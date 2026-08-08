// Ball machine. Schedules, spawns, and aims one ball at a time.
// Reuses the existing single-ball physics in physics/ball.js — only one ball
// in flight in v1.
//
// The server FIGURE (paddle, grip ring, held ball, and the windup → swing →
// recover animation) now lives in serverFigure.js. What remains here is the
// scheduling and shot-planning this class always owned: when to serve, where
// to place it, and what spin to put on it.
//
// Each feed cycle plays a wind-up → swing animation; the physics ball spawns
// at the CONTACT frame (end of swing) with a two-stage serve trajectory —
// first bounce on the server's own half, second bounce on the receiver's half,
// per the real rules of table tennis service.
//
// NOTE ON THE MIGRATION: this is the LEGACY feed path. The M1 Ball Machine
// replaces it with feedEngine.js, which solves a commanded landing point and
// forward-verifies it through the shared integrator rather than relying on a
// closed-form two-stage serve. Both must not stay live once M1 is wired to
// the UI — see rule 3 in tt-training-migration-plan.md.

import * as THREE from 'three';
import { tableBox, tableSurfaceY, ballModel } from '../../scene/models.js';
import { spawnBallAt, ballAngularVelocity } from '../../physics/ball.js';
import { serveBallistic } from './launchKinematics.js';
import { ServerFigure, SWING_CYCLE_SEC } from './serverFigure.js';

// Spin axes (right-hand rule, ball moving in +Z toward player at z=0):
//   topspin  → ω in +X (ball drops faster)
//   backspin → ω in -X (ball floats / slows on bounce)
//   sideA    → ω in +Y (ball curves toward +X mid-flight)
//   sideB    → ω in -Y (ball curves toward -X mid-flight)
//   none     → ω = 0
export const SPIN_AXES = {
  topspin:  new THREE.Vector3( 1, 0, 0),
  backspin: new THREE.Vector3(-1, 0, 0),
  sideA:    new THREE.Vector3( 0, 1, 0),
  sideB:    new THREE.Vector3( 0,-1, 0),
  none:     new THREE.Vector3( 0, 0, 0),
};

export class Feeder {
  constructor(profile) {
    this.profile = { ...profile };
    this.timeUntilNext = 0.6; // small initial countdown so player can ready
    this.spawnPosCache = new THREE.Vector3();
    this.landingCache = new THREE.Vector3();
    this.velocityCache = new THREE.Vector3();
    this.placementMode = 'alternating'; // 'forehand' | 'backhand' | 'alternating' | 'random'
    this.spinSequence = ['topspin']; // can be overridden by drills
    this.spinIndex = 0;
    this.alternateSign = 1;
    this.paused = false;
    this.shotsFed = 0;
    this.lastShot = null; // metadata of most recent feed
    this.listeners = []; // (shot) => void called on each feed

    this.shotPlan = null; // pre-solved velocity/spin for the upcoming contact

    // The visible server. `this.emitter` stays exposed because call sites
    // toggle `feeder.emitter.visible` to hide the whole figure in one call.
    this.figure = new ServerFigure();
    this.emitter = this.figure.emitter;
  }

  // --- Drill API --------------------------------------------------------------

  setPlacementMode(mode) {
    this.placementMode = mode;
  }

  setSpinSequence(seq) {
    this.spinSequence = seq;
    this.spinIndex = 0;
  }

  onFeed(fn) { this.listeners.push(fn); }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  pickPlacementX() {
    if (!tableBox) return 0;
    const halfWidth = (tableBox.max.x - tableBox.min.x) / 2;
    const usable = halfWidth * 0.85;
    const jitter = (Math.random() - 0.5) * 2 * this.profile.placementJitter;
    let side;
    switch (this.placementMode) {
      case 'forehand': side = 0.7; break;
      case 'backhand': side = -0.7; break;
      case 'random':   side = (Math.random() - 0.5) * 1.4; break;
      case 'alternating':
      default:
        side = this.alternateSign * 0.7;
        this.alternateSign = -this.alternateSign;
        break;
    }
    return THREE.MathUtils.clamp(side * usable + jitter, -halfWidth, halfWidth);
  }

  pickSpin() {
    const name = this.spinSequence[this.spinIndex % this.spinSequence.length];
    this.spinIndex++;
    return name;
  }

  computeSpawnPos(out) {
    const x = (tableBox.min.x + tableBox.max.x) / 2;
    const y = tableSurfaceY + 0.25;
    const z = tableBox.min.z + 0.05;
    out.set(x, y, z);
  }

  computeLanding(targetX, out) {
    const centerZ = (tableBox.min.z + tableBox.max.z) / 2;
    const playerHalfDepth = (tableBox.max.z - centerZ) * 0.55;
    const z = centerZ + playerHalfDepth;
    out.set(targetX, tableSurfaceY, z);
  }

  // --- Serve lifecycle --------------------------------------------------------

  // Solve the full serve plan (own-half bounce + player-half landing) and
  // hand the contact pose to the figure to animate. The physics ball is NOT
  // yet spawned — that happens at the figure's CONTACT callback.
  startServe() {
    if (!tableBox || !ballModel) return;
    this.computeSpawnPos(this.spawnPosCache);
    const targetX = this.pickPlacementX();
    this.computeLanding(targetX, this.landingCache);

    // T1 = time-to-own-bounce. Reuse the difficulty's flightTime as the
    // leg-1 duration (total flight ≈ T1 + T2 ≈ 1.5·flightTime under the
    // current restitution). The pacing field stays meaningful even though
    // the ball now arrives later than a one-leg shot.
    const result = serveBallistic(
      this.spawnPosCache, this.landingCache, tableSurfaceY,
      this.profile.flightTime, null, this.velocityCache,
    );

    const spinName = this.pickSpin();
    const axis = SPIN_AXES[spinName] || SPIN_AXES.none;
    this.shotPlan = {
      velocity: result.velocity.clone(),
      ownBounce: result.ownBounce.clone(),
      angVel: axis.clone().multiplyScalar(this.profile.spinMag),
      spinName,
      placementX: targetX,
      landing: this.landingCache.clone(),
      contactPose: ServerFigure.computeContactPose(this.spawnPosCache, result.velocity),
    };

    this.figure.beginSwing(this.shotPlan.contactPose, () => this.contact());
  }

  contact() {
    if (!this.shotPlan) return;
    spawnBallAt(this.shotPlan.contactPose.position, this.shotPlan.velocity, this.shotPlan.angVel);

    this.shotsFed++;
    this.lastShot = {
      spin: this.shotPlan.spinName,
      placementX: this.shotPlan.placementX,
      landing: this.shotPlan.landing.clone(),
      ownBounce: this.shotPlan.ownBounce.clone(),
      shotIndex: this.shotsFed,
    };
    for (const fn of this.listeners) fn(this.lastShot);

    // Subtract the animation prelude so the perceived rhythm tracks
    // profile.feedIntervalSec. Floor a small gap so back-to-back feeds still
    // have a brief "settle" beat.
    this.timeUntilNext = Math.max(this.profile.feedIntervalSec - SWING_CYCLE_SEC, 0.1);
  }

  update(dt) {
    if (this.paused) return;
    if (!this.figure) return;

    this.figure.update(dt);

    // Only count down toward the next serve while the figure is at rest.
    if (!this.figure.isIdle) return;

    // Don't start a new serve until the previous ball has cleared.
    if (ballModel && ballModel.visible) return;

    this.figure.showHeldBall(true);
    this.timeUntilNext -= dt;
    if (this.timeUntilNext <= 0) this.startServe();
  }

  dispose() {
    if (this.figure) {
      this.figure.dispose();
      this.figure = null;
      this.emitter = null;
    }
    this.listeners.length = 0;
    if (ballModel) ballModel.visible = false;
    ballAngularVelocity.set(0, 0, 0);
  }
}
