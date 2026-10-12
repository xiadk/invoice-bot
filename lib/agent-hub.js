/**
 * lib/agent-hub.js — 本机浏览器通道（方案C）的连接中枢
 *
 * 职责（只管连接，不含业务）：
 *   · 一次性配对码：用户在看板生成，扩展用它在服务器上「认领」自己的账号
 *   · WebSocket 注册表：userId ↔ 连接（同一用户后连顶掉前连）
 *   · 心跳：服务器定时 ping，超时未 pong 视为离线
 *   · 消息收发：把扩展上报的消息回调给 server.js 处理
 *
 * 业务（建任务、写 send_log、进度）全部留在 server.js，保持本模块纯粹。
 *
 * 安全边界：本模块与 server.js 都不接触用户的 1688 凭据；登录态留在用户本机浏览器，
 *           扩展只上报「是否已登录」这一布尔值（见 docs/方案C_用户自带浏览器.md §6）。
 */
const crypto = require('crypto');

const PAIR_TTL_MS = 5 * 60 * 1000;      // 配对码有效期 5 分钟
const PING_INTERVAL_MS = 20 * 1000;     // 心跳间隔
const OFFLINE_AFTER_MS = 75 * 1000;     // 超过此时长无响应 → 视为离线

class AgentHub {
  /**
   * @param {object} opts
   * @param {(uid:number, msg:object)=>void} [opts.onMessage] 扩展上报的业务消息
   * @param {(uid:number, status:object)=>void} [opts.onStatus] 在线状态变化
   */
  constructor(opts) {
    const o = opts || {};
    this.onMessage = o.onMessage || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.pairs = new Map();  // code -> { uid, expireAt }
    this.conns = new Map();  // uid  -> conn
    this._timer = setInterval(() => this._tick(), PING_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  // ── 配对码 ──
  /** 为该用户生成新配对码（会作废该用户此前的码） */
  createPairCode(uid) {
    const id = Number(uid);
    this._sweepPairs();
    for (const [k, v] of this.pairs) if (v.uid === id) this.pairs.delete(k);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expireAt = Date.now() + PAIR_TTL_MS;
    this.pairs.set(code, { uid: id, expireAt });
    return { code, ttlSec: Math.round(PAIR_TTL_MS / 1000), expiresAt: new Date(expireAt).toISOString() };
  }

  /** 用配对码换取 userId（码在有效期内可重复使用，便于扩展断线重连） */
  redeem(code) {
    this._sweepPairs();
    const key = String(code == null ? '' : code).trim();
    const p = this.pairs.get(key);
    return p ? p.uid : null;
  }

  _sweepPairs() {
    const now = Date.now();
    for (const [k, v] of this.pairs) if (v.expireAt <= now) this.pairs.delete(k);
  }

  /** 作废该用户的所有配对码（断开后必须重新配对才能再连） */
  revokePairs(uid) {
    const id = Number(uid);
    let n = 0;
    for (const [k, v] of this.pairs) if (v.uid === id) { this.pairs.delete(k); n++; }
    return n;
  }

  // ── 连接注册 ──
  /** 绑定一个扩展连接（同用户后到者顶掉先到者） */
  attach(uid, ws, meta) {
    const id = Number(uid);
    const m = meta || {};
    const old = this.conns.get(id);
    if (old && old.ws !== ws) {
      try { old.ws.close(4001, 'replaced by a newer connection'); } catch (e) { /* 忽略 */ }
    }
    const conn = {
      uid: id, ws,
      connectedAt: Date.now(), lastSeenAt: Date.now(),
      loggedIn: !!m.loggedIn, ua: m.ua || '', extVer: m.extVer || '', platform: m.platform || '',
    };
    this.conns.set(id, conn);
    this.onStatus(id, this.status(id));
    return conn;
  }

  /** 解绑（仅当当前连接仍是该 ws 时生效） */
  detach(uid, ws) {
    const id = Number(uid);
    const c = this.conns.get(id);
    if (c && (!ws || c.ws === ws)) {
      this.conns.delete(id);
      this.onStatus(id, this.status(id));
      return true;
    }
    return false;
  }

  /** 连接是否存在且存活 */
  isOnline(uid) {
    const c = this.conns.get(Number(uid));
    if (!c) return false;
    if (c.ws.readyState !== 1) return false;
    return Date.now() - c.lastSeenAt < OFFLINE_AFTER_MS;
  }

  /** 某个用户的通道状态 */
  status(uid) {
    const c = this.conns.get(Number(uid));
    if (!c) return { online: false, connected: false };
    const online = c.ws.readyState === 1 && Date.now() - c.lastSeenAt < OFFLINE_AFTER_MS;
    return {
      online,
      connected: true,
      connectedAt: new Date(c.connectedAt).toISOString(),
      lastSeenAt: new Date(c.lastSeenAt).toISOString(),
      loggedIn: !!c.loggedIn,
      ua: c.ua,
      extVer: c.extVer,
      platform: c.platform,
    };
  }

  /** 更新扩展上报的登录态 */
  setLoggedIn(uid, loggedIn) {
    const c = this.conns.get(Number(uid));
    if (c) { c.loggedIn = !!loggedIn; this.onStatus(Number(uid), this.status(Number(uid))); }
  }

  /** 发送消息给某用户的扩展；返回是否发出 */
  send(uid, msg) {
    const c = this.conns.get(Number(uid));
    if (!c || c.ws.readyState !== 1) return false;
    try { c.ws.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
  }

  /** 处理来自扩展的原始消息（由 WS 连接层调用） */
  handle(uid, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const c = this.conns.get(Number(uid));
    if (c) c.lastSeenAt = Date.now();
    if (msg.type === 'ping') { this.send(uid, { type: 'pong', t: Date.now() }); return; }
    if (msg.type === 'pong') return;
    try { this.onMessage(Number(uid), msg); } catch (e) { console.error('[agent] onMessage 异常', e.message); }
  }

  /** 主动断开某用户连接 */
  disconnect(uid, reason) {
    const c = this.conns.get(Number(uid));
    if (!c) return false;
    try { c.ws.close(4000, reason || 'disconnected by server'); } catch (e) { /* 忽略 */ }
    this.conns.delete(Number(uid));
    this.onStatus(Number(uid), this.status(Number(uid)));
    return true;
  }

  _tick() {
    const now = Date.now();
    for (const [uid, c] of this.conns) {
      if (c.ws.readyState !== 1) { this.conns.delete(uid); this.onStatus(uid, this.status(uid)); continue; }
      if (now - c.lastSeenAt > OFFLINE_AFTER_MS) {
        try { c.ws.close(4002, 'heartbeat timeout'); } catch (e) { /* 忽略 */ }
        this.conns.delete(uid);
        this.onStatus(uid, this.status(uid));
        continue;
      }
      this.send(uid, { type: 'ping', t: now });
    }
  }

  closeAll() {
    clearInterval(this._timer);
    for (const [uid, c] of this.conns) { try { c.ws.close(1001, 'server shutting down'); } catch (e) { /* 忽略 */ } }
    this.conns.clear();
  }
}

module.exports = { AgentHub, PAIR_TTL_MS, PING_INTERVAL_MS, OFFLINE_AFTER_MS };
