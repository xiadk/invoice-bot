/**
 * electron/ui/site-frame.js — 网站窗口的「外框」：顶部一条工具栏 + 下方站点视图
 *
 * 背景：以前每个站点窗口都是 `new BrowserWindow()` 直接 loadURL(站点)，
 * 窗口自身的 webContents 就是站点页面、占满整个客户区，没有地方放“窗口自己的”按钮。
 * 要做真正的顶部工具栏（← 返回 / → 前进 / ⟳ 刷新 + 网址），只能把站点挪进一个
 * WebContentsView，让窗口自身的 webContents 装本地工具栏页（frame.html，高 40px）。
 *
 * 关键设计：create() 返回的不是 BrowserWindow，而是一个**代理对象**：
 *   · `.webContents`  → 指向站点视图的 webContents（页面脚本、UA、导航限制都还生效）
 *   · 其它成员        → 原样转发给真实窗口（show / close / isDestroyed / on / loadURL …）
 * 这样各调用点原有的 `w.webContents.xxx`、`w.on('closed')`、`w.show()` 一行都不用改，
 * 把改动面压在“创建窗口”这几行里，避免动到登录 / 页内签名 / 发货这些关键链路。
 *
 * 隐私：工具栏页是本地的，不联网；站点视图沿用调用方给的分区与 sandbox 配置。
 */
const { BrowserWindow, WebContentsView, ipcMain } = require('electron');
const path = require('path');

const TOOLBAR_H = 40;

/** 工具栏页 webContents.id → { win, view }，供工具栏按钮回调找到对应的站点视图 */
const records = new Map();

/**
 * 站点视图在窗口客户区里的位置：顶部让出 TOOLBAR_H。
 * 抽成纯函数是为了能单测（窗口过矮时高度不允许为负）。
 */
function siteBounds(width, height) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  return { x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) };
}

/** 当前导航状态（能不能后退/前进、当前网址） */
function navState(view) {
  const wc = view.webContents;
  const hist = wc.navigationHistory || null;
  let canBack = false;
  let canForward = false;
  try {
    canBack = hist ? !!hist.canGoBack() : !!(typeof wc.canGoBack === 'function' && wc.canGoBack());
    canForward = hist ? !!hist.canGoForward() : !!(typeof wc.canGoForward === 'function' && wc.canGoForward());
  } catch (e) { /* 页面销毁中，按不可用处理 */ }
  let url = '';
  try { url = wc.getURL() || ''; } catch (e) { url = ''; }
  return { url, canBack, canForward };
}

function pushState(rec) {
  if (!rec || !rec.win || rec.win.isDestroyed()) return;
  try { rec.win.webContents.send('xsh:frame:state', navState(rec.view)); } catch (e) { /* 工具栏页未就绪 */ }
}

function goBack(rec) {
  const wc = rec.view.webContents;
  const hist = wc.navigationHistory || null;
  if (hist) { if (hist.canGoBack()) hist.goBack(); return; }
  if (typeof wc.canGoBack === 'function' && wc.canGoBack()) wc.goBack();
}

function goForward(rec) {
  const wc = rec.view.webContents;
  const hist = wc.navigationHistory || null;
  if (hist) { if (hist.canGoForward()) hist.goForward(); return; }
  if (typeof wc.canGoForward === 'function' && wc.canGoForward()) wc.goForward();
}

/** 只注册一次 IPC：工具栏页发来的动作 */
function ensureIpc() {
  if (ensureIpc.done) return;
  ensureIpc.done = true;
  ipcMain.on('xsh:frame:nav', (e, action) => {
    const rec = records.get(e.sender.id);
    if (!rec || rec.win.isDestroyed()) return;
    try {
      if (action === 'back') goBack(rec);
      else if (action === 'forward') goForward(rec);
      else if (action === 'reload') rec.view.webContents.reload();
    } catch (err) { /* 页面正在销毁，忽略 */ }
    setTimeout(() => pushState(rec), 80);
  });
  ipcMain.on('xsh:frame:ready', (e) => {
    const rec = records.get(e.sender.id);
    if (rec) pushState(rec);
  });
}

/**
 * 创建带工具栏的网站窗口。
 * @param {object} opts
 * @param {string} opts.title        窗口标题（固定，不随页面标题变，免得用户找不到窗口）
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {boolean} opts.show
 * @param {object} opts.webPreferences  给站点视图用的（partition / sandbox / backgroundThrottling…原样透传）
 * @returns {BrowserWindow} 代理对象（用法见文件头）
 */
function create(opts) {
  const o = opts || {};
  ensureIpc();

  const winOpts = {
    show: !!o.show,
    width: Number(o.width) || 1100,
    height: Number(o.height) || 800,
    title: o.title || '',
    autoHideMenuBar: o.autoHideMenuBar !== false,
    backgroundColor: o.backgroundColor || '#ffffff',
    webPreferences: {
      // 工具栏页：本地文件 + 极简 preload（只暴露三个导航动作），不碰任何站点数据
      preload: path.join(__dirname, 'frame-preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: true,
    },
  };
  if (o.parent) { winOpts.parent = o.parent; winOpts.modal = !!o.modal; }
  if (o.icon) winOpts.icon = o.icon;
  if (o.resizable === false) winOpts.resizable = false;

  const win = new BrowserWindow(winOpts);
  const frameWcId = win.webContents.id;
  const keepTitle = () => { if (o.title) { try { win.setTitle(o.title); } catch (e) { /* 忽略 */ } } };
  keepTitle();
  win.loadFile(path.join(__dirname, 'frame.html')).catch(() => { /* 本地文件，失败也不影响站点 */ });
  // 工具栏页自带的 <title> 会盖掉窗口标题，加载完再压回去（标题要固定成业务名，不跟网址变）
  win.webContents.on('did-finish-load', keepTitle);

  const view = new WebContentsView({ webPreferences: o.webPreferences || {} });
  win.contentView.addChildView(view);

  const rec = { win, view };
  records.set(frameWcId, rec);

  const relayout = () => {
    if (win.isDestroyed()) return;
    try {
      const [w, h] = win.getContentSize();
      view.setBounds(siteBounds(w, h));
    } catch (e) { /* 窗口销毁中 */ }
  };
  relayout();
  win.on('resize', relayout);
  win.on('maximize', () => setTimeout(relayout, 0));
  win.on('unmaximize', () => setTimeout(relayout, 0));
  win.on('enter-full-screen', () => setTimeout(relayout, 0));
  win.on('leave-full-screen', () => setTimeout(relayout, 0));

  // 站点导航 → 刷新工具栏上的网址与按钮可用性
  const wc = view.webContents;
  ['did-navigate', 'did-navigate-in-page', 'did-finish-load', 'did-stop-loading'].forEach((ev) => {
    wc.on(ev, () => pushState(rec));
  });
  wc.on('page-title-updated', () => pushState(rec));

  win.on('closed', () => {
    records.delete(frameWcId);
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (e) { /* 已随窗口销毁 */ }
  });

  return proxyOf(win, view);
}

/**
 * 这些是「网页级」方法：调用方写的是 `w.loadURL(...)`，期望的是动页面而不是动窗口。
 * 必须转发给站点视图的 webContents —— 否则会把工具栏页导航走（v0.3.15 自查时踩到过）。
 */
const PAGE_METHODS = new Set([
  'loadURL', 'getURL', 'reload', 'capturePage', 'executeJavaScript', 'insertCSS',
  'sendInputEvent', 'setZoomFactor', 'getZoomFactor', 'print',
]);

/**
 * 把真实窗口包成“看起来还是 BrowserWindow”的对象。
 * ⚠ 未知成员一律转发给真实窗口并绑定 this —— 漏实现某个方法时退化成原行为，而不是报错。
 */
function proxyOf(win, view) {
  const wc = view.webContents;
  return new Proxy(win, {
    get(t, p) {
      if (p === 'webContents') return wc;
      // 别让人不小心 await 这个代理（Promise 解析会读 then）
      if (p === 'then' || p === 'toJSON' || p === 'inspect') return undefined;
      if (p === '__window') return t;
      if (p === '__siteView') return view;
      if (PAGE_METHODS.has(p)) {
        const fn = wc[p];
        return typeof fn === 'function' ? fn.bind(wc) : fn;
      }
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, p, v) { return Reflect.set(t, p, v); },
    has(t, p) { return p === 'webContents' || p in t; },
  });
}

module.exports = { TOOLBAR_H, create, siteBounds, navState, records };
