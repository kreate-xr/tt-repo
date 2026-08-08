// Pure ballistic helpers for the ball machine and the trajectory practice drill.
// Computes spawn pose, target landing, and the velocity that links them given a
// flight time. Reused by Feeder and the trajectory previewer so the dotted line
// matches the actual launch.

import * as THREE from 'three';
import { tableBox, tableSurfaceY } from '../../scene/models.js';
import { GRAVITY, dragBoostFactor } from '../../physics/constants.js';
export { serveBallistic } from './serveBallistics.js';

export function getSpawnPos(out) {
  const o = out || new THREE.Vector3();
  if (!tableBox) return o.set(0, 1, 0);
  const x = (tableBox.min.x + tableBox.max.x) / 2;
  const y = tableSurfaceY + 0.25;
  const z = tableBox.min.z + 0.05;
  return o.set(x, y, z);
}

export function getLandingPos(targetX, out) {
  const o = out || new THREE.Vector3();
  if (!tableBox) return o.set(0, 0, 0);
  const centerZ = (tableBox.min.z + tableBox.max.z) / 2;
  const playerHalfDepth = (tableBox.max.z - centerZ) * 0.55;
  const z = centerZ + playerHalfDepth;
  return o.set(targetX, tableSurfaceY, z);
}

// Velocity that takes a ball from spawnPos to landingPos in flightTime seconds
// under constant gravity AND the live quadratic air drag. Under drag the
// horizontal range from initial speed v₀ over time T is (1/k)·ln(1 + k·v₀·T),
// so we boost the drag-free launch speed X/T by (e^(k·X) − 1)/(k·X) — see
// dragBoostFactor in constants.js. Approximation: applies the horizontal
// boost to all three components (couples vertical drag to horizontal speed),
// which is close-enough for short low-arc flights and keeps the launcher a
// closed-form solver. Returns a fresh THREE.Vector3 unless `out` is provided.
export function ballisticVelocity(spawnPos, landingPos, flightTime, out) {
  const o = out || new THREE.Vector3();
  const T = flightTime;
  o.set(
    (landingPos.x - spawnPos.x) / T,
    (landingPos.y - spawnPos.y - 0.5 * GRAVITY * T * T) / T,
    (landingPos.z - spawnPos.z) / T,
  );
  const rangeX = Math.hypot(landingPos.x - spawnPos.x, landingPos.z - spawnPos.z);
  o.multiplyScalar(dragBoostFactor(rangeX, T));
  return o;
}

