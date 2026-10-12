/**
 * lib/auth.js — 账号密码与会话（多用户 / 超级管理员）
 *
 * 设计要点：
 *   · 密码用 Node 内置 scrypt 加盐哈希（无需 bcrypt 等原生依赖，Windows / Docker 均可跑）
 *        存储格式： scrypt:<盐(hex)>:<哈希(hex)>
 *   · 会话用「签名 cookie」承载，服务端无状态（不需要额外存储）：
 *        cookie 值 = base64url(payload) + '.' + HMAC-SHA256(payload, secret)
 *        payload   = { u: 用户ID, v: 会话版本(token_version), e: 过期时间戳(ms) }
 *      改密 / 禁用账号时把 app_user.token_version +1，此前签发的所有会话立即失效。
 *   · 签名密钥优先取环境变量 SESSION_SECRET；否则首次运行时随机生成并写入
 *        data/.session-secret（已在 .gitignore 排除，不进仓库）。
 *
 * 本文件不直接访问数据库，保持纯函数，便于复用与测试。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SECRET_FILE = path.join(ROOT, 'data', '.session-secret');

const COOKIE_NAME = 'ib_sid';
const DEFAULT_TTL_HOURS = 24 * 7; // 7 天

// ── 签名密钥 ──
let _secret = null;
function sessionSecret() {
  if (_secret) return _secret;
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()) {
    _secret = process.env.SESSION_SECRET.trim();
    return _secret;
  }
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
      if (s) { _secret = s; return _secret; }
    }
  } catch (e) { /* 忽略，走随机生成 */ }
  _secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, _secret, { mode: 0o600 });
  } catch (e) { /* 只读文件系统（如容器只读层）时退化为进程内随机密钥 */ }
  return _secret;
}

// ── 密码 ──
/** 生成密码哈希（scrypt + 随机盐） */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/** 校验密码（时间安全比较） */
function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  let calc;
  try { calc = crypto.scryptSync(String(plain), salt, 64).toString('hex'); } catch (e) { return false; }
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── 会话 token ──
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sessionTtlMs() {
  const h = Number(process.env.SESSION_TTL_HOURS);
  return (h > 0 ? h : DEFAULT_TTL_HOURS) * 3600 * 1000;
}

/** 为某用户签发会话 token */
function createSessionToken(user, ttlMs) {
  const payload = b64u(JSON.stringify({
    u: user.id,
    v: Number(user.token_version) || 1,
    e: Date.now() + (ttlMs || sessionTtlMs()),
  }));
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** 校验会话 token：返回 { u, v, e } 或 null（签名错误 / 过期） */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')); } catch (e) { return null; }
  if (!obj || !obj.u || !obj.e || Date.now() > Number(obj.e)) return null;
  return obj;
}

// ── Cookie 工具 ──
/** 解析 Cookie 头为对象 */
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

/** 组装 Set-Cookie 字符串 */
function buildCookie(name, value, opts) {
  const o = opts || {};
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path || '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAge)}`);
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 下发会话 cookie */
function setSessionCookie(res, token, req) {
  const secure = isSecureRequest(req);
  res.setHeader('Set-Cookie', buildCookie(COOKIE_NAME, token, { maxAge: sessionTtlMs() / 1000, secure }));
}

/** 清除会话 cookie */
function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', buildCookie(COOKIE_NAME, '', { maxAge: 0, secure: isSecureRequest(req) }));
}

/** 判断请求是否走 HTTPS（用于 Secure 标记；云上通常挂在反代后面） */
function isSecureRequest(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (process.env.COOKIE_SECURE === '0') return false;
  const proto = req && req.headers && (req.headers['x-forwarded-proto'] || '');
  return String(proto).split(',')[0].trim() === 'https';
}

/** 从请求中取出会话 token 并校验（返回 { u, v, e } 或 null） */
function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  buildCookie,
  setSessionCookie,
  clearSessionCookie,
  sessionFromRequest,
  sessionSecret,
  sessionTtlMs,
};
