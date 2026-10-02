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

const DEFAULTS = {
  firstDelayMs: 1000,       // first retry after a drop
  retryCapMs: 15000,        // backoff ceiling
  connectTimeoutMs: 12000,  // a connect that hasn't landed by now is not going to
  repickAfter: 4            // failed reconnects before the remembered id is suspect
};

/* A gatt.connect() to a peripheral that has stopped advertising can simply never
   settle. Without this the retry ladder stalls forever on a promise that will
   not resolve — the app thinks it is still trying and never tries again. */
function withTimeout(promise, ms, label) {
  let timer;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    if (typeof timer === 'object' && timer.unref) timer.unref();
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(timer));
}

export class Strip {
  constructor(profile, transport, store = memoryStore, opts = {}) {
    this.p = profile;
    this.transport = transport;
    this.store = store;
    this.opts = { ...DEFAULTS, ...opts };
    this.handle = null;
    this.wantConnected = false;      // false after a deliberate Disconnect
    this.userOff = false;            // true from a deliberate Disconnect until the next connect()
    this.connecting = null;          // the connect() in flight, if any
    this.retryTimer = null;
    this.attempt = 0;
    this.listeners = [];
    this.remembered = store.get(profile.id);
  }

  get connected() { return !!this.handle; }
  /* Trying to get back on its own. The UI shows this, but must never use it to
     disable the manual Connect button — that removes the only way out. */
  get retrying() { return !this.handle && this.wantConnected; }
  get deviceName() { return (this.handle && this.handle.name) || null; }

  onChange(fn) { this.listeners.push(fn); }
  emit(msg, isErr) { this.listeners.forEach(fn => fn(this, msg, isErr)); }

  /* ---- connecting ---- */

  /* One connect at a time. A second call — a tap while the Electron shell's
     autoconnect is still scanning — joins the one in flight; two requestDevice()
     calls fight over the single chooser and neither lands cleanly. */
  connect(opts = {}) {
    if (!this.connecting) {
      this.connecting = this._connect(opts).finally(() => {
        this.connecting = null;
        this.emit(null);               // state changed, no new status line
      });
      this.emit(opts.auto ? 'looking for the strip…' : 'requesting device…');
    }
    return this.connecting;
  }

  async _connect(opts) {
    // A manual connect supersedes any pending automatic retry, so the two
    // cannot race and open two links to the same strip.
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.userOff = false;
    try {
      const dev = await this.transport.pick(this.p, opts);
      await this.attach(dev.id, dev.name);
    } catch (e) {
      this.wantConnected = false;
      if (opts.auto && e && e.name === 'NotFoundError') {
        this.emit('not in range — still looking, it connects when it shows up');
      } else if (e && e.name === 'NotFoundError') {
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

  async attach(id, nameHint) {
    this.wantConnected = true;
    this.handle = await withTimeout(this.transport.open(this.p, id, nameHint),
                                    this.opts.connectTimeoutMs, 'connect timed out');
    this.attempt = 0;
    this.transport.onDrop(this.handle, () => this.onDrop());
    this.remembered = { id: this.handle.id, name: this.handle.name };
    this.store.set(this.p.id, this.remembered);
    this.emit('connected · writes '
            + (this.handle.noResponse ? 'without response' : 'with response'));
  }

  disconnect() {
    this.userOff = true;               // a shell that autoconnects leaves this strip alone
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
     drops comes back on its own.

     No deadline. An ELK-BLEDOM drops an idle link as a matter of course and may
     not be connectable again for a while; abandoning the attempt turns a
     recoverable state into one the user has to fix by hand. This keeps trying
     until the user disconnects, backing off to one attempt every 15s so it costs
     nothing to leave running. */
  scheduleRetry() {
    const { firstDelayMs, retryCapMs } = this.opts;
    const delay = Math.min(firstDelayMs * Math.pow(2, this.attempt++), retryCapMs);
    this.emit('connection dropped — reconnecting, retry in '
            + Math.max(1, Math.round(delay / 1000)) + 's…');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (!this.wantConnected || !this.remembered) return;
      try {
        await this.attach(this.remembered.id, this.remembered.name);
      } catch {
        if (!this.wantConnected) return;
        /* The remembered device may simply not be this strip. It happened: a
           wrong pick in the chooser stored an address that never advertises
           again, and the ladder chased that ghost forever. After a few failures,
           if the platform can find a device without bothering the user, throw
           the id away and scan afresh. */
        if (this.attempt >= this.opts.repickAfter && this.transport.canPickSilently) {
          this.attempt = 0;
          this.emit('remembered device is not answering — scanning for it again');
          try {
            const dev = await this.transport.pick(this.p, { noDialog: true });
            this.remembered = dev;
            this.store.set(this.p.id, dev);
            await this.attach(dev.id, dev.name);
            return;
          } catch { /* nothing in range either — fall through and keep trying */ }
        }
        this.scheduleRetry();
      }
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
