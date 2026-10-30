/**
 * 账单（按月统计收支）。
 *
 * 口径（用户确认）：
 *   总收入 = 美团预计收入 + 淘宝预计收入 + 京东预计收入     —— 全部手工录入
 *   总支出 = 1688 订单当月总金额 + 拼多多当月实付总金额 + 闪电帮帮当月订单金额
 *                                                              —— 系统实时统计，不可编辑
 *          + 房租 + 水电 + 人工 + 中心仓 + 配送费 + 推广费 + 自采酒水 + 雪糕 + 果蔬
 *          + 增值税 + 企业所得税 + 其它                      —— 手工录入
 *   净利润 = 总收入 − 总支出
 *
 * 归月口径：
 *   1688   → COALESCE(pay_time, created_at) 所在月（invoice_order.pay_amount）
 *   拼多多 → order_time 所在月（pdd_order.pay_amount）
 *   闪电帮帮 → order_time 所在月（sdc_order.actual_pay_amount，排除 stage=5 已关闭与 pay_time 为空未支付）
 *
 * 存储：手工项落 billing_month（一人一月一行）；两个自动项每次实时聚合，不落库。
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
  { key: 'exp_rent', label: '房租', group: 'expense', source: 'manual', col: 'exp_rent' },
  { key: 'exp_utility', label: '水电', group: 'expense', source: 'manual', col: 'exp_utility' },
  { key: 'exp_labor', label: '人工', group: 'expense', source: 'manual', col: 'exp_labor' },
  { key: 'exp_warehouse', label: '中心仓', group: 'expense', source: 'manual', col: 'exp_warehouse' },
  { key: 'exp_delivery', label: '配送费', group: 'expense', source: 'manual', col: 'exp_delivery' },
  { key: 'exp_promo', label: '推广费', group: 'expense', source: 'manual', col: 'exp_promo' },
  { key: 'exp_liquor', label: '自采酒水', group: 'expense', source: 'manual', col: 'exp_liquor' },
  { key: 'exp_ice', label: '雪糕', group: 'expense', source: 'manual', col: 'exp_ice' },
  { key: 'exp_produce', label: '果蔬', group: 'expense', source: 'manual', col: 'exp_produce' },
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

/** 三个平台当月的自动金额：{ '2026-10': { auto_1688, auto_pdd, auto_sdc } } */
async function autoTotals(userId, months) {
  const out = {};
  if (!months.length) return out;
  const sorted = [...months].sort();
  const from = `${sorted[0]}-01`;
  const to = monthRange(sorted[sorted.length - 1]).end;

  const [r1688, rPdd, rSdc] = await Promise.all([
    db.query(
      `SELECT DATE_FORMAT(COALESCE(pay_time, created_at), '%Y-%m') AS m, SUM(pay_amount) AS s
         FROM invoice_order
        WHERE user_id = ? AND COALESCE(pay_time, created_at) >= ? AND COALESCE(pay_time, created_at) < ?
        GROUP BY m`,
      [userId, from, to]
    ),
    db.query(
      `SELECT DATE_FORMAT(order_time, '%Y-%m') AS m, SUM(pay_amount) AS s
         FROM pdd_order
        WHERE user_id = ? AND order_time >= ? AND order_time < ?
        GROUP BY m`,
      [userId, from, to]
    ),
    db.query(
      `SELECT DATE_FORMAT(order_time, '%Y-%m') AS m, SUM(actual_pay_amount) AS s
         FROM sdc_order
        WHERE user_id = ? AND order_time >= ? AND order_time < ?
          AND stage != 5                  -- 已关闭·无法开票（开不出票、也未实付）不计入支出
          AND pay_time IS NOT NULL        -- 待付款（未支付）不计入支出
        GROUP BY m`,
      [userId, from, to]
    ),
  ]);
  for (const m of months) out[m] = { auto_1688: 0, auto_pdd: 0, auto_sdc: 0 };
  for (const r of r1688) if (out[r.m]) out[r.m].auto_1688 = round2(r.s);
  for (const r of rPdd) if (out[r.m]) out[r.m].auto_pdd = round2(r.s);
  for (const r of rSdc) if (out[r.m]) out[r.m].auto_sdc = round2(r.s);
  return out;
}

/** 汇总：总收入 / 总支出 / 净利润 / 净利润率(%) */
function totalsOf(cells, auto) {
  let income = 0;
  let expense = round2(auto.auto_1688) + round2(auto.auto_pdd) + round2(auto.auto_sdc);
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
  const autos = await autoTotals(userId, list);
  const byMonth = new Map(rows.map((r) => [r.month, r]));

  const cols = list.map((month) => {
    const row = byMonth.get(month) || null;
    const cells = {};
    for (const it of MANUAL) cells[it.key] = row ? round2(row[it.col]) : 0;
    const auto = autos[month] || { auto_1688: 0, auto_pdd: 0, auto_sdc: 0 };
    return { month, hasRow: !!row, cells, auto, totals: totalsOf(cells, auto) };
  });

  return {
    items: ITEMS.map(({ key, label, group, source }) => ({ key, label, group, source })),
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

module.exports = { ITEMS, isMonth, monthRange, recentMonths, currentMonth, overview, saveCell, addMonth, totalsOf };
