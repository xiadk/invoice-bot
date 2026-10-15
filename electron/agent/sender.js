/**
 * electron/agent/sender.js — 发送内核：用内置浏览器驱动 1688 发送
 *
 * 取代了原来的两套实现（extension/content.js 注入 + lib/sender.js 的 Playwright 引擎），
 * 合并为一套：主进程创建「1688 发送窗」→ 导航到聊天页 → 定位聊天 frame → 注入脚本发送。
 *
 * 关键设计：
 *   · 独立分区 persist:1688 —— 登录态持久化在本地，用户只登一次
 *   · UA 伪装成普通 Chrome —— Electron 默认 UA 含 "Electron/xx"，1688 风控一眼可见
 *   · 页面内绝不开放 Node（nodeIntegration:false / contextIsolation:true / sandbox:true）
 *   · backgroundThrottling:false —— 否则隐藏窗口的定时器被节流，发送会卡
 *   · 聊天编辑器位于子 iframe，executeJavaScript 只在主 frame 执行 → 需递归找 frame
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const PARTITION = 'persist:1688';
// 与真实 Chrome 一致的 UA（版本号可随 Chrome 大版本更新）
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LOGIN_URL = 'https://login.1688.com/member/signin.htm';
const CHAT_URL = (sellerLoginId) => {
  const raw = String(sellerLoginId || '');
  // 会员登录ID 可能带或不带 cnalichn 前缀，避免拼接成 cnalichncnalichn… 导致打不开会话
  const uid = /cnali/i.test(raw) ? raw : ('cnalichn' + raw);
  return 'https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html' +
    '?touid=' + encodeURIComponent(uid) + '&siteid=cnalichn&status=1';
};

// 全局 UA 兜底（含任何子窗口/新开窗口）
try { app.userAgentFallback = REAL_UA; } catch (e) { /* 忽略 */ }

let sendWin = null;
let injectSource = null;
const st = { total: 0, done: 0, ok: 0, fail: 0, current: '' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 健壮性辅助 ──

/** frame/WebContents 是否仍存活
 *  ⚠ Electron 的 WebFrameMain 只有 isDestroyed()，没有 webContents/isLoading 属性；
 *    之前在这里访问 frame.webContents 恒为 undefined，导致所有存活 frame 被误判为已销毁，
 *    waitChatFrame 空转 45s 后误报「聊天窗口未就绪」（页面实际已正常打开）。
 */
function frameAlive(frame) {
  try {
    if (!frame) return false;
    if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return false;
    return true;
  } catch (e) { return false; }
}

/** frame 可执行性探测：能成功执行一段微小脚本 = frame 存活且加载已稳定。
 *  替代原来的 did-finish-load 等待（聊天页长轮询几乎永远 isLoading，且 WebFrameMain 无该 API）。
 */
async function frameExecutable(frame, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (!frameAlive(frame)) return false;
    try {
      await frame.executeJavaScript('1', false);
      return true;
    } catch (e) { /* 正在导航/尚未就绪 → 稍后重试 */ }
    if (Date.now() - t0 >= timeoutMs) return false;
    await sleep(300);
  }
}

let antiSourceDumpReady = false;
function pickHeader(headers, name) {
  const lower = String(name || '').toLowerCase();
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}
/**
 * 防「页面显示 JS 源码」：1688 风控在识别异常环境时可能以 text/plain 或 JS MIME 直接返回
 * 检测脚本（ali_Tracking.js / 指纹识别类），Electron 会将其当纯文本渲染成源码。
 * 这里仅对 1688 域名的主文档响应兜底改写为 text/html，使挑战脚本按 HTML 正常解析执行。
 */
function ensureAntiSourceDump() {
  if (antiSourceDumpReady) return;
  try {
    const part = session.fromPartition(PARTITION);
    part.webRequest.onHeadersReceived((details, callback) => {
      try {
        const url = String(details.url || '');
        const is1688Doc = /^https?:\/\/[^/]*1688\.com\//i.test(url)
          && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame');
        const headers = details.responseHeaders || {};
        const ctArr = pickHeader(headers, 'content-type') || [];
        const ct = String((ctArr[0] || '')).toLowerCase();
        const isJSLike = /text\/plain|application\/javascript|text\/javascript|application\/x-javascript/.test(ct);
        if (is1688Doc && isJSLike) {
          const newHeaders = Object.assign({}, headers);
          newHeaders['content-type'] = ['text/html; charset=utf-8'];
          callback({ responseHeaders: newHeaders });
          return;
        }
      } catch (e) { /* 忽略 */ }
      callback({});
    });
    antiSourceDumpReady = true;
  } catch (e) { /* 忽略 */ }
}

function loadInject() {
  if (injectSource == null) {
    injectSource = fs.readFileSync(path.join(__dirname, 'inject-page.js'), 'utf-8');
  }
  return injectSource;
}

/** 发送窗（懒创建 + 复用） */
function getSendWindow() {
  if (sendWin && !sendWin.isDestroyed()) return sendWin;
  ensureAntiSourceDump();
  const part = session.fromPartition(PARTITION);
  try { part.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  sendWin = new BrowserWindow({
    show: false, width: 1120, height: 780, title: '1688（发送窗口）', autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, // 关键：隐藏时不节流，否则发送循环会卡死
    },
  });
  try { sendWin.webContents.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  // 只允许停留在 1688 域名内，防钓鱼跳转
  sendWin.webContents.setWindowOpenHandler(({ url }) => (/1688\.com/i.test(url) ? { action: 'allow' } : { action: 'deny' }));
  sendWin.webContents.on('will-navigate', (e, url) => {
    if (!/1688\.com/i.test(url)) { e.preventDefault(); }
  });
  sendWin.on('closed', () => { sendWin = null; });
  return sendWin;
}

/** 打开 1688 登录窗（用户在里面登录；登录态留在本地 profile） */
function openLoginWindow() {
  const win = getSendWindow();
  win.show();
  win.focus();
  const cur = win.webContents.getURL();
  if (!/1688\.com/i.test(cur)) win.loadURL(LOGIN_URL).catch(() => {});
  return true;
}

function closeSendWindow() {
  try { if (sendWin && !sendWin.isDestroyed()) { sendWin.destroy(); } } catch (e) { /* 忽略 */ }
  sendWin = null;
}

/** 递归查找聊天核心 frame（编辑器在其中） */
function findChatFrame(wc) {
  const walk = (f) => {
    try {
      if (/def_cbu_web_im|web_im/i.test(f.url || '')) return f;
      for (const c of f.frames || []) { const r = walk(c); if (r) return r; }
    } catch (e) { /* frame 可能已销毁 */ }
    return null;
  };
  try { return walk(wc.mainFrame); } catch (e) { return null; }
}

async function waitChatFrame(wc, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const f = findChatFrame(wc);
    if (f) {
      // 等可执行后再返回，避免在 iframe 导航期间执行脚本触发 handler 销毁
      const remain = timeoutMs - (Date.now() - t0);
      const stable = await frameExecutable(f, Math.min(8000, Math.max(1500, remain)));
      if (stable) return f;
    }
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(400);
  }
}

/** 在指定 frame 里执行「注入脚本 + 表达式」，并等待 Promise 结果 */
async function runInFrame(frame, expr, timeoutMs) {
  if (!frameAlive(frame)) throw new Error('页面 frame 已销毁（页面可能正在跳转或窗口被关闭），请重试');
  const code = loadInject() + '\n;' + expr;
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('页面执行超时')), timeoutMs); });
  try {
    const jsPromise = Promise.resolve().then(() => frame.executeJavaScript(code, true));
    const r = await Promise.race([jsPromise, timeout]);
    // 执行期间页面被导航/关闭：executeJavaScript 的 handler 会被销毁且结果不可信
    if (r == null && !frameAlive(frame)) throw new Error('页面在脚本执行期间发生跳转或关闭（frame 已销毁），请重试');
    return r;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 在聊天页执行脚本的统一入口：
 *  · 每次先重新定位聊天 frame（等加载稳定），避免在 iframe 导航期间执行
 *  · 探测类（waitReady/ping）失败可自动重试；发送类（sendBatch）传 retries=0 避免重复发消息
 */
async function execInChat(win, expr, timeoutMs, retries = 1) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const frame = await waitChatFrame(win.webContents, 45000);
    if (!frame) {
      const cur = win.webContents.getURL();
      lastErr = new Error(/login\.1688\.com|signin/i.test(cur)
        ? '1688 未登录（已跳转登录页）：请先登录后重试'
        : '聊天窗口未就绪（可能未登录 1688，或页面结构变化）');
      break;
    }
    try {
      return await runInFrame(frame, expr, timeoutMs);
    } catch (e) {
      lastErr = e;
      // 页面导航导致 frame 销毁/超时 → 重新定位重试
      if (i < retries && /销毁|destroyed|跳转|超时|navigation/i.test(e.message)) {
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** 导航并在超时内等待 did-finish-load */
function loadUrl(win, url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(false), timeoutMs);
    win.webContents.once('did-finish-load', () => finish(true));
    win.webContents.once('did-fail-load', () => finish(false));
    win.loadURL(url).catch(() => finish(false));
  });
}

/** 当前登录态：能拿到聊天编辑器 = 已登录 */
async function probeLoggedIn(win) {
  try {
    const frame = await waitChatFrame(win.webContents, 12000);
    if (!frame) return false;
    const r = await runInFrame(frame, 'window.__xsh.waitReady(8000)', 15000);
    return !!(r && r.hasEditor);
  } catch (e) { return false; }
}

/**
 * 生成批次处理器（交给 AgentClient.setBatchHandler）
 *   task = { taskId, sellers:[{loginId, sellerLogin, company, messages[]}], gapMs }
 *   api  = { report(loginId, ok, error), log(text), isStopped(), sleep(ms), gapMs }
 */
function createBatchHandler({ log = () => {}, onLoginState = () => {} } = {}) {
  return async function handleBatch(task, api) {
    const win = getSendWindow();
    if (!win.isVisible()) win.show();
    const sellers = Array.isArray(task.sellers) ? task.sellers : [];
    st.total = sellers.length; st.done = 0; st.ok = 0; st.fail = 0; st.current = '';

    for (let i = 0; i < sellers.length; i++) {
      const s = sellers[i];
      if (api.isStopped()) { api.report(s.loginId, false, '已被停止（未发送）'); s._done = true; continue; }

      st.current = s.company || s.sellerLogin || s.loginId;
      api.log(`(${i + 1}/${sellers.length}) 正在发送：${st.current}`);
      let ok = false, error = '';
      try {
        const loaded = await loadUrl(win, CHAT_URL(s.sellerLogin), 60000);
        if (!loaded && !findChatFrame(win.webContents)) {
          // 页面没加载出来（多半是被踢到登录页）
          const cur = win.webContents.getURL();
          throw new Error(/login\.1688\.com|signin/i.test(cur)
            ? '1688 未登录（已跳转登录页）：请点托盘/面板的「打开 1688 登录窗口」登录后重试'
            : '聊天页加载失败');
        }
        // 等编辑器出现（未登录时这里会失败，从而给出准确原因）；若页面在导航中销毁会自动重试
        const ready = await execInChat(win, 'window.__xsh.waitReady(30000)', 40000, 1);
        const curUrl = win.webContents.getURL();
        if (!ready || !ready.hasEditor) {
          const isLogin = /login\.1688\.com|signin/i.test(curUrl);
          if (isLogin) { try { openLoginWindow(); } catch (e) { /* 忽略 */ } }
          throw new Error(isLogin
            ? '1688 未登录（已跳转登录页）：请点面板「打开 1688 登录窗口」登录后重试'
            : '聊天编辑器未出现（当前页：' + curUrl.slice(0, 90) + '）。可能原因：①会员登录ID不正确/未维护（touid 无效，会话打不开）；②未登录 1688；③1688 页面改版导致选择器失效');
        }
        if (onLoginState) onLoginState(true, win.webContents.getURL());

        // 发送（retries=0：不自动重试，避免重复发送消息；执行前已确保 frame 存活）
        const r = await execInChat(win, 'window.__xsh.sendBatch(' + JSON.stringify(s.messages) + ')', 240000, 0);
        if (!r) error = '本机页面未响应';
        else { ok = !!r.ok; error = r.error || ''; }
      } catch (e) {
        error = e.message || String(e);
      }

      st.current = '';
      st.done++;
      if (ok) st.ok++; else st.fail++;
      api.report(s.loginId, ok, error);
      s._done = true; // 标记已回报：批次级异常时 ws-client 的兜底循环据此避免重复回报
      if (!ok) log(`✗ ${s.company || s.sellerLogin} 失败：${error}`);

      if (i < sellers.length - 1 && !api.isStopped()) {
        const g = api.gapMs || { min: 20000, max: 35000 };
        const ms = Math.round(g.min + Math.random() * Math.max(0, g.max - g.min));
        api.log(`等待 ${Math.round(ms / 1000)}s 后继续（拟人间隔，防限流）`);
        await api.sleep(ms);
      }
    }
    st.current = '';
  };
}

function state() { return { ...st }; }

module.exports = {
  getSendWindow, openLoginWindow, closeSendWindow, createBatchHandler, state,
  probeLoggedIn, findChatFrame, REAL_UA, PARTITION, CHAT_URL, LOGIN_URL,
};
