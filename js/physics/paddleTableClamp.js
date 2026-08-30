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
//
// Two stages for the PLAYER's paddle (see resolvePaddleTableTilt below):
// a translation bounded by the 1 cm contact-visual agreement budget absorbs
// grazes, then any remaining top-surface penetration is resolved by pitching
// the bat up about the hand — a rotation whose fixed point is the grip, so
// deep dips ride up onto the felt instead of either clipping or detaching.

import * as THREE from 'three';

const _tmpU = new THREE.Vector3();
const _tmpV = new THREE.Vector3();
const _tmpSample = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _worldRight = new THREE.Vector3(1, 0, 0);

// Rim basis: two unit vectors perpendicular to faceNormal, spanning the
// face plane, written into _tmpU/_tmpV. Prefer u ⟂ worldUp so the "θ=0" rim
// sample sits at the paddle's near-horizontal edge — makes the sampling
// stable when the blade is tilted at typical playing angles.
function computeRimBasis(faceNormal) {
  _tmpU.crossVectors(faceNormal, _worldUp);
  if (_tmpU.lengthSq() < 1e-6) _tmpU.crossVectors(faceNormal, _worldRight);
  _tmpU.normalize();
  _tmpV.crossVectors(faceNormal, _tmpU).normalize();
}

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
 * @param {number} [maxPush=Infinity] optional ceiling on the delta's magnitude.
 *   For a PLAYER-held paddle this must be bounded — see the note below.
 * @returns {THREE.Vector3} out
 */
export function resolvePaddleTablePenetration(
  faceCenter, faceNormal, hitRadius, halfThickness, tableBox, out,
  maxPush = Infinity,
) {
  out.set(0, 0, 0);
  if (!tableBox) return out;

  const xmin = tableBox.min.x;
  const xmax = tableBox.max.x;
  const zmin = tableBox.min.z;
  const zmax = tableBox.max.z;
  const yTop = tableBox.max.y + halfThickness + 0.005;

  computeRimBasis(faceNormal);

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

  // Bound the push for a player-held paddle.
  //
  // The delta is applied to paddleAnchor.position, so it translates the bat
  // away from the hand holding it — the exact artifact that got the old
  // translational recoil removed (see xr/paddleRecoil.js), and it was live here
  // unbounded: the push equals penetration depth, so swinging a hand down
  // through the felt could shove the rendered paddle a full penetration-depth
  // off the grip. A held object cannot translate relative to the hand, and the
  // eye reads that as the bat coming loose long before it reads it as
  // collision response.
  //
  // Clamping trades one artifact for a strictly milder one: past the bound the
  // blade visibly intersects the table instead of detaching. That is the right
  // trade — if the player has driven their hand into the table, the honest
  // render is a paddle inside the table, not a paddle flying off their wrist.
  // Grazing contacts (the common case) are well under the bound and still
  // resolve fully.
  //
  // AI and remote paddles pass no bound: nobody's hand is holding them, so
  // there is nothing to detach from and clean non-clipping is the better look.
  if (maxPush !== Infinity) {
    const len = Math.hypot(out.x, out.y, out.z);
    if (len > maxPush && len > 0) {
      const k = maxPush / len;
      out.x *= k; out.y *= k; out.z *= k;
    }
  }
  return out;
}

const _tiltFace = new THREE.Vector3();
const _tiltNormal = new THREE.Vector3();
const _tiltAxis = new THREE.Vector3();
const _tiltStepQ = new THREE.Quaternion();

// Residual penetration below this is invisible (0.5 mm) — stop iterating.
const _TILT_EPS = 5e-4;
// Linearized steps undershoot as the blade rotates; a handful of refinement
// passes converges to sub-mm for every reachable pose.
const _TILT_MAX_ITERS = 10;
// Per-step ceiling so one linearized step never overshoots wildly when the
// deepest sample sits close to the pivot (tiny lift rate → huge d/ρ).
const _TILT_MAX_STEP = 0.3;

/**
 * Resolve REMAINING top-surface penetration by pitching the paddle up about
 * the grip point, instead of translating it off the hand.
 *
 * Runs AFTER the bounded translation of resolvePaddleTablePenetration: the
 * 1 cm budget silently absorbs grazes with zero rotation, and this solver
 * handles what's left of a deeper dip. The pivot is the hand, so the hand is
 * a fixed point of the rotation — same invariant as the impact recoil
 * (xr/paddleRecoil.js): nothing ever translates out of the grip. Visually the
 * blade rides up onto the felt the way a real bat pivots in a loosening grip
 * when pressed into the table.
 *
 * The rotation axis is FIXED for the whole solve: the horizontal axis
 * perpendicular to the pivot→faceCenter direction (a pure "pitch up about
 * the wrist"). A per-sample axis would jump direction as the deepest rim
 * sample flips between neighbors frame to frame; a fixed axis makes the
 * output a continuous function of the input pose, so the clamp can't jitter.
 *
 * Scope: only samples whose SHORTEST exit is the top are lifted — same
 * per-sample axis policy as the translation clamp. A hand driven fully under
 * the table (shortest exit sideways) or past `maxTilt` still renders inside
 * the table; that stays the honest render for an unreachable pose.
 *
 * Physics note: ball.js finite-differences paddle velocity from the RAW pose
 * (getRawPaddlePose bypasses this clamp), so the clamp rotation changes where
 * the blade collides but can never inject phantom swing/spin into an impact.
 *
 * @param {THREE.Vector3} pivot world-space grip/hand position (read only)
 * @param {THREE.Vector3} faceCenter world-space face center AFTER the
 *   translation clamp's delta (read only)
 * @param {THREE.Vector3} faceNormal world-space face normal, unit (read only)
 * @param {number} hitRadius paddle disc radius (m)
 * @param {number} halfThickness paddle blade half-thickness (m)
 * @param {THREE.Box3|null} tableBox world-space play-surface bounds
 * @param {THREE.Quaternion} outQuat receiver — identity when no tilt applies
 * @param {number} [maxTilt=π/2] ceiling on the total pitch (rad)
 * @returns {number} total applied angle in radians (0 = no tilt)
 */
export function resolvePaddleTableTilt(
  pivot, faceCenter, faceNormal, hitRadius, halfThickness, tableBox,
  outQuat, maxTilt = Math.PI / 2,
) {
  outQuat.identity();
  if (!tableBox) return 0;

  const xmin = tableBox.min.x;
  const xmax = tableBox.max.x;
  const zmin = tableBox.min.z;
  const zmax = tableBox.max.z;
  const yTop = tableBox.max.y + halfThickness + 0.005;

  // Pitch axis = (pivot→face) × up, i.e. horizontal and perpendicular to the
  // bat's horizontal direction. +angle about it lifts everything horizontally
  // forward of the pivot; the whole blade is forward of the hand, so the
  // whole disc rises. Degenerate when the bat hangs exactly straight down
  // from the fist — no pitch can lift it, and no real stroke gets there.
  _tiltAxis.set(
    -(faceCenter.z - pivot.z),
    0,
    faceCenter.x - pivot.x,
  );
  const hFace = _tiltAxis.length();
  if (hFace < 1e-3) return 0;
  _tiltAxis.multiplyScalar(1 / hFace);

  _tiltFace.copy(faceCenter);
  _tiltNormal.copy(faceNormal);

  let total = 0;
  for (let iter = 0; iter < _TILT_MAX_ITERS && total < maxTilt; iter++) {
    computeRimBasis(_tiltNormal);

    // Deepest top-exit sample and its lift rate ρ = d(sample.y)/dθ. For the
    // fixed axis above, ρ reduces to the sample's horizontal offset from the
    // pivot projected onto the bat's horizontal direction (see the (a×r).y
    // identity in tests/paddleTableClamp.test.js).
    let worstDepth = 0;
    let worstRho = 0;
    const N = _RIM_N + 1;
    for (let i = 0; i < N; i++) {
      if (i === 0) {
        _tmpSample.copy(_tiltFace);
      } else {
        const j = i - 1;
        _tmpSample.copy(_tiltFace)
          .addScaledVector(_tmpU, _RIM_COS[j] * hitRadius)
          .addScaledVector(_tmpV, _RIM_SIN[j] * hitRadius);
      }

      if (_tmpSample.y >= yTop) continue;
      if (_tmpSample.x < xmin || _tmpSample.x > xmax) continue;
      if (_tmpSample.z < zmin || _tmpSample.z > zmax) continue;

      const dTop = yTop - _tmpSample.y;
      // Top must be the shortest exit — side-exit penetration is not this
      // solver's business (matches the translation clamp's axis choice).
      if (_tmpSample.x - xmin < dTop || xmax - _tmpSample.x < dTop) continue;
      if (_tmpSample.z - zmin < dTop || zmax - _tmpSample.z < dTop) continue;

      if (dTop > worstDepth) {
        worstDepth = dTop;
        worstRho = _tiltAxis.z * (_tmpSample.x - pivot.x)
                 - _tiltAxis.x * (_tmpSample.z - pivot.z);
      }
    }

    if (worstDepth <= _TILT_EPS) break;
    // The deepest sample sits at/behind the pivot's vertical plane — pitching
    // can't lift it. Leave the residual as a clip rather than spinning.
    if (worstRho <= 1e-4) break;

    const step = Math.min(worstDepth / worstRho, _TILT_MAX_STEP, maxTilt - total);
    _tiltStepQ.setFromAxisAngle(_tiltAxis, step);
    _tiltFace.sub(pivot).applyQuaternion(_tiltStepQ).add(pivot);
    _tiltNormal.applyQuaternion(_tiltStepQ);
    total += step;
  }

  if (total <= 0) return 0;
  outQuat.setFromAxisAngle(_tiltAxis, total);
  return total;
}
