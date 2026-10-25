/**
 * electron/agent/pdd-apply.js — 拼多多「申请发票」批量执行内核（只跑在用户本机）
 *
 * 为什么必须在本机跑：申请接口 invoice/apply 需要 anti-content 风控签名，
 * 该签名由开票页面内置的风控 SDK 在真实页面环境里生成（webpack 内部模块，Node 无法复刻）。
 * 所以做法是：助手开窗加载**真实开票页**，页面自己生成签名、自己带默认抬头，
 * 程序只负责「点按钮 → 确认 → 读结果」，和用户手点完全一致，风控最友好。
 *
 * 单个订单的流程（实测 2026-10-25）：
 *   加载 transac_return_compensation.html?_t_timestamp=transac_modify_invoice&order_sn=..&mall_id=..&from_invoice=1
 *   → 等页面真正就绪（URL 已切到本单 + 有可见内容）
 *   → 等 react 渲染出「申请发票 / 向商家发送申请」按钮
 *   → （如有「企业」抬头单选则点选，确保开企业抬头）
 *   → 点提交按钮 → 出确认弹窗 → 点「确认 / 确定 / 提交」
 *   → 判定成功：CDP 抓到接口 success:true，或页面出现「开票状态：开票中」
 *
 * 成败判定为什么用 CDP 抓包而不是只读页面文本（2026-10-25 踩坑）：
 *   有些单点提交后页面会整页跳转/重渲染，window 里的 XHR 钩子和 innerText 都会失效，
 *   只剩一片空白，于是被误判成「超时」（订单 261022-634440968561773 就是这样翻车的）。
 *   webContents.debugger 的网络监听挂在窗口上，跨导航依然有效，且同时覆盖 XHR 与 fetch。
 *
 * 频率控制：每个订单之间间隔 gapMs（默认 3 秒），加上页面加载本身的节奏。
 */
const { BrowserWindow, session, app } = require('electron');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:pdd';           // 与 pdd-login 同一分区（登录态共享）
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const PAGE_URL = 'https://mobile.yangkeduo.com/transac_return_compensation.html'
  + '?_t_timestamp=transac_modify_invoice&from_invoice=1';

const SUBMIT_TEXTS = ['向商家发送申请', '申请发票'];
const CONFIRM_TEXTS = ['确认', '确定', '提交'];
const DONE_TEXTS = ['知道了', '关闭按钮'];
const SUCCESS_MARKS = ['开票中', '已开票', '开票成功', '申请成功', '申请已提交', '商家处理中', '等待商家开票'];
const FAIL_MARKS = ['无法申请发票', '暂时无法申请'];

let win = null;
const netBuf = [];   // 最近若干条「申请发票」接口响应（CDP 抓取，跨导航有效）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}
function isPdd(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)(yangkeduo|pinduoduo)\.com$/i.test(h);
}

/**
 * 用 CDP 监听网络响应（挂在 webContents 上，页面跳转也不会丢）。
 * 只关心「申请发票」相关接口，抓到就解析 body 存进 netBuf。
 */
async function attachNet(w) {
  const dbg = w.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Network.enable');
  } catch (e) {
    return false;   // 抓包不可用（例如 devtools 已占用）→ 退回页内钩子 + 页面文本
  }
  dbg.on('message', async (ev, method, params) => {
    try {
      if (method !== 'Network.responseReceived') return;
      const res = (params && params.response) || {};
      const url = String(res.url || '');
      if (!/invoice\/(apply|submit|create)|invoice_assistant/i.test(url)) return;
      let body = '';
      try {
        const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        body = r && r.body ? String(r.body) : '';
      } catch (e) { /* body 拿不到就只留状态 */ }
      netBuf.push({ url, status: Number(res.status) || 0, body: body.slice(0, 1000), t: Date.now() });
      if (netBuf.length > 40) netBuf.splice(0, netBuf.length - 40);
    } catch (e) { /* 忽略 */ }
  });
  return true;
}

/** 申请专用窗口（与登录窗口同一个分区、同一个 UA；批量结束不销毁，复用） */
function getWindow() {
  if (win && !win.isDestroyed()) return win;
  const part = session.fromPartition(PARTITION);
  try { part.setUserAgent(MOBILE_UA); } catch (e) { /* 忽略 */ }
  win = new BrowserWindow({
    show: false, width: 430, height: 880, title: '拼多多（申请发票）', autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false,
    },
  });
  try { win.webContents.setUserAgent(MOBILE_UA); } catch (e) { /* 忽略 */ }
  win.webContents.setWindowOpenHandler(({ url }) => ({ action: isPdd(url) ? 'allow' : 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!isPdd(url)) e.preventDefault(); });
  win.on('closed', () => { win = null; netBuf.length = 0; });
  attachNet(win).catch(() => {});
  return win;
}

const exec = async (w, js, fallback) => {
  try { return await w.webContents.executeJavaScript(js, true); } catch (e) { return fallback; }
};

/** 页面可见文本（弹窗/状态判断用） */
const pageText = (w) => exec(w, `(document.body && document.body.innerText || '').replace(/\\s+/g, '|').slice(0, 1500)`, '');
/** 去掉分隔符与零宽字符后的有效文本长度（判断页面是否真的渲染出来） */
const visibleLen = (t) => String(t || '').replace(/[|\s\u200b\u200c\u200d\ufeff]/g, '').length;

function currentUrl(w) {
  try { return w.webContents.getURL(); } catch (e) { return ''; }
}

/**
 * 在页面里按文案点击。优先叶子节点精确匹配（点「企业」时避免误伤其他含该词的元素）。
 * @param {string[]} texts 候选文案（依次尝试）
 * @param {{mustLeaf?: boolean}} opts
 * @returns {Promise<string>} 'clicked <文案>' / 'not-found ...'
 */
function clickJs(texts, opts = {}) {
  const want = JSON.stringify(texts);
  return `(() => {
    const want = ${want};
    const all = [...document.querySelectorAll('div,button,span,a,i,label')];
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
    const pick = (t, leafOnly) => {
      let list = all.filter((e) => vis(e) && (e.textContent || '').trim() === t);
      if (leafOnly || list.length === 0) {
        const leaf = list.filter((e) => e.children.length === 0);
        if (leaf.length) list = leaf;
      }
      return list[list.length - 1];
    };
    for (const t of want) { const el = pick(t, ${opts.mustLeaf ? 'true' : 'false'}); if (el) { el.click(); return 'clicked ' + t; } }
    return 'not-found ' + want.join('/');
  })()`;
}

/** 等 XHR 钩子装好（CDP 抓包不可用时的兜底；页面跳转会失效，所以每次结果轮询都重装） */
function hookJs() {
  return `(() => {
    if (!window.__pddReqs) window.__pddReqs = [];
    if (!window.__pddHooked) {
      window.__pddHooked = true;
      const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u || ''); return oOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function (b) {
        const self = this;
        this.addEventListener('load', function () {
          if (/invoice\\/(apply|submit|create)/.test(self.__u)) {
            window.__pddReqs.push({ url: self.__u, status: self.status, resp: (self.responseText || '').slice(0, 600) });
          }
        });
        return oSend.apply(this, arguments);
      };
    }
    return 'hooked';
  })()`;
}

/** 失败时存一张截图，供用户/开发排查（路径会写进结果说明） */
async function snap(w, sn) {
  try {
    const img = await w.webContents.capturePage();
    const dir = path.join(app.getPath('userData'), 'apply-fails');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, String(sn || 'order').replace(/[^\w-]/g, '_') + '-' + Date.now() + '.png');
    fs.writeFileSync(f, img.toPNG());
    return f;
  } catch (e) { return ''; }
}

/** 把当前页面/抓包情况收成一行诊断信息（写进 resp，便于事后定位） */
async function diagnose(w, mark) {
  const t = await pageText(w);
  const nets = netBuf.slice(mark).map((n) => n.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 120) + ' → ' + n.status);
  const out = {
    url: currentUrl(w).slice(0, 200),
    text: String(t || '').replace(/\|/g, ' ').slice(0, 200),
    nets: nets.slice(-5),
  };
  return JSON.stringify(out).slice(0, 800);
}

/**
 * 执行一个订单的申请（含一次整单重试）。
 * 返回 { ok, detail, httpResp, shot }
 */
async function applyOne(w, order, { timeoutMs = 30000 } = {}) {
  const first = await applyOnce(w, order, { timeoutMs });
  if (first.ok || first.errorish) return first;      // 成功 / 接口明确报错 → 不重试
  // 超时或页面没就绪 → 重载整单再来一次（多半是偶发：首屏没渲染完 / 跳转把状态冲掉）
  const again = await applyOnce(w, order, { timeoutMs, retry: true });
  if (again.ok || again.errorish) { again.detail += '（重试后）'; return again; }
  // 两次都不明确 → 带上第二次的诊断
  return again;
}

async function applyOnce(w, order, { timeoutMs = 30000, retry = false } = {}) {
  const url = PAGE_URL + '&order_sn=' + encodeURIComponent(order.order_sn) + '&mall_id=' + encodeURIComponent(order.mall_id || '');
  const mark = netBuf.length;                        // 只看本单开始之后的接口响应
  await w.loadURL(url).catch(() => {});
  await exec(w, hookJs(), '');

  // ① 等「本单的页面」真正就绪：URL 已切到本单 + 有可见内容。
  //    否则会在上一单的旧页面上误点按钮（这是 261022-...61773 那单翻车的直接原因）。
  const readyDl = Date.now() + 12000;
  let ready = false;
  while (Date.now() < readyDl) {
    if (w.isDestroyed()) return { ok: false, detail: '窗口被关闭', errorish: true };
    if (currentUrl(w).includes(order.order_sn)) {
      if (visibleLen(await pageText(w)) > 3) { ready = true; break; }
    }
    await sleep(400);
  }
  if (!ready) {
    const d = await diagnose(w, mark);
    const f = await snap(w, order.order_sn);
    return {
      ok: false, errorish: true, shot: f,
      detail: '开票页加载超时或页面空白（' + (retry ? '重试仍失败' : '首次加载失败')
        + '，多半是拼多多登录态失效或网络问题）' + (f ? '，诊断截图：' + f : ''),
      httpResp: d,
    };
  }

  // ② 等提交按钮出现
  let btn = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (w.isDestroyed()) return { ok: false, detail: '窗口被关闭', errorish: true };
    btn = await exec(w, `(() => {
      const texts = ${JSON.stringify(SUBMIT_TEXTS)};
      const all = [...document.querySelectorAll('div,button,span')];
      for (const t of texts) {
        const el = all.filter((e) => !!(e.offsetWidth || e.offsetHeight) && (e.textContent || '').trim() === t).pop();
        if (el) return t;
      }
      return '';
    })()`, '');
    if (btn) break;
    const txt = await pageText(w);
    if (FAIL_MARKS.some((m) => txt.includes(m))) {
      return { ok: false, errorish: true, detail: '页面提示无法申请（该订单可能不支持线上开票）' };
    }
    await sleep(800);
  }
  if (!btn) {
    const d = await diagnose(w, mark);
    const f = await snap(w, order.order_sn);
    const txt = await pageText(w);
    return {
      ok: false, errorish: true, shot: f,
      detail: (txt.includes('登录') ? '登录态已失效，请在助手里重新登录拼多多' : '页面未出现申请按钮（超时）')
        + (f ? '，诊断截图：' + f : ''),
      httpResp: d,
    };
  }

  // ③ 装钩子 → 选企业抬头（如可选）→ 提交 → 确认
  await exec(w, hookJs(), '');
  await exec(w, clickJs(['企业'], { mustLeaf: true }), '');
  await exec(w, clickJs([btn], { mustLeaf: true }), '');
  await sleep(1500);
  await exec(w, clickJs(CONFIRM_TEXTS), '');
  await exec(w, hookJs(), '');   // 万一刚才发生了跳转，重新装一次

  // ④ 等结果：CDP 抓包优先，页内钩子 + 页面文本兜底
  const dl2 = Date.now() + timeoutMs;
  while (Date.now() < dl2) {
    if (w.isDestroyed()) return { ok: false, detail: '窗口被关闭', errorish: true };
    const nets = netBuf.slice(mark);
    const pageReqs = await exec(w, `window.__pddReqs || []`, []);
    const text = await pageText(w);

    const okByNet = nets.find((n) => n.status === 200 && /"success"\s*:\s*true/.test(n.body));
    const badByNet = nets.find((n) => /"success"\s*:\s*false|"error_code"\s*:\s*[1-9]/.test(n.body));
    const okByHook = (pageReqs || []).some((r) => r.status === 200 && /"success"\s*:\s*true/.test(r.resp));
    const badByHook = (pageReqs || []).find((r) => /"success"\s*:\s*false|"error_code"/.test(r.resp));
    const okByText = SUCCESS_MARKS.some((m) => text.includes(m));
    const failByText = FAIL_MARKS.some((m) => text.includes(m));

    if (okByNet || okByHook || okByText) {
      await exec(w, clickJs(DONE_TEXTS), '');
      return { ok: true, detail: '已提交（开票中）', httpResp: String((okByNet && okByNet.body) || (okByHook ? '' : '')).slice(0, 300) };
    }
    const bad = badByNet || (badByHook ? { body: badByHook.resp } : null);
    if (bad) {
      let msg = '';
      try { msg = (JSON.parse(bad.body) || {}).error_msg || ''; } catch (e) { /* 保留空 */ }
      const dup = /相同|已申请|重复/.test(msg);
      await exec(w, clickJs(DONE_TEXTS), '');
      return {
        ok: false, errorish: true,
        detail: dup ? ('已有相同抬头的开票申请，请刷新列表核实：' + msg) : (msg || '接口返回失败'),
        httpResp: String(bad.body || '').slice(0, 300),
      };
    }
    if (failByText) {
      await exec(w, clickJs(DONE_TEXTS), '');
      return { ok: false, errorish: true, detail: '页面提示无法申请', httpResp: '' };
    }
    await sleep(800);
  }

  // ⑤ 超时：留诊断信息 + 截图，交由 applyOne 决定是否重试
  const d = await diagnose(w, mark);
  const f = await snap(w, order.order_sn);
  await exec(w, clickJs(DONE_TEXTS), '');
  return {
    ok: false, retryable: !retry, shot: f,
    detail: '等待结果超时（页面未出现明确成败标识）' + (f ? '，诊断截图：' + f : ''),
    httpResp: d,
  };
}

function currentVersion() {
  try { return require('../../package.json').version || ''; } catch (e) { return ''; }
}

/**
 * 执行一次批量申请任务。
 * @param {object} task { taskId, orders: [{order_sn, mall_id}], gapMs, timeoutMs }
 * @param {object} api  { log(text), isStopped(), report(payload), progress(payload) }
 */
async function runApply(task, api) {
  const orders = Array.isArray(task && task.orders) ? task.orders.filter((o) => o && o.order_sn) : [];
  const gapMs = Math.max(1500, Number(task && task.gapMs) || 3000);
  if (!orders.length) {
    api.report({ ok: false, error: '任务里没有订单' });
    return;
  }
  const w = getWindow();
  api.log(`开始批量申请发票：共 ${orders.length} 单（每单间隔约 ${Math.round(gapMs / 1000)} 秒）`);
  if (api.progress) api.progress({ index: 0, total: orders.length });

  const results = [];
  let okN = 0, failN = 0;
  for (let i = 0; i < orders.length; i++) {
    if (api.isStopped && api.isStopped()) {
      api.report({ ok: results.length > 0, results, error: '任务已被停止', stopped: true });
      return;
    }
    if (w.isDestroyed()) {
      api.report({ ok: false, results, error: '申请窗口被关闭，任务中止', stopped: true });
      return;
    }
    const o = orders[i];
    let r;
    try {
      r = await applyOne(w, o, { timeoutMs: Number(task && task.timeoutMs) || 30000 });
    } catch (e) {
      r = { ok: false, errorish: true, detail: '执行异常：' + String((e && e.message) || e).slice(0, 120) };
    }
    const detail = String(r.detail || '');
    results.push({
      order_sn: o.order_sn, ok: !!r.ok, detail,
      resp: String(r.httpResp || '').slice(0, 800),
    });
    if (r.ok) okN++; else failN++;
    if (api.progress) {
      api.progress({ index: i + 1, total: orders.length, order_sn: o.order_sn, ok: !!r.ok, detail, okCount: okN, failCount: failN });
    }
    api.log(`[${i + 1}/${orders.length}] ${o.order_sn} → ${r.ok ? '✓ 已提交' : '✗ ' + (detail || '失败')}`);
    if (i < orders.length - 1) await sleep(gapMs);
  }

  api.report({
    ok: okN > 0,
    results,
    okCount: okN,
    failCount: failN,
    agentVer: currentVersion(),
  });
  api.log(`批量申请结束：成功 ${okN} / ${results.length}`);
}

/** 供 main.js 注入：返回 pdd_apply 处理器 */
function createApplyHandler({ log = () => {} } = {}) {
  return async function handlePddApply(task, api) {
    try {
      await runApply(task, api);
    } catch (e) {
      log('拼多多申请异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = { createApplyHandler, runApply, getWindow, PARTITION, PAGE_URL };
