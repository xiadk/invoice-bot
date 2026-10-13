/**
 * lib/state-store.js — 1688 登录态入库（加密存储）
 *
 * 背景：登录态原先只活在一个文件里（data/users/<id>/state-1688.json），容器重建即丢、
 *       无法多实例、不进数据库备份。这里把它变成数据库里的一行密文记录。
 *
 * 形态：登录态 = Playwright storageState = { cookies: [...], origins: [{origin, localStorage}] }
 *
 * 存储：
 *   · 静态加密 AES-256-GCM，单字段自描述格式  v1:<keyId>:<iv>:<authTag>:<cipher>（各段 base64url）
 *   · 密钥优先取环境变量 STATE_SECRET；未配置时首次运行随机生成并写入 data/.state-secret(0600)，
 *     并在启动时给出告警（云部署务必用环境变量，否则容器重建会让旧密文全部无法解密）。
 *   · 支持 STATE_SECRET_OLD（逗号分隔）读取旧密钥，便于轮换；写入永远用当前密钥。
 *
 * 数据表：login_state（一人一平台一行，UPSERT）
 *
 * 安全约定：
 *   · 密文只对本人返回；管理员只可见元信息（是否有态/存于何时/是否失效），绝不下发密文。
 *   · 任何日志都不打印 cookies 或密文。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const tenancy = require('./tenancy');

const ROOT = path.resolve(__dirname, '..');
const SECRET_FILE = path.join(ROOT, 'data', '.state-secret');
const PLATFORM = '1688';
const IV_LEN = 12;
const VERSION = 'v1';

// ── 密钥环 ────────────────────────────────────────────────────────────────
let _keyring = null;
let _usingGeneratedFile = false;

/** 取当前密钥字符串：环境变量优先，否则持久化文件，最后随机生成 */
function currentSecret() {
  if (process.env.STATE_SECRET && process.env.STATE_SECRET.trim()) {
    return process.env.STATE_SECRET.trim();
  }
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
      if (s) { _usingGeneratedFile = true; return s; }
    }
  } catch (e) { /* 忽略，走随机生成 */ }
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  } catch (e) { /* 只读文件系统时退化为进程内随机密钥 */ }
  _usingGeneratedFile = true;
  return s;
}

/** 由密钥字符串派生 32 字节密钥与短 id */
function derive(secret) {
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  return { id: key.toString('hex').slice(0, 8), key };
}

/** 密钥环：当前密钥 + 旧密钥（仅用于解密） */
function keyring() {
  if (_keyring) return _keyring;
  const byId = new Map();
  const cur = derive(currentSecret());
  byId.set(cur.id, cur.key);
  for (const old of String(process.env.STATE_SECRET_OLD || '').split(',')) {
    const s = old.trim();
    if (!s) continue;
    const d = derive(s);
    if (!byId.has(d.id)) byId.set(d.id, d.key);
  }
  _keyring = { currentId: cur.id, byId };
  return _keyring;
}

/** 启动自检：返回需要提示的告警文案数组（不阻断启动） */
function startupNotices() {
  keyring();
  if (_usingGeneratedFile) {
    return ['1688 登录态加密密钥来自 data/.state-secret（自动生成）。云部署请改用环境变量 STATE_SECRET，' +
      '否则容器重建后密钥变化，已入库的登录态将无法解密（用户需重新登录上传）。'];
  }
  return [];
}

// ── 加解密 ────────────────────────────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** 加密任意 JSON 对象 → v1:<keyId>:<iv>:<tag>:<cipher> */
function encrypt(obj) {
  const kr = keyring();
  const key = kr.byId.get(kr.currentId);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf-8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, kr.currentId, b64u(iv), b64u(tag), b64u(enc)].join(':');
}

/** 解密 v1:<keyId>:<iv>:<tag>:<cipher> → 对象（失败抛错） */
function decrypt(enc) {
  const parts = String(enc || '').split(':');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('登录态密文格式不正确');
  const [, keyId, ivS, tagS, dataS] = parts;
  const key = keyring().byId.get(keyId);
  if (!key) throw new Error(`找不到解密密钥 ${keyId}（可能缺少 STATE_SECRET / STATE_SECRET_OLD）`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivS, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagS, 'base64url'));
  const out = Buffer.concat([decipher.update(Buffer.from(dataS, 'base64url')), decipher.final()]);
  return JSON.parse(out.toString('utf-8'));
}

// ── 库读写 ────────────────────────────────────────────────────────────────

/** 归一化 storageState，返回 { cookies, origins, cookieCount, originCount } */
function normalize(state) {
  const obj = state && typeof state === 'object' ? state : {};
  const cookies = Array.isArray(obj.cookies) ? obj.cookies : [];
  const origins = Array.isArray(obj.origins) ? obj.origins : [];
  return { cookies, origins, cookieCount: cookies.length, originCount: origins.length };
}

/**
 * 保存/覆盖某用户的登录态。
 * @param {number} userId
 * @param {object} state   Playwright storageState（{cookies, origins}）
 * @param {object} [opts]  { source: 'cloud_login'|'extension'|'migrated'|'manual' }
 * @returns {Promise<{savedAt:string, status:string, cookieCount:number, originCount:number}>}
 */
async function saveState(userId, state, opts = {}) {
  const { cookies, origins, cookieCount, originCount } = normalize(state);
  if (cookieCount === 0 && originCount === 0) throw new Error('登录态为空（没有 cookie 也没有 localStorage），拒绝保存');
  const source = ['cloud_login', 'extension', 'migrated', 'manual'].includes(opts.source) ? opts.source : 'manual';
  const enc = encrypt({ cookies, origins });
  const keyId = keyring().currentId;
  await db.exec(
    'INSERT INTO `login_state` ' +
    '(`user_id`,`platform`,`state_enc`,`key_id`,`cookie_count`,`origin_count`,`status`,`source`,`saved_at`,`last_used_at`,`last_checked_at`) ' +
    "VALUES (?,?,?,?,?,?, 'active', ?, NOW(), NULL, NOW()) " +
    'ON DUPLICATE KEY UPDATE `state_enc`=VALUES(`state_enc`), `key_id`=VALUES(`key_id`), ' +
    '`cookie_count`=VALUES(`cookie_count`), `origin_count`=VALUES(`origin_count`), ' +
    "`status`='active', `source`=VALUES(`source`), `saved_at`=NOW(), `last_checked_at`=NOW()",
    [Number(userId), PLATFORM, enc, keyId, cookieCount, originCount, source]
  );
  return { savedAt: new Date().toISOString(), status: 'active', cookieCount, originCount };
}

/** 读取并解密某用户的登录态；没有 / 解不开 → null（不抛错，调用方可回退文件） */
async function loadState(userId) {
  let rows;
  try {
    rows = await db.query(
      'SELECT `state_enc` FROM `login_state` WHERE `user_id`=? AND `platform`=? LIMIT 1',
      [Number(userId), PLATFORM]
    );
  } catch (e) { return null; }
  if (!rows.length) return null;
  try {
    const st = decrypt(rows[0].state_enc);
    const { cookies, origins } = normalize(st);
    if (cookies.length === 0 && origins.length === 0) return null;
    return { cookies, origins };
  } catch (e) {
    console.warn('[state-store] 登录态解密失败（user=' + userId + '）: ' + e.message);
    return null;
  }
}

/** 元信息（不含密文），供看板/管理员查看 */
async function getMeta(userId) {
  let rows;
  try {
    rows = await db.query(
      'SELECT `status`,`source`,`cookie_count`,`origin_count`,`saved_at`,`last_used_at`,`last_checked_at` ' +
      'FROM `login_state` WHERE `user_id`=? AND `platform`=? LIMIT 1',
      [Number(userId), PLATFORM]
    );
  } catch (e) { return { hasState: false, status: null, source: null, savedAt: null, lastUsedAt: null, cookieCount: 0, originCount: 0 }; }
  if (!rows.length) {
    return { hasState: false, status: null, source: null, savedAt: null, lastUsedAt: null, cookieCount: 0, originCount: 0 };
  }
  const r = rows[0];
  return {
    hasState: true,
    status: r.status,
    source: r.source || null,
    savedAt: r.saved_at || null,
    lastUsedAt: r.last_used_at || null,
    lastCheckedAt: r.last_checked_at || null,
    cookieCount: Number(r.cookie_count) || 0,
    originCount: Number(r.origin_count) || 0,
  };
}

/** 是否「有且可用」的登录态（无需重新登录） */
async function hasActiveState(userId) {
  const m = await getMeta(userId);
  return !!(m.hasState && m.status === 'active');
}

/** 清空某用户的登录态（下线 / 换号） */
async function clearState(userId) {
  await db.exec('DELETE FROM `login_state` WHERE `user_id`=? AND `platform`=?', [Number(userId), PLATFORM]);
}

/** 标记「最近使用过」并自愈为 active（发送成功后调用） */
async function touch(userId) {
  try {
    await db.exec(
      "UPDATE `login_state` SET `last_used_at`=NOW(), `last_checked_at`=NOW(), `status`='active' " +
      'WHERE `user_id`=? AND `platform`=?',
      [Number(userId), PLATFORM]
    );
  } catch (e) { /* 忽略：仅统计字段 */ }
}

/** 标记登录态失效（发送时被跳转登录页） */
async function markExpired(userId) {
  try {
    await db.exec(
      "UPDATE `login_state` SET `status`='expired', `last_checked_at`=NOW() WHERE `user_id`=? AND `platform`=?",
      [Number(userId), PLATFORM]
    );
  } catch (e) { /* 忽略 */ }
}

/**
 * 一次性把磁盘上的 state-1688.json 迁进数据库（幂等：库里已有则跳过）。
 * 不删除原文件（回滚安全）。返回迁移说明数组。
 */
async function migrateFromFiles() {
  const notes = [];
  let users = [];
  try { users = await db.query('SELECT `id` FROM `app_user`'); } catch (e) { return notes; }
  for (const u of users) {
    const file = tenancy.statePathFor(u.id);
    try {
      if (!fs.existsSync(file)) continue;
      const meta = await getMeta(u.id);
      if (meta.hasState) continue; // 库里已有，文件只作为历史遗留，不再覆盖
      const raw = fs.readFileSync(file, 'utf-8');
      const obj = JSON.parse(raw);
      const r = await saveState(u.id, obj, { source: 'migrated' });
      notes.push(`用户 #${u.id} 的 1688 登录态已从文件迁入数据库（${r.cookieCount} 个 cookie，原文件保留）`);
    } catch (e) {
      notes.push(`用户 #${u.id} 登录态迁移失败：${e.message}`);
    }
  }
  return notes;
}

module.exports = {
  PLATFORM,
  encrypt,
  decrypt,
  summarize: normalize,
  saveState,
  loadState,
  getMeta,
  hasActiveState,
  clearState,
  touch,
  markExpired,
  migrateFromFiles,
  startupNotices,
};
