// Off-hand (serving hand) pose math — which hand model to show, where it sits
// on the controller, and how far its fingers are curled.
//
// Pure, no scene imports, so it unit tests in node (same split as
// handedness.js / handleGrip.js). js/scene/offHand.js owns the meshes and
// calls into this every frame.
//
// The hand assets (public/models/{l,r}_hand_skeletal_lowres.glb) are a
// skinned rig with one bone chain per finger. They ship a single relaxed rest
// pose and no closed pose, so the grip is built here by rotating finger bones
// about their local +Z — verified on both rigs: +Z carries every finger tip
// toward the palm and back toward the wrist, and the L/R rigs are exact
// mirrors, so one set of angles serves both hands.

import * as THREE from 'three';
import { isGripBindable } from './handedness.js';

// The rigs are authored in centimetres.
export const HAND_MODEL_SCALE = 0.01;

/** Off-hand handedness ('left' | 'right') → model side key, or null. */
export function handModelFor(offHandedness) {
  if (offHandedness === 'left') return 'l';
  if (offHandedness === 'right') return 'r';
  return null;
}

// --- Where the hand sits on the controller -----------------------------------
//
// WebXR gripSpace (spec, XRInputSource.gripSpace): origin at the centroid of
// the fingers curled around a held rod, -Z along the rod toward the thumb,
// back of the RIGHT hand toward +X and back of the LEFT hand toward -X, +Y
// roughly up the arm. The rig's own `*_grip` bone does NOT follow that
// convention (it is an engine-specific attach frame), so the frame is
// derived from the palm instead — like deriveHandleGripPreset, it is computed
// from the loaded asset rather than tuned as magic constants, and stays right
// if the asset is swapped.
//
// The rod runs across the palm, pinky knuckle → index knuckle. Its centre sits
// in front of the palm (rod radius + finger thickness) and a little toward the
// wrist from the knuckle line. Model units (cm).
export const FIST_CENTROID_PALM_CM = 3.0;
export const FIST_CENTROID_WRIST_CM = 1.0;

// Where that fist centroid goes in grip space. The spec puts the grip origin
// at the fist, but Quest does not: the official controller models (WebXR
// input-profiles `meta-quest-touch-plus` and `oculus-touch-v3`, which are
// authored in gripSpace) both put the origin at the TOP of the handle, just
// below the button face. The handle runs from there to z ≈ +7.4 cm, its
// centre line ~1.1 cm toward the back of the hand and ~0.15 cm up. Pinning
// the fist at the origin floated the hand onto the controller head in the
// headset. z is the middle of the wrapped span — the middle finger sits just
// under the head, the pinky near the butt.
export const FIST_CENTER_IN_GRIP_CM = { back: 1.1, y: 0.15, z: 3.5 };

/**
 * Model-space → grip-space transform for a hand rig.
 *
 * @param {object} j  model-space joint positions (THREE.Vector3, rest pose):
 *   wrist, index1, middle1, ring1, pinky1, middleTip
 * @param {'left'|'right'} handedness
 * @returns {{position: THREE.Vector3, quaternion: THREE.Quaternion, scale: number}|null}
 *   Apply as the hand root's local transform under the grip; puts the fist
 *   centroid at FIST_CENTER_IN_GRIP_CM. null if the joints are degenerate.
 */
export function computeGripAlign(j, handedness) {
  const across = new THREE.Vector3().subVectors(j.index1, j.pinky1);   // toward the thumb
  const fwd = new THREE.Vector3().subVectors(j.middle1, j.wrist);      // toward the fingers
  if (across.lengthSq() < 1e-8 || fwd.lengthSq() < 1e-8) return null;
  across.normalize();
  fwd.normalize();

  // Palm normal: the side the finger tips curl toward.
  const palm = new THREE.Vector3().crossVectors(fwd, across);
  if (palm.lengthSq() < 1e-8) return null;
  palm.normalize();
  const tipDir = new THREE.Vector3().subVectors(j.middleTip, j.middle1);
  if (tipDir.dot(palm) < 0) palm.negate();

  // Grip axes expressed in model space.
  const z = across.clone().negate();                         // -Z toward the thumb
  const back = palm.clone().negate();
  const x = handedness === 'left' ? back.negate() : back;    // spec: back → +X right, -X left
  x.addScaledVector(z, -x.dot(z)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);

  // Fist centroid in model space.
  const origin = new THREE.Vector3()
    .add(j.index1).add(j.middle1).add(j.ring1).add(j.pinky1)
    .multiplyScalar(0.25)
    .addScaledVector(palm, FIST_CENTROID_PALM_CM)
    .addScaledVector(fwd, -FIST_CENTROID_WRIST_CM);

  // basis maps grip → model; the hand root needs model → grip.
  const basis = new THREE.Matrix4().makeBasis(x, y, z);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis).invert();
  const position = origin.clone().applyQuaternion(quaternion).multiplyScalar(-HAND_MODEL_SCALE);
  const c = FIST_CENTER_IN_GRIP_CM;
  position.x += (handedness === 'left' ? -c.back : c.back) * 0.01;   // back of hand: -X left, +X right
  position.y += c.y * 0.01;
  position.z += c.z * 0.01;
  return { position, quaternion, scale: HAND_MODEL_SCALE };
}

// --- Finger curl -------------------------------------------------------------
//
// Extra rotation (degrees about the bone's local +Z) on top of the rig's rest
// pose (a flat open hand) at full curl; curl 0 = the rig's rest pose.
//
// Middle/ring/pinky follow the GRIP (squeeze) button — the same button the
// serve holds the ball with — and the index follows the trigger, the way the
// real fingers sit on a Touch controller. The thumb rides on the face buttons
// and only tucks in a little with the squeeze.
export const FINGER_CURL_DEG = {
  index:  [40, 55, 35],
  middle: [60, 70, 40],
  ring:   [60, 70, 40],
  pinky:  [60, 70, 40],
};
// Thumb tucks about its local +Y (toward the palm, see the axis note above).
export const THUMB_TUCK_DEG = [8, 10, 6];

// Light touches on a button shouldn't twitch the fingers.
export const CURL_DEADZONE = 0.05;

// Curl with the button released. The rig's rest pose is a flat open hand,
// but a hand resting on a Touch controller already wraps the handle loosely
// (and the index lies on the trigger) — at 0 the fingers hung off the
// controller like an open palm hovering next to it.
export const SQUEEZE_REST_CURL = 0.45;
export const TRIGGER_REST_CURL = 0.35;

/**
 * Analog button value (0..1, may be missing/NaN) → target curl, from
 * `restCurl` with the button released up to 1 fully pressed.
 */
export function curlFromButton(value, restCurl = 0) {
  const v = Number(value);
  let t;
  if (!Number.isFinite(v) || v <= CURL_DEADZONE) t = 0;
  else if (v >= 1) t = 1;
  else t = (v - CURL_DEADZONE) / (1 - CURL_DEADZONE);
  return restCurl + (1 - restCurl) * t;
}

// Time constant of the curl follow. Short enough that the hand closes in step
// with the squeeze (~50 ms to 95%), long enough to hide single-frame jumps of
// a digital-ish button.
export const CURL_TAU_S = 0.018;

/**
 * Exponential approach of `current` toward `target`. Frame-rate independent,
 * never overshoots, and lands exactly on the target once within 1e-3.
 */
export function stepCurl(current, target, dt) {
  if (!(dt > 0)) return current;
  const k = 1 - Math.exp(-dt / CURL_TAU_S);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 1e-3 ? target : next;
}

/**
 * Show the hand on this grip right now? Needs a live controller (not a
 * tracked bare hand — that has no gamepad and the runtime may draw its own),
 * a grip three.js considers posed, and a non-zero pose (a disconnected slot
 * keeps its last matrix — see isGripBindable in handedness.js).
 */
export function shouldShowOffHand(grip, inputSource) {
  if (!grip || !inputSource || !inputSource.gamepad || inputSource.hand) return false;
  if (grip.visible === false) return false;
  return isGripBindable(inputSource, grip.matrixWorld && grip.matrixWorld.elements);
}
