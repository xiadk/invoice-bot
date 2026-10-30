/**
 * electron/main.js — 「催收小助手」桌面程序主进程
 *
 * 职责：
 *   · 单实例锁 + 自定义协议 xsh://（深链：网站点「批量发送」可唤醒本程序）
 *   · 托盘常驻（显示连接状态）
 *   · 状态小窗口（连接状态 / 1688 登录态 / 发送进度 / 停止）
 *   · 驱动 AgentClient（WS 长连接）+ 发送内核（agent/sender.js）
 *
 * 安全红线：
 *   · 不采集、不保存任何 1688 凭据（账号密码/Cookie 一律不碰）
 *   · 1688 窗口 nodeIntegration:false + contextIsolation:true + sandbox:true
 *   · 除「连接你自己的服务器」外不发起任何网络请求
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, nativeTheme, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const { createStore } = require('./store');
const { AgentClient } = require('./agent/ws-client');
const sender = require('./agent/sender');
const orderExport = require('./agent/order-export');
const qnhLogin = require('./agent/qnh-login');
const pddLogin = require('./agent/pdd-login');
const aliLogin = require('./agent/ali-login');
const pddApply = require('./agent/pdd-apply');
const pddSend = require('./agent/pdd-send');
const sdc = require('./agent/sdc');
const logoutKernel = require('./agent/logout');

// 隐藏自动化特征（navigator.webdriver=false），降低 1688 风控识别 Electron 的概率。
// 必须在 app ready 前调用，渲染进程启动后即失效。
try { app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled'); } catch (e) { /* 忽略 */ }

const PROTOCOL = 'xsh';
const VERSION = (() => { try { return require('../package.json').version; } catch (e) { return '0.1.0'; } })();
// 品牌图标：必须放在 electron/ 下才会被 electron-builder 打进 asar（顶层 assets/ 不在打包清单里）
const ASSETS = path.join(__dirname, 'assets');
const APP_ICON = path.join(ASSETS, 'app-icon-mascot.ico');

// 程序已改名「催收小助手」，Electron 默认的 userData 目录会跟着产品名走
// （%APPDATA%\催收小助手），老用户升级上来会丢掉设备令牌和本机登录态 ——
// 表现就是「又让我重新绑定、拼多多/牵牛花还要重扫一遍」。
// 所以：老目录在就继续用它（升级不搬数据）；新装的机器才用新目录。
try {
  const appData = app.getPath('appData');
  const legacyDir = path.join(appData, '1688催收助手');
  if (fs.existsSync(legacyDir)) app.setPath('userData', legacyDir);
} catch (e) { /* 拿不到路径就用默认目录，不影响启动 */ }

let store = null;
let client = null;
let tray = null;
let statusWin = null;
let quitting = false;
let bindError = '';   // 最近一次绑定失败的原因（展示给用户，别让他干等）

// 深链可能赶在 app ready / store 初始化之前到达（用户在看板点「绑定本机助手」，
// 而助手正被唤起、还在启动中）——那时 store 还是 null，直接处理会抛异常把这次绑定丢掉，
// 用户看到的就是「一直绑定不到，退出重进才好」。故先入队，等就绪后再统一处理。
const pendingLinks = [];
let appReady = false;

function enqueueLink(link) {
  if (!link) return false;
  if (!appReady) { pendingLinks.push(link); return true; }
  handleDeepLink(link).catch((e) => log('深链处理失败: ' + e.message));
  return true;
}

// ── 单实例：第二次启动（多半来自深链）→ 交给已运行实例处理 ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    enqueueLink(extractLink(argv));
    if (appReady) showStatusWin();   // 未就绪时别碰窗口与本地存储
  });
}

// ── 工具 ──
function log(msg) { console.log('[xsh] ' + msg); }
function extractLink(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(PROTOCOL + '://')) || null;
}
async function postJson(url, obj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj || {}),
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, body };
}
function hasTray() { return !!tray && !tray.isDestroyed(); }

// ── 退出本机登录态 ───────────────────────────────────────────────
// 各站点登录窗口用的 Electron 持久分区（与 agent/*.js 里的 PARTITION 一一对应）。
// 看板点「退出账号」时服务器会下发 logout 指令，把这里的分区一起清掉 ——
// 否则库里删了 Cookie、用户本机还留着，下次点「登录」会直接免登录进去（换号换不了）。
const LOGOUT_WINDOWS = {
  pdd: [() => pddLogin.peekWindow(), () => pddApply.peekWindow(), () => pddSend.peekWindow()],
  qnh: [() => qnhLogin.peekWindow()],
  // 1688 的发送窗没有 peek（getSendWindow 会懒创建），直接调 closeSendWindow 关掉；
  // 登录窗（ali-login 内核）有自己的 peek
  1688: [() => { try { sender.closeSendWindow(); } catch (e) { /* 忽略 */ } return null; }, () => aliLogin.peekWindow()],
  // 闪电帮帮：登录窗口 + 承载页内请求的后台窗口 + 客服会话窗口
  sdc: [() => sdc.peekWindow(), () => sdc.peekApiWindow(), () => sdc.peekChatWindow()],
};

/**
 * 清掉某个站点在本机的登录态（面板按钮与服务器指令共用）。
 * @param {string} target pdd / qnh / 1688
 */
async function doLocalLogout(target) {
  // 任务进行中不动手：清登录态要关掉该站点的窗口，会把正在跑的发送/申请/登录打断
  const busy = client && client.busy ? client.busy() : { any: false };
  if (busy.any) {
    return {
      ok: false,
      error: '助手正在执行任务（' + (busy.sending ? '发送催收消息'
        : (busy.pdd ? '拼多多任务' : (busy.qnh ? '牵牛花任务' : '闪电帮帮任务')))
        + '），请等任务结束后再退出登录态',
    };
  }
  const key = logoutKernel.normalizeTarget(target);
  const r = await logoutKernel.clearLoginState(key, { windows: LOGOUT_WINDOWS[key] || [] });
  // 1688 的登录态是助手自己上报的：清完顺手置为未登录，看板右上角立刻变
  if (r.ok && key === '1688' && client) client.reportLoginState(false, '');
  log(r.ok
    ? `已退出本机${r.label}账号（关窗 ${r.closedWindows} 个）`
    : `退出本机账号失败（${r.label || target}）：${r.error || ('仍有 ' + r.remain + ' 个 Cookie')}`);
  refreshTray();
  pushState();
  return r;
}

/** 各站点在本机的登录态（Cookie 数量），供状态面板显示「本机还有没有登录态」 */
async function localLoginStates() {
  const out = {};
  for (const key of Object.keys(logoutKernel.TARGETS)) {
    const t = logoutKernel.TARGETS[key];
    let n = -1;
    try { n = (await session.fromPartition(t.partition).cookies.get({})).length; } catch (e) { n = -1; }
    out[key] = { label: t.label, cookies: n, loggedIn: n > 0 };
  }
  return out;
}

// ── 状态窗口 ──
function showStatusWin() {
  if (statusWin && !statusWin.isDestroyed()) { statusWin.show(); statusWin.focus(); return; }
  statusWin = new BrowserWindow({
    width: 460, height: 620, resizable: false, title: '催收小助手',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8', // 立即绘制底色，避免启动/加载时闪白
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
  });
  statusWin.loadFile(path.join(__dirname, 'ui', 'agent.html'));
  statusWin.on('closed', () => { statusWin = null; });
  statusWin.webContents.on('did-finish-load', () => { pushState(); pushUpdate(); });
}

function pushState() {
  if (!statusWin || statusWin.isDestroyed()) return;
  const s = client ? client.state() : { connected: false, ready: false, sending: false, loggedIn: false };
  statusWin.webContents.send('agent:state', {
    ...s,
    version: VERSION,
    deviceName: (store && store.get('deviceName')) || os.hostname(),
    serverUrl: (store && store.get('serverUrl')) || '',
    bound: !!(store && store.isBound()),
    bindError: bindError || '',
    sendState: sender.state ? sender.state() : null,
    dataDir: app.getPath('userData'),
  });
}

/** 本地存储是不是已经可写（未就绪时一律当作「未绑定」，不报错） */
function bound() { return !!(store && store.isBound()); }

function refreshTray() {
  if (!hasTray()) return;
  const s = client ? client.state() : {};
  const online = !!s.ready;
  tray.setToolTip('催收小助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: online ? '状态：已连接' : (bound() ? '状态：未连接（重连中）' : '状态：未绑定'), enabled: false },
    { label: s.sending ? '正在发送…' : '空闲', enabled: false },
    { type: 'separator' },
    { label: '打开状态面板', click: () => showStatusWin() },
    { label: '打开 牵牛花 登录窗口', click: () => qnhLogin.openLogin() },
  { label: '打开 拼多多 登录窗口', click: () => pddLogin.openLogin() },
  { label: '打开 闪电帮帮 登录窗口', click: () => sdc.openLogin() },
    { type: 'separator' },
    ...(updater.info ? [{ label: `⚠ 安装助手更新 v${updater.info.latest || ''}`, click: () => { showStatusWin(); doSelfUpdate(); } }] : []),
    { label: '开机自启', type: 'checkbox', checked: !!store.get('autoStart'), click: (mi) => setAutoStart(mi.checked) },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  try {
    const icon = online ? trayIcon('color') : trayIcon('grey');
    if (icon) tray.setImage(icon);
  } catch (e) { /* 图标缺失时忽略 */ }
}

/** 托盘图标：必须是位图 PNG（矢量不适用）。透明底单色剪影随系统深浅主题切换：
 *  深色任务栏用白狗（tray-on-dark-*），浅色用墨蓝狗（tray-on-light-*）。
 *  kind：'color'=已连接（吊牌品牌橙），'grey'=未连接（整体灰化）。 */
function trayIcon(kind) {
  if (trayIcon._cache === undefined) trayIcon._cache = {};
  const dark = !!nativeTheme.shouldUseDarkColors;
  const key = (dark ? 'dark' : 'light') + '-' + kind;
  if (trayIcon._cache[key]) return trayIcon._cache[key];
  const state = kind === 'color' ? 'on' : 'off';
  const file = path.join(ASSETS, `tray-on-${dark ? 'dark' : 'light'}-${state}.png`);
  const file16 = path.join(ASSETS, `tray-on-${dark ? 'dark' : 'light'}-${state}-16.png`);
  let img = nativeImage.createFromPath(file);
  // 32px 主尺寸 + 16px 表示，避免任务栏自行缩放发糊
  if (!img.isEmpty()) {
    const im16 = nativeImage.createFromPath(file16);
    if (!im16.isEmpty()) img.addRepresentation({ scaleFactor: 0.5, buffer: im16.toPNG() });
  }
  // 文件缺失/损坏时再退一次，不让整个托盘创建失败
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(ASSETS, 'tray-grey.png'));
  trayIcon._cache[key] = img;
  return img;
}

function setAutoStart(on) {
  store.set({ autoStart: !!on });
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: [] });
  } catch (e) { log('设置开机自启失败: ' + e.message); }
}

// ── 助手主体 ──
/**
 * 确保长连接存在：已绑定才连；已有连接则用新凭证重连（绑定/换绑后调用）。
 * 幂等——绑定深链可能被重复触发（用户点了不止一次），重复调用不会连出两个客户端。
 */
function ensureClient() {
  if (!store) return false;
  const serverUrl = store.get('serverUrl');
  const deviceToken = store.get('deviceToken');
  if (!serverUrl || !deviceToken) { log('尚未绑定，等待网站「绑定本机助手」深链'); return false; }
  if (client) {
    // 凭证变了才重连；凭证没变说明已经连着，别把好端端的连接切断
    if (client.serverUrl !== serverUrl || client.deviceToken !== deviceToken) {
      client.rebind({ serverUrl, deviceToken });
    }
    return true;
  }
  startAgent();
  return true;
}

function startAgent() {
  const serverUrl = store && store.get('serverUrl');
  const deviceToken = store && store.get('deviceToken');
  if (!serverUrl || !deviceToken) { log('尚未绑定，等待网站「绑定本机助手」深链'); pushState(); return; }
  if (client) return;
  client = new AgentClient({
    serverUrl, deviceToken, version: VERSION, os: `${process.platform}-${os.arch()}`,
    log: (m) => log(m),
  });
  // 发送内核（内置浏览器驱动 1688）
  client.setBatchHandler(sender.createBatchHandler({
    getWindow: () => sender.getSendWindow(),
    log: (m) => { log(m); pushState(); },
    onLoginState: (v, url) => client.reportLoginState(v, url),
  }));
  // 「导入1688订单数据」内核：在同一 1688 分区里按条件导出报表并回传服务器
  client.setExportHandler((m, api) => orderExport.runExport(m, api, {
    serverUrl: store.get('serverUrl'),
    deviceToken: store.get('deviceToken'),
  }));
  // 「登录牵牛花」内核：服务器（云端）没有显示器与浏览器，登录只在本机完成，
  // 助手弹窗让用户登录 → 把牵牛花的 Cookie 回传服务器（服务器只负责调用接口拉退单）。
  client.setQnhLoginHandler(qnhLogin.createLoginHandler({
    log: (m) => { log(m); pushState(); },
  }));
  // 「牵牛花页内签名请求」内核：配送日志 / 订单毛利明细等接口要求 mtgsig 签名，
  // 服务器直连 403，只有真实页面环境里的 fetch 能自动带上——这个环境只有本机有。
  client.setQnhFetchHandler(qnhLogin.createFetchHandler({
    log: (m) => { log(m); pushState(); },
  }));
  // 「登录拼多多」内核：与牵牛花同一套路（服务器没有浏览器，登录只在本机完成），
  // 差别是走手机端 H5，回传的是一整条 Cookie 串（服务器直接放进请求头拉发票订单）。
  client.setPddLoginHandler(pddLogin.createLoginHandler({
    log: (m) => { log(m); pushState(); },
  }));
  // 「登录1688」内核：同一套路，桌面窗口 + persist:1688 分区（与发消息内核共用登录态），
  // 回传的 Cookie 串由服务器写进 data/ali-cookie.txt（mtop 直连取数用的就是它）。
  client.setAliLoginHandler(aliLogin.createLoginHandler({
    log: (m) => { log(m); pushState(); },
  }));
  // 「拼多多批量申请发票」内核：加载真实开票页逐单提交，anti-content 由页面自己生成。
  client.setPddApplyHandler(pddApply.createApplyHandler({
    log: (m) => { log(m); pushState(); },
  }));
  // 「拼多多催商家开票」内核：加载真实聊天页逐单发消息，anti-content 由页面自己生成。
  client.setPddSendHandler(pddSend.createSendHandler({
    log: (m) => { log(m); pushState(); },
  }));
  // 「闪电帮帮」三个内核：该站点网关要求 mtgsig 签名，服务器直连一律 403，
  // 所以登录、拉订单、发催收消息全部在本机真实页面里做（页内 fetch 会被风控 SDK 自动签名）。
  client.setSdcLoginHandler(sdc.createLoginHandler({
    log: (m) => { log(m); pushState(); },
  }));
  client.setSdcFetchHandler(sdc.createFetchHandler({
    log: (m) => { log(m); pushState(); },
  }));
  client.setSdcSendHandler(sdc.createSendHandler({
    log: (m) => { log(m); pushState(); },
  }));
  // 「清除本机登录态」内核：看板点「退出拼多多 / 退出牵牛花账号」时，
  // 服务器删库里的 Cookie 之后还要把本机分区里的 Cookie 一起清掉。
  client.setLogoutHandler(logoutKernel.createLogoutHandler({
    log: (m) => { log(m); pushState(); },
    windows: LOGOUT_WINDOWS,
  }));
  client.on('ready', () => { log('已连接服务器'); refreshTray(); pushState(); });
  client.on('connected', () => { refreshTray(); pushState(); });
  client.on('disconnected', (info) => { log(`连接断开 (${info && info.code})，稍后重连`); refreshTray(); pushState(); });
  client.on('state', () => { refreshTray(); pushState(); });
  client.on('progress', () => pushState());
  // 服务端体检结论：本版本过旧 → 记下来给面板弹更新横幅
  client.on('require_update', (m) => {
    updater.info = m || null;
    updater.phase = 'idle';
    updater.percent = 0;
    updater.message = '';
    updater.error = '';
    log(`⚠ 助手版本过旧（当前 v${VERSION}，需要 v${(m && m.latest) || '?'}）：请更新`);
    refreshTray();
    pushUpdate();
  });
  client.start();
}

// ── 深链处理 ──
async function handleDeepLink(link) {
  let u = null;
  try { u = new URL(link); } catch (e) { log('无法解析深链: ' + link); return; }
  // 自定义协议下 host 即动作名：xsh://bind?... / xsh://run
  const action = String(u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  log('深链: ' + action);

  if (action === 'bind') {
    // 绑定令牌可能过期（用户在看板点了一次却迟迟没唤起助手）。
    // 这时不能干等着——把结果写进状态，界面上直接告诉用户「回看板再点一次」。
    const server = (u.searchParams.get('server') || (store ? store.get('serverUrl') : '') || '').replace(/\/+$/, '');
    const t = u.searchParams.get('t') || '';
    if (!server || !t) { log('绑定深链缺少 server 或 t'); showStatusWin(); return; }
    const r = await postJson(server + '/api/agent/bind', {
      bindToken: t, deviceName: os.hostname(), os: `${process.platform}-${os.arch()}`, agentVer: VERSION, kind: 'agent',
    });
    if (r.status !== 200 || !r.body || !r.body.deviceToken) {
      const err = (r.body && r.body.error) || ('HTTP ' + r.status);
      log('绑定失败: ' + err);
      bindError = err;
      showStatusWin();
      return;
    }
    if (!store) { log('本地存储尚未就绪，绑定延后处理'); pendingLinks.push(link); return; }
    store.setBinding({
      deviceToken: r.body.deviceToken,
      serverUrl: r.body.serverUrl || server,
      deviceId: r.body.deviceId,
      userId: r.body.userId,
    });
    bindError = '';
    log('绑定成功（deviceId=' + r.body.deviceId + '）');
    ensureClient();          // 幂等：重复的绑定深链只会刷新凭证，不会连出第二个客户端
    refreshTray();
    showStatusWin();
    return;
  }

  if (action === 'run') {
    // 网站点「批量发送」但助手没在跑 → 拉起并连上；绑定信息用本地已存的
    if (!bound()) { log('尚未绑定，无法直接运行'); showStatusWin(); return; }
    ensureClient();
    refreshTray();
    pushState();
    return;
  }

  log('未知深链动作: ' + action);
  showStatusWin();
}

// ── 生命周期 ──
app.on('window-all-closed', (e) => { /* 托盘常驻：不随窗口关闭退出 */ });
app.on('before-quit', () => { quitting = true; try { sender.closeSendWindow(); } catch (e) {} });

app.whenReady().then(() => {
  store = createStore(app.getPath('userData'));

  // 启动提速：界面最先出。窗口带底色立即绘制（不等 HTML 加载完才不闪白），
  // 其余初始化（托盘/协议注册/连服务器）全部排到窗口之后，避免挤占首帧。
  showStatusWin();

  // 托盘
  try {
    tray = new Tray(trayIcon('grey'));
    tray.on('click', () => showStatusWin());
    refreshTray();
  } catch (e) { log('创建托盘失败: ' + e.message); }

  // 系统深浅主题切换时重建托盘图标（白狗/墨蓝狗互换）
  try {
    nativeTheme.on('updated', () => {
      try { refreshTray(); } catch (e) { /* 忽略 */ }
    });
  } catch (e) { /* 旧版 Electron 无此事件则跳过 */ }

  // 注册自定义协议（Windows 写 HKCU\Software\Classes\xsh，无需管理员；卸载时由安装器清理）
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
    log('已注册协议 ' + PROTOCOL + '://');
  } catch (e) { log('注册协议失败: ' + e.message); }

  // 冷启动时进程参数里可能就带着深链（xsh://bind…），唤醒时排队的那批也在这里一起消化。
  // 放在窗口首帧之后，保证界面先出来。
  setImmediate(async () => {
    appReady = true;
    const coldLink = extractLink(process.argv);
    const queued = pendingLinks.splice(0, pendingLinks.length);
    const links = (coldLink ? [coldLink] : []).concat(queued);
    if (links.length) {
      for (const lk of links) await handleDeepLink(lk).catch((e) => log('深链处理失败: ' + e.message));
    } else {
      startAgent();
    }
    refreshTray();
    pushState();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 版本更新（0.2.27 起）
//
// 服务端在握手时会顺手做一次体检：版本低于「最低要求」就推一条 require_update，
// 这里负责后面这一段：面板弹红色横幅 → 用户点「立即更新」→ 下载到临时目录 →
// 拉起 NSIS 安装程序 → 退出本进程。
//
// 刻意**不做静默自替换**：换一个正在运行的 exe 容易被杀软拦下来，便携版也覆盖不干净。
// 让用户走一遍安装向导反而最省事：它会沿用原安装目录、装完还会自动把新版拉起来。
// ═══════════════════════════════════════════════════════════════════════════
const updater = { info: null, phase: 'idle', percent: 0, message: '', error: '', file: '' };

function pushUpdate() {
  if (!statusWin || statusWin.isDestroyed()) return;
  try {
    statusWin.webContents.send('agent:update', {
      ...updater,
      currentVersion: VERSION,
      latestVersion: (updater.info && updater.info.latest) || '',
      blocking: !!(updater.info && updater.info.blocking),
    });
  } catch (e) { /* 窗口已销毁 */ }
}

/** 服务端给的可能是相对路径 /api/agent/download-exe，也可能是外部直链 */
function updateUrlAbsolute(u) {
  const s = String(u || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  const base = String((store && store.get('serverUrl')) || '').replace(/\/+$/, '');
  if (!base) return '';
  return base + (s.startsWith('/') ? s : '/' + s);
}

function updateFileName(msg) {
  const named = String((msg && msg.fileName) || '').trim();
  if (named) return named;
  return `催收小助手-Setup-${(msg && msg.latest) || 'latest'}.exe`;
}

// 换个文件名：同名旧包可能正被上一次的安装程序占着，删不掉就别硬覆盖
function uniqueInstallerPath(dest) {
  return dest.replace(/\.exe$/i, '') + '-' + Date.now() + '.exe';
}

/**
 * 下载安装包（跟随 3xx；流式写盘，实时回调百分比）
 *
 * 两个坑：
 *   ① 等 writeStream 的 **'close'**（句柄真正关闭）再交接。'finish' 只保证数据写完，
 *      fd 是否已释放并没有承诺；交给系统执行时一旦撞上共享冲突，连重试的机会都没有。
 *   ② 先写 .part 再改名：中途断了，临时目录里不会留半截 exe 被误执行；同名旧包
 *      正被上一次的安装程序占着时，改用带时间戳的新名字，绝不硬覆盖。
 *
 * 真正让 Windows 弹「另一程序正在使用此文件」的，多半是包刚落地那几秒：
 * Defender 首次扫描 / 索引器还攥着这个 80MB 的 exe（实测锁住约 1.5 秒后自动放行），
 * 所以「拉起」这一步必须带重试，而不是打开一次就认定成功。
 */
function downloadInstaller(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = /^https:/i.test(url) ? require('https') : require('http');
    const req = mod.get(url, { timeout: 20000 }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        let next = '';
        try { next = new URL(res.headers.location, url).href; } catch (e) { next = ''; }
        if (!next) { reject(new Error('下载失败：重定向地址无效')); return; }
        downloadInstaller(next, dest, onProgress).then(resolve, reject);
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error('下载失败：HTTP ' + code)); return; }

      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

      const part = dest + '.part';
      try { fs.unlinkSync(part); } catch (e) { /* 残留的半截文件，没有更正常 */ }
      const ws = fs.createWriteStream(part);
      ws.on('error', (e) => done(reject, e));
      res.on('error', (e) => { try { ws.destroy(); } catch (er) { /* 忽略 */ } done(reject, e); });
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          onProgress(Math.min(99, Math.floor((got / total) * 100)),
            `已下载 ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
        }
      });
      // 'close' = 句柄已释放，此时才敢把文件交出去
      ws.on('close', () => {
        if (settled) return;
        if (total && got !== total) { done(reject, new Error(`安装包不完整：${got}/${total} 字节`)); return; }
        try {
          let final = dest;
          try { if (fs.existsSync(final)) fs.unlinkSync(final); }
          catch (e) { final = uniqueInstallerPath(dest); }
          fs.renameSync(part, final);
          onProgress(100, '下载完成，正在打开安装程序…');
          done(resolve, final);
        } catch (e) {
          try { fs.unlinkSync(part); } catch (er) { /* 忽略 */ }
          done(reject, new Error('安装包写入失败：' + e.message));
        }
      });
      res.pipe(ws);
    });
    req.on('timeout', () => { try { req.destroy(new Error('下载超时（20 秒无响应）')); } catch (e) { /* 忽略 */ } });
    req.on('error', reject);
  });
}

/**
 * 打开安装程序。
 *
 * 不用 shell.openPath：它走 ShellExecute，文件被占用时 Windows 会自己弹一个
 * 「另一程序正在使用此文件」的模态框（还会盖住自己的界面），而且我们拿不到可判定的错误。
 * 改用 spawn —— 失败只会得到 error 事件（EBUSY/EPERM/EACCES），可以静默重试。
 *
 * 为什么会被占用：80MB 的 exe 刚落地，Defender 的首次扫描 / 索引器会短暂持有它。
 * 所以这里退避重试约 10 秒，而不是让用户看到一个吓人的报错。
 */
function trySpawn(file) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, [], { detached: true, stdio: 'ignore' });
    } catch (e) {
      // 注意：Node 22 在 EBUSY 时是**同步抛出**的，不会走 'error' 事件。
      // 不接住的话主进程直接崩，比原来的弹框还糟。
      resolve(e.code || e.message || 'unknown');
      return;
    }
    let settled = false;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      resolve(e.code || e.message || 'unknown');
    });
    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch (e) { /* 忽略 */ }
      resolve('');
    });
  });
}

async function openInstaller(file) {
  let lastErr = '';
  for (let i = 0; i < 10; i++) {
    // 首次等待久一点，给杀软扫完；之后逐步拉长
    await new Promise((r) => setTimeout(r, i === 0 ? 800 : 400 * i));
    const err = await trySpawn(file);
    if (!err) {
      log('✓ 安装程序已拉起（第 ' + (i + 1) + ' 次尝试）');
      return '';
    }
    lastErr = err;
    log('⚠ 拉起安装程序失败（第 ' + (i + 1) + ' 次）：' + err);
  }
  return lastErr;
}

/** 面板「立即更新」按钮 */
async function doSelfUpdate() {
  if (!updater.info) return { ok: false, error: '当前没有可用的更新信息' };
  if (updater.phase === 'downloading') return { ok: false, error: '正在下载中，请稍候' };
  const url = updateUrlAbsolute(updater.info.updateUrl);
  if (!url) {
    updater.phase = 'error';
    updater.error = '没有可用的下载地址（服务器未提供安装包，也没配外部直链），请联系管理员获取新版';
    pushUpdate();
    return { ok: false, error: updater.error };
  }
  try {
    updater.phase = 'downloading';
    updater.percent = 0;
    updater.message = '正在连接服务器…';
    updater.error = '';
    pushUpdate();
    const dest = await downloadInstaller(
      url, path.join(app.getPath('temp'), updateFileName(updater.info)),
      (percent, message) => {
        updater.percent = percent;
        updater.message = message;
        pushUpdate();
      });
    updater.file = dest;
    updater.percent = 100;
    updater.message = '下载完成，正在打开安装程序…';
    pushUpdate();
    log('✓ 更新包已就绪：' + dest);
    const err = await openInstaller(dest);
    if (err) {
      updater.phase = 'error';
      updater.error = '打开安装程序失败：' + err + '（可手动到 ' + dest + ' 安装）';
      log('✗ ' + updater.error);
      pushUpdate();
      return { ok: false, error: updater.error, file: dest };
    }
    // 打开成功后才切到「安装中」，避免没拉起来却告诉用户已经打开了
    updater.phase = 'installing';
    updater.message = '安装程序已打开：按向导一路下一步，装完会自动拉开新版助手';
    pushUpdate();
    // 让安装向导先拉起来，再退出自己 —— 否则 NSIS 会弹「程序正在运行，要关闭吗」
    setTimeout(() => { quitting = true; try { app.quit(); } catch (e) { /* 忽略 */ } }, 1500);
    return { ok: true, file: dest };
  } catch (e) {
    updater.phase = 'error';
    updater.error = (e && e.message) ? e.message : String(e);
    log('✗ 助手更新失败：' + updater.error);
    pushUpdate();
    return { ok: false, error: updater.error };
  }
}

// ── IPC（状态窗 → 主进程）──
ipcMain.handle('agent:getState', () => {
  const s = client ? client.state() : { connected: false, ready: false, sending: false, loggedIn: false };
  return {
    ...s,
    version: VERSION,
    deviceName: (store && store.get('deviceName')) || os.hostname(),
    serverUrl: (store && store.get('serverUrl')) || '',
    bound: bound(),
    bindError: bindError || '',
    dataDir: app.getPath('userData'),
  };
});
/** 面板「退出」按钮：只退出本机浏览器分区里的登录态，不动服务器上的数据 */
ipcMain.handle('agent:logout', async (_e, target) => doLocalLogout(target));
ipcMain.handle('agent:localState', () => localLoginStates());
/** 更新状态（面板首次加载/刷新时用；后续变化由 agent:update 推送） */
ipcMain.handle('agent:updateState', () => ({
  ...updater,
  currentVersion: VERSION,
  latestVersion: (updater.info && updater.info.latest) || '',
  blocking: !!(updater.info && updater.info.blocking),
}));
ipcMain.handle('agent:update', () => doSelfUpdate());
ipcMain.handle('agent:stopTask', () => {
  if (client) { client.stopFlag = true; if (client.currentTaskId != null) client.send({ type: 'client_stop', taskId: client.currentTaskId }); }
  return true;
});
ipcMain.handle('agent:openDataDir', () => { shell.openPath(app.getPath('userData')); return true; });
ipcMain.handle('agent:unbind', () => {
  if (!store) return true;
  bindError = '';
  store.clearBinding();
  if (client) { client.stop(); client = null; }
  refreshTray(); pushState();
  return true;
});
ipcMain.handle('agent:quit', () => { quitting = true; app.quit(); return true; });
