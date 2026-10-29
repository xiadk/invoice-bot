/**
 * lib/invoice-titles.js — 用户开票抬头（多抬头，催收前选一条）
 *
 * 为什么单开一张表：app_user 里只有一个 company_name/tax_no/email，
 * 但同一家公司常有几个抬头（不同税号/邮箱），催收时得能选。
 *
 * 口径：
 *   · 归属按 user_id 隔离，一人最多一条 is_default=1；
 *   · app_user 的 company_name/tax_no/email 是「老数据」，首次读取时自动播种成默认抬头，
 *     之后一律以本表为准（发送时也用本表，见 server.js /api/sdc/send）；
 *   · 抬头为空的行不入库 —— 空抬头发出去只会让商家看不懂。
 */
const db = require('../db');

const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max || 255) : null;
};

/** 首次：把 app_user 里的抬头播成一条默认记录（已经配过抬头就绝不再播） */
async function seedFromUser(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return;
  // ⚠ 必须先判空：用户把播种出来的那条改名后，app_user 里的老公司名仍在，
  //   若每次 list() 都 INSERT IGNORE，旧名会被重新播进来 → 出现两条「默认」抬头
  const has = await db.query(
    'SELECT 1 AS x FROM app_invoice_title WHERE user_id = ? LIMIT 1', [uid]
  ).catch(() => []);
  if (has && has.length) return;
  const rows = await db.query(
    'SELECT company_name, tax_no, email FROM app_user WHERE id = ?', [uid]
  ).catch(() => []);
  const u = rows[0] || {};
  const title = str(u.company_name, 200);
  if (!title) return;
  await db.exec(
    'INSERT IGNORE INTO app_invoice_title (user_id, title, tax_no, email, is_default) VALUES (?,?,?,?,1)',
    [uid, title, str(u.tax_no, 64), str(u.email, 160)]
  ).catch(() => null);
}

/** 列表（首次自动播种；按「默认优先 + 新到旧」排） */
async function list(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  await seedFromUser(uid);
  return db.query(
    'SELECT id, title, tax_no AS taxNo, email, is_default AS isDefault, created_at AS createdAt'
    + ' FROM app_invoice_title WHERE user_id = ? ORDER BY is_default DESC, id DESC', [uid]
  ).catch(() => []);
}

/** 取一条（发送时用）：不传 id 就是默认抬头 */
async function get(userId, id) {
  const uid = Number(userId) || 0;
  if (!uid) return null;
  const rows = await list(uid);
  if (!rows.length) return null;
  const want = Number(id) || 0;
  if (!want) return rows[0];
  return rows.find((r) => Number(r.id) === want) || rows[0];
}

/** 新增 / 修改（id 有值就是改）。返回落库后的记录 */
async function save(userId, body = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw new Error('缺少用户');
  const title = str(body.title, 200);
  if (!title) throw new Error('抬头不能为空');
  const taxNo = str(body.taxNo || body.tax_no, 64);
  const email = str(body.email, 160);
  const isDefault = body.isDefault === true || body.isDefault === 1 || body.isDefault === '1' ? 1 : 0;
  const id = Number(body.id) || 0;

  if (id) {
    const own = await db.query('SELECT id FROM app_invoice_title WHERE id = ? AND user_id = ?', [id, uid]).catch(() => []);
    if (!own.length) throw new Error('抬头不存在或不属于当前用户');
    await db.exec(
      'UPDATE app_invoice_title SET title = ?, tax_no = ?, email = ?, is_default = ? WHERE id = ? AND user_id = ?',
      [title, taxNo, email, isDefault, id, uid]
    );
    if (isDefault) await clearOtherDefault(uid, id);
    return { id };
  }

  const res = await db.exec(
    'INSERT INTO app_invoice_title (user_id, title, tax_no, email, is_default) VALUES (?,?,?,?,?)'
    + ' ON DUPLICATE KEY UPDATE tax_no = VALUES(tax_no), email = VALUES(email), is_default = VALUES(is_default)',
    [uid, title, taxNo, email, isDefault]
  ).catch((e) => {
    if (/Duplicate/i.test(String(e && e.message))) throw new Error('同名抬头已存在');
    throw e;
  });
  const newId = res && res.insertId ? res.insertId : null;
  if (isDefault && newId) await clearOtherDefault(uid, newId);
  return { id: newId };
}

async function clearOtherDefault(userId, keepId) {
  await db.exec(
    'UPDATE app_invoice_title SET is_default = 0 WHERE user_id = ? AND id <> ?', [userId, keepId]
  ).catch(() => null);
}

async function setDefault(userId, id) {
  const uid = Number(userId) || 0;
  const want = Number(id) || 0;
  if (!uid || !want) throw new Error('参数不完整');
  const own = await db.query('SELECT id FROM app_invoice_title WHERE id = ? AND user_id = ?', [want, uid]).catch(() => []);
  if (!own.length) throw new Error('抬头不存在或不属于当前用户');
  await db.exec('UPDATE app_invoice_title SET is_default = 0 WHERE user_id = ?', [uid]);
  await db.exec('UPDATE app_invoice_title SET is_default = 1 WHERE id = ? AND user_id = ?', [want, uid]);
  return { ok: true };
}

async function remove(userId, id) {
  const uid = Number(userId) || 0;
  const want = Number(id) || 0;
  if (!uid || !want) throw new Error('参数不完整');
  await db.exec('DELETE FROM app_invoice_title WHERE id = ? AND user_id = ?', [want, uid]);
  // 删掉的是默认抬头 → 把剩下的第一条顶上，避免「没有默认」
  const left = await db.query(
    'SELECT id FROM app_invoice_title WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1', [uid]
  ).catch(() => []);
  if (left.length) await db.exec('UPDATE app_invoice_title SET is_default = 1 WHERE id = ?', [left[0].id]);
  return { ok: true };
}

module.exports = { list, get, save, setDefault, remove, seedFromUser };
