// Intermediate engine — Voronoi-heatmap targeting with weighted struggle
// scoring, decay, accuracy guardrails, and Bayesian shrinkage.
//
// Spec §ai_worker_design.engines.intermediate +
// §accuracy_guardrails (the latter applies to all difficulty levels above
// Beginner).
//
// Inputs:
//   - ShotHistory (15 slots, decayed per-rally by 0.93)
//   - Each shot: {landing_x, landing_z, success, swing_lateness_ms, weight}
//     where landing_* is where OUR OWN previous shot bounced on the player's
//     half, and success/lateness describe how the player coped with it. See
//     the contract comment in shotAdapter.js — the pairing is what makes the
//     struggle score mean "the player is weak here" rather than "the player
//     likes hitting here".
//
// Pipeline per computeTarget:
//   1. Grid-snap each shot's (landing_x, landing_z) to 0.10m grid.
//   2. Group by snapped point → unique Voronoi seeds.
//   3. Score each seed: Σ shot_weight * (misses*3 + lateness/100*2 − success*0.3)
//      (the spec said +success*0.5; see struggleScorePerShot for why the sign
//      is flipped — zones the player has mastered should be LESS attractive)
//   4. Build bounded Voronoi over seeds inside the player-side rectangle.
//   5. Drop cells whose Voronoi area is below 0.015 sqm (merge implicit via
//      removal — neighbouring cells absorb their space the next iteration).
//   6. Apply Bayesian shrinkage: shrunk = (n·s + N₀·μ) / (n + N₀),  N₀=3.
//   7. With probability EXPLOIT_FACTOR (0.85), sample a seed by weighted CDF
//      over the top-K shrunk scores. Otherwise, pick a neutral target biased
//      away from the player's ANTICIPATED position — which keeps the AI
//      unpredictable rather than merely reactive.
//   8. Add Gaussian jitter σ=0.08m so the AI never hits the same coordinate
//      twice in a row.
//
// Steps 7-8 are skipped entirely when a third-ball attack plan is firing, and
// are preceded by a TACTICAL_PROBABILITY roll (0.50) that can pick a curated
// placement zone instead.
//
// Output is the 7-element wire payload:
//   [target_x, target_z, target_speed_mps, target_spin_rps, confidence,
//    shotType, target_sidespin_rps]
// in spec coords: target_x in [-0.7, 0.7] signed, target_z in [0.1, 1.3]
// non-negative "meters from net" on player side.
//
// Coordinate note: landing_x/landing_z in ShotHistory are already converted
// to spec coords (signed lateral x, non-negative "from net" z) by shotAdapter.
// Voronoi seeds, cells and outputs all stay in spec coords. No world-space
// math happens here.

import { Delaunay } from 'd3-delaunay';
import {
  selectShotType, sampleShotParameters, DIFFICULTY_CAPS, depthSpeedFactor,
} from '../shotTypeSelector.js';
import {
  pickTacticalTarget,
  anticipatePlayerXZ,
  TACTICAL_PROBABILITY_BY_DIFFICULTY,
} from '../tacticalZones.js';

// Spec §accuracy_guardrails — pinned values, do not relax.
const GRID_SNAP_M = 0.10;
const MIN_SHOTS_BEFORE_EXPLOIT = 5;
const VORONOI_MIN_CELL_AREA_SQM = 0.015;
const BAYESIAN_PRIOR_N = 3;
const TARGET_JITTER_SIGMA = 0.08;

// Spec §ai_worker_design.engines.intermediate — raised from 0.5 for the
// international re-tune. Players at that level punish a demonstrated weakness
// relentlessly rather than occasionally.
//
// This is only safe now that the heatmap is fed a signal that actually means
// "the player struggles here" (see shotAdapter). While it was keyed off where
// the PLAYER's shots landed on the AI's half, a high exploit factor made the
// AI strictly worse — it aimed half its shots at noise.
const EXPLOIT_FACTOR = 0.85;

// Number of recent shot types kept for anti-repeat / variety pressure in
// shotTypeSelector. applyAntiRepeat inspects all 4 (graduated per-slot lag
// penalties plus an ABAB-alternation breaker), so the window and the buffer
// are the same size — an earlier comment here claimed only the last 2 were
// read, which stopped being true when the graduated penalties landed.
const RECENT_TYPES_WINDOW = 4;

// Safe zone (player side, spec coords). The international tier aims within
// ~4 cm of the sidelines (±0.7625 → ±0.72) and ~4 cm of the end line
// (1.37 → 1.33). That is NOT free accuracy: solver landing error and target
// jitter both reach several centimetres, so a ball aimed at the clamp
// genuinely goes out sometimes — the honest price of attacking the lines,
// which the old ±0.70 / 1.30 court never paid (its most aggressive ball
// landed 6+ cm inside every line, a courtesy strip no international
// opponent grants). target_z floors at 0.1 so nothing lands on the net line.
const SAFE_X_MIN = -0.72;
const SAFE_X_MAX =  0.72;
const SAFE_Z_MIN =  0.1;
const SAFE_Z_MAX =  1.33;

// Landing zones (PLAYER side, spec coords) — the Voronoi tessellates here.
// Seeds come from where the AI's own past shots bounced on the player's half
// (see shotAdapter), so seed coordinates and output target coordinates live
// in the same frame and are directly comparable. Slightly wider than the safe
// zone because a real landing can sit right on the table edge.
const LANDING_X_MIN = -0.7625;
const LANDING_X_MAX =  0.7625;
const LANDING_Z_MIN =  0.0;
const LANDING_Z_MAX =  1.37;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function snap(v, step) { return Math.round(v / step) * step; }

// Marsaglia polar Gaussian. Same helper Beginner uses — duplicated here so
// neither engine depends on the other.
function gaussian01(rng) {
  let u, v, s;
  do {
    u = rng() * 2 - 1;
    v = rng() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  return u * Math.sqrt(-2 * Math.log(s) / s);
}

// Shoelace formula for polygon area. d3-delaunay returns cellPolygon as an
// array of [x, y] pairs with the last vertex equal to the first; both
// shoelace conventions handle that fine.
function polygonArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n - 1; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[i + 1];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// Single-shot struggle contribution.
//   misses*3 + (lateness_ms/100)*2 − successes*0.3
// Spec's original formula added +successes*0.5, but that meant zones where
// the player CLEANLY returned the ball also scored as high-struggle — the
// AI ended up drilling into zones the player had already demonstrated
// mastery of. Flipping the sign (small negative weight for clean successes)
// makes the score read as "misses/lateness minus proven mastery," which
// matches what a real coach would target.
//
// Weight (decay) is multiplied in by the caller, not here, so the formula
// stays directly auditable.
export function struggleScorePerShot(shot) {
  const isMiss = (shot.success === 0 || shot.success === false) ? 1 : 0;
  const isSuccess = (shot.success === 1 || shot.success === true) ? 1 : 0;
  const lateness = shot.swing_lateness_ms || 0;
  return isMiss * 3 + (lateness / 100) * 2 - isSuccess * 0.3;
}

// Group decayed shots by their snapped grid cell. Returns an array of seed
// records, each with raw score (sum of per-shot contributions weighted by
// decay), sample count, and the snapped (x, z).
export function buildSeeds(shots) {
  const grouped = new Map();
  for (const s of shots) {
    const sx = snap(s.landing_x, GRID_SNAP_M);
    const sz = snap(s.landing_z, GRID_SNAP_M);
    const key = `${sx.toFixed(2)},${sz.toFixed(2)}`;
    if (!grouped.has(key)) {
      grouped.set(key, { x: sx, z: sz, score: 0, n: 0, weightedN: 0 });
    }
    const g = grouped.get(key);
    const contribution = struggleScorePerShot(s) * s.weight;
    g.score += contribution;
    g.n += 1;
    g.weightedN += s.weight;
  }
  return Array.from(grouped.values());
}

// Bayesian shrinkage: pull each seed's score toward the population mean
// using prior N₀. With few samples (n small), the score regresses heavily;
// with many, the observed score dominates. This stops a single unlucky
// miss in a sparsely-sampled cell from looking like a strong target.
export function shrinkScores(seeds, priorN = BAYESIAN_PRIOR_N) {
  if (seeds.length === 0) return [];
  let totalWeightedN = 0;
  let totalScore = 0;
  for (const s of seeds) {
    totalWeightedN += s.weightedN;
    totalScore += s.score;
  }
  const populationMean = totalWeightedN > 0 ? (totalScore / totalWeightedN) : 0;
  return seeds.map(s => {
    const obsRate = s.weightedN > 0 ? (s.score / s.weightedN) : 0;
    const shrunk = (s.weightedN * obsRate + priorN * populationMean) / (s.weightedN + priorN);
    return { ...s, shrunkScore: shrunk };
  });
}

// Voronoi tessellation + small-cell filter. Returns the subset of seeds
// whose cell area meets the spec threshold (0.015 sqm).
export function filterByCellArea(seeds, bounds = [LANDING_X_MIN, LANDING_Z_MIN, LANDING_X_MAX, LANDING_Z_MAX]) {
  if (seeds.length === 0) return [];
  if (seeds.length === 1) return seeds.slice();

  const flat = new Float64Array(seeds.length * 2);
  for (let i = 0; i < seeds.length; i++) {
    flat[2 * i] = seeds[i].x;
    flat[2 * i + 1] = seeds[i].z;
  }
  const delaunay = new Delaunay(flat);
  const voronoi = delaunay.voronoi(bounds);

  const kept = [];
  for (let i = 0; i < seeds.length; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly) continue;
    if (polygonArea(poly) >= VORONOI_MIN_CELL_AREA_SQM) {
      kept.push(seeds[i]);
    }
  }
  return kept;
}

// Weighted CDF sampler. Returns the index sampled, or -1 if all weights are
// non-positive. Tested independently in the unit suite — distribution must
// match input weights within 5% over 10k samples.
export function weightedSampleIndex(weights, rng) {
  let total = 0;
  for (const w of weights) if (w > 0) total += w;
  if (total <= 0) return -1;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue;
    r -= weights[i];
    if (r <= 0) return i;
  }
  // Numeric drift fallback — find the last positive weight index.
  for (let i = weights.length - 1; i >= 0; i--) {
    if (weights[i] > 0) return i;
  }
  return -1;
}

function pickNeutralTarget(rng) {
  // "Neutral center-table" — a Gaussian around the middle. Only reachable when
  // player_xz is absent (rally 1, or unit tests); the live path uses
  // pickNeutralTargetAwayFromPlayer. An earlier comment described this as
  // matching "Beginner's center-60% pick"; Beginner has no such branch.
  const target_x = clamp(gaussian01(rng) * 0.25, SAFE_X_MIN, SAFE_X_MAX);
  const target_z = SAFE_Z_MIN + rng() * (SAFE_Z_MAX - SAFE_Z_MIN);
  return [target_x, target_z];
}

// Pick a neutral target that biases away from the player's current XZ.
// Real players don't just hit "somewhere reasonable" — they hit into the
// half of the table the opponent is furthest from. This is the single
// biggest ingredient in feeling like a real opponent instead of a ball
// machine.
//
// player_xz is spec coords: signed lateral x, non-negative "from net" z.
// If it's missing (early rally, no plumbing yet) we fall back to plain
// neutral.
export function pickNeutralTargetAwayFromPlayer(rng, playerXZ, playerVelXZ) {
  if (!playerXZ) return pickNeutralTarget(rng);
  // Mirror the player's ANTICIPATED position, not their current one. Against a
  // moving player, mirroring where they stand aims into the space they are
  // already travelling toward; mirroring where they will be aims behind their
  // momentum, which is the whole point of wrong-footing.
  //
  // This branch previously ignored player velocity entirely — as did the
  // heatmap branch — so only the tactical branch (half the shots) wrong-footed
  // at all, and the whole-engine effect came out at ~3cm of mean aim shift.
  playerXZ = anticipatePlayerXZ(playerXZ, playerVelXZ);
  // Mirror the player's lateral position across center-table and add
  // gaussian noise. If the player is on their forehand side (x=0.4), aim
  // roughly at x=-0.4 with jitter. The z axis biases deep on a rally-speed
  // return; on a short retreat (player near net) we can occasionally drop
  // one short.
  const mirroredX = clamp(-playerXZ.x + gaussian01(rng) * 0.18, SAFE_X_MIN, SAFE_X_MAX);
  // Prefer deep targets when player is close to their end; short targets
  // are a change-of-pace bet.
  const wantsDeep = rng() < 0.75;
  const target_z = wantsDeep
    ? clamp(1.0 + gaussian01(rng) * 0.15, SAFE_Z_MIN, SAFE_Z_MAX)
    : clamp(0.35 + gaussian01(rng) * 0.10, SAFE_Z_MIN, SAFE_Z_MAX);
  return [mirroredX, target_z];
}

// Multiplicative bias: scale each candidate's weight by 1 + DIST_WEIGHT *
// (distance from playerXZ / MAX_TABLE_DIST). Candidates far from the
// player get boosted; nearby ones stay at baseline. Never zeroes a
// candidate out — struggle score still dominates when the two disagree.
//
// MAX_TABLE_DIST = 1.7 approximates the far-corner-to-far-corner span
// (x range 1.4 + z range 1.2 ~= diag 1.85, clipped to 1.7 for smoother
// scaling).
const OPPONENT_DIST_WEIGHT = 0.9;
const OPPONENT_MAX_TABLE_DIST = 1.7;
export function biasWeightsAwayFromPlayer(weights, seeds, playerXZ, playerVelXZ) {
  if (!playerXZ || !seeds || seeds.length === 0) return weights;
  // Distance is measured from where the player WILL be, so a struggle cell the
  // player is already moving toward stops looking far away. Same reasoning as
  // pickNeutralTargetAwayFromPlayer.
  playerXZ = anticipatePlayerXZ(playerXZ, playerVelXZ);
  const out = new Array(weights.length);
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (w <= 0) { out[i] = w; continue; }
    const s = seeds[i];
    const dx = s.x - playerXZ.x;
    const dz = s.z - playerXZ.z;
    const dist = Math.hypot(dx, dz);
    const scale = 1 + OPPONENT_DIST_WEIGHT * Math.min(1, dist / OPPONENT_MAX_TABLE_DIST);
    out[i] = w * scale;
  }
  return out;
}

// Top-K softening. With a high exploit factor + weightedCDF over ALL cells,
// an engine drifts into "same top cell every rally" once a weakness forms —
// which reads as robotic surveillance, not skilled play. Real strong players
// cycle among their top 2-3 target zones rather than hammering one. Keep only
// the top-K weights; zero everything else.
//
// Lives here rather than in pro.js because both tiers now need it: raising
// the international exploit factor to 0.85 gave this tier exactly the
// fixation problem Pro already had. pro.js imports it (pro.js → intermediate.js
// is the existing dependency direction; the reverse would be a cycle).
//
// Return a copy of `weights` where only the top-K largest positive values are
// kept; the rest are set to 0. Ties are broken by first-occurrence.
export function keepTopK(weights, k) {
  if (weights.length <= k) return weights.slice();
  // Find the k-th largest positive weight (partial-sort by scan; N is
  // <=15 so full sort is fine and simpler).
  const withIdx = [];
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] > 0) withIdx.push({ i, w: weights[i] });
  }
  withIdx.sort((a, b) => b.w - a.w);
  const keep = new Set(withIdx.slice(0, k).map(x => x.i));
  const out = new Array(weights.length);
  for (let i = 0; i < weights.length; i++) {
    out[i] = keep.has(i) ? weights[i] : 0;
  }
  return out;
}

// How many struggle cells the international tier cycles among. Pro uses the
// same K; the tiers differ in exploit factor, not in fixation.
const TOPK_LIMIT = 3;

function applyJitter(target, rng) {
  return [
    clamp(target[0] + gaussian01(rng) * TARGET_JITTER_SIGMA, SAFE_X_MIN, SAFE_X_MAX),
    clamp(target[1] + gaussian01(rng) * TARGET_JITTER_SIGMA, SAFE_Z_MIN, SAFE_Z_MAX),
  ];
}

// Spec §deliberate_imperfection_rules.no_instant_punishment_rule: wait 1-2
// rallies before exploiting a newly-detected weakness. Implemented here as
// a small per-engine counter that increments per ingestShot and resets when
// the top struggle cell changes — i.e., when a "new" weakness signal lands.
// Until the counter reaches the delay, exploit is suppressed (engine plays
// neutral as if it were below the min-shots threshold).
const INSTANT_PUNISH_DELAY_RALLIES = 2;

// Helper: identify the highest-scoring seed (after shrinkage), or null when
// there are no seeds. Used only for the new-weakness reset signal — the
// actual sampling still uses weightedCDF over all valid seeds.
function topSeedKey(shrunk) {
  if (shrunk.length === 0) return null;
  let bestKey = null;
  let bestScore = -Infinity;
  for (const s of shrunk) {
    if (s.shrunkScore > bestScore) {
      bestScore = s.shrunkScore;
      bestKey = `${s.x.toFixed(2)},${s.z.toFixed(2)}`;
    }
  }
  return bestKey;
}

export function createIntermediateEngine({ rng = Math.random } = {}) {
  // No-instant-punishment state — see comment above on
  // INSTANT_PUNISH_DELAY_RALLIES.
  let lastTopCellKey = null;
  let ralliesSinceTopChanged = INSTANT_PUNISH_DELAY_RALLIES; // start unfrozen
  // Ring buffer of shot types this engine has picked, for anti-repeat
  // pressure in shotTypeSelector.
  let recentTypes = [];
  // Ring buffer of tactical zone NAMES so the tactical picker can
  // dampen repeated picks of the same zone (variety of placement, not
  // just variety of type).
  let recentZones = [];
  const RECENT_ZONES_WINDOW = 3;

  function ingestShot(_shot, _history) {
    // Shot already pushed to history by the worker. Counter advances per
    // rally so we eventually resume exploiting after a delay.
    ralliesSinceTopChanged += 1;
  }

  function computeTarget(history, ctx) {
    const shots = history.getAll();

    // Always build the heatmap so we can detect a top-cell change even on
    // turns where we won't exploit. The buildSeeds → shrinkScores chain is
    // ~O(n log n) over <= 15 shots; cheap on the worker.
    const seeds = buildSeeds(shots);
    const filtered = filterByCellArea(seeds);
    const shrunk = shrinkScores(filtered);
    const topKey = topSeedKey(shrunk);
    if (topKey !== lastTopCellKey) {
      lastTopCellKey = topKey;
      ralliesSinceTopChanged = 0;
    }
    const punishmentHeld = ralliesSinceTopChanged < INSTANT_PUNISH_DELAY_RALLIES;

    // ctx.player_xz (spec coords) is fed by aiMatch from the current
    // player paddle world position at target-request time. Missing on
    // rally 1 or in unit tests — both paths (neutral + exploit) fall back
    // gracefully when it's absent.
    const playerXZ = ctx && ctx.player_xz;

    // Momentum scaling: winning streak → engine exploits more; losing
    // streak → plays it safe more often. Multiplier is 0.8–1.2× baseline.
    const exploitScale = (ctx && ctx.momentumScaleExploit) || 1.0;
    const effectiveExploit = Math.min(0.95, EXPLOIT_FACTOR * exploitScale);

    // Player kinematics for the tactical picker's wrong-footing model.
    // player_velocity_xz is optional (aiMatch feeds it when available).
    const playerVelXZ = ctx && ctx.player_velocity_xz;

    // Third-ball attack — highest-priority override. If the player's return
    // landed exactly where our serve was designed to force it (aiMatch has
    // already validated this), execute the pre-planned attack: fixed target +
    // forced shot type. Serve → forced weak return → planned attack is the
    // defining pattern of high-level table tennis.
    //
    // serve.js grants the plan to intermediate as well as pro, and aiMatch
    // computes the opportunity and logs "3rd-ball plan fires" to the HUD for
    // both — but only pro.js ever read ctx.thirdBallOpportunity, so at this
    // tier the HUD announced an attack that never happened and the engine
    // played an ordinary tactical shot.
    let target;
    let tacticalName = null;
    let forcedShotType = null;
    const thirdBall = ctx && ctx.thirdBallOpportunity;
    if (thirdBall) {
      target = [
        clamp(thirdBall.attackTargetX, SAFE_X_MIN, SAFE_X_MAX),
        clamp(thirdBall.attackTargetZ, SAFE_Z_MIN, SAFE_Z_MAX),
      ];
      forcedShotType = thirdBall.attackShotType;
    }

    // Tactical zone roll — overrides the neutral/exploit pick with a
    // curated "smart placement" (deep corner, wide, short drop, body
    // jam) INDEPENDENT of the player's own shot history. This is what
    // makes the AI feel like it's thinking about where to hit, not just
    // reflecting where the ball came from. Skipped when a third-ball plan
    // is firing.
    const tacticalProb = TACTICAL_PROBABILITY_BY_DIFFICULTY.intermediate;
    if (!target && rng() < tacticalProb) {
      const pick = pickTacticalTarget(rng, playerXZ, playerVelXZ, recentZones);
      if (pick) {
        target = [
          clamp(pick.target[0], SAFE_X_MIN, SAFE_X_MAX),
          clamp(pick.target[1], SAFE_Z_MIN, SAFE_Z_MAX),
        ];
        tacticalName = pick.name;
      }
    }

    if (!target) {
      if (shots.length < MIN_SHOTS_BEFORE_EXPLOIT ||
          punishmentHeld ||
          rng() >= effectiveExploit) {
        target = pickNeutralTargetAwayFromPlayer(rng, playerXZ, playerVelXZ);
      } else {
        const rawWeights = shrunk.map(s => Math.max(0, s.shrunkScore));
        const biased = biasWeightsAwayFromPlayer(rawWeights, shrunk, playerXZ, playerVelXZ);
        // Cycle among the top few struggle cells rather than hammering the
        // single worst one — see keepTopK.
        const weights = keepTopK(biased, TOPK_LIMIT);
        const idx = weightedSampleIndex(weights, rng);

        if (idx >= 0) {
          // Seeds ARE player-side landings of our own past shots, so the
          // chosen (x, z) is directly usable as this shot's target — same
          // frame, no conversion. The opponent-position bias applied above
          // already pushed us toward whichever historical struggle cell is
          // also far from where the player is standing now.
          const chosen = shrunk[idx];
          target = [
            clamp(chosen.x, SAFE_X_MIN, SAFE_X_MAX),
            clamp(chosen.z, SAFE_Z_MIN, SAFE_Z_MAX),
          ];
        } else {
          target = pickNeutralTargetAwayFromPlayer(rng, playerXZ, playerVelXZ);
        }
      }
    }
    if (tacticalName) {
      recentZones.push(tacticalName);
      if (recentZones.length > RECENT_ZONES_WINDOW) recentZones.shift();
    }

    target = applyJitter(target, rng);

    // Shot type first, then draw speed/spin from that type's profile.
    // ctx.incoming (built by aiMatch.js from shotAdapter's rollout) tells
    // the selector what the ball coming at us looks like — short/high/
    // spinny — so it can pick a plausible response instead of rolling a
    // uniform (speed, spin) tuple.
    const shotType = forcedShotType || selectShotType({
      difficulty: 'intermediate',
      incoming: ctx && ctx.incoming,
      recentTypes,
      rng,
      momentumBias: ctx && ctx.momentumBiasShotTypeWeights,
      matchState: ctx ? { score_margin: ctx.score_margin, score_total: ctx.score_total } : null,
      style: ctx && ctx.style,
      isServeReturn: ctx && ctx.isServeReturn,
      // Placement is already decided; the stroke must fit it.
      targetZ: target[1],
    });
    let { speed: target_speed, spin: target_spin, sideSpin: target_sidespin } = sampleShotParameters({
      shotType,
      difficulty: 'intermediate',
      rng,
    });
    // Momentum swing scale: loose swings when winning (harder ball) /
    // tight swings when losing (softer). Re-clamped INSIDE the difficulty
    // rail — pushing past it made the solver flag infeasible on tight
    // geometries, which produced honest misses that then triggered the
    // shaken multiplier and cascaded. Read from DIFFICULTY_CAPS rather than
    // hard-coded: this used to be a literal 9.0 and silently became a second
    // copy of the cap that PROFILE_OVERRIDES had already moved past.
    const swingScale = (ctx && typeof ctx.momentumSwingSpeedScale === 'number') ? ctx.momentumSwingSpeedScale : 1;
    // Deep targets can't carry full pace — the ball runs out of table. See
    // depthSpeedFactor; multiplicative so the shot keeps its identity.
    const depthScale = depthSpeedFactor(target[1]);
    const caps = DIFFICULTY_CAPS.intermediate;
    target_speed = Math.max(
      caps.minSpeed,
      Math.min(target_speed * swingScale * depthScale, caps.maxSpeed),
    );

    recentTypes.push(shotType);
    if (recentTypes.length > RECENT_TYPES_WINDOW) recentTypes.shift();

    // Spec wire field. Nothing consumes payload[4] — aiFSM reads indices
    // 0,1,2,3,5. Kept because removing it would renumber shotType across all
    // three engines, the FSM and the tests for no behavioural gain.
    const confidence = 1.0;
    // Payload element [5] carries the engine's picked shot type so the
    // FSM can telegraph the intended shot instead of reverse-labelling
    // from (speed, spin) — that reverse-labelling was destructive
    // (negative spin → SLICE regardless of speed, so PUSH never rendered).
    // [6] = signed sidespin rps (see sampleSideSpin).
    return [target[0], target[1], target_speed, target_spin, confidence, shotType,
            target_sidespin];
  }

  function reset() {
    lastTopCellKey = null;
    ralliesSinceTopChanged = INSTANT_PUNISH_DELAY_RALLIES;
    recentTypes = [];
    recentZones = [];
  }

  return { ingestShot, computeTarget, reset };
}
