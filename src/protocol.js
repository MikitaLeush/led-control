/* Byte-level protocol for both LED strip controllers.
   Pure functions only — no DOM, no BLE, no platform APIs. Everything here is
   testable under `node --test` and is the single source of truth for what goes
   on the wire. Frames and constants are cited to ../../../protocol-notes.md. */

/* ═══════════════════════════════════════════════════════════════════════
   AES-128 (ECB, one block) — needed by the iStrip+ protocol.
   Key read from libAES.so symbol `key` @0x13020. See protocol-notes.md §2.4.
   ═══════════════════════════════════════════════════════════════════════ */
export const AES = (() => {
  const SBOX = new Uint8Array(256), RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
  (function buildSbox(){
    let p = 1, q = 1;
    do {
      p = p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0);      p &= 0xff;
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
      if (q & 0x80) q ^= 0x09;
      SBOX[p] = (q ^ rotl(q,1) ^ rotl(q,2) ^ rotl(q,3) ^ rotl(q,4) ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    function rotl(x,s){ return ((x << s) | (x >>> (8 - s))) & 0xff; }
  })();

  const xt = b => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;         // ×2 in GF(2^8)

  function expandKey(key){                                           // 16 B → 176 B
    const w = new Uint8Array(176);
    w.set(key);
    for (let i = 16, r = 0; i < 176; i += 4) {
      let t = [w[i-4], w[i-3], w[i-2], w[i-1]];
      if (i % 16 === 0) {
        t = [SBOX[t[1]] ^ RCON[r++], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
      }
      for (let j = 0; j < 4; j++) w[i+j] = w[i-16+j] ^ t[j];
    }
    return w;
  }

  function encryptBlock(block, roundKeys){
    const s = Uint8Array.from(block);
    for (let i = 0; i < 16; i++) s[i] ^= roundKeys[i];
    for (let round = 1; round <= 10; round++) {
      for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      // ShiftRows (state is column-major: byte index = col*4 + row)
      let t;
      t = s[1];  s[1]  = s[5];  s[5]  = s[9];  s[9]  = s[13]; s[13] = t;
      t = s[2];  s[2]  = s[10]; s[10] = t;  t = s[6];  s[6]  = s[14]; s[14] = t;
      t = s[15]; s[15] = s[11]; s[11] = s[7];  s[7]  = s[3];  s[3]  = t;
      if (round !== 10) {
        for (let c = 0; c < 16; c += 4) {
          const a0 = s[c], a1 = s[c+1], a2 = s[c+2], a3 = s[c+3];
          const all = a0 ^ a1 ^ a2 ^ a3;
          s[c]   = a0 ^ all ^ xt(a0 ^ a1);
          s[c+1] = a1 ^ all ^ xt(a1 ^ a2);
          s[c+2] = a2 ^ all ^ xt(a2 ^ a3);
          s[c+3] = a3 ^ all ^ xt(a3 ^ a0);
        }
      }
      for (let i = 0; i < 16; i++) s[i] ^= roundKeys[round*16 + i];
    }
    return s;
  }

  return { expandKey, encryptBlock };
})();

/* ═══════════════════════════════════════════════════════════════════════
   Lotus Lantern — "ELK-*" units wrap cmds 1/3/4 in a stream cipher.
   Read from com/szelk/ledlamppro/ble/EncryptionDecryptionKt.java (§1.6).
   ═══════════════════════════════════════════════════════════════════════ */
const LOTUS_PRESET_KEY = Uint8Array.from(
  [0x2A,0x7F,0xC1,0x94,0x33,0xDE,0x45,0xE0,0x8B,0x11,0x5C,0xA6,0x09,0xF2,0x7D,0xB8]);

export function lotusEncrypt(frame9, randomOverride){
  const rnd = randomOverride || crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(21);
  const pt  = Uint8Array.from(frame9);
  pt[0] = 0xAA;                                     // header 0x7E → 0xAA
  pt[8] = 0x55;                                     // terminator 0xEF → 0x55
  for (let i = 0; i < 9; i++) {
    const ks = ((rnd[i] * 27) & 0xff)
             ^ ((rnd[(i+3) % 12] + 55) & 0xff)
             ^ (rnd[(i+7) % 12] >> 2)
             ^ ((i * 85) & 0xff);
    out[i] = (pt[i] ^ ks) & 0xff;
  }
  for (let i = 0; i < 12; i++) out[9+i] = rnd[i] ^ LOTUS_PRESET_KEY[i];
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   Device profiles
   ═══════════════════════════════════════════════════════════════════════ */
export const hex = b => Array.from(b, x => x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
export const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, Math.round(v)));

export const PROFILES = {

  lotus: {
    id: 'lotus',
    name: 'Lotus Lantern',
    meta: 'service fff0 · char fff3 · 9-byte 7E…EF frames',
    service: '0000fff0-0000-1000-8000-00805f9b34fb',
    characteristic: '0000fff3-0000-1000-8000-00805f9b34fb',
    // The app scans unfiltered and matches on the GAP name only
    // (supportedDevice(), BluetoothLEService.java:1148; startScan(null,…) :1295).
    // Nothing shows these strips advertising fff0, so do NOT filter on the service.
    filters: [
      { namePrefix: 'ELK' },
      { namePrefix: 'XSL-' },
      { namePrefix: 'CLK-' },
      { namePrefix: 'LED LIGHT STRIP' }
    ],
    brightness: { min: 0, max: 100, def: 100 },
    state: { r:255, g:255, b:255, bright:100 },

    // 7E LL CMD D0 D1 D2 D3 D4 EF
    frame(cmd, ll, d){ return Uint8Array.from([0x7E, ll, cmd, d[0], d[1], d[2], d[3], d[4], 0xEF]); },

    power(on)      { return this.frame(0x04, 0x04, [on?1:0, 0x00, on?1:0, 0xFF, 0x00]); },
    rgb(r,g,b)     { return this.frame(0x05, 0x07, [0x03, r, g, b, 0x10]); },
    setBrightness(v){ return this.frame(0x01, 0x04, [clamp(v,0,100), 0xFF, 0xFF, 0xFF, 0x00]); },

    // Only cmds 1/3/4 are encrypted, and only on units whose name contains "ELK-*".
    wrap(frame, deviceName){
      const enc = !!deviceName && deviceName.indexOf('ELK-*') !== -1;
      const cmd = frame[2];
      if (enc && (cmd === 1 || cmd === 3 || cmd === 4)) return lotusEncrypt(frame);
      return frame;
    }
  },

  istrip: {
    id: 'istrip',
    name: 'iStrip+',
    meta: 'service AC50 · char AC52 · 16-byte AES-128 frames',
    service: '0000ac50-1212-efde-1523-785fedbeda25',
    characteristic: '0000ac52-1212-efde-1523-785fedbeda25',
    // The app matches manufacturer-specific advertising data, not a service UUID
    // (BleConfig.matchProduct(): AD type 0xFF, payload starts 54 52 00 57).
    // In BLE the first two bytes after the AD type are the company id, little-endian,
    // so companyIdentifier = 0x5254 and the remaining prefix is 00 57.
    filters: [{ manufacturerData: [{ companyIdentifier: 0x5254,
                                     dataPrefix: Uint8Array.from([0x00, 0x57]) }] }],
    brightness: { min: 10, max: 100, def: 100 },
    hasGroup: true,
    state: { r:255, g:255, b:255, bright:100, group:1 },

    // 54 52 00 57 CMD GID + 10 payload bytes
    frame(cmd, payload){
      const f = new Uint8Array(16);
      f.set([0x54, 0x52, 0x00, 0x57, cmd, this.state.group & 0xff]);
      f.set(payload.slice(0, 10), 6);
      return f;
    },

    // No dedicated power command: "on" re-sends the colour, "off" sends it zeroed.
    power(on){
      const s = this.state;
      if (!on) return this.frame(0x02, [0,0,0,0, s.bright, 100, 0,0,0,0]);
      return this.rgb(s.r, s.g, s.b);
    },
    // Brightness is applied on the phone in the vendor app — scale RGB the same way.
    rgb(r,g,b){
      const k = this.state.bright / 100;
      return this.frame(0x02, [
        0x00,                                       // mode 0 = static colour
        clamp(r*k,0,255), clamp(g*k,0,255), clamp(b*k,0,255),
        this.state.bright, 100,                     // light, speed
        0x00,                                       // send type 0 = colour picker
        0, 0, 0
      ]);
    },
    setBrightness(v){
      const s = this.state;
      return this.rgb(s.r, s.g, s.b);               // re-send scaled colour
    },
    // Command 07 carries the raw brightness value for effect modes.
    lightCmd(v){ return this.frame(0x07, [clamp(v,10,100), 0,0,0,0,0,0,0,0,0]); },

    wrap(frame){
      if (!this._rk) this._rk = AES.expandKey(Uint8Array.from(
        [0x34,0x52,0x2A,0x5B,0x7A,0x6E,0x49,0x2C,0x08,0x09,0x0A,0x9D,0x8D,0x2A,0x23,0xF8]));
      return AES.encryptBlock(frame, this._rk);
    }
  }
};

/* One shared control surface, two protocols with different scales. This is the whole
   translation layer, kept pure so the self-test can exercise it without hardware. */
export function masterFrame(profile, kind, st){
  if (kind === 'on')  return profile.power(true);
  if (kind === 'off') return profile.power(false);

  profile.state.r = st.r; profile.state.g = st.g; profile.state.b = st.b;

  // 0 must mean dark on both, not "off here, 10% there" — iStrip's own floor is 10.
  if (st.bright === 0) return profile.power(false);
  profile.state.bright = clamp(st.bright, profile.brightness.min, profile.brightness.max);

  return kind === 'bright'
    ? profile.setBrightness(profile.state.bright)
    : profile.rgb(profile.state.r, profile.state.g, profile.state.b);
}
