/**
 * lib/qnh-agent.js — 经「本机助手」执行牵牛花页内签名请求的桥接层
 *
 * 为什么需要它：
 *   newQueryList（配送日志）/ queryTable（订单毛利明细）等接口被 WAF 要求 mtgsig 签名，
 *   服务器用 Cookie 直连会 403。签名逻辑在牵牛花页面自己的 JS 里（H5guard），
 *   所以这类请求必须在**真实页面环境**里发。服务器（云端）没有浏览器，
 *   能提供页面环境的只有用户本机的「1688 催收助手」（内置浏览器，persist:qnh 分区）。
 *
 * 链路：
 *   服务器 request({url, method, body})
 *     → agentHub 下发 {type:'qnh_fetch', taskId, url, method, body}
 *     → 助手在牵牛花页内 fetch（自动带签名）→ 回传 {type:'qnh_fetch_done', taskId, status, json}
 *     → 本模块按 taskId 把结果交还给等待中的调用方。
 *
 * 传输层（agentHub）由 server.js 启动时通过 setTransport() 注入，本模块不依赖任何连接实现。
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.QNH_AGENT_FETCH_TIMEOUT) || 60 * 1000;

// transport 注入：{ findAgent() -> {uid, ver}|null, send(uid, msg) -> bool }
let _transport = null;
function setTransport(t) { _transport = t && typeof t.findAgent === 'function' ? t : null; }

// 等待回执的任务：taskId -> {resolve, timer, expiresAt}
const pending = new Map();

let _seq = 0;
function genTaskId() {
  _seq += 1;
  return 'qf-' + Date.now().toString(36) + '-' + _seq.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/** 助手回报结果（server.js 的 handleAgentMessage 调用） */
function onDone(uid, msg) {
  const id = String((msg && msg.taskId) || '');
  const ctx = pending.get(id);
  if (!ctx || ctx.uid !== Number(uid)) return;
  clearTimeout(ctx.timer);
  pending.delete(id);
  if (!msg.ok) {
    ctx.resolve({ ok: false, message: String(msg.error || '本机执行失败').slice(0, 300) });
    return;
  }
  ctx.resolve({
    ok: true,
    status: Number(msg.status) || 0,
    json: msg.json && typeof msg.json === 'object' ? msg.json : null,
    text: typeof msg.text === 'string' ? msg.text.slice(0, 4000) : '',
  });
}

/** 定期清理没人认领的任务（助手掉线没回执） */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, ctx] of pending) {
    if (now > ctx.expiresAt) {
      clearTimeout(ctx.timer);
      pending.delete(id);
      ctx.resolve({ ok: false, message: '本机助手未响应（可能已离线）' });
    }
  }
}, 30000);
if (sweeper.unref) sweeper.unref();

/** 当前是否有可用（在线且版本足够）的助手 */
function available() {
  return !!(_transport && _transport.findAgent());
}

/**
 * 执行一次页内签名请求。
 * @param {object} o { path|url, method='POST', body, timeoutMs }
 *   · path 形如 '/goldengateway/...' 或 '/api/v1/...'，会拼到牵牛花域名下
 *   · url 传完整地址时优先
 * @returns {ok, status, json, text} | {ok:false, message} | {ok:false, unavailable:true, message}
 */
async function request(o = {}) {
  const agent = _transport && _transport.findAgent();
  if (!agent) {
    return { ok: false, unavailable: true, message: '本机助手未连接：签名接口（配送日志/毛利明细）需要助手在本机执行' };
  }
  const taskId = genTaskId();
  const timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const sent = _transport.send(agent.uid, {
    type: 'qnh_fetch',
    taskId,
    url: o.url || '',
    path: o.path || '',
    method: (o.method || 'POST').toUpperCase(),
    body: o.body == null ? null : o.body,
  });
  if (!sent) {
    return { ok: false, unavailable: true, message: '下发任务失败：本机助手连接已断开' };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(taskId);
      resolve({ ok: false, message: `助手执行超时（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);
    pending.set(taskId, { uid: agent.uid, resolve, timer, expiresAt: Date.now() + timeoutMs + 5000 });
  });
}

module.exports = { setTransport, onDone, request, available, _internals: { pending } };
