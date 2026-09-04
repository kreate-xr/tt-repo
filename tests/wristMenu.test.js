// WristMenu — does the PLAY tile actually emit?
//
// Bisects "play click is not working": if this passes, the wrist menu is
// fine and the fault is downstream in inGame; if it fails, it is here.
// (The tile's event is still named 'training' — the stable key from before
// the Machine Play menu merged into the unified PLAY menu.)

jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/audio.js', () => ({
  playMenuHoverTick: () => {}, playMenuSelectClick: () => {},
}));
jest.mock('../js/xr/haptics.js', () => ({ pulseActive: () => {} }));
jest.mock('../js/scene/models.js', () => ({
  BALL_COLORS: { orange: { hex: 0xffa500 }, white: { hex: 0xffffff } },
  getBallColorId: () => 'orange',
  TABLE_COLORS: { blue: { id: 'blue', base: '#0d478d' }, green: { id: 'green', base: '#1e6b47' } },
  getTableColorId: () => 'blue',
}));
jest.mock('../js/xr/driftDetector.js', () => ({ getDriftFlag: () => false }));

function makeCtx() {
  const store = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: () => {} });
      }
      return () => {};
    },
    set(t, prop, v) { t[prop] = v; return true; },
    has() { return true; },
  });
}

beforeAll(() => {
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => makeCtx() }),
  };
});

const { WristMenu } = require('../js/scene/wristMenu.js');

function uvOfButton(menu, id) {
  const b = menu.buttons.find((x) => x.id === id);
  if (!b) throw new Error(`no button "${id}" — buttons: ${menu.buttons.map((x) => x.id).join(', ')}`);
  const px = b.shape === 'circle' ? b.cx : b.x + b.w / 2;
  const py = b.shape === 'circle' ? b.cy : b.y + b.h / 2;
  return [px / 1024, 1 - py / 410];
}

describe('PLAY tile', () => {
  test('a play mode button exists (id kept as mode-training)', () => {
    const menu = new WristMenu();
    const ids = menu.buttons.map((b) => b.id);
    expect(ids).toContain('mode-training');
  });

  test('the drill picker is gone', () => {
    const ids = new WristMenu().buttons.map((b) => b.id);
    expect(ids).not.toContain('drill-prev');
    expect(ids).not.toContain('drill-next');
  });

  test('its hit region resolves to the tile', () => {
    const menu = new WristMenu();
    const [u, v] = uvOfButton(menu, 'mode-training');
    expect(menu.hitTestUV(u, v)).toBe('mode-training');
  });

  test('clicking it emits "training" with the selected difficulty', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('training', (p) => seen.push(p));

    const [u, v] = uvOfButton(menu, 'mode-training');
    menu.setHovered(menu.hitTestUV(u, v));
    menu.selectHovered();

    expect(seen).toHaveLength(1);
    expect(seen[0].difficulty).toBe('beginner');
  });

  test('it does NOT emit start — that would try to launch a drill directly', () => {
    const menu = new WristMenu();
    const starts = [];
    menu.on('start', (p) => starts.push(p));
    const [u, v] = uvOfButton(menu, 'mode-training');
    menu.setHovered(menu.hitTestUV(u, v));
    menu.selectHovered();
    expect(starts).toHaveLength(0);
  });
});

describe('event registration', () => {
  // THE ROOT CAUSE of "training click is not working".
  //
  // listeners was a fixed object literal of known event names and on() was
  // `if (this.listeners[event]) this.listeners[event].push(fn)`. Registering
  // anything outside that literal was silently discarded — no error, no
  // warning — so the TRAINING tile hit-tested correctly, ran activate(),
  // called emit(), and did nothing, while every pre-existing option worked.
  test('a handler for a brand-new event name is actually registered', () => {
    const menu = new WristMenu();
    let got = null;
    menu.on('some-event-that-did-not-exist-before', (p) => { got = p; });
    menu.emit('some-event-that-did-not-exist-before', { ok: true });
    expect(got).toEqual({ ok: true });
  });

  test('multiple handlers on one event all fire', () => {
    const menu = new WristMenu();
    const calls = [];
    menu.on('training', () => calls.push('a'));
    menu.on('training', () => calls.push('b'));
    menu.emit('training', {});
    expect(calls).toEqual(['a', 'b']);
  });

  test('a throwing handler cannot suppress the others', () => {
    // A throw here would propagate out through activate() → selectHovered()
    // → the XR select event and read as "the button does nothing".
    const menu = new WristMenu();
    let reached = false;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    menu.on('training', () => { throw new Error('bad handler'); });
    menu.on('training', () => { reached = true; });
    expect(() => menu.emit('training', {})).not.toThrow();
    expect(reached).toBe(true);
    console.error.mockRestore();
  });

  test('emitting an event with no handlers is a no-op', () => {
    expect(() => new WristMenu().emit('nobody-listening', {})).not.toThrow();
  });

  test('dispose clears handlers without throwing', () => {
    const menu = new WristMenu();
    menu.on('training', () => {});
    expect(() => menu.dispose()).not.toThrow();
  });

  test('the physics tuner button only exists in dev sessions', () => {
    // Default (production): no ?tuner/?selftest, so no gear button, and
    // calibrate slides into the first dock slot so there is no gap.
    const menu = new WristMenu();
    expect(menu.buttons.some((b) => b.id === 'tune')).toBe(false);
    expect(menu.buttons.find((b) => b.id === 'calibrate').x).toBe(32);
    const dev = new WristMenu({ showTune: true });
    expect(dev.buttons.some((b) => b.id === 'tune')).toBe(true);
  });

  test('every event the menu can emit has a reachable path', () => {
    // Guards the inverse mistake: a tile wired to an event name that nothing
    // downstream listens for.
    const menu = new WristMenu();
    for (const event of ['start', 'training', 'tune', 'calibrate', 'ballColor', 'exit']) {
      let fired = false;
      menu.on(event, () => { fired = true; });
      menu.emit(event, {});
      expect(fired).toBe(true);
    }
  });
});

describe('the other tiles still work', () => {
  test('the second Machine Play tile is gone — one front door to the machine', () => {
    // Rally, survival and score challenge live inside the unified PLAY menu
    // now (as a root row and the editor's end-condition cycler), so a
    // separate tile would open a menu with nothing left in it.
    const ids = new WristMenu().buttons.map((b) => b.id);
    expect(ids).not.toContain('mode-machinePlay');
  });

  test('ai match emits start with its drill id', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('start', (p) => seen.push(p));
    const [u, v] = uvOfButton(menu, 'mode-aiMatch');
    menu.setHovered(menu.hitTestUV(u, v));
    menu.selectHovered();
    expect(seen[0].drill).toBe('aiMatch');
  });

  test('every mode tile resolves to itself, none shadowed', () => {
    const menu = new WristMenu();
    for (const id of ['mode-training', 'mode-aiMatch', 'mode-multiplayer']) {
      const [u, v] = uvOfButton(menu, id);
      expect(menu.hitTestUV(u, v)).toBe(id);
    }
  });
});

function click(menu, id) {
  const [u, v] = uvOfButton(menu, id);
  menu.setHovered(menu.hitTestUV(u, v));
  menu.selectHovered();
}

describe('match-length pill', () => {
  // Best-of-5 to 11 is 20-40 minutes in a headset. This control is how a
  // player asks for one game instead — and, because the lobby reads the same
  // stored preference, the default format for a room they host.

  test('offers one segment per length, defaulting to best-of-5', () => {
    const menu = new WristMenu();
    const ids = menu.buttons.filter((b) => b.kind === 'format').map((b) => b.id);
    expect(ids).toEqual(['bestOf-1', 'bestOf-3', 'bestOf-5']);
    expect(menu.bestOf).toBe(5);
  });

  test('each segment is individually clickable and sets the length', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('bestOf', (p) => seen.push(p));
    click(menu, 'bestOf-3');
    expect(menu.bestOf).toBe(3);
    click(menu, 'bestOf-1');
    expect(menu.bestOf).toBe(1);
    expect(seen).toEqual([{ bestOf: 3 }, { bestOf: 1 }]);
  });

  test('the new pill does not shadow the difficulty segments beside it', () => {
    // The two pills share the top row; a mis-sized hit region on either
    // swallows the other's edge segment and reads as a dead button.
    const menu = new WristMenu();
    for (const id of ['diff-0', 'diff-1', 'diff-2', 'bestOf-1', 'bestOf-3', 'bestOf-5']) {
      expect(menu.hitTestUV(...uvOfButton(menu, id))).toBe(id);
    }
  });

  test('the whole top row stays inside the panel capsule', () => {
    // Canvas has no clipping: a row wider than the capsule paints its ends
    // over the rounded edge and off the visible panel.
    const menu = new WristMenu();
    const row = menu.buttons.filter((b) => b.kind === 'segment' || b.kind === 'format');
    expect(Math.min(...row.map((b) => b.x))).toBeGreaterThan(79);
    expect(Math.max(...row.map((b) => b.x + b.w))).toBeLessThan(1024 - 79);
  });

  test('picking a length does not start a drill', () => {
    const menu = new WristMenu();
    const starts = [];
    menu.on('start', (p) => starts.push(p));
    click(menu, 'bestOf-1');
    expect(starts).toHaveLength(0);
  });
});

describe('competition rules', () => {
  // The trophy toggle is gone and ITTF rules are always on, so what these
  // guard now is that it STAYS gone: no dock button, no state, no flag in the
  // start payload for aiMatch to read a stale `false` out of.

  test('there is no rules dock and no competition state to toggle', () => {
    const menu = new WristMenu();
    expect(menu.buttons.find((b) => b.id === 'rules')).toBeUndefined();
    expect(menu.competitionMode).toBeUndefined();
  });

  test('start payloads carry no competition flag — the match factory defaults it on', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('start', (p) => seen.push(p));
    click(menu, 'mode-aiMatch');
    expect(seen[0].options).toEqual({ bestOf: menu.bestOf });
    expect('competition' in seen[0].options).toBe(false);
  });

  test('start payloads carry the match length too', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('start', (p) => seen.push(p));
    click(menu, 'bestOf-1');
    click(menu, 'mode-aiMatch');
    expect(seen[0].options.bestOf).toBe(1);
  });

  test('the freed left-dock slot is not clickable', () => {
    const menu = new WristMenu();
    const [u, v] = uvOfButton(menu, 'ballColor');
    expect(menu.hitTestUV(u, v)).toBe('ballColor');
    // Where the trophy used to sit: one dock width + gap right of calibrate.
    const cal = menu.buttons.find((b) => b.id === 'calibrate');
    const px = cal.x + cal.w + 8 + cal.w / 2;
    expect(menu.hitTestUV(px / 1024, 1 - (cal.y + cal.h / 2) / 410)).toBe(null);
  });

  test('the caption line states the service law when nothing is hovered', () => {
    const menu = new WristMenu();
    const lines = [];
    menu.ctx.fillText = (t) => lines.push(String(t));
    menu.hovered = null;
    menu.drawDockCaption();
    expect(lines.join(' ')).toMatch(/16 cm/);
    expect(lines.join(' ')).toMatch(/end line/);
  });
});
