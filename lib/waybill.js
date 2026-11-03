/**
 * lib/waybill.js — 供应商 + 货单管理（采购台账，v0.3.0）
 *
 * 业务口径：
 *   · 供应商是本系统自己维护的字典（不连任何平台），按账号隔离（user_id = 数据归属主体）。
 *     员工录入的供应商/货单归属所属主体账号，老板能看到全部。
 *   · 货单 = 一次采购：供应商 + 金额 + 货单日期 + 若干张货单图片（拍照/截图）。
 *     建单时把供应商名称冗余一份到 waybill.supplier_name，供应商被删也不至于变成空白；
 *     展示时优先取 supplier 表里的当前名字（改了名旧单跟着变），取不到才回落到快照。
 *   · 图片存七牛，库里只存对象 key；展示时由 lib/qiniu.js 现签临时链接（1 小时）。
 *
 * 手机上传（为什么要这样做）：
 *   货单照片通常拍在手机上，而员工干活是在电脑前。做法是电脑端生成一个 5 分钟有效的
 *   临时链接（二维码），手机扫码打开 m-upload.html 直接传，图片先挂在这个 token 下
 *   （waybill_id=0），电脑端点「保存」时一次性绑到新货单上。token 只能传图，不能读任何
 *   已有数据，过期即废。
 *
 * ⚠ 别再给上传页加「登录」：扫码的人多半是仓库/司机，没有账号；token 本身就是凭证。
 * ⚠ 删除是软删除（v0.3.7）：只写 waybill.deleted_at，行与图片记录都留着，七牛对象也不删。
 *   列表/统计/供应商计数一律 `deleted_at IS NULL` 过滤；恢复 = 把该列改回 NULL。
 *
 * 员工可见性（v0.3.10）：
 *   员工账号（app_user.owner_id 非空）在货单页只看得到「最近 7 天录入」的货单 —— 按
 *   created_at（新建时间）算，不是货单日期；且不给合计金额。判定只看 owner_id，不看 role，
 *   所以无论是 user 还是被改成 admin 的员工都一样受限。老板/主体账号（owner_id 为 NULL）不受影响。
 *   ⚠ 限制必须在 SQL 里做（restrictDays），前端隐藏只是不显示，改参数就能绕过去。
 */
const crypto = require('crypto');
const db = require('../db');
const qiniu = require('./qiniu');

const TOKEN_TTL_SEC = 300;          // 临时上传链接有效期：5 分钟
const MAX_IMAGES = 9;               // 一个货单最多 9 张图（手机一次选 9 张正好）
const MAX_AMOUNT = 99999999.99;     // 与 DECIMAL(12,2) 对齐
const RATE_WINDOW_MS = 60 * 1000;   // 上传限流窗口
const RATE_MAX = 30;                // 单 IP 单 token 每分钟最多 30 次（正常手拍用不到）

// 员工可见窗口（v0.3.10）：员工账号只看得到最近 7 天**录入**（created_at）的货单，
// 且不给看合计金额。口径见文件头说明，判定只看 owner_id 不看 role。
const STAFF_VISIBLE_DAYS = 7;

// 开票状态（v0.3.6）：两档，只有「未开票 / 已开票」。
// 列表页点一下就在两档之间切，不做更细的流程（用户确认口径）。
const INVOICE_STATUSES = [
  { key: 0, label: '未开票' },
  { key: 1, label: '已开票' },
];
const normInvoice = (v) => (Number(v) === 1 ? 1 : 0);

// ── 上传限流（进程内，够用：单机单实例，重启清零不影响）──
const _hits = new Map();
function rateOk(key) {
  const now = Date.now();
  const arr = (_hits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { _hits.set(key, arr); return false; }
  arr.push(now);
  _hits.set(key, arr);
  if (_hits.size > 3000) {
    for (const [k, v] of _hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) _hits.delete(k);
  }
  return true;
}

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

/** 供应商名称归一：去首尾空白、把连续空白压成一个，避免「ABC 公司」和「ABC  公司」算两个 */
function normName(v) {
  return String(v == null ? '' : v).replace(/[\s\u3000]+/g, ' ').trim().slice(0, 64);
}

/** 日期只认 YYYY-MM-DD（DATE 列），并且要是真实存在的日期（挡掉 2026-02-31） */
function normDate(v) {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  const back = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return back === s ? s : '';
}

// ─────────────────────────────────────────────────────────────────────────
// 供应商
// ─────────────────────────────────────────────────────────────────────────

/** 供应商列表：名称/备注关键字模糊查，带该供应商下的货单数 */
async function listSuppliers({ userId, keyword, page, size }) {
  const kw = str(keyword, 64);
  const pg = Math.max(1, Number(page) || 1);
  const sz = Math.min(100, Math.max(1, Number(size) || 20));
  const where = ['s.user_id = ?'];
  const args = [userId];
  if (kw) { where.push('(s.name LIKE ? OR s.note LIKE ?)'); args.push(`%${kw}%`, `%${kw}%`); }
  const w = where.join(' AND ');
  const [rows, cnt] = await Promise.all([
    db.query(
      `SELECT s.id, s.name, s.note, s.created_by,
              DATE_FORMAT(s.created_at, '%Y-%m-%d %H:%i') AS created_at,
              (SELECT COUNT(*) FROM waybill w WHERE w.supplier_id = s.id AND w.user_id = s.user_id
                  AND w.deleted_at IS NULL) AS waybill_count
         FROM supplier s
        WHERE ${w}
        ORDER BY s.id DESC
        LIMIT ${sz} OFFSET ${(pg - 1) * sz}`, args),
    db.query(`SELECT COUNT(*) AS n FROM supplier s WHERE ${w}`, args),
  ]);
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      note: r.note || '',
      createdBy: r.created_by || '',
      createdAt: r.created_at,
      waybillCount: Number(r.waybill_count) || 0,
    })),
    total: Number(cnt[0].n) || 0,
    page: pg, size: sz,
  };
}

/** 下拉用：全部供应商（不分页，按名称排序），新建货单时选供应商用 */
async function allSuppliers(userId) {
  const rows = await db.query(
    'SELECT id, name FROM supplier WHERE user_id = ? ORDER BY name ASC LIMIT 2000', [userId]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

async function createSupplier({ userId, name, note, operator }) {
  const nm = normName(name);
  if (!nm) return { ok: false, error: '请填写供应商名称' };
  if (nm.length > 64) return { ok: false, error: '供应商名称最长 64 个字' };
  const dup = await db.query('SELECT id FROM supplier WHERE user_id = ? AND name = ?', [userId, nm]);
  if (dup.length) return { ok: false, error: '这个供应商已经在列表里了' };
  const r = await db.exec(
    'INSERT INTO supplier (user_id, name, note, created_by) VALUES (?, ?, ?, ?)',
    [userId, nm, str(note, 255) || null, str(operator, 64) || null]);
  return { ok: true, id: Number(r.insertId), name: nm };
}

/** 改名 / 改备注。改名后旧货单靠 JOIN 显示新名字（supplier_name 只是兜底快照） */
async function updateSupplier({ userId, id, name, note, operator }) {
  const sid = Number(id) || 0;
  if (!sid) return { ok: false, error: '缺少供应商 id' };
  const rows = await db.query('SELECT id, name FROM supplier WHERE id = ? AND user_id = ?', [sid, userId]);
  if (!rows.length) return { ok: false, error: '供应商不存在' };
  const nm = name === undefined ? rows[0].name : normName(name);
  if (!nm) return { ok: false, error: '供应商名称不能为空' };
  if (nm !== rows[0].name) {
    const dup = await db.query('SELECT id FROM supplier WHERE user_id = ? AND name = ? AND id <> ?', [userId, nm, sid]);
    if (dup.length) return { ok: false, error: '已经有同名供应商了' };
  }
  const nv = note === undefined ? undefined : (str(note, 255) || null);
  if (nv === undefined) {
    await db.exec('UPDATE supplier SET name = ? WHERE id = ? AND user_id = ?', [nm, sid, userId]);
  } else {
    await db.exec('UPDATE supplier SET name = ?, note = ? WHERE id = ? AND user_id = ?', [nm, nv, sid, userId]);
  }
  return { ok: true, id: sid, name: nm };
}

/** 删除供应商：已被货单引用就拒绝（否则货单会指向一个不存在的供应商，历史账对不上） */
async function deleteSupplier({ userId, id }) {
  const sid = Number(id) || 0;
  if (!sid) return { ok: false, error: '缺少供应商 id' };
  const rows = await db.query('SELECT id FROM supplier WHERE id = ? AND user_id = ?', [sid, userId]);
  if (!rows.length) return { ok: false, error: '供应商不存在' };
  const used = await db.query(
    'SELECT COUNT(*) AS n FROM waybill WHERE supplier_id = ? AND user_id = ? AND deleted_at IS NULL', [sid, userId]);
  const n = Number(used[0].n) || 0;
  if (n > 0) return { ok: false, error: `该供应商下还有 ${n} 张货单，先把货单删掉才能删除供应商` };
  await db.exec('DELETE FROM supplier WHERE id = ? AND user_id = ?', [sid, userId]);
  return { ok: true, id: sid };
}

// ─────────────────────────────────────────────────────────────────────────
// 货单
// ─────────────────────────────────────────────────────────────────────────

/**
 * 货单列表：按供应商名称（模糊）、货单日期区间、开票状态查，按货单日期倒序。
 * 供应商名取「当前名字」，JOIN 不到才用建单时的快照。
 * 已软删除（deleted_at 非空）的一律不出现，也不进条数/金额合计。
 *
 * @param restrictDays 员工可见窗口（天）。>0 时只返回最近 N 天**录入**（created_at）的货单，
 *                     与货单日期无关；传 0 / 不传 = 不限（老板视角）。
 * @param withSum      false = 不算也不返回合计金额（员工不给看），默认 true。
 */
async function listWaybills({ userId, supplier, from, to, invoiceStatus, page, size, restrictDays, withSum }) {
  const kw = str(supplier, 64);
  const d1 = normDate(from);
  const d2 = normDate(to);
  const inv = str(invoiceStatus, 4);
  const pg = Math.max(1, Number(page) || 1);
  const sz = Math.min(100, Math.max(1, Number(size) || 20));
  // days 先转成整数再拼进 SQL：prepared 参数放 INTERVAL 单位前面在部分 MySQL/MariaDB 版本上
  // 不认，这里已 Number 化，不存在注入
  const days = Math.max(0, Math.trunc(Number(restrictDays) || 0));
  const needSum = withSum !== false;
  const where = ['w.user_id = ?', 'w.deleted_at IS NULL'];
  const args = [userId];
  if (kw) { where.push("COALESCE(s.name, w.supplier_name) LIKE ?"); args.push(`%${kw}%`); }
  if (d1) { where.push('w.bill_date >= ?'); args.push(d1); }
  if (d2) { where.push('w.bill_date <= ?'); args.push(d2); }
  // 开票状态筛选：'' / 'all' = 全部；'0' 未开票；'1' 已开票
  if (inv === '0' || inv === '1') { where.push('w.invoice_status = ?'); args.push(Number(inv)); }
  // 员工窗口：按 created_at 滚动 7 天（用户确认口径），不是 bill_date
  if (days > 0) { where.push(`w.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`); }
  const w = where.join(' AND ');
  const [rows, cnt, sum] = await Promise.all([
    db.query(
      `SELECT w.id, w.supplier_id, COALESCE(s.name, w.supplier_name) AS supplier_name,
              w.amount, DATE_FORMAT(w.bill_date, '%Y-%m-%d') AS bill_date,
              w.invoice_status, w.note, w.created_by,
              DATE_FORMAT(w.created_at, '%Y-%m-%d %H:%i') AS created_at,
              (SELECT COUNT(*) FROM waybill_image i WHERE i.waybill_id = w.id AND i.user_id = w.user_id) AS image_count
         FROM waybill w
         LEFT JOIN supplier s ON s.id = w.supplier_id AND s.user_id = w.user_id
        WHERE ${w}
        ORDER BY w.bill_date DESC, w.id DESC
        LIMIT ${sz} OFFSET ${(pg - 1) * sz}`, args),
    db.query(
      `SELECT COUNT(*) AS n FROM waybill w
         LEFT JOIN supplier s ON s.id = w.supplier_id AND s.user_id = w.user_id
        WHERE ${w}`, args),
    needSum
      ? db.query(
        `SELECT COALESCE(SUM(w.amount), 0) AS amount FROM waybill w
           LEFT JOIN supplier s ON s.id = w.supplier_id AND s.user_id = w.user_id
          WHERE ${w}`, args)
      : Promise.resolve([{ amount: null }]),
  ]);
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      supplierId: Number(r.supplier_id) || 0,
      supplierName: r.supplier_name || '',
      amount: Number(r.amount) || 0,
      billDate: r.bill_date,
      invoiceStatus: normInvoice(r.invoice_status),
      note: r.note || '',
      createdBy: r.created_by || '',
      createdAt: r.created_at,
      imageCount: Number(r.image_count) || 0,
    })),
    total: Number(cnt[0].n) || 0,
    // 员工视角：合计一律 null（前端整块不显示），别在这里算完再由上层抹掉
    sumAmount: needSum ? (Number(sum[0].amount) || 0) : null,
    restrictedDays: days,
    page: pg, size: sz,
  };
}

/** 货单详情：基本信息 + 图片（现签临时链接）；员工同样受近 7 天录入窗口限制 */
async function getWaybill({ userId, id, restrictDays }) {
  const wid = Number(id) || 0;
  if (!wid) return { ok: false, error: '缺少货单 id' };
  const days = Math.max(0, Math.trunc(Number(restrictDays) || 0));
  const args = [wid, userId];
  let winSql = '';
  if (days > 0) { winSql = ` AND w.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`; }
  const rows = await db.query(
    `SELECT w.id, w.supplier_id, COALESCE(s.name, w.supplier_name) AS supplier_name,
            w.amount, DATE_FORMAT(w.bill_date, '%Y-%m-%d') AS bill_date,
            w.invoice_status, w.note, w.created_by,
            DATE_FORMAT(w.created_at, '%Y-%m-%d %H:%i') AS created_at
       FROM waybill w
       LEFT JOIN supplier s ON s.id = w.supplier_id AND s.user_id = w.user_id
      WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL${winSql}`, args);
  if (!rows.length) {
    return { ok: false, error: days > 0 ? '货单不存在，或已超出可查看范围' : '货单不存在' };
  }
  const r = rows[0];
  const imgs = await db.query(
    `SELECT id, object_key, mime, size FROM waybill_image
      WHERE waybill_id = ? AND user_id = ? ORDER BY sort ASC, id ASC`, [wid, userId]);
  return {
    ok: true,
    waybill: {
      id: Number(r.id),
      supplierId: Number(r.supplier_id) || 0,
      supplierName: r.supplier_name || '',
      amount: Number(r.amount) || 0,
      billDate: r.bill_date,
      invoiceStatus: normInvoice(r.invoice_status),
      note: r.note || '',
      createdBy: r.created_by || '',
      createdAt: r.created_at,
    },
    images: imgs.map((i) => ({
      id: Number(i.id),
      url: qiniu.signUrl(i.object_key, 3600),
      mime: i.mime || '',
      size: Number(i.size) || 0,
    })).filter((i) => !!i.url),
  };
}

/**
 * 新建货单。
 * token 可选：带了就把该 token 下「还没归属」的图片绑到这张单上（手机传 + 电脑传都走这条）。
 */
async function createWaybill({ userId, supplierId, amount, billDate, note, operator, token, invoiceStatus }) {
  const sid = Number(supplierId) || 0;
  if (!sid) return { ok: false, error: '请选择供应商' };
  const sup = await db.query('SELECT id, name FROM supplier WHERE id = ? AND user_id = ?', [sid, userId]);
  if (!sup.length) return { ok: false, error: '供应商不存在（可能已被删除），请重新选择' };
  const amt = num(amount);
  if (!Number.isFinite(amt) || amt < 0) return { ok: false, error: '请填写正确的货单金额' };
  if (amt > MAX_AMOUNT) return { ok: false, error: '货单金额太大了（上限 ' + MAX_AMOUNT + '）' };
  const day = normDate(billDate);
  if (!day) return { ok: false, error: '请选择货单日期' };
  const tk = str(token, 32);
  const nm = normName(sup[0].name);

  const out = await db.transaction(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO waybill (user_id, supplier_id, supplier_name, amount, bill_date, invoice_status, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, sid, nm, amt.toFixed(2), day, normInvoice(invoiceStatus), str(note, 255) || null, str(operator, 64) || null]);
    const id = Number(r.insertId);
    let bound = 0;
    if (tk) {
      const [u] = await conn.query(
        'UPDATE waybill_image SET waybill_id = ?, sort = id, token = NULL WHERE token = ? AND user_id = ? AND waybill_id = 0',
        [id, tk, userId]);
      bound = Number(u.affectedRows) || 0;
    }
    return { id, bound };
  });
  return { ok: true, id: out.id, imageCount: out.bound };
}

/** 切换开票状态（v0.3.6）：列表点一下就切，两档互斥 */
async function setInvoiceStatus({ userId, id, status }) {
  const wid = Number(id) || 0;
  if (!wid) return { ok: false, error: '缺少货单 id' };
  const st = normInvoice(status);
  const rows = await db.query('SELECT id FROM waybill WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [wid, userId]);
  if (!rows.length) return { ok: false, error: '货单不存在' };
  await db.exec('UPDATE waybill SET invoice_status = ? WHERE id = ? AND user_id = ?', [st, wid, userId]);
  return { ok: true, id: wid, invoiceStatus: st };
}

/**
 * 删除货单（软删除，v0.3.7 用户要求）：
 *   只在 waybill.deleted_at 打时间戳，行和图片记录都留着 —— 列表/统计/供应商计数全部按
 *   deleted_at IS NULL 过滤，所以界面上跟真删一样；误删把 deleted_at 改回 NULL 就回来了。
 *   ⚠ 七牛对象一律不删（本来就在注释里约定过），恢复时图片能直接用。
 */
async function deleteWaybill({ userId, id }) {
  const wid = Number(id) || 0;
  if (!wid) return { ok: false, error: '缺少货单 id' };
  const rows = await db.query('SELECT id FROM waybill WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [wid, userId]);
  if (!rows.length) return { ok: false, error: '货单不存在（可能已经被删了）' };
  await db.exec('UPDATE waybill SET deleted_at = NOW() WHERE id = ? AND user_id = ?', [wid, userId]);
  return { ok: true, id: wid };
}

// ─────────────────────────────────────────────────────────────────────────
// 手机上传：5 分钟临时链接
// ─────────────────────────────────────────────────────────────────────────

/**
 * 生成上传令牌。每次点「生成链接」都新发一个（旧的不复用：避免上一个人的链接被继续用）。
 * 顺带清理过期超过 1 天的令牌，以及它们留下的孤儿图片记录（七牛对象不动）。
 */
async function createUploadToken({ userId, operator }) {
  const token = crypto.randomBytes(16).toString('hex');
  await db.exec(
    'INSERT INTO waybill_upload_token (token, user_id, created_by, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))',
    [token, userId, str(operator, 64) || null, TOKEN_TTL_SEC]);
  // 顺手打扫（失败不影响主流程）
  try {
    await db.exec(
      `DELETE i FROM waybill_image i
         JOIN waybill_upload_token t ON t.token = i.token
        WHERE i.waybill_id = 0 AND t.expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)`);
    await db.exec('DELETE FROM waybill_upload_token WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
  } catch (e) { /* 忽略 */ }
  return { ok: true, token, ttl: TOKEN_TTL_SEC, max: MAX_IMAGES };
}

/** 令牌会话状态：手机页倒计时、电脑端轮询已传张数都走这里 */
async function uploadSession(token) {
  const tk = str(token, 32);
  if (!/^[0-9a-f]{32}$/.test(tk)) return { ok: false, error: '链接无效，请让电脑上重新生成' };
  const rows = await db.query(
    `SELECT t.token, t.user_id, TIMESTAMPDIFF(SECOND, NOW(), t.expires_at) AS left_sec,
            (SELECT COUNT(*) FROM waybill_image i WHERE i.token = t.token AND i.waybill_id = 0) AS img_count
       FROM waybill_upload_token t WHERE t.token = ?`, [tk]);
  if (!rows.length) return { ok: false, error: '链接无效，请让电脑上重新生成', invalid: true };
  const left = Number(rows[0].left_sec) || 0;
  if (left <= 0) return { ok: false, error: '链接已过期，请让电脑上重新生成', expired: true };
  // ⚠ userId 必须带出来：手机上传靠它填 waybill_image.user_id（NOT NULL），
  //   漏了会被 mysql2 落成 NULL → "Column 'user_id' cannot be null"；
  //   电脑端 /api/waybill/upload 的归属校验也靠它，缺了会一律 403。
  return {
    ok: true, token: tk, userId: Number(rows[0].user_id) || 0,
    leftSec: left, imgCount: Number(rows[0].img_count) || 0, max: MAX_IMAGES,
  };
}

/**
 * 上传一张图片到某个令牌下（手机页调，无需登录）。
 * @returns {{ok:boolean, id?:number, count?:number, error?:string, expired?:boolean}}
 */
async function uploadImageToToken({ token, dataUrl, ip }) {
  const sess = await uploadSession(token);
  if (!sess.ok) return sess;
  // 兜底：令牌行的 user_id 若是 0/空（老数据或异常写入），宁可报错也别盲插，
  // 否则要么撞 NOT NULL 报数据库错误，要么把图挂到错误账号下。
  if (!sess.userId) return { ok: false, error: '上传链接异常，请让电脑上重新生成' };
  if (sess.imgCount >= MAX_IMAGES) {
    return { ok: false, error: `最多传 ${MAX_IMAGES} 张，已经够了` };
  }
  if (!rateOk(token + '|' + (ip || '?'))) {
    return { ok: false, error: '上传太频繁了，请等一分钟再试' };
  }
  const img = qiniu.decodeImagePayload(dataUrl, '没有收到图片');
  if (!img.ok) return { ok: false, error: img.error };
  const up = await qiniu.uploadImage(img.buffer, { mime: img.mime, userId: sess.userId, prefix: 'waybill' });
  if (!up.ok) return { ok: false, error: up.error };
  const r = await db.exec(
    'INSERT INTO waybill_image (user_id, waybill_id, token, object_key, mime, size, sort) VALUES (?, 0, ?, ?, ?, ?, ?)',
    [sess.userId, sess.token, up.key, up.mime, up.size, sess.imgCount]);
  const cnt = sess.imgCount + 1;
  return { ok: true, id: Number(r.insertId), count: cnt, max: MAX_IMAGES, leftSec: sess.leftSec };
}

/** 电脑端弹窗里已经传上去的图片（按 token 取，用于显示缩略图 + 删掉不要的那张） */
async function tokenImages({ userId, token }) {
  const tk = str(token, 32);
  if (!tk) return [];
  const rows = await db.query(
    `SELECT id, object_key, mime, size FROM waybill_image
      WHERE token = ? AND user_id = ? AND waybill_id = 0 ORDER BY sort ASC, id ASC`, [tk, userId]);
  return rows.map((i) => ({
    id: Number(i.id),
    url: qiniu.signUrl(i.object_key, 1800),
    mime: i.mime || '',
    size: Number(i.size) || 0,
  })).filter((i) => !!i.url);
}

/** 从待建单的图片里删掉一张（用户传错了要能撤） */
async function removeTokenImage({ userId, id }) {
  const iid = Number(id) || 0;
  if (!iid) return { ok: false, error: '缺少图片 id' };
  const rows = await db.query('SELECT id FROM waybill_image WHERE id = ? AND user_id = ? AND waybill_id = 0', [iid, userId]);
  if (!rows.length) return { ok: false, error: '图片不存在（可能已经存进货单了）' };
  await db.exec('DELETE FROM waybill_image WHERE id = ? AND user_id = ?', [iid, userId]);
  return { ok: true, id: iid };
}

module.exports = {
  TOKEN_TTL_SEC, MAX_IMAGES, INVOICE_STATUSES, STAFF_VISIBLE_DAYS,
  listSuppliers, allSuppliers, createSupplier, updateSupplier, deleteSupplier,
  listWaybills, getWaybill, createWaybill, deleteWaybill, setInvoiceStatus,
  createUploadToken, uploadSession, uploadImageToToken, tokenImages, removeTokenImage,
};
