/**
 * electron/agent/sdc.js — 闪电帮帮（美团 shandiancang）登录 / 取数 / 催收（只跑在用户本机）
 *
 * 为什么这三项都必须在本机浏览器里做（不能像拼多多那样服务器直连）：
 *   该站点网关有 WAF 风控：请求必须带 `mtgsig` 签名，服务器直连会拿到 openresty 的 403。
 *   但**在真实页面里**发出的 fetch 会被站点的风控 SDK（H5guard）自动补上签名 ——
 *   实测：在同一个登录页面上下文里执行不带任何签名头的裸 fetch，照样返回 200 与数据。
 *   所以：登录、拉订单、发会话消息，全部在 Electron 持久分区 `persist:sdc` 里完成。
 *
 * 已知接口（2026-10-29 实测）：
 *   登录检测   POST /sdc-gw1/mallApi/login/getLoginInfo            {}                     → data.userId / data.shopId
 *   可申请开票 POST /sdc-gw1/mallApi/invoiceTitle/queryInvoiceOrderPage
 *                                                                  {pageNo,pageSize,subUserIds:[userId]}
 *   订单列表   POST /mallApi/order/pcPageList  (无 sdc-gw1 前缀)
 *                                                                  {searchKey,orderStatus:-1,orderStartTime,orderEndTime,pageNo,pageSize,_t,queryUnCommented}
 *              ↓ 时间过滤 orderStartTime（毫秒）→ 回传里的订单时间字段是 orderDate
 *   已申请开票 POST /sdc-gw1/mallApi/orderInvoice/queryOrderInvoiceForBuyer
 *                                                                  {pageNo,pageSize,_t,invoiceApplyStatusList:[1],userIdList:[userId],billStartTime?}
 *              ↓ 时间过滤 billStartTime（毫秒）→ 回传里的开票时间字段是 invoiceDate
 *   取会话     POST /mallApi/im/shop/pub/select                     {shopId}              → data = sessionId
 *   聊天页     https://shandiancang.waimai.meituan.com/customer-service/chat?sessionId=<id>
 *
 * 隐私边界：账号密码只在用户看着的本机窗口里输入；回传服务器的只有订单数据与发送结果，
 *   不回传 Cookie（服务器也用不上）。
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:sdc';
const HOST = 'shandiancang.waimai.meituan.com';
const HOME_URL = `https://${HOST}/personal-center/invoice-order-management?invoiceStage=1&pageNo=1&pageSize=10`;
// 登录窗口落点：站点首页（用户自己点页面上的登录入口，扫码/短信都行）
const LOGIN_URL = `https://${HOST}/`;
const CHAT_URL = `https://${HOST}/customer-service/chat`;
const APPKEY = 'fe_com.sankuai.sgshopcrm.fe.purchaseshandiancangpc';
const QS = '?yodaReady=h5&csecplatform=4&csecversion=4.3.0';
// 订单列表（订单存量与支付时间口径的权威来源；注意**没有** sdc-gw1 前缀）
const ORDER_LIST_API = '/mallApi/order/pcPageList' + QS;
// 开票申请/已开票（开票状态口径的权威来源）
const INVOICE_LIST_API = '/sdc-gw1/mallApi/orderInvoice/queryOrderInvoiceForBuyer' + QS;
// 可申请开票（旧来源，保留给兜底与「平台限制线上开票」判断）
const APPLY_LIST_API = '/sdc-gw1/mallApi/invoiceTitle/queryInvoiceOrderPage' + QS;
/** 原始行只留这么多字符：够看清字段名，又不至于把 WS 消息撑爆 */
const RAW_MAX = 2000;
// 默认 UA 里带 "Electron/x"，美团系站点的风控会拿它当异常指纹（不装载风控 SDK、限制交互）。
// 换成真实 Chrome UA（与牵牛花内核同款），登录弹窗才点得动。
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let apiWin = null;    // 承载「页内请求」的后台窗口（已登录的同源页面）
let loginWin = null;  // 登录窗口（用户要看着操作，必须可见）
let chatWin = null;   // 聊天窗口（发消息用）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}
function isSdc(url) {
  const h = hostOf(url);
  return h === HOST || /(^|\.)waimai\.meituan\.com$/i.test(h);
}
/**
 * 站内导航 / 弹窗白名单：美团域才放行。
 * 登录页、扫码、短信验证会跳到 passport 等美团子域（不在 shandiancang 下），
 * 只认本站的话，登录跳转会被拦掉。站外一律不放行，防钓鱼跳转。
 */
function isMeituanHost(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)meituan\.com$/i.test(h);
}

/** 当前页面是不是站点首页（登录窗口的落点），是就别再刷新，免得把用户正在填的东西冲掉 */
function atLoginHome(url) {
  try {
    const u = new URL(url);
    return isSdc(url) && (u.pathname === '/' || u.pathname === '');
  } catch (e) { return false; }
}

// ── 窗口 ────────────────────────────────────────────────────────────
function peekWindow() { return (loginWin && !loginWin.isDestroyed()) ? loginWin : null; }
function peekApiWindow() { return (apiWin && !apiWin.isDestroyed()) ? apiWin : null; }
function peekChatWindow() { return (chatWin && !chatWin.isDestroyed()) ? chatWin : null; }

/**
 * 给窗口装上「UA + 导航/弹窗限制」。登录弹窗、聊天窗、子窗口都要装。
 * ⚠ 弹窗不能一律 deny：站点登录是用 window.open 弹扫码/短信窗的，
 *   全 deny 的表现就是「点登录什么都没发生」（0.2.56 之前踩过）。
 */
function wireWindow(w) {
  try { w.webContents.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  w.webContents.setWindowOpenHandler(({ url }) => ({ action: isMeituanHost(url) ? 'allow' : 'deny' }));
  w.webContents.on('will-navigate', (e, url) => { if (!isMeituanHost(url)) e.preventDefault(); });
  // 弹出来的子窗口（登录窗/扫码窗）继承同一分区，但要再装一遍限制，免得它自己跳去站外
  w.webContents.on('did-create-window', (child) => { try { wireWindow(child); } catch (e) { /* 忽略 */ } });
  return w;
}

function newBaseWindow(title, opts = {}) {
  try { session.fromPartition(PARTITION).setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  const w = new BrowserWindow({
    show: !!opts.show,
    width: opts.width || 1440,
    height: opts.height || 900,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,   // 后台也要能跑页内 fetch / 打字，不能被节流
    },
  });
  return wireWindow(w);
}

function getLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) return loginWin;
  loginWin = newBaseWindow('闪电帮帮（登录窗口）', { show: true });
  loginWin.on('closed', () => { loginWin = null; });
  return loginWin;
}

/** 取「页内请求」窗口：不存在就新建一个隐藏的同源页面（登录态在同一分区里） */
async function getApiWindow(api) {
  const alive = (apiWin && !apiWin.isDestroyed()) ? apiWin : null;
  const w = alive || (() => {
    apiWin = newBaseWindow('闪电帮帮（数据窗口）', { show: false });
    apiWin.on('closed', () => { apiWin = null; });
    return apiWin;
  })();
  const cur = (() => { try { return w.webContents.getURL(); } catch (e) { return ''; } })();
  if (!isSdc(cur)) {
    if (api && api.log) api.log('正在打开闪电帮帮页面（建立页内请求环境）…');
    await w.loadURL(HOME_URL).catch(() => {});
    // SPA 需要几秒把风控 SDK 装载好，等它加载完成再发请求，否则 fetch 还不会被自动签名
    await w.webContents.executeJavaScript(
      'new Promise((r) => { if (document.readyState === "complete") r(1);'
      + ' else window.addEventListener("load", () => r(1), { once: true }); })'
    ).catch(() => {});
    await sleep(3500);
  }
  return w;
}

function getChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) return chatWin;
  chatWin = newBaseWindow('闪电帮帮（客服会话）', { show: true, width: 1200, height: 860 });
  chatWin.on('closed', () => { chatWin = null; });
  return chatWin;
}

// ── 页内请求 ────────────────────────────────────────────────────────
/**
 * 在页面上下文里发一次 POST。
 * 关键点：这个 fetch 会被页面的风控 SDK 自动加上 mtgsig，所以这里**什么都不用签**。
 */
function pageFetch(wc, path, body) {
  const js = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(path)}, {
        method: 'POST', credentials: 'include',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          accept: 'application/json, text/plain, */*',
          'M-APPKEY': ${JSON.stringify(APPKEY)},
        },
        body: JSON.stringify(${JSON.stringify(body)}),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { status: r.status, json, text: String(text || '').slice(0, 300) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })()`;
  return wc.executeJavaScript(js, true).catch((e) => ({ error: String((e && e.message) || e) }));
}

/** 登录检测：能拿到 userId 才算登录 */
async function probeLogin(wc) {
  const r = await pageFetch(wc, '/sdc-gw1/mallApi/login/getLoginInfo' + QS, {});
  if (!r || r.error) return { logined: false, hint: (r && r.error) || '页内请求失败' };
  if (Number(r.status) === 401 || Number(r.status) === 403) return { logined: false, hint: 'HTTP ' + r.status };
  const d = (r.json && r.json.data) || null;
  const uid = d && (d.userId || d.userId === 0) ? String(d.userId) : '';
  if (!uid) return { logined: false, hint: '未登录' };
  return { logined: true, subUserId: uid, hint: '' };
}

/** 页顶显示的账号名（如「SGzs1234567 (ID:70504)」）——取不到就留空，不影响流程 */
async function pickAccountName(wc) {
  const name = await wc.executeJavaScript(`(function () {
    try {
      const el = Array.from(document.querySelectorAll('*')).find((e) => /\\(\\s*ID:\\s*\\d+\\s*\\)/.test((e.innerText || '').trim()) && e.children.length <= 2);
      const t = el ? String(el.innerText || '').trim().split('\\n')[0] : '';
      return t.replace(/\\(\\s*ID:.*$/, '').trim().slice(0, 40);
    } catch (e) { return ''; }
  })()`).catch(() => '');
  return String(name || '');
}

// ── 登录 ────────────────────────────────────────────────────────────
async function runLogin(task, api) {
  const timeoutMs = Number((task && task.timeoutMs) || 0) || 5 * 60 * 1000;
  const w = getLoginWindow();
  api.log('已在本机打开闪电帮帮首页，请在窗口里点登录入口完成登录（扫码 / 短信均可）');
  try {
    const cur = w.webContents.getURL();
    if (!atLoginHome(cur)) await w.loadURL(LOGIN_URL).catch(() => {});
  } catch (e) { /* 加载慢不影响后续轮询 */ }
  w.show();
  w.focus();

  const deadline = Date.now() + timeoutMs;
  let lastNote = 0;
  let wafHits = 0;
  while (Date.now() < deadline) {
    if (api.isStopped && api.isStopped()) { api.report({ ok: false, error: '登录已被停止' }); return; }
    if (w.isDestroyed()) { api.report({ ok: false, error: '登录窗口被关闭，登录中止' }); return; }
    const p = await probeLogin(w.webContents);
    if (p.logined) {
      const name = await pickAccountName(w.webContents);
      api.report({
        ok: true,
        subUserId: p.subUserId,
        accountName: name || ('闪电帮帮用户 ' + p.subUserId),
        agentVer: currentVersion(),
      });
      api.log(`登录成功：${name || p.subUserId}`);
      return;
    }
    // 兜底：首页若没装载风控 SDK，裸 fetch 会被 WAF 挡成 403，登录就永远检测不出来。
    // 连续 3 次 403 就切到订单页（那个页面一定有 SDK），再接着等用户登录。
    if (p.hint === 'HTTP 403') {
      wafHits += 1;
      if (wafHits === 3) {
        api.log('首页页内请求被风控拦截，切到订单页继续检测登录…');
        try { await w.loadURL(HOME_URL).catch(() => {}); } catch (e) { /* 忽略 */ }
        await sleep(3500);
      }
    }
    const now = Date.now();
    if (now - lastNote > 20000) {
      lastNote = now;
      api.log('等待登录中…请在闪电帮帮窗口里完成扫码或短信验证');
    }
    await sleep(2500);
  }
  api.report({ ok: false, error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）：请在窗口里完成登录后重试` });
}

/** 托盘菜单 / 状态面板：手动打开登录页 */
function openLogin() {
  const w = getLoginWindow();
  try { if (!atLoginHome(w.webContents.getURL())) w.loadURL(LOGIN_URL).catch(() => {}); } catch (e) { /* 忽略 */ }
  w.show();
  w.focus();
  return true;
}

// ── 拉订单数据 ──────────────────────────────────────────────────────
// 两个数据源、各管一段（2026-10-29 改造，口径以页面上能看到的为准）：
//   ① 订单列表 /mallApi/order/pcPageList —— 订单存量与支付时间（按 orderStartTime~orderEndTime 增量翻页）
//   ② 已申请/已开票 /sdc-gw1/mallApi/orderInvoice/queryOrderInvoiceForBuyer —— 开票状态（按开票时间增量回写）
// 平台「不支持线上开票」的限制标记只在这两处的**原始行**里，所以每行都带 raw_json 回传，
// 服务器侧据此归档证据（口径若变，照着真数据改，不用再猜）。

const pickVal = (o, keys) => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};
const numOf = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
/** 时间：兼容 13/10 位时间戳与 'YYYY-MM-DD HH:mm:ss'，统一输出毫秒（库里由服务器转 DATETIME） */
const timeMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
};
const rawOf = (r) => {
  try { return JSON.stringify(r).slice(0, RAW_MAX); } catch (e) { return null; }
};
/** 金额：订单列表接口若给「分」，这里按数值量级判断（>10 万的分=1000 元，仍按分处理会明显失真） */
const moneyOf = (v, hintCents) => {
  const n = numOf(v);
  if (n === null) return null;
  return hintCents ? Math.round(n) / 100 : n;
};

/**
 * 平台是否「不支持线上开票」。
 * ⚠ 字段口径靠两处兜底判断（真机数据回来后按 raw_json 收敛成确定字段）：
 *   1) 文案：任何短字符串里出现「不支持(线上)开票 / 不可线上开票 / 禁止线上开票」
 *   2) 开关：键名带 invoice 且表达「不支持」的布尔/枚举
 */
const BLOCK_TEXT_RE = /不支持[^。]{0,6}开票|不可[^。]{0,4}线上开票|禁止[^。]{0,4}开票/;
const BLOCK_KEY_RE = /(unsupport|notsupport|noinvoice|forbid|ban|limit|disabled|caninvoice|supportinvoice|onlineinvoice)/i;
function detectBlocked(r) {
  if (!r || typeof r !== 'object') return false;
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'string' && v.length <= 60 && BLOCK_TEXT_RE.test(v)) return true;
    if (!BLOCK_KEY_RE.test(k)) continue;
    if (v === false) return true;
    if (v === 0 || v === '0') return true;
    if (typeof v === 'string' && /^(N|NO|false|不支持)$/i.test(v.trim())) return true;
  }
  return false;
}

/** 订单列表一行 → 库表列（字段名按候选取；新订单默认 stage=1，开票状态由第二个来源覆盖） */
function mapOrderRow(r) {
  const orderSn = pickVal(r, ['orderId', 'orderSn', 'orderNo', 'orderIdStr', 'idStr', 'id', 'bizOrderNo']);
  if (!orderSn) return null;
  const poi = r.wmPoi || r.poi || {};
  const shop = r.shop || r.seller || {};
  const moneyCents = /fen|cent/i.test(Object.keys(r).join(','));
  return {
    stage: 1,
    order_sn: String(orderSn),
    shop_id: String(pickVal(r, ['shopId', 'shopIdStr', 'sellerId', 'sellerShopId']) || shop.id || '') || null,
    shop_name: pickVal(r, ['shopName', 'sellerName', 'shopNameStr']) || shop.name || '',
    wm_poi_id: String(pickVal(r, ['shangouShopId', 'wmPoiId', 'poiId']) || poi.id || '') || null,
    wm_poi_name: pickVal(r, ['wmPoiName', 'poiName']) || poi.name || '',
    invoice_apply_status: Number(pickVal(r, ['invoiceApplyStatus', 'invoiceStatus']) || 0),
    invoice_apply_desc: pickVal(r, ['invoiceApplyStatusDesc', 'invoiceStatusDesc']) || null,
    invoice_title: (r.orderInvoice && r.orderInvoice.invoiceTitle) || pickVal(r, ['invoiceTitle']) || null,
    taxpayer_ident: (r.orderInvoice && r.orderInvoice.invoiceCode) || pickVal(r, ['taxpayerIdent', 'invoiceCode']) || null,
    taker_email: (r.orderInvoice && r.orderInvoice.email) || pickVal(r, ['takerEmail', 'email']) || null,
    invoice_type_desc: (r.orderInvoice && r.orderInvoice.invoiceTypeDesc) || pickVal(r, ['invoiceTypeDesc']) || null,
    batch_no: pickVal(r, ['batchNo']),
    total_amount: moneyOf(pickVal(r, ['totalAmount', 'orderAmount', 'totalFee']), moneyCents),
    payable_amount: moneyOf(pickVal(r, ['payableAmount', 'actualPayAmount', 'payAmount']), moneyCents)
      || moneyOf(pickVal(r, ['totalAmount', 'orderAmount', 'totalFee']), moneyCents),
    actual_pay_amount: moneyOf(pickVal(r, ['actualPayAmount', 'payAmount']), moneyCents),
    after_total_amount: moneyOf(pickVal(r, ['afterTotalAmount', 'refundAmount']), moneyCents),
    // 订单时间：接口实测字段是 orderDate（也是 orderStartTime 过滤所依据的那个时间）
    order_time: timeMs(pickVal(r, ['orderDate', 'payDate', 'orderTime', 'createTime', 'orderCreateTime'])),
    // 支付时间：有单独的支付字段就用它，没有则回落到订单时间
    // （增量锚点取 MAX(pay_time)，若这里留空会让每次刷新都退回「拉近一年」的全量）
    pay_time: timeMs(pickVal(r, ['payDate', 'payTime', 'paymentTime']))
      || timeMs(pickVal(r, ['orderDate'])),
    finish_time: timeMs(pickVal(r, ['finishTime', 'completeTime'])),
    apply_time: timeMs(pickVal(r, ['applyTime', 'invoiceApplyTime'])),
    trade_status_desc: pickVal(r, ['tradeStatusDesc', 'orderStatusDesc', 'statusDesc']),
    refund_status_desc: pickVal(r, ['refundStatusDesc', 'orderRefundStatusDesc']),
    item_count: numOf(pickVal(r, ['totalItemCount', 'itemCount'])),
    item_names: (Array.isArray(r.itemList) ? r.itemList.map((i) => i && i.productName) : []).filter(Boolean).slice(0, 8).join('、'),
    online_blocked: detectBlocked(r) ? 1 : 0,
    raw_json: rawOf(r),
  };
}

/** 已申请/已开票一行 → 库表列。开票时间用来做增量，完成状态用 stage=4（不再催） */
function mapInvoiceRow(r) {
  const orderSn = pickVal(r, ['orderNo', 'orderId', 'orderSn']);
  if (!orderSn) return null;
  const applyStatus = Number(pickVal(r, ['invoiceApplyStatus']) || 0);
  const desc = String(pickVal(r, ['invoiceStatusDesc', 'invoiceApplyStatusDesc']) || '');
  const invoiceNo = pickVal(r, ['invoiceNo', 'eInvoiceNo', 'invoiceNumber']);
  // 有发票号，或状态文案是「已开票/已开具/开票成功/已下载」→ 认定开票完成
  const done = !!invoiceNo || /已开票|已开具|开票成功|已下载|已发送/.test(desc);
  return {
    stage: done ? 4 : 2,
    order_sn: String(orderSn),
    shop_id: String(pickVal(r, ['shopId', 'shopIdStr']) || '') || null,
    shop_name: pickVal(r, ['shopName', 'sellerName']) || '',
    wm_poi_id: String(pickVal(r, ['wmPoiId', 'shangouShopId']) || '') || null,
    wm_poi_name: pickVal(r, ['wmPoiName', 'poiName']) || '',
    invoice_apply_status: applyStatus,
    invoice_apply_desc: desc || (applyStatus === 1 ? '已申请' : null),
    invoice_title: pickVal(r, ['invoiceTitle']) || null,
    taxpayer_ident: pickVal(r, ['taxpayerIdent']) || null,
    taker_email: pickVal(r, ['takerEmail']) || null,
    invoice_type_desc: pickVal(r, ['invoiceTypeDesc']) || null,
    batch_no: pickVal(r, ['batchNo']),
    total_amount: numOf(pickVal(r, ['totalAmount'])),
    payable_amount: numOf(pickVal(r, ['payableAmount', 'totalAmount'])),
    actual_pay_amount: numOf(pickVal(r, ['actualPayAmount'])),
    after_total_amount: numOf(pickVal(r, ['afterTotalAmount'])),
    order_time: timeMs(pickVal(r, ['orderDate', 'tradeTime', 'orderTime'])),
    pay_time: timeMs(pickVal(r, ['payTime'])) || timeMs(pickVal(r, ['orderDate'])),
    finish_time: timeMs(pickVal(r, ['finishTime'])),
    apply_time: timeMs(pickVal(r, ['applyTime'])),
    // 开票时间：接口实测字段是 invoiceDate（也是 billStartTime 过滤所依据的那个时间）
    // 没有则是「已申请未开票」，回落到申请时间只为让该行仍能被增量命中
    invoice_time: timeMs(pickVal(r, ['invoiceDate', 'invoiceTime', 'issueTime'])) || timeMs(pickVal(r, ['applyTime'])),
    online_blocked: detectBlocked(r) ? 1 : 0,
    raw_json: rawOf(r),
  };
}

/** 时间戳 → 'MM-DD HH:mm'（日志用） */
function fmtMs(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * ① 订单列表：按支付时间区间增量翻页（orderStartTime / orderEndTime，毫秒）
 * @returns {Promise<{rows:number,pages:number,error?:string,firstKeys?:string[]}>}
 */
async function fetchOrderList(wc, { startMs, endMs, pageSize, api, emit, isStopped }) {
  let pageNo = 1;
  let total = 0;
  let pages = 0;
  let firstKeys = null;
  for (;;) {
    if (isStopped()) return { rows: total, pages, error: '已停止' };
    const body = {
      searchKey: '',
      orderStatus: -1,               // -1 = 全部状态
      orderStartTime: Number(startMs),
      orderEndTime: Number(endMs),
      pageNo,
      pageSize,
      _t: Date.now(),
      queryUnCommented: false,
    };
    const r = await pageFetch(wc, ORDER_LIST_API, body);
    if (!r || r.error) return { rows: total, pages, error: String((r && r.error) || '页内请求失败') };
    if (Number(r.status) === 401 || Number(r.status) === 403) {
      return { rows: total, pages, error: `登录态失效或触发风控（HTTP ${r.status}）：请在本机重新登录后再试` };
    }
    const d = (r.json && r.json.data) || null;
    if (!d) {
      return { rows: total, pages, error: '订单列表返回结构异常（没有 data）：' + String((r.json && r.json.msg) || r.text || '').slice(0, 120) };
    }
    const list = Array.isArray(d.data) ? d.data : (Array.isArray(d.list) ? d.list : []);
    pages = Number(d.pages || d.totalPage) || pages;
    if (pageNo === 1) {
      firstKeys = list[0] ? Object.keys(list[0]) : [];
      api.log(`订单列表第 1 页 ${list.length} 行（共 ${pages || '?'} 页）；首单字段：${(firstKeys || []).slice(0, 14).join(', ') || '空'}`);
    }
    for (const raw of list) {
      const row = mapOrderRow(raw);
      if (row && row.order_sn) { await emit(row); total += 1; }
    }
    if (!list.length) break;
    if (pages && pageNo >= pages) break;
    pageNo += 1;
    if (pageNo > 400) break;      // 保险丝：别把风控惹急
    await sleep(320);
  }
  return { rows: total, pages, firstKeys };
}

/**
 * ② 已申请/已开票：按开票时间增量回写开票状态。
 * 时间过滤字段是 billStartTime（与订单列表的 orderStartTime 同风格，毫秒时间戳）；
 * 首次（sinceMs=0）不传该字段 = 全量拉一遍，之后只拉开票时间晚于锚点的。
 * 仍保留本地按 invoice_time 过滤做兜底：万一平台忽略该参数，也不会把全量行重复回传。
 */
async function fetchInvoiceRows(wc, { userId, pageSize, sinceMs, api, emit, isStopped }) {
  let pageNo = 1;
  let total = 0;
  let pages = 0;
  let skipped = 0;
  // 增量开关：有锚点就先带 billStartTime；若第 1 页返回 0 行，无法区分「真的没有新开票」
  // 和「时间格式不被接受」，所以回退成全量拉一次（宁可多一轮请求，也不要静默同步不到）
  let useSince = Number(sinceMs) > 0;
  for (;;) {
    if (isStopped()) return { rows: total, pages, skipped, error: '已停止' };
    const body = {
      pageNo,
      pageSize,
      _t: Date.now(),
      invoiceApplyStatusList: [1],
      userIdList: [Number(userId)],
    };
    // 传 0 有些网关会当成非法时间直接拒，所以首次同步干脆不传这个字段
    if (useSince) body.billStartTime = Number(sinceMs);
    const r = await pageFetch(wc, INVOICE_LIST_API, body);
    if (!r || r.error) return { rows: total, pages, skipped, error: String((r && r.error) || '页内请求失败') };
    if (Number(r.status) === 401 || Number(r.status) === 403) {
      return { rows: total, pages, skipped, error: `登录态失效或触发风控（HTTP ${r.status}）：请在本机重新登录后再试` };
    }
    const d = (r.json && r.json.data) || null;
    if (!d) {
      return { rows: total, pages, skipped, error: '开票接口返回结构异常（没有 data）：' + String((r.json && r.json.msg) || r.text || '').slice(0, 120) };
    }
    const list = Array.isArray(d.data) ? d.data : [];
    // 带了时间过滤却一行都没有 → 回退全量重试第 1 页
    if (pageNo === 1 && useSince && !list.length) {
      useSince = false;
      if (api && api.log) api.log('开票接口带 billStartTime 返回 0 行（可能是时间格式不符），改为全量拉取后本地按开票时间过滤');
      continue;
    }
    pages = Number(d.pages) || pages;
    for (const raw of list) {
      const row = mapInvoiceRow(raw);
      if (!row || !row.order_sn) continue;
      const t = Number(row.invoice_time || row.apply_time || 0);
      if (sinceMs && t && t <= sinceMs) { skipped += 1; continue; }   // 没变化就不回传
      await emit(row);
      total += 1;
    }
    if (api && api.log && (pageNo === 1 || pageNo % 5 === 0)) {
      api.log(`已拉取「已申请/已开票」第 ${pageNo}/${pages || '?'} 页，增量回传 ${total} 单（跳过 ${skipped} 单）`);
    }
    if (!list.length) break;
    if (pages && pageNo >= pages) break;
    pageNo += 1;
    await sleep(320);
  }
  return { rows: total, pages, skipped };
}

/**
 * 一次完整取数：登录检测 → ①订单列表（支付时间增量） → ②开票状态（开票时间增量）
 * @param {object} task { startMs, endMs, invoiceSinceMs, pageSize }
 * @param {object} api  { log(text), isStopped(), report(payload), emitRow(row) }
 */
async function runFetch(task, api) {
  let w = null;
  try {
    w = await getApiWindow(api);
  } catch (e) {
    api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    return;
  }
  const p = await probeLogin(w.webContents);
  if (!p.logined) {
    api.report({ ok: false, loginish: true, error: '本机浏览器里闪电帮帮未登录，请先在窗口里登录' });
    return;
  }
  const pageSize = Math.min(100, Math.max(10, Number(task.pageSize) || 50));
  const endMs = Number(task.endMs) || Date.now();
  // 首次同步（库里没订单）没有增量起点：默认拉近一年，日志里说清楚
  const startMs = Number(task.startMs) || (endMs - 365 * 86400 * 1000);
  const invoiceSinceMs = Number(task.invoiceSinceMs) || 0;
  const stopped = () => (api.isStopped ? api.isStopped() : false);

  api.log(`① 订单列表增量（orderStartTime，按订单时间 orderDate）：${fmtMs(startMs)} ~ ${fmtMs(endMs)}`);
  const orders = await fetchOrderList(w.webContents, {
    startMs, endMs, pageSize, api, isStopped: stopped,
    emit: (row) => api.emitRow(row),
  });
  if (orders.error && !orders.rows) {
    api.report({ ok: false, subUserId: p.subUserId, tally: { orders: 0 }, agentVer: currentVersion(), error: orders.error });
    return;
  }
  api.log(`① 完成：${orders.rows} 单（${orders.pages || 1} 页）`);

  api.log(`② 开票状态增量（billStartTime，按开票时间 invoiceDate）：${invoiceSinceMs ? '晚于 ' + fmtMs(invoiceSinceMs) : '首次全量'}`);
  const inv = await fetchInvoiceRows(w.webContents, {
    userId: p.subUserId, pageSize, sinceMs: invoiceSinceMs, api, isStopped: stopped,
    emit: (row) => api.emitRow(row),
  });
  api.log(`② 完成：回传 ${inv.rows} 单，跳过未变化 ${inv.skipped || 0} 单`);

  const errs = [orders.error, inv.error].filter(Boolean);
  api.report({
    ok: !errs.length || (orders.rows + inv.rows) > 0,
    subUserId: p.subUserId,
    tally: { orders: orders.rows, invoice: inv.rows, skipped: inv.skipped || 0 },
    agentVer: currentVersion(),
    error: errs.join('；'),
  });
}

// ── 发催收消息 ──────────────────────────────────────────────────────
/** 取店铺会话 ID：只有 name 为 sdc 的会话; 失败返回空串 */
async function selectSession(wc, shopId) {
  const r = await pageFetch(wc, '/mallApi/im/shop/pub/select' + QS, { shopId: Number(shopId) });
  if (!r || r.error) return '';
  const d = r.json && r.json.data;
  return d ? String(d) : '';
}

/** 页面里找编辑器（主框架 + 同源 iframe 都翻一遍） */
function findEditorJs() {
  return `(function () {
    var roots = [document];
    try {
      var ifr = document.querySelectorAll('iframe');
      for (var i = 0; i < ifr.length; i++) {
        try { if (ifr[i].contentDocument) roots.push(ifr[i].contentDocument); } catch (e) {}
      }
    } catch (e) {}
    var SEL = 'pre[contenteditable="true"], div[contenteditable="true"], '
      + '[contenteditable="true"], textarea, input[type="text"]';
    // 不能见到第一个就认：页面里常藏着表情/富文本用的隐藏 contenteditable，
    // 右侧「搜索商品」也是 input[type=text]。取「可见 + contenteditable/textarea 优先 + 面积最大」的那个。
    var best = null;
    var bestScore = -1;
    for (var n = 0; n < roots.length; n++) {
      var list = Array.from(roots[n].querySelectorAll(SEL));
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        var r = el.getBoundingClientRect();
        var vis = !!(el.offsetParent || el.getClientRects().length) && r.width > 40 && r.height > 18;
        if (!vis) continue;
        var kind = (el.getAttribute('contenteditable') === 'true' || el.tagName === 'TEXTAREA') ? 1 : 0;
        var score = kind * 1e9 + r.width * r.height;
        if (score > bestScore) { best = el; bestScore = score; }
      }
      if (best) break;   // 主框架里有就别翻 iframe 了
    }
    if (best) {
      try { best.setAttribute('data-sdc-editor', '1'); } catch (e) {}
      return { found: true, tag: best.tagName, cls: String(best.className || '').slice(0, 80) };
    }
    return { found: false };
  })()`;
}

/** 往编辑器里填内容（走 execCommand，React/Vue 受控组件也能收到 input 事件） */
function fillJs(text) {
  return `(function (text) {
    var el = document.querySelector('[data-sdc-editor="1"]');
    if (!el) return { ok: false, err: '编辑器丢失' };
    try { el.focus(); } catch (e) {}
    var isCE = el.getAttribute('contenteditable') === 'true' || el.tagName === 'PRE' || el.tagName === 'DIV';
    if (isCE) {
      try { document.execCommand('selectAll', false, null); } catch (e) {}
      try { document.execCommand('delete', false, null); } catch (e) {}
      try { document.execCommand('insertText', false, text); } catch (e) {}
    } else {
      try {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
        var setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // ⚠ textarea / input 的 innerText 是空字符串（不是 null），走「innerText != null」分支会取到空串，
    //   明明内容已经进去了却被判「没填入」——表单元素必须读 value（0.2.58 及之前栽在这里）。
    var form = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    var got = String(form ? (el.value || '')
      : (el.innerText !== null && el.innerText !== undefined && el.innerText !== '' ? el.innerText : (el.textContent || '')));
    return { ok: got.indexOf(String(text).slice(0, 8)) >= 0, len: got.length, tag: el.tagName };
  })(${JSON.stringify(text)})`;
}

/**
 * 点发送。
 * ⚠ 不能「全局第一个叫发送的按钮就点」：右侧「咨询商品」栏里每个商品都带一个黄色「发送」，
 *   点了它只会把商品卡片发出去，话术原地不动（0.2.57 及之前的现象：内容填进去了却发不出去）。
 * 策略：从输入框往上逐层找容器，越靠近输入框的「发送」越可信；再按可见性与商品栏排除兜底。
 */
function sendJs() {
  return `(function () {
    var ed = document.querySelector('[data-sdc-editor="1"]');
    var SIDEBAR = '[class*="goods"], [class*="product"], [class*="sku"], [class*="aside"]';
    function visible(b) {
      var r = b.getBoundingClientRect();
      return !!(b.offsetParent || b.getClientRects().length) && r.width > 0 && r.height > 0;
    }
    function pick(root) {
      var list = Array.from(root.querySelectorAll('button, [role="button"], [class*="btn"], [class*="send"]'));
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        var t = String((b.innerText || b.textContent || '')).trim();
        if (t !== '发送' && !/^send$/i.test(t)) continue;
        if (!visible(b)) continue;
        if (b.closest(SIDEBAR)) continue;              // 商品/侧栏里的「发送」是发商品的
        return b;
      }
      return null;
    }
    var node = ed;
    for (var k = 0; k < 10 && node; k++) {
      var hit = pick(node);
      if (hit) {
        var off = hit.disabled || hit.getAttribute('disabled') !== null
          || String(hit.className || '').indexOf('disabled') >= 0;
        if (off) return { by: '', disabled: true, where: 'lvl' + k };
        hit.click();
        return { by: 'button', where: 'lvl' + k };
      }
      node = node.parentElement;
    }
    var hit2 = pick(document.body);
    if (hit2) { hit2.click(); return { by: 'button', where: 'global' }; }
    return { by: '' };
  })()`;
}

async function waitEditor(wc, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let info = { found: false };
  while (Date.now() < deadline) {
    info = await wc.executeJavaScript(findEditorJs(), true).catch(() => ({ found: false }));
    if (info && info.found) return info;
    await sleep(600);
  }
  return { found: false };
}

/** 会话里是否已出现这条消息（用于确认真的发出去了） */
async function hasText(wc, snippet) {
  const r = await wc.executeJavaScript(
    `(function (s) { try { return String(document.body.innerText || '').indexOf(s) >= 0; } catch (e) { return false; } })(${JSON.stringify(snippet)})`,
    true
  ).catch(() => false);
  return !!r;
}

/** 任一片段命中即算上屏：聊天区有时会把长消息折行/截断显示，头尾各取一段更稳 */
async function hasAnyText(wc, snippets) {
  for (const s of snippets || []) {
    if (s && await hasText(wc, s)) return true;
  }
  return false;
}

/** 页面内合成回车（最后的兜底：某些 IM 只认 keyboard 事件） */
function synthEnterJs() {
  return `(function () {
    var el = document.querySelector('[data-sdc-editor="1"]');
    if (!el) return false;
    try { el.focus(); } catch (e) {}
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    } catch (e) { return false; }
    return true;
  })()`;
}

/**
 * 真实按键回车：走浏览器输入通道，React/Vue 受控组件也认，
 * 比页面里 dispatchEvent 合成事件可靠得多（页面提示「Shift+Enter 换行」⇒ Enter 就是发送）。
 */
async function nativeEnter(w) {
  try {
    await w.webContents.executeJavaScript(
      '(function () { var el = document.querySelector(\'[data-sdc-editor="1"]\'); if (el) { try { el.focus(); } catch (e) {} } return true; })()',
      true
    ).catch(() => null);
  } catch (e) { /* 忽略 */ }
  try { w.focus(); } catch (e) { /* 忽略 */ }
  await sleep(180);
  try {
    const ev = { keyCode: 'Return', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, isSystemKey: false };
    w.webContents.sendInputEvent(Object.assign({ type: 'keyDown' }, ev));
    await sleep(90);
    w.webContents.sendInputEvent({ type: 'char', keyCode: 13, key: '\r', text: '\r' });
    w.webContents.sendInputEvent(Object.assign({ type: 'keyUp' }, ev));
    return true;
  } catch (e) { return false; }
}

/** 聊天区最后几行文本（发送失败时回传，远程能看看到底出去的是什么） */
function lastMsgsJs(n) {
  return `(function () {
    try {
      var all = String(document.body.innerText || '').split('\\n')
        .map(function (s) { return String(s).trim(); }).filter(Boolean);
      return all.slice(-${Math.max(1, Number(n) || 6)}).map(function (s) { return s.slice(0, 60); });
    } catch (e) { return []; }
  })()`;
}

/**
 * 批量催收：逐店打开客服会话 → 逐条打字发送 → 回执。
 * @param {object} task { taskId, items:[{shopId, shopName, contents:[string], orderSns:[]}], gapMs }
 */
async function runSend(task, api) {
  const items = Array.isArray(task.items) ? task.items : [];
  if (!items.length) { api.report({ ok: false, error: '没有需要催收的店铺' }); return; }
  const gap = Number(task.gapMs) || 6000;
  const results = [];
  const stopped = () => (api.isStopped ? api.isStopped() : false);

  let w = null;
  try { w = await getApiWindow(api); } catch (e) {
    api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); return;
  }
  const login = await probeLogin(w.webContents);
  if (!login.logined) {
    api.report({ ok: false, loginish: true, error: '本机浏览器里闪电帮帮未登录，请在助手窗口里登录后重试' });
    return;
  }

  const chat = getChatWindow();

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (stopped()) break;
    const sid = await selectSession(w.webContents, it.shopId);
    if (!sid) {
      results.push({ ok: false, shopId: it.shopId, shopName: it.shopName, detail: '取不到会话 ID（店铺可能已关闭会话入口）' });
      api.log(`✗ ${it.shopName || it.shopId}：取不到会话 ID`);
      continue;
    }
    api.log(`▶ 第 ${i + 1}/${items.length} 家：${it.shopName || it.shopId}（会话 ${sid}），${it.contents.length} 条消息`);
    try {
      await chat.loadURL(`${CHAT_URL}?sessionId=${encodeURIComponent(sid)}`).catch(() => {});
      const ed = await waitEditor(chat.webContents, 25000);
      if (!ed || !ed.found) {
        results.push({ ok: false, shopId: it.shopId, shopName: it.shopName, detail: '聊天页输入框未就绪（可能被风控拦截或登录态失效）' });
        api.log(`✗ ${it.shopName || it.shopId}：输入框 25 秒内未出现`);
        continue;
      }
      api.log(`   输入框就绪：<${ed.tag}> ${String(ed.cls || '').slice(0, 40)}`);
      let sent = 0;
      let lastErr = '';
      for (const content of it.contents) {
        if (stopped()) break;
        const filled = await chat.webContents.executeJavaScript(fillJs(content), true).catch(() => ({ ok: false, err: '填入失败' }));
        api.log(`   填入结果：${filled && filled.ok ? 'ok' : '失败'}（<${(filled && filled.tag) || '?'}> 长度 ${filled ? filled.len : 0}/${content.length}）`);
        if (!filled || !filled.ok) { lastErr = (filled && filled.err) || '内容没能填入输入框'; break; }
        // 头尾各取一段：长消息在聊天区里可能被折行/截断，只认开头容易漏判
        const seen = [content.slice(0, 12), content.slice(-12)];
        const before = await hasAnyText(chat.webContents, seen);
        const s = await chat.webContents.executeJavaScript(sendJs(), true).catch(() => ({ by: '' }));
        // 发送方式打到日志里：真机排查时一眼能看出是点了按钮、还是退到回车
        api.log(`   发送动作：${s && s.by ? `点按钮（${s.where}）` : (s && s.disabled ? '按钮不可用，改用回车' : '没找到发送按钮，改用回车')}`);
        if (!s || !s.by) await nativeEnter(chat);
        let ok = false;
        for (let k = 0; k < 30; k += 1) {          // 15 秒：长消息上屏有延迟
          await sleep(500);
          if (await hasAnyText(chat.webContents, seen)) { ok = true; break; }
        }
        if (!ok) {
          // 按钮没点动、真实回车也没生效：再补一次页面内合成的回车（两条都不成功才补，避免重复发送）
          api.log('   15 秒内没看到消息上屏，补一次页面内合成回车…');
          await chat.webContents.executeJavaScript(synthEnterJs(), true).catch(() => null);
          for (let k = 0; k < 16; k += 1) {
            await sleep(500);
            if (await hasAnyText(chat.webContents, seen)) { ok = true; break; }
          }
        }
        if (!ok && before) ok = true;   // 发之前聊天记录里已经有同样内容（重复催收）也算成功
        if (ok) { sent += 1; } else {
          lastErr = '发送后聊天记录里没找到这条消息';
          const msgs = await chat.webContents.executeJavaScript(lastMsgsJs(6), true).catch(() => []);
          api.log('   聊天区最后几行：' + (Array.isArray(msgs) && msgs.length ? msgs.join(' ␟ ').slice(0, 300) : '（取不到页面文本）'));
          break;
        }
        await sleep(900);
      }
      const okAll = sent === it.contents.length;
      results.push({
        ok: okAll, shopId: it.shopId, shopName: it.shopName,
        sent, total: it.contents.length, orderSns: it.orderSns || [], amount: it.amount || null,
        contents: it.contents,
        detail: okAll ? `已发送 ${sent} 条` : (lastErr || `只发出 ${sent}/${it.contents.length} 条`),
      });
      api.log(`${okAll ? '✓' : '✗'} ${it.shopName || it.shopId}：${okAll ? `已发送 ${sent} 条` : (lastErr || '未完成')}`);
      if (typeof api.progress === 'function') {
        // 逐店回执：服务端的 SDC_TASKS 据此实时更新「第 N/M 家 · 当前店名 · 成功x 失败y」，
        // 老助手（没有这个通道）只能靠服务端从日志行兜底猜。
        api.progress({
          results: results.slice(),
          done: results.length,
          current: it.shopName || it.shopId,
          okCount: results.filter((x) => x.ok).length,
          failCount: results.filter((x) => !x.ok).length,
        });
      }
    } catch (e) {
      results.push({ ok: false, shopId: it.shopId, shopName: it.shopName, detail: String((e && e.message) || e).slice(0, 200) });
    }
    if (i < items.length - 1 && !stopped()) await sleep(gap);
  }

  const okCount = results.filter((r) => r.ok).length;
  api.report({
    ok: okCount > 0,
    results,
    okCount,
    failCount: results.length - okCount,
    stopped: stopped(),
  });
}

function currentVersion() {
  try { return require('../../package.json').version || ''; } catch (e) { return ''; }
}

// ── 处理器工厂（main.js 注入 ws-client） ────────────────────────────
function createLoginHandler({ log = () => {} } = {}) {
  return async function handleSdcLogin(task, api) {
    try { await runLogin(task, api); }
    catch (e) { log('闪电帮帮登录异常: ' + ((e && e.message) || e)); api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
  };
}

function createFetchHandler({ log = () => {} } = {}) {
  return async function handleSdcFetch(task, api) {
    try { await runFetch(task, api); }
    catch (e) { log('闪电帮帮取数异常: ' + ((e && e.message) || e)); api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
  };
}

function createSendHandler({ log = () => {} } = {}) {
  return async function handleSdcSend(task, api) {
    try { await runSend(task, api); }
    catch (e) { log('闪电帮帮催收异常: ' + ((e && e.message) || e)); api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
  };
}

module.exports = {
  PARTITION, HOST, HOME_URL, LOGIN_URL, CHAT_URL,
  createLoginHandler, createFetchHandler, createSendHandler,
  openLogin, peekWindow, peekApiWindow, peekChatWindow,
  probeLogin, runLogin, runFetch, runSend, selectSession,
  // 纯函数也导出：字段映射最容易写错（字段名一换就静默变 NULL），要能单独测
  mapOrderRow, mapInvoiceRow, detectBlocked,
};
