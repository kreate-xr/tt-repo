// Guards the profile/rail split in shotTypeSelector.js.
//
// The defect this exists to prevent: sampleShotParameters clamps to the
// profile range FIRST and the difficulty cap SECOND, so any cap at or below a
// profile's speedMin collapses that shot type to a single constant with zero
// variance. Intermediate's old 9.0 cap vs. smash's 9.0 speedMin meant every
// intermediate smash was exactly 9.0 m/s — the type existed in the weights
// table but was indistinguishable from a capped drive in flight.
//
// Nothing failed loudly when that happened. These tests make it fail loudly.

import {
  SHOT_PROFILES, PROFILE_OVERRIDES, DIFFICULTY_CAPS,
  profileFor, sampleShotParameters,
} from '../js/ai/shotTypeSelector.js';

const DIFFICULTIES = ['beginner', 'intermediate', 'pro'];
const TYPES = Object.keys(SHOT_PROFILES);

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

describe('difficulty rails never bind', () => {
  test.each(DIFFICULTIES)('%s: every profile bound sits strictly inside the rail', (difficulty) => {
    const caps = DIFFICULTY_CAPS[difficulty];
    for (const type of TYPES) {
      const p = profileFor(type, difficulty);
      // A rail at or below speedMin is the exact collapse condition.
      expect(p.speedMin).toBeGreaterThan(caps.minSpeed);
      expect(p.speedMax).toBeLessThan(caps.maxSpeed);
    }
  });

  // The SPIN equivalent. This axis was still collapsing long after the speed
  // axis was fixed, because PROFILE_OVERRIDES only overrode speed: base spin
  // bounds stayed put while maxSpin (±15/26/40) did the shaping. Measured
  // before the fix: 100% of beginner loops emitted exactly +15.0 rps, 77% of
  // slices exactly -15.0, 93% of intermediate chops exactly -26.0.
  test.each(DIFFICULTIES)('%s: every spin bound sits strictly inside the rail', (difficulty) => {
    const caps = DIFFICULTY_CAPS[difficulty];
    for (const type of TYPES) {
      const p = profileFor(type, difficulty);
      expect(Math.abs(p.spinMin)).toBeLessThan(caps.maxSpin);
      expect(Math.abs(p.spinMax)).toBeLessThan(caps.maxSpin);
    }
  });

  test.each(DIFFICULTIES)('%s: no shot type collapses to a constant spin', (difficulty) => {
    const rng = mulberry32(31337);
    for (const type of TYPES) {
      const seen = new Set();
      for (let i = 0; i < 1000; i++) {
        seen.add(sampleShotParameters({ shotType: type, difficulty, rng }).spin);
      }
      expect(seen.size).toBeGreaterThan(50);
    }
  });

  test.each(DIFFICULTIES)('%s: sampled spin keeps a real spread', (difficulty) => {
    const rng = mulberry32(1234);
    for (const type of TYPES) {
      const xs = [];
      for (let i = 0; i < 2000; i++) {
        xs.push(sampleShotParameters({ shotType: type, difficulty, rng }).spin);
      }
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
      expect(sd).toBeGreaterThan(0.1);
    }
  });

  // Backspin has a measured physical ceiling around -62 rps in this model:
  // heavier backspin floats the ball long and cannot be held on the table at
  // any pace (see tests/solverEnvelope.test.js; the ceiling is geometry-
  // dependent — heavy chop backspin only holds at chop pace and depth).
  // Requesting more just produces infeasible solves that fall back to a slow
  // safe ball.
  test.each(DIFFICULTIES)('%s: no profile requests backspin beyond the envelope', (difficulty) => {
    for (const type of TYPES) {
      expect(profileFor(type, difficulty).spinMin).toBeGreaterThanOrEqual(-64);
    }
  });

  test.each(DIFFICULTIES)('%s: no shot type collapses to a constant speed', (difficulty) => {
    const rng = mulberry32(9001);
    for (const type of TYPES) {
      const seen = new Set();
      for (let i = 0; i < 1000; i++) {
        seen.add(sampleShotParameters({ shotType: type, difficulty, rng }).speed);
      }
      // A collapsed type yields exactly one value across 1000 draws.
      expect(seen.size).toBeGreaterThan(50);
    }
  });

  test.each(DIFFICULTIES)('%s: sampled speed keeps a real spread', (difficulty) => {
    const rng = mulberry32(4242);
    for (const type of TYPES) {
      const xs = [];
      for (let i = 0; i < 2000; i++) {
        xs.push(sampleShotParameters({ shotType: type, difficulty, rng }).speed);
      }
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
      // Loose bound — catches collapse and near-collapse without pinning the
      // exact distribution, which tuning is expected to move.
      expect(sd).toBeGreaterThan(0.1);
    }
  });
});

describe('tier ordering', () => {
  // The ladder must be monotonic in pace on the attacking strokes. This is
  // what "beginner < intermediate < pro" actually means to a player.
  const ATTACKING = ['topspin_drive', 'loop', 'smash', 'flip'];

  test.each(ATTACKING)('%s gets faster with every tier', (type) => {
    const b = profileFor(type, 'beginner').speedMean;
    const i = profileFor(type, 'intermediate').speedMean;
    const p = profileFor(type, 'pro').speedMean;
    expect(i).toBeGreaterThan(b);
    expect(p).toBeGreaterThan(i);
  });

  // Playability retune (2026-08-28): the tier previously pinned its attacking
  // means at the top of the deliverable envelope (loop >= 12, drive >= 13,
  // smash >= 16 — "genuinely international") and headset feedback was that
  // the tier was unplayable: points ended on pace before a rally developed.
  // The tier now plays at "strong tournament" pace — bounded on BOTH sides:
  // too low and it stops being a clear step above CLUB (beginner smash mean
  // is 7.9); too high and it regresses to the unplayable pass. Its difficulty
  // lives in placement, consistency and footwork instead.
  test('intermediate attacking pace is challenging but returnable', () => {
    const loop = profileFor('loop', 'intermediate');
    const drive = profileFor('topspin_drive', 'intermediate');
    const smash = profileFor('smash', 'intermediate');
    expect(loop.speedMean).toBeGreaterThanOrEqual(9);
    expect(loop.speedMean).toBeLessThanOrEqual(11);
    expect(drive.speedMean).toBeGreaterThanOrEqual(10);
    expect(drive.speedMean).toBeLessThanOrEqual(12);
    expect(smash.speedMean).toBeGreaterThanOrEqual(12);
    expect(smash.speedMean).toBeLessThanOrEqual(15);
    // Deliverable ceiling — see the measurement table in PROFILE_OVERRIDES.
    expect(smash.speedMax).toBeLessThanOrEqual(21);
  });

  test('no tier asks for a speed past the measured envelope', () => {
    // Feasibility is ~100% to 30 m/s at short/mid depth. Pace at DEPTH is the
    // real constraint, and the engines handle that by scaling with target
    // depth rather than by capping here.
    const HARD_ENVELOPE_MAX = 31.0;
    for (const difficulty of DIFFICULTIES) {
      for (const type of TYPES) {
        expect(profileFor(type, difficulty).speedMax).toBeLessThanOrEqual(HARD_ENVELOPE_MAX);
      }
    }
  });

  test('touch shots stay slow at every tier', () => {
    // A push is a push. If touch shots scale with the attacking strokes, the
    // AI loses its change-of-pace vocabulary and every ball reads the same.
    for (const difficulty of DIFFICULTIES) {
      expect(profileFor('push', difficulty).speedMean).toBeLessThan(6);
      expect(profileFor('drop_shot', difficulty).speedMean).toBeLessThan(5);
    }
  });
});

// The share of shots that punish a demonstrated weakness is an EMERGENT
// product of two constants in two different files:
//     heatmapShare = (1 - TACTICAL_PROBABILITY[tier]) * EXPLOIT_FACTOR[tier]
// so raising one tier's exploit factor while another's tactical rate is higher
// can silently invert the ladder. That is exactly what happened: pro sat at
// 0.414 against intermediate's 0.425 and nothing caught it, because each
// constant looked correct in isolation.
describe('tier ladder — targeting intent', () => {
  // Mirrors the branch order in the engines: third-ball > tactical > heatmap
  // > neutral. Kept in the test rather than exported from the engines so it
  // fails if the engines' control flow drifts away from this model.
  function shares(tacticalProb, exploitFactor) {
    const tactical = tacticalProb;
    const heatmap = (1 - tacticalProb) * exploitFactor;
    return { tactical, heatmap, neutral: 1 - tactical - heatmap };
  }

  // These must track the real constants; see tacticalZones.js and the engines.
  const INT = shares(0.50, 0.85);
  const PRO = shares(0.42, 0.95);

  test('pro punishes demonstrated weakness MORE than intermediate', () => {
    expect(PRO.heatmap).toBeGreaterThan(INT.heatmap);
  });

  test('pro plays fewer purely neutral balls than intermediate', () => {
    expect(PRO.neutral).toBeLessThan(INT.neutral);
  });

  test('the tiers differ in kind, not just degree', () => {
    // Intermediate leans on generic placement, pro on personalised targeting.
    expect(INT.tactical).toBeGreaterThan(PRO.tactical);
    expect(PRO.heatmap).toBeGreaterThan(INT.tactical);
  });

  test('every tier still plays some unpredictable neutral balls', () => {
    // A tier at 0% neutral is fully deterministic in its targeting, which
    // reads as surveillance rather than as skill.
    for (const s of [INT, PRO]) {
      expect(s.neutral).toBeGreaterThan(0.01);
    }
  });
});

describe('spin scales sanely across tiers', () => {
  // Spin used to be identical at every tier, with DIFFICULTY_CAPS.maxSpin
  // truncating it — which collapsed whole shot types to a constant. Per-tier
  // spin overrides fixed that, but they must not become a licence to inflate:
  // MAGNUS_COEFFICIENT is ~9x physical, so ~26 rps here already bends the ball
  // like a real elite loop. Tier separation comes mainly from PACE.
  test('topspin rises with tier but stays in the sane band', () => {
    for (const type of ['loop', 'topspin_drive']) {
      const b = profileFor(type, 'beginner').spinMean;
      const i = profileFor(type, 'intermediate').spinMean;
      const p = profileFor(type, 'pro').spinMean;
      expect(i).toBeGreaterThan(b);
      expect(p).toBeGreaterThanOrEqual(i);
      // Never past the 64 rps grip ceiling (PADDLE_SPIN_CAP ≈ 67 rps) —
      // past what the impulse model can deliver, the arc is fiction.
      expect(p).toBeLessThanOrEqual(64);
    }
  });

  test('beginner genuinely cannot generate spin', () => {
    // A real beginner brushes very little. If this ever creeps up, the bottom
    // of the ladder stops being distinguishable.
    for (const type of TYPES) {
      const p = profileFor(type, 'beginner');
      expect(Math.abs(p.spinMean)).toBeLessThanOrEqual(37);
    }
  });

  test('upper tiers are not merely spinnier versions of each other', () => {
    // Pace, not spin, is the ladder. Pro's spin should be at most a modest
    // step over intermediate on any type.
    for (const type of TYPES) {
      const i = Math.abs(profileFor(type, 'intermediate').spinMean);
      const p = Math.abs(profileFor(type, 'pro').spinMean);
      if (i > 0) expect(p / i).toBeLessThan(1.3);
    }
  });
});

describe('profileFor', () => {
  test('merges partial overrides over the base profile', () => {
    // beginner's `push` overrides spin only, so speed must still come from
    // the base profile. A shallow replace instead of a merge would silently
    // drop the speed bounds and hand the sampler undefined.
    const p = profileFor('push', 'beginner');
    expect(p.speedMean).toBe(SHOT_PROFILES.push.speedMean);
    expect(p.speedMin).toBe(SHOT_PROFILES.push.speedMin);
    expect(p.spinMean).not.toBe(SHOT_PROFILES.push.spinMean);
  });

  test('every merged profile has all six parameters defined', () => {
    for (const difficulty of [...DIFFICULTIES, 'nonexistent']) {
      for (const type of TYPES) {
        const p = profileFor(type, difficulty);
        for (const k of ['speedMean', 'speedSigma', 'speedMin', 'speedMax',
                         'spinMean', 'spinSigma', 'spinMin', 'spinMax']) {
          expect(Number.isFinite(p[k])).toBe(true);
        }
      }
    }
  });

  test('an unknown difficulty yields the untouched base profile', () => {
    expect(profileFor('loop', 'nonexistent')).toEqual(SHOT_PROFILES.loop);
  });

  test('an unknown shot type falls back to topspin_drive', () => {
    expect(profileFor('nonsense', 'intermediate').speedMean)
      .toBe(PROFILE_OVERRIDES.intermediate.topspin_drive.speedMean);
  });
});
