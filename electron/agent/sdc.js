/**
 * electron/agent/sdc.js — 闪电帮帮（美团 shandiancang）登录 / 取数 / 催收（只跑在用户本机）
 *
 * 为什么这三项都必须在本机浏览器里做（不能像拼多多那样服务器直连）：
 *   该站点网关有 WAF 风控：请求必须带 `mtgsig` 签名，服务器直连会拿到 openresty 的 403。
 *   但**在真实页面里**发出的 fetch 会被站点的风控 SDK（H5guard）自动补上签名 ——
 *   实测：在同一个登录页面上下文里执行不带任何签名头的裸 fetch，照样返回 200 与数据。
 *   所以：登录、拉订单、发会话消息，全部在 Electron 持久分区 `persist:sdc` 里完成。
 *
 * 已知接口（2026-10-29 实测）：
 *   登录检测   POST /sdc-gw1/mallApi/login/getLoginInfo            {}                     → data.userId / data.shopId
 *   可申请开票 POST /sdc-gw1/mallApi/invoiceTitle/queryInvoiceOrderPage
 *                                                                  {pageNo,pageSize,subUserIds:[userId]}
 *   已申请开票 POST /sdc-gw1/mallApi/orderInvoice/queryOrderInvoiceForBuyer
 *                                                                  {pageNo,pageSize,_t,invoiceApplyStatusList:[1],userIdList:[userId]}
 *   取会话     POST /mallApi/im/shop/pub/select                     {shopId}              → data = sessionId
 *   聊天页     https://shandiancang.waimai.meituan.com/customer-service/chat?sessionId=<id>
 *
 * 隐私边界：账号密码只在用户看着的本机窗口里输入；回传服务器的只有订单数据与发送结果，
 *   不回传 Cookie（服务器也用不上）。
 */
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:sdc';
const HOST = 'shandiancang.waimai.meituan.com';
const HOME_URL = `https://${HOST}/personal-center/invoice-order-management?invoiceStage=1&pageNo=1&pageSize=10`;
const CHAT_URL = `https://${HOST}/customer-service/chat`;
const APPKEY = 'fe_com.sankuai.sgshopcrm.fe.purchaseshandiancangpc';
const QS = '?yodaReady=h5&csecplatform=4&csecversion=4.3.0';

let apiWin = null;    // 承载「页内请求」的后台窗口（已登录的同源页面）
let loginWin = null;  // 登录窗口（用户要看着操作，必须可见）
let chatWin = null;   // 聊天窗口（发消息用）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}
function isSdc(url) {
  const h = hostOf(url);
  return h === HOST || /(^|\.)waimai\.meituan\.com$/i.test(h);
}

// ── 窗口 ────────────────────────────────────────────────────────────
function peekWindow() { return (loginWin && !loginWin.isDestroyed()) ? loginWin : null; }
function peekApiWindow() { return (apiWin && !apiWin.isDestroyed()) ? apiWin : null; }
function peekChatWindow() { return (chatWin && !chatWin.isDestroyed()) ? chatWin : null; }

function newBaseWindow(title, opts = {}) {
  const w = new BrowserWindow({
    show: !!opts.show,
    width: opts.width || 1440,
    height: opts.height || 900,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,   // 后台也要能跑页内 fetch / 打字，不能被节流
    },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => { if (!isSdc(url)) e.preventDefault(); });
  return w;
}

function getLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) return loginWin;
  loginWin = newBaseWindow('闪电帮帮（登录窗口）', { show: true });
  loginWin.on('closed', () => { loginWin = null; });
  return loginWin;
}

/** 取「页内请求」窗口：不存在就新建一个隐藏的同源页面（登录态在同一分区里） */
async function getApiWindow(api) {
  const alive = (apiWin && !apiWin.isDestroyed()) ? apiWin : null;
  const w = alive || (() => {
    apiWin = newBaseWindow('闪电帮帮（数据窗口）', { show: false });
    apiWin.on('closed', () => { apiWin = null; });
    return apiWin;
  })();
  const cur = (() => { try { return w.webContents.getURL(); } catch (e) { return ''; } })();
  if (!isSdc(cur)) {
    if (api && api.log) api.log('正在打开闪电帮帮页面（建立页内请求环境）…');
    await w.loadURL(HOME_URL).catch(() => {});
    // SPA 需要几秒把风控 SDK 装载好，等它加载完成再发请求，否则 fetch 还不会被自动签名
    await w.webContents.executeJavaScript(
      'new Promise((r) => { if (document.readyState === "complete") r(1);'
      + ' else window.addEventListener("load", () => r(1), { once: true }); })'
    ).catch(() => {});
    await sleep(3500);
  }
  return w;
}

function getChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) return chatWin;
  chatWin = newBaseWindow('闪电帮帮（客服会话）', { show: true, width: 1200, height: 860 });
  chatWin.on('closed', () => { chatWin = null; });
  return chatWin;
}

// ── 页内请求 ────────────────────────────────────────────────────────
/**
 * 在页面上下文里发一次 POST。
 * 关键点：这个 fetch 会被页面的风控 SDK 自动加上 mtgsig，所以这里**什么都不用签**。
 */
function pageFetch(wc, path, body) {
  const js = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(path)}, {
        method: 'POST', credentials: 'include',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          accept: 'application/json, text/plain, */*',
          'M-APPKEY': ${JSON.stringify(APPKEY)},
        },
        body: JSON.stringify(${JSON.stringify(body)}),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { status: r.status, json, text: String(text || '').slice(0, 300) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })()`;
  return wc.executeJavaScript(js, true).catch((e) => ({ error: String((e && e.message) || e) }));
}

/** 登录检测：能拿到 userId 才算登录 */
async function probeLogin(wc) {
  const r = await pageFetch(wc, '/sdc-gw1/mallApi/login/getLoginInfo' + QS, {});
  if (!r || r.error) return { logined: false, hint: (r && r.error) || '页内请求失败' };
  if (Number(r.status) === 401 || Number(r.status) === 403) return { logined: false, hint: 'HTTP ' + r.status };
  const d = (r.json && r.json.data) || null;
  const uid = d && (d.userId || d.userId === 0) ? String(d.userId) : '';
  if (!uid) return { logined: false, hint: '未登录' };
  return { logined: true, subUserId: uid, hint: '' };
}

/** 页顶显示的账号名（如「SGzs1234567 (ID:70504)」）——取不到就留空，不影响流程 */
async function pickAccountName(wc) {
  const name = await wc.executeJavaScript(`(function () {
    try {
      const el = Array.from(document.querySelectorAll('*')).find((e) => /\\(\\s*ID:\\s*\\d+\\s*\\)/.test((e.innerText || '').trim()) && e.children.length <= 2);
      const t = el ? String(el.innerText || '').trim().split('\\n')[0] : '';
      return t.replace(/\\(\\s*ID:.*$/, '').trim().slice(0, 40);
    } catch (e) { return ''; }
  })()`).catch(() => '');
  return String(name || '');
}

// ── 登录 ────────────────────────────────────────────────────────────
async function runLogin(task, api) {
  const timeoutMs = Number((task && task.timeoutMs) || 0) || 5 * 60 * 1000;
  const w = getLoginWindow();
  api.log('已在本机打开闪电帮帮窗口，请在窗口里完成登录（扫码 / 短信均可）');
  try {
    const cur = w.webContents.getURL();
    if (!isSdc(cur)) await w.loadURL(HOME_URL).catch(() => {});
  } catch (e) { /* 加载慢不影响后续轮询 */ }
  w.show();
  w.focus();

  const deadline = Date.now() + timeoutMs;
  let lastNote = 0;
  while (Date.now() < deadline) {
    if (api.isStopped && api.isStopped()) { api.report({ ok: false, error: '登录已被停止' }); return; }
    if (w.isDestroyed()) { api.report({ ok: false, error: '登录窗口被关闭，登录中止' }); return; }
    const p = await probeLogin(w.webContents);
    if (p.logined) {
      const name = await pickAccountName(w.webContents);
      api.report({
        ok: true,
        subUserId: p.subUserId,
        accountName: name || ('闪电帮帮用户 ' + p.subUserId),
        agentVer: currentVersion(),
      });
      api.log(`登录成功：${name || p.subUserId}`);
      return;
    }
    const now = Date.now();
    if (now - lastNote > 20000) {
      lastNote = now;
      api.log('等待登录中…请在闪电帮帮窗口里完成扫码或短信验证');
    }
    await sleep(2500);
  }
  api.report({ ok: false, error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）：请在窗口里完成登录后重试` });
}

/** 托盘菜单 / 状态面板：手动打开登录页 */
function openLogin() {
  const w = getLoginWindow();
  try { if (!isSdc(w.webContents.getURL())) w.loadURL(HOME_URL).catch(() => {}); } catch (e) { /* 忽略 */ }
  w.show();
  w.focus();
  return true;
}

// ── 拉订单数据 ──────────────────────────────────────────────────────
/** 可申请开票（stage=1）的一行 → 库表列 */
function pickStage1(r) {
  const inv = r.orderInvoice || {};
  return {
    stage: 1,
    order_sn: String(r.orderId || ''),
    shop_id: r.shopId ? String(r.shopId) : null,
    shop_name: r.shopName || '',
    wm_poi_id: r.shangouShopId ? String(r.shangouShopId) : null,
    wm_poi_name: r.wmPoiName || '',
    invoice_apply_status: Number(r.invoiceApplyStatus) || 0,
    invoice_apply_desc: r.invoiceApplyStatusDesc || null,
    invoice_title: inv.invoiceTitle || null,
    taxpayer_ident: inv.invoiceCode || null,
    taker_email: inv.email || null,
    invoice_type_desc: inv.invoiceTypeDesc || null,
    batch_no: null,
    total_amount: Number(r.totalAmount) || 0,
    payable_amount: Number(r.payableAmount) || Number(r.totalAmount) || 0,
    actual_pay_amount: null,
    after_total_amount: Number(r.afterTotalAmount) || 0,
    order_time: Number(r.payDate) || null,
    pay_time: Number(r.payDate) || null,
    finish_time: null,
    apply_time: null,
    trade_status_desc: null,
    refund_status_desc: r.refundStatusDesc || r.orderRefundStatusDesc || null,
    item_count: Number(r.totalItemCount) || null,
    item_names: (Array.isArray(r.itemList) ? r.itemList.map((i) => i.productName) : []).filter(Boolean).slice(0, 8).join('、'),
  };
}

/** 已申请开票（stage=2）的一行 → 库表列 */
function pickStage2(r) {
  return {
    stage: 2,
    order_sn: String(r.orderNo || ''),
    shop_id: r.shopId ? String(r.shopId) : null,
    shop_name: r.shopName || '',
    wm_poi_id: r.wmPoiId ? String(r.wmPoiId) : null,
    wm_poi_name: r.wmPoiName || '',
    invoice_apply_status: Number(r.invoiceApplyStatus) || 0,
    invoice_apply_desc: r.invoiceApplyStatus === 1 ? '已申请' : (r.invoiceStatusDesc || null),
    invoice_title: r.invoiceTitle || null,
    taxpayer_ident: r.taxpayerIdent || null,
    taker_email: r.takerEmail || null,
    invoice_type_desc: r.invoiceTypeDesc || null,
    batch_no: r.batchNo || null,
    total_amount: Number(r.totalAmount) || 0,
    payable_amount: Number(r.payableAmount) || Number(r.totalAmount) || 0,
    actual_pay_amount: Number(r.actualPayAmount) || null,
    after_total_amount: Number(r.afterTotalAmount) || 0,
    order_time: Number(r.tradeTime) || null,
    pay_time: Number(r.payTime) || null,
    finish_time: Number(r.finishTime) || null,
    apply_time: Number(r.applyTime) || null,
    trade_status_desc: r.tradeStatusDesc || null,
    refund_status_desc: r.refundStatusDesc || r.orderRefundStatusDesc || null,
    item_count: null,
    item_names: null,
  };
}

/**
 * 翻页拉某一档的全部订单，逐页回报（pageFn 负责把这一页带走，服务端边收边入库）。
 * @returns {Promise<{rows:number,pages:number,error?:string}>}
 */
async function fetchStage(wc, stage, userId, pageSize, api, pageFn, isStopped) {
  let pageNo = 1;
  let total = 0;
  let pages = 0;
  for (;;) {
    if (isStopped()) return { rows: total, pages, error: '已停止' };
    const body = stage === 2
      ? { pageNo, pageSize, _t: Date.now(), invoiceApplyStatusList: [1], userIdList: [Number(userId)] }
      : { pageNo, pageSize, _t: Date.now(), subUserIds: [Number(userId)] };
    const path = stage === 2
      ? '/sdc-gw1/mallApi/orderInvoice/queryOrderInvoiceForBuyer' + QS
      : '/sdc-gw1/mallApi/invoiceTitle/queryInvoiceOrderPage' + QS;

    const r = await pageFetch(wc, path, body);
    if (!r || r.error) return { rows: total, pages, error: String((r && r.error) || '页内请求失败') };
    if (Number(r.status) === 401 || Number(r.status) === 403) {
      return { rows: total, pages, error: `登录态失效或触发风控（HTTP ${r.status}）：请在本机重新登录后再试` };
    }
    const d = (r.json && r.json.data) || null;
    if (!d) return { rows: total, pages, error: '返回结构异常（没有 data）：' + String(r.text || '').slice(0, 120) };
    const list = Array.isArray(d.data) ? d.data : [];
    pages = Number(d.pages) || pages;
    for (const raw of list) {
      const row = stage === 2 ? pickStage2(raw) : pickStage1(raw);
      if (row.order_sn) { await pageFn(row); total += 1; }
    }
    if (api && api.log && (pageNo === 1 || pageNo % 5 === 0)) {
      api.log(`已拉取「${stage === 2 ? '已申请开票' : '可申请开票'}」第 ${pageNo}/${pages || '?'} 页，累计 ${total} 单`);
    }
    // 终止条件：够页数了 / 这一页是空的 / 拿不到下一页
    if (!list.length) break;
    if (pages && pageNo >= pages) break;
    pageNo += 1;
    await sleep(320);   // 慢一点，别把风控惹急
  }
  return { rows: total, pages };
}

/**
 * 一次完整取数：登录检测 → 两档全量 → 逐页回报。
 * @param {object} task { taskId, stages:[1,2], pageSize }
 * @param {object} api  { log(text), isStopped(), report(payload), emitRows(stage, rows) }
 */
async function runFetch(task, api) {
  let w = null;
  try {
    w = await getApiWindow(api);
  } catch (e) {
    api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    return;
  }
  const p = await probeLogin(w.webContents);
  if (!p.logined) {
    api.report({ ok: false, loginish: true, error: '本机浏览器里闪电帮帮未登录，请先在窗口里登录' });
    return;
  }
  const stages = Array.isArray(task.stages) && task.stages.length ? task.stages.map(Number) : [1, 2];
  const pageSize = Math.min(200, Math.max(10, Number(task.pageSize) || 50));
  const tally = {};
  let failed = '';
  for (const st of stages) {
    if (st !== 1 && st !== 2) continue;
    const stopped = () => (api.isStopped ? api.isStopped() : false);
    const res = await fetchStage(w.webContents, st, p.subUserId, pageSize, api, async (row) => {
      // 一条一条交给调用方（ws-client 会按适度批量发给服务器，避免单条消息过大）
      await api.emitRow(row);
    }, stopped);
    tally[st] = { rows: res.rows, pages: res.pages, error: res.error || '' };
    if (res.error) failed = res.error;
  }
  api.report({
    ok: !failed || Object.values(tally).some((t) => t.rows > 0),
    subUserId: p.subUserId,
    tally,
    agentVer: currentVersion(),
    error: failed || '',
  });
}

// ── 发催收消息 ──────────────────────────────────────────────────────
/** 取店铺会话 ID：只有 name 为 sdc 的会话; 失败返回空串 */
async function selectSession(wc, shopId) {
  const r = await pageFetch(wc, '/mallApi/im/shop/pub/select' + QS, { shopId: Number(shopId) });
  if (!r || r.error) return '';
  const d = r.json && r.json.data;
  return d ? String(d) : '';
}

/** 页面里找编辑器（主框架 + 同源 iframe 都翻一遍） */
function findEditorJs() {
  return `(function () {
    var roots = [document];
    try {
      var ifr = document.querySelectorAll('iframe');
      for (var i = 0; i < ifr.length; i++) {
        try { if (ifr[i].contentDocument) roots.push(ifr[i].contentDocument); } catch (e) {}
      }
    } catch (e) {}
    for (var n = 0; n < roots.length; n++) {
      var root = roots[n];
      var el = root.querySelector('pre[contenteditable="true"], div[contenteditable="true"], '
        + '[contenteditable="true"], textarea, input[type="text"]');
      if (el) {
        try { el.setAttribute('data-sdc-editor', '1'); } catch (e) {}
        return { found: true, tag: el.tagName, cls: String(el.className || '').slice(0, 80) };
      }
    }
    return { found: false };
  })()`;
}

/** 往编辑器里填内容（走 execCommand，React/Vue 受控组件也能收到 input 事件） */
function fillJs(text) {
  return `(function (text) {
    var el = document.querySelector('[data-sdc-editor="1"]');
    if (!el) return { ok: false, err: '编辑器丢失' };
    try { el.focus(); } catch (e) {}
    var isCE = el.getAttribute('contenteditable') === 'true' || el.tagName === 'PRE' || el.tagName === 'DIV';
    if (isCE) {
      try { document.execCommand('selectAll', false, null); } catch (e) {}
      try { document.execCommand('delete', false, null); } catch (e) {}
      try { document.execCommand('insertText', false, text); } catch (e) {}
    } else {
      try {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
        var setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    var got = String((el.innerText != null ? el.innerText : el.value) || '');
    return { ok: got.indexOf(String(text).slice(0, 8)) >= 0, len: got.length };
  })(${JSON.stringify(text)})`;
}

/** 点发送（按按钮文字找；找不到就发回车） */
function sendJs() {
  return `(function () {
    var btns = Array.from(document.querySelectorAll('button, [class*="btn"], [class*="send"]'));
    var hit = btns.filter(function (b) {
      var t = String((b.innerText || b.textContent || '')).trim();
      return /发送|Send/i.test(t) && t.length <= 6;
    })[0];
    if (hit) { hit.click(); return { by: 'button' }; }
    return { by: '' };
  })()`;
}

async function waitEditor(wc, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let info = { found: false };
  while (Date.now() < deadline) {
    info = await wc.executeJavaScript(findEditorJs(), true).catch(() => ({ found: false }));
    if (info && info.found) return info;
    await sleep(600);
  }
  return { found: false };
}

/** 会话里是否已出现这条消息（用于确认真的发出去了） */
async function hasText(wc, snippet) {
  const r = await wc.executeJavaScript(
    `(function (s) { try { return String(document.body.innerText || '').indexOf(s) >= 0; } catch (e) { return false; } })(${JSON.stringify(snippet)})`,
    true
  ).catch(() => false);
  return !!r;
}

/**
 * 批量催收：逐店打开客服会话 → 逐条打字发送 → 回执。
 * @param {object} task { taskId, items:[{shopId, shopName, contents:[string], orderSns:[]}], gapMs, dryRun }
 */
async function runSend(task, api) {
  const items = Array.isArray(task.items) ? task.items : [];
  if (!items.length) { api.report({ ok: false, error: '没有需要催收的店铺' }); return; }
  const dryRun = !!task.dryRun;
  const gap = Number(task.gapMs) || 6000;
  const results = [];
  const stopped = () => (api.isStopped ? api.isStopped() : false);

  let w = null;
  try { w = await getApiWindow(api); } catch (e) {
    api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); return;
  }
  const login = await probeLogin(w.webContents);
  if (!login.logined) {
    api.report({ ok: false, loginish: true, error: '本机浏览器里闪电帮帮未登录，请在助手窗口里登录后重试' });
    return;
  }

  const chat = getChatWindow();
  if (dryRun) api.log('演练模式：只会把内容填进会话输入框，**不会点发送**');

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (stopped()) break;
    const sid = await selectSession(w.webContents, it.shopId);
    if (!sid) {
      results.push({ ok: false, shopId: it.shopId, shopName: it.shopName, detail: '取不到会话 ID（店铺可能已关闭会话入口）' });
      api.log(`✗ ${it.shopName || it.shopId}：取不到会话 ID`);
      continue;
    }
    api.log(`▶ 第 ${i + 1}/${items.length} 家：${it.shopName || it.shopId}（会话 ${sid}），${it.contents.length} 条消息`);
    try {
      await chat.loadURL(`${CHAT_URL}?sessionId=${encodeURIComponent(sid)}`).catch(() => {});
      const ed = await waitEditor(chat.webContents, 25000);
      if (!ed || !ed.found) {
        results.push({ ok: false, shopId: it.shopId, shopName: it.shopName, detail: '聊天页输入框未就绪（可能被风控拦截或登录态失效）' });
        api.log(`✗ ${it.shopName || it.shopId}：输入框 25 秒内未出现`);
        continue;
      }
      let sent = 0;
      let lastErr = '';
      for (const content of it.contents) {
        if (stopped()) break;
        const filled = await chat.webContents.executeJavaScript(fillJs(content), true).catch(() => ({ ok: false, err: '填入失败' }));
        if (!filled || !filled.ok) { lastErr = (filled && filled.err) || '内容没能填入输入框'; break; }
        if (dryRun) {
          sent += 1;
          await sleep(600);
          continue;
        }
        const before = await hasText(chat.webContents, content.slice(0, 12));
        const s = await chat.webContents.executeJavaScript(sendJs(), true).catch(() => ({ by: '' }));
        if (!s || !s.by) {
          // 找不到发送按钮：多数 IM 支持 Enter 发送，退回到键盘事件
          await chat.webContents.executeJavaScript(
            `(function () {
              var el = document.querySelector('[data-sdc-editor="1"]');
              if (!el) return false;
              try { el.focus(); } catch (e) {}
              try {
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
              } catch (e) { return false; }
              return true;
            })()`, true
          ).catch(() => null);
        }
        let ok = false;
        for (let k = 0; k < 16; k += 1) {
          await sleep(500);
          if (await hasText(chat.webContents, content.slice(0, 12))) { ok = true; break; }
        }
        if (!ok && before) ok = true;   // 发之前聊天记录里已经有同样内容（重复催收）也算成功
        if (ok) { sent += 1; } else { lastErr = '发送后聊天记录里没找到这条消息'; break; }
        await sleep(900);
      }
      const okAll = sent === it.contents.length;
      results.push({
        ok: okAll, shopId: it.shopId, shopName: it.shopName,
        sent, total: it.contents.length, orderSns: it.orderSns || [], amount: it.amount || null,
        contents: dryRun ? [] : it.contents,
        detail: okAll ? `已发送 ${sent} 条${dryRun ? '（演练，未点发送）' : ''}` : (lastErr || `只发出 ${sent}/${it.contents.length} 条`),
      });
      api.log(`${okAll ? '✓' : '✗'} ${it.shopName || it.shopId}：${okAll ? `已发送 ${sent} 条` : (lastErr || '未完成')}`);
    } catch (e) {
      results.push({ ok: false, shopId: it.shopId, shopName: it.shopName, detail: String((e && e.message) || e).slice(0, 200) });
    }
    if (i < items.length - 1 && !stopped()) await sleep(gap);
  }

  const okCount = results.filter((r) => r.ok).length;
  api.report({
    ok: okCount > 0,
    results,
    okCount,
    failCount: results.length - okCount,
    dryRun,
    stopped: stopped(),
  });
}

function currentVersion() {
  try { return require('../../package.json').version || ''; } catch (e) { return ''; }
}

// ── 处理器工厂（main.js 注入 ws-client） ────────────────────────────
function createLoginHandler({ log = () => {} } = {}) {
  return async function handleSdcLogin(task, api) {
    try { await runLogin(task, api); }
    catch (e) { log('闪电帮帮登录异常: ' + ((e && e.message) || e)); api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
  };
}

function createFetchHandler({ log = () => {} } = {}) {
  return async function handleSdcFetch(task, api) {
    try { await runFetch(task, api); }
    catch (e) { log('闪电帮帮取数异常: ' + ((e && e.message) || e)); api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
  };
}

function createSendHandler({ log = () => {} } = {}) {
  return async function handleSdcSend(task, api) {
    try { await runSend(task, api); }
    catch (e) { log('闪电帮帮催收异常: ' + ((e && e.message) || e)); api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
  };
}

module.exports = {
  PARTITION, HOST, HOME_URL, CHAT_URL,
  createLoginHandler, createFetchHandler, createSendHandler,
  openLogin, peekWindow, peekApiWindow, peekChatWindow,
  probeLogin, runLogin, runFetch, runSend, selectSession,
};
