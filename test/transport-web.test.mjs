import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebBluetoothTransport } from '../src/transport-web.js';
import { PROFILES } from '../src/protocol.js';

/* Seen on real hardware 2026-09-28: "Connect all" was scanning for the iStrip
   when the Electron autoconnect ticker started a Lotus scan. Chromium allows one
   chooser at a time — the iStrip's was cancelled and it never connected. */
test('requestDevice() calls for different strips never overlap', async () => {
  let live = 0, peak = 0;
  Object.defineProperty(globalThis.navigator, 'bluetooth', { configurable: true, value: {
    async requestDevice() {
      peak = Math.max(peak, ++live);
      await new Promise(r => setTimeout(r, 20));
      live--;
      return { id: 'x' + Math.random(), name: 'dev' };
    }
  } });
  try {
    const t = new WebBluetoothTransport({ alwaysNarrow: true });
    await Promise.all([t.pick(PROFILES.istrip), t.pick(PROFILES.lotus)]);
    assert.equal(peak, 1);
  } finally {
    delete globalThis.navigator.bluetooth;
  }
});

test('a failed scan does not block the next one', async () => {
  let n = 0;
  Object.defineProperty(globalThis.navigator, 'bluetooth', { configurable: true, value: {
    async requestDevice() {
      if (n++ === 0) throw Object.assign(new Error('none'), { name: 'NotFoundError' });
      return { id: 'ok', name: 'dev' };
    }
  } });
  try {
    const t = new WebBluetoothTransport({ alwaysNarrow: true });
    const [a, b] = await Promise.allSettled([t.pick(PROFILES.istrip), t.pick(PROFILES.lotus)]);
    assert.equal(a.status, 'rejected');
    assert.equal(b.value.id, 'ok');
  } finally {
    delete globalThis.navigator.bluetooth;
  }
});
