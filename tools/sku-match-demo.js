#!/usr/bin/env node
/**
 * skuMatch 调用示例 + 两个测试 case（真实商品图，来自生产库 brand_product.image_url）
 *
 * 用法：
 *   node tools/sku-match-demo.js            # 跑全部 case
 *   node tools/sku-match-demo.js 1          # 只跑 case1（可乐罐型/整箱/容量/竞品）
 *   node tools/sku-match-demo.js 2          # 只跑 case2（酷儿 vs 鲜橙多）
 *   node tools/sku-match-demo.js --assert   # 顺带校验预期结论，失败退出码非 0
 *
 * 说明：
 *   1. 目标/候选的 imagePath 支持 http(s) 或本地路径；图下不下来会缓存到 data/clip-img-cache。
 *   2. 库里没有「330ml*24 整箱」和「矮罐」的独立商品图，整箱候选沿用单罐图（线上是阿发自己的整箱图），
 *      「矮罐」那条故意留空图 —— 用来验证「款式词冲突」这条纯文本规则能不能兜住。
 *   3. 阈值按线上口径传 0.80（函数默认仍是 0.70，见方案里实测校准的说明）。
 */
const path = require('path');
const { skuMatch, cleanGoodsName, parseSpec, textSimilarity } = require('../lib/sku-match');
const clip = require('../lib/clip-embed');

const THRESHOLD = 0.8;

/** 真实商品图（美团商品 CDN，生产库 brand_product.image_url 里的原图） */
const IMG = {
  coke330Modern: 'https://img.meituan.net/sgfn/3017a3be7a2e853aa2011a3da60a05861510131.png',      // 可口可乐 330ml 摩登罐
  coke330Vertical: 'http://p0.meituan.net/sgfn/QNH_184aceedf3a148c0b3cd11816ec88f9d.jpg',          // 可口可乐 330ml 竖罐装
  coke500Bottle: 'http://p0.meituan.net/sgfn/QNH_72a0495c4894469a942bbb39d9f52bc6.jpg',            // 可口可乐 500ml 瓶
  pepsi330: 'http://p0.meituan.net/sgfn/QNH_ac85bcafcebb47d698d90b6126581147.jpg',                 // 百事可乐 330ml 摩登罐
  qoo450: 'http://p1.meituan.net/sgfn/QNH_4f5605ccde744e1bbff363ed0e57e9d7.jpg',                   // 美汁源 酷儿 450ml
  xianchengduo450: 'http://p0.meituan.net/sgfn/QNH_43aa7d68d7d44f3abbfc20e66c6152f2.jpg',          // 统一鲜橙多 450ml
  guolideng1250: 'http://p0.meituan.net/sgfn/QNH_22fea54531554fd58dac87adcf5f39a0.jpg',            // 美汁源 果粒橙 1.25L
};

/**
 * case1：目标「可口可乐 330ml 矮罐单罐」
 * 候选：同规格 24 罐整箱 / 同容量但摩登高罐 / 500ml 瓶装 / 百事可乐（竞品）
 *
 * 预期：只有「同规格整箱」匹配；摩登高罐靠款式词否决；500ml 容量扣分；百事竞品否决。
 */
const CASE1 = {
  title: 'case1 · 可口可乐 330ml 矮罐单罐',
  target: { name: '可口可乐 可乐型汽水碳酸饮料 330ml/罐 矮罐 经典美味（包装随机）', imagePath: IMG.coke330Modern },
  candidates: [
    { name: '可口可乐 可乐型汽水碳酸饮料 330ml*24罐 矮罐 整箱', imagePath: IMG.coke330Modern },
    { name: '可口可乐 可乐型汽水碳酸饮料 330ml/罐 摩登罐高罐 整箱', imagePath: IMG.coke330Vertical },
    { name: '可口可乐 汽水碳酸饮料 500ml/瓶 经典美味', imagePath: IMG.coke500Bottle },
    { name: '百事可乐 可乐型汽水碳酸饮料 330ml/罐 矮罐 整箱', imagePath: IMG.pepsi330 },
  ],
  expect: [
    { idx: 0, is_match: true, why: '同容量同罐型的整箱，按业务规则视为匹配' },
    { idx: 1, is_match: false, why: '摩登高罐 ≠ 矮罐，款式冲突否决' },
    { idx: 2, is_match: false, why: '500ml ≠ 330ml，容量不一致 -0.2' },
    { idx: 3, is_match: false, why: '百事可乐是竞品，互斥 -0.3' },
  ],
};

/**
 * case2：目标「酷儿橙汁 450ml 单瓶」
 * 候选：酷儿 450ml×12 整箱 / 统一鲜橙多 450ml（竞品）/ 美汁源果粒橙 1.25L（竞品+容量不同）
 *
 * 预期：只有酷儿整箱匹配。
 */
const CASE2 = {
  title: 'case2 · 酷儿橙汁 450ml 单瓶',
  target: { name: '美汁源 酷儿 Qoo 橙汁饮料 450ml/瓶 富含维C', imagePath: IMG.qoo450 },
  candidates: [
    { name: '美汁源 酷儿 Qoo 橙汁饮料 450ml*12瓶 整箱', imagePath: IMG.qoo450 },
    { name: '统一 鲜橙多 橙汁饮料 450ml/瓶 富含维生素C', imagePath: IMG.xianchengduo450 },
    { name: '美汁源 果粒橙 橙汁饮料 1.25L/瓶', imagePath: IMG.guolideng1250 },
  ],
  expect: [
    { idx: 0, is_match: true, why: '同 IP 同容量，整箱视为匹配' },
    { idx: 1, is_match: false, why: '鲜橙多与酷儿竞品互斥 -0.3' },
    { idx: 2, is_match: false, why: '品牌与容量都不一致' },
  ],
};

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

async function runCase(c, doAssert) {
  console.log('\n' + '='.repeat(96));
  console.log(c.title);
  console.log('目标：' + c.target.name);
  console.log('  清洗后：' + cleanGoodsName(c.target.name));
  console.log('  解析：' + JSON.stringify(parseSpec(c.target.name)));

  const t0 = Date.now();
  const rows = await skuMatch(c.target, c.candidates, THRESHOLD);
  const cost = Date.now() - t0;

  console.log(`\n阈值 ${THRESHOLD} · 用时 ${cost}ms`);
  console.log(pad('候选', 46) + pad('图片', 9) + pad('文本', 9) + pad('总分', 9) + '判定');
  console.log('-'.repeat(96));
  for (const r of rows) {
    console.log(
      pad(r.candidate_name.slice(0, 22), 46) +
      pad(r.img_similarity.toFixed(3), 9) +
      pad(r.text_similarity.toFixed(3), 9) +
      pad(r.final_score.toFixed(3), 9) +
      (r.is_match ? '✓ 匹配' : '✗ 不匹配')
    );
    console.log('    ↳ ' + r.match_reason);
  }

  if (!doAssert) return { pass: 0, fail: 0 };
  let pass = 0;
  let fail = 0;
  for (const e of c.expect) {
    const name = c.candidates[e.idx].name;
    const got = rows.find((r) => r.candidate_name === name);
    const okFlag = got && got.is_match === e.is_match;
    if (okFlag) { pass++; console.log(`  ✓ ${name.slice(0, 26)} → ${e.is_match ? '匹配' : '不匹配'}（${e.why}）`); }
    else { fail++; console.log(`  ✗ ${name.slice(0, 26)} → 期望 ${e.is_match ? '匹配' : '不匹配'}，实际 ${got ? got.is_match : '缺失'}（${e.why}）`); }
  }
  return { pass, fail };
}

(async () => {
  const args = process.argv.slice(2);
  const doAssert = args.includes('--assert');
  const which = args.find((a) => /^[12]$/.test(a));
  const cases = which === '1' ? [CASE1] : which === '2' ? [CASE2] : [CASE1, CASE2];

  if (!clip.isAvailable()) {
    console.error('CLIP 依赖不可用：' + clip.unavailableReason());
    process.exit(1);
  }
  console.log('模型：' + clip.MODEL_ID + '（镜像 ' + clip.REMOTE_HOST + '，缓存 ' + clip.MODEL_DIR + '）');

  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const r = await runCase(c, doAssert);
    pass += r.pass;
    fail += r.fail;
  }
  console.log('\n模型信息：' + JSON.stringify(clip.info()));
  if (doAssert) {
    console.log(`\n===== 断言：${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
  }
  process.exit(0);
})().catch((e) => { console.error('运行失败：', e); process.exit(1); });
