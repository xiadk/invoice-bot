'use strict';
/**
 * tools/afa-token/capture.js — 城配速达（阿发）Token 抓取内核
 *
 * 这个文件原本是项目里的 lib/afa-capture.js（v0.2.88）。v0.2.89 起项目只保留「配置 Token」，
 * 抓包整段搬到这里成为独立小工具：不连数据库、不落库，抓到就把 Token 交给调用方打印。
 *
 * 为什么需要它：阿发的 Token 是小程序登录后由微信自动下发的（带一次性 code），
 * 人工只能靠抓包工具复制，过期（约 1 天）就得重来一次。这里把整套「装证书 → 设系统代理
 * → 中间人解密 → 抓 /miniapp/login/login 响应 → 打印 → 还原并清理」自动化。
 *
 * 流程（一次会话）：
 *   1. prepare()  生成 CA（首次）+ 装进根证书存储 + 记下系统代理原值
 *   2. createProxyServer() 由 index.js listen（只绑 127.0.0.1，局域网访问不到）
 *   3. activate() 把系统代理指向本机代理端口，开始等
 *   4. 抓到 login 响应里的 token → onToken 回调（打印）→ 立即 cleanup()：还原代理 / 停服务 / 删 CA
 *
 * 安全边界：
 *   · 只解密 *.zhoupudata.com 的 TLS，其它域名一律纯 TCP 隧道直通（不碰内容、不影响其证书校验）
 *   · Token 明文只走内存与终端输出，不写文件、不写日志；data/ 下只存系统代理原值用于强杀兜底
 *   · CA 私钥只存在 tools/afa-token/data/（已被 .gitignore 排除），会话结束即删除
 *   · 任何异常路径都走同一个 cleanup()，并且启动时会自动还原上次残留的代理设置
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const zlib = require('zlib');
const forge = require('node-forge');
// 装/删根证书（certutil）与读写 WinINET 代理注册表（reg.exe）都是系统级操作，Node 无原生替代
const { execFile } = require('child_process'); // arch-allow: child_process（certutil 装/删根证书、reg 改系统代理开关）

const DIR = path.join(__dirname, 'data');
const CA_CN = 'invoice-bot AFA Token Tool CA';
/** v0.2.88 留在系统里的旧证书名，启动兜底时一并清掉（那时抓包还在项目服务里） */
const LEGACY_CA_CN = 'invoice-bot AFA Capture CA';
const DEFAULT_STORE_ID = '148';
const DEFAULT_APP_ID = 'wxc050ff76c31c4371';
/** 注册表位置：JS/reg 语法与 PowerShell 路径两种写法 */
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const REG_KEY_PS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PS = 'powershell.exe';
/** 只对这些域名做 TLS 解密；命中不了的一律隧道直通 */
const MITM_SUFFIX = ['zhoupudata.com'];
const DEFAULT_TIMEOUT_MS = 180 * 1000;
const MAX_BODY = 2 * 1024 * 1024;
const PROXY_BYPASS = '<local>;127.*;10.*;192.168.*;169.254.*';

// ── 小工具 ────────────────────────────────────────────────
function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err && err.message) || ''),
        timedOut: !!(err && err.killed),
      });
    });
  });
}

function pemToDer(pem) {
  return Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function rmQuiet(p) {
  try { fs.rmSync(p, { force: true, recursive: true }); } catch (e) { /* ignore */ }
}

function isWin() {
  return process.platform === 'win32';
}

function psq(v) {
  return "'" + String(v == null ? '' : v).replace(/'/g, "''") + "'";
}

/** 跑一段 PowerShell（改注册表只走这条路：reg.exe 在本机安全策略黑名单里，会被拦） */
async function ps(script, timeout = 30000) {
  return run(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout });
}

async function isAdmin() {
  if (process.platform !== 'win32') return false;
  const r = await ps('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
  return /true/i.test(r.stdout);
}

// ── 证书：CA + 通配叶子 ────────────────────────────────────
function genCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: CA_CN },
    { name: 'organizationName', value: 'invoice-bot local capture (temporary)' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert,
    keys,
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function genLeaf(ca, hostList) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6);
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  cert.setSubject([{ name: 'commonName', value: hostList[0] }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: hostList.map((h) => ({ type: 2, value: h })) },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

/** 生成或复用 CA 文件（每次会话结束都会删，所以基本每次都是新生成） */
function ensureCaFiles() {
  ensureDir();
  const caPem = path.join(DIR, 'ca.pem');
  const caKey = path.join(DIR, 'ca.key');
  const caDer = path.join(DIR, 'ca.der');
  const leafPem = path.join(DIR, 'leaf.pem');
  const leafKey = path.join(DIR, 'leaf.key');

  if (fs.existsSync(caPem) && fs.existsSync(caKey) && fs.existsSync(leafPem) && fs.existsSync(leafKey)) {
    try {
      const certPem = fs.readFileSync(caPem, 'utf8');
      return {
        ca: { certPem, keyPem: fs.readFileSync(caKey, 'utf8'), cert: forge.pki.certificateFromPem(certPem) },
        leaf: { certPem: fs.readFileSync(leafPem, 'utf8'), keyPem: fs.readFileSync(leafKey, 'utf8') },
        files: { caPem, caKey, caDer, leafPem, leafKey },
      };
    } catch (e) { /* 坏了就重生成 */ }
  }

  const ca = genCa();
  const leaf = genLeaf(ca, MITM_SUFFIX.map((s) => '*.' + s).concat(MITM_SUFFIX));
  fs.writeFileSync(caPem, ca.certPem);
  fs.writeFileSync(caKey, ca.keyPem);
  fs.writeFileSync(caDer, pemToDer(ca.certPem));
  fs.writeFileSync(leafPem, leaf.certPem);
  fs.writeFileSync(leafKey, leaf.keyPem);
  return { ca, leaf, files: { caPem, caKey, caDer, leafPem, leafKey } };
}

function sha1Hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').toUpperCase();
}

/**
 * 装根证书。两条路，按「打扰最小」优先：
 *   ① 当前用户存储（certutil -user）：不要管理员，但 Windows 会弹一次安全警告，必须点「是」
 *   ② 提权装到本机存储（UAC 一次）：①失败时兜底
 * @returns {{ok:boolean, scope?:'user'|'machine', error?:string}}
 */
async function installCa(derPath) {
  // 已经是管理员：直接装本机存储，Windows 不会弹安全警告（最省事的一条路）
  if (await isAdmin()) {
    const m = await run('certutil', ['-addstore', '-f', 'Root', derPath], { timeout: 90 * 1000 });
    if (m.ok) return { ok: true, scope: 'machine' };
  }

  const r = await run('certutil', ['-user', '-addstore', '-f', 'Root', derPath], { timeout: 120 * 1000 });
  if (r.ok) return { ok: true, scope: 'user' };

  const verifyUser = await run('certutil', ['-user', '-store', 'Root'], { timeout: 20000 });
  if (verifyUser.stdout.indexOf(CA_CN) >= 0) return { ok: true, scope: 'user' };

  // 兜底：提权装到本机（UAC 弹窗，用户点「是」）
  const ps = 'Start-Process -FilePath certutil.exe -ArgumentList \'-addstore\',\'-f\',\'Root\',\''
    + String(derPath).replace(/'/g, "''") + '\' -Verb RunAs -Wait -WindowStyle Hidden';
  const e = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 150 * 1000 });
  if (e.ok) return { ok: true, scope: 'machine' };

  const msg = (r.stderr || r.stdout || e.stderr || '').trim().slice(0, 260);
  if (r.timedOut) return { ok: false, error: '安装证书等待超时（Windows 安全警告框没有点「是」）' };
  return { ok: false, error: '安装根证书失败：' + (msg || 'certutil 返回非 0') };
}

/** 删除临时根证书（按指纹精确删，用户级 + 本机级都清一遍） */
async function removeCa(derPath, scope) {
  let thumb = '';
  try { thumb = sha1Hex(fs.readFileSync(derPath)); } catch (e) { thumb = ''; }
  const target = thumb || CA_CN;

  const tryDel = async (args) => run('certutil', args, { timeout: 30 * 1000 });

  await tryDel(['-user', '-delstore', 'Root', target]);
  if (scope === 'machine') {
    const ps = 'Start-Process -FilePath certutil.exe -ArgumentList \'-delstore\',\'Root\',\'' + target
      + '\' -Verb RunAs -Wait -WindowStyle Hidden';
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 120 * 1000 });
  }
  // 兜底：按名称再删一次（指纹删不到时 certutil 认 CN）
  const leftUser = await run('certutil', ['-user', '-store', 'Root'], { timeout: 20000 });
  if (leftUser.stdout.indexOf(CA_CN) >= 0) await tryDel(['-user', '-delstore', 'Root', CA_CN]);
  const leftAny = await run('certutil', ['-user', '-store', 'Root'], { timeout: 20000 });
  const stillUser = leftAny.stdout.indexOf(CA_CN) >= 0;
  return { ok: !stillUser, removed: !stillUser };
}

// ── 系统代理（HKCU，不需要管理员） ─────────────────────────
/** 读当前系统代理（HKCU，不需要管理员）；同时记下两个值原本是否存在，还原时才能原样回去 */
async function readProxy() {
  const out = { enable: 0, hasServer: false, server: '', hasOverride: false, override: '' };
  const script = [
    "$k = " + psq(REG_KEY_PS),
    '$p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue',
    'if ($null -eq $p) { "{}"; exit 0 }',
    '$n = $p.PSObject.Properties.Name',
    '$o = [ordered]@{',
    '  enable = [int]$p.ProxyEnable;',
    '  hasServer = ($n -contains "ProxyServer");',
    '  server = [string]$p.ProxyServer;',
    '  hasOverride = ($n -contains "ProxyOverride");',
    '  override = [string]$p.ProxyOverride',
    '}',
    '$o | ConvertTo-Json -Compress',
  ].join('\n');
  const r = await ps(script, 20000);
  if (!r.ok) return out;
  try {
    const line = String(r.stdout || '').trim().split(/\r?\n/).pop() || '{}';
    const j2 = JSON.parse(line);
    out.enable = Number(j2.enable) || 0;
    out.hasServer = !!j2.hasServer;
    out.server = String(j2.server || '');
    out.hasOverride = !!j2.hasOverride;
    out.override = String(j2.override || '');
  } catch (e) { /* 读失败按默认值兜底 */ }
  out.existed = out.hasServer || out.hasOverride || out.enable !== 0;
  return out;
}

/** 把系统代理指向本机端口（一次 PowerShell 调用写完，减少子进程开销）
 *  @param {string} keepOverride 该机器原有的绕过列表，合并进去而不是覆盖（别破坏公司内网等原有规则）
 */
async function pointProxyTo(port, keepOverride) {
  const merged = PROXY_BYPASS + (keepOverride ? ';' + String(keepOverride) : '');
  const script = [
    "$k = " + psq(REG_KEY_PS),
    'New-Item -Path $k -Force | Out-Null',
    'Set-ItemProperty -Path $k -Name ProxyEnable -Value 1 -Type DWord',
    'Set-ItemProperty -Path $k -Name ProxyServer -Value ' + psq('127.0.0.1:' + port) + ' -Type String',
    'Set-ItemProperty -Path $k -Name ProxyOverride -Value ' + psq(merged) + ' -Type String',
    '"ok"',
  ].join('\n');
  const r = await ps(script, 20000);
  return { ok: r.ok && /ok/.test(r.stdout), error: r.ok ? '' : String(r.stderr || '').slice(0, 200) };
}

/** 还原系统代理：原本有的值写回原值，原本没有的（ProxyServer / ProxyOverride）删掉 */
async function restoreProxy(saved) {
  if (!saved) return { ok: true };
  const lines = ["$k = " + psq(REG_KEY_PS)];
  lines.push('Set-ItemProperty -Path $k -Name ProxyEnable -Value ' + (Number(saved.enable) || 0) + ' -Type DWord');
  lines.push(saved.hasServer
    ? 'Set-ItemProperty -Path $k -Name ProxyServer -Value ' + psq(saved.server) + ' -Type String'
    : 'Remove-ItemProperty -Path $k -Name ProxyServer -ErrorAction SilentlyContinue');
  lines.push(saved.hasOverride
    ? 'Set-ItemProperty -Path $k -Name ProxyOverride -Value ' + psq(saved.override) + ' -Type String'
    : 'Remove-ItemProperty -Path $k -Name ProxyOverride -ErrorAction SilentlyContinue');
  lines.push('"ok"');
  const r = await ps(lines.join('\n'), 20000);
  return { ok: r.ok && /ok/.test(r.stdout) };
}

// ── 解析响应：找出 token ──────────────────────────────────
function decodeBody(buf, headers) {
  const enc = String((headers && headers['content-encoding']) || '').toLowerCase();
  try {
    if (enc.indexOf('br') >= 0) return zlib.brotliDecompressSync(buf);
    if (enc.indexOf('gzip') >= 0) return zlib.gunzipSync(buf);
    if (enc.indexOf('deflate') >= 0) return zlib.inflateSync(buf);
  } catch (e) { /* 原样返回 */ }
  return buf;
}

const TOKEN_KEY = /^(token|access_?token|authorization|auth_?token)$/i;
const STORE_KEY = /^(store_?id|storeId)$/i;
const APPID_KEY = /^(app_?id|appId)$/i;

function looksJwt(v) {
  const s = String(v || '').trim().replace(/^Bearer\s+/i, '');
  return s.length > 30 && s.split('.').length === 3;
}

/** 广度优先在 JSON 里找 token / storeId / appId，不递归无限深 */
function scanJson(root) {
  const found = { token: '', storeId: '', appId: '' };
  if (!root || typeof root !== 'object') return found;
  const queue = [root];
  let guard = 0;
  while (queue.length && guard < 2000) {
    guard += 1;
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (v && typeof v === 'object') { queue.push(v); continue; }
      if (!found.token && TOKEN_KEY.test(k) && looksJwt(v)) found.token = String(v).trim().replace(/^Bearer\s+/i, '');
      if (!found.storeId && STORE_KEY.test(k) && (typeof v === 'number' || typeof v === 'string') && String(v).trim()) {
        found.storeId = String(v).trim();
      }
      if (!found.appId && APPID_KEY.test(k) && typeof v === 'string' && /^wx[0-9a-f]{10,}$/i.test(v.trim())) {
        found.appId = v.trim();
      }
    }
  }
  return found;
}

function hostMatches(host) {
  const h = String(host || '').toLowerCase();
  return MITM_SUFFIX.some((s) => h === s || h.endsWith('.' + s));
}

// ── 会话状态 ──────────────────────────────────────────────
const state = {
  active: false,
  status: 'idle', // idle | starting | waiting | captured | timeout | error | cancelled
  port: null,
  startedAt: null,
  deadline: null,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  message: '',
  error: '',
  storeId: '',
  appId: '',
  mid: null,
  token: '',     // 只放内存，cleanup 时清空
  needElevate: false,
  hits: 0,
  seen: [],      // 最近抓到的请求（只记 host + path，不记请求头与 body）
  steps: [],     // 进度步骤，CLI 直接打印
};

let runtime = null; // { ca, files, savedProxy, timer, proxy, closing }
let onToken = null; // 抓到 Token 时的回调（由 index.js 注入：打印 + 复制剪贴板）

function pushStep(text, level) {
  state.steps.push({ at: Date.now(), text: String(text).slice(0, 200), level: level || 'info' });
  if (state.steps.length > 40) state.steps.shift();
}

function sessionFile() {
  return path.join(DIR, 'session.json');
}

function persistSession() {
  try {
    ensureDir();
    if (!runtime || !runtime.savedProxy) return;
    fs.writeFileSync(sessionFile(), JSON.stringify({
      savedProxy: runtime.savedProxy, port: state.port, startedAt: state.startedAt,
    }), 'utf8');
  } catch (e) { /* ignore */ }
}

function clearSessionFile() {
  rmQuiet(sessionFile());
}

/**
 * 进程重启时兜底：上次若在抓包状态下被强杀，系统代理会一直指着已消失的端口 → 全机断网。
 * 启动时读 session.json 把代理还原，并清掉残留证书与私钥文件。
 */
async function cleanupOnBoot() {
  try {
    if (!fs.existsSync(sessionFile())) return { ok: true, skipped: true };
    const j = JSON.parse(fs.readFileSync(sessionFile(), 'utf8') || '{}');
    if (j && j.savedProxy) {
      await restoreProxy(j.savedProxy);
      console.log('[afa-token] 已还原上次残留的系统代理设置');
    }
    clearSessionFile();
    // 顺带清掉上次残留的临时根证书：当前用户存储可直接删，本机存储需要管理员
    const stores = [
      { name: 'user', list: ['-user', '-store', 'Root'], del: ['-user', '-delstore', 'Root'] },
      { name: 'machine', list: ['-store', 'Root'], del: ['-delstore', 'Root'] },
    ];
    for (const st of stores) {
      const out = await run('certutil', st.list, { timeout: 20000 });
      for (const cn of [CA_CN, LEGACY_CA_CN]) {
        if (out.stdout.indexOf(cn) < 0) continue;
        if (st.name === 'user') {
          await run('certutil', st.del.concat([cn]), { timeout: 30000 });
          console.log('[afa-token] 已清理残留的临时根证书（' + cn + '）');
        } else {
          console.warn('[afa-token] 本机存储仍有残留证书，请用管理员执行：certutil -delstore Root "' + cn + '"');
        }
      }
    }
    rmQuiet(path.join(DIR, 'ca.pem'));
    rmQuiet(path.join(DIR, 'ca.key'));
    rmQuiet(path.join(DIR, 'ca.der'));
    rmQuiet(path.join(DIR, 'leaf.pem'));
    rmQuiet(path.join(DIR, 'leaf.key'));
    return { ok: true, restored: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ── 代理本体 ──────────────────────────────────────────────
/**
 * 创建代理 server（不 listen，由 server.js listen）。
 * @returns {{server:http.Server, close:Function}}
 */
function createProxyServer() {
  const leafPemPath = path.join(DIR, 'leaf.pem');
  const leafKeyPath = path.join(DIR, 'leaf.key');
  const leafCtx = tls.createSecureContext({
    cert: fs.readFileSync(leafPemPath, 'utf8'),
    key: fs.readFileSync(leafKeyPath, 'utf8'),
  });
  const hostCtx = new Map();

  // 内部 http 服务：只处理「已解密」的明文请求，转发到真实上游
  const inner = http.createServer((req, res) => {
    const host = req.socket._mitmHost;
    const port = req.socket._mitmPort || 443;
    if (!host) { res.writeHead(502); res.end('bad gateway'); return; }

    state.hits += 1;
    const pathPart = String(req.url || '');
    if (state.seen.length < 30) state.seen.push({ host, path: pathPart.slice(0, 160) });

    const reqChunks = [];
    let reqSize = 0;
    req.on('data', (c) => {
      if (reqSize < MAX_BODY) { reqChunks.push(c); reqSize += c.length; }
    });
    req.on('end', () => {
      const reqBody = Buffer.concat(reqChunks);
      const headers = Object.assign({}, req.headers);
      delete headers['proxy-connection'];

      let up;
      try {
        up = https.request({
          host, port, method: req.method, path: pathPart, headers,
          servername: host, ALPNProtocols: ['http/1.1'], timeout: 30000,
        });
      } catch (e) {
        res.writeHead(502); res.end('upstream init failed'); return;
      }

      up.on('response', (r) => {
        const respChunks = [];
        let respSize = 0;
        r.on('data', (c) => {
          if (respSize < MAX_BODY) { respChunks.push(c); respSize += c.length; }
        });
        r.on('end', () => {
          try {
            const raw = Buffer.concat(respChunks);
            const decoded = decodeBody(raw, r.headers);
            handleMaybeToken(host, pathPart, req.headers, decoded);
          } catch (e) { /* 解析失败不影响转发 */ }
        });
        try { res.writeHead(r.statusCode, r.headers); } catch (e) { res.writeHead(502); res.end(); return; }
        r.pipe(res);
      });
      up.on('error', () => {
        if (!res.headersSent) { try { res.writeHead(502); } catch (e) { /* ignore */ } }
        try { res.end(); } catch (e) { /* ignore */ }
      });
      up.setTimeout(30000, () => { try { up.destroy(); } catch (e) { /* ignore */ } });
      if (reqBody.length) up.write(reqBody);
      up.end();
    });
  });
  inner.on('clientError', (e, socket) => { try { socket.destroy(); } catch (x) { /* ignore */ } });

  // tls.Server 接管原始 socket，握手完成后把明文 socket 交给 inner
  const tlsSrv = tls.createServer({
    key: fs.readFileSync(leafKeyPath, 'utf8'),
    cert: fs.readFileSync(leafPemPath, 'utf8'),
    ALPNProtocols: ['http/1.1'],
    SNICallback: (servername, cb) => {
      const name = String(servername || '').toLowerCase();
      if (hostCtx.has(name)) return cb(null, hostCtx.get(name));
      try {
        if (!hostMatches(name)) return cb(null, leafCtx);
        const caPem = fs.readFileSync(path.join(DIR, 'ca.pem'), 'utf8');
        const caKey = fs.readFileSync(path.join(DIR, 'ca.key'), 'utf8');
        const ca = { certPem: caPem, keyPem: caKey, cert: forge.pki.certificateFromPem(caPem), keys: { privateKey: forge.pki.privateKeyFromPem(caKey) } };
        const lf = genLeaf(ca, [name]);
        const ctx = tls.createSecureContext({ cert: lf.certPem, key: lf.keyPem });
        hostCtx.set(name, ctx);
        return cb(null, ctx);
      } catch (e) {
        return cb(null, leafCtx);
      }
    },
  });
  tlsSrv.on('tlsClientError', () => { /* 客户端拒绝我们的证书时会报这里，属预期（未装 CA 的其它程序） */ });
  tlsSrv.on('secureConnection', (ts) => {
    const par = ts._parent || {};
    ts._mitmHost = ts.servername || par._mitmHost;
    ts._mitmPort = par._mitmPort || 443;
    inner.emit('connection', ts);
  });

  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('this is a CONNECT-only capture proxy');
  });

  const socks = new Set();
  server.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });

  server.on('connect', (req, clientSocket, head) => {
    const raw = String(req.url || '');
    const idx = raw.lastIndexOf(':');
    const host = idx > 0 ? raw.slice(0, idx) : raw;
    const port = idx > 0 ? Number(raw.slice(idx + 1)) || 443 : 443;

    if (!hostMatches(host)) {
      // 非目标域名：纯 TCP 隧道，不解密、不记录
      const up = net.connect(port, host, () => {
        try {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) up.write(head);
          up.pipe(clientSocket);
          clientSocket.pipe(up);
        } catch (e) { /* ignore */ }
      });
      up.on('error', () => { try { clientSocket.destroy(); } catch (e) { /* ignore */ } });
      clientSocket.on('error', () => { try { up.destroy(); } catch (e) { /* ignore */ } });
      return;
    }

    try {
      clientSocket._mitmHost = host;
      clientSocket._mitmPort = port;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.pause();
      if (head && head.length) clientSocket.unshift(head);
      tlsSrv.emit('connection', clientSocket);
    } catch (e) {
      try { clientSocket.destroy(); } catch (x) { /* ignore */ }
    }
  });

  return {
    server,
    close() {
      for (const s of socks) { try { s.destroy(); } catch (e) { /* ignore */ } }
      try { server.close(); } catch (e) { /* ignore */ }
      try { inner.close(); } catch (e) { /* ignore */ }
      try { tlsSrv.close(); } catch (e) { /* ignore */ }
    },
  };
}

/** 响应里若含 token，交给回调打印并收工 */
function handleMaybeToken(host, pathPart, headers, bodyBuf) {
  if (!state.active || state.status !== 'waiting') return;
  let json = null;
  try { json = JSON.parse(bodyBuf.toString('utf8')); } catch (e) { return; }
  const hit = scanJson(json);
  if (!hit.token) return;

  let appId = hit.appId;
  if (!appId) {
    const ref = String((headers && headers.referer) || '');
    const m = ref.match(/servicewechat\.com\/(wx[0-9a-f]+)/i);
    if (m) appId = m[1];
  }
  finishWithToken(hit.token, hit.storeId, appId, host + pathPart);
}

/** 抓到 Token：记状态 → 回调打印（不落库）→ 立即收尾 */
function finishWithToken(token, storeId, appId, from) {
  const sid = String(storeId || state.storeId || DEFAULT_STORE_ID).trim() || DEFAULT_STORE_ID;
  const aid = String(appId || state.appId || DEFAULT_APP_ID).trim() || DEFAULT_APP_ID;
  const info = { token, storeId: sid, appId: aid, mid: jwtMid(token), exp: jwtExp(token), from: String(from || '') };

  state.status = 'captured';
  state.token = token;
  state.storeId = sid;
  state.appId = aid;
  state.mid = info.mid;
  state.message = '已抓到 Token';
  pushStep('已抓到 Token（' + (from || 'login 响应') + '）', 'success');

  if (typeof onToken === 'function') {
    try { onToken(info); } catch (e) { /* 打印失败不影响收尾 */ }
  }
  // 抓到了就立刻收工：还原代理 → 停代理 → 删证书，避免影响全机联网
  setTimeout(() => { cleanup('saved').catch(() => {}); }, 400);
}

/** 解码 JWT payload（只取 mid / exp，不校验签名） */
function jwtPayload(token) {
  try {
    const b64 = String(token || '').replace(/^Bearer\s+/i, '').split('.')[1];
    if (!b64) return null;
    return JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) { return null; }
}

function jwtMid(token) {
  const p = jwtPayload(token);
  const mid = p && Number(p.mid);
  return mid || null;
}

function jwtExp(token) {
  const p = jwtPayload(token);
  const exp = p && Number(p.exp);
  return exp ? exp * 1000 : null;
}

/** 注入回调：抓到 token 时调用（index.js 用来打印） */
function setOnToken(fn) {
  onToken = typeof fn === 'function' ? fn : null;
}

// ── 生命周期 ──────────────────────────────────────────────
/**
 * 第一步：准备证书（生成 + 装进根证书存储）并记录系统代理原值。
 * @returns {{ok:boolean, error?:string, needConfirm?:boolean}}
 */
async function prepare() {
  if (!isWin()) return { ok: false, error: '该工具只支持 Windows' };
  if (state.active) return { ok: false, error: '已有一次抓包在进行中，请先等待或取消' };

  state.active = true;
  state.status = 'starting';
  state.startedAt = Date.now();
  state.message = '';
  state.error = '';
  state.hits = 0;
  state.seen = [];
  state.steps = [];
  state.token = '';
  state.mid = null;
  state.appId = '';

  pushStep('生成临时根证书');

  let built;
  try {
    built = ensureCaFiles();
  } catch (e) {
    state.active = false;
    state.status = 'error';
    state.error = '生成证书失败：' + String((e && e.message) || e).slice(0, 200);
    return { ok: false, error: state.error };
  }

  pushStep('安装临时根证书（会弹一次 Windows 安全警告，请点「是」）');
  const ins = await installCa(built.files.caDer);
  if (!ins.ok) {
    state.active = false;
    state.status = 'error';
    state.error = ins.error;
    pushStep(ins.error, 'error');
    rmQuiet(built.files.caKey);
    return { ok: false, error: ins.error };
  }
  pushStep('根证书已安装' + (ins.scope === 'machine' ? '（本机存储）' : '（当前用户存储）'), 'success');

  runtime = { ca: built.ca, files: built.files, savedProxy: null, timer: null, proxy: null, caScope: ins.scope };
  runtime.savedProxy = await readProxy();
  state.needElevate = false;
  return { ok: true };
}

/**
 * 第三步：把系统代理指向已 listen 的代理端口，开始等待。
 * @param {number} port 代理实际监听端口
 * @param {{close:Function}} proxy 代理句柄（cleanup 时关闭）
 */
async function activate(port, proxy) {
  if (!runtime) return { ok: false, error: '抓包尚未初始化' };
  runtime.proxy = proxy || null;
  state.port = port;
  const keepOverride = runtime.savedProxy && runtime.savedProxy.override;
  const px = await pointProxyTo(port, keepOverride);
  if (!px.ok) {
    pushStep('设置系统代理失败：' + (px.error || 'PowerShell 返回非 0'), 'error');
    return { ok: false, error: '设置系统代理失败：' + (px.error || '权限或安全策略拦截') };
  }
  persistSession();
  state.status = 'waiting';
  state.deadline = Date.now() + state.timeoutMs;
  pushStep('系统代理已指向 127.0.0.1:' + port + '，等待微信小程序发出登录请求');
  runtime.timer = setTimeout(() => {
    if (state.status === 'waiting') {
      state.status = 'timeout';
      state.error = '等待超时，没有抓到登录请求';
      pushStep('等待超时', 'error');
      cleanup('timeout').catch(() => {});
    }
  }, state.timeoutMs);
  if (runtime.timer.unref) runtime.timer.unref();
  return { ok: true, port, timeoutMs: state.timeoutMs };
}

/** 收尾：还原代理 → 关代理 → 删证书与私钥。幂等，任何异常都走到这里 */
async function cleanup(reason) {
  if (runtime && runtime.closing) return { ok: true, already: true };
  if (!runtime && state.status === 'idle') return { ok: true, already: true };
  if (runtime) runtime.closing = true;

  const finalStatus = state.status;
  pushStep('正在收尾（还原系统代理 / 停代理 / 删证书）');

  if (runtime) {
    if (runtime.timer) { try { clearTimeout(runtime.timer); } catch (e) { /* ignore */ } }
    try { if (runtime.proxy) runtime.proxy.close(); } catch (e) { /* ignore */ }
    try { if (runtime.savedProxy) await restoreProxy(runtime.savedProxy); } catch (e) { /* ignore */ }
    pushStep('系统代理已还原');
    try { await removeCa(runtime.files.caDer, runtime.caScope); } catch (e) { pushStep('删除证书失败：' + String((e && e.message) || e), 'warn'); }
    clearSessionFile();
    for (const f of ['ca.pem', 'ca.key', 'ca.der', 'leaf.pem', 'leaf.key']) rmQuiet(path.join(DIR, f));
    pushStep('临时根证书与私钥已删除');
  }

  if (state.status !== 'error' && state.status !== 'timeout') {
    state.status = reason === 'cancel' ? 'cancelled' : (state.status === 'captured' ? 'captured' : (reason || finalStatus));
  }
  state.active = false;
  state.port = null;
  state.deadline = null;
  state.token = ''; // Token 只在抓到时短暂存在内存，收尾即清
  runtime = null;
  return { ok: true };
}

function status() {
  return {
    active: state.active,
    status: state.status,
    port: state.port,
    remainSec: state.deadline ? Math.max(0, Math.round((state.deadline - Date.now()) / 1000)) : 0,
    timeoutSec: Math.round(state.timeoutMs / 1000),
    mid: state.mid,
    storeId: state.storeId,
    appId: state.appId,
    message: state.message,
    error: state.error,
    hits: state.hits,
    seen: state.seen.slice(-10),
    steps: state.steps.slice(-12),
  };
}

module.exports = {
  prepare, activate, cleanup, status, createProxyServer, cleanupOnBoot, setOnToken,
  installCa, removeCa, readProxy, restoreProxy, isAdmin,
  _internals: {
    scanJson, decodeBody, looksJwt, genCa, genLeaf, ensureCaFiles, hostMatches,
    jwtPayload, jwtMid, jwtExp, DIR, CA_CN, LEGACY_CA_CN, DEFAULT_STORE_ID, DEFAULT_APP_ID,
  },
};
