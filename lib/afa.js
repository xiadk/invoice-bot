/**
 * 城配速达（永源顺·bluespace-plus.zhoupudata.com）接口封装：商品搜索 / 详情取价 / 加入购物车。
 *
 * 鉴权：请求头 authorization: Bearer <JWT>。该 JWT 由小程序登录后下发，有效期约 1 天，过期后接口报错。
 * 用户在城配速达小程序里把当前 authorization 值（即 Bearer xxx）复制到本系统的「配置阿发Token」里即可。
 * 服务端不校验 sign 头（实测无 sign / 假 sign / 真 sign 都返回 200），所以本模块不计算签名。
 *
 * 单价口径（页面展示用）：阿发价（小单位）= salesPrice(件价) ÷ unitFactor(一件多少瓶/罐)，保留两位小数四舍五入。
 *   例：salesPrice=42、unitFactor=24 → 42/24 = 1.75 元/罐。件价另附展示。
 *
 * ⚠ 本项目当前只做「Token 配置」不做「登录/解绑」：小程序本身无退出按钮，登录态过期后用户重新粘贴 Token 即可，
 *   不需要服务器代发登录请求，也不碰远端解绑。
 */
const db = require('../db');
const priceCache = require('./price-cache');

const BASE = 'https://bluespace-plus.zhoupudata.com';
const APP_ID = 'wxc050ff76c31c4371';   // 永源顺城配速达小程序 appId（固定）
const APP_VERSION = '5.62.7';

class AfaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AfaError';
    this.code = code || 'unknown'; // no_session | auth | network | upstream
  }
}

/** 城配速达返回的「未登录 / token 失效」类提示 */
const AUTH_HINTS = ['登录', '未登录', '失效', '过期', 'token', '请先登录', '授权', 'auth'];

function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

/** 单价（小单位）= salesPrice ÷ unitFactor（两位小数四舍五入） */
function unitPriceOf(salesPrice, unitFactor) {
  const a = Number(salesPrice);
  const b = Number(unitFactor);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return round2(a / b);
}

/** 解码 JWT payload（只取 mid 等非敏感字段；不校验签名，仅解析） */
function decodeJwtPayload(token) {
  try {
    const raw = String(token || '').trim();
    const b64 = raw.replace(/^Bearer\s+/i, '').split('.')[1];
    if (!b64) return null;
    const json = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) { return null; }
}

/** 规整 token：去掉可能的 Bearer 前缀，返回纯 JWT（api() 会统一加回 Bearer） */
function normalizeToken(token) {
  return String(token == null ? '' : token).trim().replace(/^Bearer\s+/i, '');
}

async function readSession(userId) {
  const rows = await db.query(
    'SELECT afa_token, afa_store_id, afa_app_id FROM app_user WHERE id = ?', [Number(userId) || 0]
  ).catch(() => []);
  const r = rows && rows[0];
  const token = normalizeToken((r && r.afa_token) || '');
  if (!token) throw new AfaError('还没有配置阿发Token（请先粘贴城配速达小程序的 authorization 值）', 'no_session');
  const payload = decodeJwtPayload(token);
  const mid = payload && Number(payload.mid);
  const storeId = String((r && r.afa_store_id) || '').trim();
  if (!storeId) throw new AfaError('已配置 Token 但缺少门店 storeId，请在「配置阿发Token」里补上', 'no_session');
  const appId = String((r && r.afa_app_id) || '').trim() || APP_ID;
  return { token, mid: mid || null, storeId, appId };
}

/**
 * 统一请求：带城配速达要求的全部请求头；识别登录态失效 / 上游错误。
 * @param {object} [opt.sess]  { token, mid, storeId, appId }
 * @param {object} [opt.body]  POST 时的请求体（会与公共参数合并）
 * @param {boolean} [opt.rawJson] true 时把完整 JSON 一并返回
 */
async function api(pathname, { method = 'GET', body = null, sess, rawJson = false } = {}) {
  const token = 'Bearer ' + sess.token;
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: token,
    version: '6',
    storeid: String(sess.storeId),
    mid: String(sess.mid == null ? '' : sess.mid),
    xweb_xhr: '1',
    // 小程序环境 UA（部分接口按 UA 放行）
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
      + 'MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) '
      + 'UnifiedPCWindowsWechat(0xf2541f38) XWEB/25819',
    referer: 'https://servicewechat.com/' + sess.appId + '/6/page-frame.html',
  };

  let url = pathname;
  const opts = { method, headers, signal: AbortSignal.timeout(20000) };
  if (method === 'GET') {
    const qs = new URLSearchParams({
      mid: String(sess.mid == null ? '' : sess.mid),
      storeId: String(sess.storeId),
      appId: sess.appId,
      appVersion: APP_VERSION,
    });
    url = pathname + (pathname.includes('?') ? '&' : '?') + qs.toString();
  } else {
    const base = {
      mid: Number(sess.mid) || 0,
      storeId: Number(sess.storeId),
      appId: sess.appId,
      appVersion: APP_VERSION,
    };
    opts.body = JSON.stringify(Object.assign(base, body || {}));
  }

  let res;
  try {
    res = await fetch(BASE + url, opts);
  } catch (e) {
    throw new AfaError('连接城配速达失败：' + String((e && e.message) || e).slice(0, 120), 'network');
  }
  const text = await res.text().catch(() => '');
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }

  if (!res.ok) {
    const msg = (j && (j.msg || j.message)) || ('HTTP ' + res.status);
    const isAuth = AUTH_HINTS.some((h) => msg.indexOf(h) >= 0) || res.status === 401 || res.status === 403;
    throw new AfaError('城配速达接口' + msg + (isAuth ? '（Token 可能已过期，请重新配置）' : ''), isAuth ? 'auth' : 'upstream');
  }
  if (j && j.code !== 0 && j.code !== undefined) {
    const msg = String(j.msg || j.message || '接口返回失败');
    const isAuth = AUTH_HINTS.some((h) => msg.indexOf(h) >= 0);
    throw new AfaError(msg + (isAuth ? '（Token 可能已过期，请重新配置）' : ''), isAuth ? 'auth' : 'upstream');
  }
  if (rawJson) return { data: (j && j.data) || {}, json: j || {} };
  return { data: (j && j.data) || {} };
}

/** 登录态概况（不返回完整 token，只给前后各 4 位） */
async function sessionStatus(userId) {
  const rows = await db.query(
    'SELECT afa_token, afa_store_id, afa_app_id FROM app_user WHERE id = ?', [Number(userId) || 0]
  ).catch(() => []);
  const r = rows && rows[0];
  const token = normalizeToken((r && r.afa_token) || '');
  const payload = decodeJwtPayload(token);
  const masked = token.length > 8 ? (token.slice(0, 4) + '…' + token.slice(-4)) : (token ? '****' : '');
  return {
    configured: !!token,
    tokenMasked: masked,
    mid: payload && payload.mid ? Number(payload.mid) : null,
    storeId: String((r && r.afa_store_id) || '').trim(),
    appId: String((r && r.afa_app_id) || '').trim() || APP_ID,
  };
}

/** 保存配置（用户自己粘贴 Token + 门店/小程序参数） */
async function saveSession(userId, { token, storeId, appId } = {}) {
  const t = normalizeToken(token);
  const sid = String(storeId == null ? '' : storeId).trim();
  const aid = String(appId == null ? '' : appId).trim();
  await db.exec('UPDATE app_user SET afa_token = ?, afa_store_id = ?, afa_app_id = ? WHERE id = ?',
    [t || null, sid || null, aid || null, Number(userId) || 0]);
  return { ok: true, ...(await sessionStatus(userId)) };
}

/** 清掉库里的城配速达登录态（清除按钮用） */
async function clearSession(userId) {
  await db.exec('UPDATE app_user SET afa_token = NULL, afa_store_id = NULL, afa_app_id = NULL WHERE id = ?',
    [Number(userId) || 0]);
  return { ok: true, ...(await sessionStatus(userId)) };
}

/** 把搜索/详情返回的商品规整成统一结构 */
function shape(g, { fromDetail = false } = {}) {
  const u = (g.unitList && g.unitList[0]) || {};
  const factor = Number(g.unitFactor) || Number(u.unitFactor) || 0;
  const factorName = String(g.showUnitFactorName || (u.unitName ? (factor + u.unitName + '/件') : ''));
  const salesPrice = Number(fromDetail ? g.salesPrice : g.salesPrice);
  return {
    goodsId: g.id == null ? g.goodsId : g.id,
    goodsName: String(g.name || ''),
    salePrice: salesPrice,
    unitFactor: factor,
    unitPrice: unitPriceOf(salesPrice, factor),
    factorName,
    picture: String(g.pictureUrl || (g.pictureUrls && g.pictureUrls[0]) || ''),
    // 条码：不同接口版本字段名不一，取到哪个用哪个（有则给匹配做一票命中，没有也不影响）
    barcode: String(g.barCode || g.barcode || g.upc || g.goodsCode || ''),
  };
}

/** 商品搜索（关联弹窗用）：返回图片 + 名称 + 件价 + 折合单价 */
async function searchGoods(userId, keyword, { pageNum = 1, pageSize = 20 } = {}) {
  const sess = await readSession(userId);
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) throw new AfaError('请输入搜索关键词', 'upstream');
  const { data } = await api('/miniapp/goods/search', {
    method: 'POST',
    sess,
    body: {
      current: Math.max(1, Number(pageNum) || 1),
      size: Math.min(100, Math.max(1, Number(pageSize) || 20)),
      searchText: kw, tagIds: [], thirdIds: [], orderBy: '', orderType: '', seriesSearchFlag: 0, typeChain: '|0|',
    },
  });
  const list = (data && data.records) || [];
  return {
    rows: list.map((o) => shape(o)),
    total: Number(data.total) || list.length,
    pageNum: Number(data.current) || 1,
    pages: Number(data.pages) || 1,
  };
}

/**
 * 关键词候选池（自动匹配用）：同一关键词连续翻几页，按 goodsId 去重。
 * 阿发没有「全量商品列表」接口，只能用品牌词搜索近似当候选池。
 */
async function searchPool(userId, keyword, { pages = 2, size = 50 } = {}) {
  const all = [];
  const seen = new Set();
  let total = 0;
  let pageCount = 0;
  for (let p = 1; p <= Math.max(1, Number(pages) || 1); p++) {
    const r = await searchGoods(userId, keyword, { pageNum: p, pageSize: size });
    pageCount = r.pages || pageCount;
    total = r.total || total;
    for (const o of r.rows) {
      const id = String(o.goodsId == null ? '' : o.goodsId);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(o);
    }
    if (p >= (r.pages || 1)) break;
    if (r.rows.length < size) break;
  }
  return { rows: all, total, pages: pageCount };
}

/**
 * 批量取价（v0.2.94：带价格缓存）
 *   mode='cache'   只读库（列表加载用，**不打平台**）；没缓存的商品直接不返回，页面显示「未取价」。
 *   mode='refresh' 强制去平台取新价并写库（点「阿发重新取价」用）。默认 refresh，保持老行为。
 * brandId 参与缓存键：同品牌方共用一份价格（不同品牌方的协议价可能不同）。
 */
async function pricesByGoodsIds(userId, goodsIds, { brandId = 0, mode = 'refresh' } = {}) {
  const ids = (goodsIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const uniq = [...new Set(ids)];
  if (!uniq.length) return { prices: {}, cached: 0, fetched: 0 };
  if (String(mode).toLowerCase() === 'cache') {
    const hit = await priceCache.readPrices('afa', brandId, uniq).catch(() => ({}));
    return { prices: hit, cached: Object.keys(hit).length, fetched: 0 };
  }
  const sess = await readSession(userId);
  const out = {};
  // 并发限流：一次最多 5 个，避免把对方接口打挂
  for (let i = 0; i < uniq.length; i += 5) {
    const part = uniq.slice(i, i + 5);
    const rs = await Promise.all(part.map(async (id) => {
      try {
        const { data } = await api('/miniapp/goods/query-detail-info?goodsId=' + id + '&includeStock=false', { sess });
        const o = data || {};
        const s = shape(o, { fromDetail: true });
        return [id, { ok: true, ...s }];
      } catch (e) {
        return [id, { ok: false, error: String((e && e.message) || e).slice(0, 160) }];
      }
    }));
    for (const [id, v] of rs) out[String(id)] = v;
  }
  // 取到就落库：下次查询优先读库（失败项由 savePrices 自动跳过，不会覆盖上一次的好价）
  let saved = 0;
  try { saved = await priceCache.savePrices('afa', brandId, out); } catch (e) { saved = 0; }
  // 回填取价时间：页面「缓存于 …」立刻能看到，不用等下次读库
  const stamp = priceCache.fmtTime(new Date());
  for (const k of Object.keys(out)) { if (out[k] && out[k].ok) out[k].fetchedAt = stamp; }
  return { prices: out, cached: 0, fetched: Object.keys(out).filter((k) => out[k] && out[k].ok).length, saved };
}

/**
 * 加入购物车（真实动作：会在用户自己的城配速达账号里加一件商品）
 * goodsId=城配速达商品ID；qty=采购数量（件）；unitId 默认 P2（件）
 */
async function addToCart(userId, { goodsId, qty, unitId } = {}) {
  const sess = await readSession(userId);
  const gid = Number(goodsId);
  const cnt = Number(qty);
  if (!Number.isFinite(gid) || gid <= 0) throw new AfaError('商品ID不合法', 'upstream');
  if (!Number.isFinite(cnt) || cnt <= 0) throw new AfaError('采购数量必须是大于 0 的整数', 'upstream');
  const { data } = await api('/miniapp/shopping-cart/update', {
    method: 'POST',
    sess,
    body: { goodsList: [{ goodsId: gid, unitId: String(unitId || 'P2'), quantity: Math.trunc(cnt) }] },
  });
  return { ok: true, goodsId: gid, qty: Math.trunc(cnt), data };
}

module.exports = {
  AfaError, unitPriceOf,
  sessionStatus, saveSession, clearSession,
  searchGoods, searchPool, pricesByGoodsIds, addToCart,
};
