// Unit tests for the Beginner engine. Verifies the CURRENT constraints —
// the original spec's tight bounds (x=[-0.35,0.35], speed=[3,5], spin=[-5,5])
// have been intentionally widened as part of the "make each difficulty
// feel like a real player" pass:
//   target_x ∈ [-0.55, 0.55]  (Gaussian jitter + occasional tactical picks)
//   target_z ∈ [0.30, 1.10]
//   speed   ∈ [1.5, 8.5]      (PROFILE_OVERRIDES.beginner; the 1.5 floor is
//                              DIFFICULTY_CAPS.beginner.minSpeed, applied
//                              after depthSpeedFactor scales pace for deep
//                              targets)
//   spin    ∈ [-15, 15]       (PROFILE_OVERRIDES.beginner spin bounds — NOT
//                              the ±20 rail, which deliberately sits clear.
//                              Beginner's widest live types are loop +14.4
//                              and slice -12)
//   payload length = 6        (shot type in slot [5], same as Int/Pro)
//
// Statistical tests use a seeded RNG so they're deterministic on every run.

import { createBeginnerEngine } from '../js/ai/engines/beginner.js';

// Mulberry32 — small, fast, deterministic seed. Good enough for distribution
// sanity in unit tests, NOT cryptographic.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('createBeginnerEngine', () => {
  test('computeTarget returns the 6-element wire payload', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(1) });
    const t = engine.computeTarget(null, {});
    expect(Array.isArray(t)).toBe(true);
    expect(t.length).toBe(6);
  });

  test('confidence is always 1.0', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(2) });
    for (let i = 0; i < 100; i++) {
      const t = engine.computeTarget(null, {});
      expect(t[4]).toBe(1.0);
    }
  });

  // Beginner has TWO placement boxes: ordinary shots land in a narrow box
  // around the middle (±0.55, z 0.30-1.10), and the rare 3% tactical pick may
  // reach the full safe zone (±0.7, z 0.1-1.3).
  //
  // Those tactical picks used to be clamped into the narrow box, which
  // collapsed six of the twelve zones onto the boundary — deep_wide_left and
  // wide_left resolved to the same point — so the occasional accidental wide
  // angle the branch exists to produce never actually occurred.
  test('target_x stays in the safe zone, and is overwhelmingly central', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(3) });
    let sumX = 0, wide = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const [x] = engine.computeTarget(null, {});
      expect(x).toBeGreaterThanOrEqual(-0.7);
      expect(x).toBeLessThanOrEqual(0.7);
      if (Math.abs(x) > 0.55) wide += 1;
      sumX += x;
    }
    // Still centred — beginners have no deliberate placement bias.
    expect(Math.abs(sumX / N)).toBeLessThan(0.03);
    // Wide shots exist but stay rare (tactical probability is 0.03).
    expect(wide).toBeGreaterThan(0);
    expect(wide / N).toBeLessThan(0.03);
  });

  test('target_z stays in the safe zone, and is overwhelmingly mid-depth', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(4) });
    let outsideOrdinary = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const [, z] = engine.computeTarget(null, {});
      expect(z).toBeGreaterThanOrEqual(0.10);
      expect(z).toBeLessThanOrEqual(1.30);
      if (z < 0.30 || z > 1.10) outsideOrdinary += 1;
    }
    expect(outsideOrdinary / N).toBeLessThan(0.03);
  });

  test('target_speed respects Beginner profile range [1.8, 8.5] m/s over 10k samples', () => {
    // Bounds come from PROFILE_OVERRIDES.beginner, not from a cap. Beginner's
    // attacking strokes are damped there (drive 6.0, loop 5.5, smash 7.9
    // mean) while touch shots keep base pace (drop_shot 1.8 m/s floor).
    //
    // The old 5.5 ceiling was a DIFFICULTY_CAPS value doing the shaping, which
    // pinned every beginner drive and smash to exactly 5.5 m/s — the same
    // collapse defect that made intermediate's smash a constant.
    const engine = createBeginnerEngine({ rng: mulberry32(5) });
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const [, , speed] = engine.computeTarget(null, {});
      expect(speed).toBeGreaterThanOrEqual(1.5);
      expect(speed).toBeLessThanOrEqual(8.5);
    }
  });

  test('target_spin respects Beginner profile range [-15, 15] rps over 10k samples', () => {
    // Bounds come from PROFILE_OVERRIDES.beginner, not from the rail. Before
    // those spin overrides existed, DIFFICULTY_CAPS.maxSpin (±15) did the
    // shaping and 100% of beginner loops emitted EXACTLY +15.0 rps, 77% of
    // slices exactly -15.0 — the collapse defect, still live on the spin axis
    // after it had been fixed on the speed axis.
    const engine = createBeginnerEngine({ rng: mulberry32(6) });
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const [, , , spin] = engine.computeTarget(null, {});
      expect(spin).toBeGreaterThanOrEqual(-15.0);
      expect(spin).toBeLessThanOrEqual(15.0);
    }
  });

  test('ingestShot is a no-op (Beginner does not learn)', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(7) });
    // Should not throw, should not affect subsequent computeTarget outputs.
    engine.ingestShot([1, 0, 0.2, 0.5, 1, 30, 5, 0], null);
    const t1 = engine.computeTarget(null, {});
    const t2 = engine.computeTarget(null, {});
    expect(t1.length).toBe(6);
    expect(t2.length).toBe(6);
  });

  test('reset is a no-op (Beginner is stateless)', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(8) });
    expect(() => engine.reset()).not.toThrow();
  });

  test('uses the injected RNG (deterministic with same seed)', () => {
    const a = createBeginnerEngine({ rng: mulberry32(42) });
    const b = createBeginnerEngine({ rng: mulberry32(42) });
    for (let i = 0; i < 50; i++) {
      const ta = a.computeTarget(null, {});
      const tb = b.computeTarget(null, {});
      // First 4 elements are numeric — RNG determinism check. Element [4]
      // is confidence (always 1.0), [5] is shot type string.
      for (let k = 0; k < 4; k++) expect(ta[k]).toBeCloseTo(tb[k], 12);
      expect(ta[4]).toBe(tb[4]);
      expect(ta[5]).toBe(tb[5]);
    }
  });
});
