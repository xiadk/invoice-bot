const $ = (id) => document.getElementById(id);

let prefilled = false;

function render(st) {
  const s = st || {};
  $('status').innerHTML =
    `<div><span class="dot ${s.connected ? 'on' : ''}"></span>通道：${s.connected ? '已连接服务器' : '未连接'}</div>` +
    `<div>1688 登录态：${s.loggedIn ? '已登录' : '未登录（请先打开 1688 登录）'}</div>` +
    `<div>发送状态：${s.sending ? '正在发送…' : '空闲'}</div>` +
    `<div>扩展版本：v${s.extVer || '1.0.0'}</div>`;

  // 输入框只预填一次，避免每 2 秒刷新把用户正在输入的内容清掉
  if (!prefilled) {
    if (s.serverUrl) { $('serverUrl').value = s.serverUrl; $('upServer').value = s.serverUrl; }
    if (s.code) $('code').value = s.code;
    prefilled = true;
  }

  const up = s.lastUpload;
  const box = $('upStatus');
  if (up && up.ok) {
    const when = up.savedAt ? new Date(up.savedAt).toLocaleString('zh-CN', { hour12: false }) : '';
    box.className = 'status ok';
    box.innerHTML = `✓ 已上传登录态（${up.cookieCount || 0} 个 cookie${up.originCount ? ' · ' + up.originCount + ' 个 localStorage 源' : ''}）<br>${when}`;
  } else if (up && !up.ok) {
    box.className = 'status err';
    box.textContent = '✗ 上次上传失败：' + (up.error || '未知原因');
  }
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

$('btnUpload').addEventListener('click', () => {
  const serverUrl = $('upServer').value.trim();
  const token = $('upToken').value.trim();
  const btn = $('btnUpload');
  const box = $('upStatus');
  if (!serverUrl || !token) { alert('请填写服务器地址与上传码'); return; }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '上传中…';
  box.className = 'status';
  box.textContent = '正在收集本机 1688 登录态并上传…';
  chrome.runtime.sendMessage({ type: 'UPLOAD_STATE', serverUrl, token }, (r) => {
    btn.disabled = false;
    btn.textContent = old;
    if (r && r.ok) {
      box.className = 'status ok';
      box.innerHTML = `✓ 上传成功（${r.cookieCount || 0} 个 cookie${r.originCount ? ' · ' + r.originCount + ' 个 localStorage 源' : ''}）<br>回看板点「刷新状态」即可看到「可用」。`;
      $('upToken').value = '';
    } else {
      box.className = 'status err';
      box.textContent = '✗ 上传失败：' + ((r && r.error) || '未知原因');
    }
  });
});

refresh();
setInterval(refresh, 2000);
