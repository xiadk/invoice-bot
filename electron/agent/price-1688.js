/**
 * electron/agent/price-1688.js — 1688 待付款订单「比价 + 打备注上色」（只跑在用户本机）
 *
 * 职责（两条任务，分别由 ws-client 的 price_fetch / price_apply 下行触发）：
 *   1) 抓取待付款订单   → 复用 1688 发送窗口（persist:1688 分区，与发消息共用登录态），
 *                        导航到「待付款」订单列表，逐页把订单（order_id/时间/运费/商品明细）
 *                        通过 api.stream() 一条条回给服务器；服务器端算判定并落库。
 *   2) 打备注上色       → 服务器把最近一次判定的行（orderId + memo_text + 三色 verdict）下发，
 *                        助手按订单号在列表里逐单找到，点备忘图标 → 选色 radio → 填备注文本 →
 *                        点确定保存，逐单 api.applied() 回报，服务器据此回填 price_check.applied_at。
 *
 * 帧模型：待付款订单渲染在子 iframe（buyer-order-list 内嵌 order-item 容器）+ 深 shadow DOM，
 *   与聊天发送同一套路 —— 递归遍历 webContents.mainFrame.frames 找到含 order-item 的帧，
 *   用 webContents/frame.executeJavaScript 注入 shadow DOM helper 后执行。所有点击一律用
 *   dispatchEvent（纯 JS），不做坐标鼠标点 —— 规避 iframe 坐标偏移，与 Python 版降压手段一致。
 *
 * 隐私边界：不接触、不保存 1688 账号密码/Cookie；登录态沿用发送窗口的分区。回传服务器的
 *   只有订单公开数据与「哪一单已上色」，不涉及敏感信息。
 *
 * v0.3.43 首版。
 */
const sender = require('./sender');

// 待付款订单列表页（与 Python 版同一 URL；tradeStatus=waitbuyerpay 即待买家付款）
const ORDER_LIST_URL = 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html'
  + '?tradeStatus=waitbuyerpay&page=1&pageSize=10';
// 翻页安全上限（待付款一般一页 10 单，20 页足够覆盖日常量）
const MAX_PAGES = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在指定 frame 里执行 JS，带超时（不注入额外 helper，由调用方拼好已是完整自执行脚本） */
async function execFrame(frame, code, timeoutMs, tag) {
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error((tag || '页面脚本') + ' 超时')), timeoutMs || 20000));
  try {
    const p = Promise.resolve().then(() => frame.executeJavaScript(code, true));
    return await Promise.race([p, timer]);
  } catch (e) {
    throw new Error(String((e && e.message) || e));
  }
}

/** 递归遍历 mainFrame 的帧，找第一个能在其中看到 order-item 的（即订单列表所在的子 iframe） */
async function findOrderFrame(wc, timeoutMs) {
  const t0 = Date.now();
  const walk = async (f) => {
    if (Date.now() - t0 > timeoutMs) return null;
    let url = '', kids = [];
    try { url = String(f.url || ''); kids = f.frames || []; } catch (e) { /* frame 可能已销毁 */ }
    // 只探测 1688 域内的帧，别去戳登录页等无关 frame
    if (/1688\.com/i.test(url)) {
      try {
        const has = await Promise.race([
          f.executeJavaScript('!!document.querySelector("order-item")', false),
          new Promise((r) => setTimeout(() => r(false), 3000)),
        ]);
        if (has) return f;
      } catch (e) { /* 该帧不可用，继续 */ }
    }
    for (const c of kids) { const r = await walk(c); if (r) return r; }
    return null;
  };
  try { return await walk(wc.mainFrame); } catch (e) { return null; }
}

// ── 注入 helper（移植 Python browser_operator.py 的 __findInShadow 等）──
const INJECT = `
  window.__pf = {};
  window.__pf.findInShadow = function (root, selector) {
    if (!root) return null;
    if (root.shadowRoot) {
      var el = root.shadowRoot.querySelector(selector);
      if (el) return el;
      var children = root.shadowRoot.querySelectorAll('*');
      for (var i = 0; i < children.length; i++) { var found = window.__pf.findInShadow(children[i], selector); if (found) return found; }
    }
    var el = root.querySelector(selector);
    if (el) return el;
    var children = root.querySelectorAll('*');
    for (var i = 0; i < children.length; i++) { if (children[i].shadowRoot) { var found = window.__pf.findInShadow(children[i], selector); if (found) return found; } }
    return null;
  };
  window.__pf.findAllInShadow = function (root, selector, results) {
    if (!results) results = [];
    if (!root) return results;
    if (root.shadowRoot) {
      var els = root.shadowRoot.querySelectorAll(selector);
      for (var i = 0; i < els.length; i++) results.push(els[i]);
      var children = root.shadowRoot.querySelectorAll('*');
      for (var i = 0; i < children.length; i++) window.__pf.findAllInShadow(children[i], selector, results);
    }
    var els = root.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) results.push(els[i]);
    var children = root.querySelectorAll('*');
    for (var i = 0; i < children.length; i++) { if (children[i].shadowRoot) window.__pf.findAllInShadow(children[i], selector, results); }
    return results;
  };
  window.__pf.deepAll = function (root) {
    root = root || document;
    var out = [], stack = [root];
    while (stack.length) {
      var r = stack.pop();
      var els; try { els = r.querySelectorAll('*'); } catch (e) { continue; }
      for (var i = 0; i < els.length; i++) { out.push(els[i]); if (els[i].shadowRoot) stack.push(els[i].shadowRoot); }
    }
    return out;
  };
  window.__pf.text = function (el) { try { return (el && (el.innerText !== undefined ? el.innerText : el.textContent)) || ''; } catch (e) { return ''; } };
  // 点击元素（shadow 穿透）并等待事件循环有机会消化一次
  window.__pf.click = function (el) {
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r && r.width === 0 && r.height === 0) el.scrollIntoView({ block: 'center' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    } catch (e) { return false; }
  };
`;

/** 抓取当前页全部待付款订单（一次性 evaluate 返回数组），移植 order_parser.extract_orders_from_page */
const SCRAPE_ORDERS = `
  (function () {
    var items = window.__pf.deepAll(document).filter(function (e) { return e.tagName === 'ORDER-ITEM'; });
    var orders = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var all = window.__pf.deepAll(it);
      function firstClass(cls) {
        for (var k = 0; k < all.length; k++) { var c = String(all[k].className || ''); if (c.indexOf(cls) >= 0) return all[k]; }
        return null;
      }
      var order = { order_id: '', order_time: '', total_price: 0, freight: 0, is_free_shipping: true, has_memo: false, memo_color: '', products: [] };
      // 订单号取自 copy-to-clipboard 内的一串 15 位以上数字
      var cc = window.__pf.findAllInShadow(it, 'copy-to-clipboard')[0];
      if (cc) { var m = /(\\d{15,})/.exec(window.__pf.text(cc)); if (m) order.order_id = m[1]; }
      // 下单时间 / 总价 / 运费
      var t = firstClass('order-time'); if (t) order.order_time = window.__pf.text(t).trim();
      var tp = firstClass('total-price'); if (tp) { var mm = /[\\d.]+/.exec(window.__pf.text(tp).replace(/¥/g, '')); order.total_price = mm ? parseFloat(mm[0]) : 0; }
      var ca = firstClass('carriage'); if (ca) {
        var ft = window.__pf.text(ca).trim();
        if (ft.indexOf('包邮') >= 0) { order.freight = 0; order.is_free_shipping = true; }
        else { var fm = /含运费\\s*([\\d.]+)/.exec(ft); if (fm) { order.freight = parseFloat(fm[1]); order.is_free_shipping = false; } }
      }
      // 备忘标记
      var memo = window.__pf.findAllInShadow(it, 'icon-memo')[0];
      if (memo) { order.has_memo = true; order.memo_color = memo.getAttribute('color') || ''; }
      // 商品明细
      var entries = all.filter(function (e) { var c = String(e.className || ''); return c.indexOf('order-item-entry') >= 0; });
      for (var j = 0; j < entries.length; j++) {
        var en = entries[j];
        var eall = window.__pf.deepAll(en);
        var prod = { link: '', name: '', spec: '', unit_price: 0, quantity: 0, entry_id: '' };
        var nl = null;
        for (var k = 0; k < eall.length; k++) { if (eall[k].tagName === 'A' && String(eall[k].className || '').indexOf('product-name') >= 0) { nl = eall[k]; break; } }
        if (nl) {
          var href = nl.getAttribute('href') || '';
          var lmm = /(https:\\/\\/detail\\.1688\\.com\\/offer\\/\\d+\\.html)/.exec(href);
          prod.link = lmm ? lmm[1] : href;
          prod.name = window.__pf.text(nl).trim();
        }
        // 规格：.sku-info-item 列表，拼成 "键: 值  键2: 值2"
        var specs = [];
        for (var k = 0; k < eall.length; k++) { var c = String(eall[k].className || ''); if (c.indexOf('sku-info-item') >= 0) { var s = window.__pf.text(eall[k]).trim(); if (s) specs.push(s); } }
        if (specs.length) {
          var parts = [];
          for (var s = 0; s < specs.length; s++) {
            var seg = specs[s];
            var mm2 = /^(.+?):\\s*(.+)$/.exec(seg);
            var val = mm2 ? mm2[2] : seg;
            parts.push(val);
          }
          prod.spec = parts.join(' ');
        }
        var up = null;
        for (var k = 0; k < eall.length; k++) { var c2 = String(eall[k].className || ''); if (c2.indexOf('actual-unit-price') >= 0) { up = eall[k]; break; } }
        if (up) { var um = /[\\d.]+/.exec(window.__pf.text(up).replace(/¥/g, '')); prod.unit_price = um ? parseFloat(um[0]) : 0; }
        var q = null;
        for (var k = 0; k < eall.length; k++) { var c3 = String(eall[k].className || ''); if (c3.indexOf('quantity-amount') >= 0) { q = eall[k]; break; } }
        if (q) { var qq = /[\\d]+/.exec(window.__pf.text(q).trim()); prod.quantity = qq ? parseInt(qq[0], 10) : 0; }
        prod.entry_id = en.getAttribute('data-entry-id') || '';
        order.products.push(prod);
      }
      orders.push(order);
    }
    return orders;
  })()
`;

/** 是否还有下一页（底部分页器 next 未禁用） */
const HAS_NEXT = `
  (function () {
    var pages = window.__pf.findAllInShadow(document, 'q-pagination');
    if (!pages || !pages.length) return false;
    var p = pages[pages.length - 1];
    var next = window.__pf.findInShadow(p, 'button.ui-page-next');
    if (!next) return false;
    return next.getAttribute('disabled') !== 'true';
  })()
`;

/** 点下一页 */
const GO_NEXT = `
  (function () {
    var pages = window.__pf.findAllInShadow(document, 'q-pagination');
    if (!pages || !pages.length) return { ok: false, msg: 'no-pagination' };
    var p = pages[pages.length - 1];
    var next = window.__pf.findInShadow(p, 'button.ui-page-next');
    if (!next) return { ok: false, msg: 'no-button' };
    if (next.getAttribute('disabled') === 'true') return { ok: false, msg: 'disabled' };
    window.__pf.click(next);
    pages = window.__pf.findAllInShadow(document, 'q-pagination');
    var cur = 1;
    if (pages.length) { var pp = pages[pages.length - 1]; cur = parseInt(pp.getAttribute('current') || '1', 10); }
    return { ok: true, page: cur };
  })()
`;

/** 展开所有折叠商品（点「展开更多」按钮），直到点无可点 */
const EXPAND_FOLDED = `
  (function () {
    var maxClicks = 50, clicked = 0;
    for (var n = 0; n < maxClicks; n++) {
      var items = window.__pf.deepAll(document).filter(function (e) { return e.tagName === 'ORDER-ITEM'; });
      var done = true;
      for (var i = 0; i < items.length; i++) {
        var btn = window.__pf.findInShadow(items[i], '.expend-btn');
        if (!btn) continue;
        var txt = window.__pf.text(btn);
        if (txt.indexOf('展开') < 0) continue;
        btn.scrollIntoView({ block: 'center' });
        window.__pf.click(btn);
        clicked++; done = false;
        if (clicked >= maxClicks) return clicked;
      }
      if (done) break;
    }
    return clicked;
  })()
`;

/**
 * 在可见的备忘对话框里点选某个颜色的 radio（q-radio[value]），再填备注文本并点确定。
 * value: 2=蓝  3=绿  4=黄（橙 index=1 已按需求去掉）
 */
const SET_MARK = `
  (function (colorValue, memoText) {
    function visibleDialog() {
      var ds = document.querySelectorAll('q-dialog.dialog-memo');
      for (var i = 0; i < ds.length; i++) if (ds[i].getAttribute('visible') === 'true') return ds[i];
      return null;
    }
    function dialogsVisible() {
      var ds = document.querySelectorAll('q-dialog.dialog-memo');
      for (var i = 0; i < ds.length; i++) if (ds[i].getAttribute('visible') === 'true') return true;
      return false;
    }
    var dlg = visibleDialog();
    if (!dlg) return { ok: false, step: 'no-dialog' };
    // 1) 选中颜色 radio
    var radio = window.__pf.findInShadow(dlg, 'q-radio[value="' + colorValue + '"]');
    if (!radio) radio = dlg.querySelector('q-radio[value="' + colorValue + '"]');
    if (radio) {
      radio.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      var inner = radio.shadowRoot ? radio.shadowRoot.querySelector('input, label, [role="radio"]') : (radio.querySelector('input, label') || null);
      if (inner) inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    // 2) 填备注文本（先清空）
    var qta = window.__pf.findInShadow(dlg, 'q-textarea');
    if (!qta) qta = dlg.querySelector('q-textarea');
    var ta = qta ? (qta.shadowRoot ? qta.shadowRoot.querySelector('textarea') : qta.querySelector('textarea')) : null;
    if (ta) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, memoText || '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // 3) 点确定（自定义 .memo-footer 最后一个 q-button；兜底 .q-dialog-ok-btn）
    var footer = dlg.querySelector('.memo-footer');
    var okBtn = null;
    if (footer) {
      var btns = window.__pf.findAllInShadow(footer, 'q-button');
      if (btns.length) okBtn = btns[btns.length - 1];
    }
    if (!okBtn && dlg.shadowRoot) okBtn = dlg.shadowRoot.querySelector('.q-dialog-ok-btn');
    if (okBtn) { okBtn.scrollIntoView({ block: 'center' }); window.__pf.click(okBtn); }
    return { ok: true, pickedRadio: !!radio, pickedTextarea: !!ta, pickedOk: !!okBtn, stillOpenAfter: dialogsVisible() };
  })
`;

// ── 打开/复用 1688 待付款列表，返回 { win, frame } ──
async function openPendingList(api, win) {
  win.show();
  const wc = win.webContents;
  api.log('打开 1688「待付款订单」列表…');
  let lastErr = null;
  for (let retry = 0; retry < 3; retry++) {
    try {
      await Promise.race([wc.loadURL(ORDER_LIST_URL), sleep(45000)]);
    } catch (e) { /* SPA 常见：did-finish-load 迟迟不触发，继续按 frame 探测 */ }
    // 等订单列表所在子 iframe 出现（未登录会长时间停在登录态，判超时）
    let frame = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      frame = await findOrderFrame(wc, 4000);
      if (frame) {
        // 注入 helper 后探一探 order-item 是否真的渲染出来了
        try {
          const n = await Promise.race([
            frame.executeJavaScript(INJECT + '; window.__pf.deepAll(document).filter(function(e){return e.tagName==="ORDER-ITEM";}).length', true),
            new Promise((r) => setTimeout(() => r(-1), 8000)),
          ]);
          if (Number(n) >= 0) {
            api.log(`订单列表已加载（本页 ${n} 单）`);
            return { win, frame, wc };
          }
        } catch (e) { frame = null; }
      }
      if (api.isStopped && api.isStopped()) throw new Error('已取消');
      await sleep(1500);
    }
    lastErr = '订单列表未渲染（可能未登录 1688 或页面改版）';
    api.log('订单列表未出现，刷新重试…');
    try { await wc.reload(); } catch (e) { /* 忽略 */ }
    await sleep(3000);
  }
  throw new Error(lastErr || '订单列表加载失败');
}

/** 抓取整个列表（多页），逐单 api.stream 回传；返回抓到订单数 */
async function scrapeAllPages(api, frame) {
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    try { await execFrame(frame, INJECT, 10000, '注入 helper'); } catch (e) { /* 注入失败继续，页面可能整体无 shadow */ }
    try { const x = await execFrame(frame, EXPAND_FOLDED, 15000, '展开折叠'); if (x) api.log(`展开折叠商品 ×${x}`); } catch (e) {}
    let orders = [];
    try { orders = await execFrame(frame, SCRAPE_ORDERS, 15000, '抓取订单'); } catch (e) { api.log('抓取本页订单失败: ' + e.message); }
    if (!orders.length) { api.log(`第 ${page} 页无订单，结束`); break; }
    for (const o of orders) {
      if (api.isStopped && api.isStopped()) throw new Error('已取消');
      await api.stream(o); // 逐单回传服务器（服务器端累加并计入批次）
      total++;
    }
    api.log(`已抓取第 ${page} 页，累计 ${total} 单`);
    // 翻页
    let hasNext = false;
    try { hasNext = !!await execFrame(frame, HAS_NEXT, 8000, '判断下一页'); } catch (e) {}
    if (!hasNext) break;
    const gp = await execFrame(frame, GO_NEXT, 8000, '翻页').catch(() => ({ ok: false }));
    if (!gp || !gp.ok) { api.log('翻页失败或无下一页，结束'); break; }
    // 等页内 order-item 刷新
    for (let w = 0; w < 40; w++) {
      let n = -1;
      try {
        n = await execFrame(frame, `window.__pf.deepAll(document).filter(function(e){return e.tagName==="ORDER-ITEM";}).length`, 8000, '等渲染')
          .catch(() => -1);
      } catch (e) {}
      if (Number(n) > 0) break;
      await sleep(500);
    }
  }
  return total;
}

/** 在列表（多页）里按订单号找 order-item 的索引并点击其备忘图标；返回 null 表示未找到 */
async function findAndOpenMemo(api, frame, orderId) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    try { await execFrame(frame, INJECT, 6000, '注入 helper'); } catch (e) {}
    try { await execFrame(frame, EXPAND_FOLDED, 10000, '展开折叠'); } catch (e) {}
    // 当前页找目标订单的下标
    const hit = await execFrame(frame, `
      (function () {
        var items = window.__pf.deepAll(document).filter(function (e) { return e.tagName === 'ORDER-ITEM'; });
        for (var i = 0; i < items.length; i++) {
          var cc = window.__pf.findAllInShadow(items[i], 'copy-to-clipboard')[0];
          if (!cc) continue;
          var m = /(\\d{15,})/.exec(window.__pf.text(cc));
          if (m && m[1] === ${JSON.stringify(orderId)}) return { index: i, total: items.length };
        }
        return null;
      })()
    `, 10000, '定位订单').catch(() => null);
    if (hit && hit.index != null) {
      // 滚动 + dispatchEvent 点击该订单的 icon-edit/icon-memo
      const r = await execFrame(frame, `
        (function (idx) {
          var items = window.__pf.deepAll(document).filter(function (e) { return e.tagName === 'ORDER-ITEM'; });
          var order = items[idx];
          if (!order) return 'no-order';
          var icon = window.__pf.findInShadow(order, 'icon-edit') || window.__pf.findInShadow(order, 'icon-memo') || null;
          if (!icon) return 'no-icon';
          icon.scrollIntoView({ block: 'center' });
          window.__pf.click(icon);
          return 'clicked';
        })(${JSON.stringify(hit.index)})
      `, 10000, '点备忘图标').catch((e) => e.message);
      // 等备忘对话框打开
      for (let w = 0; w < 20; w++) {
        await new Promise((res) => setTimeout(res, 300));
        const vis = await execFrame(frame, `(function(){var ds=document.querySelectorAll('q-dialog.dialog-memo');for(var i=0;i<ds.length;i++){if(ds[i].getAttribute('visible')==='true')return true;}return false;})()`, 6000, '等弹窗').catch(() => false);
        if (vis) return true;
      }
      api.log('备忘对话框未打开，已停止对该单操作');
      return false;
    }
    // 本页没有 → 翻页
    const hasNext = await execFrame(frame, HAS_NEXT, 6000, '判断下一页').catch(() => false);
    if (!hasNext) return null;
    await execFrame(frame, GO_NEXT, 6000, '翻页').catch(() => {});
    for (let w = 0; w < 40; w++) {
      const n = await execFrame(frame, `window.__pf.deepAll(document).filter(function(e){return e.tagName==="ORDER-ITEM";}).length`, 6000, '等渲染').catch(() => -1);
      if (Number(n) > 0) break;
      await sleep(500);
    }
  }
  return null;
}

const COLOR_VALUE = { blue: '2', green: '3', yellow: '4' };

/** 抓取 handler：ws-client 下行 price_fetch 触发 */
function createFetchHandler({ log = (m) => {} } = {}) {
  return async (m, api) => {
    log('开始抓取 1688 待付款订单…');
    const st = sender.state ? sender.state() : {};
    if (st.sending) throw new Error('正在发送催收消息，请等发送完成后再比价');
    const win = sender.getSendWindow();
    const { frame } = await openPendingList(api, win);
    try {
      const count = await scrapeAllPages(api, frame);
      log(`待付款订单抓取完成，共 ${count} 单`);
      return count; // ws-client 据此回 price_fetch_done
    } finally {
      // 不关窗口：用户可能想核对页面。返回空包即代表任务结束。
    }
  };
}

/**
 * 打备注上色 handler：ws-client 下行 price_apply 触发。
 * m.orders = [{ orderId, verdict, memoText }]
 */
function createApplyHandler({ log = (m) => {} } = {}) {
  return async (m, api) => {
    const orders = Array.isArray(m.orders) ? m.orders : [];
    log(`开始到 1688 打备注上色，共 ${orders.length} 单…`);
    if (!orders.length) return 0;
    const st = sender.state ? sender.state() : {};
    if (st.sending) throw new Error('正在发送催收消息，请等发送完成后再上色');
    const win = sender.getSendWindow();
    const { frame } = await openPendingList(api, win);

    let handled = 0, ok = 0, fail = 0, skipped = 0;
    for (const t of orders) {
      if (api.isStopped && api.isStopped()) break;
      const colorValue = COLOR_VALUE[t.verdict] || COLOR_VALUE.blue;
      try {
        const found = await findAndOpenMemo(api, frame, t.orderId);
        if (found === null) {
          api.applied(t.orderId, false, '列表未找到该订单');
          fail++;
        } else if (found === false) {
          api.applied(t.orderId, false, '备忘对话框未打开');
          fail++;
        } else {
          const r2 = await execFrame(frame, INJECT + ';' + SET_MARK + `(${JSON.stringify(colorValue)},${JSON.stringify(t.memoText)})`, 25000, '打备注上色')
            .catch((e) => ({ ok: false, step: 'exec-err:' + e.message }));
          if (r2 && r2.ok) { api.applied(t.orderId, true); ok++; }
          else { api.applied(t.orderId, false, (r2 && r2.step) || '上色失败'); fail++; }
        }
      } catch (e) {
        api.applied(t.orderId, false, String((e && e.message) || e).slice(0, 120));
        fail++;
      }
      handled++;
      log(`上色进度 ${handled}/${orders.length}：成功 ${ok}，失败 ${fail}`);
      if (api.gapMs) await api.sleep();
      // 对话框可能还开着，兜底关掉避免影响下一单
      await execFrame(frame, `(function(){var ds=document.querySelectorAll('q-dialog.dialog-memo');var c=0;for(var i=0;i<ds.length;i++){if(ds[i].getAttribute('visible')==='true'){ds[i].setAttribute('visible','false');c++;}}return c;})()`, 5000, '兜底关弹窗').catch(() => {});
    }
    try { await execFrame(frame, `(function(){var ds=document.querySelectorAll('q-dialog.dialog-memo');var c=0;for(var i=0;i<ds.length;i++){if(ds[i].getAttribute('visible')==='true'){ds[i].setAttribute('visible','false');c++;}}return c;})()`, 5000, '兜底关弹窗').catch(() => {}); } catch (e) {}
    log(`打备注上色完成：成功 ${ok}，失败 ${fail}`);
    return { handled, ok, fail };
  };
}

module.exports = { createFetchHandler, createApplyHandler, ORDER_LIST_URL };
