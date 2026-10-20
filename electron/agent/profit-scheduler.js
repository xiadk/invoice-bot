/**
 * electron/agent/profit-scheduler.js — 毛利采集的节奏控制（本机侧）
 *
 * 职责：按服务器下发的规则，定时（带抖动）采一次 → 上报 → 记录状态。
 * 只管节奏，不碰页面细节（页面操作在 profit-watch.js），不碰业务判定（判定在服务器）。
 *
 * 节奏设计（防风控的核心）：
 *   · 默认每 60 秒读一次 DOM（读 DOM 不发网络请求，等于「多看屏幕一眼」）；
 *   · 每轮实际间隔 = 配置间隔 × (1 ± jitterRatio)，避免精确整点的心跳特征；
 *   · 页面刷新（refreshEverySec）单独计时，同样带抖动，走页面自带刷新按钮；
 *   · 连续失败时指数退避（最长 10 分钟一次），避免「页面挂了还猛刷」；
 *   · 关掉采集开关 / 助手停止时立即停表，不残留定时器。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ProfitScheduler {
  /**
   * @param {object} o
   * @param {(cfg:object)=>{ok:boolean, rows:any[], reason?:string, pageTitle?:string, pageUrl?:string, warnings?:string[]}} o.collect
   * @param {()=>string} o.refresh         点一次页面刷新，返回命中的按钮文字（空=没点到）
   * @param {(rows:any[], info:object)=>void} o.report  上报（rows 已归一化）
   * @param {(state:object)=>void} o.onState  状态变化回调（面板展示）
   * @param {(msg:string)=>void} [o.log]
   */
  constructor(o) {
    const x = o || {};
    this.collect = x.collect || (async () => ({ ok: false, reason: 'no-collector', rows: [] }));
    this.refresh = x.refresh || (async () => '');
    this.report = x.report || (() => {});
    this.onState = x.onState || (() => {});
    this.log = x.log || (() => {});

    this.config = null;
    this.running = false;
    this.timer = null;
    this.stopped = false;
    this._lastRefreshAt = 0;
    this._failStreak = 0;

    this.stat = {
      running: false,
      enabled: false,
      lastRunAt: null,
      lastOkAt: null,
      lastError: '',
      rows: 0,
      negative: 0,
      intervalSec: 0,
      nextRunAt: null,
      pageTitle: '',
      pageUrl: '',
      lastRefreshAt: null,
      warnings: [],
      target: '',
      mode: 'live',
      failStreak: 0,
    };
  }

  state() { return { ...this.stat }; }

  /** 服务器下发/更新规则。规则变了就重排定时器（不会打断正在进行的一轮）。 */
  setConfig(cfg) {
    const prev = this.config;
    this.config = cfg || null;
    this.stat.enabled = !!(cfg && cfg.enabled);
    this.stat.intervalSec = Math.max(15, Number(cfg && cfg.pollIntervalSec) || 60);
    this.stat.target = (cfg && cfg.url) ? String(cfg.url).replace(/^https?:\/\//, '').slice(0, 90) : '';
    this._emit();
    if (!this.running) return;
    const changed = !prev || !cfg
      || prev.enabled !== cfg.enabled
      || prev.pollIntervalSec !== cfg.pollIntervalSec
      || prev.refreshEverySec !== cfg.refreshEverySec
      || prev.url !== cfg.url;
    if (changed) this._reschedule(2000);
  }

  /** 是否要采：规则启用 + 有 URL */
  _shouldRun() {
    const c = this.config;
    return !!(c && c.enabled && c.url);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.stat.running = true;
    this._emit();
    this._loop().catch((e) => this.log('采集循环异常: ' + e.message));
  }

  stop() {
    this.stopped = true;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.stat.running = false;
    this.stat.nextRunAt = null;
    this._emit();
  }

  /**
   * 立即采一次（面板「立即采集」按钮 / 看板下发的 profit_run_now）
   * @param {{reqId?:string}} [opts] 带上服务器下发的 reqId，回执里原样带回，便于前端对应
   */
  async runNow(opts) {
    const o = opts || {};
    // 还没收到看板下发的配置（未启用/未连服务器）：直接友好报错，别让 _tick 在 null 上崩
    if (!this.config) {
      this.log('手动采集被拒绝：尚未收到采集配置');
      return {
        ok: false,
        error: '尚未收到看板下发的毛利采集配置。请先在网页看板「毛利告警」页启用采集（保存规则后会自动下发到本助手）。',
      };
    }
    if (this._busy) this.log('已有一轮采集在进行，等它结束后再执行本次手动采集');
    return this._run(true, o.reqId ? String(o.reqId) : '');
  }

  /**
   * 统一执行入口：同一时刻只允许一轮采集，避免自动轮询与手动触发抢同一个页面。
   *  - 手动触发（manual=true）遇到正在跑的一轮：等它结束，再补跑一轮（不复用，保证 manual/reqId 生效）
   *  - 自动轮询遇到正在跑的一轮：直接跳过本轮（下一轮定时器照常）
   */
  async _run(manual, reqId) {
    // 自动轮询遇到在跑的一轮：直接跳过（下一轮定时器照常，不必堆积）
    if (this._busy && !manual) {
      return Promise.resolve({ ok: false, rows: [], skipped: true, reason: '上一轮未结束，跳过' });
    }
    // 手动触发：接在当前队列尾部（同步挂链，保证并发调用也严格串行）
    const prev = this._queue || Promise.resolve();
    const job = prev
      .catch(() => {})
      .then(() => this._tick(!!manual, reqId));
    this._queue = job.catch(() => {});
    this._busy = job;
    return job.finally(() => { if (this._busy === job) this._busy = null; });
  }

  _reschedule(delayMs) {
    clearTimeout(this.timer);
    if (!this.running || this.stopped) return;
    const d = Math.max(500, delayMs);
    this.stat.nextRunAt = new Date(Date.now() + d).toISOString();
    this.timer = setTimeout(() => {
      this._loop().catch((e) => this.log('采集循环异常: ' + e.message));
    }, d);
    this._emit();
  }

  _jitter(baseSec) {
    const r = Math.max(0, Math.min(0.5, Number(this.config && this.config.jitterRatio) || 0));
    const ms = baseSec * 1000;
    const delta = ms * r * (Math.random() * 2 - 1);
    return Math.max(3000, Math.round(ms + delta));
  }

  async _loop() {
    if (!this.running || this.stopped) return;
    if (!this._shouldRun()) {
      // 采集关闭：慢速轮询配置（服务器也会主动推），不占资源
      this._reschedule(30000);
      return;
    }
    await this._run(false);
    if (!this.running || this.stopped) return;

    const baseSec = Math.max(15, Number(this.config && this.config.pollIntervalSec) || 60);
    // 连续失败退避：60s → 2min → 4min → 8min（封顶 10min）
    const backoff = this._failStreak >= 3 ? Math.min(600, baseSec * Math.pow(2, Math.min(3, this._failStreak - 2))) : baseSec;
    this._reschedule(this._jitter(backoff));
  }

  _emit() { try { this.onState(this.state()); } catch (e) { /* 忽略 */ } }

  async _tick(manual, reqId) {
    const t0 = Date.now();
    this.stat.lastRunAt = new Date().toISOString();
    // config 可能为 null（助手刚启动还没收到下发），全程用安全副本
    const cfg = this.config || {};
    let r = null;
    try {
      r = await this.collect(cfg);
    } catch (e) {
      r = { ok: false, reason: 'collect-error: ' + e.message, rows: [] };
    }
    const rows = Array.isArray(r && r.rows) ? r.rows : [];
    const threshold = Number(cfg.threshold) || 0;
    const negatives = rows.filter((x) => typeof x.gross === 'number' && x.gross < threshold).length;

    // 页面刷新节奏：只在采集成功且到了刷新点时点一次（失败时不刷，避免雪上加霜）
    const refreshEvery = Math.max(0, Number(cfg.refreshEverySec) || 0);
    let refreshed = '';
    if (r && r.ok && refreshEvery > 0 && (Date.now() - (this._lastRefreshAt || 0)) >= refreshEvery * 1000) {
      try {
        refreshed = (await this.refresh()) || '';
        this._lastRefreshAt = Date.now();
        this.stat.lastRefreshAt = new Date(this._lastRefreshAt).toISOString();
      } catch (e) { /* 点不到刷新不影响本轮 */ }
    }

    if (r && r.ok) {
      this._failStreak = 0;
      this.stat.lastOkAt = new Date().toISOString();
      this.stat.lastError = '';
    } else {
      this._failStreak++;
      this.stat.lastError = (r && (r.reason || '')) || '采集失败（页面结构可能变化）';
    }
    this.stat.rows = rows.length;
    this.stat.negative = negatives;
    this.stat.pageTitle = (r && r.pageTitle) || '';
    this.stat.pageUrl = (r && r.pageUrl) || '';
    this.stat.warnings = (r && r.warnings) || [];
    this.stat.failStreak = this._failStreak;
    this.stat.lastRefreshHit = refreshed || '';
    this.stat.lastDurationMs = Date.now() - t0;
    this._emit();

    if (manual) this.log(`手动采集：${rows.length} 行，其中负毛利 ${negatives}（${Date.now() - t0}ms）`);

    try {
      this.report(rows, {
        ok: !!(r && r.ok),
        reason: (r && r.reason) || '',
        warnings: (r && r.warnings) || [],
        pageTitle: this.stat.pageTitle,
        pageUrl: this.stat.pageUrl,
        manual: !!manual,
        reqId: (manual && reqId) || String(Date.now()),
      });
    } catch (e) { this.log('上报失败: ' + e.message); }

    return { ok: !!(r && r.ok), rows, reason: (r && r.reason) || '', pageTitle: this.stat.pageTitle, warnings: this.stat.warnings };
  }
}

module.exports = { ProfitScheduler };
