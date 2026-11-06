// 功能测试：在 stub shadow-DOM 上运行注入的 INJECT + SCRAPE_ORDERS 常量，
// 确认抓包 JS 语法正确并返回订单数组。浏览器路径（executeJavaScript）无法本地测，
// 本 harness 是注入 JS 的真正防线。
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'agent', 'price-1688.js'), 'utf8');

// 按行范围抽取单模板字面量常量（常量内无内嵌反引号）
function getConst(name) {
  const startRe = new RegExp('const ' + name + ' = `');
  const m = startRe.exec(src);
  if (!m) throw new Error('constant not found: ' + name);
  const open = src.indexOf('`', m.index);
  const close = src.indexOf('`', open + 1);
  if (close < 0) throw new Error('unterminated constant: ' + name);
  const raw = src.slice(open + 1, close);
  // 解码模板字面量转义（\$ 和 \\ 等）
  return Function('return `' + raw + '`')();
}

const INJECT = getConst('INJECT');
const SCRAPE = getConst('SCRAPE_ORDERS');

// —— stub DOM ——
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
El.prototype.append = function () { for (const c of arguments) { this.children.push(c); } return this; };
El.prototype.setShadow = function (children) {
  this.shadowRoot = { parent: this, querySelector() { return null; }, querySelectorAll(sel) { return sel === '*' ? children : []; } };
  return this;
};
El.prototype.appendChild = El.prototype.append;
function allDesc(root) { const out = []; (function w(n){ for (const c of n.children||[]) { out.push(c); w(c); } })(root); return out; }
El.prototype.querySelectorAll = function (sel) {
  const kids = allDesc(this);
  if (sel === '*') return kids;
  const m = /^([a-zA-Z][\w-]*)$/.exec(sel);           // 标签名选择器
  if (m) return kids.filter((e) => e.tagName.toLowerCase() === sel.toLowerCase());
  // 类名子串选择器：.class → className 出现该词
  const cm = /^\.([\w-]+)$/.exec(sel);
  if (cm) return kids.filter((e) => String(e.className).split(/\s+/).indexOf(cm[1]) >= 0);
  return [];
};
El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
El.prototype.getAttribute = function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; };
El.prototype.scrollIntoView = function () {};
El.prototype.dispatchEvent = function () { return true; };
El.prototype.getBoundingClientRect = function () { return { width: 10, height: 10 }; };
Object.defineProperty(El.prototype, 'innerText', { get() { return this._t; } });

// 构造一页含 2 单样式各异：一个包邮、一个含运费；一个带备忘、一个不带
const doc = new El('html');
function makeItem(id, opts) {
  const item = new El('order-item');
  const cc = new El('copy-to-clipboard').setText('订单号\n' + id);
  const ot = new El('div', 'order-time').setText(opts.time || '2024-11-06 10:00');
  const tp = new El('div', 'total-price').setText('¥' + opts.total);
  const ca = new El('div', 'carriage').setText(opts.free ? '包邮' : '含运费 ' + opts.freight);
  const ent = new El('div', 'order-item-entry').setAttr('data-entry-id', opts.eid);
  const a = new El('a', 'product-name').setText(opts.pname);
  a.setAttr('href', opts.link);
  const up = new El('span', 'actual-unit-price').setText('¥' + opts.unit);
  const qty = new El('span', 'quantity-amount').setText(String(opts.qty));
  const sku = new El('div', 'sku-info-item').setText('颜色: 黑色  规格: 大码');
  ent.append(a, sku, up, qty);
  const kids = [cc, ot, tp, ca, ent];
  if (opts.memoColor !== undefined) kids.push(new El('icon-memo').setAttr('color', opts.memoColor));
  return item.append.apply(item, kids);
}
const orderWrap = new El('div', 'order-list');
orderWrap.setShadow([
  makeItem('202411061200000001', { total: '123.40', freight: '8.00', eid: 'E1', pname: '样品甲', link: 'https://detail.1688.com/offer/9001.html', unit: '8.80', qty: '12', memoColor: '#4A7BF7' }),
  makeItem('202411061200000002', { total: '56.00', free: true, eid: 'E2', pname: '样品乙', link: 'https://detail.1688.com/offer/9002.html', unit: '9.50', qty: '3', time: '2024-11-05 18:30' }),
]);
doc.append(orderWrap);

// 注入 + 抓取打成一个 script 供 new Function 执行。
// 关键：return 必须在 Function body 顶层（此前 harness 把 return 写进 IIFE 内导致 undefined）
let result, err = null;
try {
  result = new Function('window', 'document', INJECT + '\n;return (' + SCRAPE + ');')(
    {},
    { // document 根：把 light-DOM 指向 html 的子树，deepAll 才能下钻 shadow
      querySelectorAll: (sel) => (sel === '*' ? doc.children : []),
      querySelector: () => null,
    }
  );
} catch (e) { err = e; }

if (err) {
  console.log('THREW: ' + err.stack);
  process.exit(2);
}
console.log('result isArray:', Array.isArray(result), 'length:', result && result.length);
console.log(JSON.stringify(result, null, 2));

// 断言：能抓到 2 单、订单号正确、包邮/运费判定正确、商品解析正确
const pass = (Array.isArray(result) && result.length === 2
  && result[0].order_id === '202411061200000001' && result[0].is_free_shipping === false && result[0].freight === 8
  && result[0].memo_color === '#4A7BF7' && result[0].products[0].name === '样品甲' && result[0].products[0].quantity === 12
  && result[1].is_free_shipping === true && result[1].freight === 0 && !result[1].has_memo);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
