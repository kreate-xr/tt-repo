// Blob shadow — a soft radial-gradient quad on the table surface that follows
// the ball's XZ position and fades/shrinks with its height above the table.
//
// Why this exists (and why it's not optional): depth perception of a 4 cm
// object flying at you is the hardest perceptual task in the game. The
// strongest depth cue humans use for it is the *contact shadow* on the ground
// plane. A shadow-map projection at 2.7 m from a 40 mm caster flickers as the
// map resolution can't resolve the ball edge; a cheap gradient quad that
// shrinks and darkens as the ball descends is more reliable at this object
// size. We keep the real cast shadow too (rim/silhouette on nearby surfaces)
// — but this blob is the load-bearing depth cue.

import * as THREE from 'three';

const BLOB_SIZE = 0.06;
// Peak opacity when the ball is on the table surface. Bright enough to
// serve as a strong depth cue against the felt.
const MAX_OPACITY = 0.55;
// Minimum opacity floor while the ball is above the table. A shrinking
// shadow that fades completely leaves the mid-air ball with no depth
// reference at the exact moment depth judgment matters most; we keep a
// faint shadow visible across the whole trajectory.
const MIN_OPACITY = 0.10;
// Rate at which opacity falls off with height (per metre). Matches the
// spec's "0.35 per metre" recommendation, softened to 0.30 so the
// shadow stays legible for a normal ball arc (up to ~1.5 m over table).
const OPACITY_FALLOFF = 0.30;
// Real shadows GROW with height (penumbra widens as the caster rises).
// This matches physical intuition and is a stronger depth cue than a
// shrinking shadow.
const GROW_PER_METRE = 1.5;
const MAX_SCALE = 3.0;

let _blob = null;
let _tableY = 0;
let _tableBox = null;

export function createBallShadow(scene, tableSurfaceY, tableBox = null) {
  if (_blob) return _blob;
  _tableY = tableSurfaceY;
  _tableBox = tableBox;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, 'rgba(0, 0, 0, 1)');
  g.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;

  // NormalBlending, NOT AdditiveBlending — additive lightens the table
  // (the opposite of a shadow). depthWrite off so the blob doesn't punch
  // through geometry stacked above it. renderOrder = 1 pushes it after the
  // opaque table felt so alpha composites correctly.
  const mat = new THREE.MeshBasicMaterial({
    map,
    color: 0x000000,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    opacity: MAX_OPACITY,
  });

  _blob = new THREE.Mesh(new THREE.PlaneGeometry(BLOB_SIZE, BLOB_SIZE), mat);
  _blob.rotation.x = -Math.PI / 2;   // face up, lying flat on the table
  _blob.renderOrder = 1;
  _blob.frustumCulled = false;
  _blob.visible = false;
  scene.add(_blob);
  return _blob;
}

/**
 * Position the blob directly under the ball's world XZ, at 1 mm above the
 * table surface. GROW and fade with height — matches how real contact
 * shadows behave (penumbra widens as caster rises) and gives a continuous
 * depth reference across the full trajectory. Call once per physics/render
 * tick, AFTER the ball's position for this frame has been integrated.
 */
export function updateBallShadow(ballPos) {
  if (!_blob) return;

  // Below the table: hide. Being *below* usually means the ball has passed
  // the edge and dropped — no shadow makes sense.
  if (ballPos.y < _tableY - 0.01) {
    _blob.visible = false;
    return;
  }

  // Off the table's XZ footprint: hide. The blob lives at table-surface
  // height, so past the edge there is no surface under the ball and the
  // quad would hang in mid-air (same rect gate ballGhost.js uses).
  if (_tableBox &&
      (ballPos.x < _tableBox.min.x || ballPos.x > _tableBox.max.x ||
       ballPos.z < _tableBox.min.z || ballPos.z > _tableBox.max.z)) {
    _blob.visible = false;
    return;
  }

  const h = Math.max(0, ballPos.y - _tableY);
  const opacity = THREE.MathUtils.clamp(
    MAX_OPACITY - h * OPACITY_FALLOFF,
    MIN_OPACITY,
    MAX_OPACITY,
  );
  const scale = Math.min(1 + h * GROW_PER_METRE, MAX_SCALE);

  _blob.position.set(ballPos.x, _tableY + 0.001, ballPos.z);
  _blob.material.opacity = opacity;
  _blob.scale.setScalar(scale);
  _blob.visible = true;
}

/**
 * Hide the blob. Called from spawnBallAt so a fresh spawn doesn't briefly
 * show a shadow at the previous ball's rest position.
 */
export function resetBallShadow() {
  if (_blob) _blob.visible = false;
}
