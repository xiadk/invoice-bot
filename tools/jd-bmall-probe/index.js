/**
 * 京东万商（b.jd.com）接口探针 —— 只回答一个问题：带 Cookie 但不算 h5st，京东认不认。
 *
 * ⚠ 仅用于取证/排查，**不是正式链路**（2026-11-02 定稿）：
 *   正式取价走「本机助手页内请求」（lib/jd-agent.js + electron/agent/jd-login.js），
 *   因为服务器直连 api.m.jd.com 即使 Cookie 完全有效也会被网关 403。
 *   保留本脚本是为了以后京东改接口时能快速对字段、对状态码。
 *
 * 背景：三个接口都走 api.m.jd.com/api（appid=b2b），请求里带 h5st 签名。
 *   实测「无 h5st」与「原样重放旧 h5st」都是 HTTP 403 空 body —— 但那次没带 Cookie，
 *   分不清是签名被拒还是没登录。本脚本就是补上 Cookie 再试一遍。
 *
 * 用法（只读接口，不改任何数据；失败也不写库）：
 *   node tools/jd-bmall-probe/index.js --cookie "pt_key=xxx; pt_pin=yyy"
 *   node tools/jd-bmall-probe/index.js --cookie-file data/jd-cookie.txt
 *   node tools/jd-bmall-probe/index.js --cookie "..." --keyword 可口可乐 --pages 2
 *   node tools/jd-bmall-probe/index.js --cookie "..." --detail 10235591362865
 *   node tools/jd-bmall-probe/index.js --cookie "..." --h5st "20261102094923312;..."   ← 试旧签名
 *
 * 结果怎么读：
 *   · 200 + 有 JSON 且有商品 → 服务端直连可行（路线 A），不用助手
 *   · 200 但 code=xxx 提示未登录 → Cookie 无效/不全，换一份再试
 *   · 403 空 body → 网关要求 h5st，只能自算签名（A）或走助手页内通道（B）
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ── 抓包里的公共参数（2026-11-02 取自万商 PC 端）────────────────────────────
const COMMON = {
  version: '1.0',
  appid: 'b2b',
  client: 'pc',
  clientVersion: '7.0.2',
  lang: 'zh_CN',
  cthr: '1',
  loginType: '3',
  // eid = 设备指纹，抓包里带的这一串；换机器/换浏览器会变
  eid: '4J7SINRMDCOTMOX3GR6DGDEZEZOYERUPVKKIWZ3LPTAFQXVHAWVTJPPSY2R5U7TNHH2BKA7EZFCOHPAFRLLA25UC2Y',
  uuid: '1793340306220956453294',
};
// 收货地址相关（加购与取价都要，来自抓包；不同仓库要改）
const ADDR = {
  addressId: 13082155770,
  areaId: '19_1657_59566_0',
  areaIdSet: [19, 1657, 59566, 0],
  longitude: 113.397338,
  latitude: 22.527928,
  areaType: 16,
};
const GRID_LIST = [
  { buId: '0', ouIds: [1000002031], gridType: '10001', gridPid: 912824, valueMap: null, gridId: 912825, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 5 },
  { buId: '0', ouIds: [1000002031], gridType: '10001', gridPid: 911786, valueMap: null, gridId: 912824, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 4 },
  { buId: '0', ouIds: [1000002031], gridType: '10001', gridPid: 876907, valueMap: null, gridId: 911786, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 3 },
  { buId: '456', ouIds: [1000002031], gridType: '2181', gridPid: 1050005, valueMap: null, gridId: 1352645, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 1 },
  { buId: '456', ouIds: [1000002031], gridType: '2181', gridPid: 1050005, valueMap: { deliverB: '1' }, gridId: 1054605, class: 'com.jd.core.grid.sdk.service.result.GridInfoDTO', gridLevel: 1 },
];

const BIZ = { tenantId: 1024, ua: 1, buId: 456 };
const COMMON_PARAM = { pid: 100, verticalCode: 'cn_retail_bmall', ua: 1, language: 'zh', userType: 1 };

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function readCookie() {
  let c = arg('cookie', '');
  if (c === true) c = '';
  const f = arg('cookie-file', '');
  if (!c && f && f !== true) c = fs.readFileSync(path.resolve(ROOT, f), 'utf-8');
  if (!c) {
    // 兼容两种命名（用户手放时下划线/连字符都可能）
    for (const name of ['jd-cookie.txt', 'jd_cookie.txt']) {
      const dft = path.join(ROOT, 'data', name);
      if (fs.existsSync(dft)) { c = fs.readFileSync(dft, 'utf-8'); console.log('· 从 data/' + name + ' 读取 Cookie'); break; }
    }
  }
  c = String(c || '').trim().replace(/^cookie:\s*/i, '');
  return c;
}

// ── 请求 ────────────────────────────────────────────────────────────────────
function post(params, cookie) {
  const data = Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
  return new Promise((resolve) => {
    const req = https.request({
      host: 'api.m.jd.com', path: '/api', method: 'POST', timeout: 20000,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(data),
        origin: 'https://b.jd.com', referer: 'https://b.jd.com/',
        'user-agent': UA,
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const zlib = require('zlib');
      let s = res;
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      else if (enc === 'br') s = res.pipe(zlib.createBrotliDecompress());
      let b = '';
      s.on('data', (c) => (b += c));
      s.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', body: '' }); });
    req.write(data);
    req.end();
  });
}

function baseParams(functionId, bodyObj, extra = {}) {
  return Object.assign({
    ...COMMON,
    t: String(Date.now()),
    functionId,
    body: JSON.stringify(bodyObj),
  }, extra);
}

/** 搜索：关键词 → 商品列表（价格、规格、库存都在这里面） */
function searchBody(keyword, page = 1) {
  return {
    uniformBizInfo: BIZ,
    commonParam: COMMON_PARAM,
    param: {
      searchScene: 0, searchMatchFlux: 'vendorIdList', searchKey: keyword,
      priceStart: '', priceEnd: '', sortType: 1, filterConditionList: [], showHasStock: 1,
      requestSource: 1, currentPage: page, sourceFlag: null,
      addressId: ADDR.addressId, countPerPage: 50,
      pvId: 'c0b1937c-4196-4ae6-bbe0-41a056a13813', p: '10001',
    },
  };
}

/** 详情：skuId → 单品完整信息（价格/规格/包装/库存） */
function detailBody(skuId) {
  return {
    uniformBizInfo: { ...BIZ, bMallTag: '1' },
    commonParam: COMMON_PARAM,
    skuId: String(skuId),
    bMallTag: '1',
    verticalTag: 'cn_retail_bmall',
    skuUniformBizInfo: { buId: 456 },
    areaId: ADDR.areaId,
    gridInfoList: GRID_LIST,
    skuNum: 1,
    longitude: ADDR.longitude,
    latitude: ADDR.latitude,
    areaType: ADDR.areaType,
    traceId: require('crypto').randomUUID(),
  };
}

function summarize(label, r) {
  console.log('\n──────── ' + label + ' ────────');
  console.log('HTTP', r.status, r.error ? '(' + r.error + ')' : '');
  if (!r.body) { console.log('body: (空)'); return null; }
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { }
  if (!j) { console.log('body 前 600 字：\n' + r.body.slice(0, 600)); return null; }
  const head = JSON.stringify(j).slice(0, 600);
  console.log('body 前 600 字：\n' + head);
  return j;
}

(async () => {
  const cookie = readCookie();
  if (!cookie) {
    console.error('✗ 没有 Cookie。用法：node tools/jd-bmall-probe/index.js --cookie "pt_key=...; pt_pin=..."');
    process.exit(1);
  }
  if (!/pt_key=/.test(cookie) && !/thor=/.test(cookie)) {
    console.log('⚠ Cookie 里既没有 pt_key 也没有 thor —— 多半没登录，京东会当匿名请求处理。');
  }
  const keyword = arg('keyword', '可口可乐');
  const pages = Number(arg('pages', 1)) || 1;
  const h5st = arg('h5st', '');

  console.log('· Cookie 长度 ' + cookie.length + '，关键词「' + keyword + '」，UA ' + UA.slice(0, 40) + '…');

  // ① 不带 h5st
  for (let p = 1; p <= pages; p++) {
    const r = await post(baseParams('bmall_goodsm_purchase_search_list', searchBody(keyword, p)), cookie);
    const j = summarize('搜索 · 第 ' + p + ' 页 · 不带 h5st', r);
    if (p === 1 && j) printSearchSample(j);
  }

  // ② 带旧 h5st（判断签名是否强绑定 body/时间）
  if (h5st && h5st !== true) {
    const r = await post(baseParams('bmall_goodsm_purchase_search_list', searchBody(keyword, 1), { h5st }), cookie);
    summarize('搜索 · 第 1 页 · 带旧 h5st', r);
  }

  // ③ 详情
  const sku = arg('detail', '');
  if (sku && sku !== true) {
    const r = await post(baseParams('wareBusiness.style', detailBody(sku)), cookie);
    const j = summarize('详情 · skuId=' + sku + ' · 不带 h5st', r);
    if (j) printFirstRecord('详情', j);
  }
})();

// ── 结果解读 ────────────────────────────────────────────────────────────────
function findProductArray(j) {
  const candidates = [
    j && j.result && j.result.productList,
    j && j.result && j.result.data && j.result.data.productList,
    j && j.result && j.result.searchResult && j.result.searchResult.productList,
    j && j.data && j.data.productList,
  ];
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  // 兜底：BFS 找第一个「元素像商品（有 skuId 或 id 且有 price）」的数组
  const q = [j];
  while (q.length) {
    const cur = q.shift();
    if (!cur || typeof cur !== 'object') continue;
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0]) {
        const f = v[0];
        if ((f.skuId || f.id || f.wareId) && (f.price !== undefined || f.jdPrice !== undefined || f.p !== undefined)) return v;
      }
      if (v && typeof v === 'object') q.push(v);
    }
  }
  return null;
}

function printSearchSample(j) {
  const arr = findProductArray(j);
  if (!arr) { console.log('· 没找到商品数组 —— 详见上面的原始返回（可能是未登录/参数被拒）'); return; }
  console.log('\n★ 找到 ' + arr.length + ' 条商品，第一条的全字段（校准价格口径用）：');
  console.log(JSON.stringify(arr[0], null, 2).slice(0, 3000));
  console.log('\n★ 前 5 条速览：');
  for (const it of arr.slice(0, 5)) {
    console.log('  - ' + JSON.stringify({
      skuId: it.skuId || it.id || it.wareId,
      name: (it.skuName || it.name || it.wareName || '').slice(0, 40),
      price: it.price !== undefined ? it.price : (it.jdPrice !== undefined ? it.jdPrice : it.p),
      spec: it.spec || it.packingSpec || it.unitName || it.skuUnit || '',
      stock: it.stock || it.stockNum || it.hasStock,
    }));
  }
}

function printFirstRecord(label, j) {
  const arr = findProductArray(j);
  if (arr && arr[0]) {
    console.log('\n★ ' + label + '第一条全字段：\n' + JSON.stringify(arr[0], null, 2).slice(0, 3000));
  } else {
    console.log('\n★ ' + label + ' 返回结构如上，第一条字段名需人工确认。');
  }
}
