/**
 * electron/agent/ali-fetch.js — 1688 订单 / 已开票取数内核（只跑在用户本机）
 *
 * 为什么要有这个文件（2026-11-15）：
 *   「同步订单」原本由服务器（47.102.184.186）用 https 直连 h5api.m.1688.com。
 *   1688 对该出口 IP 的业务接口做了风控，四组对照实验证明与账号、Cookie、令牌都无关：
 *     · 服务器上拿 uid=4/8/13/17 的登录态拉单 → 全部 FAIL_SYS_USER_VALIDATE + RGV587 验证页
 *     · 同一业务接口**完全匿名**调用 → 服务器 IP 被要求人机验证；本机 IP 正常回 SESSION_EXPIRED
 *     · 公共接口 mtop.common.getTimestamp 在服务器上 SUCCESS → 只封业务接口，不是整机封禁
 *   → 取数请求必须从「用户自己的电脑」发出（同 IP、同设备、带真实浏览器指纹与登录态）。
 *
 * 怎么发：
 *   用 Electron 的 net.request 绑到 persist:1688 分区（与发消息/登录窗口同一个分区）：
 *     · useSessionCookies: true → 自动带上用户在真实浏览器里登录得到的 Cookie（含 _m_h5_tk）
 *     · Chromium 自己的网络栈 → TLS/HTTP2 指纹与真实 Chrome 一致，不再是 Node 的 https
 *   签名（sign = md5(token & t & appKey & data)）在本地用 crypto 算，规则与服务器侧一致。
 *
 * 与服务器侧 lib/ali-orders.js 的分工（刻意不重叠）：
 *   助手只负责「发请求 + 翻页 + 把原始行回传」，**不解析业务字段、不入库、不判断开票状态**；
 *   字段映射（mapOrder / mapInvoiceRecord）、金额分转元、upsert、markIssued 全在服务端，
 *   保持「字段口径只有一处」——这是 v0.3.30 那次字段名错配静默写 NULL 的教训。
 *   唯一被复制过来的纯函数是 pickRows（= 服务端 pickArray 的同算法），因为翻页要靠它判断
 *   「这页有没有数据 / 还有没有下一页」，而助手包里只打 electron/**（见 package.json build.files），
 *   require 不到 lib/。两边的一致性由 L2 用同一份真实响应样本比对保证。
 *
 * 隐私边界：不读取、不保存账号密码；只使用分区里已有的登录态；回传的只有订单公开数据。
 */
const { session, net } = require('electron');
const crypto = require('crypto');

const PARTITION = 'persist:1688';
const HOST = 'h5api.m.1688.com';
const APP_KEY = '12574478';
const ORDER_API = 'mtop.1688.trading.dataline.service';
const ORDER_SERVICE_ID = 'OrderListDataLineService.buyerOrderList';
const INVOICE_API = 'mtop.1688.kingsuns.invoice.dataline.service';
const INVOICE_SERVICE_ID = 'KsInvoicePurchaserManageMtopService.queryInvoiceApplyRecordListByPage';
const INVOICE_STATUS_LIST = [2, 30, 31, 32];   // 2/30/31/32 = 已开票系列受理状态（与服务器侧一致）
const PAGE_GAP_MS = 700;                       // 页间隔，别惊动风控
// 必须换掉 Electron 默认 UA（带 Electron/33 标识），否则等于自报「我不是浏览器」
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const clampInt = (v, min, max, dft) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dft;
  return Math.min(max, Math.max(min, Math.round(n)));
};

function part() { return session.fromPartition(PARTITION); }

/**
 * 发一个请求（走 persist:1688 分区的 Chromium 网络栈，自动带该分区的 Cookie）。
 * 返回 { status, body } 或 { error }——永不 reject，由调用方判 ok。
 */
function request({ method = 'POST', url, body = '', timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      req = net.request({
        method, url,
        session: part(),
        useSessionCookies: true,
        redirect: 'follow',
      });
    } catch (e) {
      finish({ error: '初始化请求失败：' + ((e && e.message) || e) });
      return;
    }

    // 请求头与抓包对照（服务器侧 httpPost 用的是同一套）；个别头被 Chromium 拒设也无妨
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': UA,
      'referer': 'https://air.1688.com/',
      'origin': 'https://air.1688.com',
    };
    if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    for (const [k, v] of Object.entries(headers)) {
      try { req.setHeader(k, v); } catch (e) { /* 受限头忽略 */ }
    }

    const timer = setTimeout(() => {
      try { req.abort(); } catch (e) { /* 已结束 */ }
      finish({ error: '请求超时' });
    }, timeoutMs);

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        clearTimeout(timer);
        finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (e) => { clearTimeout(timer); finish({ error: (e && e.message) || String(e) }); });
    });
    req.on('error', (e) => { clearTimeout(timer); finish({ error: (e && e.message) || String(e) }); });
    req.on('abort', () => { clearTimeout(timer); finish({ error: '请求已中止' }); });

    try {
      if (body) req.write(body);
      req.end();
    } catch (e) {
      clearTimeout(timer);
      finish({ error: '发送失败：' + ((e && e.message) || e) });
    }
  });
}

/** 参数顺序与浏览器实际请求一致（2026-10-29 抓包对照，与服务器侧 buildUrl 同构） */
function buildUrl({ t, sign, api }) {
  const hostApi = api || ORDER_API;
  const q = [
    'jsv=2.7.4',
    'appKey=' + APP_KEY,
    't=' + t,
    'sign=' + sign,
    'ecode=1',
    'type=json',
    'valueType=string',
    'api=' + encodeURIComponent(hostApi),
    'v=1.0',
    'dataType=jsonp',
  ].join('&');
  return `https://${HOST}/h5/${hostApi}/1.0/?${q}`;
}

/** 该分区里阿里系域的 Cookie 名集合（只判登录，不外传内容） */
async function aliCookieNames() {
  const all = await part().cookies.get({}).catch(() => []);
  const ali = (all || []).filter((c) => /(^|\.)(1688|taobao|tmall|alibaba)\.com$/i.test(String(c.domain || '')));
  return new Set(ali.map((c) => String(c.name || '').toLowerCase()));
}

/** 浏览器里是否已登录 1688（unb / __cn_logon__ + cookie2） */
async function hasLogin() {
  const names = await aliCookieNames();
  return (names.has('unb') || names.has('__cn_logon__')) && names.has('cookie2');
}

/** 取 `_m_h5_tk` 的 token 段（下划线前） */
async function readToken() {
  const list = await part().cookies.get({ name: '_m_h5_tk' }).catch(() => []);
  const v = (list && list[0] && list[0].value) || '';
  if (!v) return '';
  try { return String(decodeURIComponent(String(v))).split('_')[0] || ''; } catch (e) { return String(v).split('_')[0] || ''; }
}

/**
 * 解析响应体。dataType=jsonp 时可能被包成 `mtopjsonp3({...})`，
 * 所以先按 JSON 解，失败再剥一层 jsonp 外壳。
 */
function parseBody(body) {
  const s = String(body || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { /* 可能是 jsonp */ }
  const m = /^[\s\w$.]*\(([\s\S]*)\)\s*;?\s*$/.exec(s);
  if (m) { try { return JSON.parse(m[1]); } catch (e) { /* 真不是 JSON */ } }
  return null;
}

const retOf = (json) => (json && Array.isArray(json.ret) && json.ret[0]) || '';

/** 打公共接口（匿名可通），顺带让 1688 往分区里下发新的 _m_h5_tk */
async function fetchPublicToken() {
  const t = String(Date.now());
  const api = 'mtop.common.getTimestamp';
  const url = `https://${HOST}/h5/${api}/1.0/?jsv=2.7.4&appKey=${APP_KEY}`
    + `&t=${t}&sign=${md5(`${t}&${APP_KEY}&${api}`).toUpperCase()}&api=${api}&v=1.0&type=json`;
  await request({ method: 'GET', url });
  return readToken();
}

/** 发一次业务请求（token 由调用方给；空 token 时 sign 里就是空串，与真实浏览器首次请求一致） */
async function once(token, data, api) {
  const t = String(Date.now());
  const sign = md5(`${token}&${t}&${APP_KEY}&${data}`);
  const r = await request({ method: 'POST', url: buildUrl({ t, sign, api }), body: 'data=' + encodeURIComponent(data) });
  if (r.error) return { ok: false, error: r.error, ret: '' };
  const json = parseBody(r.body);
  return { ok: true, status: r.status, json, ret: retOf(json) };
}

/**
 * 调一次 mtop 业务接口：token 缺失先领一个；被回 TOKEN_EMPTY / TOKEN_EXOIRED 时
 * 领取新 token 重试一次（1688 的首次请求固定这样回报，重试即过）。
 */
async function callMTop({ data, api }) {
  let token = await readToken();
  if (!token) token = await fetchPublicToken();

  let out = await once(token, data, api);
  if (!out.ok) return out;

  if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/i.test(out.ret)) {
    const tk = (await fetchPublicToken()) || (await readToken());
    if (tk) out = await once(tk, data, api);
  }
  return out;
}

/**
 * 从响应里找业务数组（**与服务器侧 lib/ali-orders.js 的 pickArray 同算法**）。
 * 接口把真正的数据塞在字符串里（json.data.data.result 是 string），必须拆两层；
 * 这里做 BFS + 遇字符串即尝试解析，对层级变化免疫，顺带带回同层的 total / pages。
 */
function pickRows(json) {
  const seen = new Set();
  const queue = [{ node: json }];
  let best = null;   // 兜底：键名一个都不认识时，取「元素最多的对象数组」当记录列表
  while (queue.length) {
    const { node } = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const v of Object.values(node)) {
      if (typeof v === 'string') {
        const s = v.trim();
        if (s[0] === '{' || s[0] === '[') {
          try { queue.push({ node: JSON.parse(s) }); } catch (e) { /* 普通文本 */ }
        }
        continue;
      }
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') {
        const keys = Object.keys(v[0]).join(',').toLowerCase();
        if (/order|trade|pay|seller|sum|invoice|apply|biz/.test(keys)) {
          return { rows: v, total: Number(node.total) || null, pages: Number(node.pages) || null };
        }
        // 开票记录的字段名还没确认过（见 lib/ali-orders.js mapInvoiceRecord 的注释），
        // 认不出来时留一手：元素最多的对象数组大概率就是记录列表，多出来的行服务端会按
        // 「有没有订单号」过滤掉，不会写脏数据。
        if (!best || v.length > best.rows.length) {
          best = { rows: v, total: Number(node.total) || null, pages: Number(node.pages) || null };
        }
      } else if (v && typeof v === 'object') {
        queue.push({ node: v });
      }
    }
  }
  return best || { rows: [], total: null, pages: null };
}

/** 拉一页订单（pageSize 上限实测 100） */
async function fetchOrderPage({ startDateTime, page = 1, pageSize = 100 }) {
  const param = JSON.stringify({ startDateTime, page, pageSize });
  const data = JSON.stringify({ serviceId: ORDER_SERVICE_ID, param });
  const r = await callMTop({ data, api: ORDER_API });
  if (!r.ok) return { ok: false, error: '请求失败：' + r.error, ret: '' };
  if (r.ret && !/SUCCESS/i.test(r.ret)) return { ok: false, error: r.ret, ret: r.ret };
  const picked = pickRows(r.json);
  return { ok: true, rows: picked.rows, total: picked.total, totalPages: picked.pages };
}

/** 拉一页已开票申请记录 */
async function fetchInvoicePage({ page = 1, pageSize = 20 }) {
  const param = JSON.stringify({ page, pageSize, bizStatusList: INVOICE_STATUS_LIST });
  const data = JSON.stringify({ serviceId: INVOICE_SERVICE_ID, param });
  const r = await callMTop({ data, api: INVOICE_API });
  if (!r.ok) return { ok: false, error: '请求失败：' + r.error, ret: '' };
  if (r.ret && !/SUCCESS/i.test(r.ret)) return { ok: false, error: r.ret, ret: r.ret };
  const picked = pickRows(r.json);
  return { ok: true, rows: picked.rows, total: picked.total, totalPages: picked.pages };
}

/**
 * 执行一次取数任务。
 * @param {object} task { taskId, startDateTime, maxPages, pageSize, withInvoices, invoiceMaxPages, invoicePageSize }
 * @param {object} api  { log(text), isStopped(), emitPage(payload), report(payload) }
 *   emitPage：一页原始数据（orders 是订单原始行；invoices 是开票申请原始记录）
 *   report  ：最终结果（ok / stopped / error / ret / 计数）
 */
async function runFetch(task, api) {
  const t = task || {};
  const log = (s) => { try { api.log(s); } catch (e) { /* 忽略 */ } };
  const stopped = () => { try { return !!(api.isStopped && api.isStopped()); } catch (e) { return false; } };

  if (!(await hasLogin())) {
    api.report({
      ok: false, phase: 'orders',
      error: '本机浏览器里没有 1688 登录态：请在看板「1688发票」页点「登录1688」，在助手窗口里登录后再同步',
    });
    return;
  }

  const startDateTime = String(t.startDateTime || '').trim();
  if (!startDateTime) {
    api.report({ ok: false, phase: 'orders', error: '缺少增量同步起点（startDateTime），未执行' });
    return;
  }

  const maxPages = clampInt(t.maxPages, 1, 2000, 200);
  const pageSize = clampInt(t.pageSize, 1, 100, 100);
  const withInvoices = t.withInvoices !== false;
  const invMaxPages = clampInt(t.invoiceMaxPages, 1, 200, 100);
  const invPageSize = clampInt(t.invoicePageSize, 1, 20, 20);

  let fetched = 0;
  let pages = 0;

  // ── 第 1 段：订单 ──
  for (let page = 1; page <= maxPages; page += 1) {
    if (stopped()) { api.report({ ok: true, stopped: true, phase: 'orders', fetched, pages }); return; }
    const r = await fetchOrderPage({ startDateTime, page, pageSize });
    if (!r.ok) { api.report({ ok: false, phase: 'orders', page, error: r.error, ret: r.ret, fetched, pages }); return; }
    if (!r.rows.length) break;                       // 空页 = 拉完了
    pages = page;
    fetched += r.rows.length;
    api.emitPage({ phase: 'orders', page, totalPages: r.totalPages || 0, total: r.total || 0, fetched, rows: r.rows });
    if (r.totalPages && page >= r.totalPages) break;  // 到接口给的最后一页
    if (r.rows.length < pageSize) break;              // 不满一页 = 最后一页
    await sleep(PAGE_GAP_MS);
  }
  log(`1688 订单取数完成：${pages} 页 / ${fetched} 单`);

  // ── 第 2 段：已开票（同一任务里连跑，前端只看到一条进度条） ──
  let invFetched = 0;
  let invPages = 0;
  if (withInvoices) {
    for (let page = 1; page <= invMaxPages; page += 1) {
      if (stopped()) {
        api.report({ ok: true, stopped: true, phase: 'invoices', fetched, pages, invoiceFetched: invFetched, invoicePages: invPages });
        return;
      }
      const r = await fetchInvoicePage({ page, pageSize: invPageSize });
      if (!r.ok) {
        api.report({
          ok: false, phase: 'invoices', page, error: r.error, ret: r.ret,
          fetched, pages, invoiceFetched: invFetched, invoicePages: invPages,
        });
        return;
      }
      if (!r.rows.length) break;
      invPages = page;
      invFetched += r.rows.length;
      api.emitPage({
        phase: 'invoices', page, totalPages: r.totalPages || 0, total: r.total || 0,
        invoiceFetched: invFetched, rows: r.rows,
      });
      if (r.totalPages && page >= r.totalPages) break;
      if (r.rows.length < invPageSize) break;
      await sleep(PAGE_GAP_MS);
    }
    log(`1688 已开票取数完成：${invPages} 页 / ${invFetched} 条`);
  }

  api.report({ ok: true, phase: 'done', fetched, pages, invoiceFetched: invFetched, invoicePages: invPages });
}

/** 供 main.js 注入：返回一个 ali_fetch 处理器（旧版助手没有该处理器时，ws-client 会提示升级） */
function createFetchHandler({ log = () => {} } = {}) {
  return async function handleAliFetch(task, api) {
    try {
      await runFetch(task, api);
    } catch (e) {
      log('1688 取数异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = {
  PARTITION, createFetchHandler, runFetch,
  // 纯函数导出：L2 要拿它和服务器侧 pickArray 用同一份响应样本比对（防止两边算法漂移）
  pickRows, parseBody, buildUrl, fetchOrderPage, fetchInvoicePage, hasLogin, readToken,
};
