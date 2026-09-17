/* Regression tests for the reconnect ladder.

   Reported symptom: an ELK-BLEDOM drops while idle and never comes back — the
   user has to press Reconnect by hand. An idle drop is normal for that
   controller; failing to recover from it is the bug. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Strip } from '../src/strip.js';
import { Transport } from '../src/transport.js';
import { PROFILES } from '../src/protocol.js';

const newStore = () => {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
};
const wait = ms => new Promise(r => setTimeout(r, ms));

/* A peripheral that accepts the first connection, then stops answering —
   exactly what a strip that has gone to sleep looks like. */
class StallingTransport extends Transport {
  constructor({ mode }) { super(); this.mode = mode; this.opens = 0; this.dropCb = null; }
  async available() { return { ok: true, silentReconnect: true }; }
  async pick(profile) { return { id: 'stall-' + profile.id, name: 'Stall' }; }
  async open(profile, id) {
    this.opens++;
    if (this.opens === 1) {
      return { id, name: 'Stall', profile, noResponse: true };
    }
    if (this.mode === 'hang') return new Promise(() => {});   // never settles
    throw new Error('device unreachable');
  }
  async write() {}
  close() {}
  onDrop(handle, cb) { this.dropCb = cb; }
  async listKnown() { return []; }
  fireDrop() { if (this.dropCb) this.dropCb(); }
}

test('a connect attempt that never settles does not stall the ladder', async () => {
  const t = new StallingTransport({ mode: 'hang' });
  const s = new Strip(PROFILES.lotus, t, newStore(),
                      { firstDelayMs: 10, retryCapMs: 20, connectTimeoutMs: 40 });
  await s.connect({});
  t.fireDrop();

  // first retry fires at ~10ms, hangs, must time out at ~40ms and schedule another
  await wait(200);
  assert.ok(t.opens >= 3, `expected repeated attempts, saw ${t.opens}`);
  assert.equal(s.wantConnected, true, 'still trying');
  s.disconnect();
});

test('it keeps retrying past the old two-minute deadline', async () => {
  const t = new StallingTransport({ mode: 'reject' });
  const s = new Strip(PROFILES.lotus, t, newStore(),
                      { firstDelayMs: 5, retryCapMs: 10, connectTimeoutMs: 40 });
  await s.connect({});
  t.fireDrop();
  await wait(220);

  assert.ok(t.opens > 5, `should have retried many times by now, saw ${t.opens}`);
  assert.equal(s.wantConnected, true,
               'an idle drop must not be abandoned — the strip comes back when it wakes');
  assert.ok(s.retryTimer, 'a retry is still pending');
  s.disconnect();
});

test('retrying never blocks a manual reconnect', async () => {
  const t = new StallingTransport({ mode: 'reject' });
  const s = new Strip(PROFILES.lotus, t, newStore(),
                      { firstDelayMs: 5, retryCapMs: 10, connectTimeoutMs: 40 });
  await s.connect({});
  t.fireDrop();
  await wait(30);
  assert.equal(s.retrying, true, 'Strip reports that it is retrying');
  assert.equal(s.connected, false);
  s.disconnect();
});

test('disconnect stops the ladder for good', async () => {
  const t = new StallingTransport({ mode: 'reject' });
  const s = new Strip(PROFILES.lotus, t, newStore(),
                      { firstDelayMs: 5, retryCapMs: 10, connectTimeoutMs: 40 });
  await s.connect({});
  t.fireDrop();
  await wait(20);
  s.disconnect();
  const seen = t.opens;
  await wait(80);
  assert.equal(t.opens, seen, 'no further attempts after a deliberate disconnect');
  assert.equal(s.wantConnected, false);
});

/* A remembered device that no longer exists. Happened for real: the Lotus id in
   localStorage was BE:68:AE:0D:32:1A while the strip actually advertising was
   BE:68:C1:0D:06:08 ("ELK-BLEDDM 02"). The app retried the ghost forever. */
class GhostTransport extends Transport {
  constructor(){ super(); this.opens = []; this.picks = 0; this.realId = 'real-device'; }
  get canPickSilently() { return true; }
  async available(){ return { ok: true, silentReconnect: true }; }
  async pick(profile){ this.picks++; return { id: this.realId, name: 'ELK-BLEDDM 02' }; }
  async open(profile, id, nameHint){
    this.opens.push(id);
    if (id !== this.realId) throw new Error('device unreachable');
    return { id, name: nameHint || 'ELK-BLEDDM 02', profile, noResponse: true };
  }
  async write(){} close(){} onDrop(h,cb){ this.cb = cb; } async listKnown(){ return []; }
}

test('a remembered device that never answers is abandoned for a fresh scan', async () => {
  const t = new GhostTransport();
  const store = newStore();
  store.set('lotus', { id: 'ghost-device', name: 'Lotus Lantern' });   // the stale id

  const s = new Strip(PROFILES.lotus, t, store,
                      { firstDelayMs: 5, retryCapMs: 10, connectTimeoutMs: 40,
                        repickAfter: 3 });
  s.wantConnected = true;
  s.scheduleRetry();
  await wait(300);

  assert.ok(t.picks >= 1, 'it eventually re-scanned instead of retrying the ghost forever');
  assert.equal(s.connected, true, 'and connected to the device that is actually there');
  assert.equal(store.get('lotus').id, 'real-device', 'the stale id was replaced');
  s.disconnect();
});

test('a transport that cannot pick silently never re-picks on its own', async () => {
  const t = new GhostTransport();
  Object.defineProperty(t, 'canPickSilently', { get: () => false });
  const store = newStore();
  store.set('lotus', { id: 'ghost-device', name: 'Lotus Lantern' });

  const s = new Strip(PROFILES.lotus, t, store,
                      { firstDelayMs: 5, retryCapMs: 10, connectTimeoutMs: 40,
                        repickAfter: 2 });
  s.wantConnected = true;
  s.scheduleRetry();
  await wait(200);

  assert.equal(t.picks, 0, 'no dialog may appear without the user asking for it');
  s.disconnect();
});
