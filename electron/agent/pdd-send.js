/**
 * electron/agent/pdd-send.js — 拼多多「催商家开票」消息批量发送内核（只跑在用户本机）
 *
 * 为什么必须在本机跑发消息：chat/send_message 接口要求 anti-content 风控签名，
 * 该签名由拼多多页面内置的风控 SDK 在真实页面环境里生成（webpack 内部模块，Node 无法复刻）。
 * 做法与「申请发票」一致：助手开窗加载**真实聊天页**，在输入框里打字、点页面自己的发送按钮，
 * 让页面自己带签名发请求，和用户手点完全一样，风控最友好。
 *
 * 单个订单的流程：
 *   加载 chat_detail.html?mall_id=<商家ID>&order_sn=<订单号>
 *   → 等页面真正就绪（URL 已切到本商家 + 有可见内容）
 *   → 找到底部聊天输入框（textarea / input / contenteditable 三路兜底）
 *   → 填入模板消息（受控组件要用原生 setter + input 事件，否则框架不认）
 *   → 回读校验：输入框里真的出现这段文字才点发送
 *   → 点「发送」按钮（找不到就发真实回车键）
 *   → 判定成功：CDP 抓到 send_message 响应 success:true，或「输入框清空 + 聊天记录出现该消息」
 *
 * 成败判定为什么用 CDP 抓包：页面点发送后可能整页重渲染，页内钩子和 innerText 会失效；
 * webContents.debugger 的网络监听挂在窗口上，跨导航依然有效（申请发票那单就是栽在这上面）。
 *
 * 不做自动重试：发消息是对外打扰，宁可报「可能已发送」也不能重复发。
 * 只有明确判定「根本没点出去」（输入框里文字还在）才重试一次。
 */
const { BrowserWindow, session, app } = require('electron');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:pdd';           // 与 pdd-login / pdd-apply 同一分区（共用登录态）
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const CHAT_PAGE = 'https://mobile.yangkeduo.com/chat_detail.html';

const SEND_TEXTS = ['发送', '发送消息', '发送(1)', 'Send'];
const LOGIN_MARKS = ['请先登录', '登录后查看', '账号登录'];

let win = null;
const netBuf = [];   // 最近若干条 send_message 接口响应（CDP 抓取，跨导航有效）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}
function isPdd(url) {
  const h = hostOf(url);
  return !!h && /(^|\.)(yangkeduo|pinduoduo)\.com$/i.test(h);
}

/** CDP 网络监听：只关心发消息接口，抓到就解析 body 存进 netBuf */
async function attachNet(w) {
  const dbg = w.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Network.enable');
  } catch (e) {
    return false;   // 抓包不可用（例如 devtools 已占用）→ 退回页面文本判定
  }
  dbg.on('message', async (ev, method, params) => {
    try {
      if (method !== 'Network.responseReceived') return;
      const res = (params && params.response) || {};
      const url = String(res.url || '');
      if (!/chat\/send_message/i.test(url)) return;
      let body = '';
      try {
        const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        body = r && r.body ? String(r.body) : '';
      } catch (e) { /* body 拿不到就只留状态 */ }
      netBuf.push({ url, status: Number(res.status) || 0, body: body.slice(0, 1000), t: Date.now() });
      if (netBuf.length > 60) netBuf.splice(0, netBuf.length - 60);
    } catch (e) { /* 忽略 */ }
  });
  return true;
}

/** 发消息专用窗口（与登录/申请同一分区、同一 UA；批量结束不销毁，复用） */
/** 当前窗口（没有就返回 null，绝不懒创建——退出登录时要「关掉已存在的窗口」而不是新开一个） */
function peekWindow() { return (win && !win.isDestroyed()) ? win : null; }

function getWindow() {
  if (win && !win.isDestroyed()) return win;
  const part = session.fromPartition(PARTITION);
  try { part.setUserAgent(MOBILE_UA); } catch (e) { /* 忽略 */ }
  win = new BrowserWindow({
    show: false, width: 430, height: 880, title: '拼多多（催收消息）', autoHideMenuBar: true,
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

/** 页面可见文本（去分隔符） */
const pageText = (w) => exec(w, `(document.body && document.body.innerText || '').replace(/\\s+/g, '|').slice(0, 1800)`, '');
const visibleLen = (t) => String(t || '').replace(/[|\s\u200b\u200c\u200d\ufeff]/g, '').length;
function currentUrl(w) {
  try { return w.webContents.getURL(); } catch (e) { return ''; }
}

/** 在页面里找聊天输入框，找到就打个标记（data-xsh-input），后续都用它定位 */
const FIND_INPUT_JS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width >= 60 && r.height >= 12; };
  const cands = [...document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')]
    .filter((e) => vis(e) && !e.disabled && !e.readOnly);
  const brief = (e) => ({ tag: e.tagName, cls: String(e.className || '').slice(0, 48),
    ph: String(e.getAttribute('placeholder') || '').slice(0, 20),
    w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) });
  if (!cands.length) {
    const all = [...document.querySelectorAll('[contenteditable], textarea, input')].slice(0, 8).map(brief);
    return { ok: false, cands: all };
  }
  // 聊天输入框在最下面：按 top 从大到小取第一个
  cands.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  const el = cands[0];
  document.querySelectorAll('[data-xsh-input]').forEach((n) => n.removeAttribute('data-xsh-input'));
  el.setAttribute('data-xsh-input', '1');
  return { ok: true, info: brief(el), cands: cands.slice(0, 4).map(brief) };
})()`;

/** 页面没直接暴露输入框时，先点一下「发消息 / 说点什么 / placeholder」把输入区激活 */
const POKE_INPUT_JS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const texts = ['发消息', '说点什么', '输入消息', '咨询商家', '联系商家', '发送消息', '有话要说'];
  const el = [...document.querySelectorAll('div,span,p,a,button')]
    .filter((e) => vis(e) && e.children.length === 0
      && texts.some((t) => String(e.textContent || '').trim().indexOf(t) >= 0)).pop();
  if (el) { try { el.click(); } catch (e) { /* 忽略 */ } return 'clicked:' + String(el.textContent || '').trim().slice(0, 12); }
  const ph = [...document.querySelectorAll('[placeholder], [data-placeholder]')].filter(vis).pop();
  if (ph) { try { ph.click(); } catch (e) { /* 忽略 */ } return 'clicked-placeholder'; }
  return 'none';
})()`;

/** 往输入框填文字（受控组件：原生 setter + input 事件；contenteditable 用 insertText） */function fillJs(text) {
  return `(() => {
    const el = document.querySelector('[data-xsh-input]');
    if (!el) return { ok: false, error: '输入框丢了（页面可能已跳转）' };
    const text = ${JSON.stringify(text)};
    try { el.focus(); el.click(); } catch (e) { /* 忽略 */ }
    if (el.isContentEditable) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges(); sel.addRange(range);
        document.execCommand('delete');
        document.execCommand('insertText', false, text);
      } catch (e) { /* 走下面的兜底 */ }
      if (!String(el.innerText || '').trim()) {
        el.innerHTML = '';
        el.appendChild(document.createTextNode(text));
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); }
        catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const cur = el.value != null && el.value !== undefined ? String(el.value) : String(el.innerText || '');
    return { ok: true, typed: norm(cur).length, match: norm(cur).indexOf(norm(text).slice(0, 10)) >= 0 };
  })()`;
}

/** 点「发送」按钮（按文案优先，其次 class 含 send；都没有返回 not-found 由调用方发回车） */
function clickSendJs() {
  return `(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const texts = ${JSON.stringify(SEND_TEXTS)};
    const leaf = [...document.querySelectorAll('div,button,span,a')]
      .filter((e) => vis(e) && e.children.length === 0 && texts.indexOf(String(e.textContent || '').trim()) >= 0);
    if (leaf.length) { const el = leaf[leaf.length - 1]; el.click(); return 'clicked:' + String(el.textContent || '').trim(); }
    const byCls = [...document.querySelectorAll('[class*=send], [class*=Send]')].filter(vis).pop();
    if (byCls) { byCls.click(); return 'clicked-class:' + String(byCls.className || '').slice(0, 40); }
    return 'not-found';
  })()`;
}

/** 当前输入框状态 + 聊天记录里是否已出现该片段（文案兜底判定用） */
function stateJs(frag) {
  return `(() => {
    const el = document.querySelector('[data-xsh-input]');
    const cur = el ? (el.value != null && el.value !== undefined ? String(el.value) : String(el.innerText || '')) : '';
    const body = (document.body ? document.body.innerText : '').replace(/\\s+/g, '');
    const frag = ${JSON.stringify(frag)};
    return { hasInput: !!el, empty: !cur.trim(), echoed: !!frag && body.indexOf(frag) >= 0 };
  })()`;
}

/** 失败时存一张截图，供用户/开发排查 */
async function snap(w, sn) {
  try {
    const img = await w.webContents.capturePage();
    const dir = path.join(app.getPath('userData'), 'pdd-msg-fails');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, String(sn || 'order').replace(/[^\w-]/g, '_') + '-' + Date.now() + '.png');
    fs.writeFileSync(f, img.toPNG());
    return f;
  } catch (e) { return ''; }
}

/** 把当前页面/抓包情况收成一行诊断（写进 resp，便于事后定位） */
async function diagnose(w, mark, extra) {
  const t = await pageText(w);
  const nets = netBuf.slice(mark).map((n) => n.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 100) + ' → ' + n.status);
  const out = {
    url: currentUrl(w).slice(0, 180),
    text: String(t || '').replace(/\|/g, ' ').slice(0, 220),
    nets: nets.slice(-4),
    probe: extra || null,
  };
  return JSON.stringify(out).slice(0, 900);
}

/**
 * 发送一条消息到某个商家的会话（不同订单同一商家 = 同一会话，由服务端去重）。
 * 返回 { ok, detail, errorish, httpResp, content }
 */
async function sendOne(w, item, { timeoutMs = 40000 } = {}) {
  const sn = String(item.order_sn || '');
  const mallId = item.mall_id;
  const text = String(item.content || '');
  if (!text.trim()) return { ok: false, errorish: true, detail: '消息内容为空（模板未配置）' };

  const url = CHAT_PAGE + '?mall_id=' + encodeURIComponent(mallId)
    + '&order_sn=' + encodeURIComponent(sn)
    + '&refer_page_name=transac_invoice&refer_page_sn=24648';

  const attempt = async (isRetry) => {
    const mark = netBuf.length;              // 只看本单开始之后的接口响应
    await w.loadURL(url).catch(() => {});

    // ① 等页面就绪：URL 已切到本商家 + 有可见内容（否则会在旧页面上瞎点）
    const readyDl = Date.now() + 15000;
    let ready = false;
    while (Date.now() < readyDl) {
      if (w.isDestroyed()) return { ok: false, errorish: true, detail: '窗口被关闭' };
      const u = currentUrl(w);
      if (u.includes('chat_detail') && (u.includes('mall_id=' + mallId) || u.includes('mall_id%3D' + mallId))) {
        if (visibleLen(await pageText(w)) > 3) { ready = true; break; }
      }
      await sleep(400);
    }
    if (!ready) {
      const d = await diagnose(w, mark);
      const f = await snap(w, sn);
      return {
        ok: false, errorish: true, shot: f,
        detail: '聊天页加载超时或页面空白（多半是拼多多登录态失效或网络问题）'
          + (f ? '，诊断截图：' + f : ''),
        httpResp: d,
      };
    }

    // ② 等输入框出现（H5 首屏渲染完才有）；等不到就先点一下输入区/「发消息」把编辑器激活
    let probe = null;
    const inputDl = Date.now() + 18000;
    let tick = 0;
    while (Date.now() < inputDl) {
      if (w.isDestroyed()) return { ok: false, errorish: true, detail: '窗口被关闭' };
      probe = await exec(w, FIND_INPUT_JS, null);
      if (probe && probe.ok) break;
      const txt = await pageText(w);
      if (LOGIN_MARKS.some((m) => txt.includes(m))) {
        return { ok: false, errorish: true, detail: '拼多多登录态已失效，请先在助手里重新登录拼多多' };
      }
      // 每 3 次探测（约 1.8 秒）戳一次，避免页面把输入框藏在「发消息」后面
      if (tick++ % 3 === 0) await exec(w, POKE_INPUT_JS, 'none');
      await sleep(600);
    }
    if (!probe || !probe.ok) {
      const d = await diagnose(w, mark, probe);
      const f = await snap(w, sn);
      return {
        ok: false, errorish: true, shot: f,
        detail: '聊天页没找到输入框（页面结构可能变了）' + (f ? '，诊断截图：' + f : ''),
        httpResp: d,
      };
    }

    // ③ 填内容并回读校验
    const filled = await exec(w, fillJs(text), null);
    if (!filled || !filled.ok) {
      return { ok: false, errorish: true, detail: '消息没能输入到聊天框：' + ((filled && filled.error) || '未知原因') };
    }
    if (!filled.match) {
      const d = await diagnose(w, mark, { filled, input: probe.info });
      return {
        ok: false, errorish: true,
        detail: '消息未成功填入聊天框（键入 ' + (filled.typed || 0) + ' 字，回读不一致）',
        httpResp: d,
      };
    }

    // ④ 点发送（找不到按钮就发真实回车键）
    const clicked = await exec(w, clickSendJs(), 'not-found');
    if (clicked === 'not-found') {
      try {
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      } catch (e) { /* 忽略 */ }
    }

    // ⑤ 等结果：CDP 抓包优先，页面回显兜底
    const frag = String(text).replace(/\s+/g, '').slice(0, 12);
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      if (w.isDestroyed()) return { ok: false, errorish: true, detail: '窗口被关闭' };
      const nets = netBuf.slice(mark).filter((n) => /send_message/i.test(n.url));
      const okNet = nets.find((n) => n.status === 200 && /"success"\s*:\s*true/.test(n.body));
      if (okNet) return { ok: true, detail: '已发送', httpResp: okNet.body.slice(0, 300) };
      const badNet = nets.find((n) => /"success"\s*:\s*false|"error_code"\s*:\s*[1-9]/.test(n.body));
      if (badNet) {
        let msg = '';
        try { msg = (JSON.parse(badNet.body) || {}).error_msg || ''; } catch (e) { /* 保留空 */ }
        return { ok: false, errorish: true, detail: msg || '接口返回失败', httpResp: badNet.body.slice(0, 300) };
      }
      const st = await exec(w, stateJs(frag), null);
      if (st && st.empty && st.echoed) return { ok: true, detail: '已发送（聊天记录已回显）' };
      if (st && !st.hasInput) break;   // 输入框消失（页面跳走）→ 走诊断
      await sleep(700);
    }

    // ⑥ 超时：区分「可能已发出」与「根本没发出去」，只对后者重试
    const st = await exec(w, stateJs(frag), null);
    const d = await diagnose(w, mark, { state: st, input: probe.info, clicked });
    if (st && st.empty) {
      return {
        ok: false, errorish: true,
        detail: '消息可能已发出但未抓到接口回执，为避免重复打扰不再重发，请到拼多多聊天里核对',
        httpResp: d,
      };
    }
    const f = await snap(w, sn);
    return {
      ok: false, retryable: !isRetry, shot: f,
      detail: '点发送后没有反应（文字仍在输入框）' + (f ? '，诊断截图：' + f : ''),
      httpResp: d,
    };
  };

  const first = await attempt(false);
  if (first.ok || first.errorish || !first.retryable) return first;
  const again = await attempt(true);
  if (again.ok) again.detail += '（重试后）';
  return again;
}

function currentVersion() {
  try { return require('../../package.json').version || ''; } catch (e) { return ''; }
}

/**
 * 执行一次批量催收任务。
 * @param {object} task { taskId, items: [{order_sn, mall_id, content}], gapMs, timeoutMs }
 * @param {object} api  { log(text), isStopped(), report(payload), progress(payload) }
 */
async function runSend(task, api) {
  const items = Array.isArray(task && task.items)
    ? task.items.filter((o) => o && o.order_sn && o.mall_id && o.content) : [];
  const gapMs = Math.max(1500, Number(task && task.gapMs) || 4000);
  if (!items.length) {
    api.report({ ok: false, error: '任务里没有可发送的订单（缺少商家ID或消息内容为空）' });
    return;
  }
  const w = getWindow();
  api.log(`开始批量发送催收消息：共 ${items.length} 个商家会话（每单间隔约 ${Math.round(gapMs / 1000)} 秒）`);
  if (api.progress) api.progress({ index: 0, total: items.length });

  const results = [];
  let okN = 0, failN = 0;
  for (let i = 0; i < items.length; i++) {
    if (api.isStopped && api.isStopped()) {
      api.report({ ok: results.length > 0, results, error: '任务已被停止', stopped: true });
      return;
    }
    if (w.isDestroyed()) {
      api.report({ ok: false, results, error: '聊天窗口被关闭，任务中止', stopped: true });
      return;
    }
    const it = items[i];
    let r;
    try {
      r = await sendOne(w, it, { timeoutMs: Number(task && task.timeoutMs) || 40000 });
    } catch (e) {
      r = { ok: false, errorish: true, detail: '执行异常：' + String((e && e.message) || e).slice(0, 120) };
    }
    const detail = String(r.detail || '');
    results.push({
      order_sn: it.order_sn, mall_id: it.mall_id, ok: !!r.ok, detail,
      content: String(it.content || '').slice(0, 500),
      resp: String(r.httpResp || '').slice(0, 800),
    });
    if (r.ok) okN++; else failN++;
    if (api.progress) {
      api.progress({
        index: i + 1, total: items.length, order_sn: it.order_sn, ok: !!r.ok, detail,
        okCount: okN, failCount: failN,
      });
    }
    api.log(`[${i + 1}/${items.length}] ${it.order_sn} → ${r.ok ? '✓ 已发送' : '✗ ' + (detail || '失败')}`);
    if (i < items.length - 1) await sleep(gapMs);
  }

  api.report({
    ok: okN > 0,
    results,
    okCount: okN,
    failCount: failN,
    agentVer: currentVersion(),
  });
  api.log(`批量催收结束：成功 ${okN} / ${results.length}`);
}

/** 供 main.js 注入：返回 pdd_send 处理器 */
function createSendHandler({ log = () => {} } = {}) {
  return async function handlePddSend(task, api) {
    try {
      await runSend(task, api);
    } catch (e) {
      log('拼多多催收异常: ' + ((e && e.message) || e));
      api.report({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  };
}

module.exports = { createSendHandler, runSend, getWindow, peekWindow, CHAT_PAGE, PARTITION };
