/* Entry point. Picks a transport for whatever this is running inside, builds the
   UI, and tries to bring the strips back without a picker. */

import { AES, lotusEncrypt, hex, PROFILES, masterFrame } from './protocol.js';
import { bootstrap } from './ui.js';

const isNative = () => !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform
                          && globalThis.Capacitor.isNativePlatform());

async function makeTransport() {
  // The single-file build has no module graph to import from, so it registers a
  // factory instead. Everywhere else the import is dynamic, which keeps the
  // Capacitor plugin out of the web bundle and vice versa.
  if (typeof globalThis.__LED_TRANSPORT__ === 'function') return globalThis.__LED_TRANSPORT__();
  if (isNative()) {
    const { CapacitorBleTransport } = await import('./transport-cap.js');
    return new CapacitorBleTransport();
  }
  const { WebBluetoothTransport } = await import('./transport-web.js');
  return new WebBluetoothTransport();
}

const status = document.getElementById('btstatus');
const say = (html, bad) => {
  status.innerHTML = html;
  status.classList.toggle('flag', !!bad);
};

const transport = await makeTransport();
const app = bootstrap({
  transport,
  root: document.getElementById('master'),
  panelRoot: document.getElementById('panels')
});

/* Say plainly whether Bluetooth can work here rather than failing silently later,
   then reopen anything we already have permission for. */
const cap = await transport.available();
if (!cap.ok) {
  say(cap.reason, true);
} else if (cap.silentReconnect) {
  say('Bluetooth ready · reconnects without asking');
  let back = 0;
  for (const s of app.strips) if (await s.restore()) back++;
  if (back) say(`Bluetooth ready · reconnected ${back} of ${app.strips.length} without asking`);
} else {
  say('Bluetooth ready · the picker appears after every restart — turn on '
    + '<code>chrome://flags/#enable-web-bluetooth-new-permissions-backend</code> to skip it');
}

/* Let a host shell (Electron) answer the chooser for us. Wired in the Electron task;
   harmless everywhere else. */
if (globalThis.ledHost && globalThis.ledHost.isElectron) {
  globalThis.ledHost.remember(app.strips.map(s => s.remembered && s.remembered.name)
                                        .filter(Boolean));
}

/* ── ?selftest=1 — every frame, and proof the AES is real AES ──────────────── */
if (new URLSearchParams(location.search).has('selftest')) {
  const L = PROFILES.lotus, I = PROFILES.istrip;
  const out = [];
  const line  = (label, bytes) => out.push(label.padEnd(30) + hex(bytes));
  const check = (label, cond)  => out.push(label.padEnd(30) + (cond ? 'PASS' : 'FAIL'));

  const kat = AES.encryptBlock(
    Uint8Array.from([0x00,0x11,0x22,0x33,0x44,0x55,0x66,0x77,
                     0x88,0x99,0xaa,0xbb,0xcc,0xdd,0xee,0xff]),
    AES.expandKey(Uint8Array.from([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15])));
  check('AES-128 FIPS-197 C.1', hex(kat).replace(/ /g, '') === '69C4E0D86A7B0430D8CDB78070B4C55A');
  out.push('');

  out.push('── Lotus Lantern · 9 bytes, plaintext ──');
  line('power on',           L.power(true));
  line('power off',          L.power(false));
  line('rgb 255,0,0',        L.rgb(255, 0, 0));
  line('brightness 50',      L.setBrightness(50));
  line('cct warm100/cold0',  L.frame(0x05, 0x06, [0x02, 100, 0, 0xFF, 0x08]));
  out.push('');
  out.push('── Lotus Lantern · ELK-* unit, 21 bytes, fixed random ──');
  const rnd = Uint8Array.from([1,2,3,4,5,6,7,8,9,10,11,12]);
  line('power on',           lotusEncrypt(L.power(true), rnd));
  out.push('  colour (cmd 5) is never encrypted, even on these units');
  out.push('');

  I.state.bright = 100; I.state.group = 1;
  out.push('── iStrip+ · 16 bytes, plaintext ──');
  line('power off',          I.power(false));
  line('rgb 255,0,0',        I.rgb(255, 0, 0));
  out.push('── iStrip+ · AES-128, what goes on the wire ──');
  line('rgb 255,0,0',        I.wrap(I.rgb(255, 0, 0)));
  out.push('');

  out.push('── one control, two protocols ──');
  for (const v of [0, 5, 50, 100]) {
    const st = { r: 255, g: 0, b: 0, bright: v };
    out.push(`  brightness ${v}`);
    line('    → lotus',  masterFrame(L, 'bright', st));
    line('    → istrip', masterFrame(I, 'bright', st));
  }
  out.push('');
  const st0 = { r: 255, g: 0, b: 0, bright: 0 };
  check('0 → power-off, lotus',  hex(masterFrame(L, 'bright', st0)) === hex(L.power(false)));
  check('0 → power-off, istrip', hex(masterFrame(I, 'bright', st0)) === hex(I.power(false)));
  masterFrame(I, 'bright', { r:255, g:0, b:0, bright:5 });
  check('istrip clamps 5 → 10', I.state.bright === 10);
  L.state.bright = 100; I.state.bright = 100;
  app.panels.forEach(p => p.syncWidgets());

  const pre = document.createElement('pre');
  pre.className = 'selftest';
  pre.textContent = out.join('\n');
  const h = document.createElement('p');
  h.className = 'sect';
  h.textContent = 'Self-test';
  document.getElementById('selftest').append(h, pre);
}
