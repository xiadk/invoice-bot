/**
 * server.js — 发票催收控制台（本地服务器）
 *
 * 启动: node server.js   →  浏览器打开 http://localhost:8787
 *
 * 功能:
 *   GET  /                    控制台页面
 *   GET  /api/data            看板聚合数据：**按公司一行**，会员名在 companies[].members 子树
 *                             （订单+发票+催收全部来自 MySQL）
 *   GET  /api/seller-detail   单个会员名的订单明细 + 已开票明细（展开订单时按需加载）
 *   GET  /api/collect-history 历史催收记录（点「催收次数」查看）：?loginId= 或 ?company=
 *   POST /api/send            {loginIds: [...]} 批量发送催收消息（loginId = 会员名）
 *   POST /api/import          重新扫描 data/ 下的 Excel 并全量导入 MySQL
 *   GET  /api/mapping         销方名称映射表（有效 + 已忽略）+ 待人工比对的销方名称 + 可选卖家列表
 *   POST /api/mapping         新增/修改一条名称映射（人工比对结果；会自动取消该名称的忽略标记）
 *   POST /api/mapping/delete  删除一条名称映射
 *   POST /api/mapping/ignore  忽略/恢复一个销方名称 {taxSellerName, ignored}（确认无对应 1688 商家，
 *                             忽略后不再出现在待比对列表、不参与自动匹配与统计，可在「已忽略」区恢复）
 *   POST /api/order-state     人工确认已开票：{orderNo, action:'confirm'|'cancel'} 单订单，
 *                             或 {loginId, action:'confirm-all'|'cancel-all'} 整会员名批量（商家线下开票）
 *
 * 统计口径:
 *   已开票金额 = 税务局文件（issued_invoice）中该商家的「价税合计」明细总和
 *   已开票数量 = 税务局文件里该商家的「发票张数」，按数电票号（e_invoice_no）/发票号去重。
 *               注意：税务局导出是「一张发票多个货物明细各占一行」，同一张发票上的
 *               多个货物行共用同一个数电票号，去重后只算 1 张（明细行数另见 invoiceRowCount）
 *   待开票金额 = 订单金额 − 已开票金额（不小于 0）
 *   催收次数 = send_log 表里 result='ok' 的**成功**发送次数（失败尝试不计入次数）
 *   最近催收时间 = 最近一次**成功**发送的时间；催收按**会员名**记录
 *
 * 看板层级: 公司（一行）→ 会员名/1688 店铺（members 子树，各自带订单与催收按钮）。
 *   发票额按公司归集，同公司多会员名时只挂在「主行」（映射表登记的会员名，否则订单数最多），
 *   非主行会员名的待开票金额 = 其订单总额（公司发票额不摊到它头上），避免重复计入。
 *   催收消息内容按**会员名**口径：{amount}=该会员名待开票金额，{orderId}=该会员名未开票订单。
 *
 * 数据源: MySQL 数据库 invoice_bot（连接参数见 config.json 的 mysql 段）
 *   invoice_order        1688 完成订单（源 data/完成订单/*.xlsx；含人工确认 state_source='manual'）
 *   issued_invoice       历史已开票数据（源 data/已开票订单/*.xlsx，税务局导出）
 *   seller_name_mapping  税务局销方名称 → 1688 商家名称 映射表（is_ignored=1 表示确认无对应商家，已忽略，
 *                        从待比对列表与未匹配计数中剔除，可在名称映射页恢复）
 *   send_log             催收发送记录（一行=一次发送尝试，result=ok/fail）
 *
 * 注意: 提交开票申请（/api/apply）已在二次开发中移除，看板不再提供该按钮。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { runImport } = require('./import-to-db');
const { launch } = require('./lib/browser');
const { buildMessages, sendToSeller } = require('./lib/sender');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8787;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

// ── 数据加载（全部走 MySQL） ──

/** 卖家聚合列表：订单维度 + 税务局已开票维度（通过 seller_name_mapping 的名称关系统计） */
async function loadSellers() {
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
    WHERE COALESCE(NULLIF(o.seller_login,''), o.seller_company) IS NOT NULL
    GROUP BY loginId
  `);

  // 催收记录（send_log 一行 = 一次发送尝试）：
  //   催收次数 = **只计成功**（result='ok'）；失败尝试单独计数，不计入催收次数
  //   最近催收时间 = 最近一次**成功**催收的时间
  const sendRows = await db.query(`
    SELECT seller_login,
           SUM(result = 'ok')  AS sendCount,
           SUM(result <> 'ok') AS failCount,
           MAX(CASE WHEN result = 'ok' THEN sent_at END) AS lastSentAt
    FROM send_log
    GROUP BY seller_login
  `);
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
    WHERE seller_company IS NOT NULL AND seller_company <> ''
    GROUP BY seller_company
  `);
  const invByCompany = new Map(invRows.map((r) => [r.company, r]));

  // 同一家公司可能有多个卖家会员名（多个1688店铺）。发票是按「公司」维度统计的，
  // 为避免同一笔发票额被重复计入多行，只把它挂在「主行」上：
  // 优先取名称映射表登记的会员名，其次取订单数最多的那行；其余行标注发票额归属。
  const ownerRows = await db.query(
    `SELECT seller_company, seller_login FROM seller_name_mapping
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
      // 税务局明细「货物行」条数：一张发票上有多个货物明细时，行数会大于发票张数
      invoiceRowCount: inv ? Number(inv.invoiceRowCount) || 0 : 0,
      lastInvoiceDate: inv ? inv.lastInvoiceDate : null,
      firstInvoiceDate: inv ? inv.firstInvoiceDate : null,
      invoiceOwnerLoginId: null,      // 非空表示该行发票额已计入本公司的另一行
      invoiceOwnerLabel: null,
      // 催收（send_log）：sendCount = 成功次数（失败不计），sendFailCount = 失败尝试次数
      sendCount: st ? Number(st.sendCount) || 0 : 0,
      sendFailCount: st ? Number(st.failCount) || 0 : 0,
      lastSentAt: st ? st.lastSentAt : null,
      lastPayTime: r.lastPayTime,
    };
  });

  // 同公司多行 → 指定一个「主行」持有发票额
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

  // 待开票金额 = max(订单总额 − 已开票金额, 0)
  for (const row of list) {
    const totalAmount = Number(row.totalAmount) || 0;
    const invoicedAmount = Number(row.invoicedAmount) || 0;
    row.overInvoiced = invoicedAmount > totalAmount; // 发票金额大于订单导出金额（订单导出不全时会出现）
    row.pendingAmount = Math.max(totalAmount - invoicedAmount, 0).toFixed(2);
    row.pending = Number(row.pendingAmount) > 0 ? 1 : 0;
  }
  // 待开票金额降序，无待开票的沉底
  list.sort((a, b) => Number(b.pendingAmount) - Number(a.pendingAmount));
  return list;
}

/**
 * 公司聚合（看板主视图）：**一家公司只出一行**，会员名（1688 店铺）作为 members 子树。
 * 会员名行由 loadSellers() 产出（含发票额归属去重、催收统计），这里只做向上汇总：
 *   - 金额/单数/状态计数 = 各会员名求和
 *   - 税务局发票额与张数：非归属行本来就是 0，求和后正好等于公司口径，不会重复计入
 *   - 待开票金额 = max(公司订单总额 − 公司税务局已开票额, 0)（按公司总额重算，避免逐会员名 max 截断误差）
 * 催收仍是**会员名级**（聊天 touid 依赖会员名），所以每个会员名带 canSend。
 */
async function loadCompanies() {
  const members = await loadSellers();
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
    // 会员名按「待开票金额」降序，方便优先催收待开票多的店铺
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
        invoiceOwnerLoginId: m.invoiceOwnerLoginId,   // 非空=发票额已计入本公司另一会员名
        invoiceOwnerLabel: m.invoiceOwnerLabel,
        sendCount: m.sendCount,
        sendFailCount: m.sendFailCount,
        lastSentAt: m.lastSentAt,
        // 催收按钮可用性：有待开票金额 且 还有未开票订单 且 有会员名（touid 需要）
        canSend: Number(m.pendingAmount) > 0 && m.unissuedCount > 0 && !!m.sellerLogin,
      })),
    });
  }
  companies.sort((a, b) => Number(b.pendingAmount) - Number(a.pendingAmount));
  return companies;
}

/** 单个卖家的订单明细 + 已开票明细（看板展开行时按需拉取） */
async function loadSellerDetail(loginId) {
  const orders = await db.query(
    `SELECT order_no, pay_amount, pay_time, order_status, invoice_state, state_source, state_note, goods_title
     FROM invoice_order
     WHERE COALESCE(NULLIF(seller_login,''), seller_company) = ?
     ORDER BY pay_time DESC`,
    [loginId]
  );
  const seller = orders.length
    ? (await db.query(
        `SELECT MAX(seller_company) AS company, MAX(seller_login) AS sellerLogin FROM invoice_order
         WHERE COALESCE(NULLIF(seller_login,''), seller_company) = ?`, [loginId]
      ))[0]
    : { company: null, sellerLogin: null };
  const invoices = seller.company
    ? await db.query(
        `SELECT e_invoice_no, invoice_no, row_hash, seller_name, goods_name, total_amount, tax_amount, invoice_date, invoice_kind, invoice_status
         FROM issued_invoice WHERE seller_company = ? ORDER BY invoice_date DESC, id`,
        [seller.company]
      )
    : [];
  // 明细行数 = 表里货物行条数；发票张数 = 按数电票号/发票号去重（一张票多个货物行只计 1 张）
  const invoiceRowCount = invoices.length;
  const invoiceCount = new Set(
    invoices.map((v) => v.e_invoice_no || v.invoice_no || v.row_hash)
  ).size;
  // 催收记录明细（最近 50 次），与看板「催收次数/最近催收时间」同源
  const sendLogs = seller.sellerLogin
    ? await db.query(
        `SELECT send_date, sent_at, result, channel FROM send_log
         WHERE seller_login = ? ORDER BY sent_at DESC, id DESC LIMIT 50`,
        [seller.sellerLogin]
      )
    : [];
  return { orders, invoices, company: seller.company, sendLogs, invoiceCount, invoiceRowCount };
}

/** 催收统计 + 已催收卖家登录ID集合（来自 send_log 表；催收次数只计成功） */
async function loadSendStats() {
  const rows = await db.query(`
    SELECT seller_login AS login,
           SUM(result = 'ok')  AS sendCount,
           SUM(result <> 'ok') AS failCount,
           MAX(CASE WHEN result = 'ok' THEN sent_at END) AS lastSentAt
    FROM send_log
    GROUP BY seller_login
  `);
  return rows;
}

/**
 * 历史催收记录（看板点「催收次数」查看）：
 *   传 loginId → 该会员名的全部发送记录；传 company → 该公司下所有会员名的发送记录。
 *   每行 = 一次发送尝试，含发送当时的待开票金额与订单号快照（老记录可能为空）。
 */
async function loadCollectHistory({ loginId, company }) {
  let rows = [];
  if (loginId) {
    rows = await db.query(
      `SELECT sent_at, result, channel, amount, order_nos, seller_login,
              COALESCE(NULLIF(seller_login,''), seller_company) AS scope_key
       FROM send_log WHERE seller_login = ? ORDER BY sent_at DESC, id DESC`,
      [loginId]
    );
  } else if (company) {
    // 该公司所有会员名的登录ID（订单表口径），连同 seller_company 一起匹配，避免漏掉早期记录
    const loginRows = await db.query(
      `SELECT DISTINCT COALESCE(NULLIF(seller_login,''), seller_company) AS login
       FROM invoice_order
       WHERE seller_company = ? AND COALESCE(NULLIF(seller_login,''), seller_company) IS NOT NULL`,
      [company]
    );
    const ids = loginRows.map((r) => r.login).filter(Boolean);
    const params = [company];
    let sql = `SELECT sent_at, result, channel, amount, order_nos, seller_login, seller_company AS scope_key
               FROM send_log WHERE seller_company = ?`;
    if (ids.length) {
      sql += ` OR seller_login IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
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
    scope: r.scope_key || '',
  }));
  const okCount = logs.filter((l) => l.result === 'ok').length;
  return { logs, total: logs.length, okCount, failCount: logs.length - okCount };
}

// ── 浏览器会话（仅发送催收消息时使用） ──
// 每次任务启动全新浏览器（与 CLI 行为一致）。
// 共享浏览器会被聊天应用的本地状态（AI询盘模式等）污染，导致 touid 无法自动选中联系人。

// ── 任务状态（发送进度实时可查） ──
const taskState = {
  running: false, type: null,           // 'send'
  total: 0, done: 0, ok: 0, fail: 0,
  current: null,                        // 当前正在处理的卖家
  logs: [],                             // {time, text}
  stopRequested: false,
  startedAt: null, finishedAt: null,
};
function taskLog(text) {
  taskState.logs.push({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), text });
  if (taskState.logs.length > 500) taskState.logs.splice(0, taskState.logs.length - 500);
  console.log(text);
}

/** 记录一次催收发送（send_log 一行 = 一次发送，看板据此统计次数与最近时间）
 *  amount / orderNos 为发送「当时」的快照，供看板点「催收次数」查看历史记录。 */
async function recordSent(loginId, company, result = 'ok', channel = 'web', amount = null, orderNos = null) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await db.exec(
    `INSERT INTO send_log (send_date, seller_login, seller_company, result, channel, amount, order_nos) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [date, loginId, company || null, result, channel, amount == null ? null : Number(amount), orderNos || null]
  );
}

// ── 发送催收消息（后台任务化，进度写入 taskState） ──
async function doSend(loginIds) {
  if (taskState.running) throw new Error('已有任务在运行中');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const rt = config.runtime || {};
  const gapMin = (rt.sendGapMinSec || 15) * 1000;
  const gapMax = (rt.sendGapMaxSec || 30) * 1000;
  const data = await loadSellers();

  Object.assign(taskState, { running: true, type: 'send', total: loginIds.length, done: 0, ok: 0, fail: 0, current: null, stopRequested: false, startedAt: new Date().toISOString(), finishedAt: null, logs: [] });
  taskLog(`▶ 开始发送催收消息：共 ${loginIds.length} 家（启动独立浏览器）`);

  let browser = null;
  try {
    const launched = await launch();
    browser = launched.browser;
    const context = launched.context;
    taskLog('✓ 浏览器已启动');

    for (const loginId of loginIds) {
      if (taskState.stopRequested) { taskLog('⏹ 已手动停止'); break; }
      const seller = data.find((s) => s.loginId === loginId);
      if (!seller) { taskState.done++; taskState.fail++; taskLog(`✗ 卖家不存在: ${loginId}`); continue; }
      // 没有卖家会员名的无法发旺旺（touid 依赖 loginId）
      if (!seller.sellerLogin) { taskState.done++; taskState.fail++; taskLog(`✗ ${seller.company} 缺少卖家会员名，无法发送`); continue; }
      taskState.current = seller.company;
      const detail = await loadSellerDetail(loginId);
      // 催收口径 = **会员名级**（聊天 touid 依赖会员名，金额/订单号也按该会员名各自统计）：
      //   {amount}  = 该会员名的待开票金额（看板「待开票金额」列）
      //   {orderId} = 该会员名除「已开票」外的全部订单号（平台已开票 + 人工确认的都排除）
      const toRemind = detail.orders.filter((o) => o.invoice_state !== 'issued');
      const msgSeller = {
        loginId: seller.sellerLogin, // 关键：聊天页 touid 依赖此字段
        amount: Number(seller.pendingAmount),
        orders: toRemind.map((o) => ({ orderId: o.order_no, amount: Number(o.pay_amount).toFixed(2) })),
      };
      if (msgSeller.orders.length === 0) { taskState.done++; taskLog(`- ${seller.company} 无可催收订单，跳过`); continue; }
      const messages = buildMessages(msgSeller, config);
      // 本次催收快照（金额 = 该会员名待开票金额；订单号 = 本次催收的订单，用「；」分隔），供看板查看历史
      const collectAmount = Number(seller.pendingAmount) || 0;
      const collectOrderNos = msgSeller.orders.map((o) => o.orderId).join('；');
      const tSell = Date.now();
      try {
        await sendToSeller(context, msgSeller, messages);
        await recordSent(seller.sellerLogin, seller.company, 'ok', 'web', collectAmount, collectOrderNos);
        taskState.ok++;
        taskLog(`✓ ${seller.company} 发送成功 (${messages.length}条消息, ${Math.round((Date.now() - tSell) / 1000)}s) · 催收次数 +1`);
      } catch (e) {
        await recordSent(seller.sellerLogin, seller.company, 'fail', 'web', collectAmount, collectOrderNos);
        taskState.fail++;
        taskLog(`✗ ${seller.company} 失败: ${e.message.split('\n')[0]} · 已记录失败尝试（不计入催收次数）`);
      }
      taskState.done++;
      if (loginIds.indexOf(loginId) < loginIds.length - 1 && !taskState.stopRequested) {
        const gap = gapMin + Math.random() * (gapMax - gapMin);
        taskLog(`… 等待 ${Math.round(gap / 1000)}s 后发下一家`);
        await sleep(gap);
      }
    }
  } catch (e) {
    taskLog(`✗ 任务异常: ${e.message.split('\n')[0]}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  taskState.running = false;
  taskState.current = null;
  taskState.finishedAt = new Date().toISOString();
  taskLog(`■ 发送完成: 成功 ${taskState.ok}, 失败 ${taskState.fail}, 共 ${taskState.done}/${taskState.total}`);
}

// ── 名称映射维护 ──

/** 映射表（有效映射 / 已忽略分开返回）+ 待人工比对的销方名称 + 可选卖家列表 */
async function loadMapping() {
  const all = await db.query(`
    SELECT m.id, m.tax_seller_name, m.seller_company, m.seller_login,
           m.match_type, m.match_rule, m.is_confirmed, m.is_ignored, m.note, m.updated_at,
           (SELECT ROUND(SUM(total_amount),2) FROM issued_invoice i WHERE i.seller_name = m.tax_seller_name) AS invoice_amount,
           (SELECT COUNT(*) FROM issued_invoice i WHERE i.seller_name = m.tax_seller_name) AS invoice_rows
    FROM seller_name_mapping m
    ORDER BY m.is_ignored ASC, (m.seller_company IS NULL) DESC, invoice_amount DESC
  `);
  const mappings = all.filter((m) => !m.is_ignored);
  const ignored = all.filter((m) => m.is_ignored);
  // 待人工比对：视图已排除「已映射」与「已忽略」两类
  const unmatched = await db.query('SELECT * FROM v_unmatched_seller_name ORDER BY invoice_amount DESC');
  const sellers = await db.query(`
    SELECT COALESCE(NULLIF(seller_login,''), seller_company) AS loginId,
           MAX(seller_company) AS company, MAX(seller_login) AS sellerLogin
    FROM invoice_order
    WHERE seller_company IS NOT NULL
    GROUP BY loginId ORDER BY company
  `);
  return { mappings, ignored, unmatched, sellers, unmatchedCount: unmatched.length, ignoredCount: ignored.length };
}

/** 保存一条人工映射，并回填 issued_invoice.seller_company（同时取消该名称的忽略标记） */
async function saveMapping({ taxSellerName, sellerLogin, sellerCompany, note }) {
  if (!taxSellerName) throw new Error('缺少 taxSellerName');
  if (!sellerCompany) throw new Error('请选择对应的1688商家');
  await db.exec(
    `INSERT INTO seller_name_mapping (tax_seller_name, seller_company, seller_login, match_type, match_rule, is_confirmed, is_ignored, note)
     VALUES (?, ?, ?, 'manual', 'manual', 1, 0, ?)
     ON DUPLICATE KEY UPDATE seller_company = VALUES(seller_company), seller_login = VALUES(seller_login),
       match_type = 'manual', match_rule = 'manual', is_confirmed = 1, is_ignored = 0, note = VALUES(note)`,
    [taxSellerName, sellerCompany, sellerLogin || null, note || null]
  );
  const r = await db.exec(
    'UPDATE issued_invoice SET seller_company = ? WHERE seller_name = ?',
    [sellerCompany, taxSellerName]
  );
  return { ok: true, updatedInvoices: r.affectedRows || 0 };
}

/**
 * 忽略 / 恢复一个销方名称。
 * 忽略 = 人工确认该税务局销方名称没有对应的 1688 商家，之后不再出现在「待人工比对」列表，
 *        也不再参与自动匹配与统计；可在「已忽略」区随时恢复。
 */
async function ignoreMapping({ taxSellerName, ignored }) {
  if (!taxSellerName || typeof taxSellerName !== 'string' || !taxSellerName.trim()) {
    throw new Error('缺少 taxSellerName（税务局销方名称）');
  }
  taxSellerName = taxSellerName.trim();
  // ignored 兼容多种传入：缺省=忽略；布尔/数字/字符串都按明确语义解析，避免 "false" 被当成真值
  let on;
  if (ignored === undefined || ignored === null) on = true;
  else if (typeof ignored === 'boolean') on = ignored;
  else if (typeof ignored === 'number') on = ignored !== 0;
  else if (typeof ignored === 'string') on = !['false', '0', 'off', 'no', ''].includes(ignored.trim().toLowerCase());
  else on = !!ignored;
  if (on) {
    await db.exec(
      `INSERT INTO seller_name_mapping
         (tax_seller_name, seller_company, seller_login, match_type, match_rule, is_confirmed, is_ignored, note)
       VALUES (?, NULL, NULL, 'ignored', 'ignored', 1, 1, '确认无对应1688商家，已忽略')
       ON DUPLICATE KEY UPDATE seller_company = NULL, seller_login = NULL,
         match_type = 'ignored', match_rule = 'ignored', is_confirmed = 1, is_ignored = 1,
         note = '确认无对应1688商家，已忽略'`,
      [taxSellerName]
    );
    // 忽略的销方名称不再计入任何商家，清空此前可能的回填结果
    await db.exec('UPDATE issued_invoice SET seller_company = NULL WHERE seller_name = ?', [taxSellerName]);
  } else {
    // 恢复：本就只是「忽略」记录则直接删除；若上面挂着真实映射则只取消忽略标记
    const rows = await db.query(
      'SELECT id, seller_company FROM seller_name_mapping WHERE tax_seller_name = ?', [taxSellerName]
    );
    if (rows[0] && !rows[0].seller_company) {
      await db.exec('DELETE FROM seller_name_mapping WHERE tax_seller_name = ?', [taxSellerName]);
    } else {
      await db.exec("UPDATE seller_name_mapping SET is_ignored = 0 WHERE tax_seller_name = ?", [taxSellerName]);
    }
  }
  return { ok: true, ignored: on };
}

/** 删除一条映射，并清空 issued_invoice 里回填的结果 */
async function deleteMapping({ taxSellerName }) {
  if (!taxSellerName) throw new Error('缺少 taxSellerName');
  await db.exec('DELETE FROM seller_name_mapping WHERE tax_seller_name = ?', [taxSellerName]);
  await db.exec('UPDATE issued_invoice SET seller_company = NULL WHERE seller_name = ?', [taxSellerName]);
  return { ok: true };
}

// ── 订单级开票状态（人工确认已开票） ──

/** data/invoice-status.json 的平台状态集合（按文件 mtime 缓存） */
let _statusCache = null, _statusCacheAt = 0;
function invoiceStatusSets() {
  const f = path.join(DATA, 'invoice-status.json');
  try {
    const st = fs.statSync(f);
    if (_statusCache && _statusCacheAt === st.mtimeMs) return _statusCache;
    const s = JSON.parse(fs.readFileSync(f, 'utf-8'));
    _statusCache = {
      issued: new Set((s.issued || []).map(String)),
      applying: new Set((s.applying || []).map(String)),
    };
    _statusCacheAt = st.mtimeMs;
    return _statusCache;
  } catch (e) { return { issued: new Set(), applying: new Set() }; }
}

function platformStateOf(orderNo, sets) {
  const no = String(orderNo);
  if (sets.issued.has(no)) return 'issued';
  if (sets.applying.has(no)) return 'applying';
  return 'none';
}

/** 读取 data/invoice-status.json 的平台开票状态，判断某订单的平台状态 */
function resolvePlatformState(orderNo) {
  return platformStateOf(orderNo, invoiceStatusSets());
}

/**
 * 人工修改开票状态（支持订单维度与卖家维度批量）
 *   { orderNo, action:'confirm'|'cancel' }        单个订单
 *   { loginId, action:'confirm-all'|'cancel-all' } 整个卖家
 *     confirm-all → 该卖家所有「未开票」订单标记为人工已开票（商家线下开票）
 *     cancel-all  → 取消该卖家全部人工确认，逐单回退到平台刷新状态
 */
async function setOrderState({ orderNo, loginId, action }) {
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

  // ── 卖家级批量 ──
  if (action === 'confirm-all' || action === 'cancel-all') {
    if (!loginId) throw new Error('缺少 loginId');
    const rows = await db.query(
      `SELECT order_no, invoice_state, state_source FROM invoice_order
       WHERE COALESCE(NULLIF(seller_login,''), seller_company) = ?`, [loginId]);
    if (!rows.length) throw new Error('卖家不存在: ' + loginId);

    if (action === 'confirm-all') {
      const targets = rows.filter((r) => r.invoice_state !== 'issued').map((r) => r.order_no);
      const affected = await chunk(targets, (part) => db.exec(
        `UPDATE invoice_order SET invoice_state='issued', state_source='manual', state_note=?, state_updated_at=NOW()
         WHERE order_no IN (${part.map(() => '?').join(',')})`, [note, ...part]));
      return { ok: true, action, affected };
    }

    // cancel-all：仅回退 state_source='manual' 的行，按平台真实状态分组回退
    const sets = invoiceStatusSets();
    const byState = { issued: [], applying: [], none: [] };
    for (const r of rows) {
      if (r.state_source === 'manual') byState[platformStateOf(r.order_no, sets)].push(r.order_no);
    }
    let affected = 0;
    for (const [state, ids] of Object.entries(byState)) {
      affected += await chunk(ids, (part) => db.exec(
        `UPDATE invoice_order SET invoice_state=?, state_source='platform', state_note=NULL, state_updated_at=NOW()
         WHERE order_no IN (${part.map(() => '?').join(',')})`, [state, ...part]));
    }
    return { ok: true, action, affected };
  }

  // ── 单订单 ──
  if (!orderNo) throw new Error('缺少 orderNo');
  const exists = await db.query('SELECT order_no FROM invoice_order WHERE order_no = ?', [orderNo]);
  if (!exists.length) throw new Error('订单不存在: ' + orderNo);
  if (action === 'confirm') {
    await db.exec(
      `UPDATE invoice_order
         SET invoice_state='issued', state_source='manual', state_note=?, state_updated_at=NOW()
       WHERE order_no=?`,
      [note, orderNo]
    );
    return { ok: true, orderNo, invoice_state: 'issued', state_source: 'manual', affected: 1 };
  }
  if (action === 'cancel') {
    const st = resolvePlatformState(orderNo);
    await db.exec(
      `UPDATE invoice_order
         SET invoice_state=?, state_source='platform', state_note=NULL, state_updated_at=NOW()
       WHERE order_no=?`,
      [st, orderNo]
    );
    return { ok: true, orderNo, invoice_state: st, state_source: 'platform', affected: 1 };
  }
  throw new Error('未知操作: ' + action);
}

// ── HTTP 工具 ──
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    });
  });
}

// ── HTTP 服务器 ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // 控制台页面
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf-8'));
      return;
    }

    // 看板数据（按公司聚合，会员名为 members 子树）
    if (req.method === 'GET' && p === '/api/data') {
      const companies = await loadCompanies();
      const sendStats = await loadSendStats();
      // 「已催收」= 至少成功催收过一次（失败尝试不算）
      const sentList = sendStats.filter((r) => Number(r.sendCount) > 0).map((r) => r.login);
      const invSummary = await db.query(`
        SELECT COUNT(*) AS rows_count,
               COUNT(DISTINCT COALESCE(NULLIF(e_invoice_no,''), NULLIF(invoice_no,''), row_hash)) AS invoice_count,
               ROUND(SUM(COALESCE(total_amount,0)),2) AS amount,
               SUM(seller_company IS NULL) AS unmapped_rows
        FROM issued_invoice
      `);
      const unmatched = await db.query('SELECT COUNT(*) AS n FROM v_unmatched_seller_name');
      const ignoredCnt = await db.query(
        'SELECT COUNT(*) AS n FROM seller_name_mapping WHERE is_ignored = 1'
      );
      const manual = await db.query(
        "SELECT COUNT(*) AS n FROM invoice_order WHERE state_source = 'manual'"
      );
      return sendJson(res, 200, {
        companies,
        sentList,
        sendStats,
        invoiceSummary: invSummary[0] || null,
        unmatchedNameCount: unmatched[0] ? unmatched[0].n : 0,
        ignoredNameCount: ignoredCnt[0] ? ignoredCnt[0].n : 0,
        manualIssuedCount: manual[0] ? manual[0].n : 0,
        generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
    }

    // 卖家明细（展开行按需加载）
    if (req.method === 'GET' && p === '/api/seller-detail') {
      const loginId = url.searchParams.get('loginId');
      if (!loginId) return sendJson(res, 400, { error: '缺少 loginId' });
      return sendJson(res, 200, await loadSellerDetail(loginId));
    }

    // 历史催收记录（点「催收次数」查看）：?loginId=会员名 或 ?company=公司名
    if (req.method === 'GET' && p === '/api/collect-history') {
      const loginId = url.searchParams.get('loginId');
      const company = url.searchParams.get('company');
      if (!loginId && !company) return sendJson(res, 400, { error: '缺少 loginId 或 company' });
      return sendJson(res, 200, await loadCollectHistory({ loginId, company }));
    }

    // 配置读取
    if (req.method === 'GET' && p === '/api/config') {
      const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
      const { DEFAULT_MESSAGES } = require('./lib/sender');
      // 凭据不下发前端
      const safe = { ...config };
      delete safe.platforms;
      delete safe.mysql;
      return sendJson(res, 200, { config: safe, defaultMessages: DEFAULT_MESSAGES });
    }

    // 配置保存
    if (req.method === 'POST' && p === '/api/config') {
      const { config } = await readBody(req);
      if (!config || typeof config !== 'object') throw new Error('缺少 config');
      const old = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
      const merged = { ...old };
      merged.buyerInfo = config.buyerInfo;
      merged.runtime = { ...(old.runtime || {}), ...(config.runtime || {}) };
      merged.messages = { ...(old.messages || {}), ...(config.messages || {}) };
      fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(merged, null, 2), 'utf-8');
      return sendJson(res, 200, { ok: true });
    }

    // 导入（重新扫描 data/ 下 Excel → MySQL）
    if (req.method === 'POST' && p === '/api/import') {
      const body = await readBody(req);
      const opts = {};
      if (body.orders) opts.orders = true;
      if (body.invoices) opts.invoices = true;
      taskLog('▶ 收到「重新导入数据」请求');
      const r = await runImport(opts);
      for (const s of r.steps) taskLog('  ' + s);
      return sendJson(res, 200, r);
    }

    // 导入日志
    if (req.method === 'GET' && p === '/api/import-log') {
      const rows = await db.query('SELECT * FROM import_log ORDER BY id DESC LIMIT 30');
      return sendJson(res, 200, { logs: rows });
    }

    // 名称映射
    if (req.method === 'GET' && p === '/api/mapping') {
      return sendJson(res, 200, await loadMapping());
    }
    if (req.method === 'POST' && p === '/api/mapping') {
      return sendJson(res, 200, await saveMapping(await readBody(req)));
    }
    if (req.method === 'POST' && p === '/api/mapping/delete') {
      return sendJson(res, 200, await deleteMapping(await readBody(req)));
    }
    // 忽略 / 恢复一个销方名称（确认无对应 1688 商家）
    if (req.method === 'POST' && p === '/api/mapping/ignore') {
      return sendJson(res, 200, await ignoreMapping(await readBody(req)));
    }

    // 订单维度：人工确认已开票 / 取消人工确认
    if (req.method === 'POST' && p === '/api/order-state') {
      return sendJson(res, 200, await setOrderState(await readBody(req)));
    }

    // 任务进度查询
    if (req.method === 'GET' && p === '/api/task') {
      return sendJson(res, 200, taskState);
    }
    // 停止任务
    if (req.method === 'POST' && p === '/api/task/stop') {
      if (taskState.running) {
        taskState.stopRequested = true;
        taskLog('⏸ 收到停止请求，将在当前卖家完成后停止');
      }
      return sendJson(res, 200, { ok: true });
    }

    // 发送催收消息（后台任务，立即返回）
    if (req.method === 'POST' && p === '/api/send') {
      const { loginIds } = await readBody(req);
      if (!Array.isArray(loginIds) || loginIds.length === 0) throw new Error('缺少 loginIds');
      if (taskState.running) throw new Error('已有任务在运行中');
      doSend(loginIds).catch((e) => { taskState.running = false; taskLog('✗ 任务异常: ' + e.message); });
      return sendJson(res, 200, { started: true });
    }

    // 已移除: POST /api/apply（提交开票申请功能已按需求取消）
    if (p === '/api/apply') {
      return sendJson(res, 410, { error: '提交开票申请功能已移除（二次开发需求：取消看板中的提交申请功能与按钮）' });
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    console.error('[接口异常]', e.message);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, async () => {
  console.log(`发票催收控制台已启动: http://localhost:${PORT}`);
  try {
    const v = await db.ping();
    console.log(`✓ 数据库连接正常 (MySQL ${v})`);
    const [{ n: orderCount }] = await db.query('SELECT COUNT(*) AS n FROM invoice_order');
    const [{ n: invoiceCount }] = await db.query('SELECT COUNT(*) AS n FROM issued_invoice');
    console.log(`  订单表 ${orderCount} 行 / 已开票表 ${invoiceCount} 行`);
  } catch (e) {
    console.error('✗ 数据库连接失败:', e.message);
    console.error('  请先启动数据库（scripts/mysql-start.bat）并确认 config.json 的 mysql 段');
  }
  console.log('Ctrl+C 停止服务器');
});
