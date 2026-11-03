/**
 * electron/agent/pdd-mall.js — 把订单里的加密 mall_sn 反解成数字 mall_id（只跑在本机）
 *
 * 为什么必须在本机跑：拼多多订单接口的 mall 里只有加密串 mall_url（mall_sn 是
 * protobuf + 两块 AES 密文），解密密钥在拼多多服务端；服务端直连 gr_st 一律 40002
 * （风控），所以唯一办法是：在本机已登录的真实页面里打开一次，让页面自己解密，
 * 我们把它解出来的结果收下来。
 *
 * ⚠ 页面选型（0.3.17 实测教训，别再改回去）：
 *   `mall_page.html`（店铺页）**已经整站不可用** —— 即使传已知的 mall_id，
 *   页面也只会显示「手机网络繁忙，请稍后再试」，连 gr_st 都不发（风控 SDK 的采集
 *   地址 client.message.yangkeduo.com:16482 被拒连）。照着它做的 0.3.16 因此 0 成功。
 *
 *   可用的是 `chat_detail.html?mall_sn=<加密串>&decrypt_mall_sn=1`：页面自己把
 *   mall_sn 解成 mall_id，随后请求体里就带着 `"with":{"role":"mall","id":<数字>}`，
 *   而且页面标题就是店铺名（实测：标题「恒泰货架工厂店」，id 148288384）。
 *   我们不需要读响应体——从请求的 uploadData 里抠即可，比等响应稳。
 *
 * 解析成功一次就够：服务端把它写进 pdd_mall 缓存，mall_sn 与店铺一一对应、不会变，
 * 以后催收直接用 mall_id，不用再开页面。
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:pdd';           // 与 pdd-login / pdd-apply / pdd-send 同一分区（共用登录态）
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const BASE = 'https://mobile.yangkeduo.com';
const CHAT_PAGE = `${BASE}/chat_detail.html`;
const REFER = 'refer_page_name=transac_invoice&refer_page_sn=24648';
const DEFAULT_TIMEOUT = 15000;             // 单店超时：会话页比店铺页轻，正常 3~6s

let win = null;
const watch = { hits: [], active: false };  // 仅在本轮解析期间收集，避免被别的窗口污染
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}
function isPdd(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)(yangkeduo|pinduoduo)\.com$/i.test(h);
}

/** 把 onBeforeRequest 的 uploadData 拼成字符串（分片；只取前 20KB 足够） */
function readUpload(d) {
  const arr = (d && d.uploadData) || [];
  let s = '';
  for (const it of arr) {
    if (s.length > 20000) break;
    if (it && it.bytes) {
      try { s += Buffer.from(it.bytes).toString('utf8'); } catch (e) { /* 忽略坏分片 */ }
    }
  }
  return s;
}

/**
 * 从请求体里抠 mall_id：
 *   rainbow/chat/list  → {"list":{"with":{"role":"mall","id":"148288384"},...}}
 *   rainbow/gray/check → {"key":"filetransfer","gray_id":"148288384"}
 * 两个都出现时取 chat/list（语义明确是「会话对方的商家」）。
 */
function mallIdFromBody(body) {
  const m = String(body || '').match(/"role"\s*:\s*"mall"\s*,\s*"id"\s*:\s*"?(\d{4,})"?/);
  if (m) return m[1];
  const g = String(body || '').match(/"gray_id"\s*:\s*"(\d{4,})"/);
  return g ? g[1] : '';
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
  win.on('closed', () => { win = null; watch.hits.length = 0; watch.active = false; });

  // 主抓取点：请求体里的商家 id（会话页解密后把 mall_id 放进 chat/list 的 with 里）
  //
  // ⚠ 必须声明第二个参数 callback 并**每次都调用**：Electron 认为带 callback 的监听器
  // 要自己决定放行，不调用就等于把请求永久挂起 —— 页面一个响应都拿不到，标题永远是
  // 默认值、不会跳登录页也不会报错，看起来就像「被风控」。0.3.16 全失败的根因之一。
  try {
    part.webRequest.onBeforeRequest({ urls: ['*://*.yangkeduo.com/proxy/api/*'] }, (d, cb) => {
      try {
        if (watch.active) {
          const id = mallIdFromBody(readUpload(d));
          if (id) watch.hits.push({ mallId: id, from: 'body', url: String(d.url || '').slice(0, 160) });
        }
      } catch (e) { /* 抓包失败绝不能影响页面本身 */ }
      cb({});
    });
  } catch (e) { /* 监听不可用就只能靠 URL / 标题 */ }

  // 兜底：万一某个页面把 mall_id 写进了请求 URL
  try {
    part.webRequest.onCompleted({ urls: ['*://*.yangkeduo.com/*'] }, (d) => {
      if (!watch.active) return;
      const m = String(d.url || '').match(/[?&]mall_id=(\d{4,})/);
      if (m) watch.hits.push({ mallId: m[1], from: 'url', url: String(d.url).slice(0, 160) });
    });
  } catch (e) { /* 忽略 */ }
  return win;
}

function peekWindow() { return (win && !win.isDestroyed()) ? win : null; }

function currentUrl(w) {
  try { return w.webContents.getURL(); } catch (e) { return ''; }
}
function currentTitle(w) {
  try { return String(w.getTitle() || '').trim(); } catch (e) { return ''; }
}

/**
 * 解析单个店铺。
 * @returns {Promise<{mallSn:string, mallId:number, mallName:string, ok:boolean, error:string}>}
 */
async function resolveOne(item, { timeoutMs = DEFAULT_TIMEOUT, isStopped } = {}) {
  const mallSn = String((item && (item.mallSn || item.mall_sn)) || '').trim();
  const orderName = String((item && (item.mallName || item.mall_name)) || '').slice(0, 128);
  const out = { mallSn, mallId: 0, mallName: orderName, title: '', ok: false, error: '' };
  if (!mallSn) { out.error = '缺少 mall_sn'; return out; }
  if (isStopped && isStopped()) { out.error = '已停止'; return out; }

  const w = getWindow();
  watch.hits.length = 0;
  watch.active = true;

  const url = `${CHAT_PAGE}?mall_sn=${encodeURIComponent(mallSn)}&decrypt_mall_sn=1&${REFER}`;
  try {
    // loadURL 在导航被打断时不 resolve，所以不 await 它，统一用轮询兜底
    w.loadURL(url).catch(() => {});
  } catch (e) {
    watch.active = false;
    out.error = '打开商家会话页失败：' + String((e && e.message) || e).slice(0, 120);
    return out;
  }

  const deadline = Date.now() + Math.max(6000, Number(timeoutMs) || DEFAULT_TIMEOUT);
  try {
    while (Date.now() < deadline) {
      if (isStopped && isStopped()) { out.error = '已停止'; return out; }
      await sleep(300);
      // 1) 请求体里的商家 id（最可靠，页面解密后立刻上报）
      if (watch.hits.length) {
        out.mallId = Number(watch.hits[0].mallId) || 0;
        out.title = currentTitle(w);
        if (out.mallId) {
          out.ok = true;
          // 页面标题就是平台上的店铺名，比订单里的快照更权威（也顺便校验了没认错店）
          if (out.title && out.title !== '拼多多') out.mallName = out.title.slice(0, 128);
          return out;
        }
      }
      const cu = currentUrl(w);
      // 2) 明确被判未登录 —— 早点报出来，别每个店都白等
      if (/login\.html/i.test(cu) && /from=/i.test(cu)) {
        out.error = '拼多多登录态已失效，请先点「登录拼多多」重新登录';
        return out;
      }
    }
  } finally {
    watch.active = false;
  }

  // 失败时把现场写进错误里，下次不用再连机器复现
  const tail = currentUrl(w);
  const title = currentTitle(w);
  out.title = title;
  out.error = '没抓到 mall_id（最终页 '
    + (tail ? tail.replace(/^https?:\/\/[^/]+/, '').slice(0, 90) : '空')
    + '，标题 ' + (title || '空') + '）';
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
  watch.active = false;
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
