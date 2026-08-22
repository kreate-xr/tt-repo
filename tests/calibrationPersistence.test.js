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
  setPreset, setRotOffset, loadForProfile,
  getPosOffset, getRotOffset, getPresetName, getActiveProfile,
} = require('../js/xr/calibration.js');

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

  test('unknown profile string still tracks activeProfile', () => {
    loadForProfile('some-unknown-headset-v9');
    expect(getActiveProfile()).toBe('some-unknown-headset-v9');
    // Any subsequent setPreset should persist keyed on THIS profile.
    setPreset('shakehand');
    const raw = globalThis.localStorage.getItem('p13.calibration.some-unknown-headset-v9');
    expect(raw).not.toBeNull();
  });
});
