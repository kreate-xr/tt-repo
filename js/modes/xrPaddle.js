// Shared XR controller + paddle binding. Used by both MR mode and Training mode.
// Attaches paddleModel to the right hand by default (right-handed assumption);
// if only the left hand is connected, the paddle binds there and re-binds to the
// right when it later connects.
//
// Pseudo-haptic detail: paddleModel is NOT parented directly to the controller
// grip. Instead it lives under `paddleAnchor` in scene root, and we smooth the
// anchor's world pose toward the active grip's world pose each frame. This adds
// a small (~20 ms) tracking offset that increases the perceived weight of the
// paddle without breaking presence (Rietzler, "Breaking the Tracking"). The
// physics tick reads collision pose from the anchor — so what you SEE is what
// the ball collides with.

import * as THREE from 'three';
import { scene, renderer } from '../scene/sceneSetup.js';
import {
  paddleModel, paddleFaceOffset, paddleFaceNormalLocal,
  tableBox, paddleHitRadius, paddleHalfThickness,
} from '../scene/models.js';
import { hudLog } from '../scene/hud.js';
import { resetPaddleTracking, setPaddleRecoilHandler } from '../physics/ball.js';
import { PADDLE_POS_SMOOTHING, PADDLE_ROT_SMOOTHING, WEIGHTY_BALL_ENABLED } from '../physics/constants.js';
import { resolvePaddleTablePenetration } from '../physics/paddleTableClamp.js';
import * as haptics from '../xr/haptics.js';
import {
  composeCalibratedPose,
  setFilterFlushHandler as setCalibFilterFlushHandler,
  loadForProfile as loadCalibForProfile,
} from '../xr/calibration.js';
import { shouldFreezePaddle as trackingShouldFreezePaddle } from '../xr/trackingLossGuard.js';

// Wire calibration setters to flush the median-of-3 velocity buffer in ball.js
// (spec C7: offset change makes old blade velocities invalid). Registered
// once at module load; no-op if calibration.js is used from tests without
// ball.js present.
setCalibFilterFlushHandler(resetPaddleTracking);

const PREFERRED_PADDLE_HAND = 'right';

export function setupXRPaddle(session, { onSelect, onSelectEnd } = {}) {
  let paddleOwner = null;
  let activeController = null;
  let activeHandedness = null;
  let activeInputSource = null;   // raw XRInputSource for the paddle grip (for TrackingLossGuard)
  const grips = [];
  const targetRays = [];
  const handedness = [null, null]; // index → 'left' | 'right'
  const inputSources = [null, null]; // index → XRInputSource | null
  const attachListeners = [];

  // Visual paddle anchor in scene root. Follows the active grip's world pose
  // with a per-frame lerp/slerp (alpha < 1 → tracking offset = pseudo-haptic
  // weight). When WEIGHTY_BALL_ENABLED is false we still use the anchor but
  // with alpha=1 (snap), so structure is identical and A/B comparison is
  // pose-source-equivalent.
  const paddleAnchor = new THREE.Object3D();
  paddleAnchor.name = 'paddleAnchor';
  scene.add(paddleAnchor);
  let anchorPoseInitialized = false;
  const tmpTargetPos = new THREE.Vector3();
  const tmpTargetQuat = new THREE.Quaternion();
  const tmpFaceCenter = new THREE.Vector3();
  const tmpFaceNormal = new THREE.Vector3();
  const tmpDelta = new THREE.Vector3();
  // Persistent smoothed grip pose (BEFORE calibration). The pseudo-haptic
  // smoothing lerps this toward the raw grip pose each frame; T_cal is then
  // composed on top to produce paddleAnchor's world pose. Storing the raw
  // grip separately avoids mixing calibrated and uncalibrated spaces in the
  // lerp (which would drift by posOffset every frame at PADDLE_POS_SMOOTHING
  // < 1).
  const smoothedGripPos = new THREE.Vector3();
  const smoothedGripQuat = new THREE.Quaternion();

  // Impact recoil — post-hit visual kick-back on paddleAnchor that decays to
  // zero. Restores the pseudo-haptic "the ball has mass" cue we gave up when
  // PADDLE_POS_SMOOTHING was set to 1.0. Fires AFTER contact so the collision
  // pose is unchanged (no precision hit), but the eye sees the paddle jerk
  // backward for ~130 ms, which the brain reads as momentum transfer.
  //
  // Peak magnitude scales with impact speed; RECOIL_PEAK_M at 8 m/s or above.
  // Direction is -reflectNormal (into the paddle body).
  const RECOIL_PEAK_M = 0.012;      // 12 mm max offset
  const RECOIL_DURATION = 0.13;     // seconds, cosine decay to zero
  const RECOIL_MAX_SPEED = 8.0;     // m/s at which peak saturates
  const recoilDir = new THREE.Vector3();
  const tmpRecoilOffset = new THREE.Vector3();
  let recoilMagnitude = 0;
  let recoilStart = 0;

  function triggerPaddleRecoil(worldNormal, impactSpeed) {
    if (!worldNormal || impactSpeed <= 0) return;
    const norm = Math.min(impactSpeed / RECOIL_MAX_SPEED, 1.0);
    recoilDir.copy(worldNormal).multiplyScalar(-1);
    recoilMagnitude = RECOIL_PEAK_M * norm;
    recoilStart = performance.now() * 0.001;
  }

  // Register the recoil trigger with ball.js. Persists for the session; the
  // physics module calls it directly on local-player collisions.
  setPaddleRecoilHandler(triggerPaddleRecoil);

  function getActiveController() {
    return activeController;
  }

  function getActiveHandedness() {
    return activeHandedness;
  }

  function getActiveTargetRay() {
    const idx = grips.indexOf(activeController);
    return idx >= 0 ? targetRays[idx] : null;
  }

  function getOffHandGrip() {
    if (!activeController) return null;
    for (let i = 0; i < grips.length; i++) {
      if (grips[i] && grips[i] !== activeController) return grips[i];
    }
    return null;
  }

  function getOffHandHandedness() {
    if (!activeHandedness) return null;
    return activeHandedness === 'left' ? 'right' : 'left';
  }

  function onPaddleAttached(fn) { attachListeners.push(fn); }
  function emitAttached() {
    for (const fn of attachListeners) fn();
  }

  function attachPaddleToGrip(grip, label, hand) {
    if (!paddleModel) return;

    // Already on this exact grip — nothing to do.
    if (paddleOwner === grip) return;

    // Already attached to another grip. Only switch if the new grip is the
    // preferred hand (right) and we're currently on the non-preferred (left).
    if (paddleOwner) {
      const shouldSwitch =
        hand === PREFERRED_PADDLE_HAND &&
        activeHandedness !== PREFERRED_PADDLE_HAND;
      if (!shouldSwitch) return;
    }

    // Parent the visual paddle to the anchor (not the grip directly). The
    // local offset is the same that used to sit under the grip — anchor's
    // world pose follows the grip, so this offset still positions the paddle
    // correctly relative to the controller.
    if (paddleModel.parent !== paddleAnchor) {
      paddleAnchor.add(paddleModel);
    }
    // Mesh sits at the anchor origin now — calibration.posOffset lives on
    // paddleAnchor (see updatePaddleVisual), so any per-mesh offset here
    // would double-shift the blade for players on non-default presets.
    paddleModel.position.set(0, 0, 0);
    paddleOwner = grip;
    activeController = grip;
    const idx = grips.indexOf(grip);
    activeInputSource = idx >= 0 ? inputSources[idx] : null;
    if (hand) activeHandedness = hand;
    haptics.setActiveHandedness(activeHandedness);
    // Snap the anchor to the new grip's pose on the next visual update so
    // there's no visible "drift" when switching hands.
    anchorPoseInitialized = false;
    hudLog(`paddle attached to ${label}${hand ? ' (' + hand + ')' : ''}`);
    emitAttached();
  }

  function detachFromGrip(grip) {
    if (paddleOwner === grip && paddleModel) {
      paddleOwner = null;
      activeController = null;
      activeInputSource = null;
      haptics.setActiveHandedness(null);
      resetPaddleTracking();
    }
  }

  // Per-frame smoothing of the visual paddle's world pose toward the active
  // grip. Called from the animation loop BEFORE tickPhysics so the physics tick
  // reads a consistent pose. With WEIGHTY_BALL_ENABLED off, snaps directly.
  function updatePaddleVisual() {
    if (!activeController) return;

    // P13 §C7: if the current frame's grip pose is emulated (tracker just
    // dropped, or hand went out of view), do NOT update the smoothed grip
    // pose — freeze it at the last good value. The physics tick still runs
    // but will read the frozen pose. Contacts against a frozen pose are
    // additionally suppressed by shouldSuppressContact() in ball.js — the
    // two together prevent the "rocket ball on tracking hiccup" bug.
    if (trackingShouldFreezePaddle()) {
      // Still recompose anchor from last good smoothed grip so any late
      // T_cal edits (e.g. tuner slider mid-freeze) still take visual effect.
      if (anchorPoseInitialized) {
        composeCalibratedPose(smoothedGripPos, smoothedGripQuat, paddleAnchor.position, paddleAnchor.quaternion);
      }
      return;
    }

    activeController.updateMatrixWorld();
    activeController.getWorldPosition(tmpTargetPos);
    activeController.getWorldQuaternion(tmpTargetQuat);

    // Smooth the *grip pose* first (still uncalibrated), then compose T_cal
    // on top (plan Gotcha c). smoothedGripPos/Quat are persistent module
    // state — see their declaration above for why we don't lerp on the
    // anchor directly.
    if (!anchorPoseInitialized || !WEIGHTY_BALL_ENABLED) {
      smoothedGripPos.copy(tmpTargetPos);
      smoothedGripQuat.copy(tmpTargetQuat);
      anchorPoseInitialized = true;
    } else {
      smoothedGripPos.lerp(tmpTargetPos, PADDLE_POS_SMOOTHING);
      smoothedGripQuat.slerp(tmpTargetQuat, PADDLE_ROT_SMOOTHING);
    }

    // Compose T_cal via the shared helper — same math the C6a feel-neutrality
    // test exercises. ball.js reads pose from this anchor via inGame.js →
    // tickPhysics, so physics inherits calibration automatically. Do NOT
    // compose T_cal again inside ball.js (plan Gotcha e).
    composeCalibratedPose(smoothedGripPos, smoothedGripQuat, paddleAnchor.position, paddleAnchor.quaternion);

    // Apply impact recoil AFTER pose smoothing so it composes with 1:1 tracking
    // (paddle snaps to hand + kickback offset). Cosine-half decay: peak at t=0,
    // zero at t=RECOIL_DURATION. Purely visual — physics already used the
    // pre-recoil pose for the collision that spawned this kick.
    if (recoilMagnitude > 0) {
      const t = (performance.now() * 0.001 - recoilStart) / RECOIL_DURATION;
      if (t >= 1) {
        recoilMagnitude = 0;
      } else {
        const decay = Math.cos(t * Math.PI * 0.5);
        tmpRecoilOffset.copy(recoilDir).multiplyScalar(recoilMagnitude * decay);
        paddleAnchor.position.add(tmpRecoilOffset);
      }
    }

    // Resolve table penetration on the final (post-smoothing) anchor pose.
    // We sample the full paddle disc rim against the table's XZ footprint,
    // extended downward — so a tilted blade whose center is above the felt
    // but whose rim dips below gets lifted, and a horizontal swing into the
    // side of the table gets pushed sideways off the edge. The old logic
    // only checked the face center and only pushed up, so both cases clipped.
    // Delta is applied to the anchor position; paddleModel is a rigid child,
    // so every point of the visual paddle shifts by the same delta.
    if (tableBox) {
      // paddleFaceOffset is the model-intrinsic face center (from GLB bbox,
      // computed in models.js after PADDLE_EULER is applied). T_cal is already
      // baked into paddleAnchor above, so we just rotate the face offset by
      // the calibrated anchor quaternion and translate to the anchor position.
      tmpFaceCenter.copy(paddleFaceOffset)
        .applyQuaternion(paddleAnchor.quaternion)
        .add(paddleAnchor.position);
      tmpFaceNormal.copy(paddleFaceNormalLocal)
        .applyQuaternion(paddleAnchor.quaternion)
        .normalize();
      resolvePaddleTablePenetration(
        tmpFaceCenter, tmpFaceNormal,
        paddleHitRadius, paddleHalfThickness,
        tableBox, tmpDelta,
      );
      paddleAnchor.position.add(tmpDelta);
    }
  }

  function getPaddleAnchor() {
    return activeController ? paddleAnchor : null;
  }

  // Returns the paddle-hand's smoothed grip pose (BEFORE T_cal is composed).
  // Used by the calibration wizard: when the player confirms a sample, we
  // want the raw physical grip orientation, not one already corrected by
  // whatever T_cal happens to be active (which would make the wizard fit R
  // relative to itself and never converge).
  function getSmoothedGripPose(outPos, outQuat) {
    if (!anchorPoseInitialized) return false;
    outPos.copy(smoothedGripPos);
    outQuat.copy(smoothedGripQuat);
    return true;
  }

  function getActiveInputSource() {
    return activeInputSource;
  }

  function sweepAndAttach(reason) {
    const sources = session.inputSources;
    hudLog(`sweep (${reason}): ${sources.length} source(s)`);

    // Prefer the right hand (the default paddle hand). Fall back to whatever's tracked.
    const order = [];
    for (let i = 0; i < grips.length; i++) {
      if (handedness[i] === PREFERRED_PADDLE_HAND) order.unshift(i);
      else order.push(i);
    }

    for (const i of order) {
      const grip = grips[i];
      if (!grip) continue;
      grip.updateMatrixWorld();
      const e = grip.matrixWorld.elements;
      const tracked = Math.abs(e[12]) > 1e-4 || Math.abs(e[13]) > 1e-4 || Math.abs(e[14]) > 1e-4;
      if (tracked) {
        attachPaddleToGrip(grip, `grip[${i}] (sweep:${reason})`, handedness[i]);
        if (paddleOwner) return;
      }
    }
    if (!paddleOwner) hudLog(`sweep (${reason}): no tracked grip yet`);
  }

  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    scene.add(ctrl);
    scene.add(grip);
    grips[i] = grip;
    targetRays[i] = ctrl;

    grip.addEventListener('connected', (event) => {
      const hand = (event.data && event.data.handedness) || 'unknown';
      handedness[i] = hand;
      inputSources[i] = event.data || null;  // stash raw XRInputSource for TrackingLossGuard
      hudLog(`grip[${i}] connected (${hand})`);

      // Per-controller-profile calibration (spec §C5). event.data.profiles
      // is an ordered array (most-specific first — e.g. ["oculus-touch-v3",
      // "oculus-touch", "generic-trigger"]). Use the first entry as the
      // storage key. Only fire on the paddle hand — the off-hand grip
      // doesn't hold a paddle and its profile shouldn't overwrite T_cal.
      // Guard: setup order is such that attachPaddleToGrip may not switch
      // ownership to this grip if a preferred-hand grip is already active,
      // so we only load calibration for the grip that actually ends up
      // owning the paddle.
      if (hand === PREFERRED_PADDLE_HAND) {
        const profiles = (event.data && event.data.profiles) || [];
        const profileString = profiles[0];
        if (profileString) {
          try { loadCalibForProfile(profileString); }
          catch (e) { hudLog('calibration load failed: ' + (e && e.message)); }
        }
      }

      attachPaddleToGrip(grip, `grip[${i}]`, hand);
    });

    grip.addEventListener('disconnected', () => {
      hudLog(`grip[${i}] disconnected`);
      handedness[i] = null;
      inputSources[i] = null;
      detachFromGrip(grip);
      setTimeout(() => sweepAndAttach('after-disconnect'), 100);
      setTimeout(() => sweepAndAttach('after-disconnect-late'), 800);
    });

    if (onSelect) {
      ctrl.addEventListener('selectstart', () => onSelect(grip));
    }
    // Trigger RELEASE. Needed for held interactions — dragging a slider in a
    // panel is a press-move-release gesture, and with only selectstart the
    // best a panel can do is jump-to-value on tap.
    if (onSelectEnd) {
      ctrl.addEventListener('selectend', () => onSelectEnd(grip));
    }
  }

  session.addEventListener('inputsourceschange', () => {
    setTimeout(() => sweepAndAttach('inputsourceschange'), 50);
  });

  setTimeout(() => sweepAndAttach('timeout-1500ms'), 1500);

  return {
    getActiveController,
    getActiveHandedness,
    getActiveTargetRay,
    getActiveInputSource,
    getOffHandGrip,
    getOffHandHandedness,
    onPaddleAttached,
    getPaddleAnchor,
    getSmoothedGripPose,
    updatePaddleVisual,
    triggerPaddleRecoil,
  };
}
