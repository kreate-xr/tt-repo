// P13 spec §C5 — per-controller-profile persistence.
//
// Verifies: setPreset + loadForProfile roundtrip, custom values persist and
// reload, unknown-profile lookup falls back to default preset, corrupt storage
// is ignored.

const THREE = require('three');

// Shim localStorage in the Node test environment. calibration.js's persist()
// is wrapped in try/catch so a missing localStorage doesn't crash tests, but
// we need one to actually verify persistence.
class MemoryStorage {
  constructor() { this._store = new Map(); }
  getItem(k)     { return this._store.has(k) ? this._store.get(k) : null; }
  setItem(k, v)  { this._store.set(k, String(v)); }
  removeItem(k)  { this._store.delete(k); }
  clear()        { this._store.clear(); }
}
globalThis.localStorage = new MemoryStorage();

// Import AFTER shim so calibration.js's module-load-time reads see it.
const {
  setPreset, setRotOffset, setPosOffset, loadForProfile,
  getPosOffset, getRotOffset, getPresetName, getActiveProfile,
} = require('../js/xr/calibration.js');
const { registerDerivedPreset } = require('../js/xr/calibrationPresets.js');

function resetStorage() {
  globalThis.localStorage.clear();
}

describe('calibration persistence (spec §C5)', () => {
  beforeEach(() => {
    resetStorage();
    // Reset in-memory state to a known baseline by loading a fresh profile.
    loadForProfile('__test_reset__');
  });

  test('setPreset(shakehand) then loadForProfile roundtrip preserves values', () => {
    loadForProfile('oculus-touch-v3');
    setPreset('shakehand');
    // Assert what got written to localStorage
    const raw = globalThis.localStorage.getItem('p13.calibration.oculus-touch-v3');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.preset).toBe('shakehand');
    expect(parsed.posOffset).toEqual([0, 0.02, -0.14]);

    // Reload — values must match to 1e-9. Scramble on a THROWAWAY profile
    // so we don't overwrite the just-persisted shakehand entry we're about
    // to read back.
    loadForProfile('__scramble__');
    setPreset('default');
    loadForProfile('oculus-touch-v3');
    const p = getPosOffset();
    expect(Math.abs(p.x - 0)).toBeLessThan(1e-9);
    expect(Math.abs(p.y - 0.02)).toBeLessThan(1e-9);
    expect(Math.abs(p.z - (-0.14))).toBeLessThan(1e-9);
    expect(getPresetName()).toBe('shakehand');
  });

  test('custom rotOffset persists and reloads to 1e-9 per component', () => {
    loadForProfile('quest-custom');
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0.5, 0.3).normalize(),
      (37 * Math.PI) / 180,
    );
    setRotOffset(q);
    // Reload — scramble on a THROWAWAY profile first (see explanation above)
    loadForProfile('__scramble__');
    setPreset('default');
    loadForProfile('quest-custom');
    const r = getRotOffset();
    expect(Math.abs(r.x - q.x)).toBeLessThan(1e-9);
    expect(Math.abs(r.y - q.y)).toBeLessThan(1e-9);
    expect(Math.abs(r.z - q.z)).toBeLessThan(1e-9);
    expect(Math.abs(r.w - q.w)).toBeLessThan(1e-9);
    expect(getPresetName()).toBe('custom');
  });

  test('per-profile isolation: profile A does not overwrite profile B', () => {
    loadForProfile('profile-a');
    setPreset('shakehand');
    loadForProfile('profile-b');
    setPreset('penhold');

    // Come back to A — should still be shakehand
    loadForProfile('profile-a');
    expect(getPresetName()).toBe('shakehand');
    expect(Math.abs(getPosOffset().z - (-0.14))).toBeLessThan(1e-9);

    loadForProfile('profile-b');
    expect(getPresetName()).toBe('penhold');
    expect(Math.abs(getPosOffset().z - (-0.10))).toBeLessThan(1e-9);
  });

  test('corrupt storage entry falls back to preset defaults', () => {
    globalThis.localStorage.setItem('p13.calibration.corrupt-profile', '{"not":"valid p13"}');
    loadForProfile('corrupt-profile');
    // Should NOT throw; should be in default state (matchProfile returns default).
    expect(getPresetName()).toBe('default');
  });

  test('persisted derived preset reloads from the LIVE derivation, not the snapshot', () => {
    // Session 1: model measured, derived preset registered, player picks it.
    registerDerivedPreset('handle_grip', {
      posOffset: new THREE.Vector3(0, 0, 0.042),
      rotOffset: new THREE.Quaternion(),
    });
    loadForProfile('derived-profile');
    setPreset('handle_grip');

    // Session 2: the derivation changed (GRIP_POINT_FRACTION tweak, GLB
    // re-export) — registration now yields different numbers. The stored
    // snapshot must NOT shadow them.
    registerDerivedPreset('handle_grip', {
      posOffset: new THREE.Vector3(0, 0, 0.067),
      rotOffset: new THREE.Quaternion(),
    });
    loadForProfile('__scramble__');
    setPreset('default');
    loadForProfile('derived-profile');
    expect(getPresetName()).toBe('handle_grip');
    expect(Math.abs(getPosOffset().z - 0.067)).toBeLessThan(1e-9);
  });

  test('hand-tweak on top of a derived preset persists as custom and survives reload', () => {
    registerDerivedPreset('handle_grip', {
      posOffset: new THREE.Vector3(0, 0, 0.042),
      rotOffset: new THREE.Quaternion(),
    });
    loadForProfile('tweaked-profile');
    setPreset('handle_grip');
    setPosOffset(new THREE.Vector3(0, 0.01, 0.09));  // tuner nudge → 'custom'

    registerDerivedPreset('handle_grip', {
      posOffset: new THREE.Vector3(0, 0, 0.067),
      rotOffset: new THREE.Quaternion(),
    });
    loadForProfile('__scramble__');
    setPreset('default');
    loadForProfile('tweaked-profile');
    // Player's manual values win — the re-derive path only bypasses UNTOUCHED
    // derived snapshots.
    expect(getPresetName()).toBe('custom');
    expect(Math.abs(getPosOffset().z - 0.09)).toBeLessThan(1e-9);
    expect(Math.abs(getPosOffset().y - 0.01)).toBeLessThan(1e-9);
  });

  test('unknown profile string still tracks activeProfile', () => {
    loadForProfile('some-unknown-headset-v9');
    expect(getActiveProfile()).toBe('some-unknown-headset-v9');
    // Any subsequent setPreset should persist keyed on THIS profile.
    setPreset('shakehand');
    const raw = globalThis.localStorage.getItem('p13.calibration.some-unknown-headset-v9');
    expect(raw).not.toBeNull();
  });
});

describe('per-hand storage, first-launch seed, Quick Fit', () => {
  const {
    setCalibration, commitCalibration, getAdjust, isUncommitted, QUICK_FIT_PRESET,
  } = require('../js/xr/calibration.js');
  const { applyAdjust } = require('../js/xr/paddleAdjust.js');
  const { PRESETS } = require('../js/xr/calibrationPresets.js');

  const HG = {
    posOffset: new THREE.Vector3(0, 0.01, 0.05),
    rotOffset: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3),
  };

  beforeEach(() => {
    resetStorage();
    registerDerivedPreset('handle_grip', HG);
    loadForProfile('__test_reset__');
  });

  test('first launch seeds the measured handle_grip fit', () => {
    loadForProfile('fresh-profile', 'right');
    expect(getPresetName()).toBe('handle_grip');
    expect(getPosOffset().distanceTo(HG.posOffset)).toBeLessThan(1e-12);
  });

  test('without a registered measured fit, first launch still falls back to default', () => {
    const saved = PRESETS.handle_grip;
    delete PRESETS.handle_grip;
    try {
      loadForProfile('no-model-profile', 'right');
      expect(getPresetName()).toBe('default');
    } finally {
      PRESETS.handle_grip = saved;
    }
  });

  test('left and right hands keep independent fits under one profile string', () => {
    loadForProfile('oculus-touch-v3', 'right');
    setPreset('shakehand');
    loadForProfile('oculus-touch-v3', 'left');
    setPreset('penhold');

    expect(globalThis.localStorage.getItem('p13.calibration.oculus-touch-v3.right')).not.toBeNull();
    expect(globalThis.localStorage.getItem('p13.calibration.oculus-touch-v3.left')).not.toBeNull();

    loadForProfile('oculus-touch-v3', 'right');
    expect(getPresetName()).toBe('shakehand');
    loadForProfile('oculus-touch-v3', 'left');
    expect(getPresetName()).toBe('penhold');
  });

  test('legacy profile-only entry migrates to the per-hand key', () => {
    loadForProfile('legacy-profile');          // no hand → legacy key
    setPreset('shakehand');
    loadForProfile('legacy-profile', 'left');
    expect(getPresetName()).toBe('shakehand');
    const migrated = globalThis.localStorage.getItem('p13.calibration.legacy-profile.left');
    expect(JSON.parse(migrated).preset).toBe('shakehand');
  });

  test('live edit applies without persisting until commit', () => {
    loadForProfile('live-profile', 'right');
    const adj = { faceDeg: 12, batDeg: -8, slideM: 0.01 };
    const res = applyAdjust(HG, adj);
    setCalibration({ ...res, presetName: QUICK_FIT_PRESET, adjust: adj, persist: false });

    expect(isUncommitted()).toBe(true);
    expect(getPosOffset().distanceTo(res.posOffset)).toBeLessThan(1e-12);
    expect(globalThis.localStorage.getItem('p13.calibration.live-profile.right')).toBeNull();

    commitCalibration();
    expect(isUncommitted()).toBe(false);
    const after = JSON.parse(globalThis.localStorage.getItem('p13.calibration.live-profile.right'));
    expect(after.preset).toBe(QUICK_FIT_PRESET);
    expect(after.adjust).toEqual(adj);
  });

  test('Quick Fit reloads from the LIVE measured fit plus stored knobs', () => {
    loadForProfile('qf-profile', 'right');
    const adj = { faceDeg: 10, batDeg: 5, slideM: 0.02 };
    setCalibration({ ...applyAdjust(HG, adj), presetName: QUICK_FIT_PRESET, adjust: adj });

    // Model re-export changes the measured fit between sessions.
    const HG2 = { posOffset: new THREE.Vector3(0, 0, 0.07), rotOffset: new THREE.Quaternion() };
    registerDerivedPreset('handle_grip', HG2);
    loadForProfile('__scramble__');
    loadForProfile('qf-profile', 'right');

    expect(getPresetName()).toBe(QUICK_FIT_PRESET);
    expect(getAdjust()).toEqual(adj);
    const expected = applyAdjust(HG2, adj);
    expect(getPosOffset().distanceTo(expected.posOffset)).toBeLessThan(1e-9);
  });

  test('any manual setter clears the Quick Fit knobs', () => {
    loadForProfile('clear-profile', 'right');
    const adj = { faceDeg: 10, batDeg: 0, slideM: 0 };
    setCalibration({ ...applyAdjust(HG, adj), presetName: QUICK_FIT_PRESET, adjust: adj });
    setPosOffset(new THREE.Vector3(0, 0, 0.03));
    expect(getPresetName()).toBe('custom');
    expect(getAdjust()).toBeNull();
  });
});
