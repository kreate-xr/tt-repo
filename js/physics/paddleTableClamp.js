// Paddle-vs-table penetration resolution.
//
// The paddle is a kinematic follower of the tracked controller (player) or a
// scripted trajectory (AI). Nothing in rigid-body physics stops it from
// dipping into the table. The old fix was a single-point Y clamp on the face
// center — which lets the disc rim clip through when the blade is tilted,
// and did nothing about horizontal swings into the table's side.
//
// This helper treats the table as a semi-infinite AABB (XZ footprint of the
// play surface, extending downward forever) and samples the paddle disc rim
// plus the face center against it. Each penetrating sample picks its shortest
// exit axis; per-axis pushes are aggregated so a paddle straddling a corner
// gets lifted onto the top AND pushed off the side in one delta.

import * as THREE from 'three';

const _tmpU = new THREE.Vector3();
const _tmpV = new THREE.Vector3();
const _tmpSample = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _worldRight = new THREE.Vector3(1, 0, 0);

// 8 evenly-spaced rim samples. More would be more accurate at very shallow
// tilts, but 8 catches every real clipping case in play and keeps the per-
// frame cost trivial (a couple of dot products per sample).
const _RIM_N = 8;
const _RIM_COS = new Float32Array(_RIM_N);
const _RIM_SIN = new Float32Array(_RIM_N);
for (let i = 0; i < _RIM_N; i++) {
  const th = (i / _RIM_N) * Math.PI * 2;
  _RIM_COS[i] = Math.cos(th);
  _RIM_SIN[i] = Math.sin(th);
}

/**
 * Compute the world-space delta needed to push a paddle disc out of the
 * table's collision volume. Adds nothing if the paddle isn't intersecting.
 *
 * The collision volume is `[xmin,xmax] × (-∞, tableTop] × [zmin,zmax]` where
 * xmin/xmax/zmin/zmax come from tableBox and tableTop is `tableBox.max.y`
 * padded by `halfThickness + 0.005` so the blade's own thickness is respected.
 *
 * Sampling: face center + 8 points on the rim. For each sample inside the
 * volume, the shortest exit axis is chosen (top / ±x / ±z). Per-axis pushes
 * are aggregated (max magnitude per direction), then combined into a single
 * delta. Since the paddle disc is much smaller than the table width, samples
 * won't disagree about the ±X or ±Z direction in practice.
 *
 * @param {THREE.Vector3} faceCenter world-space paddle face center (read only)
 * @param {THREE.Vector3} faceNormal world-space paddle face normal, unit (read only)
 * @param {number} hitRadius paddle disc radius (m)
 * @param {number} halfThickness paddle blade half-thickness (m); acts as a
 *   safety margin above the felt so the clamp fires just before the blade
 *   would visibly touch, not after.
 * @param {THREE.Box3|null} tableBox world-space play-surface bounds (max.y is
 *   the felt top). Delta is zero if null.
 * @param {THREE.Vector3} out receiver — zeroed then filled with the delta.
 * @returns {THREE.Vector3} out
 */
export function resolvePaddleTablePenetration(
  faceCenter, faceNormal, hitRadius, halfThickness, tableBox, out,
) {
  out.set(0, 0, 0);
  if (!tableBox) return out;

  const xmin = tableBox.min.x;
  const xmax = tableBox.max.x;
  const zmin = tableBox.min.z;
  const zmax = tableBox.max.z;
  const yTop = tableBox.max.y + halfThickness + 0.005;

  // Rim basis: two unit vectors perpendicular to faceNormal, spanning the
  // face plane. Prefer u ⟂ worldUp so the "θ=0" rim sample sits at the
  // paddle's near-horizontal edge — makes the sampling stable when the
  // blade is tilted at typical playing angles.
  _tmpU.crossVectors(faceNormal, _worldUp);
  if (_tmpU.lengthSq() < 1e-6) _tmpU.crossVectors(faceNormal, _worldRight);
  _tmpU.normalize();
  _tmpV.crossVectors(faceNormal, _tmpU).normalize();

  // Per-axis aggregated pushes. Y only goes positive (semi-infinite volume
  // has no bottom to push down through); X and Z can go either direction
  // depending on which side of the footprint the sample sits.
  let pushYP = 0;
  let pushXN = 0, pushXP = 0;
  let pushZN = 0, pushZP = 0;

  const N = _RIM_N + 1;
  for (let i = 0; i < N; i++) {
    if (i === 0) {
      _tmpSample.copy(faceCenter);
    } else {
      const j = i - 1;
      _tmpSample.copy(faceCenter)
        .addScaledVector(_tmpU, _RIM_COS[j] * hitRadius)
        .addScaledVector(_tmpV, _RIM_SIN[j] * hitRadius);
    }

    if (_tmpSample.y >= yTop) continue;
    if (_tmpSample.x < xmin || _tmpSample.x > xmax) continue;
    if (_tmpSample.z < zmin || _tmpSample.z > zmax) continue;

    const dTop = yTop - _tmpSample.y;
    const dL   = _tmpSample.x - xmin;
    const dR   = xmax - _tmpSample.x;
    const dF   = _tmpSample.z - zmin;
    const dN   = zmax - _tmpSample.z;

    // Shortest exit wins. Ties go to the top so the paddle prefers resting
    // on the felt rather than skimming off a side.
    let bestAxis = 0; // 0=y+, 1=x-, 2=x+, 3=z-, 4=z+
    let bestDepth = dTop;
    if (dL < bestDepth) { bestAxis = 1; bestDepth = dL; }
    if (dR < bestDepth) { bestAxis = 2; bestDepth = dR; }
    if (dF < bestDepth) { bestAxis = 3; bestDepth = dF; }
    if (dN < bestDepth) { bestAxis = 4; bestDepth = dN; }

    switch (bestAxis) {
      case 0: if (dTop > pushYP) pushYP = dTop; break;
      case 1: if (dL   > pushXN) pushXN = dL;   break;
      case 2: if (dR   > pushXP) pushXP = dR;   break;
      case 3: if (dF   > pushZN) pushZN = dF;   break;
      case 4: if (dN   > pushZP) pushZP = dN;   break;
    }
  }

  out.x = pushXP - pushXN;
  out.y = pushYP;
  out.z = pushZP - pushZN;
  return out;
}
