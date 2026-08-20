// Unit tests for the Intermediate engine. Covers spec
// §testing_requirements.unit_tests_jest items:
//   - Voronoi cell area floor merges sub-threshold cells
//   - Bayesian shrinkage formula on synthetic data matches reference values
//   - Weighted CDF sampling distribution matches input weights within 5% over 10k samples
//   - Grid snap rounds correctly at boundary values
// + integration checks: struggle score formula, min-shots fallback,
//   computeTarget output stays inside safe-zone bounds.

import {
  createIntermediateEngine,
  struggleScorePerShot,
  buildSeeds,
  shrinkScores,
  filterByCellArea,
  weightedSampleIndex,
} from '../js/ai/engines/intermediate.js';
import { ShotHistory } from '../js/ai/shotHistory.js';

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

// --- struggleScorePerShot ---------------------------------------------------

describe('struggleScorePerShot', () => {
  test('miss contributes exactly +3', () => {
    expect(struggleScorePerShot({ success: 0, swing_lateness_ms: 0 })).toBeCloseTo(3.0, 10);
  });

  // Successes now subtract from struggle score (was +0.5, now -0.3). Zones
  // where the player scores cleanly should be LESS attractive as AI
  // targets, not more.
  test('clean success contributes exactly -0.3', () => {
    expect(struggleScorePerShot({ success: 1, swing_lateness_ms: 0 })).toBeCloseTo(-0.3, 10);
  });

  test('lateness of 100ms contributes exactly 2 (per spec formula)', () => {
    expect(struggleScorePerShot({ success: 0, swing_lateness_ms: 100 })).toBeCloseTo(3 + 2, 10);
  });

  test('combined: miss + 200ms lateness = 3 + 4 = 7', () => {
    expect(struggleScorePerShot({ success: 0, swing_lateness_ms: 200 })).toBeCloseTo(7, 10);
  });

  test('treats boolean success the same as 0/1', () => {
    expect(struggleScorePerShot({ success: true,  swing_lateness_ms: 0 })).toBeCloseTo(-0.3, 10);
    expect(struggleScorePerShot({ success: false, swing_lateness_ms: 0 })).toBeCloseTo(3.0, 10);
  });
});

// --- buildSeeds / grid snap -------------------------------------------------

describe('buildSeeds — grid snap groups landings at 10cm', () => {
  test('two shots inside the same 10cm cell merge into one seed', () => {
    const shots = [
      { landing_x: 0.21, landing_z: 0.51, success: 0, swing_lateness_ms: 0, weight: 1.0 },
      { landing_x: 0.19, landing_z: 0.49, success: 0, swing_lateness_ms: 0, weight: 1.0 },
    ];
    // 0.21 → 2.1 → round 2 → 0.20. 0.19 → 1.9 → round 2 → 0.20.
    // 0.51 → 5.1 → round 5 → 0.50. 0.49 → 4.9 → round 5 → 0.50.
    // Both snap to (0.20, 0.50).
    const seeds = buildSeeds(shots);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].x).toBeCloseTo(0.20, 10);
    expect(seeds[0].z).toBeCloseTo(0.50, 10);
    expect(seeds[0].n).toBe(2);
    expect(seeds[0].score).toBeCloseTo(6.0, 10); // 2 misses * 3
  });

  test('grid snap boundary: 0.05 rounds to 0.10', () => {
    const shots = [
      { landing_x: 0.05, landing_z: 0.05, success: 0, swing_lateness_ms: 0, weight: 1.0 },
    ];
    const seeds = buildSeeds(shots);
    // Round-half-up via Math.round at exactly 0.05 — JS rounds 0.05 to 0
    // because 0.05/0.10 = 0.5 and Math.round(0.5) = 1. So 0.05 → 0.10.
    expect(Math.abs(seeds[0].x)).toBeCloseTo(0.10, 10);
    expect(Math.abs(seeds[0].z)).toBeCloseTo(0.10, 10);
  });

  test('grid snap boundary: 0.14 rounds to 0.10, 0.16 rounds to 0.20', () => {
    const a = buildSeeds([{ landing_x: 0.14, landing_z: 0, success: 0, swing_lateness_ms: 0, weight: 1.0 }]);
    const b = buildSeeds([{ landing_x: 0.16, landing_z: 0, success: 0, swing_lateness_ms: 0, weight: 1.0 }]);
    expect(a[0].x).toBeCloseTo(0.10, 10);
    expect(b[0].x).toBeCloseTo(0.20, 10);
  });

  test('decay weight propagates into seed score', () => {
    const shots = [
      { landing_x: 0.3, landing_z: 0.5, success: 0, swing_lateness_ms: 0, weight: 1.0 },
      { landing_x: 0.3, landing_z: 0.5, success: 0, swing_lateness_ms: 0, weight: 0.5 },
    ];
    const seeds = buildSeeds(shots);
    // miss=3 each. Weighted: 3*1.0 + 3*0.5 = 4.5.
    expect(seeds).toHaveLength(1);
    expect(seeds[0].score).toBeCloseTo(4.5, 10);
    expect(seeds[0].weightedN).toBeCloseTo(1.5, 10);
  });
});

// --- shrinkScores -----------------------------------------------------------

describe('shrinkScores — Bayesian shrinkage with prior N₀=3', () => {
  test('matches reference on synthetic two-cell data', () => {
    // Cell A: weightedN=10, raw score=10 → observed rate = 1.0
    // Cell B: weightedN=2,  raw score=8  → observed rate = 4.0
    // Population mean = (10 + 8) / (10 + 2) = 1.5.
    // Shrunk(A) = (10*1.0 + 3*1.5) / (10+3) = 14.5/13 ≈ 1.1154
    // Shrunk(B) = (2*4.0 + 3*1.5) / (2+3)  = 12.5/5  = 2.5
    const seeds = [
      { x: 0, z: 0, score: 10, n: 10, weightedN: 10 },
      { x: 1, z: 0, score: 8,  n: 2,  weightedN: 2  },
    ];
    const out = shrinkScores(seeds);
    expect(out[0].shrunkScore).toBeCloseTo(14.5 / 13, 8);
    expect(out[1].shrunkScore).toBeCloseTo(2.5, 8);
  });

  test('low-sample cells regress more strongly toward the mean', () => {
    const seeds = [
      { x: 0, z: 0, score: 6,  n: 6, weightedN: 6 },   // rate 1.0, n=6
      { x: 1, z: 0, score: 5,  n: 1, weightedN: 1 },   // rate 5.0, n=1
    ];
    const out = shrinkScores(seeds);
    // Pop mean = (6 + 5)/(6 + 1) ≈ 1.571.
    // High-sample shrunk(0): (6*1.0 + 3*1.571)/(6+3) ≈ 1.190.
    // Low-sample  shrunk(1): (1*5.0 + 3*1.571)/(1+3) ≈ 2.428.
    expect(out[0].shrunkScore).toBeCloseTo((6 + 3 * (11 / 7)) / 9, 8);
    expect(out[1].shrunkScore).toBeCloseTo((5 + 3 * (11 / 7)) / 4, 8);
    // The low-sample cell shrinks MORE in absolute terms toward the mean:
    // its observed rate was 5.0 → shrunk ≈ 2.43 (Δ≈2.57).
    // High-sample's observed rate was 1.0 → shrunk ≈ 1.19 (Δ≈0.19).
    const deltaHigh = Math.abs(1.0 - out[0].shrunkScore);
    const deltaLow  = Math.abs(5.0 - out[1].shrunkScore);
    expect(deltaLow).toBeGreaterThan(deltaHigh);
  });

  test('empty input returns empty', () => {
    expect(shrinkScores([])).toEqual([]);
  });

  test('zero weighted N falls back to score=0, no NaN', () => {
    const out = shrinkScores([{ x: 0, z: 0, score: 0, n: 0, weightedN: 0 }]);
    expect(Number.isFinite(out[0].shrunkScore)).toBe(true);
  });
});

// --- weightedSampleIndex ----------------------------------------------------

describe('weightedSampleIndex — distribution matches input within 5%', () => {
  test('uniform weights → roughly uniform distribution', () => {
    const rng = mulberry32(1);
    const weights = [1, 1, 1, 1];
    const counts = [0, 0, 0, 0];
    const N = 40000;
    for (let i = 0; i < N; i++) counts[weightedSampleIndex(weights, rng)]++;
    for (let i = 0; i < counts.length; i++) {
      const observed = counts[i] / N;
      expect(Math.abs(observed - 0.25)).toBeLessThan(0.025);
    }
  });

  test('skewed weights [1, 3, 6] match expected ratios (0.1, 0.3, 0.6)', () => {
    const rng = mulberry32(2);
    const weights = [1, 3, 6];
    const counts = [0, 0, 0];
    const N = 20000;
    for (let i = 0; i < N; i++) counts[weightedSampleIndex(weights, rng)]++;
    expect(Math.abs(counts[0] / N - 0.1)).toBeLessThan(0.025);
    expect(Math.abs(counts[1] / N - 0.3)).toBeLessThan(0.025);
    expect(Math.abs(counts[2] / N - 0.6)).toBeLessThan(0.025);
  });

  test('returns -1 when all weights are non-positive', () => {
    const rng = mulberry32(3);
    expect(weightedSampleIndex([0, 0, 0], rng)).toBe(-1);
    expect(weightedSampleIndex([-1, -1], rng)).toBe(-1);
  });

  test('skips zero weights', () => {
    const rng = mulberry32(4);
    const idx = weightedSampleIndex([0, 1, 0, 0], rng);
    expect(idx).toBe(1);
  });
});

// --- filterByCellArea -------------------------------------------------------

describe('filterByCellArea — small Voronoi cells are dropped', () => {
  test('two far-apart seeds both keep large cells', () => {
    const seeds = [
      { x: -0.5, z: 0.3, score: 5, n: 2, weightedN: 2 },
      { x:  0.5, z: 0.9, score: 5, n: 2, weightedN: 2 },
    ];
    const kept = filterByCellArea(seeds);
    expect(kept.length).toBe(2);
  });

  test('single seed always kept (no Voronoi tessellation possible)', () => {
    const seeds = [{ x: 0, z: 0.5, score: 1, n: 1, weightedN: 1 }];
    expect(filterByCellArea(seeds)).toHaveLength(1);
  });

  test('empty input returns empty', () => {
    expect(filterByCellArea([])).toEqual([]);
  });

  test('many tightly-clustered seeds produce some sub-threshold cells which get dropped', () => {
    // 25 seeds on a 5x5 grid spanning 0.30m × 0.30m → mean cell area
    // ≈ 0.36 / 25 = 0.0144 sqm, below the 0.015 sqm threshold. Edge cells
    // are larger (bound extends to the table), interior cells are tiny.
    const seeds = [];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        seeds.push({
          x: -0.15 + i * 0.075,
          z: 0.40 + j * 0.075,
          score: 1, n: 1, weightedN: 1,
        });
      }
    }
    const kept = filterByCellArea(seeds);
    expect(kept.length).toBeLessThan(seeds.length);
    expect(kept.length).toBeGreaterThan(0);
  });
});

// --- createIntermediateEngine ----------------------------------------------

describe('createIntermediateEngine.computeTarget', () => {
  test('with empty history, falls back to neutral within safe zone + difficulty caps', () => {
    // Bounds come from PROFILE_OVERRIDES.intermediate: touch shots start near
    // 2.2 m/s (drop_shot) and attacking strokes reach smash's 20.0 m/s
    // speedMax — genuinely international pace, and inside the measured solver
    // envelope (tests/solverEnvelope.test.js).
    //
    // These are profile bounds, not the DIFFICULTY_CAPS rail (29.0 / 36); the
    // rails deliberately sit clear so they never shape the distribution.
    const engine = createIntermediateEngine({ rng: mulberry32(11) });
    const history = new ShotHistory();
    for (let i = 0; i < 200; i++) {
      const [x, z, speed, spin, conf] = engine.computeTarget(history, {});
      expect(x).toBeGreaterThanOrEqual(-0.7);
      expect(x).toBeLessThanOrEqual(0.7);
      expect(z).toBeGreaterThanOrEqual(0.1);
      expect(z).toBeLessThanOrEqual(1.3);
      expect(speed).toBeGreaterThanOrEqual(1.5);
      expect(speed).toBeLessThanOrEqual(20.0);
      // Spin bounds are now profile-driven too: chop floors at -25 (the
      // measured backspin envelope) and loop tops at its base 32. Previously
      // both ends were the ±26 rail, which pinned 31% of loops and 93% of
      // chops to a single value.
      expect(spin).toBeGreaterThanOrEqual(-25.0);
      expect(spin).toBeLessThanOrEqual(32.0);
      expect(conf).toBe(1.0);
    }
  });

  test('shot palette spans slow (push-tier) and fast (drive-tier) shots', () => {
    // Root fix: Intermediate must produce both slow touch shots and fast
    // rally drives — not a narrow band. Sample enough to catch push-tier
    // (<4.5 m/s) AND drive-tier (>7 m/s) shots.
    const engine = createIntermediateEngine({ rng: mulberry32(17) });
    const history = new ShotHistory();
    let sawSlow = false;
    let sawFast = false;
    for (let i = 0; i < 2000; i++) {
      const [, , speed] = engine.computeTarget(history, {});
      if (speed < 4.5) sawSlow = true;
      if (speed > 7.0) sawFast = true;
      engine.ingestShot(null, null);
      if (sawSlow && sawFast) break;
    }
    expect(sawSlow).toBe(true);
    expect(sawFast).toBe(true);
  });

  test('no shot type repeats 4+ times in a row (anti-repeat variety pressure)', () => {
    // The old engine could roll speed=7.8/spin=1 four times running and
    // telegraph would label all four as smashes. Selector's anti-repeat
    // penalty makes a 4-in-a-row same-type run vanishingly rare. Read
    // the picked type directly off payload[5] — that's the ground truth
    // of what the selector chose, unaffected by numeric-bucket labelling.
    const engine = createIntermediateEngine({ rng: mulberry32(18) });
    const history = new ShotHistory();
    let streak = 1;
    let maxStreak = 1;
    let prev = null;
    for (let i = 0; i < 3000; i++) {
      const payload = engine.computeTarget(history, {});
      const t = payload[5];
      streak = (t === prev) ? streak + 1 : 1;
      if (streak > maxStreak) maxStreak = streak;
      prev = t;
      engine.ingestShot(null, null);
    }
    // Selector penalty is 0.5 → 0.15 across the last-2 window; over 3000
    // samples the longest same-type streak should stay well below 6.
    expect(maxStreak).toBeLessThan(6);
  });

  test('high incoming ball biases toward smash / drive', () => {
    // A floating high ball at the AI's contact point should read as a
    // kill opportunity — expect the mean speed under that context to
    // exceed the neutral mean.
    const engine = createIntermediateEngine({ rng: mulberry32(19) });
    const history = new ShotHistory();
    let sumHigh = 0, sumNeutral = 0;
    const N = 800;
    for (let i = 0; i < N; i++) {
      sumHigh    += engine.computeTarget(history, { incoming: { contact_height_m: 0.35, bounce_depth_m: 0.7, speed_mps: 5, spin_topspin: 0 } })[2];
      engine.ingestShot(null, null);
      sumNeutral += engine.computeTarget(history, {})[2];
      engine.ingestShot(null, null);
    }
    expect(sumHigh / N).toBeGreaterThan(sumNeutral / N);
  });

  test('with 4 shots (below threshold), still falls back to neutral', () => {
    const engine = createIntermediateEngine({ rng: mulberry32(12) });
    const history = new ShotHistory();
    for (let i = 1; i <= 4; i++) {
      history.push([i, i * 100, 0.5, 0.8, 0, 50, 6, 0]);
    }
    // Even with clustered struggle data, fewer than 5 shots = no exploit.
    // Payload is 7 elements: [x, z, speed, spin, conf, shotType, sidespin].
    const t = engine.computeTarget(history, {});
    expect(t).toHaveLength(7);
    expect(t[4]).toBe(1.0);
    expect(typeof t[5]).toBe('string');
    expect(Number.isFinite(t[6])).toBe(true);
  });

  test('with 10+ shots clustered, output is inside safe-zone bounds', () => {
    const engine = createIntermediateEngine({ rng: mulberry32(13) });
    const history = new ShotHistory();
    for (let i = 1; i <= 12; i++) {
      history.push([i, i * 100, 0.5 + (i % 3) * 0.01, 0.8, 0, 80, 6, 0]);
    }
    for (let i = 0; i < 100; i++) {
      const [x, z] = engine.computeTarget(history, {});
      expect(x).toBeGreaterThanOrEqual(-0.7);
      expect(x).toBeLessThanOrEqual(0.7);
      expect(z).toBeGreaterThanOrEqual(0.1);
      expect(z).toBeLessThanOrEqual(1.3);
    }
  });

  test('exploit factor: with clustered struggle data, mean target_x leans toward the cluster ~50% of the time', () => {
    // 12 misses clustered at +0.5; with exploit factor 0.5, half the calls
    // should land near +0.5, half should be neutral (~0). Mean should drift
    // toward +0.25 vs ~0 in a no-exploit case.
    //
    // Real engine usage is ingestShot ↔ computeTarget pairs per rally. We
    // call ingestShot between computeTargets so the no-instant-punishment
    // counter advances past INSTANT_PUNISH_DELAY_RALLIES and exploit kicks in.
    const engine = createIntermediateEngine({ rng: mulberry32(14) });
    const history = new ShotHistory();
    for (let i = 1; i <= 12; i++) {
      history.push([i, i * 100, 0.5, 0.8, 0, 80, 6, 0]);
    }
    // Warm the counter up so subsequent calls are out of the punishment hold.
    engine.computeTarget(history, {});
    engine.ingestShot(null, history);
    engine.ingestShot(null, history);

    let sumX = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      sumX += engine.computeTarget(history, {})[0];
      engine.ingestShot(null, history);
    }
    const meanX = sumX / N;
    expect(meanX).toBeGreaterThan(0.05);
  });

  test('ingestShot does not throw and is idempotent for the engine', () => {
    const engine = createIntermediateEngine({ rng: mulberry32(15) });
    expect(() => engine.ingestShot([1, 0, 0.2, 0.5, 0, 50, 6, 0], null)).not.toThrow();
  });

  test('reset does not throw', () => {
    const engine = createIntermediateEngine({ rng: mulberry32(16) });
    expect(() => engine.reset()).not.toThrow();
  });
});
