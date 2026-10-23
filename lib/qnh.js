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
  profitMinAmount: 'qnh.profit_min_amount', // 线上毛利低于该值（元）告警
  profitMinRate: 'qnh.profit_min_rate',     // 线上毛利率低于该值（%）告警
  profitLastPullAt: 'qnh.profit_last_pull_at',
  profitLastPullCount: 'qnh.profit_last_pull_count',
  profitLastError: 'qnh.profit_last_error',  // 最近一次拉取失败原因（诊断用，成功时清空）
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
  [CFG.profitMinAmount]: '0',
  [CFG.profitMinRate]: '0',
  [CFG.profitLastPullCount]: '0',
  [CFG.profitLastError]: '',
};

/** 读一组配置（带默认值） */
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
    profitMinAmount: Number(cfg[CFG.profitMinAmount]) || 0,
    profitMinRate: Number(cfg[CFG.profitMinRate]) || 0,
    profitLastPullAt: cfg[CFG.profitLastPullAt] || '',
    profitLastPullCount: Number(cfg[CFG.profitLastPullCount]) || 0,
    profitLastError: cfg[CFG.profitLastError] || '',
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
  refund_no, service_id, qnh_tenant_id, order_no, serial_no, channel_name, channel_id,
  store_id, store_name, order_status, order_status_code, refund_status, refund_status_code,
  refund_type, is_appeal, apply_source, apply_source_code, apply_reason,
  refund_amount, goods_amount, commission, return_freight, return_freight_actual,
  refund_qty, refund_weight, apply_time, apply_ts, update_ts, finish_time, finish_ts,
  receiver_name, receiver_phone, receiver_address, paid_time, paid_ts,
  audit_time, audit_operator, audit_reason,
  item_kinds, detail_synced, has_delivery_log, picked_log, log_synced, sync_batch_id,
  first_seen_at, last_seen_at, raw_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),?)
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

/** 同步完成后把新退单按模板推送到企业微信（每条只推一次） */
async function notifyNewRefunds(newRows, { trigger = 'manual' } = {}) {
  if (!Array.isArray(newRows) || !newRows.length) return { ok: true, sent: 0 };
  const cfg = await getConfig();
  if (cfg[CFG.wecomEnabled] !== '1' || !cfg[CFG.webhook]) return { ok: false, sent: 0, message: '未开启企业微信通知' };

  const rows = [];
  for (const r of newRows) {
    const hit = await db.query(
      "SELECT id FROM qnh_alert_log WHERE refund_no = ? AND alert_type = 'new_refund' LIMIT 1",
      [r.refundNo]
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
        "INSERT INTO qnh_alert_log (refund_no, alert_type, content, status) VALUES (?, 'new_refund', ?, 'ok') " +
        'ON DUPLICATE KEY UPDATE sent_at = NOW()',
        [row.refundNo, renderRefundLine(row, cfg[CFG.remindTemplate]).slice(0, 1000)]
      ).catch(() => {});
    }
  }
  return { ok: r.ok, sent: r.ok ? rows.length : 0, message: r.message };
}

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

    // 1. 同步窗口：默认只拉当天（定时/手动一致）；days/date 仅在显式传参时用于补历史
    const { start, end } = resolveSyncWindow({ days, date });
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
    const newRows = [];   // 本轮新入库的退单（用于企业微信提醒）
    for (const rec of lr.records) {
      const m = qsync._internals.mapRefundRecord(rec, { batchId });
      if (!m) { failures.push('记录缺 afterSaleId，已跳过'); continue; }
      try {
        const r = await upsertRefund(m.row, m.logs, batchId);
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

    // 6. 新退单企业微信提醒（按模板渲染，逐条去重；失败不影响同步结果）
    let notify = { ok: true, sent: 0 };
    if (newRows.length) {
      notify = await notifyNewRefunds(newRows, { trigger }).catch((e) => ({ ok: false, sent: 0, message: e.message }));
      if (notify.sent) console.log(`[qnh] 新退单提醒已推送 ${notify.sent} 条`);
    }

    return { ...syncState.lastResult, lastRun: await readLastRun(), stats: await refundCounts(), notify };
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

/** 每 30 秒检查一次：到了配置的任一时间点且该时间点今天没跑过，就跑一轮当天增量。 */
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
  console.log(`[qnh] 定时同步开始（${hhmm}）`);
  const res = await runSync({ trigger: 'schedule' });
  console.log(`[qnh] 定时同步结束：${res.ok ? '成功' : '失败'} ${res.message || ''}`);

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

  // 实时毛利监控：开启后每 10 分钟经助手拉一次当天的订单毛利明细并做阈值告警
  const profitTimer = setInterval(() => {
    (async () => {
      const cfg = await getConfig();
      if (cfg[CFG.profitEnabled] !== '1') return;
      if (!qagent.available()) return;   // 助手不在线就跳过，下个周期再试
      await pullProfitOrders().catch((e) => console.log('[qnh] 毛利拉取失败：' + e.message));
    })().catch(() => {});
  }, 10 * 60 * 1000);
  if (profitTimer.unref) profitTimer.unref();
  console.log('[qnh] 毛利监控定时器已启动（开启后每 10 分钟拉取一次）');
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

// ── 登录态：存数据库（qnh_session），不再落本机文件 ──────────
// 登录态是系统级资源（只有管理员能触发登录），全系统共享一份，故固定归属 user_id=0。
const QNH_SESSION_OWNER = 0;

/** 读取登录态（storageState 对象；没有则 null） */
async function loadStorageState() {
  try {
    const rows = await db.query(
      'SELECT storage_state FROM qnh_session WHERE user_id = ? LIMIT 1',
      [QNH_SESSION_OWNER]
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
async function loadStorageMeta() {
  try {
    const rows = await db.query(
      'SELECT written_at, source, earliest_expiry FROM qnh_session WHERE user_id = ? LIMIT 1',
      [QNH_SESSION_OWNER]
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
 * 保存「本机助手」采集并回传的登录态。
 * @param {object} o
 * @param {Array}  o.cookies   助手采集到的 Cookie（Electron 格式）
 * @param {string} [o.account] 牵牛花账号名
 * @param {string} [o.tenantId]
 * @param {string} [o.agentVer] 采集它的助手版本
 */
async function saveLoginState({ cookies, account = null, tenantId = null, agentVer = '', source = '本机助手' } = {}) {
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
      QNH_SESSION_OWNER, JSON.stringify(st), st.cookies.length,
      account ? String(account).slice(0, 128) : null,
      tenantId ? String(tenantId).slice(0, 64) : null,
      String(source || '本机助手').slice(0, 32),
      String(agentVer || '').slice(0, 32),
      earliest,
    ]
  );
  const meta = await loadStorageMeta();
  return {
    ok: true, cookieCount: st.cookies.length,
    writtenAt: meta.writtenAt, earliestExpiry: meta.earliestExpiry,
  };
}

/** 清除登录态（退出登录 / 下次强制重新登录） */
async function clearLoginState() {
  await db.exec('DELETE FROM qnh_session WHERE user_id = ?', [QNH_SESSION_OWNER]);
  return { ok: true };
}

/** 注册登录态来源：本模块之后所有接口调用都从这里拿 Cookie，不再读任何本机文件 */
qsync.setStateProvider(loadStorageState, loadStorageMeta);
// 常驻浏览器（仅本地有桌面环境时可用）人工登录后，登录态也交回数据库
if (typeof qpage.setStateSink === 'function') {
  qpage.setStateSink((cookies) => saveLoginState({ cookies, source: '常驻浏览器' }));
}

// ⚠ 服务器不再有「自己登录牵牛花」的入口（原 loginCookie 已删除）。
//    云端没有显示器、也没有浏览器二进制，硬开浏览器只会报「Executable doesn't exist」。
//    现在的链路是：看板点「登录牵牛花」→ 服务器下发任务给本机助手 → 助手开窗口让你登录
//    → 助手回传 Cookie → 服务器入库（见 server.js 的 /api/qnh/login + saveLoginState）。

/** 企业微信机器人 markdown 发送（所有提醒共用；cfg 可传入省一次读取） */
async function sendWecomMarkdown(content, cfgOrNull) {
  const cfg = cfgOrNull || await getConfig();
  const url = String(cfg[CFG.webhook] || '').trim();
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

/** 企业微信机器人测试消息 */
async function testWebhook() {
  let cfg;
  try {
    cfg = await getConfig();
  } catch (e) {
    return { ok: false, message: '读取 webhook 配置失败：' + String((e && e.message) || e).slice(0, 150) };
  }
  return sendWecomMarkdown(
    '### 退单提醒 · 测试消息\n> 收到这条说明机器人配置正常。\n> 时间：' + fmtLocal(new Date()),
    cfg
  );
}

// ── 超 24 小时仍待处理的退单 → 企业微信提醒（每单只提醒一次）──
const PENDING_RE = /完成|取消|拒绝|关闭|撤/;   // 这些状态视为「已了结」，不算待处理

/**
 * 检查申请时间超过 24 小时仍未了结的退单并推送提醒。
 * 返回 {ok, sent, candidates}
 */
async function notifyPending24h({ force = false } = {}) {
  const cfg = await getConfig();
  if (!force && (cfg[CFG.wecomEnabled] !== '1' || !cfg[CFG.webhook])) {
    return { ok: false, sent: 0, candidates: 0, message: '未开启企业微信通知' };
  }
  const rows = await db.query(
    `SELECT refund_no, order_no, serial_no, channel_name, refund_type, store_name,
            refund_amount, receiver_name, receiver_address, apply_time, refund_status
       FROM qnh_refund_order
      WHERE finish_ts IS NULL
        AND apply_time < DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND (refund_status IS NULL OR refund_status NOT REGEXP '完成|取消|拒绝|关闭|撤')
      ORDER BY apply_time ASC
      LIMIT 50`
  );
  if (!rows.length) return { ok: true, sent: 0, candidates: 0 };

  const rows2 = [];
  for (const r of rows) {
    const hit = await db.query(
      "SELECT id FROM qnh_alert_log WHERE refund_no = ? AND alert_type = 'pending_24h' LIMIT 1",
      [r.refund_no]
    );
    if (!hit.length) rows2.push(r);
  }
  if (!rows2.length) return { ok: true, sent: 0, candidates: rows.length };

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
    for (const row of rows2) {
      await db.exec(
        "INSERT INTO qnh_alert_log (refund_no, alert_type, content, status) VALUES (?, 'pending_24h', ?, 'ok') " +
        'ON DUPLICATE KEY UPDATE sent_at = NOW()',
        [row.refund_no, String(row.refund_status || '待处理').slice(0, 1000)]
      ).catch(() => {});
    }
  }
  return { ok: r.ok, sent: r.ok ? rows2.length : 0, candidates: rows.length, message: r.message };
}

// ── 实时毛利监控（订单毛利明细：经本机助手页内签名接口拉取）──
const PROFIT_QUERY_PATH = '/goldengateway/empower/component/show/queryTable';
// 页面 dataCode（抓包确认）：线上毛利 / 线上毛利率
const PROFIT_DATA_CODES = ['ord_net_profit_online', 'ord_interest_rate_online'];

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

/** 统一失败出口：console 留痕 + 落库最近失败原因（页面上直接可见） */
async function profitFail(message, extra = {}) {
  const detail = extra.detail ? String(extra.detail) : '';
  const msg = String(message || '毛利拉取失败').slice(0, 400);
  const full = (detail ? `${msg}｜${detail}` : msg).slice(0, 900);
  console.warn('[qnh] 毛利拉取失败：' + full);
  try {
    await setConfig({ [CFG.profitLastError]: `${fmtLocal(new Date())} ${full}`.slice(0, 900) });
  } catch (e) { /* 落库失败不影响返回 */ }
  return { ok: false, rows: 0, alerts: 0, message: full, detail, ...extra };
}

/**
 * 拉取今天的订单毛利明细并入库，返回 {ok, rows, alerts, message}。
 * 必须有本机助手在线（签名接口）；返回 unavailable 表示当前不可拉取。
 */
async function pullProfitOrders({ date = null } = {}) {
  const d = date || fmtLocal(new Date()).slice(0, 10);
  const ymd = d.replace(/-/g, '');
  const body = {
    elemeCode: 'profit_analysis_negative_gross_profit_order_detail_new_v2',
    params: {
      policId: '1101146',
      channelIds: '100;200;9001',
      profileType: '1',
      dateType: '1',
      startDate: ymd,
      endDate: ymd,
      startTime: '00:00',
      endTime: '23:59',
      onlyUnusualStore: 0,
      orderRev: '',
      page: 1,
      pageSize: 200,
      order: '',
      selectedDataCode: PROFIT_DATA_CODES,
    },
  };
  // page 必带：助手会导航到对应页再发请求（qnhReferrer 校验，缺了 403）
  // tabNo=orderDetail 确保打开的正是「订单毛利明细」标签，便于必要时直接抓页面自己的请求
  const r = await qagent.request({
    path: PROFIT_QUERY_PATH, method: 'POST', body,
    page: '/data/gross-profit-warn?tabNo=orderDetail',
    timeoutMs: 90 * 1000,
  });
  if (!r.ok) {
    return profitFail(r.message || '本机助手执行失败', { unavailable: !!r.unavailable });
  }
  if (r.status !== 200) {
    return profitFail(`接口返回 HTTP ${r.status}`, { detail: describeQnhResp(r) });
  }

  // P1：成功码兼容数字/字符串（'0'/'200'/'success'）；json 解析失败时退回用原文再解析一次
  const j = r.json || safeJson(r.text);
  if (!j) {
    return profitFail('接口未返回可解析的数据', { detail: describeQnhResp(r) });
  }
  const codeStr = j.code == null ? '' : String(j.code).trim().toLowerCase();
  if (codeStr && !QNH_OK_CODES.has(codeStr)) {
    // 登录类错误单独给出可执行提示
    const loginLost = /40100001|token|登录|未登录/i.test(`${codeStr} ${j.msg || j.message || ''}`);
    const msg = loginLost
      ? '助手侧牵牛花登录已失效：请点「登录牵牛花」重新登录后再拉取'
      : `接口返回异常（${describeQnhResp({ ...r, json: j })}）`;
    return profitFail(msg, {
      detail: describeQnhResp({ ...r, json: j }),
      loginRequired: loginLost,
    });
  }

  const parsed = parseProfitResponse(j.data || j);
  if (!parsed.length) {
    return profitFail('接口未返回订单毛利明细（页面结构可能变化）', {
      detail: describeQnhResp({ ...r, json: j }),
    });
  }

  const cfg = await getConfig();
  const minAmount = Number(cfg[CFG.profitMinAmount]) || 0;
  const minRate = Number(cfg[CFG.profitMinRate]) || 0;
  let alerts = 0;
  for (const p of parsed) {
    await db.exec(
      `INSERT INTO qnh_profit_order
         (order_no, store_name, order_time, order_time_ms, profit_online, profit_rate_online, data_date, raw_json, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
         store_name=VALUES(store_name), order_time=VALUES(order_time), order_time_ms=VALUES(order_time_ms),
         profit_online=VALUES(profit_online), profit_rate_online=VALUES(profit_rate_online),
         raw_json=VALUES(raw_json), fetched_at=NOW()`,
      [p.orderNo, p.storeName, p.orderTime, p.orderTimeMs, p.profit, p.profitRate, d, JSON.stringify(p.raw)]
    ).catch(() => {});
  }
  // 阈值告警（每单只推一次）
  if (cfg[CFG.wecomEnabled] === '1' && cfg[CFG.webhook] && (minAmount > 0 || minRate > 0)) {
    const low = parsed.filter((p) =>
      (minAmount > 0 && p.profit != null && p.profit < minAmount) ||
      (minRate > 0 && p.profitRate != null && p.profitRate < minRate));
    const toAlert = [];
    for (const p of low) {
      const hit = await db.query(
        "SELECT id FROM qnh_alert_log WHERE refund_no = ? AND alert_type = 'profit_low' LIMIT 1",
        [p.orderNo]
      );
      if (!hit.length) toAlert.push(p);
    }
    if (toAlert.length) {
      const lines = toAlert.slice(0, 20).map((p) =>
        `> ${p.storeName || '—'} · 订单号:${p.orderNo} · 下单:${p.orderTime || '—'} · 线上毛利:${p.profit == null ? '—' : '¥' + p.profit.toFixed(2)} · 毛利率:${p.profitRate == null ? '—' : p.profitRate.toFixed(2)}%`);
      const rr = await sendWecomMarkdown(
        `### 📉 低毛利告警\n> 发现 **${toAlert.length}** 笔低于阈值的订单`
        + `（毛利<${minAmount || '—'}元 或 毛利率<${minRate || '—'}%）：\n`
        + lines.join('\n'),
        cfg
      );
      if (rr.ok) {
        alerts = toAlert.length;
        for (const p of toAlert) {
          await db.exec("INSERT INTO qnh_alert_log (refund_no, alert_type, content, status) VALUES (?, 'profit_low', ?, 'ok') ON DUPLICATE KEY UPDATE sent_at = NOW()",
            [p.orderNo, `毛利:${p.profit} 毛利率:${p.profitRate}%`]).catch(() => {});
          await db.exec('UPDATE qnh_profit_order SET alerted = 1 WHERE order_no = ?', [p.orderNo]).catch(() => {});
        }
      }
    }
  }

  await setConfig({
    [CFG.profitLastPullAt]: new Date().toISOString(),
    [CFG.profitLastPullCount]: String(parsed.length),
    [CFG.profitLastError]: '',
  });
  console.log(`[qnh] 毛利明细拉取完成：${parsed.length} 条，告警 ${alerts} 条`);
  return { ok: true, rows: parsed.length, alerts, message: `已拉取 ${parsed.length} 条毛利明细` };
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
    const first = (...keys) => {
      for (const k of keys) {
        const v = obj[k];
        if (v != null && v !== '') return v;
      }
      return null;
    };
    const orderNo = first('orderNo', 'orderId', 'order_id', 'channelOrderId', 'order_no', 'serialNo', 'serial_no');
    if (orderNo == null) continue;
    const profitRaw = first('ord_net_profit_online', 'netProfitOnline', 'profitOnline', 'profit_online', 'net_profit_online');
    const rateRaw = first('ord_interest_rate_online', 'interestRateOnline', 'profitRateOnline', 'profit_rate_online', 'grossMarginRate');
    const timeRaw = first('orderTime', 'orderCreateTime', 'createTime', 'payTime', 'order_time');
    const ms = Number(timeRaw);
    const orderTimeMs = Number.isFinite(ms) && ms > 100000000000 ? ms : null;
    out.push({
      orderNo: String(orderNo).slice(0, 64),
      storeName: first('storeName', 'poiName', 'shopName', 'store_name') == null ? null : String(first('storeName', 'poiName', 'shopName', 'store_name')).slice(0, 128),
      orderTime: orderTimeMs ? fmtLocal(new Date(orderTimeMs)) : (timeRaw == null ? null : String(timeRaw).slice(0, 19)),
      orderTimeMs,
      profit: profitRaw == null ? null : Number(profitRaw),
      profitRate: rateRaw == null ? null : Number(String(rateRaw).replace('%', '')),
      raw: it,
    });
  }
  return out;
}

/** 毛利监控页面数据：最近的低毛利订单 + 汇总 */
async function profitOverview({ limit = 100 } = {}) {
  const low = await db.query(
    `SELECT order_no, store_name, order_time, profit_online, profit_rate_online, alerted, fetched_at
       FROM qnh_profit_order
      ORDER BY order_time DESC
      LIMIT ?`,
    [Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  const sum = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(alerted = 1), 0) AS alerts FROM qnh_profit_order`
  );
  const cfg = await getConfig();
  return {
    total: Number(sum[0].n) || 0,
    alerts: Number(sum[0].alerts) || 0,
    config: publicConfig(cfg),
    rows: low.map((r) => ({
      orderNo: r.order_no,
      storeName: r.store_name || '',
      orderTime: r.order_time || '',
      profit: r.profit_online == null ? null : Number(r.profit_online),
      profitRate: r.profit_rate_online == null ? null : Number(r.profit_rate_online),
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
    `SELECT r.refund_no, r.order_no, r.serial_no, r.store_name, r.channel_name, r.order_status,
            r.refund_status, r.refund_type, r.refund_amount, r.apply_time, r.finish_time,
            r.apply_source, r.is_appeal, r.item_kinds, r.has_delivery_log, r.picked_log, r.refund_qty,
            r.receiver_name, r.receiver_address, r.paid_time,
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

/** 每天退单数量趋势（默认最近 30 天，自动补齐没有退单的日期；按退单类型分列统计） */
async function refundTrend(days = 30) {
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
      WHERE apply_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(apply_time)`,
    [n - 1]
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

// ── 配送日志：页内签名接口（newQueryList → orderOperatorLogList）──
//   服务器 Cookie 直连会被 WAF 拦（403），必须由「本机助手」在真实页面环境里 fetch；
//   自建有桌面的部署环境仍可用 qnh-page 常驻浏览器兜底。
const ROUTE_SRC_RE = /取货|揽收|送达|收货/;
// 「已支付」判断：避开「待支付/未支付」这类反向描述
const PAID_RE = /已支付|支付成功|已付款|付款成功|买家已付款|用户已支付/;
const NQL_PATH = '/api/v1/orderfuse/newQueryList';
const routeLocks = new Map(); // 同一退单并发去重

/** 经本机助手拉一单的配送操作日志（页内签名请求） */
async function fetchOrderLogsViaAgent(orderNo) {
  const now = Date.now();
  const body = {
    orderId: String(orderNo),
    page: 1,
    pageSize: 10,
    _t: now,
    createStartTime: String(now - 30 * 86400000), // 订单创建窗口放宽到 30 天
    createEndTime: String(now),
  };
  const r = await qagent.request({ path: NQL_PATH, method: 'POST', body });
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
    // 先走本机助手（云端唯一可用通道），不可用再退回常驻浏览器（仅自建有桌面的机器）
    let r = await fetchOrderLogsViaAgent(rec.order_no);
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
    await db.exec("DELETE FROM qnh_refund_log WHERE refund_no = ? AND source = 'route'", [key]);
    for (const l of mapped) {
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
        WHERE refund_no = ?`,
      [picked, paid.paidTime, paid.paidMs, serial, key]
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
  saveLoginState,
  clearLoginState,
  loadStorageState,
  loadStorageMeta,
  testWebhook,
  sendWecomMarkdown,
  renderRefundLine,
  notifyNewRefunds,
  notifyPending24h,
  pullProfitOrders,
  profitOverview,
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
  },
};
