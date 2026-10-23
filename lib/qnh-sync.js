/**
 * lib/qnh-sync.js — 牵牛花接口层（Node 版，替代 qnh-refund-sync/bridge.py）
 *
 * 为什么要这个模块：
 *   原来「拉退单 / 入库」全靠一个独立的 Python 工程（qnh-refund-sync），
 *   它不在部署机器上就整条链路失效。现在把能力收进 Node，一套程序、一套配置、一个库。
 *
 * ⚠ 2026-10-22 起（v0.2.6）：**服务器不再自己打开浏览器登录牵牛花**。
 *   之前登录要 chromium.launch() 出一个有头浏览器——本机缺 Playwright 二进制会直接报
 *   「Executable doesn't exist at …ms-playwright\chromium-xxx\chrome.exe」，
 *   部署到云服务器更是既没有显示器也没有浏览器。
 *   现在登录态由**用户本机的「1688 催收助手」**采集（Electron 内置浏览器）后回传，
 *   登录态**存进 MySQL（qnh_session 表）**，服务器只拿 Cookie 直接调接口拉数据：
 *     · 服务器不装浏览器、不碰任何本机路径 → 可整体搬到云上
 *     · 容器重启/扩缩容不丢登录态（原来存 data/qnh-state.json，容器一重启就没）
 *
 * 本模块只做「拿到登录态 → 带着它调接口」，不关心登录态从哪来：
 *   登录态由调用方（lib/qnh.js）通过 setStateProvider() 注入（从数据库读）。
 *
 * 接口基址可用 QNH_BASE_URL 覆盖（测试时指向本地假服务，生产默认 qnh.meituan.com）。
 */
const BASE_URL = (process.env.QNH_BASE_URL || 'https://qnh.meituan.com').replace(/\/+$/, '');
const API_PREFIX = '/api/v1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_TIMEOUT = Number(process.env.QNH_API_TIMEOUT) || 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 登录态（storageState）────────────────────────────────────
// 登录态不再来自本机文件，而是由调用方注入（lib/qnh.js 从 MySQL 读）。
// 注入的是 async () => storageState|null。
let _stateProvider = null;
let _stateMetaProvider = null;   // async () => {writtenAt, source}

/** 注册登录态来源（由 server 启动时调用一次） */
function setStateProvider(provider, metaProvider) {
  _stateProvider = typeof provider === 'function' ? provider : null;
  _stateMetaProvider = typeof metaProvider === 'function' ? metaProvider : null;
}

function stateHost() {
  try { return new URL(BASE_URL).hostname; } catch (e) { return 'qnh.meituan.com'; }
}

async function readState(userId = 0) {
  if (!_stateProvider) return null;
  try {
    const st = _stateProvider(userId);
    return st && typeof st.then === 'function'
      ? st.then((s) => (s && typeof s === 'object' ? s : null)).catch(() => null)
      : Promise.resolve(st && typeof st === 'object' ? st : null);
  } catch (e) {
    return Promise.resolve(null);
  }
}

async function stateExists(userId = 0) {
  return !!(await readState(userId));
}

/** 只取当前站点域的 Cookie（storageState 里可能混着其他域） */
async function stateCookies(userId = 0) {
  const st = await readState(userId);
  const host = stateHost();
  if (!st || !Array.isArray(st.cookies)) return [];
  return st.cookies.filter((c) => {
    const d = String((c && c.domain) || '').replace(/^\./, '');
    if (!d) return false;
    return d === host || host.endsWith('.' + d) || d.endsWith('.' + host);
  });
}

async function cookieHeader(userId = 0) {
  return (await stateCookies(userId)).map((c) => `${c.name}=${c.value}`).join('; ');
}

async function stateWrittenAt(userId = 0) {
  if (!_stateMetaProvider) return null;
  try { return (await _stateMetaProvider(userId)).writtenAt || null; } catch (e) { return null; }
}

async function earliestExpiry(userId = 0) {
  const now = Date.now() / 1000;
  const live = (await stateCookies(userId)).filter((c) => Number(c.expires) > now);
  if (!live.length) return null;
  live.sort((a, b) => Number(a.expires) - Number(b.expires));
  return new Date(Number(live[0].expires) * 1000).toISOString();
}

async function earliestExpiryName(userId = 0) {
  const now = Date.now() / 1000;
  const live = (await stateCookies(userId)).filter((c) => Number(c.expires) > now);
  if (!live.length) return null;
  live.sort((a, b) => Number(a.expires) - Number(b.expires));
  return live[0].name || null;
}

async function stateMeta(userId = 0) {
  const cookies = await stateCookies(userId);
  const m = _stateMetaProvider ? await _stateMetaProvider(userId).catch(() => ({})) : {};
  return {
    exists: cookies.length > 0,
    storage: 'db',                 // 登录态存在数据库（云端/多实例共享），不再落本机文件
    cookieCount: cookies.length,
    writtenAt: m.writtenAt || null,
    source: m.source || '',
    earliestExpiry: await earliestExpiry(),
  };
}

/**
 * 把「本机助手」采集到的 Cookie 列表（Electron 的 cookie 对象）转成 Playwright storageState 格式。
 * 只保留本站点域的 Cookie，丢掉过期/无域名/无名的脏数据。
 * @param {Array} list Electron session cookies（name/value/domain/path/expirationDate/secure/httpOnly/sameSite）
 * @returns {{cookies: Array, origins: Array}}
 */
function buildStorageState(list) {
  const host = stateHost();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.name) continue;
    const domain = String(c.domain || '').replace(/^\./, '');
    if (!domain) continue;
    if (!(domain === host || host.endsWith('.' + domain) || domain.endsWith('.' + host))) continue;
    let expires = Number(c.expirationDate != null ? c.expirationDate : c.expires);
    if (!Number.isFinite(expires)) expires = -1;        // 会话 Cookie
    const item = {
      name: String(c.name),
      value: String(c.value == null ? '' : c.value),
      domain,
      path: String(c.path || '/'),
      expires,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    };
    const ss = String(c.sameSite || '').toLowerCase();
    if (ss === 'no_restriction' || ss === 'none') item.sameSite = 'None';
    else if (ss === 'lax') item.sameSite = 'Lax';
    else if (ss === 'strict') item.sameSite = 'Strict';
    out.push(item);
  }
  return { cookies: out, origins: [] };
}

/** 登录态里最早过期的 Cookie 到期时间（秒），没有长期 Cookie 时返回 null */
function soonestExpiry(storageState) {
  const now = Date.now() / 1000;
  const live = (Array.isArray(storageState && storageState.cookies) ? storageState.cookies : [])
    .filter((c) => Number(c.expires) > now);
  if (!live.length) return null;
  live.sort((a, b) => Number(a.expires) - Number(b.expires));
  return Number(live[0].expires);
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
async function apiFetch(pathname, { method = 'GET', headers = {}, body = null, timeoutMs = API_TIMEOUT, userId = 0 } = {}) {
  const cookie = await cookieHeader(userId);
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
async function isLogined(userId = 0) {
  let r = await apiFetch(API_PREFIX + '/isLogined', { method: 'POST', body: {}, userId });
  if (r.status === 404 || r.status === 405) {
    r = await apiFetch(API_PREFIX + '/isLogined', { method: 'GET', userId });
  }
  if (r.error) return { logined: false, account: null, httpStatus: r.status, error: r.error };
  const p = parseLogined(r.json, r.status);
  return { ...p, httpStatus: r.status, raw: r.json };
}

// ── 业务接口（退单列表 / 明细）───────────────────────────────
// 抓包确认：这三个接口 Cookie 鉴权即可，无需 mtgsig 签名；
// 但 queryOrderRoute（配送轨迹）被 WAF 要求签名，Node 侧暂不拉取（has_delivery_log 恒 0）。
const POST_HEADERS = {
  'Content-Type': 'application/json',
  Origin: 'https://qnh.meituan.com',
  Referer: 'https://qnh.meituan.com/home.html',
  'M-APPKEY': 'fe_recofesaascrm',
  qnhReferrer: '/crmOrder/order/backList',
};

async function apiPost(pathname, body, { timeoutMs = API_TIMEOUT, userId = 0 } = {}) {
  const r = await apiFetch(pathname, { method: 'POST', body, headers: POST_HEADERS, timeoutMs, userId });
  if (r.error) return { ok: false, message: r.error };
  if ([401, 403].includes(r.status) || (r.status >= 300 && r.status < 400)) {
    return { ok: false, loginRequired: true, message: `接口被拒绝（HTTP ${r.status}）：登录态可能已失效，请重新登录牵牛花` };
  }
  if (r.status === 429) return { ok: false, message: '请求过于频繁（HTTP 429），请稍后再试' };
  const j = r.json;
  if (!j || typeof j !== 'object') return { ok: false, message: `接口返回异常（HTTP ${r.status}，非 JSON）` };
  if (j.code !== 0) return { ok: false, message: `接口错误 code=${j.code}：${j.msg || j.message || '未知'}` };
  return { ok: true, data: j.data };
}

/** 拉一页退单列表。返回 {ok, records, pageInfo} 或 {ok:false,message} */
async function fetchRefundListPage({ page = 1, pageSize = 50, startMs, endMs, userId = 0 } = {}) {
  const body = { page, pageSize, _t: Date.now(), applyStartTime: String(startMs), applyEndTime: String(endMs) };
  const r = await apiPost(API_PREFIX + '/orderfuse/queryRefundList', body, { userId });
  if (!r.ok) return r;
  const d = r.data || {};
  const records = Array.isArray(d.refundApplyRecordVOList) ? d.refundApplyRecordVOList : [];
  const pi = d.pageInfo || {};
  return { ok: true, records, pageInfo: { page: pi.page || page, size: pi.size || pageSize, totalPage: Number(pi.totalPage) || 1, totalSize: Number(pi.totalSize) || records.length } };
}

/** 分页拉全量（页间限速 800ms，防风控）。返回 {ok, records, total, failedPages} */
async function fetchAllRefunds({ startMs, endMs, pageSize = 50, onPage = null, sleepMs = 800, userId = 0 } = {}) {
  const records = [];
  let total = 0;
  let failedPages = 0;
  let page = 1;
  for (;;) {
    const r = await fetchRefundListPage({ page, pageSize, startMs, endMs, userId });
    if (!r.ok) return { ...r, records, total, failedPages };
    records.push(...r.records);
    total = r.pageInfo.totalSize;
    if (typeof onPage === 'function') { try { onPage(page, r.pageInfo); } catch (e) { /* ignore */ } }
    if (page >= r.pageInfo.totalPage || r.records.length === 0) break;
    page += 1;
    await sleep(sleepMs);
  }
  return { ok: true, records, total, failedPages: 0 };
}

/** 拉单条退单明细（含商品行）。返回 {ok, detail, items} 或 {ok:false,message} */
async function fetchRefundDetail({ channelOrderId, channelId, channelAfsId, userId = 0 } = {}) {
  const r = await apiPost(API_PREFIX + '/orderfuse/afs/detail', {
    channelOrderId: String(channelOrderId), channelId, channelAfsId: String(channelAfsId),
  }, { userId });
  if (!r.ok) return r;
  const d = r.data || {};
  // itemInfo 是数组：[{sku,skuName,upc,spec,weight,unit,totalPrice,refundCount,orderItemId,originPrice,salePrice,picUrl...}]
  const rawItems = Array.isArray(d.itemInfo) ? d.itemInfo : [];
  return { ok: true, detail: d, items: rawItems };
}

// ── 映射（纯函数，便于隔离测试）──────────────────────────────
const toMs = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
};
const msToDate = (v) => {
  const ms = toMs(v);
  if (!ms) return null;
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
/** 列表金额是「分」（如 846 = ¥8.46），落库存「元」两位小数 */
const fenToYuan = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) / 100 : null;
};
const yuanOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 把接口的一条退单记录映射成 qnh_refund_order 行 + qnh_refund_log 行数组 */
function mapRefundRecord(rec, { batchId = null } = {}) {
  if (!rec || typeof rec !== 'object') return null;
  const o = rec.orderVO || {};
  const finishLog = Array.isArray(rec.afterSaleStatusLogList)
    ? rec.afterSaleStatusLogList.find((l) => Number(l.operatorType) === 30)
    : null;
  // serialNo（展示用订单号）：接口字段位置可能调整，逐个候选兜底
  const serialNo = [o.serialNo, o.serial_no, rec.serialNo, rec.serial_no, o.orderSerialNo]
    .find((v) => v != null && v !== '') || null;
  // 顾客配送地址：列表接口的 orderVO 里带 address / receiverAddress
  const receiverAddress = [o.receiverAddress, o.address, rec.receiverAddress]
    .find((v) => v != null && v !== '') || null;
  // 已支付时间：接口若直接给 payTime / paidTime 就先入库；没有则等配送日志补（见 lib/qnh.js）
  const payMs = toMs(o.payTime) || toMs(o.paidTime) || toMs(rec.payTime) || toMs(o.payTs) || null;

  const row = {
    refund_no: String(rec.afterSaleId || o.channelAfsId || '').slice(0, 64),
    service_id: rec.serviceId == null ? null : String(rec.serviceId).slice(0, 64),
    qnh_tenant_id: o.tenantId == null ? null : String(o.tenantId).slice(0, 32),
    order_no: o.channelOrderId == null ? null : String(o.channelOrderId).slice(0, 64),
    serial_no: serialNo == null ? null : String(serialNo).slice(0, 64),
    channel_name: o.channelName == null ? null : String(o.channelName).slice(0, 64),
    channel_id: Number(o.channelId) || null,
    store_id: o.storeId == null ? null : String(o.storeId).slice(0, 64),
    store_name: o.storeName == null ? null : String(o.storeName).slice(0, 128),
    order_status: o.orderStatusDesc == null ? null : String(o.orderStatusDesc).slice(0, 32),
    order_status_code: Number(o.orderStatus) || null,
    refund_status: rec.statusDesc == null ? null : String(rec.statusDesc).slice(0, 32),
    refund_status_code: Number(rec.status) || null,
    refund_type: rec.afsApplyTypeDesc == null ? null : String(rec.afsApplyTypeDesc).slice(0, 64),
    is_appeal: Array.isArray(rec.refundOrderTagList) && rec.refundOrderTagList.length ? 1 : 0,
    apply_source: rec.fuseWhoApplyTypeDesc == null ? null : String(rec.fuseWhoApplyTypeDesc).slice(0, 32),
    apply_source_code: Number(rec.fuseWhoApplyType) || null,
    apply_reason: rec.applyReason == null ? null : String(rec.applyReason).slice(0, 512),
    refund_amount: fenToYuan(rec.refundAmt),
    goods_amount: null,
    commission: null,
    return_freight: rec.preReturnFreight == null ? null : Number(rec.preReturnFreight),
    return_freight_actual: null,
    refund_qty: Number(rec.refundProductCount) || null,
    refund_weight: Number(rec.refundTotalWeight) || null,
    apply_time: msToDate(rec.createTime),
    apply_ts: toMs(rec.createTime),
    update_ts: toMs(rec.updateTime),
    finish_time: msToDate(finishLog && finishLog.operationTime),
    finish_ts: toMs(finishLog && finishLog.operationTime),
    receiver_name: o.receiverName == null ? null : String(o.receiverName).slice(0, 64),
    receiver_phone: o.receiverPhone == null ? null : String(o.receiverPhone).slice(0, 32),
    receiver_address: receiverAddress == null ? null : String(receiverAddress).slice(0, 255),
    paid_time: payMs ? msToDate(payMs) : null,
    paid_ts: payMs,
    audit_time: msToDate(rec.auditTime),
    audit_operator: rec.auditOperatorName == null ? null : String(rec.auditOperatorName).slice(0, 64),
    audit_reason: rec.auditReason == null ? null : String(rec.auditReason).slice(0, 512),
    item_kinds: Number(rec.refundProductCount) || null,
    detail_synced: 0,
    has_delivery_log: 0,
    picked_log: 0,
    log_synced: 0,
    sync_batch_id: batchId,
    raw_json: JSON.stringify(rec),
  };
  if (!row.refund_no) return null;

  const logs = (Array.isArray(rec.afterSaleStatusLogList) ? rec.afterSaleStatusLogList : [])
    .filter((l) => l && l.operationTime != null)
    .map((l) => ({
      refund_no: row.refund_no,
      order_no: row.order_no,
      log_type: 'order',
      operator_name: l.operatorDesc == null ? '' : String(l.operatorDesc).slice(0, 64),
      op_time: msToDate(l.operationTime),
      op_time_ms: toMs(l.operationTime),
      content: l.operatorDesc == null ? '' : String(l.operatorDesc).slice(0, 255),
      note: l.operatorType == null ? null : String(l.operatorType),
      source: 'list',
      raw_json: JSON.stringify(l),
    }));
  return { row, logs };
}

/** 把明细接口的商品行映射成 qnh_refund_item 行（金额已是元） */
function mapRefundItems(refundNo, tenantId, rawItems, { batchId = null } = {}) {
  return (Array.isArray(rawItems) ? rawItems : [])
    .filter((it) => it && typeof it === 'object')
    .map((it, i) => ({
      refund_no: String(refundNo).slice(0, 64),
      qnh_tenant_id: tenantId == null ? null : String(tenantId).slice(0, 32),
      item_key: String(it.orderItemId || `${it.sku || ''}#${i}`).slice(0, 160),
      line_no: i,
      item_role: 'main',
      parent_sku: null,
      sku: it.sku == null ? null : String(it.sku).slice(0, 64),
      sku_name: it.skuName == null ? null : String(it.skuName).slice(0, 255),
      upc: it.upc == null ? null : String(it.upc).slice(0, 255),
      spec: it.spec == null ? null : String(it.spec).slice(0, 128),
      unit: it.unit == null ? null : String(it.unit).slice(0, 32),
      weight: Number(it.weight) || null,
      refund_qty: Number(it.refundCount) || null,
      order_qty: Number(it.count) || Number(it.orderCount) || null,
      sale_price: yuanOrNull(it.salePrice),
      origin_price: yuanOrNull(it.originPrice),
      item_amount: yuanOrNull(it.totalPrice),
      pic_url: it.picUrl == null ? null : String(it.picUrl).slice(0, 512),
      raw_json: JSON.stringify(it),
    }));
}

// ── 对外：状态 ───────────────────────────────────────────────
async function status({ probe = true, userId = 0 } = {}) {
  const cookies = await stateCookies(userId);
  const meta = _stateMetaProvider ? await _stateMetaProvider(userId).catch(() => ({})) : {};
  const out = {
    ok: true,
    configured: cookies.length > 0,
    source: meta.source || (cookies.length ? '本机助手采集（登录态存数据库）' : '未登录'),
    cookieCount: cookies.length,
    writtenAt: meta.writtenAt || null,
    earliestExpiry: await earliestExpiry(userId),
    earliestExpiryName: await earliestExpiryName(userId),
    tenantId: null,
    logined: false,
    account: null,
    message: '',
    engine: 'node',
    storage: 'db',
  };

  if (!out.configured) {
    out.ok = false;
    out.message = '尚未登录牵牛花：点「登录牵牛花」，在「本机助手」弹出的窗口里完成登录';
    return out;
  }
  if (!probe) return out;

  const r = await isLogined(userId);
  out.logined = !!r.logined;
  out.account = r.account || null;
  out.tenantId = r.account && r.account.tenantId != null ? String(r.account.tenantId) : null;
  if (!r.logined) {
    out.ok = false;
    out.message = r.error
      ? `探活失败：${r.error}`
      : '登录态已失效：请点「登录牵牛花」，在「本机助手」弹出的窗口里重新登录';
  }
  return out;
}

// ── 对外：登录 ───────────────────────────────────────────────
/**
 * ⚠ 登录不再由服务器执行。
 * 服务器（云端容器）没有图形界面，也没有 Playwright 浏览器二进制；
 * 在服务器上 launch chromium 只会得到「Executable doesn't exist at …chrome.exe」。
 *
 * 现在的链路：看板点「登录牵牛花」→ 服务器把任务下发给**你本机的助手**
 * → 助手用内置浏览器打开牵牛花，你在本机完成登录 → 助手把 Cookie 回传服务器 → 入库。
 * 登录态始终由你亲手产生，服务器只负责保管与调用接口。
 *
 * 这里保留一个明确的引导（而不是报错），防止再有人把 Playwright 塞回服务器。
 */
async function login() {
  return {
    ok: false,
    needAgent: true,
    message: '登录只在你本机完成：请先启动并绑定「本机助手」，再点「登录牵牛花」。',
  };
}

module.exports = {
  BASE_URL,
  API_PREFIX,
  UA,
  setStateProvider,
  buildStorageState,
  soonestExpiry,
  stateExists,
  stateMeta,
  stateCookies,
  stateHost,
  cookieHeader,
  isLogined,
  status,
  login,
  // 业务接口
  apiPost,
  fetchRefundListPage,
  fetchAllRefunds,
  fetchRefundDetail,
  // 纯函数，供隔离测试直接断言
  _internals: {
    parseLogined,
    pickAccount,
    mapRefundRecord,
    mapRefundItems,
    toMs,
    msToDate,
    fenToYuan,
    POST_HEADERS,
  },
};
