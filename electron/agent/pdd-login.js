/**
 * electron/agent/pdd-login.js — 拼多多登录内核（只跑在用户本机）
 *
 * 与牵牛花登录同源同构：服务器在云上没有浏览器，登录这种「要人看着屏幕点」的事
 *   只该发生在用户自己电脑上 —— 助手开内置窗口 → 用户登录 → 只把 Cookie 串回传服务器。
 *
 * 链路：看板点「登录拼多多」→ 服务器下发 pdd_login 任务 → 本机弹窗口 → 用户登录
 *      → 取 Cookie 串 + pdduid → 回传服务器（写进 pdd_session 表，供服务器直连拉订单）。
 *
 * 与牵牛花的三点差异：
 *   1) 拼多多走的是**手机端 H5**，所以窗口是竖屏、UA 是 Android，桌面 UA 会拿到另一套页面；
 *   2) 回传的是一整条 **Cookie 字符串**（不是结构化数组），服务器直接塞进请求头；
 *   3) 这两个列表接口不需要 anti-content，所以探活可以直接在页内 fetch，不必等签名脚本。
 *
 * 隐私边界：账号密码只在本机窗口里输入，助手不读取、不保存；
 *   回传的只有拼多多站点 Cookie，用途是代替你拉取自己的发票订单数据。
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:pdd';
// 与 lib/pdd-sync.js 保持完全一致：接口按 UA 决定返回哪套结构，桌面 UA 会拿错
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const PROBE_PATH = '/proxy/api/api/omaisapi/invoice_assistant/list_invoice_order';
const DEFAULT_URL = 'https://mobile.yangkeduo.com/commercial_pre_orders.html';

let win = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

/** 只允许停留在拼多多自己的域名内（登录跳转/短信/扫码都在域内），防钓鱼 */
function isPdd(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)(yangkeduo|pinduoduo)\.com$/i.test(h);
}

/** 登录窗口（懒创建 + 复用；登录态存 persist:pdd 分区，下次通常免登录） */
function getWindow() {
  if (win && !win.isDestroyed()) return win;
  const part = session.fromPartition(PARTITION);
  try { part.setUserAgent(MOBILE_UA); } catch (e) { /* 忽略 */ }
  win = new BrowserWindow({
    show: false, width: 430, height: 880, title: '拼多多（登录窗口）', autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,
    },
  });
  try { win.webContents.setUserAgent(MOBILE_UA); } catch (e) { /* 忽略 */ }
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: isPdd(url) ? 'allow' : 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!isPdd(url)) e.preventDefault(); });
  win.on('closed', () => { win = null; });
  return win;
}

/**
 * 页内探活：打一次「待申请订单」接口。
 * 该接口不需要 anti-content，登录态有效时页内 fetch 能拿到 success:true。
 * 注意：未登录时接口返回 HTTP 200 + {error_code:40001}，success 字段缺失 ——
 * 所以必须判 success === true，判 success !== false 会把未登录误判成已登录。
 */
async function probeLogin(wc) {
  const js = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(PROBE_PATH)}, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json;charset=UTF-8', accept: 'application/json, text/plain, */*' },
        body: JSON.stringify({ page_no: 1, page_size: 10 }),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保持 null */ }
      return { status: r.status, json, ok: !!(json && json.success === true) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })()`;
  const r = await wc.executeJavaScript(js, true)
    .catch((e) => ({ error: String((e && e.message) || e) }));
  if (!r || r.error) return { logined: false, hint: '页内探活失败' };
  if (Number(r.status) === 401 || Number(r.status) === 403) return { logined: false, hint: 'HTTP ' + r.status };
  return { logined: !!r.ok, hint: '' };
}

/**
 * 取该分区里所有拼多多域下的 Cookie，拼成请求头里直接能用的字符串。
 * 不按 url 过滤（get({url}) 会漏掉 path 限定的 Cookie），改为全量取再按域筛：
 * 服务器只请求 mobile.yangkeduo.com，所以只要 yangkeduo.com 及其子域的 Cookie。
 */
async function collectCookie() {
  const part = session.fromPartition(PARTITION);
  const all = await part.cookies.get({}).catch(() => []);
  const list = (all || []).filter((c) => /(^|\.)yangkeduo\.com$/i.test(String(c.domain || '')));
  const raw = list.map((c) => `${c.name}=${c.value}`).join('; ');
  const uid = (list.find((c) => String(c.name).toLowerCase() === 'pdd_user_id') || {}).value || '';
  return { cookie: raw, pdduid: String(uid || ''), count: list.length };
}

/** 兜底判据：拿到关键 Cookie 就算登录了（接口探活偶发失败时不至于卡死） */
async function hasLoginCookie() {
  const part = session.fromPartition(PARTITION);
  const all = await part.cookies.get({}).catch(() => []);
  return (all || []).some((c) => /(^|\.)yangkeduo\.com$/i.test(String(c.domain || ''))
    && /^(pdd_user_id|PDDAccessToken|pdd_user_uin)$/i.test(String(c.name || '')));
}

/**
 * 执行一次登录任务。
 * @param {object} task { taskId, url, timeoutMs }
 * @param {object} api  { log(text), isStopped(), report(payload) }
 */
async function runLogin(task, api) {
  const url = String((task && task.url) || DEFAULT_URL).trim() || DEFAULT_URL;
  const timeoutMs = Number((task && task.timeoutMs) || 0) || 5 * 60 * 1000;
  const w = getWindow();

  api.log('已在本机打开拼多多窗口，请在窗口里完成登录（支持扫码 / 短信验证）');
  try {
    const cur = w.webContents.getURL();
    if (!isPdd(cur)) await w.loadURL(url).catch(() => {});
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
    const now = Date.now();
    // 接口探活失败但关键 Cookie 已在 → 也认定登录成功（避免偶发接口抖动导致一直等）
    const byCookie = !p.logined && (await hasLoginCookie().catch(() => false));
    if (p.logined || byCookie) {
      const c = await collectCookie();
      if (!c.cookie) {
        api.report({ ok: false, error: '已登录但没有取到 Cookie，请重试' });
        return;
      }
      if (!c.pdduid) {
        // 接口通但没有用户标识 → 多半是探活误判（还没真正登录），继续等
        if (now - lastNote > 20000) {
          lastNote = now;
          api.log('接口已通但未取到登录标识，继续等待登录完成…');
        }
        await sleep(2000);
        continue;
      }
      api.report({
        ok: true,
        cookie: c.cookie,
        pdduid: c.pdduid,
        account: c.pdduid ? ('拼多多用户 ' + c.pdduid) : '',
        agentVer: currentVersion(),
      });
      api.log(`登录成功，已回传 ${c.count} 个 Cookie`);
      return;
    }
    if (now - lastNote > 20000) {
      lastNote = now;
      api.log('等待登录中…请在拼多多窗口里完成扫码或短信验证');
    }
    await sleep(2000);
  }
  api.report({ ok: false, error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）：请在窗口里完成登录后重试` });
}

/** 手动打开拼多多登录页（托盘菜单 / 状态面板用） */
function openLogin() {
  const w = getWindow();
  try {
    if (!isPdd(w.webContents.getURL())) w.loadURL(DEFAULT_URL).catch(() => {});
  } catch (e) { /* 忽略 */ }
  w.show();
  w.focus();
  return true;
}

function currentVersion() {
  try { return require('../../package.json').version || ''; } catch (e) { return ''; }
}

/** 供 main.js 注入：返回一个 pdd_login 处理器（旧版助手没有该处理器时，ws-client 会提示升级） */
function createLoginHandler({ log = () => {} } = {}) {
  return async function handlePddLogin(task, api) {
    try {
      await runLogin(task, api);
    } catch (e) {
      log('拼多多登录异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = { createLoginHandler, runLogin, openLogin, getWindow, PARTITION, MOBILE_UA };
