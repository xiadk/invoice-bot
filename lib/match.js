/**
 * 商品匹配（系统商品 ↔ 城配速达/阿发商品）
 *
 * 为什么需要单独一套：两边名称结构完全不同，直接字符串比对上不了。
 *   系统（牵牛花）  可口可乐 可乐型汽水碳酸饮料 330ml/罐 经典美味畅爽带劲竖罐装碳酸饮料（包装随机）
 *   阿发（城配速达） 可口可乐330L （矮罐）        ← 容量单位常写错（330L 实为 330ml），款式词用词也不一致
 *
 * 稳定锚点只有两个：**品牌** 和 **容量数字**；款式词（矮罐 / 竖罐装 / 摩登罐）两边对不上，
 * 所以排序主要靠「品牌+容量分桶 → 桶内图片 dHash + 文本相似度打分」。
 *
 * 对外接口：
 *   parseSpec(name)                     解析名称 → { brand, volNum, pack, style, series, norm }
 *   textSim(a, b)                       0~1 文本相似度（2-gram Jaccard）
 *   dhash(buffer)                       64 位感知哈希（BigInt）；非 JPEG 返回 null
 *   hashDistance(a, b)                  汉明距离
 *   imageHashOf(url)                    下载 + 哈希（带进程内缓存）
 *   guessKeyword(name)                  给阿发搜索用的关键词（品牌词）
 *   scoreCandidate(sys, cand, opt)      打分 → { score, reasons, hard, imageScore }
 *   rankCandidates(sys, cands, opt)     排序取 topN
 */
const jpeg = require('jpeg-js');

// ── 名称清洗 ────────────────────────────────────────────────────────────────
/** 营销词：对识别商品没用，只会把相似度拉低，比较前统一删掉 */
const NOISE = [
  '包装随机', '新老包装随机发货', '包装随机发货', '随机发货', '整箱', '新包装', '老包装',
  '经典美味', '畅爽带劲', '清爽解渴', '冰镇更佳', '家庭装', '分享装', '量贩装', '囤货装',
  '含糖', '不含糖', '饮料', '碳酸饮料', '汽水', '饮品', '正品', '包邮', '特价', '促销',
  '国产', '进口', '整件',
  // 形容词类：不删掉会被当成「品牌」，搜出来的候选池全是错的
  '升级加厚', '升级', '加厚', '新款', '全新', '特惠', '限量', '爆款', '网红', '便携',
];
const PACK_MAP = { 听: '罐', 罐: '罐', 瓶: '瓶', 箱: '箱', 包: '包', 袋: '袋', 桶: '桶', 盒: '盒', 杯: '杯', 支: '支', 条: '条' };
const STYLE_WORDS = ['矮罐', '摩登', '竖罐', '细长', '迷你', '大瓶', '小瓶', '易拉', '玻璃', '塑料', '胶瓶', '铝罐', '拉罐', '礼盒', '纤体'];
const SERIES_WORDS = ['零度', '无糖', '纤维', '香草', '樱桃', '柠檬', '冰爽', '健怡', '雪碧', '芬达', '气泡', '苏打', '咖啡', '茶'];

/** 全角转半角 + 小写 + 去营销词 */
function clean(name) {
  let s = String(name == null ? '' : name);
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/[()（）【】\[\]]/g, ' ')
    .replace(/[*×xX]\s*\d+\s*(罐|瓶|包|袋|盒|支)/g, ' ')  // 「×24罐」这类装箱数不算规格主线
    .toLowerCase();
  for (const w of NOISE) s = s.split(w).join(' ');
  return s.replace(/[，,。.、;；:：!！?？/\\|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 规范单位体积：330L 这种明显笔误按 ml 处理（330 升的汽水不存在） */
function normVolume(num, unit) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || '').toLowerCase();
  if (u === 'l' || u === '升') return n >= 100 ? n : n * 1000;   // 1.5L → 1500；330L → 330（笔误）
  if (u === 'kg' || u === '千克') return n * 1000;
  return n; // ml / 毫升 / g / 克 原样
}

/** 解析商品名：品牌 / 容量 / 包装 / 款式 / 系列 */
function parseSpec(name) {
  const raw = String(name == null ? '' : name);
  const norm = clean(raw);
  const flat = norm.replace(/\s+/g, '');
  // 款式/系列词在「未删营销词」的原串上找：像「竖罐装」会被 clean() 拆散，只有原串才认得出
  const rawFlat = raw
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[()（）【】\[\]，,。.、;；:：!！?？/\\|\s*×]/g, '');

  // 容量：取第一个「数字 + 单位」
  let volNum = null;
  const vm = flat.match(/(\d+(?:\.\d+)?)\s*(ml|毫升|l|升|kg|千克|g|克)/i);
  if (vm) volNum = normVolume(vm[1], vm[2]);
  else {
    // 「可口可乐330（矮罐）」这种裸数字也认：≥50 且 ≤5000 视为容量
    const bare = flat.match(/(?<![0-9.])(\d{2,4})(?![0-9.])/);
    if (bare) {
      const n = Number(bare[1]);
      if (n >= 50 && n <= 5000) volNum = n;
    }
  }

  // 包装单位：优先「330ml/罐」这种紧跟容量的，其次全文第一次出现
  let pack = '';
  const pm = flat.match(/(ml|毫升|l|升|g|克)\s*\/\s*(罐|瓶|包|袋|盒|桶|听|支)/i);
  if (pm) pack = PACK_MAP[pm[2]] || pm[2];
  else {
    const pm2 = flat.match(/(罐|瓶|包|袋|盒|桶|听|支)/);
    if (pm2) pack = PACK_MAP[pm2[1]] || pm2[1];
  }

  // 品牌：空格前第一段里的「开头连续中文」；阿发名常无空格（可口可乐330L）→ 截到数字/单位之前
  let brand = '';
  const firstSeg = norm.split(' ')[0] || '';
  const cjk = firstSeg.match(/^[\u4e00-\u9fa5]+/);
  if (cjk) brand = cjk[0];
  else {
    brand = (firstSeg || flat)
      .replace(/[\d.]+/g, '')
      .replace(/(ml|毫升|l|升|kg|千克|g|克)$/i, '');
  }
  brand = brand.slice(0, 12);

  const style = STYLE_WORDS.filter((w) => rawFlat.includes(w));
  const series = SERIES_WORDS.filter((w) => rawFlat.includes(w) || flat.includes(w));

  return { raw, norm, flat, rawFlat, brand, volNum, pack, style, series };
}

/** 2-gram Jaccard 相似度（0~1） */
function textSim(a, b) {
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}
function grams(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (!out.size && t) out.add(t);
  return out;
}

// ── 图片感知哈希（dHash）────────────────────────────────────────────────────
const HASH_CACHE = new Map();   // url → BigInt | null（进程内缓存，同一 url 只下/算一次）

/** JPEG buffer → 64 位 dHash（9×8 灰度，比较相邻像素） */
function dhash(buffer) {
  let img;
  try {
    img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 256 });
  } catch (e) { return null; }
  const { width, height, data } = img || {};
  if (!width || !height || !data) return null;
  const W = 9;
  const H = 8;
  const gray = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * height) / H);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * width) / W);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / W));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < height; yy++) {
        for (let xx = x0; xx < x1 && xx < width; xx++) {
          const i = (yy * width + xx) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n += 1;
        }
      }
      gray[y * W + x] = n ? sum / n : 0;
    }
  }
  let bits = 0n;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits = (bits << 1n) | (gray[y * W + x] > gray[y * W + x + 1] ? 1n : 0n);
    }
  }
  return bits;
}

function hashDistance(a, b) {
  if (a == null || b == null) return null;
  let v = a ^ b;
  let d = 0;
  while (v) { d += Number(v & 1n); v >>= 1n; }
  return d;
}

/** 下载图片并算哈希（失败返回 null，不抛；带缓存） */
async function imageHashOf(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (HASH_CACHE.has(u)) return HASH_CACHE.get(u);
  let h = null;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      h = dhash(buf);
    }
  } catch (e) { h = null; }
  HASH_CACHE.set(u, h);
  return h;
}

// ── 打分 ────────────────────────────────────────────────────────────────────
/**
 * @param {object} sys   系统商品 { name, image? }
 * @param {object} cand  阿发商品 { goodsName, picture, salePrice, unitPrice, unitFactor, factorName }
 * @param {object} opt   { sysHash, candHash }
 * @returns {{score:number, hard:string|null, imageScore:number, reasons:string[]}}
 */
function scoreCandidate(sys, cand, opt) {
  const o = opt || {};
  const S = typeof sys === 'string' ? parseSpec(sys) : (sys.spec || parseSpec(sys.name));
  const C = typeof cand === 'string' ? parseSpec(cand) : parseSpec(cand.goodsName);
  const reasons = [];

  // 硬性：两边都有容量且不等 → 不是同一个规格，直接淘汰
  if (S.volNum && C.volNum && S.volNum !== C.volNum) {
    return { score: 0, hard: `容量不符（${S.volNum} vs ${C.volNum}）`, imageScore: 0, reasons: [] };
  }

  let score = 0;

  // 品牌（32）
  const brandHit = !!S.brand && (C.flat.includes(S.brand) || (!!C.brand && S.flat.includes(C.brand)));
  if (brandHit) { score += 32; reasons.push('品牌一致'); }

  // 容量（24，缺一侧给一半）
  if (S.volNum && C.volNum) { score += 24; reasons.push('容量一致'); }
  else if (S.volNum || C.volNum) { score += 10; reasons.push('单侧有容量'); }

  // 包装（10）
  if (S.pack && C.pack && S.pack === C.pack) { score += 10; reasons.push('包装一致'); }
  else if (!S.pack || !C.pack) score += 3;

  // 款式词（8）
  const styleSame = S.style.some((w) => C.style.includes(w));
  if (styleSame) { score += 8; reasons.push('款式词一致（' + S.style.filter((w) => C.style.includes(w)).join('/') + '）'); }

  // 文本相似度（0~15）
  const sim = textSim(S.norm, C.norm);
  score += Math.round(sim * 15);
  if (sim >= 0.34) reasons.push('名称相似 ' + Math.round(sim * 100) + '%');

  // 系列冲突（-18）：一个「零度/无糖」另一个没有，基本是不同 SKU
  const seriesConflict = (S.series.length || C.series.length)
    && S.series.filter((w) => C.series.includes(w)).length === 0
    && (S.series.length > 0) !== (C.series.length > 0);
  if (seriesConflict) { score -= 18; reasons.push('系列词冲突（' + (S.series.join('/') || C.series.join('/')) + '）'); }

  // 图片（0~35）
  let imageScore = 0;
  const d = hashDistance(o.sysHash == null ? null : o.sysHash, o.candHash == null ? null : o.candHash);
  if (d != null) {
    if (d <= 6) imageScore = 35;
    else if (d <= 10) imageScore = 27;
    else if (d <= 14) imageScore = 17;
    else if (d <= 18) imageScore = 8;
    if (imageScore) reasons.push('图片相近（差异 ' + d + '/64）');
  }
  score += imageScore;

  // 品牌都没对上，最多给 55，避免误自动关联
  if (!brandHit && score > 55) score = 55;

  return { score: Math.max(0, Math.min(100, score)), hard: null, imageScore, reasons, dist: d, sim };
}

/** 排序取 topN；auto=是否达到「可自动关联」门槛 */
function rankCandidates(sys, cands, opt) {
  const o = opt || {};
  const seen = new Set();
  const list = [];
  for (const c of cands || []) {
    const gid = String(c.goodsId == null ? '' : c.goodsId);
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    const hashes = (o.candHashes && o.candHashes[gid]) || {};
    const r = scoreCandidate(sys, c, { sysHash: o.sysHash, candHash: hashes.hash });
    if (r.hard) continue;
    list.push({ ...c, ...r, auto: r.score >= 85 && (r.imageScore > 0 || r.reasons.indexOf('款式词一致') >= 0) });
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

/** 给阿发搜索用的关键词：品牌词优先，没有就取名称前 4~6 字 */
function guessKeyword(name) {
  const s = parseSpec(name);
  const b = s.brand || '';
  // 品牌词一般是 2~6 个字（可口可乐 / 农夫山泉 / 百事）；太长说明把品类词当品牌了
  if (b.length >= 2 && b.length <= 6) return b;
  const flat = s.flat.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  return flat.slice(0, 6) || String(name || '').slice(0, 6);
}

module.exports = {
  clean, parseSpec, textSim, dhash, hashDistance, imageHashOf,
  scoreCandidate, rankCandidates, guessKeyword,
  _internals: { grams, normVolume, NOISE, STYLE_WORDS, SERIES_WORDS, HASH_CACHE },
};
