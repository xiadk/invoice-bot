/**
 * lib/browser.js — 公共浏览器会话管理（多用户）
 *
 * 原则：
 *  1. 每个用户的登录态独立（互不干扰）：默认从数据库取（login_state，见 lib/state-store.js），
 *     也兼容历史文件 data/users/<user_id>/state-1688.json 与单用户时期 data/state-1688.json
 *  2. 生产任务默认有头模式（headless:false，风控特征更低）；云部署自动切无头
 *     （见 resolveHeadless：Linux 无 DISPLAY 即无头），无需服务器有显示器
 *  3. 所有动作间加随机抖动，拟人节奏
 *
 * 登录态获取顺序（launch）：options.storageState 对象 > options.statePath 文件 > 无
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DEFAULT_STATE_PATH = path.join(ROOT, 'data', 'state-1688.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('未找到 config.json。请先复制 config.example.json 为 config.json 并填写。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

/**
 * 是否处于「没有图形界面」的环境（云服务器 / Docker / CI）。
 * Windows、macOS 一律视为有桌面；Linux 看有没有 DISPLAY / WAYLAND_DISPLAY。
 */
function hasDisplay() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * 是否使用无头模式，优先级：
 *   显式参数 explicit > 环境变量 HEADLESS > config.runtime.headless > 自动判断
 * 自动判断：没有图形界面（云服务器）→ 无头；有桌面 → 有头（风控特征更低）。
 * 这样同一份代码本地跑是有头的，部署到云服务器会自动切到无头，无需改配置。
 */
function resolveHeadless(explicit, runtime) {
  if (explicit !== undefined) return !!explicit;
  const env = process.env.HEADLESS;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  if (runtime && runtime.headless !== undefined) return !!runtime.headless;
  return !hasDisplay();
}

function hasSavedState(statePath) {
  return fs.existsSync(statePath || DEFAULT_STATE_PATH);
}

/**
 * 启动浏览器并尝试恢复登录态。
 * @param {object} [options]
 * @param {boolean} [options.headless]  覆盖无头设置
 * @param {object}  [options.storageState] 登录态对象（{cookies, origins}）。传了它就直接用，
 *                                          不再读文件——这是「登录态入库」后的主路径
 * @param {string}  [options.statePath] 该用户的登录态文件（storageState），作为兼容/兜底
 * @param {object}  [options.config]    已读取的配置（避免重复读盘）
 * @param {object}  [options.viewport]  视口大小
 * @param {string}  [options.userAgent] 自定义 UA
 */
async function launch(options) {
  const o = options || {};
  const config = o.config || loadConfig();
  const runtime = config.runtime || {};
  const useHeadless = resolveHeadless(o.headless, runtime);
  const statePath = o.statePath || DEFAULT_STATE_PATH;

  // 容器 / 云服务器友好参数：沙箱、共享内存、隐藏滚动条、软件渲染
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
  ];
  if (useHeadless) args.push('--disable-gpu', '--use-gl=swiftshader');

  const browser = await chromium.launch({ headless: useHeadless, args });
  const contextOptions = {
    viewport: o.viewport || { width: 1440, height: 900 },
    userAgent: o.userAgent || UA,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
  };
  // Playwright 的 storageState 既可传对象也可传文件路径。优先用调用方给的对象（来自数据库），
  // 其次回退到磁盘文件（历史遗留 / CLI 脚本）。
  let stateFrom = 'none';
  if (o.storageState && typeof o.storageState === 'object') {
    contextOptions.storageState = o.storageState;
    stateFrom = 'object';
  } else if (hasSavedState(statePath)) {
    contextOptions.storageState = statePath;
    stateFrom = 'file';
  }
  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(runtime.navigationTimeoutMs || 60000);
  return { browser, context, config, statePath, stateFrom };
}

/** 保存登录态 */
async function saveState(context, statePath) {
  const target = statePath || DEFAULT_STATE_PATH;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await context.storageState({ path: target });
  console.log(`[ok] 登录态已保存: ${target}`);
  return target;
}

/** 检测当前页是否处于已登录状态（简单方式：url 未跳回登录页） */
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
  const hi = maxMs !== undefined ? maxMs : r.minActionGapMs ? r.maxActionGapMs || 2500 : 2500;
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

module.exports = {
  launch, saveState, isLoggedIn, humanPause, waitHuman, loadConfig,
  hasSavedState, resolveHeadless, hasDisplay,
  STATE_PATH: DEFAULT_STATE_PATH, DEFAULT_STATE_PATH, ROOT,
};
