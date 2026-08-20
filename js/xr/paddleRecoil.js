// Impact recoil — the post-hit "the ball has mass" cue, expressed as a
// rotation about the hand instead of a translation of the whole bat.
//
// Why this is not a translation: the original implementation displaced
// paddleAnchor.position by up to 12 mm along -contactNormal for ~130 ms after
// every hit. A held object cannot translate relative to the hand holding it,
// so the eye reads that as the paddle coming loose from the grip — the exact
// "doesn't feel like one real paddle welded to my hand" artifact. It also put
// the rendered paddle 12 mm from the true grip pose, past the 1 cm
// contact-visual agreement budget.
//
// What a real paddle does at impact: the blade decelerates, the handle pivots
// in the palm, and the contact point in the hand stays put. So we rotate the
// whole rigid pose about the grip pivot. The point at the hand is a fixed
// point of that rotation (displacement exactly zero), while the blade tip
// kicks back by the same magnitude the translation used to produce. Same
// perceptual cue, physically honest, no detachment.
//
// Rigidity is preserved either way: the rotation is applied to the single
// paddleAnchor pose that BOTH the mesh and the physics tick read, so visual
// and collision stay identical to the frame (see xrPaddle.js).
//
// --- Why the numbers below are much smaller than they used to be -------------
//
// Rotating about the grip fixed the DETACHMENT artifact (nothing slides out of
// the hand) but not the BUDGET one, and the first version of this module traded
// one for the other without noticing. RECOIL_PEAK_M is a displacement AT THE
// FACE; at 12 mm on a ~115 mm grip→face lever that is a 6° swing of the blade,
// every hard hit, while the player's real hand did not rotate at all. A fixed
// point at the hand with a blade swinging around it is, kinematically, a HINGE
// AT THE HAND — so the bat read as snapped at the throat and hanging on. The
// old "1 cm agreement" test did not catch this because it measured displacement
// at the pivot, which is a fixed point by construction and therefore always
// zero. The face is what the player looks at and hits with, so the face is what
// the budget has to bind. It now does, via RECOIL_FACE_BUDGET_M.
//
// The envelope was wrong in the same direction: it started at 1, so the full
// kick appeared in a single frame and then glided back. An impulse can step
// angular VELOCITY; it can never step an ANGLE. Snap-then-glide is the
// signature of something elastically failing. A rigid bat struck by a ball
// starts at zero deflection, swings to a peak as the grip loads up, and is
// restored — which is what the attack/decay shape below produces.
//
// Perceived mass does not live here anyway: physics/paddleWeight.js ranks the
// channels that carry heft as (1) ball response, (2) haptics, (3) audio, with
// visual a distant fourth, and disables pseudo-inertia outright for exactly
// this reason. This is a garnish. Set RECOIL_PEAK_M to 0 to remove it entirely.

import * as THREE from 'three';

// Peak blade-face kick-back distance, in meters, at or above RECOIL_MAX_SPEED.
// Expressed at the face (not as an angle) so tuning reads as "how far does the
// blade visibly move"; the angle is derived from the actual lever length.
// 3 mm ≈ 1.5° on the live rig — under the threshold at which the eye reads
// hand/blade disagreement as a compliant joint, and well inside the budget.
// Set to 0 to disable recoil entirely.
export const RECOIL_PEAK_M = 0.003;
export const RECOIL_DURATION = 0.13;   // seconds; rise, peak, decay to zero
export const RECOIL_MAX_SPEED = 8.0;   // m/s at which the peak saturates

// Hard ceiling on face displacement, applied after every scale factor (speed,
// blade weight). The contact-visual agreement budget is 1 cm; this keeps the
// rendered face inside it with margin no matter how the multipliers stack.
export const RECOIL_FACE_BUDGET_M = 0.008;

// Fraction of the window spent rising to the peak. ~23 ms at 130 ms — about
// two frames at 90 Hz, enough that the onset reads as a swing rather than a
// pose discontinuity, short enough to still feel struck rather than pushed.
export const RECOIL_ATTACK_FRAC = 0.18;

// Impulse-response envelope: 0 at t=0, peak 1 at RECOIL_ATTACK_FRAC of the
// window, 0 at RECOIL_DURATION and beyond. Sine rise into cosine decay, so the
// two halves meet with matching zero slope and the peak has no corner in it.
// `elapsed` in seconds since the impact.
export function recoilEnvelope(elapsed) {
  if (!(elapsed >= 0)) return 0;
  const t = elapsed / RECOIL_DURATION;
  if (t >= 1) return 0;
  const a = RECOIL_ATTACK_FRAC;
  if (t < a) return Math.sin((t / a) * Math.PI * 0.5);
  return Math.cos(((t - a) / (1 - a)) * Math.PI * 0.5);
}

// Peak magnitude for an impact, scaled by speed and saturating at
// RECOIL_MAX_SPEED.
//
// `weightScale` is the blade-weight multiplier from
// physics/paddleWeight.js:recoilWeightScale() — a heavier bat pivots further
// in a relaxed grip, so it visibly kicks more. Defaults to 1 (neutral blade),
// which keeps this a pure function of impact speed as before. Passed in rather
// than imported so this module stays free of physics-module coupling.
export function recoilPeakForImpact(impactSpeed, weightScale = 1) {
  if (!(impactSpeed > 0)) return 0;
  const s = weightScale > 0 ? weightScale : 1;
  const peak = RECOIL_PEAK_M * Math.min(impactSpeed / RECOIL_MAX_SPEED, 1.0) * s;
  // Budget clamp is last: a heavy blade (weightScale up to 1.2) on a smash must
  // not be able to walk the rendered face past the agreement bound.
  return Math.min(peak, RECOIL_FACE_BUDGET_M);
}

const _lever = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _rel = new THREE.Vector3();

/**
 * Rotate a rigid pose (ioPos, ioQuat) about `pivot` so that the point at
 * `faceCenter` moves `displacement` meters along the component of `recoilDir`
 * perpendicular to the pivot→face lever. `pivot` is a fixed point of the
 * transform, so whatever sits at the hand does not move.
 *
 * Returns the applied angle in radians (0 when the geometry is degenerate:
 * zero lever, zero displacement, or recoilDir parallel to the lever — a
 * rotation cannot move a point along its own lever).
 */
export function applyRecoilAboutPivot(pivot, faceCenter, recoilDir, displacement, ioPos, ioQuat) {
  if (!(displacement > 0)) return 0;

  _lever.subVectors(faceCenter, pivot);
  const leverLen = _lever.length();
  if (leverLen < 1e-6) return 0;

  // axis = lever × dir. Rotating by +angle about this axis moves the face
  // along dir's perpendicular component (see module test for the identity).
  _axis.crossVectors(_lever, recoilDir);
  const axisLen = _axis.length();
  if (axisLen < 1e-9) return 0;
  _axis.multiplyScalar(1 / axisLen);

  const angle = displacement / leverLen;
  _q.setFromAxisAngle(_axis, angle);

  // World-space rotation about the pivot: rotate the orientation on the left,
  // and orbit the position around the pivot by the same quaternion.
  ioQuat.premultiply(_q);
  _rel.subVectors(ioPos, pivot).applyQuaternion(_q);
  ioPos.copy(pivot).add(_rel);

  return angle;
}
