/**
 * lib/browser.js — 公共浏览器会话管理
 *
 * 原则：
 *  1. 登录态存本地 data/state-1688.json，凭据只存 config.json，都不进代码、不进聊天记录
 *  2. 生产任务用有头模式（headless:false），风控特征更低
 *  3. 所有动作间加随机抖动，拟人节奏
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'data', 'state-1688.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('未找到 config.json。请先复制 config.example.json 为 config.json 并填写。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function hasSavedState() {
  return fs.existsSync(STATE_PATH);
}

/** 启动浏览器并尝试恢复登录态 */
async function launch({ headless } = {}) {
  const config = loadConfig();
  const runtime = config.runtime || {};
  const useHeadless = headless !== undefined ? headless : (runtime.headless !== undefined ? runtime.headless : false);

  const browser = await chromium.launch({ headless: useHeadless });
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  };
  if (hasSavedState()) {
    contextOptions.storageState = STATE_PATH;
  }
  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(runtime.navigationTimeoutMs || 60000);
  return { browser, context, config };
}

/** 保存登录态 */
async function saveState(context) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  await context.storageState({ path: STATE_PATH });
  console.log(`[ok] 登录态已保存: ${STATE_PATH}`);
}

/** 检测当前页是否处于已登录状态（简单方式：url 未跳回登录页 + 页面含买家工作台特征） */
async function isLoggedIn(page) {
  const url = page.url();
  if (/login\.1688\.com|signin/i.test(url)) return false;
  return true;
}

/** 拟人等待：随机抖动区间（Node 侧 sleep，不依赖 page API） */
function humanPause(page, minMs, maxMs) {
  const config = loadConfig();
  const r = config.runtime || {};
  const lo = minMs !== undefined ? minMs : r.minActionGapMs || 800;
  const hi = maxMs !== undefined ? maxMs : r.maxActionGapMs || 2500;
  const gap = lo + Math.random() * (hi - lo);
  return new Promise((resolve) => setTimeout(resolve, gap));
}

/** 等待人工介入（验证码/滑块/扫码），控制台回车后继续 */
function waitHuman(message) {
  return new Promise((resolve) => {
    console.log(`\n>>> 需要人工操作: ${message}`);
    console.log('>>> 完成后回到此窗口按 Enter 继续...');
    process.stdin.once('data', () => resolve());
  });
}

module.exports = { launch, saveState, isLoggedIn, humanPause, waitHuman, loadConfig, STATE_PATH, ROOT };
