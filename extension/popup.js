const $ = (id) => document.getElementById(id);

let prefilled = false;

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render(st) {
  const s = st || {};
  $('status').innerHTML =
    `<div><span class="dot ${s.connected ? 'on' : ''}"></span>通道：${s.connected ? '已连接服务器' : '未连接'}</div>` +
    `<div>1688 登录态：${s.loggedIn ? '已登录' : '未登录（请先打开 1688 登录）'}</div>` +
    `<div>发送状态：${s.sending ? '正在发送…' : '空闲'}</div>` +
    `<div>扩展版本：v${s.extVer || '1.0.0'}</div>`;

  // 输入框只预填一次：若扩展已被打包注入（readOnly），不要覆盖；否则用 background 里的状态回显
  if (!prefilled) {
    const urlInput = $('serverUrl');
    const codeInput = $('code');
    if (s.serverUrl && !urlInput.readOnly) urlInput.value = s.serverUrl;
    if (s.code && !codeInput.readOnly) codeInput.value = s.code;
    prefilled = true;
  }

  renderTask(s.task, !!s.connected);
}

// ── 实时发送面板（数据来自服务器推送的任务进度 + 本机当前发送对象）──
function renderTask(task, connected) {
  const panel = $('taskPanel');
  if (!task) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const title = $('taskTitle');
  const body = $('taskBody');
  const stopBtn = $('btnStop');
  const done = Number(task.done) || 0;
  const total = Number(task.total) || 0;
  const ok = Number(task.ok) || 0;
  const fail = Number(task.fail) || 0;
  const sellers = Array.isArray(task.sellers) ? task.sellers : [];
  const pending = sellers.filter((x) => x.status === 'pending').length;

  if (task.finished) {
    title.textContent = `任务 #${task.taskId} 已结束`;
    body.className = 'status';
    body.innerHTML = `成功 <b style="color:#2e7d32">${ok}</b> · 失败 <b style="color:#c62828">${fail}</b>`
      + (pending > 0 ? ` · 未发送 ${pending}（回看板「继续发送未完成」续跑）` : '');
    stopBtn.style.display = 'none';
    return;
  }
  if (!connected) {
    title.textContent = `任务 #${task.taskId} · 通道已断开`;
    body.className = 'status err';
    body.textContent = '与看板的连接已断开，任务可能已中断；重新连接后可在看板续跑。';
    stopBtn.style.display = 'none';
    return;
  }

  title.textContent = `发送中 · 任务 #${task.taskId}`;
  body.className = 'status';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const rows = sellers.map((x) => {
    const isCur = !!task.current && x.company === task.current;
    const dot = x.status === 'ok' ? '#2e7d32' : x.status === 'fail' ? '#c62828' : isCur ? '#ff6a00' : '#B4B2A9';
    const label = x.status === 'ok' ? '已发送' : x.status === 'fail' ? '失败' : isCur ? '发送中…' : '等待中';
    return `<div><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dot};margin-right:6px"></span>${escHtml(x.company || x.loginId)} · ${label}</div>`;
  }).join('');
  body.innerHTML =
    `<div style="margin-bottom:6px">第 <b>${done}</b> / ${total} 家${task.current ? ' · 当前：<b>' + escHtml(task.current) + '</b>' : ''}</div>`
    + `<div style="height:6px;border-radius:3px;background:#F1EFE8;overflow:hidden;margin-bottom:8px"><div style="width:${pct}%;height:100%;background:#ff6a00;border-radius:3px"></div></div>`
    + `<div style="display:flex;gap:14px;margin-bottom:8px"><span>成功 <b style="color:#2e7d32">${ok}</b></span><span>失败 <b style="color:#c62828">${fail}</b></span><span>剩余 <b>${pending}</b></span></div>`
    + rows;
  stopBtn.style.display = '';
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (st) => render(st));
}

// 若扩展已被服务器打包注入地址与税号，则直接预填并设为只读，用户无需手动配置
function applyBakedServerUrl() {
  const url = (typeof EXT_SERVER_URL !== 'undefined' ? EXT_SERVER_URL : '') || '';
  const code = (typeof EXT_PAIR_CODE !== 'undefined' ? EXT_PAIR_CODE : '') || '';
  const urlInput = $('serverUrl');
  const codeInput = $('code');
  if (url) {
    urlInput.value = url;
    urlInput.readOnly = true;
    urlInput.style.background = '#f5f6f8';
  }
  if (code) {
    codeInput.value = code;
    codeInput.readOnly = true;
    codeInput.style.background = '#f5f6f8';
  }
  if (url && code) {
    urlInput.title = '服务器地址已由下载包内置';
    codeInput.title = '配对税号已由下载包内置';
  }
}

$('btnConnect').addEventListener('click', () => {
  const serverUrl = $('serverUrl').value.trim();
  const code = $('code').value.trim();
  if (!serverUrl || !code) { alert('请填写服务器地址与纳税人识别号（税号）'); return; }
  chrome.runtime.sendMessage({ type: 'CONNECT', serverUrl, code }, () => setTimeout(refresh, 600));
});

$('btnDisconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT' }, () => setTimeout(refresh, 300));
});

$('btnOpen').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://login.1688.com/member/signin.htm', active: true });
});

$('btnStop').addEventListener('click', () => {
  if (!confirm('停止当前发送批次？\n当前这家发完即停，未发送的不会发出（可在看板续跑）。')) return;
  chrome.runtime.sendMessage({ type: 'STOP_TASK' }, (r) => {
    if (r && !r.ok && r.error) alert(r.error);
    setTimeout(refresh, 300);
  });
});

applyBakedServerUrl();
refresh();
setInterval(refresh, 2000);
