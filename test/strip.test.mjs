import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Strip } from '../src/strip.js';
import { FakeTransport } from '../src/transport.js';
import { PROFILES } from '../src/protocol.js';

const newStore = () => {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
};

test('connect opens the transport and remembers the device', async () => {
  const t = new FakeTransport(), store = newStore();
  const s = new Strip(PROFILES.lotus, t, store);
  await s.connect({});
  assert.equal(s.connected, true);
  assert.deepEqual(store.get('lotus'), { id: 'fake-lotus', name: 'Fake lotus' });
  s.disconnect();
});

test('send writes the exact frame through the transport', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.lotus, t, newStore());
  await s.connect({});
  await s.send(PROFILES.lotus.power(true));
  assert.equal(t.writes.at(-1).hex, '7E 04 04 01 00 01 FF 00 EF');
  s.disconnect();
});

test('send applies the profile wrap — iStrip frames go out encrypted', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.istrip, t, newStore());
  await s.connect({});
  PROFILES.istrip.state.bright = 100;
  PROFILES.istrip.state.group = 1;
  await s.send(PROFILES.istrip.rgb(255, 0, 0));
  assert.equal(t.writes.at(-1).hex, '12 73 62 2A 87 79 7E 5C 76 82 11 EE 59 30 8E 5B',
               'the wire bytes are the AES ciphertext, not the plaintext frame');
  s.disconnect();
});

test('a deliberate disconnect does not schedule a retry', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.istrip, t, newStore());
  await s.connect({});
  s.disconnect();
  assert.equal(s.wantConnected, false);
  assert.equal(s.connected, false);
  assert.equal(s.retryTimer, null);
});

test('an unexpected drop schedules a retry', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.istrip, t, newStore());
  await s.connect({});
  t.simulateDrop(s.handle);
  assert.equal(s.wantConnected, true, 'still wants to be connected');
  assert.ok(s.retryTimer, 'a retry is pending');
  s.disconnect();                                  // clear the timer so the test exits
});

test('onChange listeners see status messages', async () => {
  const t = new FakeTransport();
  const s = new Strip(PROFILES.lotus, t, newStore());
  const seen = [];
  s.onChange((_s, msg) => seen.push(msg));
  await s.connect({});
  assert.ok(seen.some(m => /connected/.test(m)), 'a connected message was emitted');
  s.disconnect();
});

test('restore reopens a remembered device without a picker', async () => {
  const t = new FakeTransport(), store = newStore();
  const first = new Strip(PROFILES.lotus, t, store);
  await first.connect({});
  first.disconnect();

  const second = new Strip(PROFILES.lotus, t, store);   // fresh instance, same store
  assert.equal(second.remembered.id, 'fake-lotus');
  const ok = await second.restore();
  assert.equal(ok, true);
  assert.equal(second.connected, true);
  second.disconnect();
});
