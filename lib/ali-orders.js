/**
 * lib/ali-orders.js — 1688 订单同步（mtop: OrderListDataLineService.buyerOrderList）
 *
 * 为什么单独写一个模块：
 *   「1688发票」页原来只有一个「刷新」按钮，它只是把数据库里的数据重新读一遍（/api/data），
 *   并不会去 1688 拉新订单。订单进库一直靠人工导 Excel。这里补上直接拉取的通道。
 *
 * 接口事实（2026-10-29 实测）：
 *   GET https://h5api.m.1688.com/h5/mtop.1688.trading.dataline.service/1.0/
 *     ?jsv=2.7.4&appKey=12574478&t=<ms>&sign=<md5>&api=...&v=1.0&type=json&dataType=json
 *     &data=<urlencoded json>
 *   data = { serviceId:'OrderListDataLineService.buyerOrderList',
 *            param:'{"startDateTime":"...","page":1,"pageSize":100}' }   ← param 是**字符串**
 *   · sign = md5(token + '&' + t + '&' + appKey + '&' + data)，token 取自 cookie `_m_h5_tk` 下划线前段
 *   · **必须有真实买家登录态**：无 cookie 时返回 FAIL_SYS_SESSION_EXPIRED，且不会下发 _m_h5_tk；
 *     只有公共接口（如 mtop.common.getTimestamp）能匿名通，业务接口一律要登录。
 *     → 所以用户给的 URL 里那个固定 sign 无法复用（sign 与 t/data 绑定，且会随会话过期）。
 *   · pageSize 上限 100（传 200 仍只回 100）；按 gmtCreate 倒序，翻页稳定不重复（实测 3 页 300 单零重叠）
 *
 * 响应结构（关键：业务数据埋在**字符串**里，要拆两层）：
 *   json.data.data.result  =  string
 *     → JSON.parse → { data: { data:[订单...], total:2104, pages:22, pageSize:100 }, success:true }
 *
 * 登录态从哪来（本模块只认两个来源，都不入库）：
 *   1. 环境变量 ALI_COOKIE（运维/临时验证用）
 *   2. data/ali-cookie.txt（用户自己粘贴的一串 cookie，本机文件，不进数据库、不进 git）
 *   ⚠ 与拼多多不同：pdd 的 cookie 由本机助手采集回传并存 pdd_session 表；
 *     1688 这边刻意不落库，避免把采购账号凭据写进数据库备份。
 *
 * 入库口径（与 Excel 导入对齐）：
 *   · order_no 为唯一键，重复订单走 UPDATE，但**不覆盖 invoice_state / state_***（开票状态归发票模块权威维护）
 *   · 只写订单侧字段，invoice_state 新插入时用默认 none
 *   · 原始响应按批落盘到 data/users/<id>/ali-raw/，字段映射有偏差时可直接对照补
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { loadConfig, ROOT } = require('./config');

const APP_KEY = '12574478';
const API = 'mtop.1688.trading.dataline.service';
const HOST = 'h5api.m.1688.com';
const SERVICE_ID = 'OrderListDataLineService.buyerOrderList';
const PAGE_SIZE = 100;           // 单页订单数（实测 100 为上限，传 200 也只回 100）
const PAGE_GAP_MS = 700;         // 页间隔，别惊动风控
const DEFAULT_MAX_PAGES = 200;   // 翻页上限（防死循环）：200 页 × 100 = 20000 单
// Cookie 文件路径可用 ALI_COOKIE_FILE 覆盖（隔离验证用），默认仍是 data/ali-cookie.txt
const COOKIE_FILE = process.env.ALI_COOKIE_FILE || path.join(ROOT, 'data', 'ali-cookie.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');


// ─────────────────────────────────────────────────────────────────────────
// 登录态
// ─────────────────────────────────────────────────────────────────────────

/** 读 cookie：环境变量优先，其次本地文件。返回 '' 表示未配置。 */
function loadCookie() {
  if (process.env.ALI_COOKIE && String(process.env.ALI_COOKIE).trim()) {
    return String(process.env.ALI_COOKIE).trim();
  }
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const s = fs.readFileSync(COOKIE_FILE, 'utf-8').trim();
      if (s) return s;
    }
  } catch (e) { /* 读不到就当未配置 */ }
  return '';
}

function saveCookie(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('cookie 为空');
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, s, 'utf-8');
  return { ok: true, length: s.length };
}

/**
 * 清掉服务器侧的 1688 登录态（「退出1688」双清的第①清：删 Cookie 文件）。
 * 注意：环境变量 ALI_COOKIE 优先于文件，env 在场时清文件不影响实际取数 ——
 * 返回值里如实标注，由调用方决定怎么提示。
 */
function clearCookie() {
  let hadFile = false;
  try { hadFile = fs.existsSync(COOKIE_FILE); if (hadFile) fs.unlinkSync(COOKIE_FILE); } catch (e) { /* 清不掉就如实说 */ }
  return { ok: true, hadFile, file: COOKIE_FILE, envOverridden: !!(process.env.ALI_COOKIE && String(process.env.ALI_COOKIE).trim()) };
}

/** 从 cookie 串里取 _m_h5_tk 的 token 段（下划线前）。没有则返回 ''。 */function tokenFromCookie(cookie) {
  const m = String(cookie || '').match(/_m_h5_tk=([^;\s]+)/);
  if (!m) return '';
  return decodeURIComponent(m[1]).split('_')[0] || '';
}

/** 状态：给前端显示「有没有登录态」用，不暴露 cookie 内容。 */
function sessionStatus() {
  const c = loadCookie();
  const names = c ? c.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean) : [];
  return {
    configured: !!c,
    length: c.length,
    hasCookie2: names.includes('cookie2'),
    hasLogon: names.includes('__cn_logon__'),
    source: process.env.ALI_COOKIE ? 'env' : (c ? 'file' : 'none'),
    cookieCount: names.length,
  };
}


// ─────────────────────────────────────────────────────────────────────────
// 请求
// ─────────────────────────────────────────────────────────────────────────

function buildUrl({ t, sign, api }) {
  const hostApi = api || API;
  // 参数顺序与浏览器实际请求一致（2026-10-29 抓包对照）
  const q = [
    'jsv=2.7.4',
    'appKey=' + APP_KEY,
    't=' + t,
    'sign=' + sign,
    'ecode=1',
    'type=json',
    'valueType=string',
    'api=' + encodeURIComponent(hostApi),
    'v=1.0',
    'dataType=jsonp',
  ].join('&');
  return `https://${HOST}/h5/${hostApi}/1.0/?${q}`;
}

/**
 * 发请求。**用 POST 把 data 放在 body 里**——这是浏览器真实做法
 * （抓包确认：Content-type: application/x-www-form-urlencoded，body 为 data=<urlencoded json>）。
 * 之前用 GET + query 传 data，服务端会直接判 SESSION_EXPIRED，很难看出是传参方式的问题。
 */
function httpPost(url, body, cookie) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        // 抓包实测：这个接口的 Referer 是 air.1688.com（订单列表新版页面就挂在这个域下）
        referer: 'https://air.1688.com/',
        origin: 'https://air.1688.com',
        accept: 'application/json',
        'accept-language': 'zh-CN,zh;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        ...(cookie ? { cookie } : {}),
      },
      timeout: 25000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        setCookie: res.headers['set-cookie'] || [],
      }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.end(body);
  });
}

/** 把人话错误码翻出来，别把 mtop 原文直接甩给用户 */
function explainRet(ret) {
  const s = String(ret || '');
  if (/SUCCESS/.test(s)) return null;
  if (/SESSION_EXPIRED/.test(s)) {
    return '1688 登录态已失效（登录态会过期，这是接口要求）：请到「1688发票」页点「登录1688」，在助手窗口里重新登录';
  }
  if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/.test(s)) {
    return '访问令牌缺失或过期：接口要求 _m_h5_tk 令牌，请重新登录 1688 后重试';
  }
  if (/ILLEGAL_SIGN|SIGN_ERROR/.test(s)) return '签名校验失败（sign 与 t/data 不匹配）';
  if (/FORBIDDEN|PERMISSION/.test(s)) return '当前账号无权访问该接口（需要买家账号，且开通了订单数据权限）';
  if (/LIMIT|FREQUENCY|THROTTLE/.test(s)) return '请求过于频繁，请过几分钟再试';
  return s;
}

/**
 * 调一次 mtop 业务接口。
 * token 为空时先打公共接口取（公共接口匿名可通，有时会顺带下发 _m_h5_tk），
 * 取不到就直接用空 token 发——接口会明确回报 SESSION_EXPIRED / TOKEN_EMPTY。
 */
async function callMTop(data, { cookie, token, api } = {}) {
  let tk = token !== undefined ? token : tokenFromCookie(cookie);

  const once = async (tok) => {
    const t = String(Date.now());
    const sign = md5(`${tok}&${t}&${APP_KEY}&${data}`);
    const body = 'data=' + encodeURIComponent(data);
    const r = await httpPost(buildUrl({ t, sign, api }), body, cookie);
    if (r.error) return { ok: false, error: r.error, raw: null };
    let json = null;
    try { json = JSON.parse(r.body); } catch (e) { /* 非 JSON：可能是风控页 */ }
    const ret = json && json.ret && json.ret[0];
    // 顺带捡新下发的 token
    for (const c of r.setCookie) {
      const m = String(c).match(/^_m_h5_tk=([^;]+)/);
      if (m) tk = decodeURIComponent(m[1]).split('_')[0];
    }
    return { ok: true, status: r.status, json, ret, tk, setCookie: r.setCookie, body: r.body };
  };

  let out = await once(tk);
  if (!out.ok) return out;

  // 无 token 且被拒 → 尝试用响应里下发的 token 重试一次
  if (!tk) {
    const t1 = String(Date.now());
    const pubApi = 'mtop.common.getTimestamp';
    const pubUrl = `https://${HOST}/h5/${pubApi}/1.0/?jsv=2.7.4&appKey=${APP_KEY}`
      + `&t=${t1}&sign=${md5(`${t1}&${APP_KEY}&${pubApi}`).toUpperCase()}&api=${pubApi}&v=1.0&type=json`;
    const pr = await httpPost(pubUrl, '', cookie);
    let got = '';
    for (const c of (pr.setCookie || [])) {
      const m = String(c).match(/^_m_h5_tk=([^;]+)/);
      if (m) got = decodeURIComponent(m[1]).split('_')[0];
    }
    if (got) {
      out = await once(got);
      out.tokenFromPublic = got;
    }
  }
  return out;
}

/** 拉一页订单 */
async function fetchOrderPage({ cookie, token, startDateTime, page = 1, pageSize = PAGE_SIZE }) {
  const param = JSON.stringify({ startDateTime, page, pageSize });
  const data = JSON.stringify({ serviceId: SERVICE_ID, param });
  const r = await callMTop(data, { cookie, token });
  if (!r.ok) return { ok: false, error: '请求失败：' + r.error };
  const why = explainRet(r.ret);
  if (why) return { ok: false, error: why, ret: r.ret, raw: r.json, token: r.tk };
  return { ok: true, json: r.json, token: r.tk, setCookie: r.setCookie };
}


// ─────────────────────────────────────────────────────────────────────────
// 解析：字段候选 + 自适应取订单数组
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从响应里找订单数组。接口把真正的业务数据塞在一个**字符串**里，必须拆两层：
 *
 *   json.data.data.result            ← string（不是对象！直接 JSON.stringify 看到的是一坨转义）
 *     → JSON.parse 后：
 *       { data: { data: [ 订单... ], total: 2104, pages: 22, pageSize: 100 }, success: true }
 *
 * 所以这里做的是「BFS + 遇字符串即尝试解析」，对层级变化免疫；
 * 顺带把数组所在的那一层的 total / pages 当成分页信息带出去。
 */
function pickArray(json) {
  const seen = new Set();
  const queue = [{ node: json, path: '' }];
  while (queue.length) {
    const { node, path: p } = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      const here = p ? `${p}.${k}` : k;
      if (typeof v === 'string') {
        const s = v.trim();
        if (s[0] === '{' || s[0] === '[') {
          try { queue.push({ node: JSON.parse(s), path: here }); } catch (e) { /* 普通文本，忽略 */ }
        }
        continue;
      }
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') {
        // 数组元素里像订单（有订单号/金额类键）就认
        const keys = Object.keys(v[0]).join(',').toLowerCase();
        if (/order|trade|pay|seller|sum/.test(keys)) {
          return {
            path: here,
            rows: v,
            // 同层的 total / pages —— 用来判断还有没有下一页
            total: Number(node.total) || null,
            pages: Number(node.pages) || null,
          };
        }
      } else if (v && typeof v === 'object') {
        queue.push({ node: v, path: here });
      }
    }
  }
  return { path: null, rows: [], total: null, pages: null };
}

const pick = (o, keys) => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * 金额：**接口给的是「分」，不是元**。
 * 实测：订单 3316531947181092453 的 sumPayment="5590"，1688 页面实际是 ¥55.90。
 * 交叉验证：鼠标垫单价 price="900"（9 元/件）、帽子单 896+420-135=1181（11.81 元）——
 * 若按元解读全都离谱（900 元的鼠标垫、1181 元的两顶帽子），按分则全部合理。
 * 库里 Excel 导入的历史数据本来就是元，所以必须在这里除 100 对齐口径。
 */
const money = (v) => {
  const n = num(v);
  return n === null ? null : n / 100;
};

const pad2 = (n) => String(n).padStart(2, '0');
/** Date → 'YYYY-MM-DD HH:mm:ss'（本地时区，与库里其他时间口径一致） */
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
  + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** 时间：支持 'YYYY-MM-DD HH:mm:ss' / 时间戳(ms，如 gmtPayment) / ISO。统一输出 DATETIME 字符串 */
const dt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (/^\d{10,13}$/.test(String(v))) {
    // 13 位是毫秒，10 位是秒；gmtPayment 实测为 13 位
    const ms = String(v).length === 13 ? Number(v) : Number(v) * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : fmtDate(d);
  }
  const s = String(v).replace('T', ' ').replace(/\.\d+Z?$/, '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ ]?(\d{2}:\d{2}(:\d{2})?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4] ? (m[4].length === 5 ? m[4] + ':00' : m[4]) : '00:00:00'}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : fmtDate(d);
};

/**
 * 一条原始订单 → invoice_order 行。
 * 前半段是按 2026-10-29 实测响应写死的字段（准），后半段保留候选式兜底，
 * 万一接口改版还能捞回一部分，不至于整单变 null。
 *
 * 实测样本（首单）：
 *   idStr        3316531947181092453
 *   gmtCreate    2026-10-27 18:00:35
 *   gmtPayment   1793180406000            ← 毫秒时间戳，只有已付款的单才有
 *   status       waitbuyerpay   statusLabel 待付款
 *   sumPayment   "5590"                     ← **单位是分** = ¥55.90（整单实付）
 *   sumProductPayment 商品合计   carriage 运费   ← 同样是分
 *   sellerInfo   { companyName, loginId, userId, companyUrl }
 *   buyerInfo    { companyName, loginId, nick, userId, level }
 *   orderEntries [{ productName, quantity:{calAmount,realAmount}, amount, price, specInfo }]
 *   track        {}                       ← 列表接口不带物流，留空
 */
function mapOrder(o, userId) {
  const orderNo = pick(o, ['idStr', 'orderNo', 'order_no', 'bizOrderNo', 'tradeNo', 'id', 'orderId']);
  if (!orderNo) return null;

  const seller = o.sellerInfo || o.seller || {};
  const buyer = o.buyerInfo || o.buyer || {};
  const entries = Array.isArray(o.orderEntries) ? o.orderEntries : [];
  const first = entries[0] || {};

  // 数量：quantity 是对象 { amountFactor, calAmount, realAmount }
  // calAmount = 下单件数，realAmount = 实际收货件数（未确认收货时为 0）→ 优先实收，回落下单数
  const q = first.quantity;
  const qty = q && typeof q === 'object'
    ? (num(q.realAmount) || num(q.calAmount))
    : num(q || pick(o, ['quantity', 'productQuantity', 'totalQuantity', 'num']));

  // 商品标题：多商品时标注「等 N 件」，列表里一眼能看出是合并单
  let title = first.productName ? String(first.productName) : pick(o, ['productName', 'subject', 'goodsTitle']);
  if (title && entries.length > 1) title = `${title} 等 ${entries.length} 件`;

  return {
    user_id: userId,
    order_no: String(orderNo),
    buyer_company: buyer.companyName || pick(o, ['buyerCompanyName', 'buyerCompany', 'buyerCorpName']),
    buyer_login: buyer.loginId || buyer.nick
      || pick(o, ['buyerLoginId', 'buyerLogin', 'buyerNick', 'buyerMemberId', 'buyerName']),
    seller_company: seller.companyName
      ? String(seller.companyName).trim()
      : (pick(o, ['sellerCompanyName', 'sellerName', 'companyName', 'sellerShopName', 'shopName']) || null),
    seller_login: seller.loginId
      ? String(seller.loginId).trim()
      : (pick(o, ['sellerLoginId', 'sellerLogin', 'sellerNick', 'sellerMemberId', 'loginId']) || null),
    goods_amount: money(pick(o, ['sumProductPayment', 'originalSumPayment', 'goodsAmount', 'productSumPayment'])),
    freight_amount: money(pick(o, ['carriage', 'freight', 'freightAmount', 'postFee', 'carriageFee'])),
    discount_amount: money(pick(o, ['allPromotionFee', 'adjustFee', 'discount', 'discountAmount', 'adjustAmount'])),
    pay_amount: money(pick(o, ['sumPayment', 'payAmount', 'actualPayAmount', 'paidFee', 'payFee', 'totalPayAmount'])),
    // 存中文状态：表注释就是「交易成功 / 交易关闭 等」，前端直接显示
    order_status: o.statusLabel
      ? String(o.statusLabel)
      : (pick(o, ['orderStatus', 'statusDesc', 'orderStatusDesc', 'statusText', 'status']) || null),
    created_at: dt(pick(o, ['gmtCreate', 'createTime', 'createdTime', 'orderTime', 'tradeCreateTime'])),
    pay_time: dt(pick(o, ['gmtPayment', 'payTime', 'gmtPay', 'paySuccessTime', 'paymentTime', 'payDate'])),
    goods_title: title ? String(title).slice(0, 500) : null,
    quantity: qty,
    unit: pick(o, ['unit', 'productUnit']) || null,
    logistics_company: pick(o, ['logisticsCompany', 'logisticsName', 'companyNameExpress']),
    tracking_no: pick(o, ['trackingNo', 'mailNo', 'logisticsNo']),
    source_file: 'mtop:buyerOrderList',
  };
}


// ─────────────────────────────────────────────────────────────────────────
// 入库
// ─────────────────────────────────────────────────────────────────────────

const UPDATE_COLS = ['buyer_company', 'buyer_login', 'seller_company', 'seller_login',
  'goods_amount', 'freight_amount', 'discount_amount', 'pay_amount', 'order_status',
  'created_at', 'pay_time', 'goods_title', 'quantity', 'unit', 'logistics_company',
  'tracking_no', 'source_file'];

async function upsertOrders(rows, userId) {
  if (!rows.length) return { saved: 0, inserted: 0 };
  const fields = ['user_id', 'order_no', ...UPDATE_COLS];
  // 先查已存在的单号，用来区分「新增」和「更新」
  const nos = rows.map((r) => r.order_no);
  let exist = new Set();
  for (let i = 0; i < nos.length; i += 500) {
    const part = nos.slice(i, i + 500);
    const r = await db.query(
      `SELECT order_no FROM invoice_order WHERE user_id = ? AND order_no IN (${part.map(() => '?').join(',')})`,
      [userId, ...part]
    );
    r.forEach((x) => exist.add(String(x.order_no)));
  }

  let saved = 0;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
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
    // 已存在则更新订单侧字段；**不碰 invoice_state / state_***（开票状态归发票模块）
    const sql = `INSERT INTO invoice_order (${fields.map((f) => `\`${f}\``).join(',')})
      VALUES ${ph.join(',')}
      ON DUPLICATE KEY UPDATE ${UPDATE_COLS.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}`;
    await db.exec(sql, values);
    // 不能累加 affectedRows：MySQL 在 ON DUPLICATE KEY UPDATE 命中且值有变化时返回 2、
    // 值没变化时返回 0，累加起来会得到「更新数 > 总单数」这种数字。这里按实际处理的条数计。
    saved += part.length;
  }
  const inserted = rows.filter((r) => !exist.has(String(r.order_no))).length;
  return { saved, inserted };
}

/**
 * 增量起点 = 库里最近的**下单时间**，再回退 1 天做重叠窗口。
 *
 * 为什么只认 created_at、不掺 pay_time：
 *   接口是按 gmtCreate 过滤的。若拿 GREATEST(created_at, pay_time) 当起点，
 *   一旦库里有「付款时间晚于最新下单时间」的单（很常见，下单 25 号、28 号才付款），
 *   起点就被推到 28 号，26~28 号之间新下但未付款的单**永远拉不到**。
 *   回退 1 天是为了兜住边界秒级误差，重复的单会被 upsert 幂等更新，不产生脏数据。
 */
async function latestOrderTime(userId) {
  const r = await db.query(
    `SELECT MAX(created_at) AS t FROM invoice_order WHERE user_id = ?`, [userId]);
  const t = r && r[0] && r[0].t;
  if (!t) return null;   // 该租户还没有任何订单：不要从 1970 开始翻，交给调用方要求先导入
  const d = t instanceof Date ? new Date(t) : new Date(String(t).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(t);
  d.setDate(d.getDate() - 1);            // 重叠 1 天
  return fmtDate(d);
}

function getMaxPages() {
  let raw;
  try {
    const cfg = loadConfig() || {};
    raw = cfg.runtime && cfg.runtime.aliMaxPages;
  } catch (e) { raw = null; }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_PAGES;
  return Math.min(2000, Math.max(1, Math.round(n)));
}


// ─────────────────────────────────────────────────────────────────────────
// 同步主流程
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从「库里最近的订单时间」开始，往后（含该时刻）翻页拉全部订单，直到空页。
 * @param {number} userId  数据归属用户
 * @param {function} onProgress 进度回调 { page, fetched, rows, saved, newCount, current }
 * @param {function} shouldStop 返回 true 则提前停
 */
async function syncOrders({ userId, onProgress = () => {}, shouldStop = () => false, startDateTime: forced } = {}) {
  const uid = Number(userId) || 1;
  const cookie = loadCookie();
  if (!cookie) {
    return {
      ok: false, needLogin: true,
      message: '未配置 1688 登录态：接口需要真实买家登录 Cookie，请到「1688发票」页点「登录1688」，在助手窗口里登录（登录态自动回传服务器）',
    };
  }

  const startDateTime = forced || (await latestOrderTime(uid));
  if (!startDateTime) {
    // 首次使用：库里一条订单都没有，增量起点无从谈起（不能从 1970 开始翻上万页）
    return {
      ok: false, needImport: true,
      message: '首次使用需要先导入历史订单：点「导入订单」上传从 1688 导出的订单 Excel，之后「刷新」才会按下单时间做增量拉取',
    };
  }

  const maxPages = getMaxPages();
  let token = tokenFromCookie(cookie);
  let page = 1, fetched = 0, saved = 0, newCount = 0, truncated = false, orderTotal = 0;
  const rawDir = path.join(ROOT, 'data', 'users', String(uid), 'ali-raw');

  for (; page <= maxPages; page++) {
    if (shouldStop()) return { ok: true, stopped: true, pages: page - 1, fetched, saved, newCount, startDateTime };

    const r = await fetchOrderPage({ cookie, token, startDateTime, page, pageSize: PAGE_SIZE });
    if (!r.ok) {
      if (page === 1) {
        return {
          ok: false, needLogin: /会话|登录|令牌|Session/i.test(r.error || ''),
          message: r.error, startDateTime, rawSample: r.raw ? JSON.stringify(r.raw).slice(0, 600) : null,
        };
      }
      return { ok: false, message: `第 ${page} 页失败：${r.error}，前 ${page - 1} 页已入库`, pages: page - 1, fetched, saved, newCount, startDateTime };
    }
    token = r.token || token;

    const { path: arrPath, rows: list, total, pages } = pickArray(r.json);
    if (!list.length) break;                       // 空页 = 拉完了
    if (total) orderTotal = total;

    // 首次成功时把原始响应落盘一份，字段映射不对时直接照这个补
    if (page === 1) {
      try {
        fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, `sample-${Date.now()}.json`),
          JSON.stringify(r.json, null, 2), 'utf-8');
      } catch (e) { /* 落盘失败不影响同步 */ }
    }

    const mapped = list.map((o) => mapOrder(o, uid)).filter(Boolean);
    const { saved: s, inserted } = await upsertOrders(mapped, uid);
    fetched += list.length;
    saved += s;
    newCount += inserted;

    onProgress({
      page, totalPages: pages, total, fetched, rows: mapped.length, saved, newCount,
      current: mapped[0] ? (mapped[0].seller_company || mapped[0].order_no) : '',
      arrayPath: arrPath,
      firstKeys: list[0] ? Object.keys(list[0]).slice(0, 40) : [],
      __start: startDateTime,
    });

    if (pages && page >= pages) break;             // 已到接口给的最后一页
    if (list.length < PAGE_SIZE) break;            // 不满一页 = 最后一页
    await sleep(PAGE_GAP_MS);
  }

  if (page > maxPages) truncated = true;
  return {
    ok: true, pages: Math.min(page, maxPages), fetched, saved, newCount, total: orderTotal,
    startDateTime, truncated, maxPages,
    message: `同步完成：${fetched} 单（新增 ${newCount}，更新 ${saved - newCount}）`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 已开票同步（mtop: mtop.1688.kingsuns.invoice.dataline.service）
//   接口：KsInvoicePurchaserManageMtopService.queryInvoiceApplyRecordListByPage
//   param：{ page, pageSize, bizStatusList:[2,30,31,32] }   ← 2/30/31/32 = 已开票系列受理状态
//   增量：按开票时间。接口有没有时间过滤参数还没确认，所以先翻页、再按开票时间本地过滤：
//         只回写比「库里最近一次 issued 时间」更新的记录，重复跑不会反复改库。
//   落库：invoice_order.invoice_state='issued'（state_source=platform），
//         发票号写进 state_note（人工核对用），不动金额/订单侧字段。
// ─────────────────────────────────────────────────────────────────────────
const INVOICE_API = 'mtop.1688.kingsuns.invoice.dataline.service';
const INVOICE_SERVICE_ID = 'KsInvoicePurchaserManageMtopService.queryInvoiceApplyRecordListByPage';
const INVOICE_PAGE_SIZE = 20;
const INVOICE_STATUS_LIST = [2, 30, 31, 32];

/** 拉一页申请记录 */
async function fetchInvoicePage({ cookie, token, page = 1, pageSize = INVOICE_PAGE_SIZE }) {
  const param = JSON.stringify({ page, pageSize, bizStatusList: INVOICE_STATUS_LIST });
  const data = JSON.stringify({ serviceId: INVOICE_SERVICE_ID, param });
  const r = await callMTop(data, { cookie, token, api: INVOICE_API });
  if (!r.ok) return { ok: false, error: '请求失败：' + r.error };
  const why = explainRet(r.ret);
  if (why) return { ok: false, error: why, ret: r.ret, raw: r.json, token: r.tk };
  return { ok: true, json: r.json, token: r.tk };
}

/** 一条申请记录 → {orderNo, invoiceNo, invoiceTime, status}（字段名未知，按候选取） */
function mapInvoiceRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const orderNo = pick(r, ['orderNo', 'orderId', 'bizOrderNo', 'tradeOrderNo', 'orderSn', 'idStr']);
  if (!orderNo) return null;
  return {
    orderNo: String(orderNo),
    invoiceNo: pick(r, ['invoiceNo', 'eInvoiceNo', 'invoiceNumber', 'invoiceCode']),
    invoiceTime: dt(pick(r, ['invoiceTime', 'gmtInvoice', 'invoiceDate', 'issueTime', 'gmtCreate'])),
    status: pick(r, ['statusDesc', 'status', 'bizStatusDesc', 'applyStatusDesc']),
  };
}

/**
 * 把匹配到的订单标成已开票（一次 CASE 更新，比逐行 UPDATE 快得多）
 * @returns {Promise<{updated:number, missing:number}>}
 */
async function markIssued(userId, records) {
  const uid = Number(userId) || 1;
  if (!records.length) return { updated: 0, missing: 0 };
  let updated = 0;
  let missing = 0;
  const CHUNK = 200;
  for (let i = 0; i < records.length; i += CHUNK) {
    const part = records.slice(i, i + CHUNK);
    const nos = part.map((x) => x.orderNo);
    const ph = nos.map(() => '?').join(',');
    const exist = await db.query(
      `SELECT order_no FROM invoice_order WHERE user_id = ? AND order_no IN (${ph})`, [uid, ...nos]
    ).catch(() => []);
    const has = new Set((exist || []).map((x) => String(x.order_no)));
    const hit = part.filter((x) => has.has(x.orderNo));
    missing += part.length - hit.length;
    if (!hit.length) continue;
    const caseSql = hit.map(() => 'WHEN ? THEN ?').join(' ');
    const caseArgs = [];
    for (const x of hit) {
      caseArgs.push(x.orderNo, String(`平台已开票${x.invoiceNo ? '：发票号 ' + x.invoiceNo : ''}`).slice(0, 250));
    }
    const inPh = hit.map(() => '?').join(',');
    await db.exec(
      `UPDATE invoice_order SET invoice_state = 'issued', state_source = 'platform',`
      + ` state_updated_at = NOW(), state_note = CASE order_no ${caseSql} END`
      + ` WHERE user_id = ? AND order_no IN (${inPh})`,
      [...caseArgs, uid, ...hit.map((x) => x.orderNo)]
    ).catch(() => null);
    updated += hit.length;
  }
  return { updated, missing };
}

/**
 * 增量同步已开票状态：翻页拉申请记录 → 过滤出比 startDateTime 新的 → 回写 invoice_state。
 * @param {object} p { userId, onProgress, shouldStop, startDateTime }
 */
async function syncInvoices({ userId, onProgress = () => {}, shouldStop = () => false, startDateTime: forced } = {}) {
  const uid = Number(userId) || 1;
  const cookie = loadCookie();
  if (!cookie) {
    return { ok: false, needLogin: true, message: '未配置 1688 登录态：请到「1688发票」页点「登录1688」，在助手窗口里登录' };
  }
  // 增量起点：库里最近一次「平台标记已开票」的时间，回退 1 天做重叠
  let since = forced || null;
  if (!since) {
    const r = await db.query(
      "SELECT MAX(state_updated_at) AS t FROM invoice_order WHERE user_id = ? AND invoice_state = 'issued'", [uid]
    ).catch(() => []);
    const t = r && r[0] && r[0].t;
    if (t) {
      const d = t instanceof Date ? new Date(t) : new Date(String(t).replace(' ', 'T'));
      if (!Number.isNaN(d.getTime())) { d.setDate(d.getDate() - 1); since = fmtDate(d); }
    }
  }
  const sinceMs = since ? (Date.parse(String(since).replace(' ', 'T')) || 0) : 0;

  let token = tokenFromCookie(cookie);
  let page = 1;
  let fetched = 0;
  const picked = [];
  const rawDir = path.join(ROOT, 'data', 'users', String(uid), 'ali-invoice-raw');

  for (; page <= 100; page++) {
    if (shouldStop()) return { ok: true, stopped: true, pages: page - 1, fetched, since };
    const r = await fetchInvoicePage({ cookie, token, page });
    if (!r.ok) {
      if (page === 1) {
        return {
          ok: false, needLogin: /会话|登录|令牌|Session/i.test(r.error || ''),
          message: r.error, since, rawSample: r.raw ? JSON.stringify(r.raw).slice(0, 800) : null,
        };
      }
      return { ok: false, message: `第 ${page} 页失败：${r.error}，前 ${page - 1} 页已处理`, pages: page - 1, fetched, since };
    }
    token = r.token || token;
    const { rows: list, total, pages } = pickArray(r.json);
    if (page === 1) {
      try {
        fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, `sample-${Date.now()}.json`), JSON.stringify(r.json, null, 2), 'utf-8');
      } catch (e) { /* 落盘失败不影响同步 */ }
    }
    if (!list.length) break;
    fetched += list.length;
    const mapped = list.map(mapInvoiceRecord).filter(Boolean);
    for (const m of mapped) {
      const ms = m.invoiceTime ? (Date.parse(String(m.invoiceTime).replace(' ', 'T')) || 0) : 0;
      if (sinceMs && ms && ms < sinceMs) continue;   // 比上次更早 = 已经处理过
      picked.push(m);
    }
    onProgress({
      page, totalPages: pages, total, fetched, picked: picked.length,
      current: mapped[0] ? mapped[0].orderNo : '',
    });
    if (pages && page >= pages) break;
    if (list.length < INVOICE_PAGE_SIZE) break;
    await sleep(PAGE_GAP_MS);
  }

  const out = await markIssued(uid, picked);
  return {
    ok: true, pages: page, fetched, since,
    matched: out.updated, missing: out.missing, records: picked.length,
    message: `已开票同步完成：接口 ${fetched} 条、命中订单 ${out.updated} 单`
      + (out.missing ? `（${out.missing} 条订单不在库里，多是还没导入的历史单）` : ''),
  };
}

module.exports = {
  syncOrders, fetchOrderPage, latestOrderTime, mapOrder, pickArray,
  syncInvoices, fetchInvoicePage, mapInvoiceRecord, INVOICE_API, INVOICE_SERVICE_ID,
  sessionStatus, loadCookie, saveCookie, clearCookie, tokenFromCookie,
  calcSign: md5, COOKIE_FILE, PAGE_SIZE,
};
