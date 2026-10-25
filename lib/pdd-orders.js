/**
 * lib/pdd-orders.js — 拼多多「全部订单」同步（订单列表接口 order_list_v4）
 *
 * 与 lib/pdd-sync.js 的区别：
 *   · pdd-sync 拉的是「发票助手」的两个列表 —— 只有**已完成**、与开票相关的订单；
 *   · 这里拉的是「我的订单」页的全部订单（待付款 / 待发货 / 待收货 / 已完成 / 已退款…），
 *     用来补齐发票流程之外的订单数据，列表页「订单状态」列就是它的产物。
 *
 * 接口实测（2026-10-25，cookie 直连，**不需要 anti-content / 本机助手**）：
 *   POST https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4?pdduid=<uid>
 *   body: { type:'all', page:1, origin_host_name, scene:'order_list_h5', page_from:0,
 *           front_env:163, pay_front_supports:[], size:50, offset? }
 *   resp: { server_time, orders:[...], extra_info, view_list }
 *   · size 上限 50（≥100 直接返回空数组，别踩）
 *   · 分页是 cursor：把本页最后一条的 `offset` 作为下一页入参；没有 next/总和字段
 *   · 订单状态看 order_status_prompt（如「已签收，待确认收货」「交易成功」）
 *
 * 入库口径（关键）：
 *   · **订单号是唯一标识**：普通单用自身 order_sn；多多买菜组合单（PO- 开头）展开成子单，
 *     每个子单一条（子单号才是能和发票接口对上的号），父单号存 parent_order_sn。
 *   · 订单接口**不写 invoice_***：发票状态只由发票接口权威维护，这里只更新订单侧字段。
 *     新插入的订单 invoice_status = 9（「未同步开票」，既不可申请也不会被当成暂不可开票）。
 *   · 订单接口的 mall 里**没有数字 mall_id**（只有加密 mall_url），所以 mall_id 取不到就保留原值，
 *     免得把发票接口写入的 mall_id 覆盖成空 —— 催商家开票是按 mall_id 聚合会话的。
 *
 * 时间窗口（2026-10-25 追加业务要求）：
 *   · **只限制「首次全量」**：只回溯最近 N 个月（N 默认 3，写在 config.json 的
 *     runtime.pddOrdersFullMonths，系统管理可改，每次同步重新读文件 → 实时生效）。
 *   · **增量不受限制**：增量本来就是从最新往前追、追平即停，不存在拉取大量历史的问题。
 *   · 列表按时间倒序，因此一旦某页出现早于下限的订单，处理完这页即停；窗口外的订单不入库。
 */
const db = require('../db');
const psync = require('./pdd-sync');
const { loadConfig } = require('./config');

const PATH = '/proxy/api/api/aristotle/order_list_v4';
const PAGE_SIZE = 50;        // 实测上限：>50 会返回空数组
const MAX_PAGES = 300;       // 安全阀（300 × 50 = 15000 单，足够覆盖一个买家的全部历史）
const PAGE_GAP_MS = 900;     // 页间隔：控制频率别惊动风控
const ORDER_SOURCE = 2;      // pdd_order.order_source：订单列表接口
const UNSYNCED_INVOICE = 9;  // 订单接口新插入的单：发票助手还没给过状态

// 首次全量只回溯最近 N 个月（可在「系统管理」里改，实时生效）。
// 增量不受这个窗口限制 —— 增量只往前追到「整页都已入库且全是终态」就停，本来就很短。
const DEFAULT_FULL_MONTHS = 3;
const MIN_FULL_MONTHS = 1;
const MAX_FULL_MONTHS = 36;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
// 首次全量的时间窗口
// ─────────────────────────────────────────────────────────────────────────

/** 从 config.json 读「首次全量回溯月数」，每次调用都重新读文件 → 改完实时生效，不用重启 */
function getFullMonths() {
  let raw;
  try {
    const cfg = loadConfig() || {};
    raw = cfg.runtime && cfg.runtime.pddOrdersFullMonths;
  } catch (e) { raw = null; }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FULL_MONTHS;
  return Math.min(MAX_FULL_MONTHS, Math.max(MIN_FULL_MONTHS, Math.round(n)));
}

/** N 个月前的「YYYY-MM-DD HH:mm:ss」（与 order_time 同口径，可直接字符串比较） */
function cutoffOf(months) {
  const d = new Date();
  const day = d.getDate();
  d.setDate(1);                       // 先归 1 号再减月，避免 3-31 减一个月落到 3-03 这种偏移
  d.setMonth(d.getMonth() - Math.max(1, Number(months) || DEFAULT_FULL_MONTHS));
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`;
}

const cutoffDay = (cutoff) => String(cutoff || '').slice(0, 10);

/** 订单时间是否早于窗口下限（order_time 为空时算「不确定」，保留，不因此停止翻页） */
function olderThan(dateStr, cutoff) {
  if (!dateStr || !cutoff) return false;
  return String(dateStr) < String(cutoff);
}


// ─────────────────────────────────────────────────────────────────────────
// 拉取
// ─────────────────────────────────────────────────────────────────────────

/** 拉一页订单（offset 为空 = 第一页） */
async function fetchOrderPage({ userId, offset = null, size = PAGE_SIZE } = {}) {
  const body = {
    type: 'all',
    page: 1,                       // 接口仍要 page 字段，但真实翻页靠 offset
    origin_host_name: 'mobile.yangkeduo.com',
    scene: 'order_list_h5',
    page_from: 0,
    front_env: 163,
    pay_front_supports: [],
    size,
  };
  if (offset) body.offset = offset;
  const r = await psync.apiPost(PATH, body, {
    userId,
    referer: `${psync.BASE}/orders.html?type=all`,
  });
  if (!r.ok) return { ok: false, error: r.error, loginish: r.loginish };
  const j = r.json || {};
  const items = Array.isArray(j.orders) ? j.orders : [];
  const last = items[items.length - 1];
  return { ok: true, items, nextOffset: (last && last.offset) || null };
}

// ─────────────────────────────────────────────────────────────────────────
// 归一化（接口结构 → 一行一个子单）
// ──────────────────��──────────────────────────────────────────────────────

/** 订单号前 6 位是下单日期（YYMMDD），接口没给时间时用它兜底 */
function snDate(orderSn) {
  const m = /^([A-Z]*-)?(\d{2})(\d{2})(\d{2})-/.exec(String(orderSn || '').trim());
  if (!m) return null;
  const yy = Number(m[2]); const mm = Number(m[3]); const dd = Number(m[4]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')} 00:00:00`;
}

const unixToDt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  // 转成服务器本地时区的 'YYYY-MM-DD HH:mm:ss'，与其它字段口径一致
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
};

/** price_desc / price_desc_v2 可能是对象，也可能是 JSON 字符串 */
function parsePriceDesc(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (e) { return null; }
}

/** 从「(确认提货后自动付款¥44.97)」这类文案里抽金额（元） */
function priceFromDesc(desc) {
  const d = parsePriceDesc(desc) || {};
  const text = [d.suffix, d.shortSuffix, d.payPromotionDesc].filter(Boolean).join(' ');
  const m = /¥\s*([\d]+(?:\.[\d]{1,2})?)/.exec(text);
  return m ? Number(m[1]) : null;
}

/** 商品汇总：多商品时用「首件 等N件」 */
function goodsSummary(list) {
  const gs = (list || []).filter(Boolean);
  if (!gs.length) return { name: null, spec: null, thumb: null, count: 0 };
  const first = gs[0];
  const name = gs.length > 1
    ? `${first.goods_name || ''} 等${gs.length}种`.trim()
    : str(first.goods_name, 255);
  const specs = gs.map((g) => str(g.spec)).filter(Boolean).slice(0, 2).join(' / ');
  return { name: name || null, spec: specs || null, thumb: str(first.thumb_url, 512), count: gs.length };
}

/** 实付金额（元）：优先订单金额（分），其次价格文案，最后按商品单价×数量估 */
function payAmountOf(parent, goodsList) {
  const cents = Number(parent.order_amount);
  if (Number.isFinite(cents) && cents > 0) return Math.round(cents) / 100;
  const fromDesc = priceFromDesc(parent.price_desc_v2 || parent.price_desc);
  if (fromDesc != null) return fromDesc;
  const sum = (goodsList || []).reduce(
    (n, g) => n + (Number(g.goods_price) || 0) * (Number(g.goods_number) || 1), 0
  );
  return sum > 0 ? sum / 100 : null;
}

/** 平台分类标签（数组 → 逗号串，便于筛选） */
const tabsOf = (parent) => {
  const t = Array.isArray(parent.tabs_belong) ? parent.tabs_belong.filter(Boolean) : [];
  return t.length ? t.join(',').slice(0, 64) : null;
};

/**
 * 一个父单 → N 行（PO 组合单展开子单）
 * 普通单：自身就是唯一一行。PO 单：每个子单一行，共用父单号与父单级信息（状态/时间/金额分摊到首行）。
 */
function normalizeOrder(parent) {
  const sn = str(parent.order_sn, 64);
  if (!sn) return [];
  const isCombo = String(sn).startsWith('PO-');
  const children = Array.isArray(parent.orders) ? parent.orders.filter(Boolean) : [];
  const mall = parent.mall || {};
  const mallId = Number(mall.id || mall.mall_id || 0) || null;   // PO 单的 mall.id 是 "0"，当空处理
  const statusText = str(parent.order_status_prompt, 32);
  const orderStatus = Number.isFinite(Number(parent.status)) && parent.status !== null && parent.status !== ''
    ? Number(parent.status) : null;
  const tabs = tabsOf(parent);
  const group = parent.group_order || {};
  // 时间：普通单 order_time；组合单看团信息；都没有就用订单号里的日期
  const orderTime = unixToDt(parent.order_time)
    || unixToDt(group.create_at) || unixToDt(group.success_time)
    || snDate(sn);
  const amount = payAmountOf(parent, isCombo ? children.flatMap((c) => c.order_goods || []) : parent.order_goods);
  const rawBase = JSON.stringify(parent);

  if (!isCombo || !children.length) {
    const g = goodsSummary(parent.order_goods);
    return [{
      order_sn: sn,
      parent_order_sn: null,
      mall_id: mallId,
      goods_name: g.name,
      spec: g.spec,
      thumb_url: g.thumb,
      order_time: orderTime,
      pay_amount: amount,
      order_status: orderStatus,
      order_status_text: statusText,
      tabs_belong: tabs,
      raw_json: rawBase,
    }];
  }

  // 组合单：每个子单一条；金额只在第一条上给（父单只有一个总额，别重复计入）
  return children.map((c, i) => {
    const childSn = str(c.order_sn, 64);
    if (!childSn) return null;
    const g = goodsSummary(c.order_goods);
    return {
      order_sn: childSn,
      parent_order_sn: sn,
      mall_id: mallId,
      goods_name: g.name,
      spec: g.spec,
      thumb_url: g.thumb,
      order_time: orderTime,
      pay_amount: i === 0 ? amount : null,
      order_status: orderStatus,
      order_status_text: str(c.order_status_prompt, 32) || statusText,
      tabs_belong: tabs,
      raw_json: JSON.stringify({ parent_summary: { order_sn: sn, mall: parent.mall, status: parent.status, prompt: statusText, group_order: parent.group_order }, child: c }),
    };
  }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────
// 终态判定（增量停止用）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 终态 = 不会再变的订单：已完成(4) / 已取消(5) / 已退款(6)，或文案落在这几种。
 * 「请前往自提点提货」「已签收，待确认收货」「待发货」等一律算中间态。
 */
const TERMINAL_TEXTS = ['交易成功', '待评价', '已提货', '退款成功', '已退款', '交易关闭', '已取消', '已完成'];
function isTerminal(row) {
  if (row.order_status != null && [4, 5, 6].includes(Number(row.order_status))) return true;
  const t = String(row.order_status_text || '');
  return TERMINAL_TEXTS.some((k) => t.includes(k));
}

// ─────────────────────────────────────────────────────────────────────────
// 入库
// ─────────────────────────────────────────────────────────────────────────

// 列清单与 VALUES 逐位对齐（老项目踩过「参数错位 → 提示成功但没入库」）。
// invoice_status 只在 INSERT 时写 9，ON DUPLICATE 不碰 —— 发票状态归发票接口管。
const UPSERT_SQL = `
  INSERT INTO pdd_order
    (user_id, order_sn, mall_id, goods_name, spec, thumb_url, order_time,
     invoice_status, pay_amount, order_status, order_status_text, tabs_belong,
     parent_order_sn, order_source, raw_json, synced_at, fetched_at)
  VALUES (?,?,?,?,?,?,?, ${UNSYNCED_INVOICE}, ?,?,?,?,?, ${ORDER_SOURCE}, ?, NOW(), NOW())
  ON DUPLICATE KEY UPDATE
    mall_id = COALESCE(VALUES(mall_id), mall_id),
    goods_name = COALESCE(VALUES(goods_name), goods_name),
    spec = COALESCE(VALUES(spec), spec),
    thumb_url = COALESCE(VALUES(thumb_url), thumb_url),
    order_time = COALESCE(VALUES(order_time), order_time),
    pay_amount = COALESCE(VALUES(pay_amount), pay_amount),
    order_status = COALESCE(VALUES(order_status), order_status),
    order_status_text = COALESCE(VALUES(order_status_text), order_status_text),
    tabs_belong = COALESCE(VALUES(tabs_belong), tabs_belong),
    parent_order_sn = COALESCE(VALUES(parent_order_sn), parent_order_sn),
    raw_json = VALUES(raw_json), synced_at = NOW()
`;

function bindRow(uid, r) {
  return [
    uid, r.order_sn, r.mall_id, r.goods_name, r.spec, r.thumb_url, r.order_time,
    r.pay_amount, r.order_status, r.order_status_text, r.tabs_belong,
    r.parent_order_sn, r.raw_json,
  ];
}

async function saveRows(uid, rows) {
  let saved = 0;
  let error = '';
  for (const r of rows) {
    try {
      await db.exec(UPSERT_SQL, bindRow(uid, r));
      saved += 1;
    } catch (e) {
      if (!error) error = (e && e.message) ? e.message : String(e);
      console.warn(`[pdd-orders] 入库失败（user ${uid} ${r.order_sn}）：${(e && e.message) || e}`);
    }
  }
  return { saved, error };
}

/** 这一批里哪些订单库里已经有了（增量判定 + 统计新增数） */
async function knownSnSet(uid, sns) {
  if (!sns.length) return new Set();
  const ph = sns.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT order_sn FROM pdd_order WHERE user_id = ? AND order_sn IN (${ph})`,
    [uid, ...sns]
  ).catch(() => []);
  return new Set(rows.map((r) => String(r.order_sn)));
}

// ─────────────────────────────────────────────────────────────────────────
// 同步主流程
// ─────────────────────────────────────────────────────────────────────────

/** 库里已经有订单列表同步过的数据吗（决定默认走全量还是增量） */
async function hasOrderData(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return false;
  const rows = await db.query(
    'SELECT COUNT(*) AS n FROM pdd_order WHERE user_id = ? AND order_source = ?',
    [uid, ORDER_SOURCE]
  ).catch(() => [{ n: 0 }]);
  return Number(rows[0] && rows[0].n) > 0;
}

/**
 * 同步全部订单。
 * @param {object} opt
 * @param {number} opt.userId
 * @param {boolean} opt.full   true=全量（首次，只回溯最近 months 个月）；false=增量（翻到「整页都已入库且全是终态」就停，不受时间窗限制）
 * @param {number} [opt.months]  全量回溯月数；不传则读配置（默认 3）
 * @param {function} opt.onProgress  进度回调 ({page, fetched, saved, newCount, current, terminal})
 * @param {function} opt.shouldStop  返回 true 时在当前页处理完后停止
 */
async function syncOrders({ userId = 0, full = false, months = null, size = PAGE_SIZE, onProgress, shouldStop } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return { ok: false, message: '缺少用户身份' };
  if (!(await psync.sessionExists(uid))) {
    return { ok: false, loginish: true, message: '尚未登录拼多多：请先点「登录拼多多」' };
  }

  // 时间窗只作用于「首次全量」：增量是往前追平，追平即停，本来就不会翻到很久以前
  const windowMonths = full ? (Number(months) > 0 ? Math.round(Number(months)) : getFullMonths()) : 0;
  const cutoff = windowMonths > 0 ? cutoffOf(windowMonths) : null;

  let offset = null;
  let page = 0;
  let fetched = 0;        // 拉到的父单条数（接口口径）
  let rowsTotal = 0;      // 展开后的子单条数
  let saved = 0;          // 真正入库的子单条数
  let newCount = 0;       // 其中新订单
  let settled = false;    // 是否因「增量已追平」提前停
  let reachedCutoff = false;   // 是否因「已经翻到窗口之外」提前停
  let stopped = false;    // 是否被用户手动停止
  let failed = '';

  for (; page < MAX_PAGES; page += 1) {
    if (shouldStop && shouldStop()) { stopped = true; break; }
    const r = await fetchOrderPage({ userId: uid, offset, size });
    if (!r.ok) {
      failed = r.error || '订单列表拉取失败';
      if (page === 0) return { ok: false, loginish: !!r.loginish, message: failed };
      break;   // 中途失败：已入库的照旧保留，如实报告
    }
    const items = r.items || [];
    if (!items.length) break;

    let rows = items.flatMap((it) => normalizeOrder(it));
    if (cutoff) {
      // 列表按时间倒序 → 一旦本页出现早于窗口的订单，后面只会更早，处理完这页就收工。
      // 只入库窗口内的订单，窗口外的一条都不写。
      const keep = rows.filter((x) => !olderThan(x.order_time, cutoff));
      reachedCutoff = keep.length < rows.length;
      rows = keep;
    }
    const sns = rows.map((x) => x.order_sn);
    const known = await knownSnSet(uid, sns);
    const freshInPage = rows.filter((x) => !known.has(x.order_sn)).length;
    const res = await saveRows(uid, rows);

    fetched += items.length;
    rowsTotal += rows.length;
    saved += res.saved;
    newCount += freshInPage;
    if (onProgress) {
      onProgress({
        page: page + 1,
        fetched, rows: rowsTotal, saved, newCount,
        current: rows[0] ? rows[0].order_sn : (items[0] ? items[0].order_sn : ''),
        terminal: rows.filter(isTerminal).length,
        cutoff: cutoff ? cutoffDay(cutoff) : null,
        reachedCutoff,
      });
    }

    if (reachedCutoff) break;   // 已翻到窗口之外

    // 增量停止：这一页的订单库里全都有、而且全是终态 → 更早的页不会再有变化
    if (!full && rows.length && freshInPage === 0 && rows.every(isTerminal)) {
      settled = true;
      break;
    }

    offset = r.nextOffset;
    if (!offset || items.length < size) break;   // 到底了
    await sleep(PAGE_GAP_MS);
  }

  const notes = [];
  if (failed) notes.push(failed);
  if (settled) notes.push('增量：已追平（整页都已入库且为终态）');
  if (reachedCutoff) notes.push(`已到时间窗口下限（${cutoffDay(cutoff)} 之前的不再拉取）`);
  if (stopped) notes.push('已手动停止，已入库的部分保留');

  console.log(`[pdd-orders] 同步完成（user ${uid}，${full ? `全量·最近${windowMonths}个月` : '增量'}）：`
    + `翻 ${page + (page < MAX_PAGES ? 1 : 0)} 页、父单 ${fetched} 条、子单 ${rowsTotal} 条、`
    + `入库 ${saved} 条（新增 ${newCount}）${settled ? '，增量已追平' : ''}${reachedCutoff ? '，已到时间窗口下限' : ''}`);

  if (!saved && failed) return { ok: false, message: notes.join('；') };
  return {
    ok: !failed,
    full: !!full,
    months: windowMonths || null,
    cutoff: cutoff ? cutoffDay(cutoff) : null,
    reachedCutoff,
    pages: page + 1,
    fetched, rows: rowsTotal, saved, newCount,
    settled, stopped,
    message: `订单同步完成：拉取 ${fetched} 单、入库 ${saved} 条（新增 ${newCount}）`
      + (windowMonths ? `，仅最近 ${windowMonths} 个月（${cutoffDay(cutoff)} 起）` : '')
      + (settled ? '（增量）' : '') + (stopped ? '（已手动停止，未拉完）' : '')
      + (failed ? `；${failed}` : ''),
    note: notes.join('；'),
  };
}

/** 订单同步概况（给前端：判断首次全量/后续增量、显示最近同步时间与状态分布） */
async function orderSyncSummary(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return { synced: false, lastAt: null, byStatus: {}, total: 0 };
  const rows = await db.query(
    `SELECT order_status AS st, COUNT(*) AS n, MAX(synced_at) AS lastAt
       FROM pdd_order WHERE user_id = ? AND order_source = ?
      GROUP BY order_status`,
    [uid, ORDER_SOURCE]
  ).catch(() => []);
  const byStatus = {};
  let total = 0;
  let lastAt = null;
  for (const r of rows || []) {
    const n = Number(r.n) || 0;
    total += n;
    byStatus[r.st == null ? 'null' : String(r.st)] = n;
    if (r.lastAt && (!lastAt || String(r.lastAt) > String(lastAt))) lastAt = r.lastAt;
  }
  return { synced: total > 0, lastAt, byStatus, total };
}

module.exports = {
  ORDER_SOURCE, UNSYNCED_INVOICE, PAGE_SIZE,
  DEFAULT_FULL_MONTHS, MIN_FULL_MONTHS, MAX_FULL_MONTHS,
  getFullMonths, cutoffOf,
  fetchOrderPage, normalizeOrder, isTerminal,
  hasOrderData, orderSyncSummary, syncOrders,
};
