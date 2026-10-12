/**
 * refresh-status.js — 刷新发票状态（订单级开票状态）
 *
 * 拉取「已申请」「已开票」发票的订单号清单：
 *   1. 写入 data/invoice-status.json（原始快照，供 import-to-db 复用）
 *   2. 同步更新 MySQL 中 invoice_order.invoice_state（看板直接读到最新状态）
 *
 * 发消息催收几天后跑一次，就能看到哪些订单从「已申请」变成了「已开票」（催收转化）。
 *
 * 用法: node refresh-status.js
 * 前置: 数据库须已启动（scripts/mysql-start.bat）；同步失败不影响 json 的保存
 */
const fs = require('fs');
const path = require('path');
const { launch, ROOT } = require('./lib/browser');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INVOICE_PAGE = 'https://air.1688.com/app/ctf-page/invoice/buyer-invoice-list.html';

async function main() {
  const { browser, context } = await launch();
  const page = await context.newPage();
  await page.goto(INVOICE_PAGE, { waitUntil: 'commit', timeout: 90000 }).catch(() => {});
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    if (await page.evaluate(() => !!(window.lib && window.lib.mtop)).catch(() => false)) { ready = true; break; }
  }
  if (!ready) throw new Error('mtop 未就绪，请先 node login.js');

  const call = (serviceId, param) =>
    page.evaluate(async ({ serviceId, paramStr }) => {
      const r = await window.lib.mtop.request({
        api: 'mtop.1688.kingsuns.invoice.dataline.service', v: '1.0',
        data: { serviceId, param: paramStr }, type: 'POST', dataType: 'json', timeout: 30000,
      });
      return r.data.data;
    }, { serviceId, paramStr: JSON.stringify(param) });

  async function fetchAll(bizStatusList, label) {
    const all = [];
    let p = 1, total = Infinity;
    while (all.length < total) {
      const d = await call('KsInvoicePurchaserManageMtopService.queryInvoiceApplyRecordListByPage', {
        page: p, pageSize: 50, bizStatusList,
      });
      total = Number(d.pagination.totalNum || 0);
      all.push(...(d.result || []));
      if (!(d.result || []).length) break;
      p++;
      await sleep(1200 + Math.random() * 800);
    }
    const ids = new Set(all.map((r) => {
      const om = r.orderModel || {}, im = r.invoiceModel || {};
      return String(om.idStr || im.outBizId || '');
    }).filter(Boolean));
    console.log(`[${label}] ${ids.size} 单`);
    return [...ids];
  }

  console.log('拉取已申请发票...');
  const applying = await fetchAll([1, 5, 6, 40], '已申请');
  console.log('拉取已开票发票...');
  const issued = await fetchAll([2, 30, 31, 32], '已开票');

  const out = path.join(ROOT, 'data', 'invoice-status.json');
  fs.writeFileSync(out, JSON.stringify({ applying, issued, updatedAt: new Date().toISOString() }));
  console.log(`\n[完成] 状态已保存: ${out}`);

  // 同步进 MySQL（看板数据源），失败不影响上面的 json
  const db = require('./db');
  try {
    const { applyInvoiceStatus } = require('./import-to-db');
    const r = await applyInvoiceStatus();
    console.log(`[数据库] 已同步订单开票状态: 更新 ${r.applied} 单（已申请 ${r.applyingCount} / 已开票 ${r.issuedCount}）`);
    const [{ n }] = await db.query(
      "SELECT COUNT(*) AS n FROM invoice_order WHERE invoice_state = 'issued'"
    );
    console.log(`[数据库] 当前订单表中标记为「已开票」的订单: ${n} 单`);
  } catch (e) {
    console.error('[数据库] 同步失败:', e.message);
    console.error('  提示: 请确认数据库已启动（scripts\\mysql-start.bat），或稍后在控制台点「重新导入数据」补同步');
  } finally {
    await db.closePool().catch(() => {});
  }

  console.log('看板刷新页面即可看到最新状态');
  await browser.close();
}

main().catch((e) => { console.error('刷新失败:', e.message); process.exit(1); });
