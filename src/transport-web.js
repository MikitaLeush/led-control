/* Web Bluetooth transport — used by the browser page and by Electron.
   Electron answers the chooser programmatically in its main process, so the same
   requestDevice() call there resolves with no visible picker. */

import { Transport } from './transport.js';

export class WebBluetoothTransport extends Transport {
  constructor() {
    super();
    this.devices = new Map();          // id → BluetoothDevice, for reopening
  }

  async available() {
    if (!navigator.bluetooth) {
      return { ok: false, silentReconnect: false,
               reason: 'navigator.bluetooth is unavailable — needs Chrome or Edge, '
                     + 'served over https:// or http://localhost' };
    }
    let adapter = null;
    try { adapter = await navigator.bluetooth.getAvailability(); } catch { /* older Chrome */ }
    if (adapter === false) {
      return { ok: false, silentReconnect: false,
               reason: 'No Bluetooth adapter available — switch Bluetooth on, then reload' };
    }
    // getDevices() is what allows a silent reconnect after a reload. It sits behind
    // chrome://flags/#enable-web-bluetooth-new-permissions-backend.
    return { ok: true, silentReconnect: typeof navigator.bluetooth.getDevices === 'function' };
  }

  /* Both vendor apps scan with no scan filter and match in software, so accept-all
     is the default here. Filtering on the service UUID returns an empty chooser:
     these strips do not advertise theirs. */
  async pick(profile, { narrow } = {}) {
    const wide = { acceptAllDevices: true, optionalServices: [profile.service] };
    let dev;
    try {
      dev = await navigator.bluetooth.requestDevice(narrow
        ? { filters: profile.filters, optionalServices: [profile.service] }
        : wide);
    } catch (e) {
      // manufacturerData filters need Chrome 92+; fall back rather than dead-end.
      if (narrow && e && e.name === 'TypeError') dev = await navigator.bluetooth.requestDevice(wide);
      else throw e;
    }
    this.devices.set(dev.id, dev);
    return { id: dev.id, name: dev.name || profile.name };
  }

  async open(profile, id) {
    let dev = this.devices.get(id);
    if (!dev && typeof navigator.bluetooth.getDevices === 'function') {
      dev = (await navigator.bluetooth.getDevices()).find(d => d.id === id);
      if (dev) this.devices.set(id, dev);
    }
    if (!dev) throw new Error('device not available in this session — press Connect');

    const server  = await dev.gatt.connect();
    const service = await server.getPrimaryService(profile.service);
    const chr     = await service.getCharacteristic(profile.characteristic);

    // The vendor apps never call setWriteType, so the characteristic's own
    // properties decide. Mirror that.
    return { id, name: dev.name || profile.name, profile, device: dev, chr,
             noResponse: !!(chr.properties && chr.properties.writeWithoutResponse) };
  }

  async write(handle, bytes) {
    const { chr, noResponse } = handle;
    try {
      if (noResponse && chr.writeValueWithoutResponse) await chr.writeValueWithoutResponse(bytes);
      else if (chr.writeValueWithResponse) await chr.writeValueWithResponse(bytes);
      else await chr.writeValue(bytes);
    } catch {
      await chr.writeValue(bytes);      // some stacks reject the type they advertise
    }
  }

  close(handle) {
    if (handle.device && handle.device.gatt.connected) handle.device.gatt.disconnect();
  }

  onDrop(handle, cb) {
    const dev = handle.device;
    if (!dev || dev._boundDrop) return;    // the listener outlives reconnects
    dev._boundDrop = true;
    dev.addEventListener('gattserverdisconnected', cb);
  }

  async listKnown(profile, knownIds = []) {
    if (typeof navigator.bluetooth.getDevices !== 'function') return [];
    const devs = await navigator.bluetooth.getDevices();
    devs.forEach(d => this.devices.set(d.id, d));
    return devs.map(d => ({ id: d.id, name: d.name || profile.name }));
  }
}
