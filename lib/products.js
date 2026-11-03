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
  const FIELDS = ['user_id', 'brand_id', 'sku', 'goods_name', 'purchase_price', 'available_stock', 'transit_stock', 'purchase_status', 'sales_30d', 'suggest_qty', 'batch_id', 'source_file'];
  const CHUNK = 200;
  let affected = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const ph = part.map(() => '(' + FIELDS.map(() => '?').join(',') + ')').join(',');
    const args = [];
    for (const r of part) args.push(userId, bid, r.sku, r.goods_name, r.purchase_price, r.available_stock, r.transit_stock, r.purchase_status, r.sales_30d, r.suggest_qty || 0, batchId, fileName || '');
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
// 比价分析（v0.3.11）
//   参比价源：齐货通 / 城配速达 / 京东万商（goods_price_cache 缓存）+ 手工本地价
//   结论口径（用户确认）：
//     cheaper = 采购价高于已有最低价 → 买贵了，可换渠道（这是唯一要标红提示的方向）
//     same    = 相差不到半分钱
//     higher  = 已有最低价比采购价还高（现采购价已经是最优，不做告警，只在明细里标明）
//     no-price = 没有任何可比价
//
//   ⚠ 单价统一用「折合小单位单价」比较：三个平台的缓存里 unit_price 都是这个口径，
//     本地价存的也是单价，不能拿整件价直接比（整件含的数量各不相同）。
// ─────────────────────────────────────────────────────────────────────────
const COMPARE_CHANNELS = [
  { kind: 'qht', label: '齐货通', field: 'qht_goods_id' },
  { kind: 'afa', label: '城配速达', field: 'afa_goods_id' },
  { kind: 'jd', label: '京东万商', field: 'jd_sku_id' },
  { kind: 'local', label: '本地价', field: null },
];

function comparePrices({ rows, priceMap } = {}) {
  const out = [];
  const summary = {
    total: 0, priced: 0, cheaper: 0, same: 0, higher: 0, noPrice: 0,
    saveTotal: 0, saveQty: 0,
    // 各渠道参与比价的条数，页面汇总卡直接用
    channels: COMPARE_CHANNELS.map((c) => ({ kind: c.kind, label: c.label, count: 0 })),
  };
  const chCount = new Map(summary.channels.map((c) => [c.kind, c]));

  for (const r of rows || []) {
    const bid = Number(r.brand_id) || 0;
    const sku = String(r.sku == null ? '' : r.sku);
    const purchase = r.purchase_price == null ? null : Number(r.purchase_price);
    const buyQty = Number(r.suggest_qty) > 0 ? Number(r.suggest_qty) : 0;
    const cands = [];

    for (const ch of COMPARE_CHANNELS) {
      let unit = null; let pack = null; let qty = null; let spec = '';
      if (ch.kind === 'local') {
        if (r.local_price == null || r.local_price === '') continue;
        unit = Number(r.local_price);
        pack = r.local_pack_price == null || r.local_pack_price === '' ? null : Number(r.local_pack_price);
        qty = r.local_spec_qty == null || r.local_spec_qty === '' ? null : Number(r.local_spec_qty);
        spec = qty == null ? '' : (qty + '/件');
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
      if (!Number.isFinite(unit) || unit <= 0) continue;
      cands.push({
        kind: ch.kind, label: ch.label,
        unitPrice: round2(unit),
        packPrice: pack == null || !Number.isFinite(pack) ? null : round2(pack),
        packQty: qty == null || !Number.isFinite(qty) ? null : qty,
        spec,
      });
      const cc = chCount.get(ch.kind);
      if (cc) cc.count += 1;
    }

    const sorted = cands.slice().sort((a, b) => a.unitPrice - b.unitPrice);
    const best = sorted[0] || null;
    let verdict = 'no-price';
    let diff = null;          // 正数 = 采购价更贵（每单位可省）
    let saveTotal = null;     // 按建议量算的可省总额
    if (best && purchase != null && purchase > 0) {
      diff = round2(purchase - best.unitPrice);
      if (Math.abs(diff) < 0.005) verdict = 'same';
      else if (diff > 0) verdict = 'cheaper';
      else verdict = 'higher';
      if (verdict === 'cheaper' && buyQty > 0) saveTotal = round2(diff * buyQty);
    } else if (best) {
      verdict = 'no-purchase';
    }

    summary.total += 1;
    if (best) summary.priced += 1;
    if (verdict === 'cheaper') {
      summary.cheaper += 1;
      if (saveTotal != null) { summary.saveTotal = round2(summary.saveTotal + saveTotal); summary.saveQty += buyQty; }
    } else if (verdict === 'same') summary.same += 1;
    else if (verdict === 'higher') summary.higher += 1;
    else summary.noPrice += 1;

    out.push({
      sku,
      goods_name: r.goods_name || '',
      image_url: r.image_url || '',
      brand_id: bid,
      purchase_price: purchase,
      suggest_qty: buyQty,
      candidates: cands,
      best,
      verdict,
      diff,
      save_total: saveTotal,
    });
  }
  // 买贵了的排最前（页面打开就能看到该处理的），同类按可省金额倒序，其余保持原顺序
  out.sort((a, b) => {
    const w = (x) => (x.verdict === 'cheaper' ? 0 : x.verdict === 'higher' ? 2 : 1);
    if (w(a) !== w(b)) return w(a) - w(b);
    return (Number(b.save_total) || 0) - (Number(a.save_total) || 0);
  });
  return { rows: out, summary };
}

module.exports = {
  parseReplenishWorkbook, importReplenishFile, publishToMarket, marketOverview, marketQuotes,
  calcLocalPrice, comparePrices, COMPARE_CHANNELS,
};
