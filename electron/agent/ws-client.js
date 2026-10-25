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
    this._qnhBusy = false;
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

  /** 是否有任务在跑（清登录态必须等任务结束，否则会把正在用的窗口关掉） */
  busy() {
    return {
      sending: !!this.sending,
      pdd: !!this._pddBusy,
      qnh: !!this._qnhBusy,
      any: !!(this.sending || this._pddBusy || this._qnhBusy),
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
    if (m.type === 'qnh_login') { this._runQnhLogin(m).catch((e) => this.log('牵牛花登录异常: ' + e.message)); return; }
    if (m.type === 'qnh_fetch') { this._runQnhFetch(m).catch((e) => this.log('牵牛花页内请求异常: ' + e.message)); return; }
    if (m.type === 'pdd_login') { this._runPddLogin(m).catch((e) => this.log('拼多多登录异常: ' + e.message)); return; }
    if (m.type === 'pdd_apply') { this._runPddApply(m).catch((e) => this.log('拼多多申请异常: ' + e.message)); return; }
    if (m.type === 'pdd_send') { this._runPddSend(m).catch((e) => this.log('拼多多催收异常: ' + e.message)); return; }
    if (m.type === 'logout') { this._runLogout(m).catch((e) => this.log('清除登录态异常: ' + e.message)); return; }
    if (m.type === 'stop') {
      this.stopFlag = true;
      this.log('收到停止指令：正在中止当前步骤（不会再发新的消息）');
      return;
    }
    // 服务端体检结论：本版本过旧 → 交 main.js 弹更新横幅（只是提示，拦不拦由服务端按宽限期决定）
    if (m.type === 'require_update') { this.emit('require_update', m); return; }
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

  /** 注册「登录牵牛花」处理器（main.js 注入 qnh-login 模块） */
  setQnhLoginHandler(fn) { this._qnhLoginHandler = fn; }

  /** 注册「牵牛花页内签名请求」处理器（main.js 注入 qnh-login.createFetchHandler） */
  setQnhFetchHandler(fn) { this._qnhFetchHandler = fn; }

  /** 注册「登录拼多多」处理器（main.js 注入 pdd-login 模块） */
  setPddLoginHandler(fn) { this._pddLoginHandler = fn; }
  /** 注册「拼多多批量申请发票」处理器（main.js 注入 pdd-apply.createApplyHandler） */
  setPddApplyHandler(fn) { this._pddApplyHandler = fn; }
  /** 注册「拼多多批量催商家开票」处理器（main.js 注入 pdd-send.createSendHandler） */
  setPddSendHandler(fn) { this._pddSendHandler = fn; }

  /**
   * 执行一次「页内签名请求」：在牵牛花页面环境里 fetch（自动带 mtgsig），结果回传服务器。
   * 只与登录互斥（共用同一个窗口）；发送催收消息期间照常执行，不影响发送节奏。
   */
  async _runQnhFetch(m) {
    const done = (payload) => this.send(Object.assign({
      type: 'qnh_fetch_done', taskId: m.taskId,
    }, payload || {}));

    if (this._qnhBusy) { done({ ok: false, error: '登录窗口正在使用中，请稍后再试' }); return; }
    if (typeof this._qnhFetchHandler !== 'function') {
      done({ ok: false, error: '助手版本过旧，不支持该能力，请重新下载安装助手' });
      return;
    }
    this._qnhBusy = true;
    const api = {
      log: (text) => this.send({ type: 'log', text: String(text == null ? '' : text).slice(0, 200) }),
      report: done,
    };
    try {
      await this._qnhFetchHandler(m, api);
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    } finally {
      this._qnhBusy = false;
    }
  }

  /**
   * 执行一次「登录牵牛花」：在本机弹窗口让用户登录，完成后把 Cookie 回传服务器。
   * 与发送互斥（别在发送时弹窗口打断节奏）。
   */
  async _runQnhLogin(m) {
    const done = (payload) => this.send(Object.assign({
      type: 'qnh_login_done', taskId: m.taskId,
    }, payload || {}));

    if (this._qnhBusy) { done({ ok: false, error: '已有登录任务在进行中' }); return; }
    if (this.sending) {
      done({ ok: false, error: '正在发送催收消息，请等发送完成后再登录牵牛花' });
      return;
    }
    if (typeof this._qnhLoginHandler !== 'function') {
      done({ ok: false, error: '助手版本过旧，不支持登录牵牛花，请重新下载安装助手' });
      return;
    }
    this._qnhBusy = true;
    this.stopFlag = false;
    this.currentTaskId = m.taskId;
    this._emitState();
    const api = {
      log: (text) => this.send({ type: 'log', text: String(text == null ? '' : text).slice(0, 200) }),
      isStopped: () => this.stopFlag,
      sleep: async (ms) => {
        for (let waited = 0; waited < ms && !this.stopFlag; waited += 300) {
          await new Promise((r) => setTimeout(r, Math.min(300, ms - waited)));
        }
      },
      report: done,
    };
    try {
      await this._qnhLoginHandler(m, api);
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    } finally {
      this._qnhBusy = false;
      this.stopFlag = false;
      this.currentTaskId = null;
      this._emitState();
    }
  }

  /**
   * 执行一次「登录拼多多」：在本机弹手机端 H5 窗口让用户登录，完成后把 Cookie 串回传服务器。
   * 与牵牛花登录各自独立（不同窗口、不同站点分区），只在发送催收消息时互斥。
   */
  async _runPddLogin(m) {
    const done = (payload) => this.send(Object.assign({
      type: 'pdd_login_done', taskId: m.taskId,
    }, payload || {}));

    if (this._pddBusy) { done({ ok: false, error: '已有拼多多登录任务在进行中' }); return; }
    if (this.sending) {
      done({ ok: false, error: '正在发送催收消息，请等发送完成后再登录拼多多' });
      return;
    }
    if (typeof this._pddLoginHandler !== 'function') {
      done({ ok: false, error: '助手版本过旧，不支持登录拼多多，请重新下载安装助手' });
      return;
    }
    this._pddBusy = true;
    this.stopFlag = false;
    this.currentTaskId = m.taskId;
    this._emitState();
    const api = {
      log: (text) => this.send({ type: 'log', text: String(text == null ? '' : text).slice(0, 200) }),
      isStopped: () => this.stopFlag,
      sleep: async (ms) => {
        for (let waited = 0; waited < ms && !this.stopFlag; waited += 300) {
          await new Promise((r) => setTimeout(r, Math.min(300, ms - waited)));
        }
      },
      report: done,
    };
    try {
      await this._pddLoginHandler(m, api);
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    } finally {
      this._pddBusy = false;
      this.stopFlag = false;
      this.currentTaskId = null;
      this._emitState();
    }
  }

  /**
   * 执行一次「拼多多批量申请发票」：助手加载真实开票页并逐单提交（anti-content 由页面生成）。
   * 与登录共用 _pddBusy 互斥（都用同一个拼多多窗口分区，避免同时操作互相干扰）。
   */
  async _runPddApply(m) {
    const done = (payload) => this.send(Object.assign({
      type: 'pdd_apply_done', taskId: m.taskId,
    }, payload || {}));

    if (this._pddBusy) { done({ ok: false, error: '已有拼多多任务在进行中' }); return; }
    if (typeof this._pddApplyHandler !== 'function') {
      done({ ok: false, error: '助手版本过旧，不支持申请发票，请重新下载安装助手' });
      return;
    }
    this._pddBusy = true;
    this.stopFlag = false;
    this.currentTaskId = m.taskId;
    this._emitState();
    const api = {
      log: (text) => this.send({ type: 'log', text: String(text == null ? '' : text).slice(0, 200) }),
      isStopped: () => this.stopFlag,
      sleep: async (ms) => {
        for (let waited = 0; waited < ms && !this.stopFlag; waited += 300) {
          await new Promise((r) => setTimeout(r, Math.min(300, ms - waited)));
        }
      },
      report: done,
      // 逐单进度：服务端记进任务上下文，看板轮询 apply-status 时渲染进度看板
      progress: (p) => this.send(Object.assign({ type: 'pdd_apply_progress', taskId: m.taskId }, p || {})),
    };
    try {
      await this._pddApplyHandler(m, api);
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    } finally {
      this._pddBusy = false;
      this.stopFlag = false;
      this.currentTaskId = null;
      this._emitState();
    }
  }

  /**
   * 执行一次「拼多多批量催商家开票」：助手加载真实聊天页逐单发消息（anti-content 由页面生成）。
   * 与申请共用 _pddBusy 互斥（同一拼多多分区，避免两个窗口同时操作互相干扰）。
   */
  async _runPddSend(m) {
    const done = (payload) => this.send(Object.assign({
      type: 'pdd_send_done', taskId: m.taskId,
    }, payload || {}));

    if (this._pddBusy) { done({ ok: false, error: '已有拼多多任务在进行中' }); return; }
    if (typeof this._pddSendHandler !== 'function') {
      done({ ok: false, error: '助手版本过旧，不支持发送催收消息，请重新下载安装助手' });
      return;
    }
    this._pddBusy = true;
    this.stopFlag = false;
    this.currentTaskId = m.taskId;
    this._emitState();
    const api = {
      log: (text) => this.send({ type: 'log', text: String(text == null ? '' : text).slice(0, 200) }),
      isStopped: () => this.stopFlag,
      sleep: async (ms) => {
        for (let waited = 0; waited < ms && !this.stopFlag; waited += 300) {
          await new Promise((r) => setTimeout(r, Math.min(300, ms - waited)));
        }
      },
      report: done,
      // 逐单进度：服务端记进任务上下文，看板轮询 task-status 时渲染进度看板
      progress: (p) => this.send(Object.assign({ type: 'pdd_send_progress', taskId: m.taskId }, p || {})),
    };
    try {
      await this._pddSendHandler(m, api);
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    } finally {
      this._pddBusy = false;
      this.stopFlag = false;
      this.currentTaskId = null;
      this._emitState();
    }
  }

  /** 注册「清除登录态」处理器（main.js 注入 agent/logout 模块） */
  setLogoutHandler(fn) { this._logoutHandler = fn; }

  /**
   * 执行一次「清除本机登录态」：看板点「退出拼多多 / 退出牵牛花账号」时，
   * 服务器除了删库里的 Cookie，还会让本机把浏览器分区里的 Cookie 一起清掉 ——
   * 否则下次点「登录」会因分区里还留着旧账号而直接免登录进去。
   * 与发送/登录互斥：正在跑的任务会把窗口关掉，宁可让用户等一会儿。
   */
  async _runLogout(m) {
    const done = (payload) => this.send(Object.assign({
      type: 'logout_done', taskId: m.taskId,
    }, payload || {}));

    const busy = this.busy();
    if (busy.any) {
      const what = busy.sending ? '发送催收消息' : (busy.pdd ? '拼多多任务' : '牵牛花任务');
      done({ ok: false, error: `助手正在执行任务（${what}），请等任务结束后再退出账号` });
      return;
    }
    if (typeof this._logoutHandler !== 'function') {
      done({ ok: false, error: '助手版本过旧，不支持自动退出登录态，请重新下载安装助手' });
      return;
    }
    const api = {
      log: (text) => this.send({ type: 'log', text: String(text == null ? '' : text).slice(0, 200) }),
      report: done,
    };
    const target = String((m && m.target) || '').toLowerCase();
    try {
      await this._logoutHandler(m, api);
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
    } finally {
      // 1688 的登录态是助手自己上报的：清完顺手置为未登录，看板右上角立刻变成「未登录」
      if (target === '1688' || target === 'ali' || target === 'alibaba') this.reportLoginState(false, '');
      this._emitState();
    }
  }

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
