/**
 * scripts/ali-set-cookie.js — 保存 1688 登录 Cookie 并立即自检
 *
 * 用法（登录 1688 后，在浏览器 F12 → Network → 任一 1688 请求 → Copy as cURL，
 * 或者 Application → Cookies 里拼一串 name=value; name=value）：
 *
 *   node scripts/ali-set-cookie.js              ← 从剪贴板读取
 *   node scripts/ali-set-cookie.js "a=1; b=2"   ← 直接传串
 *   node scripts/ali-set-cookie.js --file c.txt ← 从文件读
 *
 * 它会：
 *   1) 校验关键项（cookie2 / __cn_logon__），缺了直接告诉你
 *   2) 写入 data/ali-cookie.txt（该目录已被 .gitignore 排除，不进版本库）
 *   3) 用「库中最近订单时间」真打一次 mtop，把返回码和首单字段名打出来
 *      —— 字段名是校准入库映射的依据
 */
const fs = require('fs');
const path = require('path');
// 仅用于「读剪贴板」（powershell Get-Clipboard）这一次性便利，不参与服务运行
const { execSync } = require('child_process'); // arch-allow: child_process 读剪贴板，仅本机运维脚本用，非服务运行路径

const ROOT = path.resolve(__dirname, '..');
const ali = require(path.join(ROOT, 'lib', 'ali-orders'));

function fromClipboard() {
  try {
    // PowerShell 输出可能带 BOM/换行，去掉
    let s = execSync('powershell -NoProfile -Command "Get-Clipboard -Raw"',
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return String(s || '').replace(/^\uFEFF/, '').trim();
  } catch (e) {
    return '';
  }
}

function normalize(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // 允许直接粘贴整段 cURL：把 -H 'cookie: xxx' 里的值抠出来
  const m = s.match(/cookie:\s*([^'"]+)/i);
  if (m && /cookie2|__cn_logon__/.test(m[1])) s = m[1];
  s = s.replace(/^cookie:\s*/i, '').replace(/\s+/g, ' ').trim();
  return s;
}

(async () => {
  const args = process.argv.slice(2);
  let raw = '';
  if (args[0] === '--file' && args[1]) {
    raw = fs.readFileSync(path.resolve(args[1]), 'utf-8');
  } else if (args[0]) {
    raw = args.join(' ');
  } else {
    console.log('· 未传参，从剪贴板读取…');
    raw = fromClipboard();
  }
  const cookie = normalize(raw);
  if (!cookie) {
    console.error('✗ 没读到 cookie。请在浏览器登录 1688，复制 cookie 串后再试。');
    process.exit(1);
  }

  const names = cookie.split(';').map((x) => x.trim().split('=')[0]).filter(Boolean);
  const has = (n) => names.includes(n);
  console.log('· cookie 长度 %d，%d 项', cookie.length, names.length);
  console.log('  cookie2: %s   __cn_logon__: %s   _m_h5_tk: %s',
    has('cookie2') ? '有' : '缺', has('__cn_logon__') ? '有' : '缺', has('_m_h5_tk') ? '有' : '无');
  if (!has('cookie2') && !has('__cn_logon__')) {
    console.error('✗ 既没有 cookie2 也没有 __cn_logon__，这不是登录态。请确认已登录 1688（不是仅打开首页）。');
    process.exit(1);
  }

  ali.saveCookie(cookie);
  console.log('✓ 已写入', ali.COOKIE_FILE);

  // 起点时间：按数据归属用户取；不指定就自动找「有订单的那个用户」
  const uidArg = args.indexOf('--uid');
  let uid = uidArg >= 0 ? Number(args[uidArg + 1]) : null;
  if (!uid) {
    try {
      const db = require(path.join(ROOT, 'db'));
      const rows = await db.query(
        'SELECT user_id AS uid, COUNT(*) AS n FROM invoice_order GROUP BY user_id ORDER BY n DESC LIMIT 1');
      uid = rows && rows[0] ? Number(rows[0].uid) : 1;
    } catch (e) { uid = 1; }
  }
  const t = await ali.latestOrderTime(uid).catch(() => null);
  console.log('· 数据归属 user_id = %d，库中最近订单时间: %s', uid, t || '(无，需指定起点)');

  const r = await ali.fetchOrderPage({
    cookie,
    startDateTime: t || '2026-10-01 00:00:00',
    page: 1,
    pageSize: 3,
  });
  if (!r.ok) {
    console.error('✗ 接口返回失败:', r.error);
    if (r.ret) console.error('  ret:', r.ret);
    process.exit(2);
  }
  const { path: arrPath, rows } = ali.pickArray(r.json);
  console.log('✓ 接口调用成功');
  console.log('  订单数组路径: %s   本页条数: %d', arrPath || '(未找到)', rows.length);
  if (rows.length) {
    console.log('  首单字段（校准映射用）:');
    console.log('   ', Object.keys(rows[0]).join(', '));
    console.log('  映射结果:');
    console.log('   ', JSON.stringify(ali.mapOrder(rows[0], uid), null, 2).replace(/\n/g, '\n    '));
  }
  process.exit(0);
})().catch((e) => { console.error('✗ 异常:', e.message); process.exit(3); });
