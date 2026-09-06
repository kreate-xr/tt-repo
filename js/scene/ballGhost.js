// P16 §3.2 — Mirror-ghost reflection cue. A dim copy of the ball rendered
// mirrored below the table plane, visible only when the ball is close to
// the surface. Supplies the near-bounce depth cue without screen-space
// reflections (SSR is banned in XR — off-screen samples pop as the head
// moves) and without a Reflector render pass (would double the ball-mesh
// draw count and break stereo cheap-outs).
//
// Design decisions:
// - Uses MeshBasicMaterial (unlit). A lit copy would need the lighting rig
//   flipped, which changes as XRLightProbe drives the key — the unlit copy
//   with the ball's own texture + color reads as "the ball's silhouette
//   under the felt", which is what a real dim reflection looks like on a
//   semi-glossy table.
// - Visibility gates on BOTH height (< 0.5 m over table) AND XZ containment
//   in the table rect. The rect gate is the cheap alternative to per-pixel
//   stencil clipping — the ball is only 4 cm across, so the difference
//   between "inside table" and "partly overhanging edge" is a single
//   frame's worth of pixels either side.
// - Renders after the table (renderOrder 2, above the blob's 1) so alpha
//   composites cleanly over the felt. depthWrite off so it doesn't punch
//   through the table's depth on top-down camera angles.

import * as THREE from 'three';

let _ghost = null;
let _tableY = 0;
let _tableBox = null;
let _syncedColor = null;

const GHOST_MAX_HEIGHT = 0.5;   // Hide above this height over table.
const GHOST_OPACITY   = 0.15;

/**
 * Create the ghost. Requires a live ballMesh (for geometry + texture map +
 * initial color) and the table's surface Y + XZ rect (Box3). Call once
 * during scene setup after loadModels resolves.
 */
export function createBallGhost(scene, ballMesh, tableSurfaceY, tableBox) {
  if (_ghost) return _ghost;

  _tableY = tableSurfaceY;
  _tableBox = tableBox;

  // Share the ball's geometry — cheaper than a second SphereGeometry and
  // stays in sync if the ball geometry is ever swapped.
  const geom = ballMesh.geometry;
  const mat = new THREE.MeshBasicMaterial({
    map: ballMesh.material.map,
    color: ballMesh.material.color.clone(),
    transparent: true,
    opacity: GHOST_OPACITY,
    depthWrite: false,
    toneMapped: true,
  });
  _ghost = new THREE.Mesh(geom, mat);
  _ghost.renderOrder = 2;
  _ghost.frustumCulled = false;
  _ghost.visible = false;
  _syncedColor = ballMesh.material.color;
  scene.add(_ghost);
  return _ghost;
}

/**
 * Update per frame after ball position is integrated. Mirrors the ball's Y
 * about the table plane (y_ghost = 2*tableY - y_ball) so the reflection
 * lives an equal distance under the felt. XZ is unchanged.
 */
export function updateBallGhost(ballPos, alpha = 1) {
  if (!_ghost || !_tableBox) return;
  // `alpha` is the ball's retirement fade (see despawnBall) — the reflection
  // goes with the thing it reflects.
  if (alpha <= 0) { _ghost.visible = false; return; }

  const heightOverTable = ballPos.y - _tableY;
  if (heightOverTable < 0 || heightOverTable > GHOST_MAX_HEIGHT) {
    _ghost.visible = false;
    return;
  }
  if (ballPos.x < _tableBox.min.x || ballPos.x > _tableBox.max.x ||
      ballPos.z < _tableBox.min.z || ballPos.z > _tableBox.max.z) {
    _ghost.visible = false;
    return;
  }

  _ghost.position.set(ballPos.x, 2 * _tableY - ballPos.y, ballPos.z);
  // Keep color in sync with any wrist-menu color swap. Cheap — a single
  // Color copy per frame while visible; the ball material's Color object
  // reference does not change on swap (setBallColor mutates in place).
  if (_syncedColor) _ghost.material.color.copy(_syncedColor);
  _ghost.material.opacity = GHOST_OPACITY * alpha;
  _ghost.visible = true;
}

/** Hide (spawn/reset). */
export function resetBallGhost() {
  if (_ghost) _ghost.visible = false;
}
