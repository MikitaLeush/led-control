/* CommonJS on purpose: package.json sets "type": "module", and an ESM preload
   would need sandbox disabled. A .cjs preload loads in the sandbox as-is. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledHost', {
  isElectron: true,

  /** Which strip the next requestDevice() is for. Synchronous so the main
      process knows before the chooser fires. */
  intent: profileId => ipcRenderer.sendSync('ble-intent', profileId),

  /** The page is wired up and Bluetooth works — the shell may start connecting. */
  ready: () => ipcRenderer.send('ble-ready'),

  /** Mirror a strip's status line to the shell's stdout, for diagnosis. */
  log: line => ipcRenderer.send('ble-log', String(line)),

  /** A strip connected — the shell may now reopen that device without asking. */
  connected: profileId => ipcRenderer.send('ble-connected', profileId),

  /** Answer an open chooser. Pass '' to cancel it. */
  pickDevice: id => ipcRenderer.send('ble-pick', id || ''),

  /** Called with [{id, name}] when several strips match and none is remembered. */
  onDevices: cb => ipcRenderer.on('ble-devices', (_e, list) => cb(list))
});
