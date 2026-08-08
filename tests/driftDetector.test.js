// P13 spec §C8 — drift detector.
//
// Spec tests C8a and C8b:
//   C8a — replay a contact log with a deliberate off-center bias injected
//         mid-log; drift flag fires within 40 contacts of injection and NOT
//         before.
//   C8b — replay a clean noisy-but-unbiased log (Gaussian σ=0.02, zero mean)
//         over 500 contacts; flag must NOT fire.
//
// Also verifies calibration.subscribe clears the log on T_cal change.

// localStorage shim so calibration.js loads cleanly in Node.
class MemoryStorage {
  constructor() { this._store = new Map(); }
  getItem(k)    { return this._store.has(k) ? this._store.get(k) : null; }
  setItem(k, v) { this._store.set(k, String(v)); }
  removeItem(k) { this._store.delete(k); }
  clear()       { this._store.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const { recordHit, snapshot, count, _resetForTests, clear } = require('../js/xr/contactLog.js');
const { evaluate, getDriftFlag } = require('../js/xr/driftDetector.js');
const { setPreset, setPosOffset } = require('../js/xr/calibration.js');
const THREE = require('three');

// Deterministic Gaussian sampler (Box-Muller). Wraps a seedable PRNG so
// runs are reproducible without adding a test dependency.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}
function gauss(rng, mean, sigma) {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return mean + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

describe('driftDetector — spec C8a/C8b', () => {
  beforeEach(() => _resetForTests());

  test('C8b — 500 contacts of unbiased Gaussian scatter (σ=0.02, zero mean) must NOT flag', () => {
    const rng = makeRng(12345);
    let flaggedEarly = false;
    for (let i = 0; i < 500; i++) {
      const x = gauss(rng, 0, 0.02);
      const y = gauss(rng, 0, 0.02);
      recordHit(x, y, 0, 0.5);  // utOverVn=0.5, not a "flat" hit
      // Only start checking after buffer is full.
      if (count() >= 40 && getDriftFlag()) flaggedEarly = true;
    }
    expect(flaggedEarly).toBe(false);
  });

  test('C8a — off-center bias injected mid-log fires the flag within 40 contacts of injection', () => {
    const rng = makeRng(6789);

    // First: 40 unbiased contacts to fill the ring. Flag should stay OFF.
    for (let i = 0; i < 40; i++) {
      recordHit(gauss(rng, 0, 0.02), gauss(rng, 0, 0.02), 0, 0.5);
    }
    expect(getDriftFlag()).toBe(false);

    // Now inject a biased stream — all hits shifted ~4 cm along +X with low
    // scatter (simulates a grip that's shifted so the player systematically
    // strikes right-of-center on the blade). Watch when the flag fires.
    let firedAt = -1;
    for (let i = 0; i < 60; i++) {
      recordHit(gauss(rng, 0.04, 0.008), gauss(rng, 0, 0.008), 0, 0.5);
      if (firedAt < 0 && getDriftFlag()) firedAt = i + 1;
    }
    expect(firedAt).toBeGreaterThan(0);
    expect(firedAt).toBeLessThanOrEqual(40);
  });

  test('driftDetector returns no-flag when buffer has fewer than 40 samples', () => {
    for (let i = 0; i < 30; i++) recordHit(0.05, 0.01, 0, 0.5);  // biased but too few
    expect(getDriftFlag()).toBe(false);
    expect(evaluate().reason).toBeNull();
  });

  test('calibration change clears contact log (plan Gotcha d)', () => {
    for (let i = 0; i < 20; i++) recordHit(0.03, 0, 0, 0.5);
    expect(count()).toBe(20);
    // Force a T_cal change — any setter fires the subscriber.
    setPosOffset(new THREE.Vector3(0.001, 0, 0));
    expect(count()).toBe(0);
    // Also confirm subsequent recordHit still works after clear.
    recordHit(0, 0, 0, 0.5);
    expect(count()).toBe(1);
  });
});
