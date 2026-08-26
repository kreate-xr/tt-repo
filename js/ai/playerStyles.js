// Player styles — orthogonal to difficulty. Two Pro AIs of different styles
// play COMPLETELY differently, not just "same style, slightly different
// exploit factor." This is what makes each match feel like a distinct
// opponent rather than a fresh instance of the same engine.
//
// Four archetypes drawn from real TT:
//
//   attacker  — hunts topspin openings, close to table (~0.13m behind),
//               loops and drives everything. Signature: heavy loop + drive.
//   blocker   — stands ON the edge, redirects incoming pace with quick
//               short strokes. Almost never initiates a big shot.
//               Signature: block + push + counter-drive.
//   chopper   — plays 2m back, defends with heavy backspin. Rare
//               counterattack loop. Signature: chop + slice + occasional
//               surprise loop through the middle.
//   allround  — mixes everything, no strong tendency. The "vanilla"
//               style — good default for Beginner (who doesn't have a
//               developed style yet) and the fallback when no style is
//               specified.
//
// Wired into three places:
//   1. shotTypeSelector.applyStyleBias — style-specific weight
//      multipliers on top of the difficulty base weights
//   2. readyPosition.computeReadyPose  — style-specific home distance
//      behind the AI's table edge (choppers stand way back)
//   3. aiPaddle.MOVEMENT_SPEED_MPS — style-specific movement multiplier
//      (choppers need more ground coverage, blockers less)
//
// Worker-safe: no THREE, no DOM.

export const PLAYER_STYLES = Object.freeze({
  ATTACKER: 'attacker',
  BLOCKER:  'blocker',
  CHOPPER:  'chopper',
  ALLROUND: 'allround',
});

// Per-style, per-shot-type multiplier on the difficulty base weight.
// 1.0 = leave unchanged. Values > 1 emphasize that shot for this style;
// values < 1 suppress. Missing entries default to 1.0.
//
// Design principle: each style should CLEARLY over-index on its
// signature shots and under-index on the shots that don't fit its game.
// A chopper that occasionally smashes at 0.5× still smashes — just less
// than 25% as often as an attacker would.
export const STYLE_WEIGHT_MULTIPLIERS = Object.freeze({
  attacker: {
    loop:          1.7,
    topspin_drive: 1.5,
    smash:         1.4,
    flip:          1.3,
    block:         0.7,
    push:          0.5,
    slice:         0.6,
    chop:          0.2,
    drop_shot:     0.6,
    lob:           0.4,
  },
  blocker: {
    block:         2.2,
    push:          1.6,
    slice:         1.3,
    topspin_drive: 0.8,
    loop:          0.5,
    smash:         0.5,
    chop:          0.4,
    drop_shot:     0.8,
    flip:          0.4,
    lob:           0.7,
  },
  chopper: {
    chop:          2.8,
    slice:         2.0,
    push:          1.5,
    lob:           1.5,
    loop:          0.4,   // rare counterattack "surprise loop"
    block:         0.5,
    topspin_drive: 0.4,
    smash:         0.15,
    flip:          0.15,
    drop_shot:     0.5,
  },
  // Allround: identity — no bias, use raw difficulty weights.
  allround: {},
});

// Home distance behind the AI's table edge (in meters). Attackers camp
// close for quick reads on rally balls; choppers stand meters back to
// give themselves TIME to float defensive chops with heavy backspin.
// Overrides the default NEUTRAL_Z_BEHIND_AI_EDGE_M in readyPosition.js.
export const STYLE_HOME_DISTANCE_M = Object.freeze({
  attacker: 0.13,
  blocker:  0.05,   // on-the-edge redirector
  chopper:  1.20,   // deep court defender (was 1.5 — softened so the
                    //                       chopper doesn't spend the
                    //                       whole match traveling back)
  allround: 0.30,
});

// Multiplier on the base MOVEMENT_SPEED_MPS from aiPaddle.js. Choppers
// need to cover much more ground (deeper home + full table width);
// blockers cover less because they stay glued to the edge.
export const STYLE_MOVEMENT_MULTIPLIER = Object.freeze({
  attacker: 1.00,
  blocker:  0.90,
  chopper:  1.25,
  allround: 1.00,
});

// Contact timing: ms after the AI-side bounce at which the stroke is taken
// (feeds shotAdapter's interception rollout via setContactDelayMs). This
// used to be a flat 200 for every style, which contradicted everything the
// home distances above say: a blocker glued to the edge takes the ball ON
// THE RISE — that is the entire style — while a chopper 1.2 m back takes it
// late and low on the descent. Timing is the most VISIBLE style signature
// there is; the paddle meeting the ball at a different point in its arc is
// what makes a blocker read as a blocker before they've hit three balls.
// (The physics is indifferent — the solver solves whatever contact point
// the rollout hands it — so this is pure style expression, with the real
// tactical consequences timing has: earlier contact returns the ball
// sooner and lower, later contact buys reach and time.)
export const STYLE_CONTACT_DELAY_MS = Object.freeze({
  attacker: 160,   // near the top of the bounce — takes it early to press
  blocker:  110,   // on the rise, right off the bounce
  chopper:  320,   // late and low, well into the descent
  allround: 200,   // the neutral timing the sim always used
});

// Not all styles suit all difficulties. A beginner is by definition
// "no developed style yet" — beginners are always allround. Intermediate
// and Pro get random assignment from all four.
//
// Intermediate is now the international tier, so its pool includes chopper
// and leans toward COMMITTED archetypes rather than double-weighting
// allround. Players at that level have a pronounced identity — they are an
// attacker or a blocker or a chopper — and "generic" is the exception. This
// also makes back-to-back matches at the same tier feel like different
// opponents, which matters more the stronger the opponent is.
const STYLE_POOL_BY_DIFFICULTY = Object.freeze({
  beginner:     [PLAYER_STYLES.ALLROUND],
  intermediate: [
    PLAYER_STYLES.ATTACKER,
    PLAYER_STYLES.ATTACKER, // attacking styles dominate at this level
    PLAYER_STYLES.BLOCKER,
    PLAYER_STYLES.CHOPPER,
    PLAYER_STYLES.ALLROUND,
  ],
  pro: [
    PLAYER_STYLES.ATTACKER,
    PLAYER_STYLES.BLOCKER,
    PLAYER_STYLES.CHOPPER,
    PLAYER_STYLES.ALLROUND,
  ],
});

// Pick a style for a match. Deterministic with the same rng seed so
// tests can pin behavior. Callers pass their session-scoped rng.
export function pickStyleForMatch(difficulty, rng = Math.random) {
  const pool = STYLE_POOL_BY_DIFFICULTY[difficulty] || STYLE_POOL_BY_DIFFICULTY.beginner;
  const idx = Math.floor(rng() * pool.length);
  return pool[Math.min(idx, pool.length - 1)];
}

// Apply style multipliers to a shot-type weight object. Returns a new
// object; does not mutate the input. Style === 'allround' returns a
// shallow copy unchanged.
export function applyStyleBias(weights, style) {
  if (!style || style === PLAYER_STYLES.ALLROUND) return { ...weights };
  const mults = STYLE_WEIGHT_MULTIPLIERS[style];
  if (!mults) return { ...weights };
  const out = {};
  for (const [type, w] of Object.entries(weights)) {
    const m = mults[type] ?? 1;
    out[type] = w * m;
  }
  return out;
}

// Lookup helpers — safe defaults for unknown styles.
export function homeDistanceForStyle(style) {
  return STYLE_HOME_DISTANCE_M[style] ?? STYLE_HOME_DISTANCE_M.allround;
}
export function movementMultiplierForStyle(style) {
  return STYLE_MOVEMENT_MULTIPLIER[style] ?? 1.0;
}
export function contactDelayForStyle(style) {
  return STYLE_CONTACT_DELAY_MS[style] ?? STYLE_CONTACT_DELAY_MS.allround;
}
