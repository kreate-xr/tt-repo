// Shared forward-integration primitives — the single source of truth for
// every PREDICTIVE path in the app:
//
//   js/ai/shotAdapter.js       AI interception rollout (where will this ball
//                              reach my paddle?)
//   js/ai/paddleSolver.js      pass-2 verification (does my solved impulse
//                              actually land where I asked?)
//   js/modes/training/…        trajectory preview dots, and the training
//                              feeder's commanded-outcome verification
//
// Before this module each of those carried its own copy of the flight
// integration and the table-bounce response. The three copies were formula-
// identical but had silently drifted from tickPhysics() in ball.js, which is
// the actual truth: all three omitted BUOYANCY_ACCEL, and the two that model
// the post-bounce arc also omitted TABLE_SIDESPIN_KICK. A predicted landing
// was therefore biased low on every ball, and wrong by up to ~1 m/s of
// lateral velocity on a sidespin bounce.
//
// WHAT THIS MODULE DOES AND DOESN'T ABSTRACT
//
// It shares the PHYSICS (which must never diverge from ball.js) and leaves
// the CONTROL FLOW to each caller (which legitimately differs — the solver
// stops at the first bounce on either side, the AI rollout continues past an
// own-side bounce to an interception point, the preview collects samples for
// rendering). Folding those three loops into one configurable rollout()
// would need stop-condition callbacks and a union result shape, which is a
// worse trade than three short explicit loops over shared steps.
//
// Callers pass `env` rather than importing js/scene/models.js so this module
// stays outside the scene module graph and can run headless under Jest —
// the same reason serveBallistics.js was split out of launchKinematics.js.
// `env` is { ballRadius, tableSurfaceY, tableBox }.
//
// dt is a per-caller choice, not a physics choice: finer dt costs time and
// buys accuracy, and the callers have genuinely different budgets. See
// DT_PRESETS below.

import * as THREE from 'three';
import {
  GRAVITY, BUOYANCY_ACCEL, MAGNUS_COEFFICIENT, MAGNUS_VERTICAL_SCALE,
  SPIN_DAMPING, TABLE_LINEAR_FRICTION, TABLE_SPIN_GAIN, TABLE_SIDESPIN_KICK,
  FLOOR_Y,
  applyDragStep, tableRestitution,
} from './constants.js';

// Integration step sizes, named so the trade-off behind each is recorded
// once instead of in three separate comments.
export const DT_PRESETS = Object.freeze({
  // 333 Hz — solver pass-2 verification. Runs on the worker off the render
  // path and needs precision over a full player-side arc.
  VERIFY: 0.003,
  // 200 Hz — AI interception rollout. Slightly finer than the real physics
  // tick; p99 stays well under the 3 ms spec budget on Quest 3.
  INTERCEPT: 0.005,
  // 45 Hz — trajectory preview dots. Coarse on purpose: the output is a
  // sparse point cloud, and each sample is a rendered dot.
  PREVIEW: 0.022,
});

// Below this the Magnus term is numerically irrelevant and the cross product
// is skipped. Matches the gate in tickPhysics.
const SPIN_EPSILON_SQ = 1e-4;

// Sidespin-kick gates, mirrored from tickPhysics. The bounceImpact gate stops
// residual low-energy hops from firing kicks — each kick is perpendicular to
// the current horizontal velocity, so repeated firings act as a centripetal
// force and spiral a settling ball in circles on the table.
const SIDESPIN_MIN_OMEGA_Y = 0.01;
const SIDESPIN_MIN_IMPACT = 0.3;
const SIDESPIN_IMPACT_SCALE = 1.5;

// Velocity below which a bounce is treated as settled, mirrored from
// tickPhysics so a dying ball stops in prediction exactly when it stops live.
const BOUNCE_SETTLE_VY = 0.05;

// Module-scope scratch. These functions are on the rally hot path (the AI
// rolls out on every player contact) so they must not allocate. Safe to
// share: none of them recurse or yield.
const _magnus = new THREE.Vector3();
const _surfaceFromSpin = new THREE.Vector3();
const _slipTangent = new THREE.Vector3();
const _deltaOmega = new THREE.Vector3();
const _negYR = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Advance one flight step, mutating pos/vel/spin in place.
 *
 * This IS the in-flight branch of tickPhysics() — ball.js calls it directly
 * for the owned ball, and the multiplayer non-owner's dead-reckoning
 * projection (GameStateSync via the drill's adapter) rides the same
 * function, so live physics and prediction cannot drift. Order: gravity +
 * buoyancy, Magnus, spin decay, quadratic drag, then position. Visual spin
 * rotation (ballModel.quaternion) stays in ball.js — it has no effect on
 * trajectory.
 *
 * @param {THREE.Vector3} pos   position, mutated
 * @param {THREE.Vector3} vel   velocity, mutated
 * @param {THREE.Vector3} spin  angular velocity (rad/s), mutated (decays)
 * @param {number} dt           step size in seconds
 */
export function integrateFlightStep(pos, vel, spin, dt) {
  // Gravity and buoyancy are summed rather than folded into one constant so
  // that PhysicsTuner mutations of GRAVITY don't scale buoyancy with them —
  // same reason tickPhysics keeps them separate.
  vel.y += (GRAVITY + BUOYANCY_ACCEL) * dt;

  if (spin.lengthSq() > SPIN_EPSILON_SQ) {
    _magnus.crossVectors(spin, vel);
    _magnus.y *= MAGNUS_VERTICAL_SCALE;
    vel.addScaledVector(_magnus, MAGNUS_COEFFICIENT * dt);
    spin.multiplyScalar(Math.exp(-SPIN_DAMPING * dt));
  }

  applyDragStep(vel, dt);
  pos.addScaledVector(vel, dt);
}

/**
 * Apply the table-bounce response, mutating vel/spin in place.
 *
 * Mirrors the table-bounce branch of tickPhysics() in order, which matters:
 * restitution is evaluated at |v_y| BEFORE the reflection, and the sidespin
 * kick reads the horizontal velocity AFTER spin friction has modified it.
 *
 * The caller is responsible for snapping pos.y to the surface first — this
 * function only touches velocity and spin.
 *
 * @returns {number} bounceImpact (|v_y| before reflection), which callers can
 *                   reuse for bounce audio/haptic intensity rather than
 *                   recomputing it from the already-reflected velocity.
 */
export function applyTableBounce(vel, spin, ballRadius) {
  const bounceImpact = Math.abs(vel.y);

  // Speed-dependent COR: soft drops bounce lively, hard slams die.
  vel.y *= -tableRestitution(bounceImpact);

  // Spin-coupled friction with the table.
  _negYR.set(0, -ballRadius, 0);
  _surfaceFromSpin.crossVectors(spin, _negYR);
  _slipTangent.copy(vel).add(_surfaceFromSpin).negate();
  _slipTangent.y = 0;

  vel.x += _slipTangent.x * TABLE_LINEAR_FRICTION;
  vel.z += _slipTangent.z * TABLE_LINEAR_FRICTION;

  _deltaOmega.crossVectors(_slipTangent, _up).multiplyScalar(TABLE_SPIN_GAIN);
  spin.add(_deltaOmega);

  // Sidespin lateral kick. Rigid-ball ω × r at the contact point is zero for
  // pure ω_y, so the friction math above transfers no lateral velocity from
  // vertical sidespin; real ping-pong shows a small kick from finite-patch
  // contact dynamics, approximated here. Direction is perpendicular to the
  // horizontal velocity in the same sense Magnus is already curving the ball,
  // so kick and drift stack rather than fight.
  if (TABLE_SIDESPIN_KICK > 0 &&
      Math.abs(spin.y) > SIDESPIN_MIN_OMEGA_Y &&
      bounceImpact > SIDESPIN_MIN_IMPACT) {
    const hvLenSq = vel.x * vel.x + vel.z * vel.z;
    if (hvLenSq > 0.01) {
      const invLen = 1 / Math.sqrt(hvLenSq);
      // Rotating (v_x, v_z) by −90° gives (v_z, −v_x). For horizontal
      // velocity in +Z that's +X: ω_y > 0 kicks to the player's right.
      const perpX =  vel.z * invLen;
      const perpZ = -vel.x * invLen;
      const impactScale = Math.min(1, bounceImpact / SIDESPIN_IMPACT_SCALE);
      const kickMag = spin.y * TABLE_SIDESPIN_KICK * impactScale;
      vel.x += kickMag * perpX;
      vel.z += kickMag * perpZ;
    }
  }

  if (Math.abs(vel.y) < BOUNCE_SETTLE_VY) vel.y = 0;

  return bounceImpact;
}

/**
 * True when the ball is at/through the table surface, descending, and within
 * the table footprint — i.e. this step produced a bounce. Same predicate as
 * the table-bounce branch of tickPhysics.
 */
export function isTableBounce(pos, vel, env) {
  if (!env.tableBox) return false;
  return (pos.y - env.ballRadius) <= env.tableSurfaceY &&
         vel.y < 0 &&
         pos.x >= env.tableBox.min.x && pos.x <= env.tableBox.max.x &&
         pos.z >= env.tableBox.min.z && pos.z <= env.tableBox.max.z;
}

/**
 * Roll a ball forward to its first table bounce, whichever side it lands on.
 *
 * Does NOT apply the bounce response — it reports the landing and stops, which
 * is what an inverse-physics verification pass wants ("did my shot land where
 * I commanded?"). Callers that need the post-bounce arc should run their own
 * loop over integrateFlightStep + applyTableBounce.
 *
 * Like rolloutToSurfacePlane, reports the ball's minimum clearance over the
 * net plane when `env.netBox` is present (interpolated at the crossing step,
 * same math). This is what lets the paddle solver's pass-2 verification tell
 * a genuine landing from a trajectory that only "lands" because this rollout
 * flies straight through where the net stands — the live physics in ball.js
 * would have stopped it. `env.netBox` is optional; netClearance stays null
 * and clearedNet reports true without it, so callers with no net geometry
 * (and the landing semantics itself — deliberately un-interpolated, see the
 * migration-plan note) are unchanged.
 *
 * @returns {{x:number, y:number, z:number, t_ms:number,
 *            netClearance:number|null, clearedNet:boolean}|null} null when the
 *          ball reached the floor or the step ceiling without bouncing in-table.
 */
export function rolloutToFirstBounce(startPos, startVel, startSpin, env, {
  dt = DT_PRESETS.VERIFY,
  maxSteps = 800,
} = {}) {
  if (!env.tableBox) return null;

  const pos = startPos.clone();
  const vel = startVel.clone();
  const spin = startSpin.clone();

  const netZ = env.netBox ? (env.netBox.min.z + env.netBox.max.z) / 2 : null;
  const netTopY = env.netBox ? env.netBox.max.y : null;
  let netClearance = null;

  for (let i = 0; i < maxSteps; i++) {
    const prevY = pos.y;
    const prevZ = pos.z;
    integrateFlightStep(pos, vel, spin, dt);
    // Sample clearance at the step that straddles the net plane, interpolated
    // so the result doesn't depend on where dt happens to land — mirrored
    // from rolloutToSurfacePlane. Direction agnostic.
    if (netZ !== null && ((prevZ < netZ && pos.z >= netZ) || (prevZ > netZ && pos.z <= netZ))) {
      const span = pos.z - prevZ;
      const frac = Math.abs(span) > 1e-9 ? (netZ - prevZ) / span : 0;
      const yAtNet = prevY + (pos.y - prevY) * frac;
      netClearance = yAtNet - netTopY;
    }
    if (isTableBounce(pos, vel, env)) {
      return {
        x: pos.x, y: env.tableSurfaceY, z: pos.z, t_ms: i * dt * 1000,
        netClearance,
        clearedNet: netClearance === null ? true : netClearance > 0,
      };
    }
    if (pos.y < FLOOR_Y) return null;
  }
  return null;
}

/**
 * Roll a ball forward to where it first crosses the table's HORIZONTAL PLANE
 * on the way down — whether or not that point is on the table.
 *
 * This differs from rolloutToFirstBounce only in its stop condition, and the
 * difference is what makes it usable for AIMING. An aiming search needs a
 * well-defined landing point for every trial shot, including the ones that
 * overshoot the end of the table: rolloutToFirstBounce reports `null` for
 * those (no in-table bounce), which would leave a range-vs-angle search with
 * holes in its domain and no way to tell "too long" from "too short".
 *
 * Reports `onTable` so the caller can apply the table bounds itself as a
 * separate judgement rather than conflating "missed the table" with
 * "prediction failed".
 *
 * Also reports the ball's minimum clearance over the net plane, since every
 * caller that aims a shot also has to know whether it actually got over the
 * net — and recomputing that needs a second integration of the same arc.
 * `env.netBox` is optional; netClearance is null when it is absent.
 *
 * @returns {{x, y, z, t_ms, onTable, netClearance, clearedNet}|null}
 */
export function rolloutToSurfacePlane(startPos, startVel, startSpin, env, {
  dt = DT_PRESETS.VERIFY,
  maxSteps = 2000,
} = {}) {
  const pos = startPos.clone();
  const vel = startVel.clone();
  const spin = startSpin.clone();

  const netZ = env.netBox ? (env.netBox.min.z + env.netBox.max.z) / 2 : null;
  const netTopY = env.netBox ? env.netBox.max.y : null;
  let netClearance = null;

  for (let i = 0; i < maxSteps; i++) {
    // Capture the pre-step position ONCE per iteration. Both the net sample
    // and the landing interpolation below read it, so it must not be updated
    // in between — doing so pairs one axis's previous value with another's
    // current value and silently corrupts the interpolated point.
    const prevX = pos.x;
    const prevY = pos.y;
    const prevZ = pos.z;

    integrateFlightStep(pos, vel, spin, dt);

    // Sample clearance at the step that straddles the net plane, interpolating
    // so the result doesn't depend on where dt happens to land. Direction
    // agnostic: a feed crosses -z→+z, a return crosses +z→-z.
    if (netZ !== null && ((prevZ < netZ && pos.z >= netZ) || (prevZ > netZ && pos.z <= netZ))) {
      const span = pos.z - prevZ;
      const frac = Math.abs(span) > 1e-9 ? (netZ - prevZ) / span : 0;
      const yAtNet = prevY + (pos.y - prevY) * frac;
      netClearance = yAtNet - netTopY;
    }

    if ((pos.y - env.ballRadius) <= env.tableSurfaceY && vel.y < 0) {
      // Interpolate the exact surface crossing rather than reporting whichever
      // discrete step first dipped below it.
      //
      // This matters more than it looks: at 15 m/s a single 3 ms step carries
      // the ball ~4.5 cm horizontally, so the un-interpolated landing point
      // carries up to that much quantisation error — twice M1's entire 2 cm
      // placement budget. An aiming search over a quantised objective cannot
      // converge below the step size no matter how many iterations it runs,
      // which is exactly the floor the feed solver was hitting.
      const targetY = env.tableSurfaceY + env.ballRadius;
      const span = prevY - pos.y;
      const frac = span > 1e-9 ? Math.min(1, Math.max(0, (prevY - targetY) / span)) : 0;
      const hitX = prevX + (pos.x - prevX) * frac;
      const hitZ = prevZ + (pos.z - prevZ) * frac;

      const onTable = !!env.tableBox &&
        hitX >= env.tableBox.min.x && hitX <= env.tableBox.max.x &&
        hitZ >= env.tableBox.min.z && hitZ <= env.tableBox.max.z;
      return {
        x: hitX,
        y: env.tableSurfaceY,
        z: hitZ,
        t_ms: (i + frac) * dt * 1000,
        onTable,
        netClearance,
        clearedNet: netClearance === null ? true : netClearance > 0,
      };
    }
    if (pos.y < FLOOR_Y) return null;
  }
  return null;
}
