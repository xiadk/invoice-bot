/**
 * electron/agent/jd-login.js — 京东万商（b.jd.com）登录 + 页内取价内核（只跑在用户本机）
 *
 * 为什么必须在助手做（2026-11-02 实测，见 lib/jd-bmall.js 头注释）：
 *   服务器直连 api.m.jd.com 即使 Cookie 完全有效也 403 —— 京东网关校验
 *   「出口 IP + 浏览器指纹 + Cookie」三者自洽，云端 IP 打几百次就被标记。
 *   在 b.jd.com 真实页面里 fetch（同源、指纹自洽、Cookie 由浏览器自己带）就通。
 *
 * 链路：
 *   看板点「万商登录」→ 服务器下发 jd_login → 本机弹窗 → 用户登录
 *     → 轮询到登录 Cookie → 回传服务器（服务器只取 eid/uuid/收货地址，用于组请求体）
 *   看板点「京东取价」→ 服务器下发 jd_fetch（已组好的表单）→ 页内 fetch → 回传 JSON
 *
 * 隐私边界：账号密码只在本机窗口里输入，助手不读取、不保存；
 *   回传的只有 jd.com 域 Cookie 与商品公开价格。
 *
 * 按账号隔离：每个看板账号一个持久分区（persist:jd-<uid>），
 *   任一账号登录后不再影响其他账号（1688 / 拼多多 踩过的坑）。
 */
const { session } = require('electron');
const siteFrame = require('../ui/site-frame');

const PARTITION = 'persist:jd';
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOME_URL = 'https://b.jd.com/';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const wins = new Map();   // partition -> BrowserWindow

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 分区名：与 1688 / 拼多多 / 闪电帮帮一致，一台机器一个站点一个分区。
 * 「按账号隔离」落在服务器端 —— Cookie 存 data/users/<uid>/jd-session.json，
 * 别人的登录态不会串到你身上；本机分区只是省去每次重新登录。
 */
function partitionFor() {
  return PARTITION;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function isJd(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)jd\.com$/i.test(h);
}

function currentVersion() {
  try { return require('../../package.json').version || ''; } catch (e) { return ''; }
}

/** 当前登录窗口（没有就返回 null，绝不懒创建） */
function peekWindow(uid) {
  const w = wins.get(partitionFor(uid));
  return (w && !w.isDestroyed()) ? w : null;
}

/** 万商窗口（懒创建 + 复用；登录态存在该账号自己的分区，下次免登录） */
function getWindow(uid) {
  const partition = partitionFor(uid);
  const exist = wins.get(partition);
  if (exist && !exist.isDestroyed()) return exist;
  const part = session.fromPartition(partition);
  try { part.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  // 带顶部工具栏的网站窗口（← 返回 / → 前进 / ⟳ 刷新 + 网址），返回的是兼容 BrowserWindow 的代理
  const win = siteFrame.create({
    show: false, width: 1180, height: 820, title: '京东万商',
    webPreferences: {
      partition,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,
    },
  });
  try { win.webContents.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  // 只允许停留在京东域名内（登录跳转在 passport.jd.com），防钓鱼跳转
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: isJd(url) ? 'allow' : 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!isJd(url)) e.preventDefault(); });
  win.on('closed', () => { if (wins.get(partition) === win) wins.delete(partition); });
  wins.set(partition, win);
  return win;
}

/** 取本账号分区里 jd.com 域的全部 Cookie（b 站与 api 站各取一次再合并，避免漏域） */
async function collectCookies(uid) {
  const part = session.fromPartition(partitionFor(uid));
  const urls = ['https://b.jd.com/', 'https://api.m.jd.com/', 'https://passport.jd.com/'];
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const list = await part.cookies.get({ url: u }).catch(() => []);
    for (const c of list || []) {
      const k = c.name + '@' + c.domain;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/** Cookie 数组 → 请求头用的 Cookie 串（同名以 jd.com 主域为准，后取的覆盖先取的） */
function cookieString(list) {
  const m = new Map();
  for (const c of list || []) {
    if (!c || !c.name) continue;
    m.set(c.name, c.value);
  }
  return [...m.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

/**
 * 页内探活：读分区 Cookie 判断是否已登录。
 * 万商是 thor/pinId 体系；普通京东账号（pt_key）登录 b.jd.com 也能用，所以两种都认。
 * 不用接口探活：详情接口必须给 skuId，拿不到「空探」，读 Cookie 足够。
 */
async function probeLogin(uid) {
  const list = await collectCookies(uid);
  const names = new Set((list || []).map((c) => c.name));
  const has = (...ks) => ks.some((k) => names.has(k));
  // thor = 万商登录票据；pt_key = 普通京东账号登录；pinId+pin = 老版登录态
  const logined = has('thor') || has('pt_key') || (has('pinId') && has('pin', 'pt_pin'));
  const pin = (list || []).find((c) => c.name === 'pin' || c.name === 'pt_pin');
  let account = '';
  if (pin && pin.value) {
    try { account = decodeURIComponent(pin.value); } catch (e) { account = String(pin.value); }
  }
  return { logined, account, cookieCount: (list || []).length, cookie: cookieString(list) };
}

/**
 * 执行一次登录任务：开窗口 → 用户登录 → 回传 Cookie。
 * @param {object} task { taskId, uid, timeoutMs }
 * @param {object} api  { log(text), isStopped(), report(payload) }
 */
async function runLogin(task, api) {
  const uid = Number(task && task.uid) || 0;
  const timeoutMs = Number((task && task.timeoutMs) || 0) || DEFAULT_TIMEOUT_MS;
  const w = getWindow(uid);

  api.log('已在本机打开京东万商窗口，请在窗口里登录（账号密码只在这台电脑上输入）');
  try {
    const cur = w.webContents.getURL();
    if (!isJd(cur)) await w.loadURL(HOME_URL).catch(() => {});
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
    const p = await probeLogin(uid).catch(() => null);
    if (p && p.logined) {
      // 停一下再取一次，避免登录跳转过程中只拿到半套 Cookie
      await sleep(1200);
      const p2 = await probeLogin(uid).catch(() => p);
      const cookie = (p2 && p2.cookie) || p.cookie;
      if (!cookie) {
        api.report({ ok: false, error: '已登录但没有取到 Cookie，请重试' });
        return;
      }
      api.report({
        ok: true,
        cookie,
        cookieCount: (p2 && p2.cookieCount) || p.cookieCount,
        account: (p2 && p2.account) || p.account || '',
        uid,
        agentVer: currentVersion(),
      });
      api.log('登录成功，万商登录态已回传看板');
      return;
    }
    const now = Date.now();
    if (now - lastNote > 20000) {
      lastNote = now;
      api.log('等待万商登录中…请在窗口里输入账号并完成验证');
    }
    await sleep(2000);
  }
  api.report({ ok: false, error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）：请在窗口里完成登录后重试` });
}

/** 打开万商窗口（看板「万商登录」已登录时也可以直接查看） */
function open(uid) {
  const w = getWindow(uid);
  try {
    if (!isJd(w.webContents.getURL())) w.loadURL(HOME_URL).catch(() => {});
  } catch (e) { /* 忽略 */ }
  w.show();
  w.focus();
  return true;
}

/** 把表单对象编成 x-www-form-urlencoded（京东 api.m.jd.com 只吃这种） */
function encodeForm(form) {
  return Object.keys(form || {})
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k] == null ? '' : String(form[k])))
    .join('&');
}

/** 生成页内请求脚本：xhr 优先（站点自己的请求走 XHR），fetch 兜底 */
function buildRequestJs(kind, { url, method, headers, bodyStr }) {
  const u = JSON.stringify(url);
  const m = JSON.stringify(method);
  const h = JSON.stringify(headers || {});
  const b = JSON.stringify(bodyStr || '');
  if (kind === 'xhr') {
    return `(new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open(${m}, ${u}, true);
        xhr.withCredentials = true;
        const hs = ${h};
        Object.keys(hs).forEach((k) => { try { xhr.setRequestHeader(k, hs[k]); } catch (e) {} });
        xhr.onreadystatechange = () => {
          if (xhr.readyState !== 4) return;
          let json = null;
          const text = String(xhr.responseText || '');
          try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保持 null */ }
          resolve({ status: xhr.status, json, text: text.slice(0, 4000) });
        };
        xhr.onerror = () => resolve({ error: '网络错误（可能被跨域策略拦下）' });
        xhr.send(${b});
      } catch (e) { resolve({ error: String((e && e.message) || e) }); }
    }))`;
  }
  return `(async () => {
    try {
      const r = await fetch(${u}, {
        method: ${m}, credentials: 'include', headers: ${h}, body: ${b},
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保持 null */ }
      return { status: r.status, json, text: text.slice(0, 4000) };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  })()`;
}

/**
 * 执行一次页内取价请求。
 * @param {object} task { taskId, uid, url, method, headers, form }
 * @param {object} api  { log(text), report(payload) }
 */
async function runFetch(task, api) {
  const uid = Number(task && task.uid) || 0;
  const url = String(task.url || '');
  if (!url) { api.report({ ok: false, error: '任务缺少请求地址' }); return; }
  const method = String(task.method || 'POST').toUpperCase();
  const bodyStr = task.form && typeof task.form === 'object' ? encodeForm(task.form) : '';
  const headers = Object.assign(
    { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, text/plain, */*' },
    task.headers && typeof task.headers === 'object' ? task.headers : {}
  );

  const w = getWindow(uid);
  // 必须在京东页面上发：跨域时 Origin/Referer 才与站点自己发的请求一致，否则网关照样 403
  let cur = '';
  try { cur = w.webContents.getURL(); } catch (e) { /* ignore */ }
  if (!isJd(cur)) {
    api.log('正在准备京东万商页面环境…');
    await w.loadURL(HOME_URL).catch(() => {});
    for (let i = 0; i < 10; i += 1) {
      await sleep(1200);
      try { if (isJd(w.webContents.getURL())) break; } catch (e) { /* ignore */ }
    }
  }

  const attempts = [];
  let last = null;
  for (const kind of ['xhr', 'fetch']) {
    const js = buildRequestJs(kind, { url, method, headers, bodyStr });
    const r = await w.webContents.executeJavaScript(js, true)
      .catch((e) => ({ error: String((e && e.message) || e) }));
    if (!r || r.error) { attempts.push(`${kind}: ${(r && r.error) || '无返回'}`); continue; }
    attempts.push(`${kind}: HTTP ${r.status}`);
    if (Number(r.status) >= 200 && Number(r.status) < 300) {
      api.report({ ok: true, status: r.status, json: r.json || null, text: String(r.text || '').slice(0, 4000), via: kind });
      return;
    }
    last = r;
  }

  // 全失败：区分「没登录」和「网关拦」，让看板上的提示能直接指向下一步动作
  let loginNote = '';
  try {
    const p = await probeLogin(uid).catch(() => null);
    loginNote = p && p.logined
      ? '（助手窗口里万商登录态正常，属京东网关拦截，可稍后重试）'
      : '（助手窗口里没登录：请点「万商登录」重新登录）';
  } catch (e) { /* 探活失败不影响报错 */ }

  const status = Number(last && last.status) || 0;
  const snippet = String((last && last.text) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  api.report({
    ok: false,
    status,
    error: (status === 403 ? '京东网关拒绝（HTTP 403）' : status ? `接口异常（HTTP ${status}）` : '请求没能发出去')
      + (snippet ? '。响应：' + snippet : '')
      + loginNote
      + (attempts.length ? '。通道：' + attempts.join('；').slice(0, 200) : ''),
  });
}

/** 供 main.js 注入：登录处理器 */
function createLoginHandler({ log = () => {} } = {}) {
  return async function handleJdLogin(task, api) {
    try {
      await runLogin(task, api);
    } catch (e) {
      log('京东万商登录异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

/** 供 main.js 注入：页内取价处理器 */
function createFetchHandler({ log = () => {} } = {}) {
  return async function handleJdFetch(task, api) {
    try {
      await runFetch(task, api);
    } catch (e) {
      log('京东万商取价异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = {
  createLoginHandler, createFetchHandler, runLogin, runFetch, open,
  getWindow, peekWindow, partitionFor, probeLogin, collectCookies, cookieString,
  PARTITION, HOME_URL,
};
