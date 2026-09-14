import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AES, lotusEncrypt, hex, PROFILES, masterFrame } from '../src/protocol.js';

const L = PROFILES.lotus, I = PROFILES.istrip;
const bytes = s => Uint8Array.from(s.split(' ').map(x => parseInt(x, 16)));

test('AES-128 matches the FIPS-197 C.1 vector', () => {
  const out = AES.encryptBlock(
    bytes('00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff'),
    AES.expandKey(bytes('00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f')));
  assert.equal(hex(out), '69 C4 E0 D8 6A 7B 04 30 D8 CD B7 80 70 B4 C5 5A');
});

test('Lotus frames match protocol-notes.md', () => {
  assert.equal(hex(L.power(true)),  '7E 04 04 01 00 01 FF 00 EF');
  assert.equal(hex(L.power(false)), '7E 04 04 00 00 00 FF 00 EF');
  assert.equal(hex(L.rgb(0, 128, 255)), '7E 07 05 03 00 80 FF 10 EF');
  assert.equal(hex(L.setBrightness(50)), '7E 04 01 32 FF FF FF 00 EF');
  assert.equal(hex(L.frame(0x05, 0x06, [0x02, 100, 0, 0xFF, 0x08])),
               '7E 06 05 02 64 00 FF 08 EF');
});

test('Lotus encrypts only commands 1, 3 and 4, and only for ELK-* units', () => {
  const rnd = Uint8Array.from([1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.equal(L.wrap(L.power(true), 'ELK-BLEDOM').length, 9, 'plain unit stays 9 bytes');
  assert.equal(L.wrap(L.power(true), 'ELK-*BLEDOM').length, 21, 'encrypted unit is 21 bytes');
  assert.equal(L.wrap(L.rgb(1,2,3), 'ELK-*BLEDOM').length, 9, 'cmd 5 is never encrypted');
  assert.equal(hex(lotusEncrypt(L.power(true), rnd)),
    '88 59 C0 AE EF 4A FD C9 4C 2B 7D C2 90 36 D8 42 E8 82 1B 57 AA');
});

test('iStrip frames match protocol-notes.md', () => {
  I.state.bright = 100; I.state.group = 1;
  assert.equal(hex(I.power(false)), '54 52 00 57 02 01 00 00 00 00 64 64 00 00 00 00');
  assert.equal(hex(I.rgb(255, 0, 0)), '54 52 00 57 02 01 00 FF 00 00 64 64 00 00 00 00');
  I.state.bright = 50;
  assert.equal(hex(I.rgb(255, 0, 0)), '54 52 00 57 02 01 00 80 00 00 32 64 00 00 00 00',
               'brightness is applied to RGB on the client, as the vendor app does');
  assert.equal(hex(I.lightCmd(50)), '54 52 00 57 07 01 32 00 00 00 00 00 00 00 00 00');
  I.state.bright = 100;
});

test('iStrip encrypts every frame with the extracted AES key', () => {
  I.state.bright = 100; I.state.group = 1;
  assert.equal(hex(I.wrap(I.rgb(255, 0, 0))),
               '12 73 62 2A 87 79 7E 5C 76 82 11 EE 59 30 8E 5B');
  assert.equal(I.wrap(I.power(false)).length, 16);
});

test('master brightness 0 means dark on both protocols', () => {
  const st = { r: 255, g: 0, b: 0, bright: 0 };
  assert.equal(hex(masterFrame(L, 'bright', st)), hex(L.power(false)));
  assert.equal(hex(masterFrame(I, 'bright', st)), hex(I.power(false)));
});

test('master brightness respects each profile floor', () => {
  masterFrame(I, 'bright', { r: 255, g: 0, b: 0, bright: 5 });
  assert.equal(I.state.bright, 10, 'iStrip clamps up to its floor of 10');
  masterFrame(L, 'bright', { r: 255, g: 0, b: 0, bright: 5 });
  assert.equal(L.state.bright, 5, 'Lotus has no floor');
  L.state.bright = 100; I.state.bright = 100;
});

test('master colour scales for iStrip but not for Lotus', () => {
  const st = { r: 255, g: 0, b: 0, bright: 50 };
  assert.equal(hex(masterFrame(I, 'rgb', st)).split(' ')[7], '80');
  assert.equal(hex(masterFrame(L, 'rgb', st)).split(' ')[4], 'FF');
  L.state.bright = 100; I.state.bright = 100;
});
