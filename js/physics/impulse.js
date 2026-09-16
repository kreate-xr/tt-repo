// Pure paddle-ball collision impulse. Extracted from tryPaddleCollision in
// js/physics/ball.js so the AI's paddleSolver can compute the same impulse
// against synthetic inputs without mutating live game state. The live
// physics tick and the solver verification path both call this — zero
// drift risk.
//
// This file is intentionally side-effect-free: no DOM, no module state, no
// listeners. Takes inputs as THREE.Vector3, returns new Vector3s. Callers
// decide whether to mutate live state (the host) or just inspect (the
// solver).

import * as THREE from 'three';
// constants.js is dependency-free (no three, no DOM, no scene imports), so
// pulling these two here keeps impulse.js runnable headless under Jest while
// giving the live tick, the AI solver, and the AI serve one shared source of
// truth — the same zero-drift contract the rest of this file exists for.
import { PADDLE_SPIN_CAP, PADDLE_SPIN_CAP_KNEE, CORKSCREW_RETAIN } from './constants.js';

// Reusable temps live at module scope so per-call allocations are minimal
// in the hot path (host's tick calls this once per paddle hit per frame).
// The solver also calls it during pass-2 verification; allocation count
// stays bounded because we always copy into new outputs at the end.
const _contactPoint = new THREE.Vector3();
const _rContact     = new THREE.Vector3();
const _wCrossR      = new THREE.Vector3();
const _relativeVel  = new THREE.Vector3();
const _rContactPaddle = new THREE.Vector3();
const _ballSurfaceFromSpin = new THREE.Vector3();
const _slipVel      = new THREE.Vector3();

// A ping-pong ball is a thin shell: I = (2/3)·m·R². The SAME friction impulse
// J that spins the ball also pushes it — Δv = J/m and Δω = 3J/(2mR), so the
// linear and angular halves of the friction couple are locked together as
//     Δv_t = (2/3)·R·Δω.
// Spin capture below produces Δω = gain·slip, so the matching linear kick is
// (2/3)·R·gain per unit slip (≈ 0.47·slip at R = 0.02, gain = 35). This is
// the term that makes incoming spin MATTER at the racket: a blocked topspin
// ball climbs off the face, a push against backspin drops, sidespin deflects
// a flat hit sideways. Without it the reflection is normal-axis-only and
// every spin is returned as if it were no spin.
// Exported so the AI paddleSolver's pass-1 closed form can predict the kick
// (it knows every slip term at plan time) instead of leaving it all to the
// pass-2 correction loop.
export const HOLLOW_SPHERE_MOI_FACTOR = 2 / 3;

// Compute the post-impulse ball linear velocity, angular velocity, and the
// supporting intermediate values the host needs for haptics / audio /
// event emit.
//
// Inputs (all THREE.Vector3 unless noted, none mutated):
//   ballV          ball linear velocity BEFORE impulse
//   ballW          ball angular velocity BEFORE impulse
//   ballPos        ball position (used to derive contact point on surface)
//   paddleV        paddle face-center linear velocity
//   paddleW        paddle angular velocity (optional, null for AI paddles
//                  whose getFace() doesn't expose rotation)
//   paddlePivot    reference point for the ω × r term (optional; required if
//                  paddleW is supplied). MUST match the point at which
//                  paddleV is measured — for the player, paddleV is the
//                  finite-diff of the face center, so paddlePivot must be
//                  the face center, not the controller grip. Mixing the two
//                  double-counts ω × (face_center − controller) and flips
//                  the sign of the imparted spin for tilted wrist snaps.
//   faceNormal     paddle face normal in world space — this is the
//                  REFLECTION normal, already flipped to point away from
//                  the incoming ball by detectDiscCollision
//   ballRadius     m
//   restitution    coefficient of restitution (PADDLE_RESTITUTION)
//   spinCaptureGain SPIN_CAPTURE_GAIN
//
// Returns:
//   {
//     ballV_out:    Vector3  new ball linear velocity (fresh allocation)
//     ballW_out:    Vector3  new ball angular velocity
//     vContact:     Vector3  paddle contact-point velocity
//     velDot:       number   relative velocity along faceNormal (negative
//                            = ball closing on paddle)
//     impactSpeed:  number   |velDot|
//     slipTangent:  Vector3  tangent slip used for spin capture
//     deltaOmega:   Vector3  spin imparted to ball
//   }
// opts (all optional, all default to original untuned behavior):
//   angularContribution   number in [0, 1] — scale factor on the paddleW × r
//                         contribution to vContact. 1.0 = full contribution
//                         (default). Lowering dampens the wrist-flick free-
//                         ride from unrealistic VR angular rates.
//   contactSpeedCap       number (m/s) — asymptotic ceiling on the NORMAL
//                         (drive) component of vContact, applied as a tanh
//                         soft-clip. 0 or unset = no clip. Only the normal
//                         component is capped because the "arm biomechanics
//                         plateau" it models is shoulder/elbow push force;
//                         the tangential (brush) component is generated by
//                         a different muscle group (wrist supination /
//                         forearm sweep) with a higher, independent plateau
//                         we do not further model here. Capping the total
//                         magnitude — as the prior implementation did — bled
//                         the drive limit into brush strokes and silently
//                         attenuated spin. Player-only; AI paddles have
//                         difficulty-scaled planning caps and should not be
//                         double-clipped.
//   restitutionCurve      optional function (impactSpeed) → e. When provided,
//                         overrides the scalar `restitution` param and models
//                         real rubber's speed-dependent COR: near-elastic on
//                         soft touches, more damping on hard smashes. Callers
//                         pass paddleRestitution from constants.js; edge
//                         strikes leave this unset and use the scalar
//                         PADDLE_EDGE_RESTITUTION (wood-blade contact has a
//                         different failure mode than rubber sponge damping,
//                         so speed dependence isn't the same curve there).
//   sweetnessFactor       optional number in [SWEET_SPOT_MIN_FACTOR, 1]. Scales
//                         both restitution and spin capture — center hits
//                         retain full peak values, rim hits attenuate to the
//                         floor. Models center-of-percussion advantage. Edge
//                         strikes bypass this (they use their own scalar
//                         model). Default 1.0 (no falloff).
//   torsionalDampES       optional number in [0, 1]. Damps the OUTGOING ω
//                         component parallel to `faceNormal` — models the
//                         rubber's inability to grip a ball spinning about
//                         the paddle-normal axis (it just spins in place
//                         against the pad, no traction). Sony sim2real
//                         paper fits es ≈ 0.805. Default 1.0 (no damping)
//                         so the "strip corkscrew" heuristic already in
//                         this function stays the sole ω-axis surgery
//                         until VR-tested. Note: this is distinct from
//                         corkscrew removal — corkscrew is spin about the
//                         horizontal velocity direction; torsional is
//                         spin about the paddle face normal. They align
//                         only for a flat block hit; for angled swings
//                         both apply to different components.
//   linearKickGain        optional number — the gain used for the LINEAR
//                         half of the friction couple (the kick along the
//                         slip direction). Default: spinCaptureGain, i.e.
//                         the physical hollow-sphere couple Δv_t =
//                         (2/3)·R·Δω. The player path passes the physical
//                         SPIN_CAPTURE_GAIN here while spinCaptureGain
//                         carries PLAYER_SPIN_GAIN: the compensation exists
//                         because a controller brushes at ~1/5 racket speed
//                         and under-produces SPIN, and carrying it into
//                         linear momentum was the unbounded channel that
//                         made a prepared first stroke leave the bat too
//                         hard (PADDLE_CONTACT_SPEED_CAP bounds only the
//                         normal component). Grip saturation (slipSat)
//                         still keys off spinCaptureGain so the kick stops
//                         growing exactly where spin does.
export function computeImpulse(
  ballV, ballW, ballPos,
  paddleV, paddleW, paddlePivot,
  faceNormal,
  ballRadius, restitution, spinCaptureGain,
  opts,
) {
  const angularContribution = opts?.angularContribution ?? 1.0;
  const contactSpeedCap = opts?.contactSpeedCap ?? 0;
  const restitutionCurve = opts?.restitutionCurve;
  const sweetnessFactor = opts?.sweetnessFactor ?? 1.0;
  const torsionalDampES = opts?.torsionalDampES ?? 1.0;
  // Gain for the LINEAR half of the friction couple. Defaults to the spin
  // gain — the physical couple — so every existing caller is unchanged; the
  // player path passes the physical SPIN_CAPTURE_GAIN here while its spin
  // gain carries PLAYER_SPIN_GAIN (see the opts doc above).
  const linearKickGain = opts?.linearKickGain ?? spinCaptureGain;
  // Contact point on the ball surface — center minus faceNormal * radius.
  _contactPoint.copy(ballPos).addScaledVector(faceNormal, -ballRadius);

  // Paddle contact-point velocity = paddleV + angularContribution * (paddleW × r_contact).
  // ω + pivot only available for the player paddle today; AI paddles fall
  // back to face-center velocity. The angular contribution is scaled by
  // `angularContribution` (default 1.0 = original behavior; player callers
  // pass < 1 to dampen wrist-flick free-ride).
  let vContactX, vContactY, vContactZ;
  if (paddleW && paddlePivot) {
    _rContact.copy(_contactPoint).sub(paddlePivot);
    _wCrossR.crossVectors(paddleW, _rContact);
    vContactX = paddleV.x + _wCrossR.x * angularContribution;
    vContactY = paddleV.y + _wCrossR.y * angularContribution;
    vContactZ = paddleV.z + _wCrossR.z * angularContribution;
  } else {
    vContactX = paddleV.x;
    vContactY = paddleV.y;
    vContactZ = paddleV.z;
  }

  // Tanh soft-clip on the NORMAL-direction component of vContact only
  // (player only — AI paddles pass 0/unset to skip). The plateau models
  // shoulder/elbow drive force; the tangential (brush) direction is
  // uncapped so spin generation isn't collateral damage.
  //   v_n         = vContact · n     (signed scalar along faceNormal)
  //   v_n_clipped = cap * tanh(|v_n| / cap) * sign(v_n)
  //   vContact   ← vContact + (v_n_clipped − v_n) * n
  // At |v_n|=0.5·cap → 0.92× kept, at |v_n|=cap → 0.76×, at |v_n|=2·cap → 0.48×.
  // Tangent components pass through unchanged.
  if (contactSpeedCap > 0) {
    const vNormalScalar = vContactX * faceNormal.x + vContactY * faceNormal.y + vContactZ * faceNormal.z;
    const absVn = Math.abs(vNormalScalar);
    if (absVn > 1e-6) {
      const scale = (contactSpeedCap * Math.tanh(absVn / contactSpeedCap)) / absVn;
      const delta = vNormalScalar * (scale - 1);   // amount to subtract along n
      vContactX += delta * faceNormal.x;
      vContactY += delta * faceNormal.y;
      vContactZ += delta * faceNormal.z;
    }
  }
  const vContact = new THREE.Vector3(vContactX, vContactY, vContactZ);

  // Elastic-with-restitution reflection in the paddle's frame:
  //   v_ball_out = v_ball - (1+e) * (v_rel · n) * n   when velDot < 0
  // velDot >= 0 means ball already moving away from paddle — apply a small
  // outward nudge to keep contact stable.
  _relativeVel.copy(ballV).sub(vContact);
  const velDot = _relativeVel.dot(faceNormal);
  const impactSpeed = Math.abs(velDot);

  // Evaluate the speed-dependent COR curve at the actual impact speed, or
  // fall back to the scalar `restitution` when no curve was provided.
  // Then scale by sweetnessFactor so off-center hits bleed extra energy
  // (rim hits reflect less lively than center-of-percussion hits). Edge
  // strikes use the scalar with sweetnessFactor=1 by default.
  const baseRestitution = restitutionCurve
    ? restitutionCurve(impactSpeed)
    : restitution;
  const effectiveRestitution = baseRestitution * sweetnessFactor;

  const ballV_out = ballV.clone();
  if (velDot < 0) {
    ballV_out.addScaledVector(faceNormal, -(1 + effectiveRestitution) * velDot);
  } else {
    ballV_out.addScaledVector(faceNormal, 0.5);
  }

  // Spin capture from slip at contact. Slip is measured against the
  // POST-reflection ballV (ballV_out) — the original ball.js convention,
  // kept so the extracted helper stayed regression-identical.
  _rContactPaddle.copy(faceNormal).multiplyScalar(-ballRadius);
  _ballSurfaceFromSpin.crossVectors(ballW, _rContactPaddle);
  _slipVel.copy(vContact).sub(ballV_out).sub(_ballSurfaceFromSpin);
  // Project out the normal component → tangent slip in the paddle face plane.
  const slipTangent = _slipVel
    .addScaledVector(faceNormal, -_slipVel.dot(faceNormal))
    .clone();
  const deltaOmega = new THREE.Vector3()
    .crossVectors(slipTangent, faceNormal)
    .multiplyScalar(spinCaptureGain * sweetnessFactor);
  const ballW_out = ballW.clone().add(deltaOmega);

  // Linear half of the friction couple (see HOLLOW_SPHERE_MOI_FACTOR above):
  // the tangential impulse that produced deltaOmega also drags the ball along
  // the slip direction. Gated on velDot < 0 — the "moving away" nudge branch
  // has no normal impulse and therefore no friction to transmit. Saturation
  // mirrors PADDLE_SPIN_CAP: the kick per unit slip is (2/3)·R·gain, so the
  // slip magnitude past which spin saturates (CAP/spinGain) is also where the
  // linear kick stops growing — one grip limit, two consistent halves.
  //
  // The kick uses linearKickGain, not spinCaptureGain. They are the same
  // number for every physical contact (AI, solver, edge strikes); they differ
  // only on player contacts, where spinCaptureGain carries the VR input-gap
  // compensation (PLAYER_SPIN_GAIN) and the linear half deliberately does
  // not — see constants.js PLAYER_SPIN_GAIN for why.
  if (velDot < 0) {
    let kickPerSlip = HOLLOW_SPHERE_MOI_FACTOR * ballRadius * linearKickGain * sweetnessFactor;
    if (PADDLE_SPIN_CAP > 0 && spinCaptureGain > 0) {
      const slipMag = slipTangent.length();
      const slipSat = PADDLE_SPIN_CAP / spinCaptureGain;
      if (slipMag > slipSat) kickPerSlip *= slipSat / slipMag;
    }
    ballV_out.addScaledVector(slipTangent, kickPerSlip);
  }

  // Torsional spin damping (Sony sim2real paper — es). Damps the outgoing ω
  // component parallel to the paddle face normal, modelling the rubber's
  // inability to grip a ball rotating about the impact axis (a spinning top
  // on a rubber pad slips freely around its own axis). Default 1.0 = pass-
  // through. When enabled by caller (torsionalDampES < 1), this runs BEFORE
  // corkscrew removal below. The two operate on different projections:
  // torsional damps ω · n_paddle, corkscrew zeros ω · v_horizontal. They
  // align only for flat blocks; on angled swings both apply meaningfully.
  if (torsionalDampES < 1) {
    const wDotN =
      ballW_out.x * faceNormal.x +
      ballW_out.y * faceNormal.y +
      ballW_out.z * faceNormal.z;
    // Damp the parallel component by (1 − es); leave perpendicular components
    // untouched. delta = -(1 − es) · (ω · n) applied along n.
    const dampDelta = -(1 - torsionalDampES) * wDotN;
    ballW_out.x += dampDelta * faceNormal.x;
    ballW_out.y += dampDelta * faceNormal.y;
    ballW_out.z += dampDelta * faceNormal.z;
  }

  // Damp — do not strip — the "corkscrew" (spin about horizontal direction
  // of travel) in outgoing ω. Corkscrew is real physics: it is the tilted-
  // axis component that makes hook/fade serves kick laterally off the bounce
  // via ordinary table friction. But it also produces a Magnus_x = −ω_hv ·
  // v_y term that FLIPS sign at the trajectory apex when v_y crosses zero,
  // and real balls shed this component fast through turbulent boundary-layer
  // shear — so full rigid-rotor retention is wrong in the other direction.
  // CORKSCREW_RETAIN (constants.js) keeps enough for authentic tilted-axis
  // bounce behavior while holding the apex-flip artifact below visual
  // noticeability at the realistic MAGNUS_COEFFICIENT. (This block used to
  // zero the component entirely, which deleted the hook-serve vocabulary and
  // forced an exaggerated TABLE_SIDESPIN_KICK to fake the perception back.)
  //
  // Project ω against the HORIZONTAL velocity direction (v with y zeroed),
  // not full 3D v. Full-v projection is diagonal (v_out points up+forward at
  // launch) and only partially isolates the corkscrew. Horizontal-v
  // projection catches it cleanly and leaves sidespin (⊥ horizontal-v by
  // construction, since sidespin is vertical) and topspin/backspin (⊥
  // horizontal-v in the horizontal plane) both untouched.
  const hvLenSq = ballV_out.x * ballV_out.x + ballV_out.z * ballV_out.z;
  if (hvLenSq > 1e-4) {
    const remove = 1 - CORKSCREW_RETAIN;
    const invLen = 1 / Math.sqrt(hvLenSq);
    const hvHatX = ballV_out.x * invLen;
    const hvHatZ = ballV_out.z * invLen;
    // ω · hvHat  (hvHat has no y component)
    const parallel = ballW_out.x * hvHatX + ballW_out.z * hvHatZ;
    ballW_out.x -= remove * parallel * hvHatX;
    ballW_out.z -= remove * parallel * hvHatZ;
    // Mirror the same removal on deltaOmega so the diagnostic returned to
    // the host (used for HUD label / haptics) matches what got applied.
    const dParallel = deltaOmega.x * hvHatX + deltaOmega.z * hvHatZ;
    deltaOmega.x -= remove * dParallel * hvHatX;
    deltaOmega.z -= remove * dParallel * hvHatZ;
  }

  // Spin-magnitude soft-cap (see PADDLE_SPIN_CAP). SPIN_CAPTURE_GAIN bounds
  // the transfer per unit slip, but VR tangential slip itself is unbounded —
  // this is the grip-saturation backstop. Knee-and-asymptote, NOT a pure
  // tanh: everything at or below the knee passes exactly 1:1 (a bare tanh
  // shaved 4-6% off legitimate mid-range brush spin), and only the excess
  // above the knee compresses toward the cap. Preserves the spin AXIS
  // exactly; only the magnitude saturates. Runs last so it caps the final
  // composed ω, not an intermediate.
  if (PADDLE_SPIN_CAP > 0) {
    const wMag = ballW_out.length();
    if (wMag > PADDLE_SPIN_CAP_KNEE) {
      const span = PADDLE_SPIN_CAP - PADDLE_SPIN_CAP_KNEE;
      const capped = PADDLE_SPIN_CAP_KNEE +
        span * Math.tanh((wMag - PADDLE_SPIN_CAP_KNEE) / span);
      ballW_out.multiplyScalar(capped / wMag);
    }
  }

  return { ballV_out, ballW_out, vContact, velDot, impactSpeed, slipTangent, deltaOmega };
}
