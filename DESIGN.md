# LED Control — desktop and Android apps

Design doc. Written 2026-09-14.

## Context

Two BLE LED strip controllers, each previously locked to its own vendor Android app:
Lotus Lantern (`wl.smartled`) and iStrip+ (`com.ben.istrips`). Their GATT protocols were
reverse-engineered from the decompiled APKs and are documented, with citations, in
[`../../protocol-notes.md`](../../protocol-notes.md). Both are hardware-confirmed: the
existing single-file page `../../led-control.html` drives both strips today.

Two things push this from a page to real apps:

1. **Convenience.** An icon on the phone and on the desktop, not a bookmarked file.
2. **Autoconnect.** The browser's device picker is a sandbox rule, not a protocol
   limitation. `navigator.bluetooth.getDevices()` is flag-gated in Chrome, so a plain web
   page cannot silently reconnect after a cold start. Both app shells can:
   Electron intercepts `select-bluetooth-device` and answers it programmatically; a native
   Android build reconnects by remembered device id. In both cases the picker disappears
   entirely after first pairing.

Success criteria: launch either app, strips connect by themselves, one set of controls
drives both, and the byte-level behaviour is identical to the page that already works.

## Non-goals

- Play Store release and release signing. Debug-signed APK, sideloaded.
- Effects, music reactivity, timers, colour temperature. The protocols for several of these
  are documented but untested; adding them is separate work.
- iOS.
- Any change to the protocol itself. This project repackages known-good bytes.

## Approach

Three targets share one protocol implementation and one UI, with BLE behind a small
interface. Rejected alternatives: separate web and Android codebases (the protocol would be
written twice and drift), and Capacitor for desktop as well (its Electron target is thinner
and we would give up Web Bluetooth for nothing).

## Architecture

```
projects/led-control/
  src/
    protocol.js        AES-128, lotusEncrypt, PROFILES, masterFrame — pure functions
    transport.js       Transport interface + shared helpers
    transport-web.js   Web Bluetooth        (browser, Electron)
    transport-cap.js   Capacitor BLE plugin (Android)
    strip.js           connection state machine, backoff, remembered device
    ui.js              DevicePanel, MasterPanel
    main.js            entry point; selects a transport at runtime, wires the host bridge
    app.css
    index.html         shell
  test/
    protocol.test.mjs  node --test
  electron/
    main.js            BrowserWindow + select-bluetooth-device auto-answer
  scripts/
    build-singlefile.mjs   inlines src/ back into ../../led-control.html
  android/               Capacitor platform (committed, manifest hand-edited)
  .github/workflows/android.yml
  capacitor.config.json
  package.json
```

### protocol.js — the part that matters

Everything byte-related, as pure functions with no DOM and no BLE: the AES-128 ECB
implementation and its key, the Lotus stream cipher, both device profiles, and
`masterFrame()` (the one control surface → two protocols mapping, including the rule that
brightness 0 becomes a power-off frame on both because iStrip's own floor is 10).

Being pure is the point: it makes the frame behaviour testable under `node --test` with no
browser and no hardware, which is a real improvement over today's in-page self-test.

### Transport interface

```
pick(profile, { narrow })   → { id, name }     user-facing device selection
open(profile, id)           → handle           connect + resolve characteristic
write(handle, bytes)        → void
close(handle)               → void
onDrop(handle, cb)          → void
listKnown(profile)          → [{ id, name }]   previously permitted devices, may be empty
```

`listKnown()` is what makes autoconnect portable: Web Bluetooth answers from
`getDevices()` when the flag is on and returns `[]` otherwise; Capacitor answers from
`BleClient.getDevices([savedIds])`, which needs no flag. Everything above the interface is
platform-blind.

Capacitor implementation uses `@capacitor-community/bluetooth-le`:
`BleClient.initialize()`, `requestDevice()`, `connect(id, onDisconnect)`,
`writeWithoutResponse(id, service, characteristic, DataView)`.

### strip.js

Owns one connection: which transport, current handle, the retry/backoff ladder
(1s/2s/4s/8s/15s, give up after 2 min), the remembered device record, and the
deliberate-disconnect flag that stops retries fighting the user. Emits change events; the
UI subscribes. This is today's `Strip` class with the BLE calls routed through a transport.

### Electron main process

A `BrowserWindow` loading `src/index.html`, plus the autoconnect hook:

```js
contents.on('select-bluetooth-device', (event, devices, callback) => {
  event.preventDefault();
  const match = devices.find(d => remembered.has(d.deviceName));
  if (match) return callback(match.deviceId);        // silent reconnect
  renderer.send('ble-devices', devices);             // first run: let the page show a list
  pendingCallback = callback;                        // answered by an IPC message, or
});                                                  // by '' on a timeout, which cancels
```

Two states, and the handler must distinguish them. When the device name is already
remembered it answers immediately and no chooser is ever shown. When it is not — first run —
the event fires repeatedly as the scan discovers devices, so the handler forwards the list
to the renderer, which draws an in-app picker; the user's click sends back an id over IPC.
If nothing is chosen within the scan window the handler must call `callback('')`, which
cancels cleanly. Failing to answer at all leaves `requestDevice()` hanging forever.

**Correction, measured against Electron 44 rather than assumed.** An earlier draft of this
document claimed the desktop app would "cold-start straight into connected". It will not.
Electron exposes **no `getDevices()`**, and `requestDevice()` still requires transient user
activation — calling it on load fails with
`SecurityError: Must be handling a user gesture`. What the shell actually removes is the
*dialog*, not the tap:

| | Browser | Electron |
|---|---|---|
| First connect after launch | chooser dialog, one tap | no dialog, one tap |
| Reconnect after a drop | automatic | automatic |
| Across restarts | chooser again | one tap, no dialog |

Reconnection after a drop needs no gesture in either, because the `BluetoothDevice` object
is still held in memory and `gatt.connect()` may be called on it freely. True silent
cold-start remains an Android-only property, where `BleClient.getDevices([id])` reopens a
remembered device with no gesture and no flag.

### Android specifics

`AndroidManifest.xml` needs `BLUETOOTH_SCAN` (with `usesPermissionFlags="neverForLocation"`),
`BLUETOOTH_CONNECT`, and `ACCESS_FINE_LOCATION` for API ≤ 30. The app asks for them on first
launch through the plugin's `initialize()`.

### Build outputs

- Desktop: `electron-builder`, Windows `portable` target → a single `.exe`.
- Android: `gradlew assembleDebug` → `app-debug.apk`, sideloaded.
- Web: `scripts/build-singlefile.mjs` regenerates `../../led-control.html` so the existing
  open-the-file workflow does not break.

## Repository and CI

The app gets its **own private GitHub repo**, `MikitaLeush/led-control` (`gh` is already
authenticated as `MikitaLeush`), with `projects/led-control/` in the vault as the working
copy — its own `.git`, unrelated to anything else in the vault. The
vault is deliberately not used: it is not a git repo today, and it holds the CRM and money
ledger, which have no business on GitHub just to build an APK.

`.github/workflows/android.yml` on `ubuntu-latest`: `actions/setup-java` 17, `npm ci`,
`npx cap sync android`, `./gradlew assembleDebug`, upload the APK as a build artifact.
`node --test` runs in the same workflow on every push, so a protocol regression fails the
build rather than the hardware.

## Vault housekeeping

`.stignore` gains `**/node_modules`, `**/dist`, `**/.gradle`, and the Gradle/Android build
output directories, so Syncthing replicates source across machines but not a build tree.
The `android/` platform folder stays synced — it is source, and small.

## UI work

The UI is a port of what exists, not a redesign, but it moves from one 900-line HTML file to
modules and gains a mobile-first layout. Load `frontend-master` (and `frontend-design` for
visual direction) before writing `ui.js` and `app.css`.

Constraints that carry over: touch targets ≥ 44 px, the master panel first and the
per-device panels collapsed beneath it, a visible TX hex line, and the connection status
line that says plainly why Bluetooth is unavailable when it is.

## Testing

| Layer | How |
|---|---|
| `protocol.js` | `node --test` — AES FIPS-197 C.1 vector, every command frame byte-compared against `protocol-notes.md`, `masterFrame` mapping rules (0 → power-off, iStrip clamp to 10, RGB scaling) |
| Transport | Fake transport records writes; drive the UI and assert the exact byte sequence, as was done manually in the browser console |
| Electron | Launch, assert the window loads and the `select-bluetooth-device` handler is registered |
| Android | No emulator BLE. Install the APK and try it |
| Hardware | Yours. Both strips, both apps |

## Phases

1. Extract `protocol.js` + tests; keep the existing page working through
   `build-singlefile.mjs`. Nothing user-visible changes.
2. Transport interface + `transport-web.js`; page still works.
3. Electron shell with autoconnect. Desktop app done.
4. Capacitor + `transport-cap.js` + manifest + CI. APK downloadable from the build.

Each phase leaves something working.

## Risks

- **`npx cap add android` may want the Android SDK locally.** It scaffolds from a template
  and should not need it, but if it does, the fallback is to generate the platform in CI
  once and commit the result.
- **Capacitor BLE plugin behaviour differs from Web Bluetooth** around write types and
  disconnect callbacks. The transport interface is where that gets absorbed; expect the
  Android path to need hardware iteration.
- **Electron's `select-bluetooth-device` fires repeatedly** while scanning. The handler must
  be idempotent and must eventually answer `''` to cancel, or `requestDevice()` hangs.
- **No hardware in CI.** Tests prove the bytes, never the strips.
