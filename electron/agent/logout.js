/**
 * electron/agent/logout.js — 退出本机浏览器里的登录态（只跑在用户本机）
 *
 * 为什么需要它：
 *   看板点「退出拼多多账号 / 退出牵牛花账号」时，服务器只能删掉**数据库里**的 Cookie。
 *   但登录窗口用的是 Electron 的持久分区（persist:pdd / persist:qnh / persist:1688），
 *   Cookie 同时存在用户本机的分区里 —— 不一起清掉，用户下次点「登录」时会因为
 *   分区里还留着旧账号而**直接免登录进去**，看起来像「退出了但没退掉」「换号换不了」。
 *
 * 两个入口共用这一个内核：
 *   1) 服务器下发 `logout` 指令（看板点退出、且助手在线）→ 立刻清；
 *   2) 助手状态面板的「清除登录态」按钮（助手当时不在线 / 想手动清）→ 点一下清。
 *
 * 清理范围：该分区的 Cookie / localStorage / IndexedDB / service worker / 缓存，
 *   并先关闭占用该分区的窗口（窗口开着的页面会把旧 Cookie 继续留在内存里）。
 *
 * 注意：分区是**按机器**存的，不是按账号。同一台电脑上多个账号都用过同一个登录窗口时，
 *   这里清掉的是这台机器上最后登录的那个账号的登录态 —— 界面上必须说清楚。
 */
const { session, BrowserWindow } = require('electron');

const TARGETS = {
  pdd: { partition: 'persist:pdd', label: '拼多多' },
  qnh: { partition: 'persist:qnh', label: '牵牛花' },
  1688: { partition: 'persist:1688', label: '1688' },
};

/** 把各种写法归一成 pdd / qnh / 1688；不认识返回 '' */
function normalizeTarget(target) {
  const k = String(target == null ? '' : target).trim().toLowerCase();
  if (k === 'pdd' || k === 'pinduoduo' || k === '拼多多') return 'pdd';
  if (k === 'qnh' || k === 'meituan' || k === '牵牛花') return 'qnh';
  if (k === '1688' || k === 'ali' || k === 'alibaba') return '1688';
  return '';
}

function alive(w) {
  try { return !!w && typeof w.isDestroyed === 'function' && !w.isDestroyed(); } catch (e) { return false; }
}

/**
 * 清掉某个站点在本机的登录态。
 * @param {string} target  pdd / qnh / 1688
 * @param {object} [opt]
 * @param {Array<()=>BrowserWindow|null>} [opt.windows] 占用该分区的窗口取回函数（先关再清）
 * @returns {Promise<{ok:boolean,target:string,label:string,cleared:number,remain:number,closedWindows:number,error:string}>}
 */
async function clearLoginState(target, opt) {
  const o = opt || {};
  const key = normalizeTarget(target);
  const t = TARGETS[key];
  if (!t) {
    return { ok: false, target: '', label: '', cleared: 0, remain: 0, closedWindows: 0, error: '不认识的登录目标：' + target };
  }

  // 1) 先关窗口：开着的页面会把旧 Cookie 继续留在内存里，下次打开还会「已登录」
  let closedWindows = 0;
  for (const get of (Array.isArray(o.windows) ? o.windows : [])) {
    let w = null;
    try { w = typeof get === 'function' ? get() : null; } catch (e) { w = null; }
    if (alive(w)) {
      try { w.destroy(); closedWindows += 1; } catch (e) { /* 忽略：关不掉也继续清 Cookie */ }
    }
  }

  const ses = session.fromPartition(t.partition);
  let cleared = 0;
  try { cleared = (await ses.cookies.get({})).length; } catch (e) { cleared = 0; }

  let error = '';
  try {
    // cookies / localstorage / indexdb / serviceworkers / cachestorage / websql 一次清干净
    await ses.clearStorageData();
  } catch (e) { error = 'clearStorageData 失败：' + ((e && e.message) || e); }
  // 缓存里可能存着「已登录」的页面快照，一并清掉（失败不影响登录态）
  try { await ses.clearCache(); } catch (e) { /* 忽略 */ }
  try { await ses.clearAuthCache(); } catch (e) { /* 忽略 */ }
  try { if (typeof ses.flushStorageData === 'function') ses.flushStorageData(); } catch (e) { /* 忽略 */ }

  let remain = 0;
  try { remain = (await ses.cookies.get({})).length; } catch (e) { remain = -1; }

  return {
    ok: !error && remain === 0,
    target: key,
    label: t.label,
    cleared,
    remain,
    closedWindows,
    error,
  };
}

/**
 * 供 main.js 注入给 ws-client：处理服务器下发的 `logout` 指令。
 * @param {object} o
 * @param {(s:string)=>void} [o.log]
 * @param {Record<string, Array<()=>BrowserWindow|null>>} [o.windows] 各目标要关掉的窗口
 */
function createLogoutHandler(o) {
  const opt = o || {};
  const log = opt.log || (() => {});
  const windowsOf = opt.windows || {};
  return async function handleLogout(task, api) {
    const key = normalizeTarget(task && task.target);
    const r = await clearLoginState(key, { windows: windowsOf[key] || [] });
    if (!r.ok) {
      log(`退出${r.label || '登录'}态失败：${r.error || ('还剩 ' + r.remain + ' 个 Cookie')}`);
      api.report({
        ok: false, target: r.target, label: r.label,
        error: r.error || ('仍有 ' + r.remain + ' 个 Cookie 未清掉'),
      });
      return;
    }
    log(`已退出本机${r.label}账号（关了 ${r.closedWindows} 个窗口）`);
    api.report({ ok: true, target: r.target, label: r.label, cleared: r.cleared, closedWindows: r.closedWindows });
  };
}

module.exports = { clearLoginState, createLogoutHandler, normalizeTarget, TARGETS };
