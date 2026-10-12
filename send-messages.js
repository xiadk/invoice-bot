/**
 * send-messages.js — 1688 发票催收批量发消息引擎
 *
 * 流程: 拉取最新「申请中」发票 → 按卖家聚合 → 逐家打开旺旺聊天窗发送催收消息
 *
 * 用法:
 *   node send-messages.js --dry-run       # 预演：只生成消息预览，不发送
 *   node send-messages.js --limit=3       # 只发前3家（小批量测试）
 *   node send-messages.js                 # 正式发送（跳过已发过的卖家）
 *
 * 安全设计:
 *   - 断点续发: 发送记录存 MySQL 的 send_log 表（与控制台看板"已催收"标记同源），重跑自动跳过
 *   - 拟人间隔: 每家之间随机 40~90 秒（config.runtime 可调）
 *   - 每日限量: 默认每天最多 50 家（config.runtime.dailySendLimit）
 *   - 发送失败自动跳过并记录，不中断批次
 *
 * 前置: 数据库须已启动（scripts/mysql-start.bat），否则记录读写会失败
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { launch, ROOT } = require('./lib/browser');
const { buildMessages, sendToSeller } = require('./lib/sender'); // 与控制台共用同一套发送逻辑
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INVOICE_PAGE = 'https://air.1688.com/app/ctf-page/invoice/buyer-invoice-list.html';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const m = args.find((a) => a.startsWith('--limit='));
  return m ? Number(m.split('=')[1]) : Infinity;
})();

const fen2yuan = (v) => (Number(v || 0) / 100).toFixed(2);
const ts2dt = (v) => (v ? new Date(Number(v)).toLocaleString('zh-CN', { hour12: false }) : '');

// ── 发送记录（与 server.js 共用 send_log 表，看板"已催收"标记同源） ──
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 读取「发送成功」的记录 → { 'YYYY-MM-DD': [登录ID] }（断点续发只认成功记录） */
async function loadSentLog() {
  const rows = await db.query("SELECT send_date, seller_login FROM send_log WHERE result = 'ok'");
  const log = {};
  for (const r of rows) {
    const d = String(r.send_date).slice(0, 10);
    if (!log[d]) log[d] = [];
    log[d].push(r.seller_login);
  }
  return log;
}
/** 记录一次发送（send_log 一行 = 一次发送；amount/orderNos 为发送当时快照，供看板查看催收历史） */
async function recordSent(loginId, company, result = 'ok', amount = null, orderNos = null) {
  await db.exec(
    `INSERT INTO send_log (send_date, seller_login, seller_company, result, channel, amount, order_nos) VALUES (?, ?, ?, ?, 'cli', ?, ?)`,
    [todayStr(), loginId, company || null, result, amount == null ? null : Number(amount), orderNos || null]
  );
}

/** 打开发票页并等 mtop 就绪，返回 {call} */
async function initMtop(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(INVOICE_PAGE, { waitUntil: 'commit', timeout: 90000 }).catch(() => {});
    for (let i = 0; i < 15; i++) {
      const ok = await page.evaluate(() => !!(window.lib && window.lib.mtop)).catch(() => false);
      if (ok) {
        return (args) =>
          page.evaluate(async ({ serviceId, paramStr }) => {
            const r = await window.lib.mtop.request({
              api: 'mtop.1688.kingsuns.invoice.dataline.service',
              v: '1.0',
              data: { serviceId, param: paramStr },
              type: 'POST',
              dataType: 'json',
              timeout: 20000,
            });
            return r.data.data;
          }, args);
      }
      await sleep(2000);
    }
  }
  throw new Error('mtop 库未就绪（页面加载失败），稍后重跑');
}

/** 拉取全部申请中发票并按卖家聚合 */
async function fetchApplyingBySeller(call) {
  const all = [];
  let page = 1, total = Infinity;
  while (all.length < total) {
    const d = await call({
      serviceId: 'KsInvoicePurchaserManageMtopService.queryInvoiceApplyRecordListByPage',
      paramStr: JSON.stringify({ page, pageSize: 50, bizStatusList: [1, 5, 6, 40] }),
    });
    total = Number(d.pagination.totalNum || 0);
    const batch = d.result || [];
    all.push(...batch);
    if (batch.length === 0) break;
    page++;
    await sleep(1000 + Math.random() * 1500);
  }
  console.log(`[拉取] 申请中发票共 ${all.length} 条`);

  const sellers = new Map();
  for (const r of all) {
    const im = r.invoiceModel || {};
    const om = r.orderModel || {};
    const loginId = om.sellerLoginId;
    if (!loginId) continue;
    if (!sellers.has(loginId)) {
      sellers.set(loginId, { loginId, company: om.sellerCompanyName || loginId, orders: [], amount: 0 });
    }
    const s = sellers.get(loginId);
    s.orders.push({
      orderId: om.idStr || im.outBizId,
      applyTime: im.gmtCreate || '',
      payTime: ts2dt(om.payTime),
      amount: (Number(im.amount || om.sumPayment || 0) / 100).toFixed(2),
    });
    s.amount += Number(im.amount || om.sumPayment || 0) / 100;
  }
  // 按金额降序（大额优先）
  const list = [...sellers.values()].sort((a, b) => b.amount - a.amount);
  console.log(`[聚合] 共 ${list.length} 家卖家`);
  return list;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  const rt = config.runtime || {};
  const dailyLimit = rt.dailySendLimit || 50;
  const gapMin = (rt.sendGapMinSec || 40) * 1000;
  const gapMax = (rt.sendGapMaxSec || 90) * 1000;

  const { browser, context } = await launch();
  const page = await context.newPage();

  console.log('[1/3] 拉取最新申请中发票...');
  const call = await initMtop(page);
  const sellers = await fetchApplyingBySeller(call);
  await page.close().catch(() => {});

  if (DRY_RUN) {
    console.log('\n========== DRY RUN 预览 ==========');
    console.log('--- 消息模板示例（第一家，含分块） ---');
    if (sellers.length > 0) {
      const msgs = buildMessages(sellers[0], config);
      msgs.forEach((m, i) => console.log(`--- 消息${i + 1}/${msgs.length} ---\n${m}`));
    }
    console.log('\n--- 卖家清单（前5家） ---');
    for (const s of sellers.slice(0, 5)) {
      console.log(`【${s.company}】${s.orders.length}单 ¥${s.amount.toFixed(2)}`);
    }
    console.log(`\n共 ${sellers.length} 家，实际发送请去掉 --dry-run`);
    await browser.close();
    return;
  }

  // 断点续发 + 每日限量（记录来自 MySQL send_log 表）
  const sentLog = await loadSentLog();
  const today = todayStr();
  if (!sentLog[today]) sentLog[today] = [];
  const sentToday = sentLog[today].length;
  const alreadySent = new Set(Object.values(sentLog).flat());
  const todo = sellers.filter((s) => !alreadySent.has(s.loginId)).slice(0, Math.min(LIMIT, dailyLimit - sentToday));

  console.log(`\n[2/3] 发送计划: 今日已发 ${sentToday}/${dailyLimit}，本轮待发 ${todo.length} 家`);
  if (todo.length === 0) {
    console.log('无待发卖家（全部已发或已达每日限额），明天再跑或调大 config.runtime.dailySendLimit');
    await browser.close();
    await db.closePool();
    return;
  }

  let ok = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    const msgs = buildMessages(s, config); // 每家单独生成（含各自的订单清单与总金额）
    console.log(`\n[${i + 1}/${todo.length}] ${s.company} (${s.orders.length}单 ¥${s.amount.toFixed(2)}, ${msgs.length}条消息)`);
    const orderNos = s.orders.map((o) => o.orderId).join('；');
    try {
      const result = await sendToSeller(context, s, msgs);
      if (result) {
        ok++;
        await recordSent(s.loginId, s.company, 'ok', s.amount, orderNos);
        console.log('  [发送成功]');
      } else {
        fail++;
        await recordSent(s.loginId, s.company, 'fail', s.amount, orderNos);
        console.log('  [消息发送失败] 记录跳过，下轮重试');
      }
    } catch (e) {
      fail++;
      await recordSent(s.loginId, s.company, 'fail', s.amount, orderNos).catch(() => {});
      console.log('  [失败]', e.message.split('\n')[0]);
    }
    if (i < todo.length - 1) {
      const gap = gapMin + Math.random() * (gapMax - gapMin);
      console.log(`  等待 ${(gap / 1000).toFixed(0)}s 后继续...`);
      await sleep(gap);
    }
  }

  console.log(`\n[3/3] 完成: 成功 ${ok} 家, 失败 ${fail} 家`);
  console.log('进度记录: MySQL send_log 表（与看板"已催收"标记同源）');
  await browser.close();
  await db.closePool();
}

main().catch(async (e) => {
  console.error('发送流程出错:', e.message);
  if (/ECONNREFUSED|Access denied/.test(e.message)) {
    console.error('提示: 数据库未启动或连接失败，请先执行 scripts\\mysql-start.bat 并核对 config.json 的 mysql 段');
  }
  await db.closePool().catch(() => {});
  process.exit(1);
});
