/**
 * import-to-db.js — 把 data/ 下的 Excel 数据导入 MySQL（看板数据源）
 *
 * 用法:
 *   node import-to-db.js            全量重建订单表 + 已开票表（保留人工维护的映射表）
 *   node import-to-db.js --orders   只导入「完成订单」
 *   node import-to-db.js --invoices 只导入「已开票订单」
 *   node import-to-db.js --schema   只建库建表
 *
 * 数据流:
 *   data/完成订单/*.xlsx      → invoice_order    （1688 订单，看板订单口径）
 *   data/已开票订单/*.xlsx    → issued_invoice   （税务局全量发票，一行=一个明细行）
 *                                 ↑ 通过 seller_name_mapping 把「销方名称」翻译成「1688商家名称」
 *   data/invoice-status.json  → invoice_order.invoice_state（平台实时开票状态，可选）
 *
 * 映射表维护:
 *   自动匹配规则（精确 / 规范化 / 包含 / 登录ID / 备注线索），命中即写入 seller_name_mapping；
 *   匹配不上的在 seller_name_mapping 里没有记录，看板「名称映射」页会列出来，人工比对后保存。
 *   再次导入不会覆盖人工维护的结果（只对未映射的名称做自动匹配）。
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('./db');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const ORDER_DIR = path.join(DATA, '完成订单');
const INVOICE_DIR = path.join(DATA, '已开票订单');

// ──────────────────────────── 工具函数 ────────────────────────────

/** Excel 日期（序列号或字符串）→ 'YYYY-MM-DD HH:mm:ss'，无效返回 null */
function toDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number' && isFinite(v)) {
    const o = XLSX.SSF.parse_date_code(v);
    if (o) d = new Date(o.y, o.m - 1, o.d, o.H || 0, o.M || 0, Math.floor(o.S || 0));
  } else {
    const s = String(v).trim().replace(/\//g, '-');
    d = new Date(s.replace(/-/g, '/'));
  }
  if (!d || isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 名称规范化：去空白、全半角括号统一、去标点，用于模糊比对 */
function normName(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(【\[「]/g, '(')
    .replace(/[）)】\]」]/g, ')')
    .replace(/[，,、;；]/g, ',')
    .replace(/[·・．.:：*]/g, '')
    .replace(/[－—–\-_]/g, '')
    .toUpperCase();
}

/** 数值转数字，空值返回 null */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** 截断到指定长度，避免超长写库报错 */
function cut(v, len) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return s.length > len ? s.slice(0, len) : s;
}

const md5 = (s) => require('crypto').createHash('md5').update(s, 'utf8').digest('hex');

// ──────────────────────── 解析「完成订单」 ────────────────────────

const ORDER_COLS = {
  order_no: '订单编号',
  buyer_company: '买家公司名',
  buyer_login: '买家会员名',
  seller_company: '卖家公司名',
  seller_login: '卖家会员名',
  goods_amount: '货品总价(元)',
  freight_amount: '运费(元)',
  discount_amount: '涨价或折扣(元)',
  pay_amount: '实付款(元)',
  order_status: '订单状态',
  created_at: '订单创建时间',
  pay_time: '订单付款时间',
  goods_title: '货品标题',
  quantity: '数量',
  unit: '单位',
  logistics_company: '物流公司',
  tracking_no: '运单号',
  invoice_title: '发票：购货单位名称',
  invoice_tax_no: '发票：纳税人识别号',
};

/** 解析单个订单 xlsx → 订单对象数组（按订单编号去重，取首个 SKU 主行） */
function parseOrderFile(file) {
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  if (rows.length < 2) return { orders: [], totalRows: 0 };
  const head = rows[0];
  const idx = {};
  for (const [k, cn] of Object.entries(ORDER_COLS)) idx[k] = head.indexOf(cn);

  const orders = new Map();
  let totalRows = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[idx.order_no]) continue; // 多 SKU 续行没有订单编号
    totalRows++;
    const no = String(r[idx.order_no]).trim();
    if (orders.has(no)) continue;
    orders.set(no, {
      order_no: no,
      buyer_company: cut(r[idx.buyer_company], 255),
      buyer_login: cut(r[idx.buyer_login], 128),
      seller_company: cut(r[idx.seller_company], 255),
      seller_login: cut(r[idx.seller_login], 128),
      goods_amount: num(r[idx.goods_amount]),
      freight_amount: num(r[idx.freight_amount]),
      discount_amount: num(r[idx.discount_amount]),
      pay_amount: num(r[idx.pay_amount]),
      order_status: cut(r[idx.order_status], 32),
      created_at: toDateTime(r[idx.created_at]),
      pay_time: toDateTime(r[idx.pay_time]),
      goods_title: cut(r[idx.goods_title], 512),
      quantity: num(r[idx.quantity]),
      unit: cut(r[idx.unit], 16),
      logistics_company: cut(r[idx.logistics_company], 64),
      tracking_no: cut(r[idx.tracking_no], 64),
      invoice_title: cut(r[idx.invoice_title], 255),
      invoice_tax_no: cut(r[idx.invoice_tax_no], 64),
      source_file: path.basename(file),
    });
  }
  return { orders: [...orders.values()], totalRows };
}

// ──────────────────────── 解析「已开票订单」 ────────────────────────

const INVOICE_COLS = {
  seq_no: '序号',
  invoice_code: '发票代码',
  invoice_no: '发票号码',
  e_invoice_no: '数电发票号码',
  seller_tax_no: '销方识别号',
  seller_name: '销方名称',
  buyer_tax_no: '购方识别号',
  buyer_name: '购买方名称',
  invoice_date: '开票日期',
  tax_category_code: '税收分类编码',
  special_biz_type: '特定业务类型',
  goods_name: '货物或应税劳务名称',
  spec: '规格型号',
  unit: '单位',
  quantity: '数量',
  unit_price: '单价',
  amount: '金额',
  tax_rate: '税率',
  tax_amount: '税额',
  total_amount: '价税合计',
  invoice_source: '发票来源',
  invoice_kind: '发票票种',
  invoice_status: '发票状态',
  is_positive: '是否正数发票',
  risk_level: '发票风险等级',
  drawer: '开票人',
  remark: '备注',
};

/**
 * 解析单个发票 xlsx → 发票明细行数组
 * 优先取「信息汇总表」（明细行）；只有「发票基础信息」时退化为按发票汇总。
 * 自动跳过「合计行」。
 */
function parseInvoiceFile(file) {
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames.includes('信息汇总表') ? '信息汇总表' : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true });
  if (rows.length < 2) return { invoices: [], totalRows: 0, sheet: sheetName };
  const head = rows[0];
  const idx = {};
  for (const [k, cn] of Object.entries(INVOICE_COLS)) idx[k] = head.indexOf(cn);

  const out = [];
  let totalRows = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const seqRaw = r[idx.seq_no];
    if (seqRaw !== undefined && String(seqRaw).indexOf('合计') >= 0) continue; // 合计行
    const sellerName = cut(r[idx.seller_name], 255);
    if (!sellerName) continue; // 没有销方名称的行无意义
    totalRows++;
    const inv = {
      seq_no: num(seqRaw),
      invoice_code: cut(r[idx.invoice_code], 32),
      invoice_no: cut(r[idx.invoice_no], 32),
      e_invoice_no: cut(r[idx.e_invoice_no], 32),
      seller_tax_no: cut(r[idx.seller_tax_no], 64),
      seller_name: sellerName,
      buyer_tax_no: cut(r[idx.buyer_tax_no], 64),
      buyer_name: cut(r[idx.buyer_name], 255),
      invoice_date: toDateTime(r[idx.invoice_date]),
      tax_category_code: cut(r[idx.tax_category_code], 32),
      special_biz_type: cut(r[idx.special_biz_type], 64),
      goods_name: cut(r[idx.goods_name], 512),
      spec: cut(r[idx.spec], 255),
      unit: cut(r[idx.unit], 16),
      quantity: num(r[idx.quantity]),
      unit_price: num(r[idx.unit_price]),
      amount: num(r[idx.amount]),
      tax_rate: cut(r[idx.tax_rate], 16),
      tax_amount: num(r[idx.tax_amount]),
      total_amount: num(r[idx.total_amount]),
      invoice_source: cut(r[idx.invoice_source], 64),
      invoice_kind: cut(r[idx.invoice_kind], 64),
      invoice_status: cut(r[idx.invoice_status], 32),
      is_positive: cut(r[idx.is_positive], 8),
      risk_level: cut(r[idx.risk_level], 32),
      drawer: cut(r[idx.drawer], 64),
      remark: cut(r[idx.remark], 512),
      source_sheet: cut(sheetName, 64),
      source_file: path.basename(file),
    };
    // 行指纹：同一张发票的同一明细行，重复导入时自动去重
    inv.row_hash = md5([
      inv.e_invoice_no || inv.invoice_no || '', inv.invoice_code || '',
      inv.goods_name || '', inv.spec || '', inv.unit || '',
      inv.quantity == null ? '' : inv.quantity, inv.amount == null ? '' : inv.amount,
      inv.tax_amount == null ? '' : inv.tax_amount, inv.seller_name || '',
    ].join('|'));
    out.push(inv);
  }
  return { invoices: out, totalRows, sheet: sheetName };
}

// ──────────────────────── 销方名称自动匹配 ────────────────────────

/**
 * 用「税务局销方名称」去匹配 1688 卖家（返回 { seller, rule } 或 null）
 * @param {string} taxName 销方名称
 * @param {string} remark  发票备注（常含 1688 店铺名线索）
 * @param {Array}  sellers [{ seller_login, seller_company }]
 */
/** 备注里的 1688 店铺名线索（如「1688 谨锐优选;」→「谨锐优选」），没有则 null */
function remarkShopToken(remark) {
  return (String(remark == null ? '' : remark).match(/1688\s*([^;；,，\s]{2,20})/) || [])[1] || null;
}

/** 同一家公司有多个会员名时选「主行」：① 备注线索 → ② 订单数最多（保证可复现） */
function pickAmongSiblings(hits, remark) {
  const rk = normName(remark || '');
  const tk = normName(remarkShopToken(remark) || '');
  if (rk) {
    const byRemark = hits.find((s) => {
      const l = normName(s.seller_login);
      if (!l) return false;
      if (rk.includes(l)) return true;
      return tk && (l.includes(tk) || tk.includes(l));
    });
    if (byRemark) return { seller: byRemark, via: 'remark' };
  }
  const byOrders = [...hits].sort((a, b) => (Number(b.order_cnt) || 0) - (Number(a.order_cnt) || 0) || String(a.seller_login).localeCompare(String(b.seller_login)));
  return { seller: byOrders[0], via: 'order' };
}

function matchSeller(taxName, remark, sellers) {
  const t = normName(taxName);
  if (!t) return null;
  const suffix = taxName.replace(/[\s\u3000]/g, '');

  // 1. 销方名称 与 1688 卖家公司名 完全一致。
  //    ⚠️ 同一公司可能有多个会员名（多店铺，如「谨锐优选」+「谨锐医疗」都属
  //    「谨锐医疗科技（上海）有限公司」），不能取遍历到的第一个（结果随机、随导入顺序漂移），
  //    必须显式消歧：① 发票备注里的店铺名线索 → ② 订单数最多的会员名（结果可复现）。
  const exactHits = sellers.filter((s) => normName(s.seller_company) === t);
  if (exactHits.length === 1) return { seller: exactHits[0], rule: 'exact' };
  if (exactHits.length > 1) {
    const pick = pickAmongSiblings(exactHits, remark);
    return { seller: pick.seller, rule: 'exact', ambiguous: true, via: pick.via };
  }

  // 2. 销方名称 与 卖家会员名 完全一致
  for (const s of sellers) if (s.seller_login && normName(s.seller_login) === t) return { seller: s, rule: 'login' };

  // 3. 包含关系（公司与公司），要求较短一方 ≥4 字且占比 ≥50%，避免误判
  let best = null;
  for (const s of sellers) {
    const c = normName(s.seller_company);
    if (!c || c.length < 4) continue;
    if (t.includes(c) || c.includes(t)) {
      const shorter = Math.min(t.length, c.length);
      const longer = Math.max(t.length, c.length);
      if (shorter >= 4 && shorter / longer >= 0.5) {
        if (!best || shorter > best.score) best = { seller: s, rule: 'contains', score: shorter };
      }
    }
  }
  if (best) return { seller: best.seller, rule: best.rule };

  // 4. 卖家会员名被销方名称包含（如「中山市xxx商行-沐凌制衣厂」）
  for (const s of sellers) {
    const l = normName(s.seller_login);
    if (l && l.length >= 4 && t.includes(l)) return { seller: s, rule: 'login' };
  }

  // 5. 备注线索：备注里出现 1688 店铺名（「1688 谨锐优选;」）
  const rk = normName(remark);
  if (rk) {
    for (const s of sellers) {
      const c = normName(s.seller_company);
      const l = normName(s.seller_login);
      if (c && c.length >= 4 && rk.includes(c)) return { seller: s, rule: 'remark' };
      if (l && l.length >= 4 && rk.includes(l)) return { seller: s, rule: 'remark' };
    }
    // 备注是短店铺名（去掉 1688 前缀后）→ 与公司名互相包含
    const rkToken = remarkShopToken(remark);
    if (rkToken) {
      const tk = normName(rkToken);
      for (const s of sellers) {
        const c = normName(s.seller_company);
        const l = normName(s.seller_login);
        if (tk && ((c && (c.includes(tk) || tk.includes(c))) || (l && (l.includes(tk) || tk.includes(l))))) {
          return { seller: s, rule: 'remark' };
        }
      }
    }
  }
  return null;
}

/**
 * 对「未映射的销方名称」做自动匹配并写入映射表。
 * 已存在且已填 seller_company 的记录不动（保护人工维护成果）。
 * @returns {{autoMapped:number, unmatched:string[], details:Array}}
 */
async function autoMapSellers(sellers, taxNames) {
  const existing = await db.query('SELECT tax_seller_name, seller_company FROM seller_name_mapping');
  const mapped = new Set(existing.filter((r) => r.seller_company).map((r) => r.tax_seller_name));

  const autoMapped = [];
  const unmatched = [];
  for (const t of taxNames) {
    if (mapped.has(t.tax_seller_name)) continue;
    const hit = matchSeller(t.tax_seller_name, t.remark, sellers);
    if (hit) {
      // 名称唯一命中（exact/login 且无同公司多会员名歧义）→ 已确认；
      // 歧义时若靠备注线索定的 → 也算已确认；只靠订单数猜的 → 待人工复核
      const sure =
        (hit.rule === 'exact' || hit.rule === 'login') &&
        !(hit.ambiguous && hit.via === 'order');
      const confirmed = sure ? 1 : 0;
      const note = hit.ambiguous
        ? `导入时自动匹配（同公司多会员名，按${hit.via === 'remark' ? '发票备注线索' : '订单数'}选定，请复核）`
        : '导入时自动匹配';
      await db.exec(
        `INSERT INTO seller_name_mapping
           (tax_seller_name, seller_company, seller_login, match_type, match_rule, is_confirmed, note)
         VALUES (?, ?, ?, 'auto', ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           seller_company = VALUES(seller_company), seller_login = VALUES(seller_login),
           match_type = 'auto', match_rule = VALUES(match_rule), is_confirmed = VALUES(is_confirmed)`,
        [t.tax_seller_name, hit.seller.seller_company, hit.seller.seller_login, hit.rule, confirmed, note]
      );
      autoMapped.push({ tax: t.tax_seller_name, company: hit.seller.seller_company, rule: hit.rule, confirmed: !!confirmed });
    } else {
      unmatched.push(t.tax_seller_name);
    }
  }
  return { autoMapped, unmatched };
}

// ──────────────────────── 写库 ────────────────────────

const ORDER_FIELDS = [
  'order_no', 'buyer_company', 'buyer_login', 'seller_company', 'seller_login',
  'goods_amount', 'freight_amount', 'discount_amount', 'pay_amount', 'order_status',
  'created_at', 'pay_time', 'goods_title', 'quantity', 'unit', 'logistics_company',
  'tracking_no', 'invoice_title', 'invoice_tax_no', 'source_file',
  'invoice_state', 'state_source', 'state_updated_at', 'state_note',
];

const INVOICE_FIELDS = [
  'row_hash', 'seq_no', 'invoice_code', 'invoice_no', 'e_invoice_no', 'seller_tax_no', 'seller_name',
  'seller_company', 'buyer_tax_no', 'buyer_name', 'invoice_date', 'tax_category_code', 'special_biz_type',
  'goods_name', 'spec', 'unit', 'quantity', 'unit_price', 'amount', 'tax_rate', 'tax_amount',
  'total_amount', 'invoice_source', 'invoice_kind', 'invoice_status', 'is_positive', 'risk_level',
  'drawer', 'remark', 'source_sheet', 'source_file',
];

/** 分批多值 INSERT */
async function bulkInsert(table, fields, rows, chunk = 400) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = [];
    const ph = part.map((r) => {
      const one = fields.map((f) => {
        let v = r[f];
        if (v === undefined) v = null;
        values.push(v);
        return '?';
      });
      return `(${one.join(',')})`;
    });
    const sql = `INSERT INTO \`${table}\` (${fields.map((f) => `\`${f}\``).join(',')}) VALUES ${ph.join(',')}`;
    const r = await db.exec(sql, values);
    inserted += r.affectedRows || 0;
  }
  return inserted;
}

async function logImport(entry) {
  const fields = ['kind', 'source_file', 'total_rows', 'inserted', 'skipped', 'auto_mapped', 'unmatched', 'status', 'message'];
  const numFields = new Set(['total_rows', 'inserted', 'skipped', 'auto_mapped', 'unmatched']);
  const values = fields.map((f) => {
    const v = entry[f];
    if (v === undefined || v === null) return numFields.has(f) ? 0 : null;
    return v;
  });
  await db.exec(
    `INSERT INTO import_log (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
    values
  );
}

// ──────────────────────── 主流程 ────────────────────────

/** 把 data/invoice-status.json 的平台状态同步进 invoice_order.invoice_state */
async function applyInvoiceStatus() {
  const f = path.join(DATA, 'invoice-status.json');
  if (!fs.existsSync(f)) return { applied: 0, skipped: 'invoice-status.json 不存在' };
  const s = JSON.parse(fs.readFileSync(f, 'utf-8'));
  const applying = (s.applying || []).map(String);
  const issued = (s.issued || []).map(String);
  let applied = 0;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (const [ids, state] of [[applying, 'applying'], [issued, 'issued']]) {
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      // 人工确认（state_source='manual'）的订单不被平台刷新覆盖
      const r = await db.exec(
        `UPDATE invoice_order SET invoice_state = ?, state_updated_at = ?
         WHERE order_no IN (${part.map(() => '?').join(',')}) AND invoice_state <> 'issued' AND state_source <> 'manual'`,
        [state, now, ...part]
      );
      applied += r.affectedRows || 0;
    }
  }
  return { applied, applyingCount: applying.length, issuedCount: issued.length };
}

/** 导入「完成订单」 */
async function importOrders() {
  if (!fs.existsSync(ORDER_DIR)) {
    await logImport({ kind: 'order', source_file: '-', status: 'error', message: `${ORDER_DIR} 不存在` });
    return { files: 0, inserted: 0, error: `${ORDER_DIR} 不存在` };
  }
  const files = fs.readdirSync(ORDER_DIR).filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'));
  const all = [];
  const perFile = [];
  for (const f of files) {
    const { orders, totalRows } = parseOrderFile(path.join(ORDER_DIR, f));
    perFile.push({ file: f, raw: totalRows, kept: orders.length });
    all.push(...orders);
  }

  // 全量重建，但保留开票状态（平台刷新的结果 + 人工确认的「已开票」都不能因重新导入而丢失）
  const stateKeep = new Map();
  try {
    const old = await db.query('SELECT order_no, invoice_state, state_source, state_updated_at, state_note FROM invoice_order');
    for (const r of old) stateKeep.set(r.order_no, r);
  } catch (e) { /* 首次运行表可能为空 */ }

  await db.exec('DELETE FROM invoice_order');
  for (const o of all) {
    const k = stateKeep.get(o.order_no);
    o.invoice_state = k ? k.invoice_state : 'none';
    o.state_source = k ? k.state_source : 'platform';
    o.state_updated_at = k ? k.state_updated_at : null;
    o.state_note = k ? k.state_note : null;
  }
  const inserted = await bulkInsert('invoice_order', ORDER_FIELDS, all);

  for (const p of perFile) {
    await logImport({ kind: 'order', source_file: p.file, total_rows: p.raw, inserted: p.kept, skipped: p.raw - p.kept, status: 'ok' });
  }
  return { files: files.length, inserted, perFile };
}

/** 导入「已开票订单」 */
async function importInvoices() {
  if (!fs.existsSync(INVOICE_DIR)) {
    await logImport({ kind: 'invoice', source_file: '-', status: 'error', message: `${INVOICE_DIR} 不存在` });
    return { files: 0, inserted: 0, error: `${INVOICE_DIR} 不存在` };
  }
  const files = fs.readdirSync(INVOICE_DIR).filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'));
  const perFile = [];
  const byHash = new Map();
  for (const f of files) {
    const { invoices, totalRows, sheet } = parseInvoiceFile(path.join(INVOICE_DIR, f));
    perFile.push({ file: f, raw: totalRows, kept: invoices.length, sheet });
    for (const inv of invoices) byHash.set(inv.row_hash, inv); // 同一行重复出现只留一条
  }
  const rows = [...byHash.values()];

  // 1) 先用「销方名称」自动匹配 1688 卖家
  const sellers = await db.query(
    `SELECT seller_login, MAX(seller_company) AS seller_company, COUNT(*) AS order_cnt
     FROM invoice_order
     WHERE seller_company IS NOT NULL
     GROUP BY seller_login
     ORDER BY seller_login`
  );
  const taxTotals = new Map();
  for (const inv of rows) {
    if (!taxTotals.has(inv.seller_name)) taxTotals.set(inv.seller_name, { tax_seller_name: inv.seller_name, remark: inv.remark });
  }
  const mapped = await autoMapSellers(sellers, [...taxTotals.values()]);

  // 2) 依据映射表（含人工维护）回填 seller_company
  const mapRows = await db.query(
    'SELECT tax_seller_name, seller_company FROM seller_name_mapping WHERE seller_company IS NOT NULL'
  );
  const nameMap = new Map(mapRows.map((r) => [r.tax_seller_name, r.seller_company]));
  for (const inv of rows) inv.seller_company = nameMap.get(inv.seller_name) || null;

  // 3) 全量重建已开票表
  await db.exec('DELETE FROM issued_invoice');
  const inserted = await bulkInsert('issued_invoice', INVOICE_FIELDS, rows);

  for (const p of perFile) {
    const un = mapped.unmatched.length;
    await logImport({
      kind: 'invoice', source_file: p.file, total_rows: p.raw, inserted: p.kept,
      skipped: p.raw - p.kept, auto_mapped: mapped.autoMapped.length, unmatched: un, status: 'ok',
      message: `sheet=${p.sheet}`,
    });
  }
  return { files: files.length, inserted, autoMapped: mapped.autoMapped, unmatchedNames: mapped.unmatched, perFile };
}

/**
 * 一次性迁移：把旧版 data/sent-log.json（按天合并的发送记录）导入 send_log 表。
 * 仅在 send_log 为空且文件存在时执行；旧记录没有具体时刻，统一记为当天 12:00:00。
 */
async function migrateLegacySentLog() {
  const f = path.join(DATA, 'sent-log.json');
  if (!fs.existsSync(f)) return { migrated: 0, skipped: 'sent-log.json 不存在' };
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM send_log');
  if (n > 0) return { migrated: 0, skipped: 'send_log 已有记录' };
  let log;
  try { log = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (e) { return { migrated: 0, skipped: 'json 解析失败' }; }
  const rows = [];
  for (const [date, list] of Object.entries(log)) {
    if (!Array.isArray(list)) continue;
    const d = String(date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    for (const login of list) {
      if (!login) continue;
      rows.push([d, String(login), 'ok', 'legacy', `${d} 12:00:00`]);
    }
  }
  let migrated = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    const ph = part.map(() => '(?,?,?,?,?)').join(',');
    const r = await db.exec(
      `INSERT INTO send_log (send_date, seller_login, result, channel, sent_at) VALUES ${ph}`,
      part.flat()
    );
    migrated += r.affectedRows || 0;
  }
  return { migrated };
}

/** 主入口 */
async function runImport(opts) {
  const options = opts || ({}); // 相对路径归一化: {orders:true, invoices:true, schemaOnly:true}
  const started = Date.now();
  const out = { ok: true, steps: [] };

  const info = await db.ensureSchema();
  out.database = info;
  out.steps.push(`建库建表完成: ${info.database} @ ${info.host}:${info.port}`);

  if (options.schemaOnly) { await db.closePool(); return out; }

  // 只指定 --orders 或 --invoices 时做单边导入；都不指定（或都指定）→ 全量导入
  const onlyOrders = !!options.orders && !options.invoices;
  const onlyInvoices = !!options.invoices && !options.orders;
  const doOrders = !onlyInvoices;
  const doInvoices = !onlyOrders;

  if (doOrders) {
    const r = await importOrders();
    out.orders = r;
    out.steps.push(`完成订单：${r.files} 个文件，写入 ${r.inserted} 单`);
    const st = await applyInvoiceStatus();
    out.invoiceStatus = st;
    if (st.applied) out.steps.push(`平台开票状态同步：更新 ${st.applied} 单`);
  }
  if (doInvoices) {
    const r = await importInvoices();
    out.invoices = r;
    out.steps.push(`已开票订单：${r.files} 个文件，写入 ${r.inserted} 行明细`);
    out.steps.push(`销方名称自动匹配 ${r.autoMapped ? r.autoMapped.length : 0} 个，待人工比对 ${r.unmatchedNames ? r.unmatchedNames.length : 0} 个`);
  }

  // 旧版发送记录（data/sent-log.json）迁入 send_log（仅表为空时执行一次）
  const legacy = await migrateLegacySentLog();
  if (legacy.migrated) out.steps.push(`旧版催收记录迁移：${legacy.migrated} 条 → send_log`);

  await db.closePool();
  out.elapsedMs = Date.now() - started;
  return out;
}

module.exports = { runImport, importOrders, importInvoices, applyInvoiceStatus, migrateLegacySentLog, matchSeller, normName, toDateTime };

// ──────────────────────── CLI ────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = { schemaOnly: argv.includes('--schema') };
  if (argv.includes('--orders')) opts.orders = true;
  if (argv.includes('--invoices')) opts.invoices = true;
  console.log('▶ 开始导入数据到 MySQL ...');
  runImport(opts)
    .then((r) => {
      for (const s of r.steps) console.log('  ' + s);
      if (r.invoices && r.invoices.unmatchedNames && r.invoices.unmatchedNames.length) {
        console.log('\n以下销方名称未能自动匹配，请在看板「名称映射」页人工维护：');
        for (const n of r.invoices.unmatchedNames) console.log('  - ' + n);
      }
      console.log(`\n[完成] 耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`);
      process.exit(0);
    })
    .catch((e) => { console.error('导入失败:', e.message); console.error(e.stack); process.exit(1); });
}
