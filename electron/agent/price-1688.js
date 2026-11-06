/**
 * electron/agent/price-1688.js — 1688 待付款订单「比价 + 打备注上色」（只跑在用户本机）
 *
 * 职责（两条任务，分别由 ws-client 的 price_fetch / price_apply 下行触发）：
 *   1) 抓取待付款订单   → 复用 1688 发送窗口（persist:1688 分区，与发消息共用登录态），
 *                        在「已买到的货品」订单列表页**用页面自己的筛选控件**设置
 *                        下单时间起止 + 订单状态「待付款」→ 搜索 → 逐页抓 ORDER-ITEM，
 *                        通过 api.stream() 一条条回给服务器；服务器端算判定并落库。
 *   2) 打备注上色       → 服务器把最近一次判定的行（orderId + memo_text + 三色 verdict）下发，
 *                        助手按订单号在列表里逐单找到，点备忘图标 → 选色 radio → 填备注文本 →
 *                        点确定保存，逐单 api.applied() 回报，服务器据此回填 price_check.applied_at。
 *
 * ⚠ v0.3.47：不再靠 URL 参数 tradeStatus=waitbuyerpay 过滤（新版页面由 ORDER-SEARCH-*
 *   组件驱动，URL 参数不生效），也不再遍历子 iframe 找 ORDER-ITEM —— 曾误命中
 *   g.alicdn.com/platform/xdomain-storage 的无关 iframe，页面刚加载 1 秒就把 0 单当正常收尾，
 *   线上表现为「助手已打开订单列表，却报未抓取到待付款订单」。
 *   改为与「导入/同步 1688 订单」（electron/agent/order-export.js）同口径：直接在主 frame
 *   用 wc.executeJavaScript + deepAll 穿透 shadow DOM，靠日历点选与状态下拉筛选，
 *   并等 ORDER-ITEM 真正渲染出来后才开始抓；只有页面明确空态才按 0 单正常收尾。
 *
 * 隐私边界：不接触、不保存 1688 账号密码/Cookie；登录态沿用发送窗口的分区。回传服务器的
 *   只有订单公开数据与「哪一单已上色」，不涉及敏感信息。
 *
 * v0.3.43 首版；v0.3.47 改为页面筛选 + 主 frame 抓取。
 */
const sender = require('./sender');
const orderExport = require('./order-export');

// 翻页安全上限（一页一般 10~20 单，20 页足够覆盖单月范围）
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

// ── 页面就绪判定 / 二次过滤（v0.3.47）────────────────────────────────────

/** 页面明确空态：组件把「暂无订单」渲染在 shadow DOM 里，必须 deepAll 收集文本 */
const PROBE_EMPTY = `(function(){
  var els = window.__qexp.deepAll(), out = [];
  for (var i = 0; i < els.length; i++) {
    var s = '';
    try { s = ((els[i].innerText === undefined ? els[i].textContent : els[i].innerText) || '').trim(); } catch (e) {}
    if (s && s.length < 60) out.push(s);
  }
  return /暂无订单|没有找到|无符合条件|暂无数据|没有相关订单|未查询到|无匹配/.test(out.join(' ')) ? 1 : 0;
})()`;

/** 当前主 frame 里的订单卡片数（穿透 shadow DOM） */
const COUNT_ITEMS = `window.__qexp.deepAll().filter(function(e){return e.tagName==='ORDER-ITEM';}).length`;

/**
 * 等主 frame 真的渲染出 ORDER-ITEM。
 * 只有页面明确空态才返回 false（= 范围内确实 0 单）；未渲染就一直等，超时直接抛错，
 * 不再像 v0.3.46 那样「加载 1 秒看到 0 单就当正常收尾」。
 */
async function waitForOrderItems(wc, api, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    let n = -1;
    try { n = await execFrame(wc, COUNT_ITEMS, 8000, '查订单数'); } catch (e) { /* 页面切换中，下一轮再试 */ }
    if (Number(n) > 0) { api.log(`订单列表已渲染（本页 ${n} 单）`); return true; }
    let empty = 0;
    try { empty = await execFrame(wc, PROBE_EMPTY, 8000, '查空态'); } catch (e) { /* 忽略，继续等 */ }
    if (Number(empty) === 1) { api.log('页面明确显示「暂无订单」，该时间范围内没有待付款订单'); return false; }
    if (Date.now() - t0 > (timeoutMs || 60000)) {
      throw new Error('订单列表 60 秒内未渲染出订单卡片（请检查 1688 登录态、筛选条件或页面是否改版）');
    }
    if (api.isStopped && api.isStopped()) throw new Error('已取消');
    await sleep(1500);
  }
}

/**
 * 二次过滤：页面筛选是主，这里按抓到的状态文本 / 下单时间再兜一层。
 * 状态文本识别不出来时不丢弃（避免误杀整页订单），此时只依赖页面状态下拉。
 */
function filterOrders(orders, opts, api) {
  const kept = [];
  let dropStatus = 0, dropDate = 0;
  for (const o of orders) {
    const st = String(o.status_text || '').trim();
    if (st && !/待付款|待支付|等待买家付款/.test(st)) { dropStatus++; continue; }
    const dm = /(\d{4}-\d{2}-\d{2})/.exec(String(o.order_time || ''));
    if (dm && opts.dateStart && opts.dateEnd && (dm[1] < opts.dateStart || dm[1] > opts.dateEnd)) { dropDate++; continue; }
    kept.push(o);
  }
  if (dropStatus || dropDate) api.log(`二次过滤：非待付款 ${dropStatus} 单、超出下单时间范围 ${dropDate} 单`);
  return kept;
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
      var order = { order_id: '', order_time: '', status_text: '', total_price: 0, freight: 0, is_free_shipping: true, has_memo: false, memo_color: '', products: [] };
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
      // 订单状态文本（页面筛选是主，这里用于二次过滤；状态文字可能藏在 shadow DOM 里）
      var itText = [];
      for (var z = 0; z < all.length; z++) {
        var s = window.__pf.text(all[z]).trim();
        if (s && s.length < 60) itText.push(s);
      }
      var sm = /(待付款|待支付|等待买家付款|交易关闭|交易成功|已付款|已发货|待收货|已取消)/.exec(itText.join(' '));
      if (sm) order.status_text = sm[1];
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

/** 找「下一页」控件：优先 q-pagination，兜底页面里可见的「下一页」文本元素 */
const FIND_NEXT_HELPER = `
  function __pfNext() {
    var pages = window.__pf.findAllInShadow(document, 'q-pagination');
    if (pages && pages.length) {
      var next = window.__pf.findInShadow(pages[pages.length - 1], 'button.ui-page-next');
      if (next) return next;
    }
    var els = window.__pf.deepAll(document);
    for (var i = 0; i < els.length; i++) {
      var e = els[i], t = window.__pf.text(e).trim();
      if (t !== '下一页' && t !== '下页') continue;
      var r = e.getBoundingClientRect ? e.getBoundingClientRect() : null;
      if (r && r.width === 0 && r.height === 0) continue;
      return e;
    }
    return null;
  }
  function __pfNextDisabled(n) {
    if (!n) return true;
    var d = n.getAttribute ? String(n.getAttribute('disabled') || '') : '';
    return d === 'true' || d === 'disabled' || n.disabled === true;
  }
`;

/** 是否还有下一页 */
const HAS_NEXT = `(function(){ ${FIND_NEXT_HELPER}
  var n = __pfNext(); return !!n && !__pfNextDisabled(n);
})()`;

/** 点下一页 */
const GO_NEXT = `(function(){ ${FIND_NEXT_HELPER}
  var n = __pfNext();
  if (!n) return { ok: false, msg: 'no-next' };
  if (__pfNextDisabled(n)) return { ok: false, msg: 'disabled' };
  window.__pf.click(n);
  return { ok: true };
})()`;

/** 本页第一单的订单号：翻页后等它变化，避免在旧数据上重复抓一遍 */
const FIRST_ORDER_ID = `(function(){
  var items = window.__pf.deepAll(document).filter(function(e){return e.tagName==='ORDER-ITEM';});
  if (!items.length) return '';
  var cc = window.__pf.findAllInShadow(items[0], 'copy-to-clipboard')[0];
  if (!cc) return '';
  var m = /(\\d{15,})/.exec(window.__pf.text(cc));
  return m ? m[1] : '';
})()`;

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

// ── 打开/复用 1688 订单列表，用页面控件按下单时间 + 待付款筛选（v0.3.47）──
/**
 * 复用 electron/agent/order-export.js 的同一套页面操作（主 frame + shadow DOM 穿透）：
 * 打开「已买到的货品」→ 关引导弹窗 → 清除选项 → 日历设下单时间起止 →
 * 订单状态选「待付款」→ 搜索 → 等 ORDER-ITEM 真正渲染。
 * @returns {{win, wc, empty}} empty=true 表示页面明确显示「暂无订单」
 */
async function openFilteredList(api, opts = {}) {
  const dateStart = String(opts.dateStart || '').trim();
  const dateEnd = String(opts.dateEnd || '').trim();
  const hasRange = /^\d{4}-\d{2}-\d{2}$/.test(dateStart) && /^\d{4}-\d{2}-\d{2}$/.test(dateEnd);
  api.log('打开 1688 订单列表（主 frame · 页面筛选）…');
  // 与「导入/同步 1688 订单」共用入口：同一个窗口、同一份登录态、同一套主 frame 助手
  const { win, wc } = await orderExport.openOrderPage(api);
  // 导航会清掉 window.__qexp，兜底再注入一次
  await execFrame(wc, orderExport.PAGE_HELPERS, 10000, '注入助手').catch(() => {});
  // 0) 关掉「AI订单巡检」引导弹窗（首次进入会有，可能挡住后续点击）
  await execFrame(wc, `(function(){
    var h = window.__qexp.byText('跳过', 2, true);
    if (h.length) { try { h[0].click(); return 'skipped'; } catch (e) {} }
    return 'none';
  })()`, 10000, '关引导弹窗').catch(() => {});
  await sleep(800);
  // 1) 清除既有筛选，避免残留条件混入本次抓取
  api.log('清除既有筛选条件…');
  await execFrame(wc, `window.__qexp.clickText('清除选项')`, 10000, '清除选项').catch(() => false);
  await sleep(1500);
  // 2) 下单时间范围（日历点选 + 回读校验，直接写 value 会被组件重渲染清掉）
  if (hasRange) {
    api.log(`设置下单时间：${dateStart} ~ ${dateEnd}`);
    await orderExport.setDateRange(wc, dateStart, dateEnd, api);
  } else {
    api.log('⚠ 本次没有有效的下单时间范围，跳过日历筛选（按页面当前条件抓取）');
  }
  // 3) 订单状态 → 待付款；个别版本下拉结构不同，失败不致命（抓完再按状态文本过滤）
  try { await orderExport.pickSelect(wc, 'trade-status', '待付款', api); }
  catch (e) { api.log(`⚠ 订单状态下拉未选到「待付款」（${e.message}），改由抓取结果按状态文本过滤`); }
  // 4) 搜索（按钮文字是「搜索」不是「查询」）
  api.log('应用筛选（搜索）…');
  const clicked = await execFrame(wc, `window.__qexp.clickText('搜索')`, 10000, '搜索').catch(() => false);
  if (!clicked) api.log('⚠ 未找到「搜索」按钮，按页面当前结果继续');
  await sleep(2500);
  if (api.isStopped && api.isStopped()) throw new Error('已取消');
  // 5) 等订单卡片真正出现（只有明确空态才按 0 单收尾）
  const empty = !await waitForOrderItems(wc, api, 60000);
  return { win, wc, empty };
}

/** 抓取整个列表（多页），逐单 api.stream 回传；返回抓到订单数 */
async function scrapeAllPages(api, frame, opts = {}) {
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    try { await execFrame(frame, INJECT, 10000, '注入 helper'); } catch (e) { /* 注入失败继续，页面可能整体无 shadow */ }
    try { const x = await execFrame(frame, EXPAND_FOLDED, 15000, '展开折叠'); if (x) api.log(`展开折叠商品 ×${x}`); } catch (e) {}
    let orders = [];
    try { orders = await execFrame(frame, SCRAPE_ORDERS, 15000, '抓取订单'); } catch (e) { api.log('抓取本页订单失败: ' + e.message); }
    orders = filterOrders(Array.isArray(orders) ? orders : [], opts, api);
    if (!orders.length) { api.log(`第 ${page} 页没有「待付款且在下单时间范围内」的订单，结束`); break; }
    const firstId = String((orders[0] && orders[0].order_id) || '');
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
    // 等页内数据真正换页（旧逻辑只等「数量>0」，会在旧数据上重复抓一遍）
    if (firstId) {
      let changed = false;
      for (let w = 0; w < 40; w++) {
        let id = '';
        try { id = String(await execFrame(frame, FIRST_ORDER_ID, 8000, '等翻页') || ''); } catch (e) {}
        if (id && id !== firstId) { changed = true; break; }
        await sleep(500);
      }
      if (!changed) { api.log('翻页后订单列表未刷新，结束翻页'); break; }
    } else {
      // 没抓到订单号（页面改版）时退回固定等待，宁可少翻一页也不要重复抓
      await sleep(2000);
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

/** 抓取 handler：ws-client 下行 price_fetch 触发（m 带 dateStart / dateEnd） */
function createFetchHandler({ log = (m) => {} } = {}) {
  return async (m, api) => {
    const dateStart = String(m.dateStart || '').trim();
    const dateEnd = String(m.dateEnd || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart) || !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) {
      throw new Error('缺少下单时间范围：请在看板「开始核对」里选择日期（助手需 0.3.47 及以上）');
    }
    log(`开始抓取 1688 待付款订单（下单时间 ${dateStart} ~ ${dateEnd}）…`);
    const st = sender.state ? sender.state() : {};
    if (st.sending) throw new Error('正在发送催收消息，请等发送完成后再比价');
    const { wc, empty } = await openFilteredList(api, { dateStart, dateEnd });
    if (empty) { log('该下单时间范围内没有待付款订单'); return 0; }
    const count = await scrapeAllPages(api, wc, { dateStart, dateEnd });
    log(`待付款订单抓取完成，共 ${count} 单`);
    return count; // ws-client 据此回 price_fetch_done
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
    // 与抓取共用同一套页面筛选：服务端把这批订单的下单时间范围一并下发
    const { wc, empty } = await openFilteredList(api, { dateStart: m.dateStart, dateEnd: m.dateEnd });
    if (empty) {
      log('筛选后列表没有订单，无法上色');
      for (const t of orders) api.applied(t.orderId, false, '筛选后列表无订单');
      return { handled: 0, ok: 0, fail: orders.length };
    }
    const frame = wc;

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

module.exports = { createFetchHandler, createApplyHandler };
