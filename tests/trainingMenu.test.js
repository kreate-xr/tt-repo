// TrainingMenu — end-to-end smoke test of the real class.
//
// Exists because "training click is not working" was not diagnosable by
// reading: the wrist menu's activate(), inGame's routing and the panel's hit
// test all looked correct in isolation. A throw anywhere inside draw() would
// propagate out through wristMenu.emit() — which has no try/catch — and the
// click would silently do nothing. This drives the actual code path so that
// failure mode becomes a test result instead of a headset session.

const THREE = require('three');

jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/audio.js', () => ({
  playMenuHoverTick: () => {}, playMenuSelectClick: () => {},
}));
jest.mock('../js/xr/haptics.js', () => ({ pulseActive: () => {} }));

// Canvas stub: any 2D context call is a no-op, any property is writable.
// Using a Proxy rather than listing methods means a newly-used ctx call in
// the renderer cannot silently pass here and then throw in the browser.
function makeCtx() {
  const store = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
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
  class MemoryStorage {
    constructor() { this.m = new Map(); }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
    clear() { this.m.clear(); }
  }
  globalThis.localStorage = new MemoryStorage();
});

const { TrainingMenu } = require('../js/scene/trainingMenu.js');
const { SCREENS } = require('../js/modes/training/menuModel.js');

// Resolve a widget id to a UV point at its centre, mirroring what a laser
// raycast against the panel plane produces.
function uvOf(menu, id) {
  const w = menu.panel.get(id);
  if (!w) throw new Error(`no widget "${id}"`);
  const px = w.shape === 'circle' ? w.cx : w.x + w.w / 2;
  const py = w.shape === 'circle' ? w.cy : w.y + w.h / 2;
  return [px / menu.panel.width, 1 - py / menu.panel.height];
}

function clickById(menu, id) {
  const [u, v] = uvOf(menu, id);
  const hit = menu.hitTestUV(u, v);
  expect(hit).toBe(id);        // the region must actually resolve to it
  menu.setHovered(hit);
  return menu.selectHovered();
}

describe('construction', () => {
  test('constructs and draws without throwing', () => {
    // A throw here would surface as "the click does nothing", because
    // wristMenu.emit() does not guard its handlers.
    expect(() => new TrainingMenu()).not.toThrow();
  });

  test('show() draws without throwing', () => {
    const menu = new TrainingMenu();
    expect(() => menu.show()).not.toThrow();
    expect(menu.isVisible()).toBe(true);
  });

  test('exposes the interface inGame.js drives it through', () => {
    const menu = new TrainingMenu();
    for (const m of ['show', 'hide', 'isVisible', 'on', 'hitTestUV', 'setHovered',
      'selectHovered', 'setPokeCursor', 'clearPokeCursor', 'update', 'dispose']) {
      expect(typeof menu[m]).toBe('function');
    }
    expect(menu.mesh).toBeInstanceOf(THREE.Mesh);
  });

  test('its mesh geometry carries UVs, or the laser raycast finds no hit', () => {
    const menu = new TrainingMenu();
    expect(menu.mesh.geometry.attributes.uv).toBeTruthy();
  });
});

describe('navigation by click', () => {
  test('every root row is hit-testable at its centre', () => {
    // The regression this guards: at a fixed row height a long list overran
    // the footer, so rows sat underneath the footer buttons and a click on
    // one activated a footer button instead.
    const menu = new TrainingMenu();
    menu.show();
    for (const item of menu.model.items()) {
      const [u, v] = uvOf(menu, `item:${item.id}`);
      expect(menu.hitTestUV(u, v)).toBe(`item:${item.id}`);
    }
  });

  test('no list row overlaps the footer on any screen', () => {
    const store = require('../js/profile/store.js');
    const menu = new TrainingMenu({ settings: store, showTune: true });
    for (const screen of Object.values(SCREENS)) {
      menu.model.stack = [screen];
      menu.rebuild();
      const footerTop = Math.min(
        ...['calibrate', 'tune', 'exit'].map((f) => menu.panel.get(`footer:${f}`).y),
      );
      for (const { rect } of menu._rows) {
        expect(rect.y + rect.h).toBeLessThanOrEqual(footerTop);
      }
    }
  });

  test('SETTINGS opens the settings screen; back pops, then closes at the root', () => {
    const menu = new TrainingMenu();
    menu.show();
    let backs = 0;
    menu.on('back', () => { backs++; });

    clickById(menu, 'footer:settings');
    expect(menu.model.screen).toBe(SCREENS.SETTINGS);
    clickById(menu, 'back');
    expect(menu.model.screen).toBe(SCREENS.ROOT);
    expect(backs).toBe(0);          // popped, did not close

    clickById(menu, 'back');
    expect(backs).toBe(1);          // at root, closes back to the wrist menu
  });

  test('every screen draws without throwing', () => {
    const store = require('../js/profile/store.js');
    const menu = new TrainingMenu({ settings: store });
    for (const screen of Object.values(SCREENS)) {
      menu.model.stack = [screen];
      expect(() => { menu.rebuild(); }).not.toThrow();
    }
  });
});

describe('starting the session', () => {
  test('a level row emits start for the session at that level', () => {
    const menu = new TrainingMenu();
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));

    clickById(menu, 'item:beginner');

    expect(started).toHaveLength(1);
    expect(started[0].drill).toBe('session');
    expect(started[0].config).toBeNull();
    expect(started[0].options.level).toBe('beginner');
  });
});

describe('footer', () => {
  test('CLOSE emits back, not exit — it leaves training, not the session', () => {
    const menu = new TrainingMenu();
    menu.show();
    let backs = 0;
    let exits = 0;
    menu.on('back', () => { backs++; });
    menu.on('exit', () => { exits++; });
    clickById(menu, 'footer:exit');
    expect(backs).toBe(1);
    expect(exits).toBe(0);
  });

  test('calibrate and physics hand off to the existing panels', () => {
    // showTune: the physics footer button only exists in ?tuner/?selftest
    // dev sessions; this test exercises that dev path.
    const menu = new TrainingMenu({ showTune: true });
    menu.show();
    const seen = [];
    menu.on('calibrate', () => seen.push('calibrate'));
    menu.on('tune', () => seen.push('tune'));
    clickById(menu, 'footer:calibrate');
    clickById(menu, 'footer:tune');
    expect(seen).toEqual(['calibrate', 'tune']);
  });

  test('the physics footer button is absent outside dev sessions', () => {
    const menu = new TrainingMenu();   // default: showTune off
    menu.show();
    expect(menu.panel.get('footer:tune')).toBeFalsy();
    expect(menu.panel.get('footer:calibrate')).toBeTruthy();
  });
});

describe('difficulty', () => {
  test('adopts the tier the wrist menu passes in', () => {
    const menu = new TrainingMenu();
    menu.setDifficulty('pro');
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));
    clickById(menu, 'item:player');
    expect(started[0].difficulty).toBe('pro');
  });

  test('an unknown tier is ignored rather than throwing', () => {
    const menu = new TrainingMenu();
    expect(() => menu.setDifficulty('nonsense')).not.toThrow();
  });
});
