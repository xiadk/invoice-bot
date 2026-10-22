/**
 * lib/qnh.js — 牵牛花退单：数据查询 / Cookie 状态 / 同步调度
 *
 * 分工：
 *   · 读数据 → 直接查 MySQL（qnh_* 表，由 qnh-refund-sync 写入）
 *   · 碰接口 → spawn Python（qnh-refund-sync/bridge.py），Node 不重复实现 Cookie/风控逻辑
 *   · 定时   → 进程内定时器（每 30 秒比一次配置的时分），配置存 app_config 表
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db');

const ROOT = path.join(__dirname, '..');

// ── 路径解析（优先级：环境变量 → config.json 的 qnh 段 → 自动探测）──────────
// 旧版把某台机器（Administrator 用户）的绝对路径写死在这里，换机/换用户即坏。
// 现在按下面顺序解析，全部落空时给出可操作的修复指引：
//   1) env QNH_SYNC_DIR / QNH_PYTHON
//   2) config.json 的 qnh.syncDir / qnh.python
//   3) 自动探测：%HOME%/WorkBuddy/*/qnh-refund-sync（取最新）与项目同级目录
function readQnhFileCfg() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
    return (cfg && typeof cfg.qnh === 'object' && cfg.qnh) || {};
  } catch (e) { return {}; }
}

/** 解析 qnh-refund-sync 工程目录；找不到时返回 { dir: null, tried: [...已探测路径] } */
function resolveSyncDir({ env = process.env, home = os.homedir(), root = ROOT, readCfg = readQnhFileCfg } = {}) {
  const tried = [];
  const hasBridge = (dir) => { try { return fs.existsSync(path.join(dir, 'bridge.py')); } catch (e) { return false; } };
  const pick = (dir) => {
    if (dir) {
      if (hasBridge(dir)) return dir;
      tried.push(dir);
    }
    return null;
  };

  let hit = pick(env.QNH_SYNC_DIR);
  if (hit) return { dir: hit, via: 'env:QNH_SYNC_DIR', tried };

  hit = pick(readCfg().syncDir);
  if (hit) return { dir: hit, via: 'config.json:qnh.syncDir', tried };

  const hits = [];
  const wb = path.join(home, 'WorkBuddy');
  if (fs.existsSync(wb)) {
    let sessions = [];
    try { sessions = fs.readdirSync(wb, { withFileTypes: true }); } catch (e) { /* 目录不可读就跳过 */ }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const d = path.join(wb, s.name, 'qnh-refund-sync');
      if (hasBridge(d)) {
        let mt = 0;
        try { mt = fs.statSync(d).mtimeMs; } catch (e) { /* ignore */ }
        hits.push({ d, mt });
      }
    }
  }
  const sibling = path.join(path.dirname(root), 'qnh-refund-sync');
  if (hasBridge(sibling)) hits.push({ d: sibling, mt: fs.statSync(sibling).mtimeMs });
  if (hits.length) {
    hits.sort((a, b) => b.mt - a.mt);
    return { dir: hits[0].d, via: 'auto-discover', tried };
  }
  tried.push(`${wb}\\<日期目录>\\qnh-refund-sync`, sibling);
  return { dir: null, via: null, tried };
}

/** 解析 Python 解释器：env → config.json → 本机 .workbuddy venv → PATH 上的 python */
function resolvePython({ env = process.env, home = os.homedir(), readCfg = readQnhFileCfg } = {}) {
  const candidates = [];
  if (env.QNH_PYTHON) candidates.push(env.QNH_PYTHON);
  const cfg = readCfg();
  if (cfg.python) candidates.push(cfg.python);
  candidates.push(path.join(home, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return 'python';
}

function syncDirNotFoundMessage(tried) {
  // 前端用 Element 的 $message 展示，\n 会被折叠，这里用分号连成一段可读的句子
  return [
    '找不到牵牛花同步工程（qnh-refund-sync/bridge.py）。修复任选其一：',
    `① 把 qnh-refund-sync 整个目录拷到 ${path.dirname(ROOT)}\\ 下；`,
    '② 在 config.json 增加 "qnh": { "syncDir": "D:/workspace/qnh-refund-sync" }；',
    '③ 设置环境变量 QNH_SYNC_DIR 指向该目录。',
    '已探测位置：' + tried.join(' ; '),
  ].join('');
}

const RESULT_PREFIX = '@@RESULT@@';

// ── 配置项（与 Python 侧 notify.py / bridge.py 共用同一批 key）──
const CFG = {
  scheduleEnabled: 'qnh.schedule_enabled',
  scheduleTime: 'qnh.schedule_time',
  webhook: 'qnh.wecom_webhook',
  wecomEnabled: 'qnh.wecom_enabled',
  alertDelivery: 'qnh.alert_delivery_log',
  lastAutoDate: 'qnh.last_auto_date',
  lastAutoAt: 'qnh.last_auto_at',
};

const DEFAULTS = {
  [CFG.scheduleEnabled]: '0',
  [CFG.scheduleTime]: '03:00',
  [CFG.webhook]: '',
  [CFG.wecomEnabled]: '0',
  [CFG.alertDelivery]: '1',
};

/** 读一组配置（带默认值） */
async function getConfig() {
  const rows = await db.query('SELECT `key`, `value` FROM app_config');
  const map = {};
  for (const r of rows) map[r.key] = r.value == null ? '' : r.value;
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) out[k] = map[k] === undefined ? def : map[k];
  out[CFG.lastAutoDate] = map[CFG.lastAutoDate] || '';
  out[CFG.lastAutoAt] = map[CFG.lastAutoAt] || '';
  return out;
}

/** 写配置（只允许白名单 key） */
async function setConfig(patch) {
  const allowed = new Set(Object.values(CFG));
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.has(k)) continue;
    await db.exec(
      'INSERT INTO app_config (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [k, v == null ? '' : String(v)]
    );
  }
  return getConfig();
}

/** 把库里的配置翻译成前端友好的结构 */
function publicConfig(cfg) {
  return {
    scheduleEnabled: cfg[CFG.scheduleEnabled] === '1',
    scheduleTime: cfg[CFG.scheduleTime] || '03:00',
    webhook: cfg[CFG.webhook] || '',
    wecomEnabled: cfg[CFG.wecomEnabled] === '1',
    alertDelivery: cfg[CFG.alertDelivery] !== '0',
    lastAutoDate: cfg[CFG.lastAutoDate] || '',
    lastAutoAt: cfg[CFG.lastAutoAt] || '',
  };
}

// ── 调 Python 桥接 ───────────────────────────────────────────
function runBridge(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const r = resolveSyncDir();
    if (!r.dir) return resolve({ ok: false, message: syncDirNotFoundMessage(r.tried) });
    const script = path.join(r.dir, 'bridge.py');
    const py = resolvePython();
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(py, [script, ...args], {
      cwd: r.dir,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (e) { /* ignore */ }
      resolve({ ok: false, message: `执行超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, message: '启动 Python 失败：' + e.message });
    });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith(RESULT_PREFIX));
      if (!line) {
        return resolve({
          ok: false,
          message: (err || out || '未返回结果').trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300),
        });
      }
      try {
        resolve(JSON.parse(line.slice(RESULT_PREFIX.length)));
      } catch (e) {
        resolve({ ok: false, message: '返回结果解析失败：' + e.message });
      }
    });
  });
}

// ── 同步状态（同一时刻只允许一个同步任务）───────────────────
const syncState = {
  running: false,
  startedAt: null,
  lastResult: null,
  lastFinishedAt: null,
};

function getSyncState() {
  return { ...syncState };
}

async function runSync({ trigger = 'manual', days = null, date = null } = {}) {
  if (syncState.running) {
    return { ok: false, running: true, message: '已有同步任务在运行，请稍候' };
  }
  syncState.running = true;
  syncState.startedAt = new Date().toISOString();
  try {
    const args = ['sync'];
    if (date) args.push('--date', date);
    else if (days) args.push('--days', String(days));
    const res = await runBridge(args, 15 * 60 * 1000);
    syncState.lastResult = { ...res, trigger };
    syncState.lastFinishedAt = new Date().toISOString();
    return { ...res, trigger };
  } finally {
    syncState.running = false;
  }
}

// ── 定时任务 ─────────────────────────────────────────────────
let schedulerTimer = null;

/** 每 30 秒检查一次：到了配置的时间且今天没跑过，就跑一轮增量。 */
async function tickScheduler() {
  let cfg;
  try { cfg = await getConfig(); } catch (e) { return; }
  if (cfg[CFG.scheduleEnabled] !== '1') return;
  if (syncState.running) return;

  const want = String(cfg[CFG.scheduleTime] || '03:00').slice(0, 5);
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (hhmm !== want) return;

  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (cfg[CFG.lastAutoDate] === today) return;

  // 先记「今天跑过了」，避免这一分钟内重复触发
  await setConfig({ [CFG.lastAutoDate]: today, [CFG.lastAutoAt]: now.toISOString() });
  console.log(`[qnh] 定时同步开始（${hhmm}）`);
  const res = await runSync({ trigger: 'schedule' });
  console.log(`[qnh] 定时同步结束：${res.ok ? '成功' : '失败'} ${res.message || ''}`);
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => { tickScheduler().catch(() => {}); }, 30000);
  if (schedulerTimer.unref) schedulerTimer.unref();
  console.log('[qnh] 退单同步定时器已启动（每 30s 检查一次）');
}

// ── Cookie / 环境状态 ───────────────────────────────────────
async function cookieStatus() {
  const res = await runBridge(['status'], 60000);
  return res;
}

async function loginCookie({ headless = false } = {}) {
  const args = ['login'];
  if (headless) args.push('--headless');
  return runBridge(args, headless ? 120000 : 240000);
}

async function testWebhook() {
  return runBridge(['test-webhook'], 30000);
}

// ── 退单列表 / 趋势 / 日志 ──────────────────────────────────
const SORTS = {
  apply_desc: 'r.apply_time DESC, r.refund_no DESC',
  apply_asc: 'r.apply_time ASC, r.refund_no ASC',
  amount_desc: 'r.refund_amount DESC',
  amount_asc: 'r.refund_amount ASC',
};

async function listRefunds(q = {}) {
  const where = [];
  const args = [];

  if (q.from) { where.push('r.apply_time >= ?'); args.push(`${q.from} 00:00:00`); }
  if (q.to) { where.push('r.apply_time <= ?'); args.push(`${q.to} 23:59:59`); }
  if (q.status) { where.push('r.refund_status = ?'); args.push(String(q.status).slice(0, 32)); }
  if (q.type) { where.push('r.refund_type = ?'); args.push(String(q.type).slice(0, 64)); }
  if (q.delivery === '1') where.push('r.has_delivery_log = 1');
  if (q.delivery === '0') where.push('r.has_delivery_log = 0');
  if (q.delivery === 'picked') where.push('r.picked_log = 1');
  if (q.keyword) {
    const kw = `%${String(q.keyword).trim().slice(0, 64)}%`;
    where.push('(r.refund_no LIKE ? OR r.order_no LIKE ? OR r.store_name LIKE ? OR r.receiver_name LIKE ?)');
    args.push(kw, kw, kw, kw);
  }

  const wsql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const page = Math.max(1, Number(q.page) || 1);
  const size = Math.min(200, Math.max(1, Number(q.size) || 20));
  const order = SORTS[q.sort] || SORTS.apply_desc;

  const totalRow = await db.query(`SELECT COUNT(*) AS n FROM qnh_refund_order r${wsql}`, args);
  const rows = await db.query(
    `SELECT r.refund_no, r.order_no, r.store_name, r.channel_name, r.order_status,
            r.refund_status, r.refund_type, r.refund_amount, r.apply_time, r.finish_time,
            r.apply_source, r.is_appeal, r.item_kinds, r.has_delivery_log, r.picked_log, r.refund_qty,
            (SELECT COUNT(*) FROM qnh_refund_log l WHERE l.refund_no = r.refund_no AND l.log_type = 'delivery') AS delivery_cnt,
            (SELECT COUNT(*) FROM qnh_refund_log l WHERE l.refund_no = r.refund_no) AS log_cnt
       FROM qnh_refund_order r${wsql}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`,
    [...args, size, (page - 1) * size]
  );

  return {
    total: Number(totalRow[0].n) || 0,
    page,
    size,
    rows: rows.map((r) => ({
      refundNo: r.refund_no,
      orderNo: r.order_no || '',
      storeName: r.store_name || '',
      channelName: r.channel_name || '',
      orderStatus: r.order_status || '',
      refundStatus: r.refund_status || '',
      refundType: r.refund_type || '',
      refundAmount: r.refund_amount == null ? null : Number(r.refund_amount),
      refundQty: r.refund_qty == null ? null : Number(r.refund_qty),
      applyTime: r.apply_time || '',
      finishTime: r.finish_time || '',
      applySource: r.apply_source || '',
      isAppeal: Number(r.is_appeal) === 1,
      itemKinds: Number(r.item_kinds) || 0,
      hasDeliveryLog: Number(r.has_delivery_log) === 1,
      picked: Number(r.picked_log) === 1,
      deliveryCount: Number(r.delivery_cnt) || 0,
      logCount: Number(r.log_cnt) || 0,
    })),
  };
}

/** 每天退单数量趋势（默认最近 30 天，自动补齐没有退单的日期） */
async function refundTrend(days = 30) {
  const n = Math.min(180, Math.max(1, Number(days) || 30));
  const rows = await db.query(
    `SELECT DATE(apply_time) AS d, COUNT(*) AS c, COALESCE(SUM(refund_amount), 0) AS amt,
            SUM(picked_log = 1) AS delivered
       FROM qnh_refund_order
      WHERE apply_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(apply_time)`,
    [n - 1]
  );
  const map = new Map(
    rows.filter((r) => r.d).map((r) => [
      String(r.d).slice(0, 10),
      { count: Number(r.c) || 0, amount: Number(r.amt) || 0, delivered: Number(r.delivered) || 0 },
    ])
  );

  const out = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = map.get(key) || { count: 0, amount: 0, delivered: 0 };
    out.push({ date: key, ...hit });
  }
  return out;
}

async function getLogs(refundNo, type) {
  const where = ['refund_no = ?'];
  const args = [String(refundNo)];
  if (type === 'order' || type === 'delivery') { where.push('log_type = ?'); args.push(type); }
  const rows = await db.query(
    `SELECT log_type, operator_name, op_time, op_time_ms, content, note
       FROM qnh_refund_log WHERE ${where.join(' AND ')}
      ORDER BY op_time_ms ASC, id ASC
      LIMIT 500`,
    args
  );
  return rows.map((r) => ({
    logType: r.log_type,
    operatorName: r.operator_name || '',
    opTime: r.op_time || '',
    content: r.content || '',
    note: r.note || '',
  }));
}

/** 列表页顶部的汇总数字 */
async function summary() {
  const rows = await db.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(refund_amount), 0) AS amount,
            SUM(has_delivery_log = 1) AS delivered,
            SUM(picked_log = 1) AS picked,
            SUM(DATE(apply_time) = CURDATE()) AS today,
            SUM(is_appeal = 1) AS appeal
       FROM qnh_refund_order`
  );
  const r = rows[0] || {};
  return {
    total: Number(r.total) || 0,
    amount: Number(r.amount) || 0,
    delivered: Number(r.delivered) || 0,
    picked: Number(r.picked) || 0,
    today: Number(r.today) || 0,
    appeal: Number(r.appeal) || 0,
  };
}

module.exports = {
  CFG,
  getConfig,
  setConfig,
  publicConfig,
  resolveSyncDir,
  resolvePython,
  cookieStatus,
  loginCookie,
  testWebhook,
  runSync,
  getSyncState,
  startScheduler,
  tickScheduler,
  listRefunds,
  refundTrend,
  getLogs,
  summary,
};
