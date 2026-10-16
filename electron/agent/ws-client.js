/**
 * electron/agent/ws-client.js — 与服务器 /ws/agent 的长连接客户端（纯 Node，便于单测）
 *
 * 移植自旧浏览器扩展的 background.js（原 MV3 Service Worker 版本，扩展通道 2026-10-14 已下线），改动：
 *   · WebSocket 用 ws 包（Node）而非浏览器原生
 *   · chrome.storage.local → 由调用方注入的 store
 *   · chrome.alarms 保活 → setInterval（桌面程序常驻，不再受 SW 被杀之苦）
 *   · chrome.tabs.sendMessage → 由注入的 batchHandler 承担（见 agent/sender.js）
 *
 * 协议（与服务器一致，未做任何服务端改动）：
 *   上行: hello | pong | log | sent | client_stop | login_state
 *   下行: ping | ready | send_batch | stop | task_progress
 *
 * 安全：连/收/发都只走服务器；不接触 1688 凭据。
 */
const EventEmitter = require('events');
const WebSocket = require('ws');

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const HELLO_TIMEOUT_MS = 15000;

function toWsBase(httpUrl) {
  return String(httpUrl || '').trim().replace(/\/+$/, '')
    .replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

class AgentClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.serverUrl     服务器地址（http/https）
   * @param {string} o.deviceToken   设备令牌（64hex）
   * @param {string} [o.version]     助手版本号
   * @param {string} [o.os]          操作系统标识
   * @param {(s:string)=>void} [o.log]
   */
  constructor(o) {
    super();
    this.serverUrl = o.serverUrl || '';
    this.deviceToken = o.deviceToken || '';
    this.version = o.version || '0.0.0';
    this.os = o.os || process.platform;
    this.log = o.log || (() => {});

    this.ws = null;
    this.ready = false;
    this.sending = false;
    this.loggedIn = false;
    this.stopFlag = false;
    this.currentTaskId = null;
    this._reconnectTimer = null;
    this._reconnectDelay = RECONNECT_MIN_MS;
    this._stopped = false;
    this._batchHandler = null;
    this._helloTimer = null;
  }

  /** 连接地址（供测试断言） */
  url() {
    if (!this.serverUrl || !this.deviceToken) return '';
    return `${toWsBase(this.serverUrl)}/ws/agent?device=${encodeURIComponent(this.deviceToken)}`;
  }

  /** 注入批次处理器：async (task, api) => void，api 见 _runBatch */
  setBatchHandler(fn) { this._batchHandler = fn; }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._helloTimer);
    this._reconnectTimer = null;
    try { if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); } } catch (e) { /* 忽略 */ }
    this.ws = null;
    this._setReady(false);
  }

  /** 更新凭证并重连（绑定/换绑后调用） */
  rebind({ serverUrl, deviceToken }) {
    if (serverUrl) this.serverUrl = serverUrl;
    if (deviceToken) this.deviceToken = deviceToken;
    this.log('凭证已更新，重连中…');
    this.stop();
    this.start();
  }

  state() {
    return {
      connected: !!(this.ws && this.ws.readyState === 1),
      ready: this.ready,
      sending: this.sending,
      loggedIn: this.loggedIn,
      userId: null,
      serverUrl: this.serverUrl,
      version: this.version,
    };
  }

  send(obj) {
    try {
      if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /** 上报登录态（变化时才发） */
  reportLoginState(loggedIn, url) {
    if (this.loggedIn === !!loggedIn) return false;
    this.loggedIn = !!loggedIn;
    this.send({ type: 'login_state', loggedIn: this.loggedIn, url: url || '' });
    this._emitState();
    return true;
  }

  // ── 内部 ──
  _emitState() { this.emit('state', this.state()); }

  _setReady(v) {
    if (this.ready === v) return;
    this.ready = v;
    this._emitState();
  }

  _connect() {
    const url = this.url();
    if (!url) { this.log('缺少服务器地址或设备令牌，未连接'); return; }
    if (this._stopped) return;
    try { if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); } } catch (e) { /* 忽略 */ }

    this.ws = new WebSocket(url);
    this._helloTimer = setTimeout(() => {
      if (!this.ready) { this.log('hello 超时，重连'); try { this.ws.close(); } catch (e) {} }
    }, HELLO_TIMEOUT_MS);

    this.ws.on('open', () => {
      this._reconnectDelay = RECONNECT_MIN_MS;
      this.emit('connected');
      this._emitState();
      this.send({ type: 'hello', loggedIn: this.loggedIn, ua: `xsh-agent/${this.version} (${this.os})`, agentVer: this.version, os: this.os });
    });
    this.ws.on('message', (raw) => {
      let m = null;
      try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      this._onMessage(m);
    });
    this.ws.on('close', (code, reason) => {
      clearTimeout(this._helloTimer);
      this._setReady(false);
      this.emit('disconnected', { code, reason: reason && reason.toString() });
      this._emitState();
      if (!this._stopped) this._scheduleReconnect();
    });
    this.ws.on('error', (e) => { this.log('WS 错误: ' + e.message); /* close 会跟进 */ });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const d = this._reconnectDelay;
    this._reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(d * 1.6));
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._connect(); }, d);
  }

  _onMessage(m) {
    if (!m || !m.type) return;
    if (m.type === 'ping') { this.send({ type: 'pong', t: Date.now() }); return; }
    if (m.type === 'ready') { clearTimeout(this._helloTimer); this._setReady(true); this.emit('ready', m); return; }
    if (m.type === 'send_batch') { this._runBatch(m).catch((e) => this.log('批次异常: ' + e.message)); return; }
    if (m.type === 'export_orders') { this._runExport(m).catch((e) => this.log('订单导出异常: ' + e.message)); return; }
    if (m.type === 'stop') { this.stopFlag = true; this.log('收到停止指令：当前步骤完成后即停'); return; }
    if (m.type === 'task_progress') { this.emit('progress', m); return; }
  }

  /**
   * 执行一批发送（编排在此，实际发送交给注入的 batchHandler）。
   * api 提供给处理器：
   *   report(loginId, ok, error)  回报单个卖家结果（内部即上报服务器）
   *   log(text)                   上报一行日志
   *   isStopped()                 是否已要求停止
   *   sleep(ms)                   可被停止打断的等待
   */
  async _runBatch(m) {
    if (this.sending) { this.send({ type: 'log', text: '已有批次在执行，忽略新任务' }); return; }
    const sellers = Array.isArray(m.sellers) ? m.sellers : [];
    this.sending = true;
    this.stopFlag = false;
    this.currentTaskId = m.taskId;
    this._emitState();

    const api = {
      report: (loginId, ok, error) => {
        this.send({ type: 'sent', taskId: m.taskId, loginId, ok, error: ok ? undefined : error });
      },
      log: (text) => this.send({ type: 'log', text: String(text == null ? '' : text).slice(0, 200) }),
      isStopped: () => this.stopFlag,
      sleep: async (ms) => {
        for (let waited = 0; waited < ms && !this.stopFlag; waited += 300) {
          await new Promise((r) => setTimeout(r, Math.min(300, ms - waited)));
        }
      },
      gapMs: m.gapMs || { min: 20000, max: 35000 },
    };

    try {
      if (typeof this._batchHandler === 'function') {
        await this._batchHandler(m, api);
      } else {
        for (const s of sellers) api.report(s.loginId, false, '助手未实现发送内核');
      }
    } catch (e) {
      this.log('批次执行异常: ' + (e.message || e));
      for (const s of sellers) {
        if (!s._done) api.report(s.loginId, false, '批次异常中断');
      }
    } finally {
      this.sending = false;
      this.currentTaskId = null;
      this.stopFlag = false;
      this._emitState();
    }
  }

  /** 注册「导出1688订单」处理器（main.js 注入 order-export 模块） */
  setExportHandler(fn) { this._exportHandler = fn; }

  /**
   * 执行一次「导出1688订单」任务。api 与 _runBatch 同构：
   *   log(text) / isStopped() / sleep(ms)
   * 完成或失败都必须回报 export_done（上传文件走 HTTP，不在此通道传字节）。
   */
  async _runExport(m) {
    if (this.sending) {
      this.send({ type: 'export_done', taskId: m.taskId, ok: false, error: '正在发送催收消息，请等发送完成后再导入订单' });
      return;
    }
    this.sending = true;
    this.stopFlag = false;
    this._emitState();
    const api = {
      log: (text) => this.send({ type: 'export_log', taskId: m.taskId, text: String(text == null ? '' : text).slice(0, 300) }),
      isStopped: () => this.stopFlag,
      sleep: async (ms) => {
        for (let waited = 0; waited < ms && !this.stopFlag; waited += 300) {
          await new Promise((r) => setTimeout(r, Math.min(300, ms - waited)));
        }
        if (this.stopFlag) throw new Error('已被停止');
      },
    };
    try {
      if (typeof this._exportHandler === 'function') {
        await this._exportHandler(m, api);
      } else {
        throw new Error('助手版本过旧，不支持导入1688订单数据，请重新下载安装助手');
      }
    } catch (e) {
      this.send({ type: 'export_done', taskId: m.taskId, ok: false, error: e.message || String(e) });
    } finally {
      this.sending = false;
      this.stopFlag = false;
      this._emitState();
    }
  }
}

module.exports = { AgentClient, toWsBase };
