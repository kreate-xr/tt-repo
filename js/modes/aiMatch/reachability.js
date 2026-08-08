// Reachability gate. Spec §section_3.
//
// Runs in DECIDING state, AFTER the paddleSolver computes the contact
// parameters but BEFORE the FSM transitions to MOVING. If the AI can't
// physically reach the contact point in time, we bail to a lunge-and-miss
// instead of attempting an impossible shot and either teleporting or
// arriving so late the swing produces nonsense physics.
//
// Outcomes:
//   reachable             required avg speed ≤ 0.80 × cap
//                         AI proceeds normally.
//   stretched             0.80 ≤ required ≤ 1.00 × cap
//                         AI proceeds but embodiment plays a lunge variant.
//   unreachable           required > 1.00 × cap
//                         AI bails to honest miss. Point goes to player.
//
// The 0.80 factor accounts for windup overhead — paddle must slow at the
// windup_start position before accelerating again. Without it, "reachable"
// in straight-line terms is actually unreachable once you factor in the
// swing arc.

export const REACHABILITY = Object.freeze({
  REACHABLE:    'reachable',
  STRETCHED:    'stretched',
  UNREACHABLE:  'unreachable',
});

// Spec §section_3 — straight from the algorithm description.
const REACHABLE_FACTOR  = 0.80;
const STRETCHED_FACTOR  = 1.00;

// Check whether the AI paddle can travel from `currentPos` to `contactPos`
// within `timeBudgetMs` given the difficulty's FOOTWORK speed.
//
// This used to be gated on the strike speed cap, which is a different
// physical quantity: strike speed is how fast the racket head accelerates
// through the ball, footwork is how fast the player covers ground. Gating
// reach on the strike cap let Intermediate be treated as covering 5.6 m/s of
// court while its documented body speed was 2.2 m/s — so wide balls that
// should have stretched or beaten it were declared routine, and per-tier
// footwork stopped meaning anything. Footwork is the single biggest real
// separator between club and international play; it needs to be the gate.
//
// args:
//   currentPos        Vector3 world — paddle face center now
//   contactPos        Vector3 world — predicted contact point
//   timeBudgetMs      number — ms until predicted contact
//   maxApproachSpeed  number m/s — footwork speed from
//                     aiPaddle.MOVEMENT_SPEED_MPS, style-multiplied
//
// Returns:
//   {
//     status: 'reachable' | 'stretched' | 'unreachable',
//     requiredAvgSpeed: number m/s,
//     missDirection: Vector3 | null  // populated when unreachable, points
//                                    // from paddle toward contactPos
//   }
import * as THREE from 'three';

export function checkReachability({
  currentPos, contactPos, timeBudgetMs,
  maxApproachSpeed,
  // Legacy alias — older callers and tests pass the cap under this name.
  maxPaddleSpeed,
}) {
  const speedCap = (typeof maxApproachSpeed === 'number' && maxApproachSpeed > 0)
    ? maxApproachSpeed
    : maxPaddleSpeed;
  if (timeBudgetMs <= 0) {
    return {
      status: REACHABILITY.UNREACHABLE,
      requiredAvgSpeed: Infinity,
      missDirection: contactPos.clone().sub(currentPos).normalize(),
    };
  }
  const dx = contactPos.x - currentPos.x;
  const dy = contactPos.y - currentPos.y;
  const dz = contactPos.z - currentPos.z;
  const distance = Math.hypot(dx, dy, dz);
  const timeSec = timeBudgetMs / 1000;
  const requiredAvgSpeed = distance / timeSec;

  if (requiredAvgSpeed <= speedCap * REACHABLE_FACTOR) {
    return { status: REACHABILITY.REACHABLE, requiredAvgSpeed, missDirection: null };
  }
  if (requiredAvgSpeed <= speedCap * STRETCHED_FACTOR) {
    return { status: REACHABILITY.STRETCHED, requiredAvgSpeed, missDirection: null };
  }
  const missDirection = new THREE.Vector3(dx, dy, dz);
  if (missDirection.lengthSq() > 1e-8) missDirection.normalize();
  return { status: REACHABILITY.UNREACHABLE, requiredAvgSpeed, missDirection };
}
