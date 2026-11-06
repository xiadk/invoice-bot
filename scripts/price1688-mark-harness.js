// 功能测试：SET_MARK 注入（打备注 + 上色）——选中颜色 radio、填备注文本、点确定。
// 在 stub DOM 上运行 INJECT + SET_MARK(colorValue, memoText)，断言返回 ok:true 且拿到了对话框里的状态。
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent', 'price-1688.js'), 'utf8');

function getConst(name) {
  const m = new RegExp('const ' + name + ' = `').exec(src);
  if (!m) throw new Error('constant not found: ' + name);
  const open = src.indexOf('`', m.index), close = src.indexOf('`', open + 1);
  if (close < 0) throw new Error('unterminated: ' + name);
  return Function('return `' + src.slice(open + 1, close) + '`')();
}
const INJECT = getConst('INJECT');
const SET_MARK = getConst('SET_MARK');

// —— 更完整的 matcher：支持 *  / tag  / .class  / tag.class  / tag[attr="v"] ——
function El(tag, cls) {
  this.tagName = String(tag || 'DIV').toUpperCase();
  this.className = cls || '';
  this.children = [];
  this.attrs = {};
  this.shadowRoot = null;
  this._t = '';
}
El.prototype.setText = function (s) { this._t = s; return this; };
El.prototype.setAttr = function (k, v) { this.attrs[k] = v; return this; };
El.prototype.append = function () { for (const c of arguments) this.children.push(c); return this; };
El.prototype.setShadow = function (children) {
  const sh = new El('#shadow-root');
  for (const c of children) sh.append(c);
  this.shadowRoot = sh;
  return this;
};
El.prototype.getAttribute = function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; };
El.prototype.scrollIntoView = function () {};
El.prototype.getBoundingClientRect = function () { return { width: 10, height: 10 }; };
Object.defineProperty(El.prototype, 'innerText', { get() { return this._t; } });
El.prototype.dispatchEvent = function (ev) {
  this._lastEvent = { type: ev && ev.type };
  (this._on || {}).bubbles = true;
  return true;
};

function allDesc(root) { const out = []; (function w(n){ for (const c of n.children||[]) { out.push(c); w(c); } })(root); return out; }

function matchSel(ctx, sel) {
  const kids = allDesc(ctx);
  const mTag = /^([a-zA-Z][\w-]*)$/.exec(sel);
  const mCls = /^\.([\w-]+)$/.exec(sel);
  const mTagCls = /^([a-zA-Z][\w-]*)\.([\w-]+)$/.exec(sel);
  const mAttr = /^([a-zA-Z][\w-]*)\[([\w-]+)="([^"]*)"\]$/.exec(sel);
  const mTagClsAttr = /^([a-zA-Z][\w-]*)\.([\w-]+)\[?([\w-]*)="?([^"]*)"?\]?$/.exec(sel);
  function match(e, token) {
    const t = String(token || '').toLowerCase();
    return e.tagName.toLowerCase() === t;
  }
  if (sel === '*') return kids;
  if (mAttr) { const [, tg, at, v] = mAttr; return kids.filter(e => match(e, tg) && e.getAttribute(at) === v); }
  if (mTagCls) { const [, tg, cl] = mTagCls; return kids.filter(e => match(e, tg) && String(e.className).split(/\s+/).indexOf(cl) >= 0); }
  if (mTagClsAttr) { const [, tg, cl, at, v] = mTagClsAttr; return kids.filter(e => match(e, tg) && String(e.className).split(/\s+/).indexOf(cl) >= 0 && (!at || e.getAttribute(at) === v)); }
  if (mTag) return kids.filter(e => match(e, mTag[1]));
  if (mCls) return kids.filter(e => String(e.className).split(/\s+/).indexOf(mCls[1]) >= 0);
  return [];
}
El.prototype.querySelectorAll = function (sel) { return matchSel(this, sel); };
El.prototype.querySelector = function (sel) { return matchSel(this, sel)[0] || null; };

// —— stub 对话框结构 ——
// 顶层：document > q-dialog.dialog-memo(visible=true) > q-radio[value=3](影子含 inner input) + q-textarea(影子含 textarea) + .memo-footer(q-button)
const radio = new El('q-radio').setAttr('value', '3');
radio.setShadow([new El('input', 'el-radio-input')]);
const qta = new El('q-textarea');
const ta = new El('textarea');
ta.setAttr('value', '');
qta.setShadow([ta]);
const okBtn = new El('q-button', 'primary');
const footer = new El('div', 'memo-footer').append(okBtn);
const dlg = new El('q-dialog', 'dialog-memo').setAttr('visible', 'true').append(radio, qta, footer);
// document 根
const doc = new El('html').append(dlg);

// window stub：SET_MARK 用到 window.HTMLTextAreaElement.prototype.value 原生 setter
const taValueSetter = function (v) { this._vtxt = v; };
class FakeTextAreaEl {}
Object.defineProperty(FakeTextAreaEl.prototype, 'value', { set: taValueSetter, get() { return this._vtxt || ''; } });
if (!global.MouseEvent) global.MouseEvent = function (type, o) { return { type, bubbles: o && o.bubbles, cancelable: o && o.cancelable }; };
if (!global.Event) global.Event = function (type, o) { return { type, bubbles: o && o.bubbles }; };
const winStub = { HTMLTextAreaElement: FakeTextAreaEl };
const docStub = { querySelectorAll(sel) { return sel === undefined ? [] : matchSel(doc, sel); }, querySelector(sel) { return matchSel(doc, sel)[0] || null; } };

let result, err = null;
try {
  result = new Function('window', 'document', INJECT + '\n;return (' + SET_MARK + `('3','补货备注'));`)(
    winStub, docStub
  );
} catch (e) { err = e; }

if (err) { console.log('THREW: ' + err.stack); process.exit(2); }
console.log('setMark result:', JSON.stringify(result));
console.log('textarea value set to:', JSON.stringify(ta._vtxt));

const pass = (result && result.ok === true && result.pickedRadio === true && result.pickedTextarea === true && result.pickedOk === true
  && ta._vtxt === '补货备注');
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
