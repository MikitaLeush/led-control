/* Electron shell.

   Three jobs beyond opening a window:

   1. Serve src/ over a real origin. ES modules are blocked over file:// (opaque
      origin, CORS), so loadFile() cannot run the module build. A privileged
      app:// scheme gives a proper, secure origin — modules load and Web
      Bluetooth is happy.

   2. Answer the Bluetooth chooser ourselves. select-bluetooth-device lets the
      main process pick a device programmatically, so requestDevice() resolves
      with no visible picker once a strip is known. Strips are remembered by
      address, per profile, in userData — the iStrip advertises no name, so a
      name can never identify it.

   3. Connect on launch with no tap. executeJavaScript(…, true) runs with a user
      gesture, which is all requestDevice() needs; measured on this machine, not
      assumed. A strip that is not in range is looked for again every
      AUTO_RETRY_MS until it turns up or the user presses Disconnect. */

import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { decide } from './chooser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = join(HERE, '..', 'src');

const PROFILE_IDS   = ['lotus', 'istrip'];
const SCAN_GRACE_MS = 12000;   // a remembered strip that has not shown up by now is not coming
const SETTLE_MS     = 2500;    // first run: collect candidates this long before choosing
const AUTO_RETRY_MS = 20000;

/* profile id → Bluetooth address. Per machine, outside the vault. */
const storeFile = () => join(app.getPath('userData'), 'ble-devices.json');
let saved = {};
function loadSaved() {
  try { saved = JSON.parse(readFileSync(storeFile(), 'utf8')) || {}; } catch { saved = {}; }
}
function persist() {
  try { writeFileSync(storeFile(), JSON.stringify(saved, null, 2)); } catch { /* convenience only */ }
}

let intent = null;     // profile the in-flight requestDevice() is for
const chosen = {};     // profile → address answered, committed once the strip connects

/* One in-flight chooser at a time. Electron fires select-bluetooth-device
   repeatedly as the scan discovers devices; every one of those callbacks
   replaces the previous, and exactly one must eventually be called or
   requestDevice() never settles. */
let pending = null;

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
  const { callback, grace, settleTimer, profile } = pending;
  pending = null;
  clearTimeout(grace);
  clearTimeout(settleTimer);
  if (deviceId) chosen[profile] = deviceId;
  console.log(`[ble] ${profile}: ${deviceId ? 'picked ' + deviceId : 'nothing found'}`);
  callback(deviceId || '');            // '' cancels requestDevice() cleanly
}

function createWindow() {
  const win = new BrowserWindow({
    width: 520, height: 880, minWidth: 380,
    backgroundColor: '#0b0c10',
    autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs') }
  });

  const evaluate = () => {
    const p = pending;
    if (!p) return;
    const d = decide({ devices: p.devices, remembered: saved[p.profile],
                       firstSeenAt: p.firstSeenAt, now: Date.now(), settleMs: SETTLE_MS });
    if (d.pick) return settle(d.pick);
    if (d.ask) {
      // The user is choosing now; they cancel, not the clock.
      clearTimeout(p.grace);
      p.asked = true;
      win.webContents.send('ble-devices', d.ask);
    }
  };

  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    if (!pending) {
      pending = { profile: intent, devices: [], firstSeenAt: null, asked: false,
                  grace: setTimeout(() => settle(''), SCAN_GRACE_MS), settleTimer: null };
    }
    pending.callback = callback;
    pending.devices = devices;
    if (devices.length && pending.firstSeenAt == null) {
      pending.firstSeenAt = Date.now();
      // The event only fires on new devices, so re-check once the settle window closes.
      pending.settleTimer = setTimeout(evaluate, SETTLE_MS + 50);
    }
    evaluate();
  });

  /* Connect every strip that is not up, one chooser at a time. The renderer
     answers 'skip' for a strip that is connected, reconnecting on its own, or
     that the user disconnected on purpose. */
  let running = false;
  const autoconnect = async () => {
    if (running || win.isDestroyed()) return;
    running = true;
    try {
      for (const id of PROFILE_IDS) {
        if (win.isDestroyed()) return;
        try {
          await win.webContents.executeJavaScript(
            `window.__ledAutoconnect ? window.__ledAutoconnect(${JSON.stringify(id)}) : 'skip'`,
            true);
        } catch { /* page reloading — the next tick tries again */ }
      }
    } finally { running = false; }
  };
  // Start once the page says it is wired up — did-finish-load can beat its
  // top-level awaits. After that, the ticker picks up any strip still missing.
  let ticker = null;
  const onReady = e => {
    if (e.sender !== win.webContents) return;
    autoconnect();
    if (!ticker) ticker = setInterval(autoconnect, AUTO_RETRY_MS);
  };
  ipcMain.on('ble-ready', onReady);
  win.on('closed', () => { clearInterval(ticker); ipcMain.off('ble-ready', onReady); });

  win.loadURL('app://led/index.html');
  return win;
}

ipcMain.on('ble-intent', (e, profile) => {
  intent = PROFILE_IDS.includes(profile) ? profile : null;
  e.returnValue = true;               // sendSync: settled before requestDevice() starts
});
ipcMain.on('ble-pick', (_e, id) => settle(id));
ipcMain.on('ble-log', (_e, line) => console.log(`[strip] ${line}`));
ipcMain.on('ble-connected', (_e, profile) => {
  const addr = chosen[profile];
  if (!addr || saved[profile] === addr) return;
  saved[profile] = addr;
  persist();
});

app.whenReady().then(() => {
  loadSaved();
  serveSrc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
