/* The seam between the app and whatever BLE stack the platform gives us.
   Web Bluetooth (browser, Electron) and the Capacitor plugin (Android) differ in
   how devices are chosen and how a previously-paired device is reopened; nothing
   above this interface is allowed to care. */

import { hex } from './protocol.js';

export class Transport {
  /** → { ok, reason?, silentReconnect } — can we work here, and can we skip the picker? */
  async available() { return { ok: false, reason: 'not implemented', silentReconnect: false }; }
  /** User-facing device selection. → { id, name } */
  async pick()  { throw new Error('not implemented'); }
  /** Connect and resolve the write characteristic. → handle */
  async open()  { throw new Error('not implemented'); }
  async write() { throw new Error('not implemented'); }
  close()       {}
  onDrop()      {}
  /** Devices this origin may reopen without a picker. `knownIds` is required by
      the Capacitor implementation and ignored by the Web one. */
  async listKnown(profile, knownIds = []) { return []; }
}

/* Test double. No hardware, records every byte, and can fake a disconnect so the
   reconnect logic in strip.js is testable without a strip. */
export class FakeTransport extends Transport {
  constructor() {
    super();
    this.writes = [];
    this.opened = new Map();      // currently connected
    this.permitted = new Map();   // ever granted — survives close(), like getDevices()
    this.drops  = new Map();
  }

  async available() { return { ok: true, silentReconnect: true }; }

  async pick(profile) { return { id: 'fake-' + profile.id, name: 'Fake ' + profile.id }; }

  async open(profile, id) {
    const h = { id, name: 'Fake ' + profile.id, profile, noResponse: true };
    this.opened.set(id, h);
    this.permitted.set(id, h);
    return h;
  }

  async write(handle, bytes) {
    this.writes.push({ profileId: handle.profile.id, hex: hex(bytes) });
  }

  close(handle) { this.opened.delete(handle.id); }

  onDrop(handle, cb) { this.drops.set(handle.id, cb); }

  simulateDrop(handle) {
    const cb = this.drops.get(handle.id);
    if (cb) cb();
  }

  /* Permission outlives the connection, as it does in both real transports. */
  async listKnown(profile, knownIds = []) {
    return [...this.permitted.values()]
      .filter(h => h.profile.id === profile.id)
      .map(h => ({ id: h.id, name: h.name }));
  }
}
