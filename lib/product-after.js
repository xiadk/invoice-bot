/**
 * lib/product-after.js — 商品售后台账（v0.3.25）
 *
 * 业务口径：
 *   · 「供应商售后」自 v0.3.25 起整页换成「商品售后」：台账主体是可售商品（名称 + SKU），
 *     不再绑定供应商、不再记金额；旧的 supplier_after 数据由 sql/upgrade/0.3.25 清理。
 *   · 一条售后 = 商品名称 + SKU + 数量 + 售后原因 + 售后日期 + 状态 + 运单号（已退货）+ 图片。
 *   · 状态四档人工推进：0 待处理 → 1 已申请 → 2 已退货（必填运单号）→ 3 已退款（必传退款截图）。
 *     允许在四档之间任意改（点错了能改回来），每次改动记处理人/时间。
 *   · 图片统一存 qnh_after_attach，行键 pa:<id>：status=0 是新建时的商品实物图，status=3 是退款截图。
 *     七牛只存 object_key，列表展示时现签 1 小时临时链接。
 *   · 数据归属与商品/货单一致：user_id = 主体账号，员工录入归属所属主体。
 */
const db = require('../db');
const qiniu = require('./qiniu');

const AFTER_STATUSES = [
  { value: 0, label: '待处理', tag: 'info' },
  { value: 1, label: '已申请', tag: 'warning' },
  { value: 2, label: '已退货', tag: '' },
  { value: 3, label: '已退款', tag: 'success' },
];

const MAX_QTY = 99999;
const MAX_IMAGES = 6;

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function statusLabel(v) {
  const hit = AFTER_STATUSES.find((s) => s.value === Number(v));
  return hit ? hit.label : '待处理';
}

/** 日期只认 YYYY-MM-DD，并且要是真实存在的日期（挡掉 2026-02-31） */
function normDate(v) {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  const back = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return back === s ? s : '';
}

/** 附件行键：pa:<台账id>（旧数据 ref:/man:/sup: 前缀互不干扰） */
const rowKeyOf = (id) => 'pa:' + Number(id);

/** 各状态数量（顶部统计卡） */
async function afterCounts(userId) {
  const rows = await db.query(
    'SELECT status AS s, COUNT(*) AS n FROM product_after WHERE user_id = ? GROUP BY status',
    [Number(userId) || 0]);
  const out = { all: 0, 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const r of rows) {
    const s = Number(r.s) || 0;
    const n = Number(r.n) || 0;
    out.all += n;
    if (out[s] !== undefined) out[s] += n;
  }
  return out;
}

/**
 * 售后列表：按商品名称 / SKU / 状态 / 日期区间过滤，库里排序分页。
 * 凭证只对本页行批量取一次（IN），展示链接现签 1 小时。
 * @param {{goodsName?:string, sku?:string, status?:string, from?:string, to?:string,
 *          page?:any, size?:any, userId:number}} q
 */
async function listAfter(q = {}) {
  const uid = Number(q.userId) || 0;
  const pg = Math.max(1, Number(q.page) || 1);
  const sz = Math.min(100, Math.max(1, Number(q.size) || 20));
  const where = ['a.user_id = ?'];
  const args = [uid];

  const name = str(q.goodsName, 128);
  if (name) { where.push('a.goods_name LIKE ?'); args.push(`%${name}%`); }

  const sku = str(q.sku, 64);
  if (sku) { where.push('a.sku LIKE ?'); args.push(`%${sku}%`); }

  const st = String(q.status == null ? '' : q.status).trim();
  if (/^[0-3]$/.test(st)) { where.push('a.status = ?'); args.push(Number(st)); }

  const from = normDate(q.from);
  if (from) { where.push('a.after_date >= ?'); args.push(from); }
  const to = normDate(q.to);
  if (to) { where.push('a.after_date <= ?'); args.push(to); }

  const w = where.join(' AND ');
  const [rows, cnt] = await Promise.all([
    db.query(
      `SELECT a.id, a.goods_name, a.sku, a.qty, a.after_reason, a.status, a.waybill_no,
              DATE_FORMAT(a.after_date, '%Y-%m-%d') AS after_date,
              a.note, a.handled_by, a.handled_at, a.created_by,
              DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at
         FROM product_after a
        WHERE ${w}
        ORDER BY a.after_date DESC, a.id DESC
        LIMIT ${sz} OFFSET ${(pg - 1) * sz}`, args),
    db.query(`SELECT COUNT(*) AS n FROM product_after a WHERE ${w}`, args),
  ]);

  // 本页凭证一次带出（别用 GROUP_CONCAT，会截断）。⚠ row_key 存的是 'pa:<id>'
  const ids = rows.map((r) => Number(r.id));
  let atts = [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    atts = await db.query(
      `SELECT id, row_key, status, object_key, note, created_by,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
         FROM qnh_after_attach
        WHERE user_id = ? AND row_key IN (${marks})
        ORDER BY id DESC`, [uid, ...ids.map(rowKeyOf)]);
  }
  const byRow = new Map();
  for (const t of atts) {
    const id = Number(String(t.row_key).replace(/^pa:/, '')) || 0;
    if (!byRow.has(id)) byRow.set(id, []);
    byRow.get(id).push({
      id: Number(t.id),
      status: Number(t.status) || 0,
      statusLabel: statusLabel(t.status),
      url: qiniu.isEnabled() ? qiniu.signUrl(t.object_key, 3600) : '',
      note: t.note || '',
      by: t.created_by || '',
      at: t.created_at,
    });
  }

  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      key: rowKeyOf(r.id),
      goodsName: r.goods_name || '',
      sku: r.sku || '',
      qty: Number(r.qty) || 0,
      afterReason: r.after_reason || '',
      afterDate: r.after_date,
      status: Number(r.status) || 0,
      statusLabel: statusLabel(r.status),
      waybillNo: r.waybill_no || '',
      note: r.note || '',
      handledBy: r.handled_by || '',
      handledAt: r.handled_at,
      createdBy: r.created_by || '',
      createdAt: r.created_at,
      attaches: byRow.get(Number(r.id)) || [],
    })),
    total: Number(cnt[0].n) || 0,
    page: pg, size: sz,
  };
}

/** 单条详情（凭证弹窗 / 处理弹窗取当前状态用） */
async function getAfter({ userId, id }) {
  const uid = Number(userId) || 0;
  const wid = Number(id) || 0;
  if (!wid) return { ok: false, error: '缺少记录 id' };
  const rows = await db.query(
    `SELECT a.id, a.goods_name, a.sku, a.qty, a.after_reason, a.status, a.waybill_no,
            DATE_FORMAT(a.after_date, '%Y-%m-%d') AS after_date,
            a.note, a.handled_by, a.handled_at, a.created_by,
            DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM product_after a
      WHERE a.id = ? AND a.user_id = ?`, [wid, uid]);
  if (!rows.length) return { ok: false, error: '记录不存在（可能已被删除）' };
  const r = rows[0];
  const atts = await db.query(
    `SELECT id, status, object_key, note, created_by,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM qnh_after_attach
      WHERE user_id = ? AND row_key = ?
      ORDER BY id DESC`, [uid, rowKeyOf(wid)]);
  return {
    ok: true,
    after: {
      id: wid,
      key: rowKeyOf(wid),
      goodsName: r.goods_name || '',
      sku: r.sku || '',
      qty: Number(r.qty) || 0,
      afterReason: r.after_reason || '',
      afterDate: r.after_date,
      status: Number(r.status) || 0,
      statusLabel: statusLabel(r.status),
      waybillNo: r.waybill_no || '',
      note: r.note || '',
      handledBy: r.handled_by || '',
      handledAt: r.handled_at,
      createdBy: r.created_by || '',
      createdAt: r.created_at,
      attaches: atts.map((t) => ({
        id: Number(t.id),
        status: Number(t.status) || 0,
        statusLabel: statusLabel(t.status),
        url: qiniu.isEnabled() ? qiniu.signUrl(t.object_key, 3600) : '',
        note: t.note || '',
        by: t.created_by || '',
        at: t.created_at,
      })),
    },
  };
}

/**
 * 商品模糊搜索（新增售后用）：只在品牌商品库 brand_product 里搜。
 * 普通账号锁定自己所属品牌；超管可搜全部品牌（?brand=<id> 收窄）。
 * @returns {{ok:true, rows:Array}}
 */
async function searchProducts({ brandId, all, keyword, limit }) {
  const kw = str(keyword, 64);
  const lim = Math.min(50, Math.max(1, Number(limit) || 20));
  const where = ['1=1'];
  const args = [];
  if (!all) { where.push('bp.brand_id = ?'); args.push(Number(brandId) || 1); }
  if (kw) {
    where.push('(bp.sku LIKE ? OR bp.goods_name LIKE ?)');
    args.push(`%${kw}%`, `%${kw}%`);
  }
  const rows = await db.query(
    `SELECT bp.sku, bp.goods_name, bp.brand_id, bp.image_url, b.name AS brand_name
       FROM brand_product bp
       LEFT JOIN brand b ON b.id = bp.brand_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${kw ? '(bp.sku = ?) DESC,' : ''} bp.updated_at DESC, bp.id DESC
      LIMIT ${lim}`,
    kw ? [...args, kw] : args);
  return {
    ok: true,
    rows: rows.map((r) => ({
      sku: r.sku || '',
      goodsName: r.goods_name || '',
      brandId: Number(r.brand_id) || 0,
      brandName: r.brand_name || '',
      imageUrl: r.image_url || '',
    })),
  };
}

/** 把「本次上传暂存的图」写进售后凭证表（七牛对象复用，不重复上传） */
async function bindImages(conn, { userId, id, status, images, operator, note }) {
  for (const im of images) {
    await conn.query(
      'INSERT INTO qnh_after_attach (user_id, row_key, status, object_key, mime, size, note, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, rowKeyOf(id), status, im.objectKey, im.mime || null, im.size || null,
        str(note, 255) || null, str(operator, 64) || null]);
  }
}

/**
 * 新增一条商品售后（状态一律从「待处理」开始）。
 * @param {{userId:number, goodsName:string, sku:string, qty:any, afterReason:string,
 *          afterDate:string, note:string, operator:string, images:Array}} p
 */
async function createAfter(p = {}) {
  const uid = Number(p.userId) || 0;
  const goodsName = str(p.goodsName, 255);
  if (!goodsName) return { ok: false, error: '请填写商品名称（或从商品库里搜一个）' };
  const sku = str(p.sku, 64);
  if (!sku) return { ok: false, error: '请填写商品 SKU（或从商品库里搜一个）' };

  const qty = Number(p.qty);
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: '数量要填不小于 1 的整数' };
  if (qty > MAX_QTY) return { ok: false, error: '数量太大了（上限 ' + MAX_QTY + '）' };

  const date = normDate(p.afterDate);
  if (!date) return { ok: false, error: '售后日期要填 YYYY-MM-DD，且是真实存在的日期' };

  const images = Array.isArray(p.images) ? p.images.slice(0, MAX_IMAGES) : [];
  if (!images.length) return { ok: false, error: '请上传至少 1 张商品实物图片' };

  const reason = str(p.afterReason, 255);
  if (!reason) return { ok: false, error: '请填写售后原因' };

  let newId = 0;
  await db.transaction(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO product_after
         (user_id, goods_name, sku, qty, after_reason, after_date, status, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [uid, goodsName, sku, qty, reason, date, str(p.note, 255) || null, str(p.operator, 64) || null]);
    newId = Number(r.insertId) || 0;
    await bindImages(conn, {
      userId: uid, id: newId, status: 0, images, operator: p.operator, note: '新建售后 · 商品实物图',
    });
  });
  return { ok: true, id: newId, goodsName, sku, qty, status: 0, statusLabel: statusLabel(0) };
}

/** 删除一条（凭证记录一起删；七牛对象不删，误删还能到控制台找回） */
async function deleteAfter({ userId, id }) {
  const uid = Number(userId) || 0;
  const wid = Number(id) || 0;
  if (!wid) return { ok: false, error: '缺少记录 id' };
  const rows = await db.query(
    'SELECT id, goods_name, sku, after_date FROM product_after WHERE id = ? AND user_id = ?', [wid, uid]);
  if (!rows.length) return { ok: false, error: '记录不存在（可能已被删除）' };
  await db.transaction(async (conn) => {
    await conn.query('DELETE FROM product_after WHERE id = ? AND user_id = ?', [wid, uid]);
    await conn.query('DELETE FROM qnh_after_attach WHERE user_id = ? AND row_key = ?', [uid, rowKeyOf(wid)]);
  });
  return { ok: true, id: wid, goodsName: rows[0].goods_name, sku: rows[0].sku, afterDate: rows[0].after_date };
}

/**
 * 状态变更（四档任选）：
 *   · 改到「已退货」必须填运单号；
 *   · 改到「已退款」必须带一张退款截图（图已由路由层从上传令牌取到，传 object_key 进来）。
 * 状态由前端显式传值，服务端只校验取值 0-3，不推算「下一档」—— 点错了能直接改回来。
 */
async function setStatus(p = {}) {
  const uid = Number(p.userId) || 0;
  const wid = Number(p.id) || 0;
  if (!wid) return { ok: false, error: '缺少记录 id' };
  const next = Number(p.status);
  if (!Number.isInteger(next) || !AFTER_STATUSES.some((s) => s.value === next)) {
    return { ok: false, error: '状态只能是 待处理 / 已申请 / 已退货 / 已退款' };
  }

  const rows = await db.query(
    'SELECT id, status, waybill_no, goods_name FROM product_after WHERE id = ? AND user_id = ?', [wid, uid]);
  if (!rows.length) return { ok: false, error: '记录不存在（可能已被删除）' };
  const cur = Number(rows[0].status) || 0;

  const waybillNo = str(p.waybillNo, 64);
  const hadWaybill = str(rows[0].waybill_no, 64);
  if (next === 2 && !waybillNo && !hadWaybill) return { ok: false, error: '改到「已退货」必须填运单号' };
  const images = Array.isArray(p.images) ? p.images.slice(0, MAX_IMAGES) : [];
  // 已经到过「已退款」的（补备注 / 改回再改回来）不再强制补图，原来的截图还在凭证里
  if (next === 3 && cur !== 3 && !images.length) {
    return { ok: false, error: '改到「已退款」必须上传一张退款截图' };
  }

  const keepWaybill = waybillNo || str(rows[0].waybill_no, 64);
  await db.transaction(async (conn) => {
    if (images.length) {
      await bindImages(conn, {
        userId: uid, id: wid, status: next, images, operator: p.operator,
        note: next === 3 ? '已退款截图' : '状态变更凭证',
      });
    }
    await conn.query(
      `UPDATE product_after
          SET status = ?, waybill_no = ?, note = ?, handled_by = ?, handled_at = NOW()
        WHERE id = ? AND user_id = ?`,
      [next, keepWaybill || null, str(p.note, 255) || null, str(p.operator, 64) || null, wid, uid]);
  });
  return {
    ok: true, id: wid, from: cur, status: next, statusLabel: statusLabel(next), waybillNo: keepWaybill,
  };
}

module.exports = {
  AFTER_STATUSES, MAX_IMAGES,
  afterCounts, listAfter, getAfter, createAfter, deleteAfter, setStatus, searchProducts,
};
