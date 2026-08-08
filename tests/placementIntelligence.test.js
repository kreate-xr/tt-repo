// Placement intelligence — does the AI aim with intent, or just spread noise?
//
// Nothing previously tested this. Every individual mechanism had unit tests
// (Voronoi math, zone weighting, shrinkage) but no test asked the question a
// player actually cares about: does the ball go somewhere meaningful?
//
// That gap let a real defect sit unnoticed — player VELOCITY was read only by
// the tactical branch, so two of the three targeting paths were blind to which
// way the player was moving and wrong-footing came out at ~3cm of mean aim
// shift, against 26cm for plain positional play. Measurable, invisible.
//
// Four properties, in rough order of how much they matter to the feel:
//   1. Coverage      — the whole table is reachable, no dead zones
//   2. Tracking      — aim mirrors where the player is
//   3. Exploitation  — aim drifts toward where the player keeps failing
//   4. Wrong-footing — aim goes against the player's momentum

import { createBeginnerEngine } from '../js/ai/engines/beginner.js';
import { createIntermediateEngine } from '../js/ai/engines/intermediate.js';
import { createProEngine } from '../js/ai/engines/pro.js';
import { ShotHistory } from '../js/ai/shotHistory.js';

const FACTORIES = {
  beginner: createBeginnerEngine,
  intermediate: createIntermediateEngine,
  pro: createProEngine,
};
const SMART_TIERS = ['intermediate', 'pro'];

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

// Run N shots and return every target the engine picked.
function shots(difficulty, ctx, N = 6000, history = null) {
  const engine = FACTORIES[difficulty]({ rng: mulberry32(7) });
  const h = history || new ShotHistory();
  const out = [];
  for (let i = 0; i < N; i++) {
    const [x, z] = engine.computeTarget(h, typeof ctx === 'function' ? ctx(i) : ctx);
    out.push([x, z]);
    engine.ingestShot(null, null);
  }
  return out;
}

const meanX = (list) => list.reduce((a, [x]) => a + x, 0) / list.length;
const leftShare = (list) => list.filter(([x]) => x < 0).length / list.length;

// --- 1. Coverage ------------------------------------------------------------

describe('coverage', () => {
  // Half-table is x ∈ [-0.7625, 0.7625], z ∈ [0, 1.37].
  const NX = 6;
  const NZ = 5;

  function cellsHit(list) {
    const seen = new Set();
    for (const [x, z] of list) {
      const cx = Math.min(NX - 1, Math.max(0, Math.floor((x + 0.7625) / (1.525 / NX))));
      const cz = Math.min(NZ - 1, Math.max(0, Math.floor(z / (1.37 / NZ))));
      seen.add(`${cx},${cz}`);
    }
    return seen.size;
  }

  test.each(SMART_TIERS)('%s reaches every cell of the table', (difficulty) => {
    expect(cellsHit(shots(difficulty, {}))).toBe(NX * NZ);
  });

  test.each(SMART_TIERS)('%s does not pile into a few hot cells', (difficulty) => {
    const counts = new Map();
    const list = shots(difficulty, {});
    for (const [x, z] of list) {
      const cx = Math.min(NX - 1, Math.max(0, Math.floor((x + 0.7625) / (1.525 / NX))));
      const cz = Math.min(NZ - 1, Math.max(0, Math.floor(z / (1.37 / NZ))));
      const k = `${cx},${cz}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const top3 = [...counts.values()].sort((a, b) => b - a).slice(0, 3)
      .reduce((a, b) => a + b, 0) / list.length;
    // Measured ~0.20 for both smart tiers. A jump here means the targeting has
    // collapsed onto a small number of favourite spots.
    expect(top3).toBeLessThan(0.32);
  });

  test('beginner is deliberately more central than the smart tiers', () => {
    // Not a defect — beginners aim at "the table", not at a spot.
    const spread = (d) => {
      const list = shots(d, {});
      return Math.sqrt(list.reduce((a, [x]) => a + x * x, 0) / list.length);
    };
    expect(spread('beginner')).toBeLessThan(spread('intermediate'));
  });
});

// --- 2. Tracking ------------------------------------------------------------

describe('tracking the player', () => {
  test.each(SMART_TIERS)('%s aims away from where the player stands', (difficulty) => {
    const at = (px) => meanX(shots(difficulty, { player_xz: { x: px, z: 0.7 } }, 4000));
    const far = at(-0.6);
    const mid = at(-0.3);
    const centre = at(0);
    // Monotonic mirror: the further left the player, the further right we aim.
    expect(far).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(centre);
    expect(far).toBeGreaterThan(0.15);
  });

  test.each(SMART_TIERS)('%s is symmetric — no baked-in side preference', (difficulty) => {
    const l = meanX(shots(difficulty, { player_xz: { x: -0.6, z: 0.7 } }, 4000));
    const r = meanX(shots(difficulty, { player_xz: { x: 0.6, z: 0.7 } }, 4000));
    expect(Math.abs(l + r)).toBeLessThan(0.05);
  });
});

// --- 3. Exploitation --------------------------------------------------------

describe('exploiting a demonstrated weakness', () => {
  function historyOfFailuresAt(x) {
    const h = new ShotHistory();
    for (let i = 1; i <= 12; i++) h.push([i, i * 100, x, 0.9, 0, 90, 6, 0]);
    return h;
  }

  test.each(SMART_TIERS)('%s drifts toward the zone the player keeps missing', (difficulty) => {
    const ctx = { player_xz: { x: 0, z: 0.7 } };
    const naive = meanX(shots(difficulty, ctx, 4000));
    const learned = meanX(shots(difficulty, ctx, 4000, historyOfFailuresAt(-0.6)));
    expect(naive).toBeCloseTo(0, 1);
    expect(learned).toBeLessThan(-0.12);
  });

  test('pro exploits harder than intermediate', () => {
    // The tier ladder: pro routes more shots through the heatmap (exploit 0.95
    // / tactical 0.42) than intermediate (0.85 / 0.50). This inverted once
    // before — pro was at 0.414 against intermediate's 0.425 — and no test
    // caught it because the share is emergent across two files.
    const ctx = { player_xz: { x: 0, z: 0.7 } };
    const i = meanX(shots('intermediate', ctx, 4000, historyOfFailuresAt(-0.6)));
    const p = meanX(shots('pro', ctx, 4000, historyOfFailuresAt(-0.6)));
    expect(p).toBeLessThan(i);
  });
});

// --- 4. Stroke / placement coherence ----------------------------------------

// A shot type carries an implied depth. Placement is chosen first (it is the
// tactical decision), so the stroke has to fit it.
//
// These were drawn independently until applyTargetDepthBias landed, and
// contradicted each other constantly: 73% of drop shots were aimed DEEP — a
// slow ball to the back of the table, i.e. a free attack for the player —
// plus 25% of lobs and 26% of chops aimed short. ~10% of every shot the AI
// played was a stroke that argued with its own target.
describe('stroke matches placement', () => {
  // z beyond which the named stroke stops making sense (or below, for deep
  // strokes). Tolerances are loose: jitter (sigma 0.08m) legitimately carries
  // some targets across a boundary after the type is picked, and a drop shot
  // that lands slightly long is a real thing.
  const RULES = [
    ['drop_shot', (z) => z > 0.60, 0.25],  // dies at the net
    ['lob',       (z) => z < 0.55, 0.15],  // high deep arc
    ['chop',      (z) => z < 0.55, 0.15],  // floaty backspin, lands deep
    ['smash',     (z) => z < 0.35, 0.15],  // needs table to land on
  ];

  function typedShots(difficulty, N = 12000) {
    const engine = FACTORIES[difficulty]({ rng: mulberry32(7) });
    const h = new ShotHistory();
    const out = [];
    for (let i = 0; i < N; i++) {
      const [, z, , , , type] = engine.computeTarget(h, { player_xz: { x: 0, z: 0.7 } });
      out.push([type, z]);
      engine.ingestShot(null, null);
    }
    return out;
  }

  test.each(SMART_TIERS)('%s: each stroke lands at a depth that suits it', (difficulty) => {
    const list = typedShots(difficulty);
    for (const [type, isWrong, tolerance] of RULES) {
      const of = list.filter(([t]) => t === type);
      expect(of.length).toBeGreaterThan(100); // the type must still be played
      const wrong = of.filter(([, z]) => isWrong(z)).length / of.length;
      expect(wrong).toBeLessThan(tolerance);
    }
  });

  test.each(SMART_TIERS)('%s: coherence did not come at the cost of vocabulary', (difficulty) => {
    // The cheap way to score 0% incoherence is to stop playing the
    // depth-specific strokes at all. All ten types must survive.
    const seen = new Set(typedShots(difficulty).map(([t]) => t));
    expect(seen.size).toBe(10);
  });
});

// --- 5. Wrong-footing -------------------------------------------------------

describe('wrong-footing a moving player', () => {
  const moving = (vx) => ({
    player_xz: { x: 0, z: 0.7 },
    player_velocity_xz: { x: vx, z: 0 },
  });

  test.each(SMART_TIERS)('%s aims against the player\'s momentum', (difficulty) => {
    const right = meanX(shots(difficulty, moving(1.2), 4000));
    const still = meanX(shots(difficulty, moving(0), 4000));
    const left = meanX(shots(difficulty, moving(-1.2), 4000));
    expect(right).toBeLessThan(still);
    expect(left).toBeGreaterThan(still);
  });

  test.each(SMART_TIERS)('%s wrong-foots hard enough for a human to feel it', (difficulty) => {
    // THE regression guard. Player velocity used to be read only by the
    // tactical branch (half the shots), so this came out at 0.03m — present in
    // the code, absent from the game. Measured ~0.21m after all three
    // targeting branches were made velocity-aware; positional play is ~0.26m,
    // so the two tactics are now comparable in strength as they should be.
    const shift = Math.abs(meanX(shots(difficulty, moving(1.2), 4000)));
    expect(shift).toBeGreaterThan(0.12);
  });

  test.each(SMART_TIERS)('%s sends a clear majority against the run', (difficulty) => {
    // Was 53.7% before the fix, ~77% after.
    expect(leftShare(shots(difficulty, moving(1.2), 4000))).toBeGreaterThan(0.65);
  });

  test.each(SMART_TIERS)('%s is unbiased when the player is stationary', (difficulty) => {
    expect(Math.abs(meanX(shots(difficulty, moving(0), 4000)))).toBeLessThan(0.05);
  });

  test('a stationary player is placed against exactly as before', () => {
    // Anticipation must not disturb the dominant mechanism. With zero velocity
    // the projection is the identity, so these must match the no-velocity path.
    for (const difficulty of SMART_TIERS) {
      const withVel = meanX(shots(difficulty, {
        player_xz: { x: 0.6, z: 0.7 }, player_velocity_xz: { x: 0, z: 0 },
      }, 4000));
      const withoutVel = meanX(shots(difficulty, { player_xz: { x: 0.6, z: 0.7 } }, 4000));
      expect(withVel).toBeCloseTo(withoutVel, 6);
    }
  });
});
