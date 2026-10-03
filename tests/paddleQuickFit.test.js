// PaddleQuickFit — drives the real panel class headless (canvas stubbed),
// through the same calibration singleton the game uses.

const THREE = require('three');

jest.mock('../js/scene/audio.js', () => ({
  playMenuHoverTick: () => {}, playMenuSelectClick: () => {},
}));
jest.mock('../js/xr/haptics.js', () => ({ pulseActive: () => {} }));

function makeCtx() {
  return new Proxy({}, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(t, prop, v) { t[prop] = v; return true; },
    has() { return true; },
  });
}

class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => makeCtx() }),
};
globalThis.localStorage = new MemoryStorage();

const { PaddleQuickFit } = require('../js/scene/paddleQuickFit.js');
const calibration = require('../js/xr/calibration.js');
const { registerDerivedPreset } = require('../js/xr/calibrationPresets.js');
const { ANGLE_RATE_DEG_S } = require('../js/xr/paddleAdjust.js');

const HG = {
  posOffset: new THREE.Vector3(0, 0.01, 0.05),
  rotOffset: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3),
};
const KEY = 'p13.calibration.qf-test.right';
const stored = () => JSON.parse(globalThis.localStorage.getItem(KEY));

describe('PaddleQuickFit', () => {
  let qf;

  beforeEach(() => {
    globalThis.localStorage.clear();
    registerDerivedPreset('handle_grip', HG);
    calibration.loadForProfile('qf-test', 'right');  // first launch → handle_grip
    qf = new PaddleQuickFit();
    qf.show();
  });

  test('opens on the measured fit with zeroed knobs', () => {
    expect(qf.onMeasured).toBe(true);
    expect(qf.adjust).toEqual({ faceDeg: 0, batDeg: 0, slideM: 0 });
  });

  test('stick inside the deadzone leaves the paddle alone', () => {
    expect(qf.applyStick(0.1, -0.1, 0.1, 0.1)).toBe(false);
    expect(calibration.getPresetName()).toBe('handle_grip');
  });

  test('stick moves the paddle live, saves only on close', () => {
    expect(qf.applyStick(1, 0, 0, 0.1)).toBe(true);
    expect(qf.adjust.faceDeg).toBeCloseTo(ANGLE_RATE_DEG_S * 0.1, 9);
    expect(calibration.getPresetName()).toBe(calibration.QUICK_FIT_PRESET);
    expect(calibration.isUncommitted()).toBe(true);
    expect(stored()).toBeNull();   // live edit not written yet

    let backs = 0;
    qf.on('back', () => { backs++; qf.hide(); });  // as inGame's onTunerBack does
    qf.handle('done');
    expect(backs).toBe(1);
    expect(calibration.isUncommitted()).toBe(false);
    expect(stored().preset).toBe(calibration.QUICK_FIT_PRESET);
    expect(stored().adjust.faceDeg).toBeCloseTo(ANGLE_RATE_DEG_S * 0.1, 9);
  });

  test('reopening restores the saved knobs', () => {
    qf.applyStick(0, -1, -1, 0.2);
    qf.hide();
    const again = new PaddleQuickFit();
    again.show();
    expect(again.onMeasured).toBe(true);
    expect(again.adjust.batDeg).toBeCloseTo(ANGLE_RATE_DEG_S * 0.2, 9);
    expect(again.adjust.slideM).toBeGreaterThan(0);
  });

  test('RESET returns to the measured fit and saves it', () => {
    qf.applyStick(1, 1, 1, 0.3);
    qf.handle('reset');
    expect(calibration.getPresetName()).toBe('handle_grip');
    expect(calibration.getPosOffset().distanceTo(HG.posOffset)).toBeLessThan(1e-12);
    expect(qf.adjust).toEqual({ faceDeg: 0, batDeg: 0, slideM: 0 });
    expect(stored().preset).toBe('handle_grip');
  });

  test('a non-measured fit is adjusted in place and saved as custom', () => {
    qf.hide();
    calibration.setPreset('shakehand');
    qf.show();
    expect(qf.onMeasured).toBe(false);
    qf.applyStick(0, -1, 0, 0.1);
    qf.hide();
    expect(stored().preset).toBe('custom');
    expect(stored().adjust).toBeUndefined();
  });

  test('wizard / fine-tune buttons hand off by event', () => {
    const seen = [];
    qf.on('wizard', () => seen.push('wizard'));
    qf.on('fineTune', () => seen.push('fineTune'));
    qf.handle('wizard');
    qf.handle('fineTune');
    expect(seen).toEqual(['wizard', 'fineTune']);
  });

  test('every button is hit-testable', () => {
    for (const w of qf.panel.widgets) {
      const u = (w.x + w.w / 2) / qf.panel.width;
      const v = 1 - (w.y + w.h / 2) / qf.panel.height;
      expect(qf.hitTestUV(u, v)).toBe(w.id);
    }
  });
});
