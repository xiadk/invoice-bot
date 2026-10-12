/**
 * parse-orders.js — 解析订单导出文件，生成看板数据源
 *
 * ⚠️ 遗留脚本（legacy）：看板数据源已迁移到 MySQL，本脚本产出的
 *    data/orders-parsed.json 不再被 server.js 读取。保留仅为兼容旧流程，
 *    新流程请用 node import-to-db.js（Excel → MySQL）。
 *
 * 用法: node parse-orders.js
 * 输入: data/完成订单/*.xlsx （1688「已买到的货品」导出的订单列表）
 * 输出: data/orders-parsed.json （去重后的订单 + 卖家聚合）
 *
 * 说明:
 *   - 多SKU订单的续行没有订单编号，金额取主行
 *   - 重新从1688导出订单后，把新 xlsx 放进 data/完成订单/ 再跑本脚本
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'data', '完成订单');
const OUT = path.join(ROOT, 'data', 'orders-parsed.json');

function main() {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.xlsx'));
  if (files.length === 0) {
    console.error(`未找到 xlsx，请把1688导出的订单文件放进 ${SRC_DIR}`);
    process.exit(1);
  }

  const orders = new Map();
  let totalRows = 0;
  for (const f of files) {
    const wb = XLSX.readFile(path.join(SRC_DIR, f));
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const head = rows[0];
    const idx = {
      id: head.indexOf('订单编号'),
      sellerCompany: head.indexOf('卖家公司名'),
      sellerLogin: head.indexOf('卖家会员名'),
      pay: head.indexOf('实付款(元)'),
      status: head.indexOf('订单状态'),
      payTime: head.indexOf('订单付款时间'),
    };
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[idx.id]) continue; // 多SKU续行
      totalRows++;
      const id = String(r[idx.id]);
      if (!orders.has(id)) {
        orders.set(id, {
          id,
          sellerCompany: r[idx.sellerCompany],
          sellerLogin: String(r[idx.sellerLogin] || ''),
          amount: Number(r[idx.pay] || 0),
          payTime: r[idx.payTime]
            ? new Date(Math.round((Number(r[idx.payTime]) - 25569) * 86400 * 1000)).toLocaleString('zh-CN', { hour12: false })
            : '',
          status: r[idx.status],
        });
      }
    }
    console.log(`解析 ${f}: ${rows.length - 1} 行`);
  }

  // 卖家聚合
  const sellers = new Map();
  for (const o of orders.values()) {
    if (!sellers.has(o.sellerLogin)) {
      sellers.set(o.sellerLogin, { login: o.sellerLogin, company: o.sellerCompany, orders: 0, amount: 0 });
    }
    const s = sellers.get(o.sellerLogin);
    s.orders++;
    s.amount += o.amount;
  }

  fs.writeFileSync(OUT, JSON.stringify({ orders: [...orders.values()], sellers: [...sellers.values()] }));
  console.log(`\n[完成] 总行 ${totalRows}，去重后 ${orders.size} 单，${sellers.size} 家卖家 → ${path.basename(OUT)}`);
  console.log('提示: 可再跑 node refresh-status.js 刷新开票状态');
}

main();
