/**
 * 商品手工价（v0.3.28）
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么要有这张表：平台取价（goods_price_cache）是拿「关联的齐货通商品」的价格，
 * 一旦关联错、平台改了规格、或者根本没关联到平台商品，页面上那个价就是错的，
 * 而它会影响比价结论和补货单金额。手工价就是让人在这种情况下直接纠错。
 *
 * 口径（用户 2026-11-04 确认）：
 *   · 按「品牌方 + SKU + 来源(kind)」唯一，同品牌共用一份（与平台价缓存同口径）
 *   · **优先级高于平台价**：有手工价就用它，点「重新取价」也不会覆盖
 *   · 单价 / 整件价 / 规格三件套与「本地价」同一套互算规则（复用 products.calcLocalPrice），
 *     所以整件价 ÷ 规格 = 单价 永远自洽
 *   · 没关联齐货通商品也能凭手工价参与比价（页面会标「手工」）
 *
 * 只读的函数给列表与比价用；写入口只有 server.js 的 /api/products/manual-price[/clear]。
 */
const db = require('../db');
const { calcLocalPrice } = require('./products');

const KINDS = ['qht'];                 // 暂时只做齐货通；留给以后扩展阿发/京东
const DEFAULT_KIND = 'qht';
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function normKind(kind) {
  const k = String(kind || DEFAULT_KIND).toLowerCase();
  if (!KINDS.includes(k)) throw new Error('手工价目前只支持齐货通（kind=qht）');
  return k;
}

/** normKind 的「不抛异常」版本：接口层要把它变成 400 + 中文提示，而不是 500 */
function safeKind(kind) {
  try { return { ok: true, kind: normKind(kind) }; } catch (e) { return { ok: false, error: e.message }; }
}

/** DATETIME → 'MM-DD HH:mm'（与价格缓存同一种展示口径） */
function fmtTime(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 库行 → 页面价格对象。
 * 字段名刻意与 price-cache.toPrice('qht', row) 对齐（saleIP / packingSpecification / smallUnit），
 * 这样补货页模板不用为「手工」再写一套渲染。
 */
function toPrice(row) {
  if (!row) return null;
  const packQty = num(row.pack_qty);
  const smallUnit = String(row.small_unit || '');
  return {
    ok: true,
    manual: true,                       // 页面据此显示「手工」标签
    cached: true,
    goodsId: '',
    goodsName: String(row.goods_name || ''),
    picture: '',
    unitPrice: num(row.unit_price),
    saleIP: num(row.pack_price),
    packingSpecification: packQty,
    smallUnit,
    spec: packQty == null ? String(row.spec || '') : (String(packQty) + smallUnit),
    note: String(row.note || ''),
    updatedBy: String(row.updated_by || ''),
    fetchedAt: fmtTime(row.updated_at),
  };
}

/**
 * 列表用：按品牌取一批 SKU 的手工价。
 * @returns {Object} { '<brandId>:<sku>': 价格对象 } —— 键与前端 pkey 同形（品牌前缀防串品牌）
 */
async function readManual({ brandId, skus, kind } = {}) {
  const kk = safeKind(kind);
  if (!kk.ok) return {};
  const k = kk.kind;
  const bid = Number(brandId) || 0;
  const list = [...new Set((skus || []).map((x) => str(x, 64)).filter(Boolean))];
  const out = {};
  if (!list.length) return out;
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    const rows = await db.query(
      `SELECT brand_id, sku, goods_name, unit_price, pack_price, pack_qty, spec, small_unit, note,
              updated_by, updated_at
         FROM product_price_manual
        WHERE kind = ? AND brand_id = ? AND sku IN (${part.map(() => '?').join(',')})`,
      [k, bid, ...part]
    ).catch(() => []);
    for (const r of rows) out[`${Number(r.brand_id) || 0}:${String(r.sku)}`] = toPrice(r);
  }
  return out;
}

/**
 * 比价用：把若干 (brandId, sku) 的手工价拼成 { '<kind>:<brandId>:<sku>': {...} }。
 * rows 直接传比价的行（每行有 brand_id / sku），按品牌分组查，避免大量 OR 条件。
 */
async function readManualMap({ rows, kind } = {}) {
  const kk = safeKind(kind);
  if (!kk.ok) return {};
  const k = kk.kind;
  const byBrand = new Map();
  for (const r of rows || []) {
    const bid = Number(r.brand_id) || 0;
    const sku = str(r.sku, 64);
    if (!sku) continue;
    if (!byBrand.has(bid)) byBrand.set(bid, new Set());
    byBrand.get(bid).add(sku);
  }
  const out = {};
  for (const [bid, set] of byBrand) {
    const map = await readManual({ brandId: bid, skus: [...set], kind: k });
    for (const [key, v] of Object.entries(map)) {
      const sku = key.slice(key.indexOf(':') + 1);
      // ⚠ 这里返回的是**比价口径**（unitPrice/packPrice/packQty/spec），
      //   不是页面口径（saleIP/packingSpecification）。两者混用会让比价悄悄退回本地规格。
      out[`${k}:${bid}:${sku}`] = {
        unitPrice: v.unitPrice, packPrice: v.saleIP, packQty: v.packingSpecification,
        spec: v.spec || '', note: v.note || '', manual: true,
      };
    }
  }
  return out;
}

/**
 * 保存（新增或覆盖）一条手工价。
 * @param {{brandId:number, sku:string, kind?:string, goodsName?:string,
 *          mode?:'unit'|'pack', unitPrice?:any, packPrice?:any, specQty?:any,
 *          spec?:string, smallUnit?:string, note?:string, operator?:string}} o
 * @returns {{ok:true, price:object}|{ok:false, error:string}}
 */
async function saveManual(o = {}) {
  const kk = safeKind(o.kind);
  if (!kk.ok) return { ok: false, error: kk.error };
  const kind = kk.kind;
  const sku = str(o.sku, 64);
  if (!sku) return { ok: false, error: '缺少商品SKU' };
  const brandId = Number(o.brandId) || 0;
  if (brandId <= 0) return { ok: false, error: '缺少品牌方，无法保存手工价' };

  // 单价/整件价互算与「本地价」同一套规则：改了哪个就按哪个算，另一个按规格折算
  const calc = calcLocalPrice({
    mode: o.mode, unitPrice: o.unitPrice, packPrice: o.packPrice, specQty: o.specQty,
  });
  if (!calc.ok) return { ok: false, error: calc.error };
  if (calc.unitPrice == null && calc.packPrice == null) {
    return { ok: false, error: '单价与整件价至少填一个' };
  }
  // 规格数量缺了但单价与整件价都有 → 反推规格（省得让人三次手算）
  let packQty = calc.specQty;
  if (packQty == null && calc.unitPrice != null && calc.packPrice != null && calc.unitPrice > 0) {
    const q = Math.round((calc.packPrice / calc.unitPrice) * 100) / 100;
    if (Number.isFinite(q) && q > 0) packQty = q;
  }

  await db.exec(
    `INSERT INTO product_price_manual
       (brand_id, sku, kind, goods_name, unit_price, pack_price, pack_qty, spec, small_unit, note, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       goods_name = VALUES(goods_name), unit_price = VALUES(unit_price),
       pack_price = VALUES(pack_price), pack_qty = VALUES(pack_qty),
       spec = VALUES(spec), small_unit = VALUES(small_unit),
       note = VALUES(note), updated_by = VALUES(updated_by)`,
    [brandId, sku, kind, str(o.goodsName, 512), calc.unitPrice, calc.packPrice, packQty,
      str(o.spec, 64) || null, str(o.smallUnit, 16) || null, str(o.note, 255) || null,
      str(o.operator, 64) || null]);

  const again = await db.query(
    'SELECT brand_id, sku, goods_name, unit_price, pack_price, pack_qty, spec, small_unit, note, updated_by, updated_at '
    + 'FROM product_price_manual WHERE kind = ? AND brand_id = ? AND sku = ?',
    [kind, brandId, sku]);
  return { ok: true, sku, brandId, kind, price: toPrice(again[0]) };
}

/** 取消手工价（回到平台价） */
async function clearManual({ brandId, sku, kind } = {}) {
  const kk = safeKind(kind);
  if (!kk.ok) return { ok: false, error: kk.error };
  const k = kk.kind;
  const s = str(sku, 64);
  if (!s) return { ok: false, error: '缺少商品SKU' };
  const r = await db.exec(
    'DELETE FROM product_price_manual WHERE kind = ? AND brand_id = ? AND sku = ?',
    [k, Number(brandId) || 0, s]);
  return { ok: true, sku: s, removed: r.affectedRows || 0 };
}

module.exports = {
  KINDS, DEFAULT_KIND, toPrice, readManual, readManualMap, saveManual, clearManual, fmtTime, safeKind,
};
