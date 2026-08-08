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
  test('every ENABLED root row is hit-testable at its centre', () => {
    // The regression this caught: at a fixed row height the nine root items
    // overran the footer, so "Free Play" and "Tutorial" sat underneath the
    // footer buttons and a click on Free Play activated PHYSICS instead.
    const menu = new TrainingMenu();
    menu.show();
    for (const item of menu.model.items().filter((i) => i.available !== false)) {
      const [u, v] = uvOf(menu, `item:${item.id}`);
      expect(menu.hitTestUV(u, v)).toBe(`item:${item.id}`);
    }
  });

  test('no list row overlaps the footer on any screen', () => {
    const store = require('../js/profile/store.js');
    const menu = new TrainingMenu({ presets: store });
    for (const screen of Object.values(SCREENS)) {
      if (screen === SCREENS.CUSTOM_FEED) continue;   // not a list screen
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

  test('clicking Ball Machine drills in', () => {
    const menu = new TrainingMenu();
    menu.show();
    clickById(menu, 'item:ballMachine');
    expect(menu.model.screen).toBe(SCREENS.BALL_MACHINE);
  });

  test('clicking through to Custom Feed lays out its controls', () => {
    const menu = new TrainingMenu();
    menu.show();
    clickById(menu, 'item:ballMachine');
    clickById(menu, 'item:customFeed');
    expect(menu.model.screen).toBe(SCREENS.CUSTOM_FEED);
    expect(menu.panel.get('zone:5')).toBeTruthy();
    expect(menu.panel.get('start')).toBeTruthy();
    expect(menu.panel.get('slider:speed')).toBeTruthy();
  });

  test('back pops one level and emits back only at the root', () => {
    const menu = new TrainingMenu();
    menu.show();
    let backs = 0;
    menu.on('back', () => { backs++; });

    clickById(menu, 'item:ballMachine');
    clickById(menu, 'back');
    expect(menu.model.screen).toBe(SCREENS.ROOT);
    expect(backs).toBe(0);          // popped, did not close

    clickById(menu, 'back');
    expect(backs).toBe(1);          // at root, closes back to the wrist menu
  });

  test('disabled rows do not resolve to a hit', () => {
    const menu = new TrainingMenu();
    menu.show();
    const [u, v] = uvOf(menu, 'item:serveSchool');
    expect(menu.hitTestUV(u, v)).toBeNull();
  });
});

describe('starting a drill', () => {
  test('a quick-feed preset emits start with its config', () => {
    const menu = new TrainingMenu();
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));

    clickById(menu, 'item:ballMachine');
    clickById(menu, 'item:quickFeed');
    clickById(menu, 'item:BackspinPush');

    expect(started).toHaveLength(1);
    expect(started[0].drill).toBe('ballMachine');
    expect(started[0].config.spinType).toBe('back');
    expect(started[0].difficulty).toBeTruthy();
  });

  test('a legacy drill emits start with its own drill id and no config', () => {
    const menu = new TrainingMenu();
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));

    // M2 made "Drills" a hub, so the four originals sit under Classic Drills.
    clickById(menu, 'item:drills');
    clickById(menu, 'item:classic');
    clickById(menu, 'item:spinReader');

    expect(started).toHaveLength(1);
    expect(started[0].drill).toBe('spinReader');
    expect(started[0].config).toBeNull();
  });

  test('a pattern drill starts with its pattern in the options', () => {
    const menu = new TrainingMenu();
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));

    clickById(menu, 'item:drills');
    clickById(menu, 'item:patternDrills');
    clickById(menu, 'item:falkenberg');

    expect(started).toHaveLength(1);
    expect(started[0].options.pattern).toBe('falkenberg');
    expect(started[0].options.random).toBe(false);
  });

  test('Random Mode reaches the same list but flags random ordering', () => {
    const menu = new TrainingMenu();
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));

    clickById(menu, 'item:drills');
    clickById(menu, 'item:randomMode');
    clickById(menu, 'item:falkenberg');

    expect(started[0].options.random).toBe(true);
  });

  test('a ladder starts at the chosen tier', () => {
    const menu = new TrainingMenu();
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));

    clickById(menu, 'item:drills');
    clickById(menu, 'item:ladders');
    clickById(menu, 'item:silver');

    expect(started[0].options.ladderTier).toBe('silver');
    // A ladder always runs a pattern; a graded sequence of one repeated
    // placement is a speed ramp, not a progression.
    expect(started[0].options.pattern).toBeTruthy();
  });

  test('Free Play emits freeplay rather than start', () => {
    const menu = new TrainingMenu();
    menu.show();
    let free = 0;
    menu.on('freeplay', () => { free++; });
    clickById(menu, 'item:freePlay');
    expect(free).toBe(1);
  });

  test('START in Custom Feed emits the edited config', () => {
    const menu = new TrainingMenu();
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));

    clickById(menu, 'item:ballMachine');
    clickById(menu, 'item:customFeed');
    clickById(menu, 'zone:3');
    clickById(menu, 'start');

    expect(started).toHaveLength(1);
    expect(started[0].config.placement.zone).toBe(3);
  });
});

describe('custom feed controls', () => {
  const openCustom = () => {
    const menu = new TrainingMenu();
    menu.show();
    clickById(menu, 'item:ballMachine');
    clickById(menu, 'item:customFeed');
    return menu;
  };

  test('all nine zone cells are clickable', () => {
    const menu = openCustom();
    for (let z = 1; z <= 9; z++) {
      clickById(menu, `zone:${z}`);
      expect(menu.model.zone).toBe(z);
    }
  });

  test('cycling a segment changes the config', () => {
    const menu = openCustom();
    const before = menu.model.config.depth;
    clickById(menu, 'cycle:depth:1');
    expect(menu.model.config.depth).not.toBe(before);
  });

  test('toggling the audio cue flips it', () => {
    const menu = openCustom();
    const before = menu.model.config.audioCue;
    clickById(menu, 'toggle:audioCue');
    expect(menu.model.config.audioCue).toBe(!before);
  });

  test('dragging a slider updates the config and stays in range', () => {
    const menu = openCustom();
    const w = menu.panel.get('slider:speed');
    menu.dragAt((w.x + w.w) / menu.panel.width, 1 - (w.y + 9) / menu.panel.height);
    expect(menu.model.config.speed).toBeLessThanOrEqual(25);
    expect(menu.model.config.speed).toBeGreaterThanOrEqual(2);
  });

  test('TAPPING a slider jumps to that value', () => {
    // Without this a slider could only be moved by a successful drag, so a
    // plain press did nothing — which is how it reads as "drag not working".
    const menu = openCustom();
    const before = menu.model.config.speed;
    const w = menu.panel.get('slider:speed');
    const u = (w.x + w.w * 0.9) / menu.panel.width;
    const v = 1 - (w.y + 9) / menu.panel.height;
    menu.hitTestUV(u, v);            // host records pointer position
    menu.setHovered('slider:speed');
    menu.selectHovered();
    expect(menu.model.config.speed).not.toBe(before);
  });

  test('sliderAt identifies a slider under the pointer', () => {
    const menu = openCustom();
    const w = menu.panel.get('slider:speed');
    const u = (w.x + w.w / 2) / menu.panel.width;
    const v = 1 - (w.y + 9) / menu.panel.height;
    expect(menu.sliderAt(u, v)).toBe('slider:speed');
    expect(menu.sliderAt(0.01, 0.99)).toBeNull();
  });

  test('a pinned drag keeps control even when the ray leaves the track', () => {
    // The track is ~18 px tall; re-hit-testing every frame would drop the
    // drag on the smallest wobble, or start editing a neighbouring field.
    const menu = openCustom();
    const w = menu.panel.get('slider:speed');
    const uFar = (w.x + w.w * 0.95) / menu.panel.width;
    const vOff = 1 - (w.y + 120) / menu.panel.height;   // far below the track
    const moved = menu.dragAt(uFar, vOff, 'slider:speed');
    expect(moved).toBe(true);
    expect(menu.model.config.speed).toBeGreaterThan(20);
  });

  test('a disabled slider cannot be dragged', () => {
    const menu = openCustom();
    menu.model.setField('spinType', 'none');   // disables spin amount
    menu.rebuild();
    const w = menu.panel.get('slider:spinMagnitude');
    const before = menu.model.config.spinMagnitude;
    menu.dragAt((w.x + w.w) / menu.panel.width, 1 - (w.y + 9) / menu.panel.height,
      'slider:spinMagnitude');
    expect(menu.model.config.spinMagnitude).toBe(before);
  });

  test('SAVE stores a preset and redraws without throwing', () => {
    const store = require('../js/profile/store.js');
    store.resetProfile();
    const menu = new TrainingMenu({ presets: store });
    menu.show();
    clickById(menu, 'item:ballMachine');
    clickById(menu, 'item:customFeed');
    expect(() => clickById(menu, 'save')).not.toThrow();
    expect(store.getPresets().length).toBe(1);
  });

  test('every screen draws without throwing', () => {
    // drawCustom touches widgets that only exist on its own screen; a stale
    // reference would throw only once that screen is opened.
    const store = require('../js/profile/store.js');
    const menu = new TrainingMenu({ presets: store });
    for (const screen of Object.values(SCREENS)) {
      menu.model.stack = [screen];
      expect(() => { menu.rebuild(); }).not.toThrow();
    }
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
    const menu = new TrainingMenu();
    menu.show();
    const seen = [];
    menu.on('calibrate', () => seen.push('calibrate'));
    menu.on('tune', () => seen.push('tune'));
    clickById(menu, 'footer:calibrate');
    clickById(menu, 'footer:tune');
    expect(seen).toEqual(['calibrate', 'tune']);
  });
});

describe('difficulty', () => {
  test('adopts the tier the wrist menu passes in', () => {
    const menu = new TrainingMenu();
    menu.setDifficulty('pro');
    menu.show();
    const started = [];
    menu.on('start', (e) => started.push(e));
    clickById(menu, 'item:ballMachine');
    clickById(menu, 'item:quickFeed');
    clickById(menu, 'item:Warmup');
    expect(started[0].difficulty).toBe('pro');
  });

  test('an unknown tier is ignored rather than throwing', () => {
    const menu = new TrainingMenu();
    expect(() => menu.setDifficulty('nonsense')).not.toThrow();
  });
});
