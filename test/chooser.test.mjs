import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../electron/chooser.js';

// What Electron reported on real hardware (2026-09-28): the iStrip has no GAP name.
const ISTRIP = { deviceId: '35:76:55:8C:F6:04',
                 deviceName: 'Unknown or Unsupported Device (35:76:55:8C:F6:04)' };
const ELK_A  = { deviceId: 'BE:68:C1:0D:06:08', deviceName: 'ELK-BLEDDM 02' };
const ELK_B  = { deviceId: 'BE:67:00:41:A1:38', deviceName: 'ELK-BLEDDM08' };

const at = (devices, extra = {}) =>
  decide({ devices, remembered: null, firstSeenAt: 0, now: 5000, settleMs: 2500, ...extra });

test('a remembered strip is picked the moment it shows up, nameless or not', () => {
  assert.deepEqual(at([ELK_A, ISTRIP], { remembered: ISTRIP.deviceId, now: 1 }),
                   { pick: ISTRIP.deviceId });
});

test('a remembered strip that is absent means wait, never a different device', () => {
  assert.deepEqual(at([ELK_A], { remembered: ISTRIP.deviceId }), { wait: true });
});

test('first run, one candidate: picked on its own once the scan settles', () => {
  assert.deepEqual(at([ISTRIP]), { pick: ISTRIP.deviceId });
});

test('first run waits out the settle window before choosing', () => {
  assert.deepEqual(at([ISTRIP], { firstSeenAt: 4000 }), { wait: true });
  assert.deepEqual(at([]), { wait: true });
});

test('first run, several candidates: the user is asked, with addresses as ids', () => {
  assert.deepEqual(at([ELK_A, ELK_B]), { ask: [
    { id: ELK_A.deviceId, name: 'ELK-BLEDDM 02' },
    { id: ELK_B.deviceId, name: 'ELK-BLEDDM08' }
  ] });
});
