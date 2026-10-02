/* UI. Knows about Strip and the profiles; knows nothing about BLE.
   The one idea here: the page renders the light it is sending. */

import { PROFILES, masterFrame, clamp } from './protocol.js';
import { Strip, makeThrottle } from './strip.js';

const rgbOf = v => ({ r: parseInt(v.substr(1, 2), 16),
                      g: parseInt(v.substr(3, 2), 16),
                      b: parseInt(v.substr(5, 2), 16) });
const hexOf = s => '#' + [s.r, s.g, s.b].map(x => x.toString(16).padStart(2, '0')).join('');

/* Paint the room. Called on every colour or brightness change. */
export function setLive(colourHex, bright) {
  const root = document.documentElement.style;
  root.setProperty('--live', colourHex);
  root.setProperty('--lit', String(clamp(bright, 0, 100) / 100));
}

class Readout {
  constructor(el) { this.el = el; }
  set(text, isErr) {
    this.el.innerHTML = '';
    const k = document.createElement('span'); k.className = 'k'; k.textContent = 'TX';
    const v = document.createElement('span'); v.className = 'val' + (isErr ? ' flag' : '');
    v.textContent = text;
    this.el.append(k, v);
  }
}

export class DevicePanel {
  constructor(strip, root) {
    this.strip = strip;
    this.p = strip.p;
    this.throttle = makeThrottle(50);
    this.render(root);
    strip.onChange((_s, msg, isErr) => { if (msg != null) this.tx.set(msg, isErr); this.refresh(); });
    this.refresh();
  }

  render(root) {
    const p = this.p;
    const el = document.createElement('details');
    el.className = 'strip';
    el.innerHTML = `
      <summary><span class="dot"></span><span class="title">${p.name}</span></summary>
      <div class="body">
        <p class="meta">${p.meta}</p>
        <div class="row">
          <button class="connect go">Connect</button>
          <button class="disconnect">Disconnect</button>
        </div>
        <fieldset class="controls" disabled>
          ${p.hasGroup ? `
          <div class="field">
            <div class="flabel">Group id <span class="v">
              <input type="number" class="group" min="0" max="255" value="1"></span></div>
          </div>` : ''}
          <div class="row">
            <button class="pwr-on">Power on</button>
            <button class="pwr-off">Power off</button>
          </div>
          <div class="field">
            <div class="flabel">Colour <span class="v swatch-hex">${hexOf(p.state)}</span></div>
            <div class="swatch"><input type="color" class="colour" value="${hexOf(p.state)}"></div>
          </div>
          <div class="field">
            <div class="flabel">Brightness <span class="v bval">${p.brightness.def}</span></div>
            <input type="range" class="bright" min="${p.brightness.min}"
                   max="${p.brightness.max}" value="${p.brightness.def}">
          </div>
          ${p.cct ? `
          <div class="field">
            <div class="flabel">White temperature <span class="v cval">white</span></div>
            <input type="range" class="cct" min="0" max="100" value="${p.state.cct}">
          </div>
          <div class="row">
            <button class="cct-preset" data-v="0">Cool</button>
            <button class="cct-preset" data-v="50">White</button>
            <button class="cct-preset" data-v="100">Warm</button>
          </div>` : ''}
        </fieldset>
        <div class="tx"></div>
      </div>`;
    root.appendChild(el);

    this.el       = el;
    this.dot      = el.querySelector('.dot');
    this.title    = el.querySelector('.title');
    this.controls = el.querySelector('.controls');
    this.colour   = el.querySelector('.colour');
    this.swatchHex= el.querySelector('.swatch-hex');
    this.bright   = el.querySelector('.bright');
    this.bval     = el.querySelector('.bval');
    this.btnCon   = el.querySelector('.connect');
    this.btnDis   = el.querySelector('.disconnect');
    this.tx       = new Readout(el.querySelector('.tx'));

    this.btnCon.onclick = () => this.strip.connect({ narrow: narrowOn() });
    this.btnDis.onclick = () => this.strip.disconnect();
    el.querySelector('.pwr-on').onclick  = () => this.strip.send(p.power(true));
    el.querySelector('.pwr-off').onclick = () => this.strip.send(p.power(false));

    this.colour.oninput = () => {
      const c = rgbOf(this.colour.value);
      Object.assign(p.state, c);
      this.swatchHex.textContent = this.colour.value;
      setLive(this.colour.value, p.state.bright);
      this.throttle(() => this.strip.send(p.colour ? p.colour(c.r, c.g, c.b)
                                                   : p.rgb(c.r, c.g, c.b)));
    };
    if (p.cct) {
      this.cct  = el.querySelector('.cct');
      this.cval = el.querySelector('.cval');
      const setCct = v => {
        const frame = p.cct(v);                     // updates p.state.r/g/b too
        this.syncWidgets();
        setLive(hexOf(p.state), p.state.bright);
        return frame;
      };
      this.cct.oninput = () => {
        const v = +this.cct.value;
        setCct(v);
        this.throttle(() => this.strip.send(p.cct(v)));
      };
      el.querySelectorAll('.cct-preset').forEach(b => {
        b.onclick = () => this.strip.send(setCct(+b.dataset.v));
      });
    }
    this.bright.oninput = () => {
      p.state.bright = +this.bright.value;
      this.bval.textContent = this.bright.value;
      setLive(hexOf(p.state), p.state.bright);
      this.throttle(() => this.strip.send(p.setBrightness(p.state.bright)));
    };
    if (p.hasGroup) {
      const g = el.querySelector('.group');
      g.onchange = () => { p.state.group = clamp(+g.value || 0, 0, 255); };
    }
  }

  /* The master panel writes to profile state too — pull the widgets back in step. */
  syncWidgets() {
    const p = this.p;
    this.colour.value = hexOf(p.state);
    this.swatchHex.textContent = this.colour.value;
    this.bright.value = p.state.bright;
    this.bval.textContent = p.state.bright;
    if (this.cct) {
      this.cct.value = p.state.cct;
      this.cval.textContent = p.state.type !== 2 ? 'off'
        : p.state.cct < 40 ? 'cool' : p.state.cct > 60 ? 'warm' : 'white';
    }
  }

  refresh() {
    const s = this.strip, p = this.p;
    this.dot.className = 'dot' + (s.connected ? ' on' : s.retrying ? ' busy' : '');
    this.title.textContent = s.deviceName || p.name;
    this.controls.disabled = !s.connected;
    // Never disabled while retrying. Automatic recovery is a convenience; taking
    // away the manual escape while it runs is how a stuck retry becomes a dead app.
    // Disabled while a connect is in flight: a second tap would only join it anyway.
    this.btnCon.disabled = s.connected || !!s.connecting;
    this.btnDis.disabled = !s.connected && !s.retrying;
    this.btnCon.textContent = s.connected ? 'Connected'
      : s.connecting ? 'Connecting…'
      : s.retrying ? 'Reconnecting — tap to choose again'
      : (s.remembered && s.remembered.name) ? `Reconnect ${s.remembered.name}`
      : 'Connect';
    this.syncWidgets();
  }
}

export class MasterPanel {
  constructor(strips, root, panels) {
    this.strips = strips;
    this.panels = panels;
    this.throttle = makeThrottle(50);
    this.st = { r: 255, g: 255, b: 255, bright: 100 };
    this.render(root);
    strips.forEach(s => s.onChange(() => this.refresh()));
    this.refresh();
    setLive(hexOf(this.st), 0);          // dark until something is connected
  }

  render(root) {
    const el = document.createElement('div');
    el.className = 'panel room';
    el.innerHTML = `
      <div class="phead">
        <span class="dot"></span>
        <span class="name">Both lights</span>
        <span class="count">0 / 0</span>
      </div>
      <div class="row">
        <button class="connectAll go">Connect all</button>
        <button class="disconnectAll">Disconnect all</button>
      </div>
      <fieldset class="controls" disabled>
        <div class="row">
          <button class="pwr-on">Power on</button>
          <button class="pwr-off">Power off</button>
        </div>
        <div class="field">
          <div class="flabel">Colour <span class="v mhex">#ffffff</span></div>
          <div class="swatch"><input type="color" class="colour" value="#ffffff"></div>
        </div>
        <div class="field">
          <div class="flabel">Brightness <span class="v bval">100</span></div>
          <input type="range" class="bright" min="0" max="100" value="100">
        </div>
      </fieldset>
      <div class="tx"></div>`;
    root.appendChild(el);

    this.el       = el;
    this.dot      = el.querySelector('.dot');
    this.count    = el.querySelector('.count');
    this.controls = el.querySelector('.controls');
    this.colour   = el.querySelector('.colour');
    this.mhex     = el.querySelector('.mhex');
    this.bright   = el.querySelector('.bright');
    this.bval     = el.querySelector('.bval');
    this.tx       = new Readout(el.querySelector('.tx'));

    el.querySelector('.connectAll').onclick    = () => this.connectAll();
    el.querySelector('.disconnectAll').onclick = () => this.strips.forEach(s => s.disconnect());
    el.querySelector('.pwr-on').onclick        = () => this.fanOut('on');
    el.querySelector('.pwr-off').onclick       = () => this.fanOut('off');

    this.colour.oninput = () => {
      Object.assign(this.st, rgbOf(this.colour.value));
      this.mhex.textContent = this.colour.value;
      setLive(this.colour.value, this.st.bright);
      this.throttle(() => this.fanOut('rgb'));
    };
    this.bright.oninput = () => {
      this.st.bright = +this.bright.value;
      this.bval.textContent = this.bright.value;
      setLive(this.colour.value, this.st.bright);
      this.throttle(() => this.fanOut('bright'));
    };
  }

  /* Chrome grants one device per chooser call, so this is still one picker per
     strip on first run — but only for strips that are not already up. */
  async connectAll() {
    for (const s of this.strips) {
      if (s.connected) continue;
      await s.connect({ narrow: narrowOn() });
    }
  }

  /* Sequential on purpose: parallel GATT writes to two devices stall on some stacks. */
  async fanOut(kind) {
    const live = this.strips.filter(s => s.connected);
    if (!live.length) return;
    for (const s of live) await s.send(masterFrame(s.p, kind, this.st));
    this.tx.set(`${kind} → ${live.map(s => s.p.name).join(' + ')}`);
    this.panels.forEach(p => p.syncWidgets());
    if (kind === 'off') setLive(this.colour.value, 0);
    if (kind === 'on')  setLive(this.colour.value, this.st.bright);
  }

  refresh() {
    const live = this.strips.filter(s => s.connected).length;
    this.count.textContent = `${live} / ${this.strips.length}`;
    this.dot.className = 'dot' + (live === this.strips.length ? ' on' : live ? ' busy' : '');
    this.controls.disabled = live === 0;
  }
}

function narrowOn() {
  const el = document.getElementById('narrow');
  return !!(el && el.checked);
}

/* Build the whole app against a transport. Returns the pieces so main.js can
   wire platform extras (the Electron host bridge) without the UI knowing. */
export function bootstrap({ transport, root, panelRoot }) {
  const strips = [new Strip(PROFILES.lotus, transport), new Strip(PROFILES.istrip, transport)];
  const panels = strips.map(s => new DevicePanel(s, panelRoot));
  const master = new MasterPanel(strips, root, panels);
  return { strips, panels, master };
}
