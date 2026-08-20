// MachinePlayMenu — end-to-end smoke test of the real class.
//
// Same reasoning as trainingMenu.test.js: a throw anywhere inside draw()
// propagates out through wristMenu.emit(), which has no try/catch, and the
// click silently does nothing. Driving the actual code path makes that a test
// result instead of a headset session.

const THREE = require('three');

jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/audio.js', () => ({
  playMenuHoverTick: () => {}, playMenuSelectClick: () => {},
}));
jest.mock('../js/xr/haptics.js', () => ({ pulseActive: () => {} }));

// Canvas stub: any 2D context call is a no-op, any property is writable. A
// Proxy rather than a listed set of methods, so a newly-used ctx call in the
// renderer cannot silently pass here and then throw in the browser.
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
});

const { MachinePlayMenu } = require('../js/scene/machinePlayMenu.js');
const { SCREENS } = require('../js/modes/machinePlay/machinePlayModel.js');
const { MACHINE_MODES } = require('../js/modes/machinePlay/machineModes.js');

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
    expect(() => new MachinePlayMenu()).not.toThrow();
  });

  test('exposes the interface inGame.js drives it through', () => {
    const menu = new MachinePlayMenu();
    for (const m of ['show', 'hide', 'isVisible', 'on', 'hitTestUV', 'setHovered',
      'selectHovered', 'setPokeCursor', 'clearPokeCursor', 'update', 'dispose',
      'sliderAt', 'dragAt']) {
      expect(typeof menu[m]).toBe('function');
    }
    expect(menu.mesh).toBeInstanceOf(THREE.Mesh);
  });

  test('its mesh geometry carries UVs, or the laser raycast finds no hit', () => {
    expect(new MachinePlayMenu().mesh.geometry.attributes.uv).toBeTruthy();
  });

  test('every screen draws without throwing', () => {
    const menu = new MachinePlayMenu();
    for (const screen of Object.values(SCREENS)) {
      menu.model.stack = [screen];
      expect(() => { menu.rebuild(); }).not.toThrow();
    }
  });
});

describe('navigation by click', () => {
  test('every root row is hit-testable at its centre', () => {
    // The regression this mirrors: fixed row heights let the training menu's
    // last rows slide under the footer, which wins the hit test — so a click
    // on the row activated a footer button instead.
    const menu = new MachinePlayMenu();
    menu.show();
    for (const item of menu.model.items()) {
      const [u, v] = uvOf(menu, `item:${item.id}`);
      expect(menu.hitTestUV(u, v)).toBe(`item:${item.id}`);
    }
  });

  test('no list row overlaps the footer on any list screen', () => {
    const menu = new MachinePlayMenu();
    for (const screen of [SCREENS.ROOT, SCREENS.CHALLENGE]) {
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

  test('back pops one level and emits back only at the root', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    let backs = 0;
    menu.on('back', () => { backs++; });

    clickById(menu, 'item:settings');
    clickById(menu, 'back');
    expect(menu.model.screen).toBe(SCREENS.ROOT);
    expect(backs).toBe(0);          // popped, did not close

    clickById(menu, 'back');
    expect(backs).toBe(1);          // at root, closes back to the wrist menu
  });

  test('Rally Settings lays out the feed editor', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    clickById(menu, 'item:settings');
    expect(menu.model.screen).toBe(SCREENS.SETTINGS);
    expect(menu.panel.get('zone:5')).toBeTruthy();
    expect(menu.panel.get('slider:speed')).toBeTruthy();
    expect(menu.panel.get('start')).toBeTruthy();
  });

  test('the settings screen has no Balls stepper and no Save', () => {
    // Every mode runs on an infinite burst and this screen edits a live rally,
    // so both controls would do nothing if they were drawn.
    const menu = new MachinePlayMenu();
    menu.show();
    clickById(menu, 'item:settings');
    expect(menu.panel.get('cycle:burstCount:1')).toBeFalsy();
    expect(menu.panel.get('save')).toBeFalsy();
  });
});

describe('starting a mode', () => {
  const started = (menu) => {
    const seen = [];
    menu.on('start', (e) => seen.push(e));
    return seen;
  };

  test('Quick Rally emits start in rally mode', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    const seen = started(menu);
    clickById(menu, 'item:quickRally');
    expect(seen).toHaveLength(1);
    expect(seen[0].mode).toBe(MACHINE_MODES.RALLY);
    expect(seen[0].config).toBeTruthy();
  });

  test('Survival emits start in survival mode', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    const seen = started(menu);
    clickById(menu, 'item:survival');
    expect(seen[0].mode).toBe(MACHINE_MODES.SURVIVAL);
  });

  test('Score Challenge carries the chosen target through', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    const seen = started(menu);
    clickById(menu, 'item:challenge');
    clickById(menu, 'item:target:50');
    expect(seen).toHaveLength(1);
    expect(seen[0].mode).toBe(MACHINE_MODES.CHALLENGE);
    expect(seen[0].target).toBe(50);
  });

  test('Free Hit emits freeHit rather than start', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    const seen = started(menu);
    let free = 0;
    menu.on('freeHit', () => { free++; });
    clickById(menu, 'item:freeHit');
    expect(free).toBe(1);
    expect(seen).toHaveLength(0);
  });

  test('PLAY on the settings screen starts the edited feed', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    const seen = started(menu);
    clickById(menu, 'item:settings');
    clickById(menu, 'zone:3');
    clickById(menu, 'start');
    expect(seen).toHaveLength(1);
    expect(seen[0].mode).toBe(MACHINE_MODES.RALLY);
    expect(seen[0].config.placement.zone).toBe(3);
  });
});

describe('settings controls', () => {
  const openSettings = () => {
    const menu = new MachinePlayMenu();
    menu.show();
    clickById(menu, 'item:settings');
    return menu;
  };

  test('all nine zone cells are clickable', () => {
    const menu = openSettings();
    for (let z = 1; z <= 9; z++) {
      clickById(menu, `zone:${z}`);
      expect(menu.model.zone).toBe(z);
    }
  });

  test('cycling a segment changes the config', () => {
    const menu = openSettings();
    const before = menu.model.config.arc;
    clickById(menu, 'cycle:arc:1');
    expect(menu.model.config.arc).not.toBe(before);
  });

  test('toggling the audio cue flips it', () => {
    const menu = openSettings();
    const before = menu.model.config.audioCue;
    clickById(menu, 'toggle:audioCue');
    expect(menu.model.config.audioCue).toBe(!before);
  });

  test('TAPPING a slider jumps to that value', () => {
    const menu = openSettings();
    const before = menu.model.config.speed;
    const w = menu.panel.get('slider:speed');
    const u = (w.x + w.w * 0.9) / menu.panel.width;
    const v = 1 - (w.y + 9) / menu.panel.height;
    menu.hitTestUV(u, v);            // host records pointer position
    menu.setHovered('slider:speed');
    menu.selectHovered();
    expect(menu.model.config.speed).not.toBe(before);
  });

  test('a pinned drag keeps control even when the ray leaves the track', () => {
    const menu = openSettings();
    const w = menu.panel.get('slider:speed');
    const uFar = (w.x + w.w * 0.95) / menu.panel.width;
    const vOff = 1 - (w.y + 120) / menu.panel.height;   // far below the track
    expect(menu.dragAt(uFar, vOff, 'slider:speed')).toBe(true);
    expect(menu.model.config.speed).toBeGreaterThan(20);
  });

  test('sliderAt identifies a slider under the pointer', () => {
    const menu = openSettings();
    const w = menu.panel.get('slider:speed');
    const u = (w.x + w.w / 2) / menu.panel.width;
    const v = 1 - (w.y + 9) / menu.panel.height;
    expect(menu.sliderAt(u, v)).toBe('slider:speed');
    expect(menu.sliderAt(0.01, 0.99)).toBeNull();
  });

  test('a disabled spin-amount slider cannot be dragged', () => {
    const menu = openSettings();
    menu.model.setField('spinType', 'none');
    menu.rebuild();
    const before = menu.model.config.spinMagnitude;
    const w = menu.panel.get('slider:spinMagnitude');
    menu.dragAt((w.x + w.w) / menu.panel.width, 1 - (w.y + 9) / menu.panel.height,
      'slider:spinMagnitude');
    expect(menu.model.config.spinMagnitude).toBe(before);
  });

  test('an unfeedable config surfaces the probe warning on the panel', () => {
    // Without this the only symptom of impossible settings is a machine that
    // silently never fires, which reads as broken rather than as misconfigured.
    const menu = openSettings();
    menu.setFeasibilityProbe(() => 'too slow');
    clickById(menu, 'zone:9');
    expect(menu.model.message).toBe('too slow');
  });

  test('a throwing probe does not take the menu down', () => {
    const menu = openSettings();
    menu.setFeasibilityProbe(() => { throw new Error('boom'); });
    // The catch logs; that is the point of the test, so mute it rather than
    // letting an expected stack trace look like a failure in the output.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => clickById(menu, 'zone:1')).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('footer', () => {
  test('CLOSE emits back — it leaves the menu, not the session', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    let backs = 0;
    menu.on('back', () => { backs++; });
    clickById(menu, 'footer:exit');
    expect(backs).toBe(1);
  });

  test('calibrate and physics hand off to the existing panels', () => {
    const menu = new MachinePlayMenu();
    menu.show();
    const seen = [];
    menu.on('calibrate', () => seen.push('calibrate'));
    menu.on('tune', () => seen.push('tune'));
    clickById(menu, 'footer:calibrate');
    clickById(menu, 'footer:tune');
    expect(seen).toEqual(['calibrate', 'tune']);
  });
});
