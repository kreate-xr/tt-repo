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
import {
  PADDLE_POS_SMOOTHING, PADDLE_ROT_SMOOTHING, WEIGHTY_BALL_ENABLED,
  PADDLE_TABLE_PUSH_MAX,
} from '../physics/constants.js';
import { resolvePaddleTablePenetration } from '../physics/paddleTableClamp.js';
import * as haptics from '../xr/haptics.js';
import {
  composeCalibratedPose,
  setFilterFlushHandler as setCalibFilterFlushHandler,
  loadForProfile as loadCalibForProfile,
  getPresetName as getCalibPresetName,
  subscribe as subscribeCalibration,
  getPosOffset as getCalibPosOffset,
  getRotOffset as getCalibRotOffset,
} from '../xr/calibration.js';
import { presetWeightClass } from '../xr/calibrationPresets.js';
import {
  getSetting as getProfileSetting,
  subscribe as subscribeProfile,
} from '../profile/store.js';
import { paddleHandFromSetting, shouldSwitchPaddleHand } from '../xr/handedness.js';
import { shouldFreezePaddle as trackingShouldFreezePaddle } from '../xr/trackingLossGuard.js';
import {
  applyRecoilAboutPivot, recoilEnvelope, recoilPeakForImpact,
} from '../xr/paddleRecoil.js';
import { recoilWeightScale, setPaddleWeightClass } from '../physics/paddleWeight.js';

// Wire calibration setters to flush the median-of-3 velocity buffer in ball.js
// (spec C7: offset change makes old blade velocities invalid). Registered
// once at module load; no-op if calibration.js is used from tests without
// ball.js present.
setCalibFilterFlushHandler(resetPaddleTracking);

// Adapter presets describe a physical controller→paddle mount, so their
// assembled mass is a known quantity — adopt the matching weight class when
// one is selected. Bare-controller presets return null and leave the player's
// weight preference alone: with nothing real in their hand, how heavy the bat
// should feel is their call, not something we can infer from a profile string.
// This bridge lives here rather than in calibration.js so that module keeps
// its spec-C6 property of never importing anything that changes how the blade
// behaves — it only ever decides where the blade is.
subscribeCalibration(() => {
  const cls = presetWeightClass(getCalibPresetName());
  if (cls) setPaddleWeightClass(cls);
  logCalibrationState();
});

// T_cal is persisted per device (localStorage, keyed by controller profile)
// and silently re-applied on every controller connect — a stale wizard run or
// an adapter preset on a bare controller renders the blade centimeters away
// from the grip and reads as a tracking/sync bug. One HUD line whenever it
// changes or the paddle re-binds makes the active calibration self-evident.
const CAL_WARN_OFFSET_CM = 5;
const CAL_WARN_TILT_DEG = 30;
function logCalibrationState() {
  const off = getCalibPosOffset();
  const rot = getCalibRotOffset();
  const cm = off.length() * 100;
  const deg = 2 * Math.acos(Math.min(1, Math.abs(rot.w))) * (180 / Math.PI);
  hudLog(`[cal] preset=${getCalibPresetName()}  offset=${cm.toFixed(1)}cm  tilt=${deg.toFixed(0)}deg`);
  if (cm > CAL_WARN_OFFSET_CM || deg > CAL_WARN_TILT_DEG) {
    hudLog('[cal] LARGE OFFSET ACTIVE — paddle will sit away from the controller. If unintended, set calibration preset to "default" in the menu');
  }
}

// Which hand holds the paddle. Sourced from the player's profile setting
// (M10 `dominantHand`, stored as 'L'/'R') rather than hardcoded. Read through
// a function, never cached, so flipping the setting mid-session takes effect
// on the next attach/sweep. The policy itself lives in xr/handedness.js where
// it can be unit tested — see the note there.
function preferredPaddleHand() {
  return paddleHandFromSetting(getProfileSetting('dominantHand'));
}

// `?gripAxes` — draw RGB axis triads at each controller's gripSpace origin
// (large) and at the calibrated paddle anchor (small). Makes the runtime's
// idea of "where the fist is / which way -Z points" visible in headset, so a
// calibration offset can be judged against the true grip frame instead of
// guessed at. Red=+X, green=+Y, blue=+Z (the handle extends along MINUS Z).
const SHOW_GRIP_AXES = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('gripAxes');

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
  // renderer.xr's controller/grip objects are singletons that OUTLIVE the
  // session, so every listener added to them below must be removed in the
  // session-end teardown — a leaked 'connected' handler fires again in the
  // NEXT session with this closure's stale state. That was the stuck-ray bug:
  // an old session's handler re-ran emitAttached, whose inGame callback
  // re-parented that session's disposed laser onto the live controller, where
  // nothing ever hid it again.
  const boundHandlers = [];
  let ended = false;

  // Visual paddle anchor in scene root. Follows the active grip's world pose
  // with a per-frame lerp/slerp (alpha < 1 → tracking offset = pseudo-haptic
  // weight). When WEIGHTY_BALL_ENABLED is false we still use the anchor but
  // with alpha=1 (snap), so structure is identical and A/B comparison is
  // pose-source-equivalent.
  const paddleAnchor = new THREE.Object3D();
  paddleAnchor.name = 'paddleAnchor';
  scene.add(paddleAnchor);
  if (SHOW_GRIP_AXES) paddleAnchor.add(new THREE.AxesHelper(0.05));
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

  // Raw grip pose from the SAME frame the smoothed pose was last updated
  // (i.e. frozen together with it during tracking loss). Served — with T_cal
  // composed — via getRawPaddlePose() as the physics VELOCITY measurement
  // source. The pseudo-haptic smoothing above is an EMA low-pass, and finite-
  // differencing the smoothed anchor attenuated exactly the one-frame wrist-
  // snap peaks that generate brush spin (the same signal ball.js deliberately
  // exempts from its median filter). Contact GEOMETRY still reads the
  // smoothed anchor so "what you see is what collides" holds; only the
  // velocity estimate bypasses the smoothing.
  const rawGripPos = new THREE.Vector3();
  const rawGripQuat = new THREE.Quaternion();
  let rawPoseValid = false;

  // Impact recoil — post-hit "the ball has mass" cue. Restores the
  // pseudo-haptic weight we gave up when PADDLE_POS_SMOOTHING was set to 1.0.
  // Fires AFTER contact, so the collision that spawned the kick used the
  // pre-recoil pose.
  //
  // This is a ROTATION about the grip pivot, not a translation of the anchor:
  // a held object cannot slide relative to the hand holding it, and the old
  // 12 mm translation read as the paddle coming loose from the grip (as well as
  // putting the rendered paddle outside the 1 cm agreement budget from the true
  // grip pose). Rotating about the hand leaves the grip point exactly fixed
  // while the blade tip kicks back by the same distance. See paddleRecoil.js.
  //
  // Peak magnitude scales with impact speed, saturating at RECOIL_MAX_SPEED.
  // Direction is -reflectNormal (into the paddle body).
  const recoilDir = new THREE.Vector3();
  const tmpRecoilFace = new THREE.Vector3();
  let recoilMagnitude = 0;
  let recoilStart = 0;

  function triggerPaddleRecoil(worldNormal, impactSpeed) {
    if (!worldNormal || impactSpeed <= 0) return;
    recoilDir.copy(worldNormal).multiplyScalar(-1);
    recoilMagnitude = recoilPeakForImpact(impactSpeed, recoilWeightScale());
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

  // Raw XRInputSource for the off-hand grip (the one getOffHandGrip returns).
  // Needed by consumers that poll off-hand buttons — e.g. the player-serve
  // controller's grip-hold/release toss. Null until both controllers exist.
  function getOffHandInputSource() {
    if (!activeController) return null;
    for (let i = 0; i < grips.length; i++) {
      if (grips[i] && grips[i] !== activeController) return inputSources[i];
    }
    return null;
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
    // player's preferred hand and we're currently on the other one.
    if (paddleOwner) {
      if (!shouldSwitchPaddleHand(activeHandedness, hand, preferredPaddleHand())) return;
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

    // Per-controller-profile calibration (spec §C5). This loads for the grip
    // that ACTUALLY ends up owning the paddle, which is the rule the old code
    // stated but only approximated by gating on handedness === 'right' in the
    // 'connected' handler. That approximation meant a left-handed player's
    // T_cal was never loaded at all (their paddle hand never matched the
    // literal), and a mid-session hand switch kept the previous hand's
    // transform. Doing it here is also the only placement that survives a
    // re-bind, since 'connected' fires once per controller per session.
    //
    // event.data.profiles is an ordered array (most-specific first — e.g.
    // ["oculus-touch-v3", "oculus-touch", "generic-trigger"]); the first entry
    // is the storage key.
    const profiles = (activeInputSource && activeInputSource.profiles) || [];
    if (profiles[0]) {
      try { loadCalibForProfile(profiles[0]); }
      catch (e) { hudLog('calibration load failed: ' + (e && e.message)); }
    }
    // Announce the T_cal in effect for this binding even when loadForProfile
    // applied it without a change event (persisted value == current value).
    logCalibrationState();
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

    // Persist this frame's raw grip pose for getRawPaddlePose. Not updated
    // during the tracking-loss freeze above, so raw and smoothed poses freeze
    // together and the raw finite-diff velocity in ball.js reads zero instead
    // of a teleport spike when tracking resumes.
    rawGripPos.copy(tmpTargetPos);
    rawGripQuat.copy(tmpTargetQuat);
    rawPoseValid = true;

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

    // Apply impact recoil AFTER pose composition so it composes with 1:1
    // tracking. Cosine-quarter decay: peak at t=0, zero at RECOIL_DURATION.
    // Physics already used the pre-recoil pose for the collision that spawned
    // this kick; for the remainder of the window the rotated pose is what BOTH
    // the mesh and the physics tick see, so they never disagree.
    //
    // The pivot is the smoothed grip position — the hand — so the grip point is
    // a fixed point of the rotation and the paddle stays welded to it.
    if (recoilMagnitude > 0) {
      const decay = recoilEnvelope(performance.now() * 0.001 - recoilStart);
      if (decay <= 0) {
        recoilMagnitude = 0;
      } else {
        tmpRecoilFace.copy(paddleFaceOffset)
          .applyQuaternion(paddleAnchor.quaternion)
          .add(paddleAnchor.position);
        applyRecoilAboutPivot(
          smoothedGripPos, tmpRecoilFace, recoilDir, recoilMagnitude * decay,
          paddleAnchor.position, paddleAnchor.quaternion,
        );
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
      // Bounded: this delta moves the bat relative to the hand holding it, so
      // it is capped at the contact-visual agreement budget. Unbounded, a hand
      // driven through the felt pushed the rendered paddle a full penetration
      // depth off the grip — a detachment artifact of the same family as the
      // old translational recoil. See paddleTableClamp.js for the trade.
      resolvePaddleTablePenetration(
        tmpFaceCenter, tmpFaceNormal,
        paddleHitRadius, paddleHalfThickness,
        tableBox, tmpDelta, PADDLE_TABLE_PUSH_MAX,
      );
      paddleAnchor.position.add(tmpDelta);
    }
  }

  function getPaddleAnchor() {
    return activeController ? paddleAnchor : null;
  }

  // Raw calibrated paddle pose — this frame's grip pose with T_cal composed,
  // BYPASSING the pseudo-haptic smoothing. ball.js finite-differences this
  // for paddleVelocity / paddleAngularVelocity so brush-stroke peaks reach
  // the impulse un-attenuated (see rawGripPos declaration). Returns false
  // until the first tracked frame; frozen at last-good during tracking loss.
  function getRawPaddlePose(outPos, outQuat) {
    if (!rawPoseValid || !activeController) return false;
    composeCalibratedPose(rawGripPos, rawGripQuat, outPos, outQuat);
    return true;
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
    if (ended) return; // a pending setTimeout sweep outlived the session
    const sources = session.inputSources;
    hudLog(`sweep (${reason}): ${sources.length} source(s)`);

    // Prefer the player's paddle hand. Fall back to whatever's tracked, so a
    // single-controller session still gets a paddle regardless of which hand
    // it is — the preference orders the search, it does not gate it.
    const preferred = preferredPaddleHand();
    const order = [];
    for (let i = 0; i < grips.length; i++) {
      if (handedness[i] === preferred) order.unshift(i);
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
    if (SHOW_GRIP_AXES) grip.add(new THREE.AxesHelper(0.1));
    grips[i] = grip;
    targetRays[i] = ctrl;

    const onConnected = (event) => {
      const hand = (event.data && event.data.handedness) || 'unknown';
      handedness[i] = hand;
      inputSources[i] = event.data || null;  // stash raw XRInputSource for TrackingLossGuard
      hudLog(`grip[${i}] connected (${hand})`);

      // Calibration is loaded inside attachPaddleToGrip, for whichever grip
      // actually takes the paddle — see the note there. Loading it here would
      // let the off-hand's controller profile overwrite the paddle hand's
      // T_cal, and would miss every re-bind after the first connect.
      attachPaddleToGrip(grip, `grip[${i}]`, hand);
    };
    grip.addEventListener('connected', onConnected);
    boundHandlers.push([grip, 'connected', onConnected]);

    const onDisconnected = () => {
      hudLog(`grip[${i}] disconnected`);
      handedness[i] = null;
      inputSources[i] = null;
      detachFromGrip(grip);
      setTimeout(() => sweepAndAttach('after-disconnect'), 100);
      setTimeout(() => sweepAndAttach('after-disconnect-late'), 800);
    };
    grip.addEventListener('disconnected', onDisconnected);
    boundHandlers.push([grip, 'disconnected', onDisconnected]);

    if (onSelect) {
      const onSelectStart = () => onSelect(grip);
      ctrl.addEventListener('selectstart', onSelectStart);
      boundHandlers.push([ctrl, 'selectstart', onSelectStart]);
    }
    // Trigger RELEASE. Needed for held interactions — dragging a slider in a
    // panel is a press-move-release gesture, and with only selectstart the
    // best a panel can do is jump-to-value on tap.
    if (onSelectEnd) {
      const onSelectRelease = () => onSelectEnd(grip);
      ctrl.addEventListener('selectend', onSelectRelease);
      boundHandlers.push([ctrl, 'selectend', onSelectRelease]);
    }
  }

  session.addEventListener('inputsourceschange', () => {
    setTimeout(() => sweepAndAttach('inputsourceschange'), 50);
  });

  // Player flipped dominant hand from the settings screen mid-session. Re-run
  // the sweep so the paddle moves across immediately instead of on the next
  // controller event — a setting that only takes effect after you take the
  // headset off and back on reads as broken. The sweep is a no-op when the
  // paddle is already on the preferred hand, and falls back to the currently
  // bound grip when the preferred hand's controller isn't tracked.
  const unsubscribeProfile = subscribeProfile(() => {
    if (activeHandedness === preferredPaddleHand()) return;
    sweepAndAttach('hand-preference-changed');
  });
  // Session-scoped teardown. Everything this setup attached to objects that
  // outlive the session (renderer.xr controller/grip singletons, the shared
  // scene, module-level handler slots) is detached here, so a later session's
  // setupXRPaddle starts from a clean slate instead of stacking on top of
  // this closure's dead state.
  session.addEventListener('end', () => {
    ended = true;  // pending sweep timeouts (disconnect/resweep retries) become no-ops
    unsubscribeProfile();
    for (const [obj, type, fn] of boundHandlers) obj.removeEventListener(type, fn);
    boundHandlers.length = 0;
    attachListeners.length = 0;
    // The paddle mesh is shared across sessions and modes; return it to its
    // post-load unparented state rather than leaving it inside a dead anchor.
    if (paddleModel && paddleModel.parent === paddleAnchor) paddleAnchor.remove(paddleModel);
    scene.remove(paddleAnchor);
    setPaddleRecoilHandler(null);
  });

  setTimeout(() => sweepAndAttach('timeout-1500ms'), 1500);

  return {
    getActiveController,
    getActiveHandedness,
    getActiveTargetRay,
    getActiveInputSource,
    getOffHandGrip,
    getOffHandHandedness,
    getOffHandInputSource,
    onPaddleAttached,
    getPaddleAnchor,
    getRawPaddlePose,
    getSmoothedGripPose,
    updatePaddleVisual,
    triggerPaddleRecoil,
    // Re-run the attach sweep on demand. Needed when setup is called before
    // the paddle GLB exists: 'connected' events that arrive mid-download
    // attach nothing (attachPaddleToGrip guards on paddleModel), so the
    // caller re-sweeps once the model is in.
    resweep: (reason = 'manual') => {
      sweepAndAttach(reason);
      // Retry if it missed. The 1500 ms startup sweep fires during the asset
      // download and is spent by the time the paddle GLB exists, so a
      // controller that is asleep or not yet tracked at models-loaded would
      // otherwise never bind — the only remaining triggers are
      // connect/disconnect/inputsourceschange (i.e. the player has to open and
      // close the Quest system menu to get a paddle).
      if (paddleOwner) return;
      for (const ms of [500, 2000]) {
        setTimeout(() => { if (!paddleOwner) sweepAndAttach(`${reason}-retry-${ms}ms`); }, ms);
      }
    },
  };
}
