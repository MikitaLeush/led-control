/* One strip: which transport, the live handle, the reconnect ladder, and the
   remembered device. Platform-blind — everything BLE goes through the transport. */

const STORE_KEY = 'led-control.devices';

/* localStorage in a browser, an in-memory Map everywhere else (Node tests, and
   any context where storage throws — private mode, blocked site data). Remembering
   a device is a convenience, never a requirement. */
export const memoryStore = (() => {
  const fallback = new Map();
  const ls = (() => {
    try { globalThis.localStorage.getItem(STORE_KEY); return globalThis.localStorage; }
    catch { return null; }
  })();
  if (!ls) return { get: k => fallback.get(k) ?? null, set: (k, v) => fallback.set(k, v) };
  return {
    get(k) {
      try { return (JSON.parse(ls.getItem(STORE_KEY)) || {})[k] ?? null; } catch { return null; }
    },
    set(k, v) {
      try {
        const all = JSON.parse(ls.getItem(STORE_KEY)) || {};
        all[k] = v;
        ls.setItem(STORE_KEY, JSON.stringify(all));
      } catch { fallback.set(k, v); }
    }
  };
})();

const RETRY_CAP_MS   = 15000;
const RETRY_GIVEUP_MS = 120000;

export class Strip {
  constructor(profile, transport, store = memoryStore) {
    this.p = profile;
    this.transport = transport;
    this.store = store;
    this.handle = null;
    this.wantConnected = false;      // false after a deliberate Disconnect
    this.retryTimer = null;
    this.retryStarted = 0;
    this.attempt = 0;
    this.listeners = [];
    this.remembered = store.get(profile.id);
  }

  get connected() { return !!this.handle; }
  get deviceName() { return (this.handle && this.handle.name) || null; }

  onChange(fn) { this.listeners.push(fn); }
  emit(msg, isErr) { this.listeners.forEach(fn => fn(this, msg, isErr)); }

  /* ---- connecting ---- */

  async connect(opts = {}) {
    try {
      this.emit('requesting device…');
      const dev = await this.transport.pick(this.p, opts);
      await this.attach(dev.id);
    } catch (e) {
      this.wantConnected = false;
      if (e && e.name === 'NotFoundError') {
        this.emit('no device chosen — if the list was empty, untick "Narrow the device '
                + 'picker", and make sure the strip is powered and not already connected '
                + 'to the phone app', true);
      } else {
        this.emit((e && e.message) ? e.message : String(e), true);
      }
    }
  }

  /* Reopen a remembered device with no picker. Returns false when it is simply not
     available — out of range, or this platform cannot reopen without a gesture. */
  async restore() {
    const want = this.remembered;
    if (!want || !want.id) return false;
    try {
      const known = await this.transport.listKnown(this.p, [want.id]);
      if (!known.some(d => d.id === want.id)) return false;
      await this.attach(want.id);
      return true;
    } catch {
      return false;
    }
  }

  async attach(id) {
    this.wantConnected = true;
    this.handle = await this.transport.open(this.p, id);
    this.attempt = 0;
    this.retryStarted = 0;
    this.transport.onDrop(this.handle, () => this.onDrop());
    this.remembered = { id: this.handle.id, name: this.handle.name };
    this.store.set(this.p.id, this.remembered);
    this.emit('connected · writes '
            + (this.handle.noResponse ? 'without response' : 'with response'));
  }

  disconnect() {
    this.wantConnected = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.handle) {
      this.transport.close(this.handle);
      this.handle = null;
    }
    this.emit('disconnected');
  }

  onDrop() {
    this.handle = null;
    if (!this.wantConnected) { this.emit('disconnected'); return; }
    this.scheduleRetry();
  }

  /* Reopening an already-permitted device needs no user gesture, so a strip that
     goes out of range comes back on its own while the app stays open. */
  scheduleRetry() {
    if (!this.retryStarted) this.retryStarted = Date.now();
    if (Date.now() - this.retryStarted > RETRY_GIVEUP_MS) {
      this.wantConnected = false;
      this.retryTimer = null;
      this.emit('lost connection — gave up after 2 min, press Connect', true);
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.attempt++), RETRY_CAP_MS);
    this.emit('connection dropped — retrying in ' + Math.round(delay / 1000) + 's…');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (!this.wantConnected || !this.remembered) return;
      try { await this.attach(this.remembered.id); }
      catch { this.scheduleRetry(); }
    }, delay);
    // Node would hold the process open for this timer; the browser has no unref.
    if (typeof this.retryTimer === 'object' && this.retryTimer.unref) this.retryTimer.unref();
  }

  /* ---- writing ---- */

  async send(frame) {
    const wire = this.p.wrap(frame, this.deviceName);
    this.emit(hexPair(wire, frame));
    if (!this.handle) return;
    try { await this.transport.write(this.handle, wire); }
    catch (e) { this.emit((e && e.message) || String(e), true); }
  }
}

/* Show the wire bytes, and the plaintext too when the profile encrypted them. */
function hexPair(wire, frame) {
  const h = b => Array.from(b, x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  return wire === frame ? h(wire) : h(wire) + '  (plain ' + h(frame) + ')';
}

/* Sliders fire fast; the vendor apps rate-limit too (150 ms there, 50 ms here). */
export function makeThrottle(ms) {
  let timer = null, pending = null;
  return fn => {
    pending = fn;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const f = pending; pending = null;
      if (f) f();
    }, ms);
  };
}
