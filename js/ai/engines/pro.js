// Pro engine — same Voronoi-heatmap targeting as Intermediate, with a higher
// exploit factor and the Pro ball-parameter ranges. Spec
// §ai_worker_design.engines.pro.
//
// Reuses Intermediate's pure helpers (buildSeeds, shrinkScores,
// filterByCellArea, weightedSampleIndex, keepTopK) so the math is auditable in
// one place. What actually separates Pro from Intermediate:
//
//   1. Targeting KIND. Pro routes more shots through the struggle heatmap and
//      fewer through generic tactical zones (exploit 0.95 / tactical 0.42, vs
//      0.85 / 0.50) — personalised punishment rather than good placement.
//   2. Pace. PROFILE_OVERRIDES.pro is ~1.12x Intermediate on attacking strokes
//      (smash 24.6 m/s mean vs 22.0) and carries wider spin bounds.
//   3. Tempo mixing — Pro alone deliberately breaks its own rhythm
//      (shotTypeSelector.applyProTempoMixing).
//   4. The disguised-shot telegraph and the anticipatory ready-pose bias,
//      both gated to 'pro' in the embodiment layer.
//   5. Faster footwork, lower base miss rate, longer recovery window.
//
// This list previously claimed "two differences", quoting exploit 0.85 vs 0.5
// and ball ranges of [7,12] m/s / [-30,30] rps. None of those numbers exist
// anywhere in the code any more.
//
// The "disguised serve" hook (spec: paddle telegraph implies one spin, late
// wrist applies another) is an EMBODIMENT-layer concern — the decision
// layer just emits a target. The FSM applies the disguise when difficulty
// === 'pro'. See aiFSM.js for that wiring.
//
// LSTM anticipate-and-counter is explicitly deferred to v2 per spec
// §build_phases.phase_6_v2_deferred.

import {
  buildSeeds, shrinkScores, filterByCellArea, weightedSampleIndex,
  biasWeightsAwayFromPlayer, pickNeutralTargetAwayFromPlayer, keepTopK,
} from './intermediate.js';
import {
  selectShotType, sampleShotParameters, DIFFICULTY_CAPS, depthSpeedFactor,
} from '../shotTypeSelector.js';
import {
  pickTacticalTarget,
  TACTICAL_PROBABILITY_BY_DIFFICULTY,
} from '../tacticalZones.js';

// Same no-instant-punishment delay as Intermediate. Spec doesn't carve out
// a separate value for Pro — the rule is "wait 1-2 rallies before
// exploiting" regardless of difficulty (intent: feel like recognition, not
// surveillance).
const INSTANT_PUNISH_DELAY_RALLIES = 2;

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

// Spec §accuracy_guardrails — same pinned values as Intermediate.
const MIN_SHOTS_BEFORE_EXPLOIT = 5;
const TARGET_JITTER_SIGMA = 0.08;

// Spec §ai_worker_design.engines.pro.
//
// Raised to 0.95, and the tactical rate dropped to 0.42 (tacticalZones.js), to
// fix an inversion: tactical placement and heatmap exploit are alternatives,
// so the share of shots that actually punish a demonstrated weakness is
// (1 - tacticalProb) x exploitFactor. With pro at tactical 0.55 / exploit 0.92
// that was 0.414 against intermediate's 0.425 — Pro was targeting the player's
// weak zones LESS often than the tier below it.
//
// The tiers now differ in KIND, not just degree:
//   intermediate  more generic good placement  (tactical 0.50, heatmap 0.43)
//   pro           more personalised punishment (tactical 0.42, heatmap 0.55)
// which reads as "the elite player has worked you out", not merely "more".
const EXPLOIT_FACTOR = 0.95;

// Saturation ceiling for exploit after momentum scaling. Intermediate caps at
// 0.95; Pro needs headroom above its own base or the momentum multiplier would
// be inert, and under exactly the conditions where exploit matters most (hot
// streak, or trailing) the two tiers would collapse to the same number.
const EXPLOIT_CEILING = 0.98;

// Top-K softening — see keepTopK in intermediate.js, which now shares this
// with the international tier since both run a high exploit factor.
const PRO_TOPK_LIMIT = 3;

// Recent-type buffer window for anti-repeat + tempo mixing in
// shotTypeSelector. Pro reads a 2-shot window for tempo mixing; the
// buffer keeps a bit more headroom.
const RECENT_TYPES_WINDOW = 4;

// Same safe zone (player side) as Intermediate.
const SAFE_X_MIN = -0.7;
const SAFE_X_MAX =  0.7;
const SAFE_Z_MIN =  0.1;
const SAFE_Z_MAX =  1.3;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function gaussian01(rng) {
  let u, v, s;
  do {
    u = rng() * 2 - 1;
    v = rng() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  return u * Math.sqrt(-2 * Math.log(s) / s);
}

function applyJitter(target, rng) {
  return [
    clamp(target[0] + gaussian01(rng) * TARGET_JITTER_SIGMA, SAFE_X_MIN, SAFE_X_MAX),
    clamp(target[1] + gaussian01(rng) * TARGET_JITTER_SIGMA, SAFE_Z_MIN, SAFE_Z_MAX),
  ];
}

export function createProEngine({ rng = Math.random } = {}) {
  let lastTopCellKey = null;
  let ralliesSinceTopChanged = INSTANT_PUNISH_DELAY_RALLIES;
  // Ring buffer of shot types picked, drives Pro's tempo mixing in
  // shotTypeSelector — two fast shots trigger a touch, two soft touches
  // trigger a drive/smash.
  let recentTypes = [];
  // Ring buffer of tactical zone NAMES for the placement variety picker.
  let recentZones = [];
  const RECENT_ZONES_WINDOW = 4;

  function ingestShot(_shot, _history) {
    ralliesSinceTopChanged += 1;
  }

  function computeTarget(history, ctx) {
    const shots = history.getAll();

    const seeds = buildSeeds(shots);
    const filtered = filterByCellArea(seeds);
    const shrunk = shrinkScores(filtered);
    const topKey = topSeedKey(shrunk);
    if (topKey !== lastTopCellKey) {
      lastTopCellKey = topKey;
      ralliesSinceTopChanged = 0;
    }
    const punishmentHeld = ralliesSinceTopChanged < INSTANT_PUNISH_DELAY_RALLIES;

    // Same opponent-position awareness as Intermediate. ctx.player_xz is
    // spec coords from aiMatch. Pro applies the bias more aggressively via
    // top-K sampling below.
    const playerXZ = ctx && ctx.player_xz;

    // Same momentum scaling as Intermediate. Pro's baseline exploit is already
    // high (0.95); the 0.8–1.2× multiplier is clamped at EXPLOIT_CEILING (0.98)
    // so we never guarantee exploit — a small chance to break pattern has to
    // survive, or the targeting reads as surveillance rather than as skill.
    const exploitScale = (ctx && ctx.momentumScaleExploit) || 1.0;
    const effectiveExploit = Math.min(EXPLOIT_CEILING, EXPLOIT_FACTOR * exploitScale);

    const playerVelXZ = ctx && ctx.player_velocity_xz;

    // Third-ball attack — highest-priority override. If the player's
    // return landed exactly where our serve was designed to force it
    // (aiMatch has already validated this), execute the pre-planned
    // attack: fixed target + forced shot type. This is what makes Pro
    // serves feel WEAPONIZED instead of just cosmetically different.
    let target;
    let tacticalName = null;
    const thirdBall = ctx && ctx.thirdBallOpportunity;
    let forcedShotType = null;
    if (thirdBall) {
      target = [
        clamp(thirdBall.attackTargetX, SAFE_X_MIN, SAFE_X_MAX),
        clamp(thirdBall.attackTargetZ, SAFE_Z_MIN, SAFE_Z_MAX),
      ];
      forcedShotType = thirdBall.attackShotType;
    }

    // Tactical zone roll — 42% of shots take a curated smart-placement zone
    // instead of the heatmap or neutral mix. Deliberately LOWER than
    // Intermediate's 50%: tactical and heatmap are alternatives, so routing
    // fewer shots here is what gives Pro the higher personalised-punishment
    // share. Skipped when a third-ball plan is firing.
    if (!target) {
      const tacticalProb = TACTICAL_PROBABILITY_BY_DIFFICULTY.pro;
      if (rng() < tacticalProb) {
        const pick = pickTacticalTarget(rng, playerXZ, playerVelXZ, recentZones);
        if (pick) {
          target = [
            clamp(pick.target[0], SAFE_X_MIN, SAFE_X_MAX),
            clamp(pick.target[1], SAFE_Z_MIN, SAFE_Z_MAX),
          ];
          tacticalName = pick.name;
        }
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
        // Top-K softening (see PRO_TOPK_LIMIT above) prevents Pro from locking
        // onto a single top cell across many rallies once a weakness is
        // detected. Zero out everything below the top-K threshold, then
        // sample proportionally within the top-K.
        const weights = keepTopK(biased, PRO_TOPK_LIMIT);
        const idx = weightedSampleIndex(weights, rng);

        if (idx >= 0) {
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
    // Pro's selector adds tempo-mixing pressure (after two fast shots it
    // biases toward a touch, and vice versa) — that's what makes Pro
    // feel like a real player varying pace instead of the old
    // "uniform-in-a-fast-range" hammer.
    // Third-ball plan forces the shot type; otherwise normal selection.
    const shotType = forcedShotType || selectShotType({
      difficulty: 'pro',
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
    let { speed: target_speed, spin: target_spin } = sampleShotParameters({
      shotType,
      difficulty: 'pro',
      rng,
    });
    // Momentum swing scale — see intermediate.js. Stay INSIDE the difficulty
    // rail so the solver doesn't flag infeasibility. The visible momentum
    // effect comes from the low end (losing → softer swings) and from the
    // shot-type bias, not from smashing through difficulty ceilings.
    const swingScale = (ctx && typeof ctx.momentumSwingSpeedScale === 'number') ? ctx.momentumSwingSpeedScale : 1;
    // Deep targets can't carry full pace — see depthSpeedFactor.
    const depthScale = depthSpeedFactor(target[1]);
    const caps = DIFFICULTY_CAPS.pro;
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
    // Payload [5] = engine's picked shot type. See intermediate.js for
    // rationale (reverse-labelling from speed/spin lost PUSH into SLICE
    // and misclassified LOOP/DRIVE at boundary spins).
    return [target[0], target[1], target_speed, target_spin, confidence, shotType];
  }

  function reset() {
    lastTopCellKey = null;
    ralliesSinceTopChanged = INSTANT_PUNISH_DELAY_RALLIES;
    recentTypes = [];
    recentZones = [];
  }

  return { ingestShot, computeTarget, reset };
}
