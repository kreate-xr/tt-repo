// Unit tests for deliberate-imperfection helpers + the no-instant-punishment
// counter on Intermediate/Pro. Spec §imperfection_design +
// §deliberate_imperfection_rules.

const THREE = require('three');

import {
  MISS_RATE_BY_DIFFICULTY,
  MISS_CAUSE_DISTRIBUTION,
  MISS_CAUSES,
  WASTED_STEP_PROBABILITY,
  WASTED_STEP_MIN_TIME_TO_CONTACT_MS,
  WASTED_STEP_DURATION_MS,
  INSTANT_PUNISH_DELAY_RALLIES,
  shouldInjectMiss,
  sampleMissCause,
  shouldWasteHalfStep,
  wastedStepOffsetVec,
  applyMissToIntent,
  scaleMissRateForSituation,
  SITUATION_MIN_MULT,
  SITUATION_MAX_MULT,
} from '../js/modes/aiMatch/imperfection.js';
import { createIntermediateEngine } from '../js/ai/engines/intermediate.js';
import { createProEngine } from '../js/ai/engines/pro.js';
import { ShotHistory } from '../js/ai/shotHistory.js';
import { SHOT_TYPES } from '../js/modes/aiMatch/telegraph.js';

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

// --- Constants pinned by spec ----------------------------------------------

describe('Imperfection constants match spec', () => {
  test('base miss rates: 0.12 / 0.05 / 0.03 (long-rally retune)', () => {
    // Original spec values (0.15/0.08/0.03) were too clean; first bump
    // (0.22/0.12/0.06) combined with the shaken multiplier cascaded into
    // visible shanks on routine returns. Settled at 0.18/0.10/0.04 with a
    // milder shaken multiplier (1.15) and honest misses no longer
    // triggering shaken. See imperfection.js for full rationale.
    //
    // Upper tiers then dropped for the international re-tune (per-stroke
    // error at that level is ~3-6%, not 10%), and beginner dropped
    // 0.18 → 0.12 for the long-rally retune — CLUB is the practice-partner
    // tier and its job is to keep the ball alive. These are BASE rates;
    // scaleMissRateForSituation is what makes them read as a real player.
    expect(MISS_RATE_BY_DIFFICULTY.beginner).toBeCloseTo(0.12, 10);
    // Intermediate 0.05 → 0.04 in the 2026-08-28 playability retune: pace
    // came down, consistency went up — see imperfection.js.
    expect(MISS_RATE_BY_DIFFICULTY.intermediate).toBeCloseTo(0.04, 10);
    expect(MISS_RATE_BY_DIFFICULTY.pro).toBeCloseTo(0.03, 10);
  });

  test('miss cause distribution sums to 1.0', () => {
    const sum = Object.values(MISS_CAUSE_DISTRIBUTION).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  test('miss cause distribution matches spec (40/30/20/10)', () => {
    expect(MISS_CAUSE_DISTRIBUTION.stretched_too_far).toBeCloseTo(0.40, 5);
    expect(MISS_CAUSE_DISTRIBUTION.mistimed_swing).toBeCloseTo(0.30, 5);
    expect(MISS_CAUSE_DISTRIBUTION.spin_misread).toBeCloseTo(0.20, 5);
    expect(MISS_CAUSE_DISTRIBUTION.general_inaccuracy).toBeCloseTo(0.10, 5);
  });

  test('wasted step constants match spec (30%, >500ms gating)', () => {
    expect(WASTED_STEP_PROBABILITY).toBeCloseTo(0.30, 10);
    expect(WASTED_STEP_MIN_TIME_TO_CONTACT_MS).toBe(500);
    expect(WASTED_STEP_DURATION_MS).toBeGreaterThan(0);
  });

  test('instant-punishment delay is 1-2 rallies per spec', () => {
    expect(INSTANT_PUNISH_DELAY_RALLIES).toBeGreaterThanOrEqual(1);
    expect(INSTANT_PUNISH_DELAY_RALLIES).toBeLessThanOrEqual(2);
  });
});

// --- shouldInjectMiss ------------------------------------------------------

describe('shouldInjectMiss', () => {
  test('returns true at expected rate over 20k samples', () => {
    const rng = mulberry32(101);
    let hits = 0;
    const N = 20000;
    const rate = 0.08;
    for (let i = 0; i < N; i++) {
      if (shouldInjectMiss(rate, rng)) hits++;
    }
    // 5% tolerance band on the empirical rate.
    expect(Math.abs(hits / N - rate)).toBeLessThan(0.01);
  });

  test('0 rate never injects', () => {
    const rng = mulberry32(102);
    for (let i = 0; i < 500; i++) {
      expect(shouldInjectMiss(0, rng)).toBe(false);
    }
  });

  test('1.0 rate always injects', () => {
    const rng = mulberry32(103);
    for (let i = 0; i < 500; i++) {
      expect(shouldInjectMiss(1.0, rng)).toBe(true);
    }
  });
});

// --- sampleMissCause distribution -----------------------------------------

describe('sampleMissCause matches spec distribution within 5%', () => {
  test('frequencies match 40/30/20/10 over 40k samples', () => {
    const rng = mulberry32(201);
    const counts = {
      stretched_too_far: 0, mistimed_swing: 0,
      spin_misread: 0, general_inaccuracy: 0,
    };
    const N = 40000;
    for (let i = 0; i < N; i++) counts[sampleMissCause(rng)]++;
    expect(Math.abs(counts.stretched_too_far  / N - 0.40)).toBeLessThan(0.025);
    expect(Math.abs(counts.mistimed_swing     / N - 0.30)).toBeLessThan(0.025);
    expect(Math.abs(counts.spin_misread       / N - 0.20)).toBeLessThan(0.025);
    expect(Math.abs(counts.general_inaccuracy / N - 0.10)).toBeLessThan(0.025);
  });

  test('always returns a known cause', () => {
    const rng = mulberry32(202);
    const known = new Set(Object.values(MISS_CAUSES));
    for (let i = 0; i < 1000; i++) {
      expect(known.has(sampleMissCause(rng))).toBe(true);
    }
  });
});

// --- scaleMissRateForSituation ---------------------------------------------

// A flat miss rate is what makes the AI read as a machine: it shanks balls it
// was perfectly positioned for and nails balls it had no business reaching.
// These tests pin that error probability tracks the actual difficulty of the
// shot, which is the whole point of the mechanism.
describe('scaleMissRateForSituation', () => {
  const BASE = 0.05;

  test('no situational info leaves the base rate untouched', () => {
    // Callers without the data must degrade to old behaviour, not to a
    // silently biased one.
    expect(scaleMissRateForSituation(BASE, {})).toBeCloseTo(BASE, 10);
    expect(scaleMissRateForSituation(BASE)).toBeCloseTo(BASE, 10);
  });

  test('miss rate rises monotonically with reach factor', () => {
    const rates = [0, 0.25, 0.5, 0.75, 1.0].map(
      reachFactor => scaleMissRateForSituation(BASE, { reachFactor }),
    );
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
    }
    // A full-stretch ball must be materially worse than a comfortable one.
    expect(rates[rates.length - 1]).toBeGreaterThan(rates[0] * 2);
  });

  test('a comfortable ball is safer than baseline but never certain', () => {
    const easy = scaleMissRateForSituation(BASE, { reachFactor: 0 });
    expect(easy).toBeLessThan(BASE);
    expect(easy).toBeGreaterThan(0); // even elite players shank easy balls
  });

  test('being rushed increases the miss rate', () => {
    const calm    = scaleMissRateForSituation(BASE, { timeToContactMs: 800 });
    const rushed  = scaleMissRateForSituation(BASE, { timeToContactMs: 80 });
    expect(rushed).toBeGreaterThan(calm);
  });

  test('heavy incoming spin increases the miss rate, sign-independent', () => {
    const flat  = scaleMissRateForSituation(BASE, { incomingSpinRps: 0 });
    const spinny = scaleMissRateForSituation(BASE, { incomingSpinRps: 30 });
    const backspin = scaleMissRateForSituation(BASE, { incomingSpinRps: -30 });
    expect(spinny).toBeGreaterThan(flat);
    expect(backspin).toBeCloseTo(spinny, 10);
  });

  // THE guard for the defect that hid here. The three situational terms are
  // MULTIPLIED, so any term that can reach zero or below silently cancels the
  // others. The reach term used to be `1 + clamp(t,-1,1.4)*1.5` centred on
  // 0.5, which went negative below reachFactor 1/3 — so for any
  // well-positioned shot (the common case) rush and spin were discarded
  // entirely and a 60ms 40-rps ball scored identically to a slow flat one.
  test('rush and spin still bite at EVERY reach factor', () => {
    for (const reachFactor of [0, 0.1, 0.2, 0.33, 0.5, 0.75, 1.0, 1.2]) {
      const easy = scaleMissRateForSituation(BASE, {
        reachFactor, timeToContactMs: 900, incomingSpinRps: 0,
      });
      const hard = scaleMissRateForSituation(BASE, {
        reachFactor, timeToContactMs: 60, incomingSpinRps: 40,
      });
      // A rushed, heavily-spun ball must ALWAYS be meaningfully worse than a
      // slow flat one, however well positioned the AI is.
      expect(hard / easy).toBeGreaterThan(1.5);
    }
  });

  test('the reach term is strictly positive across its whole domain', () => {
    // Isolate it: no rush, no spin. Any non-positive value here would cancel
    // the other terms once they are multiplied in.
    for (let rf = 0; rf <= 2; rf += 0.05) {
      expect(scaleMissRateForSituation(BASE, { reachFactor: rf })).toBeGreaterThan(0);
    }
  });

  test('the reach term is monotonic — never easier to be more stretched', () => {
    let prev = -Infinity;
    for (let rf = 0; rf <= 1.5; rf += 0.05) {
      const v = scaleMissRateForSituation(BASE, { reachFactor: rf });
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  test('the multiplier stays inside its declared bounds', () => {
    // Worst case on every axis at once must not run away — genuinely
    // impossible balls are already handled by the reachability gate.
    const worst = scaleMissRateForSituation(BASE, {
      reachFactor: 5, timeToContactMs: 0, incomingSpinRps: 200,
    });
    expect(worst).toBeLessThanOrEqual(BASE * SITUATION_MAX_MULT + 1e-9);
    const best = scaleMissRateForSituation(BASE, {
      reachFactor: 0, timeToContactMs: 5000, incomingSpinRps: 0,
    });
    expect(best).toBeGreaterThanOrEqual(BASE * SITUATION_MIN_MULT - 1e-9);
  });

  test('never returns a probability outside [0, 1]', () => {
    expect(scaleMissRateForSituation(0.9, { reachFactor: 5, timeToContactMs: 0 }))
      .toBeLessThanOrEqual(1);
    expect(scaleMissRateForSituation(0, { reachFactor: 5 })).toBe(0);
  });
});

describe('sampleMissCause — cause plausibility', () => {
  test('a comfortably-positioned AI never blames being stretched', () => {
    // Picking "stretched too far" while standing at the ball is the tell that
    // the miss was scripted rather than earned.
    const rng = mulberry32(701);
    for (let i = 0; i < 2000; i++) {
      const cause = sampleMissCause(rng, { reachFactor: 0.1 });
      expect(cause).not.toBe(MISS_CAUSES.STRETCHED_TOO_FAR);
    }
  });

  test('a stretched AI can blame being stretched', () => {
    const rng = mulberry32(702);
    let seen = false;
    for (let i = 0; i < 2000; i++) {
      if (sampleMissCause(rng, { reachFactor: 0.95 }) === MISS_CAUSES.STRETCHED_TOO_FAR) {
        seen = true;
        break;
      }
    }
    expect(seen).toBe(true);
  });

  test('remaining causes stay well-formed when stretched is excluded', () => {
    const rng = mulberry32(703);
    const known = new Set(Object.values(MISS_CAUSES));
    const counts = new Map();
    const N = 6000;
    for (let i = 0; i < N; i++) {
      const c = sampleMissCause(rng, { reachFactor: 0 });
      expect(known.has(c)).toBe(true);
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    // The other three causes re-normalise over the freed probability, so all
    // three must still appear rather than one absorbing everything.
    expect(counts.get(MISS_CAUSES.MISTIMED_SWING)).toBeGreaterThan(0);
    expect(counts.get(MISS_CAUSES.SPIN_MISREAD)).toBeGreaterThan(0);
    expect(counts.get(MISS_CAUSES.GENERAL_INACCURACY)).toBeGreaterThan(0);
    // Ratios should hold their 30:20:10 shape.
    const mistimed = counts.get(MISS_CAUSES.MISTIMED_SWING) / N;
    const spin = counts.get(MISS_CAUSES.SPIN_MISREAD) / N;
    expect(mistimed / spin).toBeGreaterThan(1.2);
    expect(mistimed / spin).toBeLessThan(1.8);
  });

  test('without reach info the original distribution is preserved', () => {
    const rng = mulberry32(704);
    let stretched = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      if (sampleMissCause(rng) === MISS_CAUSES.STRETCHED_TOO_FAR) stretched++;
    }
    expect(Math.abs(stretched / N - 0.40)).toBeLessThan(0.03);
  });
});

// --- shouldWasteHalfStep ---------------------------------------------------

describe('shouldWasteHalfStep gating', () => {
  test('never fires when time_to_contact < 500ms', () => {
    const rng = mulberry32(301);
    for (let t = 0; t < 500; t += 10) {
      for (let trial = 0; trial < 50; trial++) {
        expect(shouldWasteHalfStep(t, rng)).toBe(false);
      }
    }
  });

  test('fires at ~30% rate when time_to_contact >= 500ms', () => {
    const rng = mulberry32(302);
    let hits = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      if (shouldWasteHalfStep(800, rng)) hits++;
    }
    expect(Math.abs(hits / N - 0.30)).toBeLessThan(0.015);
  });
});

// --- wastedStepOffsetVec ---------------------------------------------------

describe('wastedStepOffsetVec', () => {
  test('produces a horizontal offset (y = 0) with magnitude in [0.05, 0.15]', () => {
    const rng = mulberry32(401);
    const out = new THREE.Vector3();
    for (let i = 0; i < 1000; i++) {
      wastedStepOffsetVec(rng, out);
      expect(out.y).toBe(0);
      const m = Math.hypot(out.x, out.z);
      expect(m).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(m).toBeLessThanOrEqual(0.15 + 1e-9);
    }
  });
});

// --- applyMissToIntent -----------------------------------------------------

function makeIntent({ spinRps = 0 } = {}) {
  return {
    predictedContact: new THREE.Vector3(0, 1, -1),
    predictedContactPerfMs: 1000,
    shotType: SHOT_TYPES.TOPSPIN_DRIVE,
    // Solver outputs the FSM has already populated by the time a miss is
    // injected (aiFSM sets these before rolling the miss dice).
    solverFaceNormal: new THREE.Vector3(0, 0, 1),
    predictedContactBallSpin: new THREE.Vector3(spinRps * 2 * Math.PI, 0, 0),
    willMiss: false,
    missCause: null,
  };
}

describe('applyMissToIntent — cause-specific mutations', () => {
  test('STRETCHED_TOO_FAR offsets predictedContact horizontally (no Y change)', () => {
    const rng = mulberry32(501);
    const intent = makeIntent();
    const beforeY = intent.predictedContact.y;
    const beforeTime = intent.predictedContactPerfMs;
    applyMissToIntent(intent, MISS_CAUSES.STRETCHED_TOO_FAR, rng);
    expect(intent.willMiss).toBe(true);
    expect(intent.missCause).toBe(MISS_CAUSES.STRETCHED_TOO_FAR);
    expect(intent.predictedContact.y).toBeCloseTo(beforeY, 10);
    expect(intent.predictedContactPerfMs).toBe(beforeTime);
    const offsetMag = Math.hypot(
      intent.predictedContact.x - 0,
      intent.predictedContact.z - (-1),
    );
    // Spec-aligned 8-15cm window for stretched.
    expect(offsetMag).toBeGreaterThanOrEqual(0.08);
    expect(offsetMag).toBeLessThanOrEqual(0.15);
  });

  test('MISTIMED_SWING shifts predictedContactPerfMs by 50-100ms (signed)', () => {
    const rng = mulberry32(502);
    const intent = makeIntent();
    const before = intent.predictedContactPerfMs;
    const beforeContact = intent.predictedContact.clone();
    applyMissToIntent(intent, MISS_CAUSES.MISTIMED_SWING, rng);
    expect(intent.predictedContact.equals(beforeContact)).toBe(true);
    const delta = Math.abs(intent.predictedContactPerfMs - before);
    expect(delta).toBeGreaterThanOrEqual(50);
    expect(delta).toBeLessThanOrEqual(100);
  });

  // A spin misread is the SAME stroke played with the bat too open or too
  // closed. It used to swap shotType for a uniformly random other type, which
  // could turn a push into a smash — a different shot, not a misjudged one.
  test('SPIN_MISREAD keeps the stroke and tilts the face instead', () => {
    const rng = mulberry32(503);
    const intent = makeIntent({ spinRps: 20 });
    const beforeType = intent.shotType;
    const beforeNormal = intent.solverFaceNormal.clone();

    applyMissToIntent(intent, MISS_CAUSES.SPIN_MISREAD, rng);

    expect(intent.shotType).toBe(beforeType);
    expect(intent.solverFaceNormal.equals(beforeNormal)).toBe(false);
    expect(intent.solverFaceNormal.length()).toBeCloseTo(1, 6);
  });

  test('SPIN_MISREAD tilt stays within the intended few-degree band', () => {
    const rng = mulberry32(504);
    for (let i = 0; i < 500; i++) {
      const intent = makeIntent({ spinRps: 40 }); // saturates the scale
      const before = intent.solverFaceNormal.clone();
      applyMissToIntent(intent, MISS_CAUSES.SPIN_MISREAD, rng);
      const angle = before.angleTo(intent.solverFaceNormal);
      expect(angle).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(angle).toBeLessThanOrEqual(0.16 + 1e-9);
    }
  });

  test('SPIN_MISREAD scales with how much spin there was to misjudge', () => {
    // A near-dead ball is misread by less than a heavy loop.
    const mean = (spinRps) => {
      const rng = mulberry32(505);
      let total = 0;
      const N = 400;
      for (let i = 0; i < N; i++) {
        const intent = makeIntent({ spinRps });
        const before = intent.solverFaceNormal.clone();
        applyMissToIntent(intent, MISS_CAUSES.SPIN_MISREAD, rng);
        total += before.angleTo(intent.solverFaceNormal);
      }
      return total / N;
    };
    expect(mean(30)).toBeGreaterThan(mean(0));
  });

  test('SPIN_MISREAD is inert when the solver normal is absent', () => {
    // Serve path / early frames can inject a miss before the solver ran.
    const rng = mulberry32(506);
    const intent = makeIntent();
    delete intent.solverFaceNormal;
    expect(() => applyMissToIntent(intent, MISS_CAUSES.SPIN_MISREAD, rng)).not.toThrow();
    expect(intent.willMiss).toBe(true);
  });

  test('GENERAL_INACCURACY applies a smaller (3-7cm) horizontal offset', () => {
    const rng = mulberry32(504);
    const intent = makeIntent();
    applyMissToIntent(intent, MISS_CAUSES.GENERAL_INACCURACY, rng);
    const offsetMag = Math.hypot(
      intent.predictedContact.x,
      intent.predictedContact.z - (-1),
    );
    expect(offsetMag).toBeGreaterThanOrEqual(0.03);
    expect(offsetMag).toBeLessThanOrEqual(0.07);
  });
});

// --- No-instant-punishment in engines --------------------------------------

describe('Intermediate engine — no-instant-punishment counter', () => {
  // Build a history where the SAME zone has accumulated heavy misses, so
  // the top struggle cell is well-defined and stable.
  function buildClusteredHistory() {
    const h = new ShotHistory();
    for (let i = 1; i <= 12; i++) {
      h.push([i, i * 100, 0.5, 0.8, 0, 80, 6, 0]);
    }
    return h;
  }

  test('first call after a new cluster lands holds fire (counter < delay)', () => {
    const history = buildClusteredHistory();

    // Run a single computeTarget — counter resets to 0, exploit is held.
    // Sample many times and confirm the mean x is roughly 0 (neutral) NOT
    // around 0.5 (cluster), proving the counter is suppressing exploit.
    let sumX = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const r = createIntermediateEngine({ rng: mulberry32(700 + i) });
      // First call (counter from constructor = DELAY → punishmentHeld is
      // false on the FIRST call but then top-cell change at i=0 resets to
      // 0 immediately). So the first computeTarget call may exploit OR not
      // depending on RNG. Verify the SECOND call (after ingest + new shot)
      // is held when top cell stays the same.
      r.computeTarget(history, {}); // call 1: top cell first observed → reset
      r.ingestShot(null, history);  // counter = 1, still < delay 2
      sumX += r.computeTarget(history, {})[0];
    }
    // counter = 1 < 2 → exploit suppressed → neutral pick centered ~0.
    expect(Math.abs(sumX / N)).toBeLessThan(0.10);
  });

  test('after enough ingests, exploit resumes (mean drifts toward cluster)', () => {
    let sumX = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const r = createIntermediateEngine({ rng: mulberry32(800 + i) });
      const history = buildClusteredHistory();
      r.computeTarget(history, {});  // call 1: detect new cluster, reset counter
      r.ingestShot(null, history);   // 1
      r.ingestShot(null, history);   // 2 ≥ delay → released
      sumX += r.computeTarget(history, {})[0];
    }
    // Exploit released; with factor 0.5, ~half the picks land near cluster.
    // Mean should be visibly above 0.
    expect(sumX / N).toBeGreaterThan(0.05);
  });
});

describe('Pro engine — no-instant-punishment counter', () => {
  test('respects the same delay as Intermediate', () => {
    const history = new ShotHistory();
    for (let i = 1; i <= 12; i++) {
      history.push([i, i * 100, 0.5, 0.8, 0, 80, 9, 0]);
    }
    let mean = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const e = createProEngine({ rng: mulberry32(1000 + i) });
      e.computeTarget(history, {});  // reset counter on observed top cell
      e.ingestShot(null, history);   // 1
      mean += e.computeTarget(history, {})[0]; // still held — neutral mean ≈ 0
    }
    expect(Math.abs(mean / N)).toBeLessThan(0.15);
  });
});

describe('crossover ("elbow") body-jam term', () => {
  const {
    scaleMissRateForSituation: scale, BODY_JAM_BAND_M, BODY_JAM_MAX_MULT,
  } = require('../js/modes/aiMatch/imperfection.js');
  const BASE = 0.05;
  // Comfortable reach so the jam term is the only variable.
  const ctx = (jam) => ({ reachFactor: 0.4, bodyJamOffsetM: jam });

  test('a ball straight at the body line is harder than one at comfortable reach', () => {
    const atBody = scale(BASE, ctx(0));
    const offBody = scale(BASE, ctx(BODY_JAM_BAND_M));
    expect(atBody).toBeGreaterThan(offBody);
    expect(atBody / offBody).toBeCloseTo(BODY_JAM_MAX_MULT, 5);
  });

  test('the jam fades linearly and is direction-symmetric', () => {
    const half = scale(BASE, ctx(BODY_JAM_BAND_M / 2));
    const halfNeg = scale(BASE, ctx(-BODY_JAM_BAND_M / 2));
    expect(half).toBeCloseTo(halfNeg, 10);
    const edge = scale(BASE, ctx(BODY_JAM_BAND_M));
    const beyond = scale(BASE, ctx(BODY_JAM_BAND_M * 3));
    expect(edge).toBeCloseTo(beyond, 10); // no effect outside the band
  });

  test('absent field degrades to the old behaviour', () => {
    expect(scale(BASE, { reachFactor: 0.4 }))
      .toBeCloseTo(scale(BASE, ctx(BODY_JAM_BAND_M * 5)), 10);
  });
});
