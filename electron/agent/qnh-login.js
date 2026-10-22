/**
 * electron/agent/qnh-login.js — 牵牛花登录内核（只跑在用户本机）
 *
 * 为什么把登录搬进助手：
 *   服务器部署在云上，没有显示器、也没有 Playwright 的浏览器二进制，
 *   在服务器上 chromium.launch() 只会报「Executable doesn't exist at …chrome.exe」。
 *   而「登录」这件事本来就要人看着屏幕点——它只该发生在用户自己电脑上，
 *   与 1688 登录的做法完全一致：助手开内置浏览器 → 用户登录 → 只把 Cookie 回传服务器。
 *
 * 链路：看板点「登录牵牛花」→ 服务器下发 qnh_login 任务 → 本机弹窗口 → 用户登录
 *      → 页内探活确认登录 → 取本站点 Cookie → 回传服务器（服务器入库，用于拉退单）。
 *
 * 隐私边界：账号密码只在本机窗口里输入，助手不读取、不保存；
 *   回传的只有牵牛花站点 Cookie，用途是代替你调接口拉退单数据。
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:qnh';
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_PREFIX = '/api/v1';
const DEFAULT_URL = 'https://qnh.meituan.com';

let win = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Electron 的 cookie → 可序列化的普通对象（服务端会再转成 storageState） */
function packCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    // Electron 给的是 expirationDate（秒）；会话 Cookie 没有则留空，服务端按 -1 处理
    expirationDate: c.expirationDate ? Math.round(c.expirationDate) : null,
    sameSite: c.sameSite || '',
  };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function isMeituan(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)meituan\.com$/i.test(h);
}

/** 登录窗口（懒创建 + 复用；登录态存 persist:qnh 分区，下次免登录） */
function getWindow() {
  if (win && !win.isDestroyed()) return win;
  const part = session.fromPartition(PARTITION);
  try { part.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  win = new BrowserWindow({
    show: false, width: 1180, height: 820, title: '牵牛花（登录窗口）', autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,
    },
  });
  try { win.webContents.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  // 只允许停留在美团域名内（登录跳转/扫码都在该域内），防钓鱼跳转
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: isMeituan(url) ? 'allow' : 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!isMeituan(url)) e.preventDefault(); });
  win.on('closed', () => { win = null; });
  return win;
}

/** 页内探活：页面自己发 /api/v1/isLogined，带真实 Cookie（服务器直连拿不到的就靠它） */
async function probeLogin(wc) {
  const js = `(async () => {
    try {
      const r = await fetch('${API_PREFIX}/isLogined', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保持 null */ }
      return { status: r.status, json };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })()`;
  const r = await wc.executeJavaScript(js, true)
    .catch((e) => ({ error: String((e && e.message) || e) }));
  if (!r || r.error) return { logined: false, account: {} };
  const body = (r.json && typeof r.json === 'object'
    ? (r.json.data && typeof r.json.data === 'object' ? r.json.data : r.json)
    : {});
  let logined = null;
  for (const k of ['logined', 'isLogined', 'is_logined', 'isLogin', 'is_login']) {
    if (typeof body[k] === 'boolean') { logined = body[k]; break; }
    if (typeof body[k] === 'number') { logined = body[k] === 1; break; }
  }
  // 拿不到明确标志时按未登录处理：宁可让用户多等一下，也不要把失效状态当已登录
  if (logined === null && r.json && typeof r.json.code === 'number') {
    logined = r.json.code === 0 || r.json.code === 200;
  }
  if ([401, 403].includes(Number(r.status))) logined = false;
  return { logined: !!logined, account: body };
}

async function collectCookies(url) {
  const part = session.fromPartition(PARTITION);
  const all = await part.cookies.get({ url }).catch(() => []);
  return (all || []).map(packCookie);
}

/**
 * 执行一次登录任务。
 * @param {object} task { taskId, url, timeoutMs }
 * @param {object} api  { log(text), isStopped(), sleep(ms), report(payload) }
 */
async function runLogin(task, api) {
  const base = String((task && task.url) || DEFAULT_URL).replace(/\/+$/, '') || DEFAULT_URL;
  const timeoutMs = Number((task && task.timeoutMs) || 0) || 5 * 60 * 1000;
  const w = getWindow();

  api.log('已在本机打开牵牛花窗口，请在窗口里完成登录');
  try {
    const cur = w.webContents.getURL();
    if (!isMeituan(cur)) await w.loadURL(base + '/').catch(() => {});
  } catch (e) { /* 加载慢不影响后面的轮询 */ }
  w.show();
  w.focus();

  const deadline = Date.now() + timeoutMs;
  let lastNote = 0;
  while (Date.now() < deadline) {
    if (api.isStopped && api.isStopped()) {
      api.report({ ok: false, error: '登录已被停止' });
      return;
    }
    if (w.isDestroyed()) {
      api.report({ ok: false, error: '登录窗口被关闭，登录中止' });
      return;
    }
    const p = await probeLogin(w.webContents);
    if (p.logined) {
      const cookies = await collectCookies(base);
      if (!cookies.length) {
        api.report({ ok: false, error: '已登录但没有取到 Cookie，请重试' });
        return;
      }
      const acc = p.account || {};
      api.report({
        ok: true,
        cookies,
        account: String(acc.accountName || acc.userName || acc.name || acc.nickName || '').slice(0, 128),
        tenantId: String(acc.tenantId || acc.tenant_id || '').slice(0, 64),
        agentVer: currentVersion(),
      });
      api.log('登录成功，登录态已回传服务器');
      return;
    }
    const now = Date.now();
    if (now - lastNote > 20000) {
      lastNote = now;
      api.log('等待登录中…请在牵牛花窗口里输入账号并完成验证');
    }
    await sleep(2000);
  }
  api.report({ ok: false, error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）：请在窗口里完成登录后重试` });
}

/** 手动打开牵牛花登录页（托盘菜单 / 状态面板用；已登录时直接展示） */
function openLogin() {
  const w = getWindow();
  try {
    if (!isMeituan(w.webContents.getURL())) w.loadURL(DEFAULT_URL + '/').catch(() => {});
  } catch (e) { /* 忽略 */ }
  w.show();
  w.focus();
  return true;
}

function currentVersion() {
  try { return require('../../package.json').version || ''; } catch (e) { return ''; }
}

/** 供 main.js 注入：返回一个 login 处理器（旧版助手没有这个处理器时，ws-client 会提示升级） */
function createLoginHandler({ log = () => {} } = {}) {
  return async function handleQnhLogin(task, api) {
    try {
      await runLogin(task, api);
    } catch (e) {
      log('牵牛花登录异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

/**
 * 执行一次「页内签名请求」任务（配送日志 / 订单毛利明细等被 WAF 要求 mtgsig 的接口）。
 * 原理：签名逻辑在牵牛花页面自己的 JS 里，所以必须在真实页面环境里 fetch；
 * 服务器（云端）没有浏览器，只有本机助手有 persist:qnh 分区的真实页面。
 * 全程不弹窗（复用登录窗口，必要时隐藏加载页面），执行完把 JSON 回传服务器。
 */
async function runFetch(task, api) {
  const w = getWindow();

  // 1. 确保窗口页面停在牵牛花域名上（签名 JS 已注入）
  let cur = '';
  try { cur = w.webContents.getURL(); } catch (e) { /* ignore */ }
  if (!isMeituan(cur) || !/qnh\.meituan\.com/i.test(cur)) {
    api.log('正在准备牵牛花页面环境…');
    await w.loadURL(DEFAULT_URL + '/').catch(() => {});
    // 等 SPA 初始化（签名脚本注入完成），最多 ~12 秒
    for (let i = 0; i < 8; i += 1) {
      await sleep(1500);
      try {
        const u = w.webContents.getURL();
        if (/qnh\.meituan\.com/i.test(u)) break;
      } catch (e) { /* ignore */ }
    }
  }

  // 2. 页内 fetch（H5guard 自动补 mtgsig；与服务器 qnh-page 的 inPageFetch 同构）
  const method = String(task.method || 'POST').toUpperCase();
  const signParams = 'yodaReady=h5&csecplatform=4&csecversion=4.3.0';
  let target = String(task.url || task.path || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    target = target ? (target + (target.includes('?') ? '&' : '?') + signParams) : '';
  }
  if (!target) {
    api.report({ ok: false, error: '任务缺少请求地址' });
    return;
  }
  const payload = {
    target,
    method,
    body: method === 'GET' || task.body == null ? null : JSON.stringify(task.body),
  };
  const js = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(payload.target)}, {
        method: ${JSON.stringify(payload.method)},
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
        body: ${payload.body == null ? 'undefined' : payload.body},
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保持 null */ }
      return { status: r.status, json, text: text.slice(0, 4000) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })()`;

  const r = await w.webContents.executeJavaScript(js, true).catch((e) => ({ error: String((e && e.message) || e) }));
  if (!r || r.error) {
    api.report({ ok: false, error: String((r && r.error) || '页面执行失败') });
    return;
  }
  if ([401, 403].includes(Number(r.status))) {
    api.report({ ok: false, status: r.status, error: '牵牛花登录态已失效（HTTP ' + r.status + '）：请点看板「登录牵牛花」重新登录' });
    return;
  }
  api.report({ ok: true, status: r.status, json: r.json || null, text: String(r.text || '').slice(0, 4000) });
}

/** 供 main.js 注入：返回一个 fetch 处理器 */
function createFetchHandler({ log = () => {} } = {}) {
  return async function handleQnhFetch(task, api) {
    try {
      await runFetch(task, api);
    } catch (e) {
      log('牵牛花页内请求异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = { createLoginHandler, createFetchHandler, runLogin, runFetch, openLogin, getWindow, PARTITION };
