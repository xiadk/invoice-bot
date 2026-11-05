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
const qht = require('./qht');
const afa = require('./afa');
const priceCache = require('./price-cache');
const productPrice = require('./product-price');

const CHANNELS = ['qht', 'afa', 'jd', 'local'];
/** 已关联货单的补货单只能看（v0.3.33）：货单是外部依据，改明细就永远对不上账 */
const LINKED_READONLY = '这张补货单已关联货单，只能查看；要改先点「取消关联」';
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

/**
 * 补货单详情（主表 + 明细）。
 * ⚠ v0.3.35：明细多带两个东西给页面用
 *   · availStock —— 「实时库存」列的数据源。**用户口径：不去平台查，读库里的库存**
 *     （brand_product.available_stock 商品同步来的可用库存，取不到再退个人导入的 product_item）。
 *     0 表示确实没货，NULL 只表示「库里没有这个 SKU 的库存数据」，两者必须区分，
 *     否则没同步过的商品会被误标成无货。
 *   · qhtGoodsId / afaGoodsId —— 换供应商发现没价时，判断是「没关联平台商品」还是「关联了但取不到价」。
 */
async function getOrder({ userId, id, brandId } = {}) {
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
  // brandId=0（超管看全部品牌）时不限品牌，同 SKU 多品牌取库存最大的那一行
  const bid = Number(brandId) || 0;
  const bpWhere = bid > 0 ? 'brand_id = ? AND ' : '';
  const bpArgs = bid > 0 ? [bid] : [];
  const items = await db.query(
    `SELECT i.id, i.sku, i.goods_name, i.channel, i.channel_label, i.supplier_id, i.suggest_qty, i.spec_qty,
            i.qty_pack, i.unit_price, i.pack_price, i.amount,
            bp.avail_stock AS bp_stock, pi.avail_stock AS pi_stock,
            bp.qht_goods_id, bp.afa_goods_id
       FROM replenish_order_item i
       LEFT JOIN (
            SELECT sku, MAX(available_stock) AS avail_stock,
                   MAX(qht_goods_id) AS qht_goods_id, MAX(afa_goods_id) AS afa_goods_id
              FROM brand_product WHERE ${bpWhere}1=1 GROUP BY sku
       ) bp ON bp.sku = i.sku
       LEFT JOIN (
            SELECT sku, MAX(available_stock) AS avail_stock
              FROM product_item WHERE user_id = ? GROUP BY sku
       ) pi ON pi.sku = i.sku
      WHERE i.order_id = ? AND i.user_id = ?
      ORDER BY i.amount DESC, i.id ASC`,
    [...bpArgs, Number(userId) || 0, oid, userId]);
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
    items: items.map((r) => {
      // 品牌行优先、个人导入兜底（与补货页列表同一口径：bp.available_stock → pi.available_stock）
      const bpStock = r.bp_stock == null ? null : Number(r.bp_stock);
      const piStock = r.pi_stock == null ? null : Number(r.pi_stock);
      const avail = bpStock != null ? bpStock : piStock;
      return {
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
        availStock: avail,
        // 有库存数据且 <=0 才算无货；null = 库里没这个 SKU 的库存记录，不能当无货
        noStock: avail != null && avail <= 0,
        qhtGoodsId: String(r.qht_goods_id || ''),
        afaGoodsId: String(r.afa_goods_id || ''),
      };
    }),
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
  const unitRaw = Number(unitPrice);
  if (!Number.isFinite(unitRaw) || unitRaw < 0) return { ok: false, error: '单价应为非负数字' };
  // 库里是 DECIMAL(12,4)：先按 4 位四舍五入，避免 6 位小数被 MySQL 静默截断导致行总额对不上
  const unit = Math.round((unitRaw + Number.EPSILON) * 10000) / 10000;
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
  if (Number(ord[0].waybill_id) > 0) return { ok: false, error: LINKED_READONLY };
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
  const fresh = await getOrder({ userId, id: orderId, brandId: o.brandId });
  return { ok: true, itemId: Number(o.itemId) || itemId, order: fresh.order, items: fresh.items };
}

/** 删一行；删空了整张单也保留（金额归零），要不要删单由人决定 */
async function deleteItem({ userId, orderId, itemId, brandId } = {}) {
  const uid = Number(userId) || 0;
  const oid = Number(orderId) || 0;
  const iid = Number(itemId) || 0;
  if (!oid || !iid) return { ok: false, error: '缺少补货单或明细行 id' };
  const ex = await db.query(
    'SELECT id, waybill_id FROM replenish_order WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [oid, uid]);
  if (!ex.length) return { ok: false, error: '补货单不存在或已删除' };
  if (Number(ex[0].waybill_id) > 0) return { ok: false, error: LINKED_READONLY };
  const r = await db.exec(
    'DELETE FROM replenish_order_item WHERE id = ? AND order_id = ? AND user_id = ?', [iid, oid, uid]);
  if (!(r.affectedRows > 0)) return { ok: false, error: '明细行不存在（可能刚被删掉，刷新再看）' };
  await recalcOrder(uid, oid);
  const fresh = await getOrder({ userId: uid, id: oid, brandId: o.brandId });
  return { ok: true, order: fresh.order, items: fresh.items };
}

// ─────────────────────────────────────────────────────────────────────────
// 换供应商（v0.3.33 起是行级；v0.3.35 起「目标供应商必须有价」才允许搬）
//   用户口径（2026-11-04）：
//     · 搬之前先查目标供应商有没有这个商品的价格，没有 = 供应商无货，不许搬
//     · 搬到齐货通/永源顺却没价 → 要能就地弹「关联平台商品」，关联后拿到价再搬；
//       搜不到 → 无法迁移
//     · 搬过去按**目标供应商的价**重算并显示
//     · 数量：建议量不变，按目标渠道规格重算件数（与生成补货单同一算法），
//       用户确认过「规格不同时件数会变，总基础单位不变」
//     · 京东万商 / 自有本地价供应商**不校验**，照旧整行搬（用户口径）
//   目标单：同账号 + 该供应商 + 未删除 + 未关联，优先同批次、否则最新一张；没有就新建。
//   目标单已有同 SKU → 数量累加，并按目标价重算那一行。源单被搬空 → 软删。
// ─────────────────────────────────────────────────────────────────────────

/** 供应商名 → 平台渠道（只有齐货通/永源顺参与换供应商的取价校验） */
const SUPPLIER_PLATFORMS = [
  { kind: 'qht', label: '齐货通', hints: ['齐货通'] },
  { kind: 'afa', label: '永源顺', hints: ['永源顺', '城配速达', '阿发'] },
];
function platformKindOf(supplierName) {
  const nm = String(supplierName || '');
  const hit = SUPPLIER_PLATFORMS.find((s) => s.hints.some((h) => nm.includes(h)));
  return hit ? hit.kind : '';
}
const platformLabelOf = (kind) => (SUPPLIER_PLATFORMS.find((s) => s.kind === kind) || {}).label || '';

/** SKU → 平台商品 ID（品牌行优先、个人行兜底；brandId=0 时不限品牌） */
async function goodsIdOf({ userId, brandId, sku, kind } = {}) {
  const col = kind === 'afa' ? 'afa_goods_id' : 'qht_goods_id';
  const bid = Number(brandId) || 0;
  const s = str(sku, 64);
  if (!s) return '';
  const bp = bid > 0
    ? await db.query(
      `SELECT ${col} AS gid FROM brand_product
        WHERE brand_id = ? AND sku = ? AND ${col} IS NOT NULL AND ${col} <> '' LIMIT 1`, [bid, s]).catch(() => [])
    : await db.query(
      `SELECT ${col} AS gid FROM brand_product
        WHERE sku = ? AND ${col} IS NOT NULL AND ${col} <> '' LIMIT 1`, [s]).catch(() => []);
  let gid = bp.length ? String(bp[0].gid || '').trim() : '';
  if (!gid) {
    const pi = await db.query(
      `SELECT ${col} AS gid FROM product_item
        WHERE user_id = ? AND sku = ? AND ${col} IS NOT NULL AND ${col} <> '' LIMIT 1`,
      [Number(userId) || 0, s]).catch(() => []);
    gid = pi.length ? String(pi[0].gid || '').trim() : '';
  }
  return gid;
}

/**
 * 取某个平台渠道给这个 SKU 的价（换供应商/预检用）。
 * 优先级：手工价（只有齐货通有）→ 价格缓存 → 实时取价一次。
 * @returns {Promise<{ok:boolean, kind:string, source?:string, goodsId?:string,
 *                    unitPrice?:number, specQty?:number, packPrice?:number,
 *                    needLink?:boolean, error?:string}>}
 */
async function platformPriceOf({ userId, brandId, sku, kind } = {}) {
  const uid = Number(userId) || 0;
  const bid = Number(brandId) || 0;
  const label = platformLabelOf(kind);
  const gid = await goodsIdOf({ userId: uid, brandId: bid, sku, kind });

  // 手工价优先级最高（与比价同口径）：人工填过就以它为准
  if (kind === 'qht' && bid > 0) {
    const man = await productPrice.readManual({ brandId: bid, skus: [sku], kind: 'qht' }).catch(() => ({}));
    const m = man[`${bid}:${str(sku, 64)}`];
    if (m && Number(m.unitPrice) > 0) {
      return {
        ok: true, kind, source: 'manual', goodsId: gid,
        unitPrice: Number(m.unitPrice),
        specQty: Number(m.packingSpecification) || 0,
        packPrice: m.saleIP == null ? null : Number(m.saleIP),
      };
    }
  }
  if (!gid) {
    return { ok: false, kind, needLink: true, goodsId: '', error: `${label}还没关联这个商品，关联上才有价` };
  }

  let p = null;
  const cached = await priceCache.readPrices(kind, bid, [gid]).catch(() => ({}));
  if (cached[gid]) p = cached[gid];

  // 缓存里没价（或价是空的）→ 实时打一次平台；失败不抛，交给下面统一报错
  if (!p || !(Number(p.unitPrice) > 0)) {
    const mod = kind === 'afa' ? afa : qht;
    let liveErr = '';
    const live = await mod.pricesByGoodsIds(uid, [gid], { brandId: bid, mode: 'refresh' })
      .catch((e) => { liveErr = String((e && e.message) || e).slice(0, 120); return null; });
    const v = live && live.prices && live.prices[gid];
    if (v && v.ok) p = v;
    else if (!p) {
      return {
        ok: false, kind, goodsId: gid, needLink: false,
        error: `${label}取不到这个商品的价格${liveErr ? '（' + liveErr + '）' : '（可能已下架或无货）'}`,
      };
    }
  }

  const unitPrice = Number(p.unitPrice);
  const specQty = kind === 'afa' ? Number(p.unitFactor) : Number(p.packingSpecification);
  const packPrice = kind === 'afa' ? Number(p.salePrice) : Number(p.saleIP);
  if (!(unitPrice > 0)) {
    return { ok: false, kind, goodsId: gid, needLink: false, error: `${label}这个商品没有有效价格（可能已下架或无货）` };
  }
  return {
    ok: true, kind, source: p.cached ? 'cache' : 'live', goodsId: gid,
    unitPrice, specQty: Number(specQty) || 0, packPrice: Number.isFinite(packPrice) ? packPrice : null,
  };
}

/** 源单 + 明细行 + 目标供应商的公共校验（预检与真搬共用，保证两边判定一致） */
async function loadMoveContext({ userId, orderId, itemId, supplierId }) {
  const uid = Number(userId) || 0;
  const oid = Number(orderId) || 0;
  const iid = Number(itemId) || 0;
  const sid = Number(supplierId) || 0;
  if (!oid || !iid) return { ok: false, error: '缺少补货单或明细行 id' };
  if (!sid) return { ok: false, error: '请选择目标供应商' };

  const src = await db.query(
    'SELECT id, supplier_id, supplier_name, batch_id, waybill_id FROM replenish_order WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [oid, uid]);
  if (!src.length) return { ok: false, error: '补货单不存在或已删除' };
  const s = src[0];
  if (Number(s.waybill_id) > 0) return { ok: false, error: LINKED_READONLY };
  if (Number(s.supplier_id) === sid) return { ok: false, error: '这行已经属于该供应商了，请选别的供应商' };

  const sp = await db.query('SELECT id, name FROM supplier WHERE id = ? AND user_id = ?', [sid, uid]);
  if (!sp.length) return { ok: false, error: '供应商不存在（可能已被删除），请重新选择' };

  const itemRows = await db.query(
    `SELECT id, sku, goods_name, channel, channel_label, qty_pack, spec_qty, unit_price, pack_price, amount, suggest_qty
       FROM replenish_order_item WHERE id = ? AND order_id = ? AND user_id = ?`, [iid, oid, uid]);
  if (!itemRows.length) return { ok: false, error: '明细行不存在（可能刚被删掉，刷新再看）' };
  return { ok: true, uid, oid, iid, sid, src: s, targetName: sp[0].name, it: itemRows[0] };
}

/**
 * 预检：把「搬过去之后长什么样」算给页面看（选完供应商立刻调）。
 * 平台供应商无价时返回 ok:false + needLink（齐货通/永源顺没关联商品时可弹关联窗）。
 */
async function checkItemMove({ userId, brandId, orderId, itemId, supplierId } = {}) {
  const ctx = await loadMoveContext({ userId, orderId, itemId, supplierId });
  if (!ctx.ok) return ctx;
  const { it, targetName, sid } = ctx;
  const kind = platformKindOf(targetName);
  // 建议量是「这个 SKU 想补多少基础单位」；搬过去仍按这个需求算，只是换成目标渠道的规格
  const suggest = Number(it.suggest_qty) > 0
    ? Number(it.suggest_qty) : round2((Number(it.qty_pack) || 0) * (Number(it.spec_qty) || 1));
  const from = {
    qtyPack: Number(it.qty_pack) || 0,
    specQty: Number(it.spec_qty) || 1,
    unitPrice: Number(it.unit_price) || 0,
    amount: Number(it.amount) || 0,
  };

  // 非平台供应商（京东万商 / 自有 / 本地价）：用户口径「不校验，照旧搬」
  if (!kind) {
    return {
      ok: true, platform: false, kind: '', supplierId: sid, supplierName: targetName,
      suggestQty: round2(suggest), unitPrice: from.unitPrice, specQty: from.specQty,
      qtyPack: from.qtyPack, amount: from.amount, source: '', note: '该供应商不校验价格，按原行价格搬',
      from,
    };
  }

  const pr = await platformPriceOf({ userId: ctx.uid, brandId, sku: it.sku, kind });
  if (!pr.ok) {
    return {
      ok: false, platform: true, kind, supplierId: sid, supplierName: targetName,
      sku: it.sku, goodsName: it.goods_name || '',
      // linkKind 给前端决定弹哪家的关联窗（qht=齐货通 / afa=永源顺）
      needLink: !!pr.needLink, linkKind: kind, goodsId: pr.goodsId || '',
      error: pr.error || '该供应商没有此商品的价格（无货），不能迁移',
      from,
    };
  }
  const spec = pr.specQty > 0 ? pr.specQty : 1;
  const qtyPack = Math.max(1, Math.ceil(suggest / spec));
  const line = lineOf({ qtyPack, specQty: spec, unitPrice: pr.unitPrice });
  if (!line.ok) return { ok: false, error: line.error };
  return {
    ok: true, platform: true, kind, supplierId: sid, supplierName: targetName,
    source: pr.source, goodsId: pr.goodsId || '',
    suggestQty: round2(suggest),
    unitPrice: line.unitPrice, specQty: line.specQty, qtyPack: line.qtyPack,
    packPrice: line.packPrice, amount: line.amount,
    from,
  };
}

async function moveItemToSupplier({ userId, brandId, orderId, itemId, supplierId, operator } = {}) {
  // 先按预检同一套逻辑算一遍（页面那边可能被绕过，服务端必须自己再拦一次）
  const plan = await checkItemMove({ userId, brandId, orderId, itemId, supplierId });
  if (!plan.ok) return plan;
  const ctx = await loadMoveContext({ userId, orderId, itemId, supplierId });
  if (!ctx.ok) return ctx;
  const { uid, oid, iid, sid, src: s, targetName, it } = ctx;

  // 价源跟着目标供应商走：否则行上还标着「齐货通」，价却是永源顺的
  const newChannel = plan.platform ? plan.kind : String(it.channel || '');
  const newLabel = plan.platform ? platformLabelOf(plan.kind) : String(it.channel_label || '');
  const newSpec = (Number(plan.specQty) || 1).toFixed(2);
  const newQty = Math.trunc(Number(plan.qtyPack) || 0);
  const newUnit = (Number(plan.unitPrice) || 0).toFixed(4);
  const newPack = plan.packPrice == null ? null : Number(plan.packPrice).toFixed(2);
  const newAmount = (Number(plan.amount) || 0).toFixed(2);

  // 目标单：优先同批次，没有再放宽到该供应商任意一张未关联单
  const base = 'SELECT id FROM replenish_order WHERE user_id = ? AND supplier_id = ? AND deleted_at IS NULL AND waybill_id = 0';
  let t = [];
  if (s.batch_id) {
    t = await db.query(`${base} AND batch_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [uid, sid, s.batch_id]);
  }
  if (!t.length) {
    t = await db.query(`${base} ORDER BY created_at DESC, id DESC LIMIT 1`, [uid, sid]);
  }

  const moved = await db.transaction(async (conn) => {
    let targetId = t.length ? Number(t[0].id) : 0;
    if (!targetId) {
      const [r] = await conn.query(
        `INSERT INTO replenish_order
           (user_id, supplier_id, supplier_name, channel, amount, item_count, qty_total, batch_id, created_by)
         VALUES (?, ?, ?, ?, 0.00, 0, 0, ?, ?)`,
        [uid, sid, targetName, newChannel, s.batch_id || null, str(operator, 64) || null]);
      targetId = Number(r.insertId);
    }
    // ⚠ conn.query 返回 [rows, fields]，别直接当 rows 用
    const [dup] = await conn.query(
      'SELECT id, qty_pack FROM replenish_order_item WHERE order_id = ? AND user_id = ? AND sku = ? LIMIT 1',
      [targetId, uid, it.sku]);
    let merged = false;
    if (dup.length) {
      // 目标单已有同 SKU：数量累加，规格/单价一律换成目标供应商这次的（否则两行价凑一行会互相打架）
      merged = true;
      const q = Math.trunc(Number(dup[0].qty_pack) || 0) + newQty;
      const line = lineOf({ qtyPack: q, specQty: plan.specQty, unitPrice: plan.unitPrice });
      if (!line.ok) throw new Error(line.error);
      await conn.query(
        `UPDATE replenish_order_item
            SET qty_pack = ?, spec_qty = ?, unit_price = ?, pack_price = ?, amount = ?, suggest_qty = ?,
                channel = ?, channel_label = ?, supplier_id = ?
          WHERE id = ? AND order_id = ? AND user_id = ?`,
        [line.qtyPack, line.specQty.toFixed(2), line.unitPrice.toFixed(4),
          line.packPrice.toFixed(2), line.amount.toFixed(2), round2(line.qtyPack * line.specQty).toFixed(2),
          newChannel, newLabel, sid, Number(dup[0].id), targetId, uid]);
      await conn.query(
        'DELETE FROM replenish_order_item WHERE id = ? AND order_id = ? AND user_id = ?', [iid, oid, uid]);
    } else {
      // 整行搬过去：归属 + 价源 + 按目标供应商价重算的三件套一起改
      await conn.query(
        `UPDATE replenish_order_item
            SET order_id = ?, supplier_id = ?, channel = ?, channel_label = ?,
                spec_qty = ?, qty_pack = ?, unit_price = ?, pack_price = ?, amount = ?, suggest_qty = ?
          WHERE id = ? AND order_id = ? AND user_id = ?`,
        [targetId, sid, newChannel, newLabel, newSpec, newQty, newUnit,
          newPack, newAmount, round2(newQty * (Number(plan.specQty) || 1)).toFixed(2), iid, oid, uid]);
    }
    return { targetId, merged };
  });

  const target = await recalcOrder(uid, moved.targetId);
  const rest = await db.query(
    'SELECT COUNT(*) AS n FROM replenish_order_item WHERE order_id = ? AND user_id = ?', [oid, uid]);
  const emptySource = !(Number(rest[0] && rest[0].n) > 0);
  if (emptySource) {
    await db.exec(
      'UPDATE replenish_order SET deleted_at = NOW() WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [oid, uid]);
  } else {
    await recalcOrder(uid, oid);
  }

  const fresh = await getOrder({ userId: uid, id: oid, brandId });
  return {
    ok: true,
    targetOrderId: moved.targetId,
    targetSupplierName: targetName,
    targetAmount: target.amount,
    merged: moved.merged,
    sourceDeleted: emptySource,
    moved: {
      qtyPack: newQty, specQty: Number(plan.specQty) || 1, unitPrice: Number(plan.unitPrice) || 0,
      amount: Number(plan.amount) || 0, channel: newChannel, channelLabel: newLabel,
      fromQtyPack: Number(it.qty_pack) || 0, fromUnitPrice: Number(it.unit_price) || 0,
    },
    order: fresh.ok ? fresh.order : null,
    items: fresh.ok ? fresh.items : [],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 一键加购（v0.3.33）：供应商是齐货通 / 永源顺的补货单，把整单明细按「补货数量(件)」
//   加进用户自己的平台购物车。数量口径与平台一致：齐货通 ipcnt、永源顺 quantity+P2(件)。
//   · 平台商品 ID 现查（brand_product 品牌共享 → product_item 个人兜底），同一 SKU 多个
//     命中时优先本账号品牌
//   · 逐行调用，单行失败不影响其它行；未登录（no_session/auth）单独标记 needLogin
// ─────────────────────────────────────────────────────────────────────────
const CART_SUPPLIERS = [
  { kind: 'qht', label: '齐货通', hints: ['齐货通'] },
  { kind: 'afa', label: '永源顺', hints: ['永源顺', '城配速达', '阿发'] },
];
const CART_MAX = 50;

/** 供应商名 → 加购渠道（不是这两家返回空）；判定与换供应商取价共用 platformKindOf */
function cartKindOf(order) {
  return platformKindOf(order && order.supplierName);
}

/**
 * SKU → 平台商品ID（只查一个渠道）。品牌行优先，个人行兜底；同 SKU 多个时优先本账号品牌。
 * brandId=0 表示不限定品牌（超管全部品牌），取第一个命中。
 */
async function resolveGoodsIds({ userId, brandId, kind, skus } = {}) {
  const col = kind === 'afa' ? 'afa_goods_id' : 'qht_goods_id';
  const list = [...new Set((skus || []).map((s) => String(s || '').trim()).filter(Boolean))];
  const out = {};
  if (!list.length) return out;
  const ph = list.map(() => '?').join(',');
  const [brandRows, ownRows] = await Promise.all([
    db.query(
      `SELECT sku, brand_id, ${col} AS gid FROM brand_product
        WHERE sku IN (${ph}) AND ${col} IS NOT NULL AND ${col} <> ''`, list).catch(() => []),
    db.query(
      `SELECT sku, brand_id, ${col} AS gid FROM product_item
        WHERE user_id = ? AND sku IN (${ph}) AND ${col} IS NOT NULL AND ${col} <> ''`, [Number(userId) || 0, ...list]).catch(() => []),
  ]);
  const picked = {};
  const put = (r) => {
    const gid = String((r && r.gid) || '').trim();
    if (!gid) return;
    const sku = String(r.sku || '');
    const own = Number(r.brand_id) === Number(brandId);
    if (!picked[sku] || (!picked[sku].own && own)) picked[sku] = { gid, own };
  };
  brandRows.forEach(put);
  ownRows.forEach(put);
  for (const k of Object.keys(picked)) out[k] = picked[k].gid;
  return out;
}

/**
 * 一键加购：整单明细按补货数量加进用户自己的平台购物车。
 * @returns {{ok:boolean, supplier?:string, kind?:string, total?:number, added?:number,
 *            qtyTotal?:number, skipped?:Array, failed?:Array, needLogin?:boolean, error?:string}}
 */
async function addOrderToCart({ userId, orderId, brandId, operator } = {}) {
  const uid = Number(userId) || 0;
  const detail = await getOrder({ userId: uid, id: orderId, brandId });
  if (!detail.ok) return detail;
  const order = detail.order;
  const kind = cartKindOf(order);
  if (!kind) {
    return {
      ok: false,
      error: `这张单的供应商是「${order.supplierName || '未指定'}」，只有齐货通 / 永源顺的补货单能一键加购`,
    };
  }
  const label = CART_SUPPLIERS.find((s) => s.kind === kind).label;

  const rows = (detail.items || []).filter((it) => Math.trunc(Number(it.qtyPack)) > 0);
  if (!rows.length) return { ok: false, kind, supplier: label, error: '这张单没有可加购的明细（补货数量都是 0）' };
  if (rows.length > CART_MAX) {
    return { ok: false, kind, supplier: label, error: `一次最多加购 ${CART_MAX} 个商品（本单 ${rows.length} 个），请拆成两张单` };
  }

  const ids = await resolveGoodsIds({ userId: uid, brandId, kind, skus: rows.map((r) => r.sku) });
  const skipped = [];
  const todo = [];
  for (const it of rows) {
    const gid = ids[it.sku];
    if (!gid) { skipped.push({ sku: it.sku, goodsName: it.goodsName, reason: `未关联${label}商品` }); continue; }
    todo.push({ sku: it.sku, goodsName: it.goodsName, goodsId: gid, qty: Math.trunc(Number(it.qtyPack)) });
  }
  if (!todo.length) {
    return {
      ok: false, kind, supplier: label, skipped,
      error: `本单没有已关联${label}商品的明细，先到「补货」页把商品关联上再试`,
    };
  }

  const added = [];
  const failed = [];
  let needLogin = false;
  let loginError = '';
  const queue = todo.slice();
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try {
        if (kind === 'qht') await qht.addToCart(uid, { goodsId: it.goodsId, ipcnt: it.qty });
        else await afa.addToCart(uid, { goodsId: it.goodsId, qty: it.qty });
        added.push(it);
      } catch (e) {
        const code = String((e && e.code) || '');
        const msg = String((e && e.message) || e).slice(0, 160);
        if (code === 'no_session' || code === 'auth') {
          needLogin = true;
          if (!loginError) loginError = msg;
        } else {
          failed.push({ sku: it.sku, goodsName: it.goodsName, qty: it.qty, error: msg });
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  return {
    ok: added.length > 0,
    kind,
    supplier: label,
    total: todo.length,
    added: added.length,
    qtyTotal: added.reduce((s, it) => s + it.qty, 0),
    skipped,
    failed,
    needLogin,
    error: needLogin
      ? (loginError || `${label}未登录或登录态已失效`)
      : (added.length ? '' : '加购全部失败，稍后重试或到补货页重新登录'),
  };
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

/** 删除补货单（软删除：打标记，明细留着可追溯）；已关联货单的只能看 */
async function deleteOrder({ userId, id } = {}) {
  const oid = Number(id) || 0;
  if (!oid) return { ok: false, error: '缺少补货单 id' };
  const rows = await db.query(
    'SELECT id, waybill_id FROM replenish_order WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [oid, userId]);
  if (!rows.length) return { ok: false, error: '补货单不存在或已删除' };
  if (Number(rows[0].waybill_id) > 0) return { ok: false, error: LINKED_READONLY };
  const r = await db.exec(
    'UPDATE replenish_order SET deleted_at = NOW() WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [oid, userId]);
  if (!(r.affectedRows > 0)) return { ok: false, error: '补货单不存在或已删除' };
  return { ok: true, id: oid };
}

module.exports = {
  CHANNELS, CHANNEL_LABEL, supplierIndex, ensureSupplier, createOrders,
  listOrders, getOrder, waybillCandidates, linkWaybill, deleteOrder,
  saveItem, deleteItem, searchProducts, recalcOrder, lineOf,
  moveItemToSupplier, checkItemMove, platformPriceOf, platformKindOf, addOrderToCart,
  cartKindOf, resolveGoodsIds,
};
