/* Android transport, on @capacitor-community/bluetooth-le.

   This is the only place that gets true silent reconnect: BleClient.getDevices()
   reopens a remembered device with no user gesture and no flag, which neither the
   browser nor Electron will do.

   The plugin is reached through the global its IIFE build exposes rather than a
   bare import — this project has no bundler, and `import '@capacitor-community/…'`
   does not resolve inside a WebView. scripts/sync-vendor.mjs puts the two vendor
   scripts in place and index.html loads them. */

import { Transport } from './transport.js';

function ble() {
  const g = globalThis.capacitorCommunityBluetoothLe;
  if (!g || !g.BleClient) {
    throw new Error('Bluetooth plugin missing — run scripts/sync-vendor.mjs before cap sync');
  }
  return g;
}

export class CapacitorBleTransport extends Transport {
  /* Native scans and matches in software, so a device can be found with no
     gesture and no dialog. */
  get canPickSilently() { return true; }

  async available() {
    try {
      const { BleClient } = ble();
      // neverForLocation matches the manifest: we do not derive location from scans.
      await BleClient.initialize({ androidNeverForLocation: true });
      const on = await BleClient.isEnabled();
      return on
        ? { ok: true, silentReconnect: true }
        : { ok: false, silentReconnect: true, reason: 'Bluetooth is off — switch it on' };
    } catch (e) {
      return { ok: false, silentReconnect: false, reason: (e && e.message) || String(e) };
    }
  }

  /* No chooser. BleClient.requestDevice() would put up the plugin's own device
     dialog; neither vendor app does that. They scan unfiltered and match in
     software — by GAP name (Lotus) or manufacturer data (iStrip) — so do the
     same and connect to the first strip that matches. Falls back to the dialog
     only if the scan finds nothing, so there is still a way through. */
  async pick(profile, { scanMs = 8000, noDialog = false } = {}) {
    const { BleClient, dataViewToNumbers } = ble();

    const found = await new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        BleClient.stopLEScan().catch(() => {});
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), scanMs);

      BleClient.requestLEScan({ allowDuplicates: false }, result => {
        const manufacturer = {};
        for (const [id, view] of Object.entries(result.manufacturerData || {})) {
          manufacturer[id] = dataViewToNumbers(view);
        }
        const name = result.localName || (result.device && result.device.name);
        if (profile.matchAdvert({ name, manufacturer })) {
          finish({ id: result.device.deviceId, name: name || profile.name });
        }
      }).catch(err => finish({ error: err }));
    });

    if (found && found.id) return found;
    if (found && found.error) throw found.error;

    // Nothing matched. An automatic re-pick must not put a dialog in front of
    // someone who did not ask for one.
    if (noDialog) throw new Error('no ' + profile.name + ' found in range');
    const dev = await BleClient.requestDevice({ optionalServices: [profile.service] });
    return { id: dev.deviceId, name: dev.name || profile.name };
  }

  async open(profile, id, nameHint) {
    const { BleClient } = ble();
    const handle = { id, name: nameHint || profile.name, profile, noResponse: true };
    await BleClient.connect(id, () => { if (handle._onDrop) handle._onDrop(); });
    return handle;
  }

  async write(handle, bytes) {
    const { BleClient, numbersToDataView } = ble();
    const { profile, id } = handle;
    const view = numbersToDataView(Array.from(bytes));
    try {
      await BleClient.writeWithoutResponse(id, profile.service, profile.characteristic, view);
    } catch {
      // Some firmware only accepts acknowledged writes; the vendor apps never set
      // a write type, so fall back rather than fail.
      await BleClient.write(id, profile.service, profile.characteristic, view);
    }
  }

  close(handle) {
    try { ble().BleClient.disconnect(handle.id).catch(() => {}); } catch { /* plugin gone */ }
  }

  onDrop(handle, cb) { handle._onDrop = cb; }

  /* No flag, no gesture — this is why the APK cold-starts into a connection. */
  async listKnown(profile, knownIds = []) {
    if (!knownIds.length) return [];
    try {
      const devs = await ble().BleClient.getDevices(knownIds);
      return devs.map(d => ({ id: d.deviceId, name: d.name || profile.name }));
    } catch {
      return [];
    }
  }
}
