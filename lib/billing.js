/**
 * 账单（按月统计收支）。
 *
 * 口径（用户确认）：
 *   总收入 = 美团预计收入 + 淘宝预计收入 + 京东预计收入     —— 全部手工录入
 *   总支出 = 1688 订单当月总金额 + 拼多多当月实付总金额 + 闪电帮帮当月订单金额
 *          + 齐货通当月订单金额                             —— 系统实时统计，不可编辑
 *          + 各供应商当月货单金额（一个供应商一列，列名=供应商名称）
 *                                                          —— 系统实时统计，不可编辑
 *          + 房租 + 水电 + 人工 + 配送费 + 推广费
 *          + 增值税 + 企业所得税 + 其它                      —— 手工录入
 *   净利润 = 总收入 − 总支出
 *
 * 供应商货单项（v0.3.8，用户要求）：
 *   数据源 waybill（货单管理），按 supplier_id 分组、bill_date 归月、SUM(amount)。
 *   只算未软删除的货单（deleted_at IS NULL）；列名取供应商当前名称（删了供应商则回退快照名）。
 *   原手工列「中心仓 / 自采酒水 / 雪糕 / 果蔬」已删除（这四类采购改由供应商项覆盖），
 *   库里 billing_month 对应字段保留历史值，但不再展示、不再计入总支出。
 *
 * 同名供应商 = 同一批采购（v0.3.9 用户确认）：
 *   「齐货通」既是平台自动项又是供应商（货单 Excel 里那张表），两套账逐笔相同。
 *   这种供应商**不再出独立列**（否则重复计入支出），改为挂在平台自动项上做核对：
 *   每月比对「平台自动项金额」与「同名供应商货单金额」，不一致时前端把金额标红放大，
 *   点金额弹出两边当月明细的左右对比。对照表见 PLATFORM_TOKENS（精确同名才算）。
 *
 * 归月口径：
 *   1688   → COALESCE(pay_time, created_at) 所在月（invoice_order.pay_amount）
 *   拼多多 → order_time 所在月（pdd_order.pay_amount）
 *   闪电帮帮 → order_time 所在月（sdc_order.actual_pay_amount）
 *   齐货通 → order_time 所在月（qht_order.payable_money）
 *   供应商货单 → bill_date 所在月（waybill.amount）
 *
 * 排除口径（v0.2.86 用户确认）——没花出去的钱不算支出：
 *   1688   → 排除 order_status = '待付款' 与 '交易关闭'
 *            （注：另一个文案「等待买家付款」按用户要求保留，口径不要自行合并）
 *   拼多多 → 排除 order_status_text = '交易已取消' 与 '退款成功'
 *   闪电帮帮 → 排除 stage = 5（已关闭·无法开票）与 pay_time 为空（待付款）
 *   齐货通（v0.3.3 用户确认）→ 排除 status_name 含「取消/关闭」的订单，
 *            以及未支付（pay_status≠1 且 pay_flag=0；pay_flag 1/2 是线下结款，算已付）
 *
 * ⚠️ 齐货通的两处 SQL（autoTotals / ORDER_SOURCES 的 auto_qht）排除条件必须完全一致，
 *    否则「账单金额」和「点金额弹出的明细合计」会对不上。1688/拼多多/帮帮同理；
 *    供应商货单也一样（autoTotals 里的 supplierTotals 与 ORDER_SOURCES 的 sup:<id>）。
 *
 * 存储：手工项落 billing_month（一人一月一行）；自动项每次实时聚合，不落库。
 */
const db = require('../db');

/** 行定义（顺序即页面展示顺序）：group=income/expense；source=manual(可编辑)/auto(系统统计) */
const ITEMS = [
  { key: 'income_meituan', label: '美团预计收入', group: 'income', source: 'manual', col: 'income_meituan' },
  { key: 'income_taobao', label: '淘宝预计收入', group: 'income', source: 'manual', col: 'income_taobao' },
  { key: 'income_jd', label: '京东预计收入', group: 'income', source: 'manual', col: 'income_jd' },
  { key: 'auto_1688', label: '1688订单当月总金额', group: 'expense', source: 'auto' },
  { key: 'auto_pdd', label: '拼多多当月实付总金额', group: 'expense', source: 'auto' },
  { key: 'auto_sdc', label: '闪电帮帮当月订单金额', group: 'expense', source: 'auto' },
  { key: 'auto_qht', label: '齐货通当月订单金额', group: 'expense', source: 'auto' },
  // ↓↓↓ 供应商货单项（v0.3.8）在 overview() 里按实际供应商动态插入到这里 ↓↓↓
  { key: 'exp_rent', label: '房租', group: 'expense', source: 'manual', col: 'exp_rent' },
  { key: 'exp_utility', label: '水电', group: 'expense', source: 'manual', col: 'exp_utility' },
  { key: 'exp_labor', label: '人工', group: 'expense', source: 'manual', col: 'exp_labor' },
  { key: 'exp_delivery', label: '配送费', group: 'expense', source: 'manual', col: 'exp_delivery' },
  { key: 'exp_promo', label: '推广费', group: 'expense', source: 'manual', col: 'exp_promo' },
  { key: 'exp_vat', label: '增值税', group: 'expense', source: 'manual', col: 'exp_vat' },
  { key: 'exp_cit', label: '企业所得税', group: 'expense', source: 'manual', col: 'exp_cit' },
  { key: 'exp_other', label: '其它', group: 'expense', source: 'manual', col: 'exp_other' },
];
const MANUAL = ITEMS.filter((i) => i.source === 'manual');
const MANUAL_COLS = MANUAL.map((i) => i.col);
const BY_KEY = new Map(ITEMS.map((i) => [i.key, i]));

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM' 合法性校验 */
function isMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** 月份区间：[本月1号, 下月1号) —— 用字符串直接算，避免时区/月末陷阱 */
function monthRange(month) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { start: `${month}-01`, end: `${ny}-${pad2(nm)}-01` };
}

/** 从 endMonth 往前数 count 个月，返回升序数组 */
function recentMonths(count, endMonth) {
  const end = endMonth || currentMonth();
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(5, 7));
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const total = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`);
  }
  return out;
}

/** 当前月份（服务器本地时区） */
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 四个平台当月的自动金额 + 订单数：{ '2026-10': { auto: {...}, count: {...} } } */
async function autoTotals(userId, months) {
  const out = {};
  if (!months.length) return out;
  const sorted = [...months].sort();
  const from = `${sorted[0]}-01`;
  const to = monthRange(sorted[sorted.length - 1]).end;

  // 每条 SQL 同时取 COUNT(*)：页面上金额旁边要显示「N 单」，用于和平台后台核对
  const [r1688, rPdd, rSdc, rQht] = await Promise.all([
    db.query(
      `SELECT DATE_FORMAT(COALESCE(pay_time, created_at), '%Y-%m') AS m, SUM(pay_amount) AS s, COUNT(*) AS n
         FROM invoice_order
        WHERE user_id = ? AND COALESCE(pay_time, created_at) >= ? AND COALESCE(pay_time, created_at) < ?
          AND COALESCE(order_status, '') NOT IN ('待付款', '交易关闭')
        GROUP BY m`,
      [userId, from, to]
    ),
    db.query(
      `SELECT DATE_FORMAT(order_time, '%Y-%m') AS m, SUM(pay_amount) AS s, COUNT(*) AS n
         FROM pdd_order
        WHERE user_id = ? AND order_time >= ? AND order_time < ?
          AND COALESCE(order_status_text, '') NOT IN ('交易已取消', '退款成功')
        GROUP BY m`,
      [userId, from, to]
    ),
    db.query(
      `SELECT DATE_FORMAT(order_time, '%Y-%m') AS m, SUM(actual_pay_amount) AS s, COUNT(*) AS n
         FROM sdc_order
        WHERE user_id = ? AND order_time >= ? AND order_time < ?
          AND stage != 5                  -- 已关闭·无法开票（开不出票、也未实付）不计入支出
          AND pay_time IS NOT NULL        -- 待付款（未支付）不计入支出
        GROUP BY m`,
      [userId, from, to]
    ),
    db.query(
      `SELECT DATE_FORMAT(order_time, '%Y-%m') AS m, SUM(payable_money) AS s, COUNT(*) AS n
         FROM qht_order
        WHERE user_id = ? AND order_time >= ? AND order_time < ?
          AND COALESCE(status_name, '') NOT LIKE '%取消%'
          AND COALESCE(status_name, '') NOT LIKE '%关闭%'
          AND (COALESCE(pay_status, 0) = 1 OR COALESCE(pay_flag, 0) IN (1, 2))
        GROUP BY m`,
      [userId, from, to]
    ),
  ]);
  for (const m of months) out[m] = {
    auto: { auto_1688: 0, auto_pdd: 0, auto_sdc: 0, auto_qht: 0 },
    count: { auto_1688: 0, auto_pdd: 0, auto_sdc: 0, auto_qht: 0 },
  };
  for (const r of r1688) if (out[r.m]) { out[r.m].auto.auto_1688 = round2(r.s); out[r.m].count.auto_1688 = Number(r.n) || 0; }
  for (const r of rPdd) if (out[r.m]) { out[r.m].auto.auto_pdd = round2(r.s); out[r.m].count.auto_pdd = Number(r.n) || 0; }
  for (const r of rSdc) if (out[r.m]) { out[r.m].auto.auto_sdc = round2(r.s); out[r.m].count.auto_sdc = Number(r.n) || 0; }
  for (const r of rQht) if (out[r.m]) { out[r.m].auto.auto_qht = round2(r.s); out[r.m].count.auto_qht = Number(r.n) || 0; }
  return out;
}

/**
 * 供应商货单项（v0.3.8）：
 *   key = `sup:<supplier_id>`，label = 供应商当前名称，source = auto。
 *   只列「至少有一张未软删除货单」的供应商（空供应商不给账单加噪音列）。
 *
 * v0.3.9（用户确认）：如果供应商名称与某个平台自动项同名（目前只有「齐货通」），
 *   说明这是同一批采购的两套账（齐货通订单 = 齐货通货单，金额逐笔相同）。
 *   此时**不再单独出供应商列**（避免重复计入支出），改为挂在平台自动项上做「两口径核对」：
 *   金额不一致 → 金额标红放大；点金额看两边当月明细对比。
 */
const SUPPLIER_PREFIX = 'sup:';
const supplierKeyOf = (sid) => SUPPLIER_PREFIX + String(Number(sid) || 0);
const isSupplierKey = (k) => String(k || '').startsWith(SUPPLIER_PREFIX);

/** 平台自动项 ↔ 同名供应商 的对照（供应商名精确等于 token 才算，避免误伤「1688食品」这类名字） */
const PLATFORM_TOKENS = {
  auto_1688: '1688',
  auto_pdd: '拼多多',
  auto_sdc: '闪电帮帮',
  auto_qht: '齐货通',
};
const TOKEN_TO_PLATFORM = new Map(Object.entries(PLATFORM_TOKENS).map(([k, v]) => [v, k]));

/** 某账号下的供应商列表（有货单的），按名称排序 */
async function supplierItems(userId) {
  const rows = await db.query(
    `SELECT w.supplier_id AS sid,
            COALESCE(MAX(s.name), MAX(w.supplier_name), '未命名供应商') AS name,
            COUNT(*) AS n
       FROM waybill w
       LEFT JOIN supplier s ON s.id = w.supplier_id AND s.user_id = w.user_id
      WHERE w.user_id = ? AND w.deleted_at IS NULL AND w.supplier_id > 0
      GROUP BY w.supplier_id
      ORDER BY name ASC, sid ASC`,
    [userId]
  );
  return rows.map((r) => ({
    key: supplierKeyOf(r.sid),
    label: String(r.name || '未命名供应商'),
    group: 'expense',
    source: 'auto',
    supplierId: Number(r.sid) || 0,
    waybills: Number(r.n) || 0,
  }));
}

/**
 * 供应商按月金额：{ '2026-10': { auto: { 'sup:1': 123.45 }, count: { 'sup:1': 2 } } }
 * ⚠️ 口径必须与 ORDER_SOURCES 的供应商分支完全一致（只多条 deleted_at IS NULL）。
 */
async function supplierTotals(userId, months) {
  const out = {};
  if (!months.length) return out;
  const sorted = [...months].sort();
  const from = `${sorted[0]}-01`;
  const to = monthRange(sorted[sorted.length - 1]).end;
  const rows = await db.query(
    `SELECT w.supplier_id AS sid, DATE_FORMAT(w.bill_date, '%Y-%m') AS m,
            SUM(w.amount) AS s, COUNT(*) AS n
       FROM waybill w
      WHERE w.user_id = ? AND w.deleted_at IS NULL AND w.supplier_id > 0
        AND w.bill_date >= ? AND w.bill_date < ?
      GROUP BY sid, m`,
    [userId, from, to]
  );
  for (const m of months) out[m] = { auto: {}, count: {} };
  for (const r of rows) {
    const slot = out[r.m];
    if (!slot) continue;
    const k = supplierKeyOf(r.sid);
    slot.auto[k] = round2(r.s);
    slot.count[k] = Number(r.n) || 0;
  }
  return out;
}


/**
 * 各平台「当月参与统计的订单明细」查询模板。
 * ⚠️ 这里的 WHERE 必须与 autoTotals / supplierTotals 完全一致，
 *    否则弹窗里的条数/合计会跟账单对不上。
 * cols = 明细弹窗的表头文案（供应商货单与平台订单的列含义不同）
 */
const DEFAULT_COLS = { no: '单号', who: '卖家 / 店铺', goods: '商品', status: '状态' };
const ORDER_SOURCES = {
  auto_1688: {
    label: '1688 订单',
    base: `SELECT order_no AS no, COALESCE(seller_company, seller_login, '') AS who,
                  COALESCE(goods_title, '') AS goods, pay_amount AS amount,
                  DATE_FORMAT(COALESCE(pay_time, created_at), '%Y-%m-%d %H:%i') AS t, COALESCE(order_status, '') AS status
             FROM invoice_order
            WHERE user_id = ? AND COALESCE(pay_time, created_at) >= ? AND COALESCE(pay_time, created_at) < ?
              AND COALESCE(order_status, '') NOT IN ('待付款', '交易关闭')`,
  },
  auto_pdd: {
    label: '拼多多订单',
    base: `SELECT order_sn AS no, CONCAT('店铺 ', COALESCE(mall_id, '')) AS who,
                  COALESCE(goods_name, '') AS goods, pay_amount AS amount,
                  DATE_FORMAT(order_time, '%Y-%m-%d %H:%i') AS t, COALESCE(order_status_text, '') AS status
             FROM pdd_order
            WHERE user_id = ? AND order_time >= ? AND order_time < ?
              AND COALESCE(order_status_text, '') NOT IN ('交易已取消', '退款成功')`,
  },
  auto_sdc: {
    label: '闪电帮帮订单',
    base: `SELECT order_sn AS no, COALESCE(shop_name, '') AS who,
                  COALESCE(item_names, '') AS goods, actual_pay_amount AS amount,
                  DATE_FORMAT(order_time, '%Y-%m-%d %H:%i') AS t, COALESCE(trade_status_desc, '') AS status
             FROM sdc_order
            WHERE user_id = ? AND order_time >= ? AND order_time < ?
              AND stage != 5 AND pay_time IS NOT NULL`,
  },
  auto_qht: {
    label: '齐货通订单',
    base: `SELECT order_no AS no, COALESCE(store_name, '') AS who,
                  CONCAT('件', ipcnt, ' 散', spcnt) AS goods, payable_money AS amount,
                  DATE_FORMAT(order_time, '%Y-%m-%d %H:%i') AS t, COALESCE(status_name, '') AS status
             FROM qht_order
            WHERE user_id = ? AND order_time >= ? AND order_time < ?
              AND COALESCE(status_name, '') NOT LIKE '%取消%'
              AND COALESCE(status_name, '') NOT LIKE '%关闭%'
              AND (COALESCE(pay_status, 0) = 1 OR COALESCE(pay_flag, 0) IN (1, 2))`,
  },
};

/**
 * 供应商货单明细模板（key = sup:<id>）。
 * ⚠️ WHERE 与 supplierTotals 一致：只多条 w.deleted_at IS NULL。
 * 参数顺序 (userId, start, end, supplierId) —— 与其他平台 (userId, start, end) 前缀对齐。
 */
function supplierSource(sid) {
  return {
    label: '供应商货单',
    cols: { no: '货单', who: '供应商', goods: '备注 / 来源', status: '开票状态' },
    base: `SELECT CONCAT('货单 #', w.id) AS no,
                  COALESCE(s.name, w.supplier_name, '') AS who,
                  COALESCE(w.note, '') AS goods,
                  w.amount AS amount,
                  DATE_FORMAT(w.bill_date, '%Y-%m-%d') AS t,
                  CASE WHEN w.invoice_status = 1 THEN '已开票' ELSE '未开票' END AS status
             FROM waybill w
             LEFT JOIN supplier s ON s.id = w.supplier_id AND s.user_id = w.user_id
            WHERE w.user_id = ? AND w.deleted_at IS NULL
              AND w.bill_date >= ? AND w.bill_date < ?
              AND w.supplier_id = ?`,
  };
}

/** 某平台某月的订单明细（分页）+ 全量条数与合计金额 */
async function orderList(userId, { platform, month, page = 1, size = 50 } = {}) {
  const key = String(platform || '');
  const bySupplier = isSupplierKey(key);
  const sid = bySupplier ? Number(key.slice(SUPPLIER_PREFIX.length)) || 0 : 0;
  const src = bySupplier ? supplierSource(sid) : ORDER_SOURCES[key];
  if (!src || (bySupplier && !sid)) throw new Error('不支持的平台：' + platform);
  if (!isMonth(month)) throw new Error('月份格式应为 YYYY-MM');
  const { start, end } = monthRange(month);
  const args = [userId, start, end];
  if (bySupplier) args.push(sid);
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(200, Math.max(1, Number(size) || 50));
  const agg = await db.query(
    `SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(x.amount), 0), 2) AS s FROM (${src.base}) x`, args
  );
  const rows = await db.query(
    `${src.base} ORDER BY t DESC, no DESC LIMIT ${s} OFFSET ${(p - 1) * s}`, args
  );
  return {
    ok: true, platform, month, label: src.label, page: p, size: s,
    cols: src.cols || DEFAULT_COLS,
    total: agg[0] ? Number(agg[0].n) || 0 : 0,
    sum: agg[0] ? round2(agg[0].s) : 0,
    rows,
  };
}

/** 汇总：总收入 / 总支出 / 净利润 / 净利润率(%) */
function totalsOf(cells, auto) {
  let income = 0;
  let expense = 0;
  // 自动项（平台订单 + 各供应商货单）全部计入支出；键是动态的，不能写死
  for (const k of Object.keys(auto || {})) expense += round2(auto[k]);
  for (const it of MANUAL) {
    const v = round2(cells[it.key]);
    if (it.group === 'income') income += v;
    else expense += v;
  }
  income = round2(income);
  expense = round2(expense);
  const net = round2(income - expense);
  const rate = income > 0 ? Math.round((net / income) * 10000) / 100 : 0;
  return { income, expense, net, rate };
}

/**
 * 账单数据：
 *   months 参数 = 默认展示最近几个月；返回结果会并入「已存在的历史月份」，避免老数据看不见。
 */
async function overview(userId, { months = 6 } = {}) {
  const n = Math.min(24, Math.max(1, Number(months) || 6));
  const rows = await db.query(`SELECT * FROM billing_month WHERE user_id = ? ORDER BY month ASC`, [userId]);
  const set = new Set(recentMonths(n));
  for (const r of rows) set.add(r.month);
  const list = [...set].sort();
  const [autos, allSup, supAutos] = await Promise.all([
    autoTotals(userId, list),
    supplierItems(userId),
    supplierTotals(userId, list),
  ]);
  // 同名供应商（齐货通）不出独立列，改为平台项的「两口径核对」
  const supItems = [];
  const cmpTargets = [];
  for (const s of allSup) {
    const pk = TOKEN_TO_PLATFORM.get(String(s.label).trim());
    if (pk) cmpTargets.push({ platformKey: pk, supplierKey: s.key, label: s.label });
    else supItems.push(s);
  }
  const byMonth = new Map(rows.map((r) => [r.month, r]));

  const cols = list.map((month) => {
    const row = byMonth.get(month) || null;
    const cells = {};
    for (const it of MANUAL) cells[it.key] = row ? round2(row[it.col]) : 0;
    const auto = Object.assign(
      { auto_1688: 0, auto_pdd: 0, auto_sdc: 0, auto_qht: 0 },
      (autos[month] && autos[month].auto) || {},
      (supAutos[month] && supAutos[month].auto) || {}
    );
    const autoCount = Object.assign(
      { auto_1688: 0, auto_pdd: 0, auto_sdc: 0, auto_qht: 0 },
      (autos[month] && autos[month].count) || {},
      (supAutos[month] && supAutos[month].count) || {}
    );
    // 供应商列固定存在（即便当月 0 张货单），金额补 0 —— 否则前端显示成空白
    for (const it of supItems) {
      if (auto[it.key] == null) auto[it.key] = 0;
      if (autoCount[it.key] == null) autoCount[it.key] = 0;
    }
    // ⚠ 同名供应商（齐货通）的货单金额必须从 auto 里删掉：它已由平台自动项代表，
    //   留在这里会被 totalsOf 再算一遍（总支出重复计算）。cmp 里单独保留做核对。
    for (const t of cmpTargets) { delete auto[t.supplierKey]; delete autoCount[t.supplierKey]; }
    // 两口径核对（平台自动项 vs 同名供应商货单）：只给有对照关系的项，金额差 → 前端标红放大
    const cmp = {};
    for (const t of cmpTargets) {
      const pv = round2(auto[t.platformKey]);
      const sv = round2((supAutos[month] && supAutos[month].auto[t.supplierKey]) || 0);
      const pc = Number(autoCount[t.platformKey]) || 0;
      const sc = Number((supAutos[month] && supAutos[month].count[t.supplierKey]) || 0);
      const diff = round2(pv - sv);
      cmp[t.platformKey] = {
        supplierKey: t.supplierKey, label: t.label,
        platform: pv, supplier: sv,
        platformCount: pc, supplierCount: sc,
        diff, same: Math.abs(diff) < 0.005,
      };
    }
    return { month, hasRow: !!row, cells, auto, autoCount, cmp, totals: totalsOf(cells, auto) };
  });

  // 展示顺序：收入 → 平台自动项 → 供应商货单项 → 手工支出项
  const income = ITEMS.filter((i) => i.group === 'income');
  const autoPlat = ITEMS.filter((i) => i.group === 'expense' && i.source === 'auto');
  const manualExp = ITEMS.filter((i) => i.group === 'expense' && i.source === 'manual');
  const items = [...income, ...autoPlat, ...supItems, ...manualExp]
    .map(({ key, label, group, source, supplierId }) => {
      const o = { key, label, group, source };
      if (supplierId) o.supplierId = supplierId;
      return o;
    });

  return {
    items,
    months: cols,
    range: { from: list[0] || null, to: list[list.length - 1] || null },
  };
}

/** 保存单个手工单元格 */
async function saveCell(userId, { month, item, value }) {
  if (!isMonth(month)) throw new Error('月份格式应为 YYYY-MM');
  const it = BY_KEY.get(String(item || ''));
  if (!it || it.source !== 'manual') throw new Error('该项不可编辑（只有手工项可改）');
  const raw = value === '' || value == null ? 0 : Number(value);
  if (!Number.isFinite(raw)) throw new Error('金额必须是数字');
  if (raw < 0) throw new Error('金额不能为负数');
  const v = round2(raw);
  await db.exec(
    `INSERT INTO billing_month (user_id, month, ${it.col}) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ${it.col} = VALUES(${it.col})`,
    [userId, month, v]
  );
  return { ok: true, month, item: it.key, value: v };
}

/** 新增月份（唯一键冲突直接报错）；默认复制最近一个月的手工数据 */
async function addMonth(userId, { month, copyFrom } = {}) {
  if (!isMonth(month)) throw new Error('月份格式应为 YYYY-MM');
  const exists = await db.query('SELECT month FROM billing_month WHERE user_id = ? AND month = ?', [userId, month]);
  if (exists.length) throw new Error('该月份已存在：' + month);

  let src = null;
  if (copyFrom) {
    if (!isMonth(copyFrom)) throw new Error('复制来源月份格式应为 YYYY-MM');
    const r = await db.query('SELECT * FROM billing_month WHERE user_id = ? AND month = ?', [userId, copyFrom]);
    src = r[0] || null;
  } else {
    const r = await db.query(
      'SELECT * FROM billing_month WHERE user_id = ? AND month < ? ORDER BY month DESC LIMIT 1',
      [userId, month]
    );
    src = r[0] || null;
  }

  const cols = MANUAL_COLS.join(', ');
  const vals = MANUAL_COLS.map((c) => (src ? round2(src[c]) : 0));
  await db.exec(
    `INSERT INTO billing_month (user_id, month, ${cols}) VALUES (?, ?, ${MANUAL_COLS.map(() => '?').join(', ')})`,
    [userId, month, ...vals]
  );
  return { ok: true, month, copiedFrom: src ? src.month : null };
}

module.exports = {
  ITEMS, isMonth, monthRange, recentMonths, currentMonth, overview, saveCell, addMonth, totalsOf,
  orderList, ORDER_SOURCES,
  SUPPLIER_PREFIX, supplierKeyOf, isSupplierKey, supplierItems, supplierTotals, PLATFORM_TOKENS,
};
