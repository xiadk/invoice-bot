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
  /** 清除本机某个站点的登录态：target = pdd / qnh / 1688 */
  logout: (target) => ipcRenderer.invoke('agent:logout', target),
  /** 各站点在本机的 Cookie 概况（面板显示「本机还有没有登录态」） */
  localState: () => ipcRenderer.invoke('agent:localState'),
  /** 版本更新：updateState 拉当前状态（含有没有可更的新版），doUpdate 下载+拉起安装 */
  updateState: () => ipcRenderer.invoke('agent:updateState'),
  doUpdate: () => ipcRenderer.invoke('agent:update'),
  onUpdate: (cb) => {
    const h = (_e, s) => { try { cb(s); } catch (err) { /* 忽略 */ } };
    ipcRenderer.on('agent:update', h);
    return () => ipcRenderer.removeListener('agent:update', h);
  },
  stopTask: () => ipcRenderer.invoke('agent:stopTask'),
  openDataDir: () => ipcRenderer.invoke('agent:openDataDir'),
  unbind: () => ipcRenderer.invoke('agent:unbind'),
  quit: () => ipcRenderer.invoke('agent:quit'),
});
