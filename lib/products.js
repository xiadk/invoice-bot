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
  '建议量(基础单位)': 'suggest_qty',   // 补货参考文件第 5 列（0 基第 4 列），可能为空
  // 1688 采购价核对（v0.3.43）所需：待付款订单只有 1688 供应商维度，得靠这几列匹配目标价。
  // 精确表头可能有出入时，下面的并集多备几个写法兜底（exact 匹配会逐一尝试）。
  '供应商商品名称': 'supplier_name',
  '供应商商品描述': 'supplier_name',
  '供应商商品规格': 'supplier_spec',
  '供应商商品属性': 'supplier_spec',
  '供应商商品链接': 'supplier_link',
  '链接': 'supplier_link',
  '供应商链接': 'supplier_link',
  '下单比例': 'order_ratio',
  '供应商商品下单比例': 'order_ratio',
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
      // 建议量：老文件可能没有这一列（cols.suggest_qty 为 undefined → 取 0）
      suggest_qty: Math.trunc(toNum(cols.suggest_qty == null ? 0 : r[cols.suggest_qty])),
      // 1688 供应商维度（v0.3.43，采购价核对匹配键；老文件可能没有 → 空串/1）
      supplier_name: String(cols.supplier_name == null ? '' : r[cols.supplier_name]).trim(),
      supplier_spec: String(cols.supplier_spec == null ? '' : r[cols.supplier_spec]).trim(),
      supplier_link: String(cols.supplier_link == null ? '' : r[cols.supplier_link]).trim(),
      order_ratio: toNum(cols.order_ratio == null ? 1 : r[cols.order_ratio]) || 1,
    });
  }
  return { sheet: sheetName, rows: out };
}

/**
 * 解析 + 入库（upsert）+ 批次快照。fileName 仅作留档展示。
 * brandId：导入者所属品牌方（补货数据仍按用户个人隔离，这里只记录品牌，便于按品牌商品补主图）
 */
async function importReplenishFile(userId, file, fileName, brandId) {
  const { sheet, rows } = parseReplenishWorkbook(file);
  if (!rows.length) throw new Error('文件里没有数据行');
  const bid = Number(brandId) || 1;

  // 总货值 = Σ((可用库存 + 在途库存) × 采购价)
  const totalValue = rows.reduce((s, r) => s + (r.available_stock + r.transit_stock) * r.purchase_price, 0);
  const br = await db.exec(
    'INSERT INTO product_import_batch (user_id, source_file, item_count, total_value) VALUES (?,?,?,?)',
    [userId, fileName || '', rows.length, totalValue.toFixed(2)]
  );
  const batchId = br.insertId;

  // upsert：唯一键 (user_id, sku)，重复导入用本次文件内容覆盖
  const FIELDS = ['user_id', 'brand_id', 'sku', 'goods_name', 'purchase_price', 'available_stock', 'transit_stock', 'purchase_status', 'sales_30d', 'suggest_qty', 'supplier_name', 'supplier_spec', 'supplier_link', 'order_ratio', 'batch_id', 'source_file'];
  const CHUNK = 200;
  let affected = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const ph = part.map(() => '(' + FIELDS.map(() => '?').join(',') + ')').join(',');
    const args = [];
    for (const r of part) args.push(userId, bid, r.sku, r.goods_name, r.purchase_price, r.available_stock, r.transit_stock, r.purchase_status, r.sales_30d, r.suggest_qty || 0, r.supplier_name || '', r.supplier_spec || '', r.supplier_link || '', r.order_ratio || 1, batchId, fileName || '');
    const upd = FIELDS.filter((f) => !['user_id', 'sku'].includes(f))
      .map((f) => `${f} = VALUES(${f})`).join(', ');
    const r = await db.exec(
      `INSERT INTO product_item (${FIELDS.join(',')}) VALUES ${ph}
       ON DUPLICATE KEY UPDATE ${upd}`,
      args
    );
    affected += r.affectedRows || 0;
  }
  // 补主图：按「品牌 + SKU」从品牌商品表回填（补货页要显示商品图；导入文件里没有图片列）
  try {
    await db.exec(
      `UPDATE product_item pi
         JOIN brand_product bp ON bp.brand_id = pi.brand_id AND bp.sku = pi.sku
          SET pi.image_url = bp.image_url
        WHERE pi.user_id = ? AND pi.batch_id = ?
          AND (pi.image_url IS NULL OR pi.image_url = '') AND bp.image_url IS NOT NULL`,
      [userId, batchId]
    );
  } catch (e) { /* 补图失败不影响导入本身 */ }
  return {
    ok: true, sheet, total: rows.length,
    // upsert 的 affectedRows：2=更新 1=新增（有变化时），粗略区分供提示展示
    inserted: rows.length, updated: rows.length, affected,
    totalValue: Number(totalValue.toFixed(2)), batchId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1688 比价专用：导入「补货单明细导出」作为目标价来源（v0.3.50 后）
//
// 与上面的「前置仓补货参考批量导出」是两份完全不同的文件：
//   · 补货单明细：表头在第 1 行，列是 SKU / 商品名称 / 规格 / 补货单价 / 可用库存 / 在途库存，
//     **没有** 1688 链接、供应商商品名称/规格、下单比例、采购状态、30 天销量。
//   · 因此目标价取「补货单价」，链接按 SKU 从 brand_product（商品同步）回填，
//     规格放进 supplier_spec 供同 offer 多 SKU 时消歧；order_ratio 固定 1
//     （文件里的「转换比例」是基础单位↔补货单位换算，可能是 50/10，绝不能当 order_ratio）。
//   · 只对「本功能导入」的行做更新，绝不覆盖其它页面导入的 product_item 数据。
// ─────────────────────────────────────────────────────────────────────────────
const PRICE_REF_PREFIX = '比价参考|';

/** 解析「补货单明细导出」xlsx（表头第 1 行；SKU 是 19 位长数字，全程按字符串） */
function parseReplenishOrderWorkbook(file) {
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames[0];
  // raw:false 让 19 位 SKU 保持文本，避免 Number 精度丢失
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
  let headIdx = -1;
  let cols = null;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const normed = (rows[i] || []).map(normHead);
    if (!normed.includes('补货单价')) continue;
    const at = normed.findIndex((h) => h === 'SKU' || h === '商品SKU');
    if (at < 0) continue;
    headIdx = i;
    const idx = (name) => { const p = normed.indexOf(name); return p < 0 ? null : p; };
    cols = {
      sku: at, goods_name: idx('商品名称'), purchase_price: idx('补货单价'),
      supplier_spec: idx('规格'), available_stock: idx('可用库存'), transit_stock: idx('在途库存'),
    };
    break;
  }
  if (headIdx < 0) {
    throw new Error('未找到表头行（需同时包含「SKU」与「补货单价」列，请上传「补货单明细导出」文件）');
  }
  const cell = (r, i) => (i == null || i < 0 ? '' : r[i] == null ? '' : r[i]);
  const out = [];
  for (let i = headIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const sku = String(cell(r, cols.sku)).trim();
    if (!sku || sku === 'SKU' || sku === '商品SKU') continue; // 跳过空行与重复表头
    out.push({
      sku,
      goods_name: String(cell(r, cols.goods_name)).trim(),
      // 目标价口径：以补货单上的「补货单价」为准（用户 2026-11-07 明确指定）
      purchase_price: toNum(cell(r, cols.purchase_price)),
      supplier_spec: String(cell(r, cols.supplier_spec)).trim(),
      available_stock: Math.trunc(toNum(cell(r, cols.available_stock))),
      transit_stock: Math.trunc(toNum(cell(r, cols.transit_stock))),
    });
  }
  return { sheet: sheetName, rows: out };
}

/**
 * 导入比价专用补货单明细：写 product_import_batch + product_item，返回 batchId。
 * 供 server.js 的 /api/import/upload?kind=price_ref 使用（只有 1688 比价页的导入按钮走这里）。
 */
async function importPriceRefFile(userId, file, fileName, brandId) {
  let sheet, rows;
  try {
    ({ sheet, rows } = parseReplenishOrderWorkbook(file));
  } catch (e) {
    // 与上传路由的 `if (!r.ok)` 契约对齐：解析失败也回 400 + 可读错误，不冒泡成 500
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!rows.length) return { ok: false, error: '文件里没有数据行' };
  const bid = Number(brandId) || 1;
  const source = (PRICE_REF_PREFIX + String(fileName || '')).slice(0, 255);

  const totalValue = rows.reduce((s, r) => s + (r.available_stock + r.transit_stock) * r.purchase_price, 0);
  const br = await db.exec(
    'INSERT INTO product_import_batch (user_id, source_file, item_count, total_value) VALUES (?,?,?,?)',
    [userId, source, rows.length, totalValue.toFixed(2)]
  );
  const batchId = br.insertId;

  // 按 SKU 从商品同步结果补 1688 offer 链接：补货单明细本身没有链接列
  const skus = rows.map((r) => r.sku);
  const linkBySku = new Map();
  const CHUNK_Q = 200;
  for (let i = 0; i < skus.length; i += CHUNK_Q) {
    const part = skus.slice(i, i + CHUNK_Q);
    const ph = part.map(() => '?').join(',');
    const bp = await db.query(
      `SELECT sku, supplier_link FROM brand_product WHERE brand_id = ? AND sku IN (${ph})`,
      [bid, ...part]
    );
    for (const b of bp) {
      const k = String(b.sku);
      const v = String(b.supplier_link || '').trim();
      if (v && !linkBySku.has(k)) linkBySku.set(k, v);
    }
  }
  let linkFilled = 0;
  let link1688 = 0;
  for (const r of rows) {
    const link = linkBySku.get(r.sku) || '';
    r.supplier_link = link;
    if (link) linkFilled += 1;
    if (link.includes('detail.1688.com')) link1688 += 1;
  }

  // 只新增/更新「本功能来源」的行，绝不覆盖其它页面导入的 product_item 数据
  const existing = new Map();
  for (let i = 0; i < skus.length; i += CHUNK_Q) {
    const part = skus.slice(i, i + CHUNK_Q);
    const ph = part.map(() => '?').join(',');
    const old = await db.query(
      `SELECT sku, source_file FROM product_item WHERE user_id = ? AND sku IN (${ph})`,
      [userId, ...part]
    );
    for (const o of old) existing.set(String(o.sku), String(o.source_file || ''));
  }
  const isOurs = (sku) => (existing.get(sku) || '').startsWith(PRICE_REF_PREFIX);
  const inserts = rows.filter((r) => !existing.has(r.sku));
  const updates = rows.filter((r) => existing.has(r.sku) && isOurs(r.sku));
  const skipped = rows.length - inserts.length - updates.length;

  const FIELDS = ['user_id', 'brand_id', 'sku', 'goods_name', 'purchase_price', 'available_stock',
    'transit_stock', 'purchase_status', 'sales_30d', 'suggest_qty', 'supplier_name', 'supplier_spec',
    'supplier_link', 'order_ratio', 'batch_id', 'source_file'];
  const argsOf = (r) => [
    userId, bid, r.sku, r.goods_name, r.purchase_price, r.available_stock, r.transit_stock,
    '', 0, 0, '', r.supplier_spec, r.supplier_link, 1, batchId, source,
  ];
  // 更新时保留其它页面关心的字段（采购状态/销量/建议量/本地价/图片），只改比价维度
  const UPDATE_COLS = ['goods_name', 'purchase_price', 'available_stock', 'transit_stock',
    'supplier_spec', 'supplier_link', 'order_ratio', 'batch_id', 'source_file'];
  const CHUNK_W = 200;
  let affected = 0;
  for (const [batch, isUpdate] of [[inserts, false], [updates, true]]) {
    for (let i = 0; i < batch.length; i += CHUNK_W) {
      const part = batch.slice(i, i + CHUNK_W);
      const ph = part.map(() => '(' + FIELDS.map(() => '?').join(',') + ')').join(',');
      const args = [];
      for (const r of part) args.push(...argsOf(r));
      const tail = isUpdate
        ? ' ON DUPLICATE KEY UPDATE ' + UPDATE_COLS.map((f) => `${f} = VALUES(${f})`).join(', ')
        : '';
      const res = await db.exec(
        `INSERT INTO product_item (${FIELDS.join(',')}) VALUES ${ph}${tail}`, args
      );
      affected += res.affectedRows || 0;
    }
  }
  return {
    ok: true, sheet, total: rows.length, inserted: inserts.length, updated: updates.length,
    skipped, linkFilled, link1688, affected, batchId,
    totalValue: Number(totalValue.toFixed(2)),
  };
}

/**
 * 发布到交易市场：取价与数量（可用库存），同人同 SKU 重复发布=更新。
 * 价格/库存优先取品牌商品（商品同步的权威数据），品牌商品里没有的再从个人导入数据兜底。
 */
async function publishToMarket(userId, skus, discount, brandId) {
  const d = Number(discount);
  if (!Number.isFinite(d) || d <= 0 || d > 500) throw new Error('折扣应为 0~500 之间的百分比（如 80 表示按采购价 80% 发布）');
  const list = (skus || []).filter((s) => s && typeof s === 'string').slice(0, 500);
  if (!list.length) throw new Error('请选择要发布的商品');
  const ph = list.map(() => '?').join(',');
  const bid = Number(brandId) || 1;
  const brandRows = await db.query(
    `SELECT sku, goods_name, purchase_price, available_stock FROM brand_product
     WHERE brand_id = ? AND sku IN (${ph})`, [bid, ...list]
  );
  let items = brandRows;
  const have = new Set(brandRows.map((x) => String(x.sku)));
  const rest = list.filter((s) => !have.has(s));
  if (rest.length) {
    const ownRows = await db.query(
      `SELECT sku, goods_name, purchase_price, available_stock FROM product_item
       WHERE user_id = ? AND sku IN (${rest.map(() => '?').join(',')})`, [userId, ...rest]
    );
    items = items.concat(ownRows);
  }
  if (!items.length) throw new Error('所选商品不在你所在品牌的商品列表里（可能已重新同步或删除）');
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
/** 交易市场主列表：按 SKU 去重后分页（分页是为了防止 SKU 多了以后整页渲染卡死） */
async function marketOverview({ page, size, q } = {}) {
  const kw = String(q == null ? '' : q).trim().slice(0, 64);
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(200, Math.max(1, Number(size) || 20));
  const where = [];
  const args = [];
  if (kw) {
    where.push('sku LIKE ? OR goods_name LIKE ?');
    args.push(`%${kw}%`, `%${kw}%`);
  }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  // 先按 SKU 聚合出一行，再在外层过滤/分页
  const base = `
    FROM (
      SELECT l.sku,
             MAX(l.goods_name) AS goods_name,
             SUM(l.quantity) AS total_qty,
             MIN(l.discount_price) AS min_price,
             COUNT(*) AS quote_count,
             COUNT(DISTINCT l.user_id) AS seller_count,
             MAX(l.published_at) AS last_published_at
        FROM market_listing l
       GROUP BY l.sku
    ) t`;
  const cnt = await db.query(`SELECT COUNT(*) AS n ${base}${w}`, args);
  const rows = await db.query(
    `SELECT t.* ${base}${w} ORDER BY t.last_published_at DESC, t.sku LIMIT ? OFFSET ?`,
    [...args, s, (p - 1) * s]
  );
  // 列表页统计卡用的一条只读聚合：全站口径（不受 q 影响，因为全站每一行都会被聚合进卡片）
  const agg = await db.query(`
    SELECT COUNT(*) AS quotes,
           COUNT(DISTINCT l.user_id) AS sellers,
           MIN(l.discount_price) AS min_price,
           SUM(l.quantity) AS qty
      FROM market_listing l
  `);
  const a = (agg && agg[0]) || {};
  const summary = {
    quotes: Number(a.quotes) || 0,
    sellers: Number(a.sellers) || 0,
    min_price: a.min_price == null ? null : Number(a.min_price),
    qty: Number(a.qty) || 0,
  };
  return { rows, total: Number(cnt[0] && cnt[0].n) || 0, page: p, size: s, q: kw, summary };
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

// ─────────────────────────────────────────────────────────────────────────
// 本地价三件套（v0.3.11）：整件价 / 单价 / 规格数量
//   线下报价常是「一件多少钱 + 一件几个」，两种填法都要能算另一个。
//   口径（用户确认）：
//     · 四舍五入到分（2 位小数）
//     · 没填规格数量 = 只有单价，整件价存 NULL
//     · 填整件价时必须同时有规格数量（否则算不出单价，直接报错让人补）
// ─────────────────────────────────────────────────────────────────────────
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** 价格入参 → {ok, value}：空值返回 null；接受千分位与 ¥ 前缀 */
function parseMoney(v) {
  if (v === null || v === undefined) return { ok: true, value: null };
  const s = String(v).trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s.replace(/[,，¥￥\s]/g, ''));
  if (!Number.isFinite(n)) return { ok: false, error: '价格应为数字' };
  if (n < 0) return { ok: false, error: '价格不能为负数' };
  return { ok: true, value: n };
}

/** 规格数量入参 → {ok, value}：空 / 0 一律视为「没填」 */
function parseSpecQty(v) {
  if (v === null || v === undefined) return { ok: true, value: null };
  const s = String(v).trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s.replace(/[,，\s件]/g, ''));
  if (!Number.isFinite(n)) return { ok: false, error: '规格数量应为数字' };
  if (n < 0) return { ok: false, error: '规格数量不能为负数' };
  if (n === 0) return { ok: true, value: null };
  return { ok: true, value: n };
}

/**
 * 算本地价三件套。
 * @param {{mode?:'unit'|'pack', unitPrice?:any, packPrice?:any, specQty?:any}} o
 *        mode = 这次改的是哪个价格（另一个由规格数量折算）；缺省 unit
 * @returns {{ok:true, unitPrice:number|null, packPrice:number|null, specQty:number|null}|{ok:false, error:string}}
 */
function calcLocalPrice({ mode, unitPrice, packPrice, specQty } = {}) {
  const u = parseMoney(unitPrice);
  if (!u.ok) return u;
  const p = parseMoney(packPrice);
  if (!p.ok) return p;
  const q = parseSpecQty(specQty);
  if (!q.ok) return q;
  const qty = q.value;
  const m = mode === 'pack' ? 'pack' : 'unit';

  if (m === 'pack') {
    const pack = p.value;
    if (pack == null) return { ok: true, unitPrice: null, packPrice: null, specQty: qty };
    if (qty == null) {
      return { ok: false, error: '填整件价要同时填规格数量（一件多少个），否则算不出单价' };
    }
    return { ok: true, unitPrice: round2(pack / qty), packPrice: round2(pack), specQty: qty };
  }
  const unit = u.value;
  if (unit == null) return { ok: true, unitPrice: null, packPrice: null, specQty: qty };
  return { ok: true, unitPrice: round2(unit), packPrice: qty == null ? null : round2(unit * qty), specQty: qty };
}

// ─────────────────────────────────────────────────────────────────────────
// 比价分析（v0.3.12 改口径）
//   参比价源：齐货通 / 城配速达（供应商台账里叫「永源顺」）/ 京东万商（goods_price_cache 缓存）
//            + 手工本地价（可挂供应商）
//   结论口径（用户 2026-11-03 确认，与 v0.3.11 相反）：
//     over    = 已有最低价 > 建议采购价 → 买贵了（按现有渠道买会比建议价多花钱，标红）
//     same    = 相差不到半分钱
//     under   = 建议采购价高于已有最低价（现方案已经更便宜，不告警）
//     no-price   = 没有任何可比价
//     no-purchase= 有价但补货单里没有建议采购价
//
//   数量与金额（用户确认）：
//     · 补货数量(件) = 向上取整(建议量 ÷ 规格)，规格取「最低价那个渠道自己的装箱规格」；
//       渠道没规格就退回本地价填的规格，两者都没有按 1 算（补货数量 = 建议量）
//     · 行总价 = 补货数量 × 规格 × 最低单价（= 按整件买齐的实际金额）
//     · 按供应商归集总价（同一供应商的若干 SKU 汇总成一张补货单），再算整单合计
//
//   ⚠ 单价统一用「折合小单位单价」比较：三个平台的缓存里 unit_price 都是这个口径，
//     本地价存的也是单价，不能拿整件价直接比（整件含的数量各不相同）。
// ─────────────────────────────────────────────────────────────────────────
// 渠道 → 供应商台账里的名字。平台自己叫「城配速达（阿发）」，但它其实是永源顺这家供应商的货。
const CHANNEL_SUPPLIER_NAME = { qht: '齐货通', afa: '永源顺', jd: '京东万商' };

const COMPARE_CHANNELS = [
  { kind: 'qht', label: '齐货通', field: 'qht_goods_id', supName: '齐货通' },
  { kind: 'afa', label: '永源顺', field: 'afa_goods_id', supName: '永源顺' },
  { kind: 'jd', label: '京东万商', field: 'jd_sku_id', supName: '京东万商' },
  { kind: 'local', label: '本地价', field: null, supName: null },
];

/**
 * 单行补货数量 / 总价折算（与页面弹窗同一套规则，服务端生成补货单时也用它复核）。
 * @param {{suggestQty:any, specQty:any, unitPrice:any}} o
 * @returns {{ok:true, suggestQty:number, specQty:number, qtyPack:number, unitPrice:number,
 *            packPrice:number, amount:number}|{ok:false,error:string}}
 */
function calcReplenishLine({ suggestQty, specQty, unitPrice } = {}) {
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };
  const sug = n(suggestQty);
  if (!Number.isFinite(sug) || sug < 0) return { ok: false, error: '建议量应为非负数字' };
  let spec = n(specQty);
  if (!Number.isFinite(spec) || spec <= 0) spec = 1;      // 没规格数据按 1（补货数量 = 建议量）
  const unit = n(unitPrice);
  if (!Number.isFinite(unit) || unit < 0) return { ok: false, error: '单价应为非负数字' };
  // 有小数就 +1：1.2 件算 2 件，整数不动（ceil 对 3.0 仍是 3）
  const qtyPack = sug > 0 ? Math.ceil(round2(sug / spec) - 1e-9) : 0;
  const packPrice = round2(unit * spec);
  const amount = round2(qtyPack * spec * unit);
  return { ok: true, suggestQty: round2(sug), specQty: round2(spec), qtyPack, unitPrice: unit, packPrice, amount };
}

/**
 * 逐 SKU 出补货建议：挑最低价，算补货数量与总价，按供应商归集。
 * @param {{rows:Array, priceMap:Object, manualMap?:Object, supNameById?:Object, supIdByName?:Object}} o
 *        priceMap: 平台价格缓存 { '<kind>:<brandId>:<goodsId>': {...} }
 *        manualMap: 手工价 { '<kind>:<brandId>:<sku>': {...} }（v0.3.28）
 *                   **优先级高于 priceMap**：同渠道有手工价就用手工价，且不要求已关联平台商品
 *        supNameById: {supplierId: name}（本地价挂的供应商名）
 *        supIdByName: {供应商名: id}（平台渠道映射到台账里的同名供应商）
 */
function comparePrices({ rows, priceMap, manualMap, supNameById, supIdByName } = {}) {
  const nameById = supNameById || {};
  const idByName = supIdByName || {};
  const manualOf = manualMap || {};
  const out = [];
  const groups = new Map();
  const summary = {
    total: 0, priced: 0, over: 0, same: 0, under: 0, noPrice: 0, noPurchase: 0,
    overpayTotal: 0,   // 买贵了的那批，按现渠道买会多花多少
    amountTotal: 0,    // 整单总价（只算有价的）
    qtyTotal: 0,       // 补货数量合计（件）
    groups: [],
    channels: COMPARE_CHANNELS.map((c) => ({ kind: c.kind, label: c.label, count: 0 })),
  };
  const chCount = new Map(summary.channels.map((c) => [c.kind, c]));

  for (const r of rows || []) {
    const bid = Number(r.brand_id) || 0;
    const sku = String(r.sku == null ? '' : r.sku);
    const purchase = r.purchase_price == null || r.purchase_price === '' ? null : Number(r.purchase_price);
    const buyQty = Number(r.suggest_qty) > 0 ? Number(r.suggest_qty) : 0;
    const localSpec = Number(r.local_spec_qty) > 0 ? Number(r.local_spec_qty) : null;
    const cands = [];

    for (const ch of COMPARE_CHANNELS) {
      let unit = null; let pack = null; let qty = null; let spec = '';
      let supplierId = 0; let supplierName = '';
      let manual = false;
      if (ch.kind === 'local') {
        if (r.local_price == null || r.local_price === '') continue;
        unit = Number(r.local_price);
        pack = r.local_pack_price == null || r.local_pack_price === '' ? null : Number(r.local_pack_price);
        qty = localSpec;
        spec = qty == null ? '' : (qty + '/件');
        supplierId = Number(r.local_supplier_id) || 0;
        supplierName = supplierId > 0 ? (nameById[supplierId] || '') : '';
      } else {
        // 手工价优先：有它就不用管有没有关联平台商品（关联错了也能靠手工价纠错）
        const man = manualOf[ch.kind + ':' + bid + ':' + sku];
        const manUnit = man ? Number(man.unitPrice) : NaN;
        if (man && Number.isFinite(manUnit) && manUnit > 0) {
          manual = true;
          unit = manUnit;
          pack = man.packPrice == null ? null : Number(man.packPrice);
          qty = man.packQty == null ? null : Number(man.packQty);
          spec = man.spec || '';
        } else {
          const gid = String(r[ch.field] == null ? '' : r[ch.field]).trim();
          if (!gid) continue;
          const p = priceMap && priceMap[ch.kind + ':' + bid + ':' + gid];
          if (!p || p.unitPrice == null) continue;
          unit = Number(p.unitPrice);
          pack = p.packPrice == null ? null : Number(p.packPrice);
          qty = p.packQty == null ? null : Number(p.packQty);
          spec = p.spec || '';
        }
        supplierName = ch.supName || '';
        supplierId = ch.supName ? (Number(idByName[ch.supName]) || 0) : 0;
      }
      if (!Number.isFinite(unit) || unit <= 0) continue;
      cands.push({
        kind: ch.kind,
        // 手工价的标签加后缀，比价弹窗「最低价来源」一眼看出是人填的
        label: ch.kind === 'local' ? (supplierName || ch.label) : (manual ? ch.label + '手工' : ch.label),
        manual,
        unitPrice: round2(unit),
        packPrice: pack == null || !Number.isFinite(pack) ? null : round2(pack),
        packQty: qty == null || !Number.isFinite(qty) || qty <= 0 ? null : qty,
        spec,
        supplierId,
        supplierName,
      });
      const cc = chCount.get(ch.kind);
      if (cc) cc.count += 1;
    }

    const sorted = cands.slice().sort((a, b) => a.unitPrice - b.unitPrice);
    const best = sorted[0] || null;
    // 规格：最低价渠道自己的装箱规格 → 本地价填的规格 → 1
    const specQty = best && best.packQty ? best.packQty : (localSpec || 1);
    const line = best
      ? calcReplenishLine({ suggestQty: buyQty, specQty, unitPrice: best.unitPrice })
      : { ok: true, qtyPack: 0, specQty, amount: 0 };

    let verdict = 'no-price';
    let diff = null;       // 正数 = 最低价比建议采购价高（买贵了）
    let overpay = null;    // 按现渠道买会多花的钱
    if (best && purchase != null && purchase > 0) {
      diff = round2(best.unitPrice - purchase);
      if (Math.abs(diff) < 0.005) verdict = 'same';
      else if (diff > 0) verdict = 'over';
      else verdict = 'under';
      if (verdict === 'over' && line.ok && line.qtyPack > 0) overpay = round2(line.qtyPack * line.specQty * diff);
    } else if (best) {
      verdict = 'no-purchase';
    }

    summary.total += 1;
    if (best) summary.priced += 1;
    if (verdict === 'over') {
      summary.over += 1;
      if (overpay != null) summary.overpayTotal = round2(summary.overpayTotal + overpay);
    } else if (verdict === 'same') summary.same += 1;
    else if (verdict === 'under') summary.under += 1;
    // ⚠ 「有价但补货单里没有建议采购价」不等于「无任何可比价」，必须单独计数，
    //   否则汇总卡会把两类行混在一起（v0.3.12 L2 实测发现）。
    else if (verdict === 'no-purchase') summary.noPurchase += 1;
    else summary.noPrice += 1;
    const amt = line.ok ? line.amount : 0;
    summary.amountTotal = round2(summary.amountTotal + amt);
    summary.qtyTotal += line.ok ? line.qtyPack : 0;

    // 按供应商归集（同一供应商的 SKU 将来合成一张补货单）
    if (best) {
      const gkey = best.supplierId > 0 ? 'sup:' + best.supplierId : 'ch:' + best.kind;
      const gname = best.supplierName || best.label;
      if (!groups.has(gkey)) {
        groups.set(gkey, {
          key: gkey, supplierId: best.supplierId || 0, supplierName: gname,
          channel: best.kind, itemCount: 0, qtyTotal: 0, amount: 0, overpay: 0,
        });
      }
      const g = groups.get(gkey);
      g.itemCount += 1;
      g.qtyTotal += line.ok ? line.qtyPack : 0;
      g.amount = round2(g.amount + amt);
      if (overpay != null) g.overpay = round2(g.overpay + overpay);
      if (g.channel !== best.kind) g.channel = 'mixed';
    }

    out.push({
      sku,
      goods_name: r.goods_name || '',
      image_url: r.image_url || '',
      brand_id: bid,
      purchase_price: purchase,
      suggest_qty: buyQty,
      candidates: cands,
      best,
      spec_qty: line.ok ? line.specQty : specQty,
      qty_pack: line.ok ? line.qtyPack : 0,
      amount: line.ok ? line.amount : null,
      pack_price: best ? best.packPrice : null,
      verdict,
      diff,
      overpay,
    });
  }

  summary.groups = [...groups.values()].sort((a, b) => b.amount - a.amount);
  // 买贵了的排最前（页面打开就能看到该处理的），同类按多花金额倒序
  out.sort((a, b) => {
    const w = (x) => (x.verdict === 'over' ? 0 : x.verdict === 'under' ? 2 : 1);
    if (w(a) !== w(b)) return w(a) - w(b);
    return (Number(b.overpay) || 0) - (Number(a.overpay) || 0);
  });
  return { rows: out, summary };
}

module.exports = {
  parseReplenishWorkbook, importReplenishFile, publishToMarket, marketOverview, marketQuotes,
  calcLocalPrice, comparePrices, calcReplenishLine, COMPARE_CHANNELS, CHANNEL_SUPPLIER_NAME,
  parseReplenishOrderWorkbook, importPriceRefFile, PRICE_REF_PREFIX,
};
