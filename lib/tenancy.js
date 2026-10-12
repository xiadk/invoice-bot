/**
 * lib/tenancy.js — 多租户数据目录与租户解析
 *
 * 目录约定（每个用户一份，互不可见）：
 *   data/users/<user_id>/完成订单/*.xlsx        该用户的订单导出
 *   data/users/<user_id>/已开票订单/*.xlsx      该用户的税务局发票导出
 *   data/users/<user_id>/invoice-status.json    该用户的平台开票状态快照
 *   data/users/<user_id>/state-1688.json        该用户的 1688 登录态（Playwright storageState）
 *   data/users/<user_id>/browser-profile/       该用户的浏览器持久化配置目录
 *
 * 兼容历史：单用户时期数据放在 data/完成订单 等根目录，首次启动会复制到
 * data/users/<超级管理员ID>/ 下（复制而非移动，避免影响其它脚本）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(ROOT, 'data');
const USER_DATA_ROOT = path.join(DATA_ROOT, 'users');

/** 该用户的数据目录（不保证已存在） */
function dataDirFor(userId) {
  return path.join(USER_DATA_ROOT, String(Number(userId) || 1));
}

/** 该用户的订单导出目录 */
function orderDirFor(userId) { return path.join(dataDirFor(userId), '完成订单'); }
/** 该用户的已开票导出目录 */
function invoiceDirFor(userId) { return path.join(dataDirFor(userId), '已开票订单'); }
/** 该用户的平台开票状态快照 */
function statusFileFor(userId) { return path.join(dataDirFor(userId), 'invoice-status.json'); }
/** 该用户的 1688 登录态文件（Playwright storageState） */
function statePathFor(userId) { return path.join(dataDirFor(userId), 'state-1688.json'); }
/** 该用户的浏览器持久化目录（可作为 userDataDir 复用） */
function browserProfileDirFor(userId) { return path.join(dataDirFor(userId), 'browser-profile'); }

/** 确保该用户的各个数据目录存在 */
function ensureUserDirs(userId) {
  const base = dataDirFor(userId);
  for (const d of [base, orderDirFor(userId), invoiceDirFor(userId)]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 忽略 */ }
  }
  return base;
}

/** 递归复制目录（用于把历史单用户数据搬进第一个用户的目录） */
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) n += copyDirRecursive(s, d);
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

/**
 * 首次启动时把历史单用户数据复制到超级管理员的用户目录下（幂等，已存在则跳过）。
 * @returns {string[]} 迁移动作说明
 */
function migrateLegacyData(adminId) {
  const notes = [];
  const base = ensureUserDirs(adminId);
  const pairs = [
    [path.join(DATA_ROOT, '完成订单'), orderDirFor(adminId), '完成订单'],
    [path.join(DATA_ROOT, '已开票订单'), invoiceDirFor(adminId), '已开票订单'],
  ];
  for (const [src, dest, label] of pairs) {
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      const n = copyDirRecursive(src, dest);
      notes.push(`历史「${label}」数据已复制到用户目录（${n} 个文件）`);
    }
  }
  const legacyStatus = path.join(DATA_ROOT, 'invoice-status.json');
  const userStatus = statusFileFor(adminId);
  if (fs.existsSync(legacyStatus) && !fs.existsSync(userStatus)) {
    try { fs.copyFileSync(legacyStatus, userStatus); notes.push('历史开票状态快照已复制'); } catch (e) { /* 忽略 */ }
  }
  const legacyState = path.join(DATA_ROOT, 'state-1688.json');
  const userState = statePathFor(adminId);
  if (fs.existsSync(legacyState) && !fs.existsSync(userState)) {
    try { fs.copyFileSync(legacyState, userState); notes.push('历史 1688 登录态已复制到超级管理员账号'); } catch (e) { /* 忽略 */ }
  }
  // 备份目录等公共产物仍在 data/ 根目录下
  fs.mkdirSync(path.join(DATA_ROOT, 'backups'), { recursive: true });
  return notes;
}

module.exports = {
  ROOT,
  DATA_ROOT,
  USER_DATA_ROOT,
  dataDirFor,
  orderDirFor,
  invoiceDirFor,
  statusFileFor,
  statePathFor,
  browserProfileDirFor,
  ensureUserDirs,
  migrateLegacyData,
  copyDirRecursive,
};
