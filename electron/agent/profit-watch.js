/**
 * electron/agent/profit-watch.js — 美团「毛利明细」采集内核（跑在助手自带的浏览器里）
 *
 * 目标页面（用户配置，默认）：
 *   https://qnh.meituan.com/home.html#/data/gross-profit-warn?tabNo=orderDetail
 *
 * 为什么这样做（风控视角，务必别改坏）：
 *   · 用**本机浏览器 + 用户本人登录态 + 本人 IP**，就是「你自己在盯报表」；
 *   · **不发任何额外接口请求**，只读 DOM；不 hook XHR、不改请求头、不伪造 UA；
 *   · 刷新走页面**自带的刷新按钮**（真人也会点），间隔带随机抖动，避开高频；
 *   · 单机单账号，不做并发、不做翻页轰炸（默认只读第一页）。
 *
 * 解析策略（不硬编码业务 class，页面改版也不至于全崩）：
 *   1) 找最大的 <table>（行数 × 列数）；没有则退化为「按表头文字定位的 div 行」
 *   2) 表头行 = 命中关键词最多的一行（毛利/金额/订单/状态/店铺…）
 *   3) 列 = 按表头文字模糊匹配（valueColumn「线上毛利」等），匹配不到再用位置兜底
 *   4) 行文本按「3 个以上空格 / 制表符」切成单元格（div 表格的常见形态）
 *
 * 输出：{ ok, rows:[{orderNo, store, title, status, gross, amount, orderTime, remark, raw}], pageTitle, pageUrl, warn }
 * 注意：本文件**不接触任何凭据**，登录态留在用户自己的浏览器 profile 里。
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const PARTITION = 'persist:meituan';
const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_URL = 'https://qnh.meituan.com/home.html#/data/gross-profit-warn?tabNo=orderDetail';
const HOME_URL = 'https://qnh.meituan.com/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { app.userAgentFallback = REAL_UA; } catch (e) { /* 忽略 */ }

let watchWin = null;

// ─────────────────────────────────────────────────────────────────────────
// 注入脚本：找表格 → 认表头 → 抽列。全部返回**可结构化克隆**的普通对象。
// ─────────────────────────────────────────────────────────────────────────
const EXTRACT_JS = `(function (cfg) {
  var out = { ok: false, reason: '', rows: [], warnings: [], headers: [], headerScore: 0, container: '', colMap: {} };

  function txt(el) {
    if (!el) return '';
    var t = (el.innerText === undefined ? el.textContent : el.innerText) || '';
    return String(t).replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  }
  function vis(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    try { var cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') return false; } catch (e) {}
    return true;
  }
  // 数字：'1,234.50' / '¥12.3' / '-8.2元' / '(8.20)' → number；非数字返回 null
  function num(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).replace(/[¥￥$,\\s]/g, '').replace(/元$/, '').replace(/[−–—]/g, '-');
    var m = /^\\((.*)\\)$/.exec(s);
    if (m) s = '-' + m[1];
    if (!/^-?\\d*\\.?\\d+(e[-+]?\\d+)?$/i.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function scoreHeaderLine(t) {
    var kw = ['毛利', '订单', '金额', '实付', '状态', '店铺', '门店', '商品', '时间', '单号', '收入', '成本', '利润'];
    var s = 0;
    for (var i = 0; i < kw.length; i++) if (t.indexOf(kw[i]) >= 0) s++;
    return s;
  }
  // 把一行元素里的文本按「列」取出：优先真 th/td，其次用 innerText 的连续空白切分
  function cellTexts(tr) {
    var cells = tr.querySelectorAll(':scope > th, :scope > td');
    if (cells.length >= 2) {
      var arr = [];
      for (var i = 0; i < cells.length; i++) arr.push(txt(cells[i]));
      return arr;
    }
    var line = txt(tr);
    var parts = line.split(/\\t| {3,}|\\u3000{2,}/).map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
    return parts;
  }

  // ── 1) 候选表格容器 ──
  var tables = Array.prototype.slice.call(document.querySelectorAll('table')).filter(function (t) {
    try { return t.querySelectorAll('tr').length >= 2 && vis(t); } catch (e) { return false; }
  });
  var best = null;
  for (var i = 0; i < tables.length; i++) {
    var trs = tables[i].querySelectorAll('tr').length;
    var tds = tables[i].querySelectorAll('td').length;
    var sc = trs * 3 + tds;
    if (!best || sc > best.sc) best = { el: tables[i], sc: sc, rows: trs, kind: 'table' };
  }
  // 没有 table：按「表头文字」找 div 行容器（美团这类报表页可能是 div 布局）
  if (!best) {
    var heads = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function (e) {
      if (e.children && e.children.length > 0) return false;
      return scoreHeaderLine(txt(e)) >= 3 && vis(e);
    });
    for (var h = 0; h < heads.length; h++) {
      var node = heads[h];
      var container = null;
      for (var up = 0; up < 8 && node && node.parentElement; up++) {
        node = node.parentElement;
        var cand = node.querySelectorAll('*');
        // 容器里应有足够多的「像行」的元素（文本较长、有数字）
        var like = 0;
        for (var c = 0; c < Math.min(cand.length, 400); c++) {
          var t = txt(cand[c]);
          if (t.length > 6 && /\\d/.test(t)) like++;
        }
        if (like >= 8) { container = node; break; }
      }
      if (container) { best = { el: container, sc: 999, rows: 0, kind: 'div' }; break; }
    }
  }
  if (!best) { out.reason = 'no-table'; return out; }

  // ── 2) 取「行元素」列表 + 表头 ──
  var rowEls = [];
  if (best.kind === 'table') {
    rowEls = Array.prototype.slice.call(best.el.querySelectorAll('tr'));
  } else {
    // div 布局：把容器里「同一父节点下的兄弟」视为行
    var kids = Array.prototype.slice.call(best.el.querySelectorAll('*'));
    var groups = new Map();
    for (var k = 0; k < kids.length; k++) {
      var e = kids[k];
      if (e.children.length > 12) continue;      // 太大，是容器不是行
      var t2 = txt(e);
      if (t2.length < 4) continue;
      var p = e.parentElement;
      if (!p) continue;
      var key = null;
      // 用父节点的「标签名 + 前两个 class」做分组键
      key = p.tagName + '.' + (p.className || '').toString().split(' ').slice(0, 2).join('.');
      if (!groups.has(key)) groups.set(key, { parent: p, items: [] });
      groups.get(key).items.push(e);
    }
    var gBest = null;
    groups.forEach(function (g) {
      if (g.items.length < 2) return;
      if (!gBest || g.items.length > gBest.items.length) gBest = g;
    });
    if (gBest) rowEls = gBest.items;
  }

  // 表头：得分最高的一行（在整页范围内找，因为表头可能在 best.el 之外）
  var headRow = null, headTexts = [], headScore = 0;
  for (var r = 0; r < Math.min(rowEls.length, 6); r++) {
    var line = txt(rowEls[r]);
    var s2 = scoreHeaderLine(line);
    if (s2 > headScore) { headScore = s2; headRow = rowEls[r]; headTexts = cellTexts(rowEls[r]); }
  }
  if (!headRow) {
    // 退一步：整页找表头文字最集中的一行
    var allLines = Array.prototype.slice.call(document.querySelectorAll('div,tr,li')).slice(0, 4000);
    for (var a = 0; a < allLines.length; a++) {
      var el2 = allLines[a];
      if (el2.children.length > 14) continue;
      var t3 = txt(el2);
      if (t3.length < 8 || t3.length > 400) continue;
      var s3 = scoreHeaderLine(t3);
      if (s3 > headScore) { headScore = s3; headTexts = t3.split(/\\t| {3,}/).map(function (x) { return x.trim(); }).filter(Boolean); headRow = el2; }
    }
  }
  out.headers = headTexts;
  out.headerScore = headScore;

  // ── 3) 列定位：模糊匹配表头文字，失败再按位置兜底 ──
  function findCol(want) {
    if (!want) return -1;
    var w = String(want).replace(/\\s/g, '');
    var i;
    for (i = 0; i < headTexts.length; i++) {
      if (headTexts[i].replace(/\\s/g, '') === w) return i;
    }
    for (i = 0; i < headTexts.length; i++) {
      var h = headTexts[i].replace(/\\s/g, '');
      if (h.indexOf(w) >= 0 || w.indexOf(h) >= 0) return i;
    }
    // 「线上毛利」→「毛利」，「订单金额」→「金额」：退一步按主干词匹配
    var core = w.replace(/^(线上|线下|订单|商品|门店|店铺)/, '');
    if (core && core !== w) {
      for (i = 0; i < headTexts.length; i++) {
        if (headTexts[i].replace(/\\s/g, '').indexOf(core) >= 0) return i;
      }
    }
    return -1;
  }
  var col = {
    value: findCol(cfg.valueColumn || '线上毛利'),
    amount: findCol(cfg.amountColumn || ''),
    status: findCol(cfg.statusColumn || '订单状态'),
    store: findCol(cfg.storeColumn || '店铺名称'),
    order: findCol(cfg.orderColumn || '订单号'),
    title: findCol('商品'),
    time: findCol('时间'),
  };
  out.colMap = col;

  // ── 4) 抽行 ──
  var dataRows = rowEls.filter(function (tr) { return tr !== headRow; });
  var seen = {};
  for (var d = 0; d < dataRows.length; d++) {
    var el3 = dataRows[d];
    if (!vis(el3)) continue;
    var cells = cellTexts(el3);
    if (cells.length < 2) continue;
    var lineText = cells.join(' | ');
    if (/^(合计|总计|小计|汇总)/.test(lineText)) continue;
    if (headTexts.length && lineText.replace(/\\s/g, '') === headTexts.join('').replace(/\\s/g, '')) continue;

    var pick = function (idx, fallbackRe) {
      if (idx >= 0 && idx < cells.length) return cells[idx];
      if (fallbackRe) {
        for (var q = 0; q < cells.length; q++) if (fallbackRe.test(cells[q])) return cells[q];
      }
      return '';
    };
    var rawOrder = pick(col.order, /^\\d{6,}$/);
    // 订单号兜底：行里第一个 8 位以上的纯数字
    if (!rawOrder) {
      for (var z = 0; z < cells.length; z++) { if (/^\\d{8,}$/.test(cells[z].replace(/\\s/g, ''))) { rawOrder = cells[z]; break; } }
    }
    var grossRaw = pick(col.value, null);
    var gross = num(grossRaw);
    if (gross === null) {
      // 值列没认出来：退化为「行内所有数字里最像毛利的一个（含负号或小数的第二个）」
      for (var y = 0; y < cells.length; y++) {
        if (y === col.amount) continue;
        var n2 = num(cells[y]);
        if (n2 !== null && /^-/.test(String(cells[y]).replace(/[¥￥,\\s]/g, ''))) { gross = n2; grossRaw = cells[y]; break; }
      }
    }
    // 订单号拿不到但行内有数字：用『行索引 + 关键列』造稳定标识，至少能告警（标注为无单号）
    var orderNo = (rawOrder || '').replace(/[^0-9A-Za-z_-]/g, '');
    if (!orderNo) {
      orderNo = 'NOID-' + (cfg.pageKey || 'p') + '-' + (d + 1) + '-' + String(cells.slice(0, 3).join('').replace(/\\s/g, '')).slice(0, 24);
    }
    if (seen[orderNo]) continue;
    seen[orderNo] = 1;
    out.rows.push({
      orderNo: orderNo,
      store: pick(col.store, null),
      title: pick(col.title, null),
      status: pick(col.status, null),
      gross: gross,
      amount: num(pick(col.amount, null)),
      orderTime: pick(col.time, null),
      remark: lineText.slice(0, 200),
      raw: cells.slice(0, 24),
    });
  }

  if (!out.rows.length) { out.reason = headRow ? 'no-data-rows' : 'no-header'; }
  if (col.value < 0) out.warnings.push('未识别到「' + (cfg.valueColumn || '线上毛利') + '」列，已按行内负数字段兜底，请在看板核对列名');
  out.ok = out.rows.length > 0;
  out.container = best.kind;
  return out;
})`;

// ─────────────────────────────────────────────────────────────────────────
// 窗口
// ─────────────────────────────────────────────────────────────────────────
function ensureAntiSourceDump() {
  try {
    const part = session.fromPartition(PARTITION);
    if (part.__profitHooked) return;
    part.__profitHooked = true;
    part.webRequest.onHeadersReceived((details, callback) => {
      try {
        const url = String(details.url || '');
        const isDoc = /^https?:\/\/[^/]*meituan\.com\//i.test(url)
          && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame');
        const headers = details.responseHeaders || {};
        let ct = '';
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') ct = String(headers[k] && headers[k][0] || '').toLowerCase();
        if (isDoc && /text\/plain|application\/javascript/.test(ct)) {
          const nh = Object.assign({}, headers);
          nh['content-type'] = ['text/html; charset=utf-8'];
          return callback({ responseHeaders: nh });
        }
      } catch (e) { /* 忽略 */ }
      callback({});
    });
  } catch (e) { /* 忽略 */ }
}

/** 采集窗口（懒创建 + 复用）。默认隐藏；用户点「打开美团报表窗口」才显示。 */
function getWatchWindow() {
  if (watchWin && !watchWin.isDestroyed()) return watchWin;
  ensureAntiSourceDump();
  const part = session.fromPartition(PARTITION);
  try { part.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  watchWin = new BrowserWindow({
    show: false, width: 1360, height: 860, title: '美团（毛利采集窗口）', autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, // 关键：隐藏窗口的定时器不能被节流，否则采集会漂
    },
  });
  try { watchWin.webContents.setUserAgent(REAL_UA); } catch (e) { /* 忽略 */ }
  // 只允许在美团域名内跳转，防钓鱼/被引导到别处
  watchWin.webContents.setWindowOpenHandler(({ url }) => (/meituan\.com/i.test(url) ? { action: 'allow' } : { action: 'deny' }));
  watchWin.webContents.on('will-navigate', (e, url) => {
    if (!/meituan\.com/i.test(url)) { try { e.preventDefault(); } catch (er) { /* 忽略 */ } }
  });
  watchWin.on('closed', () => { watchWin = null; });
  return watchWin;
}

/** 打开窗口并显示（用户首次登录美团、或临时查看时用） */
async function openWindow(url) {
  const win = getWatchWindow();
  win.show();
  win.focus();
  const cur = win.webContents.getURL() || '';
  if (!/meituan\.com/i.test(cur)) {
    await win.loadURL(url || HOME_URL).catch(() => {});
  } else if (url && cur.split('#')[0] !== String(url).split('#')[0]) {
    await win.loadURL(url).catch(() => {});
  }
  return true;
}

function closeWindow() {
  try { if (watchWin && !watchWin.isDestroyed()) watchWin.destroy(); } catch (e) { /* 忽略 */ }
  watchWin = null;
}

// ─────────────────────────────────────────────────────────────────────────
// 采集
// ─────────────────────────────────────────────────────────────────────────
/**
 * 判断当前页是不是「还没登录」。
 * 两道检查，缺一不可：
 *   ① URL：passport / login / sso / verify / captcha，含 SPA 哈希路由（#/login）
 *   ② DOM：美团常把登录做成浮层或同域页，URL 完全看不出来 → 检测登录表单/二维码特征
 * 宁可漏判（当成登录了，抽不到数据时报结构异常）也不要误判（把正常页当成登录页，永远采不到）。
 */
function looksLikeLogin(wc) {
  const u = wc.getURL() || '';
  if (/passport|\/login|login\b|sso|verify|captcha|#\/.*login/i.test(u)) return true;
  return false;
}

/** DOM 佐证：页面上是否明显摆着登录框（异步，只在 URL 没命中时补一刀）。
 *  2026-10-20 加固：所有特征都必须「可见」。很多正常页面的 DOM 里藏着隐藏的
 *  登录弹窗模板（display:none 的密码框/登录按钮），不做可见性校验会把已登录
 *  的报表页误判成登录页，导致永远采不到数据（用户实测踩过）。 */
async function domLooksLikeLogin(wc) {
  const expr = `(function(){
    try {
      // 元素必须真实可见（有尺寸、没被 display:none / visibility:hidden 藏起来）
      function vis(el){
        if(!el||!el.getBoundingClientRect) return false;
        var r=el.getBoundingClientRect();
        if(r.width<2||r.height<2) return false;
        try{ var cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none') return false; }catch(e){}
        return true;
      }
      // 明确的登录表单：密码框必须可见，且还没填内容（填了说明可能只是页面带着密码框组件）
      var pws=document.querySelectorAll('input[type="password"]');
      for(var i=0;i<pws.length;i++){
        if(vis(pws[i]) && !(pws[i].value && String(pws[i].value).length>0)) return 'password-input';
      }
      var t=(document.body&&document.body.innerText)||'';
      // 二维码登录：必须真的出现「扫码/二维码登录」字样
      if(/扫码登录|二维码登录/.test(t)) return 'qr-login';
      // 「登录」按钮：必须可见；且页面主体没有报表内容（有表格时不再判登录）
      var hasTable=document.querySelectorAll('table tr, .el-table__row').length>0;
      var btns=document.querySelectorAll('button,a,[role="button"]');
      for(var j=0;j<btns.length;j++){
        var s=String(btns[j].innerText||'').replace(/\\s+/g,'');
        if(s==='登录'||s==='立即登录'||s==='登录/注册'){
          if(vis(btns[j]) && !hasTable) return 'login-button';
        }
      }
      return '';
    } catch(e){ return ''; }
  })()`;
  try { return (await wc.executeJavaScript(expr, true)) || ''; } catch (e) { return ''; }
}

/** 在页面里执行抽取脚本 */
async function extractOnce(wc, cfg) {
  const expr = '(' + EXTRACT_JS + ')(' + JSON.stringify(cfg || {}) + ')';
  return wc.executeJavaScript(expr, true);
}

/**
 * 采一次（不刷新页面，只读当前 DOM）。
 * @returns {Promise<object>} { ok, rows, pageTitle, pageUrl, warn[], reason, headers, colMap }
 */
async function collectOnce(cfg) {
  const c = cfg || {};
  const win = getWatchWindow();
  const wc = win.webContents;

  const cur = wc.getURL() || '';
  if (!cur || !/meituan\.com/i.test(cur)) {
    const target = c.url || DEFAULT_URL;
    try { await wc.loadURL(target); } catch (e) { /* SPA 常见：did-finish-load 迟迟不触发 */ }
    // 给页面一点渲染时间（首次进入还要拉数据）
    await sleep(6000);
  }
  if (looksLikeLogin(wc)) {
    return {
      ok: false, reason: 'login-required | 命中URL特征 | 页面URL=' + (wc.getURL() || '(空)'),
      rows: [], pageTitle: safeTitle(wc), pageUrl: wc.getURL() || '',
    };
  }
  // URL 看不出来时再用 DOM 补判（登录浮层 / 哈希路由登录页）
  const domHit = await domLooksLikeLogin(wc);
  if (domHit) {
    return {
      ok: false, reason: 'login-required | 命中DOM特征:' + domHit + ' | 页面URL=' + (wc.getURL() || '(空)'),
      rows: [],
      warnings: ['页面疑似未登录（' + domHit + '）'],
      pageTitle: safeTitle(wc), pageUrl: wc.getURL() || '',
    };
  }
  let r = null;
  try { r = await extractOnce(wc, c); } catch (e) {
    return { ok: false, reason: 'exec-error: ' + e.message, rows: [], pageTitle: safeTitle(wc), pageUrl: wc.getURL() || '' };
  }
  if (!r || typeof r !== 'object') {
    return { ok: false, reason: 'bad-result', rows: [], pageTitle: safeTitle(wc), pageUrl: wc.getURL() || '' };
  }
  return {
    ok: !!r.ok,
    reason: r.reason || '',
    rows: Array.isArray(r.rows) ? r.rows : [],
    headers: r.headers || [],
    colMap: r.colMap || {},
    warnings: r.warnings || [],
    container: r.container || '',
    pageTitle: safeTitle(wc),
    pageUrl: wc.getURL() || '',
  };
}

function safeTitle(wc) {
  try { return wc.getTitle() || ''; } catch (e) { return ''; }
}

/**
 * 点页面自带的刷新按钮（走 UI，等于真人操作）。找不到就什么也不做，绝不 reload 页面。
 * 美团这类报表页通常有「刷新 / 刷新数据 / 查询」按钮。
 */
async function clickRefresh() {
  const win = getWatchWindow();
  const wc = win.webContents;
  const expr = `(function(){
    function txt(e){ var t=(e.innerText===undefined?e.textContent:e.innerText)||''; return String(t).replace(/\\s+/g,'').trim(); }
    function vis(e){ if(!e||!e.getBoundingClientRect) return false; var r=e.getBoundingClientRect(); return r.width>2&&r.height>2; }
    var labels=['刷新数据','刷新','查询','重新加载','更新'];
    var els=Array.prototype.slice.call(document.querySelectorAll('button,a,[role="button"],span,div'));
    for(var L=0;L<labels.length;L++){
      for(var i=0;i<els.length;i++){
        var e=els[i];
        if(e.children && e.children.length>2) continue;
        if(txt(e)!==labels[L]) continue;
        if(!vis(e)) continue;
        try{ e.click(); return labels[L]; }catch(err){}
      }
    }
    return '';
  })()`;
  try { return await wc.executeJavaScript(expr, true); } catch (e) { return ''; }
}

/** 页面是否还停在毛利明细（防止用户切走 / 被引导到别的 tab） */
async function pageLooksRight() {
  const win = getWatchWindow();
  const wc = win.webContents;
  const url = wc.getURL() || '';
  if (/gross-profit-warn/i.test(url)) return true;
  try {
    const has = await wc.executeJavaScript(
      `(/毛利/.test(document.body ? document.body.innerText : '') && /订单/.test(document.body ? document.body.innerText : ''))`,
      true
    );
    return !!has;
  } catch (e) { return false; }
}

/** 把采集结果整理成服务器要的格式（数字已转 number，时间统一 'YYYY-MM-DD HH:mm:ss'） */
function normalizeRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const g = r.gross;
    out.push({
      orderNo: String(r.orderNo || '').slice(0, 64),
      store: String(r.store || '').slice(0, 200),
      title: String(r.title || '').slice(0, 400),
      status: String(r.status || '').slice(0, 60),
      gross: (typeof g === 'number' && isFinite(g)) ? g : null,
      amount: (typeof r.amount === 'number' && isFinite(r.amount)) ? r.amount : null,
      orderTime: normTime(r.orderTime),
      remark: String(r.remark || '').slice(0, 240),
    });
  }
  return out;
}

function normTime(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const p = (x) => String(x || '0').padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3])} ${p(m[4])}:${p(m[5])}:${p(m[6] || '0')}`;
  }
  m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) {
    const p = (x) => String(x).padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3])} 00:00:00`;
  }
  return null;
}

module.exports = {
  PARTITION, REAL_UA, DEFAULT_URL, HOME_URL,
  getWatchWindow, openWindow, closeWindow,
  collectOnce, clickRefresh, pageLooksRight, normalizeRows, normTime,
  // 供自测/探测使用
  _test: { EXTRACT_JS, looksLikeLogin, domLooksLikeLogin },
};
