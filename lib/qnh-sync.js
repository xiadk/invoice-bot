/**
 * lib/qnh-sync.js — 牵牛花同步（Node 版，替代 qnh-refund-sync/bridge.py）
 *
 * 为什么要这个模块：
 *   原来「登录牵牛花 / 拉退单 / 入库」全靠一个独立的 Python 工程（qnh-refund-sync），
 *   它不在部署机器上就整条链路失效。现在把能力收进 Node，一套程序、一套配置、一个库。
 *
 * 当前能力（v0.2.4）：登录态获取 + 探活（status / login / isLogined）
 *   + 退单接口层（queryRefundList / afs/detail / 纯映射函数）。
 * 入库与批次编排在 lib/qnh.js（读写 MySQL 的部分不放在本模块，便于只测 HTTP 层）。
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

async function apiPost(pathname, body, { timeoutMs = API_TIMEOUT } = {}) {
  const r = await apiFetch(pathname, { method: 'POST', body, headers: POST_HEADERS, timeoutMs });
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
async function fetchRefundListPage({ page = 1, pageSize = 50, startMs, endMs } = {}) {
  const body = { page, pageSize, _t: Date.now(), applyStartTime: String(startMs), applyEndTime: String(endMs) };
  const r = await apiPost(API_PREFIX + '/orderfuse/queryRefundList', body);
  if (!r.ok) return r;
  const d = r.data || {};
  const records = Array.isArray(d.refundApplyRecordVOList) ? d.refundApplyRecordVOList : [];
  const pi = d.pageInfo || {};
  return { ok: true, records, pageInfo: { page: pi.page || page, size: pi.size || pageSize, totalPage: Number(pi.totalPage) || 1, totalSize: Number(pi.totalSize) || records.length } };
}

/** 分页拉全量（页间限速 800ms，防风控）。返回 {ok, records, total, failedPages} */
async function fetchAllRefunds({ startMs, endMs, pageSize = 50, onPage = null, sleepMs = 800 } = {}) {
  const records = [];
  let total = 0;
  let failedPages = 0;
  let page = 1;
  for (;;) {
    const r = await fetchRefundListPage({ page, pageSize, startMs, endMs });
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
async function fetchRefundDetail({ channelOrderId, channelId, channelAfsId } = {}) {
  const r = await apiPost(API_PREFIX + '/orderfuse/afs/detail', {
    channelOrderId: String(channelOrderId), channelId, channelAfsId: String(channelAfsId),
  });
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

  const row = {
    refund_no: String(rec.afterSaleId || o.channelAfsId || '').slice(0, 64),
    service_id: rec.serviceId == null ? null : String(rec.serviceId).slice(0, 64),
    qnh_tenant_id: o.tenantId == null ? null : String(o.tenantId).slice(0, 32),
    order_no: o.channelOrderId == null ? null : String(o.channelOrderId).slice(0, 64),
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
