/**
 * lib/pdd-sync.js — 拼多多「发票助手」接口层 + 登录态
 *
 * 与牵牛花（lib/qnh-sync.js）最大的区别：**这两个列表接口不需要风控签名**
 * （既没有 mtgsig 也没有 anti-content），所以服务器可以直连拉取，不必经本机助手。
 * 只有「提交开票申请」要 anti-content，那属于二期（走助手页内请求）。
 *
 * 两个接口：
 *   · list_invoice_order  → 已完成、还**没申请**发票的订单（待申请，invoice_status=0）
 *   · list_invoice        → **已申请**过的发票（1 开票中 / 2 已开票 / 6 商家处理中）
 *
 * 登录态：Cookie 存在 pdd_session 表（user_id 主键），由本机助手采集回传。
 *        服务器不打开浏览器——拼多多登录只在本机助手里完成。
 */
const db = require('../db');

const BASE = 'https://mobile.yangkeduo.com';
// 固定伪装成手机浏览器：接口按 UA 返回 H5 结构，桌面 UA 会拿到另一套页面
const UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const PAGE_SIZE = 20;          // page_size 必须 ≥10，实测 =2 会报「入参有误」
const MAX_PAGES = 200;         // 安全阀：避免接口异常时无限翻页
const PAGE_GAP_MS = 500;       // 页间隔，控制频率别惊动风控

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
// 登录态（Cookie）
// ─────────────────────────────────────────────────────────────────────────

async function loadSession(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return null;
  const rows = await db.query(
    'SELECT cookie, pdduid, account_name AS accountName, cookie_count AS cookieCount, written_at AS writtenAt FROM pdd_session WHERE user_id = ?',
    [uid]
  ).catch(() => []);
  const r = rows && rows[0];
  if (!r || !r.cookie) return null;
  const pdduid = r.pdduid || (String(r.cookie).match(/pdd_user_id=(\d+)/) || [])[1] || '';
  return {
    cookie: String(r.cookie),
    pdduid: String(pdduid),
    accountName: r.accountName || '',
    cookieCount: Number(r.cookieCount) || 0,
    writtenAt: r.writtenAt || null,
  };
}

/** 登录态是否有（不探活，只看库里有没有 Cookie） */
async function sessionExists(userId) {
  return !!(await loadSession(userId));
}

async function saveSession({ userId, cookie, pdduid, accountName, source, agentVer }) {
  const uid = Number(userId) || 0;
  if (!uid || !cookie) return false;
  const names = String(cookie).split(';').map((s) => s.trim()).filter(Boolean);
  await db.exec(
    `INSERT INTO pdd_session (user_id, cookie, pdduid, account_name, cookie_count, source, agent_ver, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       cookie = VALUES(cookie), pdduid = VALUES(pdduid), account_name = VALUES(account_name),
       cookie_count = VALUES(cookie_count), source = VALUES(source), agent_ver = VALUES(agent_ver),
       written_at = NOW()`,
    [
      uid, String(cookie),
      String(pdduid || (String(cookie).match(/pdd_user_id=(\d+)/) || [])[1] || ''),
      accountName ? String(accountName).slice(0, 128) : null,
      names.length,
      source ? String(source).slice(0, 32) : 'agent',
      agentVer ? String(agentVer).slice(0, 32) : null,
    ]
  );
  return true;
}

async function clearSession(userId) {
  await db.exec('DELETE FROM pdd_session WHERE user_id = ?', [Number(userId) || 0]).catch(() => {});
  return true;
}

/** 登录态状态（给前端「登录拼多多」按钮用） */
async function status({ userId, probe = false } = {}) {
  const uid = Number(userId) || 0;
  const s = await loadSession(uid);
  if (!s) {
    return {
      ok: false, logined: false, configured: false,
      message: '尚未登录拼多多：点「登录拼多多」，在本机助手弹出的窗口里完成登录',
      pdduid: '', accountName: '', writtenAt: null, cookieCount: 0,
    };
  }
  const out = {
    ok: true, logined: true, configured: true,
    message: '',
    pdduid: s.pdduid, accountName: s.accountName,
    cookieCount: s.cookieCount, writtenAt: s.writtenAt,
  };
  if (probe) {
    // 轻量探活：拉第 1 页（10 条）。失败即视为登录态失效，前端直接提示重新登录
    const r = await fetchInvoiceOrders({ userId: uid, page: 1, pageSize: 10 });
    if (!r.ok) {
      out.ok = false;
      out.logined = false;
      out.message = r.error || '登录态已失效，请重新登录拼多多';
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 接口请求
// ─────────────────────────────────────────────────────────────────────────

async function apiPost(path, body, { userId, referer, extraQuery = '' } = {}) {
  const s = await loadSession(userId);
  if (!s) return { ok: false, error: '尚未登录拼多多' };
  // URL query：pdduid 与调用方额外参数（如 is_back=1）拼在一起
  const qs = [];
  if (s.pdduid) qs.push(`pdduid=${encodeURIComponent(s.pdduid)}`);
  if (extraQuery) qs.push(String(extraQuery).replace(/^[&?]/, ''));
  const url = BASE + path + (qs.length ? `?${qs.join('&')}` : '');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json, text/plain, */*',
        origin: BASE,
        referer: referer || `${BASE}/commercial_pre_orders.html`,
        'user-agent': UA,
        cookie: s.cookie,
        dnt: '1',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: '网络请求失败：' + (e.message || e) };
  }
  let json = null;
  const text = await res.text().catch(() => '');
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  if (!json) {
    return { ok: false, error: `接口返回非 JSON（HTTP ${res.status}）：${String(text).slice(0, 120)}` };
  }
  // 注意：未登录时接口可能返回 HTTP 200 + {error_code:40001}（没有 success 字段），
  // 不能只判 success === false —— 有 error_code 且没给 success 一律按失败处理
  if (json.success === false || (json.error_code && json.success !== true)) {
    const code = json.error_code;
    let msg = json.error_msg || '接口返回失败';
    // 40001 = 未登录 / 登录态过期（HTTP 424 也常见），给用户能看懂的提示
    if (Number(code) === 40001) msg = '登录态已失效或未登录，请重新登录拼多多';
    // 1000 入参有误 / 13000 非法快筛类型 这类是参数问题；其余（含 40001）多与登录态相关
    const loginish = code !== 1000 && code !== 13000;
    return { ok: false, error: `${msg}${code && Number(code) !== 40001 ? '（' + code + '）' : ''}`, code, loginish };
  }
  return { ok: true, json, result: json.result || {} };
}

/**
 * 待申请订单（已完成、还没申请发票）
 * 与页面真实请求保持一致：URL 带 is_back=1，请求体带 query_source:1
 * （2026-10-25 用户提供抓包：is_back=1 + query_source=1 才是发票助手页的完整入参）。
 * 注意：返回项里的 is_full_refund 由调用方处理（true=已全额退款不可申请，null/absent=可申请）。
 */
async function fetchInvoiceOrders({ userId, page = 1, pageSize = PAGE_SIZE } = {}) {
  const r = await apiPost(
    '/proxy/api/api/omaisapi/invoice_assistant/list_invoice_order',
    { page_no: page, page_size: pageSize, query_source: 1 },
    { userId, extraQuery: 'is_back=1' }
  );
  if (!r.ok) return { ok: false, error: r.error, loginish: r.loginish };
  const items = r.result.invoice_order_items || [];
  return { ok: true, items };
}

/**
 * 已申请发票列表
 * list_filter_type：0=全部（1/2/6 混合）、1=已开票、2=开票中+商家处理中
 */
async function fetchInvoices({ userId, page = 1, pageSize = PAGE_SIZE, filterType = 0 } = {}) {
  const r = await apiPost(
    '/proxy/api/api/omaisapi/invoice_assistant/list_invoice',
    { page_no: page, page_size: pageSize, list_filter_type: filterType },
    { userId }
  );
  if (!r.ok) return { ok: false, error: r.error, loginish: r.loginish };
  const items = r.result.invoice_items || [];
  return { ok: true, items };
}

/**
 * 分页拉取。终止条件（满足其一）：
 *   · 返回条数 < pageSize 或为空
 *   · pageSettle(items) 返回 true —— 「增量」用：这一页的订单都已入库且状态稳定，
 *     说明后面（更早）的页不会有变化，直接停（该页不重复入库）。
 *     注意：接口的 total 是「当页条数」不是总数，不能拿它算页数。
 */
async function fetchAll(fetchPage, { userId, pageSize = PAGE_SIZE, pageSettle } = {}) {
  const all = [];
  let page = 1;
  let failed = '';
  let settled = false;              // 是否因「整页已稳定」提前停
  for (; page <= MAX_PAGES; page += 1) {
    const r = await fetchPage({ userId, page, pageSize });
    if (!r.ok) {
      failed = r.error || '拉取失败';
      if (page === 1) return { ok: false, error: failed, loginish: r.loginish, items: [] };
      break;
    }
    if (pageSettle && r.items.length && await pageSettle(r.items)) {
      settled = true;
      break;
    }
    all.push(...r.items);
    if (r.items.length < pageSize) break;
    await sleep(PAGE_GAP_MS);
  }
  return {
    ok: !failed,               // 只要没报错就算成功（0 条也是合法结果，由调用方自己看 items.length）
    items: all,
    pages: page,
    settled,
    error: failed,
  };
}

module.exports = {
  BASE, UA, PAGE_SIZE, MAX_PAGES,
  loadSession, saveSession, clearSession, sessionExists,
  status, apiPost, fetchInvoiceOrders, fetchInvoices, fetchAll,
};
