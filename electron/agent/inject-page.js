/**
 * electron/agent/inject-page.js —— 在 1688 聊天页里执行的脚本（**由主进程作为文本注入，不是模块**）
 *
 * 来源：移植自 extension/content.js（该逻辑已在真实环境验证过）。改动：
 *   · 去掉 chrome.runtime 通信段（桌面程序里由主进程用 frame.executeJavaScript 直接调用）
 *   · 改为把能力挂到 window.__xsh，供主进程调用：__xsh.ping() / __xsh.sendBatch(messages)
 *   · 其余（编辑器定位、弹窗清理、输入、发送、聊天记录校验）**保持原样**，两边行为一致
 *
 * 安全：只操作当前页面的输入框与发送按钮；不读 Cookie、不上传任何凭据。
 */
(function () {
  'use strict';
  if (window.__xsh) return; // 已注入

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) return false;
    try {
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    } catch (e) { /* 忽略 */ }
    return true;
  }

  function findEditor() {
    var editables = [
      'pre.edit', 'div.edit', '[contenteditable="true"]', 'textarea',
      'div[class*="editor"]', 'div[class*="chat-input"]', 'div[class*="input"]',
    ];
    for (var i = 0; i < editables.length; i++) {
      var list = document.querySelectorAll(editables[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        var isEditable = el.isContentEditable
          || el.getAttribute('contenteditable') === 'true'
          || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
        if (!isEditable || !visible(el)) continue;
        // 排除极小的搜索框/工具栏输入
        if (el.tagName === 'INPUT' && (el.type === 'search' || el.type === 'text')
            && el.getBoundingClientRect().width < 200) continue;
        return el;
      }
    }
    var all = document.querySelectorAll('[contenteditable="true"]');
    for (var k = 0; k < all.length; k++) if (visible(all[k])) return all[k];
    return null;
  }

  function findSendBtn() {
    var candidates = document.querySelectorAll('button, input[type="button"], a.btn, [role="button"]');
    for (var i = 0; i < candidates.length; i++) {
      var b = candidates[i];
      if (!visible(b)) continue;
      var t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.value || '')
        + ' ' + (b.className || '') + ' ' + (b.id || '')).toLowerCase();
      if (/发送|send|submit/.test(t)) return b;
    }
    return document.querySelector('button.send-btn') || null;
  }

  function isChatFrame() {
    return !!findEditor() || !!findSendBtn() || /def_cbu_web_im|web_im|im\.1688/.test(location.href);
  }

  async function waitEditor(timeoutMs) {
    var t0 = Date.now();
    for (;;) {
      var e = findEditor();
      if (e) return e;
      if (Date.now() - t0 >= timeoutMs) return null;
      await sleep(300);
    }
  }

  function dismissModals() {
    try {
      var wraps = document.querySelectorAll('.ant-modal-wrap, .ant-modal-mask');
      var blocking = false;
      wraps.forEach(function (el) {
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') blocking = true;
      });
      if (!blocking) return;
      var btns = Array.prototype.slice.call(document.querySelectorAll('button, .ant-modal-close'));
      btns.forEach(function (b) {
        var t = (b.innerText || '').trim();
        if (t === '我知道了' || t === 'OK' || t === '跳过' || b.classList.contains('ant-modal-close')) {
          try { b.click(); } catch (e) { /* 忽略 */ }
        }
      });
      wraps.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width > 0 && getComputedStyle(el).display !== 'none') el.remove();
      });
    } catch (e) { /* 忽略 */ }
  }

  function selectAll(editor) {
    var range = document.createRange();
    range.selectNodeContents(editor);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertText(editor, text) {
    editor.focus();
    selectAll(editor);
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    var cur = (editor.innerText || '').trim();
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
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent('keydown', opts));
    editor.dispatchEvent(new KeyboardEvent('keypress', opts));
    editor.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // 聊天记录里是否出现该片段。
  // ⚠ 必须排除「输入框自身」：1688 的输入框与已发送消息都用 pre.edit 渲染，
  //   若不排除，刚键入的草稿会被当成「已发送」，发送失败也会误报成功（本测试 tmp-inject-kernel.js 抓到）。
  function historyContains(frag, editorEl) {
    var els = Array.prototype.slice.call(document.querySelectorAll('pre.edit'));
    return els.some(function (e) {
      if (editorEl && e === editorEl) return false;
      return (e.innerText || '').indexOf(frag) >= 0;
    });
  }

  /** 发送单条消息（含一次重试） */
  async function sendOne(msg) {
    var frag = msg.length > 30 ? msg.slice(-30) : msg;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        dismissModals();
        var ed = findEditor();
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
        var head = msg.slice(0, 10).replace(/\s+/g, '');
        var inEd = (ed.innerText || '').replace(/\s+/g, '');
        if (head && inEd.indexOf(head) < 0) throw new Error('消息未成功输入编辑器');
        var btn = findSendBtn();
        if (btn) btn.click(); else pressEnter(ed);
        for (var i = 0; i < 24; i++) { await sleep(250); if (historyContains(frag, ed)) return { ok: true }; }
        pressEnter(ed);
        for (var j = 0; j < 12; j++) { await sleep(250); if (historyContains(frag, ed)) return { ok: true }; }
        throw new Error(btn ? '发送未确认（消息未出现在聊天记录）' : '未找到发送按钮，且回车发送未确认');
      } catch (e) {
        if (attempt === 1) return { ok: false, error: e.message };
        await sleep(1500);
      }
    }
    return { ok: false, error: '发送失败' };
  }

  /** 依次发送一组消息 */
  async function sendBatch(messages) {
    var editor = await waitEditor(30000);
    if (!editor) return { ok: false, error: '聊天编辑器未出现（可能未登录 1688，或页面结构变化）' };
    dismissModals();
    for (var i = 0; i < messages.length; i++) {
      var r = await sendOne(messages[i]);
      if (!r.ok) return { ok: false, error: '第 ' + (i + 1) + '/' + messages.length + ' 条消息发送失败：' + r.error };
      if (i < messages.length - 1) await sleep(1200 + Math.random() * 1300);
    }
    return { ok: true };
  }

  /** 就绪/登录态探测：能拿到编辑器即可视为已登录 */
  async function ping() {
    return { ok: true, chat: isChatFrame(), hasEditor: !!findEditor(), url: location.href };
  }
  async function waitReady(timeoutMs) {
    var ed = await waitEditor(timeoutMs || 30000);
    return { ok: !!ed, hasEditor: !!ed, url: location.href };
  }

  window.__xsh = { ping: ping, waitReady: waitReady, sendBatch: sendBatch, isChatFrame: isChatFrame };
})();
