// Unit tests for the Pro engine + disguised-serve telegraph hook.
// Spec §ai_worker_design.engines.pro.

import { createProEngine } from '../js/ai/engines/pro.js';
import { ShotHistory } from '../js/ai/shotHistory.js';
import {
  disguisedShotTypeFor,
  shotTypeFromTarget,
  SHOT_TYPES,
} from '../js/modes/aiMatch/telegraph.js';

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

// --- Pro engine: ball-parameter ranges -------------------------------------

describe('Pro engine ball ranges', () => {
  // Bounds come from PROFILE_OVERRIDES.pro, which sits above the international
  // tier: drop_shot floors at 2.5 m/s and smash tops out at 22.4 — inside the
  // measured solver envelope (tests/solverEnvelope.test.js). Not the
  // DIFFICULTY_CAPS rail (24.0), which stays clear so it never shapes the
  // distribution.
  test('target_speed inside pro profile range [1.5, 22.4] m/s over 10k samples', () => {
    const engine = createProEngine({ rng: mulberry32(31) });
    const history = new ShotHistory();
    for (let i = 0; i < 10000; i++) {
      const [, , speed] = engine.computeTarget(history, {});
      expect(speed).toBeGreaterThanOrEqual(1.5);
      expect(speed).toBeLessThanOrEqual(22.4);
    }
  });

  test('target_spin inside pro cap [-40, 40] rps over 10k samples', () => {
    // Widened from ±32 to ±40 so Pro's CHOP shots (heavy defensive
    // backspin, spec range -22 to -40 rps) don't get clamped and lose
    // their identity. Cap set in DIFFICULTY_CAPS.pro in shotTypeSelector.js.
    const engine = createProEngine({ rng: mulberry32(32) });
    const history = new ShotHistory();
    for (let i = 0; i < 10000; i++) {
      const [, , , spin] = engine.computeTarget(history, {});
      expect(spin).toBeGreaterThanOrEqual(-40.0);
      expect(spin).toBeLessThanOrEqual(40.0);
    }
  });

  test('Pro palette spans push-tier slow shots AND smash-tier fast shots', () => {
    // The whole point of the fix: Pro must vary pace, not just pick a
    // wider high band. Sample enough to catch both a slow touch shot
    // (<5 m/s → push/block) and a kill shot (>10 m/s → smash).
    const engine = createProEngine({ rng: mulberry32(33) });
    const history = new ShotHistory();
    let sawSlow = false;
    let sawFast = false;
    for (let i = 0; i < 3000; i++) {
      const [, , speed] = engine.computeTarget(history, {});
      if (speed < 5.0) sawSlow = true;
      if (speed > 10.0) sawFast = true;
      engine.ingestShot(null, null);
      if (sawSlow && sawFast) break;
    }
    expect(sawSlow).toBe(true);
    expect(sawFast).toBe(true);
  });

  test('Pro tempo mixing: after two fast shots, next shots skew slower', () => {
    // Encoded rule in shotTypeSelector.applyProTempoMixing — after two
    // consecutive fast shots (drive/smash) the selector biases toward
    // push/slice. Verify by forcing a fast/fast run via high-ball
    // context, then comparing the follow-up mean speed to a fresh
    // neutral baseline.
    const engineForced = createProEngine({ rng: mulberry32(34) });
    const historyForced = new ShotHistory();
    // Two forced-fast picks via strong high-ball context.
    const HIGH = { incoming: { contact_height_m: 0.4, bounce_depth_m: 1.0, speed_mps: 5, spin_topspin: 0 } };
    engineForced.computeTarget(historyForced, HIGH); engineForced.ingestShot(null, null);
    engineForced.computeTarget(historyForced, HIGH); engineForced.ingestShot(null, null);
    // Now sample the next shot under NEUTRAL context — tempo mixing
    // should pull it slower on average.
    let sumAfter = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      // Rebuild a fresh forced run each iteration so the mixing pressure
      // acts on shot #3 every time.
      const eng = createProEngine({ rng: mulberry32(50 + i) });
      const hh = new ShotHistory();
      eng.computeTarget(hh, HIGH); eng.ingestShot(null, null);
      eng.computeTarget(hh, HIGH); eng.ingestShot(null, null);
      sumAfter += eng.computeTarget(hh, {})[2];
    }
    let sumBaseline = 0;
    for (let i = 0; i < N; i++) {
      const eng = createProEngine({ rng: mulberry32(9000 + i) });
      const hh = new ShotHistory();
      sumBaseline += eng.computeTarget(hh, {})[2];
    }
    expect(sumAfter / N).toBeLessThan(sumBaseline / N);
  });

  test('confidence always exactly 1.0', () => {
    const engine = createProEngine({ rng: mulberry32(33) });
    const history = new ShotHistory();
    for (let i = 0; i < 50; i++) {
      expect(engine.computeTarget(history, {})[4]).toBe(1.0);
    }
  });

  test('target x/z stay inside spec safe zone', () => {
    const engine = createProEngine({ rng: mulberry32(34) });
    const history = new ShotHistory();
    for (let i = 0; i < 2000; i++) {
      const [x, z] = engine.computeTarget(history, {});
      expect(x).toBeGreaterThanOrEqual(-0.7);
      expect(x).toBeLessThanOrEqual(0.7);
      expect(z).toBeGreaterThanOrEqual(0.1);
      expect(z).toBeLessThanOrEqual(1.3);
    }
  });
});

// --- Pro vs Intermediate: exploit factor difference ------------------------

// This describe block used to assert Pro's mean target_x drifted toward a
// clustered struggle zone MORE than Intermediate's, on the strength of a
// 0.85-vs-0.5 exploit gap.
//
// It was removed when Intermediate took over 0.85 and the two tiers briefly
// became indistinguishable on this metric (means 0.203 vs 0.215, sign flipping
// with the seed) — asserting an ordering then would have been pinning noise.
//
// The ordering is real again: Pro now runs exploit 0.95 / tactical 0.42
// against Intermediate's 0.85 / 0.50, so its personalised-punishment share is
// 0.55 vs 0.43. That ordering is asserted properly in
// tests/placementIntelligence.test.js ("pro exploits harder than
// intermediate") and tests/shotProfiles.test.js ("tier ladder — targeting
// intent"), which model the branch shares directly rather than inferring them
// from a noisy mean.
//
// What is still worth asserting HERE is simply that the exploit mechanism
// engages at all.
describe('Pro exploits a clustered struggle zone', () => {
  test('mean target_x leans toward the zone the player keeps failing in', async () => {
    // Both engines need ingestShot calls between computeTargets so the
    // no-instant-punishment counter advances and exploit kicks in.
    const { createIntermediateEngine } = await import('../js/ai/engines/intermediate.js');

    function buildHistory() {
      const h = new ShotHistory();
      for (let i = 1; i <= 12; i++) {
        h.push([i, i * 100, 0.5, 0.8, 0, 80, 6, 0]);
      }
      return h;
    }

    const pro = createProEngine({ rng: mulberry32(40) });
    const inter = createIntermediateEngine({ rng: mulberry32(41) });
    // Warm both counters past the instant-punishment delay.
    pro.computeTarget(buildHistory(), {});
    pro.ingestShot(null, null); pro.ingestShot(null, null);
    inter.computeTarget(buildHistory(), {});
    inter.ingestShot(null, null); inter.ingestShot(null, null);

    const N = 2000;
    let sumPro = 0, sumInter = 0;
    for (let i = 0; i < N; i++) {
      sumPro += pro.computeTarget(buildHistory(), {})[0];
      pro.ingestShot(null, null);
      sumInter += inter.computeTarget(buildHistory(), {})[0];
      inter.ingestShot(null, null);
    }
    // Struggle cluster sits at x = +0.5; a non-exploiting engine would
    // average ~0 . Both tiers must drift toward it.
    expect(sumPro / N).toBeGreaterThan(0.15);
    expect(sumInter / N).toBeGreaterThan(0.15);
  });

  test('ingestShot and reset are no-ops (stateless engine)', () => {
    const engine = createProEngine({ rng: mulberry32(42) });
    expect(() => engine.ingestShot([1, 0, 0.5, 0.8, 0, 50, 9, 0], null)).not.toThrow();
    expect(() => engine.reset()).not.toThrow();
  });
});

// --- Disguised-serve hook --------------------------------------------------

describe('disguisedShotTypeFor (Pro telegraph hook)', () => {
  test('flips the spin sign before lookup', () => {
    // Positive spin → real type uses spin > 0 path; disguised flips to negative
    // → SLICE. Real type for medium_speed_high_topspin = topspin_drive.
    const real = shotTypeFromTarget(6, 25);
    const disguised = disguisedShotTypeFor(6, 25);
    expect(real).toBe(SHOT_TYPES.TOPSPIN_DRIVE);
    expect(disguised).toBe(SHOT_TYPES.SLICE);
  });

  test('a real slice (negative spin) gets disguised as the matching topspin variant', () => {
    // Real = slice (negative spin). Disguised = lookup at positive spin
    // = the corresponding row in the table. For (8, -25) the real is SLICE;
    // the disguise at (8, +25) is LOOP (high_speed_high_topspin).
    const real = shotTypeFromTarget(8, -25);
    const disguised = disguisedShotTypeFor(8, -25);
    expect(real).toBe(SHOT_TYPES.SLICE);
    expect(disguised).toBe(SHOT_TYPES.LOOP);
  });

  test('zero spin returns null (no signed disguise possible)', () => {
    expect(disguisedShotTypeFor(8, 0)).toBeNull();
  });

  test('disguised and real are always different shot types when spin ≠ 0', () => {
    // Sample a grid of (speed, spin) combos and check disguise ≠ real
    // whenever spin has a sign.
    const speeds = [3, 5, 7, 9, 11];
    const spins  = [-20, -5, 5, 20];
    for (const s of speeds) {
      for (const sp of spins) {
        const real = shotTypeFromTarget(s, sp);
        const disguised = disguisedShotTypeFor(s, sp);
        expect(disguised).not.toBe(real);
      }
    }
  });
});
