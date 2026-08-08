// P13 spec §C3 — two-sample closed-form rotOffset solver.
//
// Coordinate system (from spec §C0): +x right, +y toward opponent, +z up.
//
// Sample A ("paddle face flat on virtual table"):
//   constraint: q_grip_A * R * n_local  = world (0, 0, 1)      // face normal up
// Sample B ("paddle upright, handle down, face toward opponent"):
//   constraint: q_grip_B * R * handle_local = world (0, 0, 1)  // tip up (handle down)
//
// Sample A determines R up to a rotation about n_local (one free parameter).
// Sample B fixes that remaining twist. Both closed-form — no iterative solver.
//
// The solver is grip-frame-axis-agnostic: it takes n_local and handle_local
// as inputs so the caller can pass the actual paddle-model axes derived from
// the GLB at load time (paddleFaceNormalLocal + normalized paddleFaceOffset
// from models.js), which may not be the spec's canonical (0,0,1) / (0,1,0).

import * as THREE from 'three';

const WORLD_UP = new THREE.Vector3(0, 0, 1);
const SIN_15_DEG = Math.sin((15 * Math.PI) / 180);

// Spec C3: reject a sample if controller angular speed during confirm > 0.5
// rad/s (player moving). This is a per-sample quality gate, not a solver
// concern per se; exposed here so the wizard uses the same threshold as any
// tests that stress the boundary.
export const SAMPLE_MAX_ANGULAR_SPEED = 0.5;

// Spec C3 test C3b: degenerate input detection. If Sample A and Sample B
// grip orientations are too close, or Sample B's handle projection onto the
// plane ⊥ n has near-zero length, the twist angle is unresolved.
export const DEGENERATE_ANGLE_THRESHOLD_DEG = 15;

/**
 * Solve for the rotOffset quaternion R such that:
 *   q_grip_A * R * n_local      ≈ (0, 0, 1)
 *   q_grip_B * R * handle_local ≈ (0, 0, 1)
 *
 * Returns { R, error }. On success error is null; on degenerate input, R is
 * null and error is a short reason code the wizard can display.
 *
 * @param {THREE.Quaternion} qGripA
 * @param {THREE.Quaternion} qGripB
 * @param {THREE.Vector3}    nLocal      face normal in paddle-local frame (unit)
 * @param {THREE.Vector3}    handleLocal handle→tip axis in paddle-local frame (unit)
 */
export function solveRotOffset(qGripA, qGripB, nLocal, handleLocal) {
  // Reject if the two grip orientations are too close — Sample B adds no new
  // information and the twist step will amplify noise.
  const gripAngle = _angleBetweenQuats(qGripA, qGripB);
  if (gripAngle < (DEGENERATE_ANGLE_THRESHOLD_DEG * Math.PI) / 180) {
    return { R: null, error: 'poses-too-similar' };
  }

  // --- Step 1: R_partial fixes the face-normal constraint (Sample A) ---
  // We want R such that (q_grip_A * R) * n_local = (0,0,1). Bring the target
  // into R's input frame:
  //   R * n_local = q_grip_A⁻¹ * (0,0,1)
  const targetNInLocalA = WORLD_UP.clone().applyQuaternion(qGripA.clone().invert());
  const nLocalNormalized = nLocal.clone().normalize();
  targetNInLocalA.normalize();
  const R_partial = new THREE.Quaternion().setFromUnitVectors(nLocalNormalized, targetNInLocalA);

  // --- Step 2: R_twist fixes the handle constraint (Sample B) ---
  // With R = R_partial · R_twist and R_twist a rotation about n_local,
  //   R_twist * handle_local = R_partial⁻¹ * q_grip_B⁻¹ * (0,0,1)
  // Both sides must share the same n_local component (rotation about n_local
  // preserves it) — this is the mathematical form of "Sample B must not be
  // pointing the face parallel to the twist axis".
  const targetHandleInPartialFrame = WORLD_UP.clone()
    .applyQuaternion(qGripB.clone().invert())
    .applyQuaternion(R_partial.clone().invert());

  const handleLocalNormalized = handleLocal.clone().normalize();
  const projHandle = _projectOntoPlane(handleLocalNormalized, nLocalNormalized);
  const projTarget = _projectOntoPlane(targetHandleInPartialFrame, nLocalNormalized);

  if (projHandle.length() < SIN_15_DEG) {
    // Model handle vector is nearly parallel to n — degenerate model geometry,
    // not a wizard input issue. Should not happen for a real paddle.
    return { R: null, error: 'handle-parallel-to-normal' };
  }
  if (projTarget.length() < SIN_15_DEG) {
    // Sample B's handle points near vertical in the R_partial-solved frame,
    // meaning the player held the paddle with its face pointing up/down
    // instead of toward the opponent — face isn't upright enough.
    return { R: null, error: 'sample-b-face-not-upright' };
  }

  projHandle.normalize();
  projTarget.normalize();

  const cross = new THREE.Vector3().crossVectors(projHandle, projTarget);
  const sinThetaSigned = cross.length() * Math.sign(cross.dot(nLocalNormalized) || 1);
  const cosTheta = projHandle.dot(projTarget);
  const theta = Math.atan2(sinThetaSigned, cosTheta);

  const R_twist = new THREE.Quaternion().setFromAxisAngle(nLocalNormalized, theta);
  const R = R_partial.clone().multiply(R_twist);

  return { R, error: null };
}

/**
 * Check whether the controller was moving too fast during a sample confirm.
 * True → reject the sample and re-prompt. Spec C3 threshold: 0.5 rad/s.
 */
export function sampleIsSteady(angularSpeed) {
  return angularSpeed <= SAMPLE_MAX_ANGULAR_SPEED;
}

// --- internal helpers ---

function _projectOntoPlane(v, planeNormal) {
  // v_proj = v - (v · n) n
  const d = v.dot(planeNormal);
  return v.clone().addScaledVector(planeNormal, -d);
}

function _angleBetweenQuats(qA, qB) {
  // 2 · acos(|<qA, qB>|) — quaternion angular distance, insensitive to sign.
  const dot = Math.min(1, Math.abs(qA.dot(qB)));
  return 2 * Math.acos(dot);
}
