/**
 * electron/preload.js — 状态窗口的 contextBridge 白名单
 * 只暴露必要的几个方法，不把 Node/Electron 能力漏给页面。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xsh', {
  getState: () => ipcRenderer.invoke('agent:getState'),
  onState: (cb) => {
    const h = (_e, s) => { try { cb(s); } catch (err) { /* 忽略 */ } };
    ipcRenderer.on('agent:state', h);
    return () => ipcRenderer.removeListener('agent:state', h);
  },
  openLoginWindow: () => ipcRenderer.invoke('agent:openLoginWindow'),
  stopTask: () => ipcRenderer.invoke('agent:stopTask'),
  openDataDir: () => ipcRenderer.invoke('agent:openDataDir'),
  unbind: () => ipcRenderer.invoke('agent:unbind'),
  quit: () => ipcRenderer.invoke('agent:quit'),
});
