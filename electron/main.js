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
const profitWatch = require('./agent/profit-watch');
const { ProfitScheduler } = require('./agent/profit-scheduler');

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
let profitSched = null;   // 美团毛利采集的节奏控制（profit-scheduler）

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
    deviceName: store.get('deviceName') || os.hostname(),
    serverUrl: store.get('serverUrl') || '',
    bound: store.isBound(),
    sendState: sender.state ? sender.state() : null,
    profitState: profitSched ? profitSched.state() : null,
    profitConfig: client ? client.profitConfig : null,
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
  // 「导入1688订单数据」内核：在同一 1688 分区里按条件导出报表并回传服务器
  client.setExportHandler((m, api) => orderExport.runExport(m, api, {
    serverUrl: store.get('serverUrl'),
    deviceToken: store.get('deviceToken'),
  }));
  client.on('ready', () => {
    log('已连接服务器'); refreshTray(); pushState();
    // 连上后如果服务器还没推配置，就用上次缓存的规则先跑（避免刚启动空等）
    if (profitSched) {
      const cfg = client.profitConfig || store.get('profitConfig');
      if (cfg) profitSched.setConfig(cfg);
      profitSched.start();
    }
  });
  client.on('connected', () => { refreshTray(); pushState(); });
  client.on('disconnected', (info) => { log(`连接断开 (${info && info.code})，稍后重连`); refreshTray(); pushState(); });
  client.on('state', () => { refreshTray(); pushState(); });
  client.on('progress', () => pushState());
  setupProfitWatch();
  client.start();
}

/**
 * 美团毛利采集的装配（2026-10-20）
 *  · 规则来自服务器（profit_watch_config）；助手只执行，不自己决定阈值
 *  · 采集全在本机浏览器（persist:meituan 分区），服务器不接触美团登录态
 *  · 上报走已建立的 WS 通道；断线时这轮数据直接丢弃（下一轮会重新采，不需要补传）
 */
function setupProfitWatch() {
  if (profitSched) return;
  profitSched = new ProfitScheduler({
    log: (m) => log('[毛利] ' + m),
    collect: async (cfg) => {
      const r = await profitWatch.collectOnce(cfg || {});
      return {
        ok: !!r.ok,
        reason: r.reason || '',
        rows: profitWatch.normalizeRows(r.rows),
        pageTitle: r.pageTitle || '',
        warnings: r.warnings || [],
      };
    },
    refresh: () => profitWatch.clickRefresh(),
    report: (rows, info) => {
      if (!client) return;
      if (!info.ok) {
        // 采集失败也要报心跳，否则服务器会误判「离线」并疯狂告警
        client.send({
          type: 'profit_state', ok: false, rows: 0, parsed: 0,
          pageTitle: info.pageTitle || '', pageUrl: (profitSched && profitSched.state().pageUrl) || '',
          error: info.reason || '', agentVer: VERSION,
          target: (profitSched && profitSched.state().target) || '', mode: 'live',
        });
        return;
      }
      client.send({
        type: 'profit_report',
        rows,
        pageTitle: info.pageTitle || '',
        pageUrl: (profitSched && profitSched.state().pageUrl) || '',
        agentVer: VERSION,
        target: (profitSched && profitSched.state().target) || '',
        mode: 'live',
        // 手动触发时用服务器下发的 reqId（便于前端对应），自动轮询用时间戳
        reqId: info.reqId || String(Date.now()),
        manual: !!info.manual,
      });
      if (info.warnings && info.warnings.length) log('[毛利] ' + info.warnings.join('；'));
    },
    onState: () => pushState(),
  });

  client.on('ready', () => {
    // 连上后如果服务器还没推配置，就用上次缓存的规则先跑（避免刚启动空等）
    if (!client.profitConfig && store.get('profitConfig')) profitSched.setConfig(store.get('profitConfig'));
    if (client.profitConfig) profitSched.setConfig(client.profitConfig);
    profitSched.start();
  });
  client.on('profit_config', (cfg) => {
    store.set({ profitConfig: cfg || null });
    profitSched.setConfig(cfg);
    if (cfg && cfg.enabled) profitSched.start();
    pushState();
  });
  // 看板点「立即采集」：服务器转发过来，附带最新规则
  client.on('profit_run_now', (m) => {
    const reqId = (m && m.reqId) || '';
    if (m && m.config) {
      store.set({ profitConfig: m.config });
      profitSched.setConfig(m.config);
    }
    if (!profitSched.state().enabled) {
      log('[毛利] 收到立即采集指令，但采集已被暂停，忽略');
      return;
    }
    log('[毛利] 收到立即采集指令' + (reqId ? '（' + reqId + '）' : ''));
    profitSched.runNow({ reqId }).catch((e) => log('[毛利] 立即采集失败: ' + e.message));
  });
  client.on('disconnected', () => {
    // WS 断了就暂停采集（采集结果也发不出去，白跑）；重连后 ready 会重新 start
    if (profitSched) profitSched.stop();
  });
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

  // 冷启动时进程参数里可能就带着深链；连服务器放到窗口首帧之后
  setImmediate(() => {
    const coldLink = extractLink(process.argv);
    if (coldLink) handleDeepLink(coldLink).catch((e) => log('深链处理失败: ' + e.message));
    else startAgent();
  });
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

// ── 美团毛利采集（面板按钮）──
ipcMain.handle('agent:profitOpen', async () => {
  const url = (client && client.profitConfig && client.profitConfig.url) || profitWatch.DEFAULT_URL;
  await profitWatch.openWindow(url);
  return true;
});
ipcMain.handle('agent:profitRunNow', async () => {
  if (!profitSched) return { ok: false, error: '采集未初始化（请先绑定并连接服务器）' };
  const r = await profitSched.runNow();
  pushState();
  return r;
});
ipcMain.handle('agent:profitSetEnabled', (e, on) => {
  // 面板上的「暂停/恢复采集」只影响本机（服务器规则仍以看板为准，下次下发会覆盖）
  if (!profitSched) return false;
  const cfg = { ...(client && client.profitConfig ? client.profitConfig : store.get('profitConfig') || {}), enabled: !!on };
  profitSched.setConfig(cfg);
  if (on) profitSched.start(); else profitSched.stop();
  pushState();
  return true;
});
