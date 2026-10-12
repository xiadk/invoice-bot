/**
 * lib/sender.js — 催收消息公共模块（CLI 与 dashboard 共用）
 * 消息模板全部从 config.json 的 messages 段读取（可视化页面可编辑），此处仅提供默认值。
 */
const { launch, loadConfig } = require('./browser');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 取消息配置（config 覆盖默认值） */
function getMessagesConfig(config) {
  return { ...DEFAULT_MESSAGES, ...((config && config.messages) || {}) };
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

  return [msg1, ...orderMsgs, mc.reminder];
}

/** 打开聊天窗：逐条发送消息（①模板 ②订单清单 ③提醒），全部成功返回 true
 *  逻辑与 CLI（send-messages.js）验证过的版本一致：安静等编辑器就绪，不干预页面加载过程。
 */
async function sendToSeller(context, seller, messages) {
  const popup = await context.newPage();
  try {
    const url = CHAT_URL(seller.loginId);
    await popup.goto(url, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
    await popup.bringToFront().catch(() => {}); // 后台进程开的窗口不抢焦点，聊天应用需要前台焦点才执行 touid 选中

    /** 每次重新获取聊天 frame（页面加载中 iframe 会被销毁重建，不能缓存引用） */
    const getFrame = () => popup.frames().find((f) => f.url().includes('def_cbu_web_im_core'));
    const getEditor = async () => {
      const f = getFrame();
      if (!f) return null;
      const e = f.locator('pre.edit[contenteditable="true"]');
      return (await e.count()) > 0 ? e : null;
    };

    // 等编辑器就绪且稳定（连续两次3秒间隔都能找到，说明frame不再重建）——与CLI一致，期间不做任何干预
    let ready = false;
    outer:
    for (let round = 0; round < 3; round++) {
      await sleep(8000);
      for (let i = 0; i < 10; i++) {
        const e1 = await getEditor();
        if (e1) {
          await sleep(3000);
          const e2 = await getEditor();
          if (e2) { ready = true; break outer; }
        }
        await sleep(2000);
      }
      console.log('  聊天UI未就绪，重载...');
      await popup.reload({ waitUntil: 'commit', timeout: 60000 }).catch(() => {});
    }
    if (!ready) throw new Error('聊天编辑器未出现');

    // 弹窗清理（点按钮），联系人点击和发消息前都要跑——引导弹窗会挡住列表点击
    const dismissModals = async () => {
      const f = getFrame();
      if (!f) return;
      for (const sel of ['button:has-text("我知道了")', 'button:has-text("OK")', 'button:has-text("跳过")', '.ant-modal-close']) {
        try {
          const b = f.locator(sel).first();
          if ((await b.count()) > 0 && (await b.isVisible())) { await b.click({ timeout: 3000 }); await sleep(1000); }
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
      // 最多等 15s 看自动选中是否发生
      for (let i = 0; i < 8; i++) {
        if (!(await isContactMissing())) return true;
        await sleep(2000);
      }
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
            for (let i = 0; i < 4; i++) {
              await sleep(2000);
              if (!(await isContactMissing())) { console.log('  [已选中联系人]'); return true; }
            }
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
          await sleep(400);
          // 清空残留草稿（未选中联系人期间可能已插入过文本）
          const existing = (await editor.innerText().catch(() => '')).trim();
          if (existing) {
            await popup.keyboard.press('Control+a');
            await popup.keyboard.press('Delete');
            await sleep(300);
          }
          await popup.keyboard.insertText(msg);
          await sleep(500 + Math.random() * 500);
          // 输入验证：编辑器必须有内容（防止空消息发出）
          const typed = (await editor.innerText().catch(() => '')).trim();
          if (!typed) throw new Error('消息未成功输入编辑器');
          const f = getFrame();
          await f.locator('button.send-btn').first().click({ timeout: 10000 });
          await sleep(2500);
          // 最终验证：消息出现在聊天记录里
          if (await appearsInHistory()) return true;
          await editor.press('Enter');
          await sleep(2000);
          if (await appearsInHistory()) return true;
          // 失败截图留证（排查用）
          try {
            const dbg = require('path').join(require('./browser').ROOT, 'data', `send-fail-${Date.now()}.png`);
            await popup.screenshot({ path: dbg });
            console.log(`  [诊断截图] ${require('path').basename(dbg)}`);
          } catch (e) {}
          throw new Error('发送未确认（消息未出现在聊天记录）');
        } catch (e) {
          if (attempt === 1) throw e;
          console.log(`  重试发送: ${e.message.split('\n')[0]}`);
          await sleep(3000);
        }
      }
      return false;
    };

    // messages 已含全部消息（模板+清单+提醒，buildMessages 生成）
    for (let i = 0; i < messages.length; i++) {
      const ok = await sendMessage(messages[i]);
      if (!ok) throw new Error(`第${i + 1}/${messages.length}条消息发送失败`);
      await sleep(3000 + Math.random() * 2000);
    }
    return true;
  } finally {
    await popup.close().catch(() => {});
  }
}

module.exports = { buildMessages, sendToSeller, getMessagesConfig, DEFAULT_MESSAGES, CHAT_URL };
