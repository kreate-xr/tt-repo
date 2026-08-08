import * as THREE from 'three';
import {
  ballModel, tableBox, netBox, tableSurfaceY, ballRadius,
  paddleHitRadius, paddleFaceOffset, paddleFaceNormalLocal, getDebugHelpers,
  setBallSquash, updateBallSquashAmount, resetBallSquash,
} from '../scene/models.js';
import { playBounceSound, playPaddleHitSound, playPaddleEdgeSound, updateSwingWhoosh, updateBallRoll } from '../scene/audio.js';
import { updateBallTrail, resetBallTrail } from '../scene/ballTrail.js';
import { updateBallShadow, resetBallShadow } from '../scene/ballShadow.js';
import { updateBallGhost, resetBallGhost } from '../scene/ballGhost.js';
import { SELF_TEST, hudLog } from '../scene/hud.js';
import { detectDiscCollision } from './collisions.js';
import { computeImpulse } from './impulse.js';
import { pulseActive as hapticsPulseActive, pulseImpact as hapticsPulseImpact, pulseSwing } from '../xr/haptics.js';
import { shouldSuppressContact as trackingShouldSuppressContact } from '../xr/trackingLossGuard.js';
import { recordHit as recordContactLogHit } from '../xr/contactLog.js';
import { integrateFlightStep } from './rollout.js';
import {
  SPIN_CAPTURE_GAIN,
  TABLE_SPIN_GAIN, TABLE_LINEAR_FRICTION, TABLE_SIDESPIN_KICK,
  NET_NORMAL_RESTITUTION, NET_TANGENT_DAMP, NET_SPIN_DAMP,
  NET_TOP_CORD_RESTITUTION, NET_TOP_CORD_TANGENT_KEEP, NET_TOP_CORD_LATERAL_JITTER,
  PADDLE_RESTITUTION, HIT_COOLDOWN, FLOOR_Y,
  FLOOR_LEVEL_Y, FLOOR_RESTITUTION, FLOOR_FRICTION, FLOOR_SPIN_DAMP,
  TABLE_EDGE_SPIN_DAMP, TABLE_EDGE_COR_SCALE,
  STATIONARY_VEL, STATIONARY_TIME,
  ROLLING_FRICTION, ROLLING_VY_THRESHOLD,
  SQUASH_DURATION, SQUASH_AMOUNT,
  HAPTIC_FLOOR, HAPTIC_MAX_SPEED, HAPTIC_DURATION_MIN_MS, HAPTIC_DURATION_MAX_MS,
  HAPTIC_BOUNCE_SCALE,
  SWING_HAPTIC_THRESHOLD, SWING_HAPTIC_MAX_SPEED, SWING_HAPTIC_MAX_INTENSITY, SWING_HAPTIC_PULSE_MS,
  PADDLE_CONTACT_SPEED_CAP, PADDLE_ANGULAR_CONTRIBUTION,
  PADDLE_EDGE_RESTITUTION, PADDLE_EDGE_SPIN_SCALE, PADDLE_EDGE_NORMAL_JITTER_RAD,
  SWEET_SPOT_HAPTIC_BOOST,
  paddleRestitution, tableRestitution, sweetSpotFactor,
} from './constants.js';

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
const _tableSquashNormal = new THREE.Vector3(0, 1, 0);
export const paddleFaceCenterWorld = new THREE.Vector3();
export const paddleFaceNormalWorld = new THREE.Vector3();
const prevPaddleFaceCenter = new THREE.Vector3();
const prevPaddleFaceNormal = new THREE.Vector3(0, 1, 0);
let hadControllerPos = false;
let hadControllerQuat = false;
let lastHitTime = 0;
let stationaryTime = 0;

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
 * @param {{getFace: () => {center: THREE.Vector3, normal: THREE.Vector3, velocity: THREE.Vector3}, hitRadius?: number, id?: string}} cfg
 */
export function registerAIPaddle(cfg) {
  const entry = {
    getFace: cfg.getFace,
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
  paddleAngularVelocity.set(0, 0, 0);
  // Drop stale linear-velocity median-filter samples so the first frame
  // after resume isn't filtered against a stale v from before the disconnect.
  _paddleSampleIdx = 0;
  _paddleSampleCount = 0;
}

export function spawnBallAt(pos, velocity, angularVelocity) {
  if (!ballModel) return;
  ballModel.position.copy(pos);
  ballModel.scale.set(1, 1, 1);
  ballModel.quaternion.set(0, 0, 0, 1);
  resetBallSquash();
  ballModel.visible = true;
  ballVelocity.copy(velocity);
  ballAngularVelocity.copy(angularVelocity || new THREE.Vector3());
  lastHitTime = 0;
  stationaryTime = 0;
  squashUntil = 0;
  lastBallPos.copy(pos);
  hadBallPos = false;
  // Drop the motion trail so a fast previous life doesn't leave a streak
  // hanging in space at the new spawn point. Same reasoning for the blob
  // shadow — hide it until the next tickPhysics places it under the ball.
  resetBallTrail();
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
      const utOverVn = impactSpeed > 1e-4 ? tangentVel / impactSpeed : 0;
      recordContactLogHit(result.onPlane.x, result.onPlane.y, result.onPlane.z, utOverVn);
    }

    // Position correction — push ball just outside the paddle face to avoid
    // re-collision next frame. Kept here (not in computeImpulse) because it
    // depends on the collision result, not the impulse math.
    ballModel.position.copy(ctx.currCenter)
      .add(result.onPlane)
      .addScaledVector(result.reflectNormal, ballRadius + 0.005);

    const intensity = Math.min(impactSpeed / HAPTIC_MAX_SPEED, 1.0);
    // Edge strikes get the sharp "clack" variant. Face hits keep the
    // rubber-plus-thud sound. Both spatialized at the contact point so the
    // hall reverb pans/decays from the paddle face, not from listener origin.
    if (isEdgeStrike) {
      playPaddleEdgeSound(Math.min(swingSpeed / 3, 1.0), intensity, ctx.currCenter);
    } else {
      playPaddleHitSound(Math.min(swingSpeed / 3, 1.0), intensity, ctx.currCenter);
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
      hapticsPulseImpact(hapticIntensity, hapticDuration);

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

    if (hadControllerPos && dt > 0) {
      // Raw per-frame delta, then median-of-3 filtered into paddleVelocity.
      _rawPaddleVel.subVectors(paddleFaceCenterWorld, prevPaddleFaceCenter).divideScalar(dt);
      _pushAndMedian(_velSamples, _rawPaddleVel, paddleVelocity);

      // Paddle angular velocity in world space, derived from Δq = q_curr * q_prev⁻¹.
      // Required so wrist-snap / paddle-roll strokes (small face-center translation,
      // large rotation) contribute to the contact-point velocity used in the
      // reflection — otherwise the ball reflects as if the paddle were stationary.
      // Unfiltered: a brush stroke's peak ω lasts ~1 frame and the linear-vel
      // median-of-3 would discard it (see comment at _velSamples above).
      if (hadControllerQuat) {
        const dq = controllerWorldQuat.clone().multiply(prevControllerWorldQuat.clone().invert());
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
      // Filtered velocity feeds these too — bonus: fewer whoosh glitches on
      // tracking noise at rest.
      const swingSpeed = paddleVelocity.length();
      updateSwingWhoosh(swingSpeed);
      pulseSwing(
        swingSpeed,
        SWING_HAPTIC_THRESHOLD, SWING_HAPTIC_MAX_SPEED,
        SWING_HAPTIC_MAX_INTENSITY, SWING_HAPTIC_PULSE_MS,
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
    const prevBallPos = hadBallPos ? lastBallPos.clone() : ballModel.position.clone();

    if (ballOwned) {
      // Visual spin rotation — reads ω before stepBallFlight damps it. Spin
      // lives directly on ballModel; squash is a vertex-buffer deformation
      // (see setBallSquash), so ballModel's transform is a pure rigid
      // rotation and premultiplying dq here rotates the ball about ω in
      // world space regardless of whether squash is active.
      if (ballAngularVelocity.lengthSq() > 1e-4) {
        const omega = ballAngularVelocity.length();
        if (omega > 0.01) {
          const axis = ballAngularVelocity.clone().multiplyScalar(1 / omega);
          const dq = new THREE.Quaternion().setFromAxisAngle(axis, omega * dt);
          ballModel.quaternion.premultiply(dq);
        }
      }

      // Gravity + buoyancy + Magnus + spin damping + quadratic drag +
      // position advance. rollout.js used to MIRROR this block; now it IS
      // this block — live physics and every predictive path (AI rollout,
      // preview, multiplayer dead reckoning) share one integrator.
      integrateFlightStep(ballModel.position, ballVelocity, ballAngularVelocity, dt);
    }

    const ballBottom = ballModel.position.y - ballRadius;

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
        // finite-diff of paddleFaceCenterWorld, so the offset must be from
        // face center (not the controller grip) or the wrist-rotation
        // contribution gets double-counted.
        pivot: paddleFaceCenterWorld,
        hitRadius: paddleHitRadius,
        getLastHit: () => lastHitTime,
        setLastHit: (t) => { lastHitTime = t; },
      }, prevBallPos, dt, clockTime);
    }

    // --- Paddle-ball collision (AI opponent paddles) ---
    for (const ap of aiPaddles) {
      const face = ap.getFace();
      if (ap.hadState) {
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
        ballModel.position.x = prevBallPos.x + dirX * tEnter;
        ballModel.position.y = prevBallPos.y + dirY * tEnter;
        ballModel.position.z = prevBallPos.z + dirZ * tEnter;

        // Push center a hair outside the entry face so next frame's segment
        // doesn't start on the boundary and re-trigger the slab test at tEnter=0.
        // Without this, a top-of-net hit compounds NET_TANGENT_DAMP each frame
        // and the ball freezes on the net cord instead of rolling over.
        const NET_ESCAPE_EPS = 1e-4;
        if (hitAxis === 'z') {
          ballVelocity.z *= -NET_NORMAL_RESTITUTION;
          ballVelocity.x *= NET_TANGENT_DAMP;
          ballVelocity.y *= NET_TANGENT_DAMP;
          ballModel.position.z += (dirZ >= 0 ? -NET_ESCAPE_EPS : NET_ESCAPE_EPS);
        } else if (hitAxis === 'x') {
          ballVelocity.x *= -NET_NORMAL_RESTITUTION;
          ballVelocity.y *= NET_TANGENT_DAMP;
          ballVelocity.z *= NET_TANGENT_DAMP;
          ballModel.position.x += (dirX >= 0 ? -NET_ESCAPE_EPS : NET_ESCAPE_EPS);
        } else {
          // hitAxis === 'y'. Top-cord hit (dirY < 0, ball descending onto the
          // top edge) is a physically distinct event from a bottom-face hit —
          // the cord is a tensioned string that kills vertical energy but
          // preserves horizontal drift and adds a small unpredictable lateral
          // deflection. This is the classic "let ball" dribble-over moment.
          const isTopCord = dirY < 0;
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
          } else {
            ballVelocity.y *= -NET_NORMAL_RESTITUTION;
            ballVelocity.x *= NET_TANGENT_DAMP;
            ballVelocity.z *= NET_TANGENT_DAMP;
          }
          ballModel.position.y += (dirY >= 0 ? -NET_ESCAPE_EPS : NET_ESCAPE_EPS);
        }
        ballAngularVelocity.multiplyScalar(NET_SPIN_DAMP);

        playBounceSound(0.2, ballModel.position);
        if (SELF_TEST) hudLog(`[NET HIT] axis=${hitAxis} t=${tEnter.toFixed(2)}`);
        emit('netHit', { axis: hitAxis });
      }
    }

    // --- Bounce off table surface ---
    if (ballOwned && tableBox &&
        ballBottom <= tableSurfaceY &&
        ballModel.position.x >= tableBox.min.x && ballModel.position.x <= tableBox.max.x &&
        ballModel.position.z >= tableBox.min.z && ballModel.position.z <= tableBox.max.z &&
        ballVelocity.y < 0) {
      ballModel.position.y = tableSurfaceY + ballRadius;
      const bounceImpact = Math.abs(ballVelocity.y);
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
      // Speed-dependent table COR — soft drops bounce lively (~0.88), hard
      // slams die on the table (~0.62). Evaluated at |v_y| BEFORE the
      // reflection so the same bounceImpact drives sound, haptic, and COR
      // consistently.
      ballVelocity.y *= -tableRestitution(bounceImpact);

      // Spin-coupled friction with the table.
      const surfaceFromSpinTable = new THREE.Vector3()
        .crossVectors(ballAngularVelocity, new THREE.Vector3(0, -ballRadius, 0));
      const slipTangentTable = ballVelocity.clone().add(surfaceFromSpinTable).negate();
      slipTangentTable.y = 0;

      ballVelocity.x += slipTangentTable.x * TABLE_LINEAR_FRICTION;
      ballVelocity.z += slipTangentTable.z * TABLE_LINEAR_FRICTION;

      const deltaOmegaTable = new THREE.Vector3()
        .crossVectors(slipTangentTable, new THREE.Vector3(0, 1, 0))
        .multiplyScalar(TABLE_SPIN_GAIN);
      ballAngularVelocity.add(deltaOmegaTable);

      // Sidespin lateral kick — see constants.js:TABLE_SIDESPIN_KICK for the
      // physics rationale. Rigid-ball ω × r at bottom = 0 for pure ω_y so the
      // spin-friction math above transfers no lateral velocity from vertical
      // sidespin; real ping-pong shows a small kick from finite-patch contact
      // dynamics that we approximate here. Direction = perpendicular to the
      // ball's horizontal velocity, matching the sense Magnus is already
      // curving the ball (so kick and drift stack rather than fight).
      //
      // Gate on bounceImpact so residual low-energy hops don't fire kicks.
      // The physical mechanism (finite deformable patch) requires meaningful
      // contact force. Without this gate the kick fires on every marginal
      // rebound, and because each kick is perpendicular to the ball's current
      // horizontal velocity, repeated firings act as a centripetal force —
      // the ball spirals in circles on the table instead of settling.
      // Linear ramp from 0 at impact=0 to full kick at impact=SIDESPIN_KICK_IMPACT_SCALE.
      if (TABLE_SIDESPIN_KICK > 0 && Math.abs(ballAngularVelocity.y) > 0.01 && bounceImpact > 0.3) {
        const hvLenSq = ballVelocity.x * ballVelocity.x + ballVelocity.z * ballVelocity.z;
        if (hvLenSq > 0.01) {
          const invLen = 1 / Math.sqrt(hvLenSq);
          // Rotating (v_x, v_z) by −90° in the horizontal plane gives
          // (v_z, −v_x). For hv in +Z that's +X, i.e. R-spin (ω_y > 0)
          // kicks the ball to the player's right — same direction Magnus
          // is already curling it.
          const perpX =  ballVelocity.z * invLen;
          const perpZ = -ballVelocity.x * invLen;
          const impactScale = Math.min(1, bounceImpact / 1.5);
          const kickMag = ballAngularVelocity.y * TABLE_SIDESPIN_KICK * impactScale;
          ballVelocity.x += kickMag * perpX;
          ballVelocity.z += kickMag * perpZ;
        }
      }

      if (Math.abs(ballVelocity.y) < 0.05) {
        ballVelocity.y = 0;
      }

      emit('tableBounce', { x: ballModel.position.x, z: ballModel.position.z, impactSpeed: bounceImpact });
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
      const surfaceFromSpinFloor = new THREE.Vector3()
        .crossVectors(ballAngularVelocity, new THREE.Vector3(0, -ballRadius, 0));
      const slipTangentFloor = ballVelocity.clone().add(surfaceFromSpinFloor).negate();
      slipTangentFloor.y = 0;
      ballVelocity.x += slipTangentFloor.x * FLOOR_FRICTION;
      ballVelocity.z += slipTangentFloor.z * FLOOR_FRICTION;

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

    // Motion trail — fed the current world position + speed AFTER all
    // collisions have resolved. Works identically for owner and non-owner:
    // the non-owner's ballModel.position was already written by the network
    // drill, and ballVelocity is either the freshly integrated value (owner)
    // or the last-received remote velocity (non-owner). Threshold-gated
    // inside updateBallTrail so slow rallies don't get any streak.
    updateBallTrail(ballModel.position, ballVelocity.length());

    // Blob shadow — depth cue for the ball above the table. Follows XZ,
    // fades/shrinks with height. Same call-site rationale as the trail:
    // works for both owner and network non-owner because ballModel.position
    // was already written by whichever path is active.
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
  }
}
