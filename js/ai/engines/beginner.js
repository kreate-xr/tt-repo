// Beginner engine — plays REAL table tennis shots (push, block, occasional
// drive) drawn from the shared shot-type selector, but with beginner-tuned
// weights (heavy on push/block, almost never smashes/loops) and beginner
// caps (speed <= 5.5 m/s, spin <= 15 rps). A patient practice partner that
// keeps the ball in play with recognizable strokes.
//
// Before: Beginner emitted raw (speed, spin) uniformly from a narrow band
// with no shot-type semantics. The result was that the ball came back with
// the same neutral arc every time, indistinguishable from a ball machine —
// and no matter how much we improved Intermediate/Pro variety, Beginner
// felt like the same engine at a slower speed. Wiring it into the shot-
// type system means the AI now visibly picks between a push, a block, a
// drive — with the corresponding face angles, windups, and spin — but
// with beginner-scale execution.
//
// computeTarget returns the 6-element wire payload (same shape as Int/Pro
// after this change; downstream FSM already handles the extra shotType
// slot):
//   [target_x, target_z, target_speed_mps, target_spin_rps, confidence, shotType]

import {
  selectShotType, sampleShotParameters, depthSpeedFactor, DIFFICULTY_CAPS,
} from '../shotTypeSelector.js';
import {
  pickTacticalTarget,
  TACTICAL_PROBABILITY_BY_DIFFICULTY,
} from '../tacticalZones.js';

// Where a beginner's ORDINARY shots land — a narrow box around the middle,
// because beginners aim at "the table", not at a spot.
const TARGET_X_MIN = -0.55;
const TARGET_X_MAX =  0.55;
const TARGET_Z_MIN =  0.30;
const TARGET_Z_MAX =  1.10;
const X_JITTER_SIGMA = 0.32;

// Bounds for the rare (3%) tactical pick. Deliberately WIDER than the ordinary
// box — these are the full player-side safe-zone limits shared with the other
// engines.
//
// Clamping tactical picks into the narrow box above defeated their entire
// purpose: the zone catalog puts deep corners at x = ±0.60 and z = 1.15, and
// wide mid at ±0.65, so six of the twelve zones collapsed onto the clamp
// boundary — deep_wide_left and wide_left resolved to the SAME point. The one
// thing this branch exists to produce, an occasional accidental wide angle,
// was the one thing the clamp removed.
const TACTICAL_X_MIN = -0.7;
const TACTICAL_X_MAX =  0.7;
const TACTICAL_Z_MIN =  0.1;
const TACTICAL_Z_MAX =  1.3;

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

export function createBeginnerEngine({ rng = Math.random } = {}) {
  // Ring buffer of tactical zone names so occasional wide shots don't
  // repeat back-to-back.
  let recentZones = [];
  const RECENT_ZONES_WINDOW = 2;
  // Ring buffer of shot types, for anti-repeat pressure in the selector.
  let recentTypes = [];
  const RECENT_TYPES_WINDOW = 4;

  function ingestShot(_shot, _history) {
    // Beginner does not learn from shot history.
  }

  function computeTarget(_history, ctx) {
    // --- Target placement -------------------------------------------------
    const playerXZ = ctx && ctx.player_xz;
    const playerVelXZ = ctx && ctx.player_velocity_xz;
    let target_x, target_z;
    if (rng() < TACTICAL_PROBABILITY_BY_DIFFICULTY.beginner) {
      const pick = pickTacticalTarget(rng, playerXZ, playerVelXZ, recentZones);
      if (pick) {
        target_x = clamp(pick.target[0], TACTICAL_X_MIN, TACTICAL_X_MAX);
        target_z = clamp(pick.target[1], TACTICAL_Z_MIN, TACTICAL_Z_MAX);
        recentZones.push(pick.name);
        if (recentZones.length > RECENT_ZONES_WINDOW) recentZones.shift();
      }
    }
    if (target_x === undefined) {
      target_x = clamp(
        (TARGET_X_MIN + TARGET_X_MAX) / 2 + gaussian01(rng) * X_JITTER_SIGMA,
        TARGET_X_MIN,
        TARGET_X_MAX,
      );
      target_z = TARGET_Z_MIN + rng() * (TARGET_Z_MAX - TARGET_Z_MIN);
    }

    // --- Shot type + speed/spin -------------------------------------------
    // Same selector + sampler path as Intermediate/Pro, with the
    // beginner-tuned BASE_TYPE_WEIGHTS and DIFFICULTY_CAPS. Anti-repeat
    // and incoming-ball bias fire the same way — Beginner now visibly
    // picks a push vs a block vs a drive, with face angles and windups
    // that read as different strokes.
    const shotType = selectShotType({
      difficulty: 'beginner',
      incoming: ctx && ctx.incoming,
      recentTypes,
      rng,
      momentumBias: ctx && ctx.momentumBiasShotTypeWeights,
      matchState: ctx ? { score_margin: ctx.score_margin, score_total: ctx.score_total } : null,
      style: ctx && ctx.style,
      isServeReturn: ctx && ctx.isServeReturn,
      // Placement is already decided; the stroke must fit it.
      targetZ: target_z,
    });
    const { speed: rawSpeed, spin: target_spin } = sampleShotParameters({
      shotType,
      difficulty: 'beginner',
      rng,
    });
    // Deep targets can't carry full pace — see depthSpeedFactor. Beginner
    // speeds rarely strain the envelope, but applying it here keeps all three
    // engines on one rule rather than leaving a silent exception.
    //
    // The minSpeed rail matters after scaling: a slow touch shot aimed deep
    // would otherwise scale to under 1 m/s, which will not even carry the net.
    // Intermediate and Pro already clamp here; Beginner previously did not.
    //
    // momentumSwingSpeedScale is applied here too. Beginner already consumes
    // the momentum SHOT-TYPE bias (above) but silently dropped the swing-speed
    // half, so a beginner on a confidence streak picked bolder shots and then
    // hit them at exactly the same pace — the visible half of momentum was
    // missing at the one tier where nerves should read most clearly.
    const swingScale = (ctx && typeof ctx.momentumSwingSpeedScale === 'number')
      ? ctx.momentumSwingSpeedScale
      : 1;
    const caps = DIFFICULTY_CAPS.beginner;
    const target_speed = Math.max(
      caps.minSpeed,
      rawSpeed * swingScale * depthSpeedFactor(target_z),
    );
    recentTypes.push(shotType);
    if (recentTypes.length > RECENT_TYPES_WINDOW) recentTypes.shift();

    // Spec wire field. Nothing consumes payload[4] — aiFSM reads indices
    // 0,1,2,3,5. Kept because removing it would renumber shotType across all
    // three engines, the FSM and the tests for no behavioural gain.
    const confidence = 1.0;
    // 6-element payload (matches Int/Pro shape). Payload[5] carries the
    // picked shot type so the FSM's telegraph pipeline can render the
    // stroke visually.
    return [target_x, target_z, target_speed, target_spin, confidence, shotType];
  }

  function reset() {
    recentZones = [];
    recentTypes = [];
  }

  return { ingestShot, computeTarget, reset };
}
