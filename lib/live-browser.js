/**
 * lib/live-browser.js — 云端浏览器「实时登录」会话
 *
 * 解决的问题：多用户 / 云部署时，登录 1688 需要人工扫码或输账号，但服务器往往没有显示器。
 * 做法：在服务器上跑一个 Chromium（无头即可），用 CDP 的 Page.startScreencast 把画面
 *       持续推给看板页面的 WebSocket；用户在网页里看到实时画面并用鼠标/键盘操作，
 *       输入事件通过 Input.dispatchMouseEvent / Input.insertText / Input.dispatchKeyEvent
 *       回灌到浏览器。登录完成后把 storageState 存到该用户自己的登录态文件，
 *       之后发催收消息复用，无需再次登录。
 *
 * 每个用户同时只保留一个会话（由调用方按 userId 管理）。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { launch: launchFromConfig } = require('./browser');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORT = { width: 1280, height: 800 };

/** 非打印键的 CDP 参数映射 */
const SPECIAL_KEYS = {
  Enter: { code: 'Enter', vk: 13 },
  NumpadEnter: { code: 'NumpadEnter', vk: 13 },
  Backspace: { code: 'Backspace', vk: 8 },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  Space: { code: 'Space', vk: 32, text: ' ' },
};

class LiveBrowser {
  /**
   * @param {object} opts
   * @param {number} opts.userId          所属用户（决定登录态文件位置）
   * @param {string} opts.statePath       该用户的 storageState 文件
   * @param {object} [opts.config]        已读取的配置
   * @param {boolean} [opts.headless]     是否无头（云部署默认无头）
   * @param {(data:object)=>void} opts.onEvent 事件回调（frame/status/log/page）
   */
  constructor(opts) {
    this.userId = opts.userId;
    this.statePath = opts.statePath;
    this.config = opts.config;
    this.headless = opts.headless;
    this.onEvent = opts.onEvent || (() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    this.client = null;
    this.startedAt = null;
    this.lastActiveAt = Date.now();
    this.closing = false;
    this._screencastOn = false;
    this._pageHandler = null;
  }

  emit(obj) { try { this.onEvent(obj); } catch (e) { /* 忽略 */ } }
  log(text) { this.emit({ type: 'log', text }); }

  get url() {
    try { return this.page ? this.page.url() : ''; } catch (e) { return ''; }
  }

  get loggedIn() {
    const u = this.url;
    return !!u && !/login\.1688\.com|signin/i.test(u);
  }

  /** 启动浏览器并打开目标页 */
  async start(startUrl) {
    const launched = await launchFromConfig({
      headless: this.headless !== undefined ? this.headless : true,
      statePath: this.statePath,
      config: this.config,
      viewport: VIEWPORT,
    });
    this.browser = launched.browser;
    this.context = launched.context;
    this.startedAt = new Date().toISOString();
    this.log('浏览器已启动，正在打开登录页…');

    // 登录过程中可能弹出新窗口（扫码窗/授权窗），自动跟随最新页面
    this._pageHandler = (p) => {
      this.attachPage(p).catch(() => {});
    };
    this.context.on('page', this._pageHandler);

    this.page = await this.context.newPage();
    this.attachPage(this.page).catch(() => {});
    const url = startUrl || (this.config && this.config.platforms && this.config.platforms['1688']
      && this.config.platforms['1688'].loginUrl) || 'https://login.1688.com/member/signin.htm';
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    return this;
  }

  /** 把某个页面设为当前受控页面并（重新）开始推流 */
  async attachPage(page) {
    if (this.closing) return;
    try {
      if (this.client) { await this.client.detach().catch(() => {}); this.client = null; }
      this._screencastOn = false;
      this.page = page;
      if (this.page.isClosed && this.page.isClosed()) return;
      // 页面关闭时回退到其它仍打开的页面
      page.on('close', () => {
        if (this.page === page && !this.closing) {
          const others = this.context.pages().filter((p) => p !== page && !p.isClosed());
          if (others.length) this.attachPage(others[others.length - 1]).catch(() => {});
        }
      });
      this.client = await this.context.newCDPSession(page);
      await this.startScreencast();
      this.emit({ type: 'status', url: this.url, loggedIn: this.loggedIn });
    } catch (e) {
      this.log('切换页面失败: ' + e.message.split('\n')[0]);
    }
  }

  async startScreencast() {
    if (!this.client || this._screencastOn) return;
    this._screencastOn = true;
    this.client.on('Page.screencastFrame', async (evt) => {
      this.lastActiveAt = Date.now();
      this.emit({ type: 'frame', data: evt.data, w: VIEWPORT.width, h: VIEWPORT.height });
      try { await this.client.send('Page.screencastFrameAck', { sessionId: evt.sessionId }); } catch (e) { /* 忽略 */ }
    });
    this.client.on('Page.frameNavigated', () => {
      this.emit({ type: 'status', url: this.url, loggedIn: this.loggedIn });
    });
    await this.client.send('Page.enable').catch(() => {});
    await this.client.send('Page.startScreencast', {
      format: 'jpeg', quality: 62, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
    }).catch((e) => this.log('推流启动失败: ' + e.message.split('\n')[0]));
  }

  /** 导航到指定地址 */
  async navigate(url) {
    this.lastActiveAt = Date.now();
    if (!this.page) return;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => this.log('导航失败: ' + e.message.split('\n')[0]));
  }

  /** 鼠标事件：坐标为 0~1 的归一化值，按视口换算 */
  async mouse(evt) {
    this.lastActiveAt = Date.now();
    if (!this.client) return;
    const x = Math.round(Math.max(0, Math.min(1, Number(evt.x) || 0)) * VIEWPORT.width);
    const y = Math.round(Math.max(0, Math.min(1, Number(evt.y) || 0)) * VIEWPORT.height);
    const button = evt.button || 'left';
    const base = { x, y };
    try {
      switch (evt.action) {
        case 'move':
          await this.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
          break;
        case 'down':
          await this.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...base });
          break;
        case 'up':
          await this.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...base });
          break;
        case 'click':
          await this.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount: 1, ...base });
          await this.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount: 1, ...base });
          break;
        case 'wheel':
          await this.client.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', ...base, deltaX: Number(evt.deltaX) || 0, deltaY: Number(evt.deltaY) || 0,
          });
          break;
        default:
          break;
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 键盘：{action:'text', text} 直接插入文本；{action:'key', key} 发送功能键 */
  async key(evt) {
    this.lastActiveAt = Date.now();
    if (!this.client) return;
    try {
      if (evt.action === 'text' && evt.text) {
        await this.client.send('Input.insertText', { text: String(evt.text) });
        return;
      }
      if (evt.action === 'key' && evt.key) {
        const spec = SPECIAL_KEYS[evt.key];
        const params = {
          key: evt.key,
          code: spec ? spec.code : evt.key,
          windowsVirtualKeyCode: spec ? spec.vk : 0,
          nativeVirtualKeyCode: spec ? spec.vk : 0,
        };
        if (spec && spec.text) { params.text = spec.text; params.unmodifiedText = spec.text; }
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 手动触发立即保存登录态（用户点「保存登录态」时） */
  async saveState() {
    if (!this.context) throw new Error('浏览器未启动');
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    await this.context.storageState({ path: this.statePath });
    this.log('登录态已保存到本地');
    return this.statePath;
  }

  /** 关闭浏览器与推流 */
  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      if (this._pageHandler && this.context) this.context.off('page', this._pageHandler);
    } catch (e) { /* 忽略 */ }
    try { if (this.client) await this.client.send('Page.stopScreencast').catch(() => {}); } catch (e) { /* 忽略 */ }
    try { if (this.client) await this.client.detach().catch(() => {}); } catch (e) { /* 忽略 */ }
    this.client = null;
    try { if (this.browser) await this.browser.close(); } catch (e) { /* 忽略 */ }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  status() {
    return {
      active: !!this.browser,
      url: this.url,
      loggedIn: this.loggedIn,
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
    };
  }
}

module.exports = { LiveBrowser, VIEWPORT };
