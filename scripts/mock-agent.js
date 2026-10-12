/**
 * scripts/mock-agent.js — 本机浏览器通道（方案C）的模拟客户端
 *
 * 用途：在没有安装浏览器扩展的情况下，验证「服务器编排 → 下发 → 回执 → 落库」整条链路。
 * 它做的事和真实扩展完全一样（连 /ws/agent、收 send_batch、回 sent），但不真的发消息。
 *
 * 用法：
 *   node scripts/mock-agent.js --code 123456
 *   node scripts/mock-agent.js --code 123456 --url http://localhost:8787 --fail   # 模拟全部失败
 *   node scripts/mock-agent.js --code 123456 --delay 800                          # 每条回执前等 800ms
 *
 * 配对码在看板「本机浏览器通道 → 生成配对码」里拿。
 */
const WebSocket = require('ws');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const CODE = arg('code', '');
const URL = (arg('url', 'http://localhost:8787') || '').replace(/\/+$/, '');
const FORCE_FAIL = process.argv.includes('--fail');
const DELAY_MS = Number(arg('delay', 400));

if (!CODE) { console.error('缺少 --code（在看板生成本机通道配对码）'); process.exit(1); }

const wsBase = URL.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
const ws = new WebSocket(`${wsBase}/ws/agent?code=${encodeURIComponent(CODE)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (o) => { try { ws.send(JSON.stringify(o)); } catch (e) { /* 忽略 */ } };

ws.on('open', () => {
  console.log(`[mock-agent] 已连接 ${wsBase}/ws/agent`);
  send({ type: 'hello', loggedIn: true, extVer: 'mock-1.0.0', ua: 'mock-agent', platform: process.platform });
});

ws.on('message', async (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
  if (m.type === 'ping') { send({ type: 'pong', t: Date.now() }); return; }
  if (m.type === 'ready') { console.log(`[mock-agent] 配对成功 uid=${m.uid}`); return; }
  if (m.type === 'stop') { console.log('[mock-agent] 收到停止指令'); return; }
  if (m.type === 'send_batch') {
    console.log(`[mock-agent] 收到批次 task#${m.taskId}：${m.sellers.length} 个卖家，间隔 ${m.gapMs.min}~${m.gapMs.max}ms`);
    for (const s of m.sellers) {
      await sleep(DELAY_MS);
      const ok = !FORCE_FAIL;
      console.log(`  → ${s.company || s.sellerLogin}: ${ok ? '发送成功' : '发送失败(模拟)'}（${(s.messages || []).length} 条消息）`);
      send({ type: 'sent', taskId: m.taskId, loginId: s.loginId, ok, error: ok ? undefined : 'mock-agent 模拟失败' });
    }
  }
});

ws.on('close', () => { console.log('[mock-agent] 连接已关闭'); process.exit(0); });
ws.on('error', (e) => { console.error('[mock-agent] 连接错误:', e.message); process.exit(2); });
