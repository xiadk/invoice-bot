/**
 * 京东万商（b.jd.com，B2B 采购站）取价。
 *
 * 与齐货通/阿发的关键差异（2026-11-02 实测结论，别再重新试一遍）：
 *   · 详情接口 wareBusiness.style —— **不需要 h5st 签名**，但要 Cookie + 真实浏览器环境
 *   · 加购接口 bmall_cartAdd      —— 同样只要 Cookie（本期不做加购）
 *   · 搜索接口 bmall_goodsm_purchase_search_list —— **必须 h5st**，不带就 HTTP 403 空 body；
 *     签名强绑定 body 且几分钟就过期，服务端算不出来 → 关联商品只能「粘贴链接/skuId」
 *   · b.jd.com 是纯 SPA，HTML 里没有商品数据（每页都是同一份 6.9KB 骨架），爬页面也拿不到
 *
 * ⚠ 请求必须由**本机助手**在万商页面里发（见 lib/jd-agent.js）：
 *   服务器直连即使 Cookie 完全有效也 403 —— 京东网关校验「出口 IP + 浏览器指纹 + Cookie」三者自洽，
 *   云端 IP 打几百次就被标记。所以本模块只负责「组参数 + 解结果」，发请求交给 lib/jd-agent。
 *
 * 登录态从哪来：助手弹窗登录后回传 Cookie 串（本机文件，不入库、不进 git），
 *   这里只从 Cookie 里取三个参数（eid 设备指纹、uuid、收货地址），请求体要用：
 *     · eid      ← 3AB9D23F7A4B3C9B 的值
 *     · uuid     ← __jdu
 *     · addressId + areaId ← wq_addr（格式 "addressId|areaId"）
 *
 * 按账号隔离（2026-11-02 1688 踩过的坑）：data/users/<uid>/jd-session.json，
 *   任一账号登录后不再影响其他账号。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jagent = require('./jd-agent');

const ROOT = path.join(__dirname, '..');
// 万商所有业务接口都走这一个网关地址，区别只在 functionId
const API_URL = 'https://api.m.jd.com/api';

// 万商 PC 端固定参数（抓包得来，长期不变）
const BASE = {
  version: '1.0',
  appid: 'b2b',
  client: 'pc',
  clientVersion: '7.0.2',
  lang: 'zh_CN',
  cthr: '1',
  loginType: '3',
};
const BIZ = { tenantId: 1024, ua: 1, buId: 456 };
const COMMON_PARAM = { pid: 100, verticalCode: 'cn_retail_bmall', ua: 1, language: 'zh', userType: 1 };

// 收货地址的「网格」(gridInfoList)：接口按它算区域价。默认值取自中山店（areaId 19_1657_59566_0）的抓包；
// 换收货地址时可在会话里覆盖（session.gridInfoList）。
const DEFAULT_GRID = [
  { buId: '0', ouIds: [1000002031], gridType: '10001', gridPid: 912824, valueMap: null, gridId: 912825, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 5 },
  { buId: '0', ouIds: [1000002031], gridType: '10001', gridPid: 911786, valueMap: null, gridId: 912824, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 4 },
  { buId: '0', ouIds: [1000002031], gridType: '10001', gridPid: 876907, valueMap: null, gridId: 911786, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 3 },
  { buId: '456', ouIds: [1000002031], gridType: '2181', gridPid: 1050005, valueMap: null, gridId: 1352645, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 1 },
  { buId: '456', ouIds: [1000002031], gridType: '2181', gridPid: 1050005, valueMap: { deliverB: '1' }, gridId: 1054605, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 1 },
];
const DEFAULT_GEO = { longitude: 113.397338, latitude: 22.527928, areaType: 16 };

// ─────────────────────────────────────────────────────────────────────────
// 登录态（按账号隔离）
// ─────────────────────────────────────────────────────────────────────────

function dataDir(uid) {
  return path.join(ROOT, 'data', 'users', String(Number(uid) || 0));
}
function sessionFile(uid) {
  return path.join(dataDir(uid), 'jd-session.json');
}

/** Cookie 串 → { cookie, eid, uuid, addressId, areaId, pin } —— 能取的全从 Cookie 取，用户只粘一串 */
function parseCookie(raw) {
  const cookie = String(raw || '').trim().replace(/^cookie:\s*/i, '').replace(/[\r\n]+/g, ' ');
  const m = {};
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in m)) m[k] = v;
  }
  const eid = m['3AB9D23F7A4B3C9B'] || m['3AB9D23F7A4B3CSS'] || '';
  const uuid = m['__jdu'] || '';
  // wq_addr 形如 "13082155770|19_1657_59566_0"
  let addressId = null;
  let areaId = '';
  const wq = String(m['wq_addr'] || '');
  if (wq.includes('|')) {
    const [a, b] = wq.split('|');
    if (/^\d+$/.test(a.trim())) addressId = Number(a.trim());
    if (/^[\d_]+$/.test(b.trim())) areaId = b.trim();
  }
  let pin = '';
  try { pin = decodeURIComponent(String(m.pin || '')); } catch (e) { pin = String(m.pin || ''); }
  return { cookie, eid, uuid, addressId, areaId, pin, cookieNames: Object.keys(m) };
}

/** 读会话。没有会话返回 null（不抛错，页面据此显示「未配置」）。 */
function loadSession(uid) {
  const f = sessionFile(uid);
  try {
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (!j || !j.cookie) return null;
    return j;
  } catch (e) { return null; }
}

/**
 * 保存会话：只传 cookie 就够，其余字段从 cookie 解析补齐。
 * 已存在的值优先保留（避免用户改地址后又被 cookie 覆盖）。
 */
function saveSession(uid, input) {
  const raw = input && (input.cookie || input.raw);
  const cookie = String(raw || '').trim();
  if (!cookie) throw new Error('Cookie 为空');
  if (!/3AB9D23F7A4B3C9B=|thor=|pt_key=|pinId=/.test(cookie)) {
    throw new Error('这串 Cookie 里没有万商登录态（需要 3AB9D23F7A4B3C9B / thor / pt_key / pinId 之一）');
  }
  const p = parseCookie(cookie);
  const old = loadSession(uid) || {};
  const sess = {
    cookie,
    eid: p.eid || old.eid || '',
    uuid: p.uuid || old.uuid || '',
    addressId: Number(input && input.addressId) || p.addressId || old.addressId || null,
    areaId: String((input && input.areaId) || p.areaId || old.areaId || ''),
    pin: p.pin || old.pin || '',
    gridInfoList: (input && Array.isArray(input.gridInfoList) && input.gridInfoList.length)
      ? input.gridInfoList : (old.gridInfoList || DEFAULT_GRID),
    geo: (input && input.geo) || old.geo || DEFAULT_GEO,
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(dataDir(uid), { recursive: true });
  fs.writeFileSync(sessionFile(uid), JSON.stringify(sess, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return sess;
}

/** 清掉本账号的万商登录态（只删自己的文件，别人的不动） */
function clearSession(uid) {
  const f = sessionFile(uid);
  let had = false;
  try { had = fs.existsSync(f); if (had) fs.unlinkSync(f); } catch (e) { /* 删不掉如实返回 */ }
  return { ok: true, hadFile: had, file: f };
}

/** 给页面看的状态：只说有没有、是谁，不暴露 cookie 内容 */
function sessionStatus(uid) {
  const s = loadSession(uid);
  if (!s) return { configured: false, shop: '', savedAt: null, addressId: null, areaId: '' };
  return {
    configured: true,
    shop: s.pin || '',
    savedAt: s.savedAt || null,
    addressId: s.addressId || null,
    areaId: s.areaId || '',
    hasEid: !!s.eid,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 商品 ID 解析：用户粘贴链接或 ID 都认
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从用户输入里抠出万商 skuId。支持：
 *   · 纯数字              10235591362865
 *   · 万商商品页链接       https://b.jd.com/product/10235591362865.html
 *   · 京东商品页链接       https://item.jd.com/100012043978.html
 *   · 带参数链接           ...?skuId=10235591362865 / ...?wareId=xxx
 * @returns {string} 抠到就返回，抠不到返回 ''
 */
function parseSkuId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^\d{6,20}$/.test(s)) return s;
  // 链接里优先取显式参数，其次取路径里的长数字
  const q = s.match(/[?&](?:skuId|sku|wareId|id)=(\d{6,20})/i);
  if (q) return q[1];
  const pathHit = s.match(/\/(?:product|item)\/(\d{6,20})(?:\.html)?/i);
  if (pathHit) return pathHit[1];
  const any = s.match(/\b(\d{9,20})\b/);
  return any ? any[1] : '';
}

// ─────────────────────────────────────────────────────────────────────────
// 接口调用
// ─────────────────────────────────────────────────────────────────────────

/** 从标题里拆「装箱量 / 规格文案」：「【整箱】可口可乐 摩登罐 330ml*24罐」→ {qty:24, spec:'330ml*24罐', unit:'罐'} */
function parseSpecFromTitle(title) {
  const t = String(title || '');
  // 1) 显式乘法：330ml*24罐 / 500ml×15
  const m1 = t.match(/([\d.]+)\s*(ml|ML|毫升|L|升|g|G|克|kg|KG|千克)?\s*[*x×X]\s*(\d+)\s*(罐|瓶|包|袋|盒|支|听|片|个|桶)?/);
  if (m1) {
    const qty = Number(m1[3]);
    const unit = m1[4] || '';
    return { qty: Number.isFinite(qty) && qty > 0 ? qty : null, spec: m1[0].replace(/\s+/g, ''), unit };
  }
  // 2) 装箱写法：24罐/箱、24瓶装
  const m2 = t.match(/(\d+)\s*(罐|瓶|包|袋|盒|支|听|片|个|桶)\s*[/／]?\s*(?:箱|件|装)/);
  if (m2) {
    const qty = Number(m2[1]);
    return { qty: Number.isFinite(qty) && qty > 0 ? qty : null, spec: m2[0].replace(/\s+/g, ''), unit: m2[2] };
  }
  return { qty: null, spec: '', unit: '' };
}

/**
 * 组装取价表单（api.m.jd.com 只吃 x-www-form-urlencoded）。
 * 参数照抓包原样：BASE 固定参数 + t/eid/uuid/functionId/body。
 */
function buildDetailForm(skuId, sess) {
  const geo = sess.geo || DEFAULT_GEO;
  const body = {
    uniformBizInfo: Object.assign({}, BIZ, { bMallTag: '1' }),
    commonParam: COMMON_PARAM,
    skuId: String(skuId),
    bMallTag: '1',
    verticalTag: 'cn_retail_bmall',
    skuUniformBizInfo: { buId: 456 },
    areaId: sess.areaId || '19_1657_59566_0',
    gridInfoList: sess.gridInfoList || DEFAULT_GRID,
    skuNum: 1,
    longitude: geo.longitude,
    latitude: geo.latitude,
    areaType: geo.areaType,
    traceId: crypto.randomUUID(),
  };
  return Object.assign({}, BASE, {
    t: String(Date.now()),
    eid: sess.eid || '',
    uuid: sess.uuid || '',
    functionId: 'wareBusiness.style',
    body: JSON.stringify(body),
  });
}

/** 京东详情 JSON → 页面要的统一字段（齐货通/阿发/京东三列同一套字段名） */
function parseDetail(j, id) {
  if (!j) return { ok: false, skuId: id, error: '京东返回内容不是 JSON', code: 'parse' };
  const res = j.result;
  if (!res) {
    return { ok: false, skuId: id, error: '京东未返回商品（' + (j.resultMsg || j.message || j.code || '无详情') + '）', code: 'empty' };
  }
  const title = (res.viewTitleDTO && res.viewTitleDTO.title) || '';
  const mainPrice = res.viewSelectedDTO && res.viewSelectedDTO.mainPrice;
  const orig = (res.others && res.others.priceInfo && res.others.priceInfo.originalPrice) || null;
  const img = ((res.viewMasterMapDTO && res.viewMasterMapDTO.wareImage && res.viewMasterMapDTO.wareImage[0]) || {}).big
    || (res.viewSelectedDTO && res.viewSelectedDTO.imageUrl ? 'https://img14.360buyimg.com/n1/' + res.viewSelectedDTO.imageUrl : '');
  const common = res.viewCommonDTO || {};
  const stock = (res.viewStockDTO && res.viewStockDTO.stock) || '';
  const sp = parseSpecFromTitle(title);
  const packPrice = mainPrice === null || mainPrice === undefined || mainPrice === '' ? null : Number(mainPrice);
  const packQty = sp.qty;
  const unitPrice = (packPrice != null && packQty) ? Number((packPrice / packQty).toFixed(4)) : null;

  return {
    ok: true,
    skuId: id,
    goodsId: id,
    goodsName: title,
    // 页面模板与阿发/齐货通同一套字段名：整件价 packPrice、一件多少小单位 packQty、折合单价 unitPrice
    unitPrice,
    packPrice,
    packQty,
    spec: sp.spec,
    unit: sp.unit,
    originalPrice: orig == null || orig === '' ? null : Number(orig),
    picture: img,
    brand: common.brandName || '',
    category: common.category_name1 || '',
    stock,
    stockState: common.stockState,
    shelfLife: common.shelfLife || '',
    produceDate: common.manufacturingDate || '',
    shopId: common.shopId || '',
    venderId: common.venderId || '',
  };
}

/**
 * 取单个 sku 的详情（万商价、原价、图、品牌、库存、保质期）。
 * 请求由本机助手在万商页面里发（服务器直连必 403），这里只组参数、解结果。
 * @param {object} opts { uid } uid = 谁的万商登录态就派给谁的助手
 * @returns {Promise<{ok:boolean, skuId:string, ...}>} 失败时 ok=false 且带 error
 */
async function fetchDetail(skuId, sess, opts) {
  const id = String(skuId || '').trim();
  const uid = Number((opts && opts.uid) || 0);
  if (!id) return { ok: false, skuId: id, error: 'skuId 为空' };
  if (!sess || !sess.cookie) return { ok: false, skuId: id, error: '未登录京东万商', code: 'no_session' };

  const r = await jagent.request({
    uid,
    url: API_URL,
    method: 'POST',
    headers: { Accept: 'application/json, text/plain, */*' },
    form: buildDetailForm(id, sess),
    timeoutMs: Number(opts && opts.timeoutMs) || undefined,
  });

  if (r.unavailable) return { ok: false, skuId: id, error: r.message, code: 'no_agent' };
  if (!r.ok) return { ok: false, skuId: id, error: r.message || '助手执行失败', code: 'agent' };
  if (r.status === 403) {
    return { ok: false, skuId: id, error: '京东返回 403：万商登录态失效（点「万商登录」重新登录）', code: 'auth' };
  }
  if (r.status !== 200) {
    return { ok: false, skuId: id, error: '京东返回 HTTP ' + r.status + (r.text ? '：' + r.text.slice(0, 120) : ''), code: 'http' };
  }
  return parseDetail(r.json, id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 批量取价：串行 + 间隔（默认 500ms，走本机助手页内请求，比直连稳）。
 * 京东比阿发严，不做并发轰炸；几百个商品也就几分钟。
 * @param {Array<string|number>} skuIds
 * @param {object} sess
 * @param {{uid:number, interval?:number, onProgress?:Function, shouldStop?:Function}} opts
 */
async function fetchPrices(skuIds, sess, opts) {
  const o = opts || {};
  const interval = Number.isFinite(o.interval) ? o.interval : 500;
  const ids = [...new Set((skuIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  const prices = {};
  let fetched = 0; let failed = 0;
  let stopReason = '';
  for (let i = 0; i < ids.length; i++) {
    if (o.shouldStop && o.shouldStop()) break;
    const id = ids[i];
    let r;
    try {
      r = await fetchDetail(id, sess, { uid: o.uid });
    } catch (e) {
      r = { ok: false, skuId: id, error: (e && e.message) || String(e) };
    }
    prices[id] = r;
    if (r.ok) fetched++; else failed++;
    if (o.onProgress) {
      try { o.onProgress({ done: i + 1, total: ids.length, skuId: id, ok: r.ok, fetched, failed }); } catch (e) { /* 回调异常不影响取价 */ }
    }
    // 登录态失效 / 助手掉线：立刻停 —— 继续打只会把账号往风控里送，或空转几十次超时
    if (!r.ok && (r.code === 'auth' || r.code === 'no_agent')) { stopReason = r.error; break; }
    if (i < ids.length - 1) await sleep(interval);
  }
  return { prices, fetched, failed, total: ids.length, stopReason };
}

module.exports = {
  parseCookie, parseSkuId, parseSpecFromTitle,
  loadSession, saveSession, clearSession, sessionStatus, sessionFile,
  buildDetailForm, parseDetail, fetchDetail, fetchPrices,
  DEFAULT_GRID, DEFAULT_GEO, BASE, BIZ, COMMON_PARAM, API_URL,
};
