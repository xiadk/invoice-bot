/**
 * lib/config.js — 应用配置读取（数据库优先，config.json 仅兜底）
 *
 * 为什么改成入库（v0.3.37）：
 *   原来 loadConfig 只会读项目根的 config.json，系统管理保存配置也是直接
 *   fs.writeFileSync 回这个文件。容器部署里 /app 属主是 root、进程是 node，
 *   保存「拼多多翻页上限」必然 EACCES，用户只能进容器改属主才能改个数字。
 *   现在业务配置全部落在 `app_config` 表（key = config.<段>，value = JSON），
 *   保存只写库，不再依赖任何可写文件；config.json 退化为「首次启动的引导值」，
 *   数据库里没有对应段时才会用它的值，并在启动时一次性搬进库（不覆盖已有）。
 *
 * 仍然留在文件/环境变量的（刻意不迁移）：
 *   · mysql   —— R1 铁律：只有 db.js 能解析数据库连接参数；云上用 MYSQL_* 环境变量
 *   · qnh     —— 本机 Python 子工程路径，机器级配置，跨机器无意义
 *   · platforms / selectors —— 1688 登录凭据与页面选择器，属本机浏览器侧
 *   · buyerInfo —— 开票抬头早已按账号存在 app_user 表
 *
 * 设计约束：loadConfig() 必须保持**同步**——11 处调用点散布在 sender / pdd /
 * qiniu / pdd-sync / ali-orders 等同步代码里，改成 async 会连锁改动半个项目。
 * 因此这里用「内存缓存 + 启动时从库加载 + 定时刷新」：读永远是内存，写走库。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.APP_CONFIG_FILE
  ? path.resolve(process.env.APP_CONFIG_FILE)
  : path.join(ROOT, 'config.json');

/** 入库的业务配置段（app_config.key = `config.<段>`，value = JSON 文本） */
const DB_SECTIONS = ['runtime', 'messages', 'pddMessage', 'qiniu', 'server_url', 'copyright'];
const KEY_PREFIX = 'config.';

let _cache = null;          // 生效配置（文件值 + 库值覆盖）
let _source = {};           // 段 -> 'db' | 'file'，排查用
let _warned = false;
let _refreshing = null;

/** 去掉 _comment / _comment2 之类的说明键：它们只服务于 config.example.json 的阅读者 */
function stripComments(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k.startsWith('_comment')) continue;
    out[k] = obj[k];
  }
  return out;
}

/** 读文件（读不到就空对象，绝不因为缺文件把服务拖死） */
function readFileConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (raw && typeof raw === 'object') {
        _source = {};
        for (const s of DB_SECTIONS) if (raw[s] !== undefined) _source[s] = 'file';
        return raw;
      }
    }
  } catch (e) {
    console.error('[config] 读取 ' + CONFIG_PATH + ' 失败：' + String((e && e.message) || e));
  }
  if (!_warned) {
    _warned = true;
    console.warn('[config] 未找到 ' + CONFIG_PATH + '：按默认值运行。'
      + '云部署建议改用 MYSQL_* 等环境变量；业务配置保存后存在 app_config 表，不依赖本文件可写。');
  }
  return {};
}

/**
 * 取生效配置（同步）。
 * 数据库里的段优先；库里没有的段用文件值；两者都没有就由各调用点用自己的默认值。
 */
function loadConfig() {
  if (_cache) return _cache;
  _cache = readFileConfig();
  return _cache;
}

/** 数据库不可用时返回 null（CLI 脚本、建库前） */
function dbmod() {
  try { return require('../db'); } catch (e) { return null; }
}

/**
 * 从 app_config 刷新内存缓存。返回 { ok, sections, error }。
 * 只读，不改库；多实例靠定时调用保持一致，系统管理保存后也会立即调一次。
 */
async function refreshFromDb() {
  const db = dbmod();
  if (!db) return { ok: false, sections: [], error: '数据库模块不可用' };
  let rows;
  try {
    rows = await db.query('SELECT `key`, `value` FROM app_config WHERE `key` LIKE ?', [KEY_PREFIX + '%']);
  } catch (e) {
    return { ok: false, sections: [], error: String((e && e.message) || e) };
  }
  const base = loadConfig();
  const merged = { ...base };
  const hit = [];
  for (const r of rows || []) {
    const name = String(r.key).slice(KEY_PREFIX.length);
    if (DB_SECTIONS.indexOf(name) < 0) continue;
    let val;
    try { val = JSON.parse(r.value); } catch (e) { continue; }
    // 段内浅合并：老版本可能只存过部分字段，直接整段覆盖会把文件里的其它字段弄丢
    if (val && typeof val === 'object' && !Array.isArray(val)
        && merged[name] && typeof merged[name] === 'object' && !Array.isArray(merged[name])) {
      merged[name] = { ...merged[name], ...val };
    } else {
      merged[name] = val;
    }
    _source[name] = 'db';
    hit.push(name);
  }
  _cache = merged;
  return { ok: true, sections: hit };
}

/**
 * 首次启动的一次性迁移：把 config.json 里的业务段搬进 app_config。
 * 只插入「库里还没有」的键，绝不覆盖已经在库里改过的值；
 * 也不删文件——文件继续充当数据库不可用时的兜底。
 */
async function migrateFileToDb() {
  const db = dbmod();
  if (!db) return { migrated: [] };
  let have;
  try {
    const rows = await db.query('SELECT `key` FROM app_config WHERE `key` LIKE ?', [KEY_PREFIX + '%']);
    have = new Set((rows || []).map((r) => String(r.key)));
  } catch (e) {
    return { migrated: [], error: String((e && e.message) || e) };
  }
  const fileCfg = readFileConfig();
  const migrated = [];
  for (const s of DB_SECTIONS) {
    const key = KEY_PREFIX + s;
    if (have.has(key)) continue;
    if (fileCfg[s] === undefined || fileCfg[s] === null || fileCfg[s] === '') continue;
    const val = stripComments(fileCfg[s]);
    try {
      await db.exec(
        'INSERT INTO app_config (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
        [key, JSON.stringify(val)]
      );
      migrated.push(s);
    } catch (e) { /* 单段失败不影响其它段 */ }
  }
  return { migrated };
}

/**
 * 保存若干段到 app_config，并同步更新本进程缓存（保存后立即生效，无需重启）。
 * 只接受 DB_SECTIONS 里的段名；调用方传什么就整段覆盖什么。
 */
async function saveSections(patch) {
  const db = dbmod();
  if (!db) throw new Error('数据库模块不可用，无法保存配置');
  const saved = [];
  for (const s of DB_SECTIONS) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, s)) continue;
    if (patch[s] === undefined) continue;
    const val = stripComments(patch[s]);
    await db.exec(
      'INSERT INTO app_config (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [KEY_PREFIX + s, JSON.stringify(val)]
    );
    saved.push(s);
  }
  const cur = { ...loadConfig() };
  for (const s of saved) { cur[s] = stripComments(patch[s]); _source[s] = 'db'; }
  _cache = cur;
  return { saved };
}

/** 当前各段来源（日志/排查用） */
function configSource() { return { ..._source }; }

/**
 * 启动时调用：迁移文件 → 从库加载 → 开始定时刷新（多实例/手改库都能跟上）。
 * 数据库没起来时不抛错，保持文件兜底，等服务恢复后下一轮刷新自然补上。
 */
async function initConfigStore(opts = {}) {
  const out = { migrated: [], refreshed: false, error: '' };
  try {
    const m = await migrateFileToDb();
    out.migrated = m.migrated || [];
    const r = await refreshFromDb();
    out.refreshed = !!r.ok;
    if (!r.ok) out.error = r.error || '';
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  if (opts.autoRefresh !== false) startAutoRefresh(opts.intervalMs);
  return out;
}

let _timer = null;
/** 定时从库里重读配置（默认 10s）；unref 掉，不影响进程退出 */
function startAutoRefresh(intervalMs) {
  if (_timer) return _timer;
  const ms = Number(intervalMs) > 0 ? Number(intervalMs) : 10000;
  _timer = setInterval(() => {
    if (_refreshing) return;
    _refreshing = refreshFromDb().catch(() => null).then((r) => { _refreshing = null; return r; });
  }, ms);
  if (_timer.unref) _timer.unref();
  return _timer;
}

module.exports = {
  loadConfig,
  refreshFromDb,
  saveSections,
  initConfigStore,
  startAutoRefresh,
  migrateFileToDb,
  configSource,
  CONFIG_PATH,
  ROOT,
  DB_SECTIONS,
};
