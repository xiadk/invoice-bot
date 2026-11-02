/**
 * CLIP 图文 embedding（Xenova/clip-vit-base-patch32 · ONNX 本地推理）
 *
 * 设计要点（都是踩过坑才这么写的）：
 *   1. **模型全局只加载一次**：模块级 Promise 缓存，多次调用共用同一份 ONNX session。
 *      已缓存模型二次加载约 600ms；首次要下载（quantized 约 60MB，实测 56s）。
 *   2. **模型来源可换**：huggingface.co 在国内直连不通（实测 10s 超时），默认走 hf-mirror.com；
 *      可用环境变量 CLIP_REMOTE_HOST 覆盖，或把模型文件直接放进 data/models 离线用。
 *   3. **依赖缺失不能拖垮服务**：@xenova/transformers / sharp 都是延迟 require + try/catch，
 *      装不上时 isAvailable() 返回 false，上层走「回退名称首条」降级，server.js 照常启动。
 *   4. **sharp 只做预处理**：转正方向 → 等比裁到 224×224 → 去 alpha → sRGB → raw 像素。
 *      CLIP 模型本身不动，只取 embedding。
 *   5. **两级图片缓存**：同 URL 的图片先查内存 LRU，再查磁盘缓存（data/clip-img-cache），
 *      避免同一张候选图在多个商品之间重复下载、重复解码。
 *
 * 对外接口：
 *   isAvailable()                 依赖是否可用（不抛错）
 *   ensureModels(onLog)           加载模型（全局一次），返回 { modelId, loadMs }
 *   imageEmbed(input, onLog)      input = http(s) URL / 本地路径 / Buffer → Float32Array(512)
 *   cosine(a, b)                  余弦相似度
 *   warmup()                      预热（服务启动后可选调用）
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MODEL_ID = process.env.CLIP_MODEL_ID || 'Xenova/clip-vit-base-patch32';
// 默认 hf-mirror：huggingface.co 直连在本机实测超时；镜像可达（307 重定向到 CDN）
const REMOTE_HOST = process.env.CLIP_REMOTE_HOST || 'https://hf-mirror.com';
const MODEL_DIR = process.env.CLIP_MODEL_DIR || path.join(ROOT, 'data', 'models');
const IMG_CACHE_DIR = path.join(ROOT, 'data', 'clip-img-cache');
const IMG_TIMEOUT_MS = Number(process.env.CLIP_IMG_TIMEOUT_MS) || 12000;
const MEM_LRU_MAX = 800;         // 内存里最多存多少条图片向量
const IMG_DISK_MAX = 3000;       // 磁盘缓存最多保留多少张图（超出按时间淘汰）

// ── 依赖延迟加载（缺失时服务仍能启动）────────────────────────────────────────
let tf = null;
let sharpLib = null;
let depError = '';
try {
  tf = require('@xenova/transformers');
} catch (e) {
  depError = '未安装 @xenova/transformers：' + String((e && e.message) || e).slice(0, 160);
}
try {
  sharpLib = require('sharp');
} catch (e) {
  if (!depError) depError = '未安装 sharp：' + String((e && e.message) || e).slice(0, 160);
}

/** 依赖是否齐备（缺失只影响自动匹配的精度，不影响其它功能） */
function isAvailable() {
  return !!(tf && sharpLib);
}

/** 依赖缺失原因（给页面/日志用） */
function unavailableReason() {
  return depError;
}

// ── 模型单例 ─────────────────────────────────────────────────────────────────
let readyPromise = null;
let modelInfo = { modelId: MODEL_ID, loadMs: 0, loadedAt: null, quantized: true, remoteHost: REMOTE_HOST };
let processor = null;
let visionModel = null;

/**
 * 加载模型（全局一次）。并发调用共用同一个 Promise，不会重复初始化 ONNX session。
 * @param {(msg:string)=>void} [onLog] 进度日志（首次要下载模型，能等很久）
 */
function ensureModels(onLog) {
  if (!readyPromise) {
    readyPromise = initModels(onLog).catch((e) => {
      readyPromise = null;      // 失败允许下次重试（比如网络恢复后）
      throw e;
    });
  }
  return readyPromise;
}

async function initModels(onLog) {
  if (!isAvailable()) throw new Error(unavailableReason());
  const log = typeof onLog === 'function' ? onLog : () => {};
  const t0 = Date.now();
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  // 模型来源：镜像优先（allowRemoteModels），同时允许本地目录直读（离线部署）
  tf.env.remoteHost = REMOTE_HOST;
  tf.env.remotePathTemplate = '{model}/resolve/{revision}/{file}';
  tf.env.cacheDir = MODEL_DIR;
  tf.env.allowRemoteModels = true;
  tf.env.allowLocalModels = true;
  // ONNX 线程数：留一个核给 HTTP 服务，别把机器吃满
  try {
    const os = require('os');
    tf.env.backends.onnx.numThreads = Math.max(1, Math.min(4, (os.cpus() || []).length - 1));
  } catch (e) { /* 老版本没有这个开关，忽略 */ }

  const opts = {
    quantized: true,   // 量化版：视觉 ~22MB、文本 ~16MB，实测精度够用且快一倍
    progress_callback: (p) => {
      if (p && p.status === 'progress' && p.file) {
        log(`下载模型 ${p.file} ${Math.round(p.progress || 0)}%`);
      }
    },
  };

  log('正在加载 CLIP 模型（首次需下载，约 1 分钟）…');
  processor = await tf.AutoProcessor.from_pretrained(MODEL_ID, opts);
  visionModel = await tf.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, opts);

  modelInfo = { ...modelInfo, loadMs: Date.now() - t0, loadedAt: new Date().toISOString() };
  log(`CLIP 模型就绪（${modelInfo.loadMs}ms）`);
  return modelInfo;
}

/** 已加载的模型信息（页面显示「模型就绪 597ms」之类） */
function info() {
  return { ...modelInfo, available: isAvailable(), ready: !!readyPromise };
}

// ── 图片读取与预处理 ─────────────────────────────────────────────────────────
const isHttp = (s) => /^https?:\/\//i.test(String(s || ''));
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

function imgCachePath(key) {
  return path.join(IMG_CACHE_DIR, key.slice(0, 2), key + '.bin');
}

/** 读图片字节：URL 走网络（带磁盘缓存），本地路径直接读 */
async function readImageBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  const src = String(input || '').trim();
  if (!src) throw new Error('图片地址为空');

  if (!isHttp(src)) {
    if (!fs.existsSync(src)) throw new Error('图片文件不存在：' + src);
    return fs.readFileSync(src);
  }

  const key = sha1(src);
  const cached = imgCachePath(key);
  if (fs.existsSync(cached)) {
    try { return fs.readFileSync(cached); } catch (e) { /* 读失败就当没缓存 */ }
  }

  let res;
  try {
    res = await fetch(src, {
      // 商品图 CDN 对没有 UA 的请求偶发 403，带上常见 UA 更稳
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      signal: AbortSignal.timeout(IMG_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (e) {
    throw new Error('图片下载失败（' + String((e && e.message) || e).slice(0, 80) + '）：' + src.slice(0, 120));
  }
  if (!res.ok) throw new Error('图片下载失败 HTTP ' + res.status + '：' + src.slice(0, 120));
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('图片内容为空：' + src.slice(0, 120));

  // 写磁盘缓存（失败不影响主流程）
  try {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, buf);
    trimImageCache();
  } catch (e) { /* ignore */ }
  return buf;
}

/** 磁盘缓存淘汰：按 mtime 保留最近使用的一批，避免无限增长 */
let lastTrim = 0;
function trimImageCache() {
  if (Date.now() - lastTrim < 60 * 1000) return;
  lastTrim = Date.now();
  try {
    const all = [];
    for (const d of fs.readdirSync(IMG_CACHE_DIR)) {
      const dir = path.join(IMG_CACHE_DIR, d);
      let st;
      try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try { all.push({ p, m: fs.statSync(p).mtimeMs }); } catch (e) { /* ignore */ }
      }
    }
    if (all.length <= IMG_DISK_MAX) return;
    all.sort((a, b) => a.m - b.m);
    for (const x of all.slice(0, all.length - IMG_DISK_MAX)) {
      try { fs.unlinkSync(x.p); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

/** sharp 预处理：转正 → 等比裁 224×224 → 去 alpha → sRGB → raw 像素 */
async function toRawPixels(buf) {
  const { data, info: meta } = await sharpLib(buf)
    .rotate()                                     // 按 EXIF 转正，否则竖拍商品图会躺倒
    .resize(224, 224, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: meta.width, height: meta.height, channels: meta.channels };
}

// ── 图片向量 ─────────────────────────────────────────────────────────────────
const memLRU = new Map();   // url → Float32Array

/**
 * 图片 → 512 维向量
 * @param {string|Buffer} input http(s) URL / 本地路径 / Buffer
 * @param {(msg:string)=>void} [onLog]
 * @returns {Promise<Float32Array>}
 */
async function imageEmbed(input, onLog) {
  const key = Buffer.isBuffer(input) ? 'buf:' + sha1(input) : String(input || '');
  const hit = memLRU.get(key);
  if (hit) {
    // LRU 触碰：删了再塞回，保证顺序
    memLRU.delete(key); memLRU.set(key, hit);
    return hit;
  }
  await ensureModels(onLog);
  const bytes = await readImageBytes(input);
  const px = await toRawPixels(bytes);
  const inputs = await processor(new tf.RawImage(new Uint8ClampedArray(px.data), px.width, px.height, px.channels));
  const out = await visionModel(inputs);
  const vec = Float32Array.from(out.image_embeds.data);
  memLRU.set(key, vec);
  if (memLRU.size > MEM_LRU_MAX) memLRU.delete(memLRU.keys().next().value);
  return vec;
}

/** 余弦相似度（按未归一化向量计算，公式自带归一化） */
function cosine(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i]; const y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 预热：服务启动后调一次，把首次下载/初始化挪到空闲期（失败只记日志） */
async function warmup(onLog) {
  try {
    await ensureModels(onLog);
    return true;
  } catch (e) {
    if (typeof onLog === 'function') onLog('CLIP 预热失败：' + String((e && e.message) || e).slice(0, 160));
    return false;
  }
}

module.exports = {
  MODEL_ID, REMOTE_HOST, MODEL_DIR, IMG_CACHE_DIR,
  isAvailable, unavailableReason, ensureModels, info, imageEmbed, cosine, warmup,
  // 供测试/调试
  _internals: { readImageBytes, toRawPixels, sha1 },
};
