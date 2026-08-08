// ServerFigure — the visible server on the far end of the table, and the
// windup → swing → contact → recover animation it plays for each feed.
//
// This is the half of the old feeder.js that legitimately owns scene state:
// a cloned paddle, a grip ring, a held-ball decoration, and the pose
// interpolation between them. It keeps its `js/scene/*` imports, and that is
// correct — it exists to put meshes in the world.
//
// The other half (deciding WHAT to feed, and verifying the shot lands where
// commanded) moved to feedEngine.js, which imports no scene module and is
// therefore testable headless. The split is migration-plan D4.
//
// The division of labour is: the CALLER decides when a feed happens and what
// its contact pose is; this class plays the animation and calls back at the
// exact contact frame so the physics ball can be spawned in sync with the
// paddle face. It owns no scheduling and no ball physics.

import * as THREE from 'three';
import { scene } from '../../scene/sceneSetup.js';
import {
  tableBox, tableSurfaceY, ballRadius,
  paddleModel, paddleFaceOffset, paddleFaceNormalLocal,
} from '../../scene/models.js';

// Serve animation timings (seconds). SWING is short on purpose — a real serve
// strike is a fast snap (≈0.1 s), not a slow sweep; the brief duration plus
// the long WINDUP→CONTACT travel distance gives ~3 m/s peak paddle speed,
// which reads as a real swing rather than a drift.
export const WINDUP_DURATION = 0.26;
export const SWING_DURATION = 0.10;
export const RECOVER_DURATION = 0.28;

// Total animation prelude. Callers subtract this from their feed interval so
// the perceived rhythm tracks the configured interval rather than running
// late by the length of the animation.
export const SWING_CYCLE_SEC = WINDUP_DURATION + SWING_DURATION + RECOVER_DURATION;

export class ServerFigure {
  constructor() {
    // IDLE → WINDING → SWINGING → (contact) → RECOVERING → IDLE
    this.state = 'IDLE';
    this.timeInState = 0;
    this.contactPose = null;
    this.onContact = null;

    this.group = this.build();
    // Legacy alias: call sites toggle `feeder.emitter.visible` to hide the
    // whole server in one call. Kept so those keep working.
    this.emitter = this.group;
  }

  get isIdle() { return this.state === 'IDLE'; }

  // --- Construction ---------------------------------------------------------

  build() {
    const group = new THREE.Group();
    if (!tableBox) return group;

    // Paddle clone — paddleGroup's position is the FACE CENTER (with the
    // clone offset by −paddleFaceOffset inside so the paddle's face sits at
    // the group origin). Orientation is chosen so paddleFaceNormalLocal ·
    // paddleGroup.quaternion = world face normal — matches how the player's
    // paddle is oriented.
    this.paddleGroup = new THREE.Group();
    group.add(this.paddleGroup);

    if (paddleModel) {
      const clonedPaddle = paddleModel.clone(true);
      clonedPaddle.position.copy(paddleFaceOffset).negate();
      this.paddleGroup.add(clonedPaddle);
    } else {
      // Fallback: tiny disc in case paddle.glb hasn't loaded yet.
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.01, 24),
        new THREE.MeshStandardMaterial({ color: 0xb03020, roughness: 0.55 }),
      );
      disc.rotation.x = Math.PI / 2;
      this.paddleGroup.add(disc);
    }

    // Held-ball decoration — sits on the paddle face between serves. Hides at
    // the moment of CONTACT so the physics ball (which spawns at the same
    // pose) appears to leave the paddle naturally.
    const ballGeom = new THREE.SphereGeometry(ballRadius * 0.98, 18, 14);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xf4f4f0,
      roughness: 0.55,
      metalness: 0.0,
    });
    this.heldBall = new THREE.Mesh(ballGeom, ballMat);
    // Offset along paddle-local face normal so the ball rests on the face.
    this.heldBall.position.copy(paddleFaceNormalLocal).multiplyScalar(ballRadius + 0.002);
    this.paddleGroup.add(this.heldBall);

    // Grip ring — a small flat torus at the paddle handle. Reads as a
    // stylised "where the hand would be" marker without committing to a full
    // arm/hand model. Parented to paddleGroup so it travels with the paddle
    // through the swing.
    const handleDir = paddleFaceOffset.lengthSq() > 1e-8
      ? paddleFaceOffset.clone().normalize()
      : new THREE.Vector3(0, 0, 1);
    const gripGeom = new THREE.TorusGeometry(0.045, 0.009, 8, 28);
    const gripMat = new THREE.MeshStandardMaterial({
      color: 0xffb955,
      roughness: 0.55,
      metalness: 0.1,
    });
    this.gripRing = new THREE.Mesh(gripGeom, gripMat);
    // Place the ring near the handle end (controller-equivalent origin sits
    // at −paddleFaceOffset in paddleGroup local space).
    this.gripRing.position.copy(paddleFaceOffset).multiplyScalar(-1.05);
    // Torus axis defaults to +Z — rotate so it aligns with the handle axis.
    this.gripRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), handleDir);
    this.paddleGroup.add(this.gripRing);

    // Seed paddleGroup at READY so the figure is visible before the first feed.
    this.readyPose = this.computeReadyPose();
    this.applyPaddlePose(this.readyPose.position, this.readyPose.normal);

    scene.add(group);
    return group;
  }

  // --- Poses ----------------------------------------------------------------

  // Where the paddle sits between serves: held near the body with the face
  // turned UP so the (decorative) held ball reads as resting on it.
  computeReadyPose() {
    const centerX = (tableBox.min.x + tableBox.max.x) / 2;
    const position = new THREE.Vector3(
      centerX + 0.05,
      tableSurfaceY + 0.28,
      tableBox.min.z - 0.06,
    );
    // Face mostly up with a touch of forward — keeps the held ball visually
    // perched on the paddle face from the player's side of the table.
    const normal = new THREE.Vector3(0.0, 0.95, 0.30).normalize();
    return { position, normal };
  }

  // Pull-back pose at end of wind-up — paddle raised behind the body. The
  // face stays roughly UP so the held ball still appears to ride on it; the
  // long travel from here to the contact point is what produces visible
  // swing speed.
  computeWindupPose() {
    const centerX = (tableBox.min.x + tableBox.max.x) / 2;
    const position = new THREE.Vector3(
      centerX + 0.12,
      tableSurfaceY + 0.48,
      tableBox.min.z - 0.36,
    );
    const normal = new THREE.Vector3(0.05, 0.92, 0.40).normalize();
    return { position, normal };
  }

  // Strike pose at the moment of contact. The face center sits at the spawn
  // position so the physics ball begins exactly where the paddle face ends.
  // The face normal points along the HORIZONTAL launch direction with a small
  // upward tilt — we deliberately ignore the launchVelocity's Y component
  // (which is large because the ball must arc up to the own-side bounce),
  // since aligning the paddle to the full velocity vector reads as a "toss"
  // rather than a "strike."
  static computeContactPose(spawnPos, launchVelocity) {
    const horiz = new THREE.Vector3(launchVelocity.x, 0, launchVelocity.z);
    if (horiz.lengthSq() < 1e-6) horiz.set(0, 0, 1);
    horiz.normalize();
    const normal = horiz.clone();
    normal.y = 0.18;  // slight open-face tilt — flat-to-soft-topspin aesthetic
    normal.normalize();
    return { position: spawnPos.clone(), normal };
  }

  // Follow-through past the contact point — paddle continues forward along the
  // strike direction, dropping slightly. Reads as the wrist relaxing after
  // the snap.
  computeFollowThroughPose(contactPose) {
    const forward = contactPose.normal.clone();
    const position = contactPose.position.clone().addScaledVector(forward, 0.22);
    position.y = Math.max(position.y - 0.06, tableSurfaceY + 0.15);
    // Tilt the face a touch downward in follow-through so it isn't pointing
    // straight at the player after contact.
    const normal = forward.clone();
    normal.y = Math.max(normal.y - 0.10, -0.20);
    normal.normalize();
    return { position, normal };
  }

  // Sets paddleGroup position and orientation so its FACE CENTER is at
  // `position` and its FACE NORMAL points along `normal`.
  applyPaddlePose(position, normal) {
    if (!this.paddleGroup) return;
    this.paddleGroup.position.copy(position);
    const q = new THREE.Quaternion().setFromUnitVectors(paddleFaceNormalLocal, normal);
    this.paddleGroup.quaternion.copy(q);
  }

  // --- Animation ------------------------------------------------------------

  // Cubic ease-in-out — slow at the ends, faster mid-swing. Reads as a more
  // human motion than linear interpolation.
  static easeInOut(u) {
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }

  // Quadratic ease-in — used for the swing leg so the paddle accelerates
  // into the ball rather than coasting at constant speed.
  static easeIn(u) { return u * u; }

  animateBetween(poseA, poseB, u) {
    const position = poseA.position.clone().lerp(poseB.position, u);
    const normal = poseA.normal.clone().lerp(poseB.normal, u).normalize();
    this.applyPaddlePose(position, normal);
  }

  /**
   * Begin a swing that strikes at `contactPose`.
   *
   * `onContact` fires at the exact contact frame — the caller spawns the
   * physics ball there so it leaves the paddle face cleanly. Ignored if a
   * swing is already in progress.
   */
  beginSwing(contactPose, onContact) {
    if (!this.paddleGroup || this.state !== 'IDLE') return false;
    this.contactPose = contactPose;
    this.onContact = onContact || null;
    if (!this.readyPose) this.readyPose = this.computeReadyPose();
    this.windupPose = this.computeWindupPose();
    this.followThroughPose = this.computeFollowThroughPose(contactPose);
    this.state = 'WINDING';
    this.timeInState = 0;
    return true;
  }

  showHeldBall(visible) {
    if (this.heldBall) this.heldBall.visible = visible;
  }

  update(dt) {
    if (!this.paddleGroup) return;

    switch (this.state) {
      case 'IDLE': {
        if (!this.readyPose) this.readyPose = this.computeReadyPose();
        this.applyPaddlePose(this.readyPose.position, this.readyPose.normal);
        break;
      }
      case 'WINDING': {
        this.timeInState += dt;
        const u = Math.min(this.timeInState / WINDUP_DURATION, 1);
        this.animateBetween(this.readyPose, this.windupPose, ServerFigure.easeInOut(u));
        if (this.timeInState >= WINDUP_DURATION) {
          this.state = 'SWINGING';
          this.timeInState = 0;
        }
        break;
      }
      case 'SWINGING': {
        this.timeInState += dt;
        const u = Math.min(this.timeInState / SWING_DURATION, 1);
        this.animateBetween(this.windupPose, this.contactPose, ServerFigure.easeIn(u));
        if (this.timeInState >= SWING_DURATION) this.fireContact();
        break;
      }
      case 'RECOVERING': {
        this.timeInState += dt;
        const u = Math.min(this.timeInState / RECOVER_DURATION, 1);
        // Two-step recovery: contact → follow-through (first half), then
        // follow-through → ready (second half). Reads as a real swing arc.
        if (u < 0.5) {
          this.animateBetween(this.contactPose, this.followThroughPose,
            ServerFigure.easeInOut(u * 2));
        } else {
          this.animateBetween(this.followThroughPose, this.readyPose,
            ServerFigure.easeInOut((u - 0.5) * 2));
        }
        if (this.timeInState >= RECOVER_DURATION) {
          this.state = 'IDLE';
          this.timeInState = 0;
        }
        break;
      }
    }
  }

  fireContact() {
    // Snap visuals to the exact contact pose before handing control back, so
    // the ball appears to leave the paddle face rather than a frame short of it.
    this.applyPaddlePose(this.contactPose.position, this.contactPose.normal);
    this.showHeldBall(false);
    this.state = 'RECOVERING';
    this.timeInState = 0;
    if (this.onContact) {
      const cb = this.onContact;
      this.onContact = null;
      cb();
    }
  }

  dispose() {
    if (this.group) {
      scene.remove(this.group);
      this.group.traverse((node) => {
        if (node.geometry && node.geometry.dispose) node.geometry.dispose();
        if (node.material && node.material.dispose) node.material.dispose();
      });
      this.group = null;
      this.emitter = null;
      this.paddleGroup = null;
    }
    this.onContact = null;
  }
}
