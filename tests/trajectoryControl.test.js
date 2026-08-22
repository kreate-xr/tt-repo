// TrajectoryControl — the Trajectory Practice panel, rebuilt on panelKit.
//
// The old hand-rolled panel had no tests at all; the rebuild gets the same
// smoke coverage trainingMenu has, because the failure mode is identical — a
// throw inside draw() surfaces in-headset as "the click does nothing".

const THREE = require('three');

jest.mock('../js/scene/audio.js', () => ({
  playMenuHoverTick: () => {}, playMenuSelectClick: () => {},
}));
jest.mock('../js/xr/haptics.js', () => ({ pulseActive: () => {} }));

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

const {
  TrajectoryControl, SPINS, SPEED_LEVELS, INTENSITY_LEVELS,
} = require('../js/scene/trajectoryControl.js');

function uvOf(control, id) {
  const w = control.panel.get(id);
  if (!w) throw new Error(`no widget "${id}"`);
  return [(w.x + w.w / 2) / control.panel.width, 1 - (w.y + w.h / 2) / control.panel.height];
}

function clickById(control, id) {
  const [u, v] = uvOf(control, id);
  const hit = control.hitTestUV(u, v);
  expect(hit).toBe(id);
  control.setHovered(hit);
  return control.selectHovered();
}

describe('construction', () => {
  test('constructs, shows and draws without throwing', () => {
    const c = new TrajectoryControl();
    expect(() => c.show()).not.toThrow();
    expect(c.isVisible()).toBe(true);
    expect(c.mesh).toBeInstanceOf(THREE.Mesh);
  });

  test('exposes the surface inGame.js and trajectoryPractice.js drive', () => {
    const c = new TrajectoryControl();
    for (const m of ['show', 'hide', 'isVisible', 'on', 'hitTestUV', 'setHovered',
      'selectHovered', 'getSpin', 'getSpeed', 'getIntensity', 'dispose']) {
      expect(typeof c[m]).toBe('function');
    }
    // inGame reads .hovered to decide trigger routing (panel vs launch).
    c.setHovered('back');
    expect(c.hovered).toBe('back');
    c.setHovered(null);
    expect(c.hovered).toBeNull();
  });
});

describe('option cells', () => {
  test('every spin, speed and intensity cell is hit-testable and selects', () => {
    const c = new TrajectoryControl();
    c.show();
    for (const [kind, options] of [
      ['spin', SPINS], ['speed', SPEED_LEVELS], ['intensity', INTENSITY_LEVELS],
    ]) {
      for (let i = 0; i < options.length; i++) clickById(c, `${kind}:${i}`);
    }
    // Last click of each row sticks.
    expect(c.getSpin()).toBe(SPINS[SPINS.length - 1]);
    expect(c.getSpeed()).toBe(SPEED_LEVELS[SPEED_LEVELS.length - 1]);
    expect(c.getIntensity()).toBe(INTENSITY_LEVELS[INTENSITY_LEVELS.length - 1]);
  });

  test('selection fires the change events the preview recomputes from', () => {
    const c = new TrajectoryControl();
    c.show();
    const got = [];
    c.on('spinChange', (e) => got.push(['spin', e.spin.id]));
    c.on('speedChange', (e) => got.push(['speed', e.speed.label]));
    c.on('intensityChange', (e) => got.push(['intensity', e.intensity.label]));

    clickById(c, 'spin:1');
    clickById(c, 'speed:4');
    clickById(c, 'intensity:0');

    expect(got).toEqual([
      ['spin', SPINS[1].id], ['speed', '5'], ['intensity', '1'],
    ]);
  });

  test('defaults match the old panel: flat-ish spin, middle speed and intensity', () => {
    const c = new TrajectoryControl();
    expect(c.getSpin()).toBe(SPINS[0]);
    expect(c.getSpeed()).toBe(SPEED_LEVELS[2]);
    expect(c.getIntensity()).toBe(INTENSITY_LEVELS[2]);
  });
});

describe('footer', () => {
  test('back and hide emit their events', () => {
    const c = new TrajectoryControl();
    c.show();
    const events = [];
    c.on('back', () => events.push('back'));
    c.on('hide', () => events.push('hide'));
    clickById(c, 'hide');
    clickById(c, 'back');
    expect(events).toEqual(['hide', 'back']);
  });

  test('selectHovered with nothing hovered is a no-op', () => {
    const c = new TrajectoryControl();
    c.setHovered(null);
    expect(c.selectHovered()).toBe(false);
  });
});
