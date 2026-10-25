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
const qagent = require('./qnh-agent');

// ── 配置项 ───────────────────────────────────────────────────
const CFG = {
  scheduleEnabled: 'qnh.schedule_enabled',
  scheduleTime: 'qnh.schedule_time',        // 旧版单时间点（向后兼容读取）
  scheduleTimes: 'qnh.schedule_times',      // 新版多时间点，逗号分隔 "03:00,15:00"
  webhook: 'qnh.wecom_webhook',
  wecomEnabled: 'qnh.wecom_enabled',
  alertDelivery: 'qnh.alert_delivery_log',
  remindTemplate: 'qnh.remind_template',    // 提醒模板：逗号分隔字段名
  profitEnabled: 'qnh.profit_enabled',      // 实时毛利监控开关
  profitWebhook: 'qnh.profit_webhook',      // 毛利告警专用机器人（与退单提醒完全分开配置）
  profitWecomEnabled: 'qnh.profit_wecom_enabled', // 毛利告警机器人开关
  profitMinAmount: 'qnh.profit_min_amount', // 线上毛利低于该值（元）告警，可为负（亏多少以上告警）
  profitMinRate: 'qnh.profit_min_rate',     // 线上毛利率低于该值（%）告警，可为负
  profitLastPullAt: 'qnh.profit_last_pull_at',
  profitLastPullCount: 'qnh.profit_last_pull_count',
  profitLastError: 'qnh.profit_last_error',  // 最近一次拉取失败原因（诊断用，成功时清空）
  profitPoiIds: 'qnh.profit_poi_ids',        // 毛利查询门店 ID，逗号分隔（默认取页面抓包值）
  profitChannelIds: 'qnh.profit_channel_ids', // 毛利查询渠道，逗号分隔（默认 100,200,300）
  profitPageSize: 'qnh.profit_page_size',    // 毛利每页条数（可配，分页拉全量）
  lastAutoDate: 'qnh.last_auto_date',
  lastAutoSlots: 'qnh.last_auto_slots',     // 今天已触发过的时间点（逗号分隔）
  lastAutoAt: 'qnh.last_auto_at',
};

const DEFAULTS = {
  [CFG.scheduleEnabled]: '0',
  [CFG.scheduleTime]: '03:00',
  [CFG.scheduleTimes]: '03:00',
  [CFG.webhook]: '',
  [CFG.wecomEnabled]: '0',
  [CFG.alertDelivery]: '1',
  [CFG.remindTemplate]: '订单号,渠道,退单类型',
  [CFG.profitEnabled]: '0',
  [CFG.profitWebhook]: '',
  [CFG.profitWecomEnabled]: '0',
  [CFG.profitMinAmount]: '0',
  [CFG.profitMinRate]: '0',
  [CFG.profitLastPullCount]: '0',
  [CFG.profitLastError]: '',
  [CFG.profitPoiIds]: '1101146',
  [CFG.profitChannelIds]: '100,200,300',
  [CFG.profitPageSize]: '50',
};

/** 读一组配置（带默认值）——全局项（定时同步等，存 app_config） */
async function getConfig() {
  const rows = await db.query('SELECT `key`, `value` FROM app_config');
  const map = {};
  for (const r of rows) map[r.key] = r.value == null ? '' : r.value;
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) out[k] = map[k] === undefined ? def : map[k];
  // 老配置只有单时间点：迁移到多时间点
  if (!map[CFG.scheduleTimes] && map[CFG.scheduleTime]) out[CFG.scheduleTimes] = map[CFG.scheduleTime];
  out[CFG.lastAutoDate] = map[CFG.lastAutoDate] || '';
  out[CFG.lastAutoSlots] = map[CFG.lastAutoSlots] || '';
  out[CFG.lastAutoAt] = map[CFG.lastAutoAt] || '';
  out[CFG.profitLastPullAt] = map[CFG.profitLastPullAt] || '';
  out[CFG.profitLastError] = map[CFG.profitLastError] || '';
  return out;
}

/** 写全局配置（只允许白名单 key） */
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

// ── 按用户的配置（存 qnh_user_config）：提醒机器人 / 告警阈值 / 拉取参数 ──
// 「登录了哪位用户的牵牛花就是谁的数据」，提醒与告警自然也发给用户自己的机器人。
const USER_CFG_KEYS = new Set([
  CFG.webhook, CFG.wecomEnabled, CFG.alertDelivery, CFG.remindTemplate,
  CFG.profitEnabled, CFG.profitWebhook, CFG.profitWecomEnabled,
  CFG.profitMinAmount, CFG.profitMinRate,
  CFG.profitLastPullAt, CFG.profitLastPullCount, CFG.profitLastError,
  CFG.profitPoiIds, CFG.profitChannelIds, CFG.profitPageSize,
]);

/** 读某用户的合并配置：全局默认 + 该用户覆盖项 */
async function getConfigFor(userId) {
  const gid = Number(userId) || 0;
  const base = await getConfig();
  if (!gid) return base;
  const rows = await db.query(
    'SELECT `key`, `value` FROM qnh_user_config WHERE user_id = ?',
    [gid]
  );
  for (const r of rows) {
    if (USER_CFG_KEYS.has(r.key) && r.value != null) base[r.key] = r.value;
  }
  return base;
}

/** 写某用户的配置（只允许按用户级 key；写库前先清掉与全局相同的冗余值也可以，此处简单直写） */
async function setUserConfig(userId, patch) {
  const gid = Number(userId) || 0;
  if (!gid) return getConfig();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!USER_CFG_KEYS.has(k)) continue;
    await db.exec(
      'INSERT INTO qnh_user_config (user_id, `key`, `value`) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [gid, k, v == null ? '' : String(v)]
    );
  }
  return getConfigFor(gid);
}

/** 把库里的配置翻译成前端友好的结构 */
function parseScheduleTimes(v) {
  const seen = new Set();
  const out = [];
  for (const part of String(v || '').split(/[,，;；\s]+/)) {
    const t = part.trim();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** 提醒模板支持的字段（标签 → 取值函数） */
const TEMPLATE_FIELDS = {
  '订单号': (r) => r.serialNo || r.orderNo || '',
  '渠道': (r) => r.channelName || '',
  '退单类型': (r) => r.refundType || '',
  '门店': (r) => r.storeName || '',
  '金额': (r) => (r.refundAmount == null ? '' : `¥${Number(r.refundAmount).toFixed(2)}`),
  '收货人': (r) => r.receiverName || '',
  '地址': (r) => r.receiverAddress || '',
  '申请时间': (r) => r.applyTime || '',
  '退单号': (r) => r.refundNo || '',
  '退单状态': (r) => r.refundStatus || '',
};

/** 按模板渲染一条退单的提醒文本。模板非法/为空时退回默认三字段 */
function renderRefundLine(row, template) {
  const labels = String(template || '').split(/[,，、|]+/).map((s) => s.trim()).filter(Boolean);
  const valid = labels.filter((l) => TEMPLATE_FIELDS[l]);
  const use = valid.length ? valid : ['订单号', '渠道', '退单类型'];
  return use.map((l) => `${l}:${TEMPLATE_FIELDS[l](row) || '—'}`).join(' · ');
}

function publicConfig(cfg) {
  return {
    scheduleEnabled: cfg[CFG.scheduleEnabled] === '1',
    scheduleTime: cfg[CFG.scheduleTime] || '03:00',
    scheduleTimes: parseScheduleTimes(cfg[CFG.scheduleTimes] || cfg[CFG.scheduleTime] || '03:00'),
    webhook: cfg[CFG.webhook] || '',
    wecomEnabled: cfg[CFG.wecomEnabled] === '1',
    alertDelivery: cfg[CFG.alertDelivery] !== '0',
    remindTemplate: cfg[CFG.remindTemplate] || '订单号,渠道,退单类型',
    profitEnabled: cfg[CFG.profitEnabled] === '1',
    profitWebhook: cfg[CFG.profitWebhook] || '',
    profitWecomEnabled: cfg[CFG.profitWecomEnabled] === '1',
    profitMinAmount: Number(cfg[CFG.profitMinAmount]) || 0,
    profitMinRate: Number(cfg[CFG.profitMinRate]) || 0,
    profitLastPullAt: cfg[CFG.profitLastPullAt] || '',
    profitLastPullCount: Number(cfg[CFG.profitLastPullCount]) || 0,
    profitLastError: cfg[CFG.profitLastError] || '',
    profitPoiIds: cfg[CFG.profitPoiIds] || '1101146',
    profitChannelIds: cfg[CFG.profitChannelIds] || '100,200,300',
    profitPageSize: Number(cfg[CFG.profitPageSize]) || 50,
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
  user_id, refund_no, service_id, qnh_tenant_id, order_no, serial_no, channel_name, channel_id,
  store_id, store_name, order_status, order_status_code, refund_status, refund_status_code,
  refund_type, is_appeal, apply_source, apply_source_code, apply_reason,
  refund_amount, goods_amount, commission, return_freight, return_freight_actual,
  refund_qty, refund_weight, apply_time, apply_ts, update_ts, finish_time, finish_ts,
  receiver_name, receiver_phone, receiver_address, paid_time, paid_ts,
  audit_time, audit_operator, audit_reason,
  item_kinds, detail_synced, has_delivery_log, picked_log, log_synced, sync_batch_id,
  first_seen_at, last_seen_at, raw_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),?)
ON DUPLICATE KEY UPDATE
  service_id=VALUES(service_id), order_no=VALUES(order_no), serial_no=COALESCE(VALUES(serial_no), serial_no),
  channel_name=VALUES(channel_name),
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
  receiver_address=COALESCE(VALUES(receiver_address), receiver_address),
  paid_time=COALESCE(VALUES(paid_time), paid_time), paid_ts=COALESCE(VALUES(paid_ts), paid_ts),
  audit_time=VALUES(audit_time), audit_operator=VALUES(audit_operator), audit_reason=VALUES(audit_reason),
  item_kinds=VALUES(item_kinds), detail_synced=VALUES(detail_synced),
  has_delivery_log=VALUES(has_delivery_log), picked_log=VALUES(picked_log),
  log_synced=VALUES(log_synced), sync_batch_id=VALUES(sync_batch_id),
  last_seen_at=NOW(), raw_json=VALUES(raw_json)`;

const UPSERT_ITEM_SQL = `
INSERT INTO qnh_refund_item (
  user_id, refund_no, qnh_tenant_id, item_key, line_no, item_role, parent_sku, sku, sku_name,
  upc, spec, unit, weight, refund_qty, order_qty, sale_price, origin_price, item_amount,
  pic_url, raw_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON DUPLICATE KEY UPDATE
  line_no=VALUES(line_no), item_role=VALUES(item_role), sku=VALUES(sku), sku_name=VALUES(sku_name),
  upc=VALUES(upc), spec=VALUES(spec), unit=VALUES(unit), weight=VALUES(weight),
  refund_qty=VALUES(refund_qty), order_qty=VALUES(order_qty), sale_price=VALUES(sale_price),
  origin_price=VALUES(origin_price), item_amount=VALUES(item_amount), pic_url=VALUES(pic_url),
  raw_json=VALUES(raw_json)`;

const INSERT_LOG_SQL = `
INSERT INTO qnh_refund_log (
  user_id, refund_no, order_no, log_type, operator_name, op_time, op_time_ms, content, note, source, raw_json, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`;

const ORDER_COLS = [
  'user_id',
  'refund_no', 'service_id', 'qnh_tenant_id', 'order_no', 'serial_no', 'channel_name', 'channel_id',
  'store_id', 'store_name', 'order_status', 'order_status_code', 'refund_status', 'refund_status_code',
  'refund_type', 'is_appeal', 'apply_source', 'apply_source_code', 'apply_reason',
  'refund_amount', 'goods_amount', 'commission', 'return_freight', 'return_freight_actual',
  'refund_qty', 'refund_weight', 'apply_time', 'apply_ts', 'update_ts', 'finish_time', 'finish_ts',
  'receiver_name', 'receiver_phone', 'receiver_address', 'paid_time', 'paid_ts',
  'audit_time', 'audit_operator', 'audit_reason',
  'item_kinds', 'detail_synced', 'has_delivery_log', 'picked_log', 'log_synced', 'sync_batch_id',
];
const ITEM_COLS = [
  'user_id',
  'refund_no', 'qnh_tenant_id', 'item_key', 'line_no', 'item_role', 'parent_sku', 'sku', 'sku_name',
  'upc', 'spec', 'unit', 'weight', 'refund_qty', 'order_qty', 'sale_price', 'origin_price', 'item_amount',
  'pic_url', 'raw_json',
];
const LOG_COLS = [
  'user_id',
  'refund_no', 'order_no', 'log_type', 'operator_name', 'op_time', 'op_time_ms', 'content', 'note', 'source', 'raw_json',
];
const toParams = (cols, row) => cols.map((c) => (row[c] === undefined ? null : row[c]));

/** 单条退单入库：order upsert + 日志重建。返回 {ok, isNew, detailPending}。userId=数据归属用户 */
async function upsertRefund(row, logs, batchId, userId = 0) {
  row.user_id = Number(userId) || 0;
  const existed = await db.query(
    'SELECT detail_synced, update_ts FROM qnh_refund_order WHERE user_id = ? AND refund_no = ? LIMIT 1',
    [row.user_id, row.refund_no]
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
  await db.exec('DELETE FROM qnh_refund_log WHERE user_id = ? AND refund_no = ? AND source = ?', [row.user_id, row.refund_no, 'list']);
  for (const l of logs) {
    l.user_id = row.user_id;
    await db.exec(INSERT_LOG_SQL, [...toParams(LOG_COLS, l), l.raw_json]);
  }
  return { ok: true, isNew: !existed.length, detailPending: Number(row.detail_synced) === 0, logCount: logs.length, batchId };
}

/** 拉单条明细并入库商品行。成功后置 detail_synced=1 */
async function syncRefundDetail(rec, batchId, userId = 0) {
  const o = rec.orderVO || {};
  const r = await qsync.fetchRefundDetail({
    channelOrderId: o.channelOrderId,
    channelId: o.channelId,
    channelAfsId: rec.afterSaleId,
    userId,
  });
  if (!r.ok) return r;
  const mapped = qsync._internals.mapRefundItems(String(rec.afterSaleId), o.tenantId, r.items, { batchId });
  await db.exec('DELETE FROM qnh_refund_item WHERE user_id = ? AND refund_no = ?', [Number(userId) || 0, String(rec.afterSaleId)]);
  for (const it of mapped) {
    it.user_id = Number(userId) || 0;
    await db.exec(UPSERT_ITEM_SQL, toParams(ITEM_COLS, it));
  }
  await db.exec(
    'UPDATE qnh_refund_order SET detail_synced = 1, item_kinds = ? WHERE user_id = ? AND refund_no = ?',
    [mapped.length || null, Number(userId) || 0, String(rec.afterSaleId)]
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

/**
 * 同步窗口。⚠ 2026-10-23 起**默认只拉当天**（定时与看板「立即刷新数据」都是）：
 *   历史数据首次部署时全量补一次即可，之后每天只增量拉当天，请求量小、不易触发风控。
 *   days/date 参数保留给「补历史数据」场景（仅 API 显式传参时生效）。
 */
function resolveSyncWindow({ days = null, date = null } = {}) {
  const end = new Date();
  let start = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0, 0, 0); // 今天 00:00
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
  return { start, end };
}

/** 同步完成后把新退单按模板推送到企业微信（每条只推一次；用该用户自己的机器人与模板） */
async function notifyNewRefunds(newRows, { trigger = 'manual', userId = 0 } = {}) {
  if (!Array.isArray(newRows) || !newRows.length) return { ok: true, sent: 0 };
  const cfg = await getConfigFor(userId);
  if (cfg[CFG.wecomEnabled] !== '1' || !cfg[CFG.webhook]) return { ok: false, sent: 0, message: '未开启企业微信通知' };
  const uid = Number(userId) || 0;

  const rows = [];
  for (const r of newRows) {
    const hit = await db.query(
      "SELECT id FROM qnh_alert_log WHERE user_id = ? AND refund_no = ? AND alert_type = 'new_refund' LIMIT 1",
      [uid, r.refundNo]
    );
    if (!hit.length) rows.push(r);
  }
  if (!rows.length) return { ok: true, sent: 0 };

  const lines = rows.slice(0, 20).map((r) => `> ${renderRefundLine(r, cfg[CFG.remindTemplate])}`);
  const head = `### 退单提醒（${trigger === 'schedule' ? '定时同步' : '手动同步'}）\n`
    + `> 新增退单 **${rows.length}** 笔${rows.length > 20 ? '（仅展示前 20 条）' : ''}\n`;
  const r = await sendWecomMarkdown(head + lines.join('\n'), cfg);
  if (r.ok) {
    for (const row of rows) {
      await db.exec(
        "INSERT INTO qnh_alert_log (user_id, refund_no, alert_type, content, status) VALUES (?, ?, 'new_refund', ?, 'ok') " +
        'ON DUPLICATE KEY UPDATE sent_at = NOW()',
        [uid, row.refundNo, renderRefundLine(row, cfg[CFG.remindTemplate]).slice(0, 1000)]
      ).catch(() => {});
    }
  }
  return { ok: r.ok, sent: r.ok ? rows.length : 0, message: r.message };
}

async function runSync({ trigger = 'manual', days = null, date = null, userId = 0 } = {}) {
  const uid = Number(userId) || 0;
  if (syncState.running) {
    return { ok: false, running: true, message: '已有同步任务在运行，请稍候' };
  }
  syncState.running = true;
  syncState.startedAt = new Date().toISOString();
  const startedAt = new Date();
  try {
    // 0. 登录态检查（该用户自己的登录态；没有 Cookie 就无从拉取）
    const st = await qsync.status({ probe: true, userId: uid }).catch(() => null);
    if (!st || !st.logined) {
      const msg = st && st.configured
        ? '登录态已失效：请先点「登录牵牛花」重新登录'
        : '尚未登录牵牛花：请先点「登录牵牛花」';
      return { ok: false, message: msg };
    }

    // 1. 同步窗口：默认只拉当天（定时/手动一致）；days/date 仅在显式传参时用于补历史
    const { start, end } = resolveSyncWindow({ days, date });
    const startMs = start.getTime();
    const endMs = end.getTime();

    // 2. 分页拉全量列表（页间限速在 qnh-sync 内；用该用户的 Cookie）
    const lr = await qsync.fetchAllRefunds({
      startMs,
      endMs,
      userId: uid,
      onPage: (p, pi) => console.log(`[qnh] 拉取列表 ${p}/${pi.totalPage} 页`),
    });
    if (!lr.ok) {
      await db.exec(
        `INSERT INTO qnh_sync_run (user_id, started_at, finished_at, window_start, window_end, refunds, new_refunds, items, failed, status, message)
         VALUES (?,NOW(),NOW(),?,?,0,0,0,1,'failed',?)`,
        [uid, fmtLocal(start), fmtLocal(end), String(lr.message || '拉取退单列表失败').slice(0, 500)]
      );
      return { ok: false, message: lr.message || '拉取退单列表失败' };
    }

    // 3. 逐条入库（order upsert + 审核日志重建）
    const batchId = Date.now();
    let newCount = 0;
    let logCount = 0;
    const failures = [];
    const pendingDetail = [];
    const newRows = [];   // 本轮新入库的退单（用于企业微信提醒）
    for (const rec of lr.records) {
      const m = qsync._internals.mapRefundRecord(rec, { batchId });
      if (!m) { failures.push('记录缺 afterSaleId，已跳过'); continue; }
      try {
        const r = await upsertRefund(m.row, m.logs, batchId, uid);
        if (r.isNew) {
          newCount += 1;
          newRows.push({
            refundNo: m.row.refund_no, orderNo: m.row.order_no || '', serialNo: m.row.serial_no || '',
            channelName: m.row.channel_name || '', refundType: m.row.refund_type || '',
            storeName: m.row.store_name || '', refundAmount: m.row.refund_amount,
            receiverName: m.row.receiver_name || '', receiverAddress: m.row.receiver_address || '',
            applyTime: m.row.apply_time || '', refundStatus: m.row.refund_status || '',
          });
        }
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
        const dr = await syncRefundDetail(rec, batchId, uid);
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
      `INSERT INTO qnh_sync_run (user_id, started_at, finished_at, window_start, window_end, refunds, new_refunds, items, failed, status, message)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, fmtLocal(startedAt), fmtLocal(new Date()), fmtLocal(start), fmtLocal(end),
       Number(lr.total) || lr.records.length, newCount, itemsTotal, failed, status, message.slice(0, 500)]
    );
    console.log(`[qnh] 同步完成：列表 ${lr.records.length}（新 ${newCount}），明细行 ${itemsTotal}，失败 ${failed}，状态 ${status}`);

    syncState.lastResult = {
      ok: status !== 'failed', trigger, refunds: lr.records.length, newRefunds: newCount,
      items: itemsTotal, failed, status, message,
    };
    syncState.lastFinishedAt = new Date().toISOString();

    // 6. 新退单企业微信提醒（按模板渲染，逐条去重；失败不影响同步结果）
    let notify = { ok: true, sent: 0 };
    if (newRows.length) {
      notify = await notifyNewRefunds(newRows, { trigger, userId: uid }).catch((e) => ({ ok: false, sent: 0, message: e.message }));
      if (notify.sent) console.log(`[qnh] 新退单提醒已推送 ${notify.sent} 条`);
    }

    return { ...syncState.lastResult, lastRun: await readLastRun(uid), stats: await refundCounts(uid), notify };
  } catch (e) {
    // 异常也落一条失败批次，页面能看到原因
    try {
      await db.exec(
        "INSERT INTO qnh_sync_run (user_id, started_at, finished_at, refunds, new_refunds, items, failed, status, message) VALUES (?,NOW(),NOW(),0,0,0,1,'failed',?)",
        [uid, String((e && e.message) || e).slice(0, 500)]
      );
    } catch (e2) { /* 落库失败就只返回错误 */ }
    return { ok: false, message: '同步失败：' + String((e && e.message) || e).slice(0, 200) };
  } finally {
    syncState.running = false;
  }
}

// ── 定时任务 ─────────────────────────────────────────────────
let schedulerTimer = null;

/** 有登录态的用户 = 可能要同步的用户（按用户隔离后，同步逐用户进行） */
async function usersWithSession() {
  try {
    const rows = await db.query('SELECT user_id FROM qnh_session WHERE user_id > 0');
    return rows.map((r) => Number(r.user_id)).filter((n) => n > 0);
  } catch (e) {
    return [];
  }
}

/** 每 30 秒检查一次：到了配置的任一时间点且该时间点今天没跑过，就对**每位有登录态的用户**跑一轮当天增量。 */
async function tickScheduler() {
  let cfg;
  try { cfg = await getConfig(); } catch (e) { return; }
  if (cfg[CFG.scheduleEnabled] !== '1') return;
  if (syncState.running) return;

  const slots = parseScheduleTimes(cfg[CFG.scheduleTimes] || cfg[CFG.scheduleTime]);
  if (!slots.length) return;

  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (!slots.includes(hhmm)) return;

  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // 已触发的时间点记录在 last_auto_slots（同日去重）；跨天清空
  const firedToday = cfg[CFG.lastAutoDate] === today ? String(cfg[CFG.lastAutoSlots] || '').split(',').filter(Boolean) : [];
  if (firedToday.includes(hhmm)) return;

  // 先记「今天这个点跑过了」，避免这一分钟内重复触发
  firedToday.push(hhmm);
  await setConfig({
    [CFG.lastAutoDate]: today,
    [CFG.lastAutoSlots]: firedToday.join(','),
    [CFG.lastAutoAt]: now.toISOString(),
  });

  const users = await usersWithSession();
  console.log(`[qnh] 定时同步开始（${hhmm}，${users.length} 个用户）`);
  for (const uid of users) {
    if (syncState.running) break;
    const res = await runSync({ trigger: 'schedule', userId: uid }).catch((e) => ({ ok: false, message: e.message }));
    console.log(`[qnh] 定时同步（user ${uid}）：${res.ok ? '成功' : '失败'} ${res.message || ''}`);
  }

  // 顺手做一次超时提醒检查（每次定时点都带上）
  notifyPending24h().catch((e) => console.log('[qnh] 超时提醒失败：' + e.message));
}

function startScheduler() {
  if (schedulerTimer) return;
  // 定时同步（多时间点，每 30s 比对一次）
  schedulerTimer = setInterval(() => { tickScheduler().catch(() => {}); }, 30000);
  if (schedulerTimer.unref) schedulerTimer.unref();
  console.log('[qnh] 退单同步定时器已启动（每 30s 检查一次）');

  // 超 24h 待处理退单巡检：每 30 分钟一次
  const pendingTimer = setInterval(() => {
    notifyPending24h().catch(() => {});
  }, 30 * 60 * 1000);
  if (pendingTimer.unref) pendingTimer.unref();

  // 实时毛利监控：每位开了监控的用户每 10 分钟经自己的助手拉一次当天明细并做阈值告警
  const profitTimer = setInterval(() => {
    (async () => {
      if (!qagent.available()) return;   // 没有任何助手在线就跳过，下个周期再试
      const users = await usersWithSession();
      for (const uid of users) {
        const ucfg = await getConfigFor(uid);
        if (ucfg[CFG.profitEnabled] !== '1') continue;
        if (!qagent.available(uid)) continue;   // 该用户的助手不在线，下个周期再试
        await pullProfitOrders({ userId: uid }).catch((e) => console.log(`[qnh] 毛利拉取失败（user ${uid}）：` + e.message));
      }
    })().catch(() => {});
  }, 10 * 60 * 1000);
  if (profitTimer.unref) profitTimer.unref();
  console.log('[qnh] 毛利监控定时器已启动（开启后每 10 分钟拉取一次）');
}

// ── Cookie / 环境状态 ───────────────────────────────────────
// ── 库侧事实（即使登录态不可用，页面也要能看到「上次同步到哪」）──
async function readLastRun(userId = 0) {
  const rows = await db.query(
    `SELECT id, started_at, finished_at, refunds, new_refunds, items, failed, status, message
       FROM qnh_sync_run WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [Number(userId) || 0]
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

async function refundCounts(userId = 0) {
  const uid = Number(userId) || 0;
  const rows = await db.query(
    `SELECT (SELECT COUNT(*) FROM qnh_refund_order WHERE user_id = ?) AS orders,
            (SELECT COUNT(*) FROM qnh_refund_item WHERE user_id = ?) AS items,
            (SELECT COUNT(*) FROM qnh_refund_log WHERE user_id = ?) AS logs`,
    [uid, uid, uid]
  );
  const r = (rows && rows[0]) || {};
  return {
    orders: r.orders == null ? null : Number(r.orders),
    items: r.items == null ? null : Number(r.items),
    logs: r.logs == null ? null : Number(r.logs),
  };
}

async function cookieStatus(userId = 0) {
  // 登录态改由 Node 判断（lib/qnh-sync.js），不再 spawn Python；
  // 同时补齐库侧事实，桥接/登录不可用时页面仍能显示上次同步批次与表行数。
  const uid = Number(userId) || 0;
  let st;
  try {
    st = await qsync.status({ userId: uid });
  } catch (e) {
    st = { ok: false, configured: false, logined: false, message: '读取登录态失败：' + String((e && e.message) || e) };
  }
  const out = { ...st };

  try {
    out.lastRun = await readLastRun(uid);
  } catch (e) {
    out.lastRun = null;
    out.dbError = String((e && e.message) || e).slice(0, 200);
  }
  try {
    out.stats = await refundCounts(uid);
  } catch (e) {
    out.stats = { orders: null, items: null, logs: null };
  }
  return out;
}

// ── 登录态：存数据库（qnh_session），不再落本机文件 ──────────
// 按用户隔离：每位用户从自己的「本机助手」登录牵牛花，登录态归到自己名下（user_id）。
// user_id=0 仅作为历史遗留/兜底归属（老库迁移后通常不再出现）。
const QNH_SESSION_OWNER = 0;

/** 读取登录态（storageState 对象；没有则 null）。userId 指明读谁的登录态 */
async function loadStorageState(userId = QNH_SESSION_OWNER) {
  try {
    const rows = await db.query(
      'SELECT storage_state FROM qnh_session WHERE user_id = ? LIMIT 1',
      [Number(userId) || QNH_SESSION_OWNER]
    );
    const raw = rows[0] && rows[0].storage_state;
    if (!raw) return null;
    const st = JSON.parse(raw);
    return st && Array.isArray(st.cookies) ? st : null;
  } catch (e) {
    return null;
  }
}

/** 登录态元信息（写入时间 / 来源），供页面显示「上次更新于 …」 */
async function loadStorageMeta(userId = QNH_SESSION_OWNER) {
  try {
    const rows = await db.query(
      'SELECT written_at, source, earliest_expiry FROM qnh_session WHERE user_id = ? LIMIT 1',
      [Number(userId) || QNH_SESSION_OWNER]
    );
    const r = rows[0] || {};
    return {
      writtenAt: r.written_at ? new Date(r.written_at).toISOString() : null,
      source: r.source || '',
      earliestExpiry: r.earliest_expiry ? new Date(r.earliest_expiry).toISOString() : null,
    };
  } catch (e) {
    return { writtenAt: null, source: '', earliestExpiry: null };
  }
}

/**
 * 保存「本机助手」采集并回传的登录态（归到 userId 名下）。
 * @param {object} o
 * @param {number} [o.userId]   归属用户（谁登录的就是谁的）
 * @param {Array}  o.cookies   助手采集到的 Cookie（Electron 格式）
 * @param {string} [o.account] 牵牛花账号名
 * @param {string} [o.tenantId]
 * @param {string} [o.agentVer] 采集它的助手版本
 */
async function saveLoginState({ userId = QNH_SESSION_OWNER, cookies, account = null, tenantId = null, agentVer = '', source = '本机助手' } = {}) {
  const st = qsync.buildStorageState(cookies);
  if (!st.cookies.length) {
    return { ok: false, message: '没有采集到牵牛花的登录 Cookie：请在助手窗口里完成登录后重试' };
  }
  const exp = qsync.soonestExpiry(st);
  const earliest = exp ? new Date(exp * 1000) : null;
  await db.exec(
    'INSERT INTO qnh_session (user_id, storage_state, cookie_count, account_name, tenant_id, source, agent_ver, earliest_expiry, written_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE ' +
    'storage_state = VALUES(storage_state), cookie_count = VALUES(cookie_count), ' +
    'account_name = VALUES(account_name), tenant_id = VALUES(tenant_id), source = VALUES(source), ' +
    'agent_ver = VALUES(agent_ver), earliest_expiry = VALUES(earliest_expiry), written_at = NOW()',
    [
      Number(userId) || QNH_SESSION_OWNER, JSON.stringify(st), st.cookies.length,
      account ? String(account).slice(0, 128) : null,
      tenantId ? String(tenantId).slice(0, 64) : null,
      String(source || '本机助手').slice(0, 32),
      String(agentVer || '').slice(0, 32),
      earliest,
    ]
  );
  const meta = await loadStorageMeta(userId);
  return {
    ok: true, cookieCount: st.cookies.length,
    writtenAt: meta.writtenAt, earliestExpiry: meta.earliestExpiry,
  };
}

/** 清除登录态（退出登录 / 下次强制重新登录） */
async function clearLoginState(userId = QNH_SESSION_OWNER) {
  await db.exec('DELETE FROM qnh_session WHERE user_id = ?', [Number(userId) || QNH_SESSION_OWNER]);
  return { ok: true };
}

/**
 * 登录态归属信息（账号名 / 写入时间）。
 * 只在「退出登录」时用：先记住退的是谁，再去删（删完就查不到了，日志就成了空话）。
 */
async function sessionInfo(userId = QNH_SESSION_OWNER) {
  try {
    const rows = await db.query(
      'SELECT account_name, tenant_id, cookie_count, written_at FROM qnh_session WHERE user_id = ? LIMIT 1',
      [Number(userId) || QNH_SESSION_OWNER]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      accountName: r.account_name || '',
      tenantId: r.tenant_id || '',
      cookieCount: r.cookie_count == null ? null : Number(r.cookie_count),
      writtenAt: r.written_at ? new Date(r.written_at).toISOString() : null,
    };
  } catch (e) {
    return null;
  }
}

/** 注册登录态来源：本模块之后所有接口调用都从这里拿 Cookie（按 userId 区分），不再读任何本机文件 */
qsync.setStateProvider(
  (userId) => loadStorageState(userId),
  (userId) => loadStorageMeta(userId)
);
// 常驻浏览器（仅本地有桌面环境时可用）人工登录后，登录态也交回数据库
if (typeof qpage.setStateSink === 'function') {
  qpage.setStateSink((cookies) => saveLoginState({ cookies, source: '常驻浏览器' }));
}

// ⚠ 服务器不再有「自己登录牵牛花」的入口（原 loginCookie 已删除）。
//    云端没有显示器、也没有浏览器二进制，硬开浏览器只会报「Executable doesn't exist」。
//    现在的链路是：看板点「登录牵牛花」→ 服务器下发任务给本机助手 → 助手开窗口让你登录
//    → 助手回传 Cookie → 服务器入库（见 server.js 的 /api/qnh/login + saveLoginState）。

/** 企业微信机器人 markdown 发送（urlOverride 指定目标机器人；缺省用退单提醒机器人） */
async function sendWecomMarkdown(content, cfgOrNull, urlOverride) {
  const cfg = cfgOrNull || await getConfig();
  const url = String(urlOverride || cfg[CFG.webhook] || '').trim();
  if (!url) return { ok: false, message: '未配置企业微信机器人 webhook' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    });
    const j = await res.json().catch(() => null);
    if (j && j.errcode === 0) return { ok: true, message: '已发送' };
    return { ok: false, message: (j && (j.errmsg || JSON.stringify(j))) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: '发送失败：' + String((e && e.message) || e).slice(0, 200) };
  }
}

/**
 * 企业微信机器人测试消息。
 * type='refund'（默认）用退单提醒机器人；type='profit' 用毛利告警机器人——两套配置互不影响。
 */
async function testWebhook(type = 'refund', userId = 0) {
  let cfg;
  try {
    cfg = await getConfigFor(userId);
  } catch (e) {
    return { ok: false, message: '读取 webhook 配置失败：' + String((e && e.message) || e).slice(0, 150) };
  }
  const isProfit = type === 'profit';
  const url = String((isProfit ? cfg[CFG.profitWebhook] : cfg[CFG.webhook]) || '').trim();
  if (!url) {
    return { ok: false, message: isProfit ? '未配置毛利告警机器人 webhook' : '未配置退单提醒机器人 webhook' };
  }
  const title = isProfit ? '毛利告警' : '退单提醒';
  return sendWecomMarkdown(
    `### ${title} · 测试消息\n> 收到这条说明「${title}」机器人配置正常。\n> 时间：` + fmtLocal(new Date()),
    cfg,
    url
  );
}

// ── 超 24 小时仍待处理的退单 → 企业微信提醒（每单只提醒一次）──
const PENDING_RE = /完成|取消|拒绝|关闭|撤/;   // 这些状态视为「已了结」，不算待处理

/**
 * 检查申请时间超过 24 小时仍未了结的退单并推送提醒（每单只提醒一次）。
 * userId 传具体用户 → 只查该用户；不传 → 遍历所有有退单数据的用户，各自用自己的机器人。
 * 返回 {ok, sent, candidates}
 */
async function notifyPending24h({ force = false, userId = null } = {}) {
  // 待检查的用户清单：指定 userId 只查他；否则查所有有登录态的用户（没登录态的没有数据来源）
  const targets = userId != null
    ? [Number(userId) || 0]
    : await usersWithSession();
  let totalSent = 0;
  let totalCandidates = 0;
  let lastMessage = '';

  for (const uid of targets) {
    const cfg = await getConfigFor(uid);
    if (!force && (cfg[CFG.wecomEnabled] !== '1' || !cfg[CFG.webhook])) {
      lastMessage = '未开启企业微信通知';
      continue;
    }
    const rows = await db.query(
      `SELECT refund_no, order_no, serial_no, channel_name, refund_type, store_name,
              refund_amount, receiver_name, receiver_address, apply_time, refund_status
         FROM qnh_refund_order
        WHERE user_id = ?
          AND finish_ts IS NULL
          AND apply_time < DATE_SUB(NOW(), INTERVAL 24 HOUR)
          AND (refund_status IS NULL OR refund_status NOT REGEXP '完成|取消|拒绝|关闭|撤')
        ORDER BY apply_time ASC
        LIMIT 50`,
      [uid]
    );
    if (!rows.length) continue;

    const rows2 = [];
    for (const r of rows) {
      const hit = await db.query(
        "SELECT id FROM qnh_alert_log WHERE user_id = ? AND refund_no = ? AND alert_type = 'pending_24h' LIMIT 1",
        [uid, r.refund_no]
      );
      if (!hit.length) rows2.push(r);
    }
    totalCandidates += rows.length;
    if (!rows2.length) continue;

    const lines = rows2.map((r) => '> ' + renderRefundLine({
      refundNo: r.refund_no, orderNo: r.order_no || '', serialNo: r.serial_no || '',
      channelName: r.channel_name || '', refundType: r.refund_type || '',
      storeName: r.store_name || '', refundAmount: r.refund_amount,
      receiverName: r.receiver_name || '', receiverAddress: r.receiver_address || '',
      applyTime: r.apply_time || '', refundStatus: r.refund_status || '',
    }, cfg[CFG.remindTemplate]));
    const content = `### ⏰ 退单超时提醒\n`
      + `> 有 **${rows2.length}** 笔退单申请超过 24 小时仍未处理完成，请及时跟进：\n`
      + lines.join('\n');
    const r = await sendWecomMarkdown(content, cfg);
    if (r.ok) {
      totalSent += rows2.length;
      for (const row of rows2) {
        await db.exec(
          "INSERT INTO qnh_alert_log (user_id, refund_no, alert_type, content, status) VALUES (?, ?, 'pending_24h', ?, 'ok') " +
          'ON DUPLICATE KEY UPDATE sent_at = NOW()',
          [uid, row.refund_no, String(row.refund_status || '待处理').slice(0, 1000)]
        ).catch(() => {});
      }
    } else {
      lastMessage = r.message || '';
    }
  }
  if (userId != null) {
    return { ok: true, sent: totalSent, candidates: totalCandidates, message: lastMessage };
  }
  return { ok: true, sent: totalSent, candidates: totalCandidates, message: lastMessage };
}

// ── 实时毛利监控（订单毛利明细：经本机助手页内签名接口拉取）──
const PROFIT_QUERY_PATH = '/goldengateway/empower/component/show/queryTable';
// 页面 dataCode（抓包确认）：线上毛利 / 线上毛利率 / 预计收入
// 预计收入必须显式请求，否则接口返回的 estimate_gross_income 恒为 "-"
const PROFIT_DATA_CODES = ['ord_net_profit_online', 'ord_interest_rate_online', 'ord_est_income_amt'];
// 视图码（2026-10-23 页面真实抓包；注意是 analyze 不是 analysis）
const PROFIT_VIEW_CODE = 'profit_analyze_negative_gross_profit_order_detail_new_v2';
const PROFIT_MAX_PAGES = 20;          // 分页上限，防死循环
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const splitProfitList = (v) =>
  String(v == null ? '' : v).split(/[,;，；\s]+/).map((s) => s.trim()).filter(Boolean);

/**
 * 构造 queryTable 请求体 —— 必须与页面自己发的请求 1:1 一致。
 * 页面抓包（2026-10-23）：
 *   {viewCode, param:{poiIds:[数字], channelIds:[字符串], profitType, dateType:'r', ...,
 *                     orderNo, page, pageSize, order, selectedDataCodes}}
 * 任何字段名/类型/取值不一致，网关都会返回 {code:1, data:null}（参数校验失败）。
 */
function buildProfitBody({ ymd, page = 1, pageSize = 50, poiIds = [], channelIds = [] }) {
  return {
    viewCode: PROFIT_VIEW_CODE,
    param: {
      poiIds: poiIds.map(Number).filter((n) => Number.isFinite(n)),
      channelIds: channelIds.map(String),
      profitType: '1',
      dateType: 'r',
      startDate: ymd,
      endDate: ymd,
      startTime: '00:00',
      endTime: '23:59',
      onlyUnusualStore: 0,
      orderNo: '',
      page,
      pageSize,
      order: '',
      selectedDataCodes: PROFIT_DATA_CODES,
    },
  };
}

/** 从返回里尽量找出总页数（网关包裹层不固定），找不到返回 0（由「本页不满」兜底判断） */
function profitTotalPage(j) {
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3 || seen.has(o)) return 0;
    seen.add(o);
    const direct = o.totalPage != null ? o.totalPage : (o.pageCount != null ? o.pageCount : o.pages);
    if (direct != null && Number(direct) > 0) return Number(direct);
    if (o.total != null && Number(o.pageSize) > 0) {
      return Math.ceil(Number(o.total) / Number(o.pageSize));
    }
    for (const k of ['data', 'pageInfo', 'pagination', 'result']) {
      const v = walk(o[k], depth + 1);
      if (v) return v;
    }
    return 0;
  };
  return walk(j, 0);
}

// 网关成功码：不同接口可能返回 0 / "0" / 200 / "success"，统一按字符串比较
const QNH_OK_CODES = new Set(['0', '200', 'success', 'ok']);
const safeJson = (t) => {
  if (typeof t !== 'string' || !t.trim()) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
};

/** 把一次接口响应的关键信息压成一行，用于报错与排查（code / msg / 原文片段） */
function describeQnhResp(r) {
  const j = r && r.json;
  const bits = [`HTTP ${(r && r.status) || 0}`];
  if (j && typeof j === 'object') {
    if (j.code !== undefined) bits.push(`code=${JSON.stringify(j.code)}`);
    const m = j.msg || j.message;
    if (m) bits.push(String(m).slice(0, 200));
    const keys = Object.keys(j).slice(0, 8).join('/');
    if (keys) bits.push(`字段=${keys}`);
  } else {
    bits.push('响应非 JSON');
  }
  const snip = String((r && r.text) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (snip) bits.push(`原文：${snip}`);
  return bits.join('，');
}

/** 统一失败出口：console 留痕 + 落库最近失败原因（页面上直接可见；按用户各记各的） */
async function profitFail(message, extra = {}, userId = 0) {
  const detail = extra.detail ? String(extra.detail) : '';
  const msg = String(message || '毛利拉取失败').slice(0, 400);
  const full = (detail ? `${msg}｜${detail}` : msg).slice(0, 900);
  console.warn('[qnh] 毛利拉取失败：' + full);
  try {
    await setUserConfig(userId, { [CFG.profitLastError]: `${fmtLocal(new Date())} ${full}`.slice(0, 900) });
  } catch (e) { /* 落库失败不影响返回 */ }
  return { ok: false, rows: 0, alerts: 0, message: full, detail, ...extra };
}

/**
 * 发一页毛利查询（页内签名请求）。
 * @returns {json, totalPage} 成功 | {fail:{message, detail?, loginRequired?, unavailable?}} 失败
 */
async function fetchProfitPage(body, { poiIds = [], channelIds = [], uid = 0 } = {}) {
  // page 必带：助手会导航到对应页再发请求（qnhReferrer 校验，缺了 403）
  // tabNo=orderDetail 确保打开的正是「订单毛利明细」标签，便于必要时直接抓页面自己的请求
  // uid：用该用户的本机助手执行（毛利数据归属该用户）
  const r = await qagent.request({
    path: PROFIT_QUERY_PATH, method: 'POST', body, uid,
    page: '/data/gross-profit-warn?tabNo=orderDetail',
    timeoutMs: 90 * 1000,
  });
  if (!r.ok) return { fail: { message: r.message || '本机助手执行失败', unavailable: !!r.unavailable } };
  if (r.status !== 200) {
    return { fail: { message: `接口返回 HTTP ${r.status}`, detail: describeQnhResp(r) } };
  }
  // 成功码兼容数字/字符串（'0'/'200'/'success'）；json 解析失败时退回用原文再解析一次
  const j = r.json || safeJson(r.text);
  if (!j) return { fail: { message: '接口未返回可解析的数据', detail: describeQnhResp(r) } };
  const codeStr = j.code == null ? '' : String(j.code).trim().toLowerCase();
  if (codeStr && !QNH_OK_CODES.has(codeStr)) {
    const loginLost = /40100001|token|登录|未登录/i.test(`${codeStr} ${j.msg || j.message || ''}`);
    let message;
    if (loginLost) {
      message = '助手侧牵牛花登录已失效：请点「登录牵牛花」重新登录后再拉取';
    } else if (codeStr === '1') {
      // 网关参数校验失败（字段名/类型/门店权限不对都会落到这里）
      message = `接口拒绝本次查询（code=1 参数校验未通过）：门店=${poiIds.join(',') || '—'}`
        + ` 渠道=${channelIds.join(',') || '—'}，请核对该门店是否开通毛利权限、参数是否有效`;
    } else {
      message = `接口返回异常（${describeQnhResp({ ...r, json: j })}）`;
    }
    return { fail: { message, detail: describeQnhResp({ ...r, json: j }), loginRequired: loginLost } };
  }
  return { json: j, totalPage: profitTotalPage(j) };
}

/**
 * 拉取今天的订单毛利明细并入库（归到 userId 名下），返回 {ok, rows, alerts, message}。
 * 必须有该用户的本机助手在线（签名接口）；返回 unavailable 表示当前不可拉取。
 */
/**
 * 毛利明细入库（独立出来便于排查与单独验证）
 * 返回 { saved, failed, error }：saved=真实入库条数，error=首条失败原因（没有则空串）。
 * 任何一条写失败都不再静默——由调用方决定怎么告诉用户。
 */
async function saveProfitRows(rows, uid, d) {
  let saved = 0;
  let error = '';
  for (const p of rows) {
    try {
      await db.exec(
        `INSERT INTO qnh_profit_order
           (user_id, order_no, order_seq, channel_name, store_name, order_time, order_time_ms,
            profit_online, profit_rate_online, est_income_amt, data_date, raw_json, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           order_seq=VALUES(order_seq), channel_name=VALUES(channel_name),
           store_name=VALUES(store_name), order_time=VALUES(order_time), order_time_ms=VALUES(order_time_ms),
           profit_online=VALUES(profit_online), profit_rate_online=VALUES(profit_rate_online),
           est_income_amt=VALUES(est_income_amt),
           raw_json=VALUES(raw_json), fetched_at=NOW()`,
        [
          uid, p.orderNo, p.orderSeq, p.channelName, p.storeName, p.orderTime, p.orderTimeMs,
          p.profit, p.profitRate, p.estIncome, d, JSON.stringify(p.raw),
        ]
      );
      saved += 1;
    } catch (e) {
      if (!error) error = (e && e.message) ? e.message : String(e);
      console.warn(`[qnh] 毛利入库失败（user ${uid} 订单 ${p.orderNo}）：${(e && e.message) || e}`);
    }
  }
  return { saved, failed: rows.length - saved, error };
}

async function pullProfitOrders({ date = null, userId = 0 } = {}) {
  const uid = Number(userId) || 0;
  const d = date || fmtLocal(new Date()).slice(0, 10);
  const ymd = d.replace(/-/g, '');
  // 参数可配（默认为页面抓包值），换门店/渠道不用改代码；配置按用户各一份
  const pc = await getConfigFor(uid);
  const poiIds = splitProfitList(pc[CFG.profitPoiIds]).map(Number).filter((n) => Number.isFinite(n));
  const channelIds = splitProfitList(pc[CFG.profitChannelIds]);
  const pageSize = Math.min(200, Math.max(10, Number(pc[CFG.profitPageSize]) || 50));
  if (!poiIds.length) return profitFail('毛利查询未配置门店：请先在毛利监控页设置门店 ID', {}, uid);
  if (!qagent.available(uid)) {
    return { ok: false, unavailable: true, rows: 0, alerts: 0, message: '本机助手未连接：毛利明细需要助手在本机页面里拉取' };
  }

  // 分页拉全量：首页失败即整体失败；后续页失败保留已拿到的数据并说明（避免整批白跑）
  const byOrder = new Map();
  let totalPage = 0;
  let pageFail = '';
  for (let page = 1; page <= PROFIT_MAX_PAGES; page += 1) {
    const got = await fetchProfitPage(buildProfitBody({ ymd, page, pageSize, poiIds, channelIds }), { poiIds, channelIds, uid });
    if (got.fail) {
      if (page === 1) return profitFail(got.fail.message, got.fail);
      pageFail = `第 ${page} 页拉取失败（${got.fail.message}），已保留前 ${page - 1} 页数据`;
      break;
    }
    const rows = parseProfitResponse(got.json.data || got.json);
    if (!rows.length && page === 1) {
      // 结构变化时留线索：打印 data 的字段名，便于按真实结构修解析
      const dataObj = (got.json && got.json.data) || {};
      console.warn('[qnh] 毛利响应未识别出行数据，data 字段：' + Object.keys(dataObj).join(','));
    }
    for (const p of rows) if (!byOrder.has(p.orderNo)) byOrder.set(p.orderNo, p);
    if (got.totalPage) totalPage = got.totalPage;
    if (!rows.length || rows.length < pageSize) break;   // 不满一页即最后一页
    if (totalPage && page >= totalPage) break;
    if (page === PROFIT_MAX_PAGES) {
      pageFail = `已达分页上限 ${PROFIT_MAX_PAGES} 页，订单可能未拉全`;
      break;
    }
    await sleep(600);
  }
  const parsed = [...byOrder.values()];
  if (!parsed.length) {
    return profitFail(pageFail || '接口未返回订单毛利明细（页面结构可能变化）', {}, uid);
  }
  if (pageFail) console.warn('[qnh] 毛利分页提示：' + pageFail);

  const cfg = pc;
  const minAmount = Number(cfg[CFG.profitMinAmount]) || 0;
  const minRate = Number(cfg[CFG.profitMinRate]) || 0;
  let alerts = 0;
  // 入库失败绝不静默：接口拉到 N 条 ≠ 入库 N 条（此前 .catch(() => {}) 把报错全吞了，
  // 表现为「提示已拉取 22 条但列表为空」）。单条失败也要留下原因。
  const { saved, error: insertErr } = await saveProfitRows(parsed, uid, d);
  if (saved < parsed.length) {
    console.warn(`[qnh] 毛利入库 ${saved}/${parsed.length} 条；首条错误：${insertErr}`);
  }
  // 阈值告警（每单只推一次）；毛利告警走「毛利专用机器人」，与退单提醒通道完全独立
  // 阈值为 0 表示不启用该条件；负数有效（如「毛利低于 -5 元」「毛利率低于 -10%」）
  const profitHook = String(cfg[CFG.profitWebhook] || '').trim();
  if (cfg[CFG.profitWecomEnabled] === '1' && profitHook && (minAmount !== 0 || minRate !== 0)) {
    const low = parsed.filter((p) =>
      (minAmount !== 0 && p.profit != null && p.profit < minAmount) ||
      (minRate !== 0 && p.profitRate != null && p.profitRate < minRate));
    const toAlert = [];
    for (const p of low) {
      const hit = await db.query(
        "SELECT id FROM qnh_alert_log WHERE user_id = ? AND refund_no = ? AND alert_type = 'profit_low' LIMIT 1",
        [uid, p.orderNo]
      );
      if (!hit.length) toAlert.push(p);
    }
    if (toAlert.length) {
      const lines = toAlert.slice(0, 20).map((p) =>
        `> ${p.storeName || '—'} · 订单号:${p.orderNo} · 下单:${p.orderTime || '—'} · 线上毛利:${p.profit == null ? '—' : '¥' + p.profit.toFixed(2)} · 毛利率:${p.profitRate == null ? '—' : p.profitRate.toFixed(2)}%`);
      const cond = [];
      if (minAmount !== 0) cond.push(`毛利<${minAmount}元`);
      if (minRate !== 0) cond.push(`毛利率<${minRate}%`);
      const rr = await sendWecomMarkdown(
        `### 📉 低毛利告警\n> 发现 **${toAlert.length}** 笔低于阈值的订单`
        + `（${cond.join(' 或 ')}）：\n`
        + lines.join('\n'),
        cfg,
        profitHook
      );
      if (rr.ok) {
        alerts = toAlert.length;
        for (const p of toAlert) {
          await db.exec("INSERT INTO qnh_alert_log (user_id, refund_no, alert_type, content, status) VALUES (?, ?, 'profit_low', ?, 'ok') ON DUPLICATE KEY UPDATE sent_at = NOW()",
            [uid, p.orderNo, `毛利:${p.profit} 毛利率:${p.profitRate}%`]).catch(() => {});
          await db.exec('UPDATE qnh_profit_order SET alerted = 1 WHERE user_id = ? AND order_no = ?', [uid, p.orderNo]).catch(() => {});
        }
      } else {
        console.warn('[qnh] 毛利告警发送失败：' + (rr.message || '未知原因'));
      }
    }
  }

  await setUserConfig(uid, {
    [CFG.profitLastPullAt]: new Date().toISOString(),
    [CFG.profitLastPullCount]: String(saved),
    [CFG.profitLastError]: saved < parsed.length ? String(insertErr || pageFail || '').slice(0, 300) : '',
  });
  console.log(`[qnh] 毛利明细拉取完成（user ${uid}）：接口 ${parsed.length} 条，入库 ${saved} 条，告警 ${alerts} 条${pageFail ? '；' + pageFail : ''}`);
  // 提示口径一律用「真实入库数」；入库失败时把数据库原因直接说在页面上，不用再去翻日志
  let message = saved === parsed.length
    ? `已拉取 ${saved} 条毛利明细`
    : `接口拉到 ${parsed.length} 条，但只有 ${saved} 条入库成功`;
  if (pageFail) message += `（${pageFail}）`;
  if (saved < parsed.length) {
    message += '。入库失败原因：' + insertErr
      + '（常见原因：表主键未含 user_id、字段值不合法；可在服务器执行 '
      + 'SHOW INDEX FROM qnh_profit_order 与 docker compose logs app 查看）';
  }
  return {
    ok: saved > 0, rows: saved, pulled: parsed.length, alerts,
    insertErr: insertErr || undefined,
    message,
  };
}

/**
 * 宽容解析 queryTable 返回：页面结构变化时尽量兼容。
 * 认得的字段：订单号(orderNo) 门店(storeName) 下单时间(orderTime) 线上毛利(profit) 线上毛利率(profitRate)
 */
function parseProfitResponse(data) {
  const out = [];
  // 常见包裹：{list|rows|records|data|tableData|result: [...]} 或 {columns, rows}
  let list = null;
  for (const k of ['list', 'rows', 'records', 'tableData', 'dataList', 'result', 'data', 'items']) {
    const v = data && data[k];
    if (Array.isArray(v)) { list = v; break; }
    if (v && typeof v === 'object') {
      for (const k2 of ['list', 'rows', 'records', 'tableData', 'items']) {
        if (Array.isArray(v[k2])) { list = v[k2]; break; }
      }
      if (list) break;
    }
  }
  if (!Array.isArray(list)) return out;

  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    // 单元格数组形态：{columns:[...], values/cellList:[...]} —— 按列名对位取值
    let obj = it;
    if (!it.orderNo && !it.orderId && Array.isArray(it.values) && Array.isArray(data && data.columns)) {
      obj = {};
      data.columns.forEach((c, i) => {
        const name = String((c && (c.name || c.code || c.dataCode || c.label)) || '');
        if (name) obj[name] = it.values[i];
      });
    }
    // empower 单元格形态（2026-10-23 真实响应）：
    //   每一列是 { indicCode, indicValue:{ displayValue, originValue }, unit... }
    // 统一摊平成标量：优先 originValue（数值），否则 displayValue（字符串）
    if (obj && typeof obj === 'object') {
      const flat = {};
      for (const k of Object.keys(obj)) flat[k] = unwrapProfitCell(obj[k]);
      obj = flat;
    }
    const first = (...keys) => {
      for (const k of keys) {
        const v = obj[k];
        if (v != null && v !== '') return v;
      }
      return null;
    };
    const orderNo = first('order_id_view', 'orderNo', 'orderId', 'order_id', 'channelOrderId', 'order_no', 'serialNo', 'serial_no');
    if (orderNo == null) continue;
    const profitRaw = first('ord_net_profit_online', 'netProfitOnline', 'profitOnline', 'profit_online', 'net_profit_online');
    const rateRaw = first('ord_interest_rate_online', 'interestRateOnline', 'profitRateOnline', 'profit_rate_online', 'grossMarginRate');
    const timeRaw = first('order_time', 'orderTime', 'orderCreateTime', 'createTime', 'payTime');
    const seqRaw = first('order_seq', 'orderSeq', 'serialNo', 'serial_no');
    const channelRaw = first('channel_name', 'channelName');
    // 预计收入：页面列叫「预计收入」，真实响应键是 estimate_gross_income（表头 indicCode 为 ord_est_income_amt）
    const estRaw = first('ord_est_income_amt', 'estimate_gross_income', 'estIncomeAmt', 'estIncome', 'est_income_amt');
    const ms = Number(timeRaw);
    const orderTimeMs = Number.isFinite(ms) && ms > 100000000000 ? ms : null;
    const storeRaw = first('poi_name', 'storeName', 'poiName', 'shopName', 'store_name');
    out.push({
      orderNo: String(orderNo).slice(0, 64),
      orderSeq: seqRaw == null ? null : String(seqRaw).slice(0, 32),
      channelName: channelRaw == null ? null : String(channelRaw).slice(0, 64),
      storeName: storeRaw == null ? null : String(storeRaw).slice(0, 128),
      orderTime: orderTimeMs ? fmtLocal(new Date(orderTimeMs)) : (timeRaw == null ? null : String(timeRaw).slice(0, 19)),
      orderTimeMs,
      profit: profitRaw == null ? null : Number(profitRaw),
      profitRate: toProfitRate(rateRaw),
      estIncome: estRaw == null ? null : Number(estRaw),
      raw: it,
    });
  }
  return out;
}

/**
 * 摊平 empower 单元格：{indicValue:{displayValue,originValue}} → 标量。
 * 非该形态时原样返回（兼容旧的扁平结构）。
 */
function unwrapProfitCell(v) {
  if (v == null || typeof v !== 'object') return v;
  const iv = v.indicValue;
  if (iv == null) return v;
  if (typeof iv !== 'object') return iv;
  const disp = iv.displayValue;
  const dash = disp == null || disp === '' || disp === '-' || disp === '--';
  if (iv.originValue != null && iv.originValue !== '') {
    // 页面显示 “-” 且原始值为 0 时视为无数据（与页面观感一致）
    if (dash && Number(iv.originValue) === 0) return null;
    return iv.originValue;
  }
  return dash ? null : disp;
}

/** 毛利率归一：'12.26%' → 12.26；originValue 是小数（0.1226）时退回按百分数处理 */
function toProfitRate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const n = Number(s.replace('%', ''));
  if (!Number.isFinite(n)) return null;
  if (s.includes('%')) return n;
  // 无百分号且绝对值 <= 1：视为小数比例
  return Math.abs(n) <= 1 ? Number((n * 100).toFixed(4)) : n;
}

/** 毛利监控页面数据：最近的低毛利订单 + 汇总（userId=数据归属用户） */
async function profitOverview({ limit = 100, userId = 0 } = {}) {
  const uid = Number(userId) || 0;
  // 默认按线上毛利从小到大（低毛利优先）；NULL 排最后
  const low = await db.query(
    `SELECT order_no, order_seq, channel_name, store_name, order_time,
            profit_online, profit_rate_online, est_income_amt, alerted, fetched_at
       FROM qnh_profit_order
      WHERE user_id = ?
      ORDER BY profit_online IS NULL, profit_online ASC, order_time DESC
      LIMIT ?`,
    [uid, Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  const sum = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(alerted = 1), 0) AS alerts FROM qnh_profit_order WHERE user_id = ?`,
    [uid]
  );
  const cfg = await getConfigFor(uid);
  return {
    total: Number(sum[0].n) || 0,
    alerts: Number(sum[0].alerts) || 0,
    config: publicConfig(cfg),
    rows: low.map((r) => ({
      orderNo: r.order_no,
      orderSeq: r.order_seq || '',
      channelName: r.channel_name || '',
      storeName: r.store_name || '',
      orderTime: r.order_time || '',
      profit: r.profit_online == null ? null : Number(r.profit_online),
      profitRate: r.profit_rate_online == null ? null : Number(r.profit_rate_online),
      estIncome: r.est_income_amt == null ? null : Number(r.est_income_amt),
      alerted: Number(r.alerted) === 1,
      fetchedAt: r.fetched_at || '',
    })),
  };
}

// ── 退单列表 / 趋势 / 日志 ──────────────────────────────────
const SORTS = {
  apply_desc: 'r.apply_time DESC, r.refund_no DESC',
  apply_asc: 'r.apply_time ASC, r.refund_no ASC',
  amount_desc: 'r.refund_amount DESC',
  amount_asc: 'r.refund_amount ASC',
};

async function listRefunds(q = {}) {
  const uid = Number(q.userId) || 0;
  const where = ['r.user_id = ?'];
  const args = [uid];

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
    `SELECT r.refund_no, r.order_no, r.serial_no, r.store_name, r.channel_name, r.order_status,
            r.refund_status, r.refund_type, r.refund_amount, r.apply_time, r.finish_time,
            r.apply_source, r.is_appeal, r.item_kinds, r.has_delivery_log, r.picked_log, r.refund_qty,
            r.receiver_name, r.receiver_address, r.paid_time,
            (SELECT COUNT(*) FROM qnh_refund_log l WHERE l.refund_no = r.refund_no AND l.user_id = r.user_id AND l.log_type = 'delivery') AS delivery_cnt,
            (SELECT COUNT(*) FROM qnh_refund_log l WHERE l.refund_no = r.refund_no AND l.user_id = r.user_id) AS log_cnt
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
      serialNo: r.serial_no || '',
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
      receiverName: r.receiver_name || '',
      receiverAddress: r.receiver_address || '',
      paidTime: r.paid_time || '',
      deliveryCount: Number(r.delivery_cnt) || 0,
      logCount: Number(r.log_cnt) || 0,
    })),
  };
}

/** 每天退单数量趋势（默认最近 30 天，自动补齐没有退单的日期；按退单类型分列统计；userId=数据归属用户） */
async function refundTrend(days = 30, userId = 0) {
  const n = Math.min(180, Math.max(1, Number(days) || 30));
  const rows = await db.query(
    `SELECT DATE(apply_time) AS d, COUNT(*) AS c, COALESCE(SUM(refund_amount), 0) AS amt,
            SUM(picked_log = 1) AS delivered,
            SUM(is_appeal = 1) AS appealed,
            SUM(refund_type = '整单退') AS t_full,
            SUM(refund_type = '部分退') AS t_part,
            SUM(refund_type = '克重退差') AS t_weight,
            SUM(refund_type = '按金额退') AS t_amount,
            SUM(refund_type = '用户拒收') AS t_reject,
            SUM(COALESCE(refund_type, '') NOT IN ('整单退', '部分退', '克重退差', '按金额退', '用户拒收')) AS t_other
       FROM qnh_refund_order
      WHERE user_id = ?
        AND apply_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(apply_time)`,
    [Number(userId) || 0, n - 1]
  );
  const map = new Map(
    rows.filter((r) => r.d).map((r) => [
      String(r.d).slice(0, 10),
      {
        count: Number(r.c) || 0, amount: Number(r.amt) || 0,
        delivered: Number(r.delivered) || 0, appealed: Number(r.appealed) || 0,
        types: {
          整单退: Number(r.t_full) || 0,
          部分退: Number(r.t_part) || 0,
          克重退差: Number(r.t_weight) || 0,
          按金额退: Number(r.t_amount) || 0,
          用户拒收: Number(r.t_reject) || 0,
          其他: Number(r.t_other) || 0,
        },
      },
    ])
  );

  const out = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = map.get(key) || {
      count: 0, amount: 0, delivered: 0, appealed: 0,
      types: { 整单退: 0, 部分退: 0, 克重退差: 0, 按金额退: 0, 用户拒收: 0, 其他: 0 },
    };
    out.push({ date: key, ...hit });
  }
  return out;
}

/**
 * 每天毛利总额趋势：按 data_date 聚合当天所有订单的线上毛利合计、单数、预计收入合计。
 * 返回最近 n 天（含无数据的天，补 0），供看板画柱状图。
 */
async function profitTrend(days = 30, userId = 0) {
  const n = Math.min(180, Math.max(1, Number(days) || 30));
  const rows = await db.query(
    `SELECT DATE(data_date) AS d, COUNT(*) AS c,
            COALESCE(SUM(profit_online), 0) AS profit,
            COALESCE(SUM(est_income_amt), 0) AS income,
            SUM(profit_online < 0) AS loss_cnt
       FROM qnh_profit_order
      WHERE user_id = ?
        AND data_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(data_date)`,
    [Number(userId) || 0, n - 1]
  );
  const map = new Map(
    rows.filter((r) => r.d).map((r) => [
      String(r.d).slice(0, 10),
      {
        count: Number(r.c) || 0,
        profit: Number(r.profit) || 0,
        income: Number(r.income) || 0,
        lossCount: Number(r.loss_cnt) || 0,
      },
    ])
  );
  const out = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    out.push({ date: key, ...(map.get(key) || { count: 0, profit: 0, income: 0, lossCount: 0 }) });
  }
  return out;
}

async function getLogs(refundNo, type, userId = 0) {
  const where = ['user_id = ?', 'refund_no = ?'];
  const args = [Number(userId) || 0, String(refundNo)];
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

// ── 配送日志：页内签名接口（newQueryList → orderOperatorLogList）──
//   服务器 Cookie 直连会被 WAF 拦（403），必须由「本机助手」在真实页面环境里 fetch；
//   自建有桌面的部署环境仍可用 qnh-page 常驻浏览器兜底。
const ROUTE_SRC_RE = /取货|揽收|送达|收货/;
// 「已支付」判断：避开「待支付/未支付」这类反向描述
const PAID_RE = /已支付|支付成功|已付款|付款成功|买家已付款|用户已支付/;
const NQL_PATH = '/api/v1/orderfuse/newQueryList';
const routeLocks = new Map(); // 同一退单并发去重

/** 经本机助手拉一单的配送操作日志（页内签名请求；uid=用谁的助手执行） */
async function fetchOrderLogsViaAgent(orderNo, uid = 0) {
  const now = Date.now();
  const body = {
    orderId: String(orderNo),
    page: 1,
    pageSize: 10,
    _t: now,
    createStartTime: String(now - 30 * 86400000), // 订单创建窗口放宽到 30 天
    createEndTime: String(now),
  };
  const r = await qagent.request({ path: NQL_PATH, method: 'POST', body, uid: Number(uid) || 0 });
  if (!r.ok) return r;
  if (r.status !== 200) {
    return { ok: false, loginRequired: [401, 403].includes(r.status), message: `接口被拒（HTTP ${r.status}）` };
  }
  const j = r.json;
  if (!j || j.code !== 0) return { ok: false, message: (j && (j.msg || j.message)) || '接口返回异常' };
  const list = (j.data && j.data.orderList) || [];
  const hit = list.find((o) => String(o.channelOrderId) === String(orderNo)) || list[0];
  if (!hit) return { ok: true, logs: [], message: '订单列表中未找到该订单' };
  return { ok: true, logs: Array.isArray(hit.orderOperatorLogList) ? hit.orderOperatorLogList : [], order: hit };
}

/** 从日志/订单对象里提取「已支付时间」（接口 payTime 优先，日志里含支付/付款的条目兜底） */
function extractPaidInfo(order, rawLogs) {
  const msToDate = qsync._internals.msToDate;
  const candidates = [];
  const direct = Number(order && (order.payTime || order.paidTime));
  if (Number.isFinite(direct) && direct > 0) candidates.push(direct);
  for (const l of Array.isArray(rawLogs) ? rawLogs : []) {
    const desc = String((l && (l.operatorDesc || l.comment)) || '');
    if (PAID_RE.test(desc) && l.operationTime) candidates.push(Number(l.operationTime));
  }
  if (!candidates.length) return { paidMs: null, paidTime: null };
  const paidMs = Math.min(...candidates.filter((n) => n > 0));
  return { paidMs, paidTime: paidMs ? msToDate(paidMs) : null };
}

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

/** 确保退单有配送日志：库里没有就实时拉一次并落库。返回 {note} 或 null（无需拉取）。userId=数据归属用户 */
async function ensureDeliveryLogs(refundNo, userId = 0) {
  const uid = Number(userId) || 0;
  const key = String(refundNo);
  const rows = await db.query(
    'SELECT refund_no, order_no, has_delivery_log FROM qnh_refund_order WHERE user_id = ? AND refund_no = ? LIMIT 1',
    [uid, key]
  );
  const rec = rows[0];
  if (!rec || Number(rec.has_delivery_log) === 1 || !rec.order_no) return null;

  const cnt = await db.query(
    "SELECT COUNT(*) AS c FROM qnh_refund_log WHERE user_id = ? AND refund_no = ? AND log_type = 'delivery'",
    [uid, key]
  );
  if (Number(cnt[0].c) > 0) {
    await db.exec('UPDATE qnh_refund_order SET has_delivery_log = 1 WHERE user_id = ? AND refund_no = ?', [uid, key]);
    return null;
  }

  const lockKey = `${uid}:${key}`;
  if (routeLocks.has(lockKey)) return routeLocks.get(lockKey);
  const task = (async () => {
    // 先走该用户的本机助手（云端唯一可用通道），不可用再退回常驻浏览器（仅自建有桌面的机器）
    let r = await fetchOrderLogsViaAgent(rec.order_no, uid);
    if (r.unavailable) r = await qpage.fetchOrderLogs(rec.order_no);
    if (!r.ok) {
      // 云端助手离线/登录失效属预期内：说清楚原因，不误导成同步故障
      const msg = r.unavailable || r.unsupported
        ? '本机助手未连接：配送日志需要助手在本机页面里拉取（连上助手后重试）'
        : (r.loginRequired
          ? '牵牛花登录态已失效：请点「登录牵牛花」重新登录'
          : `配送日志获取失败：${r.message || '未知原因'}`);
      return { note: msg };
    }
    if (!r.logs.length) return { note: r.message || '接口未返回该订单的操作日志' };
    const mapped = mapRouteLogs(key, rec.order_no, r.logs);
    await db.exec("DELETE FROM qnh_refund_log WHERE user_id = ? AND refund_no = ? AND source = 'route'", [uid, key]);
    for (const l of mapped) {
      l.user_id = uid;
      await db.exec(INSERT_LOG_SQL, [...toParams(LOG_COLS, l), l.raw_json]);
    }
    const picked = mapped.some((l) => ROUTE_SRC_RE.test(`${l.content || ''}${l.note || ''}`)) ? 1 : 0;
    const paid = extractPaidInfo(r.order, r.logs);
    // 顺带补 serialNo（列表接口没给时的兜底来源）
    const serial = r.order && r.order.serialNo ? String(r.order.serialNo).slice(0, 64) : null;
    await db.exec(
      `UPDATE qnh_refund_order
          SET has_delivery_log = 1,
              picked_log = GREATEST(picked_log, ?),
              paid_time = COALESCE(?, paid_time),
              paid_ts = COALESCE(?, paid_ts),
              serial_no = COALESCE(?, serial_no)
        WHERE user_id = ? AND refund_no = ?`,
      [picked, paid.paidTime, paid.paidMs, serial, uid, key]
    );
    return { note: `已从订单接口拉取 ${mapped.length} 条配送日志` };
  })().finally(() => routeLocks.delete(lockKey));
  routeLocks.set(lockKey, task);
  return task;
}

/** 日志查询 + 按需补拉配送日志（type='order' 时不动浏览器） */
async function getLogsWithRoute(refundNo, type, userId = 0) {
  let route = null;
  if (type !== 'order') {
    try {
      route = await ensureDeliveryLogs(refundNo, userId);
    } catch (e) {
      route = { note: '配送日志获取失败：' + String((e && e.message) || e).slice(0, 150) };
    }
  }
  const logs = await getLogs(refundNo, type, userId);
  return { logs, route };
}

/** 列表页顶部的汇总数字（userId=数据归属用户） */
async function summary(userId = 0) {
  const rows = await db.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(refund_amount), 0) AS amount,
            SUM(has_delivery_log = 1) AS delivered,
            SUM(picked_log = 1) AS picked,
            SUM(DATE(apply_time) = CURDATE()) AS today,
            SUM(is_appeal = 1) AS appeal
       FROM qnh_refund_order WHERE user_id = ?`,
    [Number(userId) || 0]
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
  getConfigFor,
  setUserConfig,
  publicConfig,
  cookieStatus,
  saveLoginState,
  clearLoginState,
  sessionInfo,
  loadStorageState,
  loadStorageMeta,
  usersWithSession,
  testWebhook,
  sendWecomMarkdown,
  renderRefundLine,
  notifyNewRefunds,
  notifyPending24h,
  pullProfitOrders,
  profitOverview,
  profitTrend,
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
  _internals: {
    upsertRefund, syncRefundDetail, toParams, ORDER_COLS, ITEM_COLS, LOG_COLS, mapRouteLogs,
    parseScheduleTimes, resolveSyncWindow, extractPaidInfo, parseProfitResponse, TEMPLATE_FIELDS,
    buildProfitBody, profitTotalPage, fetchProfitPage, saveProfitRows,
  },
};
