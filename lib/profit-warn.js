/**
 * lib/profit-warn.js — 美团「毛利明细」告警（看板侧：判定 / 去重 / 推送 / 心跳）
 *
 * 架构（2026-10-20 新增）：
 *   采集在用户本机助手（electron/agent/profit-watch.js）里做——用本机浏览器打开
 *   https://qnh.meituan.com 报表页、只读 DOM 取表格。服务器**不登录美团、不存美团登录态**，
 *   只接收助手已解析好的订单行（走既有的 /ws/agent 设备令牌通道），负责：
 *     · 落库（profit_order_snapshot，按 user_id + order_no 存最新快照）
 *     · 按规则判定（线上毛利 < 阈值、排除状态、排除店铺/关键词）
 *     · 去重（指纹 = 订单号 + 毛利值；毛利变了算新事件）
 *     · 企业微信推送（合并 + 限流，机器人上限 20 条/分钟）
 *     · 采集心跳（超时未上报 → 推「采集端离线」，只推一次）
 *
 * 为什么这么切分（风控角度）：美团看到的仍是「你本人、你的 IP、你正在看报表」，
 * 服务器侧只处理你已经看到的数据，不产生任何对美团的额外请求。
 */
const crypto = require('crypto');
const db = require('../db');

// ── 常量 ──
const DEFAULT_POLL_SEC = 60;          // 采集间隔（秒）
const DEFAULT_THRESHOLD = 0;          // 线上毛利 < 0 视为负毛利
const WECOM_MAX_PER_MIN = 20;         // 企业微信群机器人速率上限（超了直接丢弃）
const EVENT_KIND = { neg: 'neg', recovered: 'recovered', offline: 'offline', test: 'test' };
const DEFAULT_NAME_PREFIX = '毛利告警机器人';

/** 默认规则（表里没有行时用它；保存后写库，看板可改） */
function defaultRule() {
  return {
    enabled: true,
    watchUrl: 'https://qnh.meituan.com/home.html#/data/gross-profit-warn?tabNo=orderDetail',
    pollIntervalSec: DEFAULT_POLL_SEC,
    refreshEverySec: 300,              // 每 5 分钟点一次页面自带刷新（0 = 不刷新）
    jitterRatio: 0.2,                  // 间隔随机抖动 ±20%
    threshold: DEFAULT_THRESHOLD,
    valueColumn: '线上毛利',
    amountColumn: '线上实付',          // 金额列（仅用于展示与排序；找不到就留空）
    statusColumn: '订单状态',
    storeColumn: '店铺名称',
    orderColumn: '订单号',
    ignoreStatus: ['已取消', '已退款', '全额退款', '待支付'],
    includeStores: [],                 // 空 = 全部店铺
    excludeStores: [],
    excludes: [],                      // 关键词排除：命中「店铺名/商品名/备注」任一即跳过
    firstPageOnly: true,
    pushChannel: 'wecom',              // wecom | none
    wecomKeyMode: 'builtin',           // builtin = 使用系统内置机器人；custom = 用下面自定义 key
    wecomKey: '',                      // 自定义机器人 key（只存库、不返回前端明文）
    wecomMention: '',                  // 企业微信 @手机号，多个用逗号分隔
    maxDetail: 10,                     // 单条消息最多列出的明细条数
    repeatAfterHours: 0,               // 0 = 同一笔只提醒一次（毛利变了才再提醒）
    quietHours: '',                    // 免打扰时段，如 "23:00-07:00"（期间不推送，离线告警除外）
    offlineAlertMin: 20,               // 超过 N 分钟没收到采集心跳 → 推「采集端离线」（0 = 关闭）
    offlineAlertRepeatMin: 120,        // 离线告警重复间隔
    updatedBy: null,
    updatedAt: null,
  };
}

// ── 工具 ──
function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

/** 数字清洗：'1,234.50' / '¥12.3' / '-8.2元' → number；无法识别 → NaN */
function toNum(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  if (!s) return NaN;
  s = s.replace(/[¥￥$,\s]/g, '').replace(/元$/, '');
  // 括号表示负数：(8.20)
  const bracket = /^\((.*)\)$/.exec(s);
  if (bracket) s = '-' + bracket[1];
  if (!/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

function fmtYuan(n) {
  const v = Number(n);
  if (!isFinite(v)) return '-';
  return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toFixed(2);
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 解析免打扰时段 "23:00-07:00"（可留空）。返回 { inQuiet(date) } */
function parseQuietHours(spec) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec || ''));
  if (!m) return { inQuiet: () => false };
  const sh = Number(m[1]), sm = Number(m[2]), eh = Number(m[3]), em = Number(m[4]);
  return {
    inQuiet(date) {
      const d = date || new Date();
      const cur = d.getHours() * 60 + d.getMinutes();
      const s = sh * 60 + sm, e = eh * 60 + em;
      return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e); // 跨零点
    },
  };
}

/** 企业微信机器人 key：只取 key 部分（有些人会整条 URL 贴进来） */
function normalizeWecomKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = /[?&]key=([A-Za-z0-9-]+)/.exec(s);
  if (m) return m[1];
  return s;
}

/** 从 config.json 读内置机器人 key（profitWatch.wecomKey / wecomWebhook）；读不到再用环境变量 */
function builtinWecomKey() {
  if (process.env.PROFIT_WECOM_KEY) return normalizeWecomKey(process.env.PROFIT_WECOM_KEY);
  if (process.env.WECOM_WEBHOOK_KEY) return normalizeWecomKey(process.env.WECOM_WEBHOOK_KEY);
  try {
    const { loadConfig } = require('./browser');
    const cfg = loadConfig();
    const pw = (cfg && cfg.profitWatch) || {};
    return normalizeWecomKey(pw.wecomKey || pw.wecomWebhook || '');
  } catch (e) { return ''; }
}

/** 规则脱敏：给前端时把 key 打码（永不回传明文） */
function maskRule(rule) {
  const r = { ...rule };
  const k = String(r.wecomKey || '');
  r.wecomKeySet = !!k;
  r.wecomKeyHint = k ? (k.slice(0, 8) + '…' + k.slice(-4)) : '';
  r.wecomKey = undefined;
  r.hasBuiltinKey = !!builtinWecomKey();
  return r;
}

// ── 规则读写 ──
async function loadRule(userId) {
  const rows = await db.query('SELECT * FROM profit_alert_rule WHERE user_id = ? LIMIT 1', [Number(userId)]);
  const def = defaultRule();
  if (!rows.length) return { ...def, userId: Number(userId) };
  const r = rows[0];
  const fromDb = (v, fallback) => {
    if (v === null || v === undefined) return fallback;
    if (Buffer.isBuffer(v)) v = v.toString('utf-8');
    if (typeof v === 'string' && (v.trim().startsWith('[') || v.trim().startsWith('{'))) {
      try { return JSON.parse(v); } catch (e) { return fallback; }
    }
    return v;
  };
  return {
    userId: Number(r.user_id),
    enabled: !!r.enabled,
    watchUrl: r.watch_url || def.watchUrl,
    pollIntervalSec: Number(r.poll_interval_sec) || def.pollIntervalSec,
    refreshEverySec: Number(r.refresh_every_sec) || 0,
    jitterRatio: r.jitter_ratio === null || r.jitter_ratio === undefined ? def.jitterRatio : Number(r.jitter_ratio),
    threshold: r.threshold === null || r.threshold === undefined ? def.threshold : Number(r.threshold),
    valueColumn: r.value_column || def.valueColumn,
    amountColumn: r.amount_column || '',
    statusColumn: r.status_column || def.statusColumn,
    storeColumn: r.store_column || def.storeColumn,
    orderColumn: r.order_column || def.orderColumn,
    ignoreStatus: fromDb(r.ignore_status, def.ignoreStatus),
    includeStores: fromDb(r.include_stores, []),
    excludeStores: fromDb(r.exclude_stores, []),
    excludes: fromDb(r.excludes, []),
    firstPageOnly: !!r.first_page_only,
    pushChannel: r.push_channel || def.pushChannel,
    wecomKeyMode: r.wecom_key_mode || def.wecomKeyMode,
    wecomKey: r.wecom_key || '',
    wecomMention: r.wecom_mention || '',
    maxDetail: Number(r.max_detail) || def.maxDetail,
    repeatAfterHours: Number(r.repeat_after_hours) || 0,
    quietHours: r.quiet_hours || '',
    offlineAlertMin: r.offline_alert_min === null || r.offline_alert_min === undefined ? def.offlineAlertMin : Number(r.offline_alert_min),
    offlineAlertRepeatMin: r.offline_alert_repeat_min === null || r.offline_alert_repeat_min === undefined
      ? def.offlineAlertRepeatMin : Number(r.offline_alert_repeat_min),
    updatedBy: r.updated_by || null,
    updatedAt: r.updated_at || null,
  };
}

/** 校验 + 归一化提交上来的规则 */
function sanitizeRule(patch, base) {
  const b = { ...defaultRule(), ...(base || {}) };
  const o = patch && typeof patch === 'object' ? patch : {};
  const out = { ...b };
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  const list = (v) => {
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
    return String(v).split(/[,，\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 200);
  };

  if (o.enabled !== undefined) out.enabled = !!o.enabled;
  if (o.watchUrl !== undefined) {
    const u = String(o.watchUrl || '').trim();
    if (u && !/^https?:\/\/qnh\.meituan\.com\//i.test(u)) throw new Error('监控地址必须是 qnh.meituan.com 的页面地址');
    out.watchUrl = u || defaultRule().watchUrl;
  }
  if (o.pollIntervalSec !== undefined) out.pollIntervalSec = Math.round(num(o.pollIntervalSec, 15, 3600, DEFAULT_POLL_SEC));
  if (o.refreshEverySec !== undefined) out.refreshEverySec = Math.round(num(o.refreshEverySec, 0, 7200, 0));
  if (o.jitterRatio !== undefined) out.jitterRatio = num(o.jitterRatio, 0, 0.5, 0.2);
  if (o.threshold !== undefined) out.threshold = num(o.threshold, -1e9, 1e9, 0);
  for (const k of ['valueColumn', 'amountColumn', 'statusColumn', 'storeColumn', 'orderColumn']) {
    if (o[k] !== undefined) out[k] = String(o[k] || '').trim().slice(0, 64);
  }
  if (o.ignoreStatus !== undefined) out.ignoreStatus = list(o.ignoreStatus);
  if (o.includeStores !== undefined) out.includeStores = list(o.includeStores);
  if (o.excludeStores !== undefined) out.excludeStores = list(o.excludeStores);
  if (o.excludes !== undefined) out.excludes = list(o.excludes);
  if (o.firstPageOnly !== undefined) out.firstPageOnly = !!o.firstPageOnly;
  if (o.pushChannel !== undefined) out.pushChannel = (o.pushChannel === 'none' ? 'none' : 'wecom');
  if (o.wecomKeyMode !== undefined) out.wecomKeyMode = (o.wecomKeyMode === 'custom' ? 'custom' : 'builtin');
  if (o.wecomKey !== undefined) {
    // 空字符串 = 清空；未提交（undefined）= 保留原值
    const raw = String(o.wecomKey || '').trim();
    out.wecomKey = raw ? normalizeWecomKey(raw) : '';
  }
  if (o.clearWecomKey) out.wecomKey = '';
  if (o.wecomMention !== undefined) out.wecomMention = String(o.wecomMention || '').replace(/[^\d,\s]/g, '').slice(0, 200);
  if (o.maxDetail !== undefined) out.maxDetail = Math.round(num(o.maxDetail, 1, 30, 10));
  if (o.repeatAfterHours !== undefined) out.repeatAfterHours = Math.round(num(o.repeatAfterHours, 0, 720, 0));
  if (o.quietHours !== undefined) {
    const q = String(o.quietHours || '').trim();
    if (q && !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(q)) throw new Error('免打扰时段格式应为 23:00-07:00');
    out.quietHours = q;
  }
  if (o.offlineAlertMin !== undefined) out.offlineAlertMin = Math.round(num(o.offlineAlertMin, 0, 1440, 20));
  if (o.offlineAlertRepeatMin !== undefined) out.offlineAlertRepeatMin = Math.round(num(o.offlineAlertRepeatMin, 5, 1440, 120));
  return out;
}

async function saveRule(userId, patch, byUserId) {
  const cur = await loadRule(userId);
  const next = sanitizeRule(patch, cur);
  // 自定义模式下必须有一个可用的 key，否则推送必失败，提前拦下
  if (next.pushChannel === 'wecom' && next.wecomKeyMode === 'custom' && !next.wecomKey) {
    throw new Error('已选择「自定义机器人」，请填写 webhook key');
  }
  await db.exec(
    `INSERT INTO profit_alert_rule
       (user_id, enabled, watch_url, poll_interval_sec, refresh_every_sec, jitter_ratio, threshold,
        value_column, amount_column, status_column, store_column, order_column,
        ignore_status, include_stores, exclude_stores, excludes, first_page_only,
        push_channel, wecom_key_mode, wecom_key, wecom_mention,
        max_detail, repeat_after_hours, quiet_hours, offline_alert_min, offline_alert_repeat_min,
        updated_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE
       enabled=VALUES(enabled), watch_url=VALUES(watch_url), poll_interval_sec=VALUES(poll_interval_sec),
       refresh_every_sec=VALUES(refresh_every_sec), jitter_ratio=VALUES(jitter_ratio), threshold=VALUES(threshold),
       value_column=VALUES(value_column), amount_column=VALUES(amount_column), status_column=VALUES(status_column),
       store_column=VALUES(store_column), order_column=VALUES(order_column),
       ignore_status=VALUES(ignore_status), include_stores=VALUES(include_stores),
       exclude_stores=VALUES(exclude_stores), excludes=VALUES(excludes), first_page_only=VALUES(first_page_only),
       push_channel=VALUES(push_channel), wecom_key_mode=VALUES(wecom_key_mode), wecom_key=VALUES(wecom_key),
       wecom_mention=VALUES(wecom_mention), max_detail=VALUES(max_detail),
       repeat_after_hours=VALUES(repeat_after_hours), quiet_hours=VALUES(quiet_hours),
       offline_alert_min=VALUES(offline_alert_min), offline_alert_repeat_min=VALUES(offline_alert_repeat_min),
       updated_by=VALUES(updated_by), updated_at=NOW()`,
    [
      Number(userId), next.enabled ? 1 : 0, next.watchUrl, next.pollIntervalSec, next.refreshEverySec,
      next.jitterRatio, next.threshold, next.valueColumn, next.amountColumn || null, next.statusColumn,
      next.storeColumn, next.orderColumn,
      JSON.stringify(next.ignoreStatus || []), JSON.stringify(next.includeStores || []),
      JSON.stringify(next.excludeStores || []), JSON.stringify(next.excludes || []), next.firstPageOnly ? 1 : 0,
      next.pushChannel, next.wecomKeyMode, next.wecomKey || null, next.wecomMention || null,
      next.maxDetail, next.repeatAfterHours, next.quietHours || null,
      next.offlineAlertMin, next.offlineAlertRepeatMin, byUserId || null,
    ]
  );
  return loadRule(userId);
}

/** 下发给本机助手的采集配置（不含任何 key、不含服务器地址） */
function toAgentConfig(rule) {
  return {
    enabled: !!rule.enabled,
    url: rule.watchUrl,
    pollIntervalSec: rule.pollIntervalSec,
    refreshEverySec: rule.refreshEverySec,
    jitterRatio: rule.jitterRatio || 0,
    valueColumn: rule.valueColumn,
    amountColumn: rule.amountColumn || '',
    statusColumn: rule.statusColumn,
    storeColumn: rule.storeColumn,
    orderColumn: rule.orderColumn,
    firstPageOnly: !!rule.firstPageOnly,
    updatedAt: rule.updatedAt ? new Date(rule.updatedAt).toISOString() : null,
  };
}

// ── 采集心跳 / 落库 ──
/**
 * 记一次采集心跳（每轮上报都会调用）。同一用户只留一行。
 * @param {number} userId
 * @param {object} info { ok, rows, parsed, pageTitle, pageUrl, error, agentVer, target, mode }
 */
async function touchState(userId, info) {
  const i = info || {};
  const ok = i.ok === undefined ? !i.error : !!i.ok;
  // 注意：rows 是 MariaDB 保留字，必须用反引号包住，否则报 SQL 语法错
  const sql = 'INSERT INTO profit_collect_state ' +
    '(user_id, last_report_at, last_ok_at, ok, `rows`, parsed, page_title, page_url, error, agent_ver, target, mode, updated_at) ' +
    'VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW()) ' +
    'ON DUPLICATE KEY UPDATE ' +
    'last_report_at=NOW(), ' +
    'last_ok_at=IF(VALUES(ok)=1, NOW(), last_ok_at), ' +
    'ok=VALUES(ok), `rows`=VALUES(`rows`), parsed=VALUES(parsed), ' +
    'page_title=VALUES(page_title), page_url=VALUES(page_url), error=VALUES(error), ' +
    'agent_ver=VALUES(agent_ver), target=VALUES(target), mode=VALUES(mode), updated_at=NOW()';
  await db.exec(sql, [
    Number(userId), ok ? new Date() : null, ok ? 1 : 0,
    Math.max(0, Math.min(20000, Number(i.rows) || 0)),
    Math.max(0, Math.min(20000, Number(i.parsed) || 0)),
    clip(i.pageTitle, 200) || null, clip(i.pageUrl, 500) || null, clip(i.error, 500) || null,
    clip(i.agentVer, 32) || null, clip(i.target, 120) || null, clip(i.mode, 16) || null,
  ]);
}

async function loadState(userId) {
  const rows = await db.query('SELECT * FROM profit_collect_state WHERE user_id = ? LIMIT 1', [Number(userId)]);
  if (!rows.length) return { exists: false, ok: false, online: false };
  const r = rows[0];
  const at = r.last_report_at ? new Date(r.last_report_at).getTime() : 0;
  return {
    exists: true,
    ok: !!r.ok,
    online: at ? (Date.now() - at < 3 * 60 * 1000) : false,
    lastReportAt: r.last_report_at,
    lastOkAt: r.last_ok_at,
    rows: Number(r.rows) || 0,
    parsed: Number(r.parsed) || 0,
    pageTitle: r.page_title || '',
    pageUrl: r.page_url || '',
    error: r.error || '',
    agentVer: r.agent_ver || '',
    target: r.target || '',
    mode: r.mode || '',
  };
}

/** 一行订单是否在关注范围内（状态/店铺/关键词过滤） */
function inScope(row, rule) {
  const status = String(row.status || '');
  const ig = (rule.ignoreStatus || []).map((x) => String(x));
  if (ig.length && ig.some((x) => x && (status === x || status.includes(x)))) return { ok: false, why: '状态忽略' };

  const store = String(row.store || '');
  const inc = (rule.includeStores || []).filter(Boolean);
  if (inc.length && !inc.some((x) => store.includes(x))) return { ok: false, why: '不在关注店铺' };
  const exc = (rule.excludeStores || []).filter(Boolean);
  if (exc.length && exc.some((x) => store.includes(x))) return { ok: false, why: '店铺排除' };

  const kw = (rule.excludes || []).filter(Boolean);
  if (kw.length) {
    const hay = [store, row.title, row.remark].map((x) => String(x || '')).join(' ');
    if (kw.some((x) => hay.includes(x))) return { ok: false, why: '关键词排除' };
  }
  return { ok: true };
}

/**
 * 接收助手一轮采集结果：落库 → 判定 → 去重 → 推送。
 * @param {number} userId
 * @param {object} payload { rows:[{orderNo,store,title,status,gross,amount,orderTime,remark,raw}], pageTitle, pageUrl, agentVer, mode, target }
 * @param {object} [opts] { dryRun:boolean }  dryRun 只落库+算判定，不推送
 * @returns {Promise<object>} 本轮处理摘要
 */
async function ingest(userId, payload, opts) {
  const o = opts || {};
  const p = payload || {};
  const rule = await loadRule(userId);
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const now = new Date();

  // 1) 归一化 + 过滤 + 落库
  const kept = [];
  for (const r of rows) {
    const orderNo = String(r.orderNo || '').trim().slice(0, 64);
    if (!orderNo) continue;
    const gross = toNum(r.gross);
    const amount = toNum(r.amount);
    const rec = {
      orderNo,
      store: clip(r.store, 255) || null,
      title: clip(r.title, 512) || null,
      status: clip(r.status, 64) || null,
      gross: isFinite(gross) ? gross : null,
      amount: isFinite(amount) ? amount : null,
      orderTime: r.orderTime ? new Date(String(r.orderTime).replace(' ', 'T')) : null,
      remark: clip(r.remark, 255) || null,
    };
    if (rec.orderTime && isNaN(rec.orderTime.getTime())) rec.orderTime = null;
    kept.push(rec);
  }

  // 批量入库（单条 upsert；订单量通常几十条，够用且能保留 raw 之外的更新时间）
  for (const r of kept) {
    await db.exec(
      `INSERT INTO profit_order_snapshot
         (user_id, order_no, store_name, goods_title, order_status, gross_profit, amount, order_time, remark, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW())
       ON DUPLICATE KEY UPDATE
         store_name=VALUES(store_name), goods_title=VALUES(goods_title), order_status=VALUES(order_status),
         gross_profit=VALUES(gross_profit), amount=VALUES(amount),
         order_time=COALESCE(VALUES(order_time), order_time), remark=VALUES(remark), last_seen_at=NOW()`,
      [Number(userId), r.orderNo, r.store, r.title, r.status, r.gross, r.amount, r.orderTime, r.remark]
    );
  }

  // 2) 判定
  const negs = [];
  let outOfScope = 0;
  for (const r of kept) {
    if (r.gross === null) continue;
    const sc = inScope(r, rule);
    if (!sc.ok) { outOfScope++; continue; }
    if (r.gross < Number(rule.threshold)) negs.push(r);
  }

  // 3) 去重：指纹 = 订单号 + 毛利值（毛利变了 = 新事件）
  const fresh = [];
  for (const n of negs) {
    const fp = sha1(n.orderNo + '|' + Number(n.gross).toFixed(2));
    const hit = await db.query(
      'SELECT id, alerted_at FROM profit_alert_event WHERE user_id=? AND fingerprint=? LIMIT 1',
      [Number(userId), fp]
    );
    if (!hit.length) { fresh.push({ row: n, fp, kind: EVENT_KIND.neg }); continue; }
    // 允许「同一金额 N 小时后再次提醒」
    const repeat = Number(rule.repeatAfterHours) || 0;
    if (repeat > 0 && hit[0].alerted_at) {
      const ageH = (now.getTime() - new Date(hit[0].alerted_at).getTime()) / 3600000;
      if (ageH >= repeat) fresh.push({ row: n, fp, kind: EVENT_KIND.neg });
    }
  }

  // 4) 恢复检测（同一订单之前告警过负毛利，这次毛利回到阈值以上）
  const recovered = [];
  if (recoveredEnabled(rule)) {
    const prevNeg = await db.query(
      `SELECT order_no, MAX(fingerprint) AS fingerprint FROM profit_alert_event
        WHERE user_id = ? AND kind = 'neg' AND recovered_at IS NULL
        GROUP BY order_no LIMIT 500`,
      [Number(userId)]
    );
    const curByNo = new Map(kept.map((r) => [r.orderNo, r]));
    for (const pv of prevNeg) {
      const cur = curByNo.get(pv.order_no);
      if (cur && cur.gross !== null && cur.gross >= Number(rule.threshold)) {
        recovered.push({ row: cur, fp: sha1('recover|' + cur.orderNo + '|' + Number(cur.gross).toFixed(2)), kind: EVENT_KIND.recovered });
      }
    }
  }

  // 5) 推送
  const quiet = parseQuietHours(rule.quietHours).inQuiet(now);
  const canPush = !o.dryRun && rule.pushChannel === 'wecom' && !!wecomKeyOf(rule);
  let pushResults = [];
  if (quiet && fresh.length) {
    // 免打扰：事件照常记录（状态 pending），下一轮安静期结束仍会提醒
  } else if (canPush) {
    if (fresh.length) pushResults = pushResults.concat(await pushNegBatch(userId, rule, fresh));
    if (recovered.length) pushResults = pushResults.concat(await pushRecoverBatch(userId, rule, recovered));
  } else if (!canPush && (fresh.length || recovered.length)) {
    // 没有可用 key：仍然落事件（便于在看板上看到「本该推送但没推」）
  }

  // 6) 事件落库（推送成功与否都记，方便复查）
  const sentOk = pushResults.filter((x) => x.ok).length;
  for (const f of fresh) {
    await upsertEvent(userId, f, rule, canPush && !quiet, sentOk ? 'sent' : (canPush && !quiet ? 'failed' : 'pending'));
  }
  for (const f of recovered) {
    await upsertEvent(userId, f, rule, canPush && !quiet, canPush && !quiet ? (sentOk ? 'sent' : 'failed') : 'pending');
    if (canPush && !quiet) {
      await db.exec('UPDATE profit_alert_event SET recovered_at = NOW() WHERE user_id=? AND order_no=? AND kind=\'neg\'',
        [Number(userId), f.row.orderNo]).catch(() => {});
    }
  }

  await touchState(userId, {
    ok: true, rows: rows.length, parsed: kept.length, pageTitle: p.pageTitle, pageUrl: p.pageUrl,
    agentVer: p.agentVer, target: p.target, mode: p.mode,
  });

  return {
    ok: true,
    received: rows.length,
    parsed: kept.length,
    negative: negs.length,
    fresh: fresh.length,
    recovered: recovered.length,
    outOfScope,
    pushed: sentOk,
    quiet,
    canPush,
    dryRun: !!o.dryRun,
    rule: { threshold: rule.threshold, valueColumn: rule.valueColumn },
  };
}

/** 恢复提醒是否启用：规则里没单独开关，跟随 repeatAfterHours>=0 一律启用（可在配置里理解成「已恢复」通知） */
function recoveredEnabled(rule) { return !!rule.enabled; }

function wecomKeyOf(rule) {
  if (rule.wecomKeyMode === 'custom') return normalizeWecomKey(rule.wecomKey);
  return builtinWecomKey() || normalizeWecomKey(rule.wecomKey);
}

async function upsertEvent(userId, item, rule, pushed, status) {
  const r = item.row;
  await db.exec(
    `INSERT INTO profit_alert_event
       (user_id, kind, order_no, fingerprint, store_name, goods_title, order_status, gross_profit, amount,
        rule_threshold, channel, status, alerted_at, meta)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)
     ON DUPLICATE KEY UPDATE
       gross_profit=VALUES(gross_profit), amount=VALUES(amount), status=VALUES(status),
       alerted_at=NOW(), meta=VALUES(meta)`,
    [
      Number(userId), item.kind, r.orderNo, item.fp, r.store, r.title, r.status, r.gross, r.amount,
      Number(rule.threshold), rule.pushChannel, status,
      JSON.stringify({ pushed: !!pushed, orderTime: r.orderTime ? r.orderTime.toISOString() : null }),
    ]
  ).catch((e) => console.error('[profit] 写告警事件失败', e.message));
}

// ── 企业微信推送 ──
/** 进程内限流：60 秒窗口最多 20 条（官方硬限制，超了会被丢弃） */
const rateWindow = [];
function rateLimited() {
  const now = Date.now();
  while (rateWindow.length && now - rateWindow[0] > 60000) rateWindow.shift();
  if (rateWindow.length >= WECOM_MAX_PER_MIN - 1) return true; // 留 1 条余量给离线告警
  rateWindow.push(now);
  return false;
}

/**
 * 发一条 markdown 到企业微信群机器人。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function sendWecom(rule, markdown, opts) {
  const o = opts || {};
  const key = wecomKeyOf(rule);
  if (!key) return { ok: false, error: '未配置企业微信机器人 key' };
  if (!o.force && rateLimited()) return { ok: false, error: '触发限流（每分钟最多 20 条），本条已跳过' };
  const body = { msgtype: 'markdown', markdown: { content: String(markdown || '').slice(0, 4000) } };
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + encodeURIComponent(key);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    clearTimeout(timer);
    let j = null;
    try { j = await res.json(); } catch (e) { /* 非 JSON */ }
    if (res.status === 200 && j && j.errcode === 0) return { ok: true };
    return { ok: false, error: (j && j.errmsg) ? j.errmsg : ('HTTP ' + res.status) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  }
}

/** 负毛利合并推送；返回每条明细的推送结果 */
/** 下单时间在消息里只显示「MM-DD HH:mm」，Date/字符串都能吃 */
function fmtShortTime(v) {
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function pushNegBatch(userId, rule, items) {
  const sorted = items.slice().sort((a, b) => Number(a.row.gross) - Number(b.row.gross));
  const max = Math.max(1, Math.min(30, Number(rule.maxDetail) || 10));
  const shown = sorted.slice(0, max);
  const mention = String(rule.wecomMention || '').split(',').map((x) => x.trim()).filter(Boolean);
  const lines = [];
  lines.push('## ⚠️ 毛利告警：发现负毛利订单');
  lines.push(`> 共 **${sorted.length}** 笔线上毛利为负（阈值 < ${fmtYuan(rule.threshold)}），以下按毛利从低到高：`);
  lines.push('');
  for (const it of shown) {
    const r = it.row;
    const parts = [
      `**${fmtYuan(r.gross)}**`,
      r.orderNo ? `订单 \`${r.orderNo}\`` : '',
      r.store ? String(r.store) : '',
      r.amount !== null ? `实付 ${fmtYuan(r.amount)}` : '',
      r.orderTime ? fmtShortTime(r.orderTime) : '',
    ].filter(Boolean);
    lines.push(`- ${parts.join(' · ')}`);
  }
  if (sorted.length > shown.length) lines.push(`- …… 另有 ${sorted.length - shown.length} 笔未列出`);
  const sum = sorted.reduce((a, x) => a + Number(x.row.gross || 0), 0);
  lines.push('');
  lines.push(`**合计负毛利：${fmtYuan(sum)}**　采集时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  if (mention.length) lines.push(`<@${mention.join('><@')}>`);

  const res = await sendWecom(rule, lines.join('\n'));
  return items.map(() => res);
}

async function pushRecoverBatch(userId, rule, items) {
  const shown = items.slice(0, Math.max(1, Math.min(30, Number(rule.maxDetail) || 10)));
  const lines = ['## ✅ 毛利恢复通知', `> 以下订单线上毛利已回到 ${fmtYuan(rule.threshold)} 以上：`, ''];
  for (const it of shown) {
    const r = it.row;
    lines.push(`- **${fmtYuan(r.gross)}** · ${r.orderNo ? '订单 `' + r.orderNo + '`' : ''} ${r.store ? '· ' + r.store : ''}`);
  }
  const res = await sendWecom(rule, lines.join('\n'));
  return items.map(() => res);
}

/** 看板「测试推送」：发一条样例，不受限流与免打扰影响 */
async function sendTest(userId, overrideRule) {
  const rule = overrideRule || await loadRule(userId);
  const md = [
    '## ✅ 毛利告警测试消息',
    `> 规则：线上毛利 < **${fmtYuan(rule.threshold)}** 时提醒`,
    `> 采集间隔：${rule.pollIntervalSec} 秒　页面刷新：${rule.refreshEverySec ? rule.refreshEverySec + ' 秒' : '不刷新'}`,
    `> 免打扰：${rule.quietHours || '无'}　离线告警：${rule.offlineAlertMin ? rule.offlineAlertMin + ' 分钟无心跳' : '关闭'}`,
    '',
    `收到这条消息说明企业微信机器人配置正确。发送时间 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  ].join('\n');
  return sendWecom(rule, md, { force: true });
}

// ── 离线/心跳巡检（由 server.js 的定时器调用） ──
/**
 * 巡检所有启用规则的用户：采集端超过 N 分钟没上报 → 推一条离线告警（按 repeatMin 重复）。
 * 只在「离线告警」时不受免打扰限制（值班场景下断线比推送更重要）。
 */
async function checkOffline(now) {
  const t = now || new Date();
  const rules = await db.query('SELECT * FROM profit_alert_rule WHERE enabled = 1');
  const out = [];
  for (const raw of rules) {
    const userId = Number(raw.user_id);
    const rule = await loadRule(userId);
    if (!rule.enabled) continue;
    const min = Number(rule.offlineAlertMin) || 0;
    if (min <= 0) continue;
    if (rule.pushChannel !== 'wecom' || !wecomKeyOf(rule)) continue;

    const st = await loadState(userId);
    const base = st.lastOkAt || st.lastReportAt;
    const ageMin = base ? (t.getTime() - new Date(base).getTime()) / 60000 : Infinity;
    if (ageMin < min) continue;

    // 是否已就该「离线段」告警过
    const last = await db.query(
      `SELECT id, alerted_at FROM profit_alert_event WHERE user_id = ? AND kind = 'offline' ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    if (last.length && last[0].alerted_at) {
      const sinceMin = (t.getTime() - new Date(last[0].alerted_at).getTime()) / 60000;
      if (sinceMin < (Number(rule.offlineAlertRepeatMin) || 120)) continue;
      // 采集端在最近一次离线告警之后又恢复过 → 新的离线段，重新告警
    }
    const md = [
      '## 🔌 采集端离线',
      `> 已有 **${isFinite(ageMin) ? Math.round(ageMin) + ' 分钟' : '很长时间'}** 没有收到毛利采集心跳`,
      `> 最近成功上报：${st.lastOkAt ? new Date(st.lastOkAt).toLocaleString('zh-CN', { hour12: false }) : '从未成功'}`,
      st.error ? `> 最近错误：${clip(st.error, 160)}` : '',
      '',
      '请检查：① 那台 24 小时开机的电脑是否在运行；② 「1688催收助手」是否在托盘运行；③ 美团页面是否掉登录。',
    ].filter(Boolean).join('\n');
    const res = await sendWecom(rule, md, { force: true });
    await db.exec(
      `INSERT INTO profit_alert_event (user_id, kind, order_no, fingerprint, status, channel, alerted_at, meta)
       VALUES (?, 'offline', '', ?, ?, 'wecom', NOW(), ?)`,
      [userId, sha1('offline|' + t.toISOString().slice(0, 16)), res.ok ? 'sent' : 'failed', JSON.stringify({ error: res.error || null, ageMin })]
    ).catch(() => {});
    out.push({ userId, ok: res.ok, error: res.error || null });
  }
  return out;
}

// ── 查询（看板用） ──
async function listEvents(userId, { kind, limit, offset }) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const args = [Number(userId)];
  let where = 'user_id = ?';
  if (kind) { where += ' AND kind = ?'; args.push(String(kind)); }
  const rows = await db.query(
    `SELECT id, kind, order_no, store_name, goods_title, order_status, gross_profit, amount,
            status, channel, alerted_at, recovered_at, meta
       FROM profit_alert_event WHERE ${where} ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`,
    args
  );
  const cnt = await db.query(`SELECT COUNT(*) AS n FROM profit_alert_event WHERE ${where}`, args);
  return {
    total: Number(cnt[0] && cnt[0].n) || 0,
    events: rows.map((r) => ({
      id: r.id, kind: r.kind, orderNo: r.order_no, store: r.store_name, title: r.goods_title,
      status: r.order_status, gross: r.gross_profit === null ? null : Number(r.gross_profit),
      amount: r.amount === null ? null : Number(r.amount),
      pushStatus: r.status, channel: r.channel, alertedAt: r.alerted_at, recoveredAt: r.recovered_at,
    })),
  };
}

async function listSnapshots(userId, { onlyNegative, limit }) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const args = [Number(userId)];
  let extra = '';
  if (onlyNegative) { extra = ' AND gross_profit IS NOT NULL AND gross_profit < 0'; }
  const rows = await db.query(
    `SELECT order_no, store_name, goods_title, order_status, gross_profit, amount, order_time, last_seen_at
       FROM profit_order_snapshot WHERE user_id = ?${extra}
      ORDER BY (gross_profit IS NULL), gross_profit ASC, last_seen_at DESC LIMIT ${lim}`,
    args
  );
  return rows.map((r) => ({
    orderNo: r.order_no, store: r.store_name, title: r.goods_title, status: r.order_status,
    gross: r.gross_profit === null ? null : Number(r.gross_profit),
    amount: r.amount === null ? null : Number(r.amount),
    orderTime: r.order_time, seenAt: r.last_seen_at,
  }));
}

/** 概览统计（看板顶部卡片） */
async function summary(userId) {
  const rows = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(gross_profit < 0) AS neg,
            SUM(gross_profit < 0) AS neg_cnt,
            ROUND(SUM(CASE WHEN gross_profit < 0 THEN gross_profit ELSE 0 END), 2) AS neg_sum,
            MAX(last_seen_at) AS last_seen
       FROM profit_order_snapshot WHERE user_id = ?`,
    [Number(userId)]
  );
  const r = rows[0] || {};
  const today = await db.query(
    `SELECT COUNT(*) AS n FROM profit_alert_event
      WHERE user_id = ? AND kind='neg' AND alerted_at >= CURDATE()`,
    [Number(userId)]
  );
  return {
    orders: Number(r.total) || 0,
    negative: Number(r.neg_cnt) || 0,
    negativeSum: r.neg_sum === null ? 0 : Number(r.neg_sum),
    lastSeenAt: r.last_seen || null,
    alertedToday: Number(today[0] && today[0].n) || 0,
  };
}

/** 助手刚连上时，告诉它「现在该不该采、按什么节奏采」 */
async function agentBootstrap(userId) {
  const rule = await loadRule(userId);
  return {
    config: toAgentConfig(rule),
    state: await loadState(userId),
  };
}

module.exports = {
  DEFAULT_POLL_SEC, DEFAULT_THRESHOLD, WECOM_MAX_PER_MIN, EVENT_KIND, DEFAULT_NAME_PREFIX,
  defaultRule, loadRule, saveRule, sanitizeRule, toAgentConfig, maskRule,
  ingest, touchState, loadState, checkOffline, sendWecom, sendTest,
  listEvents, listSnapshots, summary, agentBootstrap,
  // 供测试/其它模块复用
  toNum, fmtYuan, parseQuietHours, normalizeWecomKey, inScope, sha1, builtinWecomKey,
};
