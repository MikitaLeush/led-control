import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTransport } from '../src/transport.js';
import { PROFILES } from '../src/protocol.js';

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
  assert.deepEqual(await t.listKnown(PROFILES.lotus),
                   [{ id: 'fake-lotus', name: 'Fake lotus' }]);
});

test('listKnown does not leak devices across profiles', async () => {
  const t = new FakeTransport();
  await t.open(PROFILES.lotus, 'fake-lotus');
  await t.open(PROFILES.istrip, 'fake-istrip');
  assert.deepEqual((await t.listKnown(PROFILES.istrip)).map(d => d.id), ['fake-istrip']);
});

test('close removes the handle', async () => {
  const t = new FakeTransport();
  const h = await t.open(PROFILES.lotus, 'fake-lotus');
  t.close(h);
  assert.deepEqual(await t.listKnown(PROFILES.lotus), []);
});
