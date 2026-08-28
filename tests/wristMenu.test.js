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

describe('competition-rules toggle', () => {
  function click(menu, id) {
    const [u, v] = uvOfButton(menu, id);
    menu.setHovered(menu.hitTestUV(u, v));
    menu.selectHovered();
  }

  test('the rules dock exists, defaults off, and toggles with an event', () => {
    const menu = new WristMenu();
    expect(menu.competitionMode).toBe(false);
    const seen = [];
    menu.on('rules', (p) => seen.push(p));
    click(menu, 'rules');
    expect(menu.competitionMode).toBe(true);
    expect(seen).toEqual([{ competition: true }]);
    click(menu, 'rules');
    expect(menu.competitionMode).toBe(false);
    expect(seen[1]).toEqual({ competition: false });
  });

  test('start payloads carry the flag so the match factory can enforce it', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('start', (p) => seen.push(p));
    click(menu, 'rules');                 // ON
    click(menu, 'mode-aiMatch');
    expect(seen[0].options).toEqual({ competition: true });
    click(menu, 'rules');                 // OFF
    click(menu, 'mode-aiMatch');
    expect(seen[1].options).toEqual({ competition: false });
  });

  test('the toggle does not shadow the ball-color dock beside it', () => {
    const menu = new WristMenu();
    const [u, v] = uvOfButton(menu, 'ballColor');
    expect(menu.hitTestUV(u, v)).toBe('ballColor');
    const [u2, v2] = uvOfButton(menu, 'rules');
    expect(menu.hitTestUV(u2, v2)).toBe('rules');
  });
});
