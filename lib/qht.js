/**
 * 齐货通（new.szhsy123.cn）接口封装：商品搜索 / 商品详情取价 / 加入购物车。
 *
 * ⚠ 这些接口要求登录态（x-token + x-user），缺了会返回 HTTP 503「商城安全参数暂时不可用」。
 *   登录态由用户在「商品列表 → 补货」页粘贴自己的 x-token / x-user，存在 app_user 上（每人一份）。
 *   token 有有效期，过期后接口会变回 503，此时页面提示重新粘贴即可，不需要改代码。
 *
 * 单价口径（用户指定）：单价 = saleIP ÷ packingSpecification，保留两位小数四舍五入。
 *   saleIP = 一件的价格（大单位，如「件」）；packingSpecification = 一件有多少瓶/罐（如 24）。
 *   例：saleIP=21、packingSpecification=24 → 21/24 = 0.88 元/支
 */
const db = require('../db');

const BASE = 'https://new.szhsy123.cn';
const WX_ORIGIN = 'https://newwx.szhsy123.cn';

class QhtError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'QhtError';
    this.code = code || 'unknown'; // no_session | auth | network | upstream
  }
}

/** 齐货通返回的「安全参数不可用 / 登录态失效」提示 */
const AUTH_HINTS = ['安全参数', '未登录', '登录已失效', 'token', '请先登录'];

function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

/** 单价 = saleIP ÷ packingSpecification（两位小数四舍五入） */
function unitPriceOf(saleIP, packingSpecification) {
  const a = Number(saleIP);
  const b = Number(packingSpecification);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return round2(a / b);
}

async function readSession(userId) {
  const rows = await db.query(
    'SELECT qht_token, qht_x_user FROM app_user WHERE id = ?', [Number(userId) || 0]
  ).catch(() => []);
  const r = rows && rows[0];
  const token = String((r && r.qht_token) || '').trim();
  const xUser = String((r && r.qht_x_user) || '').trim();
  if (!token) throw new QhtError('还没有配置齐货通登录态（请先粘贴 x-token 和手机号）', 'no_session');
  return { token, xUser };
}

/** 统一请求：带齐货通要求的全部请求头；识别登录态失效 */
async function api(pathname, { method = 'GET', body = null, sess } = {}) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json;charset=UTF-8',
    origin: WX_ORIGIN,
    referer: WX_ORIGIN + '/',
    'x-domain': WX_ORIGIN + '/wx/hlccfwb2/#/goods/goodslist',
    // 齐货通按 UA 判定来源：小程序/微信内置浏览器的 UA 才能拿到「安全参数」
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
      + 'MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) '
      + 'UnifiedPCWindowsWechat(0xf2541f38) XWEB/25799 miniProgram/wx05c282d9f65fc853',
  };
  if (sess) {
    headers['x-token'] = sess.token;
    if (sess.xUser) headers['x-user'] = sess.xUser;
  }
  let res;
  try {
    res = await fetch(BASE + pathname, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new QhtError('连接齐货通失败：' + String((e && e.message) || e).slice(0, 120), 'network');
  }
  const text = await res.text().catch(() => '');
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* 非 JSON（如网关 503 页面） */ }

  // 503「商城安全参数暂时不可用」：登录态缺失或已过期
  if (!j && res.status === 503) {
    throw new QhtError('齐货通登录态无效或已过期（接口返回 503），请重新粘贴 x-token', 'auth');
  }
  if (j && j.meta && j.meta.success === false) {
    const msg = String(j.meta.message || '');
    const isAuth = AUTH_HINTS.some((h) => msg.indexOf(h) >= 0);
    throw new QhtError(
      (msg || '齐货通接口返回失败') + (isAuth ? '（登录态缺失或已过期，请重新粘贴 x-token）' : ''),
      isAuth ? 'auth' : 'upstream'
    );
  }
  if (!res.ok) {
    throw new QhtError('齐货通接口 HTTP ' + res.status, res.status === 503 ? 'auth' : 'upstream');
  }
  return { data: (j && j.data) || {}, meta: (j && j.meta) || {} };
}

/** 登录态概况（不返回完整 token，只给前后各 4 位） */
async function sessionStatus(userId) {
  const rows = await db.query(
    'SELECT qht_token, qht_x_user FROM app_user WHERE id = ?', [Number(userId) || 0]
  ).catch(() => []);
  const r = rows && rows[0];
  const token = String((r && r.qht_token) || '').trim();
  return {
    configured: !!token,
    xUser: String((r && r.qht_x_user) || ''),
    tokenMasked: token.length > 8 ? (token.slice(0, 4) + '…' + token.slice(-4)) : (token ? '****' : ''),
  };
}

/** 保存登录态（用户自己粘贴） */
async function saveSession(userId, { token, xUser }) {
  const t = String(token == null ? '' : token).trim();
  const u = String(xUser == null ? '' : xUser).trim();
  await db.exec('UPDATE app_user SET qht_token = ?, qht_x_user = ? WHERE id = ?',
    [t || null, u || null, Number(userId) || 0]);
  return { ok: true, ...(await sessionStatus(userId)) };
}

const pick = (o) => ({
  goodsId: o.goodsId == null ? o.id : o.goodsId,
  goodsName: String(o.goodsName || ''),
  picture: String(o.picture || ''),
  saleIP: Number(o.saleIP),
  packingSpecification: Number(o.packingSpecification),
  unitPrice: unitPriceOf(o.saleIP, o.packingSpecification),
  smallUnit: String(o.smallUnit || ''),
  largeUnit: String(o.largeUnit || ''),
  isHaveStock: Number(o.isHaveStock),
  statusName: String(o.statusName || ''),
});

/** 商品搜索（关联弹窗用）：返回图片 + 名称 + goodsId */
async function searchGoods(userId, keyword, { pageNum = 1, pageSize = 20 } = {}) {
  const sess = await readSession(userId);
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) throw new QhtError('请输入搜索关键词', 'upstream');
  const qs = new URLSearchParams({
    pageNum: String(Math.max(1, Number(pageNum) || 1)),
    pageSize: String(Math.min(50, Math.max(1, Number(pageSize) || 20))),
    keyword: kw,
    orderMode: '0', brandId: '0', countActivityId: '',
  });
  const { data } = await api('/mall/api/goods/mallGoods/page?' + qs.toString(), { sess });
  const list = data.list || data.rows || [];
  return {
    rows: list.map(pick),
    total: Number(data.total) || list.length,
    pageNum: Number(data.pageNum) || 1,
    pages: Number(data.pages) || 1,
  };
}

/** 批量取价：入参是齐货通商品ID（goodsId）数组 */
async function pricesByGoodsIds(userId, goodsIds) {
  const sess = await readSession(userId);
  const ids = (goodsIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
  const out = {};
  const uniq = [...new Set(ids)];
  // 并发限流：一次最多 5 个，避免把对方接口打挂
  for (let i = 0; i < uniq.length; i += 5) {
    const part = uniq.slice(i, i + 5);
    const rs = await Promise.all(part.map(async (id) => {
      try {
        const { data } = await api(`/mall/api/goods/mallGoods/${id}?id=${id}`, { sess });
        const o = (data && data.obj) || {};
        return [id, { ok: true, ...pick(o) }];
      } catch (e) {
        return [id, { ok: false, error: String((e && e.message) || e).slice(0, 160) }];
      }
    }));
    for (const [id, v] of rs) out[String(id)] = v;
  }
  return { prices: out };
}

/**
 * 加入购物车（真实动作：会在用户自己的齐货通账号里加一件商品）
 * goodsId=齐货通商品ID；ipcnt=采购数量；spcnt 固定 0（散装数量，本项目不用）
 */
async function addToCart(userId, { goodsId, ipcnt }) {
  const sess = await readSession(userId);
  const gid = Number(goodsId);
  const cnt = Number(ipcnt);
  if (!Number.isFinite(gid) || gid <= 0) throw new QhtError('商品ID不合法', 'upstream');
  if (!Number.isFinite(cnt) || cnt <= 0) throw new QhtError('采购数量必须是大于 0 的整数', 'upstream');
  const { data, meta } = await api('/mall/api/goods/carts', {
    method: 'POST',
    sess,
    body: { goodsId: gid, ipcnt: Math.trunc(cnt), spcnt: 0 },
  });
  return {
    ok: true,
    goodsId: gid,
    ipcnt: Math.trunc(cnt),
    message: String((meta && meta.message) || '已加入购物车'),
    data,
  };
}

module.exports = {
  QhtError, unitPriceOf,
  sessionStatus, saveSession,
  searchGoods, pricesByGoodsIds, addToCart,
};
