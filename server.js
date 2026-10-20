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
 * ── 1688 登录态与发送（只在用户本机执行） ─────────────────────────────────
 *   服务器不保存任何 1688 登录态、不启动服务端浏览器：登录与发送都发生在
 *   **用户自己电脑上的「1688 催收助手」桌面程序**（Electron 自带浏览器窗口）里。
 *   绑定：看板点「绑定本机助手」→ 服务端签发一次性绑定令牌 → 深链 xsh://bind?... 唤起助手
 *         → 助手用令牌换取**长期设备令牌**（本地保存）→ 连 /ws/agent?device=<token>。
 *   发送：点「发送催收消息」后，服务器只编排任务并通过 WS 下发；
 *         助手在自带浏览器里打开 1688 聊天页逐家发送，回执经 WS 回来落库。
 *   断线可续跑（只补发未完成项，已成功的绝不重发）。
 *   ⚠ 凭据演进（2026-10-14）：**设备令牌取代「税号当配对码」**——税号是半公开信息，
 *     不可作凭据。旧浏览器扩展/书签通道已下线（/api/agent/extension-download 等返回 410）。
 *
 * ── 接口 ──────────────────────────────────────────────────────────────────
 *   认证:   POST /api/auth/login | POST /api/auth/logout | GET /api/auth/me | POST /api/auth/password
 *   看板:   GET  /api/data | GET /api/seller-detail | GET /api/collect-history
 *   发送:   POST /api/send（只走本机助手通道） | GET /api/task | POST /api/task/stop
 *   数据:   POST /api/import | GET /api/import-log
 *   映射:   GET  /api/mapping | POST /api/mapping | POST /api/mapping/delete | POST /api/mapping/ignore
 *           POST /api/order-state
 *   配置:   GET  /api/config | POST /api/config（仅管理员）
 *   本机通道: GET  /api/agent/status      | POST /api/agent/pair-code（签发一次性绑定令牌）
 *             POST /api/agent/bind        | POST /api/agent/disconnect
 *             GET  /api/agent/devices     | POST /api/agent/devices/revoke（设备管理/踢下线）
 *             GET  /api/agent/tasks | GET /api/agent/resumable | POST /api/agent/resume | WS /ws/agent
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
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./lib/auth');
const tenancy = require('./lib/tenancy');
const { runImport, importOrderUpload, importInvoiceUpload } = require('./import-to-db');
const { loadConfig } = require('./lib/browser');
const { AgentHub } = require('./lib/agent-hub');
const { buildMessages } = require('./lib/sender');
const qnh = require('./lib/qnh');

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
// 前端本地依赖（Vue2 / Element UI / ECharts）—— 白名单式静态服务，杜绝路径穿越
const VENDOR_DIR = path.join(ROOT, 'vendor');
const VENDOR_MIME = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json' };
function sendVendor(res, rel) {
  const target = path.normalize(path.join(VENDOR_DIR, rel));
  if (!target.startsWith(VENDOR_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  const ext = path.extname(target).toLowerCase();
  if (!VENDOR_MIME[ext]) { res.writeHead(403); return res.end('forbidden'); }
  let buf;
  try { buf = fs.readFileSync(target); } catch (e) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': VENDOR_MIME[ext], 'cache-control': 'public, max-age=86400' });
  res.end(buf);
}
function redirect(res, to) {
  res.writeHead(302, { location: to });
  res.end();
}
/** 校验并归一化 YYYY-MM-DD 日期参数（非法/缺省返回 null，避免拼进 SQL 的意外值） */
function normalizeDay(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(s + 'T00:00:00');
  if (Number.isNaN(t.getTime())) return null;
  return s;
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > 2e6) { tooBig = true; req.destroy(); } });
    req.on('end', () => { if (tooBig) return resolve({}); try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
  });
}
/** 原始字节 body（二进制上传用，如订单 Excel 回传） */
function readRawBody(req, cap) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0; let tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > cap) { tooBig = true; req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}
// ── 本机助手安装包（electron-builder 产物，输出目录 dist/）──
//    · nsis 生成的「安装版」优先（*-setup.exe / *Setup*.exe），其次 portable（*portable*.exe）
//    · 找不到则返回 null，下载页据此提示「尚未构建/请联系管理员」
function findAgentInstaller() {
  const dir = path.join(ROOT, 'dist');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const exes = names.filter((n) => /\.exe$/i.test(n)).sort((a, b) => {
    const score = (n) => (/setup|install/i.test(n) ? 0 : (/portable/i.test(n) ? 1 : 2));
    return score(a) - score(b) || a.localeCompare(b);
  });
  if (!exes.length) return null;
  const file = exes[0];
  let size = 0;
  try { size = fs.statSync(path.join(dir, file)).size; } catch (e) { size = 0; }
  return { file, size };
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
    // 退单列表页权限（超级管理员始终可见，普通用户由管理员逐个开启）
    qnhRefundEnabled: u.role === 'admin' ? true : !!Number(u.qnh_refund_enabled),
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

/** 书签工具：按卖家登录名组装该卖家的催收消息（复用看板同款逻辑，零安装方案使用） */
async function bmComputeTask(userId, rawLogin) {
  const data = await loadSellers(userId);
  const key = rawLogin.replace(/^cnalichn/i, '');
  const s = data.find(
    (x) => x.sellerLogin === key || x.loginId === key || x.sellerLogin === rawLogin || x.loginId === rawLogin
  );
  if (!s || !s.sellerLogin) return { none: true, reason: '未找到该卖家的待催收数据（可能未维护会员名映射）' };
  const detail = await loadSellerDetail(userId, s.loginId);
  const toRemind = detail.orders.filter((o) => o.invoice_state !== 'issued');
  if (!toRemind.length) return { none: true, reason: '该卖家订单均已开票' };
  const buyer = await buyerInfoOf(userId);
  const config = loadConfig();
  const runConfig = { ...config, buyerInfo: buyer };
  const msgSeller = {
    loginId: s.sellerLogin,
    amount: Number(s.pendingAmount) || 0,
    orders: toRemind.map((o) => ({ orderId: o.order_no, amount: Number(o.pay_amount).toFixed(2) })),
  };
  const messages = buildMessages(msgSeller, runConfig);
  return {
    none: false,
    messages,
    company: s.company || '',
    sellerLogin: s.sellerLogin,
    amount: Number(s.pendingAmount) || 0,
    orderNos: msgSeller.orders.map((o) => o.orderId).join('；'),
  };
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
// 本机通道：连接中枢 + 设备令牌（2026-10-14 起替代「税号当配对码」）
//   发送动作在用户本机（桌面助手/浏览器）完成；服务器只负责下发任务、记录结果、展示进度。
// ─────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const BIND_TTL_MS = 120 * 1000;      // 一次性绑定令牌有效期（看板点「绑定本机助手」后 2 分钟内有效）
const bindTokens = new Map();        // bindToken -> { userId, expiresAt, used }

function newToken() { return crypto.randomBytes(32).toString('hex'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
}
function serverUrlOf(req) {
  const host = req.headers.host || ('localhost:' + (process.env.PORT || 8787));
  const proto = String((req.headers['x-forwarded-proto'] || 'http')).split(',')[0].trim();
  return `${proto}://${host}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 操作日志（旁路设施：任何写入失败都只打印日志，绝不影响主流程）
//   分两种来源：
//     · 服务端埋点：发送催收 / 导入税务发票 / 导入1688订单 / 绑定本机助手 —— 直接调 logOp
//     · 前端埋点：  按钮点击 / 条件查询 / 点某天金额 / 下载本机助手 —— 走 POST /api/op-log
//   安全：action 走白名单，文案一律由服务端渲染，**不接受客户端自定义的 content**，
//         避免伪造日志内容；列表与查询接口挂在 /api/admin/ 前缀下，天然是 403 守卫。
// ─────────────────────────────────────────────────────────────────────────
const OP_ACTIONS = {
  'btn.click': (d) => `点击了「${d.btn}」`,
  'collect.send': (d) => `对 ${d.count} 家公司发送催收消息：${d.companies}`,
  'import.invoice': (d) => `导入了税务发票数据（文件：${d.file}；新增 ${d.inserted} 行，更新 ${d.updated} 行）`,
  'import.order': (d) => `导入了1688订单数据（文件：${d.file}；新增 ${d.inserted} 单，更新 ${d.updated} 单）`,
  'query.filter': (d) => `根据催收状态为「${d.collect}」、开票状态为「${d.invoice}」、搜索内容为「${d.keyword}」查询`,
  'view.day.orders': (d) => `点击了 ${d.date} 的支付订单总金额进行查看`,
  'view.day.invoices': (d) => `点击了 ${d.date} 的每日已开票金额进行查看`,
  'agent.download': () => '下载了本机助手',
  'agent.bind': (d) => `绑定了本机助手${d.deviceName ? '（' + d.deviceName + '）' : ''}`,
  'qnh.sync': (d) => `在退单列表点击了「立即刷新数据」${d.ok ? '（成功）' : '（失败）'}`,
  'qnh.login': (d) => `在退单列表点击了「登录牵牛花」刷新 Cookie${d.ok ? '（成功）' : '（失败）'}`,
  'qnh.config': (d) => `修改了退单同步设置（${d.items}）`,
  'qnh.permit': (d) => `${d.enabled ? '开启' : '关闭'}了账号「${d.username}」的退单列表权限`,
  'qnh.view': () => '打开了退单列表页',
};

// 前端下拉是「值」，日志里要显示人能看懂的「文案」，在服务端做映射，避免客户端乱传
const OP_COLLECT_LABELS = { '': '不限', collected: '已催收', '7': '最近一周未催收', '15': '最近半个月未催收', '30': '最近一个月未催收', '90': '最近三个月未催收' };
const OP_INVOICE_LABELS = { '': '全部', invoiced: '已开票', pending: '未开票' };

/** 收口成单行、去掉换行与首尾空白、超长截断。保留中文引号（下方格式化要用） */
function opText(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 30);
}
/**
 * 清洗「外部传入的片段」（按钮名 / 关键词 / 日期）。
 * 注意：只在这里剥引号，绝不能剥格式化结果里的引号 —— 否则文案会变成
 * 「点击了发送催收消息」这种没有边界的样子，且不便于按内容检索。
 */
function opSafe(v, max) {
  return opText(v, max).replace(/[「」『』<>"'`]+/g, '');
}

/**
 * 写一条操作日志。
 * @param {object|number} user 用户对象（含 id/username）或用户 ID（会回查账号名）
 * @param {string} action 操作类型，必须在 OP_ACTIONS 白名单内
 * @param {object} detail 结构化明细，用于渲染文案
 */
async function logOp(user, action, detail) {
  try {
    const fmt = OP_ACTIONS[action];
    if (!fmt) return;                       // 不在白名单内的 action 直接丢弃
    const d = Object.assign({}, detail || {});
    const content = opText(fmt(d), 500);
    if (!content) return;

    let uid = 0;
    let uname = '';
    if (typeof user === 'number' || typeof user === 'string') {
      uid = Number(user) || 0;
      if (uid) {
        const rows = await db.query('SELECT username FROM app_user WHERE id = ?', [uid]);
        uname = (rows[0] && rows[0].username) || '';
      }
    } else if (user) {
      uid = Number(user.id) || 0;
      uname = user.username || '';
    }

    await db.exec(
      `INSERT INTO operation_log (user_id, username, action, content, detail, ip) VALUES (?, ?, ?, ?, ?, ?)`,
      [uid, uname.slice(0, 64), action, content, JSON.stringify(d).slice(0, 2000), opText(d.ip, 64)]
    );
  } catch (e) {
    console.error('[操作日志] 写入失败（不影响主流程）:', e.message);
  }
}

/** 签发一次性绑定令牌（看板调用；助手用它换长期设备令牌） */
function issueBindToken(userId) {
  const now = Date.now();
  for (const [k, v] of bindTokens) if (v.expiresAt < now) bindTokens.delete(k);
  const t = newToken();
  bindTokens.set(t, { userId: Number(userId), expiresAt: now + BIND_TTL_MS, used: false });
  return t;
}

/** 消费一次性绑定令牌；成功返回 userId，失败返回 null */
function redeemBindToken(token) {
  const rec = bindTokens.get(String(token || '').trim());
  if (!rec || rec.used || rec.expiresAt < Date.now()) return null;
  rec.used = true;
  bindTokens.delete(String(token).trim());
  return rec.userId;
}

/**
 * 用设备令牌解析 userId（并顺带刷新 last_seen）。返回 { deviceId, userId } 或 null。
 * 令牌为 64 位十六进制；DB 只存 sha256，故按哈希查；账号须为 active、设备未被撤销。
 */
async function resolveDeviceToken(token) {
  const t = String(token || '').trim();
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const rows = await db.query(
    'SELECT d.id, d.user_id FROM agent_device d JOIN app_user u ON u.id = d.user_id ' +
    'WHERE d.token_hash = ? AND d.revoked_at IS NULL AND u.status = ?',
    [sha256(t), 'active']
  );
  if (!rows[0]) return null;
  db.exec('UPDATE agent_device SET last_seen_at = NOW() WHERE id = ?', [rows[0].id]).catch(() => {});
  return { deviceId: Number(rows[0].id), userId: Number(rows[0].user_id) };
}

/** 新建一个设备令牌，返回 { id, token }（token 仅此一刻可见） */
async function createDevice(userId, { deviceName, os, agentVer, kind, ip } = {}) {
  const token = newToken();
  const r = await db.exec(
    'INSERT INTO agent_device (user_id, token_hash, device_name, os, agent_ver, kind, last_ip, last_seen_at) ' +
    'VALUES (?,?,?,?,?,?,?,NOW())',
    [
      Number(userId), sha256(token),
      String(deviceName || '').slice(0, 128),
      String(os || '').slice(0, 64),
      String(agentVer || '').slice(0, 32),
      kind === 'bookmarklet' ? 'bookmarklet' : 'agent',
      String(ip || '').slice(0, 64),
    ]
  );
  return { id: Number(r.insertId), token };
}

const agentHub = new AgentHub({
  onMessage: (uid, msg) => handleAgentMessage(uid, msg),
  onStatus: (uid) => maybeAbortClientTask(uid),
  // 凭据解析：只认「设备令牌」（sha256 命中 agent_device 且未撤销、账号 active）。
  // ⚠ 不再接受税号——税号是半公开信息，不可作为凭据（见 sql/schema.sql 的 agent_device 说明）。
  resolveUserByCode: async (credential) => {
    const dev = await resolveDeviceToken(credential);
    return dev ? dev.userId : null;
  },
});

/** 正在等待本机回执的任务：taskId -> ctx */
const CLIENT_TASKS = new Map();

/**
 * 把任务进度推送给本机助手（供助手状态面板的实时发送面板渲染）
 * 推送失败（通道已断）无所谓：助手面板只是旁观，断线时看板仍能看到状态。
 */
function pushClientProgress(uid, ctx) {
  if (!ctx) return;
  const t = ctx.taskState;
  const sellers = ctx.sellers.map((s) => ({
    loginId: s.loginId, company: s.company || '', status: s._result || 'pending',
  }));
  agentHub.send(uid, {
    type: 'task_progress',
    taskId: ctx.taskId,
    total: sellers.length,
    done: t.done, ok: t.ok, fail: t.fail,
    current: t.current || null,
    finished: !!ctx.finished,
    sellers,
  });
}

function handleAgentMessage(uid, msg) {
  if (msg.type === 'login_state') { agentHub.setLoggedIn(uid, msg.loggedIn); return; }
  if (msg.type === 'sent') { onAgentSent(uid, msg); return; }
  if (msg.type === 'log') {
    const t = taskFor(uid);
    if (t.running && t.channel === 'client') {
      taskLog(t, '· ' + String(msg.text || '').slice(0, 200));
      // 助手仍在推进 → 找到对应任务上下文重新计时（防止慢加载被误判超时）
      for (const c of CLIENT_TASKS.values()) {
        if (c.userId === Number(uid) && !c.finished && typeof c.armTimer === 'function') { c.armTimer(); break; }
      }
    }
    return;
  }
  // ── 「导入1688订单」流程：助手回报进度/结果 ──
  if (msg.type === 'export_log') {
    const ctx = EXPORTS.get(String(msg.taskId || ''));
    if (ctx && ctx.userId === Number(uid)) taskLog(ctx.taskState, '· ' + String(msg.text || '').slice(0, 300));
    return;
  }
  if (msg.type === 'export_done') {
    const ctx = EXPORTS.get(String(msg.taskId || ''));
    if (ctx && ctx.userId === Number(uid)) {
      if (msg.ok) taskLog(ctx.taskState, '✓ 助手回报：导出下载完成，文件已回传（导入结果见上方步骤）');
      finishExport(ctx, !!msg.ok, msg.error || null);
    }
    return;
  }
  // 本机弹窗点了「停止」：与看板停止等价——扩展侧停发剩余，服务端记录停止意图
  if (msg.type === 'client_stop') {
    const ctx = CLIENT_TASKS.get(Number(msg.taskId));
    if (ctx && ctx.userId === Number(uid) && !ctx.finished) {
      ctx.taskState.stopRequested = true;
      taskLog(ctx.taskState, '⏸ 收到本机弹窗的停止请求：当前卖家发完即停');
      pushClientProgress(uid, ctx);
    }
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
  // 仅当任务仍在 running 时才增量回写：本语句是 fire-and-forget，可能与 finishClientTask 的
  // 终态写入（status='done'）乱序落库；若终态已写入，本条迟到语句必须失效，否则会用中间值覆盖
  // 最终 done/ok/fail，导致任务行显示错误计数（曾造成续跑回归测试偶发失败）。
  db.exec('UPDATE agent_task SET done=?, ok=?, fail=? WHERE id=? AND status=\'running\'',
    [t.done, t.ok, t.fail, ctx.taskId]).catch(() => {});
  pushClientProgress(uid, ctx);
  ctx.pending--;
  if (ctx.pending <= 0) finishClientTask(ctx, ctx.stopRequested ? 'aborted' : 'done');
  else if (typeof ctx.armTimer === 'function') ctx.armTimer(); // 还有剩余家数 → 重新计时
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
  pushClientProgress(ctx.userId, ctx);
  try { ctx.resolve && ctx.resolve(); } catch (e) { /* 忽略 */ }
}

/** 本机通道掉线时，中断其正在跑的任务 */
function maybeAbortClientTask(uid) {
  if (agentHub.isOnline(uid)) return;
  for (const ctx of CLIENT_TASKS.values()) {
    if (ctx.userId === Number(uid) && !ctx.finished) {
      taskLog(ctx.taskState, '⛔ 本机助手连接已断开，任务中断（重新启动助手并连上后，可点看板「继续发送未完成」续跑）');
      ctx.abortReason = '本机助手通道断开';
      finishClientTask(ctx, 'aborted');
    }
  }
  for (const ctx of EXPORTS.values()) {
    if (ctx.userId === Number(uid) && !ctx.finished) {
      taskLog(ctx.taskState, '⛔ 本机助手连接已断开，订单导出中断');
      finishExport(ctx, false, '本机助手通道断开');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 「导入1688订单数据」：看板发起 → 本机助手在自带浏览器里按条件导出 1688 报表
//   → 文件回传（/api/agent/upload-orders，设备令牌鉴权）→ 复用 runImport 入库
// ─────────────────────────────────────────────────────────────────────────
/** 进行中的订单导出任务：taskId -> ctx */
const EXPORTS = new Map();
// 平台限制两次导出间隔 ≥5 分钟，报表生成+下载通常 1~3 分钟；给足 15 分钟兜底
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

function finishExport(ctx, ok, error) {
  if (ctx.finished) return;
  ctx.finished = true;
  clearTimeout(ctx.timer);
  EXPORTS.delete(ctx.taskId);
  const t = ctx.taskState;
  t.running = false;
  t.current = null;
  t.finishedAt = new Date().toISOString();
  t.done = 1;
  if (ok) t.ok = 1; else { t.fail = 1; t.error = error || null; }
  taskLog(t, ok
    ? `■ 1688 订单导出+导入流程结束`
    : `■ 1688 订单导出失败：${String(error || '未知原因')}`);
  try { ctx.resolve && ctx.resolve(); } catch (e) { /* 忽略 */ }
}

/** 下发一次「导出 1688 订单」任务并等待助手完成（含回传导入）。返回时任务已收尾。 */
async function doExportOrders(userId, { dateStart, dateEnd }) {
  const taskState = taskFor(userId);
  if (taskState.running) throw new Error('已有任务在运行中，请等待完成或点「停止」');
  if (!agentHub.isOnline(userId)) throw new Error('本机助手未连接：请先在本机启动「1688 催收助手」桌面程序并完成绑定');

  Object.assign(taskState, {
    running: true, channel: 'client', type: 'export',
    total: 1, done: 0, ok: 0, fail: 0, current: '1688 订单导出',
    startedAt: new Date().toISOString(), finishedAt: null, logs: [],
  });
  taskLog(taskState, `▶ 通过「本机助手」导出 1688 订单：下单时间 ${dateStart} ~ ${dateEnd}`);
  taskLog(taskState, '· 助手将打开 1688「交易 → 已买到的货品」按条件导出报表，生成后自动下载并回传服务器导入');
  taskLog(taskState, '· 平台限制：两次导出需间隔 5 分钟以上，导出期间请勿在 1688 页面操作订单');

  await new Promise((resolve) => {
    const ctx = {
      taskId: 'E' + Date.now().toString(36) + Math.floor(Math.random() * 1e4),
      userId: Number(userId), taskState, finished: false, resolve, importStarted: false,
      timer: setTimeout(() => {
        taskLog(taskState, '⏱ 导出超时（15 分钟未收到助手回执），已结束');
        finishExport(ctx, false, '等待本机助手回执超时');
      }, EXPORT_TIMEOUT_MS),
    };
    EXPORTS.set(ctx.taskId, ctx);
    const ok = agentHub.send(userId, { type: 'export_orders', taskId: ctx.taskId, dateStart, dateEnd });
    if (!ok) {
      taskLog(taskState, '✗ 下发失败：本机助手通道已断开');
      finishExport(ctx, false, '下发时通道已断开');
    }
  });
}

function estimateClientTimeout(n, gapMaxMs) {
  // 单家最坏耗时 = 聊天页加载 60s + frame 定位 45s + 编辑器就绪 40s + 发送 240s ≈ 6.5 分钟；
  // 旧公式只给 ~95s/家（n=1 时下限 120s），聊天页首次加载稍慢就误报「等待本机回执超时」。
  // 正常推进时每条回执都会重置计时（见 doClientSend 的 armTimer），所以这只是兜底上限。
  return Math.max(300000, n * (Math.ceil(gapMaxMs / 1000) + 420) * 1000);
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
 * 组装并下发一次「本机助手」发送任务
 * @param {number} userId
 * @param {string[]} loginIds 要发送的卖家内部 loginId
 * @param {{resumeOf?:number}} [opts] resumeOf=断线续跑时被接续的任务 id（仅用于审计与日志）
 */
async function doClientSend(userId, loginIds, opts = {}) {
  const resumeOf = Number(opts.resumeOf) || null;
  const taskState = taskFor(userId);
  if (taskState.running) throw new Error('已有任务在运行中');
  if (!agentHub.isOnline(userId)) throw new Error('本机助手未连接：请先在本机启动「1688 催收助手」桌面程序并完成绑定（看板顶部「本机助手」有下载与绑定入口）');

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

  // 操作日志：记录「对哪些公司发送了催收消息」（旁路，写入失败不影响发送）
  logOp(Number(userId), 'collect.send', {
    count: sellers.length,
    companies: sellers.map((s) => s.company || s.sellerLogin).slice(0, 20).join('、')
      + (sellers.length > 20 ? ` 等 ${sellers.length} 家` : ''),
    resumeOf: resumeOf || null,
  });

  Object.assign(taskState, {
    running: true, channel: 'client', type: 'send', total: sellers.length, done: 0, ok: 0, fail: 0,
    current: null, stopRequested: false, startedAt: new Date().toISOString(), finishedAt: null, logs: [],
    agentTaskId: taskId, pendingLeft: sellers.length, resumeOf,
  });
  taskLog(taskState, resumeOf
    ? `↻ 断线续跑：接续任务 #${resumeOf}，补发剩余 ${sellers.length} 家（新任务 #${taskId}）`
    : `▶ 通过「本机助手」发送催收消息：共 ${sellers.length} 家（任务 #${taskId}）`);
  taskLog(taskState, '· 发送在您本机的助手窗口里执行，服务器只下发任务并记录结果');
  if (!agentHub.status(userId).loggedIn) {
    taskLog(taskState, '⚠ 本机助手尚未登录 1688：若发送失败，请在助手里登录 1688 后重试');
  }

  await new Promise((resolve) => {
    const ctx = {
      taskId, userId: Number(userId), sellers, taskState, pending: sellers.length,
      stopRequested: false, finished: false, abortReason: null, resolve, timer: null,
    };
    // 超时兜底：以「剩余未回报家数」重新计算预算；每收到一条本机回执（log/sent）
    // 都会调用 ctx.armTimer() 重新计时 —— 只要任务还在推进就不会被误杀，
    // 只有助手彻底失联（断线且无任何回执）达到预算后才判超时。
    ctx.armTimer = () => {
      if (ctx.finished) return;
      const left = Math.max(1, ctx.pending != null ? ctx.pending : sellers.length);
      if (ctx.timer) clearTimeout(ctx.timer);
      ctx.timer = setTimeout(() => {
        taskLog(taskState, '⏱ 任务超时（长时间未收到本机助手回执），已结束');
        ctx.abortReason = '等待本机回执超时';
        finishClientTask(ctx, 'failed');
      }, estimateClientTimeout(left, gapMax));
    };
    ctx.armTimer();
    CLIENT_TASKS.set(taskId, ctx);
    pushClientProgress(userId, ctx);
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
      taskLog(taskState, '✗ 下发失败：本机助手通道已断开');
      finishClientTask(ctx, 'failed');
    }
  });
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
           u.must_change_password, u.last_login_at, u.created_at, u.updated_at, u.qnh_refund_enabled,
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
    qnhRefundEnabled: u.role === 'admin' ? true : !!Number(u.qnh_refund_enabled),
    lastLoginAt: u.last_login_at, createdAt: u.created_at, updatedAt: u.updated_at,
    orderCount: Number(u.order_count) || 0,
    companyCount: Number(u.company_count) || 0,
    invoiceRows: Number(u.invoice_rows) || 0,
    mappingCount: Number(u.mapping_count) || 0,
    sendOkCount: Number(u.send_ok_count) || 0,
  }));
}

/**
 * 登录账号规则。
 * 口径：**账号即公司全称**（开票抬头），所以必须允许中文；同时保留字母/数字/下划线/点/中划线/括号。
 * admin 是内置账号，不受"账号=公司全称"约束（其抬头会被清空，见下方 updateUser 的说明）。
 */
const USERNAME_RULE = '登录账号（公司全称）需 2~64 位，可用中文、字母、数字、下划线、点、中划线、括号';
function validUsername(name) {
  return typeof name === 'string' && /^[\u4e00-\u9fa5A-Za-z0-9_.·()（）-]{2,64}$/.test(name);
}

async function createUser({ username, password, companyName, taxNo, email, role, displayName, note }, byUser) {
  // 账号 = 公司全称：前端只填一个「公司全称」字段，这里做兜底（未传 username 时直接取 companyName）
  const uname = String(username || companyName || '').trim();
  const cname = String(companyName || uname || '').trim();
  if (!validUsername(uname)) throw new Error(USERNAME_RULE);
  if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
  const dup = await db.query('SELECT id FROM app_user WHERE username = ?', [uname]);
  if (dup.length) throw new Error('账号已存在: ' + uname);
  // 超级管理员是纯系统账号，不承载业务数据 → 不落开票抬头
  const isAdminRole = role === 'admin';
  const r = await db.exec(
    `INSERT INTO app_user (username, password_hash, role, status, company_name, tax_no, email, display_name, note, created_by)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [uname, auth.hashPassword(password), isAdminRole ? 'admin' : 'user',
      isAdminRole ? null : (cname || null),
      isAdminRole ? null : (taxNo || null),
      isAdminRole ? null : (email || null),
      displayName || null, note || null, byUser.id]
  );
  tenancy.ensureUserDirs(r.insertId);
  return { ok: true, id: r.insertId, username: uname };
}

async function updateUser({ id, username, companyName, taxNo, email, role, displayName, note }) {
  const rows = await db.query('SELECT * FROM app_user WHERE id = ?', [id]);
  if (!rows.length) throw new Error('用户不存在');
  const u = rows[0];
  if (u.username === 'admin' && role === 'user') throw new Error('内置超级管理员 admin 不能降级为普通用户');

  // 改「公司全称」= 改登录账号（两者同源）。admin 的内置账号名固定，不参与改名。
  let nextUsername = u.username;
  const wantUsername = String(username === undefined ? '' : username).trim();
  if (wantUsername && wantUsername !== u.username) {
    if (u.username === 'admin') throw new Error('内置超级管理员 admin 的登录账号不能改名');
    if (!validUsername(wantUsername)) throw new Error(USERNAME_RULE);
    const dup = await db.query('SELECT id FROM app_user WHERE username = ? AND id <> ?', [wantUsername, id]);
    if (dup.length) throw new Error('账号已存在: ' + wantUsername);
    nextUsername = wantUsername;
  }

  // 开票抬头：传了就按传的写（允许清空）；没传但账号改了 → 跟随账号；否则保持原值
  let nextCompany;
  if (companyName !== undefined) nextCompany = String(companyName).trim();
  else if (nextUsername !== u.username) nextCompany = nextUsername;
  else nextCompany = u.company_name || '';

  const nextRole = role === 'admin' ? 'admin' : (u.role === 'admin' ? 'admin' : 'user');
  // 超级管理员是纯系统账号，不承载业务数据 → 不维护开票抬头（用户列表中只保留「重置密码」）。
  // 这里对 admin 账号强制清空抬头，避免通过接口绕过界面停住一个与设计相悖的状态。
  const isAdminAccount = nextRole === 'admin';
  await db.exec(
    `UPDATE app_user SET username = ?, company_name = ?, tax_no = ?, email = ?, display_name = ?, note = ?, role = ? WHERE id = ?`,
    [nextUsername,
      isAdminAccount ? null : (nextCompany || null),
      isAdminAccount ? null : (taxNo === undefined ? u.tax_no : (String(taxNo).trim() || null)),
      isAdminAccount ? null : (email === undefined ? u.email : (String(email).trim() || null)),
      displayName === undefined ? u.display_name : (String(displayName).trim() || null),
      note === undefined ? u.note : (String(note).trim() || null),
      nextRole, id]
  );
  return { ok: true, username: nextUsername, companyName: isAdminAccount ? '' : nextCompany };
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
// HTTP 服务器
// ─────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  try {
    // ── 静态页 / 页面路由 ──
    if (method === 'GET' && (p === '/login' || p === '/login.html')) return sendHtml(res, 'login.html');
    // 公开下载落地页（无需登录，供用户获取本机发送扩展）
    if (method === 'GET' && (p === '/download' || p === '/download.html')) return sendHtml(res, 'download.html');
    // 书签工具落地页（登录可用，零安装方案；未登录跳转登录页）
    if (method === 'GET' && (p === '/bookmarklet' || p === '/bookmarklet.html')) {
      const bu = await currentUser(req);
      if (!bu) return redirect(res, '/login');
      return sendHtml(res, 'bookmarklet.html');
    }
    if (method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
    // 前端本地依赖（免外网 CDN）：/vendor/vue.min.js、/vendor/echarts.min.js、/vendor/element-ui/*
    if (method === 'GET' && p.startsWith('/vendor/')) return sendVendor(res, decodeURIComponent(p.slice('/vendor/'.length)));
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
      return sendJson(res, 200, { user: publicUser(u) });
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

    // ── 本机助手：公开端点（无需登录，供扩展首次拉取全局服务器地址）──
    if (method === 'GET' && p === '/api/agent/channel-info') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const cfg = loadConfig();
      const ins = findAgentInstaller();
      return sendJson(res, 200, {
        serverUrl: (cfg.server_url || '').trim(),
        permanentPairing: true,
        agentDownload: ins
          ? { available: true, url: '/api/agent/download-exe', fileName: ins.file, sizeBytes: ins.size }
          : { available: false, url: null, fileName: null, sizeBytes: 0 },
      });
    }

    // ── 本机助手安装包下载（公开；文件来自 dist/，未构建则 404）──
    if (method === 'GET' && p === '/api/agent/download-exe') {
      const ins = findAgentInstaller();
      if (!ins) {
        return sendJson(res, 404, {
          error: '安装包尚未构建。请管理员在本机执行 npm run agent:dist 生成，或联系管理员获取「1688催收助手」安装包。',
          hint: 'electron-builder 产物输出到 dist/ 目录（nsis 安装版优先）。',
        });
      }
      try {
        const full = path.join(ROOT, 'dist', ins.file);
        const stat = fs.statSync(full);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': stat.size,
          'content-disposition': `attachment; filename="${encodeURIComponent(ins.file)}"`,
          'cache-control': 'no-store',
        });
        return fs.createReadStream(full).pipe(res);
      } catch (e) {
        return sendJson(res, 500, { error: '读取安装包失败：' + e.message });
      }
    }

    // ── 本机助手：用一次性绑定令牌换取长期设备令牌（**公开端点**：助手没有看板 Cookie）──
    //    · 带 bindToken → 校验令牌（绝不回退 Cookie，否则伪造/重放令牌会被静默降级成自签）
    //    · 不带 bindToken 但已登录 → 看板自签（用于签发「书签令牌」）
    if (method === 'POST' && p === '/api/agent/bind') {
      const body = await readBody(req);
      const rawBind = String(body.bindToken || '').trim();
      const me = await currentUser(req);
      let uid = null;
      if (rawBind) {
        uid = redeemBindToken(rawBind);
        if (!uid) return sendJson(res, 401, { error: '绑定令牌无效或已过期；请在网站上重新点击「绑定本机助手」' });
      } else {
        if (!me) return sendJson(res, 401, { error: '缺少绑定令牌且未登录' });
        uid = me.id;
      }
      const kind = body.kind === 'bookmarklet' ? 'bookmarklet' : 'agent';
      if (kind === 'bookmarklet' && !me) return sendJson(res, 401, { error: '书签令牌需在登录状态下签发' });
      const { id, token } = await createDevice(uid, {
        deviceName: body.deviceName, os: body.os, agentVer: body.agentVer,
        kind, ip: clientIp(req),
      });
      // 操作日志：记录「绑定了本机助手」（书签令牌是另一种通道，不记入本机助手）
      if (kind === 'agent') {
        logOp(Number(uid), 'agent.bind', { deviceName: body.deviceName || '', os: body.os || '', ip: clientIp(req) });
      }
      return sendJson(res, 200, {
        ok: true, deviceId: id, deviceToken: token,
        serverUrl: serverUrlOf(req), userId: Number(uid), kind,
        note: '设备令牌仅此一次返回，请妥善保存在本机（助手会自动保存）。',
      });
    }

    // ── 本机助手回传「导出的 1688 订单 Excel」(**公开端点**：助手用设备令牌鉴权) ──
    //    文件落到该用户的「完成订单」目录后，复用「重新导入数据」同一套解析入库逻辑。
    if (method === 'POST' && p === '/api/agent/upload-orders') {
      const dev = await resolveDeviceToken(req.headers['x-device-token']);
      if (!dev) return sendJson(res, 401, { error: '设备令牌无效' });
      const userId = dev.userId;
      const ctx = EXPORTS.get(String(url.searchParams.get('taskId') || ''));
      if (!ctx || ctx.userId !== userId) return sendJson(res, 404, { error: '导出任务不存在或已结束' });
      if (ctx.importStarted) return sendJson(res, 409, { error: '该任务已在导入中，请勿重复上传' });
      const raw = await readRawBody(req, 80e6);
      if (!raw || !raw.length) return sendJson(res, 400, { error: '文件内容为空或超过大小限制（80MB）' });
      const origName = String(url.searchParams.get('name') || '1688导出.xlsx')
        .replace(/[\\/:*?"<>|\r\n]/g, '_').slice(-80);
      const dir = tenancy.orderDirFor(userId);
      fs.mkdirSync(dir, { recursive: true });
      const fname = '1688自动导出_' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '_' + origName;
      fs.writeFileSync(path.join(dir, fname), raw);
      ctx.importStarted = true;
      taskLog(ctx.taskState, `· 已收到订单文件「${fname}」（${Math.round(raw.length / 1024)} KB），开始解析入库（与「重新导入数据」同一套逻辑）`);
      let r;
      try { r = await runImport({ userId, orders: true }); }
      catch (e) {
        taskLog(ctx.taskState, '✗ 解析入库失败: ' + e.message);
        finishExport(ctx, false, '解析入库失败: ' + e.message);
        return sendJson(res, 500, { error: String(e.message || e) });
      }
      for (const s of r.steps || []) taskLog(ctx.taskState, '  ' + s);
      const ins = r.orders && r.orders.inserted;
      taskLog(ctx.taskState, `✓ 订单导入完成${ins !== undefined ? `（新写入 ${ins} 单）` : ''}`);
      // 上传即导入完成 = 导出任务成功收尾（助手端只在失败时发 export_done）
      finishExport(ctx, true);
      return sendJson(res, 200, { ok: true, import: { inserted: ins, skipped: r.orders && r.orders.skippedExisting, files: r.orders && r.orders.files } });
    }

    // ── 已废弃（2026-10-14）：浏览器扩展包下载下线，统一迁移到桌面助手 ──
    if (method === 'GET' && p === '/api/agent/extension-download') {
      return sendJson(res, 410, {
        error: '浏览器扩展已下线，请到下载页获取「1688 催收助手」桌面程序',
        migrateTo: '/download',
      });
    }

    // ── 书签工具（零安装方案）：跨域 CORS（1688 页面内的书签会跨域调用本站）──
    function allowBmCors(req, res) {
      const origin = (req.headers.origin || '').trim();
      const svr = ((loadConfig().server_url || '').trim());
      const is1688 = /(^|\.)1688\.com$/i.test(origin);
      const allow = (is1688 || (svr && origin === svr)) ? origin : (svr || `http://${req.headers.host || 'localhost'}`);
      res.setHeader('Access-Control-Allow-Origin', allow);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Vary', 'Origin');
    }
    // 书签工具：CORS 预检
    if (method === 'OPTIONS' && p.startsWith('/api/agent/bm/')) {
      allowBmCors(req, res);
      return res.writeHead(204).end();
    }
    // 书签工具：按卖家登录名拉取待发催收消息（公开，用 code=设备令牌 解析用户，凭据不出本机）
    if (method === 'GET' && p === '/api/agent/bm/task') {
      allowBmCors(req, res);
      const code = (url.searchParams.get('code') || '').trim();
      const rawLogin = (url.searchParams.get('login') || '').trim();
      if (!code || !rawLogin) return sendJson(res, 400, { error: '缺少参数' });
      const uid = await agentHub.resolveUserByCode(code);
      if (!uid) return sendJson(res, 401, { error: '设备令牌无效或已撤销（不再接受税号；请在看板「本机助手 → 书签令牌」重新签发）' });
      return sendJson(res, 200, await bmComputeTask(uid, rawLogin));
    }
    // 书签工具：回报发送结果（公开，用 code=设备令牌 解析用户）
    if (method === 'POST' && p === '/api/agent/bm/result') {
      allowBmCors(req, res);
      const body = await readBody(req);
      const code = (body.code || '').trim();
      const login = (body.login || '').trim();
      if (!code) return sendJson(res, 400, { error: '缺少 code' });
      const uid = await agentHub.resolveUserByCode(code);
      if (!uid) return sendJson(res, 401, { error: '设备令牌无效或已撤销' });
      if (body.nothing) return sendJson(res, 200, { ok: true, skipped: true });
      const ok = !!body.ok;
      await recordSent(
        uid, login, body.company || '', ok ? 'ok' : 'fail', 'bookmarklet',
        body.amount == null ? null : Number(body.amount), body.orderNos || null,
        ok ? null : (String(body.error || '').split('\n')[0].slice(0, 250))
      );
      return sendJson(res, 200, { ok: true });
    }

    // ── 以下接口都需要登录 ──
    const user = await currentUser(req);
    if (!user) return sendJson(res, 401, { error: '登录已失效，请重新登录' });
    const tenantId = tenantOf(req, url, user);
    const isAdmin = user.role === 'admin';
    const writeGuard = () => assertWritable(user, tenantId);

    // 操作日志上报（前端埋点）：action 必须命中白名单，文案一律由服务端渲染
    if (method === 'POST' && p === '/api/op-log') {
      const ob = await readBody(req);
      const action = String(ob.action || '').trim();
      if (!OP_ACTIONS[action]) return sendJson(res, 400, { error: '未知操作类型' });
      const d = {};
      if (action === 'btn.click') d.btn = opSafe(ob.btn, 40) || '按钮';
      if (action === 'query.filter') {
        d.collect = OP_COLLECT_LABELS[String(ob.collect || '')] || '不限';
        d.invoice = OP_INVOICE_LABELS[String(ob.invoice || '')] || '全部';
        d.keyword = opSafe(ob.keyword, 40) || '空';
      }
      if (action === 'view.day.orders' || action === 'view.day.invoices') d.date = opSafe(ob.date, 10) || '未知日期';
      d.ip = clientIp(req);
      await logOp(user, action, d);
      return sendJson(res, 200, { ok: true });
    }

    // ── 已废弃（2026-10-14）：浏览器扩展通道下线，统一迁移到「1688 催收助手」桌面程序 ──
    if (method === 'GET' && p === '/api/agent/my-extension-download') {
      return sendJson(res, 410, {
        error: '浏览器扩展通道已下线，请改用「1688 催收助手」桌面程序',
        migrateTo: '/download',
        note: '桌面助手自带浏览器、无需再装扩展，且用设备令牌连接、更安全。',
      });
    }

    // 看板数据
    if (method === 'GET' && p === '/api/data') {
      const companies = await loadCompanies(tenantId);
      const sendStats = await loadSendStats(tenantId);
      const sentList = sendStats.filter((r) => Number(r.sendCount) > 0).map((r) => r.login);
      // 「已开票金额（税务局）」全局统计：排除「已忽略」销方名称的发票（用户点忽略后不计入看板总额）
      const invSummary = await db.query(`
        SELECT COUNT(*) AS rows_count,
               COUNT(DISTINCT COALESCE(NULLIF(e_invoice_no,''), NULLIF(invoice_no,''), i.row_hash)) AS invoice_count,
               ROUND(SUM(COALESCE(total_amount,0)),2) AS amount,
               SUM(seller_company IS NULL) AS unmapped_rows
        FROM issued_invoice i
        WHERE i.user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM seller_name_mapping m
            WHERE m.user_id = i.user_id AND m.tax_seller_name = i.seller_name AND m.is_ignored = 1
          )
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

    // 订单明细（看板「订单总金额」卡片 / 趋势图某一天）—— 分页 + 可选关键字 + 可选日期(YYYY-MM-DD)
    if (method === 'GET' && p === '/api/detail/orders') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 20));
      const kw = (url.searchParams.get('q') || '').trim();
      const date = normalizeDay(url.searchParams.get('date'));
      const w = (kw ? 'AND (o.order_no LIKE ? OR o.seller_company LIKE ? OR o.seller_login LIKE ?) ' : '')
        + (date ? 'AND DATE(o.pay_time) = ? ' : '');
      const args = [];
      if (kw) args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
      if (date) args.push(date);
      const totalR = await db.query(`SELECT COUNT(*) AS n FROM invoice_order o WHERE o.user_id = ? AND o.pay_time IS NOT NULL ${w}`, [tenantId, ...args]);
      const rows = await db.query(`
        SELECT o.order_no, o.seller_company, o.seller_login, o.pay_amount, o.pay_time, o.invoice_state, o.state_source
        FROM invoice_order o
        WHERE o.user_id = ? AND o.pay_time IS NOT NULL ${w}
        ORDER BY o.pay_time DESC, o.order_no DESC
        LIMIT ${size} OFFSET ${(page - 1) * size}
      `, [tenantId, ...args]);
      return sendJson(res, 200, {
        total: totalR[0] ? totalR[0].n : 0, page, size, date: date || null, rows,
        // 金额合计与当前筛选口径一致（关键字 + 日期）
        amount: (await db.query(`
          SELECT ROUND(SUM(COALESCE(o.pay_amount,0)),2) AS a FROM invoice_order o
          WHERE o.user_id = ? AND o.pay_time IS NOT NULL ${w}
        `, [tenantId, ...args]))[0].a,
      });
    }

    // 发票明细（看板「已开票金额（税务局）」卡片 / 趋势图某一天）—— 排除已忽略销方，分页 + 可选关键字 + 可选日期
    if (method === 'GET' && p === '/api/detail/invoices') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 20));
      const kw = (url.searchParams.get('q') || '').trim();
      const date = normalizeDay(url.searchParams.get('date'));
      const w = (kw ? 'AND (i.seller_name LIKE ? OR i.buyer_name LIKE ? OR i.invoice_no LIKE ? OR i.e_invoice_no LIKE ?) ' : '')
        + (date ? 'AND DATE(i.invoice_date) = ? ' : '');
      const args = [];
      if (kw) args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);
      if (date) args.push(date);
      const base = `
        FROM issued_invoice i
        WHERE i.user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM seller_name_mapping m
            WHERE m.user_id = i.user_id AND m.tax_seller_name = i.seller_name AND m.is_ignored = 1
          ) ${w}`;
      const totalR = await db.query(`SELECT COUNT(*) AS n ${base}`, [tenantId, ...args]);
      const rows = await db.query(`
        SELECT COALESCE(NULLIF(i.e_invoice_no,''), NULLIF(i.invoice_no,''), i.row_hash) AS invoice_no,
               i.seller_name, i.buyer_name, i.total_amount, i.invoice_date, i.invoice_status
        ${base}
        ORDER BY i.invoice_date DESC, i.id DESC
        LIMIT ${size} OFFSET ${(page - 1) * size}
      `, [tenantId, ...args]);
      return sendJson(res, 200, {
        total: totalR[0] ? totalR[0].n : 0, page, size, date: date || null, rows,
        amount: (await db.query(`
          SELECT ROUND(SUM(COALESCE(i.total_amount,0)),2) AS a ${base}
        `, [tenantId, ...args]).then(r => (r[0] && r[0].a) || 0)),
      });
    }

    // 趋势：最近 30 天每日支付订单金额 / 每日已开票金额（排除已忽略销方）
    if (method === 'GET' && p === '/api/trend') {
      const dstr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const start = new Date(Date.now() - 29 * 86400000);
      const fromStr = dstr(start);
      const noIgnore = `
        AND NOT EXISTS (
          SELECT 1 FROM seller_name_mapping m2
          WHERE m2.user_id = i.user_id AND m2.tax_seller_name = i.seller_name AND m2.is_ignored = 1
        )`;
      const ordRows = await db.query(`
        SELECT DATE(pay_time) AS d, COUNT(*) AS n, ROUND(SUM(COALESCE(pay_amount,0)),2) AS amt
        FROM invoice_order o
        WHERE o.user_id = ? AND o.pay_time IS NOT NULL AND DATE(o.pay_time) >= ?
        GROUP BY DATE(o.pay_time)
      `, [tenantId, fromStr]);
      const invRows = await db.query(`
        SELECT DATE(i.invoice_date) AS d, COUNT(*) AS n, ROUND(SUM(COALESCE(i.total_amount,0)),2) AS amt
        FROM issued_invoice i
        WHERE i.user_id = ? AND i.invoice_date IS NOT NULL AND DATE(i.invoice_date) >= ? ${noIgnore}
        GROUP BY DATE(i.invoice_date)
      `, [tenantId, fromStr]);
      const oMap = new Map(ordRows.map(r => [String(r.d).slice(0, 10), r]));
      const iMap = new Map(invRows.map(r => [String(r.d).slice(0, 10), r]));
      const days = [];
      for (let t = start.getTime(); t <= Date.now(); t += 86400000) {
        const ds = dstr(new Date(t));
        const o = oMap.get(ds), v = iMap.get(ds);
        days.push({
          date: ds,
          orderAmount: o ? Number(o.amt) || 0 : 0,
          orderCount: o ? Number(o.n) || 0 : 0,
          invoiceAmount: v ? Number(v.amt) || 0 : 0,
          invoiceCount: v ? Number(v.n) || 0 : 0,
        });
      }
      return sendJson(res, 200, { days });
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
      const safe = { runtime: config.runtime || {}, messages: config.messages || {}, serverUrl: (config.server_url || '').trim() };
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
      // 全局通道服务器地址：所有用户的本机扩展共用，可由系统管理统一维护
      if (config.server_url !== undefined) merged.server_url = String(config.server_url || '').trim();
      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
      // 兼容旧调用：允许随配置一起提交本人抬头。看板已不再走这条路
      // （抬头属于用户信息，统一在「系统管理 → 用户管理」里按账号维护）
      if (config.buyerInfo) {
        await db.exec('UPDATE app_user SET company_name = ?, tax_no = ?, email = ? WHERE id = ?',
          [config.buyerInfo.companyName || null, config.buyerInfo.taxNo || null, config.buyerInfo.email || null, user.id]);
      }
      return sendJson(res, 200, { ok: true });
    }

    // 上传导入：用户在浏览器里拖拽/选择上传 1688 订单 Excel 或 税务局发票 Excel
    //   · kind=orders   → 解析后写入 invoice_order（按订单号 upsert：重复数据做更新）
    //   · kind=invoices → 解析后写入 issued_invoice（按 用户+行指纹 upsert）
    //   · 请求体是文件二进制（application/octet-stream），文件名走 query 参数
    if (method === 'POST' && p === '/api/import/upload') {
      writeGuard();
      const up = new URL(req.url, 'http://localhost');
      const kind = up.searchParams.get('kind') === 'invoices' ? 'invoices' : 'orders';
      const rawName = String(up.searchParams.get('name') || '').trim();
      const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]+/g, '_').slice(-120)
        || (kind === 'invoices' ? 'invoices.xlsx' : 'orders.xlsx');
      if (!/\.(xlsx|xls)$/i.test(safeName)) throw new Error('只支持 .xlsx / .xls 文件（请上传从 1688 / 税务局导出的 Excel）');
      const buf = await readRawBody(req, 80e6);
      if (!buf) throw new Error('上传失败：内容过大（上限 80MB）或读取中断');
      if (!buf.length) throw new Error('上传失败：文件内容为空');

      const dir = kind === 'invoices' ? tenancy.invoiceDirFor(tenantId) : tenancy.orderDirFor(tenantId);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dest = path.join(dir, stamp + '-' + safeName);
      fs.writeFileSync(dest, buf);

      const t = taskFor(tenantId);
      taskLog(t, `▶ 上传导入（${kind === 'invoices' ? '税务局发票' : '1688订单'}）：${safeName} · ${(buf.length / 1024).toFixed(0)}KB`);
      const r = kind === 'invoices'
        ? await importInvoiceUpload(tenantId, dest, safeName)
        : await importOrderUpload(tenantId, dest, safeName);
      if (!r.ok) {
        taskLog(t, `✗ 导入失败：${r.error}`);
        return sendJson(res, 400, { ok: false, kind, error: r.error, file: safeName });
      }
      if (kind === 'invoices') {
        taskLog(t, `✓ 发票导入完成：新增 ${r.inserted} 行 · 更新 ${r.updated} 行` +
          (r.autoMapped ? ` · 自动匹配 ${r.autoMapped} 个销方` : '') +
          (r.unmatchedNames && r.unmatchedNames.length ? ` · 待人工匹配 ${r.unmatchedNames.length} 个销方` : ''));
      } else {
        taskLog(t, `✓ 订单导入完成：新增 ${r.inserted} 单 · 更新 ${r.updated} 单`);
      }
      // 操作日志：记录导入（旁路）
      logOp(user, kind === 'invoices' ? 'import.invoice' : 'import.order', {
        file: safeName, inserted: r.inserted || 0, updated: r.updated || 0, ip: clientIp(req),
      });
      return sendJson(res, 200, { ok: true, kind, ...r });
    }

    // 导入1688订单数据：下发任务给本机助手 → 助手在自带浏览器里按条件导出报表
    //   → 下载完成回传 /api/agent/upload-orders → 复用上面的解析入库逻辑。
    //    该请求会阻塞到整个流程结束（通常 1~5 分钟），期间看板通过 /api/task 看实时日志。
    if (method === 'POST' && p === '/api/agent/export-orders') {
      writeGuard();
      const body = await readBody(req);
      const dateStart = String(body.dateStart || '').trim();
      const dateEnd = String(body.dateEnd || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart) || !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd))
        return sendJson(res, 400, { error: '开始与结束日期均必填，格式 YYYY-MM-DD' });
      if (dateStart > dateEnd) return sendJson(res, 400, { error: '开始日期不能晚于结束日期' });
      try { await doExportOrders(tenantId, { dateStart, dateEnd }); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      return sendJson(res, 200, { ok: true });
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

    // ── 本机助手通道（方案C）：始终作用于「当前登录者本人」的本机助手 ──
    if (method === 'GET' && p === '/api/agent/status') {
      return sendJson(res, 200, { ...agentHub.status(user.id), userId: user.id });
    }
    if (method === 'POST' && p === '/api/agent/pair-code') {
      if (Number(tenantId) !== Number(user.id)) throw Object.assign(new Error('查看他人数据为只读模式，无法操作本机通道'), { code: 403 });
      // 签发「一次性绑定令牌」：本机助手拿它换取长期设备令牌（之后一律用设备令牌连接）。
      // 深链形如 xsh://bind?server=<serverUrl>&t=<bindToken>
      const bindToken = issueBindToken(user.id);
      const serverUrl = serverUrlOf(req);
      return sendJson(res, 200, {
        bindToken,
        ttlSec: Math.round(BIND_TTL_MS / 1000),
        serverUrl,
        deepLink: 'xsh://bind?server=' + encodeURIComponent(serverUrl) + '&t=' + bindToken,
        taxNo: (user.tax_no || '').trim(), // 仅用于展示（话术里的 {taxNo}），不再作为凭据
        note: '一次性绑定令牌（2 分钟内有效）。本机助手用它换取长期设备令牌；令牌不再等同于税号，泄露税号无法冒用。',
      });
    }
    // 本机助手用绑定令牌换取长期设备令牌（助手无看板 Cookie，故同时支持 Cookie 自签）
    // （注：POST /api/agent/bind 在公开区——桌面助手没有看板 Cookie，
    //   靠「一次性绑定令牌」鉴权；若带登录态也可用于签发书签令牌。）
    if (method === 'GET' && p === '/api/agent/devices') {
      const rows = await db.query(
        'SELECT id, device_name, os, agent_ver, kind, last_ip, last_seen_at, revoked_at, created_at ' +
        'FROM agent_device WHERE user_id = ? ORDER BY id DESC',
        [user.id]
      );
      return sendJson(res, 200, {
        devices: rows.map((r) => ({
          id: Number(r.id), name: r.device_name || '', os: r.os || '', agentVer: r.agent_ver || '',
          kind: r.kind, lastIp: r.last_ip || '', lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
          createdAt: r.created_at, active: !r.revoked_at,
        })),
      });
    }
    if (method === 'POST' && p === '/api/agent/devices/revoke') {
      writeGuard();
      const body = await readBody(req);
      const id = Number(body.id);
      if (!id) return sendJson(res, 400, { error: '缺少设备 id' });
      const rows = await db.query('SELECT id FROM agent_device WHERE id = ? AND user_id = ?', [id, user.id]);
      if (!rows[0]) return sendJson(res, 404, { error: '设备不存在' });
      await db.exec('UPDATE agent_device SET revoked_at = NOW() WHERE id = ?', [id]);
      // 若当前在线连接正来自被撤销的设备，一并断开（下次连接会因令牌无效被拒）
      const closed = agentHub.disconnect(user.id, '设备令牌已被撤销');
      return sendJson(res, 200, { ok: true, closed });
    }
    if (method === 'POST' && p === '/api/agent/disconnect') {
      writeGuard();
      // 税号配对是永久的，「断开」只关闭当前 WebSocket 连接；下次打开扩展点「连接」即可重连，无需重新配对
      const closed = agentHub.disconnect(user.id, '用户主动断开');
      return sendJson(res, 200, { ok: true, closed });
    }
    // ── 本机通道：打包扩展供用户下载（服务器地址按全局配置注入，用户只需填税号）──
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
        throw new Error('本机助手未连接：请先在本机启动「1688 催收助手」桌面程序，再点「续跑」');
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

    // 发送催收消息（只走「本机助手通道」：发送在用户本机助手执行，服务器不接触登录态）
    if (method === 'POST' && p === '/api/send') {
      writeGuard();
      const body = await readBody(req);
      const { loginIds } = body || {};
      if (!Array.isArray(loginIds) || loginIds.length === 0) throw new Error('缺少 loginIds');
      const t = taskFor(tenantId);
      if (t.running) throw new Error('已有任务在运行中');
      if (!agentHub.isOnline(tenantId)) {
        throw new Error('本机助手未连接：请先在本机启动「1688 催收助手」桌面程序并完成绑定（看板顶部「本机助手」有下载与绑定入口）。发送只在你本机执行');
      }
      doClientSend(tenantId, loginIds).catch((e) => {
        const ts = taskFor(tenantId);
        ts.running = false;
        taskLog(ts, '✗ 任务异常: ' + e.message);
      });
      return sendJson(res, 200, { started: true, channel: 'client' });
    }

    // ── 牵牛花退单列表（需「退单列表」权限；超级管理员始终可用）──
    if (p.startsWith('/api/qnh/')) {
      const canRefund = isAdmin || !!Number(user.qnh_refund_enabled);
      if (!canRefund) return sendJson(res, 403, { error: '未开启退单列表权限，请联系超级管理员' });

      if (method === 'GET' && p === '/api/qnh/status') {
        const [cookie, cfg, sum] = await Promise.all([
          qnh.cookieStatus(), qnh.getConfig(), qnh.summary().catch(() => null),
        ]);
        return sendJson(res, 200, {
          cookie,
          config: qnh.publicConfig(cfg),
          sync: qnh.getSyncState(),
          summary: sum,
          isAdmin,
        });
      }

      if (method === 'GET' && p === '/api/qnh/summary') {
        return sendJson(res, 200, await qnh.summary());
      }

      if (method === 'GET' && p === '/api/qnh/refunds') {
        const q = url.searchParams;
        return sendJson(res, 200, await qnh.listRefunds({
          from: q.get('from') || '',
          to: q.get('to') || '',
          keyword: q.get('keyword') || '',
          status: q.get('status') || '',
          type: q.get('type') || '',
          delivery: q.get('delivery') || '',
          sort: q.get('sort') || '',
          page: q.get('page'),
          size: q.get('size'),
        }));
      }

      if (method === 'GET' && p === '/api/qnh/trend') {
        return sendJson(res, 200, { days: await qnh.refundTrend(url.searchParams.get('days') || 30) });
      }

      if (method === 'GET' && p === '/api/qnh/logs') {
        const refundNo = (url.searchParams.get('refundNo') || '').trim().slice(0, 64);
        if (!refundNo) return sendJson(res, 400, { error: '缺少退单号' });
        return sendJson(res, 200, {
          refundNo,
          logs: await qnh.getLogs(refundNo, url.searchParams.get('type') || ''),
        });
      }

      // 以下仅超级管理员
      if (method === 'POST' && p === '/api/qnh/login') {
        if (!isAdmin) return sendJson(res, 403, { error: '仅超级管理员可刷新牵牛花登录态' });
        const body = await readBody(req);
        const resLogin = await qnh.loginCookie({ headless: !!body.headless });
        await logOp(user, 'qnh.login', { ok: resLogin.ok });
        return sendJson(res, 200, resLogin);
      }

      if (method === 'POST' && p === '/api/qnh/sync') {
        if (!isAdmin) return sendJson(res, 403, { error: '仅超级管理员可触发同步' });
        const body = await readBody(req);
        const out = await qnh.runSync({
          trigger: 'manual',
          days: Number(body.days) || null,
          date: body.date || null,
        });
        await logOp(user, 'qnh.sync', { ok: !!out.ok });
        return sendJson(res, 200, out);
      }

      if (method === 'POST' && p === '/api/qnh/config') {
        if (!isAdmin) return sendJson(res, 403, { error: '仅超级管理员可修改退单同步设置' });
        const body = await readBody(req);
        const patch = {};
        if (body.scheduleEnabled !== undefined) patch[qnh.CFG.scheduleEnabled] = body.scheduleEnabled ? '1' : '0';
        if (body.scheduleTime !== undefined) {
          const t = String(body.scheduleTime).trim();
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return sendJson(res, 400, { error: '时间格式应为 HH:mm' });
          patch[qnh.CFG.scheduleTime] = t;
        }
        if (body.webhook !== undefined) patch[qnh.CFG.webhook] = String(body.webhook).trim().slice(0, 500);
        if (body.wecomEnabled !== undefined) patch[qnh.CFG.wecomEnabled] = body.wecomEnabled ? '1' : '0';
        if (body.alertDelivery !== undefined) patch[qnh.CFG.alertDelivery] = body.alertDelivery ? '1' : '0';

        const cfg = await qnh.setConfig(patch);
        const labels = [];
        if (patch[qnh.CFG.scheduleEnabled] !== undefined) labels.push('定时' + (patch[qnh.CFG.scheduleEnabled] === '1' ? '开启' : '关闭'));
        if (patch[qnh.CFG.scheduleTime] !== undefined) labels.push('时间 ' + patch[qnh.CFG.scheduleTime]);
        if (patch[qnh.CFG.wecomEnabled] !== undefined) labels.push('企业微信' + (patch[qnh.CFG.wecomEnabled] === '1' ? '开启' : '关闭'));
        if (patch[qnh.CFG.alertDelivery] !== undefined) labels.push('配送日志提醒' + (patch[qnh.CFG.alertDelivery] === '1' ? '开启' : '关闭'));
        if (patch[qnh.CFG.webhook] !== undefined) labels.push('更新了机器人地址');
        await logOp(user, 'qnh.config', { items: labels.join('、') || '无变化' });
        return sendJson(res, 200, { ok: true, config: qnh.publicConfig(cfg) });
      }

      if (method === 'POST' && p === '/api/qnh/test-webhook') {
        if (!isAdmin) return sendJson(res, 403, { error: '仅超级管理员可测试机器人' });
        return sendJson(res, 200, await qnh.testWebhook());
      }

      return sendJson(res, 404, { error: '未知退单接口' });
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
      // 退单列表页权限：逐个账号开启/关闭
      if (method === 'POST' && p === '/api/admin/users/qnh-refund') {
        const b = await readBody(req);
        const id = Number(b.id);
        const enabled = !!b.enabled;
        if (!id) return sendJson(res, 400, { error: '缺少用户ID' });
        const rows = await db.query('SELECT id, username, role FROM app_user WHERE id = ?', [id]);
        if (!rows.length) return sendJson(res, 404, { error: '用户不存在' });
        if (rows[0].role === 'admin') {
          return sendJson(res, 400, { error: '超级管理员默认拥有退单列表权限，无需开启' });
        }
        await db.exec('UPDATE app_user SET qnh_refund_enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
        await logOp(user, 'qnh.permit', { username: rows[0].username, enabled });
        return sendJson(res, 200, { ok: true, id, qnhRefundEnabled: enabled });
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
      // 操作日志：可按用户名筛选，固定按操作时间倒序
      if (method === 'GET' && p === '/api/admin/op-log') {
        const kw = (url.searchParams.get('username') || '').trim().slice(0, 64);
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 20));
        const where = [];
        const args = [];
        if (kw) { where.push('username LIKE ?'); args.push(`%${kw}%`); }
        const wsql = where.length ? ' WHERE ' + where.join(' AND ') : '';
        const total = (await db.query(`SELECT COUNT(*) AS n FROM operation_log${wsql}`, args))[0].n;
        const rows = await db.query(
          `SELECT id, user_id, username, action, content, ip, created_at FROM operation_log${wsql}
           ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
          [...args, size, (page - 1) * size]
        );
        return sendJson(res, 200, {
          total, page, size,
          logs: rows.map((r) => ({
            id: r.id, userId: r.user_id, username: r.username || '—',
            action: r.action, content: r.content, ip: r.ip || '',
            createdAt: r.created_at ? new Date(r.created_at).toLocaleString('zh-CN', { hour12: false }) : '',
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

// 本机通道：桌面助手/书签用「设备令牌」鉴权（本机侧没有看板登录 Cookie）
wsAgent.on('connection', (ws) => {
  const uid = ws._agentUid;
  let bound = false;
  const bind = (hello) => {
    if (bound) return;
    bound = true;
    agentHub.attach(uid, ws, {
      loggedIn: !!(hello && hello.loggedIn),
      ua: (hello && hello.ua) || '',
      agentVer: (hello && hello.agentVer) || '',
      os: (hello && hello.os) || (hello && hello.platform) || '',
    });
    try { ws.send(JSON.stringify({ type: 'ready', uid, serverTime: Date.now() })); } catch (e) { /* 忽略 */ }
    console.log(`[agent] uid=${uid} 本机助手已连接${hello && hello.agentVer ? ' (v' + hello.agentVer + ')' : ''}`);
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
    // 凭据 = 设备令牌（?device=<token>）。为兼容旧版助手，也接受 ?code=<token>，
    // 但两者语义相同：都必须是设备令牌，**税号不再被接受**。
    const cred = url.searchParams.get('device') || url.searchParams.get('code');
    const uid = await agentHub.redeem(cred);
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
    const v = await db.ping();
    console.log(`✓ 数据库连接正常 (MySQL ${v})`);
    const [{ n: userCount }] = await db.query('SELECT COUNT(*) AS n FROM app_user');
    console.log(`  账号 ${userCount} 个`);
  } catch (e) {
    console.error('✗ 数据库初始化失败:', e.message);
    console.error('  请先启动数据库并确认 config.json 的 mysql 段（或设置 MYSQL_* 环境变量）');
  }
  // 退单同步定时任务（到点在进程内触发，不依赖 Windows 计划任务）
  try { qnh.startScheduler(); } catch (e) { console.error('✗ 退单定时器启动失败:', e.message); }
  console.log('Ctrl+C 停止服务器');
});
