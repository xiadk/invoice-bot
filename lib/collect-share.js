/**
 * lib/collect-share.js — 「拼多多人工催收」二维码分享令牌（v0.3.38）
 *
 * 场景：电脑上点某个商家的二维码，手机扫码打开一个可编辑的催收话术页。
 * 扫码的多半是老板/业务员本人的手机，未必在这台手机上登录过看板，
 * 所以不能要求登录；但也不能把「谁的订单」暴露成裸 ID。
 *
 * 方案：无状态签名令牌（与登录 cookie 同一套 HMAC 与密钥）。
 *   token = base64url({ u: 用户id, k: 商家分组键, e: 过期时间戳 }) + '.' + HMAC-SHA256
 *   · 不建表、不落库 —— 项目里已经有 waybill_upload_token 这种「一次性令牌表」，
 *     但那是要记录「传了几张图」的有状态场景；催收只是只读展示，签名就够。
 *   · 默认 7 天：老板周末在家扫码也能打开；过期后重新点二维码即可生成新的。
 *   · 校验失败/过期一律返回 null，调用方按「链接已失效」处理，不回显任何原因。
 */
const crypto = require('crypto');
const { sessionSecret } = require('./auth');

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const PREFIX = 'pc1';   // 令牌版本前缀：将来换算法时可据此区分

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

/** 签发：userId + 商家分组键（pdd 的 'm<mallId>' / 'n<店铺名哈希>' / 's<mallSn>' / 'u'） */
function createCollectToken(opts = {}) {
  const uid = Number(opts.userId) || 0;
  const key = String(opts.key || '');
  if (!uid || !key) throw new Error('缺少 userId 或商家键');
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  const payload = b64u(JSON.stringify({ u: uid, k: key, e: Date.now() + ttl }));
  return { token: PREFIX + '.' + payload + '.' + sign(payload), exp: Date.now() + ttl, ttlMs: ttl };
}

/** 校验：返回 { u, k, e } 或 null（签名不对 / 过期 / 格式不对） */
function verifyCollectToken(token) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, sig] = parts;
  const expect = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj = null;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')); } catch (e) { return null; }
  if (!obj || !obj.u || !obj.k || !obj.e) return null;
  if (Date.now() > Number(obj.e)) return null;
  return { u: Number(obj.u), k: String(obj.k), e: Number(obj.e) };
}

module.exports = { createCollectToken, verifyCollectToken, DEFAULT_TTL_MS };
