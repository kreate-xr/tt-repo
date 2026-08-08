// Single source of truth for AI behavior during a rally.
//
// Spec §intent_state_machine + §the_five_non_negotiable_rules: intent updates
// at ~5Hz (once per shot), rendering interpolates at 90Hz. Decision math is
// forbidden inside the render loop — this module is the place readers query
// each frame.
//
// Phase 1 holds only the fields needed to drive a paddle to an interception
// point and return a shot. Phase 2/3 layer the commitment lock,
// telegraph timing, recovery, and imperfection state on top of this struct.
//
// Coordinate conventions:
//   target_x        — meters from table center, on player side, range [-0.7, 0.7]
//   target_z        — meters from net on player side, range [0.1, 1.3]
//   target_speed_mps, target_spin_rps — see decision-layer ai_target_schema
//   predictedContact — world-space {x, y, z} where the AI should intercept
//   predictedContactPerfMs — performance.now() value at which contact will happen

import * as THREE from 'three';

export function createIntent() {
  return {
    difficulty: 'beginner',

    // Latest target returned by the AI worker. null until the first
    // request_target round-trip completes.
    target: null,                    // [tx, tz, speed, spin, conf] (spec coords)

    // Derived from target at receive time — set by FSM.onTargetReceived.
    // shotType is one of telegraph.SHOT_TYPES (or null).
    // displayedShotType is what the paddle telegraphs during early SWINGING.
    // For non-Pro difficulties it equals shotType (no disguise). For Pro,
    // the FSM flips the spin sign and recomputes — paddle shows one spin
    // for ~2/3 of swing, then late wrist switches to the actual shotType.
    // targetWorld is the world-space landing point the AI aims its return at,
    // used to compose the face normal that telegraphs the shot. Defaults to
    // the table center.
    shotType: null,
    displayedShotType: null,
    targetWorld: new THREE.Vector3(),

    // World-space interception point + time. null until the physics worker
    // (Phase 2) or the JS rollout provides one. Phase 1 uses a coarse JS
    // rollout derived from the player's last hit.
    predictedContact: new THREE.Vector3(),
    predictedContactPerfMs: 0,
    hasPrediction: false,
    // Ball state at the predicted contact moment (world coords). The V2
    // paddleSolver reads these to compute the impulse that produces the
    // engine's requested outgoing target. Populated by FSM.onPlayerHit
    // from shotAdapter's rollout.
    predictedContactBallVel:  new THREE.Vector3(),
    predictedContactBallSpin: new THREE.Vector3(),

    // V2 paddleSolver outputs. Populated by FSM.onTargetReceived after
    // running the solver. Read by SWINGING to set the paddle's face
    // normal + drive velocity that produces the intended ball outcome.
    solverFaceNormal:     new THREE.Vector3(0, 0, 1),
    solverPaddleVelocity: new THREE.Vector3(),
    solverFeasible:       false,
    // V2 reachability output: 'reachable' | 'stretched' | 'unreachable'.
    // Drives the lunge-and-miss path when AI can't make it to the contact
    // point in time.
    reachability:         'reachable',

    // V2 §section_2 interception trajectory. Planned ONCE at DECIDING →
    // MOVING transition; read every frame by MOVING/COMMITTED/SWINGING
    // to interpolate paddle position + face. null when solver was
    // infeasible (FSM falls back to the windup-strike heuristic).
    trajectory:           null,
    trajectoryPlannedAtMs: 0,

    // Commitment lock — set to true at T-400ms before predictedContactPerfMs
    // and not reset until the rally enters RECOVERING. Phase 2 wires the
    // T-400ms latch; Phase 1 leaves this flag inert.
    committed: false,

    // Deliberate-imperfection state (spec §imperfection_design). Set by
    // FSM.onTargetReceived AFTER deriving shotType/displayedShotType and
    // BEFORE entering MOVING so the commit lock latches the (possibly
    // miss-injected) target.
    willMiss: false,
    missCause: null,                       // one of imperfection.MISS_CAUSES
    wastedStepOffset: new THREE.Vector3(), // 0-vec when not in a wasted step
    wastedStepActive: false,
    wastedStepExpiresPerfMs: 0,

    // Counters used elsewhere (kept here for stable data shape).
    consecutiveRallies: 0,
    ralliesSinceWeaknessDetected: 0,

    reset() {
      this.target = null;
      this.shotType = null;
      this.displayedShotType = null;
      this.targetWorld.set(0, 0, 0);
      this.predictedContact.set(0, 0, 0);
      this.predictedContactPerfMs = 0;
      this.predictedContactBallVel.set(0, 0, 0);
      this.predictedContactBallSpin.set(0, 0, 0);
      this.solverFaceNormal.set(0, 0, 1);
      this.solverPaddleVelocity.set(0, 0, 0);
      this.solverFeasible = false;
      this.reachability = 'reachable';
      this.trajectory = null;
      this.trajectoryPlannedAtMs = 0;
      this.hasPrediction = false;
      this.committed = false;
      this.willMiss = false;
      this.missCause = null;
      this.wastedStepOffset.set(0, 0, 0);
      this.wastedStepActive = false;
      this.wastedStepExpiresPerfMs = 0;
      this.consecutiveRallies = 0;
      this.ralliesSinceWeaknessDetected = 0;
    },
  };
}
