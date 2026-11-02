/**
 * lib/supplier-after.js — 供应商售后台账（v0.3.2）
 *
 * 业务口径：
 *   · 售后管理菜单从 v0.3.2 起整页替换为「针对供应商的售后」，与牵牛花退单彻底脱钩：
 *     之前读 qnh_refund_order / qnh_after_manual 的旧页面不再保留，但旧数据都留在库里。
 *   · 一条售后 = 供应商（supplier 字典）+ 售后内容 + 金额 + 售后日期 + 状态 + 凭证图。
 *     供应商名称登记时冗余一份快照；展示优先取当前名（改名后旧记录跟着变），取不到回落快照。
 *   · 状态四档人工推进：0 待处理 → 1 已申请 → 2 已退货 → 3 已退款，一键下一档；
 *     每次推进必须传一张凭证图（存 qnh_after_attach，row_key = sup:<id>，七牛只存 key）。
 *     与 v0.2.108 的售后凭证同一套存储，旧凭证（ref:/man: 前缀）不受影响。
 *   · 数据归属与供应商/货单一致：user_id = 主体账号，员工录入归属所属主体。
 */
const db = require('../db');
const qiniu = require('./qiniu');

const MAX_AMOUNT = 99999999.99;     // 与 DECIMAL(12,2) 对齐

const AFTER_STATUSES = [
  { value: 0, label: '待处理', tag: 'info' },
  { value: 1, label: '已申请', tag: 'warning' },
  { value: 2, label: '已退货', tag: '' },
  { value: 3, label: '已退款', tag: 'success' },
];

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

/** 凭证行键：sup:<台账id>（旧数据是 ref:<退单号> / man:<手工售后id>，互不干扰） */
const rowKeyOf = (id) => 'sup:' + Number(id);

/**
 * 各状态数量（顶部统计卡）。
 */
async function afterCounts(userId) {
  const rows = await db.query(
    'SELECT status AS s, COUNT(*) AS n FROM supplier_after WHERE user_id = ? GROUP BY status',
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
 * 售后列表：按供应商 / 状态 / 日期区间 / 关键字过滤，库里排序分页。
 * 凭证只对本页行批量取一次（IN），展示链接现签 1 小时。
 * @param {{supplier?:string, status?:string, from?:string, to?:string, keyword?:string,
 *          page?:any, size?:any, userId:number}} q
 */
async function listAfter(q = {}) {
  const uid = Number(q.userId) || 0;
  const pg = Math.max(1, Number(q.page) || 1);
  const sz = Math.min(100, Math.max(1, Number(q.size) || 20));
  const where = ['a.user_id = ?'];
  const args = [uid];

  const sup = Number(q.supplier) || 0;
  if (sup) { where.push('a.supplier_id = ?'); args.push(sup); }

  const st = String(q.status == null ? '' : q.status).trim();
  if (/^[0-3]$/.test(st)) { where.push('a.status = ?'); args.push(Number(st)); }

  const from = normDate(q.from);
  if (from) { where.push('a.after_date >= ?'); args.push(from); }
  const to = normDate(q.to);
  if (to) { where.push('a.after_date <= ?'); args.push(to); }

  const kw = str(q.keyword, 64);
  if (kw) {
    // 名称优先取当前名（JOIN 出来），供应商被删后也能按快照搜到
    where.push('(a.goods_desc LIKE ? OR a.note LIKE ? OR a.supplier_name LIKE ? OR s.name LIKE ?)');
    const like = `%${kw}%`;
    args.push(like, like, like, like);
  }

  const w = where.join(' AND ');
  const [rows, cnt] = await Promise.all([
    db.query(
      `SELECT a.id, a.supplier_id, a.supplier_name, a.goods_desc, a.amount, a.status,
              DATE_FORMAT(a.after_date, '%Y-%m-%d') AS after_date,
              a.note, a.handled_by, a.handled_at, a.created_by,
              DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at,
              s.name AS current_name
         FROM supplier_after a
         LEFT JOIN supplier s ON s.id = a.supplier_id AND s.user_id = a.user_id
        WHERE ${w}
        ORDER BY a.after_date DESC, a.id DESC
        LIMIT ${sz} OFFSET ${(pg - 1) * sz}`, args),
    db.query(
      `SELECT COUNT(*) AS n FROM supplier_after a
         LEFT JOIN supplier s ON s.id = a.supplier_id AND s.user_id = a.user_id
        WHERE ${w}`, args),
  ]);

  // 本页凭证一次带出（别用 GROUP_CONCAT，会截断）。⚠ row_key 存的是 'sup:<id>'，参数要拼成键
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
    const id = Number(String(t.row_key).replace(/^sup:/, '')) || 0;
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
      supplierId: Number(r.supplier_id) || 0,
      supplierName: (r.current_name || r.supplier_name || '—'),
      goodsDesc: r.goods_desc || '',
      amount: Number(r.amount) || 0,
      afterDate: r.after_date,
      status: Number(r.status) || 0,
      statusLabel: statusLabel(r.status),
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

/** 单条详情（凭证弹窗 / 行点开用），结构与列表行一致 */
async function getAfter({ userId, id }) {
  const uid = Number(userId) || 0;
  const wid = Number(id) || 0;
  if (!wid) return { ok: false, error: '缺少记录 id' };
  const rows = await db.query(
    `SELECT a.id, a.supplier_id, a.supplier_name, a.goods_desc, a.amount, a.status,
            DATE_FORMAT(a.after_date, '%Y-%m-%d') AS after_date,
            a.note, a.handled_by, a.handled_at, a.created_by,
            DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at,
            s.name AS current_name
       FROM supplier_after a
       LEFT JOIN supplier s ON s.id = a.supplier_id AND s.user_id = a.user_id
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
      supplierId: Number(r.supplier_id) || 0,
      supplierName: (r.current_name || r.supplier_name || '—'),
      goodsDesc: r.goods_desc || '',
      amount: Number(r.amount) || 0,
      afterDate: r.after_date,
      status: Number(r.status) || 0,
      statusLabel: statusLabel(r.status),
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

/** 下拉用：全部供应商（不分页，按名称排序）—— 与货单共用同一本供应商字典 */
async function allSuppliers(userId) {
  const rows = await db.query(
    'SELECT id, name FROM supplier WHERE user_id = ? ORDER BY name ASC LIMIT 2000', [Number(userId) || 0]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

/** 新增一条供应商售后（登记时只填信息，凭证在状态推进时必传） */
async function createAfter({ userId, supplierId, goodsDesc, amount, afterDate, note, operator }) {
  const uid = Number(userId) || 0;
  const sid = Number(supplierId) || 0;
  if (!sid) return { ok: false, error: '请选择供应商（先到供应商管理里维护）' };
  const desc = str(goodsDesc, 512);
  if (!desc) return { ok: false, error: '请填写售后内容（商品 / 事由描述）' };

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) return { ok: false, error: '售后金额要填不小于 0 的数字' };
  if (amt > MAX_AMOUNT) return { ok: false, error: '售后金额太大了（上限 ' + MAX_AMOUNT + '）' };

  const date = normDate(afterDate);
  if (!date) return { ok: false, error: '售后日期要填 YYYY-MM-DD，且是真实存在的日期' };

  const sup = await db.query('SELECT id, name FROM supplier WHERE id = ? AND user_id = ?', [sid, uid]);
  if (!sup.length) return { ok: false, error: '供应商不存在（可能已被删除），请重新选择' };

  const r = await db.exec(
    `INSERT INTO supplier_after
       (user_id, supplier_id, supplier_name, goods_desc, amount, after_date, status, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [uid, sid, sup[0].name, desc, amt.toFixed(2), date, str(note, 255) || null, str(operator, 64) || null]);
  return { ok: true, id: Number(r.insertId), supplierName: sup[0].name };
}

/** 删除一条（凭证记录一起删；七牛对象不删，误删还能到控制台找回） */
async function deleteAfter({ userId, id }) {
  const uid = Number(userId) || 0;
  const wid = Number(id) || 0;
  if (!wid) return { ok: false, error: '缺少记录 id' };
  const rows = await db.query(
    'SELECT id, goods_desc, supplier_name FROM supplier_after WHERE id = ? AND user_id = ?', [wid, uid]);
  if (!rows.length) return { ok: false, error: '记录不存在（可能已被删除）' };
  await db.transaction(async (conn) => {
    await conn.query('DELETE FROM supplier_after WHERE id = ? AND user_id = ?', [wid, uid]);
    await conn.query('DELETE FROM qnh_after_attach WHERE user_id = ? AND row_key = ?', [uid, rowKeyOf(wid)]);
  });
  return { ok: true, id: wid, goodsDesc: rows[0].goods_desc, supplierName: rows[0].supplier_name };
}

/**
 * 一键推进下一档（0→1→2→3），必须带一张凭证图（图已由路由层传完七牛、拿 key 传进来）。
 * 状态由服务端按「当前 +1」计算，不信任前端传值 —— 到 3 已退款后不可再推进。
 */
async function advanceAfter({ userId, id, note, imageKey, imageMime, imageSize, operator }) {
  const uid = Number(userId) || 0;
  const wid = Number(id) || 0;
  if (!wid) return { ok: false, error: '缺少记录 id' };
  if (!imageKey) return { ok: false, error: '请先上传售后凭证图片（每次推进都要留一张）' };

  const rows = await db.query('SELECT id, status FROM supplier_after WHERE id = ? AND user_id = ?', [wid, uid]);
  if (!rows.length) return { ok: false, error: '记录不存在（可能已被删除）' };
  const cur = Number(rows[0].status) || 0;
  if (cur >= 3) return { ok: false, error: '这条售后已到「已退款」，流程结束' };
  const next = cur + 1;

  await db.transaction(async (conn) => {
    await conn.query(
      'INSERT INTO qnh_after_attach (user_id, row_key, status, object_key, mime, size, note, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [uid, rowKeyOf(wid), next, imageKey, imageMime || null, imageSize || null,
        str(note, 255) || null, str(operator, 64) || null]);
    await conn.query(
      'UPDATE supplier_after SET status = ?, note = ?, handled_by = ?, handled_at = NOW() WHERE id = ? AND user_id = ?',
      [next, str(note, 255) || null, str(operator, 64) || null, wid, uid]);
  });
  return { ok: true, id: wid, status: next, statusLabel: statusLabel(next), imageKey };
}

module.exports = {
  AFTER_STATUSES,
  afterCounts, listAfter, getAfter, createAfter, deleteAfter, advanceAfter, allSuppliers,
};
