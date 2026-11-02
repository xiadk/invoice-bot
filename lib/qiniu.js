/**
 * lib/qiniu.js — 七牛云存储（售后凭证图片）
 *
 * 为什么走服务端中转：
 *   AK/SK 只存在 config.json（该文件不入库），永不下发浏览器。浏览器把图片 POST 给本服务，
 *   本服务用 AK/SK 签上传凭证再转到七牛，拿回对象 key 存库；展示时现签一个临时链接。
 *
 * ⚠ 私有空间的下载链接（2026-11-02 实测踩过，别再改回去）：
 *   签名串必须是**完整 URL 到 ?e=<deadline>**（含 http://域名/key），
 *   只签「/key?e=xxx」会被七牛回 401 {"error":"download token auth failed"}。
 *   这和部分文档里「签 path」的说法不一致，以实测为准（与官方 Node SDK 7.x 的
 *   BucketManager.privateDownloadUrl 实现一致）。
 *
 * ⚠ 域名用 http：qiniu.xiadk.pw 的边缘证书不含该域名（证书里是别家 CDN 的域名），
 *   https 会直接 TLS 报错 ERR_TLS_CERT_ALTNAME_INVALID，所以 config 里 domain 写 http:// 开头。
 *   将来若迁到 https 部署，需先给该域名配好七牛证书，否则浏览器会按混合内容拦掉。
 *
 * 配置（config.json 的 qiniu 段，缺省时功能整体不可用，接口会明确报错）：
 *   { "accessKey": "...", "secretKey": "...", "bucket": "invoice-bot",
 *     "domain": "http://qiniu.xiadk.pw", "region": "华南",
 *     "uploadHost": "https://upload-z2.qiniup.com", "expireSec": 3600 }
 *   uploadHost 可留空，按 region 推断；还可用环境变量 QINIU_UPLOAD_HOST 覆盖（隔离测试用）。
 */
const crypto = require('crypto');
const { loadConfig } = require('./config');

/** 上传域名：按空间所在区域对应，配错时依次重试 */
const REGION_HOSTS = {
  华东: 'https://upload.qiniup.com',
  华东2: 'https://upload-cn-east-2.qiniup.com',
  华北: 'https://upload-z1.qiniup.com',
  华南: 'https://upload-z2.qiniup.com',
  北美: 'https://upload-na0.qiniup.com',
  东南亚: 'https://upload-as0.qiniup.com',
};
const ALL_HOSTS = Object.values(REGION_HOSTS);

const MAX_BYTES = 5 * 1024 * 1024;           // 单张上限 5MB（前端也拦一次）
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

let _cache = null;      // { at, conf }
const CACHE_MS = 60 * 1000;

function conf(force) {
  if (!force && _cache && Date.now() - _cache.at < CACHE_MS) return _cache.conf;
  const c = (loadConfig() || {}).qiniu || {};
  const region = String(c.region || '华南').trim();
  const hosts = [];
  const envHost = String(process.env.QINIU_UPLOAD_HOST || '').trim();
  const confHost = String(c.uploadHost || '').trim();
  if (envHost) hosts.push(envHost);
  if (confHost) hosts.push(confHost);
  if (REGION_HOSTS[region]) hosts.push(REGION_HOSTS[region]);
  for (const h of ALL_HOSTS) if (!hosts.includes(h)) hosts.push(h);
  const out = {
    accessKey: String(c.accessKey || '').trim(),
    secretKey: String(c.secretKey || '').trim(),
    bucket: String(c.bucket || '').trim(),
    domain: String(c.domain || '').trim().replace(/\/+$/, ''),
    region,
    hosts,
    expireSec: Math.max(60, Number(c.expireSec) || 3600),
  };
  out.enabled = !!(out.accessKey && out.secretKey && out.bucket && out.domain);
  _cache = { at: Date.now(), conf: out };
  return out;
}

const isEnabled = () => conf().enabled;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** 上传凭证（管理凭证之外的另一种：直传用的 uploadToken） */
function uploadToken({ scope, deadline }) {
  const c = conf();
  const encoded = b64url(JSON.stringify({ scope, deadline }));
  const sign = b64url(crypto.createHmac('sha1', c.secretKey).update(encoded).digest());
  return c.accessKey + ':' + sign + ':' + encoded;
}

/** 随机后缀，避免同毫秒同名覆盖 */
function rand(n) {
  return crypto.randomBytes(8).toString('hex').slice(0, n || 8);
}

/**
 * 上传一张图片到七牛（服务端中转）
 * @param {Buffer} buffer 图片二进制
 * @param {object} opt { mime, userId, prefix }
 * @returns {Promise<{ok:boolean, key?:string, size?:number, mime?:string, error?:string}>}
 */
async function uploadImage(buffer, opt = {}) {
  const c = conf();
  if (!c.enabled) return { ok: false, error: '服务端还没配置七牛（config.json 的 qiniu 段），暂时不能上传图片' };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: '图片内容为空' };
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: '图片超过 5MB（' + (buffer.length / 1048576).toFixed(1) + 'MB），请压缩后再传' };
  }

  const mime = String(opt.mime || '').toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) return { ok: false, error: '只支持 png / jpg / webp / gif 图片（当前 ' + (mime || '未知类型') + '）' };

  const now = new Date();
  const ym = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0');
  const key = (opt.prefix || 'after-sale') + '/' + ym + '/'
    + (opt.userId ? 'u' + opt.userId + '-' : '') + Date.now() + '-' + rand(6) + '.' + ext;

  const token = uploadToken({ scope: c.bucket + ':' + key, deadline: Math.floor(Date.now() / 1000) + 3600 });
  const errors = [];
  for (const host of c.hosts) {
    try {
      const fd = new FormData();
      fd.append('token', token);
      fd.append('key', key);
      fd.append('file', new Blob([buffer], { type: mime }), 'a.' + ext);
      const r = await fetch(host.replace(/\/+$/, '') + '/', {
        method: 'POST', body: fd, signal: AbortSignal.timeout(30000),
      });
      const txt = await r.text();
      if (r.ok && txt.indexOf('"key"') >= 0) {
        return { ok: true, key, size: buffer.length, mime };
      }
      errors.push(host + ' → ' + r.status + ' ' + txt.slice(0, 120));
      // 明确是凭证/空间问题就别再换域名了（换域名也救不了）
      if (r.status === 401 || r.status === 403 || r.status === 400) break;
    } catch (e) {
      errors.push(host + ' → ' + String((e && e.message) || e));
    }
  }
  return { ok: false, error: '上传七牛失败：' + (errors[errors.length - 1] || '未知原因') };
}

/**
 * 私有空间的临时下载链接
 * @param {string} key 对象 key（不含域名）
 * @param {number} [expireSec] 有效期秒数，默认取配置
 */
function signUrl(key, expireSec) {
  const c = conf();
  const k = String(key || '').trim();
  if (!k) return '';
  if (!c.enabled) return '';
  const ttl = Math.max(60, Number(expireSec) || c.expireSec);
  const deadline = Math.floor(Date.now() / 1000) + ttl;
  const base = c.domain + '/' + encodeURI(k) + '?e=' + deadline;
  const sign = b64url(crypto.createHmac('sha1', c.secretKey).update(base).digest());
  return base + '&token=' + c.accessKey + ':' + sign;
}

/** 浏览器上传时附带的类型兜底：dataURL 里没写 mime 时按扩展名猜 */
function mimeOfName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  const ext = (m ? m[1] : '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return '';
}

/**
 * 解析浏览器发来的 dataURL（data:image/png;base64,xxxx）
 * 返回 { ok, buffer, mime } 或 { ok:false, error }；类型/大小都在这层拦一次，
 * 免得把 20MB 的图先塞进内存再发现是 .pdf 改后缀。
 */
function decodeImagePayload(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: '请先上传售后凭证图片（每次变更处理状态都要留一张）' };
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(s);
  if (!m) return { ok: false, error: '图片格式不对：需要 dataURL（data:image/png;base64,…）' };
  const mime = String(m[1] || '').toLowerCase();
  if (!MIME_EXT[mime]) return { ok: false, error: '只支持 png / jpg / webp / gif 图片（当前 ' + mime + '）' };
  let buffer;
  try {
    buffer = Buffer.from(m[2], 'base64');
  } catch (e) {
    return { ok: false, error: '图片数据解析失败' };
  }
  if (!buffer.length) return { ok: false, error: '图片内容为空' };
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: '图片超过 5MB（' + (buffer.length / 1048576).toFixed(1) + 'MB），请压缩后再传' };
  }
  return { ok: true, buffer, mime };
}

module.exports = {
  isEnabled, conf, uploadImage, signUrl, mimeOfName, decodeImagePayload,
  MAX_BYTES, MIME_EXT, REGION_HOSTS,
};
