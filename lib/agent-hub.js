/**
 * lib/agent-hub.js — 本机助手通道的连接中枢
 *
 * 职责（只管连接，不含业务）：
 *   · 连接凭证：**设备令牌（device token）**——看板签发一次性绑定令牌（120s TTL）→ 助手换取长期
 *     设备令牌（64hex）→ 以 `?device=<令牌>` 连接。服务器只存 `agent_device.token_hash`（sha256），
 *     不存明文；设备可后台撤销，撤销即断开在线连接。
 *     ⚠ 2026-10-14 起**不再使用「税号当配对码」**（税号半公开、印在发票上，可被冒用）。
 *     令牌的校验/换取/撤销在 server.js（resolveDeviceToken / createDevice 等），本模块只接收已解析的 userId。
 *   · WebSocket 注册表：userId ↔ 连接（同一用户后连顶掉前连）。
 *   · 心跳：服务器定时 ping，超时未 pong 视为离线。
 *   · 消息收发：把助手上报的消息回调给 server.js 处理。
 *
 * 业务（建任务、写 send_log、进度）全部留在 server.js，保持本模块纯粹。
 *
 * 安全边界：本模块与 server.js 都不接触用户的 1688 凭据；登录态留在用户本机（助手内置浏览器），
 *           助手只上报「是否已登录」这一布尔值。
 */
const PING_INTERVAL_MS = 20 * 1000;     // 心跳间隔
const OFFLINE_AFTER_MS = 75 * 1000;     // 超过此时长无响应 → 视为离线

class AgentHub {
  /**
   * @param {object} opts
   * @param {(uid:number, msg:object)=>void} [opts.onMessage] 扩展上报的业务消息
   * @param {(uid:number, status:object)=>void} [opts.onStatus] 在线状态变化
   * @param {(code:string)=>Promise<number|null>} [opts.resolveUserByCode] 配对凭证(税号)→userId
   */
  constructor(opts) {
    const o = opts || {};
    this.onMessage = o.onMessage || (() => {});
    this.onStatus = o.onStatus || (() => {});
    // 配对凭证解析器：根据税号查出 userId（异步，由 server.js 注入，内部查数据库）。
    // 返回 null 表示凭证无效（税号不存在 / 账号非 active）。
    this.resolveUserByCode = o.resolveUserByCode || (async () => null);
    this.conns = new Map();  // uid  -> conn
    this._timer = setInterval(() => this._tick(), PING_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * 用配对凭证（= 纳税人识别号）解析出 userId；查不到或异常返回 null。
   * 税号配对永不过期、不随服务器重启失效（解析基于数据库，而非内存临时码）。
   */
  async redeem(code) {
    const key = String(code == null ? '' : code).trim();
    if (!key) return null;
    try {
      const id = await this.resolveUserByCode(key);
      return id ? Number(id) : null;
    } catch (e) {
      console.error('[agent] resolveUserByCode 异常', e.message);
      return null;
    }
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
      loggedIn: !!m.loggedIn, ua: m.ua || '', agentVer: m.agentVer || '', os: m.os || '',
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
      agentVer: c.agentVer,
      os: c.os,
      // 兼容旧字段名（老看板/老客户端仍读 extVer/platform）
      extVer: c.agentVer,
      platform: c.os,
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

module.exports = { AgentHub, PING_INTERVAL_MS, OFFLINE_AFTER_MS };
