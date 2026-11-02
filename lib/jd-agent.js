/**
 * lib/jd-agent.js — 经「本机助手」发京东万商请求的桥接层
 *
 * 为什么不能服务端直连（2026-11-02 实测，别再试一遍）：
 *   详情接口 wareBusiness.style 本身不要 h5st 签名，只要 Cookie，但服务器直连照样 403 ——
 *   京东网关看的是「出口 IP + 浏览器指纹 + Cookie 三者是否自洽」，云端 IP 上跑几百次就被标记。
 *   详情/加购在真实页面里发就通（同源、指纹自洽、Cookie 由浏览器自己带）。
 *   搜索接口另有 h5st 签名（几分钟过期、强绑 body），页面里也由站点自己的 JS 算，
 *   所以关联商品只能「粘贴链接/skuId」，不做关键字搜索。
 *
 * 链路：
 *   服务器 jd-bmall 组好请求参数
 *     → agentHub 下发 {type:'jd_fetch', taskId, url, method, headers, body}
 *     → 助手在万商页面（persist:jd-<uid> 分区）里 fetch（Cookie 自动带）
 *     → 回传 {type:'jd_fetch_done', taskId, status, json}
 *     → 本模块按 taskId 把结果交还给等待中的调用方
 *
 * 与 lib/qnh-agent.js（牵牛花）刻意分开：两条链路各自维护、互不影响，
 * 传输层同样由 server.js 启动时通过 setTransport() 注入，本模块不依赖任何连接实现。
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.JD_AGENT_FETCH_TIMEOUT) || 60 * 1000;

// transport 注入：{ findAgent(uid) -> {uid, ver}|null, send(uid, msg) -> bool }
let _transport = null;
function setTransport(t) { _transport = t && typeof t.findAgent === 'function' ? t : null; }

// 等待回执的任务：taskId -> {uid, resolve, timer, expiresAt}
const pending = new Map();

let _seq = 0;
function genTaskId() {
  _seq += 1;
  return 'jd-' + Date.now().toString(36) + '-' + _seq.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
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

/** 当前是否有可用（在线且版本足够）的助手；uid 指定时只看该用户的 */
function available(uid = 0) {
  return !!(_transport && _transport.findAgent(Number(uid) || undefined));
}

/**
 * 在万商页面里发一次请求。
 * @param {object} o { uid, url, method='POST', headers, form, timeoutMs }
 *   · form：表单对象，助手侧按 x-www-form-urlencoded 拼体（京东 api.m.jd.com 只吃表单）
 *   · uid：必须给 —— 万商登录态是按账号隔离的，谁的登录态就派给谁的助手
 * @returns {ok, status, json, text} | {ok:false, message} | {ok:false, unavailable:true}
 */
async function request(o = {}) {
  const wantUid = Number(o.uid) || 0;
  if (!wantUid) return { ok: false, unavailable: true, message: '缺少账号信息' };
  const agent = _transport && _transport.findAgent(wantUid);
  if (!agent) {
    return {
      ok: false, unavailable: true,
      message: '本机助手未连接：京东只允许在真实浏览器里取价，请先在这台电脑上启动「催收小助手」并完成绑定',
    };
  }
  const taskId = genTaskId();
  const timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const sent = _transport.send(agent.uid, {
    type: 'jd_fetch',
    taskId,
    url: String(o.url || ''),
    method: String(o.method || 'POST').toUpperCase(),
    headers: o.headers && typeof o.headers === 'object' ? o.headers : null,
    form: o.form && typeof o.form === 'object' ? o.form : null,
  });
  if (!sent) return { ok: false, unavailable: true, message: '下发任务失败：本机助手连接已断开' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(taskId);
      resolve({ ok: false, message: `助手执行超时（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);
    pending.set(taskId, { uid: agent.uid, resolve, timer, expiresAt: Date.now() + timeoutMs + 5000 });
  });
}

module.exports = { setTransport, onDone, request, available, _internals: { pending } };
