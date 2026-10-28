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

/** 档位字典（前端表格与筛选共用） */
const STAGE_TEXT = {
  1: '可申请开票',
  2: '已申请开票',
};

/** 列表排序（与拼多多同风格：前端给 key，这里翻译成 SQL，杜绝字符串拼用户入参） */
const SORTS = {
  time_desc: 'o.pay_time DESC, o.order_sn DESC',
  time_asc: 'o.pay_time ASC, o.order_sn ASC',
  amount_desc: 'o.payable_amount DESC, o.order_sn DESC',
  amount_asc: 'o.payable_amount ASC, o.order_sn ASC',
  shop_asc: 'o.shop_name ASC, o.order_sn DESC',
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
  ];
  return crypto.createHash('md5').update(pieces.join('|')).digest('hex');
}

/** 归一化助手回传的一行：两个端点字段不同，在这里统一成库里的列 */
function normalize(row) {
  const stage = Number(row && row.stage) === 2 ? 2 : 1;
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
 * 订单列表（带按店铺聚合的催收统计）
 * @param {object} q {userId, stage, keyword, shopId, sent, page, size, sort}
 */
async function list(q = {}) {
  const uid = Number(q.userId) || 0;
  const where = ['o.user_id = ?'];
  const args = [uid];
  const stage = Number(q.stage);
  if (stage === 1 || stage === 2) { where.push('o.stage = ?'); args.push(stage); }
  const shopId = str(q.shopId, 32);
  if (shopId) { where.push('o.shop_id = ?'); args.push(shopId); }
  const kw = String(q.keyword || '').trim();
  if (kw) {
    where.push('(o.order_sn LIKE ? OR o.shop_name LIKE ? OR o.wm_poi_name LIKE ?'
      + ' OR o.invoice_title LIKE ? OR o.batch_no LIKE ?)');
    const like = `%${kw}%`;
    args.push(like, like, like, like, like);
  }
  const page = Math.max(1, Number(q.page) || 1);
  const size = Math.min(200, Math.max(1, Number(q.size) || 20));
  const order = SORTS[String(q.sort || 'time_desc')] || SORTS.time_desc;

  const rows = await db.query(
    `SELECT o.order_sn, o.stage, o.shop_id, o.shop_name, o.wm_poi_id, o.wm_poi_name,
            o.invoice_apply_status, o.invoice_apply_desc, o.invoice_title, o.taxpayer_ident,
            o.taker_email, o.invoice_type_desc, o.batch_no,
            o.total_amount, o.payable_amount, o.actual_pay_amount, o.after_total_amount,
            o.order_time, o.pay_time, o.finish_time, o.apply_time,
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
  const where = ['user_id = ?'];
  const args = [uid];
  const stage = Number(q.stage);
  if (stage === 1 || stage === 2) { where.push('stage = ?'); args.push(stage); }
  const shopId = str(q.shopId, 32);
  if (shopId) { where.push('shop_id = ?'); args.push(shopId); }
  const kw = String(q.keyword || '').trim();
  if (kw) {
    where.push('(order_sn LIKE ? OR shop_name LIKE ? OR wm_poi_name LIKE ? OR invoice_title LIKE ? OR batch_no LIKE ?)');
    const like = `%${kw}%`;
    args.push(like, like, like, like, like);
  }
  const rows = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(payable_amount),0) AS amt FROM sdc_order WHERE ${where.join(' AND ')}`,
    args
  ).catch(() => []);
  const r = (rows && rows[0]) || {};
  return { count: Number(r.n) || 0, amount: money(r.amt) || 0 };
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
    stageText: STAGE_TEXT,
  };
}

/**
 * 按店铺聚合待催收订单（发批量催收前用）
 * @param {number} userId
 * @param {string[]} [orderSns] 指定订单；不传表示「全部可申请开票的订单」
 * @returns {Array<{shopId, shopName, amount, orders:[{orderId,amount}]}>}
 */
async function shopsToChat(userId, orderSns) {
  const uid = Number(userId) || 0;
  const sns = Array.isArray(orderSns) ? orderSns.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (sns.length) {
    const ph = sns.map(() => '?').join(',');
    const rows = await db.query(
      'SELECT order_sn, shop_id, shop_name, payable_amount FROM sdc_order'
      + ` WHERE user_id = ? AND order_sn IN (${ph}) ORDER BY order_sn`, [uid, ...sns]
    ).catch(() => []);
    return groupByShop(rows);
  }
  const rows = await db.query(
    'SELECT order_sn, shop_id, shop_name, payable_amount FROM sdc_order'
    + ' WHERE user_id = ? AND stage = 1 AND shop_id IS NOT NULL AND shop_id <> \'\''
    + ' ORDER BY order_sn', [uid]
  ).catch(() => []);
  return groupByShop(rows);
}

function groupByShop(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const shopId = String(r.shop_id || '');
    if (!shopId) continue;               // 没有 shop_id → 换不到会话，发不出去
    let s = map.get(shopId);
    if (!s) {
      s = { shopId, shopName: r.shop_name || '', amount: 0, orders: [] };
      map.set(shopId, s);
    }
    const amount = Number(r.payable_amount) || Number(r.total_amount) || 0;
    s.amount = Math.round((s.amount + amount) * 100) / 100;
    s.orders.push({ orderId: r.order_sn, amount });
  }
  return [...map.values()];
}

/** 催收留痕（按店铺一条，results 是助手回执） */
async function logMsg(userId, results) {
  const uid = Number(userId) || 0;
  if (!uid || !Array.isArray(results) || !results.length) return;
  for (const r of results) {
    if (!r || !r.shopId) continue;
    const orderSns = Array.isArray(r.orderSns) ? r.orderSns : [];
    await db.exec(
      'INSERT INTO sdc_msg_log (user_id, shop_id, shop_name, order_sns, order_count, amount, ok, detail, content)'
      + ' VALUES (?,?,?,?,?,?,?,?,?)',
      [
        uid, String(r.shopId).slice(0, 32), str(r.shopName, 128),
        orderSns.join(',').slice(0, 6000), orderSns.length, money(r.amount),
        r.ok ? 1 : 0, str(r.detail, 255),
        Array.isArray(r.contents) ? r.contents.join('␟').slice(0, 1000) : str(r.content, 1000),
      ]
    ).catch((e) => console.warn(`[sdc] 催收日志写入失败（店铺 ${r.shopId}）：${(e && e.message) || e}`));
    // 同店铺的订单同步「最近催收」信息，列表里就能看到催过几次
    if (r.ok && orderSns.length) {
      const ph = orderSns.map(() => '?').join(',');
      await db.exec(
        `UPDATE sdc_order SET send_count = send_count + 1, last_sent_at = NOW()
          WHERE user_id = ? AND order_sn IN (${ph})`, [uid, ...orderSns]
      ).catch(() => null);
    }
  }
}

/** 最近催收记录（页面「催收历史」用） */
async function msgHistory(userId, limit = 20) {
  const rows = await db.query(
    'SELECT id, shop_id, shop_name, order_sns, order_count, amount, ok, detail, content, created_at'
    + ' FROM sdc_msg_log WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [Number(userId) || 0, Math.min(200, Math.max(1, Number(limit) || 20))]
  ).catch(() => []);
  return rows.map((r) => Object.assign({}, r, {
    orderSns: String(r.order_sns || '').split(',').filter(Boolean),
  }));
}

module.exports = {
  STAGE_TEXT,
  SORTS,
  dateMs, money, str, num,
  sessionInfo, upsertSession, clearSession, touchSync, usersWithSession,
  saveOrders, list, count, summary, shopsToChat, logMsg, msgHistory,
};
