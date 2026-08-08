// Procedural ball texture — bakes an equirectangular seam + logo pattern onto
// a 512×256 canvas mapped to the SphereGeometry UV layout. Grayscale on purpose:
// the material's `color` uniform tints it, so the same texture serves both the
// white and orange ITTF ball variants without a re-bake.
//
// Why a texture at all? A plain matte sphere rotating is *invisible* — the
// specular has no highlight to shift, the diffuse looks identical from every
// angle. The seam + logo give the eye something to lock onto and read spin
// direction from, which is the single strongest realism cue for ball motion.

import * as THREE from 'three';
import { renderer } from './sceneSetup.js';

export function createBallSeamTexture() {
  // 1024×512 (2× the naive 512×256). At real 40 mm scale the ball only
  // occupies ~30 pixels across in a Quest headset at typical distance —
  // any texture feature under ~16 source pixels averages into the
  // background under trilinear minification. Bumped resolution + bolder
  // strokes keep the seam and logo legible after downsampling.
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Base off-white. Earlier passes at rgb(250) plus ACES tone mapping
  // clipped the lit side to pure white and read as "glowing" against the
  // paddle/table. 215 leaves enough headroom that lighting adds visible
  // shading rather than pushing the ball into the tone-map knee.
  ctx.fillStyle = 'rgb(215, 215, 215)';
  ctx.fillRect(0, 0, W, H);

  // Mold-seam bands. Two dark stripes flanking the equator (v = 0.5) read
  // as the two halves of a real ITTF ball meeting. 8 px thick + darker
  // gray so they survive mipmap averaging at Quest render size — thin
  // 2 px lines just blur into background at that distance.
  ctx.fillStyle = 'rgb(80, 80, 80)';
  ctx.fillRect(0, Math.round(H * 0.485), W, 8);
  ctx.fillRect(0, Math.round(H * 0.515), W, 8);

  // Generic ITTF-style swoosh logo. Placed off-equator so it can't be
  // mistaken for a seam mark. Two arced strokes suggesting motion —
  // abstract enough to sidestep trademarks, distinctive enough to serve
  // as the spin-legibility anchor players' eyes track. Larger + darker
  // than the naive first pass for the same reason as the seam bands.
  ctx.strokeStyle = 'rgb(110, 110, 110)';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  const cx = W * 0.25;
  const cy = H * 0.30;
  ctx.beginPath();
  ctx.moveTo(cx - 64, cy + 36);
  ctx.quadraticCurveTo(cx, cy - 48, cx + 64, cy + 12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 44, cy + 60);
  ctx.quadraticCurveTo(cx + 8, cy + 8, cx + 52, cy + 44);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  // CanvasTexture defaults to NoColorSpace in modern three.js; under ACES
  // tone mapping this reads washed-out. SRGB matches how the canvas was
  // authored (browser 2D context is sRGB).
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
