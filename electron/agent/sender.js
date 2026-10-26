/**
 * electron/agent/sender.js — 发送内核：用内置浏览器驱动 1688 发送
 *
 * 取代了原来的两套实现（旧浏览器扩展 content.js 注入 + lib/sender.js 的 Playwright 引擎），
 * 合并为一套：主进程创建「1688 发送窗」→ 导航到聊天页 → 定位聊天 frame → 注入脚本发送。
 *
 * 关键设计：
 *   · 独立分区 persist:1688 —— 登录态持久化在本地，用户只登一次
 *   · UA 伪装成普通 Chrome —— Electron 默认 UA 含 "Electron/xx"，1688 风控一眼可见
 *   · 页面内绝不开放 Node（nodeIntegration:false / contextIsolation:true / sandbox:true）
 *   · backgroundThrottling:false —— 否则隐藏窗口的定时器被节流，发送会卡
 *   · 聊天编辑器位于子 iframe，executeJavaScript 只在主 frame 执行 → 需递归找 frame
 *
 * ── 节拍与中断设计（2026-10-26 重构）──
 *   ① 不再死等 did-finish-load：聊天页是长轮询 SPA，load 事件对「能不能发」没有指示意义，
 *      导航发起后即返回，就绪与否交给 waitChatFrameEx / waitReady 判定。
 *   ② 「加载下一家」与「两家之间的间隔」并行：发完这家立刻预加载下一家的会话，
 *      这段加载时间计入 gap，只有加载得比 gap 还快时才补差额 —— 总时长下降，
 *      而两家真实发送的间隔 = max(gap, 加载耗时)，不比原来更密。
 *   ③ 逐条发送取代页面内的 sendBatch：每条结束都回到主进程并检查停止标记，
 *      配合 raceStop，点停止后 <1s 退出循环（原实现要等这家发完，最坏近 8 分钟）。
 *   ④ 「卖家间隔」配置项继续保留：它是保底下限，会话切换快起来后（如后续接入 SPA 复用）
 *      它就是唯一的节流手段。
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

// ── 停止协作（2026-10-26）──────────────────────────────────────────────
// 旧实现里 stopFlag 只能在「每家循环的开头」被检查一次，而单家的发送是一次
// executeJavaScript（整批 3 条在页面里跑，超时上限 240s）+ 编辑器就绪等待（最多 85s），
// 于是点「停止」要等当前这家跑完才知道 —— 慢的时候要好几分钟。
// 现在所有阻塞等待都套一层 raceStop：stopFlag 一置位立即抛 StopError，
// 不再理会还没返回的页面 Promise（道具其实没有「取消 JS 执行」的 API，只能不等它）。
class StopError extends Error {
  constructor(msg) {
    super(msg || '已被停止');
    this.stopped = true;
  }
}

/** 让任意等待可被「停止」打断；返回原结果，被停则抛 StopError */
function raceStop(promise, isStopped, intervalMs = 200) {
  const p = Promise.resolve(promise);
  p.catch(() => {}); // 抢跑后迟到的 rejection 不该变成 unhandled
  if (!isStopped) return p;
  if (isStopped()) { p.catch(() => {}); return Promise.reject(new StopError()); }
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (isStopped()) { clearInterval(timer); timer = null; reject(new StopError()); }
    }, intervalMs);
  });
  return Promise.race([p, guard]).finally(() => { if (timer) { clearInterval(timer); timer = null; } });
}

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

/** 递归收集「聊天相关」frame，按优先级排序（越优先越靠前）：
 *   ① IM 核心框（def_cbu_web_im_core）—— 编辑器与「发送」按钮真正所在的 frame
 *   ② 其它 web_im 页面（排除埋点 iframe、开询盘弹窗等干扰项）
 *
 * ⚠ 实测（tmp-probe-frames.js，真实登录态）：
 *   主框 def_cbu_web_im/index.html 内 preEdit=0、contenteditable=0 —— **没有编辑器**；
 *   编辑器(pre.edit[contenteditable=true])与可见「发送」按钮都在其子框
 *   def_cbu_web_im_core/index.html 内（preEdit=4）。旧逻辑返回「第一个 URL 命中的 frame」
 *   = 主框，注入后 findEditor 永远为空 → 报「聊天编辑器未出现」。
 *   旧浏览器扩展之所以能发，是因为 content script 默认注入所有 frame（含该核心子框）。
 */
function collectChatFrames(wc) {
  const out = [];
  const walk = (f, depth) => {
    let url = '', kids = [];
    try { url = String(f.url || ''); kids = f.frames || []; } catch (e) { /* frame 可能已销毁 */ }
    if (/insights\.1688\.com|ww-bulk-inquiry-modal/i.test(url)) {
      // 埋点/弹窗框：不选它，但仍需继续下钻其子框
    } else if (/web_im_core/i.test(url)) {
      out.push({ f, score: 1000 - depth });
    } else if (/def_cbu_web_im|web_im/i.test(url)) {
      out.push({ f, score: 100 - depth });
    }
    for (const c of kids) walk(c, depth + 1);
  };
  try { walk(wc.mainFrame, 0); } catch (e) { /* 忽略 */ }
  out.sort((a, b) => b.score - a.score);
  return out.map((x) => x.f);
}

/** 递归查找聊天核心 frame（编辑器在其中）：优先 IM 核心子框 */
function findChatFrame(wc) {
  const list = collectChatFrames(wc);
  return list.length ? list[0] : null;
}

/** 目标会话 URL 是否已在浏览器里生效（防止把「上一个卖家的旧页面」当成新会话）
 *  ⚠ 0.2.26 引入过一个严重时序 bug：navigate() 发起后立刻去 waitChatFrameEx，
 *    此时旧页面还没卸载，探测到的是**上一个卖家的聊天 frame**（编辑器还在）→
 *    被误判为「下一家已就绪」→ 轮到下一家时旧 frame 已销毁 → 只能重新导航一遍，
 *    同一个会话加载两遍（用户看到的就是「打开聊天框要等 10 秒+」）；
 *    更糟的情况是旧 frame 恰好还活着 → 模板打进上一个卖家的聊天框 / 发送中途
 *    frame 被销毁报「发送未确认」。
 */
function chatUrlMatches(url, sellerLogin) {
  const raw = String(sellerLogin || '');
  if (!raw) return false;
  const uid = /cnali/i.test(raw) ? raw : ('cnalichn' + raw);
  const u = String(url || '');
  let dec = u;
  try { dec = decodeURIComponent(u); } catch (e) { /* 保持原文 */ }
  return dec.indexOf(uid) >= 0 || u.indexOf(encodeURIComponent(uid)) >= 0;
}

/** 等主 frame 的 URL 真正提交到目标会话（did-navigate 级别，秒级；不是 did-finish-load）。
 *  返回 'ok' | 'login'（被踢到登录页）| 'timeout'（URL 形态没匹配上，交由后续 frame 探测兜底）。 */
async function waitChatCommit(wc, sellerLogin, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    let url = '';
    try { url = String(wc.mainFrame.url || ''); } catch (e) { /* frame 短暂不可用 */ }
    if (chatUrlMatches(url, sellerLogin)) return 'ok';
    if (/login\.1688\.com|signin/i.test(url)) return 'login';
    if (Date.now() - t0 >= timeoutMs) return 'timeout';
    await sleep(200);
  }
}

/**
 * 同上，但额外带回「这个 frame 是否已经渲染出编辑器」。
 * 已经出现编辑器时就不必再跑到页面里执行 waitReady 二次等待（省掉一轮 ~1~5s 的往返）。
 * ⚠ 编辑器就绪只认 IM 核心子框（web_im_core）：主框 def_cbu_web_im 里可能存在
 *   搜索框等 textarea 之类的伪命中，提前 return 会锁定错误的 frame（真机踩过）。
 * @returns {Promise<{frame:object, hadEditor:boolean}|null>}
 */
async function waitChatFrameEx(wc, timeoutMs) {
  const t0 = Date.now();
  let fallback = null;
  for (;;) {
    for (const f of collectChatFrames(wc)) {
      if (!frameAlive(f)) continue;
      const remain = timeoutMs - (Date.now() - t0);
      if (remain <= 0) return fallback ? { frame: fallback, hadEditor: false } : null;
      const ok = await frameExecutable(f, Math.min(800, Math.max(400, remain)));
      if (!ok) continue;
      const isCore = /web_im_core/i.test(String(f.url || ''));
      try {
        const has = await f.executeJavaScript(
          '!!document.querySelector(\'pre.edit,[contenteditable="true"],textarea\')', false);
        if (has && isCore) return { frame: f, hadEditor: true };
        // 非 core 框的伪编辑器命中：只作兜底，继续等真正的核心框
        if (has && !fallback) fallback = f;
      } catch (e) { /* 该 frame 不可用，试下一个 */ }
    }
    if (Date.now() - t0 >= timeoutMs) return fallback ? { frame: fallback, hadEditor: false } : null;
    await sleep(250);
  }
}

/** 找到「可用于执行的聊天 frame」（兼容旧签名，只返回 frame） */
async function waitChatFrame(wc, timeoutMs) {
  const r = await waitChatFrameEx(wc, timeoutMs);
  return r ? r.frame : null;
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
async function execInChat(win, expr, timeoutMs, retries = 1, frameHint = null) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    // 同一个卖家的几条消息之间 frame 不会变：直接复用上一次定位到的 frame，省掉一整轮探测
    const frame = (frameHint && frameAlive(frameHint))
      ? frameHint
      : await waitChatFrame(win.webContents, 45000);
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

/** 发起导航。
 *  ⚠ 不等 did-finish-load：1688 聊天页是长轮询 SPA，load 事件对「能不能发」没有指示意义，
 *    死等它纯属浪费（原来最坏要等到 60s）。就绪与否统一由 waitChatFrameEx / waitReady 判定，
 *    被踢到登录页的情况在定位失败时会读 URL 识别出来。 */
function navigate(win, url) {
  try { win.loadURL(url).catch(() => {}); } catch (e) { /* 忽略 */ }
  return true;
}

/** 导航并在超时内等待 did-finish-load（保留给只读自测用；发送流程改走 navigate + prepareSeller） */
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
 * 让某家的会话就绪（导航 + 等编辑器），返回可直接注入执行的 frame。
 * 每一步都套了 raceStop：页面卡住时点停止也能立刻退出。
 *
 * ── 时序（0.2.28 修复）──
 *   ① 当前页已经在目标会话 → 不再重复导航（重试同一卖家不用整页重载）
 *   ② 导航后必须先等主 frame URL 提交到目标会话（did-navigate 级别），
 *      否则会把「上一个卖家的旧页面 frame」当成已就绪 —— 曾导致：
 *      同一会话加载两遍（打开聊天框后干等 10s+）、模板打进错误卖家、发送中断报失败。
 */
async function prepareSeller(win, seller, isStopped, opts = {}) {
  let cur = '';
  try { cur = win.webContents.getURL(); } catch (e) { /* 忽略 */ }
  if (!chatUrlMatches(cur, seller.sellerLogin)) {
    navigate(win, CHAT_URL(seller.sellerLogin));
    const commit = await raceStop(
      waitChatCommit(win.webContents, seller.sellerLogin, opts.commitTimeoutMs || 15000), isStopped);
    if (commit === 'login') {
      try { openLoginWindow(); } catch (e) { /* 忽略 */ }
      throw new Error('1688 未登录（已跳转登录页）：请点面板「打开 1688 登录窗口」登录后重试');
    }
    // 'timeout' 不中断：URL 可能是变体形态，交给下面的 frame 探测兜底
  }
  const found = await raceStop(
    waitChatFrameEx(win.webContents, opts.frameTimeoutMs || 45000), isStopped);
  if (!found || !found.frame) {
    const curUrl = win.webContents.getURL();
    throw new Error(/login\.1688\.com|signin/i.test(curUrl)
      ? '1688 未登录（已跳转登录页）：请点面板「打开 1688 登录窗口」登录后重试'
      : '聊天窗口未就绪（可能未登录 1688，或页面结构变化）');
  }
  // waitChatFrameEx 是靠 querySelector 探到编辑器的；已探到就不必再进页面跑 waitReady 二次等待
  if (found.hadEditor) return { frame: found.frame, readyMs: 0 };
  const ready = await raceStop(
    runInFrame(found.frame, '__xsh.waitReady(30000)', 40000), isStopped);
  const curUrl = win.webContents.getURL();
  if (!ready || !ready.hasEditor) {
    const isLogin = /login\.1688\.com|signin/i.test(curUrl);
    if (isLogin) { try { openLoginWindow(); } catch (e) { /* 忽略 */ } }
    throw new Error(isLogin
      ? '1688 未登录（已跳转登录页）：请点面板「打开 1688 登录窗口」登录后重试'
      : '聊天编辑器未出现（当前页：' + curUrl.slice(0, 90) + '）。可能原因：①会员登录ID不正确/未维护（touid 无效，会话打不开）；②未登录 1688；③1688 页面改版导致选择器失效');
  }
  return { frame: found.frame, readyMs: 0 };
}

/** 确认 frame 里编辑器还在（预加载后到真正发送之间隔了十几秒，frame 可能被重建） */
async function confirmReady(frame, isStopped) {
  try {
    const p = await raceStop(runInFrame(frame, '__xsh.ping()', 8000), isStopped);
    return !!(p && p.hasEditor);
  } catch (e) { return false; }
}

/**
 * 逐条发送一家的全部消息。
 * ⚠ 为什么不用页面里的 sendBatch：那是一次 executeJavaScript 里把 3 条全发完（上限 240s），
 *   主进程在此期间完全无法打断 —— 点停止必须等这家发完。
 *   拆成逐条后，每条都回到主进程一次并检查停止标记，最坏的中断延迟从「一家 4 分钟」降到「一条 ≤10s」。
 * @param {{frame:object}} holder 该家的 frame 引用（多条之间复用，失效会自动重定位）
 */
async function sendMessages(win, holder, messages, isStopped) {
  const raw = Array.isArray(messages) ? messages : [];
  const list = raw.filter((m) => String(m == null ? '' : m).trim());
  if (!list.length) return { ok: false, error: '消息内容为空（服务端消息模板未配置），未发送任何消息' };
  for (let i = 0; i < list.length; i++) {
    if (isStopped()) throw new StopError();
    const expr = 'window.__xsh.sendOne(' + JSON.stringify(list[i]) + ')';
    // retries=0：发送类绝不自动重试整轮，避免把同一条重复发给卖家
    const r = await raceStop(execInChat(win, expr, 45000, 0, holder.frame), isStopped);
    if (!r) return { ok: false, error: `第 ${i + 1}/${list.length} 条：本机页面未响应` };
    if (!r.ok) return { ok: false, error: `第 ${i + 1}/${list.length} 条发送失败：${r.error || '未知原因'}` };
    // 拟人停顿只保留在消息之间（最后一条发完即切换到下一家，不再空等）
    if (i < list.length - 1) await raceStop(sleep(1200 + Math.random() * 1300), isStopped);
  }
  const dropped = raw.length - list.length;
  return dropped > 0 ? { ok: true, warning: `已跳过 ${dropped} 条空消息` } : { ok: true };
}

/**
 * 生成批次处理器（交给 AgentClient.setBatchHandler）
 *   task = { taskId, sellers:[{loginId, sellerLogin, company, messages[]}], gapMs, prefetch }
 *   api  = { report(loginId, ok, error), log(text), isStopped(), sleep(ms), gapMs }
 *
 * ── 节拍设计（2026-10-26）──
 * 两家之间的等待不再是「先空等 gap、再加载下一家」的串行。现在发完这家就立刻
 * 预加载下一家的会话，这段加载时间直接计入 gap；加载比 gap 还慢时不额外等，
 * 只剩差额才补。于是：
 *   · 用户感知的总时长下降（每家少了一整段纯等待）
 *   · 两家「真实发送动作」的间隔 = max(gap, 加载耗时)，不会小于 gap —— 不加风控风险
 */
function createBatchHandler({ log = () => {}, onLoginState = () => {} } = {}) {
  return async function handleBatch(task, api) {
    const win = getSendWindow();
    if (!win.isVisible()) win.show();
    const sellers = Array.isArray(task.sellers) ? task.sellers : [];
    st.total = sellers.length; st.done = 0; st.ok = 0; st.fail = 0; st.current = '';

    const isStopped = () => (typeof api.isStopped === 'function' ? !!api.isStopped() : false);
    const gapMs = task.gapMs || { min: 20000, max: 35000 };
    const prefetch = task.prefetch !== false; // 默认开：服务端可下发 false 回到「严格串行等待」
    let prepared = null;      // 已预加载好的下一家：{ index, frame }
    let lastSendEndAt = 0;    // 上一家最后一条消息发出的时刻（算真实间隔用）

    try {
      for (let i = 0; i < sellers.length; i++) {
        const s = sellers[i];
        if (isStopped()) { api.report(s.loginId, false, '已被停止（未发送）'); s._done = true; st.done++; st.fail++; continue; }

        st.current = s.company || s.sellerLogin || s.loginId;
        api.log(`(${i + 1}/${sellers.length}) 正在发送：${st.current}`);
        let ok = false;
        let error = '';
        let frame = null;
        try {
          // ① 会话就绪：上一轮预加载好了就直接复用，否则现场加载
          frame = (prepared && prepared.index === i) ? prepared.frame : null;
          if (frame) {
            // 兜底：预加载后到真正发送之间隔了（gap + 预加载）一段时间，
            // 期间页面若被手动导航走，编辑器还在也不该用 —— 当前页必须仍是这家卖家的会话
            let u = '';
            try { u = win.webContents.getURL(); } catch (e) { /* 忽略 */ }
            if (!chatUrlMatches(u, s.sellerLogin)) frame = null;
          }
          if (frame && !(await confirmReady(frame, isStopped))) frame = null;
          if (!frame) {
            const p = await prepareSeller(win, s, isStopped);
            frame = p.frame;
          }
          prepared = null;

          // ② 保底停顿：两家真实发送之间的最短间隔。加载下一家的时间已经算在里面，
          //    只有加载得比 gap 还快时才补差额（gap 由系统管理配置，是防风控的下限）
          if (i > 0 && lastSendEndAt) {
            const target = Math.round(gapMs.min + Math.random() * Math.max(0, gapMs.max - gapMs.min));
            const elapsed = Date.now() - lastSendEndAt;
            const rest = target - elapsed;
            if (rest > 0) {
              api.log(`两家发送间隔保底 ${Math.round(target / 1000)}s：切换会话用了 ${Math.round(elapsed / 1000)}s，再等 ${Math.round(rest / 1000)}s`);
              await raceStop(api.sleep(rest), isStopped);
            } else {
              api.log(`两家发送间隔 ${Math.round(elapsed / 1000)}s（已超过保底 ${Math.round(target / 1000)}s），无需额外等待`);
            }
          }
          if (isStopped()) throw new StopError();
          if (onLoginState) onLoginState(true, win.webContents.getURL());

          // ③ 逐条发送（每条之间回到主进程检查停止标记）
          const holder = { frame };
          const r = await sendMessages(win, holder, s.messages, isStopped);
          ok = !!r.ok;
          error = r.error || '';
          if (r.warning) api.log('⚠ ' + r.warning);
          if (ok) lastSendEndAt = Date.now();
        } catch (e) {
          if (e && e.stopped) {
            error = '已被停止（该卖家可能只发出了部分消息）';
            api.log('⏸ 已停止：当前步骤未完成，不再继续发送');
          } else {
            error = e.message || String(e);
          }
          try { win.webContents.stop(); } catch (e2) { /* 忽略 */ } // 停掉还在拉的页面请求
        }

        st.current = '';
        st.done++;
        if (ok) st.ok++; else st.fail++;
        api.report(s.loginId, ok, error);
        s._done = true; // 标记已回报：批次级异常时 ws-client 的兜底循环据此避免重复回报
        if (!ok) log(`✗ ${s.company || s.sellerLogin} 失败：${error}`);

        if (isStopped()) continue; // 剩余卖家在下一轮开头统一回报「已被停止（未发送）」

        // ④ 预加载下一家：这段时间会计入 gap，等价于把「加载」和「等待」重叠起来做
        if (prefetch && i < sellers.length - 1) {
          try {
            const p = await prepareSeller(win, sellers[i + 1], isStopped);
            prepared = { index: i + 1, frame: p.frame };
          } catch (e) {
            prepared = null; // 预加载失败不算数：轮到它时会现场再加载一次
          }
        }
      }
    } finally {
      if (isStopped()) {
        // 停止时不再理会还在页面里跑的脚本：窗口留着不卸，下次点发送可直接复用登录态
        try { win.webContents.stop(); } catch (e) { /* 忽略 */ }
      }
      st.current = '';
    }
  };
}

function state() { return { ...st }; }

module.exports = {
  getSendWindow, openLoginWindow, closeSendWindow, createBatchHandler, state,
  probeLoggedIn, findChatFrame, REAL_UA, PARTITION, CHAT_URL, LOGIN_URL,
  // 仅供本机自测脚本（tmp-selftest-*.js）复用的内部件，不影响正常流程
  _test: {
    collectChatFrames, waitChatFrame, waitChatFrameEx, execInChat, loadUrl, frameExecutable,
    StopError, raceStop, navigate, prepareSeller, sendMessages, confirmReady, sleep,
    chatUrlMatches, waitChatCommit,
  },
};
