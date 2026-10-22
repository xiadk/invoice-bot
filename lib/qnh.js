/**
 * lib/qnh.js — 牵牛花退单：数据查询 / 同步入库 / Cookie 状态 / 调度
 *
 * 分工：
 *   · 读数据 → 直接查 MySQL（qnh_* 表）
 *   · 登录态 → lib/qnh-sync.js（Node + Playwright）
 *   · 拉数据 → lib/qnh-sync.js 的接口层（queryRefundList / afs/detail，Cookie 鉴权）
 *   · 入库   → 本模块（upsert qnh_refund_order / item / log，写 qnh_sync_run 批次）
 *   · 定时   → 进程内定时器（每 30 秒比一次配置的时分），配置存 app_config 表
 *
 * v0.2.4 起 Python 工程（qnh-refund-sync）彻底移除：一套程序、一套配置、一个库。
 */
const db = require('../db');
const qsync = require('./qnh-sync');
const qpage = require('./qnh-page');

// ── 配置项 ───────────────────────────────────────────────────
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

// ── 同步入库（Node 直连接口 + 直写 MySQL）───────────────────
const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const UPSERT_ORDER_SQL = `
INSERT INTO qnh_refund_order (
  refund_no, service_id, qnh_tenant_id, order_no, channel_name, channel_id,
  store_id, store_name, order_status, order_status_code, refund_status, refund_status_code,
  refund_type, is_appeal, apply_source, apply_source_code, apply_reason,
  refund_amount, goods_amount, commission, return_freight, return_freight_actual,
  refund_qty, refund_weight, apply_time, apply_ts, update_ts, finish_time, finish_ts,
  receiver_name, receiver_phone, audit_time, audit_operator, audit_reason,
  item_kinds, detail_synced, has_delivery_log, picked_log, log_synced, sync_batch_id,
  first_seen_at, last_seen_at, raw_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),?)
ON DUPLICATE KEY UPDATE
  service_id=VALUES(service_id), order_no=VALUES(order_no), channel_name=VALUES(channel_name),
  channel_id=VALUES(channel_id), store_id=VALUES(store_id), store_name=VALUES(store_name),
  order_status=VALUES(order_status), order_status_code=VALUES(order_status_code),
  refund_status=VALUES(refund_status), refund_status_code=VALUES(refund_status_code),
  refund_type=VALUES(refund_type), is_appeal=VALUES(is_appeal), apply_source=VALUES(apply_source),
  apply_source_code=VALUES(apply_source_code), apply_reason=VALUES(apply_reason),
  refund_amount=VALUES(refund_amount), goods_amount=VALUES(goods_amount), commission=VALUES(commission),
  return_freight=VALUES(return_freight), return_freight_actual=VALUES(return_freight_actual),
  refund_qty=VALUES(refund_qty), refund_weight=VALUES(refund_weight),
  apply_time=VALUES(apply_time), apply_ts=VALUES(apply_ts), update_ts=VALUES(update_ts),
  finish_time=VALUES(finish_time), finish_ts=VALUES(finish_ts),
  receiver_name=VALUES(receiver_name), receiver_phone=VALUES(receiver_phone),
  audit_time=VALUES(audit_time), audit_operator=VALUES(audit_operator), audit_reason=VALUES(audit_reason),
  item_kinds=VALUES(item_kinds), detail_synced=VALUES(detail_synced),
  has_delivery_log=VALUES(has_delivery_log), picked_log=VALUES(picked_log),
  log_synced=VALUES(log_synced), sync_batch_id=VALUES(sync_batch_id),
  last_seen_at=NOW(), raw_json=VALUES(raw_json)`;

const UPSERT_ITEM_SQL = `
INSERT INTO qnh_refund_item (
  refund_no, qnh_tenant_id, item_key, line_no, item_role, parent_sku, sku, sku_name,
  upc, spec, unit, weight, refund_qty, order_qty, sale_price, origin_price, item_amount,
  pic_url, raw_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON DUPLICATE KEY UPDATE
  line_no=VALUES(line_no), item_role=VALUES(item_role), sku=VALUES(sku), sku_name=VALUES(sku_name),
  upc=VALUES(upc), spec=VALUES(spec), unit=VALUES(unit), weight=VALUES(weight),
  refund_qty=VALUES(refund_qty), order_qty=VALUES(order_qty), sale_price=VALUES(sale_price),
  origin_price=VALUES(origin_price), item_amount=VALUES(item_amount), pic_url=VALUES(pic_url),
  raw_json=VALUES(raw_json)`;

const INSERT_LOG_SQL = `
INSERT INTO qnh_refund_log (
  refund_no, order_no, log_type, operator_name, op_time, op_time_ms, content, note, source, raw_json, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`;

const ORDER_COLS = [
  'refund_no', 'service_id', 'qnh_tenant_id', 'order_no', 'channel_name', 'channel_id',
  'store_id', 'store_name', 'order_status', 'order_status_code', 'refund_status', 'refund_status_code',
  'refund_type', 'is_appeal', 'apply_source', 'apply_source_code', 'apply_reason',
  'refund_amount', 'goods_amount', 'commission', 'return_freight', 'return_freight_actual',
  'refund_qty', 'refund_weight', 'apply_time', 'apply_ts', 'update_ts', 'finish_time', 'finish_ts',
  'receiver_name', 'receiver_phone', 'audit_time', 'audit_operator', 'audit_reason',
  'item_kinds', 'detail_synced', 'has_delivery_log', 'picked_log', 'log_synced', 'sync_batch_id',
];
const ITEM_COLS = [
  'refund_no', 'qnh_tenant_id', 'item_key', 'line_no', 'item_role', 'parent_sku', 'sku', 'sku_name',
  'upc', 'spec', 'unit', 'weight', 'refund_qty', 'order_qty', 'sale_price', 'origin_price', 'item_amount',
  'pic_url', 'raw_json',
];
const LOG_COLS = [
  'refund_no', 'order_no', 'log_type', 'operator_name', 'op_time', 'op_time_ms', 'content', 'note', 'source', 'raw_json',
];
const toParams = (cols, row) => cols.map((c) => (row[c] === undefined ? null : row[c]));

/** 单条退单入库：order upsert + 日志重建。返回 {ok, isNew, detailPending} */
async function upsertRefund(row, logs, batchId) {
  const existed = await db.query(
    'SELECT detail_synced, update_ts FROM qnh_refund_order WHERE refund_no = ? LIMIT 1',
    [row.refund_no]
  );
  // 已同步过明细且接口侧 update_ts 没变 → 保留 detail_synced=1，本轮不必重拉明细
  if (
    existed.length &&
    Number(existed[0].update_ts) === Number(row.update_ts) &&
    Number(existed[0].detail_synced) === 1
  ) {
    row.detail_synced = 1;
  }
  await db.exec(UPSERT_ORDER_SQL, [...toParams(ORDER_COLS, row), row.raw_json]);
  // 日志以接口为准重建（source='list'），避免反复同步翻倍
  await db.exec('DELETE FROM qnh_refund_log WHERE refund_no = ? AND source = ?', [row.refund_no, 'list']);
  for (const l of logs) {
    await db.exec(INSERT_LOG_SQL, [...toParams(LOG_COLS, l), l.raw_json]);
  }
  return { ok: true, isNew: !existed.length, detailPending: Number(row.detail_synced) === 0, logCount: logs.length, batchId };
}

/** 拉单条明细并入库商品行。成功后置 detail_synced=1 */
async function syncRefundDetail(rec, batchId) {
  const o = rec.orderVO || {};
  const r = await qsync.fetchRefundDetail({
    channelOrderId: o.channelOrderId,
    channelId: o.channelId,
    channelAfsId: rec.afterSaleId,
  });
  if (!r.ok) return r;
  const mapped = qsync._internals.mapRefundItems(String(rec.afterSaleId), o.tenantId, r.items, { batchId });
  await db.exec('DELETE FROM qnh_refund_item WHERE refund_no = ?', [String(rec.afterSaleId)]);
  for (const it of mapped) {
    await db.exec(UPSERT_ITEM_SQL, toParams(ITEM_COLS, it));
  }
  await db.exec(
    'UPDATE qnh_refund_order SET detail_synced = 1, item_kinds = ? WHERE refund_no = ?',
    [mapped.length || null, String(rec.afterSaleId)]
  );
  return { ok: true, items: mapped.length };
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

const DEFAULT_SYNC_DAYS = 7;
// 明细接口逐条拉（限速防风控）；单次同步的明细上限，超出的下次补拉
const DETAIL_SLEEP_MS = Number(process.env.QNH_DETAIL_SLEEP_MS) || 1500;
const DETAIL_LIMIT = Number(process.env.QNH_DETAIL_LIMIT) || 80;

async function runSync({ trigger = 'manual', days = null, date = null } = {}) {
  if (syncState.running) {
    return { ok: false, running: true, message: '已有同步任务在运行，请稍候' };
  }
  syncState.running = true;
  syncState.startedAt = new Date().toISOString();
  const startedAt = new Date();
  try {
    // 0. 登录态检查（没有 Cookie 就无从拉取）
    const st = await qsync.status({ probe: true }).catch(() => null);
    if (!st || !st.logined) {
      const msg = st && st.configured
        ? '登录态已失效：请先点「登录牵牛花」重新登录'
        : '尚未登录牵牛花：请先点「登录牵牛花」';
      return { ok: false, message: msg };
    }

    // 1. 同步窗口：默认近 7 天；days 覆盖（1~90）；date 指定某一天
    const end = new Date();
    let start = new Date(end.getTime() - DEFAULT_SYNC_DAYS * 86400000);
    if (date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date).slice(0, 10));
      if (m) {
        start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
        end.setTime(start.getTime() + 86400000 - 1);
      }
    } else if (days) {
      const n = Math.max(1, Math.min(90, Number(days) || DEFAULT_SYNC_DAYS));
      start = new Date(end.getTime() - n * 86400000);
    }
    const startMs = start.getTime();
    const endMs = end.getTime();

    // 2. 分页拉全量列表（页间限速在 qnh-sync 内）
    const lr = await qsync.fetchAllRefunds({
      startMs,
      endMs,
      onPage: (p, pi) => console.log(`[qnh] 拉取列表 ${p}/${pi.totalPage} 页`),
    });
    if (!lr.ok) {
      await db.exec(
        `INSERT INTO qnh_sync_run (started_at, finished_at, window_start, window_end, refunds, new_refunds, items, failed, status, message)
         VALUES (NOW(),NOW(),?,?,0,0,0,1,'failed',?)`,
        [fmtLocal(start), fmtLocal(end), String(lr.message || '拉取退单列表失败').slice(0, 500)]
      );
      return { ok: false, message: lr.message || '拉取退单列表失败' };
    }

    // 3. 逐条入库（order upsert + 审核日志重建）
    const batchId = Date.now();
    let newCount = 0;
    let logCount = 0;
    const failures = [];
    const pendingDetail = [];
    for (const rec of lr.records) {
      const m = qsync._internals.mapRefundRecord(rec, { batchId });
      if (!m) { failures.push('记录缺 afterSaleId，已跳过'); continue; }
      try {
        const r = await upsertRefund(m.row, m.logs, batchId);
        if (r.isNew) newCount += 1;
        logCount += r.logCount;
        if (r.detailPending) pendingDetail.push(rec);
      } catch (e) {
        failures.push(`${m.row.refund_no}: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    }

    // 4. 明细补拉（限速 + 单次上限；配送轨迹接口需签名，Node 侧暂不拉取）
    let itemsTotal = 0;
    let detailFail = 0;
    let detailSkipped = 0;
    for (let i = 0; i < pendingDetail.length; i += 1) {
      if (i >= DETAIL_LIMIT) { detailSkipped = pendingDetail.length - i; break; }
      const rec = pendingDetail[i];
      try {
        const dr = await syncRefundDetail(rec, batchId);
        if (dr.ok) itemsTotal += dr.items;
        else {
          detailFail += 1;
          if (dr.loginRequired) { detailSkipped = pendingDetail.length - i - 1; break; }
        }
      } catch (e) { detailFail += 1; }
      await new Promise((r2) => setTimeout(r2, DETAIL_SLEEP_MS));
    }

    // 5. 批次落库 + 返回
    const failed = failures.length + detailFail;
    const status = !lr.records.length && (failures.length || detailFail)
      ? 'failed'
      : (failed || detailSkipped ? 'partial' : 'success');
    const msgParts = [];
    if (failures.length) msgParts.push(`列表入库失败 ${failures.length} 条`);
    if (detailFail) msgParts.push(`明细失败 ${detailFail} 条`);
    if (detailSkipped) msgParts.push(`明细已达单次上限，剩余 ${detailSkipped} 条下次补拉`);
    const message = msgParts.join('；');
    await db.exec(
      `INSERT INTO qnh_sync_run (started_at, finished_at, window_start, window_end, refunds, new_refunds, items, failed, status, message)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [fmtLocal(startedAt), fmtLocal(new Date()), fmtLocal(start), fmtLocal(end),
       Number(lr.total) || lr.records.length, newCount, itemsTotal, failed, status, message.slice(0, 500)]
    );
    console.log(`[qnh] 同步完成：列表 ${lr.records.length}（新 ${newCount}），明细行 ${itemsTotal}，失败 ${failed}，状态 ${status}`);

    syncState.lastResult = {
      ok: status !== 'failed', trigger, refunds: lr.records.length, newRefunds: newCount,
      items: itemsTotal, failed, status, message,
    };
    syncState.lastFinishedAt = new Date().toISOString();
    return { ...syncState.lastResult, lastRun: await readLastRun(), stats: await refundCounts() };
  } catch (e) {
    // 异常也落一条失败批次，页面能看到原因
    try {
      await db.exec(
        "INSERT INTO qnh_sync_run (started_at, finished_at, refunds, new_refunds, items, failed, status, message) VALUES (NOW(),NOW(),0,0,0,1,'failed',?)",
        [String((e && e.message) || e).slice(0, 500)]
      );
    } catch (e2) { /* 落库失败就只返回错误 */ }
    return { ok: false, message: '同步失败：' + String((e && e.message) || e).slice(0, 200) };
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
// ── 库侧事实（即使登录态不可用，页面也要能看到「上次同步到哪」）──
async function readLastRun() {
  const rows = await db.query(
    `SELECT id, started_at, finished_at, refunds, new_refunds, items, failed, status, message
       FROM qnh_sync_run ORDER BY id DESC LIMIT 1`
  );
  const r = rows && rows[0];
  if (!r) return null;
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    refunds: r.refunds,
    newRefunds: r.new_refunds,
    items: r.items,
    failed: r.failed,
    status: r.status,
    message: r.message,
  };
}

async function refundCounts() {
  const rows = await db.query(
    `SELECT (SELECT COUNT(*) FROM qnh_refund_order) AS orders,
            (SELECT COUNT(*) FROM qnh_refund_item) AS items,
            (SELECT COUNT(*) FROM qnh_refund_log) AS logs`
  );
  const r = (rows && rows[0]) || {};
  return {
    orders: r.orders == null ? null : Number(r.orders),
    items: r.items == null ? null : Number(r.items),
    logs: r.logs == null ? null : Number(r.logs),
  };
}

async function cookieStatus() {
  // 登录态改由 Node 判断（lib/qnh-sync.js），不再 spawn Python；
  // 同时补齐库侧事实，桥接/登录不可用时页面仍能显示上次同步批次与表行数。
  let st;
  try {
    st = await qsync.status();
  } catch (e) {
    st = { ok: false, configured: false, logined: false, message: '读取登录态失败：' + String((e && e.message) || e) };
  }
  const out = { ...st };

  try {
    out.lastRun = await readLastRun();
  } catch (e) {
    out.lastRun = null;
    out.dbError = String((e && e.message) || e).slice(0, 200);
  }
  try {
    out.stats = await refundCounts();
  } catch (e) {
    out.stats = { orders: null, items: null, logs: null };
  }
  return out;
}

async function loginCookie({ headless = false } = {}) {
  const r = await qsync.login({ headless, timeoutMs: headless ? 120000 : 240000 });
  if (!r.ok) return r;
  // 与旧 bridge.py 的 cmd_login 返回形态保持一致：登录后附带最新状态（前端契约不变）
  const st = await cookieStatus();
  return { ...st, refreshed: true };
}

/** 企业微信机器人测试消息（Node fetch 直发，不再经 Python） */
async function testWebhook() {
  let url = '';
  try {
    const cfg = await getConfig();
    url = String(cfg[CFG.webhook] || '').trim();
  } catch (e) {
    return { ok: false, message: '读取 webhook 配置失败：' + String((e && e.message) || e).slice(0, 150) };
  }
  if (!url) return { ok: false, message: '未配置企业微信机器人 webhook' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          content: '### 退单提醒 · 测试消息\n> 收到这条说明机器人配置正常。\n> 时间：' + fmtLocal(new Date()),
        },
      }),
    });
    const j = await res.json().catch(() => null);
    if (j && j.errcode === 0) return { ok: true, message: '已发送' };
    return { ok: false, message: (j && (j.errmsg || JSON.stringify(j))) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: '发送失败：' + String((e && e.message) || e).slice(0, 200) };
  }
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

// ── 配送日志：点「日志」时按需经常驻浏览器拉取（newQueryList → orderOperatorLogList）──
const ROUTE_SRC_RE = /取货|揽收|送达|收货/;
const routeLocks = new Map(); // 同一退单并发去重

function mapRouteLogs(refundNo, orderNo, rawLogs) {
  const msToDate = qsync._internals.msToDate;
  return rawLogs.map((l) => {
    const ms = Number(l.operationTime) || 0;
    const desc = String(l.operatorDesc || '');
    const comment = String(l.comment || '');
    return {
      refund_no: String(refundNo),
      order_no: orderNo || null,
      log_type: 'delivery',
      operator_name: String(l.operatorName || '') || null,
      op_time: ms ? msToDate(ms) : null,
      op_time_ms: ms || null,
      content: comment ? `${desc}：${comment}` : desc,
      note: String(l.operatorType || '') || null,
      source: 'route',
      raw_json: JSON.stringify(l),
    };
  });
}

/** 确保退单有配送日志：库里没有就实时拉一次并落库。返回 {note} 或 null（无需拉取） */
async function ensureDeliveryLogs(refundNo) {
  const key = String(refundNo);
  const rows = await db.query(
    'SELECT refund_no, order_no, has_delivery_log FROM qnh_refund_order WHERE refund_no = ? LIMIT 1',
    [key]
  );
  const rec = rows[0];
  if (!rec || Number(rec.has_delivery_log) === 1 || !rec.order_no) return null;

  const cnt = await db.query(
    "SELECT COUNT(*) AS c FROM qnh_refund_log WHERE refund_no = ? AND log_type = 'delivery'",
    [key]
  );
  if (Number(cnt[0].c) > 0) {
    await db.exec('UPDATE qnh_refund_order SET has_delivery_log = 1 WHERE refund_no = ?', [key]);
    return null;
  }

  if (routeLocks.has(key)) return routeLocks.get(key);
  const task = (async () => {
    const r = await qpage.fetchOrderLogs(rec.order_no);
    if (!r.ok) return { note: '配送日志获取失败：' + (r.message || '未知原因') };
    if (!r.logs.length) return { note: r.message || '接口未返回该订单的操作日志' };
    const mapped = mapRouteLogs(key, rec.order_no, r.logs);
    await db.exec("DELETE FROM qnh_refund_log WHERE refund_no = ? AND source = 'route'", [key]);
    for (const l of mapped) {
      await db.exec(INSERT_LOG_SQL, [...toParams(LOG_COLS, l), l.raw_json]);
    }
    const picked = mapped.some((l) => ROUTE_SRC_RE.test(`${l.content || ''}${l.note || ''}`)) ? 1 : 0;
    await db.exec(
      'UPDATE qnh_refund_order SET has_delivery_log = 1, picked_log = GREATEST(picked_log, ?) WHERE refund_no = ?',
      [picked, key]
    );
    return { note: `已从订单接口拉取 ${mapped.length} 条配送日志` };
  })().finally(() => routeLocks.delete(key));
  routeLocks.set(key, task);
  return task;
}

/** 日志查询 + 按需补拉配送日志（type='order' 时不动浏览器） */
async function getLogsWithRoute(refundNo, type) {
  let route = null;
  if (type !== 'order') {
    try {
      route = await ensureDeliveryLogs(refundNo);
    } catch (e) {
      route = { note: '配送日志获取失败：' + String((e && e.message) || e).slice(0, 150) };
    }
  }
  const logs = await getLogs(refundNo, type);
  return { logs, route };
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
  getLogsWithRoute,
  ensureDeliveryLogs,
  summary,
  // 供隔离测试断言
  _internals: { upsertRefund, syncRefundDetail, toParams, ORDER_COLS, ITEM_COLS, LOG_COLS, mapRouteLogs },
};
