/**
 * tmp-preview.js — 用看板的真实数据渲染「将要发送」的催收消息（不联网、不发送）
 * 逻辑与 server.js doSend() 完全一致：
 *   {amount}  = 该会员名的待开票金额
 *   {orderId} = 该会员名 invoice_state !== 'issued' 的全部订单号
 */
const fs = require('fs');
const { buildMessages } = require('./lib/sender');

(async () => {
  const base = 'http://127.0.0.1:8787';
  const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
  const data = await (await fetch(base + '/api/data')).json();
  const all = data.companies.flatMap((c) => c.members.map((m) => ({ ...m, companyName: c.company })));

  const wanted = process.argv.slice(2);
  for (const lid of wanted) {
    const m = all.find((x) => x.loginId === lid);
    if (!m) { console.log('!! 找不到会员名', lid); continue; }
    const det = await (await fetch(base + '/api/seller-detail?loginId=' + encodeURIComponent(lid))).json();
    const toRemind = det.orders.filter((o) => o.invoice_state !== 'issued');
    const msgSeller = {
      loginId: m.sellerLogin,
      amount: Number(m.pendingAmount),
      orders: toRemind.map((o) => ({ orderId: o.order_no, amount: Number(o.pay_amount).toFixed(2) })),
    };
    const msgs = buildMessages(msgSeller, config);
    const listSum = toRemind.reduce((a, o) => a + Number(o.pay_amount), 0);
    console.log('='.repeat(78));
    console.log(`【${m.companyName}】店铺=${m.sellerLogin}`);
    console.log(`  {amount} = 待开票金额 ¥${Number(m.pendingAmount).toFixed(2)}    ` +
      `{orderId} 清单 = ${toRemind.length} 单（订单实付合计 ¥${listSum.toFixed(2)}）`);
    console.log(`  该公司其他会员名（不进入本条消息）：` +
      (all.filter((x) => x.companyName === m.companyName && x.loginId !== lid).map((x) => x.sellerLogin).join('、') || '无'));
    console.log(`  → 共 ${msgs.length} 条消息`);
    msgs.forEach((t, i) => console.log(`\n--- 第 ${i + 1}/${msgs.length} 条 ---\n${t}`));
    console.log('');
  }
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
