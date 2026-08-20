// Deliberate imperfection — the rules that make the AI feel human instead
// of robotic. Spec §imperfection_design and §deliberate_imperfection_rules.
//
// Per the spec, this is "the single hardest part of human-feel AI" — the
// numeric constants here are starting values, NOT final values. Tuning
// requires 2-3 weeks of headset playtests (the explicit budget in
// §build_phases.phase_5_imperfection_tuning). Treat anything pinned in
// this file as a hypothesis; the headset is the oracle.
//
// What this module owns:
//   - spec-stated probabilities and distributions
//   - pure stateless helpers (RNG-driven), so the FSM can call them with
//     deterministic test seeds when needed
//   - applyMissToIntent: mutates an intent object in place to inject the
//     chosen miss cause. Called from aiFSM.onTargetReceived BEFORE the
//     commitment lock fires, so the miss is "honestly committed to" —
//     the AI then plays out a bad swing without realising.
//
// Weight-shift lag (spec §deliberate_imperfection_rules.weight_shift_lag_ms
// = 80ms) is NOT implemented yet. The integration spec drops the humanoid
// skeleton, leaving us with paddle + arm + wrist primitives. There's no
// separate body root to lag against arm motion. Re-evaluate once the arm
// rig grows enough joints for the lag to read on screen.

import * as THREE from 'three';

// Spec §deliberate_imperfection_rules. Original spec values (15/8/3) felt
// too clean at Beginner; the first pass overshot to (22/12/6) which
// combined with the shaken multiplier below caused visible miss cascades
// on routine returns. Landed at (18/10/4) — a modest bump above spec that
// reads as "sometimes shanks a routine ball" without spiraling.
// Re-tuned down for the higher tiers alongside the international re-tune:
// international per-stroke error rates are roughly 3-6%, not 10%.
//
// This is a BASE rate — see scaleMissRateForSituation below, which is what
// actually reads as a real player. A flat probability makes the AI shank
// balls it was perfectly positioned for and nail balls it had no business
// reaching; real errors track how stretched, rushed and spun-up you are.
// Beginner dropped 0.18 → 0.12 for the long-rally retune: at 0.18 with the
// situational multipliers on top, the AI donated a point every ~5 of its own
// shots, so rallies died before they developed. CLUB is the practice-partner
// tier — its job is to keep the ball alive; the player should win points by
// beating it, not by waiting for it. 0.12 still misses visibly more than the
// upper tiers, and hard balls still push it toward 4x via
// scaleMissRateForSituation.
export const MISS_RATE_BY_DIFFICULTY = Object.freeze({
  beginner: 0.12,
  intermediate: 0.05,
  pro: 0.03,
});

// Nerves — after an INJECTED miss (chose a bad shot / mistimed), real
// players are shaken for the next couple of shots. Honest misses
// (unreachable / physical fail) do NOT trigger this; those are external,
// not psychological. Multiplier on base miss rate that decays over the
// next N shots. 1.15 = +15% miss chance on the following shot; back to
// 1.00 after SHAKEN_SHOTS. Modest so a single miss doesn't chain into a
// 3-shanks-in-a-row cascade.
export const SHAKEN_MULTIPLIER = 1.15;
export const SHAKEN_SHOTS = 2;

export const MISS_CAUSE_DISTRIBUTION = Object.freeze({
  stretched_too_far: 0.40,
  mistimed_swing:    0.30,
  spin_misread:      0.20,
  general_inaccuracy: 0.10,
});

export const MISS_CAUSES = Object.freeze({
  STRETCHED_TOO_FAR:  'stretched_too_far',
  MISTIMED_SWING:     'mistimed_swing',
  SPIN_MISREAD:       'spin_misread',
  GENERAL_INACCURACY: 'general_inaccuracy',
});

// Spec §deliberate_imperfection_rules.wasted_half_step_*.
export const WASTED_STEP_PROBABILITY = 0.30;
// Spec: "Only when time budget allows (>500ms)" — under 500ms there isn't
// time to commit + correct without missing.
export const WASTED_STEP_MIN_TIME_TO_CONTACT_MS = 500;
// Offset magnitude — spec says 5-15cm. Picked at sample time per call.
const WASTED_STEP_MIN_M = 0.05;
const WASTED_STEP_MAX_M = 0.15;
// How long the AI "commits to the wrong direction" before correcting.
// Spec is silent on duration; ~120ms reads as a believable false-start
// without enough time to actually mis-position into a miss.
export const WASTED_STEP_DURATION_MS = 120;

// Spec §deliberate_imperfection_rules.no_instant_punishment_rule:
// "wait 1-2 rallies before exploiting it". 2 = lower bound on the safe
// side; tunable in playtests.
export const INSTANT_PUNISH_DELAY_RALLIES = 2;

// Miss-cause offset magnitudes (meters / ms). Picked to land within the
// spec's "honest miss" intent: deviations big enough to land outside the
// existing ±5cm IK correction budget so the host's collision physics
// produces a genuine miss, but not so big the miss looks teleport-y.
const STRETCHED_MIN_M = 0.08;
const STRETCHED_MAX_M = 0.15;
const MISTIME_MIN_MS = 50;
const MISTIME_MAX_MS = 100;
const INACCURACY_MIN_M = 0.03;
const INACCURACY_MAX_M = 0.07;
// Face-angle error for a spin misread, in radians (~2.9° to ~9.2°). A face
// error deflects the outgoing ball by roughly twice the tilt, so ~6° puts the
// ball ~25cm off over a 2.5m flight — comfortably outside the ±5cm IK
// correction budget, so the host's collision physics produces a genuine miss,
// while staying small enough that the stroke still looks like the stroke.
const SPIN_MISREAD_MIN_RAD = 0.05;
const SPIN_MISREAD_MAX_RAD = 0.16;
// Incoming spin (rps) at which the misread reaches its full magnitude.
const SPIN_MISREAD_REFERENCE_RPS = 25;

// --- RNG helpers ----------------------------------------------------------

function _r(rng, lo, hi) { return lo + rng() * (hi - lo); }
function _randomXZ(rng, mag, out) {
  const a = rng() * Math.PI * 2;
  out.x = Math.cos(a) * mag;
  out.y = 0;
  out.z = Math.sin(a) * mag;
  return out;
}

// --- Public helpers -------------------------------------------------------

export function shouldInjectMiss(missRate, rng = Math.random) {
  return rng() < missRate;
}

// --- Situational miss scaling ---------------------------------------------
//
// A flat per-shot miss probability is the single biggest reason the AI reads
// as a machine rather than a player. It shanks balls it was perfectly
// positioned for and nails balls it had no business reaching, because nothing
// about the shot's difficulty enters the dice roll.
//
// Real errors track how hard the shot actually was. Three factors, all of
// which the FSM has already computed by the time it rolls:
//
//   reachFactor  requiredAvgSpeed / footworkSpeed, from checkReachability.
//                At/above 1 the AI is at full stretch. This is the dominant
//                term — most real errors are positional.
//   timeToContact  a rushed shot is a worse shot.
//   incomingSpin   heavy spin is harder to read and to counter.
//
// Multipliers are deliberately bounded so a comfortable ball can't reach zero
// error (even elite players shank easy balls) and a desperate lunge can't
// exceed a sane ceiling — an honest miss via the reachability gate already
// covers genuinely impossible balls.
export const SITUATION_MIN_MULT = 0.5;
export const SITUATION_MAX_MULT = 4.0;
// Reach at or below this fraction of the footwork budget is "comfortable".
// Used by sampleMissCause to decide whether "stretched too far" is a plausible
// excuse; the miss-rate curve below uses its own shape.
const REACH_COMFORTABLE = 0.5;

// Reach → miss-rate multiplier curve. Monotonic and strictly positive, which
// matters: the three situational terms are multiplied together, so any term
// that can reach zero or below silently cancels the others.
//   reachFactor  0.00  0.30  0.50  0.75  1.00  1.20
//   multiplier   0.50  0.56  0.72  1.12  1.77  2.50
const REACH_MAX_FACTOR = 1.2;   // beyond this the AI is scrambling anyway
const REACH_MIN_MULT   = 0.5;
const REACH_MAX_MULT   = 2.5;
const REACH_EXPONENT   = 2.5;   // flat at the easy end, steep near full stretch
// Below this many ms to contact the AI is rushed.
const RUSHED_MS = 350;
const RUSHED_MAX_MULT = 1.6;
// Incoming spin (rps) at which the spin term reaches its full effect.
const SPIN_REFERENCE_RPS = 25;
const SPIN_MAX_MULT = 1.5;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Scale a base miss rate by how hard this specific shot is.
// All fields optional — an absent factor contributes 1.0, so callers that
// don't have a value yet degrade to the old flat behaviour rather than
// silently biasing the result.
export function scaleMissRateForSituation(baseRate, {
  reachFactor,
  timeToContactMs,
  incomingSpinRps,
} = {}) {
  let mult = 1;

  if (typeof reachFactor === 'number' && Number.isFinite(reachFactor)) {
    // Power curve from REACH_MIN_MULT to REACH_MAX_MULT across the reach
    // range. Flat near the bottom (being very well positioned is not much
    // better than being comfortably positioned) and steep near full stretch.
    //
    // This was previously `1 + clamp(t, -1, 1.4) * 1.5` with t centred on
    // REACH_COMFORTABLE, which went NEGATIVE below reachFactor 1/3 (−0.5 at
    // 0). A negative multiplier stays negative through the rush and spin
    // terms and then clamps to SITUATION_MIN_MULT, so both of those factors
    // were silently discarded for any well-positioned shot — measured: a ball
    // arriving in 60ms with 40 rps of spin scored exactly the same as a slow
    // flat one (ratio 1.00x). Well-positioned is the COMMON case, so that was
    // most of the shots the mechanism was supposed to be reasoning about.
    const t = clamp(reachFactor, 0, REACH_MAX_FACTOR) / REACH_MAX_FACTOR;
    mult *= REACH_MIN_MULT + (REACH_MAX_MULT - REACH_MIN_MULT) * Math.pow(t, REACH_EXPONENT);
  }

  if (typeof timeToContactMs === 'number' && Number.isFinite(timeToContactMs) && timeToContactMs < RUSHED_MS) {
    const rush = 1 - clamp(timeToContactMs, 0, RUSHED_MS) / RUSHED_MS;
    mult *= 1 + rush * (RUSHED_MAX_MULT - 1);
  }

  if (typeof incomingSpinRps === 'number' && Number.isFinite(incomingSpinRps)) {
    const s = clamp(Math.abs(incomingSpinRps) / SPIN_REFERENCE_RPS, 0, 1);
    mult *= 1 + s * (SPIN_MAX_MULT - 1);
  }

  return clamp(baseRate * clamp(mult, SITUATION_MIN_MULT, SITUATION_MAX_MULT), 0, 1);
}

// Weighted CDF over the spec distribution. Returns one of MISS_CAUSES.
//
// When `reachFactor` is supplied, STRETCHED_TOO_FAR is only eligible if the
// AI was actually stretched. Picking "stretched too far" from a fixed 40%
// slice while the AI stood comfortably at the ball is the tell that the miss
// was scripted; the remaining causes are re-normalised over the leftover
// probability so the distribution still sums to 1.
export function sampleMissCause(rng = Math.random, { reachFactor } = {}) {
  const stretchedPlausible = typeof reachFactor !== 'number'
    || !Number.isFinite(reachFactor)
    || reachFactor >= REACH_COMFORTABLE;

  const causes = Object.keys(MISS_CAUSE_DISTRIBUTION)
    .filter(c => stretchedPlausible || c !== MISS_CAUSES.STRETCHED_TOO_FAR);

  let total = 0;
  for (const c of causes) total += MISS_CAUSE_DISTRIBUTION[c];
  if (total <= 0) return MISS_CAUSES.GENERAL_INACCURACY;

  const r = rng() * total;
  let cum = 0;
  for (const cause of causes) {
    cum += MISS_CAUSE_DISTRIBUTION[cause];
    if (r < cum) return cause;
  }
  // Float drift fallback — last cause.
  return MISS_CAUSES.GENERAL_INACCURACY;
}

export function shouldWasteHalfStep(timeToContactMs, rng = Math.random) {
  if (timeToContactMs < WASTED_STEP_MIN_TIME_TO_CONTACT_MS) return false;
  return rng() < WASTED_STEP_PROBABILITY;
}

// Returns a vector representing the wrong-direction step. Caller should
// add it to the AI's interception target for ~WASTED_STEP_DURATION_MS,
// then drop it so the paddle corrects back.
export function wastedStepOffsetVec(rng = Math.random, out = new THREE.Vector3()) {
  const mag = _r(rng, WASTED_STEP_MIN_M, WASTED_STEP_MAX_M);
  return _randomXZ(rng, mag, out);
}

// Mutates `intent` to encode the chosen miss. Called from aiFSM
// onTargetReceived BEFORE the commitment lock fires — once committed, the
// AI plays out the bad swing.
//
// intent is expected to expose:
//   predictedContact: THREE.Vector3 (world)
//   predictedContactPerfMs: number
//   shotType: string (one of SHOT_TYPES)
// The function sets:
//   intent.willMiss = true
//   intent.missCause = cause
// And applies cause-specific mutations to predictedContact / time / shotType.
export function applyMissToIntent(intent, cause, rng = Math.random) {
  intent.willMiss = true;
  intent.missCause = cause;

  switch (cause) {
    case MISS_CAUSES.STRETCHED_TOO_FAR: {
      const mag = _r(rng, STRETCHED_MIN_M, STRETCHED_MAX_M);
      const off = _randomXZ(rng, mag, _tmpVec);
      intent.predictedContact.x += off.x;
      intent.predictedContact.z += off.z;
      break;
    }
    case MISS_CAUSES.MISTIMED_SWING: {
      const sign = rng() < 0.5 ? -1 : 1;
      intent.predictedContactPerfMs += sign * _r(rng, MISTIME_MIN_MS, MISTIME_MAX_MS);
      break;
    }
    case MISS_CAUSES.SPIN_MISREAD: {
      // Misjudge the face angle, keeping the stroke. This used to swap
      // shotType for a uniformly random other type, which could turn a push
      // into a smash — that is not a spin misread, it is a different shot.
      // A real misread is the same stroke played with the bat too open or
      // too closed: the ball sails long or drops into the net.
      //
      // Tilt the face about the horizontal axis lying in the face plane, so
      // only the elevation of the outgoing ball changes. Magnitude scales
      // with how much spin there was to misjudge — heavy spin is misread by
      // more than a near-dead ball.
      //
      // The sign is random: over-opening and over-closing are both genuine
      // misreads and both produce a miss, and picking the "wrong" one would
      // require assuming a spin sign convention the solver owns.
      const n = intent.solverFaceNormal;
      if (n && typeof n.applyAxisAngle === 'function') {
        const spinMag = intent.predictedContactBallSpin
          ? intent.predictedContactBallSpin.length() / (2 * Math.PI)
          : 0;
        const t = Math.min(1, spinMag / SPIN_MISREAD_REFERENCE_RPS);
        const angle = (SPIN_MISREAD_MIN_RAD
          + t * (SPIN_MISREAD_MAX_RAD - SPIN_MISREAD_MIN_RAD))
          * (rng() < 0.5 ? -1 : 1);

        // Horizontal axis in the face plane = up x normal. Degenerate only
        // when the face points straight up/down, which the solver never
        // produces; fall back to world X so the tilt still happens.
        _tmpAxis.set(0, 1, 0).cross(n);
        if (_tmpAxis.lengthSq() < 1e-8) _tmpAxis.set(1, 0, 0);
        _tmpAxis.normalize();
        n.applyAxisAngle(_tmpAxis, angle).normalize();
      }
      break;
    }
    case MISS_CAUSES.GENERAL_INACCURACY:
    default: {
      const mag = _r(rng, INACCURACY_MIN_M, INACCURACY_MAX_M);
      const off = _randomXZ(rng, mag, _tmpVec);
      intent.predictedContact.x += off.x;
      intent.predictedContact.z += off.z;
      break;
    }
  }
}

// Module-scope temps avoid per-call allocation in applyMissToIntent.
const _tmpVec = new THREE.Vector3();
const _tmpAxis = new THREE.Vector3();
