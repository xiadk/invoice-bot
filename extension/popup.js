const $ = (id) => document.getElementById(id);

function render(st) {
  const s = st || {};
  $('serverUrl').value = s.serverUrl || '';
  $('code').value = s.code || '';
  $('status').innerHTML =
    `<div><span class="dot ${s.connected ? 'on' : ''}"></span>通道：${s.connected ? '已连接服务器' : '未连接'}</div>` +
    `<div>1688 登录态：${s.loggedIn ? '已登录' : '未登录（请先打开 1688 登录）'}</div>` +
    `<div>发送状态：${s.sending ? '正在发送…' : '空闲'}</div>` +
    `<div>扩展版本：v${s.extVer || '1.0.0'}</div>`;
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (st) => render(st));
}

$('btnConnect').addEventListener('click', () => {
  const serverUrl = $('serverUrl').value.trim();
  const code = $('code').value.trim();
  if (!serverUrl || !code) { alert('请填写服务器地址与配对码'); return; }
  chrome.runtime.sendMessage({ type: 'CONNECT', serverUrl, code }, () => setTimeout(refresh, 600));
});

$('btnDisconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT' }, () => setTimeout(refresh, 300));
});

$('btnOpen').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://login.1688.com/member/signin.htm', active: true });
});

refresh();
setInterval(refresh, 2000);
