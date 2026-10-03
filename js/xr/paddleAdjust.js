// Quick Fit adjustment math — three player-facing knobs layered on a base
// T_cal (normally the measured 'handle_grip' fit from handleGrip.js).
//
// A bare controller has no real blade to register against, so "calibrated"
// means "the bat sits where the player expects it". Three knobs cover that:
//   faceDeg  — face angle: roll the bat about the handle axis (grip −Z)
//   batDeg   — bat angle:  tilt the handle up/down relative to the
//              controller (rotation about grip +X; + tips the head toward
//              grip +Y)
//   slideM   — blade distance: slide the bat along its handle (+ = further
//              out from the fist)
//
// Every adjustment is a rotation about the GRIP ORIGIN (the fist centroid),
// so under handle_grip the handle's grip point stays welded to the fist no
// matter how the angles move. The result is always rebuilt from base + the
// three numbers — never accumulated onto the live quaternion — so repeated
// stick nudges cannot drift.
//
// Frame contract matches calibration.js composeCalibratedPose: a mesh point p
// lands at grip-local (rotOffset * p + posOffset). Adjusting that whole
// mapping by qAdj gives rotOffset' = qAdj * rotOffset and
// posOffset' = qAdj * (posOffset + slide along −Z).
//
// Pure math, no scene/physics imports (same rule as handleGrip.js).

import * as THREE from 'three';

export const FACE_MAX_DEG = 60;
export const BAT_MAX_DEG = 60;
export const SLIDE_MAX_M = 0.05;

// Thumbstick → knob rates at full deflection.
export const STICK_DEADZONE = 0.2;
export const ANGLE_RATE_DEG_S = 30;
export const SLIDE_RATE_M_S = 0.05;

const DEG = Math.PI / 180;
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_NEG_Z = new THREE.Vector3(0, 0, -1);

const _qFace = new THREE.Quaternion();
const _qAdj = new THREE.Quaternion();

export function zeroAdjust() {
  return { faceDeg: 0, batDeg: 0, slideM: 0 };
}

export function isZeroAdjust(adj) {
  return !adj || (adj.faceDeg === 0 && adj.batDeg === 0 && adj.slideM === 0);
}

// Clamp in place; returns the same object.
export function clampAdjust(adj) {
  adj.faceDeg = Math.max(-FACE_MAX_DEG, Math.min(FACE_MAX_DEG, adj.faceDeg));
  adj.batDeg = Math.max(-BAT_MAX_DEG, Math.min(BAT_MAX_DEG, adj.batDeg));
  adj.slideM = Math.max(-SLIDE_MAX_M, Math.min(SLIDE_MAX_M, adj.slideM));
  return adj;
}

/**
 * Compose base T_cal with the three knobs.
 *
 * @param {{posOffset: THREE.Vector3, rotOffset: THREE.Quaternion}} base
 * @param {{faceDeg: number, batDeg: number, slideM: number}} adj
 * @param {{posOffset: THREE.Vector3, rotOffset: THREE.Quaternion}} [out]
 *   Written in place when given (the per-frame stick path), else allocated.
 */
export function applyAdjust(base, adj, out) {
  const res = out || { posOffset: new THREE.Vector3(), rotOffset: new THREE.Quaternion() };
  // Face roll first (about the handle axis, which is grip −Z under
  // handle_grip), then bat tilt — so the face rolls about the handle
  // regardless of how far the bat is tilted.
  _qFace.setFromAxisAngle(AXIS_NEG_Z, adj.faceDeg * DEG);
  _qAdj.setFromAxisAngle(AXIS_X, adj.batDeg * DEG).multiply(_qFace);

  res.rotOffset.copy(_qAdj).multiply(base.rotOffset);
  res.posOffset.copy(base.posOffset);
  res.posOffset.z -= adj.slideM;
  res.posOffset.applyQuaternion(_qAdj);
  return res;
}

function _stickAxis(v) {
  const a = Math.abs(v);
  if (!(a > STICK_DEADZONE)) return 0;  // also swallows NaN
  return Math.sign(v) * Math.min(1, (a - STICK_DEADZONE) / (1 - STICK_DEADZONE));
}

/**
 * Advance the knobs from thumbstick input. Stick values follow the Gamepad
 * convention (−1 = left/up, +1 = right/down); Y is negated here so pushing a
 * stick UP increases bat angle / blade distance.
 *
 * @returns {boolean} true if any knob changed (caller re-applies T_cal).
 */
export function stepAdjust(adj, faceStickX, batStickY, slideStickY, dt) {
  const f = _stickAxis(faceStickX);
  const b = -_stickAxis(batStickY);
  const s = -_stickAxis(slideStickY);
  if (f === 0 && b === 0 && s === 0) return false;
  const prevF = adj.faceDeg, prevB = adj.batDeg, prevS = adj.slideM;
  adj.faceDeg += f * ANGLE_RATE_DEG_S * dt;
  adj.batDeg += b * ANGLE_RATE_DEG_S * dt;
  adj.slideM += s * SLIDE_RATE_M_S * dt;
  clampAdjust(adj);
  return adj.faceDeg !== prevF || adj.batDeg !== prevB || adj.slideM !== prevS;
}
