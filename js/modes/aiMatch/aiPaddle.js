// AI opponent paddle entity — a Three.js group holding a paddle clone only
// (floating paddle; wrist/arm stubs removed by user request). Mounts via
// the existing registerAIPaddle slot in physics/ball.js so the host's
// swept-disc collision handles impulse just like the player's paddle and
// the network remote paddle.
//
// Spec §ai_paddle_entity_design:
//   - hitRadius: 0.09 m (per existing paddle model)
//   - id: 'ai-opponent'
//   - getFace() returns {center, normal, velocity} world-space
//   - movement speed varies by difficulty; recovery multiplier 0.4
//   - position drive: direct Object3D interpolation, NO IK library
//
// Velocity reported by getFace() is the finite-difference paddle-center
// velocity from frame to frame. The existing tryPaddleCollision in
// physics/ball.js uses this to compute the relative velocity at contact.

import * as THREE from 'three';
import { scene } from '../../scene/sceneSetup.js';
import {
  paddleModel, paddleFaceOffset, paddleFaceNormalLocal,
  tableBox, tableSurfaceY, paddleHitRadius, paddleHalfThickness,
} from '../../scene/models.js';
import { registerAIPaddle, unregisterAIPaddle } from '../../physics/ball.js';
import { resolvePaddleTablePenetration } from '../../physics/paddleTableClamp.js';
import { computeReadyPose } from './readyPosition.js';
import { movementMultiplierForStyle } from '../../ai/playerStyles.js';

export const AI_PADDLE_ID = 'ai-opponent';

// Spec-locked geometry: 0.09 m hit radius matches the existing paddle model.
const HIT_RADIUS = 0.09;

// Footwork speeds per difficulty, m/s — how fast the AI covers ground to
// reach a ball. Originally spec §ai_paddle_entity_design.movement_speed_
// normal_mps, since re-tuned for the international ladder.
//
// This is the tier's court coverage, and it is the biggest real separator
// between skill levels — an international player's edge over a club player is
// far more about being in position than about arm speed. Elite lateral
// coverage is roughly 1.5m in ~0.35s, so ~4 m/s.
//
// Enforced by checkReachability and by the approach phase of
// interception.planTrajectory. It previously governed only idle drift, while
// reach was gated on the (much higher) strike cap — so these numbers existed
// but changed nothing during a rally.
export const MOVEMENT_SPEED_MPS = {
  beginner: 1.5,
  intermediate: 4.0,
  pro: 4.5,
};

// Recovery-window movement multiplier lives in recovery.js — the spec
// frames it as a property of the recovery state, not the paddle. aiFSM
// imports it from there.

// Rotation smoothing — how quickly the paddle face normal rotates toward
// the commanded normal. Higher = snappier. 8/s is "almost instant within
// one frame at 60Hz" but still smoothed enough to avoid pop on first frame.
const NORMAL_LERP_PER_S = 8.0;

// Scratch reused across both clamp call sites in this module.
const _tmpClampDelta = new THREE.Vector3();

export class AIPaddle {
  constructor({ difficulty = 'beginner', style = 'allround' } = {}) {
    this.difficulty = difficulty;
    this.style = style;
    // Style multiplier on movement speed — choppers cover more ground,
    // blockers cover less. Read directly off this field by aiFSM.footworkSpeed()
    // so the FSM picks up the style-aware value without threading style
    // through its own state. (There is no getMovementSpeed() method; this
    // comment used to claim one.)
    this.movementMultiplier = movementMultiplierForStyle(style);
    this.group = new THREE.Group();
    this.faceCenterWorld = new THREE.Vector3();
    this.faceNormalWorld = new THREE.Vector3(0, 0, 1);
    this.velocityWorld   = new THREE.Vector3();
    this._prevCenter = new THREE.Vector3();
    this._hasPrev = false;

    this._buildVisual();

    this.readyPose = this._computeReadyPose();
    this.snapToPose(this.readyPose.position, this.readyPose.normal);
    this._prevCenter.copy(this.faceCenterWorld);

    scene.add(this.group);

    this.handle = registerAIPaddle({
      id: AI_PADDLE_ID,
      hitRadius: HIT_RADIUS,
      getFace: () => ({
        center: this.faceCenterWorld,
        normal: this.faceNormalWorld,
        velocity: this.velocityWorld,
      }),
    });
  }

  // --- Visual ---------------------------------------------------------------
  _buildVisual() {
    // Paddle clone — offset inside the group so the group origin sits at the
    // face center (collision frame). The AI opponent renders as a floating
    // paddle only; wrist/arm stubs were removed per user request.
    if (paddleModel) {
      const clone = paddleModel.clone(true);
      clone.position.copy(paddleFaceOffset).negate();
      this.group.add(clone);
    } else {
      // Fallback: thin red disc if the GLB hasn't loaded.
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.01, 24),
        new THREE.MeshStandardMaterial({ color: 0x2050a8, roughness: 0.55 }),
      );
      disc.rotation.x = Math.PI / 2;
      this.group.add(disc);
    }
  }

  _computeReadyPose() {
    // V2 §section_4: delegate to the readyPosition module so the pose
    // includes the Pro anticipatory-bias logic and so it stays in one place.
    return computeReadyPose({
      tableBox,
      tableSurfaceY,
      difficulty: this.difficulty,
    });
  }

  // V2 §section_4 "Updates between rallies, not during". Called by the FSM
  // on the RECOVERING → IDLE transition. Refreshes this.readyPose from
  // the latest landing centroid (Pro only; non-Pro re-computes to the same
  // neutral pose).
  refreshReadyPose() {
    this.readyPose = this._computeReadyPose();
  }

  // --- Drive ----------------------------------------------------------------

  // Hard-set pose. Used at construction time AND per-frame by the FSM when
  // driving from a planned interception trajectory (V2 §section_2) — the
  // trajectory IS the speed plan, so it bypasses driveTowardPose's rate
  // limiter. The clamp must therefore live here too; without it, the
  // hermite-quintic swing arc dips below the table (its terminal-velocity
  // constraint pulls the mid-arc Y below both endpoints when the strike is
  // upward). Mirrors the same invariant enforced in driveTowardPose.
  snapToPose(position, normal) {
    this.faceCenterWorld.copy(position);
    this.faceNormalWorld.copy(normal).normalize();
    if (tableBox) {
      resolvePaddleTablePenetration(
        this.faceCenterWorld, this.faceNormalWorld,
        paddleHitRadius, paddleHalfThickness,
        tableBox, _tmpClampDelta,
      );
      this.faceCenterWorld.add(_tmpClampDelta);
    }
    this.group.position.copy(this.faceCenterWorld);
    const q = new THREE.Quaternion().setFromUnitVectors(
      paddleFaceNormalLocal,
      this.faceNormalWorld,
    );
    this.group.quaternion.copy(q);
  }

  // Move the paddle toward (targetPosition, targetNormal) over dt seconds,
  // limited to movementSpeedMps. Velocity is recomputed each call from
  // finite difference; collision picks up via getFace().
  driveTowardPose(targetPosition, targetNormal, dt, movementSpeedMps) {
    if (dt > 0) {
      const dist = targetPosition.distanceTo(this.faceCenterWorld);
      const step = Math.min(dist, movementSpeedMps * dt);
      if (dist > 1e-5) {
        const dirX = (targetPosition.x - this.faceCenterWorld.x) / dist;
        const dirY = (targetPosition.y - this.faceCenterWorld.y) / dist;
        const dirZ = (targetPosition.z - this.faceCenterWorld.z) / dist;
        this.faceCenterWorld.x += dirX * step;
        this.faceCenterWorld.y += dirY * step;
        this.faceCenterWorld.z += dirZ * step;
      }
      // Rotate the face normal toward the target first — the clamp reads it
      // to orient the rim samples, and using the fresh normal keeps the
      // sampling consistent with what the player will see this frame.
      const alpha = Math.min(1, dt * NORMAL_LERP_PER_S);
      this.faceNormalWorld.lerp(targetNormal, alpha).normalize();
      // Push the paddle out of the table if the commanded pose put it there.
      // Drive logic has no inherent obstacle awareness; without this the
      // paddle can be commanded below the felt or into a side rail.
      if (tableBox) {
        resolvePaddleTablePenetration(
          this.faceCenterWorld, this.faceNormalWorld,
          paddleHitRadius, paddleHalfThickness,
          tableBox, _tmpClampDelta,
        );
        this.faceCenterWorld.add(_tmpClampDelta);
      }
    }

    this.group.position.copy(this.faceCenterWorld);
    const q = new THREE.Quaternion().setFromUnitVectors(
      paddleFaceNormalLocal,
      this.faceNormalWorld,
    );
    this.group.quaternion.copy(q);
  }

  // Refresh the per-frame velocity from finite-difference. Must be called
  // exactly once per frame, AFTER any driveTowardPose for the frame and
  // BEFORE tickPhysics consumes getFace() (which it does via the registered
  // callback). Calling it from aiMatch.update guarantees ordering.
  refreshVelocity(dt) {
    if (this._hasPrev && dt > 1e-6) {
      this.velocityWorld
        .copy(this.faceCenterWorld)
        .sub(this._prevCenter)
        .divideScalar(dt);
    } else {
      this.velocityWorld.set(0, 0, 0);
    }
    this._prevCenter.copy(this.faceCenterWorld);
    this._hasPrev = true;
  }

  dispose() {
    if (this.handle) unregisterAIPaddle(this.handle);
    this.handle = null;
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse((node) => {
      if (node.geometry && node.geometry.dispose) node.geometry.dispose();
      if (node.material && node.material.dispose && !node.material.__shared) {
        node.material.dispose();
      }
    });
  }
}
