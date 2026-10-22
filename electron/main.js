/**
 * electron/main.js — 「1688 催收助手」桌面程序主进程
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
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createStore } = require('./store');
const { AgentClient } = require('./agent/ws-client');
const sender = require('./agent/sender');
const orderExport = require('./agent/order-export');
const qnhLogin = require('./agent/qnh-login');

// 隐藏自动化特征（navigator.webdriver=false），降低 1688 风控识别 Electron 的概率。
// 必须在 app ready 前调用，渲染进程启动后即失效。
try { app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled'); } catch (e) { /* 忽略 */ }

const PROTOCOL = 'xsh';
const VERSION = (() => { try { return require('../package.json').version; } catch (e) { return '0.1.0'; } })();

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

// ── 状态窗口 ──
function showStatusWin() {
  if (statusWin && !statusWin.isDestroyed()) { statusWin.show(); statusWin.focus(); return; }
  statusWin = new BrowserWindow({
    width: 460, height: 620, resizable: false, title: '1688 催收助手',
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8', // 立即绘制底色，避免启动/加载时闪白
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
  });
  statusWin.loadFile(path.join(__dirname, 'ui', 'agent.html'));
  statusWin.on('closed', () => { statusWin = null; });
  statusWin.webContents.on('did-finish-load', () => pushState());
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
  tray.setToolTip('1688 催收助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: online ? '状态：已连接' : (bound() ? '状态：未连接（重连中）' : '状态：未绑定'), enabled: false },
    { label: s.sending ? '正在发送…' : '空闲', enabled: false },
    { type: 'separator' },
    { label: '打开状态面板', click: () => showStatusWin() },
    { label: '打开 1688 登录窗口', click: () => openLogin() },
    { label: '打开 牵牛花 登录窗口', click: () => qnhLogin.openLogin() },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: !!store.get('autoStart'), click: (mi) => setAutoStart(mi.checked) },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  try {
    const icon = online ? trayIcon('green') : trayIcon('grey');
    if (icon) tray.setImage(icon);
  } catch (e) { /* 图标缺失时忽略 */ }
}

/**
 * 托盘图标：必须是位图（PNG）。此前用 SVG data URL —— nativeImage 不支持 SVG，
 * createFromDataURL 返回空图像，托盘显示为一块白板（用户截图证实）。
 * 这里内嵌代码生成的 PNG（绿色=已连接，灰色=未连接），16x16 + 32x32 两档适配高分屏。
 */
const TRAY_PNG = {
  green: {
    1: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaklEQVR42mPQqzViwIPZoBinGmyCGnq1RpP1ao3u6dUa/Yfie1AxDUIG5CNpwoXzcRlAjGYMQ5Cd/Z9ErIFswGQyDJiMbMA9Mgy4BzOAjQzNMMxGFQMo9gJVApHiaKQ4IVElKVMlM5GcnQFArXj0EvkRGAAAAABJRU5ErkJggg==',
    2: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA20lEQVR42s2X3Q2FIAyF7QoMwgNLOAMzOEOXYStmYAe4mpSEEH+uILQPJyZGOJ9QSrtoNAunegaDRqNIMAPgMLEajdufXqOJGk0iRXrn6Bv4EuCYDDWaUBg+KdAY6AVY6c9SozzN0QSwdRjX2t4CfGl+C3G17GmQ1icA6Nzzf2IC7gBwoHkWXgHAy6PWqlCuQglgJ5hn2TMANxHAnQH4iQC+BoAqt49WzHGQAdRE8ywlCoB9C9iDUMQxZE9E7KmY/TIScR2zFyQiSjIRRamIslxEYyKiNRPTnA7RD2cV4Nw28vr+AAAAAElFTkSuQmCC',
  },
  grey: {
    1: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAbElEQVR42mOYtWAZAx7MBsU41WAT1Ji1YNnkWQuW3Zu1YNl/KL4HFdMgZEA+kiZcOB+XAcRoxjAE2dn/ScQayAZMJsOAycgG3CPDgHswA9jI0AzDbFQxgGIvUCUQKY5GihMSVZIyVTITydkZAPD/fAMdFUBFAAAAAElFTkSuQmCC',
    2: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA3ElEQVR42s2X3Q2FIAyF7Qos5QzM4AwswhPhgZ2YgR3Aa1ISQvy5gtA+nJgY4XxCKe2ijVso1TMYtHECBTMADhOpjbO/p9fGRW1cQkV8Z/Eb+BLgmExp40Jh+KSAY6AXYMU/S43yOEcTwNZhXGt7C/Cl+S3E1bKnQVqfAKBzz/+JCbgDUAPNs9QVALw8aq0K5SqUAHKCeZY8A7ATAewZgJ8I4GsAqHL7aMUcBxlATDTPEqwAyLeAPAhZHEPyRESeiskvIxbXMXlBwqIkY1GUsijLWTQmLFozNs3pEO32se0YCAHWcwAAAABJRU5ErkJggg==',
  },
};

function trayIcon(color) {
  if (trayIcon._cache === undefined) trayIcon._cache = {};
  if (trayIcon._cache[color]) return trayIcon._cache[color];
  const src = TRAY_PNG[color] || TRAY_PNG.grey;
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, dataURL: 'data:image/png;base64,' + src[1] });
  img.addRepresentation({ scaleFactor: 2, dataURL: 'data:image/png;base64,' + src[2] });
  // 防御：万一 addRepresentation 产物异常，至少保证返回有效图像
  const icon = img.isEmpty()
    ? nativeImage.createFromDataURL('data:image/png;base64,' + src[2])
    : img;
  trayIcon._cache[color] = icon;
  return icon;
}

function setAutoStart(on) {
  store.set({ autoStart: !!on });
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: [] });
  } catch (e) { log('设置开机自启失败: ' + e.message); }
}

/** 统一入口：打开 1688 登录窗口，并启动「登录看门狗」实时反映登录态 */
let _loginWatch = null;
function openLogin() {
  sender.openLoginWindow();
  if (_loginWatch) return;
  _loginWatch = setInterval(() => {
    const win = sender.getSendWindow ? sender.getSendWindow() : null;
    if (!win || win.isDestroyed()) { clearInterval(_loginWatch); _loginWatch = null; return; }
    const url = win.webContents.getURL();
    const onLoginPage = /login\.1688\.com|signin/i.test(url);
    if (client) client.reportLoginState(!onLoginPage, url);
    if (!onLoginPage) { clearInterval(_loginWatch); _loginWatch = null; } // 已离开登录页 → 视为已登录，停止轮询
  }, 2000);
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
  client.on('ready', () => { log('已连接服务器'); refreshTray(); pushState(); });
  client.on('connected', () => { refreshTray(); pushState(); });
  client.on('disconnected', (info) => { log(`连接断开 (${info && info.code})，稍后重连`); refreshTray(); pushState(); });
  client.on('state', () => { refreshTray(); pushState(); });
  client.on('progress', () => pushState());
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
ipcMain.handle('agent:openLoginWindow', () => { openLogin(); return true; });
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
