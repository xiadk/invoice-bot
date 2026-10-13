/**
 * server.js — 发票催收控制台（多用户 / 可云端部署）
 *
 * 启动: node server.js   →  浏览器打开 http://localhost:8787 （生产建议放在 HTTPS 反代后面）
 *
 * ── 账号与权限 ────────────────────────────────────────────────────────────
 *   登录页 /login（只能登录，不能注册）；账号由超级管理员在「系统管理」里创建。
 *   超级管理员 admin（首次建库自动创建，默认密码 admin，请立即修改）：
 *     · 新增用户（账号/密码/公司名称/纳税人识别号/收票邮箱）、重置密码、启用/禁用
 *     · 按用户名查看任意用户的看板与名称映射数据（只读）
 *   普通用户：只能看自己的「看板」与「名称映射」，看不到「系统管理」。
 *   所有业务数据按 user_id 隔离（见 sql/schema.sql 与 lib/tenancy.js）。
 *
 * ── 1688 登录态（入库，服务端发送时取用） ─────────────────────────────────
 *   登录态 = Playwright storageState，加密后存在数据库 login_state 表（见 lib/state-store.js）。
 *   获取方式：用户在**自己电脑的浏览器**登录 1688 后，用浏览器扩展（extension/）把登录态
 *   上传给服务器（看板「登录 1688」弹窗 → 生成一次性上传码 → 扩展填写并上传）。
 *   ⚠ 服务器不再承载登录画面（无投屏登录）：服务器全程不接触 1688 密码。
 *   发送催收消息时从库里取态喂给本机 Chromium；失效自动标记 expired 并提示重新上传。
 *   兼容：历史遗留的 data/users/<id>/state-1688.json 首次启动会迁入数据库（原文件保留）。
 *
 * ── 接口 ──────────────────────────────────────────────────────────────────
 *   认证:   POST /api/auth/login | POST /api/auth/logout | GET /api/auth/me | POST /api/auth/password
 *   看板:   GET  /api/data | GET /api/seller-detail | GET /api/collect-history
 *   发送:   POST /api/send | GET /api/task | POST /api/task/stop
 *   数据:   POST /api/import | GET /api/import-log
 *   映射:   GET  /api/mapping | POST /api/mapping | POST /api/mapping/delete | POST /api/mapping/ignore
 *           POST /api/order-state
 *   配置:   GET  /api/config | POST /api/config（仅管理员）
 *   登录态: GET  /api/state/status | POST /api/state/upload-token（生成一次性上传码）
 *           POST /api/state/upload（扩展上传，凭上传码，无需登录 Cookie） | POST /api/state/clear
 *   本机通道: GET /api/agent/status | POST /api/agent/pair-code | POST /api/agent/disconnect
 *           GET  /api/agent/tasks | GET /api/agent/resumable | POST /api/agent/resume | WS /ws/agent
 *   管理:   GET  /api/admin/users | POST /api/admin/users/create | /update | /password | /status | /delete
 *   运维:   GET  /healthz
 *
 *   管理员查看他人数据：任何读接口加 ?tenant=<用户ID>（普通用户会被忽略，强制只看自己）。
 *
 * ── 统计口径 ──────────────────────────────────────────────────────────────
 *   已开票金额 = 税务局文件（issued_invoice）中该商家的「价税合计」明细总和
 *   已开票数量 = 税务局文件里该商家的「发票张数」，按数电票号（e_invoice_no）/发票号去重
 *   待开票金额 = 订单金额 − 已开票金额（不小于 0）
 *   催收次数   = send_log 表里 result='ok' 的成功发送次数（失败尝试不计入次数）
 *   最近催收时间 = 最近一次成功发送的时间；催收按「会员名」记录
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./lib/auth');
const tenancy = require('./lib/tenancy');
const { runImport } = require('./import-to-db');
const { launch, loadConfig } = require('./lib/browser');
const stateStore = require('./lib/state-store');
const { AgentHub } = require('./lib/agent-hub');
const { buildMessages, sendToSeller } = require('./lib/sender');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

// ─────────────────────────────────────────────────────────────────────────
// HTTP 工具
// ─────────────────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
function sendHtml(res, file) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
}
function redirect(res, to) {
  res.writeHead(302, { location: to });
  res.end();
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > 2e6) { tooBig = true; req.destroy(); } });
    req.on('end', () => { if (tooBig) return resolve({}); try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 认证 / 权限
// ─────────────────────────────────────────────────────────────────────────
/** 取当前登录用户（校验会话签名 + token_version + 账号状态） */
async function currentUser(req) {
  const sess = auth.sessionFromRequest(req);
  if (!sess) return null;
  const rows = await db.query('SELECT * FROM app_user WHERE id = ?', [sess.u]);
  const u = rows[0];
  if (!u) return null;
  if (u.status !== 'active') return null;
  if ((Number(u.token_version) || 1) !== Number(sess.v)) return null;
  return u;
}

/** 公开的用户信息（不下发密码哈希） */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    companyName: u.company_name || '',
    taxNo: u.tax_no || '',
    email: u.email || '',
    displayName: u.display_name || '',
    mustChangePassword: !!u.must_change_password,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

/**
 * 解析本次请求操作的目标租户：
 *   · 普通用户 → 只能是自己（忽略 tenant 参数）
 *   · 管理员 → 可用 ?tenant=<id> 或请求头 x-tenant-id 查看他人数据
 */
function tenantOf(req, url, user) {
  if (user.role === 'admin') {
    const t = url.searchParams.get('tenant') || req.headers['x-tenant-id'];
    if (t !== undefined && t !== null && String(t) !== '') {
      const n = Number(t);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return user.id;
}

/** 写操作只允许作用于自己的数据（管理员查看他人为只读） */
function assertWritable(user, tenantId) {
  if (Number(tenantId) !== Number(user.id)) {
    const err = new Error('查看他人数据为只读模式，无法修改');
    err.code = 403;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 数据加载（全部按 user_id 隔离）
// ─────────────────────────────────────────────────────────────────────────

/** 某用户的卖家聚合列表：订单维度 + 税务局已开票维度 */
async function loadSellers(userId) {
  const orderRows = await db.query(`
    SELECT
      COALESCE(NULLIF(o.seller_login,''), o.seller_company) AS loginId,
      MAX(o.seller_company)                                 AS company,
      MAX(o.seller_login)                                   AS sellerLogin,
      COUNT(*)                                              AS total,
      ROUND(SUM(COALESCE(o.pay_amount,0)), 2)               AS totalAmount,
      SUM(o.invoice_state = 'none')                         AS noneCount,
      SUM(o.invoice_state = 'applying')                     AS applyingCount,
      SUM(o.invoice_state = 'issued')                       AS issuedStateCount,
      SUM(o.invoice_state <> 'issued')                      AS unissuedCount,
      SUM(o.invoice_state = 'issued' AND o.state_source = 'manual') AS manualIssuedCount,
      ROUND(SUM(CASE WHEN o.invoice_state = 'issued' AND o.state_source = 'manual'
                     THEN COALESCE(o.pay_amount,0) ELSE 0 END), 2) AS manualIssuedAmount,
      MAX(o.pay_time)                                       AS lastPayTime
    FROM invoice_order o
    WHERE o.user_id = ?
      AND COALESCE(NULLIF(o.seller_login,''), o.seller_company) IS NOT NULL
    GROUP BY loginId
  `, [userId]);

  // 催收记录：催收次数只计成功（result='ok'），最近催收时间取最近一次成功
  const sendRows = await db.query(`
    SELECT seller_login,
           SUM(result = 'ok')  AS sendCount,
           SUM(result <> 'ok') AS failCount,
           MAX(CASE WHEN result = 'ok' THEN sent_at END) AS lastSentAt
    FROM send_log WHERE user_id = ?
    GROUP BY seller_login
  `, [userId]);
  const sendByLogin = new Map(sendRows.map((r) => [r.seller_login, r]));

  // 已开票数据按「映射后的商家名称」汇总
  const invRows = await db.query(`
    SELECT seller_company                                              AS company,
           COUNT(DISTINCT COALESCE(NULLIF(e_invoice_no,''), NULLIF(invoice_no,''), row_hash)) AS invoiceCount,
           COUNT(*)                                                    AS invoiceRowCount,
           ROUND(SUM(COALESCE(total_amount,0)), 2)                     AS invoiceAmount,
           MIN(invoice_date)                                           AS firstInvoiceDate,
           MAX(invoice_date)                                           AS lastInvoiceDate
    FROM issued_invoice
    WHERE user_id = ? AND seller_company IS NOT NULL AND seller_company <> ''
    GROUP BY seller_company
  `, [userId]);
  const invByCompany = new Map(invRows.map((r) => [r.company, r]));

  // 同一家公司可能对应多个会员名，发票额只挂在「主行」上避免重复计入
  const ownerRows = await db.query(
    `SELECT seller_company, seller_login FROM seller_name_mapping
     WHERE user_id = ? AND seller_company IS NOT NULL AND seller_login IS NOT NULL`,
    [userId]
  );
  const ownerByCompany = new Map(ownerRows.map((r) => [r.seller_company, r.seller_login]));

  const list = orderRows.map((r) => {
    const inv = invByCompany.get(r.company) || null;
    const st = r.sellerLogin ? sendByLogin.get(r.sellerLogin) : null;
    return {
      loginId: r.loginId,
      company: r.company,
      sellerLogin: r.sellerLogin || '',
      total: Number(r.total) || 0,
      totalAmount: (Number(r.totalAmount) || 0).toFixed(2),
      noneCount: Number(r.noneCount) || 0,
      applyingCount: Number(r.applyingCount) || 0,
      issuedStateCount: Number(r.issuedStateCount) || 0,
      unissuedCount: Number(r.unissuedCount) || 0,
      manualIssuedCount: Number(r.manualIssuedCount) || 0,
      manualIssuedAmount: (Number(r.manualIssuedAmount) || 0).toFixed(2),
      invoicedAmount: (inv ? Number(inv.invoiceAmount) || 0 : 0).toFixed(2),
      invoiceCount: inv ? Number(inv.invoiceCount) || 0 : 0,
      invoiceRowCount: inv ? Number(inv.invoiceRowCount) || 0 : 0,
      lastInvoiceDate: inv ? inv.lastInvoiceDate : null,
      firstInvoiceDate: inv ? inv.firstInvoiceDate : null,
      invoiceOwnerLoginId: null,
      invoiceOwnerLabel: null,
      sendCount: st ? Number(st.sendCount) || 0 : 0,
      sendFailCount: st ? Number(st.failCount) || 0 : 0,
      lastSentAt: st ? st.lastSentAt : null,
      lastPayTime: r.lastPayTime,
    };
  });

  const groupByCompany = new Map();
  for (const row of list) {
    if (!row.company) continue;
    if (!groupByCompany.has(row.company)) groupByCompany.set(row.company, []);
    groupByCompany.get(row.company).push(row);
  }
  for (const [company, rows] of groupByCompany) {
    if (rows.length < 2) continue;
    const wantLogin = ownerByCompany.get(company);
    let owner = wantLogin ? rows.find((x) => x.sellerLogin === wantLogin || x.loginId === wantLogin) : null;
    if (!owner) owner = rows.reduce((a, b) => (b.total > a.total ? b : a));
    for (const row of rows) {
      if (row === owner) continue;
      row.invoiceOwnerLoginId = owner.loginId;
      row.invoiceOwnerLabel = owner.sellerLogin || owner.loginId;
      row.invoicedAmount = '0.00';
      row.invoiceCount = 0;
      row.invoiceRowCount = 0;
      row.lastInvoiceDate = null;
      row.firstInvoiceDate = null;
    }
  }

  for (const row of list) {
    const totalAmount = Number(row.totalAmount) || 0;
    const invoicedAmount = Number(row.invoicedAmount) || 0;
    row.overInvoiced = invoicedAmount > totalAmount;
    row.pendingAmount = Math.max(totalAmount - invoicedAmount, 0).toFixed(2);
    row.pending = Number(row.pendingAmount) > 0 ? 1 : 0;
  }
  list.sort((a, b) => Number(b.pendingAmount) - Number(a.pendingAmount));
  return list;
}

/** 公司聚合（看板主视图）：一家公司一行，会员名作为 members 子树 */
async function loadCompanies(userId) {
  const members = await loadSellers(userId);
  const byCompany = new Map();
  for (const m of members) {
    const key = m.company || m.loginId;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(m);
  }

  const sum = (rows, f) => rows.reduce((a, x) => a + (Number(x[f]) || 0), 0);
  const maxOf = (rows, f) => rows.map((x) => x[f]).filter(Boolean).sort().pop() || null;

  const companies = [];
  for (const [company, rows] of byCompany) {
    const totalAmount = sum(rows, 'totalAmount');
    const invoicedAmount = sum(rows, 'invoicedAmount');
    const pendingAmount = Math.max(totalAmount - invoicedAmount, 0);
    rows.sort((a, b) => Number(b.pendingAmount) - Number(a.pendingAmount));
    companies.push({
      company,
      memberCount: rows.length,
      total: sum(rows, 'total'),
      totalAmount: totalAmount.toFixed(2),
      noneCount: sum(rows, 'noneCount'),
      applyingCount: sum(rows, 'applyingCount'),
      issuedStateCount: sum(rows, 'issuedStateCount'),
      unissuedCount: sum(rows, 'unissuedCount'),
      manualIssuedCount: sum(rows, 'manualIssuedCount'),
      manualIssuedAmount: sum(rows, 'manualIssuedAmount').toFixed(2),
      invoicedAmount: invoicedAmount.toFixed(2),
      invoiceCount: sum(rows, 'invoiceCount'),
      invoiceRowCount: sum(rows, 'invoiceRowCount'),
      lastInvoiceDate: maxOf(rows, 'lastInvoiceDate'),
      pendingAmount: pendingAmount.toFixed(2),
      overInvoiced: invoicedAmount > totalAmount,
      sendCount: sum(rows, 'sendCount'),
      sendFailCount: sum(rows, 'sendFailCount'),
      lastSentAt: maxOf(rows, 'lastSentAt'),
      lastPayTime: maxOf(rows, 'lastPayTime'),
      members: rows.map((m) => ({
        loginId: m.loginId,
        sellerLogin: m.sellerLogin,
        company: m.company,
        total: m.total,
        totalAmount: m.totalAmount,
        noneCount: m.noneCount,
        applyingCount: m.applyingCount,
        issuedStateCount: m.issuedStateCount,
        unissuedCount: m.unissuedCount,
        manualIssuedCount: m.manualIssuedCount,
        manualIssuedAmount: m.manualIssuedAmount,
        invoicedAmount: m.invoicedAmount,
        invoiceCount: m.invoiceCount,
        invoiceRowCount: m.invoiceRowCount,
        lastInvoiceDate: m.lastInvoiceDate,
        pendingAmount: m.pendingAmount,
        overInvoiced: m.overInvoiced,
        invoiceOwnerLoginId: m.invoiceOwnerLoginId,
        invoiceOwnerLabel: m.invoiceOwnerLabel,
        sendCount: m.sendCount,
        sendFailCount: m.sendFailCount,
        lastSentAt: m.lastSentAt,
        canSend: Number(m.pendingAmount) > 0 && m.unissuedCount > 0 && !!m.sellerLogin,
      })),
    });
  }
  companies.sort((a, b) => Number(b.pendingAmount) - Number(a.pendingAmount));
  return companies;
}

/** 单个卖家的订单明细 + 已开票明细 + 催收记录 */
async function loadSellerDetail(userId, loginId) {
  const orders = await db.query(
    `SELECT order_no, pay_amount, pay_time, order_status, invoice_state, state_source, state_note, goods_title
     FROM invoice_order
     WHERE user_id = ? AND COALESCE(NULLIF(seller_login,''), seller_company) = ?
     ORDER BY pay_time DESC`,
    [userId, loginId]
  );
  const seller = orders.length
    ? (await db.query(
        `SELECT MAX(seller_company) AS company, MAX(seller_login) AS sellerLogin FROM invoice_order
         WHERE user_id = ? AND COALESCE(NULLIF(seller_login,''), seller_company) = ?`, [userId, loginId]
      ))[0]
    : { company: null, sellerLogin: null };
  const invoices = seller.company
    ? await db.query(
        `SELECT e_invoice_no, invoice_no, row_hash, seller_name, goods_name, total_amount, tax_amount, invoice_date, invoice_kind, invoice_status
         FROM issued_invoice WHERE user_id = ? AND seller_company = ? ORDER BY invoice_date DESC, id`,
        [userId, seller.company]
      )
    : [];
  const invoiceRowCount = invoices.length;
  const invoiceCount = new Set(invoices.map((v) => v.e_invoice_no || v.invoice_no || v.row_hash)).size;
  const sendLogs = seller.sellerLogin
    ? await db.query(
        `SELECT send_date, sent_at, result, channel, error FROM send_log
         WHERE user_id = ? AND seller_login = ? ORDER BY sent_at DESC, id DESC LIMIT 50`,
        [userId, seller.sellerLogin]
      )
    : [];
  return { orders, invoices, company: seller.company, sendLogs, invoiceCount, invoiceRowCount };
}

/** 催收统计（来自 send_log；催收次数只计成功） */
async function loadSendStats(userId) {
  return db.query(`
    SELECT seller_login AS login,
           SUM(result = 'ok')  AS sendCount,
           SUM(result <> 'ok') AS failCount,
           MAX(CASE WHEN result = 'ok' THEN sent_at END) AS lastSentAt
    FROM send_log WHERE user_id = ?
    GROUP BY seller_login
  `, [userId]);
}

/** 历史催收记录：传 loginId → 该会员名；传 company → 该公司下所有会员名 */
async function loadCollectHistory(userId, { loginId, company }) {
  let rows = [];
  if (loginId) {
    rows = await db.query(
      `SELECT sent_at, result, channel, amount, order_nos, error, seller_login,
              COALESCE(NULLIF(seller_login,''), seller_company) AS scope_key
       FROM send_log WHERE user_id = ? AND seller_login = ? ORDER BY sent_at DESC, id DESC`,
      [userId, loginId]
    );
  } else if (company) {
    const loginRows = await db.query(
      `SELECT DISTINCT COALESCE(NULLIF(seller_login,''), seller_company) AS login
       FROM invoice_order
       WHERE user_id = ? AND seller_company = ? AND COALESCE(NULLIF(seller_login,''), seller_company) IS NOT NULL`,
      [userId, company]
    );
    const ids = loginRows.map((r) => r.login).filter(Boolean);
    const params = [userId, company];
    let sql = `SELECT sent_at, result, channel, amount, order_nos, error, seller_login, seller_company AS scope_key
               FROM send_log WHERE user_id = ? AND seller_company = ?`;
    if (ids.length) {
      // OR 分支同样限定 user_id，保证跨租户不会串数据
      sql += ` OR (user_id = ? AND seller_login IN (${ids.map(() => '?').join(',')}))`;
      params.push(userId, ...ids);
    }
    sql += ' ORDER BY sent_at DESC, id DESC';
    rows = await db.query(sql, params);
  }
  const logs = rows.map((r) => ({
    sentAt: r.sent_at,
    result: r.result,
    channel: r.channel,
    amount: r.amount == null ? null : Number(r.amount),
    orderNos: r.order_nos || null,
    error: r.error || null,
    scope: r.scope_key || '',
  }));
  const okCount = logs.filter((l) => l.result === 'ok').length;
  return { logs, total: logs.length, okCount, failCount: logs.length - okCount };
}

// ─────────────────────────────────────────────────────────────────────────
// 每用户任务状态（发送进度）
// ─────────────────────────────────────────────────────────────────────────
const TASKS = new Map(); // userId -> taskState
function taskFor(userId) {
  let t = TASKS.get(userId);
  if (!t) {
    t = {
      running: false, channel: null, type: null, total: 0, done: 0, ok: 0, fail: 0,
      current: null, logs: [], stopRequested: false, startedAt: null, finishedAt: null,
    };
    TASKS.set(userId, t);
  }
  return t;
}
function taskLog(taskState, text) {
  taskState.logs.push({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text });
  if (taskState.logs.length > 500) taskState.logs.splice(0, taskState.logs.length - 500);
  console.log(text);
}

/** 记录一次催收发送（send_log 一行 = 一次发送） */
async function recordSent(userId, loginId, company, result = 'ok', channel = 'web', amount = null, orderNos = null, error = null) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await db.exec(
    `INSERT INTO send_log (user_id, send_date, seller_login, seller_company, result, channel, amount, order_nos, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId, date, loginId, company || null, result, channel,
      amount == null ? null : Number(amount),
      orderNos || null,
      result === 'ok' || !error ? null : String(error).split('\n')[0].slice(0, 250),
    ]
  );
}

/** 取用户的开票抬头（催收话术里的 {companyName}/{taxNo}/{email}） */
async function buyerInfoOf(userId) {
  const rows = await db.query('SELECT company_name, tax_no, email FROM app_user WHERE id = ?', [userId]);
  const u = rows[0] || {};
  return { companyName: u.company_name || '', taxNo: u.tax_no || '', email: u.email || '' };
}

// ─────────────────────────────────────────────────────────────────────────
// 本机浏览器通道（方案C）：连接中枢 + 任务下发 + 结果回收
//   发送动作在用户本机浏览器里完成；服务器只负责下发任务、记录结果、展示进度。
// ─────────────────────────────────────────────────────────────────────────
const agentHub = new AgentHub({
  onMessage: (uid, msg) => handleAgentMessage(uid, msg),
  onStatus: (uid) => maybeAbortClientTask(uid),
});

/** 正在等待本机回执的任务：taskId -> ctx */
const CLIENT_TASKS = new Map();

function handleAgentMessage(uid, msg) {
  if (msg.type === 'login_state') { agentHub.setLoggedIn(uid, msg.loggedIn); return; }
  if (msg.type === 'sent') { onAgentSent(uid, msg); return; }
  if (msg.type === 'log') {
    const t = taskFor(uid);
    if (t.running && t.channel === 'client') taskLog(t, '· ' + String(msg.text || '').slice(0, 200));
    return;
  }
}

function onAgentSent(uid, msg) {
  const ctx = CLIENT_TASKS.get(Number(msg.taskId));
  if (!ctx || ctx.userId !== Number(uid)) return;
  const s = ctx.sellers.find((x) => x.loginId === msg.loginId);
  const t = ctx.taskState;
  const sellerLogin = s ? s.sellerLogin : msg.loginId;
  const company = s ? s.company : '';
  if (msg.ok) {
    t.ok++;
    recordSent(uid, sellerLogin, company, 'ok', 'client', s ? s.amount : null, s ? s.orderNos : null).catch(() => {});
    taskLog(t, `✓ ${company || sellerLogin} 发送成功 · 催收次数 +1`);
  } else {
    t.fail++;
    recordSent(uid, sellerLogin, company, 'fail', 'client', s ? s.amount : null, s ? s.orderNos : null,
      msg.error || '本机发送失败').catch(() => {});
    taskLog(t, `✗ ${company || sellerLogin} 失败: ${String(msg.error || '本机发送失败').split('\n')[0]} · 已记录失败原因`);
  }
  if (s) s._result = msg.ok ? 'ok' : 'fail';
  t.done++;
  t.current = null;
  db.exec('UPDATE agent_task SET done=?, ok=?, fail=? WHERE id=?', [t.done, t.ok, t.fail, ctx.taskId]).catch(() => {});
  ctx.pending--;
  if (ctx.pending <= 0) finishClientTask(ctx, ctx.stopRequested ? 'aborted' : 'done');
}

async function finishClientTask(ctx, status) {
  if (ctx.finished) return;
  ctx.finished = true;
  clearTimeout(ctx.timer);
  CLIENT_TASKS.delete(ctx.taskId);
  const t = ctx.taskState;
  t.running = false;
  t.current = null;
  t.finishedAt = new Date().toISOString();
  const items = ctx.sellers.map((s) => ({
    loginId: s.loginId, company: s.company, amount: s.amount, orderNos: s.orderNos, status: s._result || 'pending',
  }));
  const reason = status === 'aborted' ? (ctx.abortReason || '被中断') : (status === 'failed' ? (ctx.abortReason || '异常结束') : null);
  await db.exec(
    'UPDATE agent_task SET status=?, done=?, ok=?, fail=?, items=?, error=?, finished_at=NOW() WHERE id=?',
    [status, t.done, t.ok, t.fail, JSON.stringify(items), reason, ctx.taskId]
  ).catch(() => {});
  taskLog(t, `■ 本机通道任务 #${ctx.taskId} 结束：成功 ${t.ok} · 失败 ${t.fail}${status === 'aborted' ? ' · 已中断' : ''}`);
  taskLog(t, `任务完成 ${t.ok}/${t.total}`);
  const left = items.filter((i) => i.status === 'pending').length;
  if (left > 0) {
    taskLog(t, `↻ 还有 ${left} 家未发送：本机通道重新连接后，点看板「继续发送未完成」即可续跑（不会重发已成功的）`);
  } else if (t.fail > 0) {
    taskLog(t, `↻ 有 ${t.fail} 家发送失败：可在看板「重试失败项」按原清单重发`);
  }
  try { ctx.resolve && ctx.resolve(); } catch (e) { /* 忽略 */ }
}

/** 本机通道掉线时，中断其正在跑的任务 */
function maybeAbortClientTask(uid) {
  if (agentHub.isOnline(uid)) return;
  for (const ctx of CLIENT_TASKS.values()) {
    if (ctx.userId === Number(uid) && !ctx.finished) {
      taskLog(ctx.taskState, '⛔ 本机浏览器通道已断开，任务中断（重新配对连接后可点看板「继续发送未完成」续跑）');
      ctx.abortReason = '本机浏览器通道断开';
      finishClientTask(ctx, 'aborted');
    }
  }
}

function estimateClientTimeout(n, gapMaxMs) {
  return Math.max(120000, n * (Math.ceil(gapMaxMs / 1000) + 60) * 1000);
}

// ── 断线续跑（方案C） ──────────────────────────────────────────────────────
/**
 * 对账：把「库里仍在 running、但内存里已无对应执行上下文」的任务置为 aborted。
 * 覆盖服务进程重启/崩溃后遗留的 running 任务。
 * @returns {Promise<number>} 被纠正的任务数
 */
async function reconcileStaleAgentTasks(userId) {
  const rows = await db.query("SELECT id FROM agent_task WHERE user_id = ? AND status = 'running'", [userId]);
  const stale = rows.filter((r) => !CLIENT_TASKS.has(Number(r.id)));
  for (const r of stale) {
    await db.exec(
      "UPDATE agent_task SET status = 'aborted', error = ?, finished_at = NOW() WHERE id = ? AND status = 'running'",
      ['服务重启或任务上下文丢失，已中断（可续跑）', r.id]
    ).catch(() => {});
  }
  return stale.length;
}

/** 解析 agent_task.items，统计 pending / failed */
function summarizeItems(raw) {
  let items = [];
  try { items = typeof raw === 'string' ? JSON.parse(raw) : (raw || []); } catch (e) { items = []; }
  if (!Array.isArray(items)) items = [];
  return {
    pending: items.filter((i) => i && i.status === 'pending'),
    failed: items.filter((i) => i && i.status === 'fail'),
  };
}

/**
 * 取「最近一次可续跑的任务」：优先还有 pending 的，其次有失败项的（只看最近 10 条任务）。
 * 只回传未完成项（不含 ok），供看板展示与一键续发。
 * 已被后续续跑任务接续过的旧任务视为「已作废」，不再重复提示（避免把已补发的项再发一遍）。
 */
async function resumableTask(userId) {
  await reconcileStaleAgentTasks(userId);
  const rows = await db.query(
    'SELECT id, status, total, ok, fail, error, items, resume_of, finished_at, created_at FROM agent_task ' +
    'WHERE user_id = ? ORDER BY id DESC LIMIT 10', [userId]
  );
  const superseded = new Set();
  for (const r of rows) if (r.resume_of) superseded.add(Number(r.resume_of));

  for (const r of rows) {
    if (r.status === 'running') continue;
    if (superseded.has(Number(r.id))) continue;
    const sum = summarizeItems(r.items);
    if (!sum.pending.length && !sum.failed.length) continue;
    return {
      task: {
        id: Number(r.id), status: r.status, error: r.error || null,
        total: Number(r.total), ok: Number(r.ok), fail: Number(r.fail),
        pending: sum.pending.length, failed: sum.failed.length,
        finishedAt: r.finished_at, createdAt: r.created_at,
        remaining: [...sum.pending, ...sum.failed].map((i) => ({
          loginId: i.loginId, company: i.company || '',
          amount: i.amount == null ? null : Number(i.amount),
          orderNos: i.orderNos || '', status: i.status,
        })),
      },
    };
  }
  return { task: null };
}

/**
 * 取某任务的未完成项 loginId 清单（按 loginId 去重）
 * @param {'pending'|'failed'|'both'} scope
 */
async function resumeLoginIds(userId, taskId, scope) {
  const rows = await db.query('SELECT id, items FROM agent_task WHERE id = ? AND user_id = ?', [taskId, userId]);
  const r = rows[0];
  if (!r) throw new Error('找不到该任务（可能不属于当前账号）');
  const sum = summarizeItems(r.items);
  const pick = scope === 'failed' ? sum.failed
    : scope === 'both' ? [...sum.pending, ...sum.failed]
      : sum.pending;
  const seen = new Set();
  const loginIds = [];
  for (const it of pick) {
    if (!it || !it.loginId || seen.has(it.loginId)) continue;
    seen.add(it.loginId);
    loginIds.push(it.loginId);
  }
  return { taskId: Number(r.id), loginIds, pending: sum.pending.length, failed: sum.failed.length };
}

/**
 * 组装并下发一次「本机浏览器」发送任务
 * @param {number} userId
 * @param {string[]} loginIds 要发送的卖家内部 loginId
 * @param {{resumeOf?:number}} [opts] resumeOf=断线续跑时被接续的任务 id（仅用于审计与日志）
 */
async function doClientSend(userId, loginIds, opts = {}) {
  const resumeOf = Number(opts.resumeOf) || null;
  const taskState = taskFor(userId);
  if (taskState.running) throw new Error('已有任务在运行中');
  if (!agentHub.isOnline(userId)) throw new Error('本机浏览器通道未连接：请先在本机浏览器安装扩展并完成配对');

  const config = loadConfig();
  const rt = config.runtime || {};
  const gapMin = (rt.sendGapMinSec || 15) * 1000;
  const gapMax = (rt.sendGapMaxSec || 30) * 1000;
  const buyer = await buyerInfoOf(userId);
  const runConfig = { ...config, buyerInfo: buyer };
  const data = await loadSellers(userId);

  const sellers = [];
  for (const loginId of loginIds) {
    const s = data.find((x) => x.loginId === loginId);
    if (!s || !s.sellerLogin) continue;
    const detail = await loadSellerDetail(userId, loginId);
    const toRemind = detail.orders.filter((o) => o.invoice_state !== 'issued');
    if (!toRemind.length) continue;
    const msgSeller = {
      loginId: s.sellerLogin,
      amount: Number(s.pendingAmount),
      orders: toRemind.map((o) => ({ orderId: o.order_no, amount: Number(o.pay_amount).toFixed(2) })),
    };
    sellers.push({
      loginId,
      sellerLogin: s.sellerLogin,
      company: s.company,
      amount: Number(s.pendingAmount) || 0,
      orderNos: msgSeller.orders.map((o) => o.orderId).join('；'),
      messages: buildMessages(msgSeller, runConfig),
    });
  }
  if (!sellers.length) throw new Error('没有可发送的卖家（可能都已开票或缺少卖家会员名）');

  const created = await db.exec(
    "INSERT INTO agent_task (user_id, status, total, items, resume_of, started_at) VALUES (?, 'running', ?, ?, ?, NOW())",
    [userId, sellers.length, JSON.stringify(sellers.map((s) => ({
      loginId: s.loginId, company: s.company, amount: s.amount, orderNos: s.orderNos, status: 'pending',
    }))), resumeOf]
  );
  const taskId = created.insertId;

  Object.assign(taskState, {
    running: true, channel: 'client', type: 'send', total: sellers.length, done: 0, ok: 0, fail: 0,
    current: null, stopRequested: false, startedAt: new Date().toISOString(), finishedAt: null, logs: [],
    agentTaskId: taskId, pendingLeft: sellers.length, resumeOf,
  });
  taskLog(taskState, resumeOf
    ? `↻ 断线续跑：接续任务 #${resumeOf}，补发剩余 ${sellers.length} 家（新任务 #${taskId}）`
    : `▶ 通过「本机浏览器」发送催收消息：共 ${sellers.length} 家（任务 #${taskId}）`);
  taskLog(taskState, '· 发送在您本机浏览器执行，服务器只下发任务并记录结果');
  if (!agentHub.status(userId).loggedIn) {
    taskLog(taskState, '⚠ 本机浏览器尚未登录 1688：若发送失败，请在该浏览器登录 1688 后重试');
  }

  await new Promise((resolve) => {
    const ctx = {
      taskId, userId: Number(userId), sellers, taskState, pending: sellers.length,
      stopRequested: false, finished: false, abortReason: null, resolve,
      timer: setTimeout(() => {
        taskLog(taskState, '⏱ 任务超时（长时间未收到本机浏览器回执），已结束');
        ctx.abortReason = '等待本机回执超时';
        finishClientTask(ctx, 'failed');
      }, estimateClientTimeout(sellers.length, gapMax)),
    };
    CLIENT_TASKS.set(taskId, ctx);
    const ok = agentHub.send(userId, {
      type: 'send_batch',
      taskId,
      gapMs: { min: gapMin, max: gapMax },
      sellers: sellers.map((s) => ({
        loginId: s.loginId, sellerLogin: s.sellerLogin, company: s.company, messages: s.messages,
      })),
    });
    if (!ok) {
      ctx.abortReason = '下发时通道已断开';
      taskLog(taskState, '✗ 下发失败：本机浏览器通道已断开');
      finishClientTask(ctx, 'failed');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 发送催收消息（后台任务，进度写入该用户的 taskState）
// ─────────────────────────────────────────────────────────────────────────
async function doSend(userId, loginIds) {
  const taskState = taskFor(userId);
  if (taskState.running) throw new Error('已有任务在运行中');
  const config = loadConfig();
  const rt = config.runtime || {};
  const gapMin = (rt.sendGapMinSec || 15) * 1000;
  const gapMax = (rt.sendGapMaxSec || 30) * 1000;
  const data = await loadSellers(userId);
  const buyer = await buyerInfoOf(userId);
  const statePath = tenancy.statePathFor(userId);
  const runConfig = { ...config, buyerInfo: buyer }; // 话术里的抬头取该用户账号资料
  // 登录态：优先数据库（login_state），库为空时回退历史文件
  const dbState = await stateStore.loadState(userId);

  Object.assign(taskState, {
    running: true, channel: 'server', type: 'send', total: loginIds.length, done: 0, ok: 0, fail: 0,
    current: null, stopRequested: false, startedAt: new Date().toISOString(), finishedAt: null, logs: [],
  });
  taskLog(taskState, `▶ 开始发送催收消息：共 ${loginIds.length} 家（启动独立浏览器）`);
  if (!dbState && !fs.existsSync(statePath)) {
    taskLog(taskState, '⚠ 未找到 1688 登录态：请点右上角「登录 1688」，在你自己电脑的浏览器登录后，用扩展把登录态上传给服务器');
  } else if (dbState) {
    taskLog(taskState, `✓ 已从账号（数据库）取到 1688 登录态：${dbState.cookies.length} 个 cookie`);
  }

  let browser = null;
  let loginLost = false;
  try {
    // storageState 对象优先（来自数据库）；没取到则 launch 自己回退到 statePath 文件
    const launched = await launch({ statePath, storageState: dbState || undefined });
    browser = launched.browser;
    const context = launched.context;
    taskLog(taskState, '✓ 浏览器已启动');

    for (const loginId of loginIds) {
      if (taskState.stopRequested) { taskLog(taskState, '⏹ 已手动停止'); break; }
      const seller = data.find((s) => s.loginId === loginId);
      if (!seller) { taskState.done++; taskState.fail++; taskLog(taskState, `✗ 卖家不存在: ${loginId}`); continue; }
      if (!seller.sellerLogin) { taskState.done++; taskState.fail++; taskLog(taskState, `✗ ${seller.company} 缺少卖家会员名，无法发送`); continue; }
      taskState.current = seller.company;
      const detail = await loadSellerDetail(userId, loginId);
      const toRemind = detail.orders.filter((o) => o.invoice_state !== 'issued');
      const msgSeller = {
        loginId: seller.sellerLogin,
        amount: Number(seller.pendingAmount),
        orders: toRemind.map((o) => ({ orderId: o.order_no, amount: Number(o.pay_amount).toFixed(2) })),
      };
      if (msgSeller.orders.length === 0) { taskState.done++; taskLog(taskState, `- ${seller.company} 无可催收订单，跳过`); continue; }
      const messages = buildMessages(msgSeller, runConfig);
      const collectAmount = Number(seller.pendingAmount) || 0;
      const collectOrderNos = msgSeller.orders.map((o) => o.orderId).join('；');
      const tSell = Date.now();
      try {
        await sendToSeller(context, msgSeller, messages);
        await recordSent(userId, seller.sellerLogin, seller.company, 'ok', 'web', collectAmount, collectOrderNos);
        taskState.ok++;
        taskLog(taskState, `✓ ${seller.company} 发送成功 (${messages.length}条消息, ${Math.round((Date.now() - tSell) / 1000)}s) · 催收次数 +1`);
      } catch (e) {
        if (/登录态失效/.test(e.message)) {
          taskLog(taskState, `⛔ ${e.message}`);
          taskLog(taskState, `■ 批量发送已中止（已完成 ${taskState.ok} 家）：请在你自己电脑的浏览器重新登录 1688，再用扩展上传登录态后重试`);
          loginLost = true;
          break;
        }
        await recordSent(userId, seller.sellerLogin, seller.company, 'fail', 'web', collectAmount, collectOrderNos, e.message);
        taskState.fail++;
        taskLog(taskState, `✗ ${seller.company} 失败: ${e.message.split('\n')[0]} · 已记录失败尝试与原因（不计入催收次数）`);
      }
      taskState.done++;
      if (!loginLost && loginIds.indexOf(loginId) < loginIds.length - 1 && !taskState.stopRequested) {
        const gap = gapMin + Math.random() * (gapMax - gapMin);
        taskLog(taskState, `… 等待 ${Math.round(gap / 1000)}s 后发下一家`);
        const tEnd = Date.now() + gap;
        while (Date.now() < tEnd && !taskState.stopRequested) {
          await sleep(Math.min(500, tEnd - Date.now()));
        }
      }
    }
  } catch (e) {
    taskLog(taskState, `✗ 任务异常: ${e.message.split('\n')[0]}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  taskState.running = false;
  taskState.current = null;
  taskState.finishedAt = new Date().toISOString();
  // 登录态维护：这次确实发出去过 → 记「最近使用」并自愈为有效；被跳登录页 → 标记失效
  if (loginLost) {
    await stateStore.markExpired(userId);
    taskLog(taskState, '登录态已标记为「失效」，重新上传后即可继续发送');
  } else if (taskState.ok > 0) {
    await stateStore.touch(userId);
  }
  taskLog(taskState, loginLost
    ? `■ 发送中止: 成功 ${taskState.ok}, 失败 ${taskState.fail}, 已处理 ${taskState.done}/${taskState.total}（登录态失效）`
    : `■ 发送完成: 成功 ${taskState.ok}, 失败 ${taskState.fail}, 共 ${taskState.done}/${taskState.total}`);
}

// ─────────────────────────────────────────────────────────────────────────
// 名称映射维护（按用户隔离）
// ─────────────────────────────────────────────────────────────────────────
async function loadMapping(userId) {
  const all = await db.query(`
    SELECT m.id, m.tax_seller_name, m.seller_company, m.seller_login,
           m.match_type, m.match_rule, m.is_confirmed, m.is_ignored, m.note, m.updated_at,
           (SELECT ROUND(SUM(total_amount),2) FROM issued_invoice i
             WHERE i.user_id = m.user_id AND i.seller_name = m.tax_seller_name) AS invoice_amount,
           (SELECT COUNT(*) FROM issued_invoice i
             WHERE i.user_id = m.user_id AND i.seller_name = m.tax_seller_name) AS invoice_rows
    FROM seller_name_mapping m
    WHERE m.user_id = ?
    ORDER BY m.is_ignored ASC, (m.seller_company IS NULL) DESC, invoice_amount DESC
  `, [userId]);
  const mappings = all.filter((m) => !m.is_ignored);
  const ignored = all.filter((m) => m.is_ignored);
  const unmatched = await db.query(
    'SELECT * FROM v_unmatched_seller_name WHERE user_id = ? ORDER BY invoice_amount DESC', [userId]
  );
  const sellers = await db.query(`
    SELECT COALESCE(NULLIF(seller_login,''), seller_company) AS loginId,
           MAX(seller_company) AS company, MAX(seller_login) AS sellerLogin
    FROM invoice_order
    WHERE user_id = ? AND seller_company IS NOT NULL
    GROUP BY loginId ORDER BY company
  `, [userId]);
  return { mappings, ignored, unmatched, sellers, unmatchedCount: unmatched.length, ignoredCount: ignored.length };
}

async function saveMapping(userId, { taxSellerName, sellerLogin, sellerCompany, note }) {
  if (!taxSellerName) throw new Error('缺少 taxSellerName');
  if (!sellerCompany) throw new Error('请选择对应的1688商家');
  await db.exec(
    `INSERT INTO seller_name_mapping (user_id, tax_seller_name, seller_company, seller_login, match_type, match_rule, is_confirmed, is_ignored, note)
     VALUES (?, ?, ?, ?, 'manual', 'manual', 1, 0, ?)
     ON DUPLICATE KEY UPDATE seller_company = VALUES(seller_company), seller_login = VALUES(seller_login),
       match_type = 'manual', match_rule = 'manual', is_confirmed = 1, is_ignored = 0, note = VALUES(note)`,
    [userId, taxSellerName, sellerCompany, sellerLogin || null, note || null]
  );
  const r = await db.exec(
    'UPDATE issued_invoice SET seller_company = ? WHERE user_id = ? AND seller_name = ?',
    [sellerCompany, userId, taxSellerName]
  );
  return { ok: true, updatedInvoices: r.affectedRows || 0 };
}

async function ignoreMapping(userId, { taxSellerName, ignored }) {
  if (!taxSellerName || typeof taxSellerName !== 'string' || !taxSellerName.trim()) {
    throw new Error('缺少 taxSellerName（税务局销方名称）');
  }
  taxSellerName = taxSellerName.trim();
  let on;
  if (ignored === undefined || ignored === null) on = true;
  else if (typeof ignored === 'boolean') on = ignored;
  else if (typeof ignored === 'number') on = ignored !== 0;
  else if (typeof ignored === 'string') on = !['false', '0', 'off', 'no', ''].includes(ignored.trim().toLowerCase());
  else on = !!ignored;
  if (on) {
    await db.exec(
      `INSERT INTO seller_name_mapping
         (user_id, tax_seller_name, seller_company, seller_login, match_type, match_rule, is_confirmed, is_ignored, note)
       VALUES (?, ?, NULL, NULL, 'ignored', 'ignored', 1, 1, '确认无对应1688商家，已忽略')
       ON DUPLICATE KEY UPDATE seller_company = NULL, seller_login = NULL,
         match_type = 'ignored', match_rule = 'ignored', is_confirmed = 1, is_ignored = 1,
         note = '确认无对应1688商家，已忽略'`,
      [userId, taxSellerName]
    );
    await db.exec('UPDATE issued_invoice SET seller_company = NULL WHERE user_id = ? AND seller_name = ?', [userId, taxSellerName]);
  } else {
    const rows = await db.query(
      'SELECT id, seller_company FROM seller_name_mapping WHERE user_id = ? AND tax_seller_name = ?', [userId, taxSellerName]
    );
    if (rows[0] && !rows[0].seller_company) {
      await db.exec('DELETE FROM seller_name_mapping WHERE user_id = ? AND tax_seller_name = ?', [userId, taxSellerName]);
    } else {
      await db.exec("UPDATE seller_name_mapping SET is_ignored = 0 WHERE user_id = ? AND tax_seller_name = ?", [userId, taxSellerName]);
    }
  }
  return { ok: true, ignored: on };
}

async function deleteMapping(userId, { taxSellerName }) {
  if (!taxSellerName) throw new Error('缺少 taxSellerName');
  await db.exec('DELETE FROM seller_name_mapping WHERE user_id = ? AND tax_seller_name = ?', [userId, taxSellerName]);
  await db.exec('UPDATE issued_invoice SET seller_company = NULL WHERE user_id = ? AND seller_name = ?', [userId, taxSellerName]);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// 订单级开票状态（人工确认已开票）
// ─────────────────────────────────────────────────────────────────────────
/** 该用户的平台状态集合（按文件 mtime 缓存） */
const _statusCache = new Map(); // userId -> { mtimeMs, issued, applying }
function invoiceStatusSets(userId) {
  const f = tenancy.statusFileFor(userId);
  try {
    const st = fs.statSync(f);
    const cached = _statusCache.get(userId);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached;
    const s = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const out = {
      mtimeMs: st.mtimeMs,
      issued: new Set((s.issued || []).map(String)),
      applying: new Set((s.applying || []).map(String)),
    };
    _statusCache.set(userId, out);
    return out;
  } catch (e) { return { issued: new Set(), applying: new Set() }; }
}
function platformStateOf(orderNo, sets) {
  const no = String(orderNo);
  if (sets.issued.has(no)) return 'issued';
  if (sets.applying.has(no)) return 'applying';
  return 'none';
}
function resolvePlatformState(userId, orderNo) {
  return platformStateOf(orderNo, invoiceStatusSets(userId));
}

async function setOrderState(userId, { orderNo, loginId, action }) {
  const note = '人工确认已开票（商家线下开票）';
  const chunk = async (ids, fn) => {
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const r = await fn(part);
      n += r.affectedRows || 0;
    }
    return n;
  };

  if (action === 'confirm-all' || action === 'cancel-all') {
    if (!loginId) throw new Error('缺少 loginId');
    const rows = await db.query(
      `SELECT order_no, invoice_state, state_source FROM invoice_order
       WHERE user_id = ? AND COALESCE(NULLIF(seller_login,''), seller_company) = ?`, [userId, loginId]);
    if (!rows.length) throw new Error('卖家不存在: ' + loginId);

    if (action === 'confirm-all') {
      const targets = rows.filter((r) => r.invoice_state !== 'issued').map((r) => r.order_no);
      const affected = await chunk(targets, (part) => db.exec(
        `UPDATE invoice_order SET invoice_state='issued', state_source='manual', state_note=?, state_updated_at=NOW()
         WHERE user_id = ? AND order_no IN (${part.map(() => '?').join(',')})`, [note, userId, ...part]));
      return { ok: true, action, affected };
    }

    const sets = invoiceStatusSets(userId);
    const byState = { issued: [], applying: [], none: [] };
    for (const r of rows) {
      if (r.state_source === 'manual') byState[platformStateOf(r.order_no, sets)].push(r.order_no);
    }
    let affected = 0;
    for (const [state, ids] of Object.entries(byState)) {
      affected += await chunk(ids, (part) => db.exec(
        `UPDATE invoice_order SET invoice_state=?, state_source='platform', state_note=NULL, state_updated_at=NOW()
         WHERE user_id = ? AND order_no IN (${part.map(() => '?').join(',')})`, [state, userId, ...part]));
    }
    return { ok: true, action, affected };
  }

  if (!orderNo) throw new Error('缺少 orderNo');
  const exists = await db.query('SELECT order_no FROM invoice_order WHERE user_id = ? AND order_no = ?', [userId, orderNo]);
  if (!exists.length) throw new Error('订单不存在: ' + orderNo);
  if (action === 'confirm') {
    await db.exec(
      `UPDATE invoice_order
         SET invoice_state='issued', state_source='manual', state_note=?, state_updated_at=NOW()
       WHERE user_id=? AND order_no=?`,
      [note, userId, orderNo]
    );
    return { ok: true, orderNo, invoice_state: 'issued', state_source: 'manual', affected: 1 };
  }
  if (action === 'cancel') {
    const st = resolvePlatformState(userId, orderNo);
    await db.exec(
      `UPDATE invoice_order
         SET invoice_state=?, state_source='platform', state_note=NULL, state_updated_at=NOW()
       WHERE user_id=? AND order_no=?`,
      [st, userId, orderNo]
    );
    return { ok: true, orderNo, invoice_state: st, state_source: 'platform', affected: 1 };
  }
  throw new Error('未知操作: ' + action);
}

// ─────────────────────────────────────────────────────────────────────────
// 用户管理（仅超级管理员）
// ─────────────────────────────────────────────────────────────────────────
async function listUsers() {
  const users = await db.query(`
    SELECT u.id, u.username, u.role, u.status, u.company_name, u.tax_no, u.email, u.display_name, u.note,
           u.must_change_password, u.last_login_at, u.created_at, u.updated_at,
           (SELECT COUNT(*) FROM invoice_order o WHERE o.user_id = u.id)              AS order_count,
           (SELECT COUNT(DISTINCT o.seller_company) FROM invoice_order o WHERE o.user_id = u.id) AS company_count,
           (SELECT COUNT(*) FROM issued_invoice i WHERE i.user_id = u.id)             AS invoice_rows,
           (SELECT COUNT(*) FROM seller_name_mapping m WHERE m.user_id = u.id)        AS mapping_count,
           (SELECT COUNT(*) FROM send_log s WHERE s.user_id = u.id AND s.result='ok') AS send_ok_count
    FROM app_user u ORDER BY u.role = 'admin' DESC, u.id ASC
  `);
  return users.map((u) => ({
    id: u.id, username: u.username, role: u.role, status: u.status,
    companyName: u.company_name || '', taxNo: u.tax_no || '', email: u.email || '',
    displayName: u.display_name || '', note: u.note || '',
    mustChangePassword: !!u.must_change_password,
    lastLoginAt: u.last_login_at, createdAt: u.created_at, updatedAt: u.updated_at,
    orderCount: Number(u.order_count) || 0,
    companyCount: Number(u.company_count) || 0,
    invoiceRows: Number(u.invoice_rows) || 0,
    mappingCount: Number(u.mapping_count) || 0,
    sendOkCount: Number(u.send_ok_count) || 0,
  }));
}

/** 校验用户名：4~64 位，字母/数字/下划线/中划线/点 */
function validUsername(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{4,64}$/.test(name);
}

async function createUser({ username, password, companyName, taxNo, email, role, displayName, note }, byUser) {
  if (!validUsername(username)) throw new Error('账号需 4~64 位，仅限字母、数字、下划线、点、中划线');
  if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
  const dup = await db.query('SELECT id FROM app_user WHERE username = ?', [username]);
  if (dup.length) throw new Error('账号已存在: ' + username);
  const r = await db.exec(
    `INSERT INTO app_user (username, password_hash, role, status, company_name, tax_no, email, display_name, note, created_by)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [username, auth.hashPassword(password), role === 'admin' ? 'admin' : 'user',
      companyName || null, taxNo || null, email || null, displayName || null, note || null, byUser.id]
  );
  tenancy.ensureUserDirs(r.insertId);
  return { ok: true, id: r.insertId };
}

async function updateUser({ id, companyName, taxNo, email, role, displayName, note }) {
  const rows = await db.query('SELECT * FROM app_user WHERE id = ?', [id]);
  if (!rows.length) throw new Error('用户不存在');
  const u = rows[0];
  if (u.username === 'admin' && role === 'user') throw new Error('内置超级管理员 admin 不能降级为普通用户');
  await db.exec(
    `UPDATE app_user SET company_name = ?, tax_no = ?, email = ?, display_name = ?, note = ?, role = ? WHERE id = ?`,
    [companyName || null, taxNo || null, email || null, displayName || null, note || null,
      role === 'admin' ? 'admin' : (u.role === 'admin' ? 'admin' : 'user'), id]
  );
  return { ok: true };
}

async function resetUserPassword({ id, password }) {
  if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
  const rows = await db.query('SELECT id, username FROM app_user WHERE id = ?', [id]);
  if (!rows.length) throw new Error('用户不存在');
  await db.exec(
    'UPDATE app_user SET password_hash = ?, token_version = token_version + 1, must_change_password = 0 WHERE id = ?',
    [auth.hashPassword(password), id]
  );
  return { ok: true, username: rows[0].username };
}

async function setUserStatus({ id, status }, byUser) {
  if (!['active', 'disabled'].includes(status)) throw new Error('状态非法');
  const rows = await db.query('SELECT id, username, role FROM app_user WHERE id = ?', [id]);
  if (!rows.length) throw new Error('用户不存在');
  if (rows[0].username === 'admin') throw new Error('内置超级管理员 admin 不能被禁用');
  if (Number(id) === Number(byUser.id)) throw new Error('不能禁用自己的账号');
  await db.exec(
    'UPDATE app_user SET status = ?, token_version = token_version + 1 WHERE id = ?',
    [status, id]
  );
  return { ok: true, status };
}

async function deleteUser({ id, username, purge }, byUser) {
  const rows = await db.query('SELECT id, username, role FROM app_user WHERE id = ?', [id]);
  if (!rows.length) throw new Error('用户不存在');
  const u = rows[0];
  if (u.username === 'admin') throw new Error('内置超级管理员 admin 不能被删除');
  if (Number(id) === Number(byUser.id)) throw new Error('不能删除自己的账号');
  if (purge) {
    if (String(username) !== u.username) throw new Error('请输入要删除的用户名以确认清除其数据');
  }
  // 禁用 + 失效会话，避免残留登录态
  await db.exec('UPDATE app_user SET status = "disabled", token_version = token_version + 1 WHERE id = ?', [id]);
  let purged = 0;
  if (purge) {
    for (const t of ['invoice_order', 'issued_invoice', 'seller_name_mapping', 'send_log', 'import_log']) {
      const r = await db.exec(`DELETE FROM \`${t}\` WHERE user_id = ?`, [id]);
      purged += r.affectedRows || 0;
    }
    try { fs.rmSync(tenancy.dataDirFor(id), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  await db.exec('DELETE FROM app_user WHERE id = ?', [id]);
  return { ok: true, purged };
}

// ─────────────────────────────────────────────────────────────────────────
// 1688 登录态（入库）：状态查询 + 扩展上传的一次性令牌
//   服务器不再承载登录画面（无投屏登录）：登录在用户本机浏览器完成，
//   扩展凭一次性上传码把 storageState 交给服务器，加密后写入 login_state。
// ─────────────────────────────────────────────────────────────────────────
const UPLOAD_TTL_MS = 10 * 60 * 1000; // 上传码有效期 10 分钟
const UPLOAD_TOKEN_MAX = 5;           // 每个用户同时最多保留几个未用上传码
const uploadTokens = new Map();       // token -> { uid, expireAt }

function sweepUploadTokens() {
  const now = Date.now();
  for (const [k, v] of uploadTokens) if (v.expireAt <= now) uploadTokens.delete(k);
}

/** 为某用户生成一次性上传码（同用户旧码全部作废，避免堆积） */
function createUploadToken(uid) {
  const id = Number(uid);
  sweepUploadTokens();
  const mine = [...uploadTokens.entries()].filter(([, v]) => v.uid === id);
  for (const [k] of mine) uploadTokens.delete(k);
  const token = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expireAt = Date.now() + UPLOAD_TTL_MS;
  uploadTokens.set(token, { uid: id, expireAt });
  return { code: token, ttlSec: Math.round(UPLOAD_TTL_MS / 1000), expiresAt: new Date(expireAt).toISOString() };
}

/** 校验上传码 → 返回 uid 或 null（校验成功即作废，一次性） */
function redeemUploadToken(token) {
  sweepUploadTokens();
  const key = String(token || '').trim();
  if (!key) return null;
  const hit = uploadTokens.get(key);
  if (!hit) return null;
  uploadTokens.delete(key);
  return hit.uid;
}

/** 该用户的登录态状态（读库，不含密文） */
async function stateStatus(userId) {
  const meta = await stateStore.getMeta(userId);
  return {
    hasState: meta.hasState,
    usable: !!(meta.hasState && meta.status === 'active'),
    status: meta.status,
    source: meta.source,
    savedAt: meta.savedAt,
    lastUsedAt: meta.lastUsedAt,
    cookieCount: meta.cookieCount,
    originCount: meta.originCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP 服务器
// ─────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  try {
    // ── 静态页 / 页面路由 ──
    if (method === 'GET' && (p === '/login' || p === '/login.html')) return sendHtml(res, 'login.html');
    if (method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      const u = await currentUser(req);
      if (!u) return redirect(res, '/login');
      return sendHtml(res, 'dashboard.html');
    }

    // ── 认证 ──
    if (method === 'POST' && p === '/api/auth/login') {
      const { username, password } = await readBody(req);
      if (!username || !password) return sendJson(res, 400, { error: '请输入账号与密码' });
      const rows = await db.query('SELECT * FROM app_user WHERE username = ?', [String(username).trim()]);
      const u = rows[0];
      // 统一错误提示，避免暴露账号是否存在
      if (!u || !auth.verifyPassword(password, u.password_hash)) {
        return sendJson(res, 401, { error: '账号或密码错误' });
      }
      if (u.status !== 'active') return sendJson(res, 403, { error: '账号已被禁用，请联系管理员' });
      auth.setSessionCookie(res, auth.createSessionToken(u), req);
      await db.exec('UPDATE app_user SET last_login_at = NOW() WHERE id = ?', [u.id]);
      return sendJson(res, 200, { user: publicUser(u) });
    }

    if (method === 'POST' && p === '/api/auth/logout') {
      auth.clearSessionCookie(res, req);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && p === '/api/auth/me') {
      const u = await currentUser(req);
      if (!u) return sendJson(res, 401, { error: '未登录' });
      const st = await stateStatus(u.id);
      return sendJson(res, 200, {
        user: publicUser(u),
        needLogin1688: !st.usable,
        login1688: st,
      });
    }

    if (method === 'POST' && p === '/api/auth/password') {
      const u = await currentUser(req);
      if (!u) return sendJson(res, 401, { error: '未登录' });
      const { oldPassword, newPassword } = await readBody(req);
      if (!auth.verifyPassword(oldPassword, u.password_hash)) return sendJson(res, 400, { error: '原密码不正确' });
      if (!newPassword || String(newPassword).length < 4) return sendJson(res, 400, { error: '新密码至少 4 位' });
      await db.exec(
        'UPDATE app_user SET password_hash = ?, token_version = token_version + 1, must_change_password = 0 WHERE id = ?',
        [auth.hashPassword(newPassword), u.id]
      );
      const fresh = (await db.query('SELECT * FROM app_user WHERE id = ?', [u.id]))[0];
      auth.setSessionCookie(res, auth.createSessionToken(fresh), req);
      return sendJson(res, 200, { ok: true });
    }

    // ── 扩展上传登录态（公开：凭一次性上传码鉴权，不需要看板会话 Cookie）──
    // 注意：必须放在「以下接口都需要登录」之前——扩展侧没有登录 Cookie，只有上传码。
    if (method === 'OPTIONS' && p === '/api/state/upload') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    if (method === 'POST' && p === '/api/state/upload') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = await readBody(req);
      const state = body.state || ((body.cookies || body.origins) ? body : null);
      // 先做形状校验：空登录态直接拒绝，不消耗上传码（避免用户白跑一趟、白生成一次码）
      const sum = stateStore.summarize(state);
      if (!sum.cookieCount && !sum.originCount) {
        return sendJson(res, 400, { error: '登录态为空（没有 cookie 也没有 localStorage），拒绝保存' });
      }
      const uid = redeemUploadToken(body.token || body.code);
      if (!uid) return sendJson(res, 401, { error: '上传码无效或已过期，请在看板重新生成' });
      try {
        const r = await stateStore.saveState(uid, state, { source: 'extension' });
        console.log(`[state] 用户 #${uid} 上传了 1688 登录态（${r.cookieCount} cookie / ${r.originCount} 源）`);
        return sendJson(res, 200, Object.assign({ ok: true }, r));
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ── 以下接口都需要登录 ──
    const user = await currentUser(req);
    if (!user) return sendJson(res, 401, { error: '登录已失效，请重新登录' });
    const tenantId = tenantOf(req, url, user);
    const isAdmin = user.role === 'admin';
    const writeGuard = () => assertWritable(user, tenantId);

    // 看板数据
    if (method === 'GET' && p === '/api/data') {
      const companies = await loadCompanies(tenantId);
      const sendStats = await loadSendStats(tenantId);
      const sentList = sendStats.filter((r) => Number(r.sendCount) > 0).map((r) => r.login);
      const invSummary = await db.query(`
        SELECT COUNT(*) AS rows_count,
               COUNT(DISTINCT COALESCE(NULLIF(e_invoice_no,''), NULLIF(invoice_no,''), row_hash)) AS invoice_count,
               ROUND(SUM(COALESCE(total_amount,0)),2) AS amount,
               SUM(seller_company IS NULL) AS unmapped_rows
        FROM issued_invoice WHERE user_id = ?
      `, [tenantId]);
      const unmatched = await db.query('SELECT COUNT(*) AS n FROM v_unmatched_seller_name WHERE user_id = ?', [tenantId]);
      const ignoredCnt = await db.query('SELECT COUNT(*) AS n FROM seller_name_mapping WHERE user_id = ? AND is_ignored = 1', [tenantId]);
      const manual = await db.query("SELECT COUNT(*) AS n FROM invoice_order WHERE user_id = ? AND state_source = 'manual'", [tenantId]);
      const tenant = (await db.query('SELECT id, username, company_name FROM app_user WHERE id = ?', [tenantId]))[0] || null;
      return sendJson(res, 200, {
        companies,
        sentList,
        sendStats,
        invoiceSummary: invSummary[0] || null,
        unmatchedNameCount: unmatched[0] ? unmatched[0].n : 0,
        ignoredNameCount: ignoredCnt[0] ? ignoredCnt[0].n : 0,
        manualIssuedCount: manual[0] ? manual[0].n : 0,
        tenant: tenant ? { id: tenant.id, username: tenant.username, companyName: tenant.company_name || '' } : null,
        viewer: { id: user.id, role: user.role },
        isOtherTenant: Number(tenantId) !== Number(user.id),
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
    }

    if (method === 'GET' && p === '/api/seller-detail') {
      const loginId = url.searchParams.get('loginId');
      if (!loginId) return sendJson(res, 400, { error: '缺少 loginId' });
      return sendJson(res, 200, await loadSellerDetail(tenantId, loginId));
    }

    if (method === 'GET' && p === '/api/collect-history') {
      const loginId = url.searchParams.get('loginId');
      const company = url.searchParams.get('company');
      if (!loginId && !company) return sendJson(res, 400, { error: '缺少 loginId 或 company' });
      return sendJson(res, 200, await loadCollectHistory(tenantId, { loginId, company }));
    }

    // 配置：本人抬头 + 全局运行参数与话术（话术/参数仅管理员可改）
    if (method === 'GET' && p === '/api/config') {
      const config = loadConfig();
      const { DEFAULT_MESSAGES } = require('./lib/sender');
      const safe = { runtime: config.runtime || {}, messages: config.messages || {} };
      return sendJson(res, 200, {
        config: { ...safe, buyerInfo: await buyerInfoOf(user.id) },
        defaultMessages: DEFAULT_MESSAGES,
        canEdit: isAdmin,
      });
    }
    if (method === 'POST' && p === '/api/config') {
      if (!isAdmin) return sendJson(res, 403, { error: '仅超级管理员可修改系统配置' });
      const { config } = await readBody(req);
      if (!config || typeof config !== 'object') throw new Error('缺少 config');
      const filePath = path.join(ROOT, 'config.json');
      const old = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const merged = { ...old };
      merged.runtime = { ...(old.runtime || {}), ...(config.runtime || {}) };
      merged.messages = { ...(old.messages || {}), ...(config.messages || {}) };
      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
      if (config.buyerInfo) {
        await db.exec('UPDATE app_user SET company_name = ?, tax_no = ?, email = ? WHERE id = ?',
          [config.buyerInfo.companyName || null, config.buyerInfo.taxNo || null, config.buyerInfo.email || null, user.id]);
      }
      return sendJson(res, 200, { ok: true });
    }

    // 导入（按用户的数据目录）
    if (method === 'POST' && p === '/api/import') {
      writeGuard();
      const body = await readBody(req);
      const opts = { userId: tenantId };
      if (body.orders) opts.orders = true;
      if (body.invoices) opts.invoices = true;
      const taskState = taskFor(tenantId);
      taskLog(taskState, '▶ 收到「重新导入数据」请求');
      const r = await runImport(opts);
      for (const s of r.steps) taskLog(taskState, '  ' + s);
      return sendJson(res, 200, r);
    }

    if (method === 'GET' && p === '/api/import-log') {
      const rows = await db.query('SELECT * FROM import_log WHERE user_id = ? ORDER BY id DESC LIMIT 30', [tenantId]);
      return sendJson(res, 200, { logs: rows });
    }

    // 名称映射
    if (method === 'GET' && p === '/api/mapping') return sendJson(res, 200, await loadMapping(tenantId));
    if (method === 'POST' && p === '/api/mapping') { writeGuard(); return sendJson(res, 200, await saveMapping(tenantId, await readBody(req))); }
    if (method === 'POST' && p === '/api/mapping/delete') { writeGuard(); return sendJson(res, 200, await deleteMapping(tenantId, await readBody(req))); }
    if (method === 'POST' && p === '/api/mapping/ignore') { writeGuard(); return sendJson(res, 200, await ignoreMapping(tenantId, await readBody(req))); }

    // 订单级开票状态
    if (method === 'POST' && p === '/api/order-state') { writeGuard(); return sendJson(res, 200, await setOrderState(tenantId, await readBody(req))); }

    // 任务进度 / 停止
    if (method === 'GET' && p === '/api/task') return sendJson(res, 200, taskFor(tenantId));
    if (method === 'POST' && p === '/api/task/stop') {
      writeGuard();
      const t = taskFor(tenantId);
      if (t.running) {
        t.stopRequested = true;
        taskLog(t, '⏸ 收到停止请求：当前卖家发完即停（若正在等待间隔，则立即停止）');
        if (t.channel === 'client') {
          for (const ctx of CLIENT_TASKS.values()) {
            if (ctx.userId === Number(tenantId) && !ctx.finished) {
              ctx.stopRequested = true;
              agentHub.send(tenantId, { type: 'stop', taskId: ctx.taskId });
            }
          }
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    // ── 本机浏览器通道（方案C）：始终作用于「当前登录者本人」的本机浏览器 ──
    if (method === 'GET' && p === '/api/agent/status') {
      return sendJson(res, 200, { ...agentHub.status(user.id), userId: user.id });
    }
    if (method === 'POST' && p === '/api/agent/pair-code') {
      if (Number(tenantId) !== Number(user.id)) throw Object.assign(new Error('查看他人数据为只读模式，无法操作本机通道'), { code: 403 });
      const info = agentHub.createPairCode(user.id);
      const host = req.headers.host || ('localhost:' + (process.env.PORT || 8787));
      const proto = String((req.headers['x-forwarded-proto'] || 'http')).split(',')[0].trim();
      return sendJson(res, 200, { ...info, serverUrl: `${proto}://${host}` });
    }
    if (method === 'POST' && p === '/api/agent/disconnect') {
      writeGuard();
      const closed = agentHub.disconnect(user.id, '用户主动断开');
      const revoked = agentHub.revokePairs(user.id);
      return sendJson(res, 200, { ok: true, closed, revoked });
    }
    if (method === 'GET' && p === '/api/agent/tasks') {
      const rows = await db.query(
        'SELECT id, status, total, done, ok, fail, error, resume_of, items, started_at, finished_at, created_at ' +
        'FROM agent_task WHERE user_id = ? ORDER BY id DESC LIMIT 20',
        [user.id]
      );
      const tasks = rows.map((r) => {
        const sum = summarizeItems(r.items);
        return {
          id: Number(r.id), status: r.status, total: Number(r.total), done: Number(r.done),
          ok: Number(r.ok), fail: Number(r.fail), pending: sum.pending.length,
          resumeOf: r.resume_of ? Number(r.resume_of) : null,
          error: r.error || null,
          startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at,
        };
      });
      return sendJson(res, 200, { tasks });
    }

    // 断线续跑：查询最近一次「还有未完成项」的任务（服务重启遗留的 running 任务会先对账纠正）
    if (method === 'GET' && p === '/api/agent/resumable') {
      return sendJson(res, 200, await resumableTask(user.id));
    }
    // 断线续跑：只补发未完成项（scope=pending|failed|both），不重发已成功的
    if (method === 'POST' && p === '/api/agent/resume') {
      writeGuard();
      const body = await readBody(req);
      const scope = ['pending', 'failed', 'both'].includes(body && body.scope) ? body.scope : 'pending';
      const t = taskFor(tenantId);
      if (t.running) throw new Error('已有任务在运行中');
      let taskId = Number(body && body.taskId) || null;
      if (!taskId) {
        const r = await resumableTask(user.id);
        if (!r.task) throw new Error('没有可续跑的任务');
        taskId = r.task.id;
      }
      const picked = await resumeLoginIds(user.id, taskId, scope);
      if (!picked.loginIds.length) {
        throw new Error(scope === 'failed' ? '该任务没有失败项需要重试' : '该任务没有未完成的卖家');
      }
      if (!agentHub.isOnline(user.id)) {
        throw new Error('本机浏览器通道未连接：请先在本机浏览器扩展里重新配对连接，再点「续跑」');
      }
      doClientSend(tenantId, picked.loginIds, { resumeOf: picked.taskId }).catch((e) => {
        const ts = taskFor(tenantId);
        ts.running = false;
        taskLog(ts, '✗ 续跑异常: ' + e.message);
      });
      return sendJson(res, 200, {
        started: true, channel: 'client', scope,
        resumeOf: picked.taskId, count: picked.loginIds.length,
      });
    }

    // 发送催收消息（channel 缺省=server，即服务器浏览器；client=本机浏览器通道）
    if (method === 'POST' && p === '/api/send') {
      writeGuard();
      const body = await readBody(req);
      const { loginIds } = body || {};
      const channel = body && body.channel === 'client' ? 'client' : 'server';
      if (!Array.isArray(loginIds) || loginIds.length === 0) throw new Error('缺少 loginIds');
      const t = taskFor(tenantId);
      if (t.running) throw new Error('已有任务在运行中');
      if (channel === 'client') {
        doClientSend(tenantId, loginIds).catch((e) => {
          const ts = taskFor(tenantId);
          ts.running = false;
          taskLog(ts, '✗ 任务异常: ' + e.message);
        });
      } else {
        doSend(tenantId, loginIds).catch((e) => { t.running = false; taskLog(t, '✗ 任务异常: ' + e.message); });
      }
      return sendJson(res, 200, { started: true, channel });
    }

    // ── 1688 登录态（入库）：状态查询 / 生成上传码 / 清除（需登录，按 tenant 隔离）──
    // 说明：扩展上传接口 /api/state/upload 在登录闸门之前（凭上传码鉴权），见上方。
    if (method === 'GET' && p === '/api/state/status') {
      return sendJson(res, 200, await stateStatus(tenantId));
    }
    if (method === 'POST' && p === '/api/state/upload-token') {
      writeGuard();
      const t = createUploadToken(tenantId);
      // 反代后面用 x-forwarded-proto，直连则看连接是否 TLS
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
        || ((req.socket && req.socket.encrypted) ? 'https' : 'http');
      const serverUrl = proto + '://' + (req.headers.host || ('localhost:' + PORT));
      return sendJson(res, 200, Object.assign({ ok: true, serverUrl }, t));
    }
    if (method === 'POST' && p === '/api/state/clear') {
      writeGuard();
      await stateStore.clearState(tenantId);
      return sendJson(res, 200, { ok: true });
    }

    // ── 系统管理（仅超级管理员） ──
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin) return sendJson(res, 403, { error: '仅超级管理员可访问' });

      if (method === 'GET' && p === '/api/admin/users') {
        return sendJson(res, 200, { users: await listUsers(), self: publicUser(user) });
      }
      if (method === 'POST' && p === '/api/admin/users/create') {
        return sendJson(res, 200, await createUser(await readBody(req), user));
      }
      if (method === 'POST' && p === '/api/admin/users/update') {
        return sendJson(res, 200, await updateUser(await readBody(req)));
      }
      if (method === 'POST' && p === '/api/admin/users/password') {
        return sendJson(res, 200, await resetUserPassword(await readBody(req)));
      }
      if (method === 'POST' && p === '/api/admin/users/status') {
        return sendJson(res, 200, await setUserStatus(await readBody(req), user));
      }
      if (method === 'POST' && p === '/api/admin/users/delete') {
        return sendJson(res, 200, await deleteUser(await readBody(req), user));
      }
      // 按用户名/ID 查用户概况（配合 ?tenant= 查看其看板）
      if (method === 'GET' && p === '/api/admin/user-lookup') {
        const kw = (url.searchParams.get('username') || '').trim();
        if (!kw) return sendJson(res, 400, { error: '缺少 username' });
        const rows = await db.query(
          `SELECT id, username, role, status, company_name, tax_no, email FROM app_user
           WHERE username = ? OR username LIKE ? ORDER BY username LIMIT 20`,
          [kw, `%${kw}%`]
        );
        return sendJson(res, 200, {
          users: rows.map((u) => ({
            id: u.id, username: u.username, role: u.role, status: u.status,
            companyName: u.company_name || '', taxNo: u.tax_no || '', email: u.email || '',
          })),
        });
      }
      return sendJson(res, 404, { error: '未知管理接口' });
    }

    // 已移除: POST /api/apply
    if (p === '/api/apply') {
      return sendJson(res, 410, { error: '提交开票申请功能已移除' });
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    const code = e.code === 403 ? 403 : 500;
    console.error('[接口异常]', req.method, p, e.message);
    if (!res.headersSent) sendJson(res, code, { error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// WebSocket：把服务器端浏览器的实时画面推给看板，并回灌鼠标/键盘
// ─────────────────────────────────────────────────────────────────────────
const wsAgent = new WebSocketServer({ noServer: true });

// 本机浏览器通道：扩展用配对码鉴权（扩展侧没有看板登录 Cookie）
wsAgent.on('connection', (ws) => {
  const uid = ws._agentUid;
  let bound = false;
  const bind = (hello) => {
    if (bound) return;
    bound = true;
    agentHub.attach(uid, ws, {
      loggedIn: !!(hello && hello.loggedIn),
      ua: (hello && hello.ua) || '',
      extVer: (hello && hello.extVer) || '',
      platform: (hello && hello.platform) || '',
    });
    try { ws.send(JSON.stringify({ type: 'ready', uid, serverTime: Date.now() })); } catch (e) { /* 忽略 */ }
    console.log(`[agent] uid=${uid} 已配对本机浏览器${hello && hello.extVer ? ' (扩展 v' + hello.extVer + ')' : ''}`);
  };
  const helloTimer = setTimeout(() => { if (!bound) { try { ws.close(4003, 'hello timeout'); } catch (e) { /* 忽略 */ } } }, 15000);
  ws.on('message', (raw) => {
    const text = raw.toString();
    if (!bound) {
      let msg = null;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg && msg.type === 'hello') bind(msg);
      return;
    }
    agentHub.handle(uid, text);
  });
  ws.on('close', () => { clearTimeout(helloTimer); if (bound) agentHub.detach(uid, ws); });
  ws.on('error', () => { /* 忽略 */ });
});

server.on('upgrade', async (req, socket, head) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch (e) { socket.destroy(); return; }

  if (url.pathname === '/ws/agent') {
    const uid = agentHub.redeem(url.searchParams.get('code'));
    if (!uid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wsAgent.handleUpgrade(req, socket, head, (ws) => {
      ws._agentUid = uid;
      wsAgent.emit('connection', ws, req);
    });
    return;
  }

  // 已无 /ws/browser（投屏登录已移除）：其它 WS 路径一律拒绝
  socket.destroy();
});

// ─────────────────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`发票催收控制台已启动: http://localhost:${PORT}`);
  console.log(`  登录页: http://localhost:${PORT}/login   （超级管理员 admin / admin，首次登录请改密）`);
  try {
    await db.ensureSchema();
    const admin = (await db.query("SELECT id FROM app_user WHERE username = 'admin'"))[0];
    if (admin) {
      const notes = tenancy.migrateLegacyData(admin.id);
      for (const n of notes) console.log('  [迁移] ' + n);
    }
    // 登录态加密密钥自检（未用环境变量时给出告警，不阻断启动）
    for (const n of stateStore.startupNotices()) console.log('  [提示] ' + n);
    // 历史登录态文件 → 数据库（幂等：库里已有则跳过，原文件保留）
    const snotes = await stateStore.migrateFromFiles();
    for (const n of snotes) console.log('  [迁移] ' + n);
    const v = await db.ping();
    console.log(`✓ 数据库连接正常 (MySQL ${v})`);
    const [{ n: userCount }] = await db.query('SELECT COUNT(*) AS n FROM app_user');
    console.log(`  账号 ${userCount} 个`);
  } catch (e) {
    console.error('✗ 数据库初始化失败:', e.message);
    console.error('  请先启动数据库并确认 config.json 的 mysql 段（或设置 MYSQL_* 环境变量）');
  }
  console.log('Ctrl+C 停止服务器');
});
