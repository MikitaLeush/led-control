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

  /* Both vendor apps scan unfiltered and match in software, so no service filter
     here either — these strips do not advertise their service UUID. */
  async pick(profile) {
    const { BleClient } = ble();
    const dev = await BleClient.requestDevice({ optionalServices: [profile.service] });
    return { id: dev.deviceId, name: dev.name || profile.name };
  }

  async open(profile, id) {
    const { BleClient } = ble();
    const handle = { id, name: profile.name, profile, noResponse: true };
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
