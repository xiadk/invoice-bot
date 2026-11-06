/**
 * lib/price-check.js — 1688 待付款订单采购价核对（纯计算层）
 *
 * 数据来源与归口：
 *   · 本模块不碰浏览器、不碰 1688 页面。待付款订单由**本机助手**抓取后，把订单项
 *     （link / name / spec / unit_price / quantity）POST 给 `POST /api/price-check`，
 *     server 端用它算完判定，再把结果写 `price_check` 审计表、回给助手 / 前端弹窗。
 *   · 目标价 = 当前用户导入的「前置仓补货参考」里的「采购单价(基础单位)」，
 *     通过 1688 供应商维度（supplier_link / supplier_name / supplier_spec / order_ratio）匹配。
 *
 * 口径与 1688 价格检查工具（Python 版）保持一致，去掉旺旺谈价与橙色：
 *   · order_ratio：供应商一个销售单位含基础单位数（一箱12桶=12）。
 *   · 基础单位到手价 = 规格价/order_ratio + 分摊运费(按商品金额占比)。
 *   · 目标采购单价本身就是基础单位到手价口径，目标侧不再加运费（避免重复计费）。
 *   · 三色：blue(合理) / yellow(价格异常 或 采购量过高) / green(新品，月销为0)；未匹配→unmatched。
 *
 * v0.3.43 首版。
 */

// 各判定阈值默认值（与补货页比价分析解耦；运行时可从入参覆盖）。
const DEFAULTS = {
  priceRatio: 0.05,        // 单价涨幅阈值：涨幅 < 5% 才算合理（否则 yellow）
  priceAmount: 5,          // 单价金额阈值：差价 < 5 元才算合理
  totalRatio: 0.03,        // 整单总额阈值：当前总金额 / 目标总金额 > 103% → 视为价格异常
  totalAmount: 8,          // 整单总额阈值：当前总金额 − 目标总金额 > 8 元 → 视为价格异常
  checkSales: false,       // 是否检查采购量过高（黄色提示）
  salePercentage: 0.5,     // 采购量过高阈值：基础单位采购量 / 月销 ≥ 50%
};

/** 规格归一化：连续空白压成单空格、去首尾空白 */
function _normSpec(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** 规格排列组合（对齐 Python ref_importer：页面规格与库规格可能顺序不同） */
function _specPermutations(spec) {
  const parts = _normSpec(spec).split(' ');
  if (parts.length <= 1) return new Set([_normSpec(spec)]);
  // 规格值两两交换组合即可；超过 3 个不穷举，退化为全排列里最常用的前几种
  const set = new Set();
  for (let i = 0; i < parts.length; i++) {
    for (let j = 0; j < parts.length; j++) {
      if (i === j) continue;
      const p = parts.slice();
      [p[i], p[j]] = [p[j], p[i]];
      set.add(p.join(' '));
    }
  }
  set.add(parts.join(' '));
  return set;
}

/** 子串模糊匹配辅助：互相为子串（最短长度 ≥ 6 才参与，避免过短误配） */
function _isSubstringMatch(a, b) {
  const x = _normSpec(a), y = _normSpec(b);
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

/**
 * 在一个订单项上匹配目标价（在该用户自己的 product_item 范围内）。
 * 顺序：供应商链接精确 → 供应商名+规格（排列组合/子串）→ 无法区分多个 SKU 判歧义 → 返回 null(未匹配)。
 * @param {{link,name,spec}} item 订单项（1688 页面）
 * @param {Array} targets 目标行（product_item，restrict 到当前用户）
 * @returns {object|null} 命中行；识别不出（多 SKU 共用一链接）也返回 null
 */
function matchTarget(item, targets) {
  if (!targets || !targets.length) return null;
  const link = String(item.link || '').trim();
  const name = String(item.name || '').trim();

  // 主候选 = 补货参考（带 1688 供应商维度）；品牌兜底行（_fallback，只有品名与价）不参与
  // 链接/精确名/规格匹配，避免污染既有稳定命中。
  const prim = (t) => !t._fallback;

  // 先按链接收紧候选：链接稳定，绝大多数能直接命中
  let cands = link ? targets.filter((t) => prim(t) && String(t.supplier_link || '').trim() === link) : [];

  // 链接没命中 → 按供应商名 + 规格匹配
  if (!cands.length) {
    if (name) {
      cands = targets.filter((t) => prim(t) && t.supplier_name && String(t.supplier_name).trim() === name);
    }
  }

  if (cands.length) {
    // 只有一个候选 → 直接命中
    if (cands.length === 1) return cands[0];

    // 多个候选：先按规格精确（含排列组合）区分
    const itemSpec = String(item.spec || '').trim();
    if (itemSpec) {
      const perms = _specPermutations(itemSpec);
      const bySpec = cands.filter((t) => perms.has(_normSpec(t.supplier_spec)));
      if (bySpec.length === 1) return bySpec[0];
      // 子串模糊
      const byFuzzy = cands.filter((t) => _isSubstringMatch(itemSpec, t.supplier_spec));
      if (byFuzzy.length === 1) return byFuzzy[0];
    }

    // 多个候选且无法用规格区分 → 歧义，判未匹配（避免把链接对到错误 SKU）
    return null;
  }

  // 兜底（v0.3.50）：商品同步进来的 brand_product 无 1688 链接、goodsId 体系与 1688 不同，
  // 只能按品名做子串兜底（≥6 字符）；精确相等优先，命中多个仍歧义 → 判未匹配，宁可漏也不配错价。
  if (name) {
    const fb = targets.filter((t) => t._fallback && (t.goods_name || t.supplier_name));
    if (fb.length) {
      const norm = _normSpec(name);
      const byName = fb.filter((t) => {
        const a = _normSpec(t.goods_name), b = _normSpec(t.supplier_name);
        return _isSubstringMatch(norm, a) || _isSubstringMatch(norm, b);
      });
      const exact = byName.filter((t) => {
        const a = _normSpec(t.goods_name), b = _normSpec(t.supplier_name);
        return a === norm || b === norm;
      });
      if (exact.length === 1) return exact[0];
      if (byName.length === 1) return byName[0];
    }
  }

  return null;
}

/** 分摊运费：按各订单项金额占总金额的比例分摊（贵的多摊）；包邮则不分摊 */
function _allocFreight(freight, items) {
  if (!freight || freight <= 0) return items.map(() => 0);
  const totalAmount = items.reduce((s, it) => s + it.unit_price * it.quantity, 0);
  if (totalAmount <= 0) return items.map(() => 0);
  return items.map((it) => freight * (it.unit_price * it.quantity) / totalAmount);
}

/** 整单当前总金额（含运费，实付口径） */
function _currentTotal(items, freight) {
  return items.reduce((s, it) => s + it.unit_price * it.quantity, 0) + (freight || 0);
}

/** 整单目标总金额：匹配商品按 target×数量×ratio，未匹配按当前价计入（目标侧不加运费） */
function _targetTotal(items, freightShares, targets) {
  let total = 0;
  items.forEach((it, i) => {
    const t = matchTarget(it, targets);
    if (t) total += (t.purchase_price || 0) * it.quantity * (t.order_ratio || 1);
    else total += it.unit_price * it.quantity;
  });
  return total;
}

/**
 * 检查一个订单项，返回判定行（与 price_check 表列对齐）。
 */
function _checkOne(item, target, baseQty, freightShare, orderTotal, targetTotal, opts, orderId, orderTime) {
  const ratio = Number(target.order_ratio) > 0 ? Number(target.order_ratio) : 1;
  const targetPrice = Number(target.purchase_price) || 0;
  const specPrice = item.unit_price || 0;

  // 基础单位实际到手价 = 规格价/ratio + 分摊运费的单价（分摊到基础单位）
  let actualPrice = specPrice / ratio;
  if (freightShare > 0 && baseQty > 0) actualPrice += freightShare / baseQty;
  actualPrice = Math.round(actualPrice * 10000) / 10000;

  const diff = Math.round((actualPrice - targetPrice) * 100) / 100;
  const priceRatio = targetPrice !== 0 ? Math.round((diff / targetPrice) * 10000) / 10000 : Infinity;

  const isReasonable = priceRatio < opts.priceRatio && diff < opts.priceAmount;

  const sales = Number(target.sales_30d) || 0;
  const isNewProduct = sales === 0;

  let isQtyTooHigh = false;
  let qtyTooHighPct = 0;
  if (opts.checkSales && sales > 0) {
    const r = baseQty / sales;
    if (r >= opts.salePercentage) { isQtyTooHigh = true; qtyTooHighPct = r; }
  }

  // 整单维度：整单实付未超目标总额，则不判价格异常（低价品抵消高价涨幅）
  let isPriceIssue = !isReasonable;
  if (isPriceIssue && orderTotal <= targetTotal) isPriceIssue = false;
  // 整单总额超阈值也视为价格异常（整单买的比目标多很多）
  if (targetTotal > 0 && !isPriceIssue) {
    if (orderTotal / targetTotal > 1 + opts.totalRatio || orderTotal - targetTotal > opts.totalAmount) {
      isPriceIssue = true;
    }
  }

  // 三色判定（对齐 Python 去橙色）：采购量过高 > 新品 > 价格异常 > 合理
  let verdict, reason;
  if (opts.checkSales && isQtyTooHigh) { verdict = 'yellow'; reason = 'qty_too_high'; }
  else if (isNewProduct) { verdict = 'green'; reason = 'new_product'; }
  else if (isPriceIssue) { verdict = 'yellow'; reason = 'price_issue'; }
  else { verdict = 'blue'; reason = 'all_reasonable'; }

  const memo = buildMemo({ target, item, ratio, targetPrice, actualPrice, priceRatio, sales, isNewProduct, isQtyTooHigh, baseQty, qtyTooHighPct, isPriceIssue });

  return {
    order_id: orderId || '',
    order_time: orderTime || '',
    link: item.link || '',
    item_name: item.name || '',
    spec: item.spec || '',
    sku: target.sku || '',
    goods_name: target.goods_name || '',
    supplier_name: target.supplier_name || item.name || '',
    supplier_spec: target.supplier_spec || item.spec || '',
    supplier_link: target.supplier_link || item.link || '',
    order_ratio: ratio,
    quantity: item.quantity || 0,
    base_quantity: Math.round(baseQty * 100) / 100,
    spec_price: specPrice,
    target_price: targetPrice,
    actual_price: actualPrice,
    freight_share: Math.round(freightShare * 100) / 100,
    paid_amount: Math.round(actualPrice * baseQty * 100) / 100,
    price_diff: diff,
    price_ratio: priceRatio,
    sales_30d: sales,
    matched: 1,
    verdict,
    reason,
    is_qty_too_high: isQtyTooHigh,
    memo_text: memo,
  };
}

/** 生成要写到 1688 备注的文本（去掉谈价相关字段；对齐 Python 三色共同格式：异常才带涨幅） */
function buildMemo({ target, item, ratio, targetPrice, actualPrice, priceRatio, sales, isNewProduct, isQtyTooHigh, baseQty, qtyTooHighPct, isPriceIssue }) {
  const spec = _normSpec(target.supplier_spec || item.spec);
  const base = spec ? `${target.supplier_name || item.name} ${spec}` : (target.supplier_name || item.name);
  const prefix = isNewProduct ? '新品 ' : '';
  if (targetPrice === 0) return `${prefix}${base}`; // 目标价缺失，只留商品名，避免误导

  const salesPart = sales > 0 ? `(月销:${sales})` : '';
  const cols = [`目标采购单价：${targetPrice}${salesPart}`];

  if (isQtyTooHigh) {
    cols.push(`【采购量过高】 当前采购量 ${Math.round(baseQty)}，达到${Math.round(qtyTooHighPct * 100)}%月销`);
  }
  cols.push(`当前采购单价：${Math.round(actualPrice * 100) / 100}`);
  // 价格异常才带涨幅（对齐 Python：合理/新品不放涨幅）；新品 priceRatio 通常为正也可展示
  if (isPriceIssue || isNewProduct) {
    if (Number.isFinite(priceRatio) && priceRatio !== 0) cols.push(`涨幅 ${(priceRatio * 100).toFixed(2)}%`);
  }

  return [`${prefix}${base}`, `商品名称：${target.goods_name || ''}`, `商品SKU：${target.sku || ''}`, `- ${cols.join('，')}`]
    .filter((x) => x && x.trim())
    .join('，');
}

/**
 * 检查一整单待付款订单。
 * @param {object} order { order_id, order_time, total_price, freight, is_free_shipping, items:[] }
 * @param {Array} targets 当前用户的目标行（product_item）
 * @param {object} opts 阈值覆盖（见 DEFAULTS）
 * @returns {{rows:Array, summary:object, order_total, target_total}}
 */
function checkOrder(order, targets, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const items = Array.isArray(order.items) ? order.items : [];
  const freight = order.is_free_shipping ? 0 : (Number(order.freight) || 0);

  const freightShares = _allocFreight(freight, items);
  const orderTotal = _currentTotal(items, freight);
  const targetTotal = _targetTotal(items, freightShares, targets);

  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const t = matchTarget(it, targets);
    const baseQty = (it.quantity || 0) * (t && Number(t.order_ratio) > 0 ? Number(t.order_ratio) : 1);
    if (t) {
      rows.push(_checkOne(it, t, baseQty, freightShares[i], orderTotal, targetTotal, o, order.order_id, order.order_time));
    } else {
      rows.push({
        order_id: order.order_id || '', order_time: order.order_time || '',
        link: it.link || '', item_name: it.name || '', spec: it.spec || '',
        sku: '', goods_name: '', supplier_name: it.name || '', supplier_spec: it.spec || '',
        supplier_link: it.link || '', order_ratio: 1,
        quantity: it.quantity || 0, base_quantity: (it.quantity || 0),
        spec_price: it.unit_price || 0, target_price: 0, actual_price: it.unit_price || 0,
        freight_share: Math.round(freightShares[i] * 100) / 100, sales_30d: 0,
        matched: 0, verdict: 'unmatched', reason: '', is_qty_too_high: 0, memo_text: '',
      });
    }
  }

  const summary = { blue: 0, yellow: 0, green: 0, unmatched: 0 };
  for (const r of rows) summary[r.verdict] = (summary[r.verdict] || 0) + 1;

  return {
    order_id: order.order_id || '',
    order_time: order.order_time || '',
    order_total: Math.round(orderTotal * 100) / 100,
    target_total: Math.round(targetTotal * 100) / 100,
    rows,
    summary,
  };
}

module.exports = { checkOrder, matchTarget, buildMemo, DEFAULTS };
