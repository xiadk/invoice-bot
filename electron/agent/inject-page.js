/**
 * electron/agent/inject-page.js —— 在 1688 聊天页里执行的脚本（**由主进程作为文本注入，不是模块**）
 *
 * 来源：移植自旧浏览器扩展的 content.js（扩展通道 2026-10-14 已下线；该逻辑已在真实环境验证过）。改动：
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
  // ⚠ 必须排除「输入框自身」：1688 的输入框与已发送消息都用 pre.edit 渲染。
  //   排除规则不能只比对节点身份（editorEl）：发送后 React 可能重建编辑器 DOM 节点，
  //   旧节点引用失效 → 草稿滞留在「新编辑器节点」里会被误判成「已发送」（严格自测抓到过）。
  //   因此这里排除**所有** contenteditable 元素（编辑器无论怎么重建都不是聊天记录）。
  // ⚠ 比对前去掉所有空白：1688 回显时换行/缩进可能与原文不同，严格比对会误判「发送未确认」→ 重复发送。
  //
  // ⚠ 2026-10-25 真机复测（订单 3312608485660047261 那批全部报「发送未确认」）发现：
  //   新版 IM 里「自己发的消息」渲染成 .message-item.self > .content，**不是每条消息都有 pre.edit**
  //   （pre.edit 只出现在模板消息/部分气泡里）。只扫 pre.edit 会在虚拟列表下漏检 → 明明发出去了却判失败，
  //   于是每条都报失败、整批中断，重试路径还可能重复发送。
  //   改为：优先扫整个 .message-list 的可见文本（实测包含全部消息，含自己发的），pre.edit 作为兜底。
  var normText = function (s) { return String(s || '').replace(/\s+/g, ''); };

  /** 聊天记录区域的可见文本（不含输入框，因为输入框不在 message-list 内） */
  // ⚠ 2026-10-26：长会话下每次都要把整个 message-list 拼串再 indexOf，是隐藏的卡顿源
  //   （发送确认每 250ms 轮询一次，会话越长越慢）。新消息永远追加在列表尾部，
  //   因此只保留尾部片段参与比对即可（既看得到新消息，也控住了计算量）。
  var HISTORY_TAIL_LEN = 30000;
  function chatAreaText() {
    var sel = '.message-list, [class*="message-list"], .ww_message';
    var boxes = document.querySelectorAll(sel);
    var out = '';
    for (var i = 0; i < boxes.length; i++) {
      // 只取最外层：避免父子容器重复累加
      var isNested = false;
      for (var k = 0; k < i; k++) {
        if (boxes[k].contains(boxes[i])) { isNested = true; break; }
      }
      if (isNested) continue;
      out += ' ' + (boxes[i].innerText || '');
    }
    out = normText(out);
    return out.length > HISTORY_TAIL_LEN ? out.slice(-HISTORY_TAIL_LEN) : out;
  }

  function countOccur(hay, needle) {
    if (!needle) return 0;
    var n = 0, i = 0;
    for (;;) {
      var p = hay.indexOf(needle, i);
      if (p < 0) break;
      n++; i = p + needle.length;
    }
    return n;
  }

  /** 该片段在聊天记录里出现的次数（发送前记基线，发送后比对增量 → 内容重复也不会误判） */
  function historyCount(frag) {
    var target = normText(frag);
    if (!target) return 0;
    var area = chatAreaText();
    if (area) return countOccur(area, target);
    // 兜底：旧结构直接用气泡节点
    var els = Array.prototype.slice.call(document.querySelectorAll('pre.edit'));
    var txt = '';
    els.forEach(function (e) {
      if (e.getAttribute && e.getAttribute('contenteditable') === 'true') return;
      txt += ' ' + normText(e.innerText);
    });
    return countOccur(txt, target);
  }

  function historyContains(frag, editorEl) {
    return historyCount(frag) > 0;
  }

  /** 输入框是否已空（1688 发送成功后会把草稿清掉，这是与聊天记录无关的独立判据） */
  function editorEmpty(editor) {
    return !normText(editor && editor.innerText);
  }

  /** 发送单条消息（含一次重试） */
  async function sendOne(msg) {
    var normMsg = normText(msg);
    // 空内容发送必然失败（页面上等于点了个空发送），立即报明确原因而不是空转到超时
    if (!normMsg) return { ok: false, error: '消息内容为空（服务端消息模板未配置）' };
    var frag = normMsg.length > 30 ? normMsg.slice(-30) : normMsg;
    var beforeCount = historyCount(frag);       // 发送前基线：已存在同样内容也能识别新增
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        dismissModals();
        var ed = findEditor();
        if (!ed) throw new Error('编辑器丢失');
        ed.focus();
        ed.click();
        if (!editorEmpty(ed)) {
          selectAll(ed);
          document.execCommand('delete');
          await sleep(180);
        }
        insertText(ed, msg);
        await sleep(250);
        var head = normText(String(msg).slice(0, 10));
        if (head && normText(ed.innerText).indexOf(head) < 0) throw new Error('消息未成功输入编辑器');
        var btn = findSendBtn();
        var clicked = false;
        if (btn) {
          var disabled = !!btn.disabled
            || /disabled/i.test(String(btn.className || ''))
            || (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true');
          if (!disabled) { try { btn.click(); clicked = true; } catch (e) { clicked = false; } }
        }
        if (!clicked) pressEnter(ed);
        // 判定成败：① 聊天记录里该片段出现次数增加（最可靠）② 输入框被清空（页面已收下这条消息）
        for (var i = 0; i < 24; i++) {
          await sleep(250);
          if (historyCount(frag) > beforeCount) return { ok: true, via: 'history' };
          if (editorEmpty(ed)) return { ok: true, via: 'cleared' };
        }
        // 还没确认：只有草稿仍在输入框里才「可能没发出去」，此时补一次回车
        if (!editorEmpty(ed)) {
          pressEnter(ed);
          for (var j = 0; j < 12; j++) {
            await sleep(250);
            if (historyCount(frag) > beforeCount) return { ok: true, via: 'history2' };
            if (editorEmpty(ed)) return { ok: true, via: 'cleared2' };
          }
          throw new Error(clicked
            ? '发送未确认（草稿仍在输入框，消息可能未发出）'
            : '未找到可用发送按钮，且回车发送未确认');
        }
        // 输入框已清空、聊天记录暂未渲染（虚拟列表延迟）：按已发送处理，避免重复发
        return { ok: true, via: 'cleared-no-history' };
      } catch (e) {
        if (attempt === 1) return { ok: false, error: e.message };
        await sleep(1500);
      }
    }
    return { ok: false, error: '发送失败' };
  }

  /** 依次发送一组消息 */
  async function sendBatch(messages) {
    // 先剔掉空消息：服务端一旦下发了空文案（模板被清空的历史问题），
    // 原来会一条条「输入空内容→点发送→找不到聊天记录」空转到超时，最后只报「发送未确认」。
    var list = (messages || []).filter(function (m) { return normText(m); });
    if (!list.length) return { ok: false, error: '消息内容为空（服务端消息模板未配置），未发送任何消息' };
    var dropped = (messages || []).length - list.length;
    var editor = await waitEditor(30000);
    if (!editor) return { ok: false, error: '聊天编辑器未出现（可能未登录 1688，或页面结构变化）' };
    dismissModals();
    for (var i = 0; i < list.length; i++) {
      var r = await sendOne(list[i]);
      if (!r.ok) return { ok: false, error: '第 ' + (i + 1) + '/' + list.length + ' 条消息发送失败：' + r.error };
      if (i < list.length - 1) await sleep(1200 + Math.random() * 1300);
    }
    return dropped > 0 ? { ok: true, warning: '已跳过 ' + dropped + ' 条空消息' } : { ok: true };
  }

  /** 就绪/登录态探测：能拿到编辑器即可视为已登录 */
  async function ping() {
    return { ok: true, chat: isChatFrame(), hasEditor: !!findEditor(), url: location.href };
  }
  async function waitReady(timeoutMs) {
    var ed = await waitEditor(timeoutMs || 30000);
    return { ok: !!ed, hasEditor: !!ed, url: location.href };
  }

  /** 通道自检：定位编辑器 → 输入文本 → 校验文本确实进了编辑器 → 找到发送按钮，
   *  随后**清空输入框**（绝不点发送）。用于在真实环境验证发送通道而无需惊动卖家。 */
  async function selfTest(probeText) {
    var text = probeText || ('通道自检 ' + Date.now());
    var out = { ok: false, url: location.href };
    try {
      dismissModals();
      var ed = await waitEditor(15000);
      if (!ed) { out.error = '编辑器未出现'; return out; }
      ed.focus(); ed.click();
      if ((ed.innerText || '').trim()) { selectAll(ed); document.execCommand('delete'); await sleep(180); }
      insertText(ed, text);
      await sleep(300);
      var norm = function (s) { return String(s || '').replace(/\s+/g, ''); };
      var typed = norm(ed.innerText).indexOf(norm(text).slice(0, 6)) >= 0;
      var btn = findSendBtn();
      out.typed = typed;
      out.sendBtn = !!btn;
      out.sendBtnText = btn ? (btn.innerText || '').trim().slice(0, 10) : '';
      out.editorTag = ed.tagName;
      out.editorClass = String(ed.className || '');
      out.historyPreEdit = document.querySelectorAll('pre.edit').length;
      // 清空，避免误发
      selectAll(ed); document.execCommand('delete');
      await sleep(200);
      out.cleared = !norm(ed.innerText);
      out.ok = !!typed && !!out.cleared;
      if (!typed) out.error = '文本未成功进入编辑器（编辑器可能被遮挡或页面未就绪）';
      else if (!out.cleared) out.error = '自检文本未能清空，请手动检查输入框';
      return out;
    } catch (e) {
      out.error = e && e.message ? e.message : String(e);
      return out;
    }
  }

  window.__xsh = {
    ping: ping, waitReady: waitReady, sendBatch: sendBatch, sendOne: sendOne,
    isChatFrame: isChatFrame, selfTest: selfTest,
    // 只读诊断入口（不发送）：排查「发送未确认」用
    _debug: function (probeText) {
      var ed = findEditor();
      var btn = findSendBtn();
      var t = String(probeText || '');
      return {
        url: location.href,
        hasEditor: !!ed,
        editorEmpty: ed ? editorEmpty(ed) : null,
        sendBtn: !!btn,
        sendBtnText: btn ? String(btn.innerText || '').trim().slice(0, 10) : '',
        sendBtnDisabled: btn ? (!!btn.disabled || /disabled/i.test(String(btn.className || ''))) : null,
        chatTextLen: chatAreaText().length,
        probe: t,
        probeCount: t ? historyCount(t) : null,
        preEdit: document.querySelectorAll('pre.edit').length,
        selfItems: document.querySelectorAll('.message-item.self').length,
        msgItems: document.querySelectorAll('.message-item').length,
      };
    },
  };
})();
