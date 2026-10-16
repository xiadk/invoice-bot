/**
 * electron/agent/order-export.js — 「导入1688订单数据」的助手端执行内核
 *
 * 流程：打开 1688 订单列表页（已买到的货品·全部订单）→ 关引导弹窗 → 清除旧筛选 →
 * 用「日历点选」设置下单时间起止 → 订单状态/订单类型/支付方式=全部 → 搜索 →
 * 点「导出当前条件」→ 弹窗点「生成新报表」→ 轮询报表历史（刷新→最新行导出成功→
 * 点该行下载）→ 把文件回传服务器（/api/agent/upload-orders，设备令牌鉴权），
 * 服务端复用「重新导入数据」的解析入库逻辑。
 *
 * 页面结构（2026-10-16 真机实测，全部验证过，勿凭想象改）：
 *   · Quark Web Components（Q-SELECT/Q-DATE/Q-BUTTON），内容在 Shadow DOM 里，
 *     必须用穿透查询（deepAll 递归 shadowRoot）
 *   · 下单时间：Q-SELECT(select-order-date) footer 的 custom-date-range 里
 *     Q-DATE(date-start/date-end)，三层嵌套 q-date → q-date-time → ui-datetime
 *   · ⚠ 直接写 value 属性会被组件重渲染清掉 —— 必须点开日历弹层（ui.click()），
 *     点 .ui-date-item（title/data-date=YYYY-MM-DD）让组件自己走完整流程
 *   · ⚠「生成新报表」等文本在页面里常有【隐藏重复元素】（导出历史视图预渲染在
 *     DOM 里）—— 点击必须只点「可见」元素（getBoundingClientRect 有尺寸），
 *     否则点到隐藏元素毫无反应（2026-10-16 实测踩坑：连续 4 轮测试全栽在这）
 *   · 「生成新报表」要点 host + 内部 .q-button 两层：host 触发数据动作（创建
 *     报表），内部元素驱动弹窗切到历史视图；弹窗没切可用「查看过往导出报表」兜底
 *   · ⚠ 点「生成新报表」前必须先点过「搜索」（要有查询上下文），否则点击完全无效
 *   · 点「生成新报表」成功后报表出现在导出历史第一行，状态「导出中」约 1 分钟；
 *     ⚠ 视图不会自动刷新，必须点「刷新」
 *   · 历史表格以可见的「申请时间」表头定位容器；「下载」是真链接（A 元素），
 *     要点「最深层」的下载元素（TD 的 innerText 也是"下载"，点 TD 无效）
 *   · 搜索按钮文字是「搜索」不是「查询」
 *   · 首次进入有「AI订单巡检」引导弹窗（1/3），先点「跳过」
 *   · 平台限制：两次导出间隔 ≥5 分钟；报表历史只保留 30 天
 */
const path = require('path');
const fs = require('fs');
const { app, session } = require('electron');
const sender = require('./sender');

const TRADE_URL = 'https://trade.1688.com/order/buyer_order_list.htm';
const ORDER_URL = 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 注入页面的穿透查询/点击助手（shadow DOM 递归）
 *  ⚠ 必须返回可结构化克隆的值：最后一句若是对象字面量（含函数）会报
 *    "An object could not be cloned."，故整体包 IIFE 并返回字符串。 */
const PAGE_HELPERS = `(function () {
  window.__qexp = {
    deepAll(root) {
      root = root || document;
      var out = [], stack = [root];
      while (stack.length) {
        var r = stack.pop();
        var els; try { els = r.querySelectorAll('*'); } catch (e) { continue; }
        for (var i = 0; i < els.length; i++) {
          out.push(els[i]);
          if (els[i].shadowRoot) stack.push(els[i].shadowRoot);
        }
      }
      return out;
    },
    // 可见性：有尺寸即视为可见（display:none 子树里尺寸为 0）
    visible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },
    // 按可见文本找元素（innerText 精确匹配）；onlyVisible=true 只取可见元素
    byText(txt, limit, onlyVisible) {
      limit = limit || 1;
      var hits = [];
      var els = this.deepAll();
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        var t = '';
        try { t = (e.innerText === undefined ? e.textContent : e.innerText) || ''; } catch (er) {}
        if (t.trim() === txt) {
          if (onlyVisible && !this.visible(e)) continue;
          hits.push(e); if (hits.length >= limit) break;
        }
      }
      return hits;
    },
    // 点击文本：优先可见元素（⚠ 页面里同名隐藏元素很多，盲点会点到隐藏元素上）
    clickText(txt) {
      var hits = this.byText(txt, 3, true);
      if (!hits.length) hits = this.byText(txt, 3, false);
      for (var i = 0; i < hits.length; i++) { try { hits[i].click(); return true; } catch (e) {} }
      return false;
    },
    qdateHost(tracker) {
      return this.deepAll().filter(function (e) {
        return e.tagName === 'Q-DATE' && e.getAttribute('data-tracker') === tracker;
      })[0] || null;
    },
    // q-date → q-date-time → ui-datetime 三层取齐
    dateChain(tracker) {
      var h = this.qdateHost(tracker);
      if (!h) return null;
      var qt = h.shadowRoot ? h.shadowRoot.querySelector('q-date-time') : null;
      var ui = qt && qt.shadowRoot ? qt.shadowRoot.querySelector('ui-datetime') : null;
      return { host: h, qt: qt, ui: ui };
    },
    dateState(tracker) {
      var c = this.dateChain(tracker);
      if (!c) return 'no-chain';
      var disp = '';
      try { disp = ((c.ui ? c.ui.innerText : '') || '').trim(); } catch (e) {}
      return { hostVal: c.host.getAttribute('value') || '', uiVal: c.ui ? (c.ui.getAttribute('value') || '') : 'no-ui', disp: disp };
    },
    openPopup(tracker) {
      var c = this.dateChain(tracker);
      if (!c || !c.ui) return 'no-ui';
      try { c.ui.click(); return 'popup-clicked'; } catch (e) { return 'click-err'; }
    },
    // 在日历弹层里按完整日期(title/data-date=YYYY-MM-DD)精确点格子
    clickDateCell(dateStr) {
      var els = this.deepAll();
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        if (!e.matches || !e.matches('.ui-date-item')) continue;
        var attrs = '';
        try { attrs = [e.getAttribute('title'), e.getAttribute('data-date'), e.getAttribute('aria-label')].join(' ').trim(); } catch (er) {}
        if (attrs === dateStr) { try { e.click(); return 'clicked:' + attrs; } catch (er) { return 'click-err'; } }
      }
      return 'not-found:' + dateStr;
    },
    closePopup() {
      try {
        ['mousedown', 'mouseup', 'click'].forEach(function (t) {
          document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: 5, clientY: 5 }));
        });
        return 'closed';
      } catch (e) { return 'err:' + e.message; }
    },
    // 通过日历把某个 q-date 设为目标日期（开弹层→点格子→回读校验）
    async setDateViaCalendar(tracker, dateStr) {
      var open = this.openPopup(tracker);
      if (open !== 'popup-clicked') return open;
      await new Promise(function (r) { setTimeout(r, 1200); });
      var click = this.clickDateCell(dateStr);
      await new Promise(function (r) { setTimeout(r, 900); });
      var st = this.dateState(tracker);
      var okv = st && st.hostVal === dateStr && st.disp === dateStr;
      return (open + '|' + click + '|' + (okv ? 'verified' : 'mismatch:' + JSON.stringify(st)));
    },
    // 导出历史表格容器（以可见的「申请时间」表头定位；避免读到弹窗背后订单列表的时间戳）
    historyScope() {
      var hdr = this.byText('申请时间', 1, true)[0];
      if (!hdr) return null;
      var c = hdr;
      for (var up = 0; up < 10 && c.parentElement; up++) {
        c = c.parentElement;
        var t = '';
        try { t = c.innerText || ''; } catch (er) {}
        if ((t.match(/\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}/g) || []).length >= 2) break;
      }
      return c;
    },
    // 历史视图最新一行（表格第一行 = y 最小的时间戳行容器）
    newestRow() {
      var scope = this.historyScope();
      if (!scope) return null;
      var els = this.deepAll(scope);
      var stampRe = /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/;
      var leaves = [];
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        var t = '';
        try { t = ((e.innerText === undefined ? e.textContent : e.innerText) || '').trim(); } catch (er) {}
        if (!stampRe.test(t)) continue;
        if (!this.visible(e)) continue;
        var r = e.getBoundingClientRect();
        leaves.push({ el: e, text: t, x: r.x, y: r.y });
      }
      leaves.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
      if (!leaves.length) return null;
      var L = leaves[0];
      var row = L.el;
      for (var up = 0; up < 8 && row.parentElement; up++) {
        row = row.parentElement;
        var rt = '';
        try { rt = row.innerText || ''; } catch (er) {}
        if (/导出/.test(rt) && rt.length < 300) break;
      }
      return row;
    },
    // 最新一行状态摘要（回传主进程判断）
    rowInfo() {
      var row = this.newestRow();
      if (!row) return 'no-rows';
      var txt = '';
      try { txt = (row.innerText || '').replace(/\\s+/g, ' ').slice(0, 120); } catch (e) {}
      var hasDl = false;
      try { hasDl = Array.prototype.slice.call(row.querySelectorAll('*')).some(function (x) { return (x.innerText || '').trim() === '下载' && window.__qexp.visible(x); }); } catch (er) {}
      return { text: txt, hasDl: hasDl };
    },
    // 点最新一行里「最深层」的下载元素（⚠ TD 的 innerText 也是"下载"，要点真链接 A）
    clickNewestDownload() {
      var row = this.newestRow();
      if (!row) return 'no-rows';
      var cands = [];
      try {
        cands = Array.prototype.slice.call(row.querySelectorAll('*')).filter(function (x) {
          return (x.innerText || '').trim() === '下载' && window.__qexp.visible(x);
        });
      } catch (er) { return 'scan-err'; }
      if (!cands.length) return 'no-download-link';
      cands.sort(function (a, b) { return a.querySelectorAll('*').length - b.querySelectorAll('*').length; });
      var d = cands[0];
      try { d.click(); return 'clicked:' + d.tagName; } catch (e) { return 'click-err'; }
    },
  };
  return 'injected';
})()`;

async function exec(wc, code, timeoutMs, tag) {
  return Promise.race([
    wc.executeJavaScript(code, true),
    new Promise((_, rej) => setTimeout(() => rej(new Error((tag || '页面脚本') + ' 超时')), timeoutMs || 20000)),
  ]);
}

/** 等 wc.url 命中 pattern */
async function waitForUrl(wc, pattern, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (pattern.test(wc.getURL() || '')) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(500);
  }
}

/** 等页面出现指定文本（穿透 shadow，只认可见元素），期间轮询 */
async function waitText(wc, txt, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const r = await exec(wc, `window.__qexp.byText(${JSON.stringify(txt)}, 1, true).length > 0`, 10000, 'waitText').catch(() => false);
    if (r === true) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(1200);
  }
}

/** 注册下载捕获（同一 session 只挂一次；返回 { armed }，在触发下载前调用） */
function captureDownload(ses, downloadDir) {
  fs.mkdirSync(downloadDir, { recursive: true });
  const state = { resolve: null, path: null, name: null };
  if (!ses.__qexpDownloadHooked) {
    ses.__qexpDownloadHooked = true;
    ses.on('will-download', (e, item) => {
      const name = item.getFilename() || ('order-export-' + Date.now() + '.xlsx');
      const file = path.join(downloadDir, name.replace(/[\\/:*?"<>|]/g, '_'));
      item.setSavePath(file);
      state.path = file; state.name = name;
      item.once('done', (_ev, st) => {
        if (state.resolve) {
          const r = { path: file, name, ok: st === 'completed' && fs.existsSync(file) && fs.statSync(file).size > 0 };
          state.resolve(r); state.resolve = null;
        }
      });
    });
  }
  return {
    armed() { return new Promise((resolve) => { state.resolve = resolve; }); },
    get lastPath() { return state.path; },
  };
}

/** 打开/复用 1688 窗口并加载订单列表页 */
async function openOrderPage(api) {
  const st = sender.state ? sender.state() : {};
  if (st.sending) throw new Error('正在发送催收消息，请等发送完成后再导入订单');
  const win = sender.getSendWindow();
  win.show();
  const wc = win.webContents;
  api.log('打开 1688「已买到的货品」页面…');
  for (const url of [ORDER_URL, TRADE_URL]) {
    try {
      await Promise.race([wc.loadURL(url), sleep(40000)]);
    } catch (e) { /* SPA 常见：did-finish-load 迟迟不触发，继续按 URL 判断 */ }
    if (/buyer-order-list/i.test(wc.getURL() || '')) {
      // 等页面渲染出「导出当前条件」（页面较重，最多 90s）
      await exec(wc, PAGE_HELPERS, 10000, '注入助手').catch(() => {});
      if (await waitText(wc, '导出当前条件', 90000)) {
        // 导航会清掉 window.__qexp，兜底再注入一次
        await exec(wc, PAGE_HELPERS, 10000, '注入助手').catch(() => {});
        api.log('页面就绪（已买到的货品 · 全部订单）');
        return { win, wc };
      }
    }
  }
  throw new Error('订单列表页未能打开/渲染（可能未登录 1688 或页面改版）。请先在助手里登录 1688 再试');
}

/** 点开下拉并选中指定 label（ORDER-SEARCH-* 下的 q-select） */
async function pickSelect(wc, tag, label, api) {
  const done = await exec(wc, `(async function(){
    function deepAll(root) {
      root = root || document;
      var out = [], stack = [root];
      while (stack.length) {
        var r = stack.pop();
        var els; try { els = r.querySelectorAll('*'); } catch (e) { continue; }
        for (var i = 0; i < els.length; i++) { out.push(els[i]); if (els[i].shadowRoot) stack.push(els[i].shadowRoot); }
      }
      return out;
    }
    var hs = deepAll().filter(function (e) { return e.tagName === 'ORDER-SEARCH-${tag.toUpperCase()}'; });
    var h = hs[0];
    if (!h) return 'no-host';
    var q = h.shadowRoot ? h.shadowRoot.querySelector('q-select') : (h.matches && h.matches('q-select') ? h : h.querySelector('q-select'));
    if (!q) return 'no-select';
    var c = q.querySelector('[slot="content"]');
    var cur = c ? (c.innerText || '').trim() : '';
    if (cur === ${JSON.stringify(label)}) return 'already';
    var inner = q.shadowRoot ? q.shadowRoot.querySelector('.q-select-selector') : null;
    try { (inner || q).click(); } catch (e) { return 'open-err'; }
    await new Promise(function (r) { setTimeout(r, 500); });
    var opts = Array.prototype.slice.call(q.querySelectorAll('q-select-option'));
    var hit = opts.filter(function (o) { return (o.getAttribute('label') || '') === ${JSON.stringify(label)}; })[0];
    if (!hit) return 'no-option';
    var optInner = hit.shadowRoot ? hit.shadowRoot.querySelector('.q-select-option') : hit;
    try { optInner.click(); } catch (e) { return 'pick-err'; }
    await new Promise(function (r) { setTimeout(r, 400); });
    var c2 = q.querySelector('[slot="content"]');
    return 'ok:' + (c2 ? (c2.innerText || '').trim() : '');
  })()`, 20000, 'pickSelect');
  if (done === 'already') { api.log(`${tag} 已是「${label}」，跳过`); return true; }
  if (done && String(done).startsWith('ok:')) { api.log(`${tag} → ${String(done).slice(3)}`); return true; }
  throw new Error(`设置「${tag}」筛选失败（${done}）`);
}

/** 用日历弹层设置起止日期并回读校验（直接写 value 会被组件重渲染清掉，必须走组件自己的 UI） */
async function setDateRange(wc, dateStart, dateEnd, api) {
  const setOne = async (tracker, dateStr) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await exec(wc, `window.__qexp.setDateViaCalendar(${JSON.stringify(tracker)}, ${JSON.stringify(dateStr)})`, 30000, 'setDate').catch(e => String(e));
      if (String(r).endsWith('verified')) { api.log(`· ${tracker === 'date-start' ? '开始' : '结束'}日期 ${dateStr} 已设置`); return true; }
      if (attempt === 1) await sleep(1200); // 弹层偶发未展开，稍候重试一次
    }
    throw new Error(`设置${tracker === 'date-start' ? '开始' : '结束'}日期失败：${dateStr}`);
  };
  await setOne('date-start', dateStart);
  await setOne('date-end', dateEnd);
  // 收起弹层并复核（防被重渲染清掉）
  await exec(wc, `window.__qexp.closePopup()`, 8000, 'closePopup').catch(() => {});
  await sleep(600);
  const check = await exec(wc, `(function(){
    var a = window.__qexp.dateState('date-start');
    var b = window.__qexp.dateState('date-end');
    return (a.hostVal === ${JSON.stringify(dateStart)} && b.hostVal === ${JSON.stringify(dateEnd)}) ? 'ok' : JSON.stringify({a: a, b: b});
  })()`, 12000, 'dateCheck');
  if (check !== 'ok') throw new Error('日期设置未被页面接受（回读不符）：' + check);
  api.log('下单时间设置完成并复核通过');
}

/** 主流程：m = { taskId, dateStart, dateEnd }，api = { log, isStopped, sleep } */
async function runExport(m, api, ctx) {
  const dateStart = String(m.dateStart || '');
  const dateEnd = String(m.dateEnd || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart) || !/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) {
    throw new Error('日期参数无效（需 YYYY-MM-DD）');
  }

  const { wc } = await openOrderPage(api);
  if (api.isStopped()) throw new Error('已被停止');

  // 0) 关掉「AI订单巡检」引导弹窗（首次进入会有，可能挡住后续点击）
  const aiClosed = await exec(wc, `(function(){
    var hits = window.__qexp.byText('跳过', 2, true);
    if (hits.length) { try { hits[0].click(); return 'skipped'; } catch (e) {} }
    return 'no-ai-popup';
  })()`, 10000, '关引导弹窗').catch(() => 'skip-check-failed');
  if (aiClosed === 'skipped') api.log('· 已跳过「AI订单巡检」引导弹窗');
  await sleep(800);

  // 1) 清空全部筛选（还原到「全部」基准，避免残留条件混入导出）
  api.log('清除既有筛选条件…');
  await exec(wc, `window.__qexp.clickText('清除选项')`, 10000, '清除选项').catch(() => false);
  await sleep(1500);

  // 2) 设置下单时间 = 自定义起止日期（日历点选 + 回读校验）
  api.log(`设置下单时间：${dateStart} ~ ${dateEnd}`);
  await setDateRange(wc, dateStart, dateEnd, api);

  // 3) 订单状态 / 订单类型 / 支付方式 → 全部（清除后一般已是全部，这里确保）
  for (const [tag, label] of [['trade-status', '全部'], ['trade-type', '全部'], ['pay-type', '全部']]) {
    if (api.isStopped()) throw new Error('已被停止');
    try { await pickSelect(wc, tag, label, api); }
    catch (e) {
      // 这些下拉的内部结构偶有差异：失败不致命——清除选项后默认即为「全部」，记录后继续
      api.log(`⚠ ${tag} 设为「${label}」未确认（${e.message}），继续（清除选项后默认值即为全部）`);
    }
  }

  // 4) 搜索（⚠ 按钮文字是「搜索」不是「查询」）
  api.log('应用筛选（搜索）…');
  const qClicked = await exec(wc, `window.__qexp.clickText('搜索')`, 10000, '搜索').catch(() => false);
  if (!qClicked) api.log('⚠ 未找到「搜索」按钮，继续导出');
  await sleep(4000);
  if (api.isStopped()) throw new Error('已被停止');

  // 5) 挂上下载捕获，再点「导出当前条件」
  const ses = session.fromPartition(sender.PARTITION);
  const downloadDir = path.join(app.getPath('userData'), 'order-exports');
  const dl = captureDownload(ses, downloadDir);
  const armed = dl.armed();
  api.log('点击「导出当前条件」…');
  const expClicked = await exec(wc, `window.__qexp.clickText('导出当前条件')`, 10000, '导出当前条件').catch(() => false);
  if (!expClicked) throw new Error('未找到「导出当前条件」按钮（页面可能改版）');

  // 6) 等弹窗（批量导出）→ 点「生成新报表」
  //    ⚠ 只认可见元素：「生成新报表」在隐藏的导出历史视图里也有同名元素
  //    ⚠ host 和内部 .q-button 都要点：实测 host 触发数据动作（创建报表）、
  //      内部元素驱动弹窗切到历史视图（2026-10-16 对照实验）
  const modalOk = await waitText(wc, '生成新报表', 25000);
  if (!modalOk) throw new Error('点击导出后未出现「批量导出」弹窗（可能触发平台 5 分钟间隔限制，请稍后再试）');
  api.log('出现「批量导出」弹窗，点击生成新报表…');
  const genClicked = await exec(wc, `(function(){
    var hits = window.__qexp.byText('生成新报表', 3, true);
    var out = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      try { h.click(); out.push('host'); } catch (e) {}
      if (h.shadowRoot) {
        var inner = h.shadowRoot.querySelector('button, .q-button');
        if (inner) { try { inner.click(); out.push('inner'); } catch (e) {} }
      }
    }
    return out.join('+') || 'none';
  })()`, 10000, '生成报表').catch(() => 'none');
  if (genClicked === 'none') throw new Error('未点到「生成新报表」按钮');

  // 7) 轮询导出历史：确保切到历史视图 → 刷新 → 最新一行导出成功 → 点该行下载
  //    ⚠ 视图可能不自动切换（此时点「查看过往导出报表」）；状态不自动更新（要点「刷新」）
  api.log('等待报表生成（平台提示约 1 分钟，期间自动刷新历史）…');
  const result = await Promise.race([
    (async () => {
      for (let i = 0; i < 32; i++) { // 32 × 15s ≈ 8 分钟
        await sleep(15000);
        if (api.isStopped()) throw new Error('已被停止');
        // 历史视图没开就手动打开
        const scoped = await exec(wc, `!!window.__qexp.historyScope()`, 10000, '查历史视图').catch(() => false);
        if (scoped !== true) {
          await exec(wc, `window.__qexp.clickText('查看过往导出报表')`, 10000, '切到历史视图').catch(() => {});
          await sleep(2000);
        }
        // 刷新状态（视图不会自动更新）
        await exec(wc, `window.__qexp.clickText('刷新')`, 8000, '刷新历史').catch(() => {});
        await sleep(2500);
        const info = await exec(wc, `window.__qexp.rowInfo()`, 12000, '读报表状态').catch(() => null);
        if (info && info.text && /导出失败/.test(info.text)) {
          throw new Error('1688 报表生成失败（历史显示导出失败），请稍后重试');
        }
        if (info && info.text && /导出成功/.test(info.text) && info.hasDl) {
          api.log('· 报表生成完成，点击下载…');
          await exec(wc, `window.__qexp.clickNewestDownload()`, 10000, '点下载').catch(() => {});
          const r = await Promise.race([armed, sleep(60000).then(() => null)]);
          if (r && r.ok) return r;
          // 兜底再点一次
          await exec(wc, `window.__qexp.clickNewestDownload()`, 10000, '点下载-兜底').catch(() => {});
          const r2 = await Promise.race([armed, sleep(60000).then(() => null)]);
          if (r2 && r2.ok) return r2;
          throw new Error('报表已生成但触发下载失败，请到 1688 订单页手动下载后用「重新导入数据」导入');
        }
      }
      return null;
    })(),
    sleep(9 * 60 * 1000).then(() => null),
  ]);
  if (!result || !result.ok) {
    throw new Error('等待报表生成/下载超时（约 9 分钟）。平台两次导出需间隔 5 分钟以上，可稍后重试');
  }
  return finishUpload(result, m, api, ctx);
}

/** 下载完成后：把文件回传服务器触发入库 */
async function finishUpload(dlResult, m, api, ctx) {
  const stat = fs.statSync(dlResult.path);
  api.log(`下载完成：「${dlResult.name}」（${Math.round(stat.size / 1024)} KB），回传服务器入库…`);
  const url = (ctx.serverUrl || '').replace(/\/+$/, '') + '/api/agent/upload-orders'
    + '?taskId=' + encodeURIComponent(m.taskId) + '&name=' + encodeURIComponent(dlResult.name);
  const buf = fs.readFileSync(dlResult.path);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-device-token': ctx.deviceToken || '' },
    body: buf,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* 非 JSON */ }
  if (res.status !== 200 || !body || !body.ok) {
    throw new Error('文件回传/入库失败：' + ((body && body.error) || ('HTTP ' + res.status)));
  }
  const imp = body.import || {};
  api.log(`✓ 服务器入库完成：新写入 ${imp.inserted != null ? imp.inserted : '?'} 单，跳过已有 ${imp.skipped != null ? imp.skipped : '?'} 单`);
}

module.exports = { runExport };
