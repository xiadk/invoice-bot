/**
 * lib/sdc.js — 闪电帮帮（美团 shandiancang）发票：订单入库 / 列表 / 汇总 / 催收留痕
 *
 * ⚠ 与拼多多（lib/pdd.js）最大的不同：这个站点有 WAF 风控（mtgsig 签名）。
 *   服务器直连列表接口会被 403（实测：openresty 403 Forbidden）。
 *   只有在**真实浏览器里**、由页面上下文发出的 fetch，才会被站点的风控 SDK 自动补上签名，
 *   所以「拉数据」和「发消息」都必须发生在本机助手的浏览器里，服务器只做落库与查询。
 *   —— 本文件因此不负责取数，取数在 electron/agent/sdc.js，经由本机助手回传后调 saveOrders。
 *
 * 数据来源两个端点（都在浏览器页内调用）：
 *   stage=1 可申请开票 → /sdc-gw1/mallApi/invoiceTitle/queryInvoiceOrderPage
 *                        body { pageNo, pageSize, subUserIds: [userId] }
 *   stage=2 已申请开票 → /sdc-gw1/mallApi/orderInvoice/queryOrderInvoiceForBuyer
 *                        body { pageNo, pageSize, _t, invoiceApplyStatusList: [1], userIdList: [userId] }
 * 会话（发催收）→ POST /mallApi/im/shop/pub/select { shopId } → data 就是 sessionId
 *               → https://shandiancang.waimai.meituan.com/customer-service/chat?sessionId=<id>
 * 登录检测     → POST /sdc-gw1/mallApi/login/getLoginInfo {} → data.userId / data.shopId
 *
 * 数据归属：所有表以 user_id 首列隔离；管理员通过 ?tenant=<userId> 以该账号身份操作。
 */
const crypto = require('crypto');
const db = require('../db');

/** 档位字典（前端表格与筛选共用）
 *  1 可申请开票：平台允许线上申请，还没提申请
 *  2 已申请开票：已提申请、还没开出来（催收对象：催商家尽快开）
 *  3 不支持线上开票：平台限制，只能商家线下开（催收对象：催商家线下开给公司）
 *  4 已开票：开票完成，不再催
 */
const STAGE_TEXT = {
  1: '可申请开票',
  2: '已申请开票',
  3: '不支持线上开票',
  4: '已开票',
};

/** 需要催收的档位（催的是「卡住的」两档：已申请但没开出来、平台不让线上开） */
const STAGES_TO_CHAT = [2, 3];

/** 列表排序（与拼多多同风格：前端给 key，这里翻译成 SQL，杜绝字符串拼用户入参） */
const SORTS = {
  time_desc: 'o.pay_time DESC, o.order_sn DESC',
  time_asc: 'o.pay_time ASC, o.order_sn ASC',
  amount_desc: 'o.payable_amount DESC, o.order_sn DESC',
  amount_asc: 'o.payable_amount ASC, o.order_sn ASC',
  shop_asc: 'o.shop_name ASC, o.order_sn DESC',
};

/** 店铺维度列表的排序（这里排的是 GROUP BY 之后的聚合字段，所以只能用别名） */
const SHOP_SORTS = {
  amount_desc: 'payable_amount DESC, shop_id ASC',
  amount_asc: 'payable_amount ASC, shop_id ASC',
  count_desc: 'order_count DESC, shop_id ASC',
  count_asc: 'order_count ASC, shop_id ASC',
  time_desc: 'last_pay_time DESC, shop_id ASC',
  time_asc: 'last_pay_time ASC, shop_id ASC',
  sent_desc: 'send_count DESC, shop_id ASC',
  sent_asc: 'send_count ASC, shop_id ASC',
  shop_asc: 'shop_name ASC, shop_id ASC',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max || 255) : null;
};
/** 毫秒时间戳 → Date（DATETIME 列）；非法值回填 null，避免 1970/空 DOM 解析成 0 值 */
const dateMs = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * 关键字段指纹：只有这些字段变了才写库。
 * 用途：反复点「刷新」时不会每次更新所有行的 updated_at，也便于「有没有新东西」的判断。
 */
function rowHash(r) {
  const pieces = [
    r.stage, r.order_sn, r.shop_id, r.shop_name, r.wm_poi_id, r.wm_poi_name,
    r.invoice_apply_status, r.invoice_title, r.taxpayer_ident, r.taker_email,
    r.batch_no, r.invoice_type_desc,
    money(r.total_amount), money(r.payable_amount), money(r.actual_pay_amount), money(r.after_total_amount),
    r.order_time ? new Date(r.order_time).getTime() : 0,
    r.pay_time ? new Date(r.pay_time).getTime() : 0,
    r.apply_time ? new Date(r.apply_time).getTime() : 0,
    r.invoice_time ? new Date(r.invoice_time).getTime() : 0,
    r.online_blocked ? 1 : 0,
  ];
  return crypto.createHash('md5').update(pieces.join('|')).digest('hex');
}

/** 归一化助手回传的一行：两个端点字段不同，在这里统一成库里的列 */
function normalize(row) {
  const st = Number(row && row.stage);
  // 档位只认 1~4；不合法时按「可申请」兜底（旧助手只回 1/2）
  const stage = STAGES_TO_CHAT.includes(st) || st === 4 ? st : 1;
  const orderSn = str((row && row.order_sn) || '', 64);
  if (!orderSn) return null;
  return {
    stage,
    order_sn: orderSn,
    shop_id: str(row.shop_id, 32) || null,
    shop_name: str(row.shop_name, 128),
    wm_poi_id: str(row.wm_poi_id, 64),
    wm_poi_name: str(row.wm_poi_name, 128),
    invoice_apply_status: num(row.invoice_apply_status),
    invoice_apply_desc: str(row.invoice_apply_desc, 32),
    invoice_title: str(row.invoice_title, 200),
    taxpayer_ident: str(row.taxpayer_ident, 64),
    taker_email: str(row.taker_email, 128),
    invoice_type_desc: str(row.invoice_type_desc, 32),
    batch_no: str(row.batch_no, 64),
    total_amount: money(row.total_amount),
    payable_amount: money(row.payable_amount),
    actual_pay_amount: money(row.actual_pay_amount),
    after_total_amount: money(row.after_total_amount),
    // ⚠ 助手回传的是「毫秒时间戳」（平台接口给的就是 long），这里必须转成 Date，
    //   直接把 1793123911256 塞进 DATETIME 列会报 Incorrect datetime value
    order_time: dateMs(row.order_time),
    pay_time: dateMs(row.pay_time),
    finish_time: dateMs(row.finish_time),
    apply_time: dateMs(row.apply_time),
    invoice_time: dateMs(row.invoice_time),
    online_blocked: row.online_blocked ? 1 : 0,
    raw_json: row.raw_json ? String(row.raw_json).slice(0, 60000) : null,
    trade_status_desc: str(row.trade_status_desc, 32),
    refund_status_desc: str(row.refund_status_desc, 32),
    item_count: num(row.item_count),
    item_names: str(row.item_names, 500),
  };
}

// ── 登录台账 ────────────────────────────────────────────────────────
/** 登录概况（给前端登录条用）。注意：这里不存 Cookie，登录态在本机助手的浏览器分区里。 */
async function sessionInfo(userId) {
  const rows = await db.query(
    'SELECT user_id, sub_user_id, account_name, last_sync_at, source, agent_ver, written_at'
    + ' FROM sdc_session WHERE user_id = ?', [Number(userId) || 0]
  ).catch(() => []);
  const r = rows && rows[0];
  if (!r) return { logined: false, subUserId: '', accountName: '', lastSyncAt: null };
  return {
    logined: true,
    subUserId: r.sub_user_id || '',
    accountName: r.account_name || '',
    lastSyncAt: r.last_sync_at || null,
    agentVer: r.agent_ver || '',
    writtenAt: r.written_at || null,
  };
}

/** 助手回报登录成功后写台账（只是一次 UPSERT，不含任何凭据） */
async function upsertSession(userId, info = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return false;
  await db.exec(
    'INSERT INTO sdc_session (user_id, sub_user_id, account_name, source, agent_ver, written_at)'
    + ' VALUES (?,?,?,?,?,NOW())'
    + ' ON DUPLICATE KEY UPDATE sub_user_id = VALUES(sub_user_id), account_name = VALUES(account_name),'
    + ' source = VALUES(source), agent_ver = VALUES(agent_ver), written_at = NOW()',
    [uid, str(info.subUserId, 32), str(info.accountName, 128), str(info.source, 32) || '本机助手', str(info.agentVer, 32)]
  ).catch((e) => { console.warn(`[sdc] 登录台账写入失败：${(e && e.message) || e}`); return false; });
  return true;
}

async function clearSession(userId) {
  await db.exec('DELETE FROM sdc_session WHERE user_id = ?', [Number(userId) || 0]).catch(() => false);
  return true;
}

/** 记本轮同步时间（助手跑完 sdc_fetch 后调用） */
async function touchSync(userId) {
  await db.exec('UPDATE sdc_session SET last_sync_at = NOW() WHERE user_id = ?', [Number(userId) || 0])
    .catch(() => false);
  return true;
}

/** 管理员「代入」用：哪些账号已经登录过闪电帮帮（返回用户 id 数组，与拼多多口径一致） */
async function usersWithSession() {
  const rows = await db.query('SELECT user_id FROM sdc_session').catch(() => []);
  return (rows || []).map((r) => Number(r.user_id)).filter(Boolean);
}

// ── 订单入库 ────────────────────────────────────────────────────────
/**
 * 保存助手回传的一批订单（已归一化第二步在 normalize 里）。
 * @param {number} userId
 * @param {Array<object>} rows  助手挑选后的行（见 electron/agent/sdc.js 的 pick 步骤）
 * @returns {{inserted:number, updated:number, skipped:number, total:number}}
 */
async function saveOrders(userId, rows) {
  const uid = Number(userId) || 0;
  const out = { inserted: 0, updated: 0, skipped: 0, total: 0 };
  if (!uid || !Array.isArray(rows)) return out;
  const now = new Date();
  for (const raw of rows) {
    const r = normalize(raw);
    if (!r) continue;
    out.total += 1;
    const hash = rowHash(r);
    // 指纹没变 → 只更新 synced_at（表示「本轮确实拉到了它」），不动 updated_at
    const old = await db.query('SELECT row_hash FROM sdc_order WHERE user_id = ? AND order_sn = ?', [uid, r.order_sn])
      .then((x) => (x && x[0]) || null)
      .catch(() => null);
    if (old && old.row_hash === hash) {
      await db.exec('UPDATE sdc_order SET synced_at = ? WHERE user_id = ? AND order_sn = ?', [now, uid, r.order_sn])
        .catch(() => null);
      out.skipped += 1;
      continue;
    }
    // ⚠ order_sn 已在上面的固定列里出现过一次，这里必须排除，
    //   否则 INSERT 里同一列出现两次 → MySQL 报 "Column 'order_sn' specified twice"
    const cols = Object.keys(r).filter((c) => c !== 'order_sn');
    const sql = 'INSERT INTO sdc_order (user_id, order_sn, ' + cols.map((c) => '`' + c + '`').join(', ')
      + ', row_hash, synced_at) VALUES (?,?, ' + cols.map(() => '?').join(',') + ', ?, ?)'
      + ' ON DUPLICATE KEY UPDATE ' + cols.map((c) => '`' + c + '` = VALUES(`' + c + '`)').join(', ')
      + ', row_hash = VALUES(row_hash), synced_at = VALUES(synced_at)';
    const args = [uid, r.order_sn, ...cols.map((c) => r[c]), hash, now];
    const res = await db.exec(sql, args).catch((e) => {
      console.warn(`[sdc] 订单写入失败（${r.order_sn}）：${(e && e.message) || e}`);
      return null;
    });
    if (!res) continue;
    if (old) out.updated += 1; else out.inserted += 1;
  }
  return out;
}

// ── 查询 ────────────────────────────────────────────────────────────
/**
 * 订单筛选条件（列表 / 计数 / 店铺聚合三处共用，避免「筛选看着一样结果不一样」）
 * @param {object} q {userId, stage, keyword, shopId}
 * @param {string} [alias] 表名前缀，如 'o.'（拼← table alias 只允许内部常量）
 */
function orderWhere(q = {}, alias) {
  // ⚠ 必须带外层表限定：下面 sent 用到的关联子查询里有 sdc_msg_log m，
  //   如果这里写成裸列名（user_id / shop_id），MySQL 解析时会优先命中内层的 m 表，
  //   条件退化成本表自比较（恒真/恒假），催收筛选直接失效。
  const p = (alias ? String(alias) : 'sdc_order') + '.';
  const where = [`${p}user_id = ?`];
  const args = [Number(q.userId) || 0];
  const stage = Number(q.stage);
  if (STAGE_TEXT[stage]) { where.push(`${p}stage = ?`); args.push(stage); }
  const shopId = str(q.shopId, 32);
  // '__none__' = 「没有店铺 ID」那一组（店铺树里必须能看到它们，否则这部分订单会凭空消失）
  // ⚠ 表前缀只能落在列名上，写在 IFNULL( 前面会变成 o.IFNULL(...) 直接语法错
  if (shopId === '__none__') { where.push(`IFNULL(${p}shop_id, '') = ''`); }
  else if (shopId) { where.push(`${p}shop_id = ?`); args.push(shopId); }
  // 催收状态：与 1688 页同一套口径（已催收 = 有成功记录；最近 N 天未催收 = N 天内没有成功记录）
  const sent = String(q.sent || '').trim();
  if (sent === 'collected') {
    where.push(`EXISTS (SELECT 1 FROM sdc_msg_log m WHERE m.user_id = ${p}user_id`
      + ` AND m.shop_id = ${p}shop_id AND m.ok = 1)`);
  } else if (/^\d+$/.test(sent)) {
    const days = Math.min(365, Math.max(1, Number(sent)));
    where.push(`NOT EXISTS (SELECT 1 FROM sdc_msg_log m WHERE m.user_id = ${p}user_id`
      + ` AND m.shop_id = ${p}shop_id AND m.ok = 1 AND m.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY))`);
  }
  const kw = String(q.keyword || '').trim();
  if (kw) {
    where.push(`(${p}order_sn LIKE ? OR ${p}shop_name LIKE ? OR ${p}wm_poi_name LIKE ?`
      + ` OR ${p}invoice_title LIKE ? OR ${p}batch_no LIKE ?)`);
    const like = `%${kw}%`;
    args.push(like, like, like, like, like);
  }
  return { where, args };
}

/**
 * 订单列表（带按店铺聚合的催收统计）
 * @param {object} q {userId, stage, keyword, shopId, sent, page, size, sort}
 */
async function list(q = {}) {
  const uid = Number(q.userId) || 0;
  const { where, args } = orderWhere(q, 'o');
  const page = Math.max(1, Number(q.page) || 1);
  const size = Math.min(200, Math.max(1, Number(q.size) || 20));
  const order = SORTS[String(q.sort || 'time_desc')] || SORTS.time_desc;

  const rows = await db.query(
    `SELECT o.order_sn, o.stage, o.shop_id, o.shop_name, o.wm_poi_id, o.wm_poi_name,
            o.invoice_apply_status, o.invoice_apply_desc, o.invoice_title, o.taxpayer_ident,
            o.taker_email, o.invoice_type_desc, o.batch_no,
            o.total_amount, o.payable_amount, o.actual_pay_amount, o.after_total_amount,
            o.order_time, o.pay_time, o.finish_time, o.apply_time, o.invoice_time,
            o.online_blocked,
            o.trade_status_desc, o.refund_status_desc, o.item_count, o.item_names,
            o.send_count, o.last_sent_at, o.synced_at
       FROM sdc_order o
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`,
    [...args, size, (page - 1) * size]
  ).catch(() => []);

  // 催收统计按店铺聚合（与拼多多按 mall_id 聚合同理）：同一家店多个订单只发一条消息
  const shopIds = [...new Set(rows.map((r) => String(r.shop_id || '')).filter(Boolean))];
  const stat = new Map();
  if (shopIds.length) {
    const ph = shopIds.map(() => '?').join(',');
    const agg = await db.query(
      `SELECT shop_id, SUM(ok = 1) AS okN, SUM(ok <> 1 OR ok IS NULL) AS failN,
              MAX(CASE WHEN ok = 1 THEN created_at END) AS lastOkAt, MAX(created_at) AS lastAnyAt
         FROM sdc_msg_log WHERE user_id = ? AND shop_id IN (${ph}) GROUP BY shop_id`,
      [uid, ...shopIds]
    ).catch(() => []);
    for (const s of agg || []) stat.set(String(s.shop_id), s);
  }

  return rows.map((r) => {
    const s = stat.get(String(r.shop_id || '')) || null;
    return Object.assign({}, r, {
      stageText: STAGE_TEXT[Number(r.stage)] || '',
      sendCount: s ? Number(s.okN) || 0 : Number(r.send_count) || 0,
      failCount: s ? Number(s.failN) || 0 : 0,
      lastSentAt: s && s.lastOkAt ? s.lastOkAt : (r.last_sent_at || null),
      chatable: !!String(r.shop_id || ''),
    });
  });
}

/** 概况（分页合计用总数，注意是「当前筛选条件」下的） */
async function count(q = {}) {
  const uid = Number(q.userId) || 0;
  const { where, args } = orderWhere(q);
  const rows = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(payable_amount),0) AS amt FROM sdc_order WHERE ${where.join(' AND ')}`,
    args
  ).catch(() => []);
  const r = (rows && rows[0]) || {};
  return { count: Number(r.n) || 0, amount: money(r.amt) || 0 };
}

// ── 店铺维度（页面主表：一行 = 一家店铺，订单明细在展开行里另拉） ──────────
/**
 * 店铺聚合列表。口径与 list 完全一致（同一套 orderWhere），只是把行折叠成店铺。
 * ⚠ IFNULL(shop_id,'') 分组：把「没有店铺 ID」的订单也归到一个「（无店铺 ID）」组，
 *   否则这部分订单在店铺视图里会凭空消失（发不了消息，但得让人看见）。
 * @param {object} q {userId, stage, keyword, page, size, sort}
 */
/**
 * 店铺维度「开票」筛选（与 1688 发票页同一条口径：已开票=待开票金额 0，未开票=待开票金额>0）。
 * 待开票是聚合值，只能落在 HAVING 里，所以单独给出 SQL 片段而不是塞进 orderWhere。
 */
function invoiceHaving(q = {}) {
  const inv = String(q.invoice || '').trim();
  if (inv === 'invoiced') {
    return ' HAVING COALESCE(SUM(total_amount),0) - COALESCE(SUM(CASE WHEN stage IN (2,4) THEN payable_amount ELSE 0 END),0) <= 0';
  }
  if (inv === 'pending') {
    return ' HAVING COALESCE(SUM(total_amount),0) - COALESCE(SUM(CASE WHEN stage IN (2,4) THEN payable_amount ELSE 0 END),0) > 0';
  }
  return '';
}

async function shops(q = {}) {
  const uid = Number(q.userId) || 0;
  const { where, args } = orderWhere(q);
  const page = Math.max(1, Number(q.page) || 1);
  const size = Math.min(200, Math.max(1, Number(q.size) || 20));
  const order = SHOP_SORTS[String(q.sort || 'amount_desc')] || SHOP_SORTS.amount_desc;

  const rows = await db.query(
    `SELECT IFNULL(shop_id, '') AS shop_id,
            MAX(IFNULL(shop_name, '')) AS shop_name,
            COUNT(*) AS order_count,
            COALESCE(SUM(payable_amount), 0) AS payable_amount,
            COALESCE(SUM(total_amount), 0) AS total_amount,
            -- 待开票 = 订单总金额 − 已申请开票金额（已申请/已开票那两档算「已有着落」，不再计入待开票）
            COALESCE(SUM(CASE WHEN stage IN (2, 4) THEN payable_amount ELSE 0 END), 0) AS applied_amount,
            SUM(stage = 1) AS stage1_count,
            SUM(stage = 2) AS stage2_count,
            SUM(stage = 3) AS stage3_count,
            SUM(stage = 4) AS stage4_count,
            MAX(pay_time) AS last_pay_time,
            MIN(pay_time) AS first_pay_time,
            MAX(send_count) AS send_count,
            MAX(last_sent_at) AS last_sent_at,
            COUNT(DISTINCT IFNULL(wm_poi_name, '')) AS poi_count
       FROM sdc_order
      WHERE ${where.join(' AND ')}
      GROUP BY IFNULL(shop_id, '')${invoiceHaving(q)}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`,
    [...args, size, (page - 1) * size]
  ).catch(() => []);

  // 催收成功/失败按店铺计（sdc_msg_log 是按店铺一条）；.order 表里也有 send_count，优先用日志口径
  const ids = rows.map((r) => String(r.shop_id || '')).filter(Boolean);
  const stat = new Map();
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const agg = await db.query(
      `SELECT shop_id, SUM(ok = 1) AS okN, SUM(ok <> 1 OR ok IS NULL) AS failN,
              MAX(CASE WHEN ok = 1 THEN created_at END) AS lastOkAt, MAX(created_at) AS lastAnyAt
         FROM sdc_msg_log WHERE user_id = ? AND shop_id IN (${ph}) GROUP BY shop_id`,
      [uid, ...ids]
    ).catch(() => []);
    for (const s of agg || []) stat.set(String(s.shop_id || ''), s);
  }

  return rows.map((r) => {
    const shopId = String(r.shop_id || '');
    const s = stat.get(shopId) || null;
    return Object.assign({}, r, {
      shopName: String(r.shop_name || '') || '（无店铺 ID）',
      key: shopId || '__none__',          // Element row-key 不能是空串
      chatable: !!shopId,                 // 没有店铺 ID → 换不到会话，发不出去
      orderCount: Number(r.order_count) || 0,
      payableAmount: money(r.payable_amount),
      totalAmount: money(r.total_amount),
      appliedAmount: money(r.applied_amount),
      // 待开票金额：总金额扣掉已申请/已开票的部分，负数按 0 处理（有退款时总额可能低于已申请）
      pendingAmount: Math.max(0, Number(money(r.total_amount) || 0) - Number(money(r.applied_amount) || 0)),
      stage1Count: Number(r.stage1_count) || 0,
      stage2Count: Number(r.stage2_count) || 0,
      stage3Count: Number(r.stage3_count) || 0,
      stage4Count: Number(r.stage4_count) || 0,
      // 可催收单数：已申请 + 不支持线上开票（第 6 条的催收口径）
      chatCount: (Number(r.stage2_count) || 0) + (Number(r.stage3_count) || 0),
      poiCount: Number(r.poi_count) || 0,
      sendCount: s ? Number(s.okN) || 0 : Number(r.send_count) || 0,
      failCount: s ? Number(s.failN) || 0 : 0,
      lastSentAt: s && s.lastOkAt ? s.lastOkAt : (r.last_sent_at || null),
      lastPayTime: r.last_pay_time || null,
    });
  });
}

/** 店铺聚合后的总家数与金额合计（用于分页） */
async function countShops(q = {}) {
  const { where, args } = orderWhere(q);
  const hv = invoiceHaving(q);
  // 注意：开票筛选是聚合后条件，必须留在子查询的 HAVING 里，不能提到外层 WHERE
  const rows = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(payable_amount), 0) AS amt
       FROM (SELECT IFNULL(shop_id, '') AS shop_id, SUM(payable_amount) AS payable_amount
               FROM sdc_order WHERE ${where.join(' AND ')}
              GROUP BY IFNULL(shop_id, '')${hv}) t`,
    args
  ).catch(() => []);
  const r = (rows && rows[0]) || {};
  return { count: Number(r.n) || 0, amount: money(r.amt) || 0 };
}

/**
 * 增量窗口（重复行靠 upsert + 指纹比对保持幂等，这里只决定「窗口开多大」）
 *
 * 两个来源的重叠长度不一样，原因是数据可变态不同：
 *   · 订单列表：订单下单后状态仍会变（退款、关单），留 1 天重叠让这些变化能被重新拉到；
 *   · 开票状态：开票记录生成后，开票时间不会再被改写，因此**不需要任何重叠**。
 *     实测教训：某账号 96 单在同一秒（00:40:39）批量申请开票，invoice_time 全部相同。
 *     留 1 天重叠时这 96 单每轮刷新都被重新回传比对（全部无变化），用户看到「一直回传 87 条」；
 *     缩到 5 分钟、1 秒都无效——它们的值正好等于锚点。去掉重叠（锚点 = MAX）后才会被跳过。
 *     安全性：未开票的单 invoice_time 只是兜底的 apply_time、不会变，本来就不需要重拉；
 *     真正开票时 invoiceDate 会变成一个**更晚的新时间**，必然大于锚点，照样能被增量拉到。
 */
const ORDER_OVERLAP_MS = 86400 * 1000;   // 订单：1 天（订单状态之后还会变，需要重叠）
const INVOICE_OVERLAP_MS = 0;             // 开票：不重叠（开票时间只会新增，不会改写）
async function syncWindow(userId) {
  const uid = Number(userId) || 0;
  const endMs = Date.now();
  const rows = await db.query(
    // 锚点必须与接口的过滤口径一致：orderStartTime 过滤的是**订单时间**（orderDate → order_time）。
    // 不能用 pay_time：支付可以晚于下单（库里实测 108 单如此，最长差 2 天），
    // 锚点被支付时间推后后，那些「下单早、支付晚」的订单就落在窗口外，
    // 之后的状态变更（退款/关单等）再也拉不到，只能靠开票接口偶然兜住。
    'SELECT MAX(order_time) AS max_ord, MAX(pay_time) AS max_pay, MAX(invoice_time) AS max_inv'
    + ' FROM sdc_order WHERE user_id = ?', [uid]
  ).catch(() => []);
  const r = (rows && rows[0]) || {};
  const toMs = (t) => {
    if (!t) return 0;
    const d = t instanceof Date ? t : new Date(String(t).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  };
  // 订单时间为准；只有老数据全都没有订单时间时，才退用支付时间近似
  const maxOrd = toMs(r.max_ord) || toMs(r.max_pay);
  // 首次（库里没有订单）：拉近一年；之后从最近订单时间回退 1 天做重叠
  const startMs = maxOrd ? maxOrd - ORDER_OVERLAP_MS : endMs - 365 * 86400 * 1000;
  const maxInv = toMs(r.max_inv);
  return {
    startMs: Math.min(startMs, endMs),
    invoiceSinceMs: maxInv ? Math.max(0, maxInv - INVOICE_OVERLAP_MS) : 0,
    endMs,
    first: !maxOrd,
  };
}

async function summary(userId) {
  const uid = Number(userId) || 0;
  const rows = await db.query(
    `SELECT stage, COUNT(*) AS n, COALESCE(SUM(payable_amount),0) AS amt, COUNT(DISTINCT shop_id) AS shops
       FROM sdc_order WHERE user_id = ? GROUP BY stage`, [uid]
  ).catch(() => []);
  const g = (st) => {
    const r = (rows || []).find((x) => Number(x.stage) === st);
    return {
      count: Number(r && r.n) || 0,
      amount: money(r && r.amt) || 0,
      shops: Number(r && r.shops) || 0,
    };
  };
  return {
    applyable: g(1),     // 可申请开票
    applied: g(2),       // 已申请开票
    blocked: g(3),       // 不支持线上开票
    issued: g(4),        // 已开票
    stageText: STAGE_TEXT,
    chatStages: STAGES_TO_CHAT,
  };
}

/**
 * 把订单行按店铺合并成催收条目：一家店一条消息（金额合计 + 订单清单）
 * @returns {Array<{shopId, shopName, amount, orders:[{orderId, amount}]}>}
 */
function groupByShop(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const shopId = String(r.shop_id || '');
    if (!map.has(shopId)) {
      map.set(shopId, {
        shopId, shopName: String(r.shop_name || '') || '（无店铺 ID）',
        amount: 0, orders: [],
      });
    }
    const g = map.get(shopId);
    const amt = money(r.payable_amount) || 0;
    g.amount = Math.round((g.amount + amt) * 100) / 100;
    g.orders.push({ orderId: String(r.order_sn), amount: amt });
  }
  const out = [...map.values()];
  for (const g of out) g.orders.sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)));
  // 金额大的排在前面：催收时先处理金额高的
  return out.sort((a, b) => b.amount - a.amount);
}

/**
 * 按店铺聚合待催收订单（发批量催收前用）
 * 催收口径（2026-10-29 起）：只催「卡住的」两档 —— 已申请开票(2) + 不支持线上开票(3)。
 *   可申请开票(1) 还没提申请，催了也没意义；已开票(4) 已经完成，不再打扰商家。
 * @param {number} userId
 * @param {string[]} [orderSns] 指定订单（显式指定时按订单来，不再套档位）
 * @param {object} [opts] { shopIds: string[], stages: number[], stage: number|'' }
 * @returns {Array<{shopId, shopName, amount, orders:[{orderId,amount}]}>}
 */
async function shopsToChat(userId, orderSns, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const uid = Number(userId) || 0;
  const picked = Array.isArray(o.stages) && o.stages.length ? o.stages : [Number(o.stage)];
  const stages = picked.map(Number).filter((s) => !!STAGE_TEXT[s]);
  const useStages = stages.length ? stages : STAGES_TO_CHAT;
  const stageSql = ` AND stage IN (${useStages.map(() => '?').join(',')})`;

  // 页面主表是店铺维度：勾选的单位就是店铺
  const ids = Array.isArray(o.shopIds) ? o.shopIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const rows = await db.query(
      'SELECT order_sn, shop_id, shop_name, payable_amount FROM sdc_order'
      + ` WHERE user_id = ? AND IFNULL(shop_id, '') IN (${ph})${stageSql} ORDER BY order_sn`,
      [uid, ...ids, ...useStages]
    ).catch(() => []);
    return groupByShop(rows);
  }
  // 显式给了订单号：就按订单来（勾订单的场景，保留兼容）
  const sns = Array.isArray(orderSns) ? orderSns.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (sns.length) {
    const ph = sns.map(() => '?').join(',');
    const rows = await db.query(
      'SELECT order_sn, shop_id, shop_name, payable_amount FROM sdc_order'
      + ` WHERE user_id = ? AND order_sn IN (${ph}) ORDER BY order_sn`,
      [uid, ...sns]
    ).catch(() => []);
    return groupByShop(rows);
  }
  // 什么都没选：所有店铺里「卡住的」两档，按店合并
  const rows = await db.query(
    'SELECT order_sn, shop_id, shop_name, payable_amount FROM sdc_order'
    + ` WHERE user_id = ? AND shop_id IS NOT NULL AND shop_id <> ''${stageSql} ORDER BY order_sn`,
    [uid, ...useStages]
  ).catch(() => []);
  return groupByShop(rows);
}

// ── 催收留痕 ────────────────────────────────────────────────────────
/**
 * 记录一次批量催收的结果（一家店一条）。
 * 发消息是真实对外打扰，必须留痕：谁家、催了哪些单、多少钱、成没成。
 * @param {number} userId
 * @param {Array<{shopId,shopName,ok,detail,orderSns,amount,contents,sent}>} results 助手回传的逐店结果
 */
async function logMsg(userId, results) {
  const uid = Number(userId) || 0;
  if (!uid || !Array.isArray(results) || !results.length) return;
  for (const r of results) {
    if (!r) continue;
    const shopId = str(r.shopId || r.shop_id, 32);
    const sns = Array.isArray(r.orderSns) ? r.orderSns.map(String) : [];
    const contents = Array.isArray(r.contents) ? r.contents : (r.content ? [r.content] : []);
    const ok = r.ok ? 1 : 0;
    await db.exec(
      'INSERT INTO sdc_msg_log (user_id, shop_id, shop_name, order_sns, order_count, amount, ok, detail, content)'
      + ' VALUES (?,?,?,?,?,?,?,?,?)',
      [
        uid, shopId, str(r.shopName || r.shop_name, 128),
        sns.join(',').slice(0, 4000), sns.length,
        r.amount === null || r.amount === undefined ? null : money(r.amount),
        ok,
        String(r.detail || (ok ? '发送成功' : '发送失败')).slice(0, 250),
        contents.join(' ␟ ').slice(0, 1000),
      ]
    ).catch((e) => console.warn(`[sdc] 催收日志写入失败（${shopId || '-'}）：${(e && e.message) || e}`));
    // 成功才累加店铺催收次数（失败的催收不算「催过了」，否则筛选会误判）
    if (ok && shopId) {
      await db.exec(
        'UPDATE sdc_order SET send_count = send_count + 1, last_sent_at = NOW()'
        + ' WHERE user_id = ? AND shop_id = ?',
        [uid, shopId]
      ).catch(() => null);
    }
  }
}

/** 某店铺（不传 shopId 就是全部）最近的催收记录，展开行里展示 */
async function msgHistory(userId, limit, shopId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  const n = Math.min(100, Math.max(1, Number(limit) || 20));
  const sid = str(shopId, 32);
  const args = [uid];
  let sql = 'SELECT id, shop_id AS shopId, shop_name AS shopName, order_sns AS orderSns,'
    + ' order_count AS orderCount, amount, ok, detail, content, created_at AS createdAt'
    + ' FROM sdc_msg_log WHERE user_id = ?';
  if (sid) { sql += ' AND shop_id = ?'; args.push(sid); }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(n);
  const rows = await db.query(sql, args).catch(() => []);
  return (rows || []).map((r) => Object.assign({}, r, {
    ok: !!r.ok,
    amount: r.amount === null ? null : money(r.amount),
  }));
}

module.exports = {
  STAGE_TEXT, STAGES_TO_CHAT,
  SORTS, SHOP_SORTS,
  dateMs, money, str, num,
  sessionInfo, upsertSession, clearSession, touchSync, usersWithSession,
  saveOrders, list, count, shops, countShops, summary, shopsToChat, logMsg, msgHistory, syncWindow,
};
