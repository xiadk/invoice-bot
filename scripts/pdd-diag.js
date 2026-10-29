#!/usr/bin/env node
/**
 * scripts/pdd-diag.js —— 拼多多开票状态「卡在 9（未同步开票）」只读诊断
 *
 * 只读：只查库 + 只调两个「列表」接口，不写库、不提交申请、不改配置。
 * 在有拼多多登录态的那台机器上跑（Cookie 存在 pdd_session 表里）。
 *
 * 用法：
 *   node scripts/pdd-diag.js                 # 看整体分布 + 每页条数
 *   node scripts/pdd-diag.js 260511-453163170161773   # 额外追踪某个订单号
 */
const db = require('../db');
const psync = require('../lib/pdd-sync');

const SN = (process.argv[2] || '').trim();
const STATUS_TEXT = { 0: '暂不可开票', 1: '开票中', 2: '已开票', 6: '商家处理中', 7: '待申请', 8: '已申请', 9: '未同步开票' };
const line = (s) => console.log(s);

async function who() {
  const rows = await db.query('SELECT DATABASE() db, @@hostname host');
  return rows[0];
}

async function distribution() {
  line('\n── 1. 库里的开票状态分布 ──');
  const rows = await db.query(
    `SELECT invoice_status st, COUNT(*) n FROM pdd_order GROUP BY invoice_status ORDER BY st`
  );
  if (!rows.length) line('  （pdd_order 为空）');
  for (const r of rows) line(`  ${String(r.st).padStart(2)} ${(STATUS_TEXT[r.st] || '未知').padEnd(6)} ${r.n} 单`);

  line('\n── 2. 卡在 9 的单，按订单状态文案分布 ──');
  const g = await db.query(
    `SELECT COALESCE(NULLIF(order_status_text,''),'（订单接口没给文案）') t,
            COUNT(*) n, SUM(parent_order_sn IS NOT NULL) combo
       FROM pdd_order WHERE invoice_status = 9
      GROUP BY t ORDER BY n DESC LIMIT 12`
  );
  if (!g.length) line('  （没有卡在 9 的单）');
  for (const r of g) line(`  ${String(r.n).padStart(4)} 单（组合单子单 ${r.combo || 0}）  ${r.t}`);

  line('\n── 3. 最近 10 条卡在 9 的单 ──');
  const rows3 = await db.query(
    `SELECT order_sn, order_time, order_status_text, parent_order_sn, synced_at
       FROM pdd_order WHERE invoice_status = 9 ORDER BY order_time DESC LIMIT 10`
  );
  if (!rows3.length) line('  （无）');
  for (const r of rows3) {
    line(`  ${r.order_sn}  ${r.order_time || '—'}  ${r.order_status_text || '—'}`
      + (r.parent_order_sn ? `  父单 ${r.parent_order_sn}` : '') + `  同步于 ${r.synced_at || '—'}`);
  }
  return rows;
}

async function session() {
  line('\n── 4. 登录态 ──');
  const rows = await db.query('SELECT user_id, account_name, pdduid, written_at FROM pdd_session');
  if (!rows.length) { line('  ✗ 库里没有拼多多登录态，无法做接口探测（请先在页面上登录拼多多）'); return null; }
  for (const r of rows) line(`  user_id=${r.user_id} 账号=${r.account_name || '—'} pdduid=${r.pdduid || '—'} 写入=${r.written_at}`);
  return Number(rows[0].user_id);
}

async function probe(uid, name, fetchPage, pageSize) {
  line(`\n── ${name}（page_size=${pageSize}）──`);
  const seen = new Set();
  let dup = 0;
  let hit = -1;
  let total = 0;
  for (let page = 1; page <= 30; page += 1) {
    const r = await fetchPage({ userId: uid, page, pageSize });
    if (!r.ok) { line(`  第 ${page} 页失败：${r.error}`); break; }
    const items = r.items || [];
    const sns = items.map((x) => String(x.order_sn || '')).filter(Boolean);
    const newOnes = sns.filter((s) => !seen.has(s));
    sns.forEach((s) => seen.add(s));
    if (page <= 3 || items.length < pageSize) {
      line(`  第 ${page} 页：${items.length} 条（新 ${newOnes.length}）`
        + (sns.length ? `　首 ${sns[0]}　末 ${sns[sns.length - 1]}` : ''));
    }
    if (items.length && !newOnes.length) dup += 1;
    total += items.length;
    if (SN && hit < 0 && sns.includes(SN)) hit = page;
    if (!items.length) break;                 // 只有空页才算真到底
    if (newOnes.length === 0) { line(`  第 ${page} 页整页重复 → 接口可能忽略 page_no，提前停`); break; }
    if (items.length < pageSize && page > 1) {
      line(`  ⚠ 第 ${page} 页只有 ${items.length} 条（< page_size ${pageSize}），按老逻辑就停在这里`);
    }
  }
  line(`  合计 ${total} 条 / 去重 ${seen.size} 条 / 整页重复 ${dup} 页`);
  if (SN) line(hit > 0 ? `  ✓ 目标单在第 ${hit} 页命中` : '  ✗ 30 页内没有找到目标单');
  return { total, unique: seen.size };
}

(async () => {
  const w = await who();
  line(`数据库：${w.db} @ ${w.host}`);
  await distribution();
  const uid = await session();
  if (!uid) process.exit(0);

  line('\n── 5. 接口探测（只调 list 接口，无写入）──');
  for (const size of [20, 10]) {
    await probe(uid, '待申请 list_invoice_order', psync.fetchInvoiceOrders, size);
  }
  for (const size of [20, 10]) {
    await probe(uid, '已申请 list_invoice', (o) => psync.fetchInvoices({ ...o, filterType: 0 }), size);
  }
  line('\n结论提示：若「待申请」在 page_size=20 时第一页不足 20 条、或总数远小于库里 9 的单数，'
    + '就是翻页被提前截断；若两个列表 30 页都找不到目标单，则是平台侧没有给该单开票入口。');
  process.exit(0);
})().catch((e) => { console.error('诊断异常：', e && e.message ? e.message : e); process.exit(1); });
