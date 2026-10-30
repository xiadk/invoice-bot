/**
 * server.js — 发票催收（多用户 / 可云端部署）
 *
 * 启动: node server.js   →  浏览器打开 http://localhost:8787 （生产建议放在 HTTPS 反代后面）
 *
 * ── 账号与权限 ────────────────────────────────────────────────────────────
 *   登录页 /login（只能登录，不能注册）；账号由超级管理员在「系统管理」里创建。
 *   超级管理员 admin（首次建库自动创建，默认密码 admin，请立即修改）：
 *     · 新增用户（账号/密码/公司名称/纳税人识别号/收票邮箱）、重置密码、启用/禁用
 *     · 按用户名查看任意用户的「1688发票」数据（只读）
 *     · 「税名核对」全局视图：可查看并维护所有用户产生的待映射 / 已维护映射
 *   普通用户：只能看自己的「1688发票」「拼多多发票」等业务数据，看不到「系统管理」。
 *     · 「税名核对」可用（查询 / 保存 / 忽略），但只看得到、也只改得动自己发票里的销方名称；
 *       底层映射表是全平台一套去重表，别人维护过的同名销方会直接复用，无须重复映射。
 *   所有业务数据按 user_id 隔离（见 sql/schema.sql 与 lib/tenancy.js）。
 *
 * ── 1688 登录态与发送（只在用户本机执行） ─────────────────────────────────
 *   服务器不保存任何 1688 登录态、不启动服务端浏览器：登录与发送都发生在
 *   **用户自己电脑上的「催收小助手」桌面程序**（Electron 自带浏览器窗口）里。
 *   绑定：「1688发票」页点「绑定本机助手」→ 服务端签发一次性绑定令牌 → 深链 xsh://bind?... 唤起助手
 *         → 助手用令牌换取**长期设备令牌**（本地保存）→ 连 /ws/agent?device=<token>。
 *   发送：点「发送催收消息」后，服务器只编排任务并通过 WS 下发；
 *         助手在自带浏览器里打开 1688 聊天页逐家发送，回执经 WS 回来落库。
 *   断线可续跑（只补发未完成项，已成功的绝不重发）。
 *   ⚠ 凭据演进（2026-10-14）：**设备令牌取代「税号当配对码」**——税号是半公开信息，
 *     不可作凭据。旧浏览器扩展/书签通道已下线（/api/agent/extension-download 等返回 410）。
 *
 * ── 接口 ──────────────────────────────────────────────────────────────────
 *   认证:   POST /api/auth/login | POST /api/auth/logout | GET /api/auth/me | POST /api/auth/password
 *   1688发票: GET  /api/data | GET /api/seller-detail | GET /api/collect-history
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
const zlib = require('zlib');
const { spawn } = require('child_process'); // arch-allow: child_process（管理员「一键重新打包本机助手」功能使用，全项目唯一豁免）
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./lib/auth');
const tenancy = require('./lib/tenancy');
const { runImport, importOrderUpload, importInvoiceUpload } = require('./import-to-db');
const qht = require('./lib/qht');
const products = require('./lib/products');
const billing = require('./lib/billing');
const { loadConfig } = require('./lib/config');
const { AgentHub } = require('./lib/agent-hub');
const { buildMessages } = require('./lib/sender');
const qnh = require('./lib/qnh');
const qagent = require('./lib/qnh-agent');
const pdd = require('./lib/pdd');
const pddOrders = require('./lib/pdd-orders');
const aliOrders = require('./lib/ali-orders');
const psync = require('./lib/pdd-sync');
const sdc = require('./lib/sdc');

const PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

// ─────────────────────────────────────────────────────────────────────────
// HTTP 工具
// ─────────────────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  // 大响应（列表类接口常有几百 KB ~ 几 MB）按 gzip 压缩下发：浏览器原生支持，无需额外依赖
  // 小响应不压（压了反而多耗 CPU、省不了几个字节）
  const ae = String((res.req && res.req.headers && res.req.headers['accept-encoding']) || '');
  if (buf.length > 2048 && /\bgzip\b/i.test(ae)) {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      'vary': 'Accept-Encoding',
    });
    return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(buf);
}
function sendHtml(res, file) {
  // 页面本体 ~300KB 且 no-store（每次访问都重下），gzip 后约 1/5，首屏明显更快
  const buf = fs.readFileSync(path.join(ROOT, file));
  const ae = String((res.req && res.req.headers && res.req.headers['accept-encoding']) || '');
  if (/\bgzip\b/i.test(ae)) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-encoding': 'gzip',
      'vary': 'Accept-Encoding',
    });
    return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(buf);
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
// 品牌静态资源（logo / favicon）—— 与 vendor 一样白名单式下发，杜绝路径穿越
const ASSETS_DIR = path.join(ROOT, 'assets');
const ASSETS_MIME = { '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function sendAsset(req, res, rel) {
  const target = path.normalize(path.join(ASSETS_DIR, rel));
  if (!target.startsWith(ASSETS_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  const ext = path.extname(target).toLowerCase();
  if (!ASSETS_MIME[ext]) { res.writeHead(403); return res.end('forbidden'); }
  let buf;
  try { buf = fs.readFileSync(target); } catch (e) { res.writeHead(404); return res.end('not found'); }
  // 协商缓存：内容变则 URL 立即生效（否则浏览器会按 max-age 把旧图标赖一周），
  // 内容没变则回 304，不重传。品牌资源必须走这条路而不是长 max-age。
  const etag = '"' + crypto.createHash('md5').update(buf).digest('hex') + '"';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
  res.writeHead(200, { 'content-type': ASSETS_MIME[ext], 'cache-control': 'no-cache', etag });
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
  const exes = names.filter((n) => /\.exe$/i.test(n)).map((n) => {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch (e) { /* 忽略 */ }
    return { n, mtime };
  });
  if (!exes.length) return null;
  // 安装版优先；同类型里取「最新构建」的那份——不能按文件名排序，
  // 否则 0.2.0 会永远排在 0.2.6 前面，重新打包后下载页还是旧版本
  exes.sort((a, b) => {
    const score = (x) => (/setup|install/i.test(x.n) ? 0 : (/portable/i.test(x.n) ? 1 : 2));
    return score(a) - score(b) || b.mtime - a.mtime;
  });
  const file = exes[0].n;
  let size = 0;
  let mtime = 0;
  try { size = fs.statSync(path.join(dir, file)).size; mtime = fs.statSync(path.join(dir, file)).mtimeMs; } catch (e) { /* 忽略 */ }
  return { file, size, mtime };
}

/** dist/ 里全部 .exe 安装包清单（用于看板「助手安装包」管理，支持上传/删除/指定下载） */
function listAllInstallers() {
  const dir = path.join(ROOT, 'dist');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter((n) => /\.exe$/i.test(n))
    .map((n) => {
      let st = null;
      try { st = fs.statSync(path.join(dir, n)); } catch (e) { /* 忽略 */ }
      return { file: n, version: parseVerFromName(n), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 安装包上传文件名净化：只允许「基本名 + .exe」，禁路径穿越 / 目录分隔符。
 * 允许中文、字母、数字、下划线、点、短横、空格（覆盖「催收小助手-Setup-0.2.28.exe」这类命名）。
 * @returns {string} 净化后的文件名；非法返回空串
 */
function sanitizeInstallerName(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // 先拦掉任何路径分隔符 / 相对段，杜绝 a/b.exe、..\x.exe、../../x.exe 之类
  if (s.includes('/') || s.includes('\\') || s.includes('..')) return '';
  const base = path.basename(s);
  if (!base || !/^[\w.\-\u4e00-\u9fa5][\w.\-\u4e00-\u9fa5 ]*\.exe$/i.test(base)) return '';
  return base;
}

// ── 助手安装包重新打包（系统管理页一键触发）──
//    在服务器上执行 npm run agent:dist（electron-builder），产物落到 dist/，
//    下载接口按「最新构建时间」自动取包，打完即生效，无需改代码。
const agentBuild = { proc: null, running: false, startedAt: null, finishedAt: null, ok: null, error: '', log: [] };

function agentBuildStatus() {
  let ins = null;
  try { ins = findAgentInstaller(); } catch (e) { /* 忽略 */ }
  return {
    running: agentBuild.running,
    ok: agentBuild.ok,
    error: agentBuild.error || '',
    startedAt: agentBuild.startedAt,
    finishedAt: agentBuild.finishedAt,
    version: (() => { try { return require('./package.json').version; } catch (e) { return ''; } })(),
    installer: ins ? { file: ins.file, sizeBytes: ins.size, mtime: ins.mtime || 0 } : null,
    installers: listAllInstallers(),
    platform: process.platform,
    log: agentBuild.log.slice(-80),
  };
}

function startAgentBuild() {
  if (agentBuild.running) return { ok: false, error: '已有打包任务在进行中，请等它结束' };
  if (process.platform !== 'win32') {
    return { ok: false, error: `当前服务器是 ${process.platform}，nsis 安装包只能在 Windows 上构建（在 Windows 机器上运行本服务后再试）` };
  }
  agentBuild.running = true;
  agentBuild.ok = null;
  agentBuild.error = '';
  agentBuild.startedAt = new Date().toISOString();
  agentBuild.finishedAt = null;
  agentBuild.log = [`[build] ${new Date().toLocaleString('zh-CN')} 开始重新打包助手（npm run agent:dist，约 1~2 分钟）…`];

  const proc = spawn('npm run agent:dist', { cwd: ROOT, shell: true, env: process.env, windowsHide: true });
  agentBuild.proc = proc;
  const push = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      const t = line.trim();
      if (t) agentBuild.log.push(t);
    }
    if (agentBuild.log.length > 300) agentBuild.log.splice(0, agentBuild.log.length - 300);
  };
  proc.stdout.on('data', push);
  proc.stderr.on('data', push);
  proc.on('error', (e) => {
    agentBuild.running = false;
    agentBuild.ok = false;
    agentBuild.error = '启动打包进程失败：' + String((e && e.message) || e).slice(0, 200);
    agentBuild.finishedAt = new Date().toISOString();
    agentBuild.log.push('[build] ✗ ' + agentBuild.error);
    agentBuild.proc = null;
  });
  proc.on('close', (code) => {
    agentBuild.running = false;
    agentBuild.ok = code === 0;
    if (code !== 0) agentBuild.error = `打包进程退出码 ${code}，请查看日志定位`;
    agentBuild.finishedAt = new Date().toISOString();
    agentBuild.log.push(code === 0 ? '[build] ✓ 打包完成，下载页已指向新包' : `[build] ✗ 打包失败（退出码 ${code}）`);
    agentBuild.proc = null;
  });
  return { ok: true };
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
    // 服务端版本号：侧边栏品牌区展示，前端不必再为此单独请求 admin 接口
    serverVersion: SERVER_VERSION,
    // 退单列表页权限（超级管理员始终可见，普通用户由管理员逐个开启）
    qnhRefundEnabled: u.role === 'admin' ? true : !!Number(u.qnh_refund_enabled),
    // 实时毛利监控权限（同上，独立开关）
    qnhProfitEnabled: u.role === 'admin' ? true : !!Number(u.qnh_profit_enabled),
    // 拼多多发票页权限（同上，独立开关）
    pddEnabled: u.role === 'admin' ? true : !!Number(u.pdd_enabled),
    // 商品列表页权限（含补货、齐货通；超级管理员始终可见，普通用户默认关闭）
    productEnabled: u.role === 'admin' ? true : !!Number(u.product_enabled),
    // 交易市场页权限（同上，独立开关）
    marketEnabled: u.role === 'admin' ? true : !!Number(u.market_enabled),
    // 账单页权限（同上，独立开关）
    billingEnabled: u.role === 'admin' ? true : !!Number(u.billing_enabled),
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
  // （映射全员共享后按名称全局查，company→主会员名全局唯一）
  const ownerRows = await db.query(
    `SELECT DISTINCT seller_company, seller_login FROM seller_name_mapping
     WHERE seller_company IS NOT NULL AND seller_login IS NOT NULL`
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

/**
 * 批量取「这些卖家各自的待催收订单」
 * 用于组装催收任务：原来 doClientSend 对每个卖家串行调 loadSellerDetail（每家 4 条 SQL），
 * 选 100 家就是 400 次往返 —— 纯属浪费。这里一次查完并按 loginId 分组。
 * @returns {Promise<Map<string, Array<{orderId:string, amount:string}>>>}
 */
async function loadPendingOrdersBatch(userId, loginIds) {
  const out = new Map();
  const ids = Array.from(new Set((loginIds || []).filter((x) => x !== '' && x != null).map(String)));
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT COALESCE(NULLIF(seller_login,''), seller_company) AS loginId,
            order_no, pay_amount, invoice_state, pay_time
     FROM invoice_order
     WHERE user_id = ? AND COALESCE(NULLIF(seller_login,''), seller_company) IN (${ph})
     ORDER BY pay_time DESC`,
    [userId, ...ids]
  );
  for (const r of rows) {
    if (String(r.invoice_state) === 'issued') continue;
    const k = String(r.loginId);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ orderId: r.order_no, amount: Number(r.pay_amount).toFixed(2) });
  }
  return out;
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

/**
 * 发送话术用的开票抬头：一律用本账号默认抬头（app_user.company_name / tax_no / email，
 * 在「系统管理 → 用户管理 → 编辑」里由超级管理员维护）。
 * 2026-10-30 起取消「发送前选抬头」的步骤（相关菜单与 app_invoice_title 多抬头功能一并下线），
 * 三个渠道（1688 / 拼多多 / 闪电帮帮）共用同一口径，保证话术变量来源一致。
 * @param {number} userId
 * @param {number} [titleId] 忽略，保留参数仅为兼容旧调用签名
 * @returns {Promise<{companyName:string, taxNo:string, email:string, titleId:number}>}
 */
async function buyerOfSend(userId, titleId) {
  const old = await buyerInfoOf(Number(userId) || 0).catch(() => null);
  return {
    companyName: (old && old.companyName) || '',
    taxNo: (old && old.taxNo) || '',
    email: (old && old.email) || '',
    titleId: 0,
  };
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
  'agent.update.prompt': (d) => d.blocking
    ? `打开了版本更新提示（v${d.current || '?'} 已停用，需 v${d.latest || '?'}）`
    : `打开了版本更新提示（v${d.current || '?'}，宽限期还剩 ${d.days || 0} 天）`,
  'agent.bind': (d) => `绑定了本机助手${d.deviceName ? '（' + d.deviceName + '）' : ''}`,
  'agent.build': () => '重新打包了本机助手安装包',
  'qnh.sync': (d) => `在退单列表点击了「立即刷新数据」${d.ok ? '（成功）' : '（失败）'}`,
  'qnh.profit_pull': (d) => `拉取了毛利明细（${d.rows || 0} 条，告警 ${d.alerts || 0} 条）`,
  'qnh.notify_pending': (d) => `手动触发了超时退单提醒${d.ok ? `（推送 ${d.sent || 0} 条）` : '（失败）'}`,
  'qnh.login': (d) => `在退单列表点击了「登录牵牛花」刷新 Cookie${d.ok ? '（成功）' : '（失败）'}`,
  'qnh.login.start': (d) => `发起了「登录牵牛花」（${d.tenantId ? '用户 ' + d.tenantId : '本人'}）`,
  'qnh.logout': (d) => `退出了牵牛花账号`
    + (d.accountName ? `「${d.accountName}」` : '')
    + (d.agentCleared ? '（含本机登录态）' : '（本机助手未同步清除）'),
  'qnh.config': (d) => `修改了退单同步设置（${d.items}）`,
  'qnh.permit': (d) => `${d.enabled ? '开启' : '关闭'}了账号「${d.username}」的退单列表权限`,
  'qnh.view': () => '打开了退单列表页',
  'pdd.apply.start': (d) => `发起了批量申请发票任务（${d.total || 0} 单${d.invalid ? `，跳过 ${d.invalid} 单` : ''}）`,
  'pdd.apply': (d) => d.ok === false
    ? `批量申请发票失败${d.reason ? '：' + d.reason : ''}`
    : `批量申请发票完成（成功 ${d.okCount || 0} 单、失败 ${d.failCount || 0} 单）`,
  'pdd.send.start': (d) => `发起了拼多多批量催商家开票（${d.total || 0} 个商家${d.invalid ? `，跳过 ${d.invalid} 单` : ''}）`,
  'pdd.send': (d) => d.ok === false
    ? `拼多多批量催收失败${d.reason ? '：' + d.reason : ''}`
    : `拼多多批量催收完成（成功 ${d.okCount || 0} 个商家、失败 ${d.failCount || 0} 个）`,
  'pdd.sync': (d) => `刷新了拼多多发票状态${d.ok ? '（' + (d.total || 0) + ' 条）' : '（失败）'}`,
  'pdd.orders.sync': (d) => `拉取了拼多多全部订单${d.full ? '（全量）' : '（增量）'}`, 
  'ali.orders.sync': (d) => `同步了 1688 订单${d.startDateTime ? '（起 ' + d.startDateTime + '）' : ''}`,
  'pdd.login.start': (d) => `发起了「登录拼多多」（${d.tenantId ? '用户 ' + d.tenantId : '本人'}）`,
  'pdd.login': (d) => `登录拼多多${d.ok ? '（成功）' : '（失败）'}`,
  'pdd.logout': (d) => `退出了拼多多账号`
    + (d.accountName ? `「${d.accountName}」` : '')
    + (d.pdduid ? `（ID ${d.pdduid}）` : '')
    + (d.agentCleared ? '（含本机登录态）' : '（本机助手未同步清除）'),
  'sdc.view': () => '打开了闪电帮帮发票页',
  'sdc.login.start': (d) => `发起了「登录闪电帮帮」（${d.tenantId ? '用户 ' + d.tenantId : '本人'}）`,
  'sdc.login': (d) => `登录闪电帮帮${d.ok ? '（成功）' : '（失败）'}`,
  'sdc.logout': (d) => `退出了闪电帮帮账号`
    + (d.accountName ? `「${d.accountName}」` : '')
    + (d.agentCleared ? '（含本机登录态）' : '（本机助手未同步清除）'),
  'sdc.sync': (d) => d.ok === false
    ? `拉取闪电帮帮订单失败${d.reason ? '：' + d.reason : ''}`
    : `拉取了闪电帮帮订单（可申请 ${d.applyable || 0} 单、已申请 ${d.applied || 0} 单）`,
  'sdc.send.start': (d) => `发起了闪电帮帮批量催收（${d.total || 0} 家店铺${d.title ? '，抬头 ' + d.title : ''}）`,
  'sdc.send': (d) => d.ok === false
    ? `闪电帮帮批量催收失败${d.reason ? '：' + d.reason : ''}`
    : `闪电帮帮批量催收完成（成功 ${d.okCount || 0} 家、失败 ${d.failCount || 0} 家）`,
};

// 前端下拉是「值」，日志里要显示人能看懂的「文案」，在服务端做映射，避免客户端乱传
const OP_COLLECT_LABELS = { '': '不限', collected: '已催收', '7': '最近一周未催收', '15': '最近半个月未催收', '30': '最近一个月未催收', '90': '最近三个月未催收' };
const OP_INVOICE_LABELS = { '': '全部', invoiced: '已开票', pending: '未开票' };

/**
 * 页脚版权文案。
 * 归属主体写在 config.json 的 `copyright` 里（系统级设置，多租户共用一套），
 * 不写死在本文件里——换主体/换年度都不用改代码；没配就用系统名兜底。
 */
function copyrightText() {
  let owner = '';
  try {
    const c = loadConfig();
    owner = String((c && c.copyright) || '').trim();
  } catch (e) { /* 配置读不到不影响页面渲染 */ }
  return '© ' + new Date().getFullYear() + ' ' + (owner || '发票催收系统') + ' · 保留所有权利';
}

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

// ── 「登录牵牛花」任务：本机会话采集登录态后回传 ────────────
//   服务器自己不再启动浏览器（云端没有显示器，也没有 Playwright 浏览器二进制）。
//   服务器只做三件事：登记任务 → 通过本机助手通道下发 → 收回助手采集的登录态入库。
const QNH_LOGINS = new Map();                  // taskId -> ctx
const QNH_LOGIN_TIMEOUT_MS = Number(process.env.QNH_LOGIN_TIMEOUT_MS) || 5 * 60 * 1000;
const QNH_LOGIN_TTL_MS = QNH_LOGIN_TIMEOUT_MS + 60 * 1000;   // 任务记录在内存里的最长存活
// 支持「登录牵牛花」的最低助手版本：旧版助手没有该能力，得让用户先升级，
// 否则点了没反应、干等 5 分钟才超时，体验很差。
const QNH_LOGIN_MIN_AGENT = '0.2.6';

/** 语义化版本比较：a >= b ? */
function verGte(a, b) {
  const pa = String(a || '').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 助手版本策略（2026-10-26 起）
//
// 背景：上面那些 *_MIN_AGENT 只卡「协议能力」——旧助手不认识新指令才会被拦。
// 像 0.2.26 这种「协议没变、只重构发送性能」的版本，老助手照样连得上、照样发，
// 只是又慢又停不下来。所以补一条不依赖协议变化的通用版本线。
//
// · 版本权威 = 服务端 package.json 的 version（助手与服务端同仓同版本，既定约定）；
//   也可用 runtime.agentMinVersion 手动钉死，紧急情况脱离代码单独划线。
// · 宽限期：服务端升级（= 进程重启）后 agentUpdateGraceDays 天内**只提示不拦**，
//   避免半夜部署把正在跑批量发送的用户直接打死；到期后才硬卡。
//
// ⚠ 硬拦截的前提是「服务端真能给出一个版本号 ≥ 最低要求的下载包」：
//   容器里 dist/ 来自构建时 COPY，而 dist 在 .gitignore 里、git pull 拿不到，
//   线上很可能是空的/旧的。真发生了「必须更新却下载不到」= 把所有人的活全锁死。
//   所以拿不到合格包时一律降级为提示，绝不硬拦。
// ═══════════════════════════════════════════════════════════════════════════
const SERVER_VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; }
})();
const BOOT_AT = Date.now();   // 进程启动 = 服务端本次升级的时刻，宽限期从这里起算

/** 从安装包文件名解析版本号：催收小助手-Setup-0.2.26.exe → 0.2.26 */
function parseVerFromName(name) {
  const m = String(name || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
}

/** 当前版本策略（每次调用都重读配置，改完立刻生效，无需重启） */
function agentUpdatePolicy() {
  const rt = (loadConfig().runtime) || {};
  const latest = SERVER_VERSION;
  const minCfg = String(rt.agentMinVersion || '').trim();
  const min = /^\d+(\.\d+){0,2}$/.test(minCfg) ? minCfg : latest;
  // 未配置 → 默认给 3 天宽限；显式配 0 → 立即硬卡
  const graceNum = Number(rt.agentUpdateGraceDays);
  const graceDays = Number.isFinite(graceNum) && graceNum >= 0 ? Math.min(30, Math.floor(graceNum)) : 3;
  const graceMs = graceDays * 86400000;
  const graceUntil = BOOT_AT + graceMs;
  const ins = findAgentInstaller();
  const insVer = ins ? parseVerFromName(ins.file) : '';
  const extUrl = String(rt.agentInstallerUrl || '').trim();
  // localOk = dist 里有一份版本合格的安装包；extUrl = 管理员配了外部直链（版本无法校验，但假定它会跟着更新）
  const localOk = !!(ins && insVer && verGte(insVer, min));
  const source = localOk ? 'dist' : (extUrl ? 'external' : 'none');
  return {
    latest, min,
    graceDays: Math.round(graceMs / 86400000),
    graceUntil,
    expired: Date.now() >= graceUntil,
    packVersion: insVer || (extUrl ? latest : ''),
    // packOk = 「用户真的能拿到新版」——硬拦截的唯一前提
    packOk: localOk || !!extUrl,
    source,
    updateUrl: extUrl || (ins ? '/api/agent/download-exe' : ''),
    fileName: ins ? ins.file : '',
  };
}

/** 某个用户的助手相对当前策略的状态 */
function checkAgentVersion(uid) {
  const pol = agentUpdatePolicy();
  const st = agentHub.status(uid);
  const current = String(st.agentVer || '');
  // current 为空（老助手不上报版本）→ 不判定为过期：能力门禁那几个 *_MIN_AGENT 已经兜住了
  const outdated = !!current && !!pol.min && !verGte(current, pol.min);
  return {
    ...pol,
    online: !!st.online,
    current,
    outdated,
    updateAvailable: outdated && pol.packOk,
    blocking: outdated && pol.packOk && pol.expired,   // 该拦了：版本旧 + 能更新 + 过了宽限期
  };
}

/**
 * 统一版本门禁。要在执行任何「依赖助手」的操作前调用。
 * @returns {boolean} true = 放行；false = 已写回响应并拒绝（调用方直接 return）
 */
function agentVersionGate(res, uid, action) {
  const v = checkAgentVersion(uid);
  // 拿不到新版就绝不拦人 —— 提示一下就好，别把活卡死
  if (!v.outdated || !v.packOk || !v.expired) return true;
  sendJson(res, 200, {
    ok: false,
    // needAgent=true：复用前端既有的「助手这边有问题」分流 → promptAgentIssue → 弹「去下载」
    needAgent: true,
    agentOutdated: true,
    fromVersionGate: true,
    updateUrl: v.updateUrl,
    agentCurrent: v.current,
    agentLatest: v.min,
    message: `这台电脑上的催收小助手是 v${v.current}，版本过旧，${action}需要 v${v.min} 及以上。`
      + `请先点页面右上角「下载本机助手」更新后再操作。`,
  });
  return false;
}

// ── 「登录拼多多」任务：与牵牛花同一套路（本机助手弹窗登录 → Cookie 回传入库）──
const PDD_LOGINS = new Map();                  // taskId -> ctx
const PDD_LOGIN_TIMEOUT_MS = Number(process.env.PDD_LOGIN_TIMEOUT_MS) || 5 * 60 * 1000;
const PDD_LOGIN_TTL_MS = PDD_LOGIN_TIMEOUT_MS + 60 * 1000;
// 支持「登录拼多多」的最低助手版本
const PDD_LOGIN_MIN_AGENT = '0.2.18';

// ── 「登录1688」任务：与拼多多同一套路（本机助手弹窗登录 → Cookie 回传写 ali-cookie.txt）──
const ALI_LOGINS = new Map();                  // taskId -> ctx
const ALI_LOGIN_TIMEOUT_MS = Number(process.env.ALI_LOGIN_TIMEOUT_MS) || 5 * 60 * 1000;
const ALI_LOGIN_TTL_MS = ALI_LOGIN_TIMEOUT_MS + 60 * 1000;
// 支持「登录1688」的最低助手版本（0.2.72 起助手才有 ali_login 内核）
const ALI_LOGIN_MIN_AGENT = '0.2.72';

// ── 拼多多「页内操作」任务：助手加载真实页面执行（anti-content 由页面风控 SDK 生成）──
//    kind='apply' 申请发票（开票页点提交） / kind='send' 催商家开票（聊天页发消息）
const PDD_TASKS = new Map();                   // taskId -> ctx
// ── 1688 订单同步任务：从「库里最近订单时间」往后翻页拉全部订单 ──
//    与 PDD_TASKS 同构，前端轮询进度即可；不落库，进程重启后作废（订单本身已入库）
const ALI_TASKS = new Map();                   // taskId -> ctx
const ALI_TASK_TTL_MS = 60 * 60 * 1000;        // 完成后保留 1 小时供前端读最终状态
const PDD_APPLY_TIMEOUT_MS = Number(process.env.PDD_APPLY_TIMEOUT_MS) || 10 * 60 * 1000;
const PDD_APPLY_TTL_MS = PDD_APPLY_TIMEOUT_MS + 5 * 60 * 1000;
// 支持「申请发票」的最低助手版本
const PDD_APPLY_MIN_AGENT = '0.2.21';   // 0.2.21 起：CDP 抓包判成败 + 页面就绪再点（修「等待结果超时」）
// 支持「催商家开票」的最低助手版本（0.2.23 起才有 pdd_send 内核）
const PDD_SEND_MIN_AGENT = '0.2.23';

// ── 闪电帮帮任务：登录 / 拉订单 / 批量催收（三项都必须在本机助手的浏览器里跑）──
//    原因：该站点网关要 mtgsig 签名，服务器直连 403；只有页面上下文的 fetch 会自动被签名。
const SDC_LOGINS = new Map();                  // taskId -> ctx（登录）
const SDC_TASKS = new Map();                   // taskId -> ctx（sync 取数 / send 催收）
const SDC_LOGIN_TIMEOUT_MS = Number(process.env.SDC_LOGIN_TIMEOUT_MS) || 5 * 60 * 1000;
const SDC_LOGIN_TTL_MS = SDC_LOGIN_TIMEOUT_MS + 60 * 1000;
const SDC_TASK_TIMEOUT_MS = Number(process.env.SDC_TASK_TIMEOUT_MS) || 15 * 60 * 1000;
const SDC_TASK_TTL_MS = SDC_TASK_TIMEOUT_MS + 5 * 60 * 1000;
// 支持闪电帮帮三项能力的最低助手版本（0.2.55 起才有 sdc_login / sdc_fetch / sdc_send 内核）
const SDC_MIN_AGENT = '0.2.67';

// ── 「清除本机登录态」──────────────────────────────────────────────
// 看板点「退出 XX 账号」时，光删数据库里的 Cookie 不够：助手那边的登录窗口用的是
// Electron 持久分区（persist:pdd / persist:qnh），Cookie 还在用户本机上，下次点「登录」
// 会直接免登录进去 —— 表现为「退出了却没退掉 / 换不了号」。
// 所以退出时顺带下发一条 logout 指令，让助手把本机分区一起清掉，并等它回执。
const LOGOUT_MIN_AGENT = '0.2.24';   // 0.2.24 起助手才认识 logout 指令
const AGENT_LOGOUTS = new Map();     // taskId -> { resolve, timer }
const AGENT_LOGOUT_TIMEOUT_MS = 6000;

/**
 * 让该用户的本机助手清掉某个站点的登录态，等回执（最多 6 秒）。
 * 助手不在线 / 版本太旧 / 不回应，都如实返回原因，由调用方写进提示语 ——
 * 不能假装清了（用户下次登录会莫名还是旧账号）。
 * @param {number} uid
 * @param {'pdd'|'qnh'|'1688'} target
 * @returns {Promise<{ok:boolean,offline?:boolean,outdated?:boolean,timeout?:boolean,agentVer?:string,cleared?:number,error?:string}>}
 */
function agentLogout(uid, target) {
  return new Promise((resolve) => {
    if (!agentHub.isOnline(uid)) { resolve({ ok: false, offline: true }); return; }
    const agentVer = agentHub.status(uid).agentVer || '';
    if (agentVer && !verGte(agentVer, LOGOUT_MIN_AGENT)) {
      resolve({ ok: false, outdated: true, agentVer });
      return;
    }
    const taskId = 'lo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(() => {
      AGENT_LOGOUTS.delete(taskId);
      resolve({ ok: false, timeout: true });
    }, AGENT_LOGOUT_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    AGENT_LOGOUTS.set(taskId, { resolve, timer });
    const sent = agentHub.send(uid, { type: 'logout', taskId, target });
    if (!sent) {
      clearTimeout(timer);
      AGENT_LOGOUTS.delete(taskId);
      resolve({ ok: false, offline: true });
    }
  });
}

/** 助手回报「清除本机登录态」结果 */
function onAgentLogoutDone(uid, msg) {
  const taskId = String((msg && msg.taskId) || '');
  const ctx = AGENT_LOGOUTS.get(taskId);
  if (!ctx) return;
  clearTimeout(ctx.timer);
  AGENT_LOGOUTS.delete(taskId);
  const label = msg.label || msg.target || '';
  console.log(`[agent] uid=${uid} 清除本机${label}登录态：${msg.ok ? '成功' : '失败 ' + (msg.error || '')}`);
  ctx.resolve({
    ok: !!msg.ok,
    target: msg.target || '',
    cleared: Number(msg.cleared) || 0,
    error: msg.ok ? '' : String(msg.error || '助手清除登录态失败').slice(0, 200),
  });
}

/**
 * 把「本机登录态有没有一起清掉」翻译成一句人话（拼多多与牵牛花共用）。
 * @param {object} agent agentLogout 的返回值
 * @param {string} name  '拼多多' / '牵牛花'
 */
function logoutAgentNote(agent, name) {
  const a = agent || {};
  if (a.ok) return '本机助手里的登录态也已一并退出。';
  if (a.offline) {
    return `本机助手当前未连接，本机浏览器里的登录态没被退出：下次点「登录${name}」如果还是旧账号，`
      + `请在助手面板「本机登录态」里点「${name} · 退出」再登录。`;
  }
  if (a.outdated) {
    return `本机助手是 v${a.agentVer}，不支持自动退出本机登录态：升级助手，或在助手面板点「${name} · 退出」。`;
  }
  if (a.timeout) {
    return `本机助手没有回应退出指令，本机登录态可能还在：请在助手面板点「${name} · 退出」。`;
  }
  return `本机助手退出登录态失败（${a.error || '未知原因'}），请在助手面板点「${name} · 退出」。`;
}

/**
 * 这次动作该下发给哪台本机助手？
 *
 * 默认是「数据归属用户」自己的助手。但管理员以他人身份进入（?tenant=<id>）时，
 * 那台电脑上通常没有助手，而管理员自己电脑上的助手是在线的 —— 登录/申请/发送
 * 只需要一台能真干活的助手，登录态照样写进被代入用户的库。
 * 所以：目标用户的助手在线就用它，否则退回到「当前登录用户」（管理员本机）的助手。
 *
 * @param {{id:number}} user     当前登录用户
 * @param {number} tenantId      数据归属用户
 * @returns {number|null} 在线助手所属的 userId；都没在线则 null
 */
function agentUidFor(user, tenantId) {
  const t = Number(tenantId);
  if (agentHub.isOnline(t)) return t;
  const me = Number(user && user.id);
  if (me && me !== t && agentHub.isOnline(me)) return me;
  return null;
}

/** 用户/租户的展示名（公司全称优先），只用于提示文案 */
async function tenantLabelOf(uid) {
  try {
    const r = await db.query('SELECT username, company_name FROM app_user WHERE id = ?', [Number(uid)]);
    const u = r[0] || null;
    return u ? (u.company_name || u.username || '') : '';
  } catch (e) { return ''; }
}

/** 定期清掉没人管的登录任务（用户点了又不登录），避免内存堆积 */
const qnhLoginSweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, c] of QNH_LOGINS) if (now > c.expiresAt) QNH_LOGINS.delete(id);
  for (const [id, c] of PDD_LOGINS) if (now > c.expiresAt) PDD_LOGINS.delete(id);
  for (const [id, c] of PDD_TASKS) if (now > c.expiresAt && c.status !== 'pending') PDD_TASKS.delete(id);
  for (const [id, c] of SDC_LOGINS) if (now > c.expiresAt) SDC_LOGINS.delete(id);
  for (const [id, c] of SDC_TASKS) if (now > c.expiresAt && c.status !== 'pending') SDC_TASKS.delete(id);
}, 60000);
if (qnhLoginSweeper.unref) qnhLoginSweeper.unref();

// ── 「牵牛花页内签名请求」通道：把配送日志 / 毛利明细等签名请求派给本机助手 ──
//    服务器 Cookie 直连这些接口会被 WAF 拦（403），只有助手真实页面里的 fetch 能自动签名。
const QNH_FETCH_MIN_AGENT = '0.2.9';

/**
 * 找一个在线且版本足够的助手。
 * wantUid 指定时只找该用户的助手（按用户隔离：用谁的牵牛花登录态就派给谁的助手）；
 * 不指定时沿用旧行为：任选一个在线且版本足够的助手。
 */
function findQnhAgent(wantUid) {
  const target = Number(wantUid) || 0;
  for (const [uid] of agentHub.conns) {
    if (!agentHub.isOnline(uid)) continue;
    if (target && Number(uid) !== target) continue;
    const ver = agentHub.status(uid).agentVer || '';
    if (ver && !verGte(ver, QNH_FETCH_MIN_AGENT)) continue;
    return { uid, ver };
  }
  return null;
}

qagent.setTransport({
  findAgent: findQnhAgent,
  send: (uid, msg) => agentHub.send(uid, msg),
});

/** 助手回报登录结果：把登录态入库，并标记任务完成/失败 */
function onQnhLoginDone(uid, msg) {
  const ctx = QNH_LOGINS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  if (!msg.ok) {
    ctx.status = 'failed';
    ctx.message = String(msg.error || '助手未采集到登录态').slice(0, 300);
    logOp(Number(uid), 'qnh.login', { ok: false });
    return;
  }
  qnh.saveLoginState({
    userId: ctx.userId,
    cookies: msg.cookies,
    account: msg.account,
    tenantId: msg.tenantId,
    agentVer: msg.agentVer,
  }).then((r) => {
    if (!r.ok) {
      ctx.status = 'failed';
      ctx.message = r.message || '保存登录态失败';
      logOp(Number(uid), 'qnh.login', { ok: false });
      return;
    }
    ctx.status = 'done';
    ctx.cookieCount = r.cookieCount;
    ctx.writtenAt = r.writtenAt;
    ctx.message = `登录态已更新（${r.cookieCount} 个 Cookie）`;
    logOp(Number(uid), 'qnh.login', { ok: true });
  }).catch((e) => {
    ctx.status = 'failed';
    ctx.message = '保存登录态失败：' + String((e && e.message) || e).slice(0, 200);
    logOp(Number(uid), 'qnh.login', { ok: false });
  });
}

/**
 * 助手回报「登录拼多多」结果：Cookie 串入库（pdd_session），并标记任务完成/失败。
 * 与牵牛花的差别：牵牛花存结构化 cookies 数组，拼多多只需要一整条 Cookie 串 + pdduid。
 */
function onPddLoginDone(uid, msg) {
  const ctx = PDD_LOGINS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  if (!msg.ok) {
    ctx.status = 'failed';
    ctx.message = String(msg.error || '助手未采集到登录态').slice(0, 300);
    logOp(Number(uid), 'pdd.login', { ok: false });
    return;
  }
  const cookie = String(msg.cookie || '').trim();
  if (!cookie) {
    ctx.status = 'failed';
    ctx.message = '助手回传的登录态为空，请重新登录';
    logOp(Number(uid), 'pdd.login', { ok: false });
    return;
  }
  pdd.saveSession({
    userId: ctx.userId,
    cookie,
    pdduid: msg.pdduid,
    accountName: msg.account || msg.accountName || '',
    source: 'agent',
    agentVer: msg.agentVer,
  }).then(() => {
    ctx.status = 'done';
    ctx.cookieCount = String(cookie).split(';').filter((s) => s.trim()).length;
    ctx.writtenAt = new Date();
    ctx.message = `登录态已更新（${ctx.cookieCount} 个 Cookie）`;
    logOp(Number(uid), 'pdd.login', { ok: true });
    // 登录后立刻把昵称拉回来（接口不需要风控签名），页面顶部即可显示「登录的是哪个账号」
    pdd.refreshProfile(ctx.userId).then((p) => {
      if (p && p.ok && p.nickname) ctx.accountName = p.nickname;
    }).catch(() => {});
  }).catch((e) => {
    ctx.status = 'failed';
    ctx.message = '保存登录态失败：' + String((e && e.message) || e).slice(0, 200);
    logOp(Number(uid), 'pdd.login', { ok: false });
  });
}

/**
 * 助手回报「登录1688」结果：把 Cookie 串写进 data/ali-cookie.txt（mtop 直连取数用的就是它）。
 * 与拼多多不同：1688 的服务器侧登录态是文件不是数据库 —— saveCookie / clearCookie 都在 lib/ali-orders.js。
 */
function onAliLoginDone(uid, msg) {
  const ctx = ALI_LOGINS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  if (!msg.ok) {
    ctx.status = 'failed';
    ctx.message = String(msg.error || '助手未采集到登录态').slice(0, 300);
    logOp(Number(uid), 'ali.login', { ok: false });
    return;
  }
  const cookie = String(msg.cookie || '').trim();
  if (!cookie) {
    ctx.status = 'failed';
    ctx.message = '助手回传的登录态为空，请重新登录';
    logOp(Number(uid), 'ali.login', { ok: false });
    return;
  }
  try {
    const r = aliOrders.saveCookie(cookie);
    ctx.status = 'done';
    ctx.cookieCount = cookie.split(';').filter((s) => s.trim()).length;
    ctx.writtenAt = new Date();
    ctx.message = `登录态已更新（${ctx.cookieCount} 个 Cookie${r && r.envOverridden ? '，注意环境变量 ALI_COOKIE 仍在生效' : ''}）`;
    logOp(Number(uid), 'ali.login', { ok: true });
  } catch (e) {
    ctx.status = 'failed';
    ctx.message = '保存登录态失败：' + String((e && e.message) || e).slice(0, 200);
    logOp(Number(uid), 'ali.login', { ok: false });
  }
}

/**
 * 助手回报「批量申请发票」结果：逐条落 pdd_apply_log，并标记任务完成。
 */
function onPddApplyDone(uid, msg) {
  const ctx = PDD_TASKS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.kind !== 'apply' || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  const results = Array.isArray(msg.results) ? msg.results : [];
  ctx.results = results;
  ctx.okCount = Number(msg.okCount) || results.filter((r) => r.ok).length;
  ctx.failCount = Number(msg.failCount) || (results.length - ctx.okCount);

  // 无论整体成败，先把每一条结果落库（不吞错：写失败只告警，不影响任务状态）
  pdd.logApply(ctx.userId, results);

  // 提交成功的订单打「已申请(8)」中间态：不可再勾选申请，等下次同步被真实状态覆盖
  const okSns = results.filter((r) => r.ok).map((r) => r.order_sn);
  if (okSns.length) {
    pdd.markApplied(ctx.userId, okSns).then((n) => {
      if (n) console.log(`[pdd] 已把 ${n} 单标记为「已申请」（user ${ctx.userId}）`);
    });
  }

  if (!msg.ok && !results.length) {
    ctx.status = 'failed';
    ctx.message = String(msg.error || '助手执行申请失败').slice(0, 300);
    ctx.finishedAt = new Date();
    logOp(Number(uid), 'pdd.apply', { ok: false, tenantId: ctx.userId, reason: ctx.message });
    return;
  }
  ctx.status = 'done';
  ctx.finishedAt = new Date();
  ctx.message = `申请提交完成：成功 ${ctx.okCount} 单、失败 ${ctx.failCount} 单`
    + (msg.stopped ? '（中途停止）' : '');
  logOp(Number(uid), 'pdd.apply', { ok: ctx.okCount > 0, okCount: ctx.okCount, failCount: ctx.failCount, tenantId: ctx.userId });
}

/**
 * 助手逐单上报「页内任务」进度（index/total/order_sn/ok/detail）：
 * 记进任务上下文供 task-status 轮询返回；同时打到服务端控制台留排查痕迹。
 */
function onPddApplyProgress(uid, msg) {
  const ctx = PDD_TASKS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  const isSend = ctx.kind === 'send';
  const idx = Number(msg.index) || 0;
  const total = Number(msg.total) || ctx.total;
  ctx.progress = {
    index: idx, total,
    current: String(msg.order_sn || ''),
    okCount: Number(msg.okCount) || 0,
    failCount: Number(msg.failCount) || 0,
    lastOk: !!msg.ok,
    lastDetail: String(msg.detail || '').slice(0, 200),
    updatedAt: Date.now(),
  };
  if (msg.order_sn) {
    ctx.progressLog = ctx.progressLog || [];
    ctx.progressLog.push({
      t: new Date().toISOString().slice(11, 19),
      text: `[${idx}/${total}] ${msg.order_sn} → ${msg.ok
        ? (isSend ? '✓ 已发送' : '✓ 已提交')
        : '✗ ' + (msg.detail || '失败')}`,
    });
    if (ctx.progressLog.length > 300) ctx.progressLog.splice(0, ctx.progressLog.length - 300);
  }
  console.log(`[pdd-${ctx.kind}] user=${uid} task=${ctx.taskId} [${idx}/${total}] ${msg.order_sn || ''} `
    + `${msg.ok ? 'OK' : 'FAIL ' + (msg.detail || '')}`);
}

/**
 * 助手回报「催商家开票」结果：逐条落 pdd_msg_log，并标记任务完成。
 * 与申请的区别：发消息不改变订单状态（只是提醒），所以不写 pdd_order。
 */
function onPddSendDone(uid, msg) {
  const ctx = PDD_TASKS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.kind !== 'send' || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  const results = Array.isArray(msg.results) ? msg.results : [];
  ctx.results = results;
  ctx.okCount = Number(msg.okCount) || results.filter((r) => r.ok).length;
  ctx.failCount = Number(msg.failCount) || (results.length - ctx.okCount);

  pdd.logMsg(ctx.userId, results);

  if (!msg.ok && !results.length) {
    ctx.status = 'failed';
    ctx.message = String(msg.error || '助手执行催收失败').slice(0, 300);
    ctx.finishedAt = new Date();
    logOp(Number(uid), 'pdd.send', { ok: false, tenantId: ctx.userId, reason: ctx.message });
    return;
  }
  ctx.status = 'done';
  ctx.finishedAt = new Date();
  ctx.message = `催收消息发送完成：成功 ${ctx.okCount} 个商家、失败 ${ctx.failCount} 个`
    + (msg.stopped ? '（中途停止）' : '');
  logOp(Number(uid), 'pdd.send', {
    ok: ctx.okCount > 0, okCount: ctx.okCount, failCount: ctx.failCount, tenantId: ctx.userId,
  });
}

/**
 * 助手回报「登录闪电帮帮」结果：写台账（不写 Cookie，登录态始终留在本机浏览器分区里）。
 */
function onSdcLoginDone(uid, msg) {
  const ctx = SDC_LOGINS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  if (!msg.ok) {
    ctx.status = 'failed';
    ctx.message = String(msg.error || '助手执行登录失败').slice(0, 300);
    ctx.finishedAt = new Date();
    logOp(Number(uid), 'sdc.login', { ok: false, tenantId: ctx.userId, reason: ctx.message });
    return;
  }
  ctx.status = 'done';
  ctx.subUserId = String(msg.subUserId || '');
  ctx.accountName = String(msg.accountName || '');
  ctx.finishedAt = new Date();
  ctx.message = `登录成功${ctx.accountName ? '：' + ctx.accountName : ''}`;
  sdc.upsertSession(ctx.userId, { subUserId: ctx.subUserId, accountName: ctx.accountName, agentVer: msg.agentVer || '', source: '本机助手' })
    .catch((e) => console.warn(`[sdc] 登录台账写入失败：${(e && e.message) || e}`));
  logOp(Number(uid), 'sdc.login', { ok: true, tenantId: ctx.userId, accountName: ctx.accountName });
}

/**
 * 助手分批回传订单行：边收边入库（避免等全部拉完才写，中途失败也留住已拿到的部分）。
 */
function onSdcFetchPage(uid, msg) {
  const ctx = SDC_TASKS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.kind !== 'sync' || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  const rows = Array.isArray(msg.rows) ? msg.rows : [];
  if (!rows.length) return;
  ctx.received += rows.length;
  sdc.saveOrders(ctx.userId, rows)
    .then((r) => {
      ctx.inserted += r.inserted; ctx.updated += r.updated; ctx.skipped += r.skipped;
      ctx.progress = `已回传 ${ctx.received} 单（新增 ${ctx.inserted} / 更新 ${ctx.updated} / 无变化 ${ctx.skipped}）`;
    })
    .catch((e) => { ctx.lastError = String((e && e.message) || e).slice(0, 200); });
}

/** 助手跑完取数：收尾 + 写同步时间 + 留痕 */
function onSdcFetchDone(uid, msg) {
  const ctx = SDC_TASKS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.kind !== 'sync' || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  const tally = msg.tally || {};
  const gotAny = Object.values(tally).some((t) => t && Number(t.rows) > 0);
  sdc.touchSync(ctx.userId).catch(() => null);
  if (!msg.ok && !gotAny) {
    ctx.status = 'failed';
    ctx.message = String(msg.error || '助手拉取订单失败').slice(0, 300);
    ctx.finishedAt = new Date();
    logOp(Number(uid), 'sdc.sync', { ok: false, tenantId: ctx.userId, reason: ctx.message });
    return;
  }
  ctx.status = 'done';
  ctx.finishedAt = new Date();
  ctx.tally = tally;
  ctx.loginish = !!msg.loginish;
  ctx.message = String(msg.error || '')
    ? `拉取完成（部分档位失败：${String(msg.error).slice(0, 120)}）`
    : `拉取完成：新增 ${ctx.inserted} 单、更新 ${ctx.updated} 单`;
  logOp(Number(uid), 'sdc.sync', {
    ok: true, tenantId: ctx.userId,
    applyable: (tally['1'] && tally['1'].rows) || 0,
    applied: (tally['2'] && tally['2'].rows) || 0,
  });
}

/** 助手每处理完一家店回执一次（sdc_send_progress）：实时刷新「第 N/M 家 · 当前店名 · 成功/失败」 */
function onSdcSendProgress(uid, msg) {
  const ctx = SDC_TASKS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.kind !== 'send' || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  if (Array.isArray(msg.results)) ctx.results = msg.results;
  ctx.doneIdx = Number(msg.done) || (ctx.results || []).length;
  ctx.current = String(msg.current || '').slice(0, 128);
  ctx.okCount = Number(msg.okCount) || (ctx.results || []).filter((r) => r && r.ok).length;
  ctx.failCount = Number(msg.failCount) || Math.max(0, (ctx.results || []).length - ctx.okCount);
  ctx.progressGauged = true;   // 有了精确回执就不再从日志里猜
}

/**
 * 兜底：从助手日志行里认「▶ 第 1/5 家：XX店（会话 xxx）」与「✓/✗ 店名：…」，
 * 给还没升级到会报 sdc_send_progress 的助手也凑出可用的进度数字。
 * 认不出来就什么都不做（保持上一次的值），绝不让进度倒退。
 */
function guessSdcProgress(ctx, text) {
  if (ctx.progressGauged) return;
  const head = /第\s*(\d+)\s*\/\s*(\d+)\s*家[：:]\s*([^（(]+)/.exec(text);
  if (head) {
    const n = Number(head[1]);
    if (Number.isFinite(n) && n > 0) {
      ctx.doneIdx = n;
      ctx.current = String(head[3] || '').trim().slice(0, 128);
    }
    return;
  }
  if (/^\s*✓/.test(text)) {
    ctx.okCount = Number(ctx.okCount || 0) + 1;
    ctx.doneIdx = Math.min(Number(ctx.total) || 0, Number(ctx.doneIdx || 0) + 1);
  } else if (/^\s*✗/.test(text)) {
    ctx.failCount = Number(ctx.failCount || 0) + 1;
    ctx.doneIdx = Math.min(Number(ctx.total) || 0, Number(ctx.doneIdx || 0) + 1);
  }
}

/** 助手回报「闪电帮帮批量催收」结果：逐店铺落 sdc_msg_log，并按店铺回写订单的催收次数 */
function onSdcSendDone(uid, msg) {
  const ctx = SDC_TASKS.get(String((msg && msg.taskId) || ''));
  if (!ctx || ctx.kind !== 'send' || ctx.userId !== Number(uid) || ctx.status !== 'pending') return;
  const results = Array.isArray(msg.results) ? msg.results : [];
  ctx.results = results;
  ctx.okCount = Number(msg.okCount) || results.filter((r) => r.ok).length;
  ctx.failCount = Number(msg.failCount) || (results.length - ctx.okCount);
  sdc.logMsg(ctx.userId, results).catch((e) => console.warn(`[sdc] 催收日志写入失败：${(e && e.message) || e}`));
  if (!msg.ok && !results.length) {
    ctx.status = 'failed';
    ctx.message = String(msg.error || '助手执行催收失败').slice(0, 300);
    ctx.finishedAt = new Date();
    logOp(Number(uid), 'sdc.send', { ok: false, tenantId: ctx.userId, reason: ctx.message });
    return;
  }
  ctx.status = 'done';
  ctx.finishedAt = new Date();
  ctx.message = '催收消息发送完成：'
    + `成功 ${ctx.okCount} 家店铺、失败 ${ctx.failCount} 家` + (msg.stopped ? '（中途停止）' : '');
  logOp(Number(uid), 'sdc.send', {
    ok: ctx.okCount > 0, okCount: ctx.okCount, failCount: ctx.failCount, tenantId: ctx.userId,
  });
}

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
  // 「登录牵牛花」：助手在本机开窗口让用户登录，完成后把 Cookie 回传
  if (msg.type === 'qnh_login_done') { onQnhLoginDone(uid, msg); return; }
  if (msg.type === 'pdd_login_done') { onPddLoginDone(uid, msg); return; }
  if (msg.type === 'ali_login_done') { onAliLoginDone(uid, msg); return; }
  if (msg.type === 'pdd_apply_done') { onPddApplyDone(uid, msg); return; }
  if (msg.type === 'pdd_apply_progress') { onPddApplyProgress(uid, msg); return; }
  if (msg.type === 'pdd_send_done') { onPddSendDone(uid, msg); return; }
  if (msg.type === 'pdd_send_progress') { onPddApplyProgress(uid, msg); return; }
  // ── 闪电帮帮：登录 / 取数（分批回传）/ 批量催收 ──
  if (msg.type === 'sdc_login_done') { onSdcLoginDone(uid, msg); return; }
  if (msg.type === 'sdc_fetch_page') { onSdcFetchPage(uid, msg); return; }
  if (msg.type === 'sdc_fetch_done') { onSdcFetchDone(uid, msg); return; }
  if (msg.type === 'sdc_send_done') { onSdcSendDone(uid, msg); return; }
  // 助手每处理完一家店回执一次：进度面板就能像 1688 那样显示「第 N/M 家 · 当前 XX店 · 成功x 失败y」
  if (msg.type === 'sdc_send_progress') { onSdcSendProgress(uid, msg); return; }
  // 「牵牛花页内签名请求」：助手回传配送日志 / 毛利明细等接口结果
  if (msg.type === 'qnh_fetch_done') { qagent.onDone(uid, msg); return; }
  // 「清除本机登录态」：助手清掉本机浏览器分区后回执
  if (msg.type === 'logout_done') { onAgentLogoutDone(uid, msg); return; }
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
    } else {
      // 不在催收任务上下文里的助手日志（如申请发票 / 发催收消息）：既打控制台，也并入该任务的进度面板
      const pctx = [...PDD_TASKS.values()]
        .filter((c) => c.userId === Number(uid) && c.status === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (pctx) {
        pctx.progressLog = pctx.progressLog || [];
        pctx.progressLog.push({ t: new Date().toISOString().slice(11, 19), text: String(msg.text || '').slice(0, 200) });
        if (pctx.progressLog.length > 300) pctx.progressLog.splice(0, pctx.progressLog.length - 300);
      }
      // 闪电帮帮（取数 / 催收）：助手日志必须进这里，否则页面上只看得到「已处理 x/y 家」，
      // 助手到底有没有打开会话、点是按钮还是回车，全变成黑盒，线上无法排查。
      const sctx = [...SDC_TASKS.values()]
        .filter((c) => c.userId === Number(uid) && c.status === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (sctx) {
        const text = String(msg.text || '').slice(0, 200);
        sctx.progressLog = sctx.progressLog || [];
        sctx.progressLog.push({ t: new Date().toISOString().slice(11, 19), text });
        if (sctx.progressLog.length > 300) sctx.progressLog.splice(0, sctx.progressLog.length - 300);
        // 兜底：老版本助手不会主动报 sdc_send_progress，就从日志行里认「第 N/M 家：店名」，
        // 否则进度数字会一直停在 0，直到最后一次回执才跳到 100%（等于没有进度）。
        if (sctx.kind === 'send') guessSdcProgress(sctx, text);
      }
      console.log(`[agent] uid=${uid} · ${String(msg.text || '').slice(0, 200)}`);
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
    taskLog(t, `↻ 还有 ${left} 家未发送：本机通道重新连接后，点「继续发送未完成」即可续跑（不会重发已成功的）`);
  } else if (t.fail > 0) {
    taskLog(t, `↻ 有 ${t.fail} 家发送失败：可在「重试失败项」按原清单重发`);
  }
  pushClientProgress(ctx.userId, ctx);
  try { ctx.resolve && ctx.resolve(); } catch (e) { /* 忽略 */ }
}

/** 本机通道掉线时，中断其正在跑的任务 */
function maybeAbortClientTask(uid) {
  if (agentHub.isOnline(uid)) return;
  for (const ctx of CLIENT_TASKS.values()) {
    if (ctx.userId === Number(uid) && !ctx.finished) {
      taskLog(ctx.taskState, '⛔ 本机助手连接已断开，任务中断（重新启动助手并连上后，可点「继续发送未完成」续跑）');
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
  if (!agentHub.isOnline(userId)) throw new Error('本机助手未连接：请先在本机启动「催收小助手」桌面程序并完成绑定');

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
  const rows = await db.query('SELECT id, items, title_id FROM agent_task WHERE id = ? AND user_id = ?', [taskId, userId]);
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
  return {
    taskId: Number(r.id), loginIds, pending: sum.pending.length, failed: sum.failed.length,
    titleId: Number(r.title_id) || 0,   // 续跑沿用原任务选的那条抬头
  };
}

/**
 * 组装并下发一次「本机助手」发送任务
 * @param {number} userId
 * @param {string[]} loginIds 要发送的卖家内部 loginId
 * @param {{resumeOf?:number, titleId?:number}} [opts]
 *   resumeOf=断线续跑时被接续的任务 id（仅用于审计与日志）
 *   titleId = 保留参数（2026-10-30 起已无选抬头，恒为账号默认抬头）；agent_task.title_id 留作审计
 */
async function doClientSend(userId, loginIds, opts = {}) {
  const resumeOf = Number(opts.resumeOf) || null;
  const taskState = taskFor(userId);
  if (taskState.running) throw new Error('已有任务在运行中');
  if (!agentHub.isOnline(userId)) throw new Error('本机助手未连接：请先在本机启动「催收小助手」桌面程序并完成绑定（页面右上角有「下载本机助手 / 绑定本机助手」入口）');

  const config = loadConfig();
  const rt = config.runtime || {};
  const gapMin = (rt.sendGapMinSec || 15) * 1000;
  const gapMax = (rt.sendGapMaxSec || 30) * 1000;
  // 「提前加载下一家会话」：把下一家的页面加载塞进两家之间的等待里，总时长下降但
  // 两家真实发送动作的间隔不会小于 gap。关掉则退回「先等够 gap 再加载下一家」的旧节拍。
  const prefetch = rt.prefetchNextSeller !== false;
  // 抬头：用户在下拉里选的那条（断线续跑沿用原任务的选择，不会中途换成默认抬头）
  const buyer = await buyerOfSend(userId, opts.titleId);
  const runConfig = { ...config, buyerInfo: buyer };
  const data = await loadSellers(userId);

  // 先筛出有效目标，再一次性把他们的待催收订单查出来（原来每家串行 4 条 SQL）
  const targets = [];
  for (const loginId of loginIds) {
    const s = data.find((x) => x.loginId === loginId);
    if (!s || !s.sellerLogin) continue;
    targets.push({ loginId, sellerLogin: s.sellerLogin, company: s.company, amount: Number(s.pendingAmount) || 0 });
  }
  const pendingMap = await loadPendingOrdersBatch(userId, targets.map((t) => t.loginId));

  const sellers = [];
  for (const t of targets) {
    const toRemind = pendingMap.get(t.loginId) || [];
    if (!toRemind.length) continue;
    const msgSeller = { loginId: t.sellerLogin, amount: t.amount, orders: toRemind };
    sellers.push({
      loginId: t.loginId,
      sellerLogin: t.sellerLogin,
      company: t.company,
      amount: t.amount,
      orderNos: toRemind.map((o) => o.orderId).join('；'),
      messages: buildMessages(msgSeller, runConfig),
    });
  }
  if (!sellers.length) throw new Error('没有可发送的卖家（可能都已开票或缺少卖家会员名）');

  // 消息内容为空就别派单：助手在 1688 里会「输入空内容→点发送→找不到聊天记录」，
  // 一路重试后报「发送未确认」，看不出真实原因。这里直接给出可操作提示。
  const emptyMsg = sellers.find((s) => !Array.isArray(s.messages) || !s.messages.length
    || s.messages.every((m) => !String(m || '').trim()));
  if (emptyMsg) {
    throw new Error('催收消息模板为空，已取消发送。请到「配置」页填写消息模板（消息①模板 / 消息②订单清单 / 消息③提醒）后重试'
      + '（当前 config.json 里这三项是空字符串，会覆盖系统默认文案）');
  }

  const created = await db.exec(
    "INSERT INTO agent_task (user_id, status, total, items, resume_of, title_id, started_at)"
      + " VALUES (?, 'running', ?, ?, ?, ?, NOW())",
    [userId, sellers.length, JSON.stringify(sellers.map((s) => ({
      loginId: s.loginId, company: s.company, amount: s.amount, orderNos: s.orderNos, status: 'pending',
    }))), resumeOf, buyer.titleId || null]
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
  taskLog(taskState, `· 节奏：两家发送之间至少间隔 ${Math.round(gapMin / 1000)}~${Math.round(gapMax / 1000)}s`
    + (prefetch ? '（等待期间提前打开下一家的会话，加载时间计入间隔，不额外多等）'
      : '（严格等满间隔后再加载下一家）'));
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
      prefetch,
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
// 税名核对（销方名称 ↔ 1688 商家名称）
//   权限：所有登录用户可用（查询 / 保存 / 忽略 / 删除）。
//   数据口径（两件事要分开看）：
//     · 映射关系 —— 底层一套全局去重表（tax_seller_name 唯一）。谁维护都一样，
//       用户 A 映射后，用户 B 发票里出现的同名销方直接复用，无须重复映射。
//     · 可见/可操作范围 —— 普通用户只看得到自己发票里出现过的销方名称（待比对 + 已维护 + 已忽略），
//       也只能对这些名称做维护；超级管理员看得到所有用户的数据并可直接操作。
//   映射写入后回填 issued_invoice.seller_company（按销方名称全表），这正是「B 自动关联」的实现。
// ─────────────────────────────────────────────────────────────────────────
/**
 * 1688 商家候选（按需搜索，不再整表下发）
 *   浏览器一次只渲染 50 条，输入关键词时由服务端过滤，避免几万个选项把页面卡死。
 *   allUsers=true（超管）→ 全部用户订单里的卖家；false → 只看自己订单里的。
 */
async function searchSellers(userId, { q = '', limit = 50, allUsers = false } = {}) {
  const kw = String(q == null ? '' : q).trim().slice(0, 64);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const where = ['seller_company IS NOT NULL', "seller_company <> ''"];
  const args = [];
  if (!allUsers) { where.push('user_id = ?'); args.push(userId); }
  if (kw) {
    where.push('(seller_company LIKE ? OR seller_login LIKE ?)');
    args.push(`%${kw}%`, `%${kw}%`);
  }
  const w = where.join(' AND ');
  // 按公司名分组：同一家公司可能对应多个会员名，下拉里只出现一次（取其中一个会员名回填）
  const sellers = await db.query(`
    SELECT seller_company AS company,
           MAX(seller_login) AS sellerLogin,
           COUNT(DISTINCT NULLIF(seller_login, '')) AS loginCount
    FROM invoice_order
    WHERE ${w}
    GROUP BY seller_company
    ORDER BY seller_company
    LIMIT ?
  `, [...args, lim]);
  const cnt = await db.query(
    `SELECT COUNT(DISTINCT seller_company) AS n FROM invoice_order WHERE ${w}`, args
  );
  return { sellers, total: Number(cnt[0] && cnt[0].n) || 0, q: kw, limit: lim };
}

async function loadMapping(userId, { allUsers = false } = {}) {
  // allUsers=true（超管）→ 全部映射行、统计算所有用户；false（普通用户）→ 只列自己发票涉及过的销方名称
  const scoped = !allUsers;
  // 发票按销方名称聚合成一张派生表，再 JOIN 到映射表：
  //   原写法是每行跑 2 次相关子查询（359 行 = 718 次），现在是 1 次扫描 + 1 次 JOIN。
  //   顺带把「最近开票时间」带出来，用于默认排序（最近开票在前）。
  const agg = `(
      SELECT seller_name AS n,
             ROUND(SUM(total_amount), 2) AS invoice_amount,
             COUNT(*) AS invoice_rows,
             MAX(invoice_date) AS last_invoice_date
        FROM issued_invoice
        ${scoped ? 'WHERE user_id = ?' : ''}
       GROUP BY seller_name
    )`;
  // 普通用户用 INNER JOIN：派生表只含自己的发票行，JOIN 后天然只剩「自己发票里出现过的销方名称」
  const all = await db.query(`
    SELECT m.id, m.tax_seller_name, m.seller_company, m.seller_login,
           m.match_type, m.match_rule, m.is_confirmed, m.is_ignored, m.note, m.updated_at,
           (m.user_id = ?) AS maintainer_is_me,
           u.name AS maintainer,
           agg.invoice_amount, agg.invoice_rows, agg.last_invoice_date
    FROM seller_name_mapping m
    LEFT JOIN (SELECT id, COALESCE(NULLIF(company_name, ''), username) AS name FROM app_user) u
           ON u.id = m.user_id
    ${scoped ? 'INNER JOIN' : 'LEFT JOIN'} ${agg} agg ON agg.n = m.tax_seller_name
    ORDER BY agg.last_invoice_date IS NULL, agg.last_invoice_date DESC, agg.invoice_amount DESC
  `, scoped ? [userId, userId] : [userId]);
  const mappings = all.filter((m) => !m.is_ignored);
  const ignored = all.filter((m) => m.is_ignored);
  // 待人工比对（超管全局视图）：汇总所有用户发票里的销方名称，并标出「涉及哪些账号」
  //   GROUP_CONCAT 直接对 JOIN 后的「发票行 × 用户」聚合，不再每组跑一次子查询（624 组 = 624 次扫描）
  const unmatched = allUsers ? await db.query(`
    SELECT i.seller_name AS tax_seller_name,
           COUNT(*)      AS invoice_rows,
           ROUND(SUM(i.total_amount),2) AS invoice_amount,
           MIN(i.invoice_date) AS first_invoice_date,
           MAX(i.invoice_date) AS last_invoice_date,
           MAX(i.seller_tax_no) AS seller_tax_no,
           MAX(i.remark) AS remark,
           COUNT(DISTINCT i.user_id) AS user_count,
           GROUP_CONCAT(DISTINCT COALESCE(NULLIF(u.company_name,''), u.username)
                        ORDER BY COALESCE(NULLIF(u.company_name,''), u.username) SEPARATOR '、') AS owners
    FROM issued_invoice i
    LEFT JOIN app_user u ON u.id = i.user_id
    LEFT JOIN seller_name_mapping m
           ON m.tax_seller_name = i.seller_name
          AND (m.is_ignored = 1 OR m.seller_company IS NOT NULL)
    WHERE m.id IS NULL
    GROUP BY i.seller_name
    ORDER BY MAX(i.invoice_date) IS NULL, MAX(i.invoice_date) DESC, invoice_amount DESC
  `) : await db.query(
    `SELECT * FROM v_unmatched_seller_name WHERE user_id = ?
      ORDER BY last_invoice_date IS NULL, last_invoice_date DESC, invoice_amount DESC`, [userId]
  );
  // 商家候选不再随映射整表返回（近 3000 条、约 600KB）；前端改按需搜索（/api/mapping/sellers）
  return {
    mappings, ignored, unmatched,
    unmatchedCount: unmatched.length, ignoredCount: ignored.length, allUsers,
  };
}

/**
 * 普通用户能否维护该销方名称：只能操作「自己发票里出现过的」销方名称。
 * 超管不受限制（他就是来兜底的）。
 */
async function canMaintainSeller(user, taxSellerName) {
  const name = (taxSellerName == null ? '' : String(taxSellerName)).trim();
  if (!name) return false;
  if (user.role === 'admin') return true;
  const rows = await db.query(
    'SELECT 1 FROM issued_invoice WHERE user_id = ? AND seller_name = ? LIMIT 1', [user.id, name]
  );
  return rows.length > 0;
}

async function saveMapping(userId, { taxSellerName, sellerLogin, sellerCompany, note }) {
  if (!taxSellerName) throw new Error('缺少 taxSellerName');
  if (!sellerCompany) throw new Error('请选择对应的1688商家');
  // 全员共享：同名映射只存一条（全局唯一键），user_id 只在首次创建时记维护人
  await db.exec(
    `INSERT INTO seller_name_mapping (user_id, tax_seller_name, seller_company, seller_login, match_type, match_rule, is_confirmed, is_ignored, note)
     VALUES (?, ?, ?, ?, 'manual', 'manual', 1, 0, ?)
     ON DUPLICATE KEY UPDATE seller_company = VALUES(seller_company), seller_login = VALUES(seller_login),
       match_type = 'manual', match_rule = 'manual', is_confirmed = 1, is_ignored = 0, note = VALUES(note)`,
    [userId, taxSellerName, sellerCompany, sellerLogin || null, note || null]
  );
  // 回填所有用户的同销方发票行（映射共享，B 维护后 A 的发票也自动对上）
  const r = await db.exec(
    'UPDATE issued_invoice SET seller_company = ? WHERE seller_name = ?',
    [sellerCompany, taxSellerName]
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
    // 忽略同样全员生效：所有用户的该销方发票行都不再计入「1688发票」统计
    await db.exec('UPDATE issued_invoice SET seller_company = NULL WHERE seller_name = ?', [taxSellerName]);
  } else {
    const rows = await db.query(
      'SELECT id, seller_company FROM seller_name_mapping WHERE tax_seller_name = ?', [taxSellerName]
    );
    if (rows[0] && !rows[0].seller_company) {
      await db.exec('DELETE FROM seller_name_mapping WHERE tax_seller_name = ?', [taxSellerName]);
    } else {
      await db.exec('UPDATE seller_name_mapping SET is_ignored = 0 WHERE tax_seller_name = ?', [taxSellerName]);
    }
  }
  return { ok: true, ignored: on };
}

async function deleteMapping(userId, { taxSellerName }) {
  if (!taxSellerName) throw new Error('缺少 taxSellerName');
  await db.exec('DELETE FROM seller_name_mapping WHERE tax_seller_name = ?', [taxSellerName]);
  await db.exec('UPDATE issued_invoice SET seller_company = NULL WHERE seller_name = ?', [taxSellerName]);
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
           u.qnh_refund_enabled, u.qnh_profit_enabled, u.product_enabled, u.market_enabled, u.billing_enabled,
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
    qnhProfitEnabled: u.role === 'admin' ? true : !!Number(u.qnh_profit_enabled),
    pddEnabled: u.role === 'admin' ? true : !!Number(u.pdd_enabled),
    productEnabled: u.role === 'admin' ? true : !!Number(u.product_enabled),
    marketEnabled: u.role === 'admin' ? true : !!Number(u.market_enabled),
    billingEnabled: u.role === 'admin' ? true : !!Number(u.billing_enabled),
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
    // 官网首页（路径 /）：未登录停留在这里；已登录自动进看板 /home
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      const u = await currentUser(req);
      if (u) return redirect(res, '/home');
      return sendHtml(res, 'home.html');
    }
    // 书签工具落地页（登录可用，零安装方案；未登录跳转登录页）
    if (method === 'GET' && (p === '/bookmarklet' || p === '/bookmarklet.html')) {
      const bu = await currentUser(req);
      if (!bu) return redirect(res, '/login');
      return sendHtml(res, 'bookmarklet.html');
    }
    if (method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
    // 品牌图标：浏览器默认会请求 /favicon.ico，这里给真实图标而不是一条 404
    // 直接复用桌面端那套 ICO（内含 16/20/24 的简化帧，小尺寸不糊）
    if (method === 'GET' && p === '/favicon.ico') return sendAsset(req, res, 'app-icon-mascot.ico');
    if (method === 'GET' && p.startsWith('/assets/')) return sendAsset(req, res, decodeURIComponent(p.slice('/assets/'.length)));
    // 前端本地依赖（免外网 CDN）：/vendor/vue.min.js、/vendor/echarts.min.js、/vendor/element-ui/*
    if (method === 'GET' && p.startsWith('/vendor/')) return sendVendor(res, decodeURIComponent(p.slice('/vendor/'.length)));
    // 登录后的看板（路径 /home）：已登录进看板；未登录回官网首页 /
    if (method === 'GET' && (p === '/home' || p === '/home.html')) {
      const u = await currentUser(req);
      if (!u) return redirect(res, '/');
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
      return sendJson(res, 200, { user: publicUser(u), copyright: copyrightText() });
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
    //    ?file=<包名> 可指定下载某个具体版本；缺省给「最新构建」那份
    if (method === 'GET' && p === '/api/agent/download-exe') {
      const qName = sanitizeInstallerName(url.searchParams.get('file'));
      const ins = qName ? { file: qName } : findAgentInstaller();
      if (!ins) {
        return sendJson(res, 404, {
          error: '安装包尚未构建。请管理员在本机执行 npm run agent:dist 生成，或联系管理员获取「催收小助手」安装包。',
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

    // ── 助手安装包重新打包（仅超级管理员；系统管理页一键触发）──
    //    注意：必须放在 isAdmin 计算之后
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
        error: '浏览器扩展已下线，请到下载页获取「催收小助手」桌面程序',
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
      if (!uid) return sendJson(res, 401, { error: '设备令牌无效或已撤销（不再接受税号；请在「本机助手 → 书签令牌」重新签发）' });
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
    // ── 菜单权限：商品列表 / 交易市场 / 账单（v0.2.39；默认所有普通用户关闭，超管始终可用）──
    //    菜单隐藏只是体验，接口这里才是真正的放行判断（含补货、齐货通加购、商品导入）
    const canProduct = isAdmin || !!Number(user.product_enabled);
    const canMarket = isAdmin || !!Number(user.market_enabled);
    const canBilling = isAdmin || !!Number(user.billing_enabled);
    const denyProduct = () => sendJson(res, 403, { error: '未开启商品列表权限，请联系超级管理员' });
    const denyMarket = () => sendJson(res, 403, { error: '未开启交易市场权限，请联系超级管理员' });
    const denyBilling = () => sendJson(res, 403, { error: '未开启账单权限，请联系超级管理员' });

    // ── 助手安装包重新打包（仅超级管理员；系统管理页一键触发）──
    if (p === '/api/agent/build') {
      if (method === 'GET') {
        if (!isAdmin) return sendJson(res, 403, { error: '仅超级管理员可查看打包状态' });
        return sendJson(res, 200, agentBuildStatus());
      }
      if (method === 'POST') {
        if (!isAdmin) return sendJson(res, 403, { error: '仅超级管理员可重新打包助手' });
        const started = startAgentBuild();
        if (!started.ok) return sendJson(res, 409, { error: started.error });
        await logOp(user, 'agent.build', {});
        return sendJson(res, 200, { ok: true, message: '打包已开始，约 1~2 分钟' });
      }
    }

    // ── 本机助手安装包上传（仅超级管理员；Linux 容器无法 npm run agent:dist 时的替代方案）──
    //    流程：管理员在本机 Windows 跑 npm run agent:dist → 把生成的 .exe 上传到这里 →
    //    写入 dist/（同名覆盖）→ 版本策略自动取用 → 旧助手到宽限期后可被硬拦并一键更新。
    //    注意：裸二进制上传（fetch/XHR 直接发 File），不走 readBody；超大直接流式截断。
    if (method === 'POST' && p === '/api/agent/installer-upload') {
      if (!user || !isAdmin) return sendJson(res, user ? 403 : 401, { error: '仅超级管理员可上传安装包' });
      const name = sanitizeInstallerName(url.searchParams.get('name'));
      if (!name) return sendJson(res, 400, { error: '文件名非法（仅允许 .exe，且不能含路径分隔符 / ..）' });
      const MAX = 400 * 1024 * 1024; // 400MB 上限，超出直接拒绝
      const dest = path.join(ROOT, 'dist', name);
      let done = false;
      const fail = (code, obj) => { if (done) return; done = true; sendJson(res, code, obj); };
      const ws = fs.createWriteStream(dest);
      let size = 0;
      let aborted = false;
      req.on('data', (c) => {
        if (aborted || done) return;
        size += c.length;
        if (size > MAX) {
          aborted = true;
          try { ws.destroy(); } catch (e) { /* 忽略 */ }
          try { fs.unlinkSync(dest); } catch (e) { /* 忽略 */ }
          try { req.destroy(); } catch (e) { /* 忽略 */ }
          fail(413, { error: '安装包超过 400MB 上限，已丢弃' });
        }
      });
      req.on('error', () => {
        if (aborted || done) return;
        try { ws.destroy(); } catch (e) { /* 忽略 */ }
        try { fs.unlinkSync(dest); } catch (e) { /* 忽略 */ }
      });
      ws.on('error', (e) => {
        try { fs.unlinkSync(dest); } catch (er) { /* 忽略 */ }
        fail(500, { error: '写入安装包失败：' + e.message });
      });
      req.pipe(ws);
      ws.on('finish', () => {
        if (aborted || done) return;
        const ins = findAgentInstaller();
        fail(200, {
          ok: true,
          installer: ins ? { file: ins.file, version: parseVerFromName(ins.file), sizeBytes: ins.size } : null,
          policy: agentUpdatePolicy(),
        });
      });
      return; // 由上面的事件回调结束响应
    }

    // ── 本机助手安装包删除（仅超级管理员）──
    if (method === 'DELETE' && p === '/api/agent/installer') {
      if (!user || !isAdmin) return sendJson(res, user ? 403 : 401, { error: '仅超级管理员可删除安装包' });
      const name = sanitizeInstallerName(url.searchParams.get('name'));
      if (!name) return sendJson(res, 400, { error: '文件名非法' });
      const full = path.join(ROOT, 'dist', name);
      try { fs.unlinkSync(full); } catch (e) { return sendJson(res, 404, { error: '文件不存在或已删除' }); }
      return sendJson(res, 200, { ok: true, policy: agentUpdatePolicy() });
    }

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

    // ── 已废弃（2026-10-14）：浏览器扩展通道下线，统一迁移到「催收小助手」桌面程序 ──
    if (method === 'GET' && p === '/api/agent/my-extension-download') {
      return sendJson(res, 410, {
        error: '浏览器扩展通道已下线，请改用「催收小助手」桌面程序',
        migrateTo: '/download',
        note: '桌面助手自带浏览器、无需再装扩展，且用设备令牌连接、更安全。',
      });
    }

    // ── 1688 订单同步（mtop: OrderListDataLineService.buyerOrderList）──
    // 「1688发票」页的刷新按钮打这里：从库里最近的订单时间起，往后翻页拉全部订单。
    // 登录态不进数据库，只读 data/ali-cookie.txt（或环境变量 ALI_COOKIE）。
    if (method === 'GET' && p === '/api/ali/orders-session') {
      const st = aliOrders.sessionStatus();
      return sendJson(res, 200, Object.assign(st, {
        latestOrderTime: await aliOrders.latestOrderTime(tenantId).catch(() => null),
        pageSize: aliOrders.PAGE_SIZE,
        cookieFileHint: 'data/ali-cookie.txt',
      }));
    }
    // ── 「登录1688」：本机助手弹桌面窗口（persist:1688 分区）→ 用户登录 → Cookie 串回传 →
    // 写进 data/ali-cookie.txt。从此不用再手工粘贴 Cookie。
    if (method === 'POST' && p === '/api/ali/login') {
      // 管理员代入他人时，登录窗口开在「有在线助手的那台电脑」上，登录态仍写到该租户共用的文件
      const aUid = agentUidFor(user, tenantId);
      const onMyPc = aUid && Number(aUid) !== Number(tenantId);
      if (!aUid) {
        return sendJson(res, 200, {
          ok: false,
          needAgent: true,
          message: '本机助手未连接：请先在电脑上启动「催收小助手」并绑定。1688 登录只在本机完成，服务器不会代你登录。',
        });
      }
      if (!agentVersionGate(res, aUid, '登录1688')) return;
      const agentVer = agentHub.status(aUid).agentVer || '';
      if (agentVer && !verGte(agentVer, ALI_LOGIN_MIN_AGENT)) {
        return sendJson(res, 200, {
          ok: false,
          needAgent: true,
          agentOutdated: true,
          message: `这台电脑上的催收小助手是 v${agentVer}，还不支持登录 1688。请下载安装 v${ALI_LOGIN_MIN_AGENT} 及以上版本。`,
        });
      }
      const taskId = 'alilogin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const ctx = {
        taskId, userId: Number(tenantId), status: 'pending', message: '',
        cookieCount: 0, writtenAt: null, createdAt: Date.now(),
        expiresAt: Date.now() + ALI_LOGIN_TTL_MS,
      };
      const sent = agentHub.send(aUid, {
        type: 'ali_login',
        taskId,
        url: (process.env.ALI_LOGIN_URL || 'https://login.1688.com/member/signin.htm'),
        timeoutMs: ALI_LOGIN_TIMEOUT_MS,
      });
      if (!sent) {
        return sendJson(res, 200, {
          ok: false, needAgent: true,
          message: '下发登录任务失败：本机助手连接已断开，请确认助手正在运行。',
        });
      }
      ALI_LOGINS.set(taskId, ctx);
      await logOp(user, 'ali.login.start', { tenantId, agentUid: aUid });
      return sendJson(res, 200, {
        ok: true, pending: true, taskId,
        message: (onMyPc ? '已在「' + ((await tenantLabelOf(tenantId)) || '该账号') + '」的电脑上打开 1688 登录窗口，' : '已在你本机的助手窗口里打开 1688 登录，')
          + '请在弹出的窗口里完成登录（支持扫码/短信验证）。',
      });
    }

    // 轮询「登录1688」进度（status: pending / done / failed）
    if (method === 'GET' && p === '/api/ali/login-status') {
      const ctx = ALI_LOGINS.get(String(url.searchParams.get('taskId') || ''));
      const mine = ctx && (ctx.userId === Number(user.id) || (isAdmin && ctx.userId === Number(tenantId)));
      if (!mine) return sendJson(res, 404, { error: '登录任务不存在或已结束' });
      return sendJson(res, 200, {
        status: ctx.status,
        ok: ctx.status === 'done',
        message: ctx.message || '',
        cookieCount: ctx.cookieCount,
        writtenAt: ctx.writtenAt,
      });
    }

    // 退出1688（双清联动）：① 清服务器侧 Cookie 文件（data/ali-cookie.txt）
    // ② 下发 logout 指令让本机助手清掉 persist:1688 分区并等回执（最多 6 秒）。
    // 只清①的话，本机分区还留着旧账号，发消息窗口会免登进旧号（看起来像没退掉）。
    if (method === 'POST' && p === '/api/ali/logout') {
      const cleared = aliOrders.clearCookie();
      const agent = await agentLogout(agentUidFor(user, tenantId) || tenantId, '1688');
      await logOp(user, 'ali.logout', { tenantId, agentCleared: !!agent.ok, hadFile: cleared.hadFile });
      let note;
      if (agent.ok) {
        note = '已退出 1688：服务器登录态与本机助手登录态都已清除。';
      } else if (agent.offline) {
        note = '已清除服务器登录态，但助手离线，请手动在助手面板点退出。';
      } else if (agent.timeout) {
        note = '已清除服务器登录态，但助手 6 秒内没有回应退出指令，视为助手离线，请手动在助手面板点退出。';
      } else if (agent.outdated) {
        note = `已清除服务器登录态，但本机助手是 v${agent.agentVer}，不支持自动退出本机登录态：请升级助手，或在助手面板点「1688 · 退出」。`;
      } else {
        note = `已清除服务器登录态，但本机助手退出登录态失败（${agent.error || '未知原因'}），请手动在助手面板点退出。`;
      }
      if (cleared.envOverridden) {
        note += ' 注意：环境变量 ALI_COOKIE 仍在生效，清文件不影响它 —— 需要彻底退出请同时去掉该环境变量。';
      }
      return sendJson(res, 200, {
        ok: true,
        agentCleared: !!agent.ok,
        agentOffline: !!agent.offline,
        hadFile: cleared.hadFile,
        message: note,
      });
    }

    if (method === 'POST' && p === '/api/ali/orders-sync') {
      writeGuard();
      const b = await readBody(req).catch(() => ({}));
      // 同一租户只允许一个同步任务在跑，避免重复翻页把接口打限流
      const running = [...ALI_TASKS.values()].find((c) => c.userId === Number(tenantId) && c.status === 'pending');
      if (running) {
        return sendJson(res, 200, {
          ok: true, pending: true, taskId: running.taskId, already: true,
          message: '订单同步正在运行中，继续展示进度…',
        });
      }
      // 允许指定起始时间；不传则由服务端取「库里最近的订单时间」
      const forcedStart = b.startDateTime && /^\d{4}-\d{2}-\d{2}/.test(String(b.startDateTime))
        ? String(b.startDateTime) : null;

      const taskId = 'aliord-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const ctx = {
        taskId, kind: 'ali-orders', userId: Number(tenantId), status: 'pending',
        message: '', startDateTime: forcedStart, createdAt: Date.now(),
        // withInvoices：订单拉完顺带刷「已开票」状态（默认开；传 false 可只拉订单）
        withInvoices: b.withInvoices !== false,
        progress: { page: 0, totalPages: 0, total: 0, fetched: 0, rows: 0, saved: 0, newCount: 0, current: '' },
        progressLog: [], expiresAt: Date.now() + ALI_TASK_TTL_MS,
      };
      const pushLog = (text) => {
        const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        ctx.progressLog.push({ t, text });
        if (ctx.progressLog.length > 300) ctx.progressLog.shift();
      };
      ALI_TASKS.set(taskId, ctx);
      pushLog('开始同步 1688 订单…');

      aliOrders.syncOrders({
        userId: Number(tenantId),
        startDateTime: forcedStart,
        onProgress: (pr) => {
          if (!ctx.startDateTime && pr.__start) ctx.startDateTime = pr.__start;
          ctx.progress = Object.assign({}, ctx.progress, {
            page: pr.page, fetched: pr.fetched, rows: pr.rows,
            saved: pr.saved, newCount: pr.newCount, current: pr.current || '',
            totalPages: pr.totalPages || ctx.progress.totalPages || 0,
            total: pr.total || ctx.progress.total || 0,
          });
          pushLog(`第 ${pr.page}${pr.totalPages ? '/' + pr.totalPages : ''} 页：本页 ${pr.rows} 单，累计 ${pr.fetched} 单，入库 ${pr.saved}（新增 ${pr.newCount}）`);
          if (pr.page === 1 && Array.isArray(pr.firstKeys) && pr.firstKeys.length) {
            pushLog('首单字段：' + pr.firstKeys.slice(0, 12).join(', ') + ' …');
          }
        },
        shouldStop: () => !!ctx.stopping,
      }).then(async (out) => {
        ctx.status = out.ok ? 'done' : 'failed';
        ctx.message = out.message || '';
        ctx.needLogin = !!out.needLogin;
        ctx.needImport = !!out.needImport;
        ctx.rawSample = out.rawSample || null;
        if (out.startDateTime) ctx.startDateTime = out.startDateTime;
        ctx.progress = Object.assign({}, ctx.progress, {
          page: out.pages || 0, fetched: out.fetched || 0,
          saved: out.saved || 0, newCount: out.newCount || 0, percent: 100,
          total: out.total || ctx.progress.total || 0,
        });
        ctx.finishedAt = Date.now();
        ctx.expiresAt = Date.now() + ALI_TASK_TTL_MS;
        if (out.truncated) pushLog(`已到翻页上限（${out.maxPages} 页），更早的订单未拉取`);
        pushLog((out.ok ? '✓ ' : '✗ ') + (out.message || ''));

        // 订单拉完接着刷「已开票」状态（第 9 条）：共用同一条进度条，前端不用串两个任务
        if (out.ok && ctx.withInvoices && !ctx.stopping) {
          ctx.status = 'pending';
          ctx.phase = 'invoices';
          pushLog('开始同步 1688 已开票状态（按开票时间增量）…');
          try {
            const inv = await aliOrders.syncInvoices({
              userId: Number(tenantId),
              onProgress: (p) => {
                ctx.progress.invPage = p.page;
                ctx.progress.invPages = p.totalPages || 0;
                ctx.progress.invFetched = p.fetched;
                pushLog(`发票同步第 ${p.page}${p.totalPages ? '/' + p.totalPages : ''} 页：接口 ${p.fetched} 条，命中 ${p.picked} 条`);
              },
              shouldStop: () => !!ctx.stopping,
            });
            ctx.invoice = {
              fetched: inv.fetched || 0, matched: inv.matched || 0,
              missing: inv.missing || 0, since: inv.since || null,
            };
            pushLog((inv.ok ? '✓ ' : '✗ ') + (inv.message || ''));
            if (!inv.ok) {
              ctx.status = 'failed';
              ctx.message = [ctx.message, inv.message].filter(Boolean).join('；');
              ctx.needLogin = ctx.needLogin || !!inv.needLogin;
            } else {
              ctx.status = 'done';
            }
          } catch (e) {
            pushLog('✗ 发票同步异常：' + ((e && e.message) || e));
          }
          ctx.finishedAt = Date.now();
          ctx.expiresAt = Date.now() + ALI_TASK_TTL_MS;
        }
      }).catch((e) => {
        ctx.status = 'failed';
        ctx.message = (e && e.message) || String(e);
        ctx.finishedAt = Date.now();
        pushLog('✗ 同步异常：' + ctx.message);
      });

      const st = aliOrders.sessionStatus();
      if (!st.configured) {
        return sendJson(res, 200, {
          ok: false, pending: false, needLogin: true,
          message: '未配置 1688 登录态：接口需要真实买家登录 Cookie，请到「1688发票」页点「登录1688」，在助手窗口里登录（登录态自动回传服务器）',
        });
      }
      await logOp(user, 'ali.orders.sync', { tenantId, startDateTime: forcedStart });
      return sendJson(res, 200, {
        ok: true, pending: true, taskId,
        message: '已开始同步 1688 订单，进度见下方…',
      });
    }
    if (method === 'GET' && p === '/api/ali/orders-sync') {
      const id = url.searchParams.get('id');
      const ctx = ALI_TASKS.get(String(id || ''));
      if (!ctx) return sendJson(res, 404, { ok: false, error: '任务不存在或已过期' });
      return sendJson(res, 200, {
        ok: true, status: ctx.status, message: ctx.message,
        needLogin: !!ctx.needLogin, rawSample: ctx.rawSample || null,
        needImport: !!ctx.needImport,
        startDateTime: ctx.startDateTime || null,
        phase: ctx.phase || 'orders', invoice: ctx.invoice || null,
        progress: ctx.progress, progressLog: ctx.progressLog,
      });
    }
    if (method === 'POST' && p === '/api/ali/orders-sync-stop') {
      const b = await readBody(req).catch(() => ({}));
      const ctx = ALI_TASKS.get(String(b.taskId || ''));
      if (ctx) { ctx.stopping = true; return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 200, { ok: false, error: '任务不存在' });
    }

    // 看板数据
    if (method === 'GET' && p === '/api/data') {
      const companies = await loadCompanies(tenantId);
      const sendStats = await loadSendStats(tenantId);
      const sentList = sendStats.filter((r) => Number(r.sendCount) > 0).map((r) => r.login);
      // 「已开票金额（税务局）」全局统计：排除「已忽略」销方名称的发票（忽略全员共享，任何用户点忽略后都不计入）
      const invSummary = await db.query(`
        SELECT COUNT(*) AS rows_count,
               COUNT(DISTINCT COALESCE(NULLIF(e_invoice_no,''), NULLIF(invoice_no,''), i.row_hash)) AS invoice_count,
               ROUND(SUM(COALESCE(total_amount,0)),2) AS amount,
               SUM(seller_company IS NULL) AS unmapped_rows
        FROM issued_invoice i
        WHERE i.user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM seller_name_mapping m
            WHERE m.tax_seller_name = i.seller_name AND m.is_ignored = 1
          )
      `, [tenantId]);
      const unmatched = await db.query('SELECT COUNT(*) AS n FROM v_unmatched_seller_name WHERE user_id = ?', [tenantId]);
      const ignoredCnt = await db.query('SELECT COUNT(*) AS n FROM seller_name_mapping WHERE is_ignored = 1');
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
            WHERE m.tax_seller_name = i.seller_name AND m.is_ignored = 1
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
          WHERE m2.tax_seller_name = i.seller_name AND m2.is_ignored = 1
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
      const safe = {
        runtime: config.runtime || {},
        messages: config.messages || {},
        // 拼多多催收模板与 1688 的 messages 完全分开（只有一条话术）
        pddMessage: pdd.getPddMessageConfig(config),
        serverUrl: (config.server_url || '').trim(),
      };
      return sendJson(res, 200, {
        config: { ...safe, buyerInfo: await buyerInfoOf(user.id) },
        defaultMessages: DEFAULT_MESSAGES,
        defaultPddMessage: pdd.DEFAULT_PDD_MESSAGE,
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
      // 拼多多翻页上限（发票刷新与订单同步共用）：夹在 20~2000，非法值回默认 300（改完下次同步即生效）
      if (config.runtime && config.runtime.pddMaxPages !== undefined) {
        const n = Number(config.runtime.pddMaxPages);
        merged.runtime.pddMaxPages = Number.isFinite(n) && n > 0
          ? Math.min(psync.MAX_MAX_PAGES, Math.max(psync.MIN_MAX_PAGES, Math.round(n)))
          : psync.DEFAULT_MAX_PAGES;
      }
      merged.messages = { ...(old.messages || {}), ...(config.messages || {}) };
      // 「提前加载下一家会话」开关：布尔，缺省 true（下次发送任务生效，无需重启）
      if (config.runtime && config.runtime.prefetchNextSeller !== undefined) {
        merged.runtime.prefetchNextSeller = String(config.runtime.prefetchNextSeller) !== 'false';
      }
      // 卖家保底间隔：夹下限到 5s，防止手滑设成极短值把整批推向风控
      for (const k of ['sendGapMinSec', 'sendGapMaxSec']) {
        if (!config.runtime || config.runtime[k] === undefined) continue;
        const n = Number(config.runtime[k]);
        merged.runtime[k] = Number.isFinite(n) && n > 0 ? Math.max(5, Math.round(n)) : (k === 'sendGapMinSec' ? 15 : 30);
      }
      // 拼多多催收模板：单独一组配置，保存时规范化（空值回退默认，避免又出现「模板被存成空串」）
      if (config.pddMessage !== undefined) {
        const norm = pdd.getPddMessageConfig({ pddMessage: config.pddMessage });
        merged.pddMessage = { chat: norm.chat, gapMs: norm.gapMs };
      }
      // 全局通道服务器地址：所有用户的本机扩展共用，可由系统管理统一维护
      if (config.server_url !== undefined) merged.server_url = String(config.server_url || '').trim();
      // ── 助手版本治理 ──
      // 最低要求版本：留空 = 跟随服务端自身版本（推荐）；填了就以它为准（紧急划线用）
      if (config.runtime && config.runtime.agentMinVersion !== undefined) {
        const s = String(config.runtime.agentMinVersion || '').trim();
        merged.runtime.agentMinVersion = /^\d+(\.\d+){0,2}$/.test(s) ? s : '';
      }
      // 宽限天数：0~30，空=默认 3 天（服务端升级后这段时间内只提示不拦）
      if (config.runtime && config.runtime.agentUpdateGraceDays !== undefined) {
        const n = Number(config.runtime.agentUpdateGraceDays);
        merged.runtime.agentUpdateGraceDays = Number.isFinite(n) && n >= 0 ? Math.min(30, Math.round(n)) : 3;
      }
      // 安装包外部直链：dist/ 里没包（容器化部署常见）时用它兜底
      if (config.runtime && config.runtime.agentInstallerUrl !== undefined) {
        const u = String(config.runtime.agentInstallerUrl || '').trim();
        merged.runtime.agentInstallerUrl = /^https?:\/\//i.test(u) ? u : '';
      }
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
      const kp = up.searchParams.get('kind');
      const kind = kp === 'invoices' ? 'invoices' : kp === 'products' ? 'products' : 'orders';
      // 商品列表导入（前置仓补货参考）随「商品列表」菜单权限放行
      if (kind === 'products' && !canProduct) return denyProduct();
      const rawName = String(up.searchParams.get('name') || '').trim();
      const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]+/g, '_').slice(-120)
        || (kind === 'invoices' ? 'invoices.xlsx' : kind === 'products' ? 'products.xlsx' : 'orders.xlsx');
      if (!/\.(xlsx|xls)$/i.test(safeName)) throw new Error('只支持 .xlsx / .xls 文件（请上传从 1688 / 税务局导出的 Excel）');
      const buf = await readRawBody(req, 80e6);
      if (!buf) throw new Error('上传失败：内容过大（上限 80MB）或读取中断');
      if (!buf.length) throw new Error('上传失败：文件内容为空');

      const dir = kind === 'invoices' ? tenancy.invoiceDirFor(tenantId)
        : kind === 'orders' ? tenancy.orderDirFor(tenantId)
        : path.join(tenancy.dataDirFor(tenantId), '商品列表');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dest = path.join(dir, stamp + '-' + safeName);
      fs.writeFileSync(dest, buf);

      const t = taskFor(tenantId);
      taskLog(t, `▶ 上传导入（${kind === 'invoices' ? '税务局发票' : kind === 'orders' ? '1688订单' : '前置仓补货参考'}）：${safeName} · ${(buf.length / 1024).toFixed(0)}KB`);
      const r = kind === 'invoices'
        ? await importInvoiceUpload(tenantId, dest, safeName)
        : kind === 'orders'
        ? await importOrderUpload(tenantId, dest, safeName)
        : await products.importReplenishFile(tenantId, dest, safeName);
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

    // 名称映射（所有登录用户可用；普通用户只见/可改自己发票里的销方名称，超管看全局）
    if (method === 'GET' && p === '/api/mapping') {
      return sendJson(res, 200, await loadMapping(user.id, { allUsers: isAdmin }));
    }
    // 1688 商家候选：按关键词搜索、最多返回 50 条（前端下拉按需拉取，避免整表下发）
    if (method === 'GET' && p === '/api/mapping/sellers') {
      return sendJson(res, 200, await searchSellers(user.id, {
        q: url.searchParams.get('q') || '',
        limit: url.searchParams.get('limit'),
        allUsers: isAdmin,
      }));
    }
    if (method === 'POST' && p === '/api/mapping') {
      const body = await readBody(req);
      if (!(await canMaintainSeller(user, body.taxSellerName))) {
        return sendJson(res, 403, { error: '该销方名称不在你的发票数据里，无权维护' });
      }
      writeGuard(); return sendJson(res, 200, await saveMapping(user.id, body));
    }
    if (method === 'POST' && p === '/api/mapping/delete') {
      const body = await readBody(req);
      if (!(await canMaintainSeller(user, body.taxSellerName))) {
        return sendJson(res, 403, { error: '该销方名称不在你的发票数据里，无权维护' });
      }
      writeGuard(); return sendJson(res, 200, await deleteMapping(user.id, body));
    }
    if (method === 'POST' && p === '/api/mapping/ignore') {
      const body = await readBody(req);
      if (!(await canMaintainSeller(user, body.taxSellerName))) {
        return sendJson(res, 403, { error: '该销方名称不在你的发票数据里，无权维护' });
      }
      writeGuard(); return sendJson(res, 200, await ignoreMapping(user.id, body));
    }

    // ── 商品列表（前置仓补货参考导入） ── 所有登录用户可用（菜单不做逐用户授权）
    if (method === 'GET' && p === '/api/products') {
      if (!canProduct) return denyProduct();
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      // 上限 2000：补货界面要一次展示本次导入的全部商品（导入文件常见几百~上千行）
      const size = Math.min(2000, Math.max(1, Number(url.searchParams.get('size')) || 20));
      const q = (url.searchParams.get('q') || '').trim();
      const status = (url.searchParams.get('status') || '').trim();
      const sort = url.searchParams.get('sort') || ''; // ''=最近更新 | price_asc | price_desc
      const batch = (url.searchParams.get('batch') || '').trim(); // 补货界面：只取某次导入的商品
      const w = (q ? 'AND (sku LIKE ? OR goods_name LIKE ?) ' : '')
        + (status ? 'AND purchase_status = ? ' : '')
        + (batch ? 'AND batch_id = ? ' : '');
      const args = [];
      if (q) args.push(`%${q}%`, `%${q}%`);
      if (status) args.push(status);
      if (batch) args.push(batch);
      const order = sort === 'price_asc' ? 'purchase_price ASC, id ASC'
        : sort === 'price_desc' ? 'purchase_price DESC, id DESC'
        : 'updated_at DESC, id DESC';
      const totalR = await db.query(`SELECT COUNT(*) AS n FROM product_item WHERE user_id = ? ${w}`, [tenantId, ...args]);
      const rows = await db.query(`
        SELECT id, sku, goods_name, purchase_price, available_stock, transit_stock, purchase_status, sales_30d,
               suggest_qty, qht_goods_id, local_price, source_file, updated_at
        FROM product_item WHERE user_id = ? ${w}
        ORDER BY ${order} LIMIT ${size} OFFSET ${(page - 1) * size}
      `, [tenantId, ...args]);
      // 当前筛选口径下的总货值（(可用+在途)×采购价 合计），与趋势图口径一致
      const valueR = await db.query(`
        SELECT ROUND(SUM((available_stock + transit_stock) * purchase_price), 2) AS v,
               SUM(purchase_price IS NOT NULL AND purchase_price > 0) AS priced
        FROM product_item WHERE user_id = ? ${w}`, [tenantId, ...args]);
      const latest = await db.query(
        'SELECT id, source_file, item_count, total_value, imported_at FROM product_import_batch WHERE user_id = ? ORDER BY imported_at DESC, id DESC LIMIT 1', [tenantId]
      );
      return sendJson(res, 200, {
        total: totalR[0] ? totalR[0].n : 0, page, size, rows,
        filteredValue: valueR[0] ? (valueR[0].v || 0) : 0,
        latestBatch: latest[0] || null,
      });
    }

    // 总货值趋势：按导入批次（每次导入记一个点）
    if (method === 'GET' && p === '/api/products/trend') {
      if (!canProduct) return denyProduct();
      const rows = await db.query(`
        SELECT id, source_file, item_count, total_value, imported_at
        FROM product_import_batch WHERE user_id = ?
        ORDER BY imported_at ASC, id ASC LIMIT 90
      `, [tenantId]);
      return sendJson(res, 200, { days: rows });
    }

    // ── 齐货通（商品关联 / 实时取价 / 加入购物车）── 随「商品列表」菜单权限一同放行
    if (p.startsWith('/api/qht/') && !canProduct) return denyProduct();
    if (method === 'GET' && p === '/api/qht/session') {
      return sendJson(res, 200, await qht.sessionStatus(tenantId));
    }
    if (method === 'POST' && p === '/api/qht/session') {
      writeGuard();
      const b = await readBody(req);
      return sendJson(res, 200, await qht.saveSession(tenantId, { token: b.token, xUser: b.xUser }));
    }
    if (method === 'GET' && p === '/api/qht/search') {
      try {
        return sendJson(res, 200, await qht.searchGoods(tenantId, url.searchParams.get('keyword'), {
          pageNum: url.searchParams.get('pageNum'),
          pageSize: url.searchParams.get('pageSize'),
        }));
      } catch (e) {
        return sendJson(res, 200, { error: String((e && e.message) || e), code: (e && e.code) || 'unknown', rows: [], total: 0 });
      }
    }
    // 批量取价：ids=37207,1002（齐货通商品ID，逗号分隔）
    if (method === 'GET' && p === '/api/qht/prices') {
      const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return sendJson(res, 200, { prices: {} });
      try {
        return sendJson(res, 200, await qht.pricesByGoodsIds(tenantId, ids));
      } catch (e) {
        return sendJson(res, 200, { error: String((e && e.message) || e), code: (e && e.code) || 'unknown', prices: {} });
      }
    }
    // 加入购物车：会在用户自己的齐货通账号里真实加一件，只在用户点确认后调用一次
    if (method === 'POST' && p === '/api/qht/cart') {
      writeGuard();
      const b = await readBody(req);
      try {
        return sendJson(res, 200, await qht.addToCart(tenantId, b));
      } catch (e) {
        return sendJson(res, 200, { error: String((e && e.message) || e), code: (e && e.code) || 'unknown' });
      }
    }

    // 关联齐货通商品（按 user+sku）/ 保存本地价
    if (method === 'POST' && p === '/api/products/link') {
      if (!canProduct) return denyProduct();
      writeGuard();
      const b = await readBody(req);
      const sku = String(b.sku || '').trim();
      const goodsId = String(b.goodsId == null ? '' : b.goodsId).trim();
      if (!sku) return sendJson(res, 200, { error: '缺少 sku' });
      const r = await db.exec(
        'UPDATE product_item SET qht_goods_id = ? WHERE user_id = ? AND sku = ?',
        [goodsId || null, tenantId, sku]
      );
      return sendJson(res, 200, { ok: true, sku, goodsId: goodsId || null, affected: r.affectedRows || 0 });
    }
    if (method === 'POST' && p === '/api/products/local-price') {
      if (!canProduct) return denyProduct();
      writeGuard();
      const b = await readBody(req);
      const sku = String(b.sku || '').trim();
      if (!sku) return sendJson(res, 200, { error: '缺少 sku' });
      const raw = String(b.localPrice == null ? '' : b.localPrice).trim();
      let v = null;
      if (raw !== '') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return sendJson(res, 200, { error: '本地价应为非负数字' });
        v = Math.round(n * 100) / 100;
      }
      await db.exec('UPDATE product_item SET local_price = ? WHERE user_id = ? AND sku = ?', [v, tenantId, sku]);
      return sendJson(res, 200, { ok: true, sku, localPrice: v });
    }

    // ── 交易市场（跨用户共享） ──
    if (method === 'GET' && p === '/api/market') {
      if (!canMarket) return denyMarket();
      return sendJson(res, 200, await products.marketOverview({
        page: url.searchParams.get('page'),
        size: url.searchParams.get('size'),
        q: url.searchParams.get('q') || '',
      }));
    }
    if (method === 'GET' && p === '/api/market/quotes') {
      if (!canMarket) return denyMarket();
      const sku = String(url.searchParams.get('sku') || '').trim();
      if (!sku) return sendJson(res, 400, { error: '缺少 sku' });
      return sendJson(res, 200, await products.marketQuotes(sku));
    }
    if (method === 'POST' && p === '/api/market/publish') {
      if (!canMarket) return denyMarket();
      writeGuard();
      const body = await readBody(req);
      return sendJson(res, 200, await products.publishToMarket(user.id, body.skus, body.discount));
    }

    // ── 账单（按月收支；1688 / 拼多多金额由系统实时统计，其余手工录入）──
    if (method === 'GET' && p === '/api/billing') {
      if (!canBilling) return denyBilling();
      const months = url.searchParams.get('months');
      return sendJson(res, 200, await billing.overview(tenantId, { months }));
    }
    if (method === 'POST' && p === '/api/billing/cell') {
      if (!canBilling) return denyBilling();
      writeGuard();
      try {
        return sendJson(res, 200, await billing.saveCell(tenantId, await readBody(req)));
      } catch (e) {
        return sendJson(res, 200, { error: String((e && e.message) || e) });
      }
    }
    if (method === 'POST' && p === '/api/billing/month') {
      if (!canBilling) return denyBilling();
      writeGuard();
      try {
        return sendJson(res, 200, await billing.addMonth(tenantId, await readBody(req)));
      } catch (e) {
        return sendJson(res, 200, { error: String((e && e.message) || e) });
      }
    }

    // 订单级开票状态
    if (method === 'POST' && p === '/api/order-state') { writeGuard(); return sendJson(res, 200, await setOrderState(tenantId, await readBody(req))); }

    // 任务进度 / 停止
    if (method === 'GET' && p === '/api/task') return sendJson(res, 200, taskFor(tenantId));
    if (method === 'POST' && p === '/api/task/stop') {
      writeGuard();
      const t = taskFor(tenantId);
      if (t.running) {
        t.stopRequested = true;
        taskLog(t, '⏸ 收到停止请求：立即中止当前步骤（正在发送的这一条可能已发出，无法撤回），剩余卖家记为未发送');
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
      return sendJson(res, 200, { ...agentHub.status(user.id), userId: user.id, version: checkAgentVersion(user.id) });
    }
    // 助手版本治理（管理员）：最低要求、可分发包、每台设备的版本。普通用户只读自己那份。
    if (method === 'GET' && p === '/api/agent/versions') {
      const pol = agentUpdatePolicy();
      const weAreAdmin = String(user.role) === 'admin';
      const mine = await db.query(
        'SELECT id, user_id, device_name, os, agent_ver, last_ip, last_seen_at, revoked_at, created_at ' +
        'FROM agent_device WHERE revoked_at IS NULL AND user_id = ? ORDER BY id DESC',
        [user.id]
      );
      const rows = weAreAdmin
        ? await db.query(
          'SELECT id, user_id, device_name, os, agent_ver, last_ip, last_seen_at, revoked_at, created_at ' +
          'FROM agent_device WHERE revoked_at IS NULL ORDER BY user_id, id DESC')
        : mine;
      return sendJson(res, 200, {
        ...pol,
        scopedToSelf: !weAreAdmin,
        devices: rows.map((r) => {
          const uid = Number(r.user_id || 0);
          const live = agentHub.status(uid);
          const ver = String((live.online && live.agentVer) || r.agent_ver || '');
          return {
            id: Number(r.id), userId: uid, name: r.device_name || '', os: r.os || '',
            agentVer: ver, online: !!live.online,
            lastIp: r.last_ip || '', lastSeenAt: r.last_seen_at, createdAt: r.created_at,
            outdated: !!ver && !verGte(ver, pol.min),
          };
        }),
      });
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
        throw new Error('本机助手未连接：请先在本机启动「催收小助手」桌面程序，再点「续跑」');
      }
      doClientSend(tenantId, picked.loginIds, { resumeOf: picked.taskId, titleId: picked.titleId }).catch((e) => {
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
      const titleId = Number((body || {}).titleId) || 0;
      if (!Array.isArray(loginIds) || loginIds.length === 0) throw new Error('缺少 loginIds');
      const t = taskFor(tenantId);
      if (t.running) throw new Error('已有任务在运行中');
      if (!agentHub.isOnline(tenantId)) {
        throw new Error('本机助手未连接：请先在本机启动「催收小助手」桌面程序并完成绑定（页面右上角有「下载本机助手 / 绑定本机助手」入口）。发送只在你本机执行');
      }
      // 版本门禁：过了宽限期且旧助手还能跑业务的，统统拦下（拿不到新版时会自动放行）
      const vchk = checkAgentVersion(tenantId);
      if (vchk.blocking) {
        throw new Error(`这台电脑上的催收小助手是 v${vchk.current}，版本过旧：发送催收消息需要 v${vchk.min} 及以上。`
          + '请先点页面右上角「下载本机助手」安装新版，新版的停止响应更快、发送也更快。');
      }
      doClientSend(tenantId, loginIds, { titleId }).catch((e) => {
        const ts = taskFor(tenantId);
        ts.running = false;
        taskLog(ts, '✗ 任务异常: ' + e.message);
      });
      return sendJson(res, 200, { started: true, channel: 'client' });
    }

    // ── 牵牛花：退单列表 / 实时毛利（按「菜单权限」分别放行；超级管理员始终可用）──
    //    数据归属：tenantOf(req, url, user) —— 普通用户永远是自己的数据；
    //    超级管理员通过 ?tenant=<userId>「以某个用户的角色进入」查看/操作该用户的数据。
    if (p.startsWith('/api/qnh/')) {
      const canRefund = isAdmin || !!Number(user.qnh_refund_enabled);
      const canProfit = isAdmin || !!Number(user.qnh_profit_enabled);
      const qnhUid = tenantId;   // 本块所有读写的「数据归属用户」
      const profitApi = p === '/api/qnh/profit' || p === '/api/qnh/profit/pull' || p === '/api/qnh/profit/trend';
      if (profitApi) {
        if (!canProfit) return sendJson(res, 403, { error: '未开启毛利监控权限，请联系超级管理员' });
      } else if (p === '/api/qnh/status' || p === '/api/qnh/logout') {
        // 两个面板都要用它拿配置 / 退出登录，任一权限即可
        if (!canRefund && !canProfit) return sendJson(res, 403, { error: '未开启菜单权限，请联系超级管理员' });
      } else if (!canRefund) {
        return sendJson(res, 403, { error: '未开启退单列表权限，请联系超级管理员' });
      }

      if (method === 'GET' && p === '/api/qnh/status') {
        const [cookie, ucfg, sum] = await Promise.all([
          qnh.cookieStatus(qnhUid), qnh.getConfigFor(qnhUid), qnh.summary(qnhUid).catch(() => null),
        ]);
        const out = {
          cookie,
          config: qnh.publicConfig(ucfg),
          sync: qnh.getSyncState(),
          // 退单概况只给有退单权限的人（毛利-only 用户不需要）
          summary: canRefund ? sum : null,
          isAdmin,
          canRefund,
          canProfit,
          tenantId: qnhUid,
        };
        // 管理员需要「以某账号身份进入」：给它账号列表 + 哪些账号已登录牵牛花
        if (isAdmin) {
          try {
            out.sessions = await qnh.usersWithSession();
            out.users = (await listUsers()).map((u) => ({
              id: u.id, username: u.username, companyName: u.companyName, role: u.role,
              qnhRefundEnabled: !!u.qnhRefundEnabled, qnhProfitEnabled: !!u.qnhProfitEnabled,
            }));
          } catch (e) { /* 列表拿不到不影响主流程 */ }
        }
        return sendJson(res, 200, out);
      }

      if (method === 'GET' && p === '/api/qnh/summary') {
        return sendJson(res, 200, await qnh.summary(qnhUid));
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
          userId: qnhUid,
        }));
      }

      if (method === 'GET' && p === '/api/qnh/trend') {
        return sendJson(res, 200, { days: await qnh.refundTrend(url.searchParams.get('days') || 30, qnhUid) });
      }

      if (method === 'GET' && p === '/api/qnh/logs') {
        const refundNo = (url.searchParams.get('refundNo') || '').trim().slice(0, 64);
        if (!refundNo) return sendJson(res, 400, { error: '缺少退单号' });
        const out = await qnh.getLogsWithRoute(refundNo, url.searchParams.get('type') || '', qnhUid);
        return sendJson(res, 200, { refundNo, logs: out.logs, route: out.route });
      }

      // 「登录牵牛花」：不再由服务器打开浏览器（云端没有显示器/浏览器二进制），
      // 改为把任务下发给**该用户**的「本机助手」→ 助手弹窗让你登录 → 回传登录态入库（归属该用户）。
      // 返回 pending + taskId，前端轮询 /api/qnh/login-status 拿结果。
      // 权限：有退单列表权限即可（管理员以某用户身份进入时，登录的就是该用户的牵牛花）。
      if (method === 'POST' && p === '/api/qnh/login') {
        // 与拼多多一致：优先目标用户自己的助手，管理员代入时用管理员本机在线的助手，
        // 登录态仍写进 qnhUid 名下。
        const aUid = agentUidFor(user, qnhUid);
        const onMyPc = aUid && Number(aUid) !== Number(qnhUid);
        if (!aUid) {
          return sendJson(res, 200, {
            ok: false,
            needAgent: true,
            message: '本机助手未连接：请先在电脑上启动「催收小助手」并点页面右上角「绑定本机助手」完成绑定。'
              + '牵牛花登录只在本机完成，服务器不会代你登录。',
          });
        }
        // 旧版助手没有这个能力：它会直接忽略指令，用户只能干等到超时
        if (!agentVersionGate(res, aUid, '登录牵牛花')) return;
        const agentVer = agentHub.status(aUid).agentVer || '';
        if (agentVer && !verGte(agentVer, QNH_LOGIN_MIN_AGENT)) {
          return sendJson(res, 200, {
            ok: false,
            needAgent: true,
            agentOutdated: true,
            message: `这台电脑上的催收小助手是 v${agentVer}，还不支持登录牵牛花。请下载安装 v${QNH_LOGIN_MIN_AGENT} 及以上版本。`,
          });
        }
        const taskId = 'qnh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const ctx = {
          taskId, userId: Number(qnhUid), status: 'pending', message: '',
          cookieCount: 0, writtenAt: null, createdAt: Date.now(),
          expiresAt: Date.now() + QNH_LOGIN_TTL_MS,
        };
        const sent = agentHub.send(aUid, {
          type: 'qnh_login',
          taskId,
          url: (process.env.QNH_BASE_URL || 'https://qnh.meituan.com').replace(/\/+$/, ''),
          timeoutMs: QNH_LOGIN_TIMEOUT_MS,
        });
        if (!sent) {
          return sendJson(res, 200, {
            ok: false, needAgent: true,
            message: '下发登录任务失败：本机助手连接已断开，请确认助手正在运行。',
          });
        }
        QNH_LOGINS.set(taskId, ctx);
        await logOp(user, 'qnh.login.start', { tenantId: qnhUid, agentUid: aUid });
        return sendJson(res, 200, {
          ok: true, pending: true, taskId,
          message: onMyPc
            ? '已在你本机的助手窗口里打开牵牛花登录（登录态记在「' + ((await tenantLabelOf(qnhUid)) || '该账号') + '」名下），请在窗口里完成登录。'
            : '已在该用户电脑上打开牵牛花登录窗口，请在弹出的助手窗口里完成登录。',
        });
      }

      // 轮询「登录牵牛花」的进度（status: pending / done / failed）
      // 本人可查自己的任务；管理员可查其代入用户的任务
      if (method === 'GET' && p === '/api/qnh/login-status') {
        const ctx = QNH_LOGINS.get(String(url.searchParams.get('taskId') || ''));
        const mine = ctx && (ctx.userId === Number(user.id) || (isAdmin && ctx.userId === Number(qnhUid)));
        if (!mine) return sendJson(res, 404, { error: '登录任务不存在或已结束' });
        return sendJson(res, 200, {
          status: ctx.status,
          ok: ctx.status === 'done',
          message: ctx.message || '',
          cookieCount: ctx.cookieCount,
          writtenAt: ctx.writtenAt,
        });
      }

      // 「退出牵牛花账号」：删库里的登录态 + 让本机助手清掉浏览器分区里的 Cookie。
      // 退单列表与实时毛利监控共用同一个牵牛花登录态，所以一处退出两处都回到未登录。
      if (method === 'POST' && p === '/api/qnh/logout') {
        const info = await qnh.sessionInfo(qnhUid).catch(() => null);
        await qnh.clearLoginState(qnhUid);
        const agent = await agentLogout(agentUidFor(user, qnhUid) || qnhUid, 'qnh');
        await logOp(user, 'qnh.logout', {
          tenantId: qnhUid,
          accountName: (info && info.accountName) || '',
          agentCleared: !!agent.ok,
        });
        return sendJson(res, 200, {
          ok: true,
          accountName: (info && info.accountName) || '',
          agentCleared: !!agent.ok,
          agentOffline: !!agent.offline,
          message: '已退出牵牛花账号'
            + (info && info.accountName ? `「${info.accountName}」` : '')
            + '，服务器登录态已清除（退单列表与实时毛利监控都回到未登录）。'
            + logoutAgentNote(agent, '牵牛花'),
        });
      }

      // 「立即刷新数据」：有退单列表权限即可触发（同步的是当前代入用户的登录态与数据）
      if (method === 'POST' && p === '/api/qnh/sync') {
        const body = await readBody(req);
        const out = await qnh.runSync({
          trigger: 'manual',
          days: Number(body.days) || null,
          date: body.date || null,
          userId: qnhUid,
        });
        await logOp(user, 'qnh.sync', { ok: !!out.ok, tenantId: qnhUid });
        return sendJson(res, 200, out);
      }

      // 配置写入：按「谁的配置」分两半 ——
      //   · 全局项（定时同步时间等）：仅超级管理员
      //   · 用户项（提醒机器人 / 告警阈值 / 拉取参数）：写到当前代入用户的配置里
      //     （普通用户改自己的；管理员以某用户身份进入时改的就是该用户的）
      if (method === 'POST' && p === '/api/qnh/config') {
        const body = await readBody(req);
        const globalPatch = {};
        const userPatch = {};
        if (body.scheduleEnabled !== undefined) globalPatch[qnh.CFG.scheduleEnabled] = body.scheduleEnabled ? '1' : '0';
        // 多时间点（"09:00,15:00" 或数组）；旧的 scheduleTime 单字段仍兼容
        if (body.scheduleTimes !== undefined) {
          const arr = Array.isArray(body.scheduleTimes) ? body.scheduleTimes : String(body.scheduleTimes).split(',');
          const times = qnh._internals.parseScheduleTimes(arr.join(','));
          if (!times.length) return sendJson(res, 400, { error: '时间格式应为 HH:mm（多个用逗号分隔）' });
          globalPatch[qnh.CFG.scheduleTimes] = times.join(',');
          globalPatch[qnh.CFG.scheduleTime] = times[0];
        }
        if (body.scheduleTime !== undefined) {
          const t = String(body.scheduleTime).trim();
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return sendJson(res, 400, { error: '时间格式应为 HH:mm' });
          globalPatch[qnh.CFG.scheduleTime] = t;
        }
        if (body.webhook !== undefined) userPatch[qnh.CFG.webhook] = String(body.webhook).trim().slice(0, 500);
        if (body.wecomEnabled !== undefined) userPatch[qnh.CFG.wecomEnabled] = body.wecomEnabled ? '1' : '0';
        if (body.alertDelivery !== undefined) userPatch[qnh.CFG.alertDelivery] = body.alertDelivery ? '1' : '0';
        if (body.remindTemplate !== undefined) {
          // 模板只做格式约束：逗号/顿号分隔的字段名，识别不了的会在渲染时忽略
          const tpl = String(body.remindTemplate).trim().slice(0, 200);
          userPatch[qnh.CFG.remindTemplate] = tpl || '订单号,渠道,退单类型';
        }
        if (body.profitEnabled !== undefined) userPatch[qnh.CFG.profitEnabled] = body.profitEnabled ? '1' : '0';
        // 毛利告警专用机器人（与退单提醒的 webhook/总开关完全独立）
        if (body.profitWebhook !== undefined) userPatch[qnh.CFG.profitWebhook] = String(body.profitWebhook).trim().slice(0, 500);
        if (body.profitWecomEnabled !== undefined) userPatch[qnh.CFG.profitWecomEnabled] = body.profitWecomEnabled ? '1' : '0';
        // 阈值允许负数（毛利为负很常见：如「毛利低于 -5 元」「毛利率低于 -10% 告警」）
        if (body.profitMinAmount !== undefined) {
          const n = Number(body.profitMinAmount);
          if (!Number.isFinite(n) || n < -1000000 || n > 1000000) {
            return sendJson(res, 400, { error: '毛利阈值应为数字（±1000000 以内，可为负）' });
          }
          userPatch[qnh.CFG.profitMinAmount] = String(n);
        }
        if (body.profitMinRate !== undefined) {
          const n = Number(body.profitMinRate);
          if (!Number.isFinite(n) || n < -100 || n > 100) {
            return sendJson(res, 400, { error: '毛利率阈值应为 -100 ~ 100 的数字' });
          }
          userPatch[qnh.CFG.profitMinRate] = String(n);
        }

        if (Object.keys(globalPatch).length) {
          if (!isAdmin) return sendJson(res, 403, { error: '定时同步等全局设置仅超级管理员可修改' });
          await qnh.setConfig(globalPatch);
        }
        if (Object.keys(userPatch).length) {
          await qnh.setUserConfig(qnhUid, userPatch);
        }
        const cfg = await qnh.getConfigFor(qnhUid);
        const labels = [];
        if (globalPatch[qnh.CFG.scheduleEnabled] !== undefined) labels.push('定时' + (globalPatch[qnh.CFG.scheduleEnabled] === '1' ? '开启' : '关闭'));
        if (globalPatch[qnh.CFG.scheduleTimes] !== undefined) labels.push('时间 ' + globalPatch[qnh.CFG.scheduleTimes]);
        if (globalPatch[qnh.CFG.scheduleTime] !== undefined) labels.push('时间 ' + globalPatch[qnh.CFG.scheduleTime]);
        if (userPatch[qnh.CFG.wecomEnabled] !== undefined) labels.push('企业微信' + (userPatch[qnh.CFG.wecomEnabled] === '1' ? '开启' : '关闭'));
        if (userPatch[qnh.CFG.alertDelivery] !== undefined) labels.push('配送日志提醒' + (userPatch[qnh.CFG.alertDelivery] === '1' ? '开启' : '关闭'));
        if (userPatch[qnh.CFG.webhook] !== undefined) labels.push('更新了机器人地址');
        if (userPatch[qnh.CFG.profitWebhook] !== undefined) labels.push('更新了毛利告警机器人地址');
        if (userPatch[qnh.CFG.profitWecomEnabled] !== undefined) {
          labels.push('毛利告警机器人' + (userPatch[qnh.CFG.profitWecomEnabled] === '1' ? '开启' : '关闭'));
        }
        await logOp(user, 'qnh.config', { items: labels.join('、') || '无变化', tenantId: qnhUid });
        return sendJson(res, 200, { ok: true, config: qnh.publicConfig(cfg) });
      }

      if (method === 'POST' && p === '/api/qnh/test-webhook') {
        const b = await readBody(req).catch(() => ({}));
        const type = b && b.type === 'profit' ? 'profit' : 'refund';
        if (type === 'profit' && !canProfit) return sendJson(res, 403, { error: '未开启毛利监控权限' });
        if (!canRefund) return sendJson(res, 403, { error: '未开启退单列表权限' });
        return sendJson(res, 200, await qnh.testWebhook(type, qnhUid));
      }

      // ── 实时毛利监控 ──
      // 查看毛利数据与告警配置（有毛利监控权限即可看；管理员看到的是代入用户的数据）
      if (method === 'GET' && p === '/api/qnh/profit') {
        return sendJson(res, 200, await qnh.profitOverview({ limit: url.searchParams.get('limit') || 100, userId: qnhUid }));
      }
      // 每天毛利总额趋势（按日期聚合线上毛利合计）
      if (method === 'GET' && p === '/api/qnh/profit/trend') {
        return sendJson(res, 200, { days: await qnh.profitTrend(url.searchParams.get('days') || 30, qnhUid) });
      }
      // 立即拉取当天毛利明细（经该用户的本机助手页内签名接口）
      if (method === 'POST' && p === '/api/qnh/profit/pull') {
        const out = await qnh.pullProfitOrders({ userId: qnhUid });
        if (out.ok) await logOp(user, 'qnh.profit_pull', { rows: out.rows, alerts: out.alerts, tenantId: qnhUid });
        return sendJson(res, 200, out);
      }
      // 手动触发一次「超24h待处理」提醒（检查当前代入用户的数据）
      if (method === 'POST' && p === '/api/qnh/notify-pending') {
        const out = await qnh.notifyPending24h({ force: true, userId: qnhUid });
        await logOp(user, 'qnh.notify_pending', { ok: !!out.ok, sent: out.sent, tenantId: qnhUid });
        return sendJson(res, 200, out);
      }

      return sendJson(res, 404, { error: '未知退单接口' });
    }

    // ── 拼多多发票看板（对所有登录用户开放，不需要菜单权限）────────────────
    //    多租户规则与牵牛花一致：数据归属 tenantOf(req, url, user)。
    //    差别：列表接口不需要风控签名，**服务器可直连拉取**；
    //          只有「登录拼多多」要本机助手（服务器没有浏览器，登录只在本机完成）。
    if (p.startsWith('/api/pdd/')) {
      const pddUid = tenantId;   // 本块所有读写的「数据归属用户」

      // 概况：登录态 + 状态汇总 + 状态字典；管理员额外拿到账号列表以便「代入」
      if (method === 'GET' && p === '/api/pdd/status') {
        const [cookie, sum, orderSync] = await Promise.all([
          pdd.cookieStatus(pddUid).catch(() => ({ ok: false, logined: false, message: '登录态读取失败' })),
          pdd.summary(pddUid).catch(() => null),
          pddOrders.orderSyncSummary(pddUid).catch(() => null),
        ]);
        const out = {
          cookie,
          summary: sum,
          orderSync,
          // 「获取订单数据」首次全量不再限时间，一直翻到空页；这里给页面用的翻页上限（系统管理可改）
          maxPages: psync.getMaxPages(),
          statusText: pdd.STATUS_TEXT,
          isAdmin,
          tenantId: pddUid,
        };
        // 管理员需要「以某账号身份进入」：给它账号列表 + 哪些账号已登录拼多多
        if (isAdmin) {
          try {
            out.sessions = await pdd.usersWithSession();
            out.users = (await listUsers()).map((u) => ({
              id: u.id, username: u.username, companyName: u.companyName, role: u.role,
              pddEnabled: !!u.pddEnabled,
            }));
          } catch (e) { /* 列表拿不到不影响主流程 */ }
        }
        return sendJson(res, 200, out);
      }

      // 订单列表（已完成订单：待申请 / 开票中 / 已开票 / 商家处理中 / 暂不可开票）
      if (method === 'GET' && p === '/api/pdd/orders') {
        const q = url.searchParams;
        const status = q.get('status');
        return sendJson(res, 200, await pdd.list({
          status: (status === null || status === 'all') ? '' : status,
          keyword: q.get('keyword') || '',
          sort: q.get('sort') || '',
          page: q.get('page'),
          size: q.get('size'),
          userId: pddUid,
        }));
      }

      if (method === 'GET' && p === '/api/pdd/summary') {
        return sendJson(res, 200, await pdd.summary(pddUid));
      }

      // 「立即刷新数据」：服务器直连拼多多接口，不需要助手在线
      if (method === 'POST' && p === '/api/pdd/sync') {
        const out = await pdd.sync({ userId: pddUid, trigger: 'manual' });
        await logOp(user, 'pdd.sync', { ok: !!out.ok, total: out.total, tenantId: pddUid });
        return sendJson(res, 200, out);
      }

      // 「获取订单数据」：拉「我的订单」全部订单（待付款/待发货/待收货/已完成/已退款）
      // 数据源 order_list_v4（cookie 直连，不需要助手）；首次全量、之后增量。
      // 全量要翻几十页（限速 900ms/页），不能让浏览器干等 → 后台任务 + 进度轮询（复用 task-status）。
      if (method === 'POST' && p === '/api/pdd/orders-sync') {
        const b = await readBody(req).catch(() => ({}));
        const running = [...PDD_TASKS.values()].find(
          (c) => c.kind === 'orders' && c.userId === Number(pddUid) && c.status === 'pending'
        );
        if (running) {
          return sendJson(res, 200, {
            ok: true, pending: true, taskId: running.taskId, already: true,
            message: '订单同步正在运行中，继续展示进度…',
          });
        }
        // 首次（库里还没有订单列表同步过的数据）自动全量；之后默认增量
        let full = b.full === true || b.full === 'true';
        if (!(await pddOrders.hasOrderData(pddUid))) full = true;

        const taskId = 'pddord-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const ctx = {
          taskId, kind: 'orders', full, userId: Number(pddUid), status: 'pending', message: '',
          total: 0, results: [], okCount: 0, failCount: 0,
          progress: { page: 0, fetched: 0, rows: 0, saved: 0, newCount: 0, current: '' },
          progressLog: [], createdAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000,
        };
        const pushLog = (text) => {
          // 本地时间（toISOString 是 UTC，用户看到的会是 08:xx 而不是 16:xx）
          const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          ctx.progressLog.push({ t, text });
          if (ctx.progressLog.length > 300) ctx.progressLog.shift();
        };
        PDD_TASKS.set(taskId, ctx);
        pushLog(full
          ? '开始全量拉取订单（不限时间范围，一直往前翻到空页为止）…'
          : '开始增量拉取订单（从最新往前翻，追平即停）…');

        pddOrders.syncOrders({
          userId: pddUid,
          full,
          onProgress: (pr) => {
            ctx.progress = Object.assign({}, ctx.progress, pr);
            ctx.total = pr.fetched || 0;
            pushLog(`第 ${pr.page} 页：已拉 ${pr.fetched} 单（子单 ${pr.rows} 条），入库 ${pr.saved} 条，新增 ${pr.newCount}`);
          },
          shouldStop: () => !!ctx.stopping,
        }).then((out) => {
          ctx.status = out.ok ? 'done' : 'failed';
          ctx.message = out.message || '';
          ctx.truncated = !!out.truncated;
          ctx.maxPages = out.maxPages || null;
          ctx.progress = Object.assign({}, ctx.progress, {
            page: out.pages || ctx.progress.page,
            fetched: out.fetched || 0, rows: out.rows || 0,
            saved: out.saved || 0, newCount: out.newCount || 0, percent: 100,
          });
          ctx.total = out.fetched || ctx.total;
          ctx.finishedAt = Date.now();
          ctx.expiresAt = Date.now() + PDD_APPLY_TTL_MS;
          if (ctx.truncated) pushLog(`已到翻页上限（${out.maxPages} 页），更早的订单未拉取，可在系统管理调大上限`);
          pushLog((out.ok ? '✓ ' : '✗ ') + (out.message || ''));
        }).catch((e) => {
          ctx.status = 'failed';
          ctx.message = (e && e.message) || String(e);
          ctx.finishedAt = Date.now();
          pushLog('✗ 同步异常：' + ctx.message);
        });

        await logOp(user, 'pdd.orders.sync', { tenantId: pddUid, full });
        return sendJson(res, 200, {
          ok: true, pending: true, taskId, full,
          message: full
            ? '已开始全量拉取订单（不限时间范围），进度见下方…'
            : '已开始增量拉取订单（追平即停），进度见下方…',
        });
      }

      // 「登录拼多多」：把任务下发给该用户的本机助手 → 助手弹窗让用户登录 → Cookie 回传入库
      if (method === 'POST' && p === '/api/pdd/login') {
        // 管理员代入他人时，登录窗口开在「有在线助手的那台电脑」上（通常就是管理员本机），
        // 登录态仍写进被代入用户（pddUid）名下。
        const aUid = agentUidFor(user, pddUid);
        const onMyPc = aUid && Number(aUid) !== Number(pddUid);
        if (!aUid) {
          return sendJson(res, 200, {
            ok: false,
            needAgent: true,
            message: '本机助手未连接：请先在电脑上启动「催收小助手」并点页面右上角「绑定本机助手」完成绑定。'
              + '拼多多登录只在本机完成，服务器不会代你登录。',
          });
        }
        if (!agentVersionGate(res, aUid, '登录拼多多')) return;
        const agentVer = agentHub.status(aUid).agentVer || '';
        if (agentVer && !verGte(agentVer, PDD_LOGIN_MIN_AGENT)) {
          return sendJson(res, 200, {
            ok: false,
            needAgent: true,
            agentOutdated: true,
            message: `这台电脑上的催收小助手是 v${agentVer}，还不支持登录拼多多。请下载安装 v${PDD_LOGIN_MIN_AGENT} 及以上版本。`,
          });
        }
        const taskId = 'pdd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const ctx = {
          taskId, userId: Number(pddUid), status: 'pending', message: '',
          cookieCount: 0, writtenAt: null, createdAt: Date.now(),
          expiresAt: Date.now() + PDD_LOGIN_TTL_MS,
        };
        const sent = agentHub.send(aUid, {
          type: 'pdd_login',
          taskId,
          // 发票助手页：未登录会自动跳登录，登录完正好停在订单页，方便确认身份
          url: (process.env.PDD_LOGIN_URL || 'https://mobile.yangkeduo.com/commercial_pre_orders.html'),
          timeoutMs: PDD_LOGIN_TIMEOUT_MS,
        });
        if (!sent) {
          return sendJson(res, 200, {
            ok: false, needAgent: true,
            message: '下发登录任务失败：本机助手连接已断开，请确认助手正在运行。',
          });
        }
        PDD_LOGINS.set(taskId, ctx);
        await logOp(user, 'pdd.login.start', { tenantId: pddUid, agentUid: aUid });
        return sendJson(res, 200, {
          ok: true, pending: true, taskId,
          message: (onMyPc ? '已在你本机的助手窗口里打开拼多多登录（登录态记在「' + ((await tenantLabelOf(pddUid)) || '该账号') + '」名下），' : '已在该用户电脑上打开拼多多登录窗口，')
            + '请在弹出的助手窗口里完成登录（支持扫码/短信验证）。',
        });
      }

      // 轮询「登录拼多多」进度（status: pending / done / failed）
      if (method === 'GET' && p === '/api/pdd/login-status') {
        const ctx = PDD_LOGINS.get(String(url.searchParams.get('taskId') || ''));
        const mine = ctx && (ctx.userId === Number(user.id) || (isAdmin && ctx.userId === Number(pddUid)));
        if (!mine) return sendJson(res, 404, { error: '登录任务不存在或已结束' });
        return sendJson(res, 200, {
          status: ctx.status,
          ok: ctx.status === 'done',
          message: ctx.message || '',
          cookieCount: ctx.cookieCount,
          writtenAt: ctx.writtenAt,
        });
      }

      // 退出登录：清掉该用户的拼多多 Cookie（登录态失效/换账号时用）
      // 顺带让该用户的本机助手把浏览器分区里的 Cookie 也清掉——只删库的话，
      // 本机分区还留着旧账号，下次点「登录」会直接免登录进去（看起来像没退掉）。
      if (method === 'POST' && p === '/api/pdd/logout') {
        // 先记下是谁，退出后库里就没有这条记录了
        const info = await pdd.sessionInfo(pddUid).catch(() => null);
        await pdd.clearSession(pddUid);
        const agent = await agentLogout(agentUidFor(user, pddUid) || pddUid, 'pdd');
        await logOp(user, 'pdd.logout', {
          tenantId: pddUid,
          accountName: (info && info.accountName) || '',
          pdduid: (info && info.pdduid) || '',
          agentCleared: !!agent.ok,
        });
        return sendJson(res, 200, {
          ok: true,
          accountName: (info && info.accountName) || '',
          agentCleared: !!agent.ok,
          agentOffline: !!agent.offline,
          message: '已退出拼多多账号'
            + (info && info.accountName ? `「${info.accountName}」` : '')
            + '，服务器登录态已清除。'
            + logoutAgentNote(agent, '拼多多'),
        });
      }

      // 「申请发票」：校验订单归属与状态 → 派给该用户的本机助手 → 助手加载真实开票页逐单提交
      // （anti-content 必须由页面风控 SDK 生成，服务器无法复刻，所以必须走助手）
      if (method === 'POST' && p === '/api/pdd/apply') {
        const b = await readBody(req);
        const sns = Array.isArray(b.orderSns) ? b.orderSns : [];
        if (!sns.length) return sendJson(res, 200, { ok: false, message: '请先勾选要申请发票的订单' });

        if (!(await pdd.cookieStatus(pddUid).catch(() => null) || {}).logined) {
          return sendJson(res, 200, { ok: false, loginish: true, message: '尚未登录拼多多或登录态已失效，请先登录' });
        }
        const aUid = agentUidFor(user, pddUid);
        if (!aUid) {
          return sendJson(res, 200, {
            ok: false, needAgent: true,
            message: '本机助手未连接：申请发票要在本机助手里真实提交（页面生成风控签名），请先启动并绑定助手。',
          });
        }
        if (!agentVersionGate(res, aUid, '申请发票')) return;
        const agentVer = agentHub.status(aUid).agentVer || '';
        if (agentVer && !verGte(agentVer, PDD_APPLY_MIN_AGENT)) {
          return sendJson(res, 200, {
            ok: false, needAgent: true, agentOutdated: true,
            message: `这台电脑上的催收小助手是 v${agentVer}，还不支持申请发票。请升级到 v${PDD_APPLY_MIN_AGENT} 及以上。`,
          });
        }

        const { orders, invalid } = await pdd.getApplyableOrders(pddUid, sns);
        if (!orders.length) {
          return sendJson(res, 200, {
            ok: false,
            message: '没有可申请的订单：勾选的订单不属于该账号，或状态不是「待申请」'
              + (invalid.length ? `（无效：${invalid.slice(0, 3).join('、')}${invalid.length > 3 ? ' 等' : ''}）` : ''),
          });
        }

        const taskId = 'pdda-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const ctx = {
          taskId, kind: 'apply', userId: Number(pddUid), status: 'pending', message: '',
          total: orders.length, results: [], okCount: 0, failCount: 0,
          createdAt: Date.now(), expiresAt: Date.now() + PDD_APPLY_TTL_MS,
        };
        const sent = agentHub.send(aUid, {
          type: 'pdd_apply',
          taskId,
          orders: orders.map((o) => ({ order_sn: o.order_sn, mall_id: o.mall_id })),
          gapMs: 3000,          // 每单间隔，控制频率别惊动风控
          timeoutMs: 30000,     // 单单超时
        });
        if (!sent) {
          return sendJson(res, 200, { ok: false, needAgent: true, message: '下发申请任务失败：本机助手连接已断开。' });
        }
        PDD_TASKS.set(taskId, ctx);
        await logOp(user, 'pdd.apply.start', { tenantId: pddUid, total: orders.length, invalid: invalid.length });
        return sendJson(res, 200, {
          ok: true, pending: true, taskId,
          total: orders.length,
          skipped: invalid,
          message: `已下发申请任务（${orders.length} 单），正在本机助手里逐单提交…`,
        });
      }

      // 「催商家开票」：给「商家处理中」的订单发一条催收消息 → 派给该用户的本机助手
      // 助手加载真实聊天页打字点发送（anti-content 必须由页面风控 SDK 生成，服务器无法复刻）
      if (method === 'POST' && p === '/api/pdd/send') {
        const b = await readBody(req);
        const sns = Array.isArray(b.orderSns) ? b.orderSns : [];
        const pddTitleId = Number(b.titleId) || 0;
        if (!sns.length) return sendJson(res, 200, { ok: false, message: '请先勾选要催收的订单' });

        if (!(await pdd.cookieStatus(pddUid).catch(() => null) || {}).logined) {
          return sendJson(res, 200, { ok: false, loginish: true, message: '尚未登录拼多多或登录态已失效，请先登录' });
        }
        const sendUid = agentUidFor(user, pddUid);
        if (!sendUid) {
          return sendJson(res, 200, {
            ok: false, needAgent: true,
            message: '本机助手未连接：发催收消息要在本机助手里打开真实聊天页（页面生成风控签名），请先启动并绑定助手。',
          });
        }
        if (!agentVersionGate(res, sendUid, '发送催收消息')) return;
        const agentVer = agentHub.status(sendUid).agentVer || '';
        if (agentVer && !verGte(agentVer, PDD_SEND_MIN_AGENT)) {
          return sendJson(res, 200, {
            ok: false, needAgent: true, agentOutdated: true,
            message: `这台电脑上的催收小助手是 v${agentVer}，还不支持发送催收消息。请升级到 v${PDD_SEND_MIN_AGENT} 及以上。`,
          });
        }

        const { orders, invalid } = await pdd.getChatableOrders(pddUid, sns);
        if (!orders.length) {
          return sendJson(res, 200, {
            ok: false,
            message: '没有可催收的订单：只能对「商家处理中」的订单催开票'
              + (invalid.length ? `（跳过：${invalid.slice(0, 3).join('、')}${invalid.length > 3 ? ' 等' : ''}）` : ''),
          });
        }

        // 同一条话术发给同一个商家只需要一次（多个订单同一商家 = 同一会话）。
        // 但如果模板里用了 {orderSn}，说明用户想逐单说明，就按订单逐条发。
        const cfg = loadConfig();
        const msgCfg = pdd.getPddMessageConfig(cfg);
        const buyer = await buyerOfSend(Number(pddUid), pddTitleId);
        const perOrder = /\{orderSn\}/.test(msgCfg.chat);
        const items = [];
        const seenMall = new Set();
        for (const o of orders) {
          const content = pdd.buildPddMessage(cfg, buyer, {
            order_sn: o.order_sn, invoice_amount: o.invoice_amount,
          });
          if (!content.trim()) continue;   // 模板为空绝不发空消息（1688 已经踩过这个坑）
          if (!perOrder && seenMall.has(String(o.mall_id))) continue;
          seenMall.add(String(o.mall_id));
          items.push({ order_sn: o.order_sn, mall_id: o.mall_id, content });
        }
        if (!items.length) {
          return sendJson(res, 200, { ok: false, message: '催收消息内容为空：请到「系统管理 → 拼多多催收消息」配置模板' });
        }

        const taskId = 'pddm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const ctx = {
          taskId, kind: 'send', userId: Number(pddUid), status: 'pending', message: '',
          total: items.length, results: [], okCount: 0, failCount: 0,
          createdAt: Date.now(), expiresAt: Date.now() + PDD_APPLY_TTL_MS,
        };
        const sent = agentHub.send(sendUid, {
          type: 'pdd_send',
          taskId,
          items,
          gapMs: msgCfg.gapMs,  // 每个商家之间的间隔，控制频率别惊动风控
          timeoutMs: 40000,     // 单个会话超时
        });
        if (!sent) {
          return sendJson(res, 200, { ok: false, needAgent: true, message: '下发催收任务失败：本机助手连接已断开。' });
        }
        PDD_TASKS.set(taskId, ctx);
        await logOp(user, 'pdd.send.start', {
          tenantId: pddUid, total: items.length, invalid: invalid.length,
          titleId: buyer.titleId || 0, title: buyer.companyName || '',
        });
        return sendJson(res, 200, {
          ok: true, pending: true, taskId,
          total: items.length,
          merged: orders.length - items.length,   // 同商家合并掉的单数
          skipped: invalid,
          title: buyer.companyName || '',
          titleId: buyer.titleId || 0,
          preview: items[0] ? items[0].content : '',
          message: `已下发催收任务（${items.length} 个商家${orders.length > items.length ? `，${orders.length - items.length} 单同商家已合并` : ''}），正在本机助手里逐条发送…`,
        });
      }

      // 停止「页内任务」（申请发票 / 催收消息通用）：已完成的不会撤回，当前这一单处理完就停
      if (method === 'POST' && (p === '/api/pdd/apply-stop' || p === '/api/pdd/task-stop')) {
        const b = await readBody(req);
        const ctx = PDD_TASKS.get(String(b.taskId || ''));
        const mine = ctx && (ctx.userId === Number(user.id) || (isAdmin && ctx.userId === Number(pddUid)));
        if (!mine) return sendJson(res, 404, { error: '任务不存在或已结束' });
        if (ctx.status !== 'pending') return sendJson(res, 200, { ok: false, message: '任务已结束，无需停止' });
        ctx.stopping = true;
        // 订单同步是服务器自己翻页（不经过助手），只需置停止标记，当前这一页处理完就停
        if (ctx.kind === 'orders') {
          return sendJson(res, 200, { ok: true, message: '已请求停止：当前这一页处理完就停' });
        }
        const sent = agentHub.send(ctx.userId, { type: 'stop' });
        return sendJson(res, 200, {
          ok: true,
          message: sent ? '已发送停止指令：当前这一单处理完就停' : '助手连接已断开，任务会随连接中断结束',
        });
      }

      // 轮询「页内任务」进度（status: pending / done / failed）——申请发票与催收消息共用
      if (method === 'GET' && (p === '/api/pdd/apply-status' || p === '/api/pdd/task-status')) {
        const ctx = PDD_TASKS.get(String(url.searchParams.get('taskId') || ''));
        const mine = ctx && (ctx.userId === Number(user.id) || (isAdmin && ctx.userId === Number(pddUid)));
        if (!mine) return sendJson(res, 404, { error: '任务不存在或已结束' });
        return sendJson(res, 200, {
          kind: ctx.kind || 'apply',
          status: ctx.status,
          ok: ctx.status === 'done',
          message: ctx.message || '',
          full: !!ctx.full,
          maxPages: ctx.maxPages || null,
          truncated: !!ctx.truncated,
          total: ctx.total,
          results: ctx.results,
          okCount: ctx.okCount,
          failCount: ctx.failCount,
          progress: ctx.progress || null,
          progressLog: ctx.progressLog || [],
        });
      }

      return sendJson(res, 404, { error: '未知拼多多接口' });
    }

    // ── 闪电帮帮发票（/api/sdc/*）────────────────────────────────────
    // ⚠ 与拼多多不同：该站点网关要 mtgsig 签名，服务器直连 403。
    //   所以「登录 / 拉订单 / 发催收」三个动作都是：服务器下发任务 → 本机助手在真实页面里执行
    //   → 结果回传服务器入库。服务器从不用自己的网络去碰这个站点。
    if (p.startsWith('/api/sdc/')) {
      const sdcUid = tenantId;   // 本块所有读写的「数据归属用户」

      // 概况：登录台账 + 汇总 + 助手状态；管理员额外拿账号列表以便「代入」
      if (method === 'GET' && p === '/api/sdc/status') {
        const [sess, sum] = await Promise.all([
          sdc.sessionInfo(sdcUid).catch(() => ({ logined: false })),
          sdc.summary(sdcUid).catch(() => null),
        ]);
        const aUid = agentUidFor(user, sdcUid);
        const out = {
          logged: !!sess.logined,
          login: sess,
          summary: sum,
          stageText: sdc.STAGE_TEXT,
          agent: {
            online: !!(aUid && agentHub.isOnline(aUid)),
            agentVer: aUid ? (agentHub.status(aUid).agentVer || '') : '',
            minVer: SDC_MIN_AGENT,
            outdated: !!(aUid && agentHub.isOnline(aUid) && agentHub.status(aUid).agentVer
              && !verGte(agentHub.status(aUid).agentVer || '', SDC_MIN_AGENT)),
          },
          isAdmin,
          tenantId: sdcUid,
        };
        if (isAdmin) {
          try {
            out.sessions = await sdc.usersWithSession();
            out.users = (await listUsers()).map((u) => ({
              id: u.id, username: u.username, companyName: u.companyName, role: u.role,
            }));
          } catch (e) { /* 列表拿不到不影响主流程 */ }
        }
        return sendJson(res, 200, out);
      }

      if (method === 'GET' && p === '/api/sdc/orders') {
        const q = url.searchParams;
        const base = {
          userId: sdcUid,
          stage: q.get('stage') || '',
          keyword: q.get('keyword') || '',
          shopId: q.get('shopId') || '',
          sent: q.get('sent') || '',
          sort: q.get('sort') || 'time_desc',
          page: q.get('page'),
          size: q.get('size'),
        };
        const [rows, cnt] = await Promise.all([
          sdc.list(base),
          sdc.count(base),
        ]);
        return sendJson(res, 200, { rows, total: cnt.count, amount: cnt.amount, stageText: sdc.STAGE_TEXT });
      }

      // 店铺维度主表（一行 = 一家店铺）；展开行的订单明细走上面的 /api/sdc/orders?shopId=
      if (method === 'GET' && p === '/api/sdc/shops') {
        const q = url.searchParams;
        const base = {
          userId: sdcUid,
          stage: q.get('stage') || '',
          keyword: q.get('keyword') || '',
          sent: q.get('sent') || '',
          invoice: q.get('invoice') || '',
          sort: q.get('sort') || 'amount_desc',
          page: q.get('page'),
          size: q.get('size'),
        };
        const [rows, cnt] = await Promise.all([
          sdc.shops(base),
          sdc.countShops(base),
        ]);
        return sendJson(res, 200, { rows, total: cnt.count, amount: cnt.amount, pending: cnt.pending });
      }

      if (method === 'GET' && p === '/api/sdc/summary') {
        return sendJson(res, 200, await sdc.summary(sdcUid));
      }


      if (method === 'GET' && p === '/api/sdc/msg-history') {
        const shopId = url.searchParams.get('shopId');
        const rows = await sdc.msgHistory(sdcUid, Number(url.searchParams.get('limit')) || 20, shopId);
        return sendJson(res, 200, { rows });
      }

      // 「登录闪电帮帮」：下发任务给本机助手 → 助手开窗口让用户登录 → 回传账号标识
      if (method === 'POST' && p === '/api/sdc/login') {
        const aUid = agentUidFor(user, sdcUid);
        const onMyPc = aUid && Number(aUid) !== Number(sdcUid);
        if (!aUid) {
          return sendJson(res, 200, {
            ok: false, needAgent: true,
            message: '本机助手未连接：请先在电脑上启动「催收小助手」并点页面右上角「绑定本机助手」完成绑定。'
              + '闪电帮帮登录只在本机完成，服务器不会代你登录。',
          });
        }
        if (!agentVersionGate(res, aUid, '登录闪电帮帮')) return;
        const agentVer = agentHub.status(aUid).agentVer || '';
        if (agentVer && !verGte(agentVer, SDC_MIN_AGENT)) {
          return sendJson(res, 200, {
            ok: false, needAgent: true, agentOutdated: true,
            message: `这台电脑上的催收小助手是 v${agentVer}，还不支持闪电帮帮。请下载安装 v${SDC_MIN_AGENT} 及以上版本。`,
          });
        }
        const taskId = 'sdc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const ctx = {
          taskId, userId: Number(sdcUid), status: 'pending', message: '',
          accountName: '', subUserId: '', createdAt: Date.now(),
          expiresAt: Date.now() + SDC_LOGIN_TTL_MS,
        };
        const sent = agentHub.send(aUid, {
          type: 'sdc_login',
          taskId,
          timeoutMs: SDC_LOGIN_TIMEOUT_MS,
        });
        if (!sent) {
          return sendJson(res, 200, {
            ok: false, needAgent: true,
            message: '下发登录任务失败：本机助手连接已断开，请确认助手正在运行。',
          });
        }
        SDC_LOGINS.set(taskId, ctx);
        await logOp(user, 'sdc.login.start', { tenantId: sdcUid, agentUid: aUid });
        return sendJson(res, 200, {
          ok: true, pending: true, taskId,
          message: (onMyPc ? '已在你本机的助手窗口里打开闪电帮帮登录（登录态记在「' + ((await tenantLabelOf(sdcUid)) || '该账号') + '」名下），'
            : '已在该用户电脑上打开闪电帮帮登录窗口，')
            + '请在弹出的助手窗口里完成登录（支持扫码/短信验证）。',
        });
      }

      if (method === 'GET' && p === '/api/sdc/login-status') {
        const ctx = SDC_LOGINS.get(String(url.searchParams.get('taskId') || ''));
        const mine = ctx && (ctx.userId === Number(user.id) || (isAdmin && ctx.userId === Number(sdcUid)));
        if (!mine) return sendJson(res, 404, { error: '登录任务不存在或已结束' });
        return sendJson(res, 200, {
          status: ctx.status,
          ok: ctx.status === 'done',
          message: ctx.message || '',
          accountName: ctx.accountName || '',
          subUserId: ctx.subUserId || '',
        });
      }

      // 退出登录：删台账 + 让助手把本机浏览器分区一起清掉（否则下次登录会免登进旧账号）
      if (method === 'POST' && p === '/api/sdc/logout') {
        const info = await sdc.sessionInfo(sdcUid).catch(() => null);
        await sdc.clearSession(sdcUid);
        const agent = await agentLogout(agentUidFor(user, sdcUid) || sdcUid, 'sdc');
        await logOp(user, 'sdc.logout', {
          tenantId: sdcUid, accountName: (info && info.accountName) || '', agentCleared: !!agent.ok,
        });
        return sendJson(res, 200, {
          ok: true,
          accountName: (info && info.accountName) || '',
          agentCleared: !!agent.ok,
          agentOffline: !!agent.offline,
          message: '已退出闪电帮帮账号'
            + (info && info.accountName ? `「${info.accountName}」` : '')
            + '。' + logoutAgentNote(agent, '闪电帮帮'),
        });
      }

      // 「刷新订单数据」：下发任务给助手 → 助手在真实页面里翻页 fetch → 分批回传入库
      if (method === 'POST' && p === '/api/sdc/sync') {
        const running = [...SDC_TASKS.values()].find(
          (c) => c.kind === 'sync' && c.userId === Number(sdcUid) && c.status === 'pending'
        );
        if (running) {
          return sendJson(res, 200, {
            ok: true, pending: true, taskId: running.taskId, already: true,
            message: '正在拉取订单数据，继续展示进度…',
          });
        }
        const sess = await sdc.sessionInfo(sdcUid).catch(() => null);
        if (!sess || !sess.logined) {
          return sendJson(res, 200, { ok: false, loginish: true, message: '尚未登录闪电帮帮，请先登录' });
        }
        const aUid = agentUidFor(user, sdcUid);
        if (!aUid) {
          return sendJson(res, 200, {
            ok: false, needAgent: true,
            message: '本机助手未连接：闪电帮帮的订单接口带风控签名，只能由助手在真实页面里拉取。',
          });
        }
        if (!agentVersionGate(res, aUid, '拉取闪电帮帮订单')) return;
        const taskId = 'sdcs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const win = await sdc.syncWindow(sdcUid).catch(() => null);
        const ctx = {
          taskId, kind: 'sync', userId: Number(sdcUid), status: 'pending', message: '',
          received: 0, inserted: 0, updated: 0, skipped: 0, tally: {}, progress: '', progressLog: [],
          startMs: win ? win.startMs : 0, invoiceSinceMs: win ? win.invoiceSinceMs : 0,
          createdAt: Date.now(), expiresAt: Date.now() + SDC_TASK_TTL_MS,
        };
        if (win && win.first) {
          ctx.progressLog.push({ t: new Date().toISOString().slice(11, 19), text: '库里还没有闪电帮帮订单：首次同步拉取近一年的订单' });
        }
        if (win && win.invoiceFull) {
          ctx.progressLog.push({
            t: new Date().toISOString().slice(11, 19),
            text: '库里还没有任何「已开票」订单：这次把开票记录全量扫一遍'
              + '（历史单的开票时间早于增量锚点，只靠增量补不回来）',
          });
        }
        const sent = agentHub.send(aUid, {
          type: 'sdc_fetch', taskId, pageSize: 50,
          startMs: ctx.startMs, endMs: win ? win.endMs : Date.now(), invoiceSinceMs: ctx.invoiceSinceMs,
        });
        if (!sent) {
          return sendJson(res, 200, { ok: false, needAgent: true, message: '下发取数任务失败：本机助手连接已断开。' });
        }
        SDC_TASKS.set(taskId, ctx);
        return sendJson(res, 200, { ok: true, pending: true, taskId, message: '已下发取数任务，正在本机助手里拉取…' });
      }

      // 「批量催收」：按店铺合并成一条消息交给助手逐店发送
      // 口径（2026-10-29 起）：除已开票(4)外都催 —— 可申请开票(1) + 已申请开票(2) + 不支持线上开票(3)；
      // 范围由 sdc.STAGES_TO_CHAT 单一来源决定。标题/税号/邮箱取用户选中的抬头（不传就用默认抬头）。
      if (method === 'POST' && p === '/api/sdc/send') {
        const b = await readBody(req).catch(() => ({}));
        const sns = Array.isArray(b.orderSns) ? b.orderSns.map(String).filter(Boolean) : [];
        // 页面主表是店铺维度，勾选的单位就是店铺（旧的「勾选订单」仍然支持）
        const shopIds = Array.isArray(b.shopIds) ? b.shopIds.map(String).filter(Boolean) : [];
        const titleId = Number(b.titleId) || 0;
        const sess = await sdc.sessionInfo(sdcUid).catch(() => null);
        if (!sess || !sess.logined) {
          return sendJson(res, 200, { ok: false, loginish: true, message: '尚未登录闪电帮帮，请先登录' });
        }
        const sendUid = agentUidFor(user, sdcUid);
        if (!sendUid) {
          return sendJson(res, 200, {
            ok: false, needAgent: true,
            message: '本机助手未连接：发催收消息要在本机助手里打开真实客服会话（消息签名由页面生成），请先启动并绑定助手。',
          });
        }
        if (!agentVersionGate(res, sendUid, '发送催收消息')) return;
        const agentVer = agentHub.status(sendUid).agentVer || '';
        if (agentVer && !verGte(agentVer, SDC_MIN_AGENT)) {
          return sendJson(res, 200, {
            ok: false, needAgent: true, agentOutdated: true,
            message: `这台电脑上的催收小助手是 v${agentVer}，还不支持闪电帮帮催收。请升级到 v${SDC_MIN_AGENT} 及以上。`,
          });
        }

        const shops = await sdc.shopsToChat(sdcUid, sns, { shopIds, stages: sdc.STAGES_TO_CHAT });
        if (!shops.length) {
          return sendJson(res, 200, {
            ok: false,
            message: '没有可催收的订单：除「已开票」外，可申请开票 / 已申请开票 / 不支持线上开票 三档都会催'
              + (shopIds.length ? '（勾选的店铺在这三档下没有订单）' : '（库里暂无这三档订单，先点刷新拉取）'),
          });
        }
        // 消息内容与 1688 完全同源（config.messages 那套模板：抬头/税号/邮箱/金额 + 订单清单），
        // 只是把「1688 卖家」换成「闪电帮帮店铺」，话术不用另配一套。
        // 抬头由用户在弹框里选（titleId），没选就用默认抬头，再没有才回落到 app_user 上的老字段。
        const cfg = loadConfig();
        // 抬头由用户在弹框里选（titleId），没选就用账号上的老字段——与 1688 / 拼多多同一口径
        const buyer = await buyerOfSend(Number(sdcUid), titleId);
        const runConfig = Object.assign({}, cfg, { buyerInfo: buyer });
        const items = [];
        for (const s of shops) {
          const contents = buildMessages(
            { loginId: s.shopId, amount: s.amount, orders: s.orders.map((o) => ({ orderId: o.orderId, amount: Number(o.amount).toFixed(2) })) },
            runConfig
          );
          if (!contents.length) continue;   // 模板为空绝不发空消息
          items.push({
            shopId: s.shopId, shopName: s.shopName, amount: s.amount,
            orderSns: s.orders.map((o) => o.orderId), contents,
          });
        }
        if (!items.length) {
          return sendJson(res, 200, {
            ok: false,
            message: '催收消息内容为空：请到「系统管理 → 消息模板」里配置模板文案（抬头/税号/邮箱/订单清单）',
          });
        }

        const taskId = 'sdcm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const ctx = {
          taskId, kind: 'send', userId: Number(sdcUid), status: 'pending', message: '',
          total: items.length, results: [], okCount: 0, failCount: 0,
          doneIdx: 0, current: '',          // 当前在处理第几家 / 哪家店（进度面板要显示，像 1688 那样）
          orderCount: items.reduce((a, it) => a + it.orderSns.length, 0),
          title: buyer.companyName || '', taxNo: buyer.taxNo || '',
          createdAt: Date.now(), expiresAt: Date.now() + SDC_TASK_TTL_MS,
        };
        const sent = agentHub.send(sendUid, {
          type: 'sdc_send', taskId, items,
          gapMs: 6000,   // 店铺之间的间隔，别把风控惹急
        });
        if (!sent) {
          return sendJson(res, 200, { ok: false, needAgent: true, message: '下发催收任务失败：本机助手连接已断开。' });
        }
        SDC_TASKS.set(taskId, ctx);
        await logOp(user, 'sdc.send.start', { tenantId: sdcUid, total: items.length, title: ctx.title });
        return sendJson(res, 200, {
          ok: true, pending: true, taskId,
          total: items.length,
          orderCount: ctx.orderCount,
          title: ctx.title,
          preview: items[0] ? items[0].contents[0] : '',
          message: `已下发催收任务（${items.length} 家店铺 / 共 ${ctx.orderCount} 单，抬头：${ctx.title || '未配置'}），正在本机助手里逐条发送…`,
        });
      }

      // 停止「取数 / 催收」任务
      if (method === 'POST' && p === '/api/sdc/task-stop') {
        const b = await readBody(req).catch(() => ({}));
        const ctx = SDC_TASKS.get(String(b.taskId || ''));
        const mine = ctx && (ctx.userId === Number(user.id) || (isAdmin && ctx.userId === Number(sdcUid)));
        if (!mine) return sendJson(res, 404, { error: '任务不存在或已结束' });
        if (ctx.status !== 'pending') return sendJson(res, 200, { ok: false, message: '任务已结束，无需停止' });
        ctx.stopping = true;
        const sent = agentHub.send(ctx.userId, { type: 'stop' });
        return sendJson(res, 200, {
          ok: true,
          message: sent ? '已发送停止指令：当前这一家/这一页处理完就停' : '助手连接已断开，任务会随连接中断结束',
        });
      }

      // 轮询「取数 / 催收」进度
      if (method === 'GET' && p === '/api/sdc/task-status') {
        const ctx = SDC_TASKS.get(String(url.searchParams.get('taskId') || ''));
        const mine = ctx && (ctx.userId === Number(user.id) || (isAdmin && ctx.userId === Number(sdcUid)));
        if (!mine) return sendJson(res, 404, { error: '任务不存在或已结束' });
        return sendJson(res, 200, {
          kind: ctx.kind,
          status: ctx.status,
          ok: ctx.status === 'done',
          message: ctx.message || '',
          received: ctx.received || 0,
          inserted: ctx.inserted || 0,
          updated: ctx.updated || 0,
          skipped: ctx.skipped || 0,
          tally: ctx.tally || {},
          progress: ctx.progress || '',
          total: ctx.total || 0,
          results: ctx.results || [],
          done: ctx.doneIdx || (ctx.results || []).length,
          current: ctx.current || '',
          okCount: ctx.okCount || 0,
          failCount: ctx.failCount || 0,
          loginish: !!ctx.loginish,
          log: ctx.progressLog || [],
        });
      }

      return sendJson(res, 404, { error: '未知闪电帮帮接口' });
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
      // 菜单权限：逐个账号开启/关闭（menu=refund|profit|product|market，缺省 refund 向后兼容；
      // 拼多多发票对所有用户开放，不再走这里）
      if (method === 'POST' && p === '/api/admin/users/qnh-refund') {
        const b = await readBody(req);
        const id = Number(b.id);
        const enabled = !!b.enabled;
        const menu = String(b.menu || 'refund').trim().toLowerCase();
        const MENU = {
          refund: { col: 'qnh_refund_enabled', label: '退单列表', field: 'qnhRefundEnabled' },
          profit: { col: 'qnh_profit_enabled', label: '实时毛利监控', field: 'qnhProfitEnabled' },
          product: { col: 'product_enabled', label: '商品列表', field: 'productEnabled' },
          market: { col: 'market_enabled', label: '交易市场', field: 'marketEnabled' },
          billing: { col: 'billing_enabled', label: '账单', field: 'billingEnabled' },
        };
        const m = MENU[menu];
        if (!m) return sendJson(res, 400, { error: '未知的菜单：' + menu });
        if (!id) return sendJson(res, 400, { error: '缺少用户ID' });
        const rows = await db.query('SELECT id, username, role FROM app_user WHERE id = ?', [id]);
        if (!rows.length) return sendJson(res, 404, { error: '用户不存在' });
        if (rows[0].role === 'admin') {
          return sendJson(res, 400, { error: `超级管理员默认拥有${m.label}权限，无需开启` });
        }
        await db.exec(`UPDATE app_user SET ${m.col} = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
        await logOp(user, 'qnh.permit', { username: rows[0].username, menu, enabled });
        return sendJson(res, 200, { ok: true, id, menu, enabled, [m.field]: enabled });
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
        // 只读汇总（操作日志页 4 张统计卡）：今日操作 / 今日活跃账号 / 近 7 日 / 本月
        // 口径固定为全量日志，不随用户名筛选变化（统计卡讲的是整体审计轨迹）
        const agg = (await db.query(
          `SELECT SUM(DATE(created_at) = CURDATE()) AS today,
                  COUNT(DISTINCT CASE WHEN DATE(created_at) = CURDATE() THEN username END) AS today_users,
                  SUM(created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)) AS week,
                  SUM(DATE_FORMAT(created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')) AS month
             FROM operation_log`
        ))[0] || {};
        const rows = await db.query(
          `SELECT id, user_id, username, action, content, ip, created_at FROM operation_log${wsql}
           ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
          [...args, size, (page - 1) * size]
        );
        return sendJson(res, 200, {
          total, page, size,
          summary: {
            today: Number(agg.today) || 0,
            todayUsers: Number(agg.today_users) || 0,
            week: Number(agg.week) || 0,
            month: Number(agg.month) || 0,
          },
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
    const agentVer = (hello && hello.agentVer) || '';
    console.log(`[agent] uid=${uid} 本机助手已连接${agentVer ? ' (v' + agentVer + ')' : ''}`);
    // 连接建立即体检：版本过旧就主动把「去更新」推给助手，让它弹更新横幅。
    // 注意：握手推送只按「版本够不够」判断，**不看能不能下载**——即使服务端暂时没有新版安装包，
    // 也该让用户知道「你的助手太旧了，需要 vX」，助手那边会把按钮换成「联系管理员」而不是给个死链。
    // 真正决定拦不拦的是业务侧的 agentVersionGate（它还要求 packOk），两层分开，互不干扰。
    const pol = agentUpdatePolicy();
    if (agentVer && pol.min && !verGte(agentVer, pol.min)) {
      try {
        ws.send(JSON.stringify({
          type: 'require_update',
          current: agentVer, latest: pol.min, serverVersion: pol.latest,
          updateUrl: pol.updateUrl, fileName: pol.fileName,
          blocking: !!pol.expired,
          graceUntil: pol.graceUntil,
          message: `当前助手 v${agentVer} 过旧，请更新到 v${pol.min} 及以上`
            + (pol.expired ? '：旧版本已无法继续使用登录/发送等功能。' : '以继续使用全部功能。'),
        }));
      } catch (e) { /* 忽略 */ }
      console.log(`[agent] uid=${uid} 助手版本过旧 v${agentVer} < v${pol.min} → 已推送更新提示${pol.expired ? '（已过宽限期）' : '（宽限中）'}`);
    }
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
