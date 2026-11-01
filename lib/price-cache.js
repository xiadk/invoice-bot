/**
 * 平台商品价格缓存（齐货通 / 城配速达）：**取过一次价就持久化，页面查询优先读库**。
 *
 * 口径：
 *   · 唯一键 (kind, brand_id, goods_id) —— 按品牌方共用一份（不同品牌方拿到的协议价可能不同）。
 *   · 永久有效，不设过期；价格变化靠页面「重新取价」强制刷新（mode=refresh）来更新。
 *   · 只缓存成功（ok=true）的结果；失败项不入库，下次取价会重新尝试。
 *   · 存的是页面直接要用的字段：折合单价 unit_price、整件价 pack_price、一件多少小单位 pack_qty。
 *     读出来再按 kind 还原成页面模板认识的字段名（qht: saleIP/packingSpecification/smallUnit，
 *     afa: salePrice/unitFactor/factorName），这样页面模板一行都不用改。
 */
const db = require('../db');

const KINDS = ['qht', 'afa'];

function normKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (!KINDS.includes(k)) throw new Error('未知价格来源：' + kind);
  return k;
}

function num(v) {
  // 注意：Number(null)=0、Number('')=0，直接用会把「没有这个字段」写成 0 元，必须先挡掉
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** DATETIME → 'MM-DD HH:mm'（页面「缓存于 …」直接用） */
function fmtTime(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 远端价格对象 → 缓存行字段（两种平台差异在此收敛） */
function toRow(kind, goodsId, v) {
  const gid = String(goodsId == null ? '' : goodsId).trim();
  if (kind === 'qht') {
    const packQty = num(v.packingSpecification);
    const smallUnit = String(v.smallUnit || '');
    return {
      goodsId: gid,
      goodsName: String(v.goodsName || '').slice(0, 500),
      unitPrice: num(v.unitPrice),
      packPrice: num(v.saleIP),
      packQty,
      spec: (packQty == null ? '' : String(packQty)) + smallUnit,
      smallUnit,
      picture: String(v.picture || '').slice(0, 500) || null,
    };
  }
  return {
    goodsId: gid,
    goodsName: String(v.goodsName || '').slice(0, 500),
    unitPrice: num(v.unitPrice),
    packPrice: num(v.salePrice),
    packQty: num(v.unitFactor),
    spec: String(v.factorName || '').slice(0, 60),
    smallUnit: null,
    picture: String(v.picture || '').slice(0, 500) || null,
  };
}

/** 缓存行 → 页面价格对象（字段名与 lib/qht.js pick、lib/afa.js shape 保持一致） */
function toPrice(kind, row) {
  const base = {
    ok: true,
    cached: true,
    goodsId: String(row.goods_id),
    goodsName: String(row.goods_name || ''),
    picture: String(row.picture || ''),
    unitPrice: num(row.unit_price),
    fetchedAt: fmtTime(row.fetched_at),
  };
  if (kind === 'qht') {
    return {
      ...base,
      saleIP: num(row.pack_price),
      packingSpecification: num(row.pack_qty),
      smallUnit: String(row.small_unit || ''),
      largeUnit: '',
      isHaveStock: null,
      statusName: '',
    };
  }
  return {
    ...base,
    salePrice: num(row.pack_price),
    unitFactor: num(row.pack_qty),
    factorName: String(row.spec || ''),
    barcode: '',
  };
}

/**
 * 读缓存：返回 { [goodsId]: 价格对象 }，没缓存的不返回（页面显示「未取价」）。
 * @param {'qht'|'afa'} kind
 * @param {number} brandId 品牌方（同品牌共用一份；0=未指定）
 * @param {Array<string|number>} goodsIds
 */
async function readPrices(kind, brandId, goodsIds) {
  const k = normKind(kind);
  const bid = Number(brandId) || 0;
  const ids = [...new Set((goodsIds || []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
  const out = {};
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = await db.query(
      'SELECT goods_id, goods_name, unit_price, pack_price, pack_qty, spec, small_unit, picture, fetched_at '
      + 'FROM goods_price_cache WHERE kind = ? AND brand_id = ? AND goods_id IN ('
      + part.map(() => '?').join(',') + ')',
      [k, bid, ...part]
    ).catch(() => []);
    for (const r of rows) out[String(r.goods_id)] = toPrice(k, r);
  }
  return out;
}

/**
 * 写缓存（批量 upsert）：只写成功项，失败项跳过，保证「取价失败」不会把上一次的好价冲掉。
 * @returns {number} 写入条数
 */
async function savePrices(kind, brandId, prices) {
  const k = normKind(kind);
  const bid = Number(brandId) || 0;
  const list = Object.entries(prices || {}).filter(([, v]) => v && v.ok && v.goodsId != null)
    .map(([gid, v]) => [gid, v]);
  if (!list.length) return 0;
  const COLS = ['kind', 'brand_id', 'goods_id', 'goods_name', 'unit_price', 'pack_price', 'pack_qty',
    'spec', 'small_unit', 'picture', 'raw_json', 'fetched_at'];
  const holders = [];
  const args = [];
  const now = new Date();
  for (const [gid, v] of list) {
    const m = toRow(k, gid, v);
    if (!m.goodsId) continue;
    holders.push('(' + COLS.map(() => '?').join(', ') + ')');
    args.push(k, bid, m.goodsId, m.goodsName, m.unitPrice, m.packPrice, m.packQty,
      m.spec, m.smallUnit, m.picture, JSON.stringify(v).slice(0, 8000), now);
  }
  if (!holders.length) return 0;
  await db.exec(
    'INSERT INTO goods_price_cache (' + COLS.join(', ') + ') VALUES ' + holders.join(', ')
    + ' ON DUPLICATE KEY UPDATE goods_name = VALUES(goods_name), unit_price = VALUES(unit_price),'
    + ' pack_price = VALUES(pack_price), pack_qty = VALUES(pack_qty), spec = VALUES(spec),'
    + ' small_unit = VALUES(small_unit), picture = VALUES(picture), raw_json = VALUES(raw_json),'
    + ' fetched_at = VALUES(fetched_at)',
    args
  );
  return holders.length;
}

module.exports = { readPrices, savePrices, toPrice, toRow, fmtTime };
