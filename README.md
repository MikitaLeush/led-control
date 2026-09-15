# LED Control

One control surface for two Bluetooth LE LED strip controllers that speak entirely
different protocols:

| | Lotus Lantern (`wl.smartled`) | iStrip+ (`com.ben.istrips`) |
|---|---|---|
| Service | `0000fff0-…` | `0000AC50-1212-EFDE-1523-785FEDBEDA25` |
| Frame | 9 bytes, `7E … EF` | 16 bytes, `54 52 00 57 …` |
| Encryption | only on `ELK-*` units, cmds 1/3/4 | **always**, AES-128 ECB |
| Brightness | its own command, 0–100 | scale RGB client-side, 10–100 |

Both protocols were reverse-engineered from the vendor APKs and are documented, with
citations down to file and line, in the vault's `protocol-notes.md`. Both are confirmed
against the real hardware.

## Running it

```bash
npm install
npm start           # desktop app (Electron)
npm test            # protocol + transport + reconnect tests, no hardware needed
```

The standalone page — open `led-control.html` in Chrome, no install:

```bash
npm run build:singlefile
npm run serve       # then http://127.0.0.1:8765/led-control.html
```

Append `?selftest=1` to print every command frame and an AES known-answer test without
touching a strip.

## The Android APK

Built by CI, not locally — nothing here needs an Android SDK on your machine.

1. Push to `main`, or run the **android** workflow by hand.
2. Download the `led-control-debug-apk` artifact from the run.
3. Unzip, sideload `app-debug.apk`. It is **debug-signed**, so Android will ask you to
   allow installing from an unknown source.

To build it locally anyway you need JDK 21 and an Android SDK with API 36, then:

```bash
npm run sync:android && cd android && ./gradlew assembleDebug
```

## How autoconnect differs per platform

The browser's device picker is a sandbox rule, not a protocol limit, and each shell
relaxes it by a different amount. Measured, not assumed:

| | First connect after launch | Reconnect after a drop |
|---|---|---|
| Chrome | chooser dialog, one tap | automatic |
| Electron | no dialog, one tap | automatic |
| Android APK | **none — connects on its own** | automatic |

Only Android gets a silent cold start, because `BleClient.getDevices([id])` reopens a
remembered device with no user gesture. Electron exposes no `getDevices()` and still
requires a gesture for `requestDevice()`; it removes the dialog, not the tap.

An ELK-BLEDOM drops an idle link as a matter of course. The app treats that as normal and
reconnects on its own, backing off to one attempt every 15 s, with no deadline — Connect
stays enabled throughout so there is always a manual way out.

## Layout

```
src/protocol.js       every byte-level decision, pure functions, no DOM and no BLE
src/transport*.js     the BLE seam — Web Bluetooth, Capacitor, and a fake for tests
src/strip.js          connection state, reconnect ladder, remembered device
src/ui.js             panels; the page is lit by the colour it is sending
electron/             desktop shell; answers the Bluetooth chooser itself
scripts/              single-file build, vendor sync, loopback dev server
```

No bundler. `src/` is native ES modules, loaded directly by Electron over a privileged
`app://` scheme, by Capacitor as `webDir`, and by the browser.

## Not implemented

Colour temperature, effects, speed, timers and music reactivity. The frames for several of
these are documented but were never exercised against hardware — see the verification
section of `protocol-notes.md` before trusting any of them.
