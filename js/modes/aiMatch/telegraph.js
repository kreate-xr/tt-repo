// Telegraph — derives the visible cues that reveal the AI's incoming shot
// type to the player ~150ms before contact. Spec §step_5_execute_with_telegraph
// + §telegraph_design.
//
// Why telegraph at all? Table tennis is read-and-react. An AI that hides
// shot type until contact removes the entire learning loop — players plateau
// and quit within 20 minutes. More telegraph = better game. (Counterintuitive
// but documented in the spec's why_telegraph rationale.)
//
// What this module exposes:
//   - SHOT_TYPES enum (the only six allowed per spec)
//   - shotTypeFromTarget(speed, spin)   — derives shot type from the decision
//                                          layer's target tuple
//   - FACE_Y_BY_SHOT_TYPE              — the Y component of the world-space
//                                          face normal that visually telegraphs
//                                          the shot (closed vs open vs vertical)
//   - faceNormalForShot(...)           — composes XZ direction toward target +
//                                          Y from shot type into a normalised
//                                          world-space face normal
//   - WINDUP_DEPTH_M_BY_POWER          — meters the paddle pulls back per tier
//   - powerTierForSpeed(speed)         — soft/medium/power
//   - windupPositionForShot(...)       — world-space pull-back point
//
// Coordinate notes: target (speed, spin) comes from the decision-layer
// engine in spec coords; the engine doesn't care about world frames. The
// faceNormal output IS world frame because the host's paddle collision
// reads world-space face normal directly.

import * as THREE from 'three';

export const SHOT_TYPES = Object.freeze({
  TOPSPIN_DRIVE: 'topspin_drive',
  SLICE:         'slice',
  BLOCK:         'block',
  LOOP:          'loop',
  PUSH:          'push',
  SMASH:         'smash',
  CHOP:          'chop',
  DROP_SHOT:     'drop_shot',
  LOB:           'lob',
  FLIP:          'flip',
});

// Speed/spin tier boundaries used by the shot-type lookup. Aligned with the
// intermediate engine's speed band ([5-8] m/s) so a "medium" decision-layer
// target translates to a "medium" telegraph tier without surprises.
// Speed buckets for the spec's shot_type_lookup_table (shotTypeFromTarget).
// These belong to that lookup and are pinned to it — do NOT retune them for
// ball-speed changes; the table's rows are defined against these numbers.
const SPEED_LOW = 5.0;     // < SPEED_LOW = low-speed row
const SPEED_MEDIUM = 8.0;  // < SPEED_MEDIUM = mid-speed row, >= = high-speed row

// Separate thresholds for SWING POWER (windup depth + telegraph lead).
// These used to share SPEED_LOW/SPEED_MEDIUM with the lookup table above,
// which is a different concern that happened to want the same numbers.
// Rescaled for the international ladder: the old 5.0/8.0 split was calibrated
// when the fastest shot in the game was 13.5 m/s, and against international
// profiles (loop 13, drive 16, smash 22) it classified nearly every ball as
// "power" so the tiering stopped discriminating.
//
// Current split lands as: push/drop = soft, chop/block/slice/flip = medium,
// loop/drive/smash = power. Beginner's damped strokes all fall in
// soft/medium, which is correct — a beginner never plays a power shot.
const POWER_SPEED_LOW = 6.0;
const POWER_SPEED_MEDIUM = 10.0;
const SPIN_LOW_ABS = 8.0;
const SPIN_HIGH_ABS = 20.0;

// Spec §telegraph_design.paddle_angle_per_shot_type_relative_to_neutral_face_normal.
// Negative Y = face closed (toward ball, generates topspin/loop).
// Positive Y = face open  (away from ball, generates slice/push backspin).
// ≈0  = vertical face (block/smash). Smash differs from block in swing path,
// not in face angle — Phase 3 leaves swing-path styling to follow.
export const FACE_Y_BY_SHOT_TYPE = Object.freeze({
  [SHOT_TYPES.TOPSPIN_DRIVE]: -0.34,
  [SHOT_TYPES.SLICE]:          0.34,
  [SHOT_TYPES.BLOCK]:          0.00,
  [SHOT_TYPES.LOOP]:          -0.17,
  [SHOT_TYPES.PUSH]:           0.17,
  [SHOT_TYPES.SMASH]:          0.00,
  // Chop — extreme open face (defender scoops UNDER a heavy loop). Bigger
  // than slice's +0.34 to visually distinguish "defender's chop" from
  // "attacker's slice" — the chop windup swing is up-and-back, face very
  // open, so this reads as "he's about to load heavy backspin."
  [SHOT_TYPES.CHOP]:           0.45,
  // Drop shot — face slightly open (light backspin) but paddle is barely
  // moving forward; telegraphed by the SMALL windup, not the face angle.
  [SHOT_TYPES.DROP_SHOT]:      0.12,
  // Lob — face open moderately, ball tossed high. Similar to push but the
  // swing path (below) is upward, producing the arc.
  [SHOT_TYPES.LOB]:            0.25,
  // Flip — face slightly closed like a mini-drive, with a very short
  // wrist-driven windup. Reads as "he's attacking the short ball."
  [SHOT_TYPES.FLIP]:          -0.20,
});

// Spec §telegraph_design.windup_depth_mapping — midpoint of each documented
// range. Picking midpoints (not min/max) keeps the depth deterministic given
// shot type; Phase 5 (imperfection tuning) can add jitter here if testers
// report the windup looks too uniform.
export const WINDUP_DEPTH_M_BY_POWER = Object.freeze({
  soft:   0.20,   // spec range 0.15-0.25
  medium: 0.38,   // spec range 0.30-0.45
  power:  0.85,   // was 0.60 (spec range 0.50-0.70)
});

// How long before contact the AI commits to its visible swing, per power
// tier. THIS IS A PLAYABILITY MECHANIC, not a cosmetic one.
//
// An international-pace ball covers the ~2.5m to the player in 130-180ms,
// which is at or below human reaction time. Real players return those shots
// by reading the opponent's BACKSWING, not the ball — the decision is made
// before contact. Reproduce that and the tier is hard; omit it and the tier
// is simply impossible, which is not the same thing.
//
// The flat 150ms this replaces was fine when the fastest ball was 13.5 m/s
// and took ~250ms to arrive. Power shots now need the windup visible far
// enough ahead that a human can start moving before the ball is struck.
//
// Must stay below COMMIT_LOCK_BEFORE_CONTACT_MS — the FSM enters COMMITTED
// before SWINGING, so a longer telegraph than the commit lock would invert
// those states. That constant lives here rather than in aiFSM.js so the two
// timings sit together and the invariant is unit-testable: aiFSM.js imports
// the whole scene graph, which jest can't transform.
export const COMMIT_LOCK_BEFORE_CONTACT_MS = 400;

export const TELEGRAPH_LEAD_MS_BY_POWER = Object.freeze({
  soft:   150,
  medium: 250,
  power:  350,
});

// Telegraph lead for a given target ball speed.
export function telegraphLeadMsForSpeed(speedMps) {
  return TELEGRAPH_LEAD_MS_BY_POWER[powerTierForSpeed(speedMps)];
}

export function powerTierForSpeed(speedMps) {
  if (speedMps < POWER_SPEED_LOW) return 'soft';
  if (speedMps < POWER_SPEED_MEDIUM) return 'medium';
  return 'power';
}

// Pro-only "disguised serve" hook (spec §ai_worker_design.engines.pro):
// paddle telegraph implies one spin, late wrist rotation applies another.
// Implemented as a sign-flip on target_spin BEFORE looking up the shot type.
// The visible face Y during early SWINGING corresponds to this disguised
// type; the FSM switches to the real shotType in the last third of the
// telegraph window, simulating the late wrist snap. Returns null when the
// real spin is 0 (no signed disguise possible) — the caller should fall
// back to the actual shotType in that case.
export function disguisedShotTypeFor(realSpeed, realSpin) {
  if (realSpin === 0) return null;
  return shotTypeFromTarget(realSpeed, -realSpin);
}

// Spec §telegraph_design.shot_type_lookup_table. Negative spin always maps
// to SLICE regardless of speed (per the "any_speed_negative_spin" row).
// Positive-spin rows are bucketed by speed × |spin|.
export function shotTypeFromTarget(targetSpeed, targetSpin) {
  if (targetSpin < 0) return SHOT_TYPES.SLICE;
  const absSpin = Math.abs(targetSpin);
  const lowSpin  = absSpin < SPIN_LOW_ABS;
  const highSpin = absSpin >= SPIN_HIGH_ABS;

  if (targetSpeed < SPEED_LOW) {
    // Spec row: low_speed_low_spin → "block or push". Pick BLOCK as the
    // default; PUSH would only differ in face Y (open vs vertical), and
    // BLOCK keeps the face vertical which is the safer fallback for any
    // shot the decision layer didn't deliberately mark as a touch shot.
    return SHOT_TYPES.BLOCK;
  }
  if (targetSpeed < SPEED_MEDIUM) {
    // medium_speed_low_spin → block; medium_speed_high_topspin → topspin_drive.
    // Mid-spin between low and high falls back to topspin_drive (the "default
    // rally shot" interpretation of mid-speed mid-spin returns).
    if (lowSpin) return SHOT_TYPES.BLOCK;
    return SHOT_TYPES.TOPSPIN_DRIVE;
  }
  // High speed
  if (lowSpin) return SHOT_TYPES.SMASH;
  if (highSpin) return SHOT_TYPES.LOOP;
  // mid-spin high-speed isn't in the spec table — default to LOOP (closer to
  // high_topspin than to low_spin smash).
  return SHOT_TYPES.LOOP;
}

// Compose a world-space face normal:
//   XZ component points from paddle toward the target world position
//   Y component is the telegraph value per shot type
// out is mutated and returned. paddleWorldPos / targetWorldPos must be
// THREE.Vector3.
export function faceNormalForShot(shotType, paddleWorldPos, targetWorldPos, out) {
  const dx = targetWorldPos.x - paddleWorldPos.x;
  const dz = targetWorldPos.z - paddleWorldPos.z;
  const horizLen = Math.hypot(dx, dz);
  const inv = horizLen > 1e-6 ? 1 / horizLen : 0;
  const faceY = FACE_Y_BY_SHOT_TYPE[shotType] ?? 0;
  out.set(dx * inv, faceY, dz * inv);
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  return out.normalize();
}

// Compute the world-space windup pull-back point: interception + face *
// (-windup depth). The paddle drives to this point briefly during the swing
// to produce a visible "wind up and strike" arc.
export function windupPositionForShot(shotType, targetSpeed, interceptionWorldPos, faceNormal, out) {
  const tier = powerTierForSpeed(targetSpeed);
  const depth = WINDUP_DEPTH_M_BY_POWER[tier] ?? WINDUP_DEPTH_M_BY_POWER.medium;
  out.copy(interceptionWorldPos).addScaledVector(faceNormal, -depth);
  return out;
}

// Convenience: convert decision-layer target (spec coords on player side)
// to a world-space target position. Caller supplies the table's centre; we
// pick a target height slightly above table — Phase 3 doesn't try to predict
// exact landing Y (the host's physics gives the ball its trajectory once
// the impulse is applied at AI contact).
//
// BOTH axes are table-local. Z always was. X was not: it was written
// straight out as a world coordinate, which is only correct while the
// table's centre line happens to sit on x = 0. Table.glb's does not — its
// play surface runs -0.8302..0.6841, centred on x ≈ -0.073 — so every
// engine envelope expressed about zero (intermediate's ±0.7625 landing
// clamp, tacticalZones' ±0.66 corners, pro's tighter court) was displaced
// ~7 cm: it reached past the right side line into balls that could only go
// out, and never used the outer strip of the left. The engines' numbers are
// right; the frame they were resolved in was not.
export function specTargetToWorld(targetX, targetZ, tableCenterX, tableCenterZ, tableSurfaceY, out) {
  const _DEFAULT_Y_ABOVE_TABLE = 0.10;
  out.set(tableCenterX + targetX, tableSurfaceY + _DEFAULT_Y_ABOVE_TABLE, tableCenterZ + targetZ);
  return out;
}

// Re-export a scratch vector type. Callers can pre-allocate to keep the
// hot path allocation-free. Pure convenience.
export const tmpVec3 = () => new THREE.Vector3();
