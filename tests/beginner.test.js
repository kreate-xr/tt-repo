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
//   spin    ∈ [-45, 36]       (PROFILE_OVERRIDES.beginner spin bounds — NOT
//                              the ±50 rail, which deliberately sits clear.
//                              Beginner's widest live types are loop +36
//                              and slice -30, physical rps)
//   payload length = 7        (shot type in slot [5], sidespin rps in [6],
//                              same as Int/Pro)
//
// Plus the exploit-lite pass (CLUB learns, slowly): tactical probability
// 0.10, struggle-heatmap exploit at factor 0.20 with min-shots 7 and a
// 4-rally punish delay. The "Beginner does not learn" era is over; the
// tests below pin how LITTLE it learns as much as that it learns at all.
//
// Statistical tests use a seeded RNG so they're deterministic on every run.

import { createBeginnerEngine } from '../js/ai/engines/beginner.js';
import { createIntermediateEngine } from '../js/ai/engines/intermediate.js';
import { ShotHistory } from '../js/ai/shotHistory.js';

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
  test('computeTarget returns the 7-element wire payload', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(1) });
    const t = engine.computeTarget(null, {});
    expect(Array.isArray(t)).toBe(true);
    expect(t.length).toBe(7);
  });

  test('confidence is always 1.0', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(2) });
    for (let i = 0; i < 100; i++) {
      const t = engine.computeTarget(null, {});
      expect(t[4]).toBe(1.0);
    }
  });

  // Beginner has TWO placement boxes: ordinary shots land in a narrow box
  // around the middle (±0.55, z 0.30-1.10), and the 10% tactical pick may
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
    // Still centred — CLUB places some balls, but with no side preference.
    expect(Math.abs(sumX / N)).toBeLessThan(0.03);
    // Wide shots exist but stay a minority (tactical probability is 0.10,
    // and only some zones sit outside the ordinary box).
    expect(wide).toBeGreaterThan(0);
    expect(wide / N).toBeLessThan(0.10);
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
    expect(outsideOrdinary / N).toBeLessThan(0.10);
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

  test('target_spin respects Beginner profile range [-45, 36] rps over 10k samples', () => {
    // Bounds come from PROFILE_OVERRIDES.beginner, not from the rail. Before
    // those spin overrides existed, DIFFICULTY_CAPS.maxSpin did the shaping
    // and 100% of beginner loops emitted EXACTLY the rail value — the
    // collapse defect, still live on the spin axis after it had been fixed
    // on the speed axis. Values are physical rps.
    const engine = createBeginnerEngine({ rng: mulberry32(6) });
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const [, , , spin] = engine.computeTarget(null, {});
      expect(spin).toBeGreaterThanOrEqual(-45.0);
      expect(spin).toBeLessThanOrEqual(36.0);
    }
  });

  test('ingestShot and reset tolerate null arguments', () => {
    // placementIntelligence's harness calls ingestShot(null, null) — the
    // punish-delay counter must advance without reading either argument.
    const engine = createBeginnerEngine({ rng: mulberry32(7) });
    engine.ingestShot(null, null);
    engine.ingestShot([1, 0, 0.2, 0.5, 1, 30, 5, 0], null);
    expect(() => engine.reset()).not.toThrow();
    const t = engine.computeTarget(null, {});
    expect(t.length).toBe(7);
  });

  // --- Exploit-lite (CLUB learns, slowly) -----------------------------------

  // 12 failed returns all landing at the same spot on the player's half —
  // the same fixture placementIntelligence uses for the smart tiers.
  // Wire schema: [shot_id, timestamp_ms, landing_x, landing_z, success,
  // swing_lateness_ms, speed, spin].
  function historyOfFailuresAt(x, count = 12) {
    const h = new ShotHistory();
    for (let i = 1; i <= count; i++) h.push([i, i * 100, x, 0.9, 0, 90, 6, 0]);
    return h;
  }

  // Mean target x over N rallies, advancing the punish-delay counter each
  // rally the way the worker does (shot → ingestShot → computeTarget).
  function meanXOver(engine, h, N) {
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const [x] = engine.computeTarget(h, {});
      sum += x;
      engine.ingestShot(null, null);
    }
    return sum / N;
  }

  test('drifts toward a demonstrated weakness — but only mildly', () => {
    const learned = meanXOver(
      createBeginnerEngine({ rng: mulberry32(11) }),
      historyOfFailuresAt(-0.6),
      4000,
    );
    const naive = meanXOver(
      createBeginnerEngine({ rng: mulberry32(11) }),
      new ShotHistory(),
      4000,
    );
    expect(Math.abs(naive)).toBeLessThan(0.03);
    // Exploit factor 0.20 × non-tactical share ≈ 18% of shots at ~-0.6:
    // a real drift a player can feel across a game, nowhere near the smart
    // tiers' lock-on.
    expect(learned).toBeLessThan(-0.05);
    expect(learned).toBeGreaterThan(-0.25);
  });

  test('exploits far less than the international tier', () => {
    const club = meanXOver(
      createBeginnerEngine({ rng: mulberry32(12) }),
      historyOfFailuresAt(-0.6),
      4000,
    );
    const intl = meanXOver(
      createIntermediateEngine({ rng: mulberry32(12) }),
      historyOfFailuresAt(-0.6),
      4000,
    );
    // Both drift left; CLUB's drift must stay well short of INTERNATIONAL's.
    expect(club).toBeGreaterThan(intl + 0.1);
  });

  test('holds punishment for 4 rallies after a new weakness appears', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(13) });
    const h = historyOfFailuresAt(-0.6);
    // computeTarget without ingestShot: the first call detects the new top
    // cell and zeroes the delay counter, and with no rallies elapsing the
    // exploit branch must stay frozen — aim stays centred.
    let sum = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) sum += engine.computeTarget(h, {})[0];
    expect(Math.abs(sum / N)).toBeLessThan(0.04);
  });

  test('needs 7 shots of evidence before noticing anything', () => {
    // 6 failures at one spot: above the smart tiers' threshold (5), below
    // CLUB's (7). A club player hasn't spotted the pattern yet.
    const engine = createBeginnerEngine({ rng: mulberry32(14) });
    const shifted = meanXOver(engine, historyOfFailuresAt(-0.6, 6), 4000);
    expect(Math.abs(shifted)).toBeLessThan(0.04);
  });

  test('ordinary shots lean gently away from where the player stands', () => {
    const at = (px, seed) => {
      const engine = createBeginnerEngine({ rng: mulberry32(seed) });
      let sum = 0;
      const N = 4000;
      for (let i = 0; i < N; i++) {
        sum += engine.computeTarget(null, { player_xz: { x: px, z: 0.7 } })[0];
      }
      return sum / N;
    };
    const leanRight = at(-0.6, 15);
    const leanLeft = at(0.6, 15);
    // A real lean into the open half...
    expect(leanRight).toBeGreaterThan(0.05);
    expect(leanLeft).toBeLessThan(-0.05);
    // ...but a LEAN, not the smart tiers' ~0.26m mirror (AWAY_BIAS_MAX_M
    // caps the center shift at 0.15; the tactical branch adds a little).
    expect(leanRight).toBeLessThan(0.22);
    // Symmetric — no baked-in side preference.
    expect(Math.abs(leanRight + leanLeft)).toBeLessThan(0.05);
  });

  // --- Pace adaptation + sidespin (long-rally retune) -----------------------

  test('return pace tracks the incoming ball, and stays rally-safe', () => {
    const meanSpeedVs = (inSpeed, seed) => {
      const engine = createBeginnerEngine({ rng: mulberry32(seed) });
      let sum = 0;
      const N = 4000;
      for (let i = 0; i < N; i++) {
        const t = engine.computeTarget(null, { incoming: { speed_mps: inSpeed } });
        expect(t[2]).toBeLessThanOrEqual(8.5); // never amplified past profile top
        sum += t[2];
      }
      return sum / N;
    };
    const offSoft = meanSpeedVs(2.5, 21);
    const offMedium = meanSpeedVs(5.5, 21);
    const offFast = meanSpeedVs(10.0, 21);
    // Monotone: a faster incoming ball draws a faster (but still controlled)
    // return; a soft one draws a soft one.
    expect(offSoft).toBeLessThan(offMedium);
    expect(offMedium).toBeLessThan(offFast);
    // Controlled: PACE_MATCH_MAX (7.0) keeps the blend from chasing a fast
    // ball — the mean stays at rally pace even off a 10 m/s incoming.
    expect(offFast).toBeLessThan(6.5);
  });

  test('sidespin: present, bounded, both directions, never on a smash', () => {
    const engine = createBeginnerEngine({ rng: mulberry32(22) });
    let withSide = 0, left = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const t = engine.computeTarget(null, {});
      const side = t[6];
      expect(Number.isFinite(side)).toBe(true);
      if (side !== 0) {
        // Beginner band from SIDESPIN_BY_DIFFICULTY: 5-15 rps magnitude
        // (physical rps).
        expect(Math.abs(side)).toBeGreaterThanOrEqual(5.0);
        expect(Math.abs(side)).toBeLessThanOrEqual(15.0);
        withSide += 1;
        if (side < 0) left += 1;
      }
      if (t[5] === 'smash') expect(side).toBe(0);
    }
    // A real minority of shots curl — enough to feel, not a gimmick on
    // every ball. Base prob 0.45 x per-type factors lands in this window.
    expect(withSide / N).toBeGreaterThan(0.10);
    expect(withSide / N).toBeLessThan(0.45);
    // Fair coin on direction.
    expect(left / withSide).toBeGreaterThan(0.4);
    expect(left / withSide).toBeLessThan(0.6);
  });

  test('uses the injected RNG (deterministic with same seed)', () => {
    const a = createBeginnerEngine({ rng: mulberry32(42) });
    const b = createBeginnerEngine({ rng: mulberry32(42) });
    for (let i = 0; i < 50; i++) {
      const ta = a.computeTarget(null, {});
      const tb = b.computeTarget(null, {});
      // First 4 elements are numeric — RNG determinism check. Element [4]
      // is confidence (always 1.0), [5] is shot type string, [6] sidespin.
      for (let k = 0; k < 4; k++) expect(ta[k]).toBeCloseTo(tb[k], 12);
      expect(ta[4]).toBe(tb[4]);
      expect(ta[5]).toBe(tb[5]);
      expect(ta[6]).toBeCloseTo(tb[6], 12);
    }
  });
});
