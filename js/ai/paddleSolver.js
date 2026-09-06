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
import { computeImpulse, HOLLOW_SPHERE_MOI_FACTOR } from '../physics/impulse.js';
import {
  GRAVITY, PADDLE_RESTITUTION, SPIN_CAPTURE_GAIN, PADDLE_SPIN_CAP,
  paddleRestitution,
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
// Raised 5/11/13 → 7/15/18 in the spin-economy unification: spin requests
// are now physical rps (×2.5), and the tangential paddle speed needed is
// slip ≈ ω/SPIN_CAPTURE_GAIN — a 58 rps pro loop alone needs ~10.4 m/s of
// brush on top of the normal drive component. The new caps are real
// racket-head speeds (an elite forehand loop swings 15-20 m/s at contact),
// so they stay what they were designed to be: a rail, not the binding
// constraint. What actually limits delivered ball speed is that the
// launch-angle search can only return trajectories that still LAND, which
// saturates delivery around 15.6-18 m/s depending on target depth. The
// profiles in shotTypeSelector are set inside that band for exactly this
// reason.
export const MAX_PADDLE_SPEED_MPS = Object.freeze({
  beginner: 7.0,
  intermediate: 15.0,
  pro: 18.0,
});

// Spin-tilt sensitivity (spec §section_1.algorithm.step_3). Tilt angle in
// radians = atan(target_spin_rps * 0.010). At ±37 rps that's ±atan(0.37)
// ≈ ±20.4°; at ±60 rps ±atan(0.6) ≈ ±31°. Reasonable visual telegraph
// range. Was 0.025 before the spin-economy rescale (×2.5 on every rps
// request); 0.010 keeps the tilt-per-SHOT unchanged so the swept
// SPIN_TILT_APPLY optimum below still holds.
const SPIN_TILT_COEFFICIENT = 0.010;

// Fraction of that tilt actually applied to the CONTACT face normal.
//
// The full tilt cannot be applied, because in this physics model the face
// normal dominates where the ball goes. computeImpulse reflects along n:
//     v_out = v_in - (1+e)(v_rel·n) n  [+ the tangential friction kick,
//     (2/3)·R·gain·slip, which pass 1 does not model — pass 2 and the
//     correction loop absorb it the same way they absorb drag and Magnus]
// so to first order v_out lives near the line v_in + λn. Pass 1 solves a
// ballistic trajectory, sets faceNormal = normalize(v_out - v_in), and then
// rotating that normal for spin INVALIDATES the solution it just computed —
// the ball leaves along a different line than the one aimed at the target.
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
// 6 was the knee under the old spin economy; the physical-rps rescale made
// heavy-spin shots carry ~2.5× the brush (bigger tangential kick, bigger
// pass-1 residual), and the envelope suite showed deep high-spin cells
// landing just outside tolerance at 6 — 8 recovers them. Each iteration
// terminates at first bounce, so the typical cost stays far below the
// 800-step ceiling.
const CORRECTION_MAX_ITERS = 8;
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

// Aim-shift budget (see the aim-shift pass in solvePaddle — it now runs on
// any persistent miss, not just sidespin). Each iteration is one pass-1
// closed form + one pass-2 rollout. The lateral drift is near-linear in the
// aim offset, so the fixed-point iteration converges fast; 5 covers the
// physical-rps spin bands (heavier brush → bigger first-shot miss than the
// old economy's 3 was sized for), and shots that haven't converged by then
// still enter the range-correction loop with the best shifted solution.
const AIM_SHIFT_MAX_ITERS = 5;

// Launch-angle bisection budget. Each iteration is one closed-form evaluation
// (no rollout), so this is cheap — but raising it past ~10 does not help,
// because beyond the deliverable speed band the extra precision only finds
// trajectories that pass 2 then rejects for not landing.
const LAUNCH_SEARCH_ITERS = 6;

// Net-clearance gates. Until 2026-08 the solver had NO net awareness at all:
// pass 1 matched landing speed only, and pass 2's rolloutToFirstBounce flew
// straight through where the net stands. At smash pace (intermediate 11-16,
// pro 15.7-22.4 m/s) the speed-matching bisection converges onto the flat
// branch — essentially a straight line from contact to target — and from any
// contact under ~0.45 m that line crosses the net plane BELOW the cord. The
// solve verified "landed on target", the FSM committed, and the live physics
// (which does collide with the net) stopped the ball: every intermediate/pro
// smash off a mid-height ball went into the net.
//
// Margin bookkeeping: the live netBox.max.y is already ballRadius-inflated
// (models.js Minkowski sum), so rollout's netClearance = centerY − netBox.max.y
// IS the physical gap between the ball's BOTTOM and the cord top. Both gates
// therefore demand a plain physical gap on top of netBox.max.y — no extra
// radius term.
//
// These margins originally added env.ballRadius again ("beat the cord
// cleanly", serve.js convention). That stacked to a 4 cm bottom-gap demand at
// pass 2 and 8.5 cm at pass 1 — which outlaws the cord-skimming drives and
// loops elite play is made of, and every such engine request collapsed to the
// FSM's zero-spin centre-block fallback (measured 2026-08-30: ~15% of all
// intermediate/pro rally shots, concentrated in the high-spin/high-pace ones).
//
// PASS-2 (the gate that counts): the verified, drag+Magnus-integrated flight
// must clear by this much or the solution is rejected.
//
// 1 cm was enough to cover the rollout's own interpolation error across the
// net slab, and nothing else — which made this gate a pure model check with
// no budget for EXECUTION error. That was fine only as long as execution was
// assumed perfect. It isn't: the FSM delivers the plan through a keyframed
// trajectory, and until the phase-spacing fix in interception.js the paddle
// arrived at 0.884× the solved contact speed, which cost ~4 cm of clearance.
// A gate that accepts a 1 cm skim has nothing left to give.
//
// The correction loop makes this worse than it sounds: it optimises LANDING
// ERROR and only checks clearance as a veto, so it actively walks accepted
// solutions back down toward whatever this floor allows. Raising the floor is
// what stops the AI aiming at the top of the cord — which is what a real
// player does too, for exactly this reason.
//
// 3 cm measured against the realistic-contact envelope (150 contacts × 36
// target cells): intermediate/pro feasibility 92.6% → 91.6%, beginner
// 68.4% → 67.8%. The lost 1% degrades through the FSM's soften ladder, which
// keeps the tactical target and drops pace — not through the centre-block
// safe fallback — so it costs placement identity nothing.
const NET_CLEARANCE_MARGIN_M = 0.03;
// PASS-1 (drag-free closed form): demand extra headroom over the pass-2 gate,
// because drag and topspin Magnus both steepen the real arc below the
// parabola — a trajectory that clears on paper can still cross under the
// cord in pass 2. Spin-heavy shots that still come up short are re-solved by
// the net-rescue loop below, which raises this demand by the measured deficit.
const PASS1_NET_MARGIN_M = 0.045;
// Net-rescue budget: each iteration is one pass-1 closed form + one pass-2
// rollout, re-solving with the clearance demand raised by the observed
// deficit. Converges in 1-2 in practice (the deficit is measured, not
// guessed); shots that can't clear at all exit via NET_HIT to the FSM's
// safe-target fallback — which is what a real player does with a ball too
// low to kill: lift it instead.
const NET_RESCUE_MAX_ITERS = 3;

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
  NET_HIT:               'net_hit',               // verified flight crosses under the net cord
});

// Numerical helpers ---------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Spec coords are table-local on BOTH axes — see the shared copy in
// modes/aiMatch/telegraph.js for why x needs the centre too. env.tableCenterX
// defaults to 0 for callers on a table that really is centred (and for the
// headless solver tests, which build their own env).
function specTargetToWorld(tx, tz, tableCenterX, tableCenterZ, tableSurfaceY, out) {
  out.set(tableCenterX + tx, tableSurfaceY, tableCenterZ + tz);
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
function pass1Analytical(contactPos, contactVel, targetWorld, targetSpeed, targetSpin, targetSideSpin, maxPaddleSpeed, contactSpin = null, ballRadius = 0.02, netPlane = null) {
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

  // Drag-free net-clearance predicate for a candidate launch velocity. The
  // closed-form flight crosses the net plane at t = dz_net / v.z; require the
  // ball CENTER above netPlane.minCenterY there. Trajectories that never
  // reach the plane (t ≤ 0 — contact already past the net) pass by default
  // and are judged by pass 2 instead.
  function clearsNetDragFree(v, gUse) {
    if (!netPlane) return true;
    if (Math.abs(v.z) < 1e-6) return true;
    const t = (netPlane.z - contactPos.z) / v.z;
    if (t <= 0) return true;
    const yAtNet = contactPos.y + v.y * t + 0.5 * gUse * t * t;
    return yAtNet >= netPlane.minCenterY;
  }

  // Binary search over launch angle for a given effective gravity.
  function searchLaunchAngle(gUse) {
    let lo = Math.max(-Math.PI / 3, angleFloor);
    let hi = Math.PI * 0.45; // ~81°, very high arc
    let bestV = null;
    let bestErr = Infinity;
    for (let iter = 0; iter < LAUNCH_SEARCH_ITERS; iter++) {
      const mid = (lo + hi) / 2;
      const v = ballisticVelocityForLaunchAngle(contactPos, targetWorld, mid, gUse);
      if (v && !clearsNetDragFree(v, gUse)) {
        // Crosses under the cord — only a higher arc can clear (clearance at
        // the net is monotonic in launch angle for a fixed target), so steer
        // the same direction as "too fast" and never record this candidate.
        // The requested speed may become unreachable once the arc is forced
        // up; the search then returns the fastest CLEARING trajectory, the
        // same honest saturation the deliverable-envelope note describes.
        lo = mid;
      } else if (v) {
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

  // Tangential paddle speeds needed to impart the requested spins.
  //
  // This is the INVERSE of what the physics actually does. impulse.js
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
  //
  // Sidespin is a SECOND tangential component, along the horizontal face-plane
  // axis (tiltAxis) instead of the vertical one. Horizontal slip crosses the
  // face normal into a vertical Δω — spin about the up axis, which Magnus
  // turns into lateral curl. The face normal is NOT re-tilted for it (the
  // top/back tilt is a telegraph of elevation intent — sidespin lives purely
  // in the brush). The lateral curl lands the ball OFF the ballistic aim
  // point; solvePaddle cancels that with the aim-shift pass rather than
  // asking pass 1 to model Magnus.
  const paddleTangentMag = (targetSpin * 2 * Math.PI) / SPIN_CAPTURE_GAIN;
  const paddleSideTangentMag = (targetSideSpin * 2 * Math.PI) / SPIN_CAPTURE_GAIN;

  // The friction couple's linear half (impulse.js): the same tangential slip
  // that spins the ball also DRAGS it, Δv = (2/3)·R·gain·slip. That kick moves
  // v_out off the reflection line, and unlike drag/Magnus it acts at launch,
  // so leaving it to the pass-2 range loop (which can only scale pace along
  // the solved direction) tanks feasibility on spin shots. Every slip term is
  // known at plan time — paddle tangential motion, incoming tangential
  // velocity, incoming spin — so predict the kick and aim the reflection at
  // (v_out − kick) instead. Round 0 is the old kick-blind solution, round 1
  // re-derives the face from the adjusted target, and so on.
  //
  // This ran at 2 rounds, which is NOT converged. Swept against the envelope
  // suite's 120 pro contacts (signed range bias, m — negative is short):
  //     rounds      1       2       3       4       5       6      12
  //     bias    +0.052  -0.038  -0.099  -0.101  -0.102  -0.103  -0.103
  //     feasible   90     120     120     120     120     120     120
  // Two things there. The iteration is a clean contraction — settled by 5,
  // stationary to 0.1 mm after 6 — and stopping at 2 was reading a value
  // still in flight. And 2 rounds is not merely imprecise: it left a quarter
  // of these contacts infeasible, because a face derived from a half-applied
  // kick correction needs more paddle speed than the tier's cap allows.
  //
  // The converged solution sits ~10 cm short, which is pass 1 being drag-free
  // and is not this loop's job to fix — the range-correction loop at the
  // bottom of solvePaddle centres it. Stopping at 2 rounds was hiding that
  // bias at ~4 cm, under the gate that decides whether that loop runs at all.
  const PASS1_KICK_ROUNDS = 6;
  const worldUp = new THREE.Vector3(0, 1, 0);
  const kickGain = HOLLOW_SPHERE_MOI_FACTOR * ballRadius * SPIN_CAPTURE_GAIN;
  const slipSat = PADDLE_SPIN_CAP > 0 ? PADDLE_SPIN_CAP / SPIN_CAPTURE_GAIN : Infinity;
  const predictedKick = new THREE.Vector3();
  const vOutAdj = new THREE.Vector3();
  let faceNormal = null;
  let tiltAxis = null;
  let tangentDir = null;
  let paddleNormalMag = 0;

  for (let round = 0; round < PASS1_KICK_ROUNDS; round++) {
    vOutAdj.copy(v_out).sub(predictedKick);

    // Impulse vector (in ball frame).
    const impulse = vOutAdj.clone().sub(contactVel);
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
    faceNormal = impulse.clone().multiplyScalar(1 / impulseMag);
    // Tilt direction: perpendicular to faceNormal in the vertical plane
    // containing faceNormal and world up. = (worldUp × faceNormal) × faceNormal,
    // normalized — points "up the impact axis".
    tiltAxis = new THREE.Vector3().crossVectors(worldUp, faceNormal);
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
    paddleNormalMag = vInDotN + impulseMag / (1 + PADDLE_RESTITUTION);
    // Tangent direction = the tilt axis projected onto the plane perpendicular
    // to faceNormal. For zero spin, magnitude = 0. For topspin, paddle moves
    // up along the face; for slice, paddle moves down.
    tangentDir = new THREE.Vector3().crossVectors(faceNormal, tiltAxis).normalize();

    // Predict the slip computeImpulse will see (same expression, tangential
    // part): slip = vContact − ballV_out − ω×r with r = −R·n. The normal
    // reflection leaves the ball's tangential velocity untouched, so
    //   slip_t = paddle_t − v_in_t + R·(ω_in × n).
    const slip = new THREE.Vector3()
      .addScaledVector(tangentDir, paddleTangentMag)
      .addScaledVector(tiltAxis, paddleSideTangentMag)
      .sub(contactVel);
    if (contactSpin) {
      slip.addScaledVector(
        new THREE.Vector3().crossVectors(contactSpin, faceNormal), ballRadius,
      );
    }
    slip.addScaledVector(faceNormal, -slip.dot(faceNormal));

    // Mirror computeImpulse's grip saturation: past CAP/gain of slip the kick
    // stops growing.
    predictedKick.copy(slip).multiplyScalar(kickGain);
    const slipMag = slip.length();
    if (slipMag > slipSat) predictedKick.multiplyScalar(slipSat / slipMag);
  }

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
//   env                        { tableBox, tableSurfaceY, ballRadius, tableCenterX, tableCenterZ }
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
// Generator core: yields once after every pass-2 verification rollout (the
// expensive step — up to 800 integration steps each; worst case 20 rollouts
// across the rescue + net-rescue + aim-shift + correction loops). The FSM amortizes the
// solve across frames through this; the exported solvePaddle below drains it
// synchronously — identical computation, identical results.
export function* solvePaddleSteps({
  targetX, targetZ, targetSpeed, targetSpin, targetSideSpin = 0,
  contactPos, contactVel, contactSpin,
  difficulty, env,
}) {
  const maxPaddleSpeed = MAX_PADDLE_SPEED_MPS[difficulty] || MAX_PADDLE_SPEED_MPS.beginner;
  const targetWorld = new THREE.Vector3();
  specTargetToWorld(
    targetX, targetZ, env.tableCenterX || 0, env.tableCenterZ, env.tableSurfaceY, targetWorld,
  );

  // Net geometry, when the caller supplies it (env.netBox is optional — tests
  // and headless envs without a net solve exactly as before). Pass 1 gets a
  // minimum center height demand at the net plane; pass 2's verified flight
  // is gated on the integrated clearance.
  const netPlane = env.netBox ? {
    z: (env.netBox.min.z + env.netBox.max.z) / 2,
    minCenterY: env.netBox.max.y + PASS1_NET_MARGIN_M,
  } : null;
  const minNetClearance = NET_CLEARANCE_MARGIN_M;
  const clearsNet = (landing) =>
    landing.netClearance === null || landing.netClearance === undefined ||
    landing.netClearance >= minNetClearance;

  // Pass 1.
  let pass1 = pass1Analytical(contactPos, contactVel, targetWorld, targetSpeed, targetSpin, targetSideSpin, maxPaddleSpeed, contactSpin, env.ballRadius, netPlane);
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
  let verify = pass2Verify(contactPos, contactVel, contactSpin, pass1.paddleV, pass1.faceNormal, env);
  yield;
  if (!verify.landing) {
    // Ball didn't land — no bounce in 2.4s. On a table this small that is
    // almost always a range OVERSHOOT (the ball cleared the far edge), so
    // before giving up, do what a player does with a shot flying long: swing
    // softer. Scale the NORMAL component down (tangent preserved so the spin
    // request survives) and re-verify. This rescue is what keeps deep
    // high-pace targets solvable — the correction loop below can only run
    // once SOME landing exists to shoot against.
    for (const scale of [0.85, 0.72, 0.6]) {
      const normalVec = pass1.faceNormal.clone()
        .multiplyScalar(pass1.paddleV.dot(pass1.faceNormal) * scale);
      const tangentVec = pass1.paddleV.clone()
        .addScaledVector(pass1.faceNormal, -pass1.paddleV.dot(pass1.faceNormal));
      const damped = normalVec.add(tangentVec);
      const retry = pass2Verify(contactPos, contactVel, contactSpin, damped, pass1.faceNormal, env);
      yield;
      if (retry.landing) {
        pass1.paddleV = damped;
        pass1.paddleSpeed = damped.length();
        verify = retry;
        break;
      }
    }
  }
  if (!verify.landing) {
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

  // Net rescue. Pass 1's clearance check is drag-free; drag and topspin
  // Magnus both steepen the real arc, so a solution that clears on paper can
  // still cross under the cord in the integrated flight. The deficit is
  // MEASURED (verify.landing.netClearance), so re-solve pass 1 demanding
  // that much extra clearance and re-verify — the angle search returns a
  // higher arc, trading requested pace for a ball that actually gets over.
  // If no clearing arc exists (contact too low, too close to the net), exit
  // NET_HIT: the FSM's safe-target fallback re-solves at lift pace.
  if (netPlane && !clearsNet(verify.landing)) {
    let rescued = false;
    let extra = 0;
    for (let i = 0; i < NET_RESCUE_MAX_ITERS; i++) {
      extra += (minNetClearance - verify.landing.netClearance) + 0.02;
      const raised = { z: netPlane.z, minCenterY: netPlane.minCenterY + extra };
      const p = pass1Analytical(contactPos, contactVel, targetWorld, targetSpeed, targetSpin, targetSideSpin, maxPaddleSpeed, contactSpin, env.ballRadius, raised);
      if (!p.feasible) break;
      const vv = pass2Verify(contactPos, contactVel, contactSpin, p.paddleV, p.faceNormal, env);
      yield;
      if (!vv.landing) break;
      pass1 = p;
      verify = vv;
      if (clearsNet(vv.landing)) { rescued = true; break; }
    }
    if (!rescued) {
      return {
        feasible: false,
        reason: SOLVER_REASONS.NET_HIT,
        paddleV: pass1.paddleV,
        faceNormal: pass1.faceNormal,
        paddleSpeed: pass1.paddleSpeed,
        predictedLanding: verify.landing ? { x: verify.landing.x, z: verify.landing.z } : null,
        landingError: null,
      };
    }
  }

  const errX = verify.landing.x - targetWorld.x;
  const errZ = verify.landing.z - targetWorld.z;
  const error = Math.hypot(errX, errZ);

  // Accept outright only when the shot is CONVERGED, not merely acceptable.
  //
  // This gate used to read ACCEPTABLE_LANDING_ERROR_M — the threshold below
  // which a shot is not rejected — and so returned any pass-1 solution inside
  // 15 cm without ever entering the range-correction loop. That made the
  // loop's own convergence target (CORRECTION_TARGET_ERROR_M, 5 cm) dead
  // letter for exactly the shots it was written for: a systematic pass-1
  // bias, which is drag-free-short by construction, sails through here and
  // the loop never sees it. The envelope suite measured the result as a
  // ~10 cm mean short landing across every pro contact, with the entire
  // error being that bias rather than scatter.
  //
  // The two constants mean different things and this is the one that wants
  // the tighter of them. Anything between 5 and 15 cm now falls through to
  // the correction loop, which breaks the moment it gets inside 5 cm; the
  // loop is capped at CORRECTION_MAX_ITERS rollouts that each terminate at
  // first bounce, and the FSM amortizes them across frames through the
  // generator, so the cost of centring is a few yields on shots that were
  // previously accepted crooked.
  if (error <= CORRECTION_TARGET_ERROR_M) {
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

  // Aim-shift pass — any persistent miss.
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
  //
  // Originally gated to targetSideSpin ≠ 0, because only sidespin missed
  // laterally. The tangential friction kick changed that: incoming spin on
  // the CONTACT deflects the launch too, and pass 1's kick prediction is
  // first-order, so any spin-heavy contact can leave a systematic 15-25 cm
  // residual the range loop cannot see. The shift now runs whenever the
  // verified landing stays outside tolerance — a few extra rollouts on
  // exactly the shots that would otherwise be rejected.
  let base = pass1;
  let baseLanding = verify.landing;
  let baseError = error;
  if (baseError > ACCEPTABLE_LANDING_ERROR_M) {
    const virtualTarget = targetWorld.clone();
    for (let i = 0; i < AIM_SHIFT_MAX_ITERS && baseError > ACCEPTABLE_LANDING_ERROR_M; i++) {
      virtualTarget.x += targetWorld.x - baseLanding.x;
      virtualTarget.z += targetWorld.z - baseLanding.z;
      const p = pass1Analytical(contactPos, contactVel, virtualTarget, targetSpeed, targetSpin, targetSideSpin, maxPaddleSpeed, contactSpin, env.ballRadius, netPlane);
      if (!p.feasible) break;
      const vv = pass2Verify(contactPos, contactVel, contactSpin, p.paddleV, p.faceNormal, env);
      yield;
      if (!vv.landing) break;
      const e = Math.hypot(vv.landing.x - targetWorld.x, vv.landing.z - targetWorld.z);
      // A closer landing that would clip the net is not an improvement —
      // `base` must only ever hold solutions the live physics would let over.
      if (e < baseError && clearsNet(vv.landing)) {
        base = p;
        baseLanding = vv.landing;
        baseError = e;
      }
    }
    // Same distinction as the gate above, and the same reason. The loop
    // CONDITION stays at ACCEPTABLE_LANDING_ERROR_M — that is the shift
    // budget, and the shift exists to kill a lateral miss, which it has done
    // once the ball is inside tolerance. But RETURNING here at merely
    // acceptable hands back a shot that is still up to 15 cm out, and the
    // range-correction loop below is the thing that would have centred it.
    //
    // This was where nearly all of the residual actually lived: with the
    // gate at 0.15, the envelope suite ran the correction loop on 17 of 120
    // pro contacts and returned the other 103 straight from here at ~10 cm
    // short. The 17 that did reach the loop came out of it substantially
    // better (0.085 → 0.045, 0.129 → 0.084), which is what the loop is for.
    if (baseError <= CORRECTION_TARGET_ERROR_M) {
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
  // Set when the loop stopped because a correction step wanted more racket
  // speed than the tier allows — used only to name the reason if the best
  // solution we already hold is itself unacceptable.
  let cappedOut = false;

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
      // The step wants more racket speed than the tier has. Stop correcting,
      // but do not throw away what we already verified in order to say so.
      // The old `return feasible: false` here discarded a base solution that
      // may well have been inside tolerance, purely because the attempt to
      // CENTRE it overran the cap — which contradicts the promise made two
      // dozen lines up, that keeping the best iterate means a bad step can
      // never make the answer worse than what we had. Harmless while the
      // gate above accepted everything under 15 cm and this loop ran only on
      // already-failing shots; routine now that centring is its job.
      cappedOut = true;
      break;
    }

    const v = pass2Verify(contactPos, contactVel, contactSpin, corrected, base.faceNormal, env);
    yield;
    if (!v.landing) break;
    lastLanding = v.landing;
    const err = Math.hypot(v.landing.x - targetWorld.x, v.landing.z - targetWorld.z);
    // Netted iterates still feed lastLanding (the range ratio stays smooth in
    // paddle speed) but never become the returned answer: a down-scale that
    // fixes range by dropping the arc under the cord is a worse shot, not a
    // better one.
    if (err < bestError && clearsNet(v.landing)) {
      bestError = err;
      bestPaddleV = corrected.clone();
      bestLanding = v.landing;
    }
    if (err <= CORRECTION_TARGET_ERROR_M) break;
  }

  const feasible = bestError <= ACCEPTABLE_LANDING_ERROR_M;
  return {
    feasible,
    reason: feasible
      ? null
      : (cappedOut ? SOLVER_REASONS.CORRECTED_SPEED_CAP : SOLVER_REASONS.LANDING_ERROR),
    paddleV: bestPaddleV,
    faceNormal: base.faceNormal,
    paddleSpeed: bestPaddleV.length(),
    predictedLanding: { x: bestLanding.x, z: bestLanding.z },
    landingError: bestError,
  };
}

// Synchronous entry point — drains the generator in one go.
export function solvePaddle(args) {
  const gen = solvePaddleSteps(args);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

// Convenience: return the max strike speed for a difficulty. Exposed so
// reachability.js can read the same cap the solver uses.
export function maxPaddleSpeedForDifficulty(difficulty) {
  return MAX_PADDLE_SPEED_MPS[difficulty] || MAX_PADDLE_SPEED_MPS.beginner;
}
