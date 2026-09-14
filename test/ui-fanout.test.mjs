import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Strip } from '../src/strip.js';
import { FakeTransport } from '../src/transport.js';
import { PROFILES, masterFrame, hex } from '../src/protocol.js';

const newStore = () => {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
};

async function twoConnected(t) {
  const strips = [new Strip(PROFILES.lotus, t, newStore()),
                  new Strip(PROFILES.istrip, t, newStore())];
  for (const s of strips) await s.connect({});
  t.writes.length = 0;
  return strips;
}

test('a master action writes to every connected strip, in order', async () => {
  const t = new FakeTransport();
  const strips = await twoConnected(t);
  const st = { r: 255, g: 0, b: 0, bright: 100 };

  for (const s of strips) await s.send(masterFrame(s.p, 'on', st));

  assert.deepEqual(t.writes.map(w => w.profileId), ['lotus', 'istrip']);
  assert.equal(t.writes[0].hex, '7E 04 04 01 00 01 FF 00 EF');
  assert.equal(t.writes[1].hex.split(' ').length, 16, 'iStrip frame is one AES block');
  strips.forEach(s => s.disconnect());
});

test('a disconnected strip is skipped, the other still receives', async () => {
  const t = new FakeTransport();
  const strips = await twoConnected(t);
  strips[0].disconnect();
  t.writes.length = 0;

  const st = { r: 0, g: 255, b: 0, bright: 80 };
  for (const s of strips.filter(s => s.connected)) await s.send(masterFrame(s.p, 'rgb', st));

  assert.deepEqual(t.writes.map(w => w.profileId), ['istrip']);
  strips.forEach(s => s.disconnect());
});

test('master brightness 0 sends a power-off frame to both', async () => {
  const t = new FakeTransport();
  const strips = await twoConnected(t);
  const st = { r: 255, g: 0, b: 0, bright: 0 };

  for (const s of strips) await s.send(masterFrame(s.p, 'bright', st));

  assert.equal(t.writes[0].hex, hex(PROFILES.lotus.power(false)));
  assert.equal(t.writes[1].hex, hex(PROFILES.istrip.wrap(PROFILES.istrip.power(false))),
               'iStrip off frame is encrypted on the wire');
  strips.forEach(s => s.disconnect());
});
