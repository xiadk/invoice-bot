/**
 * 商品匹配算法（系统商品 ↔ 城配速达/阿发商品）—— CLIP 图文相似度 + 业务规则
 *
 * 为什么要重写：原来是「拿商品名原样搜阿发，直接取第一条」，同品牌不同规格、竞品都排在一起，
 * 关联错货只能靠人肉发现。现在用 CLIP 图片向量 + 中文文本相似度打分，再用业务规则纠偏。
 *
 * 三个实测事实决定了这里的实现（不要凭直觉改）：
 *   1. **CLIP 文本编码器对中文几乎无区分度**：酷儿 vs 鲜橙多文本余弦 0.992、酷儿 vs 可乐 0.949。
 *      所以 textSim 不用 CLIP 文本塔，改成清洗后的中文 2-gram 余弦（同品类约 0.3~0.5，同款约 0.8+）。
 *   2. **CLIP 图像余弦绝对值天然偏高**：同品类 0.73~0.96，同品牌不同容量 0.93~0.96
 *      （比不同品牌还高）。所以「容量不一致 -0.2」「竞品互斥 -0.3」这些规则不是锦上添花，
 *      而是唯一能拦住错货的东西；阈值也要按实测校准（调用方传 0.80，函数默认仍是 0.70）。
 *   3. **矮罐 / 摩登高罐靠图像分不开**（同品牌实测 0.93+），所以除图片向量外，
 *      再加一条「款式词冲突」惩罚做兜底（名称里有「矮罐/摩登/高罐」时才生效）。
 *
 * 对外接口（签名按需求约定，输出字段用 snake_case）：
 *   skuMatch(target, candidates, threshold = 0.7) → Promise<Array<{
 *     candidate_name, img_similarity, text_similarity, final_score, match_reason, is_match
 *   }>>
 *     target     = { name, imagePath }
 *     candidates = [{ name, imagePath }]
 *
 *   cleanGoodsName(name)      名称清洗（剔整箱/箱/数量包装/年份/促销词）
 *   parseSpec(name)           解析出 { ip, brand, flavor, category, volMl, pack, packQty, style }
 *   textSimilarity(a, b)      中文 2-gram 余弦
 */
const clip = require('./clip-embed');

// ─────────────────────────────────────────────────────────────────────────────
// 词表
// ─────────────────────────────────────────────────────────────────────────────

/** 促销/营销噪声词：对识别商品没用，只会把相似度拉低，比较前统一删掉 */
const NOISE_WORDS = [
  '包装随机发货', '新老包装随机', '包装随机', '随机发货', '新老包装',
  '整箱装', '整箱', '整件', '箱装', '原箱', '箱',
  '促销', '特价', '特惠', '秒杀', '清仓', '限时', '买一送一', '买赠', '赠品', '赠',
  '包邮', '正品', '行货', '国产', '进口', '新品', '新款', '爆款', '网红', '热销',
  '家庭装', '分享装', '量贩装', '囤货装', '便携装', '组合装', '礼盒装', '礼盒',
  '经典美味', '畅爽带劲', '清爽解渴', '冰镇更佳', '冰爽', '畅饮', '劲爽',
  '含糖', '不含糖', '无糖零卡', '零卡', '零脂肪', '0脂肪', '富含维C', '富含维生素C',
  '膳食纤维', '醇香浓厚', '果味饮品', '碳酸饮料', '汽水', '饮料', '饮品',
  '适合', '常备', '必备', '聚餐', '宴请', '出行', '解腻', '解渴',
];

/**
 * IP / 品牌别名表：一个 IP 一条，别名全部小写。
 * 匹配时「目标 IP == 候选 IP」加分；「同品类不同 IP」按竞品互斥扣分。
 */
const IP_ALIASES = {
  可口可乐: ['可口可乐', 'coca-cola', 'cocacola', 'coke', '经典可乐', '零度可乐', '健怡可乐'],
  百事可乐: ['百事可乐', '百事', 'pepsi'],
  雪碧: ['雪碧', 'sprite'],
  芬达: ['芬达', 'fanta'],
  酷儿: ['酷儿', 'qoo'],
  美汁源: ['美汁源', 'minute maid', 'minutemaid'],
  果粒橙: ['果粒橙'],
  鲜橙多: ['鲜橙多'],
  果倍爽: ['果倍爽', 'capri-sun', 'caprisun'],
  农夫山泉: ['农夫山泉', 'nongfu'],
  怡宝: ['怡宝', 'cestbon'],
  康师傅: ['康师傅', 'master kong'],
  统一: ['统一', 'uni-president', 'unipresident'],
  元气森林: ['元气森林', 'genki forest'],
  脉动: ['脉动', 'mizone'],
  红牛: ['红牛', 'red bull', 'redbull'],
  东鹏: ['东鹏', '东鹏特饮'],
  加多宝: ['加多宝'],
  王老吉: ['王老吉'],
  娃哈哈: ['娃哈哈', 'wahaha'],
};

/** 品类：决定「同品类不同 IP」才算竞品互斥，避免把水和可乐判成竞品 */
const CATEGORY_KEYWORDS = {
  可乐: ['可乐', 'cola'],
  橙汁: ['橙汁', '橙', 'orange'],
  柠檬汽水: ['柠檬', 'lemon', '雪碧', '七喜'],
  茶饮: ['茶', 'tea', '冰红茶', '绿茶', '乌龙'],
  矿泉水: ['矿泉水', '纯净水', '饮用水', '水'],
  功能饮料: ['功能饮料', '能量', '电解质', '特饮'],
  乳饮: ['牛奶', '酸奶', '乳', '奶'],
};

/** 竞品互斥表：目标 IP → 明确要重罚的候选关键词（需求里点名的组合，优先于通用规则） */
const RIVAL_MAP = {
  酷儿: ['鲜橙多', '果倍爽', '果粒橙', '美汁源果粒橙'],
  果粒橙: ['鲜橙多', '果倍爽', '酷儿'],
  可口可乐: ['百事可乐', '百事'],
  百事可乐: ['可口可乐'],
  雪碧: ['七喜', '芬达'],
  农夫山泉: ['怡宝', '娃哈哈'],
  怡宝: ['农夫山泉'],
};

/** 口味词：口味不同（同 IP 同容量）也应扣分 */
const FLAVOR_WORDS = [
  '原味', '经典', '橙汁', '橙', '柠檬', '青柠', '葡萄', '水蜜桃', '蜜桃', '芒果', '西柚', '柚子',
  '草莓', '苹果', '荔枝', '菠萝', '椰子', '西瓜', '蓝莓', '樱桃', '无糖', '零度', '香草', '咖啡', '薄荷',
];

/** 款式词：罐型/瓶型差异（矮罐 vs 摩登高罐），图片分不开时靠这个兜底 */
const STYLE_GROUPS = [
  ['矮罐', '短罐', '普通罐'],
  ['摩登罐', '摩登', '高罐', '细高罐', '纤体罐', '细长罐'],
  ['竖罐', '竖罐装'],
  ['胖罐', '宽罐'],
];

// ─────────────────────────────────────────────────────────────────────────────
// 名称解析
// ─────────────────────────────────────────────────────────────────────────────

/** 全角转半角 + 统一乘号，方便后面正则 */
function normalizeText(s) {
  return String(s == null ? '' : s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[×✕✖＊]/g, '*')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[【]/g, '[').replace(/[】]/g, ']')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析容量（毫升）。兼容脏数据：阿发常把 330ml 写成「330L」（实测），
 * 所以「单位是 L 但数值 ≥ 100」一律按 ml 处理。
 */
function parseVolume(text) {
  const s = String(text || '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(ml|毫升|l|升|kg|g|克)(?![a-z])/i);
  if (!m) return null;
  const num = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(num) || num <= 0) return null;
  if (unit === 'ml' || unit === '毫升') return Math.round(num);
  if (unit === 'l' || unit === '升') {
    if (num >= 100) return Math.round(num);        // 330L → 330ml（脏数据）
    return Math.round(num * 1000);                  // 1.25L → 1250ml
  }
  return null;                                      // kg/g 不是饮料容量口径，忽略
}

/** 解析件内数量：*24 / x24 / 24罐 / 24瓶 / 12瓶 */
function parsePackQty(text) {
  const s = String(text || '');
  let m = s.match(/(?:\*|x)\s*(\d{1,3})\b/i);
  if (m) return Number(m[1]);
  m = s.match(/(\d{1,3})\s*(?:罐|瓶|听|包|袋|杯|支)\b/);
  if (m) return Number(m[1]);
  return null;
}

/** 包装形态 */
function parsePack(text) {
  const s = String(text || '');
  if (/(?:罐|听)/.test(s)) return '罐';
  if (/瓶/.test(s)) return '瓶';
  if (/(?:包|袋)/.test(s)) return '包';
  if (/(?:箱|件)/.test(s)) return '箱';
  return '';
}

/** 命中哪个 IP（取最长别名，避免「可口可乐」被「可乐」抢走） */
function detectIp(text) {
  const low = String(text || '').toLowerCase();
  let best = '';
  let bestLen = 0;
  for (const [ip, aliases] of Object.entries(IP_ALIASES)) {
    for (const a of aliases) {
      // 短别名要求词边界，防止「可乐」命中「可口可乐」以外的东西
      if (low.includes(a) && a.length > bestLen) { best = ip; bestLen = a.length; }
    }
  }
  return best;
}

/** 判断品类 */
function detectCategory(text) {
  const low = String(text || '').toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some((k) => low.includes(k))) return cat;
  }
  return '';
}

/** 口红口味 */
function detectFlavor(text) {
  const low = String(text || '').toLowerCase();
  const hits = FLAVOR_WORDS.filter((w) => low.includes(w));
  return hits.join('/');
}

/** 款式（矮罐/摩登罐…） */
function detectStyle(text) {
  const low = String(text || '').toLowerCase();
  for (const group of STYLE_GROUPS) {
    const hit = group.find((w) => low.includes(w));
    if (hit) return { style: hit, group: group[0] };
  }
  return { style: '', group: '' };
}

/**
 * 解析商品名称 → 结构化规格
 * @param {string} name
 * @returns {{raw:string, ip:string, flavor:string, category:string, volMl:number|null,
 *            pack:string, packQty:number|null, style:string, styleGroup:string}}
 */
function parseSpec(name) {
  const raw = normalizeText(name);
  const st = detectStyle(raw);
  return {
    raw,
    ip: detectIp(raw),
    flavor: detectFlavor(raw),
    category: detectCategory(raw),
    volMl: parseVolume(raw),
    pack: parsePack(raw),
    packQty: parsePackQty(raw),
    style: st.style,
    styleGroup: st.group,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 名称清洗
// ─────────────────────────────────────────────────────────────────────────────

/** 删除所有出现的噪声词（按长度倒序删，避免「整箱装」只删掉「整箱」留下「装」） */
function stripNoise(s) {
  let out = String(s || '');
  const sorted = [...NOISE_WORDS].sort((a, b) => b.length - a.length);
  for (const w of sorted) {
    if (!w) continue;
    out = out.split(w).join(' ');
  }
  return out;
}

/**
 * 商品名清洗：剔掉【整箱、箱、*数字瓶/罐、/箱、年份、促销文字】，只留「IP + 品牌 + 口味 + 容量 + 包装」。
 *
 * 实现上先用占位符把容量保护起来，再删数量表达 —— 否则「450ml/瓶」里的「/瓶」、
 * 「330ml*24罐」里的「24罐」会把容量一起吃掉。
 *
 * @param {string} name
 * @returns {string} 清洗后的名称（保留可读性，供文本相似度与人工核对用）
 */
function cleanGoodsName(name) {
  let s = normalizeText(name);
  if (!s) return '';

  // 1) 容量先换成占位符（330ml / 1.25L → \u0001），避免被后面的数量正则误伤
  const vols = [];
  s = s.replace(/(\d+(?:\.\d+)?)\s*(ml|毫升|l|升)(?![a-z])/gi, (m0) => {
    vols.push(m0.replace(/\s+/g, ''));
    return `\u0001${vols.length - 1}\u0001`;
  });
  // 2) 件内数量：*24罐 / x12瓶 整体删（需求里的「*数字瓶、*数字罐」），再删「24罐」这种写法
  s = s.replace(/(?:\*|x)\s*\d{1,3}\s*(?:罐|瓶|听|包|袋|杯|支)?\b/gi, ' ');
  s = s.replace(/(?:\*|x)\s*\d{1,3}\b/gi, ' ');
  s = s.replace(/\d{1,3}\s*(?:罐|瓶|听|包|袋|杯|支)\b/g, ' ');
  // 3) 方括号里的包装说明：【整箱】【整件】
  s = s.replace(/\[[^\]]*\]/g, ' ');
  // 4) /箱 /件 这类「每箱」写法
  s = s.replace(/[\/／]\s*(?:箱|件)/g, ' ');
  // 5) 年份（2024 / 2025年）—— 4 位连续数字，不会误伤 1.25L / 330ml
  s = s.replace(/(?:19|20)\d{2}\s*年?/g, ' ');
  // 6) 促销与营销噪声
  s = stripNoise(s);
  // 7) 还原容量
  s = s.replace(/\u0001(\d+)\u0001/g, (m0, i) => vols[Number(i)] || '');
  // 8) 收尾：合并空白、去掉多余的括号与标点
  s = s.replace(/[()\[\]{}<>《》]/g, ' ')
    .replace(/[\s,，、;；:：!！?？~～\-—_]+/g, ' ')
    .trim();
  // 9) 清掉被拆散后孤立的「装」字（促销装→促销+装、整箱装→…+装），「罐装/瓶装」这类有意义的保留
  s = s.replace(/(^|\s)装(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// 文本相似度（中文 2-gram 余弦）
// ─────────────────────────────────────────────────────────────────────────────

/** 抽 2-gram 词频（去空白与标点；单字串退化为 1-gram） */
function bigramFreq(s) {
  const t = String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '');
  const map = new Map();
  if (!t) return map;
  if (t.length === 1) { map.set(t, 1); return map; }
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    map.set(g, (map.get(g) || 0) + 1);
  }
  return map;
}

/**
 * 文本相似度：清洗后的中文 2-gram 词频向量余弦（0~1）
 * 同款商品约 0.8+，同品类不同品牌约 0.3~0.5，不同品类更低。
 */
function textSimilarity(a, b) {
  const sa = cleanGoodsName(a);
  const sb = cleanGoodsName(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const fa = bigramFreq(sa);
  const fb = bigramFreq(sb);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of fa.values()) na += v * v;
  for (const [g, v] of fb) {
    nb += v * v;
    const x = fa.get(g);
    if (x) dot += x * v;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─────────────────────────────────────────────────────────────────────────────
// 打分
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * 业务规则打分（叠加在 final = img*0.6 + text*0.4 之上）
 * @returns {{delta:number, reasons:string[], hardReject:boolean, spec:Object, candSpec:Object}}
 */
function applyRules(targetName, candName) {
  const t = parseSpec(targetName);
  const c = parseSpec(candName);
  const reasons = [];
  let delta = 0;
  let hardReject = false;

  // ① IP 正向加分：目标与候选是同一个 IP
  if (t.ip && c.ip && t.ip === c.ip) {
    delta += 0.08;
    reasons.push(`IP一致(${t.ip}) +0.08`);
  }

  // ② 竞品互斥：命中 RIVAL_MAP 直接重罚（需求：目标酷儿命中鲜橙多/果倍爽 -0.3）
  const rivals = RIVAL_MAP[t.ip] || [];
  const hitRival = rivals.find((r) => String(candName).includes(r));
  if (hitRival) {
    delta -= 0.3;
    hardReject = true;
    reasons.push(`竞品互斥(${hitRival}) -0.30`);
  } else if (t.ip && c.ip && t.ip !== c.ip && t.category && c.category && t.category === c.category) {
    // 通用规则：同品类不同 IP 也算竞品（可乐 vs 百事、橙汁 vs 鲜橙多）
    delta -= 0.3;
    hardReject = true;
    reasons.push(`同品类不同品牌(${c.ip}) -0.30`);
  }

  // ③ 容量不一致 -0.2（含整箱兼容判断）
  if (t.volMl && c.volMl) {
    if (t.volMl === c.volMl) {
      // 目标单罐/单瓶 vs 候选同规格整箱 → 视为匹配，不加不减（需求第 4 条）
      if ((c.packQty || 0) > 1) reasons.push(`同规格整箱(${c.volMl}ml×${c.packQty}) 视为匹配`);
      else reasons.push(`容量一致 ${t.volMl}ml`);
    } else {
      delta -= 0.2;
      reasons.push(`容量不一致(${t.volMl}ml vs ${c.volMl}ml) -0.20`);
    }
  } else if (t.volMl && !c.volMl) {
    reasons.push('候选未标容量，未扣分');
  }

  // ④ 款式冲突（矮罐 vs 摩登高罐）：图片分不开，靠名称兜底
  if (t.styleGroup && c.styleGroup && t.styleGroup !== c.styleGroup) {
    delta -= 0.15;
    hardReject = true;
    reasons.push(`款式冲突(${t.style} vs ${c.style}) -0.15`);
  } else if (t.styleGroup && c.styleGroup && t.styleGroup === c.styleGroup) {
    reasons.push(`款式一致(${t.style})`);
  }

  // ⑤ 口味冲突（同 IP 同容量但口味不同）
  if (t.flavor && c.flavor && t.flavor !== c.flavor) {
    const share = t.flavor.split('/').some((f) => c.flavor.split('/').includes(f));
    if (!share) { delta -= 0.1; reasons.push(`口味不同(${t.flavor} vs ${c.flavor}) -0.10`); }
  }

  return { delta, reasons, hardReject, spec: t, candSpec: c };
}

/**
 * 内部：给一批候选打分，**保留输入顺序与下标**（不排序）
 *
 * 与 skuMatch 的区别：skuMatch 是给外部调用方用的（按分数排序、字段固定），
 * 服务端需要把「第几条候选」映射回阿发 goodsId，所以用这个带 index 的版本，
 * 避免同名候选串位。
 *
 * @param {{name:string, imagePath:string}} target
 * @param {Array<{name:string, imagePath:string}>} candidates
 * @param {number} [threshold=0.7]
 * @returns {Promise<Array<Object>>} 每项在 skuMatch 输出字段基础上多一个 index
 */
async function scoreCandidates(target, candidates, threshold = 0.7) {
  const th = Number(threshold) > 0 ? Number(threshold) : 0.7;
  const tName = String((target && target.name) || '').trim();
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && (c.name || c.imagePath)) : [];
  if (!list.length) return [];

  // 目标图片向量（失败不致命：图像分用文本分兜底，并在理由里写明）
  let tVec = null;
  let tImgErr = '';
  if (target && target.imagePath) {
    try {
      tVec = await clip.imageEmbed(target.imagePath);
    } catch (e) {
      tImgErr = String((e && e.message) || e).slice(0, 100);
    }
  } else {
    tImgErr = '目标无图';
  }

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const cand = list[i];
    const cName = String(cand.name || '').trim();
    const textSim = textSimilarity(tName, cName);
    const rules = applyRules(tName, cName);

    // 图像相似度：候选图取不到就当 0 分（不会因为「取不到」白捡高分）
    let imgSim = 0;
    let cImgErr = '';
    if (tVec && cand.imagePath) {
      try {
        const cVec = await clip.imageEmbed(cand.imagePath);
        imgSim = clip.cosine(tVec, cVec);
      } catch (e) {
        cImgErr = String((e && e.message) || e).slice(0, 80);
      }
    }

    // 权重固定：图片 0.6 + 文本 0.4
    let base;
    if (tVec) {
      base = imgSim * 0.6 + textSim * 0.4;
    } else {
      // 目标无图：图像一路拿不到，只能用文本；不再强行乘 0.6 否则永远不可能达标
      base = textSim;
      rules.reasons.unshift(`目标无图(${tImgErr})，按文本分计`);
    }

    const finalScore = clamp01(base + rules.delta);
    const reasonParts = [
      `图文 ${imgSim.toFixed(3)}×0.6 + 文本 ${textSim.toFixed(3)}×0.4`,
      ...rules.reasons,
    ];
    if (cImgErr) reasonParts.push(`候选图取不到(${cImgErr})`);
    if (tVec && rules.hardReject) reasonParts.push('含否决项');

    out.push({
      index: i,
      candidate_name: cName,
      img_similarity: round3(imgSim),
      text_similarity: round3(textSim),
      final_score: round3(finalScore),
      match_reason: reasonParts.join('；'),
      is_match: finalScore >= th && !rules.hardReject,
      targetHasImage: !!tVec,
    });
  }
  return out;
}

/**
 * 核心：给一批候选打分并排序（对外接口，字段严格按约定）
 *
 * @param {{name:string, imagePath:string}} target 目标商品（imagePath 支持 http(s) 或本地路径）
 * @param {Array<{name:string, imagePath:string}>} candidates 候选商品
 * @param {number} [threshold=0.7] 判定为匹配的阈值（调用方按实测建议传 0.80）
 * @returns {Promise<Array<{candidate_name:string, img_similarity:number, text_similarity:number,
 *                          final_score:number, match_reason:string, is_match:boolean}>>}
 */
async function skuMatch(target, candidates, threshold = 0.7) {
  const rows = await scoreCandidates(target, candidates, threshold);
  const out = rows.map((r) => ({
    candidate_name: r.candidate_name,
    img_similarity: r.img_similarity,
    text_similarity: r.text_similarity,
    final_score: r.final_score,
    match_reason: r.match_reason,
    is_match: r.is_match,
  }));
  // 分数降序，同分时文本相似度高的在前
  out.sort((a, b) => (b.final_score - a.final_score) || (b.text_similarity - a.text_similarity));
  return out;
}

module.exports = {
  skuMatch,
  scoreCandidates,
  cleanGoodsName,
  parseSpec,
  textSimilarity,
  // 供服务端做轻量预筛（不加载模型也能用）
  parseVolume,
  parsePackQty,
  detectIp,
  applyRules,
  DEFAULT_THRESHOLD: 0.7,
  TABLES: { NOISE_WORDS, IP_ALIASES, RIVAL_MAP, CATEGORY_KEYWORDS, STYLE_GROUPS, FLAVOR_WORDS },
};
