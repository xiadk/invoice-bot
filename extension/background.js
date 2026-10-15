/**
 * background.js — MV3 Service Worker：与服务器保持长连接，并在 1688 标签页里执行发送
 *
 * 连接：用配对码连服务器 /ws/agent（扩展侧没有看板登录 Cookie）
 * 保活：Chrome 116+ 下 WebSocket 活动会延长 SW 生命周期；再叠加 1 分钟 alarms 兜底重连
 * 发送：每次任务使用同一个「工作标签页」，逐个卖家导航到聊天页 → 让 content.js 发消息 → 回执
 * 进度：服务器把任务进度（task_progress）推过来，弹窗实时渲染；弹窗可点「停止」
 *
 * 安全：不上报 1688 密码；登录态只留在用户本机浏览器，服务器不保存、不代发。
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
  currentCompany: '',
  sending: false,
  task: null, // 服务器推送的任务进度（供弹窗面板渲染）
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
  if (m.type === 'task_progress') { state.task = m; return; }
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

/** 找到带聊天编辑器的 frameId（轮询，直到出现或超时） */
async function findEditorFrame(tabId, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    let frames = [];
    try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch (e) { frames = []; }
    if (frames && frames.length) {
      for (const f of frames) {
        const r = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 4000);
          try {
            chrome.tabs.sendMessage(tabId, { type: 'AGENT_PING' }, { frameId: f.frameId }, (res) => {
              clearTimeout(t);
              if (chrome.runtime.lastError) resolve(null); else resolve(res || null);
            });
          } catch (e) { clearTimeout(t); resolve(null); }
        });
        if (r && r.ok && r.hasEditor) return f.frameId;
      }
    }
    if (Date.now() - t0 >= timeoutMs) return -1;
    await sleep(800);
  }
}
/** 向指定 frame 发消息（带重试） */
async function askFrame(tabId, frameId, msg, { timeoutMs = 60000, retries = 4 } = {}) {
  for (let i = 0; i < retries; i++) {
    const resp = await new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs);
      try {
        chrome.tabs.sendMessage(tabId, msg, { frameId }, (r) => {
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
    state.currentCompany = s.company || '';
    try {
      await navigateWorker(tabId, CHAT_URL(s.sellerLogin));
      // 定向到「带聊天输入框」的 frame 发送，避免顶层 frame 抢先回「无编辑器」导致内层 frame 响应丢失
      const frameId = await findEditorFrame(tabId, 45000);
      let r = null;
      if (frameId < 0) {
        // 兜底：拿不到 frame 列表时退化为整页广播
        r = await askTab(tabId, { type: 'AGENT_SEND', messages: s.messages }, { timeoutMs: 120000, retries: 3 });
      } else {
        r = await askFrame(tabId, frameId, { type: 'AGENT_SEND', messages: s.messages }, { timeoutMs: 120000, retries: 3 });
      }
      if (!r) { error = '本机页面未响应（未登录 1688 或页面结构变化）'; }
      else { ok = !!r.ok; error = r.error || ''; }
    } catch (e) {
      error = e.message || String(e);
    }
    state.currentCompany = '';
    sendToServer({ type: 'sent', taskId: m.taskId, loginId: s.loginId, ok, error: ok ? undefined : error });
    if (i < sellers.length - 1 && !state.stopFlag) {
      const ms = Math.round(gap.min + Math.random() * Math.max(0, gap.max - gap.min));
      for (let waited = 0; waited < ms && !state.stopFlag; waited += 500) await sleep(Math.min(500, ms - waited));
    }
  }
  state.sending = false;
  state.currentTaskId = null;
  state.currentCompany = '';
  state.stopFlag = false;
}

// ── 来自 content.js / popup 的消息 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'STOP_TASK') {
    // 弹窗点「停止」：与看板停止等价——本机停发剩余，并通知服务端记录停止意图
    if (state.sending && state.currentTaskId != null) {
      state.stopFlag = true;
      sendToServer({ type: 'client_stop', taskId: state.currentTaskId });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: '当前没有正在发送的任务' });
    }
    return;
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
    sendResponse({
      connected: state.connected, loggedIn: state.loggedIn, sending: state.sending,
      serverUrl: state.serverUrl, code: state.code, extVer: VERSION,
      task: state.task ? Object.assign({}, state.task, { current: state.currentCompany || state.task.current || null }) : null,
    });
    return true;
  }

  if (msg.type === 'CONNECT') {
    let inputUrl = (msg.serverUrl || '').trim();
    // 弹出页未传地址（或为空）时，回退到打包时内置的全局地址
    if (!inputUrl && typeof EXT_SERVER_URL !== 'undefined' && EXT_SERVER_URL) inputUrl = EXT_SERVER_URL;
    const code = (msg.code || '').trim();
    chrome.storage.local.set({ serverUrl: inputUrl, code }, async () => {
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
