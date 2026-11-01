#!/usr/bin/env node
'use strict';
/**
 * tools/afa-token/index.js — 城配速达（阿发）Token 抓取小工具（命令行）
 *
 * 为什么有这个工具：阿发的 Token 由微信小程序登录后自动下发（带一次性 code），人工只能用
 * 抓包软件抄，约 1 天就过期。本工具把「装临时根证书 → 系统代理指向本机中间人 → 抓一次
 * /miniapp/login/login → 打印 Token → 立刻还原代理并删证书」这一套串起来。
 *
 * 只在本机使用：
 *   · 没有网页界面，只能在这台机器的终端里跑（双击 run.cmd 或 node index.js）
 *   · 中间人代理只监听 127.0.0.1 的随机端口，局域网其它机器连不上
 *   · Token 只打印到终端（并复制到剪贴板），不写文件、不写日志、不联网上传
 *   · data/ 目录只保存「系统代理原值」，用于被强杀后下次启动还原，不含任何凭据
 *
 * 用法：
 *   node tools/afa-token/index.js              正常抓取（默认等 180 秒）
 *   node tools/afa-token/index.js --timeout=300  自定义等待秒数
 *   node tools/afa-token/index.js --check      只检查本机代理/证书是否有残留
 *   node tools/afa-token/index.js --fix        清理上次残留（还原代理 + 删证书）
 *   node tools/afa-token/index.js --selftest   离线自检（不装证书、不起代理）
 *
 * 退出码：0 抓到并已收尾；1 失败 / 超时 / 取消；2 本机环境不满足
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
// clip.exe：把 Token 直接塞进剪贴板，避免终端软换行把长 JWT 复制成多行
const { spawnSync } = require('child_process'); // arch-allow: child_process（只用于 clip.exe 写剪贴板与只读查询 certutil）

const cap = require('./capture');

const BAR = '='.repeat(60);
const DEFAULT_TIMEOUT_SEC = 180;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write((s == null ? '' : String(s)) + '\n');
const bar = () => out(BAR);

function parseArgs(argv) {
  const a = { timeout: DEFAULT_TIMEOUT_SEC, check: false, fix: false, selftest: false, help: false, yes: false };
  for (const s of argv.slice(2)) {
    if (s === '--check') a.check = true;
    else if (s === '--fix') a.fix = true;
    else if (s === '--selftest') a.selftest = true;
    else if (s === '--help' || s === '-h') a.help = true;
    else if (s === '-y' || s === '--yes') a.yes = true;
    else if (/^--timeout=\d+$/.test(s)) a.timeout = Math.max(20, Math.min(900, Number(s.split('=')[1])));
  }
  return a;
}

function usage() {
  bar();
  out(' 阿发 Token 抓取小工具');
  bar();
  out('  双击 run.cmd，或在本目录执行：node index.js');
  out('');
  out('  参数：');
  out('    --timeout=<秒>   等待小程序登录的超时，默认 ' + DEFAULT_TIMEOUT_SEC + '，范围 20~900');
  out('    --check          只检查本机系统代理 / 证书是否有残留（不改动任何东西）');
  out('    --fix            清理上次残留：还原系统代理 + 删除临时根证书');
  out('    --selftest       离线自检：验证 Token 解析与打印格式，不装证书也不起代理');
  out('    -y, --yes        跳过开跑前的回车确认');
  out('');
  out('  抓到的 Token 怎么用：打开 invoice-bot → 补货与商品 → 「配置阿发Token」→ 粘贴 → 保存。');
  bar();
}

function fmtTime(ms) {
  if (!ms) return '（Token 里没写 exp）';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const leftH = Math.max(0, Math.round((ms - Date.now()) / 3600000));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    + '（约 ' + leftH + ' 小时后过期）';
}

function toClipboard(text) {
  try {
    const r = spawnSync('clip', [], { input: text, windowsHide: true, timeout: 5000 });
    return r && r.status === 0;
  } catch (e) { return false; }
}

/** 把抓到的 Token 打印成方便复制的一块（自检时不动剪贴板） */
function printToken(info, opt) {
  const useClip = !(opt && opt.clip === false);
  if (!(opt && opt.erase === false)) process.stdout.write('\r' + ' '.repeat(60) + '\r'); // 擦掉进度行
  const copied = useClip ? toClipboard(info.token) : false;
  bar();
  out(' 抓到 Token 了');
  bar();
  out(' 下面这一整行就是 Token' + (copied ? '（已复制到剪贴板，可直接 Ctrl+V 粘贴）' : '（请完整选中复制）') + '：');
  out('');
  out(info.token);
  out('');
  out(' 门店 storeId : ' + info.storeId);
  out(' 小程序 appId : ' + info.appId);
  out(' 商户 mid     : ' + (info.mid || '（Token 里没解出）'));
  out(' 有效期至     : ' + fmtTime(info.exp));
  out(' 抓取来源     : ' + (info.from || 'login 响应'));
  bar();
  out(' 下一步：打开 invoice-bot → 补货与商品 → 「配置阿发Token」');
  out('        → 粘贴上面的 Token（门店 / appId 会自动带出）→ 保存');
  bar();
}

async function askEnter(question) {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question(question, res));
  rl.close();
  return /^\s*$/i.test(ans) || /^y/i.test(ans);
}

function listCaByCn() {
  const found = [];
  const stores = [{ name: '当前用户', args: ['-user', '-store', 'Root'] }, { name: '本机', args: ['-store', 'Root'] }];
  for (const st of stores) {
    let r = null;
    try { r = spawnSync('certutil', st.args, { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }); } catch (e) { continue; }
    const text = String((r && r.stdout) || '');
    for (const cn of [cap._internals.CA_CN, cap._internals.LEGACY_CA_CN]) {
      if (text.indexOf(cn) >= 0) found.push({ store: st.name, cn });
    }
  }
  return found;
}

async function doCheck() {
  bar();
  out(' 本机检查（只读，不改动任何设置）');
  bar();
  const px = await cap.readProxy();
  const isOurs = px.enable === 1 && /^127\.0\.0\.1:\d+$/.test(String(px.server || ''));
  out(' 系统代理(ProxyEnable) : ' + px.enable);
  out(' 代理地址(ProxyServer) : ' + (px.server || '（未设置）'));
  out(' 判定                  : ' + (isOurs
    ? '⚠ 正指向本机抓包端口，若是残留请执行 --fix'
    : (px.enable === 1 ? '正常（指向外部代理，不是本工具的）' : '正常（未启用系统代理）')));
  const ca = listCaByCn();
  out(' 临时根证书            : ' + (ca.length ? '⚠ 发现 ' + ca.length + ' 处残留：' + ca.map((c) => c.cn + '@' + c.store).join('、') : '无'));
  const sess = fs.existsSync(path.join(cap._internals.DIR, 'session.json'));
  out(' 上次会话兜底文件      : ' + (sess ? '存在（说明上次被强杀，建议 --fix）' : '无'));
  bar();
  return ca.length === 0 && !sess && !isOurs;
}

async function doFix() {
  out('正在清理残留…');
  const r = await cap.cleanupOnBoot();
  if (r && r.restored) {
    out(' 已还原系统代理并删除残留证书。');
  } else if (r && r.skipped) {
    out(' 没有发现残留，本机是干净的。');
  } else {
    out(' 清理完成（若提示本机存储仍有证书，请用管理员执行 certutil -delstore Root "' + cap._internals.CA_CN + '"）');
  }
  return true;
}

/** 离线自检：真实 login 响应结构喂给解析器，验证 token/storeId/appId 抽取与打印 */
function doSelftest() {
  const I = cap._internals;
  bar();
  out(' 离线自检（不装证书、不起代理、不联网）');
  bar();
  const b64u = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sample = {
    code: 0,
    msg: 'ok',
    data: {
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
        + b64u({ mid: 123456, userId: 666, exp: Math.floor(Date.now() / 1000) + 86400 }) + '.'
        + 'c2lnbmF0dXJlLXBsYWNlaG9sZGVyLWZvci1zZWxmdGVzdA',
      storeId: 148,
      userInfo: { appId: 'wxc050ff76c31c4371', nickName: '门店账号' },
    },
  };
  const hit = I.scanJson(sample);
  const checks = [
    ['从 login 响应里取到 Token', !!hit.token],
    ['Token 形如 JWT（三段）', I.looksJwt(hit.token)],
    ['取到 storeId = 148', hit.storeId === '148'],
    ['取到 appId = wxc050ff76c31c4371', hit.appId === 'wxc050ff76c31c4371'],
    ['JWT 里解出 mid = 123456', I.jwtMid(hit.token) === 123456],
    ['JWT 里解出 exp', !!I.jwtExp(hit.token)],
    ['gzip 压缩的响应也能解出 Token', (() => {
      try {
        const raw = zlib.gzipSync(Buffer.from(JSON.stringify({ data: { token: hit.token } }), 'utf8'));
        return !!I.scanJson(JSON.parse(I.decodeBody(raw, { 'content-encoding': 'gzip' }).toString('utf8'))).token;
      } catch (e) { return false; }
    })()],
    ['只解密 zhoupudata.com，微信域名直通', I.hostMatches('bluespace-plus.zhoupudata.com') && !I.hostMatches('weixin.qq.com')],
  ];

  let pass = 0;
  for (const [name, ok] of checks) {
    out(' ' + (ok ? '[OK]  ' : '[FAIL]') + ' ' + name);
    if (ok) pass += 1;
  }
  out('');
  out(' 打印格式预览：');
  printToken({
    token: hit.token, storeId: hit.storeId, appId: hit.appId,
    mid: I.jwtMid(hit.token), exp: I.jwtExp(hit.token), from: '（自检样例）',
  }, { clip: false, erase: false });
  bar();
  out(' 结果：' + pass + ' / ' + checks.length + ' 项通过');
  bar();
  return pass === checks.length;
}

async function run(opts) {
  if (process.platform !== 'win32') {
    out('这个工具只能在 Windows 上跑（要改系统代理和证书存储）。');
    return 2;
  }

  bar();
  out(' 阿发 Token 抓取（本机抓包，仅此一次）');
  bar();
  out(' 抓包会临时做三件事，抓完立刻全部撤回：');
  out('   1. 装一张临时根证书（Windows 会弹一次安全警告，点「是」）');
  out('   2. 把系统代理指向本机中间人（只解密 zhoupudata.com，其它程序照常联网）');
  out('   3. 抓到 Token 后还原代理、停代理、删证书');
  out('');
  out(' 想跳过安全警告弹窗：右键 run.cmd → 以管理员身份运行（管理员装证书不弹窗）。');
  bar();
  out(' 请先做这一件事：');
  out('   · 彻底退出微信：任务管理器里结束 WeChat.exe 与 WeChatAppEx.exe');
  out('     （只关窗口不算，微信会复用旧连接，抓不到登录请求）');
  out('   · 然后重新打开微信 → 进入「永源顺城配速达」小程序 → 停在小程序首页');
  out('   · 小程序若已登录，先在「我的」里退出登录，这样才会重新发登录请求');
  bar();

  if (!opts.yes && !(await askEnter(' 准备好了就按回车开始（Ctrl+C 取消）：'))) {
    out(' 已取消。');
    return 1;
  }

  // 先清上次残留，避免旧代理值被当成「原值」保存
  const boot = await cap.cleanupOnBoot().catch(() => null);
  if (boot && boot.restored) out(' 提示：先还原了上次残留的代理设置。');

  out('');
  out(' [1/4] 生成并安装临时根证书…');
  const prep = await cap.prepare();
  if (!prep.ok) {
    out(' 失败：' + prep.error);
    out(' 提示：若提示安装证书失败，可手动导入 tools/afa-token/data/ca.der 后重试。');
    return 1;
  }
  out('       OK');

  out(' [2/4] 启动本机中间人代理（只监听 127.0.0.1）…');
  const proxy = cap.createProxyServer();
  await new Promise((resolve, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(0, '127.0.0.1', resolve); // 只绑回环，局域网连不上
  });
  const port = proxy.server.address().port;
  out('       OK（端口 ' + port + '）');

  out(' [3/4] 把系统代理指向本机…');
  const act = await cap.activate(port, proxy);
  if (!act.ok) {
    await cap.cleanup('error');
    out(' 失败：' + (act.error || '设置系统代理失败'));
    return 1;
  }
  out('       OK');
  out('');
  out(' [4/4] 等微信发出登录请求（最多 ' + Math.round(act.timeoutMs / 1000) + ' 秒）…');
  out('       现在去微信里点一下小程序，让它重新登录。');
  out('');

  let got = false;
  cap.setOnToken((info) => { got = true; printToken(info); });

  const isTty = process.stdout.isTTY;
  let last = -1;
  while (true) {
    const s = cap.status();
    if (s.status === 'captured') break;
    if (s.status === 'timeout' || s.status === 'error' || s.status === 'cancelled' || s.status === 'idle') break;
    if (isTty && s.remainSec !== last) {
      last = s.remainSec;
      process.stdout.write('\r       剩余 ' + String(s.remainSec).padStart(3, ' ') + ' 秒 · 已转发 ' + s.hits + ' 个请求   ');
    }
    await sleep(300);
  }

  // 等收尾（还原代理 / 删证书）落定
  for (let i = 0; i < 40; i += 1) {
    if (!cap.status().active) break;
    await sleep(250);
  }
  const fin = cap.status();
  if (got) {
    out(' 收尾完成：系统代理已还原、临时证书已删除。窗口可以直接关掉。');
    return 0;
  }
  if (isTty) process.stdout.write('\r' + ' '.repeat(60) + '\r');
  if (fin.status === 'timeout') {
    out(' 超时：' + (fin.error || '没有抓到登录请求'));
    out(' 常见原因：微信没彻底退出（旧连接还在）、或没在小程序里重新登录。');
    out(' 收尾已完成：代理已还原、证书已删除，可以再跑一次。');
  } else if (fin.status === 'cancelled') {
    out(' 已取消：代理已还原、证书已删除。');
  } else {
    out(' 失败：' + (fin.error || '未知原因'));
  }
  return 1;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { usage(); return 0; }
  if (opts.selftest) return doSelftest() ? 0 : 1;
  if (process.platform !== 'win32') {
    out('这个工具只能在 Windows 上跑（要改系统代理和证书存储）。');
    return 2;
  }
  if (opts.check) return (await doCheck()) ? 0 : 1;
  if (opts.fix) return (await doFix()) ? 0 : 1;
  return run(opts);
}

// Ctrl+C：任何时刻都要把系统代理还原、证书删掉，否则整机没网
let interrupting = false;
process.on('SIGINT', async () => {
  if (interrupting) process.exit(130);
  interrupting = true;
  out('');
  out(' 收到中断，正在还原系统代理并删除证书…');
  try { await cap.cleanup('cancel'); } catch (e) { /* ignore */ }
  out(' 已清理，可以安全退出。');
  process.exit(130);
});

main()
  .then((code) => { process.exitCode = code; })
  .catch(async (e) => {
    out(' 出错：' + String((e && e.message) || e));
    try { await cap.cleanup('error'); } catch (x) { /* ignore */ }
    process.exitCode = 1;
  });
