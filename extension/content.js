/**
 * content.js — 在 1688 页面内执行催收消息发送（方案C 本机发送）
 *
 * 运行范围：*://*.1688.com/*（all_frames）
 * 只有「聊天框架」会响应消息：判定条件 = 页面里有聊天编辑器(pre.edit) 或 URL 命中 def_cbu_web_im。
 * 这样同一个 1688 标签页里的其它 iframe 不会误回执。
 *
 * 安全：本脚本只操作当前 1688 页面上的输入框与发送按钮，不读取 Cookie、不上传任何凭据。
 * 选择器与服务器端发送引擎（lib/sender.js）保持一致，便于两边行为对齐。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 元素定位 ──
// 1688 旺旺网页版的输入框/发送按钮 class 会随版本变化，这里用「多选择器 + 尺寸过滤」兜底，
// 优先匹配已知的 pre.edit（最常见），其余作为降级，避免一改版就彻底发不出去。
function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 40 || r.height < 12) return false;
  try { if (getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none') return false; } catch (e) { /* 忽略 */ }
  return true;
}
function findEditor() {
  const editables = [
    'pre.edit',
    'div.edit',
    '[contenteditable="true"]',
    'textarea',
    'div[class*="editor"]',
    'div[class*="chat-input"]',
    'div[class*="input"]',
  ];
  for (const sel of editables) {
    const list = document.querySelectorAll(sel);
    for (const el of list) {
      const isEditable = el.isContentEditable
        || el.getAttribute('contenteditable') === 'true'
        || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
      if (isEditable && visible(el)) {
        // 排除极小的搜索框/工具栏输入
        if (el.tagName === 'INPUT' && (el.type === 'search' || el.type === 'text') && el.getBoundingClientRect().width < 200) continue;
        return el;
      }
    }
  }
  // 兜底：任意可见的 contenteditable
  const all = document.querySelectorAll('[contenteditable="true"]');
  for (const el of all) if (visible(el)) return el;
  return null;
}
function findSendBtn() {
  const candidates = document.querySelectorAll('button, input[type="button"], a.btn, [role="button"]');
  for (const b of candidates) {
    if (!visible(b)) continue;
    const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.value || '') + ' ' + (b.className || '') + ' ' + (b.id || '')).toLowerCase();
    if (/发送|send|submit/.test(t)) return b;
  }
  return document.querySelector('button.send-btn') || null;
}
function isChatFrame() {
  return !!findEditor() || !!findSendBtn() || /def_cbu_web_im|web_im|im\.1688/.test(location.href);
}
async function waitEditor(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const e = findEditor();
    if (e) return e;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(300);
  }
}

// ── 弹窗清理（引导/营销遮罩会挡住编辑器与按钮）──
function dismissModals() {
  try {
    const wraps = document.querySelectorAll('.ant-modal-wrap, .ant-modal-mask');
    let blocking = false;
    wraps.forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') blocking = true;
    });
    if (!blocking) return;
    const btns = [...document.querySelectorAll('button, .ant-modal-close')];
    for (const b of btns) {
      const t = (b.innerText || '').trim();
      if (t === '我知道了' || t === 'OK' || t === '跳过' || b.classList.contains('ant-modal-close')) {
        try { b.click(); } catch (e) { /* 忽略 */ }
      }
    }
    wraps.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && getComputedStyle(el).display !== 'none') el.remove();
    });
  } catch (e) { /* 忽略 */ }
}

// ── 输入 ──
function selectAll(editor) {
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
function insertText(editor, text) {
  editor.focus();
  selectAll(editor);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
  const cur = (editor.innerText || '').trim();
  if (!ok || !cur) {
    // 兜底：直接写内容并派发 input 事件，让 React 感知
    editor.textContent = text;
    try {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    } catch (e) {
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}
function pressEnter(editor) {
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  editor.dispatchEvent(new KeyboardEvent('keydown', opts));
  editor.dispatchEvent(new KeyboardEvent('keypress', opts));
  editor.dispatchEvent(new KeyboardEvent('keyup', opts));
}
// 聊天记录里是否出现该片段。
// ⚠ 必须排除「输入框自身」：1688 的输入框与已发送消息都用 pre.edit 渲染，若不排除，
//   刚键入的草稿会被当成「已发送」，发送失败也会误报成功。
function historyContains(frag, editorEl) {
  const els = [...document.querySelectorAll('pre.edit')];
  return els.some((e) => {
    if (editorEl && e === editorEl) return false;
    return (e.innerText || '').includes(frag);
  });
}

/** 发送单条消息（含一次重试） */
async function sendOne(editor, msg) {
  const frag = msg.length > 30 ? msg.slice(-30) : msg;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      dismissModals();
      const ed = findEditor();
      if (!ed) throw new Error('编辑器丢失');
      ed.focus();
      ed.click();
      if ((ed.innerText || '').trim()) {
        selectAll(ed);
        document.execCommand('delete');
        await sleep(180);
      }
      insertText(ed, msg);
      await sleep(250);
      // 容错比较：去掉空白后看前若干字符是否已进入编辑器（富文本可能规范化换行/全角空格）
      const head = msg.slice(0, 10).replace(/\s+/g, '');
      const inEd = (ed.innerText || '').replace(/\s+/g, '');
      if (head && !inEd.includes(head)) throw new Error('消息未成功输入编辑器');
      const btn = findSendBtn();
      if (btn) {
        btn.click();
      } else {
        // 兜底：没有发送按钮就直接回车发送
        pressEnter(ed);
      }
      for (let i = 0; i < 24; i++) { await sleep(250); if (historyContains(frag, ed)) return { ok: true }; }
      // 点击没出结果，再尝试回车兜底（部分聊天框回车即发送）
      pressEnter(ed);
      for (let i = 0; i < 12; i++) { await sleep(250); if (historyContains(frag, ed)) return { ok: true }; }
      throw new Error(btn ? '发送未确认（消息未出现在聊天记录）' : '未找到发送按钮，且回车发送未确认');
    } catch (e) {
      if (attempt === 1) return { ok: false, error: e.message };
      await sleep(1500);
    }
  }
  return { ok: false, error: '发送失败' };
}

/** 依次发送一组消息 */
async function sendMessages(messages) {
  const editor = await waitEditor(30000);
  if (!editor) return { ok: false, error: '聊天编辑器未出现（可能未登录 1688，或页面结构变化）' };
  dismissModals();
  for (let i = 0; i < messages.length; i++) {
    const r = await sendOne(editor, messages[i]);
    if (!r.ok) return { ok: false, error: `第 ${i + 1}/${messages.length} 条消息发送失败：${r.error}` };
    if (i < messages.length - 1) await sleep(1200 + Math.random() * 1300);
  }
  return { ok: true };
}

// ── 与扩展后台通信 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (!isChatFrame()) return; // 非聊天框架不响应，避免误回执

  if (msg.type === 'AGENT_PING') {
    sendResponse({ ok: true, chat: true, hasEditor: !!findEditor(), url: location.href });
    return true;
  }
  if (msg.type === 'AGENT_SEND') {
    // 只有本 frame 真正持有聊天输入框才处理，避免顶层 frame 抢先回「无编辑器」而让内层 frame 的成功响应丢失
    if (!findEditor()) return false;
    sendMessages(Array.isArray(msg.messages) ? msg.messages : [])
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // 异步响应
  }
});

// 页面加载后主动上报一次登录态（聊天框架能加载出编辑器即视为已登录）
(async () => {
  if (!isChatFrame()) return;
  const ed = await waitEditor(20000);
  try {
    chrome.runtime.sendMessage({ type: 'LOGIN_STATE', loggedIn: !!ed, url: location.href });
  } catch (e) { /* 后台未就绪时忽略 */ }
})();
