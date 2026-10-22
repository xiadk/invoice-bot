/**
 * lib/qnh-page.js — 牵牛花常驻有头浏览器页内代理
 *
 * 背景：queryOrderRoute / newQueryList 等 API 被 WAF 要求 mtgsig 签名 + 设备指纹
 * （WEBDFPID），Node 直连 403；注入 storageState 的全新浏览器也因指纹不自洽而 403。
 * 已验证（v0.2.5 spike）：在有头浏览器里真实登录后，页内 fetch 自动带签名，稳定 200。
 *
 * 方案：
 *   · launchPersistentContext（profile 落 data/qnh-profile，不入库）——指纹与 Cookie
 *     在同一浏览器环境自洽，登录一次后可复用
 *   · 首次启动尝试用已保存登录态（data/qnh-state.json）静默恢复；签名探活 403 时
 *     弹出窗口等待人工登录（复用 qnh-sync 的登录流程）
 *   · 对外只暴露 fetchOrderLogs(orderId)（newQueryList → orderOperatorLogList）
 *   · 空闲 10 分钟自动回收浏览器；崩溃/被关后下次调用自动重建
 */
const path = require('path');
const fs = require('fs');
const db = require('../db');
const qsync = require('./qnh-sync');

const PROFILE_DIR = process.env.QNH_PROFILE_DIR
  || path.join(__dirname, '..', 'data', 'qnh-profile');
const IDLE_CLOSE_MS = Number(process.env.QNH_PAGE_IDLE_MS) || 10 * 60 * 1000;
const NQL_URL = '/api/v1/orderfuse/newQueryList';

const res = {
  ctx: null,       // persistent context（兼 browser）
  page: null,
  lastUsedAt: 0,
  starting: null,  // 并发去重：正在启动的 Promise
  idleTimer: null,
};

function log(...args) { console.log('[qnh-page]', ...args); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive() {
  return !!(res.ctx && res.page && !res.page.isClosed() && !res.ctx._qnhDead);
}

/** 等页面 URL 稳定（SPA 初始跳转），最多 ~15 秒 */
async function waitStable(page) {
  let last = '';
  for (let i = 0; i < 6; i += 1) {
    await sleep(2500);
    const u = page.url();
    if (u === last && !/login/.test(u)) return u;
    last = u;
  }
  return page.url();
}

/** 页内 fetch（H5guard 自动签名）。返回 {status, json} 或 {error} */
async function inPageFetch(page, api, body) {
  return page.evaluate(async ({ api, body }) => {
    try {
      const r = await fetch(api + '?yodaReady=h5&csecplatform=4&csecversion=4.3.0', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* 保留 text */ }
      return { status: r.status, json, text: text.slice(0, 2000) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }, { api, body }).catch((e) => ({ error: String((e && e.message) || e) }));
}

/** 签名探活：newQueryList 空查一页，200 即指纹+登录态都自洽 */
async function probe(page) {
  const r = await inPageFetch(page, NQL_URL, { page: 1, pageSize: 1, _t: Date.now() });
  if (r.error) return { ok: false, message: r.error };
  if (r.status === 200 && r.json && r.json.code === 0) return { ok: true };
  return {
    ok: false,
    status: r.status,
    loginRequired: r.status === 401 || r.status === 403,
    message: `探活 HTTP ${r.status}`,
  };
}

/** 人工登录：在已打开的有头窗口里等用户完成登录 */
async function interactiveLogin(ctx, page, timeoutMs = 300000) {
  try { await page.goto(qsync.BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { /* 慢也等 */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return { ok: false, message: '浏览器窗口被关闭，登录中止' };
    const cookies = await ctx.cookies().catch(() => []);
    const cookie = cookies
      .filter((c) => String(c.domain || '').includes('meituan.com'))
      .map((c) => `${c.name}=${c.value}`).join('; ');
    if (cookie) {
      try {
        const r = await fetch(qsync.BASE_URL + '/api/v1/isLogined', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: '{}',
        });
        const j = await r.json().catch(() => null);
        if (j && j.data && (j.data.logined === true || j.data.uid)) {
          fs.mkdirSync(path.dirname(qsync.STATE_PATH), { recursive: true });
          await ctx.storageState({ path: qsync.STATE_PATH });
          return { ok: true };
        }
      } catch (e) { /* 继续等 */ }
    }
    await sleep(3000);
  }
  return { ok: false, message: `等待人工登录超时（${Math.round(timeoutMs / 1000)} 秒）` };
}

/** 启动/重建常驻浏览器。返回 {page} 或 {error} */
async function start({ allowInteractive = true } = {}) {
  if (res.starting) return res.starting;
  res.starting = (async () => {
    await close('重建前回收');
    let chromium;
    try { ({ chromium } = require('playwright')); } catch (e) {
      return { error: '未安装 playwright，无法启动常驻浏览器' };
    }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false, // 有头是签名通过的前提，不能改
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 820 },
        locale: 'zh-CN',
      });
    } catch (e) {
      return { error: '启动浏览器失败：' + String((e && e.message) || e).slice(0, 200) };
    }
    ctx._qnhDead = false;
    ctx.once('close', () => { ctx._qnhDead = true; res.ctx = null; res.page = null; });

    const page = ctx.pages()[0] || await ctx.newPage();
    // 首次启动：把已保存登录态的 Cookie 灌进 profile，尽量免人工
    try {
      const cookies = qsync.stateCookies();
      if (Array.isArray(cookies) && cookies.length) await ctx.addCookies(cookies);
    } catch (e) { /* 没有旧登录态就靠人工 */ }

    try {
      await page.goto(qsync.BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) { /* 首页慢不影响后续 fetch */ }
    await waitStable(page);

    let p = await probe(page);
    if (!p.ok && p.loginRequired && allowInteractive) {
      log('签名探活 403，弹出窗口等待人工登录…');
      const li = await interactiveLogin(ctx, page);
      if (!li.ok) { await ctx.close().catch(() => {}); return { error: li.message }; }
      await waitStable(page);
      p = await probe(page);
    }
    if (!p.ok) {
      await ctx.close().catch(() => {});
      return { error: p.message || '页内探活失败' };
    }

    res.ctx = ctx;
    res.page = page;
    res.lastUsedAt = Date.now();
    armIdleTimer();
    log('常驻浏览器就绪');
    return { page };
  })();
  try {
    return await res.starting;
  } finally {
    res.starting = null;
  }
}

async function close(reason) {
  if (res.idleTimer) { clearTimeout(res.idleTimer); res.idleTimer = null; }
  const ctx = res.ctx;
  res.ctx = null;
  res.page = null;
  if (ctx) {
    log('关闭常驻浏览器' + (reason ? `（${reason}）` : ''));
    await ctx.close().catch(() => {});
  }
}

function armIdleTimer() {
  if (res.idleTimer) clearTimeout(res.idleTimer);
  res.idleTimer = setTimeout(() => { close(`空闲 ${Math.round(IDLE_CLOSE_MS / 60000)} 分钟`); }, IDLE_CLOSE_MS);
  if (res.idleTimer.unref) res.idleTimer.unref();
}

/** 对外入口：用关联订单号拉配送操作日志。返回
 *  {ok, logs:[...]} | {ok:false, loginRequired, message} */
async function fetchOrderLogs(orderId) {
  const started = await (alive() ? Promise.resolve({ page: res.page }) : start());
  if (started.error) return { ok: false, message: started.error };
  const page = started.page;
  res.lastUsedAt = Date.now();
  armIdleTimer();

  const now = Date.now();
  const body = {
    orderId: String(orderId),
    page: 1,
    pageSize: 10,
    _t: now,
    createStartTime: String(now - 30 * 86400000), // 订单创建窗口放宽到 30 天
    createEndTime: String(now),
  };
  let r = await inPageFetch(page, NQL_URL, body);
  // 会话中途失效 → 弹窗人工登录一次后重试
  if (r.status === 401 || r.status === 403) {
    log('页内请求被拒（HTTP ' + r.status + '），尝试人工登录后重试');
    const s2 = await start({ allowInteractive: true });
    if (s2.error) return { ok: false, loginRequired: true, message: s2.error };
    r = await inPageFetch(s2.page, NQL_URL, body);
  }
  if (r.error) return { ok: false, message: r.error };
  if (r.status !== 200) return { ok: false, loginRequired: r.status === 401 || r.status === 403, message: `HTTP ${r.status}` };
  const j = r.json;
  if (!j || j.code !== 0) return { ok: false, message: (j && j.message) || '接口返回异常' };

  const list = (j.data && j.data.orderList) || [];
  const hit = list.find((o) => String(o.channelOrderId) === String(orderId)) || list[0];
  if (!hit) return { ok: true, logs: [], message: '订单列表中未找到该订单' };
  const rawLogs = Array.isArray(hit.orderOperatorLogList) ? hit.orderOperatorLogList : [];
  return { ok: true, logs: rawLogs };
}

/** 状态（给 /api/qnh/status 附加展示，暂不接前端） */
function status() {
  return {
    resident: alive(),
    lastUsedAt: res.lastUsedAt ? new Date(res.lastUsedAt).toISOString() : null,
  };
}

module.exports = { fetchOrderLogs, start, close, status, probe, _internals: { inPageFetch, waitStable } };
