/**
 * 商品列表（前置仓补货参考）解析与入库 + 交易市场发布逻辑。
 *
 * 数据流：
 *   上传「前置仓补货参考批量导出」xlsx → parseReplenishWorkbook() 按列名定位解析
 *   → importReplenishFile() 逐行 upsert 到 product_item（唯一键 user_id+sku，重复导入做更新）
 *   → 每次导入写入一条 product_import_batch 快照（总货值=Σ((可用库存+在途库存)×采购价)，供趋势图）
 *
 * 注意：商品SKU 是 19 位长数字，全程按字符串处理，禁止走 Number（精度丢失）。
 */
const path = require('path');
const XLSX = require('xlsx');
const db = require('../db');

// 列头（规范化后）→ 字段。列头形如「采购单价\n(基础单位)」「可用库存\n(中心仓)」
const HEAD_MAP = {
  '商品名称': 'goods_name',
  '商品SKU': 'sku',
  '采购单价(基础单位)': 'purchase_price',
  '采购状态': 'purchase_status',
  '可用库存': 'available_stock',      // 门店仓口径（不带「中心仓」后缀）
  '在途库存': 'transit_stock',
  '30天总销量': 'sales_30d',
};
const REQUIRED = ['sku', 'goods_name', 'purchase_price', 'available_stock', 'transit_stock', 'purchase_status', 'sales_30d'];

const normHead = (s) => String(s == null ? '' : s).replace(/[\s\u00A0]+/g, '');
const toNum = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** 解析「前置仓补货参考」xlsx：前两行是说明/分组行，按「含商品SKU」的行定位列头 */
function parseReplenishWorkbook(file) {
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
  let headIdx = -1;
  let cols = null;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const normed = (rows[i] || []).map(normHead);
    const at = normed.indexOf('商品SKU');
    if (at >= 0) {
      headIdx = i;
      cols = {};
      normed.forEach((h, idx) => { const k = HEAD_MAP[h]; if (k && cols[k] == null) cols[k] = idx; });
      break;
    }
  }
  if (headIdx < 0) throw new Error('未找到表头行（需包含「商品SKU」列，请上传「前置仓补货参考批量导出」文件）');
  const missing = REQUIRED.filter((k) => cols[k] == null);
  if (missing.length) {
    throw new Error('表头缺少必需列：' + missing.map((k) => Object.keys(HEAD_MAP).find((h) => HEAD_MAP[h] === k)).join('、'));
  }
  const out = [];
  for (let i = headIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const sku = String(r[cols.sku] == null ? '' : r[cols.sku]).trim();
    if (!sku || sku === '商品SKU') continue; // 跳过空行与重复表头
    out.push({
      sku,
      goods_name: String(r[cols.goods_name] == null ? '' : r[cols.goods_name]).trim(),
      purchase_price: toNum(r[cols.purchase_price]),
      available_stock: Math.trunc(toNum(r[cols.available_stock])),
      transit_stock: Math.trunc(toNum(r[cols.transit_stock])),
      purchase_status: String(r[cols.purchase_status] == null ? '' : r[cols.purchase_status]).trim(),
      sales_30d: Math.trunc(toNum(r[cols.sales_30d])),
    });
  }
  return { sheet: sheetName, rows: out };
}

/** 解析 + 入库（upsert）+ 批次快照。fileName 仅作留档展示 */
async function importReplenishFile(userId, file, fileName) {
  const { sheet, rows } = parseReplenishWorkbook(file);
  if (!rows.length) throw new Error('文件里没有数据行');

  // 总货值 = Σ((可用库存 + 在途库存) × 采购价)
  const totalValue = rows.reduce((s, r) => s + (r.available_stock + r.transit_stock) * r.purchase_price, 0);
  const br = await db.exec(
    'INSERT INTO product_import_batch (user_id, source_file, item_count, total_value) VALUES (?,?,?,?)',
    [userId, fileName || '', rows.length, totalValue.toFixed(2)]
  );
  const batchId = br.insertId;

  // upsert：唯一键 (user_id, sku)，重复导入用本次文件内容覆盖
  const FIELDS = ['user_id', 'sku', 'goods_name', 'purchase_price', 'available_stock', 'transit_stock', 'purchase_status', 'sales_30d', 'batch_id', 'source_file'];
  const CHUNK = 200;
  let affected = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const ph = part.map(() => '(' + FIELDS.map(() => '?').join(',') + ')').join(',');
    const args = [];
    for (const r of part) args.push(userId, r.sku, r.goods_name, r.purchase_price, r.available_stock, r.transit_stock, r.purchase_status, r.sales_30d, batchId, fileName || '');
    const upd = FIELDS.filter((f) => !['user_id', 'sku'].includes(f))
      .map((f) => `${f} = VALUES(${f})`).join(', ');
    const r = await db.exec(
      `INSERT INTO product_item (${FIELDS.join(',')}) VALUES ${ph}
       ON DUPLICATE KEY UPDATE ${upd}`,
      args
    );
    affected += r.affectedRows || 0;
  }
  return {
    ok: true, sheet, total: rows.length,
    // upsert 的 affectedRows：2=更新 1=新增（有变化时），粗略区分供提示展示
    inserted: rows.length, updated: rows.length, affected,
    totalValue: Number(totalValue.toFixed(2)), batchId,
  };
}

/** 发布到交易市场：从当前商品列表取价与数量（可用库存），同人同 SKU 重复发布=更新 */
async function publishToMarket(userId, skus, discount) {
  const d = Number(discount);
  if (!Number.isFinite(d) || d <= 0 || d > 500) throw new Error('折扣应为 0~500 之间的百分比（如 80 表示按采购价 80% 发布）');
  const list = (skus || []).filter((s) => s && typeof s === 'string').slice(0, 500);
  if (!list.length) throw new Error('请选择要发布的商品');
  const ph = list.map(() => '?').join(',');
  const items = await db.query(
    `SELECT sku, goods_name, purchase_price, available_stock FROM product_item
     WHERE user_id = ? AND sku IN (${ph})`, [userId, ...list]
  );
  if (!items.length) throw new Error('所选商品不在你的商品列表中（可能已被重新导入覆盖或删除）');
  for (const it of items) {
    const price = Number(it.purchase_price) || 0;
    await db.exec(
      `INSERT INTO market_listing (user_id, sku, goods_name, orig_price, quantity, discount, discount_price)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE goods_name = VALUES(goods_name), orig_price = VALUES(orig_price),
         quantity = VALUES(quantity), discount = VALUES(discount), discount_price = VALUES(discount_price),
         published_at = NOW()`,
      [userId, it.sku, it.goods_name || '', price, Number(it.available_stock) || 0, d, (price * d / 100).toFixed(2)]
    );
  }
  return { ok: true, published: items.length, skipped: list.length - items.length, items: items.map((it) => ({ sku: it.sku, name: it.goods_name, price: Number(it.purchase_price) || 0, qty: Number(it.available_stock) || 0 })) };
}

/** 交易市场主列表：按 SKU 去重（数量=各用户发布数量合计，价格=最低价，报价数=发布条数） */
async function marketOverview() {
  const rows = await db.query(`
    SELECT l.sku, MAX(l.goods_name) AS goods_name,
           SUM(l.quantity) AS total_qty,
           MIN(l.discount_price) AS min_price,
           COUNT(*) AS quote_count,
           COUNT(DISTINCT l.user_id) AS seller_count,
           MAX(l.published_at) AS last_published_at
    FROM market_listing l
    GROUP BY l.sku
    ORDER BY last_published_at DESC
  `);
  return { rows };
}

/** 某个 SKU 的报价列表：价格升序，同价按发布时间倒序（新发布的排前面） */
async function marketQuotes(sku) {
  const rows = await db.query(`
    SELECT l.user_id, l.sku, l.goods_name, l.orig_price, l.quantity, l.discount, l.discount_price, l.published_at,
           COALESCE(NULLIF(u.company_name, ''), u.username) AS user_name
    FROM market_listing l JOIN app_user u ON u.id = l.user_id
    WHERE l.sku = ?
    ORDER BY l.discount_price ASC, l.published_at DESC
  `, [String(sku || '').trim()]);
  return { rows };
}

module.exports = { parseReplenishWorkbook, importReplenishFile, publishToMarket, marketOverview, marketQuotes };
