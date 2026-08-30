// Derived "handle in grip" calibration — the controller body IS the paddle
// handle.
//
// WebXR gripSpace is defined for exactly this mapping: its origin sits at the
// centroid of the user's fist, and -Z points the way a rod held in that fist
// points. So placing the paddle so that (a) its handle axis runs along grip -Z
// and (b) the grip point of its handle (GRIP_POINT_FRACTION) sits at the grip
// origin makes the rendered bat coincide with the physical controller the
// player is actually holding.
//
// Unlike the hand-tuned presets in calibrationPresets.js, this transform is
// COMPUTED from the loaded model's authored anchors (HandleEnd + blade
// geometry, measured in models.js), so it is exact for whichever bat asset is
// in use and survives a model swap without anyone re-tuning constants.
//
// Frame contract: all inputs are CONTROLLER-LOCAL (a.k.a. anchor-local) —
// i.e. after models.js has applied PADDLE_EULER. That is the same frame
// paddleFaceOffset lives in, and the frame calibration.js T_cal operates on:
// a mesh point p lands at grip-local (rotOffset * p + posOffset), see
// composeCalibratedPose.
//
// Pure math, no scene/physics imports — keeps calibration's spec-C6 property
// (calibration decides WHERE the blade is, never how it behaves) and stays
// unit-testable in node.

import * as THREE from 'three';

// Grip-space direction a held rod extends toward (WebXR spec).
const ROD_FORWARD = new THREE.Vector3(0, 0, -1);

// Where along the handle (0 = butt / HandleEnd, 1 = throat / blade bottom)
// the fist centroid sits. 0.5 (mid-handle) matches a natural full grip on
// paper, but in-headset the handle butt visibly floated above the physical
// controller's base — the Touch controller body extends further below the
// grip-space origin than half our handle covers. 0.8 lined the butt up with
// the controller base, but in-headset the bat still read as riding high on
// the controller; 0.9 puts the butt ~7.6 cm behind the fist point (on the
// 8.4 cm handle), seating the paddle slightly below the controller start.
// Asset-relative: a longer-handled GLB shifts proportionally more. Fine
// per-player adjustment lives in the in-headset Paddle Fine-Tune panel
// (Pos Z), not here.
export const GRIP_POINT_FRACTION = 0.9;

/**
 * Derive the T_cal that welds the paddle handle onto the controller.
 *
 * @param {object} geo  controller-local paddle geometry, all THREE.Vector3:
 *   handleEnd   — HandleEnd anchor (handle butt)
 *   bladeBottom — EdgeBottom anchor (blade/throat junction)
 *   faceCenter  — blade disc center (paddleFaceOffset)
 * @returns {{posOffset: THREE.Vector3, rotOffset: THREE.Quaternion}|null}
 *   null if the geometry is degenerate (zero-length handle axis).
 *
 * Guarantees (see tests/handleGrip.test.js):
 *   rotOffset * headDir            = (0, 0, -1)   handle axis → grip -Z
 *   rotOffset * gripPoint + posOffset = (0, 0, 0)  grip point → fist centroid
 *
 * The rotation is the SHORTEST ARC taking the handle axis onto -Z: with only
 * an axis to aim (the player's preferred face roll is unknowable from
 * geometry), minimal rotation preserves the in-headset-validated default
 * orientation's roll as closely as possible. Note the 180°-opposed case
 * (handle axis ≈ +Z) has an arbitrary roll by construction; no real bat
 * orientation gets near it.
 */
export function deriveHandleGripPreset({ handleEnd, bladeBottom, faceCenter }) {
  // Handle→head axis. Span butt→blade-center rather than butt→throat: same
  // line on a straight bat, but the longer baseline is less sensitive to
  // millimeter noise in the authored anchors.
  const headDir = new THREE.Vector3().subVectors(faceCenter, handleEnd);
  if (headDir.lengthSq() < 1e-8) return null;
  headDir.normalize();

  const rotOffset = new THREE.Quaternion().setFromUnitVectors(headDir, ROD_FORWARD);

  const gripPoint = new THREE.Vector3()
    .lerpVectors(handleEnd, bladeBottom, GRIP_POINT_FRACTION);
  const posOffset = gripPoint.applyQuaternion(rotOffset).multiplyScalar(-1);

  return { posOffset, rotOffset };
}
