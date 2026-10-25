/**
 * lib/sender.js — 催收消息公共模块
 * 消息模板全部从 config.json 的 messages 段读取（可视化页面可编辑），此处仅提供默认值。
 *
 * ⚠ 2026-10-13 起，服务端浏览器发送已废除：发送只在用户本机浏览器执行（electron/agent/sender.js）。
 *   · buildMessages / DEFAULT_MESSAGES：仍在使用（服务器组装消息文本下发本机通道）
 *   · sendToSeller（服务端页面自动化引擎）：已退役，仅作为本机助手选择器对齐的参照保留
 *
 * ── 性能设计（2026-10-12 优化）──
 * 原实现的固定 sleep 使单家耗时约 45s：编辑器盲等 8s、每条消息发后盲等 2.5s、
 * 消息之间 3~5s（含最后一条）。现全部改为「条件满足即继续」的轮询：
 *   · 编辑器就绪：轮询 + 1.6s 稳定性确认，通常 3~5s（原来 ≥11s）
 *   · 消息发送确认：轮询聊天记录出现，通常 <1s（原来固定 2.5s）
 *   · 消息之间的拟人停顿只保留在「非最后一条」，缩短为 1.2~2.5s
 * 家与家之间的间隔由 config.runtime.sendGapMinSec / sendGapMaxSec 控制
 * （防限流的主开关，可在看板「配置」页调整），不在此文件内。
 * 功能不变：每条消息仍逐条发送并验证出现在聊天记录中，失败仍会重试一次。
 */
const path = require('path');
const { loadConfig } = require('./config');
const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn() 返回真值；超时返回 null。避免固定 sleep 造成的空耗。 */
/** 轮询直到 fn() 返回真值；超时返回 null。避免固定 sleep 造成的空耗。
 *  注意：必须用 try/catch 包住 fn 的「调用」——写成 Promise.resolve(fn()) 时，
 *  若 fn 同步抛错会在进入 Promise 之前逃逸，.catch 拦不到。同步抛错与 Promise
 *  拒绝统一按「未满足」继续重试。 */
async function waitFor(fn, { timeout = 6000, interval = 250 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 >= timeout) return null;
    await sleep(interval);
  }
}

const CHAT_URL = (sellerLoginId) =>
  `https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=cnalichn${encodeURIComponent(
    sellerLoginId
  )}&siteid=cnalichn&status=1`;

/** 默认消息配置（config.json 缺省时兜底） */
const DEFAULT_MESSAGES = {
  // 模板消息：{amount}=待开票总金额，{companyName}/{taxNo}/{email}=抬头信息
  template:
    '老板您好，以下订单是我在贵店下的所有待开票订单，所有订单已经在平台申请，但是迟迟没有开出来，帮忙尽快安排开票，开票总金额为{amount}元，抬头：{companyName}，税号：{taxNo}，邮箱：{email}',
  // 订单清单条目：{orderId}/{amount}
  orderItem: '订单号：{orderId} 金额：{amount}',
  // 清单分块上限（单条消息字数）
  orderChunkMax: 450,
  // 提醒消息（固定文案）
  reminder: '订单在线上后台都已提交申请！！！长时间未开出来，故发送消息提醒！！！都是交易完成的订单',
};

/** 取消息配置（config 覆盖默认值）
 *  ⚠ 空字符串/纯空白不能算「已配置」：曾出现 config.json 里 template/orderItem/reminder 全被写成 ""
 *    （配置页保存了空表单），合并后覆盖掉默认文案 → buildMessages 生成 3 条空消息 →
 *    助手在 1688 里点发送什么也发不出去，最终报「发送未确认（消息未出现在聊天记录）」。
 *    这里对空值一律回退默认，保证永远有可用文案。 */
function getMessagesConfig(config) {
  const raw = (config && config.messages) || {};
  const out = { ...DEFAULT_MESSAGES };
  for (const k of ['template', 'orderItem', 'reminder']) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  const chunk = Number(raw.orderChunkMax);
  if (Number.isFinite(chunk) && chunk > 0) out.orderChunkMax = chunk;
  return out;
}

/** 简单模板变量替换 */
function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/** 生成消息列表：①模板（总金额+抬头）②订单清单（可多块，单行分号分隔）③提醒 */
function buildMessages(seller, config) {
  const mc = getMessagesConfig(config);
  const b = (config && config.buyerInfo) || {};

  const msg1 = fillTemplate(mc.template, {
    amount: seller.amount.toFixed(2),
    companyName: b.companyName || '',
    taxNo: b.taxNo || '',
    email: b.email || '',
  });

  const items = seller.orders.map((o) => fillTemplate(mc.orderItem, { orderId: o.orderId, amount: o.amount }));
  const chunkMax = Number(mc.orderChunkMax) || 450;
  const orderMsgs = [];
  for (const item of items) {
    const last = orderMsgs[orderMsgs.length - 1];
    if (last && (last + '；' + item).length <= chunkMax) {
      orderMsgs[orderMsgs.length - 1] = last + '；' + item;
    } else {
      orderMsgs.push(item);
    }
  }

  // 空消息一律丢弃：发出去也没有内容，只会让助手在 1688 里空转并报「发送未确认」
  return [msg1, ...orderMsgs, mc.reminder]
    .map((m) => String(m == null ? '' : m).trim())
    .filter((m) => !!m);
}

const READY_MIN_SETTLE_MS = 2500; // 启动后最短总等待（让 IM 应用初始化，替代原来的盲等 8s）
const READY_STABLE_GAP_MS = 1600; // 编辑器就绪的稳定性确认间隔（frame 可能重建）
const READY_ROUND_MS = 15000;     // 每轮就绪判定上限，超时重载一次

/**
 * 打开卖家聊天窗并等待编辑器就绪。
 * 返回 { popup, getFrame, getEditor, readyMs }，由调用方负责 popup.close()。
 * 供 sendToSeller 与只读实测复用（实测只等就绪、不发消息）。
 */
async function openChatReady(context, sellerLoginId) {
  const t0 = Date.now();
  const popup = await context.newPage();
  /** 每次重新获取聊天 frame（页面加载中 iframe 会被销毁重建，不能缓存引用） */
  const getFrame = () => {
    try {
      return popup.frames().find((f) => f.url().includes('def_cbu_web_im_core')) || null;
    } catch (e) {
      return null;
    }
  };
  /** 探测编辑器是否出现。iframe 重建的瞬间引用会 detached 并抛错，一律视为「未就绪」继续轮询 */
  const getEditor = async () => {
    try {
      const f = getFrame();
      if (!f) return null;
      const e = f.locator('pre.edit[contenteditable="true"]');
      return (await e.count()) > 0 ? e : null;
    } catch (e) {
      return null;
    }
  };

  let ready = false;
  try {
    await popup.goto(CHAT_URL(sellerLoginId), { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
    await popup.bringToFront().catch(() => {}); // 后台进程开的窗口不抢焦点，聊天应用需要前台焦点才执行 touid 选中

    /** 被踢回登录页 → 立即失败，否则每个卖家都要空等一轮，整批被拖死且全失败 */
    const loginRedirected = () => /login\.1688\.com|signin/i.test(popup.url() || '');
    const assertLoggedIn = () => {
      if (loginRedirected()) throw new Error('登录态失效（已跳转登录页），请先重新登录 1688 后再发送');
    };

    // 轮询等待编辑器就绪（找到后 1.6s 再确认一次，确保 frame 不再重建）
    for (let round = 0; round < 3 && !ready; round++) {
      const tRound = Date.now();
      while (Date.now() - tRound < READY_ROUND_MS) {
        const e1 = await getEditor();
        if (e1) {
          await sleep(READY_STABLE_GAP_MS);
          if (await getEditor()) {
            const settle = READY_MIN_SETTLE_MS - (Date.now() - t0);
            if (settle > 0) await sleep(settle);
            ready = true;
            break;
          }
        } else {
          assertLoggedIn(); // 未就绪时先看是否被踢回登录页
          await sleep(400);
        }
      }
      if (!ready && round < 2) {
        assertLoggedIn();
        console.log('  聊天UI未就绪，重载...');
        await popup.reload({ waitUntil: 'commit', timeout: 60000 }).catch(() => {});
      }
    }
    if (!ready) throw new Error('聊天编辑器未出现');
    return { popup, getFrame, getEditor, readyMs: Date.now() - t0 };
  } catch (e) {
    await popup.close().catch(() => {});
    throw e;
  }
}

/** 打开聊天窗：逐条发送消息（①模板 ②订单清单 ③提醒），全部成功返回 true */
async function sendToSeller(context, seller, messages) {
  const { popup, getFrame, getEditor } = await openChatReady(context, seller.loginId);
  try {
    // 弹窗清理（点按钮），联系人点击和发消息前都要跑——引导弹窗会挡住列表点击。
    // 优化：先做一次轻量存在性检查，没有遮罩时直接返回（原来每条消息都做 4 组选择器往返）。
    const hasBlockingModal = async () => {
      const f = getFrame();
      if (!f) return false;
      return f
        .evaluate(() => {
          const sels = ['.ant-modal-wrap', '.ant-modal-mask'];
          return sels.some((s) =>
            [...document.querySelectorAll(s)].some((el) => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
            })
          );
        })
        .catch(() => false);
    };
    const dismissModals = async () => {
      if (!(await hasBlockingModal())) return; // 绝大多数情况：无弹窗，一次检查即返回
      const f = getFrame();
      if (!f) return;
      for (const sel of ['button:has-text("我知道了")', 'button:has-text("OK")', 'button:has-text("跳过")', '.ant-modal-close']) {
        try {
          const b = f.locator(sel).first();
          if ((await b.count()) > 0 && (await b.isVisible())) { await b.click({ timeout: 3000 }); await sleep(600); }
        } catch (e) {}
      }
      // 仍有遮罩挡住列表时，直接移除可见遮罩 DOM（营销/引导弹窗，不影响业务功能）
      try {
        await f.evaluate(() => {
          document.querySelectorAll('.ant-modal-wrap, .ant-modal-mask').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && getComputedStyle(el).display !== 'none') el.remove();
          });
        });
      } catch (e) {}
    };

    // 联系人选中保障：touid 自动选中不生效时，点击左侧会话列表里的目标联系人。
    // 判定=右侧空状态文案（"您尚未选择联系人"）消失；检测不确定时不拦截，仍尝试发送（发送本身会验证）。
    const isContactMissing = async () => {
      const f = getFrame();
      if (!f) return false;
      const n =
        (await f.getByText('您尚未选择联系人').count().catch(() => 0)) +
        (await f.getByText('请先选择联系人').count().catch(() => 0));
      return n > 0;
    };
    const ensureContact = async () => {
      // touid 自动选中通常在 1~3s 内完成：轮询确认（原来固定等 2s×8）
      const autoSelected = await waitFor(async () => (!(await isContactMissing()) ? true : null), { timeout: 8000, interval: 1000 });
      if (autoSelected) return true;
      // 未自动选中 → 清弹窗后点击会话列表里的目标联系人
      for (let attempt = 0; attempt < 3; attempt++) {
        console.log(`  [联系人未自动选中] 点击会话列表 (第${attempt + 1}次)...`);
        try {
          const f = getFrame();
          if (!f) throw new Error('frame丢失');
          await dismissModals();
          const item = f.getByText(seller.loginId, { exact: true }).first();
          if ((await item.count()) > 0) {
            await item.click({ timeout: 8000 });
            const ok = await waitFor(async () => (!(await isContactMissing()) ? true : null), { timeout: 8000, interval: 1000 });
            if (ok) { console.log('  [已选中联系人]'); return true; }
          } else {
            console.log('  [会话列表中未找到该联系人名]');
            try {
              const dump = await f.evaluate(() => document.body.innerText.slice(0, 800));
              console.log('  [现场转储]', dump.replace(/\n+/g, '|').slice(0, 500));
            } catch (e) {}
            break;
          }
        } catch (e) { console.log('  [点击联系人失败]', e.message.split('\n')[0]); }
        await sleep(2000);
      }
      console.log('  [警告] 选中状态未确认，仍尝试发送（发送结果将验证）');
      return true; // best effort：不拦截，让发送流程做最终验证
    };
    await ensureContact();

    // 发送单条消息（带一次重试）——insertText 整体插入（type 的\n会被当回车逐行发送）
    const sendMessage = async (msg) => {
      // 验证片段：消息尾部30字（含订单号/金额，唯一性强）
      const fragment = msg.length > 30 ? msg.slice(-30) : msg;
      const appearsInHistory = async () => {
        const f = getFrame();
        if (!f) return false;
        return f
          .evaluate((frag) => [...document.querySelectorAll('pre.edit')].some((e) => (e.innerText || '').includes(frag)), fragment)
          .catch(() => false);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await dismissModals();
          const editor = await getEditor();
          if (!editor) throw new Error('编辑器丢失');
          await editor.click({ timeout: 15000 });
          // 清空残留草稿（未选中联系人期间可能已插入过文本）
          const existing = (await editor.innerText().catch(() => '')).trim();
          if (existing) {
            await popup.keyboard.press('Control+a');
            await popup.keyboard.press('Delete');
            await sleep(200);
          }
          await popup.keyboard.insertText(msg);
          // 输入验证：编辑器必须有内容（防止空消息发出）——轮询确认，替代固定 0.5~1s 盲等。
          // 优先匹配开头片段；若编辑器对文本做了规范化，只要非空也放行（与原实现同等宽容）。
          const head = msg.slice(0, 20);
          const typed = await waitFor(
            async () => {
              const cur = (await editor.innerText().catch(() => '')) || '';
              if (cur.includes(head)) return 'exact';
              return cur.trim() ? 'present' : null;
            },
            { timeout: 3000, interval: 120 }
          );
          if (!typed) throw new Error('消息未成功输入编辑器');
          const f = getFrame();
          await f.locator('button.send-btn').first().click({ timeout: 10000 });
          // 最终验证：消息出现在聊天记录里——轮询确认（通常 <1s），替代固定 2.5s 盲等
          if (await waitFor(appearsInHistory, { timeout: 6000, interval: 250 })) return true;
          await editor.press('Enter');
          if (await waitFor(appearsInHistory, { timeout: 3000, interval: 250 })) return true;
          // 失败截图留证（排查用）
          try {
            const dbg = path.join(ROOT, 'data', `send-fail-${Date.now()}.png`);
            await popup.screenshot({ path: dbg });
            console.log(`  [诊断截图] ${require('path').basename(dbg)}`);
          } catch (e) {}
          throw new Error('发送未确认（消息未出现在聊天记录）');
        } catch (e) {
          if (attempt === 1) throw e;
          console.log(`  重试发送: ${e.message.split('\n')[0]}`);
          await sleep(2000);
        }
      }
      return false;
    };

    // messages 已含全部消息（模板+清单+提醒，buildMessages 生成）
    for (let i = 0; i < messages.length; i++) {
      const ok = await sendMessage(messages[i]);
      if (!ok) throw new Error(`第${i + 1}/${messages.length}条消息发送失败`);
      // 拟人停顿只保留在「非最后一条」之间（最后一条发完即关页，无需再等）
      if (i < messages.length - 1) await sleep(1200 + Math.random() * 1300);
    }
    return true;
  } finally {
    await popup.close().catch(() => {});
  }
}

module.exports = { buildMessages, sendToSeller, openChatReady, waitFor, getMessagesConfig, DEFAULT_MESSAGES, CHAT_URL };
