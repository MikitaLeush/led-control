/* Electron shell.

   Two jobs beyond opening a window:

   1. Serve src/ over a real origin. ES modules are blocked over file:// (opaque
      origin, CORS), so loadFile() cannot run the module build. A privileged
      app:// scheme gives a proper, secure origin — modules load and Web
      Bluetooth is happy.

   2. Answer the Bluetooth chooser ourselves. This is the whole reason a desktop
      app can autoconnect where the browser cannot: select-bluetooth-device lets
      the main process pick a device programmatically, so requestDevice()
      resolves with no visible picker once a strip is known. */

import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = join(HERE, '..', 'src');

/* Names the renderer has told us it already trusts. */
const remembered = new Set();

/* One in-flight chooser at a time. Electron fires select-bluetooth-device
   repeatedly as the scan discovers devices; every one of those callbacks
   replaces the previous, and exactly one must eventually be called or
   requestDevice() never settles. */
let pending = null;

const SCAN_GRACE_MS = 12000;

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

function serveSrc() {
  protocol.handle('app', request => {
    const url = new URL(request.url);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '');
    const file = join(SRC, rel || 'index.html');
    if (file !== SRC && !file.startsWith(SRC + sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function settle(deviceId) {
  if (!pending) return;
  const { callback, timer } = pending;
  pending = null;
  clearTimeout(timer);
  callback(deviceId || '');            // '' cancels requestDevice() cleanly
}

function createWindow() {
  const win = new BrowserWindow({
    width: 520, height: 880, minWidth: 380,
    backgroundColor: '#0b0c10',
    autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs') }
  });

  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();

    const known = devices.find(d => d.deviceName && remembered.has(d.deviceName));
    if (known) { settle(null); return callback(known.deviceId); }   // silent reconnect

    // First run for this strip: hand the list to the page and let the user choose.
    if (pending) clearTimeout(pending.timer);
    pending = {
      callback,
      timer: setTimeout(() => settle(''), SCAN_GRACE_MS)
    };
    win.webContents.send('ble-devices',
      devices.filter(d => d.deviceName)
             .map(d => ({ id: d.deviceId, name: d.deviceName })));
  });

  win.loadURL('app://led/index.html');
  return win;
}

ipcMain.on('ble-remember', (_e, names) => {
  for (const n of names) if (n) remembered.add(n);
});
ipcMain.on('ble-pick', (_e, id) => settle(id));

app.whenReady().then(() => {
  serveSrc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
