// Pure two-stage serve solver. Extracted from launchKinematics.js so callers
// outside the scene module graph (e.g. the AI opponent's serve adapter and its
// unit tests) can use it without pulling in scene/models/sceneSetup.

import * as THREE from 'three';
import { GRAVITY, dragBoostFactor, tableRestitution } from '../../physics/constants.js';

// Two-stage serve solver: launch velocity that takes the ball from spawnPos,
// bounces it on the SERVER's own half (P1), then carries it via the natural
// table bounce to the player-side landing target (landingP2). T1 is the
// time-to-own-bounce; T2 (post-bounce flight back to surface) is derived
// from gravity and the speed-dependent table restitution evaluated at the
// actual bounce velocity.
//
// Restitution used to be a caller-passed scalar; it's now looked up
// internally from the table COR curve so soft feeds and hard serves both
// get their correct post-bounce time-of-flight. Caller passes only geometry
// and T1.
//
// Returns { velocity, ownBounce, T2 }. `velocity` is the launch velocity at
// spawn (drag-compensated for leg 1 via the quadratic-drag boost factor).
export function serveBallistic(spawnPos, landingP2, surfaceY, T1, _restitution, out) {
  const o = out || new THREE.Vector3();
  const g = GRAVITY;
  const h0 = spawnPos.y - surfaceY;

  const vy_bounce = -h0 / T1 + 0.5 * g * T1;
  const e = tableRestitution(Math.abs(vy_bounce));
  const vy_after = -e * vy_bounce;
  const T2 = -2 * vy_after / g;

  const alpha = T1 / (T1 + T2);
  const ownBounce = new THREE.Vector3(
    alpha * landingP2.x + (1 - alpha) * spawnPos.x,
    surfaceY,
    alpha * landingP2.z + (1 - alpha) * spawnPos.z,
  );

  o.set(
    (ownBounce.x - spawnPos.x) / T1,
    (surfaceY - spawnPos.y - 0.5 * g * T1 * T1) / T1,
    (ownBounce.z - spawnPos.z) / T1,
  );
  const rangeX = Math.hypot(ownBounce.x - spawnPos.x, ownBounce.z - spawnPos.z);
  o.multiplyScalar(dragBoostFactor(rangeX, T1));

  return { velocity: o, ownBounce, T2 };
}
