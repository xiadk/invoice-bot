/**
 * electron/store.js — 助手本地凭证与偏好（纯 Node，不依赖 Electron，便于单测）
 *
 * 存放位置：<userData>/agent.json
 *   · deviceToken  设备令牌（绑定后获得；连接 /ws/agent?device=<token> 用）
 *   · serverUrl    服务器地址（绑定深链里带过来的）
 *   · deviceName   设备名（默认取主机名）
 *   · autoStart    是否开机自启
 *   · lastLoggedIn 上次上报的 1688 登录态（仅布尔，用于状态展示）
 *
 * ⚠ 本文件**不含**任何 1688 凭据：助手不读取、不保存 1688 账号密码或 Cookie。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  serverUrl: '',
  deviceToken: '',
  deviceId: 0,
  userId: 0,
  deviceName: '',
  autoStart: true,
  lastLoggedIn: false,
};

function createStore(dir) {
  const file = path.join(dir, 'agent.json');
  let data = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    data = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { /* 首次运行：无文件，用默认值 */ }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 原子写：先写临时文件再 rename，避免断电写坏凭证
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('[store] 保存失败:', e.message);
    }
  }

  return {
    file,
    all: () => ({ ...data }),
    get: (k) => data[k],
    set(patch) { Object.assign(data, patch || {}); save(); return { ...data }; },
    /** 绑定成功后写入 */
    setBinding({ deviceToken, serverUrl, deviceId, userId }) {
      Object.assign(data, {
        deviceToken: deviceToken || '',
        serverUrl: serverUrl || '',
        deviceId: Number(deviceId) || 0,
        userId: Number(userId) || 0,
      });
      save();
      return { ...data };
    },
    /** 解绑（清空令牌，保留 serverUrl） */
    clearBinding() {
      Object.assign(data, { deviceToken: '', deviceId: 0, userId: 0 });
      save();
      return { ...data };
    },
    isBound: () => !!data.deviceToken,
  };
}

module.exports = { createStore, DEFAULTS };
