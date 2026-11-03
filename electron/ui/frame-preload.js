/**
 * electron/ui/frame-preload.js — 工具栏页与主进程之间的最小桥
 *
 * 只暴露三个导航动作和一条状态订阅，工具栏页本身拿不到 Node、也碰不到站点视图。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xshFrame', {
  /** action: 'back' | 'forward' | 'reload' */
  nav: (action) => ipcRenderer.send('xsh:frame:nav', String(action || '')),
  /** 订阅状态：{ url, canBack, canForward } */
  onState: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('xsh:frame:state', (_e, s) => { try { cb(s || {}); } catch (err) { /* 忽略 */ } });
  },
  /** 告诉主进程“我准备好了”，主进程会立刻回推一次状态 */
  ready: () => ipcRenderer.send('xsh:frame:ready'),
});
