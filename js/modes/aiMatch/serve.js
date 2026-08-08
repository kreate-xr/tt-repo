// AI serve sub-system — archetype-driven, human-like variety.
//
// A real table-tennis serve is a joint choice of (start position × swing
// type × spin category × length × placement). The AI now samples from a
// catalog of archetypes per difficulty rather than emitting a uniform
// random target. Consequences you can see:
//   - The AI stands at forehand corner / backhand corner / center between
//     serves instead of always centered.
//   - The paddle's cosmetic swing sweeps sideways for pendulum serves,
//     rises for tomahawks, and pushes straight for backhand/no-spin.
//   - Anti-repeat: the same archetype is never picked twice in a row.
//
// The first two apply to INTERMEDIATE and PRO only. All three archetypes with
// a non-zero beginner weight are `servePosX: 0.0` with a `straight` swing, so
// Beginner always stands dead centre and always plays the same motion — it
// varies only in spin and length, and alternates between two of its three
// archetypes. That is deliberate (a beginner has one serve), but this comment
// used to read as though stance and swing variety applied at every tier.
//
// FSM sub-states unchanged:
//   PRE_SERVE   — paddle moves to a serve-ready pose over 400ms (position
//                 now varies by archetype).
//   SERVE_SWING — ball launched directly (spawnBallAt) with solver-computed
//                 velocity/spin. Paddle plays a cosmetic swing whose target
//                 pose is chosen from the archetype's swing kinematics.
//   POST_SERVE  — recovery back to ready pose over 300ms; hands off.
//
// Earlier toss-then-hit design tried to coordinate three independent
// timelines (ball, paddle, swept-disc collision) on a few-cm / few-ms
// budget and routinely missed. The launch-then-swing approach sidesteps
// that — the ball is already 3m/s away by the time the paddle's cosmetic
// motion begins, so they never meet.

import * as THREE from 'three';
import { spawnBallAt } from '../../physics/ball.js';
import { ballRadius, tableBox, tableSurfaceY, netBox } from '../../scene/models.js';
import { solvePaddle, maxPaddleSpeedForDifficulty } from '../../ai/paddleSolver.js';
import { computeImpulse } from '../../physics/impulse.js';
import {
  PADDLE_RESTITUTION, SPIN_CAPTURE_GAIN, paddleRestitution,
} from '../../physics/constants.js';
import { integrateFlightStep } from '../../physics/rollout.js';

export const SERVE_STATES = Object.freeze({
  IDLE: 'SERVE_IDLE',
  PRE_SERVE: 'PRE_SERVE',
  SERVE_SWING: 'SERVE_SWING',
  POST_SERVE: 'POST_SERVE',
});

const PRE_SERVE_DURATION_MS = 400;
const SERVE_SWING_DURATION_MS = 150;
const POST_SERVE_RECOVERY_MS = 300;

const BALL_SPAWN_FORWARD_OFFSET_M = 0.15;
const SWING_FORWARD_TRAVEL_M = 0.20;
const FALLBACK_LAUNCH_SPEED_MPS = 3.5;

// --- Net-clearance guard ---------------------------------------------------
//
// The solver picks a launch velocity that lands near the target under nominal
// physics. When the physics tuner cranks DRAG_COEFFICIENT, GRAVITY, or Magnus
// values away from baseline, the trajectory can sag and clip the net. We
// don't want the AI's serves to ever hit the net — that's a distracting
// failure mode. So AFTER computing launchVel/launchSpin, we roll the ball
// forward with the ACTIVE physics constants (live-binding imports pick up
// the current tuner values every serve), find where the trajectory crosses
// the net Z-plane, and if the Y at that crossing is below (netTop +
// ballRadius + margin) we boost the launch vertical component and re-check.
//
// The boost trades placement accuracy for legality — a serve that lands
// 30cm short of the target still counts as a serve. Losing the point
// because we clipped the net is worse.

const NET_CLEARANCE_MARGIN_M = 0.04;    // ball CENTER must be this far above net top
const CLEAR_BOOST_STEP_MPS = 0.6;       // vy bump per iteration
const CLEAR_MAX_ITERATIONS = 24;        // caps total added vy at ~14 m/s
const CLEAR_SIM_DT = 0.008;             // integration step (matches shotAdapter timing)
const CLEAR_SIM_MAX_STEPS = 400;        // 3.2s of simulated flight

// Roll a virtual ball forward from launchPos with the ACTIVE physics
// (gravity + drag + Magnus). Returns the Y at which the trajectory crosses
// the net's Z plane, or null if it never crosses within the simulation
// window (ball fell off / stayed on AI side).
function simulateNetCrossingY(launchPos, launchVel, launchSpin, netZ) {
  const pos = launchPos.clone();
  const vel = launchVel.clone();
  const spin = launchSpin.clone();
  const dt = CLEAR_SIM_DT;
  for (let i = 0; i < CLEAR_SIM_MAX_STEPS; i++) {
    const prevY = pos.y;
    const prevZ = pos.z;
    integrateFlightStep(pos, vel, spin, dt);
    // Detect Z-crossing (sign-agnostic — the AI can be on either side).
    if ((prevZ < netZ && pos.z >= netZ) || (prevZ > netZ && pos.z <= netZ)) {
      const denom = pos.z - prevZ;
      if (Math.abs(denom) < 1e-9) return pos.y;
      const t = (netZ - prevZ) / denom;
      return prevY + (pos.y - prevY) * t;
    }
    // Ball fell below table surface without crossing — abandoned trajectory.
    if (pos.y < tableSurfaceY - 0.5) return null;
  }
  return null;
}

// Public helper: given a candidate launch, iteratively boost the vertical
// component of launchVel until the trajectory clears the net at the desired
// margin. Returns the possibly-mutated velocity/spin plus diagnostics.
// Safe to call when netBox is not yet populated (returns input unchanged).
export function ensureNetClearance(launchPos, launchVel, launchSpin) {
  if (!netBox) {
    return { launchVel, launchSpin, clears: true, iterations: 0 };
  }
  const netTopY = netBox.max.y;
  const netZ = (netBox.min.z + netBox.max.z) / 2;
  const requiredY = netTopY + ballRadius + NET_CLEARANCE_MARGIN_M;

  const vel = launchVel.clone();
  const spin = launchSpin.clone();

  for (let iter = 0; iter <= CLEAR_MAX_ITERATIONS; iter++) {
    const yAtNet = simulateNetCrossingY(launchPos, vel, spin, netZ);
    if (yAtNet !== null && yAtNet >= requiredY) {
      return { launchVel: vel, launchSpin: spin, clears: true, iterations: iter };
    }
    // Either doesn't clear (yAtNet < requiredY) or doesn't reach the net
    // (yAtNet === null). Both are fixed by more upward velocity.
    vel.y += CLEAR_BOOST_STEP_MPS;
  }
  // Exhausted — return best effort. Physics is probably over-tuned.
  return { launchVel: vel, launchSpin: spin, clears: false, iterations: CLEAR_MAX_ITERATIONS };
}

// --- Archetype catalog -----------------------------------------------------
//
// Each archetype is a bundle of intent. servePos.x is measured as a fraction
// of the AI baseline half-width (−1 = left corner, +1 = right corner, 0 =
// center) and placement.x is the same convention on the player's side. This
// lets us describe crossline / down-the-line without hard-coding handedness.
//
// swing:
//   type            — cosmetic paddle motion during SERVE_SWING
//   lateral         — sideways offset (m) applied to swing target, signed
//                     opposite of servePos.x so pendulums sweep across
//                     the body
//   vertical        — vertical offset (m) applied to swing target
// spin (rps, signed): negative = backspin (retards forward motion), positive
//   = topspin, sign-of-servePos.x controls sidespin direction implicitly by
//   the swing lateral term feeding into faceNormal rotation.
// length (target_z, m from net into player side): short 0.15–0.40,
//   half 0.55–0.85, long 1.00–1.30. ITTF legal service box ends at 1.37.
// speedRange (m/s at ball landing, feeds solver targetSpeed).
//
// difficultyWeights: relative sampling weight per difficulty. 0 = never.

const ARCHETYPES = Object.freeze([
  {
    id: 'soft_straight_middle',
    swing: { type: 'straight', lateral: 0.00, vertical: 0.00 },
    spinRange: [0, 0],
    lengthRange: [0.90, 1.10],
    placementXRange: [-0.10, 0.10],
    servePosX: 0.0,
    speedRange: [3.2, 3.8],
    // Weight 1 at international: a dead no-spin middle ball is a genuine
    // change-up used to bait an attack, but it is a rare one — this must not
    // become a staple or the tier serves like a beginner.
    difficultyWeights: { beginner: 3, intermediate: 1, pro: 0 },
    risk: 'safe',
  },
  {
    id: 'soft_topspin_middle',
    swing: { type: 'straight', lateral: 0.00, vertical: 0.05 },
    spinRange: [3, 6],
    lengthRange: [0.85, 1.10],
    placementXRange: [-0.15, 0.15],
    servePosX: 0.0,
    speedRange: [3.4, 4.0],
    difficultyWeights: { beginner: 2, intermediate: 1, pro: 0 },
    risk: 'safe',
  },
  {
    id: 'soft_backspin_short',
    swing: { type: 'straight', lateral: 0.00, vertical: -0.05 },
    spinRange: [-8, -4],
    lengthRange: [0.35, 0.55],
    placementXRange: [-0.15, 0.15],
    servePosX: 0.0,
    speedRange: [3.0, 3.6],
    difficultyWeights: { beginner: 2, intermediate: 1, pro: 0 },
    risk: 'safe',
  },
  {
    id: 'pendulum_backspin_short_crossline',
    swing: { type: 'pendulum', lateral: 0.18, vertical: -0.03 },
    spinRange: [-22, -14],
    lengthRange: [0.20, 0.38],
    placementXRange: [-0.55, -0.30],
    servePosX: +0.55,
    speedRange: [3.5, 4.5],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 3 },
    risk: 'safe',
  },
  {
    id: 'pendulum_sidespin_deep_crossline',
    swing: { type: 'pendulum', lateral: 0.20, vertical: 0.00 },
    spinRange: [-6, 6],
    lengthRange: [1.00, 1.25],
    placementXRange: [-0.60, -0.35],
    servePosX: +0.55,
    speedRange: [5.5, 7.0],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'medium',
  },
  {
    id: 'backhand_flat_middle',
    swing: { type: 'backhand', lateral: -0.08, vertical: 0.00 },
    spinRange: [-4, 4],
    lengthRange: [0.60, 0.90],
    placementXRange: [-0.15, 0.15],
    servePosX: -0.25,
    speedRange: [4.5, 5.5],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 1 },
    risk: 'medium',
  },
  {
    id: 'tomahawk_sidespin_wide',
    swing: { type: 'tomahawk', lateral: -0.15, vertical: 0.18 },
    spinRange: [8, 18],
    lengthRange: [0.70, 1.10],
    placementXRange: [+0.40, +0.60],
    servePosX: -0.45,
    speedRange: [5.0, 6.5],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'medium',
  },
  {
    id: 'reverse_pendulum_topspin_deep',
    swing: { type: 'pendulum', lateral: -0.18, vertical: 0.05 },
    spinRange: [10, 22],
    lengthRange: [1.05, 1.30],
    placementXRange: [+0.30, +0.55],
    servePosX: -0.40,
    speedRange: [6.5, 8.0],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'aggressive',
  },
  {
    id: 'high_toss_heavy_backspin',
    swing: { type: 'high_toss', lateral: 0.08, vertical: 0.25 },
    spinRange: [-28, -20],
    lengthRange: [0.30, 0.55],
    placementXRange: [-0.20, 0.20],
    servePosX: +0.30,
    speedRange: [3.8, 4.8],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'medium',
  },
  {
    id: 'fast_deep_no_spin_downline',
    swing: { type: 'straight', lateral: 0.00, vertical: 0.02 },
    spinRange: [-2, 2],
    lengthRange: [1.10, 1.30],
    placementXRange: [+0.45, +0.65],
    servePosX: +0.45,
    speedRange: [7.5, 9.0],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'aggressive',
  },
]);

export const SERVE_ARCHETYPE_IDS = Object.freeze(ARCHETYPES.map(a => a.id));

// Third-ball attack plans by archetype. Real Pros don't serve randomly —
// they serve TO SET UP their next attack. Each entry names the archetype's
// planned reply pattern:
//
//   expectedReturnZone — where on the AI's side the player's return most
//     likely lands (spec coords: x signed lateral, z from-net distance).
//     If the actual return lands INSIDE (± tolerance) this zone, the
//     third-ball plan fires.
//   attackShotType — the shot the AI plans to hit as the third ball.
//   attackTargetX / attackTargetZ — where the AI plans to place that
//     attack on the PLAYER'S side (spec coords).
//   tolerance — max distance (m) from expectedReturnZone center that
//     still counts as "return landed as expected."
//
// Only aggressive/spinny archetypes get plans. Simple straight serves
// don't SET UP a specific reply; they're just neutral rally openings.
const THIRD_BALL_PLANS = Object.freeze({
  // Short heavy-backspin serve to backhand → expect a push return down
  // the line (deep, backhand side of AI). Plan: loop-kill to the wide
  // forehand corner (crosscourt open winner).
  pendulum_backspin_short_crossline: {
    expectedReturnZone: { x: -0.4, z: 1.0, tolerance: 0.4 },
    attackShotType: 'loop',
    attackTargetX: 0.55,
    attackTargetZ: 1.15,
  },
  // Deep sidespin crossline → expect a block return crosscourt (mid-depth,
  // AI backhand). Plan: heavy topspin drive to the wide forehand.
  pendulum_sidespin_deep_crossline: {
    expectedReturnZone: { x: -0.3, z: 0.7, tolerance: 0.4 },
    attackShotType: 'topspin_drive',
    attackTargetX: 0.60,
    attackTargetZ: 1.05,
  },
  // Wide tomahawk sidespin → expect a stretched return short and to the
  // middle. Plan: FLIP attack over the net down the line.
  tomahawk_sidespin_wide: {
    expectedReturnZone: { x: 0.1, z: 0.5, tolerance: 0.4 },
    attackShotType: 'flip',
    attackTargetX: -0.55,
    attackTargetZ: 1.10,
  },
  // Reverse pendulum topspin deep → expect a hurried block/push somewhere
  // mid-depth. Plan: smash the fast return down the line.
  reverse_pendulum_topspin_deep: {
    expectedReturnZone: { x: 0.2, z: 0.7, tolerance: 0.45 },
    attackShotType: 'smash',
    attackTargetX: -0.55,
    attackTargetZ: 1.10,
  },
  // Heavy backspin high toss → the classic "trap" serve. Backspin is so
  // heavy that most returns pop up. Plan: loop kill to the middle-wide.
  high_toss_heavy_backspin: {
    expectedReturnZone: { x: 0.0, z: 0.6, tolerance: 0.5 },
    attackShotType: 'loop',
    attackTargetX: 0.50,
    attackTargetZ: 1.10,
  },
  // Fast deep no-spin down the line → expect a rushed block back down
  // the line. Plan: smash crosscourt.
  fast_deep_no_spin_downline: {
    expectedReturnZone: { x: 0.4, z: 0.8, tolerance: 0.4 },
    attackShotType: 'smash',
    attackTargetX: -0.55,
    attackTargetZ: 1.05,
  },
});

// Look up the third-ball plan for a given archetype id. Returns null when
// the archetype doesn't have a planned attack (simple/soft serves).
export function thirdBallPlanForArchetype(archetypeId) {
  return THIRD_BALL_PLANS[archetypeId] || null;
}

// Track most-recent archetype per createServer instance for anti-repeat.

function lerp(a, b, t) { return a + (b - a) * t; }
function pick(range, rng) { return lerp(range[0], range[1], rng()); }

// Pressure levels shift archetype weights by risk category. A human at deuce
// or match point plays fewer risky serves but doesn't abandon them entirely
// — the safe multiplier goes up, the aggressive multiplier goes down.
//   normal      — baseline
//   elevated    — deuce OR game point (server one away from winning game)
//   critical    — match point (would-be-deciding game, server one away)
// Weights are multiplicative and applied AFTER the per-difficulty weight.
const PRESSURE_RISK_MULT = Object.freeze({
  normal:    { safe: 1.0, medium: 1.0, aggressive: 1.0 },
  elevated:  { safe: 1.4, medium: 0.9, aggressive: 0.5 },
  critical:  { safe: 1.8, medium: 0.7, aggressive: 0.25 },
});

function pressureFromContext(ctx) {
  if (!ctx) return 'normal';
  if (ctx.isMatchPoint) return 'critical';
  if (ctx.isGamePoint || ctx.isDeuce) return 'elevated';
  return 'normal';
}

// Placement bucket for pattern-progression tracking. Splits the player
// side into three zones — LEFT (x < -0.2), MIDDLE (-0.2..0.2), RIGHT —
// and tracks how many of the last few serves landed in each. Real Pros
// notice when they've served backhand 4 times running and consciously
// mix middle to jam the opponent; without this the AI would happily
// pound the same zone all game because the archetype-level anti-repeat
// only blocks identical archetypes.
function placementBucket(x) {
  if (x < -0.20) return 'left';
  if (x >  0.20) return 'right';
  return 'middle';
}
function archetypeBucket(a) {
  const mid = (a.placementXRange[0] + a.placementXRange[1]) / 2;
  return placementBucket(mid);
}

// Penalty applied to an archetype when its placement bucket has been
// used ≥3 times in the recent-serve window. 0.4 = "possible but strongly
// discouraged" — allows the AI to still choose it (e.g., if all other
// eligible archetypes are also over-used) but heavily biases toward
// variety.
const OVERUSED_BUCKET_PENALTY = 0.4;
const OVERUSE_THRESHOLD = 3;

function bucketCounts(recentPlacements) {
  const counts = { left: 0, middle: 0, right: 0 };
  for (const b of recentPlacements) counts[b] = (counts[b] || 0) + 1;
  return counts;
}

function weightedPickArchetype(difficulty, rng, avoidId = null, gameContext = null, recentPlacements = null) {
  const pressure = pressureFromContext(gameContext);
  const riskMult = PRESSURE_RISK_MULT[pressure];
  const buckets = recentPlacements ? bucketCounts(recentPlacements) : null;
  const eligible = [];
  let total = 0;
  for (const a of ARCHETYPES) {
    const baseW = a.difficultyWeights[difficulty] || 0;
    if (baseW <= 0) continue;
    if (a.id === avoidId) continue;
    let w = baseW * (riskMult[a.risk] || 1.0);
    // Pattern-progression penalty — dampen archetypes whose placement
    // bucket has been over-used in the recent window.
    if (buckets) {
      const b = archetypeBucket(a);
      if ((buckets[b] || 0) >= OVERUSE_THRESHOLD) {
        w *= OVERUSED_BUCKET_PENALTY;
      }
    }
    if (w <= 0) continue;
    eligible.push({ a, w });
    total += w;
  }
  // Fallback: if anti-repeat filtered everything (single-archetype difficulty),
  // allow the repeat rather than silently degrading.
  if (eligible.length === 0) {
    for (const a of ARCHETYPES) {
      const baseW = a.difficultyWeights[difficulty] || 0;
      if (baseW <= 0) continue;
      const w = baseW * (riskMult[a.risk] || 1.0);
      if (w <= 0) continue;
      eligible.push({ a, w });
      total += w;
    }
  }
  let r = rng() * total;
  for (const e of eligible) {
    if ((r -= e.w) <= 0) return e.a;
  }
  return eligible[eligible.length - 1].a;
}

// --- Target selection -------------------------------------------------------
//
// Returns { target_x, target_z, target_speed, target_spin, mode,
//           archetype, servePos, swing, disguised }.
// target_z is in spec coords (meters from net on player side).
// servePos.x is meters (already converted from fractional to world offset).
// swing describes the cosmetic paddle motion for SERVE_SWING.
export function selectServeTarget(difficulty, rng = Math.random, opts = {}) {
  const avoidId = opts.avoidArchetypeId || null;
  const gameContext = opts.gameContext || null;
  const recentPlacements = opts.recentPlacements || null;
  const arch = weightedPickArchetype(difficulty, rng, avoidId, gameContext, recentPlacements);

  const target_z = pick(arch.lengthRange, rng);
  const target_x = pick(arch.placementXRange, rng);
  const target_speed = pick(arch.speedRange, rng);
  const target_spin = pick(arch.spinRange, rng);

  const halfWidth = tableBox
    ? (tableBox.max.x - tableBox.min.x) / 2
    : 0.7625;
  // servePos.x is meters from center of AI baseline. Cap at 80% of half-width
  // so the paddle never spawns on the table's outer edge.
  const servePosXMeters = arch.servePosX * halfWidth * 0.80;

  // Derive a coarse "mode" for backward compat with anything reading it.
  let mode;
  if (target_z < 0.50) mode = 'short';
  else if (target_z > 0.95) mode = 'long';
  else mode = 'half_long';
  if (Math.abs(target_x) > 0.45) mode = 'corner';

  return {
    target_x,
    target_z,
    target_speed,
    target_spin,
    mode,
    archetype: arch.id,
    servePos: { x: servePosXMeters },
    swing: {
      type: arch.swing.type,
      lateral: arch.swing.lateral,
      vertical: arch.swing.vertical,
    },
    disguised: arch.swing.type === 'pendulum' && Math.sign(arch.spinRange[0]) !== Math.sign(arch.spinRange[1]),
  };
}

// A serve target is "legal" if it lands inside the standard service area
// (player side, inside table footprint and above the net plane).
export function isServeTargetLegal(target, env) {
  if (!target) return false;
  if (!env || !env.tableBox) return true;
  if (target.target_z < 0.05 || target.target_z > 1.37) return false;
  const halfWidth = (env.tableBox.max.x - env.tableBox.min.x) / 2;
  if (target.target_x < -halfWidth || target.target_x > halfWidth) return false;
  return true;
}

// --- Serve subsystem -------------------------------------------------------

export function createServer({ paddle, difficulty = 'beginner', rng = Math.random } = {}) {
  let state = SERVE_STATES.IDLE;
  let stateEnteredAtMs = 0;
  let onComplete = null;

  let serveTarget = null;
  let lastArchetypeId = null;
  // Ring buffer of recent serve placement buckets (left/middle/right).
  // Used by weightedPickArchetype to dampen over-used zones. Cleared
  // between games so a fresh game starts with a clean pattern slate.
  const RECENT_PLACEMENT_WINDOW = 5;
  const recentPlacements = [];
  function pushPlacement(bucket) {
    recentPlacements.push(bucket);
    while (recentPlacements.length > RECENT_PLACEMENT_WINDOW) recentPlacements.shift();
  }
  function resetPlacementPattern() {
    recentPlacements.length = 0;
  }

  const swingTargetPos = new THREE.Vector3();
  const swingTargetNormal = new THREE.Vector3();

  // Serve-ready pose: archetype's servePos.x sets the lateral offset from
  // the AI baseline center. Y and Z remain at the AI's baseline edge.
  function computeServeReadyPose(servePosXMeters = 0) {
    if (!tableBox) {
      return {
        position: new THREE.Vector3(servePosXMeters, 1.05, -1.4),
        normal:   new THREE.Vector3(0, 0.15, 0.99).normalize(),
      };
    }
    const centerX = (tableBox.min.x + tableBox.max.x) / 2;
    const halfWidth = (tableBox.max.x - tableBox.min.x) / 2;
    // Clamp so the paddle never spawns past the AI-side edge of the table.
    const maxOffset = halfWidth * 0.85;
    const clampedX = Math.max(-maxOffset, Math.min(maxOffset, servePosXMeters));
    return {
      position: new THREE.Vector3(centerX + clampedX, tableSurfaceY + 0.30, tableBox.min.z - 0.05),
      normal:   new THREE.Vector3(0, 0.15, 0.99).normalize(),
    };
  }

  function transitionTo(next) {
    state = next;
    stateEnteredAtMs = performance.now();
  }

  function startServe(opts = {}) {
    onComplete = opts.onComplete || null;
    serveTarget = selectServeTarget(difficulty, rng, {
      avoidArchetypeId: lastArchetypeId,
      gameContext: opts.gameContext || null,
      recentPlacements,
    });
    lastArchetypeId = serveTarget.archetype;
    pushPlacement(placementBucket(serveTarget.target_x));
    // Third-ball plan: international and above. Serve → forced weak return →
    // pre-planned attack is THE defining pattern of high-level table tennis;
    // an opponent that serves without a follow-up in mind is not playing at
    // that level, whatever its ball speeds say. Beginner is excluded because
    // it doesn't have the shot vocabulary to execute a plan.
    //
    // If the archetype has no configured plan (soft serves, straight
    // middles), this stays null and no third-ball logic fires.
    lastServeThirdBallPlan = (difficulty === 'pro' || difficulty === 'intermediate')
      ? thirdBallPlanForArchetype(serveTarget.archetype)
      : null;
    transitionTo(SERVE_STATES.PRE_SERVE);
    const ready = computeServeReadyPose(serveTarget.servePos.x);
    paddle._serveReadyPose = ready;
  }

  function isFinished() { return state === SERVE_STATES.IDLE; }
  function getState() { return state; }
  function getServeTarget() { return serveTarget; }
  // Third-ball plan for the most recently STARTED serve. Set by
  // startServe() and cleared by consumeLastServeThirdBallPlan() (called
  // by aiMatch on the player's first return). Null when the archetype
  // has no planned attack or when already consumed.
  let lastServeThirdBallPlan = null;
  function getLastServeThirdBallPlan() { return lastServeThirdBallPlan; }
  function consumeLastServeThirdBallPlan() {
    const p = lastServeThirdBallPlan;
    lastServeThirdBallPlan = null;
    return p;
  }

  // Build a cosmetic swing target from the archetype's swing kinematics.
  // Lateral is applied opposite the AI's servePos.x so a pendulum from the
  // right sweeps left-to-right across the body (looks natural).
  function computeSwingTarget() {
    const kin = serveTarget.swing;
    swingTargetPos.copy(paddle.faceCenterWorld)
      .addScaledVector(paddle.faceNormalWorld, SWING_FORWARD_TRAVEL_M);
    // Lateral: signed by opposite of servePos.x so the swing crosses the
    // body. Neutral (servePos.x ≈ 0) still uses lateral as-is.
    const lateralSign = serveTarget.servePos.x >= 0 ? -1 : +1;
    if (kin.lateral !== 0) {
      swingTargetPos.x += kin.lateral * lateralSign;
    }
    if (kin.vertical !== 0) {
      swingTargetPos.y += kin.vertical;
    }
    swingTargetNormal.copy(paddle.faceNormalWorld);
  }

  function launchBall() {
    const launchPos = paddle.faceCenterWorld.clone()
      .addScaledVector(paddle.faceNormalWorld, BALL_SPAWN_FORWARD_OFFSET_M);

    const env = {
      tableBox, tableSurfaceY, ballRadius,
      tableCenterZ: tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0,
    };

    const contactVel = new THREE.Vector3();
    const contactSpin = new THREE.Vector3();
    const solverResult = solvePaddle({
      targetX: serveTarget.target_x,
      targetZ: serveTarget.target_z,
      targetSpeed: serveTarget.target_speed,
      targetSpin: serveTarget.target_spin,
      contactPos: launchPos,
      contactVel,
      contactSpin,
      difficulty, env,
    });

    let launchVel;
    let launchSpin;
    if (solverResult.feasible) {
      const impulse = computeImpulse(
        contactVel, contactSpin, launchPos,
        solverResult.paddleV, null, null,
        solverResult.faceNormal,
        ballRadius, PADDLE_RESTITUTION, SPIN_CAPTURE_GAIN,
        { restitutionCurve: paddleRestitution },
      );
      launchVel = impulse.ballV_out;
      launchSpin = impulse.ballW_out;
    } else {
      const tableCenterZ = tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0;
      const targetWorld = new THREE.Vector3(
        serveTarget.target_x,
        tableSurfaceY,
        tableCenterZ + serveTarget.target_z,
      );
      const dir = targetWorld.clone().sub(launchPos);
      dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      launchVel = new THREE.Vector3(
        dir.x * FALLBACK_LAUNCH_SPEED_MPS,
        1.5,
        dir.z * FALLBACK_LAUNCH_SPEED_MPS,
      );
      launchSpin = new THREE.Vector3();
    }

    // Net-clearance guard: verify (and if necessary boost) the launch so the
    // ball clears the net, regardless of the current physics tuning.
    const cleared = ensureNetClearance(launchPos, launchVel, launchSpin);
    launchVel = cleared.launchVel;
    launchSpin = cleared.launchSpin;
    if (!cleared.clears && typeof console !== 'undefined') {
      console.warn('[AI serve] could not verify net clearance after boost — physics may be over-tuned');
    }

    spawnBallAt(launchPos, launchVel, launchSpin);
    computeSwingTarget();
  }

  function update(dt) {
    const nowMs = performance.now();
    switch (state) {
      case SERVE_STATES.IDLE: return;

      case SERVE_STATES.PRE_SERVE: {
        const ready = paddle._serveReadyPose;
        if (ready) paddle.driveTowardPose(ready.position, ready.normal, dt, 2.0);
        if (nowMs - stateEnteredAtMs >= PRE_SERVE_DURATION_MS) {
          launchBall();
          transitionTo(SERVE_STATES.SERVE_SWING);
        }
        return;
      }

      case SERVE_STATES.SERVE_SWING: {
        paddle.driveTowardPose(
          swingTargetPos, swingTargetNormal, dt,
          maxPaddleSpeedForDifficulty(difficulty),
        );
        if (nowMs - stateEnteredAtMs >= SERVE_SWING_DURATION_MS) {
          transitionTo(SERVE_STATES.POST_SERVE);
        }
        return;
      }

      case SERVE_STATES.POST_SERVE: {
        paddle.driveTowardPose(
          paddle.readyPose.position, paddle.readyPose.normal,
          dt, 1.5,
        );
        if (nowMs - stateEnteredAtMs >= POST_SERVE_RECOVERY_MS) {
          transitionTo(SERVE_STATES.IDLE);
          serveTarget = null;
          if (onComplete) {
            const cb = onComplete;
            onComplete = null;
            cb();
          }
        }
        return;
      }
    }
  }

  function dispose() {
    state = SERVE_STATES.IDLE;
    serveTarget = null;
    onComplete = null;
    lastArchetypeId = null;
  }

  return {
    startServe,
    update,
    isFinished,
    getLastServeThirdBallPlan,
    consumeLastServeThirdBallPlan,
    resetPlacementPattern,
    getState,
    getServeTarget,
    dispose,
  };
}
