// Paddle solver — inverse-physics computation that translates engine intent
// (target landing + speed + spin) into concrete paddle parameters
// (velocity vector + face normal at contact) that, when run through the
// host's existing collision physics, produce a ball landing at the
// intended target with the intended speed and spin.
//
// V2 spec §section_1. Two-pass algorithm:
//   Pass 1 — analytical inverse estimate (~0.3ms)
//     1.1  ballistic equation → required outgoing ball velocity
//     1.2  impulse = v_out - v_in
//     1.3  face_normal = normalize(impulse) ± topspin/slice tilt
//     1.4  paddle_velocity decomposed into normal + tangent components
//     1.5  feasibility check against max_paddle_speed_mps_by_difficulty
//   Pass 2 — forward verification (~0.5ms)
//     2.1  call computeImpulse() (extracted from js/physics/ball.js) to
//          simulate the contact deterministically
//     2.2  roll ball forward through existing physics until first bounce
//     2.3  compare landing to target. Accept if within 15cm; otherwise
//          apply ONE correction (scale normal velocity by ratio). Beyond
//          one correction, mark infeasible.
//
// Total budget 1ms per spec.
//
// Coordinate notes: engine targets are in spec coords (signed lateral x,
// non-negative "from net" z on player side). Solver converts to world
// once at the top (specTargetToWorld). All physics math thereafter is
// world-frame.
//
// Telegraph integration (spec §section_1.telegraph_integration): solver
// output IS the source of truth for paddle face normal. The legacy
// FACE_Y_BY_SHOT_TYPE lookup in telegraph.js becomes informational only.

import * as THREE from 'three';
import { computeImpulse } from '../physics/impulse.js';
import {
  GRAVITY, PADDLE_RESTITUTION, SPIN_CAPTURE_GAIN, paddleRestitution,
} from '../physics/constants.js';
import {
  rolloutToFirstBounce as sharedRolloutToFirstBounce, DT_PRESETS,
} from '../physics/rollout.js';

// Strike-speed caps: racket-head speed at the MOMENT OF CONTACT. Distinct
// from aiPaddle.MOVEMENT_SPEED_MPS, which is how fast the AI covers ground.
// Both are enforced now — reachability and the trajectory's approach phase
// use the movement cap, the swing phase uses these.
//
// Sized to clear each tier's top profile speed through the impulse model
// (roughly paddle = (v_out + e*v_in) / (1 + e), plus the tangential spin
// component). Intermediate's fastest profile is a 20 m/s smash.
//
// These are NOT the binding constraint and raising them buys nothing. Measured
// at a 24 m/s request against a 13.0 cap, the solved paddle speed peaked at
// 9.51 — nowhere near it. What actually limits delivered ball speed is that
// the launch-angle search can only return trajectories that still LAND, which
// saturates delivery around 15.6-18 m/s depending on target depth. The
// profiles in shotTypeSelector are set inside that band for exactly this
// reason.
export const MAX_PADDLE_SPEED_MPS = Object.freeze({
  beginner: 5.0,
  intermediate: 11.0,
  pro: 13.0,
});

// Spin-tilt sensitivity (spec §section_1.algorithm.step_3). Tilt angle in
// radians = atan(target_spin_rps * 0.025). At ±15 rps that's ±atan(0.375)
// ≈ ±20.5°; at ±30 rps that's ±atan(0.75) ≈ ±36.9°. Reasonable visual
// telegraph range.
const SPIN_TILT_COEFFICIENT = 0.025;

// Fraction of that tilt actually applied to the CONTACT face normal.
//
// The full tilt cannot be applied, because in this physics model the face
// normal rigidly determines where the ball goes. computeImpulse only changes
// the velocity component along n:
//     v_out = v_in - (1+e)(v_rel·n) n
// so v_out is confined to the line v_in + λn. Pass 1 solves a ballistic
// trajectory, sets faceNormal = normalize(v_out - v_in), and then rotating
// that normal for spin INVALIDATES the solution it just computed — the ball
// leaves along a different line than the one aimed at the target.
//
// At full tilt the effect is severe: a 20 rps request tilts the face 26.6°,
// launching the ball upward at 2.35 m/s so it descends at z = 1.90, well past
// the table's far edge at 1.37. Every spinny shot missed the table.
//
// That was invisible before the spin moment-arm fix because the two errors
// cancelled: the old arm produced 3.15x the requested spin, and the excess
// Magnus dragged the over-lofted ball back down onto the table. Fixing the
// spin exposed the tilt.
//
// Swept against pass 2 over 6000 randomized shots (feasible fraction):
//     apply    0.00   0.15   0.20   0.25   0.30   0.35   0.40   1.00
//     all      51.1%  70.7%  73.8%  77.8%  79.0%  78.2%  75.3%  29.0%
//     highSpin 37.0%  64.3%  68.6%  74.1%  76.2%  74.7%  70.5%  15.2%
//
// Note the optimum is NOT zero — a small tilt genuinely helps, because it
// changes the slip geometry at contact and so produces the requested spin more
// efficiently, and the correction loop can absorb a small launch-angle
// perturbation. The curve is flat across 0.25-0.35, so 0.30 is not knife-edge.
const SPIN_TILT_APPLY = 0.30;

// Forward-verification rollout config. Smaller dt than shotAdapter's main
// rollout because solver verification needs precision over a longer arc
// (full player-side bounce, not just to AI side). 333Hz, max 800 steps =
// 2.4s — long enough for the slowest target shot.
const ROLLOUT_DT_S = DT_PRESETS.VERIFY;
const ROLLOUT_MAX_STEPS = 800;

// Landing-error threshold for accepting a solution. Spec §section_1.algorithm.step_3.
const ACCEPTABLE_LANDING_ERROR_M = 0.15;

// Iterative range-correction budget. The spec said "one correction max", which
// is too few for an approximate pass 1 — each iteration is one pass-2 rollout
// (~800 steps of 3ms), so a handful is still cheap on the worker.
// Measured against pass 2 over 6000 randomized shots (feasible fraction):
//   iters   1      2      4      6      8
//           16.6%  22.0%  27.7%  29.0%  29.3%
// 6 is the knee — 8 buys 0.3pt for another rollout. Each iteration terminates
// at first bounce, so the typical cost is far below the 800-step ceiling.
const CORRECTION_MAX_ITERS = 6;
// Per-step velocity scale bounds. Narrower than the old [0.4, 2.5] because the
// scale is now sqrt(rangeRatio) rather than the raw ratio, and because
// iterating means a single step no longer has to cover the whole gap.
const CORRECTION_MIN_SCALE = 0.55;
const CORRECTION_MAX_SCALE = 1.8;
// Error the loop tries to CONVERGE to, distinct from the error it will ACCEPT
// (ACCEPTABLE_LANDING_ERROR_M). Stopping the moment the shot is merely
// acceptable leaves any systematic pass-1 bias sitting there, up to the full
// tolerance — pass 1 is drag-free so it lands short, and the loop was banking
// ~8.5cm of that as "good enough". Iterations are cheap and capped, so it is
// worth spending a spare one to centre the error instead of just clearing the
// bar.
const CORRECTION_TARGET_ERROR_M = 0.05;

// Aim-shift budget for sidespin shots (see the aim-shift pass in solvePaddle).
// Each iteration is one pass-1 closed form + one pass-2 rollout. The lateral
// drift is near-linear in the aim offset, so the fixed-point iteration
// converges fast — 3 covers the tier sidespin bands with margin, and shots
// that haven't converged by then still enter the range-correction loop with
// the best shifted solution found.
const AIM_SHIFT_MAX_ITERS = 3;

// Launch-angle bisection budget. Each iteration is one closed-form evaluation
// (no rollout), so this is cheap — but raising it past ~10 does not help,
// because beyond the deliverable speed band the extra precision only finds
// trajectories that pass 2 then rejects for not landing.
const LAUNCH_SEARCH_ITERS = 6;

// NOTE: there is deliberately no DRAG_COMPENSATION factor here any more.
//
// It used to be 1.10, applied to the pass-1 speed objective as
// `err = landSpeed - targetSpeed * DRAG_COMPENSATION`, on the reasoning that
// drag-free pass-1 ballistics land short under real drag so we should aim
// faster. It never did that job: every ballisticVelocityForLaunchAngle
// solution lands exactly on target BY CONSTRUCTION at every angle, so biasing
// the speed objective only reselects the launch angle — it cannot extend range.
//
// What it actually did was over-hit everything by ~10%, which distorts the
// whole point of the speed ladder (a push must read as slow, a smash as fast).
// Drag on range is now handled properly by the iterative correction loop below,
// which shoots against pass 2 and pass 2 integrates real drag.
//
// Measured end-to-end (real engine requests → delivered launch speed):
//     factor   feasible   requested → delivered   under-delivered
//     1.00       90%          8.6 → 8.9  (+3.5%)       3%
//     1.05       89%          8.7 → 9.3  (+8%)         1%
//     1.10       88%          8.6 → 9.5  (+10%)        1%
//     1.15       88%          8.6 → 9.9  (+15%)        1%
// Removing it is better on BOTH accuracy and feasibility.

// Why a solve was rejected. Exported so the envelope measurement suite (and
// any future telemetry) can attribute failures to a specific gate instead of
// guessing — the spin moment-arm bug survived for as long as it did precisely
// because every rejection looked alike from the outside.
export const SOLVER_REASONS = Object.freeze({
  NO_BALLISTIC_SOLUTION: 'no_ballistic_solution', // geometry admits no launch angle
  PADDLE_SPEED_CAP:      'paddle_speed_cap',      // pass-1 solution exceeds the tier cap
  NO_LANDING:            'no_landing',            // pass-2 rollout never bounced in-table
  CORRECTED_SPEED_CAP:   'corrected_speed_cap',   // correction pushed past the tier cap
  LANDING_ERROR:         'landing_error',         // landed too far from target
});

// Numerical helpers ---------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function specTargetToWorld(tx, tz, tableCenterZ, tableSurfaceY, out) {
  out.set(tx, tableSurfaceY, tableCenterZ + tz);
  return out;
}

// Closed-form initial-velocity vector for a projectile (no drag) from
// `from` to land at `to` with prescribed launch angle (radians above
// horizontal). Returns null when the geometry doesn't admit a solution.
function ballisticVelocityForLaunchAngle(from, to, launchAngle, g = GRAVITY) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const horiz = Math.hypot(dx, dz);
  if (horiz < 1e-6) return null;
  const dy = to.y - from.y;
  const cosA = Math.cos(launchAngle);
  const sinA = Math.sin(launchAngle);
  // Horizontal: x(t) = v*cosA * t   → t = horiz / (v*cosA)
  // Vertical:   y(t) = v*sinA * t + 0.5*g*t²   → set = dy
  //   dy = v*sinA*(horiz/(v*cosA)) + 0.5*g*(horiz/(v*cosA))²
  //   dy = horiz*tan(A) + 0.5*g*horiz²/(v²*cos²A)
  //   v² = 0.5 * g * horiz² / ((dy - horiz*tan(A)) * cos²A)
  const denom = (dy - horiz * Math.tan(launchAngle)) * cosA * cosA;
  if (Math.abs(denom) < 1e-6) return null;
  const v2 = 0.5 * g * horiz * horiz / denom;
  if (v2 < 0 || !Number.isFinite(v2)) return null;
  const v = Math.sqrt(v2);
  const horizDir = new THREE.Vector3(dx / horiz, 0, dz / horiz);
  const out = horizDir.multiplyScalar(v * cosA);
  out.y = v * sinA;
  return out;
}

// Pass-2 verification rolls the solved contact state forward to its first
// in-table bounce, on whichever side it lands. The integration itself lives in
// js/physics/rollout.js so it cannot drift from the live physics in ball.js —
// a verification pass that models different physics than the game verifies
// nothing.
function rolloutToFirstBounce(startPos, startVel, startSpin, env) {
  return sharedRolloutToFirstBounce(startPos, startVel, startSpin, env, {
    dt: ROLLOUT_DT_S,
    maxSteps: ROLLOUT_MAX_STEPS,
  });
}

// WHY PASS 1 STAYS GRAVITY-ONLY, despite pass 2 simulating Magnus.
//
// The obvious improvement — fold Magnus into the closed form as an effective
// gravity, since for horizontal flight ω × v is purely vertical:
//     g_eff = GRAVITY - MAGNUS_COEFFICIENT · MAGNUS_VERTICAL_SCALE · ω · |v_h|
// was implemented and MEASURED, and it makes the solver strictly worse. Sweeping
// the Magnus strength from 0 to 1 against pass 2 over 6000 randomized shots:
//
//     factor   0.00   0.15   0.30   0.45   0.60   0.80   1.00
//     feasible 22.8%  21.1%  19.5%  18.3%  17.0%  15.6%  14.7%
//
// Monotonically worse, at every spin magnitude. Two reasons:
//
//   1. Magnus is NOT purely vertical. For ω = (ωx,0,0) and v = (0,vy,vz),
//      ω × v = (0, -ωx·vz, +ωx·vy) — the horizontal term ∝ vy extends range on
//      a lofted shot and partially cancels the range loss from the dive. A
//      constant effective gravity can only represent the vertical half, so it
//      over-corrects. At factor 1.0 topspin shots flew clean off the end of the
//      table and backspin landed up to 1 m short.
//   2. Drag decays vz and SPIN_DAMPING decays ω over the flight, so the
//      flight-average Magnus is well below its launch-instant value.
//
// A biased-but-larger pass-1 error is worse than an unbiased smaller one,
// because the correction pass below is a range-ratio step that assumes the
// miss is a range miss. Accuracy here comes from that correction loop
// converging, not from making the closed form analytically perfect — which is
// not achievable anyway with drag, Magnus and a speed-dependent bounce in play.

// Pass-1 analytical inverse. Returns { paddleV_out, faceNormal, paddle_v_normal_mag,
//                                       paddle_v_tangent_mag, feasible } or { feasible: false }.
function pass1Analytical(contactPos, contactVel, targetWorld, targetSpeed, targetSpin, targetSideSpin, maxPaddleSpeed) {
  // Iterate launch angle to find a velocity vector whose flight from
  // contactPos arrives at targetWorld with magnitude ≈ targetSpeed at
  // landing. Spec is intentionally loose ("interpret target_speed as
  // landing speed for consistency"); 6-iter binary search.
  //
  // The search range matters: when the ball is above the table being
  // struck toward a target below, the launch angle is often slightly
  // negative (downward throw). A purely positive lo locks the solver out
  // of those geometries and 90% of feasible shots get rejected. Compute
  // an analytical lower bound from the singularity in the ballistic
  // formula: v² goes to ±∞ as (dy - horiz*tan A) → 0, i.e. at
  // A = atan(dy / horiz). Stay an epsilon above that for stability.
  const horiz0 = Math.hypot(targetWorld.x - contactPos.x, targetWorld.z - contactPos.z);
  const dy0 = targetWorld.y - contactPos.y;
  const angleFloor = horiz0 > 1e-6 ? Math.atan(dy0 / horiz0) + 0.02 : -Math.PI / 4;
  // Binary search over launch angle for a given effective gravity.
  function searchLaunchAngle(gUse) {
    let lo = Math.max(-Math.PI / 3, angleFloor);
    let hi = Math.PI * 0.45; // ~81°, very high arc
    let bestV = null;
    let bestErr = Infinity;
    for (let iter = 0; iter < LAUNCH_SEARCH_ITERS; iter++) {
      const mid = (lo + hi) / 2;
      const v = ballisticVelocityForLaunchAngle(contactPos, targetWorld, mid, gUse);
      if (v) {
        // Estimate landing speed: under gravity (no drag) the landing
        // speed magnitude equals launch speed magnitude only if landing y
        // == launch y. Here landing y < launch y so landing speed >
        // launch speed. Approximate landing speed via energy conservation:
        //   v_land² = v_launch² + 2*|g|*Δy
        const launchSpeed = v.length();
        const dy = contactPos.y - targetWorld.y;
        const landSpeed = Math.sqrt(launchSpeed * launchSpeed + 2 * Math.abs(gUse) * Math.max(0, dy));
        // Unbiased: pick the angle whose landing speed is closest to what was
        // actually asked for. Drag is the correction loop's job, not this
        // objective's — see the DRAG_COMPENSATION note above.
        const err = landSpeed - targetSpeed;
        if (Math.abs(err) < Math.abs(bestErr)) {
          bestErr = err;
          bestV = v;
        }
        if (err > 0) {
          // Too fast → use a higher arc (more vertical, less horizontal speed).
          lo = mid;
        } else {
          hi = mid;
        }
      } else {
        // Geometry infeasible at this angle; try a lower one.
        hi = mid;
      }
    }
    return bestV;
  }

  // Gravity-only by measurement — see the note above effectiveGravity.
  const bestV = searchLaunchAngle(GRAVITY);

  if (!bestV) return { feasible: false, reason: SOLVER_REASONS.NO_BALLISTIC_SOLUTION };
  const v_out = bestV;

  // Impulse vector (in ball frame).
  const impulse = v_out.clone().sub(contactVel);
  const impulseMag = impulse.length();
  if (impulseMag < 1e-6) {
    // No change in velocity needed — degenerate case, return a low-energy
    // hold (paddle barely brushes ball).
    return {
      feasible: true,
      paddleV: new THREE.Vector3(0, 0, 0),
      faceNormal: new THREE.Vector3(0, 0, 1),
      v_out,
    };
  }

  // Face normal = normalize(impulse) with topspin/slice tilt.
  const faceNormal = impulse.clone().multiplyScalar(1 / impulseMag);
  // Tilt direction: perpendicular to faceNormal in the vertical plane
  // containing faceNormal and world up. = (worldUp × faceNormal) × faceNormal,
  // normalized — points "up the impact axis".
  const worldUp = new THREE.Vector3(0, 1, 0);
  const tiltAxis = new THREE.Vector3().crossVectors(worldUp, faceNormal);
  if (tiltAxis.lengthSq() > 1e-8) {
    tiltAxis.normalize();
    const tiltAngle = Math.atan(targetSpin * SPIN_TILT_COEFFICIENT);
    faceNormal.applyAxisAngle(tiltAxis, -tiltAngle * SPIN_TILT_APPLY);
    faceNormal.normalize();
  }

  // Paddle velocity decomposition.
  //
  // The spec's stated formula `paddle_v_normal = |impulse| / (1 + e)` only
  // holds when the ball is at rest in the paddle's frame at contact. In
  // general, derive from elastic-with-restitution reflection:
  //   v_out · n = -e * v_in_paddle · n + paddle_v · n
  //   v_out · n = -e * (v_in - paddle_v) · n + paddle_v · n
  //   v_out · n = -e * v_in · n + (1+e) * paddle_v · n
  //   paddle_v · n = (v_out · n + e * v_in · n) / (1+e)
  //
  // Since faceNormal = impulse.normalize(), v_out · n = v_in · n + |impulse|,
  // so the formula simplifies to:
  //   paddle_v · n = v_in · n + |impulse| / (1 + e)
  //
  // The spec's formula missed the v_in · n term. With it, the solver
  // produces paddle velocities that actually drive the ball to target
  // through the host's collision physics (verified by pass 2).
  // Analytic inverse uses the scalar PADDLE_RESTITUTION (curve median) as a
  // linearization anchor. The true COR is speed-dependent (see
  // paddleRestitution), so a fast smash sees slightly less bounce than this
  // formula predicts — pass-2 verification below re-simulates with the real
  // curve and rejects solutions whose landing error exceeds
  // ACCEPTABLE_LANDING_ERROR_M. In practice the linearization error is
  // ~5-10% of paddle speed at rally speeds, well within the search band.
  const vInDotN = contactVel.dot(faceNormal);
  const paddleNormalMag = vInDotN + impulseMag / (1 + PADDLE_RESTITUTION);
  // Tangent direction = the tilt axis projected onto the plane perpendicular
  // to faceNormal. For zero spin, magnitude = 0. For topspin, paddle moves
  // up along the face; for slice, paddle moves down.
  const tangentDir = new THREE.Vector3().crossVectors(faceNormal, tiltAxis).normalize();
  // Tangential paddle speed needed to impart target_spin.
  //
  // This is the INVERSE of what the physics actually does. impulse.js:200-202
  // generates spin from slip, not from rolling the ball around an arm:
  //     Δω = (slipTangent × n) · SPIN_CAPTURE_GAIN
  // so producing ω rad/s requires slip ≈ ω / SPIN_CAPTURE_GAIN. To first order
  // (little incoming tangential velocity or pre-existing spin) the slip IS the
  // paddle's tangential velocity, so that inversion is what belongs here.
  //
  // This previously read `targetSpin * FACE_RADIUS_M * 2 * Math.PI`, using the
  // PADDLE FACE radius (0.09 m) as a spin moment arm — a category error, not a
  // tuning value. SPIN_CAPTURE_GAIN = 35 is documented in constants.js:34-40 as
  // 5/(7R) for the BALL's radius R = 0.02, i.e. an effective arm of ~0.0286 m.
  // The old form therefore overestimated the required paddle speed by
  // 0.09 × 35 = 3.15×.
  //
  // Because paddleSpeed = hypot(normal, tangent) is gated against the tier cap
  // below, that inflation acted as a hard spin ceiling independent of all
  // geometry (8.8 rps at beginner, 19.5 at intermediate, 23 at pro), rejecting
  // ~87% of intermediate loops and 100% of chops. Rejected shots fall back to a
  // spin-0 safe target in aiFSM — which succeeded precisely BECAUSE it dropped
  // the spin request, masking the bug.
  const paddleTangentMag = (targetSpin * 2 * Math.PI) / SPIN_CAPTURE_GAIN;

  // Sidespin: a SECOND tangential component, along the horizontal face-plane
  // axis (tiltAxis) instead of the vertical one. Horizontal slip crosses the
  // face normal into a vertical Δω — spin about the up axis, which Magnus
  // turns into lateral curl. Same slip inversion as the vertical component
  // above; the face normal is NOT re-tilted for it (the top/back tilt is a
  // telegraph of elevation intent — sidespin lives purely in the brush).
  //
  // The lateral curl this produces lands the ball OFF the ballistic aim
  // point; solvePaddle cancels that systematically with the aim-shift pass
  // rather than asking pass 1 to model Magnus (see the measurement note
  // above on why folding Magnus into the closed form makes things worse).
  const paddleSideTangentMag = (targetSideSpin * 2 * Math.PI) / SPIN_CAPTURE_GAIN;

  const paddleV = new THREE.Vector3()
    .addScaledVector(faceNormal, paddleNormalMag)
    .addScaledVector(tangentDir, paddleTangentMag);
  if (paddleSideTangentMag !== 0 && tiltAxis.lengthSq() > 1e-8) {
    paddleV.addScaledVector(tiltAxis, paddleSideTangentMag);
  }

  const paddleSpeed = paddleV.length();
  const feasible = paddleSpeed <= maxPaddleSpeed;
  return {
    feasible,
    reason: feasible ? null : SOLVER_REASONS.PADDLE_SPEED_CAP,
    paddleV,
    faceNormal,
    paddleSpeed,
    v_out,
  };
}

// Pass-2 forward verification. Returns { landingError, landing, ballV_out_actual }.
function pass2Verify(contactPos, contactVel, contactSpin, paddleV, faceNormal, env) {
  const impulse = computeImpulse(
    contactVel,
    contactSpin,
    contactPos,
    paddleV,
    null, // AI paddle has no angular velocity in current host model
    null,
    faceNormal,
    env.ballRadius,
    PADDLE_RESTITUTION,
    SPIN_CAPTURE_GAIN,
    { restitutionCurve: paddleRestitution },
  );
  const landing = rolloutToFirstBounce(contactPos, impulse.ballV_out, impulse.ballW_out, env);
  return { landing, ballV_out_actual: impulse.ballV_out, ballW_out_actual: impulse.ballW_out };
}

// Solve a paddle hit for the given target. Top-level entry point.
//
// args:
//   targetX, targetZ           spec coords (signed x, non-negative "from net" z on player side)
//   targetSpeed                m/s, AI's intended OUTGOING landing speed
//   targetSpin                 rps, signed (+ topspin, - slice)
//   targetSideSpin             rps, signed, optional (default 0) — spin about
//                              the vertical axis; the ball curls laterally in
//                              flight. Sign convention follows Δω = slip × n.
//   contactPos                 Vector3 world — predicted AI contact point
//   contactVel                 Vector3 world — predicted ball velocity at contact
//   contactSpin                Vector3 world — predicted ball angular velocity at contact
//   difficulty                 'beginner' | 'intermediate' | 'pro'
//   env                        { tableBox, tableSurfaceY, ballRadius, tableCenterZ }
//
// Returns:
//   {
//     feasible:           boolean
//     paddleV:            Vector3 world (velocity AI paddle must have AT contact)
//     faceNormal:         Vector3 world (face normal AI paddle must present AT contact)
//     paddleSpeed:        number m/s
//     predictedLanding:   {x, z} | null
//     landingError:       number m  (distance to target; null if no bounce)
//   }
export function solvePaddle({
  targetX, targetZ, targetSpeed, targetSpin, targetSideSpin = 0,
  contactPos, contactVel, contactSpin,
  difficulty, env,
}) {
  const maxPaddleSpeed = MAX_PADDLE_SPEED_MPS[difficulty] || MAX_PADDLE_SPEED_MPS.beginner;
  const targetWorld = new THREE.Vector3();
  specTargetToWorld(targetX, targetZ, env.tableCenterZ, env.tableSurfaceY, targetWorld);

  // Pass 1.
  const pass1 = pass1Analytical(contactPos, contactVel, targetWorld, targetSpeed, targetSpin, targetSideSpin, maxPaddleSpeed);
  if (!pass1.feasible) {
    return {
      feasible: false,
      reason: pass1.reason || SOLVER_REASONS.NO_BALLISTIC_SOLUTION,
      paddleV: pass1.paddleV || new THREE.Vector3(),
      faceNormal: pass1.faceNormal || new THREE.Vector3(0, 0, 1),
      paddleSpeed: pass1.paddleSpeed || 0,
      predictedLanding: null,
      landingError: null,
    };
  }

  // Pass 2 verify.
  const verify = pass2Verify(contactPos, contactVel, contactSpin, pass1.paddleV, pass1.faceNormal, env);
  if (!verify.landing) {
    // Ball didn't land — no bounce in 2.4s. Mark infeasible.
    return {
      feasible: false,
      reason: SOLVER_REASONS.NO_LANDING,
      paddleV: pass1.paddleV,
      faceNormal: pass1.faceNormal,
      paddleSpeed: pass1.paddleSpeed,
      predictedLanding: null,
      landingError: null,
    };
  }
  const errX = verify.landing.x - targetWorld.x;
  const errZ = verify.landing.z - targetWorld.z;
  const error = Math.hypot(errX, errZ);

  if (error <= ACCEPTABLE_LANDING_ERROR_M) {
    return {
      feasible: true,
      reason: null,
      paddleV: pass1.paddleV,
      faceNormal: pass1.faceNormal,
      paddleSpeed: pass1.paddleSpeed,
      predictedLanding: { x: verify.landing.x, z: verify.landing.z },
      landingError: error,
    };
  }

  // Aim-shift pass — sidespin only.
  //
  // Sidespin Magnus curls the flight LATERALLY, so the ball lands off to the
  // side of the ballistic aim point. The range-correction loop below can only
  // scale pace along the solved direction — a lateral miss is invisible to it
  // — so without this pass every sidespin shot over the curl budget came back
  // infeasible and aiFSM's fallback re-solved at spin 0: the feature would
  // strip itself exactly when it was asked for.
  //
  // Fix is how a human hits a sidespin shot: aim off-target and let the curl
  // bring it back. Re-run pass 1 at a virtual target displaced opposite the
  // observed miss (fixed-point iteration, cumulative shift), keeping the best
  // verified solution. Not folded into pass 1 analytically for the same
  // measured reason Magnus isn't (see the note above pass1Analytical).
  let base = pass1;
  let baseLanding = verify.landing;
  let baseError = error;
  if (targetSideSpin !== 0) {
    const virtualTarget = targetWorld.clone();
    for (let i = 0; i < AIM_SHIFT_MAX_ITERS && baseError > ACCEPTABLE_LANDING_ERROR_M; i++) {
      virtualTarget.x += targetWorld.x - baseLanding.x;
      virtualTarget.z += targetWorld.z - baseLanding.z;
      const p = pass1Analytical(contactPos, contactVel, virtualTarget, targetSpeed, targetSpin, targetSideSpin, maxPaddleSpeed);
      if (!p.feasible) break;
      const vv = pass2Verify(contactPos, contactVel, contactSpin, p.paddleV, p.faceNormal, env);
      if (!vv.landing) break;
      const e = Math.hypot(vv.landing.x - targetWorld.x, vv.landing.z - targetWorld.z);
      if (e < baseError) {
        base = p;
        baseLanding = vv.landing;
        baseError = e;
      }
    }
    if (baseError <= ACCEPTABLE_LANDING_ERROR_M) {
      return {
        feasible: true,
        reason: null,
        paddleV: base.paddleV,
        faceNormal: base.faceNormal,
        paddleSpeed: base.paddleV.length(),
        predictedLanding: { x: baseLanding.x, z: baseLanding.z },
        landingError: baseError,
      };
    }
  }

  // Iterative range correction — a damped shooting method around pass 2.
  //
  // This is where the solver's accuracy actually comes from. Pass 1 is a
  // closed-form approximation and cannot be made exact (drag, Magnus and a
  // speed-dependent bounce are all outside the closed form — see the note
  // above `effectiveGravity`), so the job here is to converge despite that.
  //
  // Two fixes over the previous single-shot version:
  //   - Ballistic range scales as v², so the velocity scale is sqrt(rangeRatio).
  //     Scaling by the raw ratio systematically OVER-corrected: a landing 20%
  //     short got a 1.25x boost where 1.12x was wanted, overshooting and
  //     failing the very check it was trying to satisfy.
  //   - Iterate instead of correcting once. One step of an approximate method
  //     leaves whatever it didn't converge; a few cheap steps land it.
  //
  // We keep the BEST iterate rather than the last, so an overshooting step can
  // never make the returned answer worse than what we already had.
  let corrected = base.paddleV.clone();
  let lastLanding = baseLanding;
  let bestPaddleV = base.paddleV.clone();
  let bestLanding = baseLanding;
  let bestError = baseError;
  let correctedSpeed = base.paddleV.length();

  const distTarget = Math.hypot(targetWorld.x - contactPos.x, targetWorld.z - contactPos.z);

  for (let iter = 0; iter < CORRECTION_MAX_ITERS; iter++) {
    const distActual = Math.hypot(lastLanding.x - contactPos.x, lastLanding.z - contactPos.z);
    if (distActual < 1e-6) break;
    const scale = clamp(
      Math.sqrt(distTarget / distActual),
      CORRECTION_MIN_SCALE, CORRECTION_MAX_SCALE,
    );

    // Re-decompose: scale only the normal component, preserve the tangent so
    // the requested spin is not disturbed by a range correction.
    const normalVec = base.faceNormal.clone()
      .multiplyScalar(corrected.dot(base.faceNormal));
    const tangentVec = corrected.clone().sub(normalVec);
    corrected = normalVec.multiplyScalar(scale).add(tangentVec);

    correctedSpeed = corrected.length();
    if (correctedSpeed > maxPaddleSpeed) {
      return {
        feasible: false,
        reason: SOLVER_REASONS.CORRECTED_SPEED_CAP,
        paddleV: corrected,
        faceNormal: base.faceNormal,
        paddleSpeed: correctedSpeed,
        predictedLanding: { x: bestLanding.x, z: bestLanding.z },
        landingError: bestError,
      };
    }

    const v = pass2Verify(contactPos, contactVel, contactSpin, corrected, base.faceNormal, env);
    if (!v.landing) break;
    lastLanding = v.landing;
    const err = Math.hypot(v.landing.x - targetWorld.x, v.landing.z - targetWorld.z);
    if (err < bestError) {
      bestError = err;
      bestPaddleV = corrected.clone();
      bestLanding = v.landing;
    }
    if (err <= CORRECTION_TARGET_ERROR_M) break;
  }

  const feasible = bestError <= ACCEPTABLE_LANDING_ERROR_M;
  return {
    feasible,
    reason: feasible ? null : SOLVER_REASONS.LANDING_ERROR,
    paddleV: bestPaddleV,
    faceNormal: base.faceNormal,
    paddleSpeed: bestPaddleV.length(),
    predictedLanding: { x: bestLanding.x, z: bestLanding.z },
    landingError: bestError,
  };
}

// Convenience: return the max strike speed for a difficulty. Exposed so
// reachability.js can read the same cap the solver uses.
export function maxPaddleSpeedForDifficulty(difficulty) {
  return MAX_PADDLE_SPEED_MPS[difficulty] || MAX_PADDLE_SPEED_MPS.beginner;
}
