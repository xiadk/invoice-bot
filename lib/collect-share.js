/**
 * lib/collect-share.js — 「拼多多人工催收」二维码分享令牌（v0.3.38 / 令牌 v2 见 v0.3.40）
 *
 * 场景：电脑上点某个商家的二维码，手机扫码打开一个可编辑的催收话术页。
 * 扫码的多半是老板/业务员本人的手机，未必在这台手机上登录过看板，
 * 所以不能要求登录；但也不能把「谁的订单」暴露成裸 ID。
 *
 * 方案：无状态签名令牌（与登录 cookie 同一套 HMAC 与密钥）。
 *   v1（pc1）：base64url({u,k,e}) + 43 字符签名 —— 内容一长二维码版本就高，
 *              手机端扫码 + 电脑端生成都要多花几十毫秒，已停用（保留校验，老链接不作废）。
 *   v2（pc2）：base64url('uid|过期秒|商家键') + 128 bit 截断签名。
 *              同样信息从 98 字符压到 50 字符左右，二维码版本从 9 降到 5，
 *              生成耗时与 SVG 体积都少一半（见 v0.3.40 提交说明）。
 *   · 不建表、不落库 —— 项目里已经有 waybill_upload_token 这种「一次性令牌表」，
 *     但那是要记录「传了几张图」的有状态场景；催收只是只读展示，签名就够。
 *   · 默认 7 天：老板周末在家扫码也能打开；过期后重新点二维码即可生成新的。
 *   · 校验失败/过期一律返回 null，调用方按「链接已失效」处理，不回显任何原因。
 */
const crypto = require('crypto');
const { sessionSecret } = require('./auth');

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const PREFIX_V1 = 'pc1';
const PREFIX = 'pc2';
const SIG_BYTES = 16;   // 128 bit：对伪造而言远超需要，换来二维码少约 5 个模块

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signFull(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}
function signShort(payload) {
  return crypto.createHmac('sha256', sessionSecret())
    .update(payload).digest().subarray(0, SIG_BYTES).toString('base64url');
}
function sameSig(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 签发：userId + 商家分组键（pdd 的 'm<mallId>' / 'n<店铺名哈希>' / 's<mallSn>' / 'u'） */
function createCollectToken(opts = {}) {
  const uid = Number(opts.userId) || 0;
  const key = String(opts.key || '');
  if (!uid || !key) throw new Error('缺少 userId 或商家键');
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  // 过期时间用秒存：毫秒时间戳 13 位，秒 10 位，base64 后少 4 个字符，够用
  const expSec = Math.floor((Date.now() + ttl) / 1000);
  const payload = b64u(uid + '|' + expSec + '|' + key);
  return { token: PREFIX + '.' + payload + '.' + signShort(payload), exp: expSec * 1000, ttlMs: ttl };
}

/** 校验：返回 { u, k, e } 或 null（签名不对 / 过期 / 格式不对） */
function verifyCollectToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  if (parts[0] === PREFIX) return verifyV2(parts[1], parts[2]);
  if (parts[0] === PREFIX_V1) return verifyV1(parts[1], parts[2]);
  return null;
}

function verifyV2(payload, sig) {
  if (!sameSig(sig, signShort(payload))) return null;
  let s = '';
  try { s = Buffer.from(String(payload || ''), 'base64url').toString('utf-8'); } catch (e) { return null; }
  // 商家键放最后一段：万一里面自带 '|' 也只切前两个分隔符，不会把键截断
  const i1 = s.indexOf('|');
  const i2 = s.indexOf('|', i1 + 1);
  if (i1 <= 0 || i2 <= i1) return null;
  const u = Number(s.slice(0, i1));
  const e = Number(s.slice(i1 + 1, i2));
  const k = s.slice(i2 + 1);
  if (!u || !e || !k) return null;
  if (Date.now() > e * 1000) return null;
  return { u, k, e: e * 1000 };
}

function verifyV1(payload, sig) {
  if (!sameSig(sig, signFull(payload))) return null;
  let obj = null;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')); } catch (e) { return null; }
  if (!obj || !obj.u || !obj.k || !obj.e) return null;
  if (Date.now() > Number(obj.e)) return null;
  return { u: Number(obj.u), k: String(obj.k), e: Number(obj.e) };
}

module.exports = { createCollectToken, verifyCollectToken, DEFAULT_TTL_MS };
