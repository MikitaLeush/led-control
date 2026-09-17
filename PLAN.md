# LED Control (desktop + Android) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a desktop app and an Android APK that drive both BLE LED strips from one control surface, connecting by themselves with no device picker after first pairing.

**Architecture:** One pure protocol module holds every byte-level decision. BLE sits behind a six-method `Transport` interface with two implementations — Web Bluetooth for browser and Electron, the Capacitor BLE plugin for Android. UI and connection state are shared and platform-blind. No bundler: `src/` is native ES modules, loaded directly by Electron, by Capacitor's `webDir`, and by the browser.

**Tech Stack:** Vanilla ES modules, `node --test`, Electron + electron-builder, Capacitor 7 + `@capacitor-community/bluetooth-le`, GitHub Actions.

**Spec:** [`DESIGN.md`](DESIGN.md) — read it before starting; this plan argues from it.

## Global Constraints

- **Node ≥ 22** (machine has v24.15.0, npm 11.12.1). Not 20: `node --test` only
  expands glob patterns from Node 22 onward, and the test script relies on one. CI
  pinned to 20 failed with `Could not find 'test/**/*.test.mjs'` while the same
  command passed locally on 24 — corrected 2026-09-16.
- **No protocol changes.** Every byte this project emits must match `../../protocol-notes.md`. That document and the frames in `../../led-control.html` are the reference; if they disagree, stop and ask.
- iStrip+ AES-128 ECB key, verbatim: `34 52 2A 5B 7A 6E 49 2C 08 09 0A 9D 8D 2A 23 F8`.
- Lotus stream-cipher preset key, verbatim: `2A 7F C1 94 33 DE 45 E0 8B 11 5C A6 09 F2 7D B8`.
- Brightness rules: Lotus 0–100 direct; iStrip floor 10, RGB scaled client-side; master slider 0 → power-off frame on both.
- ES modules only (`.mjs` for scripts, `type="module"` in HTML). No bundler, no transpiler.
- Touch targets ≥ 44 px.
- Android: debug signing only. No keystore secrets in the repo.
- Repo: `MikitaLeush/led-control`, **private**. The vault is never pushed.
- Working directory for every command: `projects/led-control/`.

---

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`, `.gitignore`, `test/smoke.test.mjs`
- Modify: `../../.stignore`

**Interfaces:**
- Produces: `npm test` runs `node --test "test/**/*.test.mjs"`; project root is a git repo.
- Note: on Node 24 a bare directory argument (`node --test test/`) is treated as an entry script and fails with `MODULE_NOT_FOUND`. The quoted glob is required, and works on cmd as well because Node expands it itself.

- [ ] **Step 1: Write the failing test**

`test/smoke.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package.json exposes a test script', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.type, 'module');
  assert.match(pkg.scripts.test, /node --test/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test "test/**/*.test.mjs"`
Expected: FAIL — `ENOENT` on `package.json`.

- [ ] **Step 3: Create package.json**

```json
{
  "name": "led-control",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Desktop and Android control for Lotus Lantern and iStrip+ BLE LED strips",
  "scripts": {
    "test": "node --test \"test/**/*.test.mjs\"",
    "build:singlefile": "node scripts/build-singlefile.mjs"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 5: Add .gitignore**

```
node_modules/
dist/
android/app/build/
android/build/
android/.gradle/
android/local.properties
*.apk
.DS_Store
```

- [ ] **Step 6: Keep build trees out of Syncthing**

Append to `../../.stignore`:
```
**/node_modules
**/dist
**/.gradle
projects/led-control/android/app/build
projects/led-control/android/build
```

- [ ] **Step 7: Initialise the repo and commit**

```bash
git init -b main
git add package.json .gitignore test/smoke.test.mjs
git commit -m "chore: scaffold led-control project with node --test harness"
```

---

### Task 2: Extract the protocol into a pure, tested module

This is the heart of the project. Every byte lives here and nowhere else.

**Files:**
- Create: `src/protocol.js`, `test/protocol.test.mjs`
- Source to move from: `../../led-control.html` — the `AES` IIFE, `LOTUS_PRESET_KEY`, `lotusEncrypt()`, `hex`, `clamp`, `PROFILES`, and `masterFrame()`. Move them **verbatim**; only add `export`.

**Interfaces:**
- Produces:
  - `export const AES = { expandKey(Uint8Array) → Uint8Array, encryptBlock(Uint8Array, Uint8Array) → Uint8Array }`
  - `export function lotusEncrypt(frame9: Uint8Array, randomOverride?: Uint8Array) → Uint8Array` (21 bytes)
  - `export const hex: (bytes) => string` — space-separated uppercase
  - `export const clamp: (v, lo, hi) => number`
  - `export const PROFILES: { lotus, istrip }` — each with `id, name, meta, service, characteristic, filters, brightness {min,max,def}, state, frame(), power(on), rgb(r,g,b), setBrightness(v), wrap(frame, deviceName?)`; `istrip` additionally has `hasGroup: true` and `lightCmd(v)`
  - `export function masterFrame(profile, kind: 'on'|'off'|'rgb'|'bright', st: {r,g,b,bright}) → Uint8Array`

- [ ] **Step 1: Write the failing test**

`test/protocol.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AES, lotusEncrypt, hex, PROFILES, masterFrame } from '../src/protocol.js';

const L = PROFILES.lotus, I = PROFILES.istrip;
const bytes = s => Uint8Array.from(s.split(' ').map(x => parseInt(x, 16)));

test('AES-128 matches the FIPS-197 C.1 vector', () => {
  const out = AES.encryptBlock(
    bytes('00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff'),
    AES.expandKey(bytes('00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f')));
  assert.equal(hex(out), '69 C4 E0 D8 6A 7B 04 30 D8 CD B7 80 70 B4 C5 5A');
});

test('Lotus frames match protocol-notes.md', () => {
  assert.equal(hex(L.power(true)),  '7E 04 04 01 00 01 FF 00 EF');
  assert.equal(hex(L.power(false)), '7E 04 04 00 00 00 FF 00 EF');
  assert.equal(hex(L.rgb(0, 128, 255)), '7E 07 05 03 00 80 FF 10 EF');
  assert.equal(hex(L.setBrightness(50)), '7E 04 01 32 FF FF FF 00 EF');
  assert.equal(hex(L.frame(0x05, 0x06, [0x02, 100, 0, 0xFF, 0x08])),
               '7E 06 05 02 64 00 FF 08 EF');
});

test('Lotus encrypts only commands 1, 3 and 4, and only for ELK-* units', () => {
  const rnd = Uint8Array.from([1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.equal(L.wrap(L.power(true), 'ELK-BLEDOM').length, 9, 'plain unit stays 9 bytes');
  assert.equal(L.wrap(L.power(true), 'ELK-*BLEDOM').length, 21, 'encrypted unit is 21 bytes');
  assert.equal(L.wrap(L.rgb(1,2,3), 'ELK-*BLEDOM').length, 9, 'cmd 5 is never encrypted');
  assert.equal(hex(lotusEncrypt(L.power(true), rnd)),
    '88 59 C0 AE EF 4A FD C9 4C 2B 7D C2 90 36 D8 42 E8 82 1B 57 AA');
});

test('iStrip frames match protocol-notes.md', () => {
  I.state.bright = 100; I.state.group = 1;
  assert.equal(hex(I.power(false)), '54 52 00 57 02 01 00 00 00 00 64 64 00 00 00 00');
  assert.equal(hex(I.rgb(255, 0, 0)), '54 52 00 57 02 01 00 FF 00 00 64 64 00 00 00 00');
  I.state.bright = 50;
  assert.equal(hex(I.rgb(255, 0, 0)), '54 52 00 57 02 01 00 80 00 00 32 64 00 00 00 00',
               'brightness is applied to RGB on the client, as the vendor app does');
  assert.equal(hex(I.lightCmd(50)), '54 52 00 57 07 01 32 00 00 00 00 00 00 00 00 00');
  I.state.bright = 100;
});

test('iStrip encrypts every frame with the extracted AES key', () => {
  I.state.bright = 100; I.state.group = 1;
  assert.equal(hex(I.wrap(I.rgb(255, 0, 0))),
               '12 73 62 2A 87 79 7E 5C 76 82 11 EE 59 30 8E 5B');
  assert.equal(I.wrap(I.power(false)).length, 16);
});

test('master brightness 0 means dark on both protocols', () => {
  const st = { r: 255, g: 0, b: 0, bright: 0 };
  assert.equal(hex(masterFrame(L, 'bright', st)), hex(L.power(false)));
  assert.equal(hex(masterFrame(I, 'bright', st)), hex(I.power(false)));
});

test('master brightness respects each profile floor', () => {
  masterFrame(I, 'bright', { r: 255, g: 0, b: 0, bright: 5 });
  assert.equal(I.state.bright, 10, 'iStrip clamps up to its floor of 10');
  masterFrame(L, 'bright', { r: 255, g: 0, b: 0, bright: 5 });
  assert.equal(L.state.bright, 5, 'Lotus has no floor');
  L.state.bright = 100; I.state.bright = 100;
});

test('master colour scales for iStrip but not for Lotus', () => {
  const st = { r: 255, g: 0, b: 0, bright: 50 };
  assert.equal(hex(masterFrame(I, 'rgb', st)).split(' ')[7], '80');
  assert.equal(hex(masterFrame(L, 'rgb', st)).split(' ')[4], 'FF');
  L.state.bright = 100; I.state.bright = 100;
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/protocol.js`.

- [ ] **Step 3: Create src/protocol.js**

Copy, unchanged, from `../../led-control.html`: the `AES` IIFE, `LOTUS_PRESET_KEY`, `lotusEncrypt`, `hex`, `clamp`, `PROFILES`, `masterFrame`. Add `export` to `AES`, `lotusEncrypt`, `hex`, `clamp`, `PROFILES`, `masterFrame`. Change nothing else — not a constant, not a comment. The comments cite `protocol-notes.md` line numbers and must survive.

`lotusEncrypt` calls `crypto.getRandomValues`. Node 24 has `globalThis.crypto`, so this works unchanged in tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 9 tests. If any frame differs, the extraction changed a byte — diff against the HTML and fix the copy, never the expectation.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.js test/protocol.test.mjs
git commit -m "feat: extract BLE protocol into a pure tested module"
```

---

### Task 3: Regenerate the standalone page from the modules

Keeps the existing open-in-Chrome workflow alive while the source moves to modules.

**Files:**
- Create: `scripts/build-singlefile.mjs`, `test/build-singlefile.test.mjs`
- Writes: `../../led-control.html`

**Interfaces:**
- Consumes: `src/protocol.js` (Task 2).
- Produces: `inlineModules(order: string[]) → string` — concatenated module source with `import`/`export` keywords stripped.

- [ ] **Step 1: Write the failing test**

`test/build-singlefile.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineModules } from '../scripts/build-singlefile.mjs';

test('inlining strips module syntax but keeps the code', async () => {
  const src = await inlineModules(['src/protocol.js']);
  assert.ok(!/^\s*import\s/m.test(src), 'no import statements survive');
  assert.ok(!/^\s*export\s+(const|function)/m.test(src), 'no export keywords survive');
  assert.match(src, /const PROFILES/, 'the declarations are still there');
  assert.match(src, /0x34, ?0x52, ?0x2A/, 'the AES key survives verbatim');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../scripts/build-singlefile.mjs`.

- [ ] **Step 3: Write the script**

```js
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function inlineModules(paths) {
  const parts = [];
  for (const p of paths) {
    const src = await readFile(join(root, p), 'utf8');
    parts.push(src
      .replace(/^\s*import[^;]+;\s*$/gm, '')
      .replace(/^(\s*)export\s+(const|function|class)\s/gm, '$1$2 '));
  }
  return parts.join('\n');
}

export async function build() {
  const order = ['src/protocol.js', 'src/transport.js', 'src/transport-web.js',
                 'src/strip.js', 'src/ui.js'];
  const present = [];
  for (const p of order) {
    try { await readFile(join(root, p)); present.push(p); } catch { /* not built yet */ }
  }
  const js  = await inlineModules(present);
  const css = await readFile(join(root, 'src/app.css'), 'utf8').catch(() => '');
  const html = await readFile(join(root, 'src/index.html'), 'utf8');
  const out = html
    .replace(/<link[^>]+app\.css[^>]*>/, `<style>\n${css}\n</style>`)
    .replace(/<script type="module"[^>]*><\/script>/, `<script>\n"use strict";\n${js}\n</script>`);
  await writeFile(join(root, '../../led-control.html'), out);
  return out.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build().then(n => console.log('wrote ../../led-control.html,', n, 'bytes'));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. `build()` is not exercised yet — `src/index.html` arrives in Task 6.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-singlefile.mjs test/build-singlefile.test.mjs
git commit -m "feat: add single-file build so the standalone page keeps working"
```

---

### Task 4: Transport interface and the Web Bluetooth implementation

**Files:**
- Create: `src/transport.js`, `src/transport-web.js`, `test/transport-fake.test.mjs`
- Source to adapt from: `../../led-control.html` — `Strip.pick()`, `Strip.attach()`, `Strip.send()`.

**Interfaces:**
- Consumes: `PROFILES` from `src/protocol.js`.
- Produces:
  - `export class Transport` — abstract; methods `pick(profile, opts) → Promise<{id,name}>`, `open(profile, id) → Promise<handle>`, `write(handle, bytes) → Promise<void>`, `close(handle) → void`, `onDrop(handle, cb) → void`, `listKnown(profile, knownIds?: string[]) → Promise<Array<{id,name}>>`, and `available() → Promise<{ok: boolean, reason?: string, silentReconnect: boolean}>` — `knownIds` is ignored by the Web implementation and required by the Capacitor one
  - `export class FakeTransport extends Transport` — records every write into `.writes` as `{profileId, hex}`; used by tests
  - `export class WebBluetoothTransport extends Transport` (in `transport-web.js`)
  - handle shape: `{ id, name, chr, noResponse, device }`

- [ ] **Step 1: Write the failing test**

`test/transport-fake.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTransport } from '../src/transport.js';
import { PROFILES, hex } from '../src/protocol.js';

test('FakeTransport records writes per profile', async () => {
  const t = new FakeTransport();
  const dev = await t.pick(PROFILES.lotus, {});
  const h = await t.open(PROFILES.lotus, dev.id);
  await t.write(h, PROFILES.lotus.power(true));
  assert.deepEqual(t.writes, [{ profileId: 'lotus', hex: '7E 04 04 01 00 01 FF 00 EF' }]);
});

test('FakeTransport reports a drop to its listener', async () => {
  const t = new FakeTransport();
  const h = await t.open(PROFILES.istrip, 'fake-istrip');
  let dropped = false;
  t.onDrop(h, () => { dropped = true; });
  t.simulateDrop(h);
  assert.equal(dropped, true);
});

test('FakeTransport remembers opened devices for listKnown', async () => {
  const t = new FakeTransport();
  await t.open(PROFILES.lotus, 'fake-lotus');
  assert.deepEqual(await t.listKnown(PROFILES.lotus), [{ id: 'fake-lotus', name: 'Fake lotus' }]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/transport.js`.

- [ ] **Step 3: Write src/transport.js**

```js
import { hex } from './protocol.js';

/** Every platform BLE binding implements this. Nothing above it may use platform APIs. */
export class Transport {
  async available() { return { ok: false, reason: 'not implemented', silentReconnect: false }; }
  async pick()      { throw new Error('not implemented'); }
  async open()      { throw new Error('not implemented'); }
  async write()     { throw new Error('not implemented'); }
  close()           {}
  onDrop()          {}
  async listKnown(profile, knownIds = []) { return []; }
}

/** Test double: no hardware, records bytes, can fake a disconnect. */
export class FakeTransport extends Transport {
  constructor() { super(); this.writes = []; this.opened = new Map(); this.drops = new Map(); }
  async available() { return { ok: true, silentReconnect: true }; }
  async pick(profile) { return { id: 'fake-' + profile.id, name: 'Fake ' + profile.id }; }
  async open(profile, id) {
    const h = { id, name: 'Fake ' + profile.id, profile, noResponse: true };
    this.opened.set(id, h);
    return h;
  }
  async write(handle, bytes) {
    this.writes.push({ profileId: handle.profile.id, hex: hex(bytes) });
  }
  close(handle) { this.opened.delete(handle.id); }
  onDrop(handle, cb) { this.drops.set(handle.id, cb); }
  simulateDrop(handle) { const cb = this.drops.get(handle.id); if (cb) cb(); }
  async listKnown(profile, knownIds = []) {
    return [...this.opened.values()]
      .filter(h => h.profile.id === profile.id)
      .map(h => ({ id: h.id, name: h.name }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 12 tests total.

- [ ] **Step 5: Write src/transport-web.js**

Port `pick`, `attach` and the write-type fallback out of `../../led-control.html` unchanged in behaviour:

```js
import { Transport } from './transport.js';

export class WebBluetoothTransport extends Transport {
  async available() {
    if (!navigator.bluetooth) {
      return { ok: false, silentReconnect: false,
               reason: 'navigator.bluetooth is unavailable — needs Chrome or Edge over '
                     + 'https:// or http://localhost' };
    }
    let adapter = null;
    try { adapter = await navigator.bluetooth.getAvailability(); } catch {}
    if (adapter === false) {
      return { ok: false, silentReconnect: false,
               reason: 'No Bluetooth adapter available — switch Bluetooth on, then reload' };
    }
    return { ok: true, silentReconnect: typeof navigator.bluetooth.getDevices === 'function' };
  }

  // Both vendor apps scan unfiltered and match in software, so accept-all is the default.
  // A service-UUID filter yields an empty chooser: these strips do not advertise theirs.
  async pick(profile, { narrow } = {}) {
    const opts = narrow
      ? { filters: profile.filters, optionalServices: [profile.service] }
      : { acceptAllDevices: true, optionalServices: [profile.service] };
    let dev;
    try {
      dev = await navigator.bluetooth.requestDevice(opts);
    } catch (e) {
      if (narrow && e && e.name === 'TypeError') {     // manufacturerData needs Chrome 92+
        dev = await navigator.bluetooth.requestDevice(
          { acceptAllDevices: true, optionalServices: [profile.service] });
      } else throw e;
    }
    this._devices ??= new Map();
    this._devices.set(dev.id, dev);
    return { id: dev.id, name: dev.name || profile.name };
  }

  async open(profile, id) {
    this._devices ??= new Map();
    let dev = this._devices.get(id);
    if (!dev && typeof navigator.bluetooth.getDevices === 'function') {
      dev = (await navigator.bluetooth.getDevices()).find(d => d.id === id);
    }
    if (!dev) throw new Error('device not available — press Connect');
    const server  = await dev.gatt.connect();
    const service = await server.getPrimaryService(profile.service);
    const chr     = await service.getCharacteristic(profile.characteristic);
    // The vendor apps never call setWriteType, so the characteristic's own
    // properties decide. Mirror that.
    return { id, name: dev.name || profile.name, chr, device: dev, profile,
             noResponse: !!(chr.properties && chr.properties.writeWithoutResponse) };
  }

  async write(handle, bytes) {
    const { chr, noResponse } = handle;
    try {
      if (noResponse && chr.writeValueWithoutResponse) await chr.writeValueWithoutResponse(bytes);
      else if (chr.writeValueWithResponse) await chr.writeValueWithResponse(bytes);
      else await chr.writeValue(bytes);
    } catch {
      await chr.writeValue(bytes);            // some stacks reject the claimed type
    }
  }

  close(handle) { if (handle.device?.gatt.connected) handle.device.gatt.disconnect(); }

  onDrop(handle, cb) {
    if (handle.device._boundDrop) return;
    handle.device._boundDrop = true;
    handle.device.addEventListener('gattserverdisconnected', cb);
  }

  async listKnown(profile, knownIds = []) {
    if (typeof navigator.bluetooth.getDevices !== 'function') return [];
    const devs = await navigator.bluetooth.getDevices();
    this._devices ??= new Map();
    devs.forEach(d => this._devices.set(d.id, d));
    return devs.map(d => ({ id: d.id, name: d.name || profile.name }));
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/transport.js src/transport-web.js test/transport-fake.test.mjs
git commit -m "feat: add transport interface with Web Bluetooth and fake implementations"
```

---

### Task 5: Strip state machine on top of a transport

**Files:**
- Create: `src/strip.js`, `test/strip.test.mjs`
- Source to adapt from: `../../led-control.html` — `Strip`, `makeThrottle`, `loadStore`, `saveStore`.

**Interfaces:**
- Consumes: `Transport` (Task 4), `PROFILES` (Task 2).
- Produces:
  - `export class Strip` — constructed as `new Strip(profile, transport, store)`; properties `p` (the profile), `handle` (current transport handle, `null` when down), `connected`, `remembered`, `wantConnected`, `retryTimer`; methods `connect(opts)`, `attach(id)`, `disconnect()`, `send(frame)`, `onChange(cb)`
  - `export function makeThrottle(ms) → (fn) => void`
  - `export const memoryStore` — `{ get(id), set(id, rec) }`, the storage seam so tests need no `localStorage`

- [ ] **Step 1: Write the failing test**

`test/strip.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Strip, memoryStore } from '../src/strip.js';
import { FakeTransport } from '../src/transport.js';
import { PROFILES } from '../src/protocol.js';

const newStore = () => { const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) }; };

test('connect opens the transport and remembers the device', async () => {
  const t = new FakeTransport(), store = newStore();
  const s = new Strip(PROFILES.lotus, t, store);
  await s.connect({});
  assert.equal(s.connected, true);
  assert.deepEqual(store.get('lotus'), { id: 'fake-lotus', name: 'Fake lotus' });
});

test('send writes the exact frame through the transport', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.lotus, t, newStore());
  await s.connect({});
  await s.send(PROFILES.lotus.power(true));
  assert.equal(t.writes.at(-1).hex, '7E 04 04 01 00 01 FF 00 EF');
});

test('a deliberate disconnect does not schedule a retry', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.istrip, t, newStore());
  await s.connect({});
  s.disconnect();
  assert.equal(s.wantConnected, false);
  assert.equal(s.connected, false);
});

test('an unexpected drop schedules a retry', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.istrip, t, newStore());
  await s.connect({});
  const handle = s.handle;
  t.simulateDrop(handle);
  assert.equal(s.wantConnected, true, 'still wants to be connected');
  assert.ok(s.retryTimer, 'a retry is pending');
  s.disconnect();                                  // stop the timer so the test exits
});

test('onChange listeners see status messages', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.lotus, t, newStore());
  const seen = [];
  s.onChange((_s, msg) => seen.push(msg));
  await s.connect({});
  assert.ok(seen.some(m => /connected/.test(m)));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../src/strip.js`.

- [ ] **Step 3: Write src/strip.js**

Port the existing class, replacing direct Web Bluetooth calls with transport calls. Keep the backoff ladder exactly as it is (1s, 2s, 4s, 8s, capped 15s, abandon after 120 s) and keep `wantConnected` gating retries. Expose `this.handle` so tests can drive a drop. `memoryStore` wraps `localStorage` when it exists and falls back to a `Map` when it does not, so the same module runs in Node, the browser, Electron and Capacitor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 17 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/strip.js test/strip.test.mjs
git commit -m "feat: move connection state machine onto the transport interface"
```

---

### Task 6: UI modules and the app shell

**REQUIRED SUB-SKILLS for this task:** load `frontend-master` and `frontend-design` before writing any markup or CSS.

**Files:**
- Create: `src/ui.js`, `src/app.css`, `src/index.html`
- Source to adapt from: `../../led-control.html` — `DevicePanel`, `MasterPanel`, `rgbOf`, `hexOf`, and the stylesheet.
- Test: `test/ui-fanout.test.mjs`

**Interfaces:**
- Consumes: `Strip` (Task 5), `masterFrame`, `PROFILES` (Task 2).
- Produces:
  - `export class DevicePanel` — `new DevicePanel(strip, rootEl)`, method `syncWidgets()`
  - `export class MasterPanel` — `new MasterPanel(strips, rootEl, panels)`, methods `fanOut(kind)`, `refresh()`
  - `export function bootstrap({ transport, root }) → { strips, panels, master }`

- [ ] **Step 1: Write the failing test**

`test/ui-fanout.test.mjs` — no DOM needed; it tests the fan-out ordering and byte sequence directly:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Strip } from '../src/strip.js';
import { FakeTransport } from '../src/transport.js';
import { PROFILES, masterFrame } from '../src/protocol.js';

const newStore = () => { const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) }; };

test('a master action writes to every connected strip, in order', async () => {
  const t = new FakeTransport();
  const strips = [new Strip(PROFILES.lotus, t, newStore()),
                  new Strip(PROFILES.istrip, t, newStore())];
  for (const s of strips) await s.connect({});
  t.writes.length = 0;

  const st = { r: 255, g: 0, b: 0, bright: 100 };
  for (const s of strips) await s.send(masterFrame(s.p, 'on', st));

  assert.deepEqual(t.writes.map(w => w.profileId), ['lotus', 'istrip']);
  assert.equal(t.writes[0].hex, '7E 04 04 01 00 01 FF 00 EF');
  strips.forEach(s => s.disconnect());
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `s.p` undefined, or the module is missing.

- [ ] **Step 3: Port the UI**

Move `DevicePanel` and `MasterPanel` across unchanged in behaviour. Requirements that must survive the port, all currently true:

- master panel first, per-device panels collapsed in `<details>` beneath a section heading
- master disabled until at least one strip is connected; header reads `N of 2 connected`
- fan-out is **sequential** (`await` each write — parallel GATT writes to two devices stall)
- after a fan-out, every `DevicePanel.syncWidgets()` runs so the sliders track the master
- power buttons keep the class names `.pwr-on` / `.pwr-off`; **never** `.on`, which collides with the lit status dot `.dot.on`
- 50 ms throttle on colour and brightness input
- TX hex line under each panel
- Bluetooth status line reports availability and whether silent reconnect is on

- [ ] **Step 4: Write src/index.html**

Shell only, referencing `<link rel="stylesheet" href="app.css">` and a single
`<script type="module" src="./main.js"></script>`. Keep the `?selftest=1` block working by
importing from `protocol.js`.

- [ ] **Step 5: Run tests and regenerate the standalone page**

```bash
npm test
npm run build:singlefile
```
Expected: tests PASS; `../../led-control.html` rewritten.

- [ ] **Step 6: Verify the regenerated page in a browser**

Start the vault's loopback server and open the page:
```bash
python -m http.server 8765 --bind 127.0.0.1
```
Check at `http://localhost:8765/led-control.html?selftest=1`: every self-test line PASS, no console errors, master disabled with nothing connected, panels collapse and expand.

- [ ] **Step 7: Commit**

```bash
git add src/ui.js src/app.css src/index.html src/main.js test/ui-fanout.test.mjs ../../led-control.html
git commit -m "feat: split UI into modules and regenerate the standalone page"
```

---

### Task 7: Electron shell with picker-free autoconnect

**Files:**
- Create: `electron/main.js`, `electron/preload.js`
- Modify: `package.json` (add `electron` devDependency and a `start` script)

**Interfaces:**
- Consumes: `src/index.html`.
- Produces: `npm start` opens the app; `window.ledHost.pickDevice(id)` is exposed to the page for first-run device selection.

- [ ] **Step 1: Install Electron**

```bash
npm install --save-dev electron
```

- [ ] **Step 2: Write electron/main.js**

```js
import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let pendingCallback = null;
const remembered = new Set();          // device names the renderer has told us about

function createWindow() {
  const win = new BrowserWindow({
    width: 520, height: 840, backgroundColor: '#0e0f13',
    webPreferences: { preload: join(here, 'preload.js') }
  });

  // This is the whole autoconnect story on desktop: answer the chooser ourselves.
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    const match = devices.find(d => remembered.has(d.deviceName));
    if (match) return callback(match.deviceId);
    pendingCallback = callback;                    // first run: let the page choose
    win.webContents.send('ble-devices', devices.map(
      d => ({ id: d.deviceId, name: d.deviceName })));
  });

  win.loadFile(join(here, '..', 'src', 'index.html'));
  return win;
}

ipcMain.on('ble-remember', (_e, names) => names.forEach(n => n && remembered.add(n)));
ipcMain.on('ble-pick', (_e, id) => {
  const cb = pendingCallback; pendingCallback = null;
  if (cb) cb(id || '');                            // '' cancels requestDevice cleanly
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

- [ ] **Step 3: Write electron/preload.js**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledHost', {
  isElectron: true,
  remember:  names => ipcRenderer.send('ble-remember', names),
  pickDevice: id   => ipcRenderer.send('ble-pick', id),
  onDevices: cb    => ipcRenderer.on('ble-devices', (_e, list) => cb(list))
});
```

- [ ] **Step 4: Teach the page about the host**

In `src/main.js`, after the strips are constructed, push remembered names to the host and
render the in-app picker when it offers a device list:

```js
if (globalThis.ledHost?.isElectron) {
  ledHost.remember(strips.map(s => s.remembered?.name).filter(Boolean));
  ledHost.onDevices(list => showHostPicker(list, id => ledHost.pickDevice(id)));
}
```

`showHostPicker` renders a simple list into the page and calls back with the chosen id, or
with `''` if the user dismisses it.

- [ ] **Step 5: Add the start script**

In `package.json` scripts: `"start": "electron electron/main.js"`.

- [ ] **Step 6: Run it**

Run: `npm start`
Expected: the window opens, the Bluetooth status line reads ready, `npm test` still passes.
With no strips in range the picker list will be empty — that is correct.

- [ ] **Step 7: Commit**

```bash
git add electron package.json package-lock.json src/main.js
git commit -m "feat: add Electron shell with programmatic device selection"
```

---

### Task 8: Package the desktop app

**Files:**
- Modify: `package.json`
- Create: `build/icon.png` (512×512)

- [ ] **Step 1: Install electron-builder**

```bash
npm install --save-dev electron-builder
```

- [ ] **Step 2: Add build config to package.json**

```json
"build": {
  "appId": "dev.fantom.ledcontrol",
  "productName": "LED Control",
  "files": ["electron/**", "src/**", "package.json"],
  "win": { "target": "portable", "icon": "build/icon.png" },
  "directories": { "output": "dist" }
}
```
and script `"dist": "electron-builder --win portable"`.

- [ ] **Step 3: Build**

Run: `npm run dist`
Expected: `dist/LED Control <version>.exe`, a single portable executable.

- [ ] **Step 4: Verify the built app runs**

Launch the exe. The window opens and the status line reports Bluetooth ready.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json build/icon.png
git commit -m "build: package the desktop app as a portable Windows executable"
```

---

### Task 9: Capacitor project and the Android BLE transport

**Files:**
- Create: `capacitor.config.json`, `src/transport-cap.js`
- Modify: `package.json`, `src/main.js`

**Interfaces:**
- Produces: `export class CapacitorBleTransport extends Transport` — same six methods plus `available()`.

- [ ] **Step 1: Install Capacitor and the BLE plugin**

```bash
npm install @capacitor/core @capacitor/android @capacitor-community/bluetooth-le
npm install --save-dev @capacitor/cli
```

- [ ] **Step 2: Write capacitor.config.json**

```json
{
  "appId": "dev.fantom.ledcontrol",
  "appName": "LED Control",
  "webDir": "src",
  "bundledWebRuntime": false
}
```

- [ ] **Step 3: Write src/transport-cap.js**

```js
import { Transport } from './transport.js';
import { BleClient, numbersToDataView } from '@capacitor-community/bluetooth-le';

export class CapacitorBleTransport extends Transport {
  async available() {
    try {
      await BleClient.initialize({ androidNeverForLocation: true });
      const on = await BleClient.isEnabled();
      return on ? { ok: true, silentReconnect: true }
                : { ok: false, silentReconnect: true, reason: 'Bluetooth is off' };
    } catch (e) {
      return { ok: false, silentReconnect: false, reason: e.message };
    }
  }

  // The vendor apps scan unfiltered and match in software; allowDuplicates keeps
  // the strips visible while the sheet is open.
  async pick(profile) {
    const dev = await BleClient.requestDevice({ optionalServices: [profile.service] });
    return { id: dev.deviceId, name: dev.name || profile.name };
  }

  async open(profile, id) {
    const handle = { id, name: profile.name, profile, noResponse: true };
    await BleClient.connect(id, () => handle._onDrop && handle._onDrop());
    return handle;
  }

  async write(handle, bytes) {
    const { profile, id } = handle;
    const view = numbersToDataView(Array.from(bytes));
    try {
      await BleClient.writeWithoutResponse(id, profile.service, profile.characteristic, view);
    } catch {
      await BleClient.write(id, profile.service, profile.characteristic, view);
    }
  }

  close(handle) { BleClient.disconnect(handle.id).catch(() => {}); }
  onDrop(handle, cb) { handle._onDrop = cb; }

  // No flag needed here — this is why the APK autoconnects and the browser cannot.
  async listKnown(profile, knownIds = []) {
    if (!knownIds.length) return [];
    const devs = await BleClient.getDevices(knownIds);
    return devs.map(d => ({ id: d.deviceId, name: d.name || profile.name }));
  }
}
```

- [ ] **Step 4: Select the transport at runtime**

In `src/main.js`:
```js
const transport = globalThis.Capacitor?.isNativePlatform?.()
  ? new (await import('./transport-cap.js')).CapacitorBleTransport()
  : new (await import('./transport-web.js')).WebBluetoothTransport();
```

- [ ] **Step 5: Verify the web build still works**

Run: `npm test && npm run build:singlefile`
Expected: PASS; the regenerated page still loads in the browser. The dynamic import means
the Capacitor module is never fetched on the web.

- [ ] **Step 6: Commit**

```bash
git add capacitor.config.json src/transport-cap.js src/main.js package.json package-lock.json
git commit -m "feat: add Capacitor BLE transport for Android"
```

---

### Task 10: Android platform and permissions

**Files:**
- Create: `android/` (generated), then hand-edit `android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Add the Android platform**

```bash
npx cap add android
```
This scaffolds from a template and should not need the Android SDK. **If it fails asking for
the SDK**, skip to Task 11, let the CI job run `npx cap add android` on the runner, download
the generated `android/` directory from the build artifacts, commit it, then return here.

- [ ] **Step 2: Add the permissions**

In `android/app/src/main/AndroidManifest.xml`, inside `<manifest>`:
```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
                 android:usesPermissionFlags="neverForLocation"
                 tools:targetApi="s" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"
                 android:maxSdkVersion="30" />
<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
```
Ensure the root element carries `xmlns:tools="http://schemas.android.com/tools"`.

- [ ] **Step 3: Sync the web assets**

```bash
npx cap sync android
```

- [ ] **Step 4: Commit**

```bash
git add android
git commit -m "feat: add Android platform with BLE permissions"
```

---

### Task 11: CI, the private repo, and the APK

**Files:**
- Create: `.github/workflows/android.yml`, `README.md`

- [ ] **Step 1: Write the workflow**

```yaml
name: android
on:
  push: { branches: [main] }
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - name: Protocol tests
        run: npm test
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - run: npx cap sync android
      - name: Build debug APK
        run: ./gradlew assembleDebug
        working-directory: android
      - uses: actions/upload-artifact@v4
        with:
          name: led-control-debug-apk
          path: android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 2: Write README.md**

Cover: what the app controls, that the protocols are documented in the vault's
`protocol-notes.md`, how to run (`npm start`), how to build the desktop app (`npm run dist`),
where the APK comes from (the `android` workflow artifact), and that the APK is debug-signed
so "install from unknown sources" must be allowed.

- [ ] **Step 3: Create the private repo and push**

```bash
gh repo create led-control --private --source=. --remote=origin --push
```

- [ ] **Step 4: Watch the build**

```bash
gh run watch
```
Expected: `npm test` passes, `assembleDebug` succeeds, the artifact appears.

- [ ] **Step 5: Install and try it**

Download the artifact, unzip, sideload `app-debug.apk`. Grant Bluetooth and Location when
asked. First run: one tap per strip. Kill the app, reopen it — both strips should connect
with no picker.

- [ ] **Step 6: Commit**

```bash
git add .github README.md
git commit -m "ci: build the Android APK on GitHub Actions"
git push
```

---

## Done when

- `npm test` passes: AES vector, every documented frame, the master mapping rules, the
  transport contract, the strip state machine, and the fan-out ordering.
- `npm start` opens the desktop app and both strips connect without a picker on second run.
- The APK installs on the phone and both strips connect on launch without a picker.
- `../../led-control.html` still works in Chrome, regenerated from the modules.
- The bytes on the wire are unchanged from the version confirmed against real hardware.
