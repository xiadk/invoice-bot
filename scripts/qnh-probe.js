#!/usr/bin/env node
/**
 * scripts/qnh-probe.js — 牵牛花接口探测（一次性工具，v0.2.3）
 *
 * 用途：Node 重写同步链路时，需要先知道「退单列表 / 明细 / 日志」的真实接口。
 *      本脚本复用 lib/qnh-sync.js 的登录能力打开牵牛花，记录页面自己发出的所有 /api/ 请求，
 *      只输出「路径 + 参数名 + 返回字段名与类型」，**不记录任何字段值**（避免手机号/地址外泄）。
 *
 * 用法：
 *   node scripts/qnh-probe.js                     # 有头登录，默认观察 240 秒
 *   node scripts/qnh-probe.js --seconds 300       # 自定义观察时长
 *   node scripts/qnh-probe.js --headless --seconds 60
 *
 * 操作指引（脚本会打印）：登录后依次点开「退单列表」→ 翻一页 → 打开一条退单详情/日志。
 * 结果写入 data/qnh-probe-<时间戳>.json（data/* 已被 .gitignore 排除）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const qsync = require(path.join(ROOT, 'lib', 'qnh-sync'));

function parseArgs(argv) {
  const out = { seconds: 240, headless: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--seconds') { out.seconds = Math.max(20, Number(argv[i + 1]) || 240); i += 1; }
    else if (a === '--headless') out.headless = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = `牵牛花接口探测
  node scripts/qnh-probe.js [--seconds 240] [--headless]

  --seconds N   观察时长（秒），默认 240
  --headless    无窗口模式（不推荐：首次登录需要你看得见页面）
`;

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? '?<params>' : '');
  } catch (e) {
    return String(url).slice(0, 200);
  }
}

function queryKeysOf(url) {
  try { return [...new URL(url).searchParams.keys()]; } catch (e) { return []; }
}

function safeJson(text) {
  if (!text || text.length > 2 * 1024 * 1024) return null;
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

/** 只描述结构（键名 + 类型），不保留任何值 */
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return 'array<空>';
    return `array<${depth >= 3 ? '…' : shape(v[0], depth + 1)}>`;
  }
  if (typeof v === 'object') {
    if (depth >= 3) return 'object';
    const keys = Object.keys(v).slice(0, 30);
    const body = keys.map((k) => `${k}:${shape(v[k], depth + 1)}`).join(',');
    return `{${body}}`;
  }
  return typeof v;
}

function bodyKeysOf(postData) {
  const j = safeJson(postData || '');
  if (j && typeof j === 'object' && !Array.isArray(j)) return Object.keys(j);
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }

  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch (e) {
    console.error('未安装 playwright：npm i playwright');
    return 1;
  }

  console.log(`基址：${qsync.BASE_URL}`);
  console.log(`登录态：${qsync.stateExists() ? qsync.STATE_PATH : '（无，先登录一次）'}`);

  if (!qsync.stateExists()) {
    console.log('\n没有本地登录态，先打开窗口登录（看到「登录成功」即可，之后会另开一个观察窗口）…');
    const r = await qsync.login({ headless: args.headless, onEvent: (m) => console.log('  · ' + m) });
    if (!r.ok) {
      console.error('\n登录未完成：' + r.message);
      return 1;
    }
    console.log('  ✓ ' + r.message + `（Cookie ${r.cookieCount} 条）`);
  }

  const collected = new Map();
  let browser = null;

  const record = (rec) => {
    const key = `${rec.method} ${rec.path}`;
    const hit = collected.get(key);
    if (hit) {
      hit.count += 1;
      if (!hit.shape && rec.shape) { hit.shape = rec.shape; hit.status = rec.status; }
      for (const k of rec.queryKeys) if (!hit.queryKeys.includes(k)) hit.queryKeys.push(k);
      for (const k of rec.bodyKeys) if (!hit.bodyKeys.includes(k)) hit.bodyKeys.push(k);
      return;
    }
    collected.set(key, { ...rec, count: 1 });
  };

  try {
    browser = await chromium.launch({ headless: args.headless, args: ['--disable-blink-features=AutomationControlled'] });
    const ctx = await browser.newContext({
      storageState: qsync.STATE_PATH,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1360, height: 900 },
      locale: 'zh-CN',
    });
    const page = await ctx.newPage();

    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (!/\/api\//.test(url)) return;
        const req = res.request();
        const ct = String(res.headers()['content-type'] || '');
        const rec = {
          method: req.method(),
          path: pathOf(url),
          queryKeys: queryKeysOf(url),
          bodyKeys: bodyKeysOf(req.postData()),
          status: res.status(),
          contentType: ct.split(';')[0],
          shape: null,
        };
        if (ct.includes('json')) {
          const txt = await res.text().catch(() => '');
          const j = safeJson(txt);
          if (j !== null) rec.shape = shape(j);
        }
        record(rec);
      } catch (e) { /* 页面跳转中响应体可能取不到，忽略 */ }
    });

    console.log('\n正在打开牵牛花…');
    await page.goto(qsync.BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log([
      '请在打开的窗口里依次操作（每步停留几秒，让请求被记录下来）：',
      '  ① 进入「退单列表」页',
      '  ② 翻到第 2 页（记录分页参数）',
      '  ③ 打开一条退单的详情 / 日志',
      `观察时长 ${args.seconds} 秒，结束后自动汇总。`,
    ].join('\n'));

    const tty = process.stdin.isTTY;
    const manual = new Promise((resolve) => {
      if (!tty) return;
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => { console.log('\n收到回车，提前结束观察。'); resolve(); });
    });
    const timer = new Promise((resolve) => setTimeout(resolve, args.seconds * 1000));
    await Promise.race([timer, manual]);
    process.stdin.pause();

    const list = [...collected.values()].sort((a, b) => b.count - a.count);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = path.join(ROOT, 'data', `qnh-probe-${ts}.json`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
      baseUrl: qsync.BASE_URL,
      capturedAt: new Date().toISOString(),
      note: '仅记录接口路径/参数名/返回字段结构，不含字段值',
      endpoints: list,
    }, null, 2), 'utf8');

    console.log(`\n捕获 ${list.length} 个接口：`);
    if (!list.length) {
      console.log('  （没有捕到 /api/ 请求：可能页面还没加载完，或登录态失效，重跑并多停留一会儿）');
    }
    for (const e of list) {
      const q = e.queryKeys.length ? ` 入参名:${e.queryKeys.join(',')}` : '';
      const b = e.bodyKeys.length ? ` 体字段:${e.bodyKeys.join(',')}` : '';
      console.log(`  ${String(e.count).padStart(3)}×  ${e.method} ${e.path}  [${e.status}]${q}${b}`);
      if (e.shape) console.log(`        返回: ${e.shape.slice(0, 400)}`);
    }
    console.log(`\n已写入：${outFile}`);
    console.log('把这份文件（或上面的接口清单）给我，就能确定退单列表/明细/日志的接口契约。');
    return 0;
  } catch (e) {
    console.error('探测失败：' + ((e && e.message) || e));
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('探测异常：' + ((e && e.stack) || e));
  process.exit(1);
});
