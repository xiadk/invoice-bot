/**
 * electron/agent/ali-login.js — 1688 登录内核（只跑在用户本机）
 *
 * 与 pdd-login 同源同构：服务器没有浏览器，「要人看着屏幕点」的登录只该发生在用户电脑上。
 * 链路：看板「1688发票」页点「登录1688」→ 服务器下发 ali_login 任务 → 本机弹窗口
 *      → 用户登录 → 取 Cookie 串 → 回传服务器（写进 data/ali-cookie.txt，供服务器直连 mtop 拉订单）。
 *
 * 与拼多多的差异：
 *   1) 1688 是桌面站点，用桌面 UA、宽窗口（不是拼多多那种竖屏手机端）；
 *   2) 分区用 persist:1688 —— 与发消息内核（sender.js）同一个分区，登录一次两边共用；
 *   3) 登录成功判据用 Cookie（unb / cookie2 / __cn_logon__），不做接口探活 ——
 *      1688 页内没有「免签名就能探活」的接口，Cookie 判据反而更稳。
 *
 * 隐私边界：账号密码只在本机窗口里输入，助手不读取、不保存；
 *   回传的只有 1688 站点 Cookie，用途是代替你拉取自己的订单与发票数据。
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:1688';
const DEFAULT_URL = 'https://login.1688.com/member/signin.htm';

let win = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

/** 只允许停留在阿里系自己的域内（登录跳转 / 短信 / 扫码都在域内），防钓鱼 */
function isAli(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)(1688|taobao|tmall|alibaba)\.com$/i.test(h);
}

/** 当前登录窗口（没有就返回 null，绝不懒创建——退出登录时要「关掉已存在的窗口」而不是新开一个） */
function peekWindow() { return (win && !win.isDestroyed()) ? win : null; }

function getWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false, width: 1100, height: 800, title: '1688（登录窗口）', autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: isAli(url) ? 'allow' : 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!isAli(url)) e.preventDefault(); });
  win.on('closed', () => { win = null; });
  return win;
}

/** 该分区里 1688/淘宝域下是否已有登录 Cookie（unb=用户标识、cookie2=登录态、__cn_logon__=已登录标记） */
async function hasLoginCookie() {
  const part = session.fromPartition(PARTITION);
  const all = await part.cookies.get({}).catch(() => []);
  const ali = (all || []).filter((c) => /(^|\.)(1688|taobao)\.com$/i.test(String(c.domain || '')));
  const names = new Set(ali.map((c) => String(c.name || '').toLowerCase()));
  const hasId = names.has('unb') || names.has('__cn_logon__');
  return hasId && names.has('cookie2');
}

/**
 * 取该分区里阿里系各域的 Cookie，拼成请求头里直接能用的字符串。
 * 不按 url 过滤（get({url}) 会漏掉 path 限定的 Cookie），改为全量取再按域筛：
 * 服务器 mtop 请求打 h5api.m.1688.com，但登录 Cookie（cookie2/sg/unb 等）常挂在 .taobao.com 上，
 * 所以两边的都要。
 */
async function collectCookie() {
  const part = session.fromPartition(PARTITION);
  const all = await part.cookies.get({}).catch(() => []);
  const list = (all || []).filter((c) => /(^|\.)(1688|taobao|tmall|alibaba)\.com$/i.test(String(c.domain || '')));
  const raw = list.map((c) => `${c.name}=${c.value}`).join('; ');
  const unb = (list.find((c) => String(c.name).toLowerCase() === 'unb') || {}).value || '';
  return { cookie: raw, unb: String(unb || ''), count: list.length };
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

  api.log('已在本机打开 1688 窗口，请在窗口里完成登录（支持扫码 / 短信验证 / 密码）');
  try {
    const cur = w.webContents.getURL();
    if (!isAli(cur)) await w.loadURL(url).catch(() => {});
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
    const now = Date.now();
    if (await hasLoginCookie().catch(() => false)) {
      const c = await collectCookie();
      if (!c.cookie || !c.unb) {
        // 关键 Cookie 不齐 → 多半是登录进行中（部分 Cookie 先落地），继续等
        if (now - lastNote > 20000) {
          lastNote = now;
          api.log('已拿到部分登录 Cookie，继续等待登录完成…');
        }
        await sleep(2000);
        continue;
      }
      api.report({
        ok: true,
        cookie: c.cookie,
        account: c.unb ? ('1688 用户 ' + c.unb) : '',
        agentVer: currentVersion(),
      });
      api.log(`登录成功，已回传 ${c.count} 个 Cookie`);
      return;
    }
    if (now - lastNote > 20000) {
      lastNote = now;
      api.log('等待登录中…请在 1688 窗口里完成扫码或短信验证');
    }
    await sleep(2000);
  }
  api.report({ ok: false, error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）：请在窗口里完成登录后重试` });
}

function currentVersion() {
  try { return require('../../package.json').version || ''; } catch (e) { return ''; }
}

/** 供 main.js 注入：返回一个 ali_login 处理器（旧版助手没有该处理器时，ws-client 会提示升级） */
function createLoginHandler({ log = () => {} } = {}) {
  return async function handleAliLogin(task, api) {
    try {
      await runLogin(task, api);
    } catch (e) {
      log('1688 登录异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = { createLoginHandler, runLogin, getWindow, peekWindow, PARTITION };
