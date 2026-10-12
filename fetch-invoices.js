/**
 * fetch-invoices.js — 全量拉取 1688 发票数据（正式版）
 *
 * 原理: 打开发票列表页（iframe 同源页面），复用页面自带的 window.lib.mtop 官方库发请求
 *      （自动处理 mtop 签名/防爬，绕不开 ILLEGAL_ACCESS 的根因在此），
 *      分页拉全量后导出 CSV。浏览器仅作传输层，不解析 DOM。
 *
 * 用法: node fetch-invoices.js
 * 前置: node login.js 已保存登录态
 * 输出: data/waiting-YYYY-MM-DD.csv  (待申请发票订单 —— 催收池)
 *       data/applying-YYYY-MM-DD.csv (申请中发票)
 *       data/issued-YYYY-MM-DD.csv   (已开具发票)
 */
const fs = require('fs');
const path = require('path');
const { launch, humanPause, ROOT } = require('./lib/browser');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_SIZE = 50;
const INVOICE_PAGE = 'https://air.1688.com/app/ctf-page/invoice/buyer-invoice-list.html';

/** 分→元 */
const fen2yuan = (v) => (Number(v || 0) / 100).toFixed(2);
/** 时间戳→日期时间 */
const ts2dt = (v) => (v ? new Date(Number(v)).toLocaleString('zh-CN', { hour12: false }) : '');

function toCsv(rows) {
  const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""').replace(/\s+/g, ' ').trim()}"`;
  return '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

async function main() {
  const { browser, context } = await launch();
  const page = await context.newPage();

  console.log(`打开发票页: ${INVOICE_PAGE}`);
  await page.goto(INVOICE_PAGE, { waitUntil: 'commit', timeout: 120000 }).catch(() => {});

  // 等 mtop 库就绪（页面 JS 异步加载）
  for (let i = 0; i < 30; i++) {
    const ok = await page.evaluate(() => !!(window.lib && window.lib.mtop)).catch(() => false);
    if (ok) break;
    await sleep(2000);
  }
  const ready = await page.evaluate(() => !!(window.lib && window.lib.mtop));
  if (!ready) {
    // 可能登录态失效（页面跳登录）
    const url = page.url();
    if (/login/i.test(url)) throw new Error('登录态已失效，请先运行 node login.js');
    throw new Error('页面 mtop 库未加载成功，请重跑一次');
  }
  console.log('[ok] mtop 库就绪');

  /** 调用发票服务，返回 {pagination, result} */
  const call = (args) =>
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

  /** 分页拉全量 */
  async function fetchAll(serviceId, baseParam, label) {
    const all = [];
    let page = 1;
    let total = Infinity;
    while (all.length < total) {
      const param = { ...baseParam, page, pageSize: PAGE_SIZE };
      const d = await call({ serviceId, paramStr: JSON.stringify(param) });
      total = Number(d.pagination.totalNum || 0);
      const batch = d.result || [];
      all.push(...batch);
      console.log(`  [${label}] 第${page}页: ${batch.length} 条 (累计 ${all.length}/${total})`);
      if (batch.length === 0) break;
      page++;
      await humanPause(page, 1000, 2500); // 翻页间隔，拟人
    }
    return all;
  }

  // ── 1. 待申请发票（催收池）──
  console.log('\n[1/3] 待申请发票...');
  const waiting = await fetchAll('KsInvoicePurchaserMtopService.searchInvoiceableOrderListByPage', {}, '待申请');
  const waitingRows = [['订单号', '支付时间', '订单状态', '卖家公司', '卖家登录ID', '商品', '订单金额(元)']];
  for (const r of waiting) {
    waitingRows.push([
      r.idStr,
      ts2dt(r.payTime),
      r.orderStatus || '',
      r.sellerCompanyName || '',
      r.sellerLoginId || '',
      r.productName || '',
      fen2yuan(r.sumPayment),
    ]);
  }

  // ── 2. 申请中发票 ──
  console.log('\n[2/3] 申请中发票...');
  const applying = await fetchAll(
    'KsInvoicePurchaserManageMtopService.queryInvoiceApplyRecordListByPage',
    { bizStatusList: [1, 5, 6, 40] },
    '申请中'
  );
  // ── 3. 已开具发票 ──
  console.log('\n[3/3] 已开具发票...');
  const issued = await fetchAll(
    'KsInvoicePurchaserManageMtopService.queryInvoiceApplyRecordListByPage',
    { bizStatusList: [2, 30, 31, 32] },
    '已开具'
  );

  const applyRows = (list, label) => {
    const rows = [['发票申请ID', '订单号', '卖家公司', '购买方抬头', '金额(元)', '状态', '申请时间', '最后更新', '开票截止', '备注']];
    for (const r of list) {
      const im = r.invoiceModel || {};
      const om = r.orderModel || {};
      rows.push([
        im.id,
        om.idStr || im.outBizId,
        om.sellerCompanyName || (im.sellerInvoiceTitleModel && im.sellerInvoiceTitleModel.title) || '',
        (im.purchaserInvoiceTitleModel && im.purchaserInvoiceTitleModel.title) || '',
        fen2yuan(im.amount || om.sumPayment),
        `${im.bizStatus || ''}(${label})`,
        im.gmtCreate || '',
        im.gmtModified || '',
        ts2dt(im.invoiceDeadline),
        im.invoiceType === 'VATAX_COMM' ? '电子普通发票' : im.invoiceType || '',
      ]);
    }
    return rows;
  };

  // ── 导出 CSV ──
  const stamp = new Date().toISOString().slice(0, 10);
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const files = [
    [`waiting-${stamp}.csv`, waitingRows],
    [`applying-${stamp}.csv`, applyRows(applying, '申请中')],
    [`issued-${stamp}.csv`, applyRows(issued, '已开具')],
  ];
  for (const [name, rows] of files) {
    const p = path.join(dataDir, name);
    fs.writeFileSync(p, toCsv(rows), 'utf-8');
    console.log(`[ok] ${name}: ${rows.length - 1} 条`);
  }

  // ── 汇总 ──
  const bySeller = {};
  for (const r of waiting) {
    const k = r.sellerCompanyName || r.sellerLoginId || '未知';
    bySeller[k] = bySeller[k] || { orders: 0, amount: 0 };
    bySeller[k].orders++;
    bySeller[k].amount += Number(r.sumPayment || 0);
  }
  const top = Object.entries(bySeller).sort((a, b) => b[1].amount - a[1].amount).slice(0, 10);
  console.log('\n=== 待开票 TOP10 卖家（催收优先级） ===');
  top.forEach(([name, v], i) => console.log(`${i + 1}. ${name}: ${v.orders}单 ¥${fen2yuan(v.amount)}`));

  await browser.close();
  console.log('\n[done] 全部完成');
}

main().catch((e) => {
  console.error('抓取出错:', e.message);
  process.exit(1);
});
