/* CommonJS on purpose: package.json sets "type": "module", and an ESM preload
   would need sandbox disabled. A .cjs preload loads in the sandbox as-is. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledHost', {
  isElectron: true,

  /** Device names the shell may reconnect to without asking. */
  remember: names => ipcRenderer.send('ble-remember', names),

  /** Answer an open chooser. Pass '' to cancel it. */
  pickDevice: id => ipcRenderer.send('ble-pick', id || ''),

  /** Called with [{id, name}] while a first-run scan is running. */
  onDevices: cb => ipcRenderer.on('ble-devices', (_e, list) => cb(list))
});
