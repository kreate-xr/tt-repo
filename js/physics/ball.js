import * as THREE from 'three';
import {
  ballModel, tableBox, netBox, tableSurfaceY, ballRadius,
  paddleHitRadius, paddleFaceOffset, paddleFaceNormalLocal, getDebugHelpers,
  setBallSquash, updateBallSquashAmount, resetBallSquash,
} from '../scene/models.js';
import { playBounceSound, playPaddleHitSound, playPaddleEdgeSound, updateSwingWhoosh, updateBallRoll } from '../scene/audio.js';
import { updateBallShadow, resetBallShadow } from '../scene/ballShadow.js';
import { updateBallGhost, resetBallGhost } from '../scene/ballGhost.js';
import { SELF_TEST, hudLog } from '../scene/hud.js';
import { detectDiscCollision } from './collisions.js';
import { computeImpulse } from './impulse.js';
import { pulseActive as hapticsPulseActive, pulseImpact as hapticsPulseImpact, pulseSwing } from '../xr/haptics.js';
import { shouldSuppressContact as trackingShouldSuppressContact } from '../xr/trackingLossGuard.js';
import { recordHit as recordContactLogHit } from '../xr/contactLog.js';
import { integrateFlightStep, applyTableBounce } from './rollout.js';
import {
  SPIN_CAPTURE_GAIN,
  NET_NORMAL_RESTITUTION, NET_TANGENT_DAMP, NET_SPIN_DAMP,
  NET_TOP_CORD_RESTITUTION, NET_TOP_CORD_TANGENT_KEEP, NET_TOP_CORD_LATERAL_JITTER,
  NET_HIT_COOLDOWN,
  PADDLE_RESTITUTION, HIT_COOLDOWN, FLOOR_Y,
  FLOOR_LEVEL_Y, FLOOR_RESTITUTION, FLOOR_FRICTION, FLOOR_SPIN_DAMP,
  TABLE_EDGE_SPIN_DAMP, TABLE_EDGE_COR_SCALE,
  STATIONARY_VEL, STATIONARY_TIME,
  DEAD_BALL_BOUNCES, DEAD_BALL_COR_SCALE,
  ROLLING_FRICTION, ROLLING_VY_THRESHOLD,
  SQUASH_DURATION, SQUASH_AMOUNT,
  HAPTIC_FLOOR, HAPTIC_MAX_SPEED, HAPTIC_DURATION_MIN_MS, HAPTIC_DURATION_MAX_MS,
  HAPTIC_BOUNCE_SCALE,
  SWING_HAPTIC_THRESHOLD, SWING_HAPTIC_MAX_SPEED, SWING_HAPTIC_MAX_INTENSITY, SWING_HAPTIC_PULSE_MS,
  SWING_HAPTIC_CURVE,
  PADDLE_CONTACT_SPEED_CAP, PADDLE_ANGULAR_CONTRIBUTION,
  PADDLE_EDGE_RESTITUTION, PADDLE_EDGE_SPIN_SCALE, PADDLE_EDGE_NORMAL_JITTER_RAD,
  SWEET_SPOT_HAPTIC_BOOST,
  paddleRestitution, tableRestitution, sweetSpotFactor,
} from './constants.js';
import { hapticWeightEnvelope, audioWeightShape } from './paddleWeight.js';

// Impulse tuning applied only to the local player's collisions — represents
// the biomechanical limits of a real arm + paddle. AI paddles have their own
// difficulty-scaled planning caps and should not be double-clipped, so they
// pass no opts and get the original untuned formula.
//
// Built fresh each call (not module-scope const) so that PhysicsTuner
// setters — which mutate the live `let` bindings in constants.js — take
// effect immediately without a rebuild.
function playerImpulseOpts() {
  return {
    angularContribution: PADDLE_ANGULAR_CONTRIBUTION,
    contactSpeedCap: PADDLE_CONTACT_SPEED_CAP,
    restitutionCurve: paddleRestitution,
  };
}

export const ballVelocity = new THREE.Vector3();
export const ballAngularVelocity = new THREE.Vector3();

export const paddleVelocity = new THREE.Vector3();
export const paddleAngularVelocity = new THREE.Vector3();

// Median-of-3 filter on the raw per-frame paddle LINEAR velocity samples.
// Quest tracking occasionally produces a single-frame spike (phantom high-
// velocity position delta) that the aggregate tanh cap in impulse.js can't
// catch — the cap smooths sustained input but a lone frame at 15 m/s still
// rockets the ball on soft strokes. Median-of-3 drops the outlier cleanly
// (median of [2, 3, 15] = 3) with ~11 ms latency at 90 Hz. Passthrough for
// the first three frames after connect / reset so warm-up isn't unfiltered
// zeros.
//
// Angular velocity is NOT filtered here. A wrist snap for spin peaks ω for
// ~1 frame (~11 ms) — the exact single-sample "spike" median-of-3 rejects.
// Killing that peak kills brush-stroke spin generation. Quaternion-delta ω
// is already smoother than position-diff velocity (integrating quat noise
// over a frame averages it), so it does not need the same jitter guard.
const _velSamples = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
let _paddleSampleIdx = 0;
let _paddleSampleCount = 0;
const _rawPaddleVel = new THREE.Vector3();
const _rawPaddleAng = new THREE.Vector3();

function _medianComp(a, b, c) {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function _pushAndMedian(buf, raw, out) {
  buf[_paddleSampleIdx].copy(raw);
  if (_paddleSampleCount < 3) {
    out.copy(raw);
    return;
  }
  out.set(
    _medianComp(buf[0].x, buf[1].x, buf[2].x),
    _medianComp(buf[0].y, buf[1].y, buf[2].y),
    _medianComp(buf[0].z, buf[1].z, buf[2].z),
  );
}

// Perturb a unit normal by a random direction inside a cone of half-angle
// `coneRad` around itself. Used to model the wild, unpredictable deflection
// of an edge-of-blade strike where the bare wood curvature is not aligned
// with the disc's planar face normal. Overwrites `out` with the new unit
// vector. Uses a trig-correct cone rotation (not a small-angle tangent
// projection) so 15°+ cones stay on the unit sphere without renormalization
// drift.
const _edgeTmp = new THREE.Vector3();
const _edgeT1 = new THREE.Vector3();
const _edgeT2 = new THREE.Vector3();
function _jitterNormalInCone(n, coneRad, out) {
  // Build orthonormal basis (t1, t2) perpendicular to n. Use world-X or
  // world-Y as the seed depending on which is less parallel to n.
  if (Math.abs(n.y) > 0.9) _edgeTmp.set(1, 0, 0);
  else _edgeTmp.set(0, 1, 0);
  _edgeT1.crossVectors(n, _edgeTmp).normalize();
  _edgeT2.crossVectors(n, _edgeT1).normalize();
  // Uniform azimuth, uniform-in-angle radial (not area-uniform on the cap
  // — good enough for a wild-deflection effect and biases toward more
  // dramatic offsets which is what we actually want for player feedback).
  const azimuth = Math.random() * Math.PI * 2;
  const angle = Math.random() * coneRad;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const azCos = Math.cos(azimuth);
  const azSin = Math.sin(azimuth);
  out.copy(n).multiplyScalar(c)
    .addScaledVector(_edgeT1, s * azCos)
    .addScaledVector(_edgeT2, s * azSin)
    .normalize();
}

const controllerWorldPos = new THREE.Vector3();
const controllerWorldQuat = new THREE.Quaternion();
const prevControllerWorldQuat = new THREE.Quaternion();

// Raw (unsmoothed) paddle pose — the velocity measurement source when the
// caller provides opts.getRawPose (xrPaddle.getRawPaddlePose). The anchor
// passed as xrController is EMA-smoothed for pseudo-haptic weight
// (PADDLE_POS/ROT_SMOOTHING), and finite-differencing a smoothed pose
// low-passes the velocity estimate — which attenuated exactly the one-frame
// wrist-snap peaks that generate brush spin, the same signal the median
// filter above deliberately exempts angular velocity to protect. Contact
// GEOMETRY (face center/normal, swept collision) still uses the smoothed
// anchor so physics collides with what the player sees; only the velocity
// finite-diff reads the raw pose. Raw and smoothed poses freeze together
// during tracking loss (see xrPaddle.js), so the raw diff can't spike on
// resume.
const _rawPosePos = new THREE.Vector3();
const _rawPoseQuat = new THREE.Quaternion();
const _rawFaceCenter = new THREE.Vector3();
const prevRawFaceCenter = new THREE.Vector3();
const prevRawPoseQuat = new THREE.Quaternion();
let hadRawPose = false;

// Ceiling on a single flight-integration step. The frame tick divides its dt
// into equal substeps no larger than this (90 Hz frame → 2 substeps, 72 Hz
// → 3), so integration fidelity is the same at every display rate and closer
// to the AI's rollout presets (DT_PRESETS.VERIFY=3 ms / INTERCEPT=5 ms).
const MAX_FLIGHT_STEP = 1 / 180;

// Per-frame scratch for tickPhysics. This function runs on the render hot
// path every XR frame — it must not allocate (GC pauses on Quest's mobile
// heap read as dropped frames, and the ball is where a dropped frame is
// seen). Same rule rollout.js already follows for the shared integrator.
const _dqScratch = new THREE.Quaternion();
const _qInvScratch = new THREE.Quaternion();
const _spinAxis = new THREE.Vector3();
const _spinDq = new THREE.Quaternion();
const _prevBallPos = new THREE.Vector3();
const _floorNegYR = new THREE.Vector3();
const _floorSurfVel = new THREE.Vector3();
const _floorSlip = new THREE.Vector3();
const _tableSquashNormal = new THREE.Vector3(0, 1, 0);
export const paddleFaceCenterWorld = new THREE.Vector3();
export const paddleFaceNormalWorld = new THREE.Vector3();
const prevPaddleFaceCenter = new THREE.Vector3();
const prevPaddleFaceNormal = new THREE.Vector3(0, 1, 0);
let hadControllerPos = false;
let hadControllerQuat = false;
let lastHitTime = 0;
// -Infinity, not 0: clockTime is an arbitrary-origin clock, so a 0 sentinel
// would swallow the first real net contact of any ball spawned within
// NET_HIT_COOLDOWN of clock start.
let lastNetHitTime = -Infinity;
let stationaryTime = 0;
// Table bounces since the last paddle contact. At DEAD_BALL_BOUNCES the ball
// is dead in every mode (see constants.js) and each further bounce takes the
// DEAD_BALL_COR_SCALE damp so it settles in seconds, not tens of seconds.
let bouncesSinceContact = 0;

// Previous-frame ball position, used as the "pre" sample for swept paddle
// collision. Tracking it at module scope (rather than recomputing inside the
// tick) lets multiplayer non-owner mode work: the network drill overwrites
// ballModel.position with the latest remote state before tickPhysics runs,
// and the swept test still has a valid prev → curr displacement to test
// against. Reset by spawnBallAt.
const lastBallPos = new THREE.Vector3();
let hadBallPos = false;

// Squash-and-stretch state — clockTime at which the impact deformation expires.
// Purely visual; ballRadius (used for collision) is unchanged. The deformation
// itself is applied per-vertex on the ball mesh via setBallSquash /
// updateBallSquashAmount / resetBallSquash so ballModel's transform (which
// carries spin) stays a pure rigid rotation and can't leak into the spin.
let squashUntil = 0;
// Peak deformation for the currently-active squash. Tracked separately from
// SQUASH_AMOUNT because table bounces scale the peak by bounce intensity —
// a soft drop shouldn't start recovery from the full amount and pop.
let squashPeakAmount = 0;

// Additional collidable paddles (e.g., the AI opponent). Each entry tracks
// its own previous pose so the swept disc-collision math works the same way
// it does for the player. Entries are added/removed by drills via
// registerAIPaddle / unregisterAIPaddle.
const aiPaddles = [];

/**
 * Register an opponent paddle for ball collision. The drill provides a
 * `getFace()` callback that returns the current world-space face center and
 * normal, plus the paddle's linear velocity (m/s). Returns a handle the
 * caller passes back to unregisterAIPaddle on dispose.
 *
 * An optional `isActive()` predicate lets the owner temporarily take the
 * paddle out of the collision set without unregistering it. The AI's serve
 * uses this: during the toss the ball is deliberately flown INTO the paddle
 * and the contact is scripted, so the swept-disc impulse must not also fire.
 * Pose tracking (prevCenter/prevNormal) keeps updating while inactive, so
 * re-activating never produces a stale one-frame sweep.
 *
 * @param {{getFace: () => {center: THREE.Vector3, normal: THREE.Vector3, velocity: THREE.Vector3}, hitRadius?: number, id?: string, isActive?: () => boolean}} cfg
 */
export function registerAIPaddle(cfg) {
  const entry = {
    getFace: cfg.getFace,
    isActive: cfg.isActive ?? null,
    hitRadius: cfg.hitRadius ?? paddleHitRadius,
    id: cfg.id ?? 'ai',
    prevCenter: new THREE.Vector3(),
    prevNormal: new THREE.Vector3(0, 1, 0),
    hadState: false,
    lastHitTime: 0,
  };
  aiPaddles.push(entry);
  return entry;
}

export function unregisterAIPaddle(handle) {
  const idx = aiPaddles.indexOf(handle);
  if (idx >= 0) aiPaddles.splice(idx, 1);
}

// Listeners that want to know when ball events happen (drills, stats).
const listeners = {
  paddleHit: [],
  tableBounce: [],
  netHit: [],
  ballLost: [],
};

// Persistent handler for the pseudo-haptic paddle recoil. Set once at XR
// session start by xrPaddle.js; unlike the drill-scoped listener arrays above
// it survives clearListeners() because it belongs to the session lifetime,
// not the drill lifetime. Called only for local-player collisions.
let paddleRecoilHandler = null;
export function setPaddleRecoilHandler(fn) { paddleRecoilHandler = fn || null; }

export function onPaddleHit(fn) { listeners.paddleHit.push(fn); }
export function onTableBounce(fn) { listeners.tableBounce.push(fn); }
export function onNetHit(fn) { listeners.netHit.push(fn); }
export function onBallLost(fn) { listeners.ballLost.push(fn); }
function removeListener(arr, fn) {
  const i = arr.indexOf(fn);
  if (i !== -1) arr.splice(i, 1);
}
export function offPaddleHit(fn) { removeListener(listeners.paddleHit, fn); }
export function offTableBounce(fn) { removeListener(listeners.tableBounce, fn); }
export function offNetHit(fn) { removeListener(listeners.netHit, fn); }
export function offBallLost(fn) { removeListener(listeners.ballLost, fn); }
function emit(kind, payload) {
  const arr = listeners[kind];
  for (let i = 0; i < arr.length; i++) arr[i](payload);
}

export function clearListeners() {
  listeners.paddleHit.length = 0;
  listeners.tableBounce.length = 0;
  listeners.netHit.length = 0;
  listeners.ballLost.length = 0;
}

export function resetPaddleTracking() {
  hadControllerPos = false;
  hadControllerQuat = false;
  hadRawPose = false;
  paddleAngularVelocity.set(0, 0, 0);
  // Drop stale linear-velocity median-filter samples so the first frame
  // after resume isn't filtered against a stale v from before the disconnect.
  _paddleSampleIdx = 0;
  _paddleSampleCount = 0;
}

// Silently remove the live ball. Used by match flow when the point has been
// DECIDED but the old ball is still rolling/bouncing: play must visibly stop
// so the player isn't rallying a dead ball into the next serve window. Emits
// no ballLost — the rally is already resolved and a stale lost event would
// double-book it.
export function despawnBall() {
  if (!ballModel) return;
  ballModel.visible = false;
  ballVelocity.set(0, 0, 0);
  ballAngularVelocity.set(0, 0, 0);
  stationaryTime = 0;
  resetBallShadow();
  resetBallGhost();
}

export function spawnBallAt(pos, velocity, angularVelocity) {
  if (!ballModel) return;
  ballModel.position.copy(pos);
  ballModel.scale.set(1, 1, 1);
  ballModel.quaternion.set(0, 0, 0, 1);
  resetBallSquash();
  ballModel.visible = true;
  ballVelocity.copy(velocity);
  if (angularVelocity) ballAngularVelocity.copy(angularVelocity);
  else ballAngularVelocity.set(0, 0, 0);
  lastHitTime = 0;
  lastNetHitTime = -Infinity;
  stationaryTime = 0;
  bouncesSinceContact = 0;
  squashUntil = 0;
  lastBallPos.copy(pos);
  hadBallPos = false;
  // Hide the blob shadow until the next tickPhysics places it under the ball,
  // so a fast previous life doesn't leave one hanging at the old position.
  resetBallShadow();
  resetBallGhost();
}

// Project an in-plane contact offset onto a stable 2-D basis of the paddle
// face. Returns {x, y} in metres: x across the face, y along the in-plane
// direction closest to world up.
//
// Scratch vectors are module-scope because this runs on every paddle contact.
const _faceRight = new THREE.Vector3();
const _faceUp = new THREE.Vector3();
// Ball state as it ARRIVED at the paddle, captured before the impulse
// overwrites it. Consumed by the paddleHit payload for M7.
const _hitInVel = new THREE.Vector3();
const _hitInSpin = new THREE.Vector3();
const _hitPos = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _fallbackUp = new THREE.Vector3(0, 0, 1);
function faceLocalContact(onPlane, normal) {
  if (!onPlane || !normal) return null;
  // Near-degenerate when the face points straight up/down: world up is then
  // parallel to the normal and the cross product collapses.
  const ref = Math.abs(normal.dot(_worldUp)) > 0.98 ? _fallbackUp : _worldUp;
  _faceRight.crossVectors(ref, normal);
  if (_faceRight.lengthSq() < 1e-8) return null;
  _faceRight.normalize();
  _faceUp.crossVectors(normal, _faceRight).normalize();
  return { x: onPlane.dot(_faceRight), y: onPlane.dot(_faceUp) };
}

// Shared paddle-ball collision response. Handles the swept disc-collision
// test, restitution-based reflection, spin capture, and the paddleHit event
// emit. Used for both the player paddle and any registered AI paddles.
function tryPaddleCollision(ctx, prevBallPos, dt, clockTime) {
  if (!ballModel || !ballModel.visible) return false;
  const swingMargin = Math.min(ctx.velocity.length() * dt, 0.03);

  const result = detectDiscCollision(
    prevBallPos, ballModel.position,
    ctx.prevCenter, ctx.currCenter,
    ctx.prevNormal, ctx.currNormal,
    ctx.hitRadius + swingMargin, ballRadius, dt,
    ctx.hitRadius,  // faceRadius = physical rim, independent of swingMargin
  );

  if (result.crossed && result.hit && (clockTime - ctx.getLastHit()) > HIT_COOLDOWN) {
    ctx.setLastHit(clockTime);
    // The ball is back in play: its table bounces count from zero again for
    // the dead-ball damp.
    bouncesSinceContact = 0;

    // Edge-strike detection. Only the player paddle triggers the wood-blade
    // model — AI paddles' edge-zone contacts fall back to standard face
    // physics because their paddleSolver plans clean face hits and a random
    // edge branch would break rally intent. When edge fires: reflectNormal
    // is perturbed within a cone (unpredictable deflection), restitution
    // bumps up (wood is stiffer than rubber sponge), and spin capture is
    // sharply reduced (no rubber grip).
    const isEdgeStrike = result.edgeHit && ctx.origin === 'player';
    let impulseNormal = result.reflectNormal;
    let restitution = PADDLE_RESTITUTION;
    let spinCaptureGain = SPIN_CAPTURE_GAIN;
    if (isEdgeStrike) {
      _jitterNormalInCone(result.reflectNormal, PADDLE_EDGE_NORMAL_JITTER_RAD, result.reflectNormal);
      impulseNormal = result.reflectNormal;
      restitution = PADDLE_EDGE_RESTITUTION;
      spinCaptureGain = SPIN_CAPTURE_GAIN * PADDLE_EDGE_SPIN_SCALE;
    }

    // Impulse + spin capture — extracted into a shared pure helper so the
    // AI's paddleSolver can run the same math against synthetic inputs
    // without touching live game state. See js/physics/impulse.js.
    //
    // Both player and AI face contacts use the speed-dependent restitution
    // curve so hard smashes and soft blocks feel physically distinct.
    // Edge strikes skip the curve (isEdgeStrike branch above sets a scalar
    // restitution) — wood-blade contact has a different failure mode than
    // rubber sponge damping and takes its own fixed COR.
    const impulseOpts = ctx.origin === 'player'
      ? playerImpulseOpts()
      : { restitutionCurve: paddleRestitution };
    if (isEdgeStrike) {
      // Strip the curve for edge strikes so the scalar PADDLE_EDGE_RESTITUTION
      // is honored. Only mutates the fresh player-opts object above.
      impulseOpts.restitutionCurve = undefined;
    } else {
      // Sweet-spot falloff — face hits get an attenuation of COR and spin
      // capture based on distance from the face center. Clean center strikes
      // fly and grip at peak; rim face hits bleed extra energy and spin. Not
      // applied on edge strikes (they use their own wood-blade model) — those
      // stay at sweetnessFactor=1.0 default in impulse.js.
      impulseOpts.sweetnessFactor = sweetSpotFactor(result.radialDist, ctx.hitRadius);
    }
    // Capture the INCOMING state before the impulse overwrites it. M7's
    // Why-Did-I-Miss compares what the player did against what the solver
    // says was required, and the solver's input is the ball as it ARRIVED —
    // reading ballVelocity after the impulse gives the outgoing shot instead
    // and the diagnosis would be answering a different question.
    _hitInVel.copy(ballVelocity);
    _hitInSpin.copy(ballAngularVelocity);
    _hitPos.copy(ballModel.position);

    const impulse = computeImpulse(
      ballVelocity, ballAngularVelocity, ballModel.position,
      ctx.velocity, ctx.angularVelocity || null, ctx.pivot || null,
      impulseNormal,
      ballRadius, restitution, spinCaptureGain,
      impulseOpts,
    );

    // Apply impulse outputs to live state.
    ballVelocity.copy(impulse.ballV_out);
    ballAngularVelocity.copy(impulse.ballW_out);

    const swingSpeed = impulse.vContact.length();
    const velDot = impulse.velDot;
    const tangentVel = impulse.slipTangent;
    const deltaOmega = impulse.deltaOmega;
    const impactSpeed = impulse.impactSpeed;

    // P13 §C8: record player hits for drift detection. r_c is result.onPlane
    // (already in the disc-plane basis relative to face center). u_t/v_n uses
    // tangential slip magnitude over normal impact speed — matches the spec's
    // "flat hit" classifier. AI paddles are excluded — their pose is
    // authoritative and can't drift.
    if (ctx.origin === 'player' && impactSpeed > 0.05) {
      // tangentVel is a Vector3 — dividing it by a scalar yields NaN, which
      // silently poisoned every logged hit's flat-hit ratio for a while.
      const utOverVn = impactSpeed > 1e-4 ? tangentVel.length() / impactSpeed : 0;
      recordContactLogHit(result.onPlane.x, result.onPlane.y, result.onPlane.z, utOverVn);
    }

    // Position correction — push ball just outside the paddle face to avoid
    // re-collision next frame. Kept here (not in computeImpulse) because it
    // depends on the collision result, not the impulse math.
    ballModel.position.copy(ctx.currCenter)
      .add(result.onPlane)
      .addScaledVector(result.reflectNormal, ballRadius + 0.005);

    const intensity = Math.min(impactSpeed / HAPTIC_MAX_SPEED, 1.0);
    // Blade-weight shaping for the contact sound. Only the local player's
    // paddle carries a weight setting — the opponent's bat is not in anyone's
    // hand here, so AI / remote contacts stay at the neutral shape.
    const weightShape = ctx.origin === 'player' ? audioWeightShape() : undefined;
    // Edge strikes get the sharp "clack" variant. Face hits keep the
    // rubber-plus-thud sound. Both spatialized at the contact point so the
    // hall reverb pans/decays from the paddle face, not from listener origin.
    if (isEdgeStrike) {
      playPaddleEdgeSound(Math.min(swingSpeed / 3, 1.0), intensity, ctx.currCenter, weightShape);
    } else {
      playPaddleHitSound(Math.min(swingSpeed / 3, 1.0), intensity, ctx.currCenter, weightShape);
    }

    // Haptic pulse — only fire on the local player's paddle. Remote / AI hits
    // already produce no controller force, so they shouldn't buzz our hand.
    if (ctx.origin === 'player') {
      // Off-center face hits vibrate MORE — the bat "rings" in the hand.
      // Squared radial to match the sweet-spot COR falloff shape. Edge
      // strikes already have their own sharp clack character and skip this
      // boost so they don't stack a second buzz on top.
      let hapticBoost = 1.0;
      if (!isEdgeStrike && ctx.hitRadius > 1e-6) {
        const r = Math.min(1, result.radialDist / ctx.hitRadius);
        hapticBoost = 1 + SWEET_SPOT_HAPTIC_BOOST * r * r;
      }
      const hapticIntensity = Math.min(1, Math.max(HAPTIC_FLOOR, intensity) * hapticBoost);
      const hapticDuration =
        HAPTIC_DURATION_MIN_MS + (HAPTIC_DURATION_MAX_MS - HAPTIC_DURATION_MIN_MS) * intensity;
      // Blade weight scales amplitude and duration — the only two axes WebXR
      // gives us. Neutral weight passes both through unchanged.
      const env = hapticWeightEnvelope(hapticIntensity, hapticDuration);
      hapticsPulseImpact(env.intensity, env.durationMs);

      // Visual paddle kick-back — restores pseudo-haptic mass cue without
      // touching the collision pose. See xrPaddle.triggerPaddleRecoil.
      if (paddleRecoilHandler) {
        paddleRecoilHandler(result.reflectNormal, impactSpeed);
      }
    }

    // Squash-and-stretch (visual only; ballRadius unchanged for collision).
    // Applied as a per-vertex world-aligned deformation on the ball mesh
    // itself (see setBallSquash) — NOT as a parent quaternion + non-uniform
    // scale. That older transform-based approach composed with the spin
    // quaternion on the same node, drifting the visible spin axis for the
    // whole 80 ms squash window and snapping back at squash end. The vertex
    // route keeps ballModel's transform a pure rigid rotation so spin stays
    // clean in world regardless of squash state.
    if (SQUASH_AMOUNT > 0 && SQUASH_DURATION > 0) {
      squashUntil = clockTime + SQUASH_DURATION;
      squashPeakAmount = SQUASH_AMOUNT;
      setBallSquash(result.reflectNormal, squashPeakAmount);
    }

    const spinMag = ballAngularVelocity.length();
    const verticalBrush = tangentVel.y;
    const horizontalBrush = Math.hypot(tangentVel.x, tangentVel.z);
    let spinType = 'flat';
    if (Math.abs(verticalBrush) > horizontalBrush && Math.abs(verticalBrush) > 0.05) {
      spinType = verticalBrush > 0 ? 'TOP' : 'BACK';
    } else if (horizontalBrush > 0.05) {
      // Label from the player's perspective (the one reading the HUD): +ωy
      // is CCW viewed from above, which makes the ball curve to the player's
      // right under Magnus, so call it R-SPIN.
      spinType = deltaOmega.y > 0 ? 'R-SPIN' : 'L-SPIN';
    }
    const hitTag = isEdgeStrike ? 'EDGE' : 'HIT!';
    hudLog(`[${hitTag} ${ctx.origin}] swing=${swingSpeed.toFixed(2)} ${spinType} ω=${spinMag.toFixed(1)}`);
    if (SELF_TEST) {
      hudLog(`  radial=${result.radialDist.toFixed(3)}`);
      const pw = ctx.angularVelocity;
      const pwMag = pw ? pw.length() : 0;
      hudLog(`  paddleω=${pwMag.toFixed(1)} Δω=(${deltaOmega.x.toFixed(1)},${deltaOmega.y.toFixed(1)},${deltaOmega.z.toFixed(1)})`);
      hudLog(`  ballω=(${ballAngularVelocity.x.toFixed(1)},${ballAngularVelocity.y.toFixed(1)},${ballAngularVelocity.z.toFixed(1)})`);
    }

    // Contact point on the blade, in face-plane 2-D. M7's Blade Heatmap plots
    // this; without it the heatmap has nothing to draw.
    //
    // The basis is built from the face normal and world up rather than the
    // paddle's own quaternion, which the collision context does not carry.
    // That makes `y` the in-plane direction closest to vertical — which is
    // the axis M7's advice is phrased against anyway ("your loops contact
    // 2 cm low"), and is well defined for every paddle pose except perfectly
    // face-up, where the fallback axis takes over.
    const contactLocal = faceLocalContact(result.onPlane, result.reflectNormal);

    emit('paddleHit', {
      origin: ctx.origin, swingSpeed, impactSpeed, spinType, spinMag, deltaOmega,
      // Outgoing ball speed (m/s) after the impulse — what a broadcast
      // "shot speed" readout shows. impactSpeed is only the normal-axis
      // approach speed, so it under-reads real shot pace.
      outSpeed: impulse.ballV_out.length(),
      edge: isEdgeStrike,
      contactLocal,
      contactRadius: result.radialDist,
      // Contact signature for M2's Stroke Isolation, which classifies the
      // stroke from the tangential/normal velocity ratio (the spec's u_t/v_n):
      // a brushed loop is mostly tangential, a flat drive mostly normal.
      // Taken from the impulse solve rather than recomputed, so the classifier
      // and the physics can never disagree about what the contact was.
      tangentSpeed: tangentVel.length(),
      normalSpeed: Math.abs(velDot),
      // Full contact state for M7's Why-Did-I-Miss. Cloned rather than shared:
      // the scratch vectors above are reused on the next contact, and a
      // listener that stores the payload would otherwise find its history
      // silently rewritten by the following shot.
      contactPos: _hitPos.clone(),
      inVel: _hitInVel.clone(),
      inSpin: _hitInSpin.clone(),
      outVel: ballVelocity.clone(),
      outSpin: ballAngularVelocity.clone(),
      faceNormal: result.reflectNormal.clone(),
    });
    return true;
  }

  if (SELF_TEST && result.crossed && !result.hit) {
    hudLog(`[NEAR MISS ${ctx.origin}] radial=${result.radialDist.toFixed(3)} over=${(result.radialDist - ctx.hitRadius - swingMargin - ballRadius).toFixed(3)}`);
  } else if (SELF_TEST && result.crossed && (clockTime - ctx.getLastHit()) <= HIT_COOLDOWN) {
    hudLog(`[COOLDOWN BLOCK ${ctx.origin}] dt=${(clockTime - ctx.getLastHit()).toFixed(3)}s`);
  }
  return false;
}

// Per-frame physics step. xrController is the THREE.Group from renderer.xr.getControllerGrip()
// (or null for desktop / non-XR contexts). clockTime is the elapsed time used for hit cooldown.
//
// opts.ballOwned (default true): when false, this tick is running on a peer
// that does NOT own the ball. Ball integration and table/net/lost emissions
// are skipped — the network drill writes ballModel.position from interpolated
// remote state before this call. Paddle collision still runs so a local hit
// can trigger an ownership-handoff via the onPaddleHit event.
export function tickPhysics(dt, xrController, clockTime, opts = {}) {
  const ballOwned = opts.ballOwned !== false;
  // Velocity measurement point for this frame — raw face center when
  // opts.getRawPose delivered a pose, else the smoothed anchor's face
  // center. Function-scoped because the player collision ctx (pivot) and
  // the end-of-tick bookkeeping both need it outside the tracking block.
  let velFaceCenter = paddleFaceCenterWorld;
  let rawSampled = false;
  // --- Paddle tracking ---
  if (xrController) {
    // NOTE (P13): xrController here is the smoothed paddleAnchor (see
    // inGame.js — paddleNode = xr.getPaddleAnchor()). The anchor already has
    // T_cal = {posOffset, rotOffset} baked into its pose by xrPaddle.js
    // updatePaddleVisual. Do NOT compose T_cal a second time here (plan
    // Gotcha e) — the mesh and the physics pose derive from the same anchor
    // by design, so "what you see is what collides" extends to calibration
    // for free. If a future refactor adds sweep substeps, each substep must
    // re-read anchor world pose (which will still carry T_cal); do not
    // reintroduce a raw-grip read here without composing T_cal.
    xrController.getWorldPosition(controllerWorldPos);
    xrController.getWorldQuaternion(controllerWorldQuat);

    // paddleFaceOffset is model-local face center from the GLB (models.js).
    // paddleModel.position is (0,0,0) after P13 (used to be a cosmetic (0,
    // 0.005, -0.02) — now folded into calibration.posOffset on the anchor).
    paddleFaceCenterWorld.copy(paddleFaceOffset);
    paddleFaceCenterWorld.applyQuaternion(controllerWorldQuat).add(controllerWorldPos);
    paddleFaceNormalWorld.copy(paddleFaceNormalLocal)
      .applyQuaternion(controllerWorldQuat)
      .normalize();

    if (SELF_TEST) {
      const { debugFaceSphere, debugNormalArrow, debugDiscMesh } = getDebugHelpers();
      if (debugFaceSphere) {
        debugFaceSphere.position.copy(paddleFaceCenterWorld);
        debugNormalArrow.position.copy(paddleFaceCenterWorld);
        debugNormalArrow.setDirection(paddleFaceNormalWorld);
        debugDiscMesh.position.copy(paddleFaceCenterWorld);
        debugDiscMesh.lookAt(paddleFaceCenterWorld.clone().add(paddleFaceNormalWorld));
      }
    }

    // Pick the velocity measurement source. The anchor pose above is EMA-
    // smoothed (pseudo-haptic weight) — finite-differencing it low-passes
    // the velocity and shaves the one-frame brush peaks that generate spin.
    // When the caller supplies the raw calibrated pose, measure velocities
    // there instead; contact geometry stays on the smoothed anchor. See the
    // _rawPosePos block at module scope for the full rationale.
    let velQuat = controllerWorldQuat;
    let velPrevCenter = prevPaddleFaceCenter;
    let velPrevQuat = prevControllerWorldQuat;
    let haveVelPrev = hadControllerPos;
    let haveVelPrevQuat = hadControllerQuat;
    if (opts.getRawPose && opts.getRawPose(_rawPosePos, _rawPoseQuat)) {
      _rawFaceCenter.copy(paddleFaceOffset)
        .applyQuaternion(_rawPoseQuat)
        .add(_rawPosePos);
      velFaceCenter = _rawFaceCenter;
      velQuat = _rawPoseQuat;
      velPrevCenter = prevRawFaceCenter;
      velPrevQuat = prevRawPoseQuat;
      haveVelPrev = hadRawPose;
      haveVelPrevQuat = hadRawPose;
      rawSampled = true;
    }

    if (haveVelPrev && dt > 0) {
      // Raw per-frame delta, then median-of-3 filtered into paddleVelocity.
      _rawPaddleVel.subVectors(velFaceCenter, velPrevCenter).divideScalar(dt);
      _pushAndMedian(_velSamples, _rawPaddleVel, paddleVelocity);

      // Paddle angular velocity in world space, derived from Δq = q_curr * q_prev⁻¹.
      // Required so wrist-snap / paddle-roll strokes (small face-center translation,
      // large rotation) contribute to the contact-point velocity used in the
      // reflection — otherwise the ball reflects as if the paddle were stationary.
      // Unfiltered: a brush stroke's peak ω lasts ~1 frame and the linear-vel
      // median-of-3 would discard it (see comment at _velSamples above).
      if (haveVelPrevQuat) {
        const dq = _dqScratch.copy(velQuat)
          .multiply(_qInvScratch.copy(velPrevQuat).invert());
        if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
        const w = Math.min(1, Math.max(-1, dq.w));
        const angle = 2 * Math.acos(w);
        const s = Math.sqrt(Math.max(0, 1 - w * w));
        if (s > 1e-4 && angle > 1e-4) {
          _rawPaddleAng.set(dq.x / s, dq.y / s, dq.z / s).multiplyScalar(angle / dt);
        } else {
          _rawPaddleAng.set(0, 0, 0);
        }
        paddleAngularVelocity.copy(_rawPaddleAng);
      }

      // Advance the ring index once per frame after the linear-vel filter has
      // taken its sample for this frame.
      _paddleSampleIdx = (_paddleSampleIdx + 1) % 3;
      if (_paddleSampleCount < 3) _paddleSampleCount++;

      // Weight cues that fire only during motion — no visual lag, but the
      // player feels resistance (haptic buzz) and hears air being cut (whoosh).
      //
      // RAW velocity, not the median-of-3 filtered one. This is the same reason
      // angular velocity above is left unfiltered: a wrist jerk's peak lasts
      // about one frame, and median-of-3 is precisely the filter that discards
      // a one-frame spike. Feeding it the filtered value meant the harder and
      // faster you flicked, the less of the swing the cues saw — so the blade
      // swept a big visible arc (2:1 lever ratio about the grip) while the hand
      // felt and heard nothing. That sensory contradiction is what reads as the
      // blade not really being attached; it is also the whole of "the paddle
      // has no weight". Inertia is felt DURING the swing, not at contact.
      //
      // Noise is handled by SWING_HAPTIC_THRESHOLD instead: at rest the raw
      // value sits far below it, and the cost of a stray one-frame spike is a
      // 22 ms buzz, which is much cheaper than losing every jerk.
      const swingSpeed = _rawPaddleVel.length();
      updateSwingWhoosh(swingSpeed);
      pulseSwing(
        swingSpeed,
        SWING_HAPTIC_THRESHOLD, SWING_HAPTIC_MAX_SPEED,
        SWING_HAPTIC_MAX_INTENSITY, SWING_HAPTIC_PULSE_MS,
        SWING_HAPTIC_CURVE,
      );
    }
  } else {
    // No XR controller this frame — silence the whoosh so it doesn't hold its
    // last gain value when the session pauses or the paddle disconnects.
    updateSwingWhoosh(0);
  }

  if (ballModel && ballModel.visible) {
    // Owner-only integration. Non-owner had ballModel.position written by the
    // multiplayer drill before this call, so prev (last frame) → curr (this
    // frame) is the remote-driven displacement we collide against.
    const prevBallPos = _prevBallPos.copy(hadBallPos ? lastBallPos : ballModel.position);

    if (ballOwned) {
      // Visual spin rotation — reads ω before stepBallFlight damps it. Spin
      // lives directly on ballModel; squash is a vertex-buffer deformation
      // (see setBallSquash), so ballModel's transform is a pure rigid
      // rotation and premultiplying dq here rotates the ball about ω in
      // world space regardless of whether squash is active.
      if (ballAngularVelocity.lengthSq() > 1e-4) {
        const omega = ballAngularVelocity.length();
        if (omega > 0.01) {
          _spinAxis.copy(ballAngularVelocity).multiplyScalar(1 / omega);
          _spinDq.setFromAxisAngle(_spinAxis, omega * dt);
          ballModel.quaternion.premultiply(_spinDq);
        }
      }

      // Gravity + buoyancy + Magnus + spin damping + quadratic drag +
      // position advance. rollout.js used to MIRROR this block; now it IS
      // this block — live physics and every predictive path (AI rollout,
      // preview, multiplayer dead reckoning) share one integrator.
      //
      // Integrated in equal substeps capped at MAX_FLIGHT_STEP. The collision
      // blocks below are untouched by this: they all sweep prevBallPos → the
      // post-step position across the WHOLE frame, so substepping refines the
      // trajectory without changing how contacts are detected.
      const nSub = dt > MAX_FLIGHT_STEP ? Math.ceil(dt / MAX_FLIGHT_STEP) : 1;
      const hSub = dt / nSub;
      for (let i = 0; i < nSub; i++) {
        integrateFlightStep(ballModel.position, ballVelocity, ballAngularVelocity, hSub);
      }
    }

    // --- Paddle-ball collision (player) ---
    // P13 §C7: suppress player-paddle contacts for up to 100 ms after the
    // most recent emulated-position frame. Skipping this gate would let a
    // teleport-during-tracking-hiccup register as a swing at 40+ m/s.
    // AI paddles are unaffected — their pose is authoritative, not tracked.
    if (xrController && hadControllerPos && !trackingShouldSuppressContact()) {
      tryPaddleCollision({
        origin: 'player',
        prevCenter: prevPaddleFaceCenter,
        currCenter: paddleFaceCenterWorld,
        prevNormal: prevPaddleFaceNormal,
        currNormal: paddleFaceNormalWorld,
        velocity: paddleVelocity,
        angularVelocity: paddleAngularVelocity,
        // Face-center reference for the ω×r term. paddleVelocity is the
        // finite-diff of velFaceCenter (raw face center when opts.getRawPose
        // is live, smoothed otherwise), so the pivot must be that SAME point
        // (not the controller grip, and not the other pose's face center) or
        // the wrist-rotation contribution gets double-counted.
        pivot: velFaceCenter,
        hitRadius: paddleHitRadius,
        getLastHit: () => lastHitTime,
        setLastHit: (t) => { lastHitTime = t; },
      }, prevBallPos, dt, clockTime);
    }

    // --- Paddle-ball collision (AI opponent paddles) ---
    for (const ap of aiPaddles) {
      const face = ap.getFace();
      if (ap.hadState && (!ap.isActive || ap.isActive())) {
        tryPaddleCollision({
          origin: ap.id,
          prevCenter: ap.prevCenter,
          currCenter: face.center,
          prevNormal: ap.prevNormal,
          currNormal: face.normal,
          velocity: face.velocity,
          hitRadius: ap.hitRadius,
          getLastHit: () => ap.lastHitTime,
          setLastHit: (t) => { ap.lastHitTime = t; },
        }, prevBallPos, dt, clockTime);
      }
      ap.prevCenter.copy(face.center);
      ap.prevNormal.copy(face.normal);
      ap.hadState = true;
    }

    // --- Net collision (segment-vs-AABB slab) ---
    // Owner-only: the non-owner mirrors net/table/lost events via the reliable
    // eventChannel so collision side-effects (sounds, score) aren't duplicated.
    if (ballOwned && netBox) {
      const dirX = ballModel.position.x - prevBallPos.x;
      const dirY = ballModel.position.y - prevBallPos.y;
      const dirZ = ballModel.position.z - prevBallPos.z;
      let tEnter = -Infinity, tExit = Infinity;
      let hitAxis = null;
      let miss = false;
      const axes = [
        ['x', prevBallPos.x, dirX, netBox.min.x, netBox.max.x],
        ['y', prevBallPos.y, dirY, netBox.min.y, netBox.max.y],
        ['z', prevBallPos.z, dirZ, netBox.min.z, netBox.max.z],
      ];
      for (const [axis, o, d, mn, mx] of axes) {
        if (Math.abs(d) < 1e-9) {
          if (o < mn || o > mx) { miss = true; break; }
          continue;
        }
        let t1 = (mn - o) / d;
        let t2 = (mx - o) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tEnter) { tEnter = t1; hitAxis = axis; }
        if (t2 < tExit) tExit = t2;
        if (tEnter > tExit) { miss = true; break; }
      }
      if (!miss && hitAxis && tEnter >= 0 && tEnter <= 1) {
        // Resolve only the hit axis: snap to the entry face plus an escape
        // margin, keeping the frame's tangential advance so the ball slides
        // along the face (rewinding all three axes to tEnter discarded most
        // of each frame's horizontal travel on shallow re-contacts, pinning
        // the ball on the cord instead of letting it dribble over).
        // The margin must beat next frame's motion or the segment re-enters
        // the slab immediately; a fixed 1e-4 loses to a single 90 Hz gravity
        // step (~1.2 mm), so scale with the frame's displacement on the hit
        // axis, floored at 1 mm.
        //
        // One physical contact spans several frames of residual overlap, so
        // the velocity response, spin damp, sound, and netHit event fire only
        // once per NET_HIT_COOLDOWN — position is still corrected on every
        // frame so the ball can never tunnel through the net.
        const freshHit = (clockTime - lastNetHitTime) > NET_HIT_COOLDOWN;
        if (hitAxis === 'z') {
          const eps = Math.max(1e-3, Math.abs(dirZ) * 0.5);
          ballModel.position.z = dirZ >= 0 ? netBox.min.z - eps : netBox.max.z + eps;
          if (freshHit) {
            ballVelocity.z *= -NET_NORMAL_RESTITUTION;
            ballVelocity.x *= NET_TANGENT_DAMP;
            ballVelocity.y *= NET_TANGENT_DAMP;
          }
        } else if (hitAxis === 'x') {
          const eps = Math.max(1e-3, Math.abs(dirX) * 0.5);
          ballModel.position.x = dirX >= 0 ? netBox.min.x - eps : netBox.max.x + eps;
          if (freshHit) {
            ballVelocity.x *= -NET_NORMAL_RESTITUTION;
            ballVelocity.y *= NET_TANGENT_DAMP;
            ballVelocity.z *= NET_TANGENT_DAMP;
          }
        } else {
          // hitAxis === 'y'. Top-cord hit (dirY < 0, ball descending onto the
          // top edge) is a physically distinct event from a bottom-face hit —
          // the cord is a tensioned string that kills vertical energy but
          // preserves horizontal drift and adds a small unpredictable lateral
          // deflection. This is the classic "let ball" dribble-over moment.
          const isTopCord = dirY < 0;
          const eps = Math.max(1e-3, Math.abs(dirY) * 0.5);
          ballModel.position.y = dirY >= 0 ? netBox.min.y - eps : netBox.max.y + eps;
          if (freshHit) {
            if (isTopCord) {
              ballVelocity.y *= -NET_TOP_CORD_RESTITUTION;
              ballVelocity.x *= NET_TOP_CORD_TANGENT_KEEP;
              ballVelocity.z *= NET_TOP_CORD_TANGENT_KEEP;
              // Random horizontal impulse — cord tension asymmetry and finite-
              // diameter geometry produce a small unpredictable sideways kick.
              // Uniform azimuth, fixed magnitude — this is a stylized effect,
              // not a full cord-dynamics simulation.
              const azimuth = Math.random() * Math.PI * 2;
              ballVelocity.x += NET_TOP_CORD_LATERAL_JITTER * Math.cos(azimuth);
              ballVelocity.z += NET_TOP_CORD_LATERAL_JITTER * Math.sin(azimuth);
              // Micro-bounce cutoff (same idea as the table's): a sub-5 cm/s
              // rebound can't clear the escape margin anyway — rest on the
              // cord and let gravity plus horizontal drift carry the ball off.
              if (Math.abs(ballVelocity.y) < 0.05) ballVelocity.y = 0;
            } else {
              ballVelocity.y *= -NET_NORMAL_RESTITUTION;
              ballVelocity.x *= NET_TANGENT_DAMP;
              ballVelocity.z *= NET_TANGENT_DAMP;
            }
          }
        }
        if (freshHit) {
          lastNetHitTime = clockTime;
          ballAngularVelocity.multiplyScalar(NET_SPIN_DAMP);
          playBounceSound(0.2, ballModel.position);
          if (SELF_TEST) hudLog(`[NET HIT] axis=${hitAxis} t=${tEnter.toFixed(2)}`);
          emit('netHit', { axis: hitAxis });
        }
      }
    }

    // --- Bounce off table surface ---
    // Computed here, after paddle/net resolution, so the bounce test sees the
    // ball where those blocks actually left it, not its pre-collision height.
    const ballBottom = ballModel.position.y - ballRadius;
    // Interpolate the surface-crossing point from last frame's position and
    // judge in/out THERE, not at the post-step position. At 90 Hz a smash
    // carries ~15 cm of horizontal travel per frame, so testing the AABB at
    // the post-step position called every landing late by up to that much —
    // and a legitimately-in deep ball could cross the surface just inside
    // the baseline, be sampled past it, fail the AABB test, and be scored
    // out. rolloutToSurfacePlane already interpolates for prediction; this
    // brings live physics into agreement at exactly the margin where deep
    // calls happen. Falls back to the post-step position when the previous
    // sample doesn't straddle the plane (spawn frame, or a paddle hit moved
    // the ball below the surface within a single frame).
    let bounceX = ballModel.position.x;
    let bounceZ = ballModel.position.z;
    if (hadBallPos && ballBottom <= tableSurfaceY) {
      const prevBottom = prevBallPos.y - ballRadius;
      if (prevBottom > tableSurfaceY) {
        const span = prevBottom - ballBottom;
        const frac = span > 1e-9 ? (prevBottom - tableSurfaceY) / span : 0;
        bounceX = prevBallPos.x + (ballModel.position.x - prevBallPos.x) * frac;
        bounceZ = prevBallPos.z + (ballModel.position.z - prevBallPos.z) * frac;
      }
    }
    if (ballOwned && tableBox &&
        ballBottom <= tableSurfaceY &&
        bounceX >= tableBox.min.x && bounceX <= tableBox.max.x &&
        bounceZ >= tableBox.min.z && bounceZ <= tableBox.max.z &&
        ballVelocity.y < 0) {
      ballModel.position.y = tableSurfaceY + ballRadius;
      // Bounce response — speed-dependent COR, spin-coupled friction,
      // sidespin lateral kick, micro-bounce settle — is the shared
      // implementation in rollout.js. applyTableBounce IS the block that
      // used to live inline here (moved for the same reason as
      // integrateFlightStep: live physics and every predictive path must
      // ride one implementation), and unlike the old inline copy it is
      // allocation-free. Returns |v_y| BEFORE the reflection, which drives
      // sound, haptic, and squash intensity consistently.
      const bounceImpact = applyTableBounce(ballVelocity, ballAngularVelocity, ballRadius);
      // Dead-ball damping: from the third bounce with no paddle contact the
      // ball is dead in every mode, and at the lively-table COR (clamped at
      // COR_MAX for all impacts below ~3.9 m/s) it would otherwise keep
      // bouncing for 15+ seconds before the stuck-ball detector could fire —
      // stalling any feeder that waits on ballLost. Bleed extra vertical
      // energy so it visibly comes to rest within a few hops.
      if (++bouncesSinceContact >= DEAD_BALL_BOUNCES) {
        ballVelocity.y *= DEAD_BALL_COR_SCALE;
      }
      const bounceIntensity = Math.min(bounceImpact / 5, 1.0);
      playBounceSound(bounceIntensity, ballModel.position);
      // Light haptic so the table has felt presence — scaled below paddle hits
      // so the player can still distinguish "I hit it" from "table caught it."
      hapticsPulseActive(bounceIntensity * HAPTIC_BOUNCE_SCALE, HAPTIC_DURATION_MIN_MS);

      // Squash-and-stretch on table bounce — same vertex-buffer mechanism
      // used for paddle hits, direction = world-up. Amount scales with
      // bounceIntensity so a soft drop barely deforms and a hard slam gets
      // the full pancake. Matches the paddle-hit polish so bounces don't
      // feel underweighted by comparison.
      if (SQUASH_AMOUNT > 0 && SQUASH_DURATION > 0 && bounceIntensity > 0.05) {
        squashUntil = clockTime + SQUASH_DURATION;
        squashPeakAmount = SQUASH_AMOUNT * bounceIntensity;
        setBallSquash(_tableSquashNormal, squashPeakAmount);
      }

      // Report the interpolated crossing point — it is where the ball
      // physically met the table, and it's what scoring/stats should judge.
      emit('tableBounce', { x: bounceX, z: bounceZ, impactSpeed: bounceImpact });
    }

    // --- Table edge ("edge ball") — spec P8 ---
    // Ball collides with the top-edge curve of the table if its center is
    // outside the XZ AABB but within ballRadius of the nearest point on the
    // perimeter line at tableSurfaceY. Uses a radial contact normal (from
    // nearest edge point → ball center) instead of (0,1,0), so the ball
    // deflects along the geometry of the corner — outward and mostly down.
    // The signature "unreturnable edge ball" of table tennis. Runs only in
    // the mutually-exclusive "outside AABB" branch so it can't double-fire
    // with the flat table bounce above.
    //
    // Discrete detection (checks at ballModel.position each frame). At rally
    // speeds near the edge (typically <8 m/s vertical), one physics step
    // moves the ball <4 cm — well inside the 4 cm edge sphere-check band, so
    // no tunneling under normal play. High-speed grazing shots at the edge
    // are already unreliable in real TT — the discrete miss rate here
    // matches the physical unreliability, which is arguably realistic.
    if (ballOwned && tableBox) {
      const bx = ballModel.position.x;
      const bz = ballModel.position.z;
      const cx = Math.max(tableBox.min.x, Math.min(tableBox.max.x, bx));
      const cz = Math.max(tableBox.min.z, Math.min(tableBox.max.z, bz));
      const dx = bx - cx;
      const dz = bz - cz;
      const outsideXZ = (dx !== 0) || (dz !== 0);
      if (outsideXZ) {
        const dy = ballModel.position.y - tableSurfaceY;
        const distSq = dx * dx + dy * dy + dz * dz;
        const rSq = ballRadius * ballRadius;
        if (distSq < rSq && distSq > 1e-12) {
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const ny = dy / dist;
          const nz = dz / dist;
          const vDotN = ballVelocity.x * nx + ballVelocity.y * ny + ballVelocity.z * nz;
          if (vDotN < 0) {
            const impactSpeed = -vDotN;
            const en = tableRestitution(impactSpeed) * TABLE_EDGE_COR_SCALE;
            // Standard reflection along the radial normal: v_out = v - (1+e)(v·n)n
            const j = (1 + en) * vDotN;
            ballVelocity.x -= j * nx;
            ballVelocity.y -= j * ny;
            ballVelocity.z -= j * nz;
            // Position correction — push ball just outside the edge sphere so
            // next frame doesn't retrigger at t=0.
            const push = ballRadius - dist + 1e-4;
            ballModel.position.x += nx * push;
            ballModel.position.y += ny * push;
            ballModel.position.z += nz * push;
            // Chaotic contact — kill spin harder than a flat bounce. Spec
            // permits skipping spin coupling; a hard damp is more honest
            // than transferring inaccurately.
            ballAngularVelocity.multiplyScalar(TABLE_EDGE_SPIN_DAMP);
            const bounceIntensity = Math.min(impactSpeed / 5, 1.0);
            playBounceSound(bounceIntensity, ballModel.position);
            if (SELF_TEST) hudLog(`[EDGE BALL] impact=${impactSpeed.toFixed(2)}`);
            // Tag the tableBounce event with edge:true so rally scoring and
            // stats can distinguish edge balls from clean bounces.
            emit('tableBounce', { x: ballModel.position.x, z: ballModel.position.z, impactSpeed, edge: true });
          }
        }
      }
    }

    // --- Rolling friction ---
    // Once the ball has settled onto the table (near-surface height, tiny
    // vertical velocity) it should roll to a stop instead of gliding
    // frictionlessly. Applies to horizontal velocity only — vertical is
    // already handled by the bounce path. Gated on being INSIDE the table
    // footprint so a ball rolling off the edge continues into free-fall.
    if (ballOwned && tableBox &&
        ballModel.position.y - ballRadius - tableSurfaceY < 0.005 &&
        Math.abs(ballVelocity.y) < ROLLING_VY_THRESHOLD &&
        ballModel.position.x >= tableBox.min.x && ballModel.position.x <= tableBox.max.x &&
        ballModel.position.z >= tableBox.min.z && ballModel.position.z <= tableBox.max.z) {
      const decay = Math.max(0, 1 - ROLLING_FRICTION * dt);
      ballVelocity.x *= decay;
      ballVelocity.z *= decay;
    }

    // --- Floor bounce (spec P8) ---
    // Ball bounces off the visible floor plane at FLOOR_LEVEL_Y (y=0 in
    // arena mode) so missed shots don't clip through the ground. Same
    // spin-coupling math as the table bounce: linear friction on the
    // horizontal, angular impulse from slip, spin damping proportional to
    // impact. Runs before the FLOOR_Y (out-of-world safety) check below —
    // under normal play the ball dissipates all vertical energy here and
    // never reaches FLOOR_Y at all. Only triggers when the ball is BELOW
    // the table height (so we don't fake-bounce a ball that's currently
    // above the table); the table-XZ check on the table-bounce block already
    // handles balls above the play surface.
    if (ballOwned && ballModel.position.y - ballRadius <= FLOOR_LEVEL_Y &&
        ballVelocity.y < 0 &&
        ballModel.position.y < tableSurfaceY) {
      ballModel.position.y = FLOOR_LEVEL_Y + ballRadius;
      const floorImpact = Math.abs(ballVelocity.y);
      const floorIntensity = Math.min(floorImpact / 5, 1.0);
      // Softer plop than table — floor is not a taut playing surface. Reuse
      // the bounce sound scaled down so we don't need a separate asset.
      playBounceSound(floorIntensity * 0.45, ballModel.position);
      ballVelocity.y *= -FLOOR_RESTITUTION;

      // Spin coupling: mirror of the table math but with FLOOR_FRICTION.
      _floorNegYR.set(0, -ballRadius, 0);
      _floorSurfVel.crossVectors(ballAngularVelocity, _floorNegYR);
      _floorSlip.copy(ballVelocity).add(_floorSurfVel).negate();
      _floorSlip.y = 0;
      ballVelocity.x += _floorSlip.x * FLOOR_FRICTION;
      ballVelocity.z += _floorSlip.z * FLOOR_FRICTION;

      // Floor kills spin harder than the table (bare concrete/wood is less
      // grippy than rubber, and there's no re-launch to preserve it for).
      ballAngularVelocity.multiplyScalar(FLOOR_SPIN_DAMP);

      // Squash-and-stretch — same mechanism used for paddle and table hits,
      // world-up normal, amount scaled by bounce intensity. Gated on
      // floorIntensity > 0.05 so residual micro-bounces don't pop the mesh
      // every frame. Without this the ball visibly compresses on paddle and
      // table hits but goes rigid on floor bounces — inconsistent tactile
      // read that a VR player notices.
      if (SQUASH_AMOUNT > 0 && SQUASH_DURATION > 0 && floorIntensity > 0.05) {
        squashUntil = clockTime + SQUASH_DURATION;
        squashPeakAmount = SQUASH_AMOUNT * floorIntensity;
        setBallSquash(_tableSquashNormal, squashPeakAmount);
      }

      // Micro-bounce cutoff — same idea as the table's 0.05 clamp so the
      // ball settles instead of trickling forever.
      if (Math.abs(ballVelocity.y) < 0.1) ballVelocity.y = 0;
    }

    if (ballOwned) {
      if (ballModel.position.y < FLOOR_Y) {
        ballModel.visible = false;
        ballVelocity.set(0, 0, 0);
        ballAngularVelocity.set(0, 0, 0);
        stationaryTime = 0;
        emit('ballLost', { reason: 'floor' });
      } else {
        // Stuck-ball recovery: ball settled on table or wedged near net.
        const speed = ballVelocity.length();
        if (speed < STATIONARY_VEL) {
          stationaryTime += dt;
          if (stationaryTime >= STATIONARY_TIME) {
            ballModel.visible = false;
            ballVelocity.set(0, 0, 0);
            ballAngularVelocity.set(0, 0, 0);
            stationaryTime = 0;
            emit('ballLost', { reason: 'stuck' });
          }
        } else {
          stationaryTime = 0;
        }
      }
    }

    // Squash-and-stretch recovery — linear taper of the vertex-buffer
    // deformation from peak amount back to zero. The world-space compression
    // direction was baked at impact by setBallSquash; we only need to shrink
    // the amount here. Visual only; ball collision uses ballRadius unchanged.
    if (squashUntil > 0) {
      const remaining = squashUntil - clockTime;
      if (remaining > 0) {
        const k = squashPeakAmount * (remaining / SQUASH_DURATION);
        updateBallSquashAmount(k);
      } else {
        resetBallSquash();
        squashUntil = 0;
        squashPeakAmount = 0;
      }
    }

    // Blob shadow — depth cue for the ball above the table. Follows XZ,
    // fades/shrinks with height. Fed AFTER all collisions have resolved, and
    // works identically for owner and network non-owner because
    // ballModel.position was already written by whichever path is active.
    updateBallShadow(ballModel.position);
    updateBallGhost(ballModel.position);

    // Rolling audio — persistent looped noise, spatialized at the ball's
    // world position. Gated on the ball being on a surface (table interior
    // OR below-table floor) with tiny vertical velocity. Silent when
    // airborne — otherwise the source would hiss constantly during flight.
    // Same near-surface + low-vy predicate as the ROLLING_FRICTION block
    // above, plus an analogous floor case for missed shots that have
    // settled on the ground. Passing speed=0 fades the sound out via the
    // exponential smoothing inside updateBallRoll.
    {
      const vyAbs = Math.abs(ballVelocity.y);
      const hSpeed = Math.hypot(ballVelocity.x, ballVelocity.z);
      const onTable = !!tableBox &&
        ballModel.position.y - ballRadius - tableSurfaceY < 0.005 &&
        vyAbs < ROLLING_VY_THRESHOLD &&
        ballModel.position.x >= tableBox.min.x && ballModel.position.x <= tableBox.max.x &&
        ballModel.position.z >= tableBox.min.z && ballModel.position.z <= tableBox.max.z;
      const onFloor = ballModel.position.y - ballRadius - FLOOR_LEVEL_Y < 0.005 &&
        vyAbs < ROLLING_VY_THRESHOLD &&
        ballModel.position.y < tableSurfaceY;
      updateBallRoll(onTable || onFloor ? hSpeed : 0, ballModel.position);
    }

    lastBallPos.copy(ballModel.position);
    hadBallPos = true;
  }

  if (xrController) {
    prevPaddleFaceCenter.copy(paddleFaceCenterWorld);
    prevPaddleFaceNormal.copy(paddleFaceNormalWorld);
    prevControllerWorldQuat.copy(controllerWorldQuat);
    hadControllerPos = true;
    hadControllerQuat = true;
    // Raw-pose history is valid only when this frame actually sampled one;
    // dropping it on a gap forces a passthrough frame instead of a finite
    // diff across the gap when the raw source comes back.
    if (rawSampled) {
      prevRawFaceCenter.copy(_rawFaceCenter);
      prevRawPoseQuat.copy(_rawPoseQuat);
      hadRawPose = true;
    } else {
      hadRawPose = false;
    }
  }
}
