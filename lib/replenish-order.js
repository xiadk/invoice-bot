/**
 * 补货单（v0.3.12）
 * ════════════════════════════════════════════════════════════════════════════
 * 「采用补货建议」时按**供应商**归集生成：一个供应商一张补货单，明细一行一个 SKU。
 *
 * 口径（用户 2026-11-03 确认）：
 *   · 补货数量(件) = 向上取整(建议量 ÷ 规格)，规格取最低价渠道自己的装箱规格，
 *     渠道没规格退本地价规格，都没有按 1（= 补货数量就是建议量）
 *   · 行总额 = 补货数量 × 规格 × 最低单价（按整件买齐的实际金额）
 *   · 补货单金额 = 明细行总额之和；整单合计由前端把各单金额相加
 *   · 平台渠道映射到台账里的同名供应商：齐货通→齐货通、城配速达→永源顺、京东万商→京东万商；
 *     台账里没有就自动建一条（否则这张单永远关联不到货单）
 *   · 关联货单后记金额快照，列表显示「一致 / 相差多少」；货单被软删了也还能看当时的对账结果
 *
 * ⚠ 金额一律服务端重算，不信前端传来的总额（前端只传建议量、规格、单价）。
 */
const db = require('../db');
const { calcReplenishLine } = require('./products');

const CHANNELS = ['qht', 'afa', 'jd', 'local'];
const MAX_ITEMS = 3000;                 // 一次最多生成多少行（比列表上限 2000 留余量）
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

/** 供应商台账索引：{byId:{id:name}, byName:{name:id}}，同一次请求只查一次 */
async function supplierIndex(userId) {
  const rows = await db.query('SELECT id, name FROM supplier WHERE user_id = ?', [userId]);
  const byId = {};
  const byName = {};
  for (const r of rows) {
    byId[r.id] = r.name;
    byName[r.name] = r.id;
  }
  return { byId, byName };
}

/**
 * 按名字取供应商 id，没有就建一条。
 * 平台渠道（齐货通/永源顺/京东万商）走这里：台账里缺了自动补，保证补货单能关联货单。
 */
async function ensureSupplier(userId, name, operator) {
  const nm = str(name, 64);
  if (!nm) return 0;
  const ex = await db.query('SELECT id FROM supplier WHERE user_id = ? AND name = ? LIMIT 1', [userId, nm]);
  if (ex.length) return Number(ex[0].id) || 0;
  try {
    const r = await db.exec(
      'INSERT INTO supplier (user_id, name, note, created_by) VALUES (?, ?, ?, ?)',
      [userId, nm, '补货单自动创建', str(operator, 64) || null]);
    return Number(r.insertId) || 0;
  } catch (e) {
    // 并发下唯一键冲突：重新查一次即可
    const again = await db.query('SELECT id FROM supplier WHERE user_id = ? AND name = ? LIMIT 1', [userId, nm]);
    return again.length ? Number(again[0].id) || 0 : 0;
  }
}

/**
 * 生成补货单（按供应商分组，一次可生成多张）。
 * @param {{userId:number, operator:string, batchId?:string,
 *          groups:Array<{supplierId?:number, supplierName?:string, channel?:string,
 *                        items:Array<{sku:string, goodsName?:string, channel?:string, channelLabel?:string,
 *                                     suggestQty:any, specQty:any, unitPrice:any}>}>}} o
 * @returns {{ok:true, orders:Array, totalAmount:number, skipped:number}|{ok:false,error:string}}
 */
async function createOrders({ userId, operator, batchId, groups } = {}) {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return { ok: false, error: '没有可生成的补货建议（先做一次比价分析）' };
  const idx = await supplierIndex(userId);

  // 1) 先在内存里把每张单算清楚（纯计算，不碰库），任何一行不合法就整批不生成
  const plans = [];
  let skipped = 0;
  for (const g of list) {
    const items = Array.isArray(g && g.items) ? g.items : [];
    const lines = [];
    let amount = 0;
    let qtyTotal = 0;
    const channels = new Set();
    for (const it of items) {
      const sku = str(it && it.sku, 64);
      if (!sku) { skipped += 1; continue; }
      const line = calcReplenishLine({
        suggestQty: it.suggestQty, specQty: it.specQty, unitPrice: it.unitPrice,
      });
      if (!line.ok) { skipped += 1; continue; }
      if (line.qtyPack <= 0 || line.unitPrice <= 0) { skipped += 1; continue; }
      const ch = CHANNELS.includes(String(it.channel || '')) ? String(it.channel) : 'local';
      channels.add(ch);
      lines.push({
        sku,
        goodsName: str(it.goodsName, 512),
        channel: ch,
        channelLabel: str(it.channelLabel, 32) || ch,
        suggestQty: line.suggestQty,
        specQty: line.specQty,
        qtyPack: line.qtyPack,
        unitPrice: line.unitPrice,
        packPrice: line.packPrice,
        amount: line.amount,
      });
      amount = round2(amount + line.amount);
      qtyTotal += line.qtyPack;
    }
    if (!lines.length) continue;
    let supplierId = Number(g.supplierId) || 0;
    let supplierName = '';
    if (supplierId > 0) supplierName = idx.byId[supplierId] || str(g.supplierName, 64);
    if (!supplierName) supplierName = str(g.supplierName, 64);
    if (!supplierId && supplierName) supplierId = await ensureSupplier(userId, supplierName, operator);
    if (!supplierName && supplierId) supplierName = idx.byId[supplierId] || '';
    plans.push({
      supplierId: supplierId || 0,
      supplierName: supplierName || '未指定供应商',
      channel: channels.size > 1 ? 'mixed' : ([...channels][0] || ''),
      amount,
      itemCount: lines.length,
      qtyTotal,
      lines,
    });
  }

  if (!plans.length) return { ok: false, error: '没有可生成的补货建议（建议量为空或没有最低价）' };
  if (plans.reduce((s, p) => s + p.itemCount, 0) > MAX_ITEMS) {
    return { ok: false, error: `一次最多生成 ${MAX_ITEMS} 行，请先用关键词筛选再生成` };
  }

  // 2) 落库：整批一个事务，中途失败一张单都不留
  const bid = str(batchId, 64) || null;
  const created = await db.transaction(async (conn) => {
    const out = [];
    for (const p of plans) {
      const [r] = await conn.query(
        `INSERT INTO replenish_order
           (user_id, supplier_id, supplier_name, channel, amount, item_count, qty_total, batch_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, p.supplierId, p.supplierName, p.channel, p.amount.toFixed(2),
          p.itemCount, p.qtyTotal, bid, str(operator, 64) || null]);
      const id = Number(r.insertId);
      const values = p.lines.map((l) => [
        id, userId, l.sku, l.goodsName, l.channel, l.channelLabel, p.supplierId,
        l.suggestQty.toFixed(2), l.specQty.toFixed(2), l.qtyPack,
        l.unitPrice.toFixed(4), l.packPrice == null ? null : l.packPrice.toFixed(2), l.amount.toFixed(2),
      ]);
      await conn.query(
        `INSERT INTO replenish_order_item
           (order_id, user_id, sku, goods_name, channel, channel_label, supplier_id,
            suggest_qty, spec_qty, qty_pack, unit_price, pack_price, amount)
         VALUES ?`, [values]);
      out.push({
        id, supplierId: p.supplierId, supplierName: p.supplierName,
        amount: p.amount, itemCount: p.itemCount, qtyTotal: p.qtyTotal,
      });
    }
    return out;
  });

  return {
    ok: true,
    orders: created,
    totalAmount: round2(created.reduce((s, o) => s + o.amount, 0)),
    skipped,
  };
}

/** 补货单列表：按供应商名模糊、生成日期区间、关联状态筛，按生成时间倒序 */
async function listOrders({ userId, supplier, from, to, linked, page, size } = {}) {
  const kw = str(supplier, 64);
  const d1 = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : '';
  const d2 = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to) : '';
  const lk = String(linked == null ? '' : linked).trim();
  const pg = Math.max(1, Number(page) || 1);
  const sz = Math.min(100, Math.max(1, Number(size) || 20));
  const where = ['o.user_id = ?', 'o.deleted_at IS NULL'];
  const args = [userId];
  if (kw) { where.push('o.supplier_name LIKE ?'); args.push(`%${kw}%`); }
  if (d1) { where.push('DATE(o.created_at) >= ?'); args.push(d1); }
  if (d2) { where.push('DATE(o.created_at) <= ?'); args.push(d2); }
  if (lk === '1') where.push('o.waybill_id > 0');
  if (lk === '0') where.push('o.waybill_id = 0');
  const w = where.join(' AND ');
  const FROM = `FROM replenish_order o
     LEFT JOIN waybill w ON w.id = o.waybill_id AND w.user_id = o.user_id AND w.deleted_at IS NULL
    WHERE ${w}`;
  const [rows, cnt, sum] = await Promise.all([
    db.query(
      `SELECT o.id, o.supplier_id, o.supplier_name, o.channel, o.amount, o.item_count, o.qty_total,
              o.batch_id, o.waybill_id, o.waybill_amount, o.created_by,
              DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i') AS created_at,
              DATE_FORMAT(o.linked_at, '%Y-%m-%d %H:%i') AS linked_at,
              DATE_FORMAT(w.bill_date, '%Y-%m-%d') AS waybill_date,
              w.amount AS waybill_cur_amount
         ${FROM}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${sz} OFFSET ${(pg - 1) * sz}`, args),
    db.query(`SELECT COUNT(*) AS n ${FROM}`, args),
    db.query(`SELECT COALESCE(SUM(o.amount), 0) AS amount ${FROM}`, args),
  ]);
  return {
    rows: rows.map((r) => {
      const linkedAmount = r.waybill_id > 0
        ? (r.waybill_cur_amount == null ? (r.waybill_amount == null ? null : Number(r.waybill_amount)) : Number(r.waybill_cur_amount))
        : null;
      const diff = linkedAmount == null ? null : round2(linkedAmount - (Number(r.amount) || 0));
      return {
        id: Number(r.id),
        supplierId: Number(r.supplier_id) || 0,
        supplierName: r.supplier_name || '',
        channel: r.channel || '',
        amount: Number(r.amount) || 0,
        itemCount: Number(r.item_count) || 0,
        qtyTotal: Number(r.qty_total) || 0,
        batchId: r.batch_id || '',
        waybillId: Number(r.waybill_id) || 0,
        waybillAmount: linkedAmount,
        waybillDate: r.waybill_date || '',
        diff,
        matched: diff == null ? null : Math.abs(diff) < 0.005,
        createdBy: r.created_by || '',
        createdAt: r.created_at,
        linkedAt: r.linked_at || '',
      };
    }),
    total: Number(cnt[0].n) || 0,
    sumAmount: Number(sum[0].amount) || 0,
    page: pg, size: sz,
  };
}

/** 补货单详情：主表 + 明细 */
async function getOrder({ userId, id } = {}) {
  const oid = Number(id) || 0;
  if (!oid) return { ok: false, error: '缺少补货单 id' };
  const rows = await db.query(
    `SELECT o.*, DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i') AS created_at_f,
            DATE_FORMAT(o.linked_at, '%Y-%m-%d %H:%i') AS linked_at_f,
            DATE_FORMAT(w.bill_date, '%Y-%m-%d') AS waybill_date, w.amount AS waybill_cur_amount
       FROM replenish_order o
       LEFT JOIN waybill w ON w.id = o.waybill_id AND w.user_id = o.user_id AND w.deleted_at IS NULL
      WHERE o.id = ? AND o.user_id = ? AND o.deleted_at IS NULL`, [oid, userId]);
  if (!rows.length) return { ok: false, error: '补货单不存在' };
  const o = rows[0];
  const items = await db.query(
    `SELECT id, sku, goods_name, channel, channel_label, supplier_id, suggest_qty, spec_qty,
            qty_pack, unit_price, pack_price, amount
       FROM replenish_order_item WHERE order_id = ? AND user_id = ? ORDER BY amount DESC, id ASC`,
    [oid, userId]);
  const waybillAmount = Number(o.waybill_id) > 0
    ? (o.waybill_cur_amount == null ? (o.waybill_amount == null ? null : Number(o.waybill_amount)) : Number(o.waybill_cur_amount))
    : null;
  return {
    ok: true,
    order: {
      id: Number(o.id),
      supplierId: Number(o.supplier_id) || 0,
      supplierName: o.supplier_name || '',
      channel: o.channel || '',
      amount: Number(o.amount) || 0,
      itemCount: Number(o.item_count) || 0,
      qtyTotal: Number(o.qty_total) || 0,
      batchId: o.batch_id || '',
      waybillId: Number(o.waybill_id) || 0,
      waybillAmount,
      waybillDate: o.waybill_date || '',
      diff: waybillAmount == null ? null : round2(waybillAmount - (Number(o.amount) || 0)),
      createdBy: o.created_by || '',
      createdAt: o.created_at_f,
      linkedAt: o.linked_at_f || '',
    },
    items: items.map((r) => ({
      id: Number(r.id),
      sku: r.sku,
      goodsName: r.goods_name || '',
      channel: r.channel || '',
      channelLabel: r.channel_label || '',
      supplierId: Number(r.supplier_id) || 0,
      suggestQty: Number(r.suggest_qty) || 0,
      specQty: Number(r.spec_qty) || 1,
      qtyPack: Number(r.qty_pack) || 0,
      unitPrice: Number(r.unit_price) || 0,
      packPrice: r.pack_price == null ? null : Number(r.pack_price),
      amount: Number(r.amount) || 0,
    })),
  };
}

/** 关联弹窗用：该补货单所属供应商的全部货单（同供应商才让选，避免张冠李戴） */
async function waybillCandidates({ userId, orderId } = {}) {
  const oid = Number(orderId) || 0;
  if (!oid) return { ok: false, error: '缺少补货单 id' };
  const o = await db.query(
    'SELECT id, supplier_id, supplier_name, waybill_id, amount FROM replenish_order WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [oid, userId]);
  if (!o.length) return { ok: false, error: '补货单不存在' };
  const sid = Number(o[0].supplier_id) || 0;
  const args = [userId];
  let where = 'w.user_id = ? AND w.deleted_at IS NULL';
  if (sid > 0) { where += ' AND w.supplier_id = ?'; args.push(sid); }
  const rows = await db.query(
    `SELECT w.id, w.supplier_id, COALESCE(s.name, w.supplier_name) AS supplier_name, w.amount,
            DATE_FORMAT(w.bill_date, '%Y-%m-%d') AS bill_date,
            DATE_FORMAT(w.created_at, '%Y-%m-%d %H:%i') AS created_at,
            (SELECT COUNT(*) FROM waybill_image i WHERE i.waybill_id = w.id AND i.user_id = w.user_id) AS image_count
       FROM waybill w
       LEFT JOIN supplier s ON s.id = w.supplier_id AND s.user_id = w.user_id
      WHERE ${where}
      ORDER BY w.bill_date DESC, w.id DESC
      LIMIT 100`, args);
  return {
    ok: true,
    order: {
      id: Number(o[0].id), supplierId: sid, supplierName: o[0].supplier_name || '',
      amount: Number(o[0].amount) || 0, waybillId: Number(o[0].waybill_id) || 0,
    },
    rows: rows.map((r) => ({
      id: Number(r.id),
      supplierName: r.supplier_name || '',
      amount: Number(r.amount) || 0,
      billDate: r.bill_date || '',
      createdAt: r.created_at || '',
      imageCount: Number(r.image_count) || 0,
      diff: round2((Number(r.amount) || 0) - (Number(o[0].amount) || 0)),
    })),
  };
}

/** 关联 / 取消关联货单（waybillId=0 即取消）。只允许关联同一供应商的货单 */
async function linkWaybill({ userId, id, waybillId } = {}) {
  const oid = Number(id) || 0;
  const wid = Number(waybillId) || 0;
  if (!oid) return { ok: false, error: '缺少补货单 id' };
  const o = await db.query(
    'SELECT id, supplier_id, supplier_name, amount FROM replenish_order WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [oid, userId]);
  if (!o.length) return { ok: false, error: '补货单不存在' };
  if (!wid) {
    await db.exec(
      'UPDATE replenish_order SET waybill_id = 0, waybill_amount = NULL, linked_at = NULL WHERE id = ? AND user_id = ?',
      [oid, userId]);
    return { ok: true, id: oid, waybillId: 0, waybillAmount: null, diff: null };
  }
  const w = await db.query(
    `SELECT w.id, w.supplier_id, w.amount,
            COALESCE((SELECT s.name FROM supplier s WHERE s.id = w.supplier_id AND s.user_id = w.user_id),
                     w.supplier_name) AS supplier_name,
            DATE_FORMAT(w.bill_date, '%Y-%m-%d') AS bill_date
       FROM waybill w WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL`, [wid, userId]);
  if (!w.length) return { ok: false, error: '货单不存在或已删除' };
  const orderSid = Number(o[0].supplier_id) || 0;
  if (orderSid > 0 && Number(w[0].supplier_id) !== orderSid) {
    return { ok: false, error: '只能关联同一供应商的货单（该货单属于「' + (w[0].supplier_name || '其他供应商') + '」）' };
  }
  const amt = Number(w[0].amount) || 0;
  const diff = round2(amt - (Number(o[0].amount) || 0));
  await db.exec(
    'UPDATE replenish_order SET waybill_id = ?, waybill_amount = ?, linked_at = NOW() WHERE id = ? AND user_id = ?',
    [wid, amt.toFixed(2), oid, userId]);
  return {
    ok: true, id: oid, waybillId: wid, waybillAmount: amt,
    waybillDate: w[0].bill_date, diff, matched: Math.abs(diff) < 0.005,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 补货单编辑（v0.3.28）：生成后还能改——改行（数量/规格/单价）、删行、加行、换供应商。
//   金额一律服务端重算：行 = 补货数量 × 规格 × 单价，单头 = 各行之和；
//   与货单的对账差额由 getOrder/listOrders 现算，改完自动跟着变（货单本身不动）。
// ─────────────────────────────────────────────────────────────────────────
const CHANNEL_LABEL = { qht: '齐货通', afa: '永源顺', jd: '京东万商', local: '本地价' };

/** 单头汇总回写（行数 / 件数 / 金额），任何明细变动后都要调一次 */
async function recalcOrder(userId, orderId) {
  const rows = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS amount,
            COUNT(*) AS n,
            COALESCE(SUM(qty_pack), 0) AS qty
       FROM replenish_order_item WHERE order_id = ? AND user_id = ?`,
    [orderId, userId]);
  const r = rows[0] || {};
  const amount = round2(Number(r.amount) || 0);
  const itemCount = Number(r.n) || 0;
  const qtyTotal = Number(r.qty) || 0;
  await db.exec(
    'UPDATE replenish_order SET amount = ?, item_count = ?, qty_total = ? WHERE id = ? AND user_id = ?',
    [amount.toFixed(2), itemCount, qtyTotal, orderId, userId]);
  return { amount, itemCount, qtyTotal };
}

/** 明细行的金额折算：与 calcReplenishLine 同一口径，但「补货数量(件)」是直接给的，不由建议量推 */
function lineOf({ qtyPack, specQty, unitPrice }) {
  const q = Math.trunc(Number(qtyPack));
  if (!Number.isFinite(q) || q < 1) return { ok: false, error: '补货数量必须 ≥ 1 件' };
  if (q > 999999) return { ok: false, error: '补货数量过大' };
  let spec = Number(specQty);
  if (!Number.isFinite(spec) || spec <= 0) spec = 1;
  const unit = Number(unitPrice);
  if (!Number.isFinite(unit) || unit < 0) return { ok: false, error: '单价应为非负数字' };
  const packPrice = round2(unit * spec);
  const amount = round2(q * spec * unit);
  return { ok: true, qtyPack: q, specQty: round2(spec), unitPrice: unit, packPrice, amount };
}

/**
 * 保存一行（itemId 为空 = 新增，有值 = 改这一行）。
 * @param {{userId:number, orderId:any, itemId?:any, sku?:string, goodsName?:string,
 *          channel?:string, qtyPack:any, specQty:any, unitPrice:any, suggestQty?:any}} o
 * @returns {Promise<{ok:true, itemId:number, order:object, items:Array}|{ok:false,error:string}>}
 */
async function saveItem(o = {}) {
  const userId = Number(o.userId) || 0;
  const orderId = Number(o.orderId) || 0;
  if (!orderId) return { ok: false, error: '缺少补货单 id' };
  const ord = await db.query(
    'SELECT id, supplier_id, waybill_id FROM replenish_order WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [orderId, userId]);
  if (!ord.length) return { ok: false, error: '补货单不存在或已删除' };
  const line = lineOf({ qtyPack: o.qtyPack, specQty: o.specQty, unitPrice: o.unitPrice });
  if (!line.ok) return { ok: false, error: line.error };

  const itemId = Number(o.itemId) || 0;
  const ch = CHANNELS.includes(String(o.channel || '')) ? String(o.channel) : 'qht';
  // 建议量的语义是「这个 SKU 想补多少基础单位」；手填件数时按 件数 × 规格 回写，复核时仍能自洽
  const sug = Number.isFinite(Number(o.suggestQty)) && o.suggestQty !== '' && o.suggestQty != null
    ? round2(Number(o.suggestQty)) : round2(line.qtyPack * line.specQty);

  if (itemId > 0) {
    const ex = await db.query(
      'SELECT id FROM replenish_order_item WHERE id = ? AND order_id = ? AND user_id = ?',
      [itemId, orderId, userId]);
    if (!ex.length) return { ok: false, error: '明细行不存在（可能刚被删掉，刷新再看）' };
    await db.exec(
      `UPDATE replenish_order_item
          SET qty_pack = ?, spec_qty = ?, unit_price = ?, pack_price = ?, amount = ?, suggest_qty = ?
        WHERE id = ? AND order_id = ? AND user_id = ?`,
      [line.qtyPack, line.specQty.toFixed(2), line.unitPrice.toFixed(4),
        line.packPrice.toFixed(2), line.amount.toFixed(2), sug.toFixed(2),
        itemId, orderId, userId]);
  } else {
    const sku = str(o.sku, 64);
    if (!sku) return { ok: false, error: '新增一行需要商品SKU' };
    const dup = await db.query(
      'SELECT id FROM replenish_order_item WHERE order_id = ? AND user_id = ? AND sku = ? LIMIT 1',
      [orderId, userId, sku]);
    if (dup.length) return { ok: false, error: '这张单里已经有这个 SKU 了，直接改那一行的数量就行' };
    const r = await db.exec(
      `INSERT INTO replenish_order_item
         (order_id, user_id, sku, goods_name, channel, channel_label, supplier_id,
          suggest_qty, spec_qty, qty_pack, unit_price, pack_price, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, userId, sku, str(o.goodsName, 512), ch, str(o.channelLabel, 32) || CHANNEL_LABEL[ch] || ch,
        Number(ord[0].supplier_id) || 0, sug.toFixed(2), line.specQty.toFixed(2), line.qtyPack,
        line.unitPrice.toFixed(4), line.packPrice.toFixed(2), line.amount.toFixed(2)]);
    o.itemId = Number(r.insertId) || 0;
  }

  await recalcOrder(userId, orderId);
  const fresh = await getOrder({ userId, id: orderId });
  return { ok: true, itemId: Number(o.itemId) || itemId, order: fresh.order, items: fresh.items };
}

/** 删一行；删空了整张单也保留（金额归零），要不要删单由人决定 */
async function deleteItem({ userId, orderId, itemId } = {}) {
  const uid = Number(userId) || 0;
  const oid = Number(orderId) || 0;
  const iid = Number(itemId) || 0;
  if (!oid || !iid) return { ok: false, error: '缺少补货单或明细行 id' };
  const ex = await db.query(
    'SELECT o.id FROM replenish_order o WHERE o.id = ? AND o.user_id = ? AND o.deleted_at IS NULL', [oid, uid]);
  if (!ex.length) return { ok: false, error: '补货单不存在或已删除' };
  const r = await db.exec(
    'DELETE FROM replenish_order_item WHERE id = ? AND order_id = ? AND user_id = ?', [iid, oid, uid]);
  if (!(r.affectedRows > 0)) return { ok: false, error: '明细行不存在（可能刚被删掉，刷新再看）' };
  await recalcOrder(uid, oid);
  const fresh = await getOrder({ userId: uid, id: oid });
  return { ok: true, order: fresh.order, items: fresh.items };
}

/**
 * 换供应商（单头）。已关联货单时不允许：货单是某家供应商的，改了就张冠李戴。
 * supplierId 有值 → 用台账里的名字；只有名字 → 台账里没有就自动建一条（与生成时同规则）。
 */
async function setSupplier({ userId, id, supplierId, supplierName, operator } = {}) {
  const uid = Number(userId) || 0;
  const oid = Number(id) || 0;
  if (!oid) return { ok: false, error: '缺少补货单 id' };
  const rows = await db.query(
    'SELECT id, waybill_id FROM replenish_order WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [oid, uid]);
  if (!rows.length) return { ok: false, error: '补货单不存在或已删除' };
  if (Number(rows[0].waybill_id) > 0) {
    return { ok: false, error: '这张单已关联货单，换供应商会跟货单对不上；先「取消关联」再改' };
  }
  let sid = Number(supplierId) || 0;
  let name = str(supplierName, 64);
  if (sid > 0) {
    const sp = await db.query('SELECT id, name FROM supplier WHERE id = ? AND user_id = ?', [sid, uid]);
    if (!sp.length) return { ok: false, error: '供应商不存在（可能已被删除），请重新选择' };
    sid = Number(sp[0].id);
    name = sp[0].name;
  } else if (name) {
    sid = await ensureSupplier(uid, name, operator);
  } else {
    return { ok: false, error: '请选择供应商' };
  }
  await db.exec(
    'UPDATE replenish_order SET supplier_id = ?, supplier_name = ? WHERE id = ? AND user_id = ?',
    [sid, name, oid, uid]);
  // 明细行上的 supplier_id 一起改，否则按行归集的地方会不一致
  await db.exec(
    'UPDATE replenish_order_item SET supplier_id = ? WHERE order_id = ? AND user_id = ?', [sid, oid, uid]);
  const fresh = await getOrder({ userId: uid, id: oid });
  return { ok: true, order: fresh.order, items: fresh.items };
}

/** 补货单里「加一行」用的商品搜索：按账号所属品牌方商品库模糊搜（名称 / SKU） */
async function searchProducts({ brandId, keyword, limit } = {}) {
  const kw = str(keyword, 64);
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const bid = Number(brandId) || 0;
  const where = ['1=1'];
  const args = [];
  if (bid > 0) { where.push('brand_id = ?'); args.push(bid); }
  if (kw) { where.push('(sku LIKE ? OR goods_name LIKE ?)'); args.push(`%${kw}%`, `%${kw}%`); }
  const rows = await db.query(
    `SELECT brand_id, sku, goods_name, image_url, purchase_price, local_price, local_pack_price, local_spec_qty
       FROM brand_product WHERE ${where.join(' AND ')}
      ORDER BY (sku = ?) DESC, updated_at DESC, id DESC LIMIT ${n}`,
    [...args, kw]).catch(() => []);
  return {
    ok: true,
    rows: rows.map((r) => ({
      brandId: Number(r.brand_id) || 0,
      sku: String(r.sku || ''),
      goodsName: r.goods_name || '',
      imageUrl: r.image_url || '',
      purchasePrice: r.purchase_price == null ? null : Number(r.purchase_price),
      localPrice: r.local_price == null ? null : Number(r.local_price),
      localPackPrice: r.local_pack_price == null ? null : Number(r.local_pack_price),
      localSpecQty: r.local_spec_qty == null ? null : Number(r.local_spec_qty),
    })),
  };
}

/** 删除补货单（软删除：打标记，明细留着可追溯） */
async function deleteOrder({ userId, id } = {}) {
  const oid = Number(id) || 0;
  if (!oid) return { ok: false, error: '缺少补货单 id' };
  const r = await db.exec(
    'UPDATE replenish_order SET deleted_at = NOW() WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [oid, userId]);
  if (!(r.affectedRows > 0)) return { ok: false, error: '补货单不存在或已删除' };
  return { ok: true, id: oid };
}

module.exports = {
  CHANNELS, CHANNEL_LABEL, supplierIndex, ensureSupplier, createOrders,
  listOrders, getOrder, waybillCandidates, linkWaybill, deleteOrder,
  saveItem, deleteItem, setSupplier, searchProducts, recalcOrder, lineOf,
};
