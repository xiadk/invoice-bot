#!/usr/bin/env node
/**
 * scripts/qnh-probe.js — 牵牛花「登录态 + 接口」自检（无浏览器版，v0.2.6）
 *
 * 用途：快速确认「登录态还在不在、退单接口通不通」，排障时先跑它。
 *
 * ⚠ 老版本要 launch 一个 Playwright 浏览器去抓包——服务器（云端）没有浏览器，
 *   本地也常缺 Chromium 二进制。现在登录由「本机助手」完成、登录态存进数据库，
 *   本脚本也就改成纯 HTTP 自检：**不需要浏览器、不写任何本机登录态文件**，
 *   云端和本地都能直接跑。
 *
 * 用法：
 *   node scripts/qnh-probe.js                # 默认查近 7 天
 *   node scripts/qnh-probe.js --days 3       # 自定义区间
 *   node scripts/qnh-probe.js --json         # 额外把结构写入 data/qnh-probe-<时间戳>.json
 *
 * 前置：看板里已用「本机助手」登录过牵牛花（登录态在 qnh_session 表里）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const qnh = require(path.join(ROOT, 'lib', 'qnh'));
const qsync = require(path.join(ROOT, 'lib', 'qnh-sync'));

function parseArgs(argv) {
  const out = { days: 7, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') { out.days = Math.max(1, Math.min(90, Number(argv[i + 1]) || 7)); i += 1; }
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = `牵牛花登录态 / 接口自检
  node scripts/qnh-probe.js [--days 7] [--json]

  --days N  查询区间（天），默认 7
  --json    把接口返回结构写入 data/qnh-probe-<时间戳>.json

  只用数据库里的登录态，不需要浏览器；没有登录态时请先在看板用「本机助手」登录。
`;

function safeJson(text) {
  if (!text || text.length > 2 * 1024 * 1024) return null;
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

/** 只描述结构（键名 + 类型），不保留任何值——避免手机号/地址落盘 */
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return 'array<空>';
    return `array<${depth >= 3 ? '…' : shape(v[0], depth + 1)}>`;
  }
  if (typeof v === 'object') {
    if (depth >= 3) return 'object';
    const keys = Object.keys(v).slice(0, 30);
    return `{${keys.map((k) => `${k}:${shape(v[k], depth + 1)}`).join(',')}}`;
  }
  return typeof v;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }

  // 登录态来自数据库（本机助手采集后回传），脚本不再依赖任何本机文件
  qsync.setStateProvider(qnh.loadStorageState, qnh.loadStorageMeta);

  console.log(`基址：${qsync.BASE_URL}`);
  const cookies = await qsync.stateCookies();
  if (!cookies.length) {
    console.error('\n✗ 没有登录态：请先在看板点「登录牵牛花」，用「本机助手」完成登录后再跑本脚本。');
    return 1;
  }
  const meta = await qnh.loadStorageMeta();
  console.log(`登录态：${cookies.length} 个 Cookie · 来源  ${meta.source || '未知'}`
    + ` · 写入于 ${meta.writtenAt || '未知'}`
    + (meta.earliestExpiry ? ` · 最早过期 ${meta.earliestExpiry}` : ''));

  const st = await qsync.isLogined();
  console.log(`探活：${st.logined ? '✓ 已登录' : '✗ 登录态已失效'}${st.error ? '（' + st.error + '）' : ''}`);
  if (st.account && Object.keys(st.account).length) console.log('  账号信息：' + shape(st.account));
  if (!st.logined) return 1;

  const now = Date.now();
  const startMs = now - args.days * 86400000;
  const page = await qsync.fetchRefundListPage({ page: 1, pageSize: 20, startMs, endMs: now });
  if (!page.ok) {
    console.error('✗ 拉取退单列表失败：' + page.message);
    return 1;
  }
  const first = page.records[0] || null;
  console.log(`\n退单列表：共 ${page.pageInfo.totalSize} 条 / ${page.pageInfo.totalPage} 页，本页 ${page.records.length} 条`);
  if (first) console.log('  记录结构：' + shape(first));

  if (first) {
    const o = first.orderVO || {};
    const detail = await qsync.fetchRefundDetail({
      channelOrderId: o.channelOrderId, channelId: o.channelId, channelAfsId: first.afterSaleId,
    });
    if (!detail.ok) console.log('  明细：✗ ' + detail.message);
    else {
      console.log(`  明细：✓ ${detail.items.length} 个商品行`);
      if (detail.items.length) console.log('    商品结构：' + shape(detail.items[0]));
    }
  }

  if (args.json) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = path.join(ROOT, 'data', `qnh-probe-${ts}.json`);
    try {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify({
        baseUrl: qsync.BASE_URL,
        capturedAt: new Date().toISOString(),
        note: '仅记录返回字段结构，不含字段值',
        logined: true,
        list: first ? shape(first) : null,
      }, null, 2), 'utf8');
      console.log(`\n已写入 ${outFile}`);
    } catch (e) {
      console.error('写入失败：' + (e && e.message));
    }
  }
  return 0;
}

main().then((code) => { process.exit(code || 0); })
  .catch((e) => { console.error('自检失败：' + String((e && e.message) || e)); process.exit(1); });
