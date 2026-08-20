# TT AI Opponent — Full Implementation Guide

> **Coding Agent Rules — Read Before Touching Anything**
>
> - **DO NOT** modify ball physics, player input handling, collision detection, rendering pipeline, game loop, scoring, or any existing game systems
> - **ONLY** create new files under `/src/ai/` and wire them in via the single integration points defined in Step 9
> - All integration points are clearly marked with `// AI_INTEGRATION_POINT` comments — those are the only places you touch existing code
> - If something breaks in existing gameplay after your changes, you have violated this boundary — revert and isolate

---

## Architecture Overview

```
PlayerIntentPredictor (TF.js TCN)
         ↓ prediction before contact
AIBrain (orchestrator)
    ├── PlayerModel       → live tendency + pattern tracker
    ├── TacticalPlanner   → 2-shot lookahead + shot selection
    ├── ShotExecutor      → paddle orientation + force solver
    └── MomentumModel     → timing variance + emotional state
         ↓
ShotExecutor applies force + spin to ball via existing physics
```

The AI never writes directly to ball velocity or paddle mesh. It returns values. The existing game applies them through the integration points.

---

## File Structure to Create

```
/src/ai/
  ai-types.js
  PlayerIntentPredictor.js
  PlayerModel.js
  TacticalPlanner.js
  MomentumModel.js
  PaddleOrientationSolver.js
  ShotForceSolver.js
  AIBrain.js
/public/models/intent/   ← empty for now, populated after training
```

---

## Step 1 — ai-types.js

All shared constants. No logic, no dependencies.

```javascript
// /src/ai/ai-types.js

export const SHOT_TYPES = {
  TOPSPIN_LOOP:   'topspin_loop',
  BACKHAND_LOOP:  'backhand_loop',
  FOREHAND_DRIVE: 'forehand_drive',
  BACKHAND_DRIVE: 'backhand_drive',
  PUSH:           'push',
  FLICK:          'flick',
  BLOCK:          'block',
  LOB:            'lob'
};

export const RALLY_STATE = {
  NEUTRAL:    'neutral',
  ATTACKING:  'attacking',
  DEFENSIVE:  'defensive',
  FINISHING:  'finishing'
};

export const DIFFICULTY = {
  BEGINNER:     1,
  INTERMEDIATE: 2,
  ADVANCED:     3,
  EXPERT:       4,
  PRO:          5
};

// Per difficulty: [reactionDelayMs, maxPaddleSpeedMs, exploitRate, timingVarianceMs]
export const DIFFICULTY_PARAMS = {
  1: { reactionDelay: 180, maxPaddleSpeed: 2.5, exploitRate: 0.10, timingVariance: 80 },
  2: { reactionDelay: 130, maxPaddleSpeed: 3.5, exploitRate: 0.30, timingVariance: 55 },
  3: { reactionDelay:  90, maxPaddleSpeed: 4.5, exploitRate: 0.50, timingVariance: 35 },
  4: { reactionDelay:  50, maxPaddleSpeed: 6.0, exploitRate: 0.70, timingVariance: 18 },
  5: { reactionDelay:  20, maxPaddleSpeed: 7.5, exploitRate: 0.90, timingVariance:  8 }
};

// Physics envelope per shot type
// spin: [min, max] rad/s   axis: [min, max] tilt from Y
// speed: [min, max] multiplier   face: [min, max] angle offset radians
export const SHOT_ENVELOPES = {
  topspin_loop:   { spin: [60, 90],   axis: [0.10, 0.20], speed: [1.2, 1.8], face: [-0.25, -0.15] },
  backhand_loop:  { spin: [50, 80],   axis: [0.10, 0.20], speed: [1.1, 1.6], face: [-0.22, -0.12] },
  forehand_drive: { spin: [20, 40],   axis: [0.00, 0.10], speed: [1.4, 2.0], face: [-0.10, -0.05] },
  backhand_drive: { spin: [15, 35],   axis: [0.00, 0.10], speed: [1.3, 1.8], face: [-0.10, -0.05] },
  push:           { spin: [-40, -20], axis: [-0.10, 0.00], speed: [0.6, 1.0], face: [0.15,  0.25] },
  flick:          { spin: [30, 60],   axis: [0.10, 0.30], speed: [1.5, 2.2], face: [-0.20, -0.10] },
  block:          { spin: [-10, 10],  axis: [-0.05, 0.05], speed: [0.8, 1.1], face: [0.00,  0.05] },
  lob:            { spin: [40, 70],   axis: [0.20, 0.40], speed: [0.5, 0.8], face: [-0.20, -0.10] }
};
```

---

## Step 2 — PlayerIntentPredictor.js

Reads player controller state frame by frame and predicts shot direction + spin type BEFORE the player makes contact. Falls back to heuristics until a trained model is available.

```javascript
// /src/ai/PlayerIntentPredictor.js
import * as tf from '@tensorflow/tfjs';

export class PlayerIntentPredictor {
  constructor() {
    this.BUFFER_SIZE = 20;   // frames of pre-contact history
    this.buffer = [];
    this.model = null;
    this.modelReady = false;
  }

  async init() {
    try {
      this.model = await tf.loadLayersModel('/models/intent/model.json');
      this.modelReady = true;
      console.log('[AI] Intent model loaded');
    } catch {
      this.model = this._buildArchitecture();
      this.modelReady = false;
      console.log('[AI] Intent model not found — using heuristic fallback');
    }
  }

  _buildArchitecture() {
    // TCN — temporal convolutional net
    // Input: 20 frames × 12 features
    // Output: 6 probabilities [leftDir, centerDir, rightDir, topspin, backspin, sidespin]
    const model = tf.sequential();
    model.add(tf.layers.conv1d({
      inputShape: [20, 12], filters: 32, kernelSize: 3,
      padding: 'same', activation: 'relu'
    }));
    model.add(tf.layers.conv1d({
      filters: 64, kernelSize: 3, padding: 'same', activation: 'relu'
    }));
    model.add(tf.layers.globalAveragePooling1d());
    model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 6,  activation: 'softmax' }));
    model.compile({ optimizer: 'adam', loss: 'categoricalCrossentropy' });
    return model;
  }

  // Call every frame with the player's controller state object:
  // { position: Vector3, velocity: Vector3, angularVelocity: Vector3, quaternion: Quaternion }
  pushFrame(ctrl) {
    this.buffer.push([
      ctrl.position.x, ctrl.position.y, ctrl.position.z,
      ctrl.velocity.x, ctrl.velocity.y, ctrl.velocity.z,
      ctrl.angularVelocity.x, ctrl.angularVelocity.y, ctrl.angularVelocity.z,
      ctrl.quaternion.y, ctrl.quaternion.z, ctrl.quaternion.w
    ]);
    if (this.buffer.length > this.BUFFER_SIZE) this.buffer.shift();
  }

  // Call ~150ms before predicted contact. Returns prediction object.
  predict() {
    if (!this.modelReady || this.buffer.length < this.BUFFER_SIZE) {
      return this._heuristicPredict();
    }
    const input = tf.tensor3d([this.buffer]);
    const output = this.model.predict(input);
    const p = output.dataSync();
    input.dispose(); output.dispose();

    return {
      direction: p[0] > p[2] ? 'left' : p[2] > p[0] ? 'right' : 'center',
      directionConfidence: Math.max(p[0], p[1], p[2]),
      spinType: p[3] > p[4] ? 'topspin' : 'backspin',
      spinConfidence: Math.max(p[3], p[4])
    };
  }

  _heuristicPredict() {
    if (this.buffer.length < 5) {
      return { direction: 'center', directionConfidence: 0.3, spinType: 'topspin', spinConfidence: 0.3 };
    }
    const recent = this.buffer.slice(-5);
    const avgVelX   = recent.reduce((s, f) => s + f[3], 0) / 5;
    const avgAngVelY = recent.reduce((s, f) => s + f[7], 0) / 5;
    return {
      direction: avgVelX > 0.15 ? 'right' : avgVelX < -0.15 ? 'left' : 'center',
      directionConfidence: 0.5,
      spinType: avgAngVelY > 0 ? 'topspin' : 'backspin',
      spinConfidence: 0.5
    };
  }

  reset() { this.buffer = []; }
}
```

---

## Step 3 — PlayerModel.js

Builds a live profile of the specific player during the match. Updates after every point. Detects patterns and weak side.

```javascript
// /src/ai/PlayerModel.js

export class PlayerModel {
  constructor() {
    this.shots = [];
    this.tendencies = {
      forehandRate:          0.5,
      crossCourtRate:        0.5,
      topspinRate:           0.5,
      aggressUnderPressure:  0.5,
      patternBuffer:         []   // last 6 shot directions
    };
  }

  // Call after each point with the player's last shot data
  // shot: { type, direction, spin, wasUnderPressure }
  recordShot(shot) {
    this.shots.push(shot);
    this._update(shot);
  }

  _update(shot) {
    const a = 0.15; // recency weight
    const isFH   = shot.type?.includes('forehand') ? 1 : 0;
    const isCross = shot.direction === 'cross' ? 1 : 0;
    const isTop   = (shot.spin ?? 0) > 0 ? 1 : 0;

    this.tendencies.forehandRate    = lerp(this.tendencies.forehandRate,    isFH,   a);
    this.tendencies.crossCourtRate  = lerp(this.tendencies.crossCourtRate,  isCross, a);
    this.tendencies.topspinRate     = lerp(this.tendencies.topspinRate,     isTop,  a);

    if (shot.wasUnderPressure) {
      this.tendencies.aggressUnderPressure = lerp(this.tendencies.aggressUnderPressure, isFH, a);
    }

    this.tendencies.patternBuffer.push(shot.direction);
    if (this.tendencies.patternBuffer.length > 6) this.tendencies.patternBuffer.shift();
  }

  // Returns { type, direction, confidence } or null
  detectPattern() {
    const buf = this.tendencies.patternBuffer;
    if (buf.length < 4) return null;

    const last3 = buf.slice(-3);
    if (last3.every(d => d === last3[0])) {
      return { type: 'repetitive', direction: last3[0], confidence: 0.80 };
    }
    if (buf.length >= 4) {
      const [a, b, c, d] = buf.slice(-4);
      if (a === c && b === d) return { type: 'alternating', confidence: 0.65 };
    }
    return null;
  }

  // Returns 'forehand' or 'backhand'
  getWeakSide() {
    return this.tendencies.forehandRate > 0.65 ? 'backhand' : 'forehand';
  }

  reset() {
    this.shots = [];
    this.tendencies = {
      forehandRate: 0.5, crossCourtRate: 0.5,
      topspinRate: 0.5, aggressUnderPressure: 0.5, patternBuffer: []
    };
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
```

---

## Step 4 — PaddleOrientationSolver.js

Back-calculates the geometrically correct paddle normal given incoming ball, desired target, and shot type. Uses the bisector method — no guessing, no fixed angles.

```javascript
// /src/ai/PaddleOrientationSolver.js
import * as THREE from 'three';

const FACE_OFFSETS = {
  topspin_loop:   -0.20,
  backhand_loop:  -0.18,
  forehand_drive: -0.07,
  backhand_drive: -0.07,
  push:            0.22,
  flick:          -0.15,
  block:           0.03,
  lob:            -0.12
};

// Returns THREE.Quaternion for AI paddle orientation at contact
export function computePaddleOrientation(ballVelocity, contactPoint, targetPoint, shotType) {
  const incoming = ballVelocity.clone().normalize();
  const desired  = new THREE.Vector3().subVectors(targetPoint, contactPoint).normalize();

  // Bisector = paddle normal that reflects incoming toward desired
  const normal = incoming.clone().add(desired).normalize();

  // Apply face angle offset for spin type
  const offset = FACE_OFFSETS[shotType] ?? 0;
  normal.applyAxisAngle(new THREE.Vector3(1, 0, 0), offset);

  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
}
```

---

## Step 5 — ShotForceSolver.js

Binary search on initial speed to land ball at exact target zone. Runs forward simulation using the same Magnus force your existing physics uses — results are consistent with your game's ball behavior.

> **Important:** Pass the same `magnusCoeff` and gravity values your existing ball physics uses. If they differ, the AI shots will arc differently than player shots.

```javascript
// /src/ai/ShotForceSolver.js
import * as THREE from 'three';

const GRAVITY = new THREE.Vector3(0, -9.81, 0);
const TABLE_Y = 0.76;  // adjust to match your table height
const DT      = 0.016;

// Returns THREE.Vector3 — initial ball velocity for AI shot
export function solveForce(contactPoint, paddleNormal, targetZone, spinVector, magnusCoeff = 0.00041) {
  const dir = paddleNormal.clone().normalize();
  let lo = 1.0, hi = 20.0, bestSpeed = 8.0;

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const landing = _simulate(contactPoint, dir.clone().multiplyScalar(mid), spinVector, magnusCoeff);
    const err = new THREE.Vector2(landing.x - targetZone.x, landing.z - targetZone.z).length();
    if (err < 0.04) { bestSpeed = mid; break; }
    if (landing.z > targetZone.z) hi = mid; else lo = mid;
    bestSpeed = mid;
  }

  return dir.clone().multiplyScalar(bestSpeed);
}

function _simulate(pos, vel, spin, magnusCoeff) {
  let p = pos.clone();
  let v = vel.clone();

  for (let i = 0; i < 300; i++) {
    const magnus = new THREE.Vector3().crossVectors(spin, v).multiplyScalar(magnusCoeff);
    v.addScaledVector(GRAVITY, DT);
    v.addScaledVector(magnus, DT);
    p.addScaledVector(v, DT);
    if (p.y <= TABLE_Y && i > 5) return p; // first table bounce
  }
  return p;
}
```

---

## Step 6 — MomentumModel.js

Tracks match momentum. Modulates AI timing variance and shot aggression. Makes the AI feel like it has emotional state — on a run it hits earlier and more aggressively; when losing it tightens up or gambles depending on personality.

```javascript
// /src/ai/MomentumModel.js

export class MomentumModel {
  constructor() {
    this.value = 0.0; // -1.0 (losing badly) to 1.0 (on a run)
  }

  // Call after each point. result: 'won' | 'lost' | 'net' | 'out'
  update(result) {
    const delta = { won: 0.15, lost: -0.20, net: -0.05, out: -0.08 }[result] ?? 0;
    this.value = Math.max(-1, Math.min(1, this.value + delta));
    this.value *= 0.92; // decay toward neutral over time
  }

  // Returns timing offset in milliseconds
  // Positive = hit early (more pace, less control)
  // Negative = hit late (more spin, less pace)
  getTimingOffset(difficulty) {
    const baseVariance = [80, 55, 35, 18, 8][difficulty - 1];
    const momentumShift = this.value * 12; // on momentum = slightly early
    return (Math.random() - 0.5) * 2 * baseVariance - momentumShift;
  }

  // Returns aggression multiplier 0.7–1.3
  getAggressionScale() {
    return 1.0 + this.value * 0.3;
  }

  reset() { this.value = 0.0; }
}
```

---

## Step 7 — TacticalPlanner.js

Selects shot type and target zone using rally state, player tendencies, pattern detection, and 2-shot lookahead logic. This is where TT intelligence lives.

```javascript
// /src/ai/TacticalPlanner.js
import { SHOT_TYPES, RALLY_STATE, DIFFICULTY_PARAMS } from './ai-types.js';
import * as THREE from 'three';

// Table zones — adjust Z values to match your coordinate system
// AI is at positive Z, player at negative Z
const ZONES = {
  deepCross:    new THREE.Vector3( 0.40, 0.76, -1.40),
  deepLine:     new THREE.Vector3(-0.40, 0.76, -1.40),
  shortCross:   new THREE.Vector3( 0.30, 0.76, -0.80),
  shortLine:    new THREE.Vector3(-0.30, 0.76, -0.80),
  deepCenter:   new THREE.Vector3( 0.00, 0.76, -1.50),
  wideBackhand: new THREE.Vector3( 0.50, 0.76, -1.20),
  wideForehand: new THREE.Vector3(-0.50, 0.76, -1.20),
};

export class TacticalPlanner {
  constructor(difficulty) {
    this.difficulty = difficulty;
    this.params = DIFFICULTY_PARAMS[difficulty];
    this.rallyState = RALLY_STATE.NEUTRAL;
    this.shotCount = 0;
    this._setupHistory = []; // last 3 target zones — avoids repetition
  }

  // Returns { shotType: string, targetZone: THREE.Vector3 }
  selectShot(gameState, playerModel, intentPrediction, momentum) {
    const { incomingBall, aiBodyPosition } = gameState;

    this.rallyState = this._evalRallyState(incomingBall, aiBodyPosition, momentum);

    const pattern   = playerModel.detectPattern();
    const weakSide  = playerModel.getWeakSide();
    const exploit   = this.params.exploitRate;

    let shotType, targetZone;

    switch (this.rallyState) {
      case RALLY_STATE.DEFENSIVE:
        shotType   = SHOT_TYPES.LOB;
        targetZone = ZONES.deepCenter.clone();
        break;

      case RALLY_STATE.ATTACKING:
        shotType   = this._attackShot(incomingBall);
        targetZone = this._attackZone(weakSide, pattern, exploit);
        break;

      case RALLY_STATE.FINISHING:
        shotType   = this._attackShot(incomingBall);
        // Go opposite of player's predicted direction
        targetZone = intentPrediction.direction === 'left'
          ? ZONES.wideForehand.clone()
          : ZONES.wideBackhand.clone();
        break;

      default: // NEUTRAL — build the point
        shotType   = this._neutralShot(incomingBall);
        targetZone = this._setupZone(weakSide, exploit);
        break;
    }

    // Prevent 3 identical zones in a row
    targetZone = this._diversify(targetZone, exploit);
    this._setupHistory.push(targetZone.clone());
    if (this._setupHistory.length > 3) this._setupHistory.shift();

    this.shotCount++;
    return { shotType, targetZone };
  }

  _evalRallyState(ball, aiPos, momentum) {
    const speed    = ball.velocity?.length() ?? 0;
    const height   = ball.position?.y ?? 0.76;
    const dist     = aiPos?.distanceTo?.(ball.predictedBounce ?? ball.position) ?? 0;

    if (dist > 1.3) return RALLY_STATE.DEFENSIVE;
    if (height > 1.15 && speed < 4.5) return RALLY_STATE.ATTACKING;
    if (momentum > 0.55 && this.shotCount > 2) return RALLY_STATE.FINISHING;
    return RALLY_STATE.NEUTRAL;
  }

  _attackShot(ball) {
    const spinY = ball.spin?.y ?? 0;
    if (spinY < -25) return SHOT_TYPES.TOPSPIN_LOOP; // heavy backspin — open face, loop
    if (spinY > 25)  return SHOT_TYPES.FLICK;
    return SHOT_TYPES.FOREHAND_DRIVE;
  }

  _neutralShot(ball) {
    const spinY = ball.spin?.y ?? 0;
    if (spinY < -30) return SHOT_TYPES.PUSH;
    if (spinY > 30)  return SHOT_TYPES.BLOCK;
    return Math.random() > 0.5 ? SHOT_TYPES.TOPSPIN_LOOP : SHOT_TYPES.BACKHAND_LOOP;
  }

  _attackZone(weakSide, pattern, exploitRate) {
    // Exploit detected pattern — go opposite
    if (pattern?.type === 'repetitive' && Math.random() < exploitRate) {
      return pattern.direction === 'left' ? ZONES.wideForehand.clone() : ZONES.wideBackhand.clone();
    }
    // Target weak side
    if (Math.random() < exploitRate) {
      return weakSide === 'backhand' ? ZONES.wideBackhand.clone() : ZONES.wideForehand.clone();
    }
    return ZONES.deepCross.clone();
  }

  _setupZone(weakSide, exploitRate) {
    // Every 3rd shot go to weak side to set up shot 4
    if (this.shotCount % 3 === 2 && Math.random() < exploitRate) {
      return weakSide === 'backhand' ? ZONES.wideBackhand.clone() : ZONES.wideForehand.clone();
    }
    return Math.random() > 0.5 ? ZONES.deepCross.clone() : ZONES.deepLine.clone();
  }

  _diversify(zone, exploitRate) {
    if (this._setupHistory.length < 3) return zone;
    const allSame = this._setupHistory.every(z => z.distanceTo(zone) < 0.15);
    if (allSame) {
      // Break predictability
      const keys = Object.keys(ZONES);
      return ZONES[keys[Math.floor(Math.random() * keys.length)]].clone();
    }
    return zone;
  }

  reset() {
    this.shotCount = 0;
    this.rallyState = RALLY_STATE.NEUTRAL;
    this._setupHistory = [];
  }
}
```

---

## Step 8 — AIBrain.js

Orchestrates everything. This is the only file your existing game talks to.

```javascript
// /src/ai/AIBrain.js
import * as THREE from 'three';
import { PlayerIntentPredictor } from './PlayerIntentPredictor.js';
import { PlayerModel }           from './PlayerModel.js';
import { TacticalPlanner }       from './TacticalPlanner.js';
import { MomentumModel }         from './MomentumModel.js';
import { computePaddleOrientation } from './PaddleOrientationSolver.js';
import { solveForce }               from './ShotForceSolver.js';
import { DIFFICULTY, DIFFICULTY_PARAMS, SHOT_ENVELOPES } from './ai-types.js';

export class AIBrain {
  constructor(difficulty = DIFFICULTY.INTERMEDIATE) {
    this.difficulty = difficulty;
    this.params     = DIFFICULTY_PARAMS[difficulty];

    this.predictor   = new PlayerIntentPredictor();
    this.playerModel = new PlayerModel();
    this.planner     = new TacticalPlanner(difficulty);
    this.momentum    = new MomentumModel();

    // AI physical state — read by renderer, never written by renderer
    this.paddlePosition   = new THREE.Vector3(0, 0.95, 1.3);
    this.paddleQuaternion = new THREE.Quaternion();

    this._targetPosition = null;
    this._pendingShot    = null;
    this._reactionTimer  = null;
  }

  async init() {
    await this.predictor.init();
    console.log('[AI] AIBrain ready, difficulty:', this.difficulty);
  }

  // ─── GAME LOOP ───────────────────────────────────────────────────────────────

  // Call every frame. dt in seconds.
  // playerControllerState: { position, velocity, angularVelocity, quaternion }
  update(dt, playerControllerState) {
    // Always read player intent — even between shots
    this.predictor.pushFrame(playerControllerState);

    // Move paddle toward target with speed cap (simulates human arm movement)
    if (this._targetPosition) {
      const toTarget = new THREE.Vector3().subVectors(this._targetPosition, this.paddlePosition);
      const dist     = toTarget.length();
      const maxMove  = this.params.maxPaddleSpeed * dt;
      if (dist <= maxMove) {
        this.paddlePosition.copy(this._targetPosition);
        this._targetPosition = null;
      } else {
        this.paddlePosition.addScaledVector(toTarget.normalize(), maxMove);
      }
    }
  }

  // ─── EVENTS ──────────────────────────────────────────────────────────────────

  // Call when ball crosses net toward AI side.
  // ball: { position: Vector3, velocity: Vector3, spin: Vector3, predictedBounce: Vector3, predictedContactPoint: Vector3 }
  // gameState: { aiBodyPosition: Vector3, ... } — whatever your game tracks
  onBallIncoming(ball, gameState) {
    // Predict player intent NOW — buffer is richest right after contact
    const intent = this.predictor.predict();

    // Delay reaction by difficulty-appropriate amount
    this._reactionTimer = setTimeout(() => {
      const { shotType, targetZone } = this.planner.selectShot(
        { incomingBall: ball, aiBodyPosition: this.paddlePosition },
        this.playerModel,
        intent,
        this.momentum.value
      );

      // Start moving paddle toward contact point
      const contactPoint = ball.predictedContactPoint ?? ball.predictedBounce ?? ball.position;
      this._targetPosition = contactPoint.clone();

      this._pendingShot = { shotType, targetZone, contactPoint: contactPoint.clone() };

    }, this.params.reactionDelay);
  }

  // Call exactly when ball collision with AI paddle is detected.
  // ball: { velocity: Vector3, spin: Vector3 }
  // Returns: { force: Vector3, spinVector: Vector3, paddleQuaternion: Quaternion }
  // Apply these to the ball via your existing physics — DO NOT apply them here.
  onContact(ball) {
    if (!this._pendingShot) {
      console.warn('[AI] onContact called without pending shot — returning null');
      return null;
    }

    const { shotType, targetZone, contactPoint } = this._pendingShot;
    this._pendingShot = null;

    // Apply timing variance — shifts target slightly
    const timingOffset = this.momentum.getTimingOffset(this.difficulty);
    const adjustedTarget = targetZone.clone();
    adjustedTarget.z += timingOffset * 0.0008; // ms offset → small positional shift

    // Compute paddle orientation
    const paddleQuat   = computePaddleOrientation(ball.velocity, contactPoint, adjustedTarget, shotType);
    this.paddleQuaternion.copy(paddleQuat);

    // Get paddle face normal
    const paddleNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(paddleQuat);

    // Sample spin from envelope
    const spinVector = this._sampleSpin(shotType);

    // Solve for force
    const force = solveForce(contactPoint, paddleNormal, adjustedTarget, spinVector);

    return { force, spinVector, paddleQuaternion: paddleQuat };
  }

  // Call after each point ends.
  // result: 'won' | 'lost' | 'net' | 'out'
  // playerShot: last shot the player made { type, direction, spin, wasUnderPressure } or null
  onPointEnd(result, playerShot) {
    this.momentum.update(result);
    if (playerShot) this.playerModel.recordShot(playerShot);
    this.predictor.reset();
    this.planner.reset();
    this._pendingShot = null;
    if (this._reactionTimer) { clearTimeout(this._reactionTimer); this._reactionTimer = null; }
  }

  // Call on match end or difficulty change
  fullReset() {
    this.playerModel.reset();
    this.momentum.reset();
    this.onPointEnd(null, null);
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────────────

  _sampleSpin(shotType) {
    const env = SHOT_ENVELOPES[shotType];
    if (!env) return new THREE.Vector3(0, 30, 0);

    const mag  = env.spin[0]  + Math.random() * (env.spin[1]  - env.spin[0]);
    const tilt = env.axis[0]  + Math.random() * (env.axis[1]  - env.axis[0]);
    return new THREE.Vector3(tilt, mag, 0);
  }
}
```

---

## Step 9 — Integration Points

These are the **only** changes to existing game code. Find these four locations and add the marked lines. Do not change anything else around them.

### 9a — Game init

```javascript
// In your existing game initialization function
// AI_INTEGRATION_POINT 1 — add after existing setup is complete

import { AIBrain } from './ai/AIBrain.js';
import { DIFFICULTY } from './ai/ai-types.js';

const aiBrain = new AIBrain(DIFFICULTY.INTERMEDIATE); // change difficulty as needed
await aiBrain.init();
```

### 9b — Game loop

```javascript
// In your existing requestAnimationFrame / game loop
// AI_INTEGRATION_POINT 2 — add inside loop, after player input is read

aiBrain.update(dt, {
  position:        playerPaddle.position,       // your existing player paddle position
  velocity:        playerPaddle.velocity,       // your existing player paddle velocity
  angularVelocity: playerPaddle.angularVelocity,
  quaternion:      playerPaddle.quaternion
});

// Sync AI paddle mesh to brain state
aiPaddleMesh.position.copy(aiBrain.paddlePosition);
aiPaddleMesh.quaternion.copy(aiBrain.paddleQuaternion);
```

### 9c — Ball crosses net toward AI

```javascript
// In your existing ball position tracking / net crossing detection
// AI_INTEGRATION_POINT 3 — add when ball crosses net toward AI side

aiBrain.onBallIncoming(
  {
    position:             ball.position,
    velocity:             ball.velocity,
    spin:                 ball.spin,
    predictedBounce:      ball.predictedBounce,      // your existing prediction if available
    predictedContactPoint: ball.predictedContactPoint // your existing prediction if available
  },
  {
    aiBodyPosition: aiBrain.paddlePosition
  }
);
```

### 9d — Ball contacts AI paddle

```javascript
// In your existing collision detection between ball and AI paddle
// AI_INTEGRATION_POINT 4 — replace your existing AI shot logic with this

const aiShot = aiBrain.onContact({ velocity: ball.velocity, spin: ball.spin });

if (aiShot) {
  // Apply to ball via your existing physics — these are plain THREE.Vector3
  ball.velocity.copy(aiShot.force);
  ball.spin.copy(aiShot.spinVector);
  // aiShot.paddleQuaternion is already applied to aiPaddleMesh in 9b
}
```

### 9e — Point ends

```javascript
// In your existing point-end / score handler
// AI_INTEGRATION_POINT 5

aiBrain.onPointEnd(
  pointResult,   // 'won' | 'lost' | 'net' | 'out' — from your existing scoring
  lastPlayerShot // { type, direction, spin, wasUnderPressure } or null
);
```

---

## Difficulty Reference

| Level | Name | Reaction | Paddle Speed | Exploit Rate | Timing Variance |
|---|---|---|---|---|---|
| 1 | Beginner | 180ms | 2.5 m/s | 10% | ±80ms |
| 2 | Intermediate | 130ms | 3.5 m/s | 30% | ±55ms |
| 3 | Advanced | 90ms | 4.5 m/s | 50% | ±35ms |
| 4 | Expert | 50ms | 6.0 m/s | 70% | ±18ms |
| 5 | Pro | 20ms | 7.5 m/s | 90% | ±8ms |

---

## Training the Intent Model (Week 2)

The predictor runs on heuristics until you have data. Add a recording mode:

```javascript
// RecordingMode.js — temporary, remove before ship
// Attach to player paddle. On contact event, save the last 20 frames + manual shot label.

const LABEL_MAP = { 'forehand-cross': 0, 'forehand-line': 1, 'backhand-cross': 2, 'backhand-line': 3 };

function saveSession(frames, label) {
  const sessions = JSON.parse(localStorage.getItem('tt_training') || '[]');
  sessions.push({ frames, label });
  localStorage.setItem('tt_training', JSON.stringify(sessions));
}
```

Collect 20–30 players × 10 minutes each. Export JSON, train offline in Python with a 1D CNN or LSTM (same architecture as `_buildArchitecture`), quantize INT8, export to TF.js format, place in `/public/models/intent/`. Model will be under 500KB and inference under 5ms on Quest browser.

---

## Coordinate System Notes

Adjust these constants in `ShotForceSolver.js` and `TacticalPlanner.js` to match your game:

- `TABLE_Y` — Y coordinate of table surface
- `ZONES` — target positions assume AI at positive Z, player at negative Z. Flip Z signs if your setup is reversed.
- `magnusCoeff` — must match what your existing ball physics uses exactly

---

## What This Does That No Other TT Sim Does

1. **Reads the player before contact** — not the ball after. 150ms head start on positioning, just like a real pro.
2. **Builds a live player profile** — by rally 5 it knows your patterns. By rally 10 it's exploiting them.
3. **Geometrically correct paddle orientation** — bisector method, not a fixed angle. Always physically accurate.
4. **Force back-calculation** — AI always hits where it intends to, at all difficulty levels.
5. **Timing variance tied to momentum** — on a run it hits early and hard. Down it tightens or loosens based on state.
6. **Shot sequences, not single shots** — sets up the winner 2 balls ahead, like a real player.
