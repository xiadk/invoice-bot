/**
 * electron/agent/pdd-mall.js — 把订单里的加密 mall_sn 反解成数字 mall_id（只跑在本机）
 *
 * 为什么必须在本机跑：拼多多订单接口的 mall 里只有加密串 mall_url（mall_sn 是
 * protobuf + 两块 AES 密文），解密密钥在拼多多服务端；前端也只是把 mall_sn 转发给
 * POST /api/turing/mall/gr_st，而且必须带页面 SDK 现生的 anti_content。
 * 服务器直连该接口一律返回 40002（前端把它定义成 isIntercept 风控拦截），
 * 静态抓 mall_page.html 又是空壳（needLogin / 无 viewCtx），所以唯一的办法是：
 * 在本机已登录的真实页面里把它打开一次，让页面自己去解密，我们只把结果收下来。
 *
 * 做法：加载 mall_page.html?mall_sn=<加密串>&decrypt_mall_sn=1
 *   → 页面自己调 gr_st 拿到 mall_id，随后所有请求都带 ?mall_id=<数字>
 *   → 监听 webRequest，从请求 URL 里抠出 mall_id（比读 DOM 稳：页面渲染常常是空壳）
 *   → 顺便看一眼最终 URL 是否停在 login.html（登录态失效时这里能第一时间发现）
 *
 * 解析成功一次就够：服务端把它写进 pdd_mall 缓存，mall_sn 与店铺一一对应、不会变，
 * 以后催收直接用 mall_id，不用再开页面。
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:pdd';           // 与 pdd-login / pdd-apply / pdd-send 同一分区（共用登录态）
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const BASE = 'https://mobile.yangkeduo.com';
const DEFAULT_TIMEOUT = 15000;             // 单店超时：首屏 JS 重，正常 5~10s；超时按失败记

let win = null;
const watch = { hits: [] };                // 当前这一轮抓到的 mall_id 命中
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}
function isPdd(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)(yangkeduo|pinduoduo)\.com$/i.test(h);
}

/** 解析专用窗口（隐藏；与登录共用分区，不额外登录） */
function getWindow() {
  if (win && !win.isDestroyed()) return win;
  const part = session.fromPartition(PARTITION);
  try { part.setUserAgent(MOBILE_UA); } catch (e) { /* 忽略 */ }
  win = new BrowserWindow({
    show: false, width: 430, height: 880, title: '拼多多（解析店铺）', autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,
    },
  });
  try { win.webContents.setUserAgent(MOBILE_UA); } catch (e) { /* 忽略 */ }
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: isPdd(url) ? 'allow' : 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!isPdd(url)) e.preventDefault(); });
  win.on('closed', () => { win = null; watch.hits.length = 0; });

  // 监听整页请求：解出 mall_id 后，页面所有业务请求都会带 ?mall_id=<数字>
  try {
    part.webRequest.onCompleted({ urls: ['*://*.yangkeduo.com/*'] }, (d) => {
      const m = String(d.url || '').match(/[?&]mall_id=(\d{4,})/);
      if (m) watch.hits.push({ mallId: m[1], url: String(d.url).slice(0, 200) });
    });
  } catch (e) { /* 监听不可用就只能靠最终 URL */ }
  return win;
}

function peekWindow() { return (win && !win.isDestroyed()) ? win : null; }

function currentUrl(w) {
  try { return w.webContents.getURL(); } catch (e) { return ''; }
}

/**
 * 解析单个店铺。
 * @returns {Promise<{mallSn:string, mallId:number, mallName:string, ok:boolean, error:string}>}
 */
async function resolveOne(item, { timeoutMs = DEFAULT_TIMEOUT, isStopped } = {}) {
  const mallSn = String((item && (item.mallSn || item.mall_sn)) || '').trim();
  const mallName = String((item && (item.mallName || item.mall_name)) || '').slice(0, 128);
  const out = { mallSn, mallId: 0, mallName, ok: false, error: '' };
  if (!mallSn) { out.error = '缺少 mall_sn'; return out; }
  if (isStopped && isStopped()) { out.error = '已停止'; return out; }

  const w = getWindow();
  watch.hits.length = 0;

  const url = `${BASE}/mall_page.html?mall_sn=${encodeURIComponent(mallSn)}&decrypt_mall_sn=1`;
  try {
    // loadURL 在导航被打断时不 resolve，所以不 await 它，统一用轮询兜底
    w.loadURL(url).catch(() => {});
  } catch (e) {
    out.error = '打开店铺页失败：' + String((e && e.message) || e).slice(0, 120);
    return out;
  }

  const deadline = Date.now() + Math.max(6000, Number(timeoutMs) || DEFAULT_TIMEOUT);
  while (Date.now() < deadline) {
    if (isStopped && isStopped()) { out.error = '已停止'; return out; }
    await sleep(400);
    // 1) 请求 URL 里的 mall_id（最可靠）
    if (watch.hits.length) {
      out.mallId = Number(watch.hits[0].mallId) || 0;
      if (out.mallId) { out.ok = true; return out; }
    }
    // 2) 最终 URL 也可能直接带 mall_id（页面重写 location 的情况）
    const cu = currentUrl(w);
    const m = String(cu).match(/[?&]mall_id=(\d{4,})/);
    if (m) { out.mallId = Number(m[1]) || 0; out.ok = !!out.mallId; return out; }
    // 3) 明确被判未登录 —— 早点报出来，别每个店都白等 20 秒
    if (/login\.html/i.test(cu) && /from=/i.test(cu)) {
      out.error = '拼多多登录态已失效，请先点「登录拼多多」重新登录';
      return out;
    }
  }
  out.error = '打开店铺页后没抓到 mall_id（可能被风控拦截或页面未加载完）';
  return out;
}

/**
 * 助手任务入口：逐个解析，边解析边回报进度。
 * @param {{taskId:string, items:Array, timeoutMs?:number, gapMs?:number}} msg
 * @param {{progress:Function, isStopped:Function, sleep:Function, log:Function}} api
 */
async function run(msg, api) {
  const items = Array.isArray(msg && msg.items) ? msg.items.slice(0, 80) : [];
  const timeoutMs = Number(msg && msg.timeoutMs) || DEFAULT_TIMEOUT;
  const gapMs = Number(msg && msg.gapMs) || 800;
  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    if (api.isStopped()) break;
    const it = items[i];
    let r;
    try {
      r = await resolveOne(it, { timeoutMs, isStopped: api.isStopped });
    } catch (e) {
      r = {
        mallSn: String((it && it.mallSn) || ''),
        mallId: 0, mallName: String((it && it.mallName) || ''),
        ok: false, error: String((e && e.message) || e).slice(0, 150),
      };
    }
    results.push(r);
    if (api.progress) {
      api.progress({
        index: i + 1, total: items.length,
        current: r.mallName || r.mallSn.slice(0, 12),
        okCount: results.filter((x) => x.ok).length,
        failCount: results.filter((x) => !x.ok).length,
      });
    }
    if (api.log) {
      api.log(`[${i + 1}/${items.length}] ${r.mallName || r.mallSn.slice(0, 12)} → `
        + (r.ok ? `mall_id=${r.mallId}` : `失败：${r.error}`));
    }
    if (gapMs && i < items.length - 1) await api.sleep(gapMs);
  }
  // 收尾：解析完把窗口留着复用（下次不用重新建），但清掉抓包缓存
  watch.hits.length = 0;
  return {
    ok: true,
    results,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    stopped: api.isStopped(),
  };
}

/** main.js 注入用：把 run 包成 ws 任务处理器（异常一律转成 ok:false 回报，别让任务悬着） */
function createResolveHandler({ log = () => {} } = {}) {
  return async function handlePddMall(task, api) {
    try {
      const r = await run(task, api);
      api.report(r);
    } catch (e) {
      log('拼多多解析店铺异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = { run, createResolveHandler, peekWindow, resolveOne };
