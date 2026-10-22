/**
 * lib/qnh-sync.js — 牵牛花同步（Node 版，替代 qnh-refund-sync/bridge.py）
 *
 * 为什么要这个模块：
 *   原来「登录牵牛花 / 拉退单 / 入库」全靠一个独立的 Python 工程（qnh-refund-sync），
 *   它不在部署机器上就整条链路失效。现在把能力收进 Node，一套程序、一套配置、一个库。
 *
 * 当前阶段（v0.2.3）：登录态获取 + 探活（status / login / isLogined）
 * 下一阶段（v0.2.4）：退单列表 / 明细 / 日志拉取 + 入库 + 批次落库
 *
 * 登录态存 data/qnh-state.json（Playwright storageState 格式，已被 .gitignore 的 data/* 覆盖，不入库）。
 * 接口基址可用 QNH_BASE_URL 覆盖（测试时指向本地假服务，生产默认 qnh.meituan.com）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = process.env.QNH_STATE_FILE
  ? path.resolve(process.env.QNH_STATE_FILE)
  : path.join(ROOT, 'data', 'qnh-state.json');
const BASE_URL = (process.env.QNH_BASE_URL || 'https://qnh.meituan.com').replace(/\/+$/, '');
const API_PREFIX = '/api/v1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_TIMEOUT = Number(process.env.QNH_API_TIMEOUT) || 15000;
const DEFAULT_LOGIN_TIMEOUT = 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 登录态（storageState）────────────────────────────────────
function stateExists() {
  try { return fs.statSync(STATE_PATH).isFile(); } catch (e) { return false; }
}

function readState() {
  if (!stateExists()) return null;
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (e) { return null; }
}

function stateHost() {
  try { return new URL(BASE_URL).hostname; } catch (e) { return 'qnh.meituan.com'; }
}

/** 只取当前站点域的 Cookie（storageState 里可能混着其他域） */
function stateCookies() {
  const st = readState();
  const host = stateHost();
  if (!st || !Array.isArray(st.cookies)) return [];
  return st.cookies.filter((c) => {
    const d = String((c && c.domain) || '').replace(/^\./, '');
    if (!d) return false;
    return d === host || host.endsWith('.' + d) || d.endsWith('.' + host);
  });
}

function cookieHeader() {
  return stateCookies().map((c) => `${c.name}=${c.value}`).join('; ');
}

function stateWrittenAt() {
  try { return fs.statSync(STATE_PATH).mtime.toISOString(); } catch (e) { return null; }
}

function earliestExpiry() {
  const now = Date.now() / 1000;
  const live = stateCookies().filter((c) => Number(c.expires) > now);
  if (!live.length) return null;
  live.sort((a, b) => Number(a.expires) - Number(b.expires));
  return new Date(Number(live[0].expires) * 1000).toISOString();
}

function earliestExpiryName() {
  const now = Date.now() / 1000;
  const live = stateCookies().filter((c) => Number(c.expires) > now);
  if (!live.length) return null;
  live.sort((a, b) => Number(a.expires) - Number(b.expires));
  return live[0].name || null;
}

function stateMeta() {
  return {
    exists: stateExists(),
    path: STATE_PATH,
    cookieCount: stateCookies().length,
    writtenAt: stateWrittenAt(),
    earliestExpiry: earliestExpiry(),
  };
}

// ── 响应解析（纯函数，便于隔离测试）──────────────────────────
function pickAccount(payload) {
  const d = payload && typeof payload === 'object'
    ? (payload.data && typeof payload.data === 'object' ? payload.data : payload)
    : {};
  const first = (...keys) => {
    for (const k of keys) {
      if (d[k] != null && d[k] !== '') return d[k];
    }
    return null;
  };
  return {
    uid: first('uid', 'userId', 'user_id', 'memberId'),
    tenantId: first('tenantId', 'tenant_id', 'tenantID'),
    tenantName: first('tenantName', 'tenant_name', 'tenant'),
    accountName: first('accountName', 'account_name', 'userName', 'user_name', 'name', 'nickName'),
  };
}

/** 把各种包装形态（{logined}/{data:{logined}}/{code:0}）统一成 {logined} */
function parseLogined(payload, httpStatus) {
  const body = payload && typeof payload === 'object'
    ? (payload.data && typeof payload.data === 'object' ? payload.data : payload)
    : {};
  let logined = null;

  for (const k of ['logined', 'isLogined', 'is_logined', 'isLogin', 'is_login']) {
    if (typeof body[k] === 'boolean') { logined = body[k]; break; }
    if (typeof body[k] === 'number') { logined = body[k] === 1; break; }
  }
  if (logined === null && payload && typeof payload === 'object') {
    if (typeof payload.code === 'number') logined = payload.code === 0 || payload.code === 200;
    else if (typeof payload.success === 'boolean') logined = payload.success;
  }
  // 兜底：拿不到明确标志（非 JSON / 空对象 / 被重定向到登录页）一律按「未登录」处理，
  // 宁可让用户重新登录，也不要把失效状态误报成已登录。
  if (logined === null) logined = false;
  // 被踢到登录页 / 无权限一律视为未登录
  if ([401, 403].includes(Number(httpStatus)) || (Number(httpStatus) >= 300 && Number(httpStatus) < 400)) logined = false;

  return { logined: !!logined, account: pickAccount(payload) };
}

// ── HTTP（带登录态调接口）────────────────────────────────────
async function apiFetch(pathname, { method = 'GET', headers = {}, body = null, timeoutMs = API_TIMEOUT } = {}) {
  const cookie = cookieHeader();
  if (!cookie) {
    return { status: 0, json: null, text: '', error: '未登录：缺少 Cookie' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE_URL + pathname, {
      method,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': UA,
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保持 null */ }
    return { status: res.status, json, text: text.slice(0, 500) };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `接口超时（${timeoutMs}ms）` : String((e && e.message) || e);
    return { status: 0, json: null, text: '', error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 探活：bridge.py 用的是 POST /api/v1/isLogined，这里先 POST，405/404 再回退 GET */
async function isLogined() {
  let r = await apiFetch(API_PREFIX + '/isLogined', { method: 'POST', body: {} });
  if (r.status === 404 || r.status === 405) {
    r = await apiFetch(API_PREFIX + '/isLogined', { method: 'GET' });
  }
  if (r.error) return { logined: false, account: null, httpStatus: r.status, error: r.error };
  const p = parseLogined(r.json, r.status);
  return { ...p, httpStatus: r.status, raw: r.json };
}

// ── 对外：状态 ───────────────────────────────────────────────
async function status({ probe = true } = {}) {
  const cookies = stateCookies();
  const out = {
    ok: true,
    configured: cookies.length > 0,
    source: stateExists() ? 'data/qnh-state.json（Node 登录态）' : '未登录',
    cookieCount: cookies.length,
    writtenAt: stateWrittenAt(),
    earliestExpiry: earliestExpiry(),
    earliestExpiryName: earliestExpiryName(),
    tenantId: null,
    logined: false,
    account: null,
    message: '',
    engine: 'node',
  };

  if (!out.configured) {
    out.ok = false;
    out.message = '尚未登录牵牛花：点右上角「登录牵牛花」，在弹出窗口里完成登录';
    return out;
  }
  if (!probe) return out;

  const r = await isLogined();
  out.logined = !!r.logined;
  out.account = r.account || null;
  out.tenantId = r.account && r.account.tenantId != null ? String(r.account.tenantId) : null;
  if (!r.logined) {
    out.ok = false;
    out.message = r.error
      ? `探活失败：${r.error}`
      : '登录态已失效：请点「登录牵牛花」重新登录';
  }
  return out;
}

// ── 对外：登录 ───────────────────────────────────────────────
async function waitForLogin(page, timeoutMs, emit) {
  const deadline = Date.now() + timeoutMs;
  const host = stateHost();
  let lastNote = 0;

  while (Date.now() < deadline) {
    if (page.isClosed()) return false;
    let pageHost = '';
    try { pageHost = new URL(page.url()).hostname; } catch (e) { /* 跳转中 */ }

    if (pageHost === host) {
      const r = await page
        .evaluate(async (api) => {
          try {
            const res = await fetch(api, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: '{}',
            });
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
            return { status: res.status, json, snippet: text.slice(0, 120) };
          } catch (e) {
            return { error: String((e && e.message) || e) };
          }
        }, API_PREFIX + '/isLogined')
        .catch(() => null);

      if (r && !r.error && parseLogined(r.json, r.status).logined) return true;

      const now = Date.now();
      if (now - lastNote > 15000) {
        lastNote = now;
        emit('等待登录中…请在浏览器窗口里输入账号并完成验证');
      }
    }
    await sleep(2000);
  }
  return false;
}

async function login({ headless = false, timeoutMs = DEFAULT_LOGIN_TIMEOUT, onEvent = null } = {}) {
  const emit = (m) => { if (typeof onEvent === 'function') { try { onEvent(m); } catch (e) { /* ignore */ } } };

  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch (e) {
    return { ok: false, message: '未安装 playwright，无法启动登录浏览器' };
  }

  let browser = null;
  try {
    browser = await chromium.launch({
      headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 820 },
      locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    emit('已打开登录窗口，请在浏览器里完成登录');
    try {
      await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      emit('打开牵牛花首页较慢，继续等待登录…');
    }

    const ok = await waitForLogin(page, timeoutMs, emit);
    const cookies = await ctx.cookies().catch(() => []);
    const siteCookies = cookies.filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '');
      const h = stateHost();
      return !!d && (d === h || h.endsWith('.' + d) || d.endsWith('.' + h));
    });

    if (!siteCookies.length) {
      return { ok: false, message: `未获取到登录态：请在弹出窗口里完成登录（等待 ${Math.round(timeoutMs / 1000)} 秒）` };
    }

    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    await ctx.storageState({ path: STATE_PATH });

    if (!ok) {
      return {
        ok: false,
        message: '已保存 Cookie，但探活未通过：可能仍在登录页，请重试或手动刷新一次页面',
        cookieCount: siteCookies.length,
      };
    }
    emit('登录成功，登录态已保存');
    return {
      ok: true,
      statePath: STATE_PATH,
      cookieCount: siteCookies.length,
      writtenAt: stateWrittenAt(),
      message: '登录成功，登录态已保存',
    };
  } catch (e) {
    return { ok: false, message: '登录失败：' + String((e && e.message) || e).slice(0, 300) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** 删除本地登录态（退出登录用，暂未接入 UI） */
function clearState() {
  try { fs.unlinkSync(STATE_PATH); return true; } catch (e) { return false; }
}

module.exports = {
  BASE_URL,
  STATE_PATH,
  API_PREFIX,
  stateExists,
  stateMeta,
  stateCookies,
  cookieHeader,
  isLogined,
  status,
  login,
  clearState,
  // 纯函数，供隔离测试直接断言
  _internals: { parseLogined, pickAccount },
};
