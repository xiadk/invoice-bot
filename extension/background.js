/**
 * background.js — MV3 Service Worker：与服务器保持长连接，并在 1688 标签页里执行发送
 *
 * 连接：用配对码连服务器 /ws/agent（扩展侧没有看板登录 Cookie）
 * 保活：Chrome 116+ 下 WebSocket 活动会延长 SW 生命周期；再叠加 1 分钟 alarms 兜底重连
 * 发送：每次任务使用同一个「工作标签页」，逐个卖家导航到聊天页 → 让 content.js 发消息 → 回执
 *
 * 上传登录态：用户在看板「登录 1688」里生成一次性上传码后，这里把本机 1688 的
 *   cookie（含 httpOnly）+ 页面 localStorage 组装成 Playwright storageState，
 *   凭上传码 POST 给服务器（服务端加密入库，供「服务器浏览器」通道发送时取用）。
 *
 * 安全：不上报 1688 密码；登录态仅在用户主动点「上传登录态」时发送一次，且走用户填写的服务器地址。
 */
const VERSION = '1.0.0';
const CHAT_URL = (sellerLoginId) =>
  'https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html' +
  '?touid=cnalichn' + encodeURIComponent(sellerLoginId) + '&siteid=cnalichn&status=1';

const state = {
  serverUrl: '', code: '',
  connected: false, loggedIn: false,
  workerTabId: null,
  stopFlag: false,
  currentTaskId: null,
  sending: false,
};
let ws = null;
let reconnectTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 配置 ──
async function loadConfig() {
  const s = await chrome.storage.local.get(['serverUrl', 'code', 'loggedIn']);
  state.serverUrl = (s.serverUrl || '').trim();
  state.code = (s.code || '').trim();
  state.loggedIn = !!s.loggedIn;
}
function wsUrl() {
  let base = state.serverUrl.replace(/\/+$/, '');
  if (!base || !state.code) return '';
  base = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${base}/ws/agent?code=${encodeURIComponent(state.code)}`;
}

function setBadge() {
  try {
    chrome.action.setBadgeText({ text: state.connected ? 'ON' : 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: state.connected ? '#2e7d32' : '#9aa0a6' });
  } catch (e) { /* 忽略 */ }
}

// ── WebSocket ──
function connect() {
  const url = wsUrl();
  if (!url) return;
  try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) { /* 忽略 */ }
  ws = new WebSocket(url);
  ws.onopen = () => {
    state.connected = true;
    setBadge();
    ws.send(JSON.stringify({
      type: 'hello', loggedIn: state.loggedIn,
      ua: navigator.userAgent, extVer: VERSION, platform: navigator.platform || '',
    }));
  };
  ws.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    handleServerMessage(m);
  };
  ws.onclose = () => { state.connected = false; setBadge(); scheduleReconnect(); };
  ws.onerror = () => { /* onclose 会跟进 */ };
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
}
function sendToServer(obj) {
  try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } } catch (e) { /* 忽略 */ }
  return false;
}
function ensureConnected() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  connect();
}

// ── 服务器消息 ──
function handleServerMessage(m) {
  if (!m || !m.type) return;
  if (m.type === 'ping') { sendToServer({ type: 'pong', t: Date.now() }); return; }
  if (m.type === 'ready') { return; }
  if (m.type === 'send_batch') { runBatch(m).catch(() => {}); return; }
  if (m.type === 'stop') { state.stopFlag = true; return; }
}

// ── 工作标签页 ──
async function getWorkerTab() {
  if (state.workerTabId != null) {
    try { await chrome.tabs.get(state.workerTabId); return state.workerTabId; } catch (e) { state.workerTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  state.workerTabId = tab.id;
  return tab.id;
}
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const onUpd = (id, info) => {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(true); }
    };
    const cleanup = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); };
    chrome.tabs.onUpdated.addListener(onUpd);
    const t = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
  });
}
async function navigateWorker(tabId, url) {
  const done = waitTabComplete(tabId, 60000);
  await chrome.tabs.update(tabId, { url, active: true });
  return done;
}
/** 给标签页发消息（会在所有 frame 广播，只有聊天框架回执）；带重试 */
async function askTab(tabId, msg, { timeoutMs = 60000, retries = 4 } = {}) {
  for (let i = 0; i < retries; i++) {
    const resp = await new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs);
      try {
        chrome.tabs.sendMessage(tabId, msg, (r) => {
          if (settled) return;
          settled = true; clearTimeout(t);
          if (chrome.runtime.lastError) resolve(null); else resolve(r || null);
        });
      } catch (e) { clearTimeout(t); resolve(null); }
    });
    if (resp) return resp;
    await sleep(1200);
  }
  return null;
}

// ── 执行一批发送 ──
async function runBatch(m) {
  if (state.sending) { sendToServer({ type: 'log', text: '已有批次在执行，忽略新任务' }); return; }
  state.sending = true;
  state.stopFlag = false;
  state.currentTaskId = m.taskId;
  const sellers = Array.isArray(m.sellers) ? m.sellers : [];
  const gap = m.gapMs || { min: 15000, max: 30000 };
  const tabId = await getWorkerTab();

  for (let i = 0; i < sellers.length; i++) {
    const s = sellers[i];
    if (state.stopFlag) {
      sendToServer({ type: 'sent', taskId: m.taskId, loginId: s.loginId, ok: false, error: '已被停止（未发送）' });
      continue;
    }
    let ok = false, error = '';
    try {
      await navigateWorker(tabId, CHAT_URL(s.sellerLogin));
      const r = await askTab(tabId, { type: 'AGENT_SEND', messages: s.messages }, { timeoutMs: 120000, retries: 3 });
      if (!r) { error = '本机页面未响应（未登录 1688 或页面结构变化）'; }
      else { ok = !!r.ok; error = r.error || ''; }
    } catch (e) {
      error = e.message || String(e);
    }
    sendToServer({ type: 'sent', taskId: m.taskId, loginId: s.loginId, ok, error: ok ? undefined : error });
    if (i < sellers.length - 1 && !state.stopFlag) {
      const ms = Math.round(gap.min + Math.random() * Math.max(0, gap.max - gap.min));
      for (let waited = 0; waited < ms && !state.stopFlag; waited += 500) await sleep(Math.min(500, ms - waited));
    }
  }
  state.sending = false;
  state.currentTaskId = null;
  state.stopFlag = false;
}

// ── 上传登录态（供服务器浏览器通道发送时取用） ──
const COOKIE_DOMAIN_RE = /(^|\.)1688\.com$/i;

/** chrome.cookies 的 sameSite → Playwright 的写法 */
function mapSameSite(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'None';
  if (s === 'strict') return 'Strict';
  return 'Lax'; // lax / unspecified 都按默认 Lax
}

/** 收集 1688 相关 cookie，转成 Playwright storageState.cookies 的格式 */
async function collectCookies() {
  let raw = [];
  try {
    raw = await chrome.cookies.getAll({ domain: '1688.com' });
  } catch (e) { raw = []; }
  if (!raw.length) {
    try { raw = await chrome.cookies.getAll({}); } catch (e) { raw = []; }
    raw = raw.filter((c) => COOKIE_DOMAIN_RE.test(String(c.domain || '')));
  }
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate) : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: mapSameSite(c.sameSite),
  }));
}

/** 从一个已打开的 1688 标签页里取 localStorage（best-effort，取不到就返回空） */
async function collectOrigins() {
  const origins = [];
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.1688.com/*' });
    const seen = new Set();
    for (const t of tabs.slice(0, 5)) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: t.id, allFrames: false },
          func: () => {
            const out = [];
            try {
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                out.push({ name: k, value: localStorage.getItem(k) });
              }
            } catch (e) { /* 忽略 */ }
            return { origin: location.origin, localStorage: out };
          },
        });
        const r = results && results[0] && results[0].result;
        if (r && r.origin && !seen.has(r.origin) && r.localStorage.length) {
          seen.add(r.origin);
          origins.push({ origin: r.origin, localStorage: r.localStorage });
        }
      } catch (e) { /* 单个标签页失败不影响整体 */ }
    }
  } catch (e) { /* 忽略 */ }
  return origins;
}

/** 组装 storageState 并上传给服务器（凭一次性上传码） */
async function uploadLoginState(serverUrl, token) {
  const base = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('请填写服务器地址');
  if (!String(token || '').trim()) throw new Error('请填写上传码（在看板「登录 1688」里生成）');
  const cookies = await collectCookies();
  const origins = await collectOrigins();
  if (!cookies.length && !origins.length) {
    throw new Error('本机没有找到 1688 登录态：请先在浏览器打开 1688 并确认已登录');
  }
  const res = await fetch(base + '/api/state/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: String(token).trim(), state: { cookies, origins }, ua: navigator.userAgent }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* 忽略 */ }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  const out = {
    ok: true, cookieCount: data.cookieCount || cookies.length,
    originCount: data.originCount || origins.length, savedAt: data.savedAt || new Date().toISOString(),
  };
  await chrome.storage.local.set({ lastUpload: out });
  return out;
}

// ── 来自 content.js / popup 的消息 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'UPLOAD_STATE') {
    (async () => {
      try {
        const r = await uploadLoginState(msg.serverUrl, msg.token);
        sendResponse(r);
      } catch (e) {
        const err = e.message || String(e);
        try { await chrome.storage.local.set({ lastUpload: { ok: false, error: err } }); } catch (e2) { /* 忽略 */ }
        sendResponse({ ok: false, error: err });
      }
    })();
    return true; // 异步回执
  }

  if (msg.type === 'LOGIN_STATE') {
    if (state.loggedIn !== !!msg.loggedIn) {
      state.loggedIn = !!msg.loggedIn;
      chrome.storage.local.set({ loggedIn: state.loggedIn });
      sendToServer({ type: 'login_state', loggedIn: state.loggedIn, url: msg.url || '' });
    }
    return;
  }

  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['lastUpload']).then((s) => {
      sendResponse({
        connected: state.connected, loggedIn: state.loggedIn, sending: state.sending,
        serverUrl: state.serverUrl, code: state.code, extVer: VERSION,
        lastUpload: s.lastUpload || null,
      });
    }).catch(() => {
      sendResponse({
        connected: state.connected, loggedIn: state.loggedIn, sending: state.sending,
        serverUrl: state.serverUrl, code: state.code, extVer: VERSION, lastUpload: null,
      });
    });
    return true;
  }

  if (msg.type === 'CONNECT') {
    chrome.storage.local.set({ serverUrl: (msg.serverUrl || '').trim(), code: (msg.code || '').trim() }, async () => {
      await loadConfig();
      connect();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'DISCONNECT') {
    chrome.storage.local.set({ code: '' }, async () => {
      state.code = '';
      try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) { /* 忽略 */ }
      ws = null;
      state.connected = false;
      setBadge();
      sendResponse({ ok: true });
    });
    return true;
  }
});

// ── 启动与保活 ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
  loadConfig().then(() => { setBadge(); ensureConnected(); });
});
chrome.runtime.onStartup.addListener(() => { loadConfig().then(() => { setBadge(); ensureConnected(); }); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'keepalive') { loadConfig().then(() => ensureConnected()); } });
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === state.workerTabId) state.workerTabId = null; });

loadConfig().then(() => { setBadge(); ensureConnected(); });
