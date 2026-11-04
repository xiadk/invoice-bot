/**
 * lib/pdd.js — 拼多多发票：订单同步入库 / 列表查询 / 概况统计 / 登录态
 *
 * 数据归属：所有表以 user_id 首列隔离；管理员通过 ?tenant=<userId> 以该账号身份操作。
 * 数据来源（服务器直连，不需要本机助手）：
 *   · 待申请订单 → pdd-sync.fetchInvoiceOrders  → invoice_status = 7
 *   · 已申请发票 → pdd-sync.fetchInvoices       → invoice_status = 0/1/2/6
 * 提交开票申请（需要 anti-content）属于二期，走助手页内请求。
 *
 * 状态语义（实测核对，2026-10-25）：
 *   7 待申请      — 已完成、还没提交开票申请（来自 list_invoice_order，21 条全为 7）
 *   0 暂不可开票  — 已申请但被驳回，reject_reason 如「订单已全额退款」
 *   1 开票中      — invoice_time_str「预计订单确认收货后10日之内开票」
 *   2 已开票
 *   6 商家处理中  — invoice_time_str「如需了解开票时间，请联系商家」
 */
const db = require('../db');
const psync = require('./pdd-sync');

const STATUS_TEXT = {
  0: '暂不可开票',
  1: '开票中',
  2: '已开票',
  6: '商家处理中',
  7: '待申请',
  // 本地中间态：助手已真实提交申请（尚未同步到拼多多的「开票中」），不可再次申请。
  // 下一次同步会用拼多多接口返回的真实状态覆盖它。
  8: '已申请',
  // 「订单列表」同步进来的订单（含待付款/待发货/待收货）：发票助手还没给过状态。
  // 既不可申请（不是 7）也不会被当成「暂不可开票」。等发票接口返回该单时会被覆盖成真实状态。
  9: '未同步开票',
};

/** 可提交开票申请的状态（二期勾选批量申请时用） */
const APPLYABLE = [7];

/**
 * 可以「催商家开票」的状态：商家处理中(6)。
 * 语义上这类单子已经申请过、卡在商家手里，催一句最有效；已开票(2)/开票中(1)催了没意义，
 * 待申请(7)应该先提交申请而不是催。
 */
const CHATABLE = [6];

/**
 * 超期「未同步开票」(9)：订单列表接口新插进来的、发票接口拉不到的单。
 * 2026-11-04 用户定稿口径：交易成功(4)且发票接口从没给过状态的单，
 * 一律归「暂不可开票(0)」（订单超时没有申请入口），**不再开放自动催收**；
 * 想催只能先在平台上点「申请发票」，申请失败会转成「商家处理中(6)」再催。
 */
const UNSYNCED_INVOICE = 9;

/** 有 mall_id 或加密 mall_sn 就能打开商家会话（只有 mall_sn 时由助手页面自己解密） */
const hasChatTarget = (r) => !!(r.mall_id || r.mall_sn);

/** 可自动催收 = 商家处理中(6) 且能开聊（2026-11-04 收窄：9+成功 归「暂不可开票」，不再催） */
const canChat = (r) =>
  hasChatTarget(r) && CHATABLE.indexOf(Number(r.invoice_status) || 0) >= 0;

/**
 * 拼多多催收消息模板（与 1688 的 messages 完全分开，只有一条）。
 * 变量：{companyName} 抬头 / {taxNo} 税号 / {email} 收票邮箱 / {orderSn} 订单号 / {amount} 金额
 */
const DEFAULT_PDD_MESSAGE = {
  chat: '你好，麻烦尽快开一下发票，在平台都已经申请！！！如需线下开票，我的抬头：{companyName}，'
    + '税号：{taxNo}，邮箱：{email}，非常感谢，已经在平台申请！！！',
  gapMs: 4000,
};

/**
 * 取拼多多催收模板：字段为空/纯空白一律回退默认文案
 * （1688 那边就因为「空串覆盖默认值」导致发空消息，这里同一坑先堵上）。
 */
function getPddMessageConfig(config) {
  const c = (config && config.pddMessage) || {};
  const chat = String(c.chat == null ? '' : c.chat).trim();
  const gap = Number(c.gapMs);
  return {
    chat: chat || DEFAULT_PDD_MESSAGE.chat,
    gapMs: Number.isFinite(gap) && gap >= 1500 ? gap : DEFAULT_PDD_MESSAGE.gapMs,
  };
}

/** 用买家抬头填充模板（缺哪个变量就留空，绝不留 {xxx} 花括号给商家看） */
function buildPddMessage(config, buyer = {}, order = {}) {
  const { chat } = getPddMessageConfig(config);
  const b = buyer || {};
  const o = order || {};
  const vars = {
    companyName: b.companyName || b.company_name || '',
    taxNo: b.taxNo || b.tax_no || '',
    email: b.email || '',
    orderSn: o.order_sn || o.orderSn || '',
    amount: o.invoice_amount != null && o.invoice_amount !== ''
      ? Number(o.invoice_amount).toFixed(2) : (o.amount != null ? Number(o.amount).toFixed(2) : ''),
  };
  return chat.replace(/\{(companyName|taxNo|email|orderSn|amount)\}/g, (m, k) => {
    const v = vars[k];
    return v == null ? '' : String(v);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 入库
// ─────────────────────────────────────────────────────────────────────────

// 注意：列清单与 VALUES 必须逐位对齐（本项目曾因错位导致「提示已拉取但一条没入库」）。
// 末尾 raw_json / synced_at / fetched_at 三位对应 ?, NOW(), NOW()。
// 占位符程序化生成：前 19 列传参，note 恒 NULL（发票同步是权威状态，不覆盖本地备注），raw_json 传参
const UPSERT_SQL = `
  INSERT INTO pdd_order
    (user_id, order_sn, mall_id, goods_name, spec, thumb_url, order_time, invoice_amount,
     invoice_status, invoice_time_str, reject_reason, business_type, invoice_kind, payer_name,
     can_reapply, paper_shipping_id, paper_tracking_number, is_full_refund, is_mall_close,
     note, raw_json, synced_at, fetched_at)
  VALUES (${new Array(19).fill('?').join(',')},NULL,?,NOW(),NOW())
  ON DUPLICATE KEY UPDATE
    mall_id = VALUES(mall_id), goods_name = VALUES(goods_name), spec = VALUES(spec),
    thumb_url = VALUES(thumb_url), order_time = VALUES(order_time),
    invoice_amount = VALUES(invoice_amount), invoice_status = VALUES(invoice_status),
    invoice_time_str = VALUES(invoice_time_str), reject_reason = VALUES(reject_reason),
    business_type = VALUES(business_type), invoice_kind = VALUES(invoice_kind),
    payer_name = VALUES(payer_name), can_reapply = VALUES(can_reapply),
    paper_shipping_id = VALUES(paper_shipping_id),
    paper_tracking_number = VALUES(paper_tracking_number),
    is_full_refund = VALUES(is_full_refund), is_mall_close = VALUES(is_mall_close),
    raw_json = VALUES(raw_json), synced_at = NOW()
`;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
};
/** 页面给的 order_time 是 'YYYY-MM-DD HH:mm:ss'，直接可入 DATETIME */
const dt = (v) => {
  const s = str(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s) ? s.slice(0, 19) : null;
};

/**
 * 这两个列表接口不返回任何时间字段，但拼多多订单号前 6 位就是下单日期
 * （如 260511-453163170161773 → 2026-05-11），据此还原下单时间用于排序与展示。
 */
function snDate(orderSn) {
  const m = /^(\d{2})(\d{2})(\d{2})[-\d]/.exec(String(orderSn || '').trim());
  if (!m) return null;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (Number.isNaN(d.getTime())) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')} 00:00:00`;
}

function bindRow(uid, r, status, force = false) {
  return [
    uid,
    str(r.order_sn, 64) || '',
    num(r.mall_id),
    str(r.goods_name, 255),
    str(r.spec, 255),
    str(r.thumb_url, 512),
    dt(r.order_time) || dt(r.pay_time) || dt(r.confirm_time) || snDate(r.order_sn),
    num(r.invoice_amount),
    // force=true：强制用调用方给的状态（待申请列表按 is_full_refund 定 7/0，不信接口原始值）；
    // 默认：接口返回的 invoice_status 优先（已申请列表的 0/1/2/6 是真实语义）
    force ? status : (Number.isFinite(Number(r.invoice_status)) ? Number(r.invoice_status) : status),
    str(r.invoice_time_str, 255),
    str(r.reject_reason, 512),
    num(r.business_type),
    num(r.invoice_kind),
    str(r.payer_name, 128),
    r.can_reapply == null ? null : (r.can_reapply ? 1 : 0),
    num(r.paper_shipping_id),
    str(r.paper_tracking_number, 128),
    r.is_full_refund == null ? null : (r.is_full_refund ? 1 : 0),
    r.is_mall_close == null ? null : (r.is_mall_close ? 1 : 0),
    JSON.stringify(r),
  ];
}

async function saveOrders(rows, uid, status, { force = false } = {}) {
  let saved = 0;
  let error = '';
  for (const r of rows) {
    if (!r || !r.order_sn) continue;
    try {
      await db.exec(UPSERT_SQL, bindRow(uid, r, status, force));
      saved += 1;
    } catch (e) {
      if (!error) error = (e && e.message) ? e.message : String(e);
      console.warn(`[pdd] 订单入库失败（user ${uid} ${r.order_sn}）：${(e && e.message) || e}`);
    }
  }
  if (saved < rows.length) console.warn(`[pdd] 订单入库 ${saved}/${rows.length}；首条错误：${error}`);
  return { saved, error };
}

// ─────────────────────────────────────────────────────────────────────────
// 同步
// ─────────────────────────────────────────────────────────────────────────

/**
 * 同步（「刷新发票状态」）：两条列表都翻到「空页」为止，不做增量提前停。
 */
async function sync({ userId = 0, trigger = 'manual' } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return { ok: false, message: '缺少用户身份' };
  if (!(await psync.sessionExists(uid))) {
    return { ok: false, loginish: true, message: '尚未登录拼多多：请先点「登录拼多多」' };
  }

  // 1) 待申请（已完成未开票）。is_full_refund=true = 已全额退款不可申请 → 归「暂不可开票(0)」；
  //    其余为待申请(7)。状态强制认定，不受接口原始 invoice_status 干扰（2026-10-25 用户确认口径）。
  // 2026-11-04 线上反馈部分待申请单被漏拉：该单在「不带 is_back」的变体里才查得到。
  //    两个变体（is_back=1 / 不带）都全量翻页，按 order_sn 去重合并，谁返回了就用谁的。
  const pullApplyable = async (withBack) => {
    const r = await psync.fetchAll(
      (args) => psync.fetchInvoiceOrders({ ...args, withBack }),
      { userId: uid }
    );
    return { ...r, withBack };
  };
  const a1 = await pullApplyable(true);
  // 登录态失效（40001）没必要再拉第二个变体，直接终止
  if (!a1.ok && a1.loginish) {
    return { ok: false, loginish: true, message: a1.error || '待申请订单拉取失败，请重试' };
  }
  const a2 = await pullApplyable(false);
  if (!a2.ok && a2.loginish) {
    return { ok: false, loginish: true, message: a2.error || '待申请订单拉取失败，请重试' };
  }
  if (!a1.ok && !a2.ok) {
    return { ok: false, loginish: false, message: a1.error || a2.error || '待申请订单拉取失败，请重试' };
  }
  // 合并：按 order_sn 去重，先到先得（变体间只是入口不同，同一单内容一致）
  const seen = new Set();
  const mergedItems = [];
  for (const it of [...(a1.items || []), ...(a2.items || [])]) {
    if (!it || !it.order_sn || seen.has(it.order_sn)) continue;
    seen.add(it.order_sn);
    mergedItems.push(it);
  }
  const a = {
    ok: true,
    items: mergedItems,
    pages: (a1.pages || 0) + (a2.pages || 0),
    truncated: !!(a1.truncated || a2.truncated),
    error: [a1.error, a2.error].filter(Boolean).join('；'),
  };
  if (a1.ok && a2.ok) {
    const onlyBack = (a1.items || []).length - (a1.items || []).filter((x) => a2.items.some((y) => y.order_sn === x.order_sn)).length;
    console.log(`[pdd] 待申请两变体合并：is_back=1 ${a1.items.length} 条 + 不带 is_back ${a2.items.length} 条`
      + ` → 去重 ${mergedItems.length} 条（is_back 独有 ${onlyBack} 条）`);
  } else {
    console.log(`[pdd] 待申请变体 ${a1.ok ? 'is_back=1' : '不带 is_back'} 拉取失败（${(a1.error || a2.error || '').slice(0, 80)}），`
      + `用另一变体的 ${mergedItems.length} 条继续`);
  }
  const applyable = [];
  const refunded = [];
  for (const r of a.items || []) {
    if (!r || !r.order_sn) continue;
    if (r.is_full_refund === true) {
      if (!r.reject_reason) r.reject_reason = '订单已全额退款';
      refunded.push(r);
    } else {
      applyable.push(r);
    }
  }
  const r1 = await saveOrders(applyable, uid, 7, { force: true });
  const r1b = await saveOrders(refunded, uid, 0, { force: true });

  // 2) 已申请（暂不可开票 / 开票中 / 已开票 / 商家处理中）——同样翻到空页为止，不做增量提前停
  const b = await psync.fetchAll(psync.fetchInvoices, { userId: uid, filterType: 0 });
  if (!b.ok) {
    return {
      ok: false,
      loginish: !!b.loginish,
      message: `已申请发票拉取失败：${b.error || '未知错误'}`
        + (r1.saved + r1b.saved ? `（其中待申请 ${r1.saved + r1b.saved} 条已入库）` : ''),
    };
  }
  const r2 = await saveOrders(b.items || [], uid, 0);

  const total = r1.saved + r1b.saved + r2.saved;
  const note = [];
  if (a.error) note.push('待申请：' + a.error);
  if (b.error) note.push('已申请：' + b.error);
  const insErr = r1.error || r1b.error || r2.error;
  // 撞到翻页上限：两条列表任一被截断，都要明说，不能让用户以为「已全部同步」
  const truncated = !!(a.truncated || b.truncated);
  const maxPages = psync.getMaxPages();
  if (truncated) note.push(`已到翻页上限（${maxPages} 页），更早的记录未拉取`);

  console.log(`[pdd] 同步完成（user ${uid}，${trigger}）：待申请 ${r1.saved} 条、已退款 ${r1b.saved} 条、`
    + `已申请 ${r2.saved} 条；共翻 ${(a.pages || 0) + (b.pages || 0)} 页`
    + `${truncated ? `（已到上限 ${maxPages} 页）` : ''}`);

  if (!total && (a.error || b.error || insErr)) {
    return { ok: false, message: [a.error || b.error || '', insErr].filter(Boolean).join('；') };
  }
  return {
    ok: true,
    pending: r1.saved,        // 待申请入库数（is_full_refund 非true）
    refunded: r1b.saved,      // 已全额退款归入「暂不可开票」的数量
    invoiced: r2.saved,       // 已申请入库数
    truncated,
    maxPages,
    total,
    pages: (a.pages || 0) + (b.pages || 0),
    note: note.join('；'),
    insertError: insErr || '',
    message: `同步完成：待申请 ${r1.saved} 条、已申请 ${r2.saved} 条`
      + (r1b.saved ? `、已退款 ${r1b.saved} 条` : '')
      + (truncated ? `（已到翻页上限 ${maxPages} 页，更早的未拉取）` : ''),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────────────────

/**
 * 排序：只开放两个可排序字段（下单时间 / 开票金额），由列表表头点击驱动。
 * 默认 time_desc =「下单时间倒序，同一时间按金额倒序」（业务默认口径）。
 * ⚠ order_time 是从订单号前 6 位日期还原的，同一天的单子都是 00:00:00，
 *   所以并列时的次级排序（金额 → 订单号）非常关键：既符合业务预期，
 *   也保证翻页顺序稳定（否则同一天的单子在两页之间来回串）。
 * 金额为 NULL 的一律排最后（`IS NULL` 升序 = 非空在前）。
 */
const SORTS = {
  time_desc: 'o.order_time DESC, o.invoice_amount IS NULL, o.invoice_amount DESC, o.order_sn DESC',
  time_asc: 'o.order_time ASC, o.invoice_amount IS NULL, o.invoice_amount ASC, o.order_sn ASC',
  amount_desc: 'o.invoice_amount IS NULL, o.invoice_amount DESC, o.order_time DESC, o.order_sn DESC',
  amount_asc: 'o.invoice_amount IS NULL, o.invoice_amount ASC, o.order_time ASC, o.order_sn ASC',
};

async function list(q = {}) {
  const uid = Number(q.userId) || 0;
  const where = ['o.user_id = ?'];
  const args = [uid];
  if (q.status !== undefined && q.status !== '') {
    where.push('o.invoice_status = ?');
    args.push(Number(q.status));
  }
  const kw = String(q.keyword || '').trim();
  if (kw) {
    where.push('(o.order_sn LIKE ? OR o.goods_name LIKE ? OR o.spec LIKE ? OR o.payer_name LIKE ?)');
    const like = `%${kw}%`;
    args.push(like, like, like, like);
  }
  const page = Math.max(1, Number(q.page) || 1);
  const size = Math.min(200, Math.max(1, Number(q.size) || 20));
  const order = SORTS[String(q.sort || 'time_desc')] || SORTS.time_desc;

  const rows = await db.query(
    `SELECT o.order_sn, o.mall_id, o.mall_sn, o.goods_name, o.spec, o.thumb_url, o.order_time,
            o.invoice_amount, o.invoice_status, o.invoice_time_str, o.reject_reason, o.note,
            o.business_type, o.invoice_kind, o.payer_name, o.can_reapply,
            o.paper_shipping_id, o.paper_tracking_number, o.is_full_refund, o.is_mall_close,
            o.order_status, o.order_status_text, o.pay_amount, o.order_source,
            o.parent_order_sn, o.tabs_belong,
            o.synced_at, o.fetched_at
       FROM pdd_order o
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`,
    [...args, size, (page - 1) * size]
  );
  // 催收统计（pdd_msg_log）。
  // ⚠ 口径按「商家 mall_id」聚合，而不是按订单号：拼多多的聊天会话是商家维度的，
  //   同商家多笔订单发催收只发一条消息（见 server 派单去重），若按订单统计，
  //   同商家的其它订单会误显示「0 次 / 未催过」→ 用户看着以为没催，重复打扰商家。
  //   与 1688 看板「按公司聚合催收次数」的语义保持一致。
  // 语义：催收次数 = 成功发出的次数；最近催收时间 = 最近一次成功的时间；
  //       失败尝试不计入次数（没催出去不算催过），仅在 tooltip 里提示。
  const msgStat = new Map(); // key: 'm<mallId>' / 's<orderSn>'
  const mallIds = [...new Set(rows.map((r) => Number(r.mall_id) || 0).filter(Boolean))];
  const noMallSns = rows.filter((r) => !Number(r.mall_id)).map((r) => r.order_sn);
  if (mallIds.length) {
    const ph = mallIds.map(() => '?').join(',');
    const stat = await db.query(
      `SELECT o.mall_id,
              SUM(m.ok = 1) AS okN,
              SUM(m.ok <> 1 OR m.ok IS NULL) AS failN,
              MAX(CASE WHEN m.ok = 1 THEN m.created_at END) AS lastOkAt,
              MAX(m.created_at) AS lastAnyAt
         FROM pdd_msg_log m
         JOIN pdd_order o ON o.user_id = m.user_id AND o.order_sn = m.order_sn
        WHERE m.user_id = ? AND o.mall_id IN (${ph})
        GROUP BY o.mall_id`,
      [uid, ...mallIds]
    ).catch(() => []);
    for (const s of stat || []) msgStat.set('m' + Number(s.mall_id), s);
  }
  // 兜底：没有 mall_id 的老数据按订单号统计，别让记录凭空消失
  if (noMallSns.length) {
    const ph = noMallSns.map(() => '?').join(',');
    const stat = await db.query(
      `SELECT order_sn,
              SUM(ok = 1) AS okN,
              SUM(ok <> 1 OR ok IS NULL) AS failN,
              MAX(CASE WHEN ok = 1 THEN created_at END) AS lastOkAt,
              MAX(created_at) AS lastAnyAt
         FROM pdd_msg_log
        WHERE user_id = ? AND order_sn IN (${ph})
        GROUP BY order_sn`,
      [uid, ...noMallSns]
    ).catch(() => []);
    for (const s of stat || []) msgStat.set('s' + String(s.order_sn), s);
  }

  const cnt = await db.query(
    `SELECT COUNT(*) AS n FROM pdd_order o WHERE ${where.join(' AND ')}`,
    args
  );
  return {
    total: Number(cnt[0] && cnt[0].n) || 0,
    page,
    size,
    rows: rows.map((r) => {
      const st = (Number(r.mall_id) ? msgStat.get('m' + Number(r.mall_id)) : msgStat.get('s' + r.order_sn)) || {};
      return {
        orderSn: r.order_sn,
        mallId: r.mall_id == null ? null : Number(r.mall_id),
        mallSn: r.mall_sn || null,
        goodsName: r.goods_name || '',
        spec: r.spec || '',
        thumbUrl: r.thumb_url || '',
        orderTime: r.order_time || '',
        invoiceAmount: r.invoice_amount == null ? null : Number(r.invoice_amount),
        invoiceStatus: Number(r.invoice_status) || 0,
        statusText: STATUS_TEXT[Number(r.invoice_status)] || ('状态' + r.invoice_status),
        applyable: APPLYABLE.indexOf(Number(r.invoice_status) || 0) >= 0,
        // 可催商家开票——只有「商家处理中(6)」且能开聊（2026-11-04 收窄，超期未开票归「暂不可开票」不催）：
        //   mall_id 优先（聊天接口直连）；只有 mall_sn 时由助手用 mall_sn 跳 chat_detail，
        //   让页面自己解密（v0.3.16）。两者都没有才是真的催不了。
        chatable: canChat(r),
        // 「去平台催」入口已下线（2026-11-04 口径：暂不可开票的单不显示任何催收入口）
        manualChat: false,
        // 订单侧信息（来自「订单列表」接口；发票接口来的老数据这些字段为空）
        orderStatus: r.order_status == null ? null : Number(r.order_status),
        orderStatusText: r.order_status_text || '',
        payAmount: r.pay_amount == null ? null : Number(r.pay_amount),
        orderSource: r.order_source == null ? 1 : Number(r.order_source),
        parentOrderSn: r.parent_order_sn || '',
        tabsBelong: r.tabs_belong || '',
        invoiceTimeStr: r.invoice_time_str || '',
        rejectReason: r.reject_reason || '',
        note: r.note || '',
        businessType: r.business_type,
        invoiceKind: r.invoice_kind,
        payerName: r.payer_name || '',
        canReapply: !!r.can_reapply,
        paperTrackingNumber: r.paper_tracking_number || '',
        isFullRefund: r.is_full_refund == null ? null : !!r.is_full_refund,
        isMallClose: r.is_mall_close == null ? null : !!r.is_mall_close,
        syncedAt: r.synced_at || '',
        // 催收统计（pdd_msg_log，按商家聚合）
        sendCount: Number(st.okN) || 0,
        sendFailCount: Number(st.failN) || 0,
        lastSentAt: st.lastOkAt || null,
        lastSendAttemptAt: st.lastAnyAt || null,
      };
    }),
  };
}

async function summary(userId) {
  const uid = Number(userId) || 0;
  const rows = await db.query(
    `SELECT invoice_status AS st, COUNT(*) AS n, COALESCE(SUM(invoice_amount),0) AS amt
       FROM pdd_order WHERE user_id = ? GROUP BY invoice_status`,
    [uid]
  ).catch(() => []);
  const byStatus = {};
  let totalCount = 0;
  let totalAmount = 0;
  for (const r of rows) {
    const st = Number(r.st) || 0;
    byStatus[st] = { count: Number(r.n) || 0, amount: Number(r.amt) || 0 };
    totalCount += Number(r.n) || 0;
    totalAmount += Number(r.amt) || 0;
  }
  const g = (st) => byStatus[st] || { count: 0, amount: 0 };
  return {
    totalCount,
    totalAmount: Math.round(totalAmount * 100) / 100,
    pending: g(7),          // 待申请（可以提交开票申请）
    applied: g(8),          // 已申请（本地中间态：已提交，等拼多多反映「开票中」）
    issuing: g(1),          // 开票中
    issued: g(2),           // 已开票
    mallProcessing: g(6),   // 商家处理中
    unavailable: g(0),      // 暂不可开票（全额退款等）
    unsynced: g(9),         // 未同步开票（订单列表带进来的、发票助手还没给状态）
    byStatus,
  };
}

/** 登录态（给前端登录条用）；顺带把「当前登录的拼多多账号昵称」补上 */
async function cookieStatus(userId) {
  const st = await psync.status({ userId, probe: true });
  if (!st || !st.logined) return st;
  // 库里已有昵称时 ensureProfile 直接返回，不发请求（避免每次开页都多打一个接口）
  const p = await psync.ensureProfile(userId).catch(() => null);
  if (p && p.ok && p.nickname) st.accountName = p.nickname;
  if (!st.accountName && st.pdduid) st.accountName = '拼多多用户 ' + st.pdduid;
  return st;
}

/** 强制刷新一次账号昵称（换号后 / 手动「刷新账号信息」用） */
async function refreshProfile(userId) {
  return psync.ensureProfile(userId, { refresh: true });
}

/** 只读登录态里的身份信息（不探活、不发请求），退出登录前用来留操作日志 */
async function sessionInfo(userId) {
  const s = await psync.loadSession(userId).catch(() => null);
  if (!s) return null;
  return { accountName: s.accountName || '', pdduid: s.pdduid || '', writtenAt: s.writtenAt || null };
}

/** 哪些账号已经登录过拼多多（给管理员的「查看身份」下拉做标记） */
async function usersWithSession() {
  const rows = await db.query(
    "SELECT user_id AS userId FROM pdd_session WHERE cookie IS NOT NULL AND cookie <> ''"
  ).catch(() => []);
  return (rows || []).map((r) => Number(r.userId)).filter(Boolean);
}

/**
 * 校验一批订单号：必须属于该用户、且状态为「待申请」。
 * 返回 { orders: [{order_sn, mall_id, goods_name}], invalid: [order_sn] }
 */
async function getApplyableOrders(userId, orderSns) {
  const uid = Number(userId) || 0;
  const sns = (Array.isArray(orderSns) ? orderSns : [])
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 100);
  if (!uid || !sns.length) return { orders: [], invalid: sns };
  const ph = sns.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT order_sn, mall_id, goods_name FROM pdd_order
      WHERE user_id = ? AND order_sn IN (${ph}) AND invoice_status = 7`,
    [uid, ...sns]
  ).catch(() => []);
  const found = (rows || []).map((r) => ({
    order_sn: r.order_sn,
    mall_id: r.mall_id == null ? '' : Number(r.mall_id),
    goods_name: r.goods_name || '',
  }));
  const foundSet = new Set(found.map((r) => r.order_sn));
  return { orders: found, invalid: sns.filter((s) => !foundSet.has(s)) };
}

/**
 * 校验一批订单号能否「催商家开票」：必须属于该用户、状态可催、且能开聊。
 * 可催 = 商家处理中(6)（2026-11-04 收窄：暂不可开票/未同步开票一律不催）；
 * 能开聊 = 有 mall_id 或 mall_sn（加密串也能催，助手会用 mall_sn 跳聊天页）。
 * 返回 { orders: [{order_sn, mall_id, mall_sn, goods_name}], invalid: [order_sn] }
 */
async function getChatableOrders(userId, orderSns) {
  const uid = Number(userId) || 0;
  const sns = (Array.isArray(orderSns) ? orderSns : [])
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 100);
  if (!uid || !sns.length) return { orders: [], invalid: sns };
  const ph = sns.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT order_sn, mall_id, mall_sn, goods_name, invoice_amount FROM pdd_order
      WHERE user_id = ? AND order_sn IN (${ph})
        AND (mall_id IS NOT NULL OR (mall_sn IS NOT NULL AND mall_sn <> ''))
        AND invoice_status = 6`,
    [uid, ...sns]
  ).catch(() => []);
  const found = (rows || []).map((r) => ({
    order_sn: r.order_sn,
    mall_id: r.mall_id == null ? null : Number(r.mall_id),
    mall_sn: r.mall_sn || '',
    goods_name: r.goods_name || '',
    invoice_amount: r.invoice_amount == null ? null : Number(r.invoice_amount),
  }));
  const foundSet = new Set(found.map((r) => r.order_sn));
  return { orders: found, invalid: sns.filter((s) => !foundSet.has(s)) };
}

// ─────────────────────────────────────────────────────────────────────────
// 店铺加密串 mall_sn → 数字 mall_id（v0.3.16）
//
// 为什么必须借本机助手：订单列表接口的 mall 里只有加密的 mall_url（mall_sn 是
// protobuf + 两块 AES 密文），解密密钥在拼多多服务端，前端只是把 mall_sn 转发到
// POST /api/turing/mall/gr_st，且必须带页面生成的 anti_content。服务端直连一律 40002
// （前端把它定义成 isIntercept 风控拦截）。所以只在助手已登录的真实页面里跑一次，
// 把页面自己解出来的 mall_id 抓回来存 pdd_mall，之后服务端查表即可（永久有效）。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 「值得解析 mall_sn」的订单条件（targets 与 stats 共用，避免两处口径漂移）。
 *
 * 为什么只认这三个条件：
 *  - 发票接口（待申请 / 已申请两个列表）返回的单**自带数字 mall_id**，同步时 UPSERT 会写进去，
 *    所以 invoice_status = 0/2/6/7/8 的单 100% 有 mall_id，也不需要 mall_sn（发票接口不给这个字段）。
 *  - 只有停在 9（未同步开票）的单是订单列表接口新插入的：接口只给加密 mall_url，没有数字 id，
 *    而这类单（超期不可申请）发票接口以后也不会再返给它 → 永远补不上 mall_id，只能靠解析。
 *  - 交易已成功（order_status = 4）才谈得上催商家开票；退款成功 / 交易已取消解析了也没用。
 *    注意有 2 单 order_status 还是 4 但文案已是「退款成功」，必须靠文案排掉。
 *
 * 结论：range 内的单 = 超期老单里唯一还需要 mall_id 的那部分，其余一律不解析。
 */
const MALL_RESOLVE_WHERE = `
        o.mall_id IS NULL
    AND o.mall_sn IS NOT NULL AND o.mall_sn <> ''
    AND o.invoice_status = 9
    AND o.order_status = 4
    AND COALESCE(o.order_status_text, '') NOT LIKE '%退款%'`;

/** 缓存侧条件：还没解出来、且不在 10 分钟冷却期（与 MALL_RESOLVE_WHERE 配套使用） */
const MALL_RESOLVE_CACHE = `
        m.mall_id IS NULL
    AND (m.tried_at IS NULL OR m.tried_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE))`;

/**
 * 取一批「还不知道 mall_id、但有 mall_sn」的店铺，交给助手解析。
 * 排序：名下订单多的优先（一次解析收益最大）；同一店铺 10 分钟内不重复尝试（失败别死循环）。
 */
async function mallResolveTargets(userId, limit = 0) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  // limit <= 0 表示「全部」（一次点完，不再 20 个一批）；上限 500 只是防御，
  // 真实待解析量级在几百以内。分批下发给助手由 server.js 负责（助手单任务上限 80）。
  const n = Number(limit) > 0 ? Math.min(500, Math.floor(Number(limit))) : 500;
  const rows = await db.query(
    `SELECT o.mall_sn,
            MAX(JSON_UNQUOTE(JSON_EXTRACT(o.raw_json, '$.mall.mall_name'))) AS mall_name,
            COUNT(*) AS orders
       FROM pdd_order o
       LEFT JOIN pdd_mall m ON m.user_id = o.user_id AND m.mall_sn = o.mall_sn
      WHERE o.user_id = ? AND ${MALL_RESOLVE_WHERE}
        AND ${MALL_RESOLVE_CACHE}
      GROUP BY o.mall_sn
      ORDER BY orders DESC
      LIMIT ${n}`,
    [uid]
  ).catch(() => []);
  return (rows || []).map((r) => ({
    mallSn: String(r.mall_sn),
    mallName: r.mall_name || '',
    orders: Number(r.orders) || 0,
  }));
}

/**
 * 保存助手解析结果：写 pdd_mall，并把同一 mall_sn 名下订单的 mall_id 一次性回填。
 * @param {Array<{mallSn:string, mallId:number, mallName?:string, ok?:boolean, error?:string}>} results
 * @returns {{ok:number, fail:number, filled:number}}
 */
async function saveMallResults(userId, results, agentVer = '') {
  const uid = Number(userId) || 0;
  const out = { ok: 0, fail: 0, filled: 0 };
  if (!uid || !Array.isArray(results)) return out;
  for (const r of results) {
    const sn = String((r && (r.mallSn || r.mall_sn)) || '').trim().slice(0, 128);
    if (!sn) continue;
    const id = Number((r && (r.mallId || r.mall_id)) || 0) || 0;
    const name = String((r && (r.mallName || r.mall_name)) || '').slice(0, 128);
    const err = id ? '' : String((r && r.error) || '未解析出 mall_id').slice(0, 250);
    try {
      await db.exec(
        `INSERT INTO pdd_mall (user_id, mall_sn, mall_id, mall_name, fail_reason, tried_at, agent_ver)
         VALUES (?,?,?,?,?,NOW(),?)
         ON DUPLICATE KEY UPDATE
           mall_id = COALESCE(VALUES(mall_id), mall_id),
           mall_name = COALESCE(VALUES(mall_name), mall_name),
           fail_reason = VALUES(fail_reason),
           tried_at = NOW(),
           agent_ver = VALUES(agent_ver)`,
        [uid, sn, id || null, name || null, err || null, String(agentVer || '').slice(0, 32) || null]
      );
    } catch (e) {
      console.warn(`[pdd] mall_sn 缓存写入失败（${sn.slice(0, 20)}）：${(e && e.message) || e}`);
      continue;
    }
    if (!id) { out.fail += 1; continue; }
    out.ok += 1;
    try {
      const r2 = await db.exec(
        'UPDATE pdd_order SET mall_id = ? WHERE user_id = ? AND mall_sn = ? AND mall_id IS NULL',
        [id, uid, sn]
      );
      out.filled += Number(r2 && r2.affectedRows) || 0;
    } catch (e) {
      console.warn(`[pdd] mall_id 回填失败（${sn.slice(0, 20)}）：${(e && e.message) || e}`);
    }
  }
  return out;
}

/** 店铺解析进度：待解析店铺数 / 已解析店铺数（看板上「解析店铺 ID」按钮的提示） */
async function mallResolveStats(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return { pending: 0, resolved: 0 };
  // pending 必须与 mallResolveTargets 完全同口径（含缓存冷却），否则按钮上的数字永远降不到 0
  const [a] = await db.query(
    `SELECT COUNT(DISTINCT o.mall_sn) AS n
       FROM pdd_order o
       LEFT JOIN pdd_mall m ON m.user_id = o.user_id AND m.mall_sn = o.mall_sn
      WHERE o.user_id = ? AND ${MALL_RESOLVE_WHERE}
        AND ${MALL_RESOLVE_CACHE}`,
    [uid]
  ).catch(() => [{ n: 0 }]);
  const [b] = await db.query(
    'SELECT COUNT(*) AS n FROM pdd_mall WHERE user_id = ? AND mall_id IS NOT NULL',
    [uid]
  ).catch(() => [{ n: 0 }]);
  return { pending: Number(a && a.n) || 0, resolved: Number(b && b.n) || 0 };
}

/** 记录催收消息发送结果（pdd_msg_log，留痕不吞错） */
async function logMsg(userId, results) {
  const uid = Number(userId) || 0;
  if (!uid || !Array.isArray(results) || !results.length) return;
  for (const r of results) {
    if (!r || !r.order_sn) continue;
    await db.exec(
      'INSERT INTO pdd_msg_log (user_id, order_sn, ok, detail, content, resp) VALUES (?,?,?,?,?,?)',
      [
        uid, r.order_sn, r.ok ? 1 : 0,
        String(r.detail || '').slice(0, 250),
        String(r.content || '').slice(0, 500),
        String(r.resp || '').slice(0, 480),
      ]
    ).catch((e) => console.warn(`[pdd] 催收日志写入失败（${r.order_sn}）：${(e && e.message) || e}`));
  }
}

/** 记录申请结果（pdd_apply_log，留痕不吞错） */async function logApply(userId, results) {
  const uid = Number(userId) || 0;
  if (!uid || !Array.isArray(results) || !results.length) return;
  for (const r of results) {
    if (!r || !r.order_sn) continue;
    await db.exec(
      'INSERT INTO pdd_apply_log (user_id, order_sn, ok, detail, resp) VALUES (?,?,?,?,?)',
      [uid, r.order_sn, r.ok ? 1 : 0, String(r.detail || '').slice(0, 250), String(r.resp || '').slice(0, 480)]
    ).catch((e) => console.warn(`[pdd] 申请日志写入失败（${r.order_sn}）：${(e && e.message) || e}`));
  }
}

/**
 * 提交成功的订单标记为「已申请(8)」中间态：
 * 表示「已经提交了申请」，在拼多多列表 reflecting 出「开票中」之前不可再勾选申请。
 * 下一次同步会被接口返回的真实状态覆盖（幂等，无副作用）。
 */
async function markApplied(userId, orderSns) {
  const uid = Number(userId) || 0;
  const sns = (Array.isArray(orderSns) ? orderSns : [])
    .map((s) => String(s || '').trim()).filter(Boolean);
  if (!uid || !sns.length) return 0;
  const ph = sns.map(() => '?').join(',');
  await db.exec(
    `UPDATE pdd_order SET invoice_status = 8,
       invoice_time_str = CASE WHEN invoice_time_str IS NULL OR invoice_time_str = ''
         THEN '已提交申请，等待商家/平台开票' ELSE invoice_time_str END
     WHERE user_id = ? AND order_sn IN (${ph})`,
    [uid, ...sns]
  ).catch((e) => {
    console.warn(`[pdd] 标记「已申请」失败（${sns.length} 单）：${(e && e.message) || e}`);
    return 0;
  });
  return sns.length;
}

/**
 * 「申请发票」提交失败的单 → 商家处理中(6) + 说明备注原因（2026-11-04 用户口径）。
 * 卡到 6 之后「催收消息」入口才出现：申请失败说明商家在处理开票，催一句最有效。
 */
async function markApplyFailed(userId, results) {
  const uid = Number(userId) || 0;
  const fails = (Array.isArray(results) ? results : []).filter((r) => r && !r.ok && r.order_sn);
  let n = 0;
  for (const r of fails) {
    const reason = String(r.detail || r.error || '申请失败').slice(0, 200);
    const ok = await db.exec(
      `UPDATE pdd_order SET invoice_status = 6, note = ? WHERE user_id = ? AND order_sn = ?`,
      [reason, uid, String(r.order_sn)]
    ).then((x) => x && x.affectedRows).catch((e) => {
      console.warn(`[pdd] 标记「申请失败→商家处理中」失败（${r.order_sn}）：${(e && e.message) || e}`);
      return 0;
    });
    n += ok ? 1 : 0;
  }
  return n;
}

/**
 * 「发送催收消息」失败的单 → 暂不可开票(0) + 说明备注原因（2026-11-04 用户口径）。
 * 聊天页加载超时/页面空白 → 备注「无法开启聊天，线下处理」。归 0 后催收入口自动消失。
 */
async function markSendFailed(userId, results) {
  const uid = Number(userId) || 0;
  const fails = (Array.isArray(results) ? results : []).filter((r) => r && !r.ok && r.order_sn);
  let n = 0;
  for (const r of fails) {
    const detail = String(r.detail || r.error || '').slice(0, 200);
    const note = /超时或页面空白|加载超时/.test(detail)
      ? '无法开启聊天，线下处理'
      : (detail || '发送失败').slice(0, 200);
    const ok = await db.exec(
      `UPDATE pdd_order SET invoice_status = 0, note = ? WHERE user_id = ? AND order_sn = ?`,
      [note, uid, String(r.order_sn)]
    ).then((x) => x && x.affectedRows).catch((e) => {
      console.warn(`[pdd] 标记「发送失败→暂不可开票」失败（${r.order_sn}）：${(e && e.message) || e}`);
      return 0;
    });
    n += ok ? 1 : 0;
  }
  return n;
}

module.exports = {
  STATUS_TEXT,
  APPLYABLE,
  CHATABLE,
  DEFAULT_PDD_MESSAGE,
  getPddMessageConfig,
  buildPddMessage,
  saveSession: psync.saveSession,
  clearSession: psync.clearSession,
  cookieStatus,
  refreshProfile,
  sessionInfo,
  usersWithSession,
  sync,
  list,
  summary,
  getApplyableOrders,
  getChatableOrders,
  mallResolveTargets,
  saveMallResults,
  mallResolveStats,
  logApply,
  logMsg,
  markApplied,
  markApplyFailed,
  markSendFailed,
  _internals: { UPSERT_SQL, bindRow, saveOrders, snDate },
};
