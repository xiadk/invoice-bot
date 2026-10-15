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

// ── 单实例：第二次启动（多半来自深链）→ 交给已运行实例处理 ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = extractLink(argv);
    if (link) handleDeepLink(link).catch((e) => log('深链处理失败: ' + e.message));
    showStatusWin();
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
    deviceName: store.get('deviceName') || os.hostname(),
    serverUrl: store.get('serverUrl') || '',
    bound: store.isBound(),
    sendState: sender.state ? sender.state() : null,
    dataDir: app.getPath('userData'),
  });
}

function refreshTray() {
  if (!hasTray()) return;
  const s = client ? client.state() : {};
  const online = !!s.ready;
  tray.setToolTip('1688 催收助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: online ? '状态：已连接' : (store.isBound() ? '状态：未连接（重连中）' : '状态：未绑定'), enabled: false },
    { label: s.sending ? '正在发送…' : '空闲', enabled: false },
    { type: 'separator' },
    { label: '打开状态面板', click: () => showStatusWin() },
    { label: '打开 1688 登录窗口', click: () => openLogin() },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: !!store.get('autoStart'), click: (mi) => setAutoStart(mi.checked) },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  try {
    const icon = online ? trayIcon('green') : trayIcon('grey');
    if (icon) tray.setImage(icon);
  } catch (e) { /* 图标缺失时忽略 */ }
}

/** 用 canvas 生成纯色小圆点图标，避免依赖图片资源 */
function trayIcon(color) {
  if (trayIcon._cache === undefined) trayIcon._cache = {};
  if (trayIcon._cache[color]) return trayIcon._cache[color];
  const c = color === 'green' ? '#2e7d32' : '#9aa0a6';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="${c}"/></svg>`;
  const icon = nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
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
function startAgent() {
  const serverUrl = store.get('serverUrl');
  const deviceToken = store.get('deviceToken');
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
    const server = (u.searchParams.get('server') || store.get('serverUrl') || '').replace(/\/+$/, '');
    const t = u.searchParams.get('t') || '';
    if (!server || !t) { log('绑定深链缺少 server 或 t'); showStatusWin(); return; }
    const r = await postJson(server + '/api/agent/bind', {
      bindToken: t, deviceName: os.hostname(), os: `${process.platform}-${os.arch()}`, agentVer: VERSION, kind: 'agent',
    });
    if (r.status !== 200 || !r.body || !r.body.deviceToken) {
      log('绑定失败: ' + (r.body && r.body.error ? r.body.error : ('HTTP ' + r.status)));
      showStatusWin();
      return;
    }
    store.setBinding({ deviceToken: r.body.deviceToken, serverUrl: r.body.serverUrl || server, deviceId: r.body.deviceId, userId: r.body.userId });
    log('绑定成功（deviceId=' + r.body.deviceId + '）');
    if (client) client.rebind({ serverUrl: store.get('serverUrl'), deviceToken: store.get('deviceToken') });
    else startAgent();
    showStatusWin();
    return;
  }

  if (action === 'run') {
    // 网站点「批量发送」但助手没在跑 → 拉起并连上；绑定信息用本地已存的
    if (!store.isBound()) { log('尚未绑定，无法直接运行'); showStatusWin(); return; }
    startAgent();
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

  // 注册自定义协议（Windows 写 HKCU\Software\Classes\xsh，无需管理员；卸载时由安装器清理）
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
    log('已注册协议 ' + PROTOCOL + '://');
  } catch (e) { log('注册协议失败: ' + e.message); }

  // 托盘
  try {
    tray = new Tray(trayIcon('grey'));
    tray.on('click', () => showStatusWin());
    refreshTray();
  } catch (e) { log('创建托盘失败: ' + e.message); }

  // 冷启动时进程参数里可能就带着深链
  const coldLink = extractLink(process.argv);
  if (coldLink) handleDeepLink(coldLink).catch((e) => log('深链处理失败: ' + e.message));
  else startAgent();

  // 启动即展示主窗口（无论是否已绑定）：用户点 exe 应直接看到界面，
  // 而不是只呆在托盘里、要手动点托盘图标才弹出来。
  showStatusWin();
});

// ── IPC（状态窗 → 主进程）──
ipcMain.handle('agent:getState', () => {
  const s = client ? client.state() : { connected: false, ready: false, sending: false, loggedIn: false };
  return { ...s, version: VERSION, deviceName: store.get('deviceName') || os.hostname(), serverUrl: store.get('serverUrl') || '', bound: store.isBound(), dataDir: app.getPath('userData') };
});
ipcMain.handle('agent:openLoginWindow', () => { openLogin(); return true; });
ipcMain.handle('agent:stopTask', () => {
  if (client) { client.stopFlag = true; if (client.currentTaskId != null) client.send({ type: 'client_stop', taskId: client.currentTaskId }); }
  return true;
});
ipcMain.handle('agent:openDataDir', () => { shell.openPath(app.getPath('userData')); return true; });
ipcMain.handle('agent:unbind', () => {
  store.clearBinding();
  if (client) { client.stop(); client = null; }
  refreshTray(); pushState();
  return true;
});
ipcMain.handle('agent:quit', () => { quitting = true; app.quit(); return true; });
