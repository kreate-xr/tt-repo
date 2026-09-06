// Wall finish for the Focus Room — a single vertical gradient painted onto a
// canvas and handed back as one texture.
//
// The walls are BLACK (ROOM.WALL_COLOR): they are the backdrop the
// sideWallArt.js player graphic is printed on. That makes most wall treatment
// pointless — an earlier version of this file drew acoustic-panel joints, and
// on a black ground they inverted into pale glowing lines, because anything
// painted over black can only lift it. What is left is the one thing that
// still belongs on a black wall:
//
// FLOOR BOUNCE. A warm gradient over the bottom WALL_PANEL.BOUNCE_H_M, tinted
// toward the wood floor. In a real hall the floor throws light back up the
// wall, and without it the wood visibly ends in midair at the skirting. No
// light can produce this: a HemisphereLight's contribution depends only on the
// normal, so it gives a flat wall exactly one value everywhere, and no light
// here can be scoped to this room anyway (sceneSetup.js LIGHTING LAYERS). So
// it is painted. Set BOUNCE_ALPHA to 0 for absolutely black walls.
//
// The result is horizontally UNIFORM — a vertical gradient and nothing else.
// Hence PX_W of 8 rather than hundreds, and hence no per-face UV rescale on
// the shell: every wall samples the same column whatever its length. Anything
// with horizontal structure would need both of those back.
//
// V DOES NOT TILE. wrapT is ClampToEdge and the shell's v stays 0..1, so the
// bounce spans the wall height exactly once instead of reappearing as a band
// partway up.

import * as THREE from 'three';
import { renderer } from './sceneSetup.js';
import { ROOM, WALL_PANEL } from './focusRoomSpec.js';
import { tint, rgba, paintOffscreen } from './canvasPaint.js';

// Canvas row 0 is the TOP of the wall: three uploads with flipY on by
// default, so image row 0 becomes v=1, and BoxGeometry puts v=1 at the
// ceiling. The canvas therefore reads the same way up as the wall does.
function paintWall(ctx, w, h) {
  const pxPerM = h / ROOM.HEIGHT_Y;

  ctx.fillStyle = tint(ROOM.WALL_COLOR);
  ctx.fillRect(0, 0, w, h);

  // Floor bounce, strongest at the skirting and gone by BOUNCE_H_M.
  const bouncePx = WALL_PANEL.BOUNCE_H_M * pxPerM;
  const bounce = ctx.createLinearGradient(0, h, 0, h - bouncePx);
  bounce.addColorStop(0, rgba(WALL_PANEL.BOUNCE_COLOR, WALL_PANEL.BOUNCE_ALPHA));
  bounce.addColorStop(1, rgba(WALL_PANEL.BOUNCE_COLOR, 0));
  ctx.fillStyle = bounce;
  ctx.fillRect(0, h - bouncePx, w, bouncePx);

  // Skirting last, over the bounce: a base rail grounds the wall where it
  // meets the floor instead of the two just abutting.
  const skirtPx = WALL_PANEL.SKIRT_H_M * pxPerM;
  ctx.fillStyle = tint(WALL_PANEL.SKIRT_COLOR);
  ctx.fillRect(0, h - skirtPx, w, skirtPx);
}

// Painted once per page and cached; each caller still gets its OWN texture
// off it, because the Focus Room is rebuilt per session and disposes what it
// owns (same reasoning as brandLogo.js / woodFloor.js).
let tileCanvas;
let tileFailed = false;

function getTileCanvas() {
  if (tileCanvas) return tileCanvas;
  if (tileFailed) return null;
  tileCanvas = paintOffscreen(WALL_PANEL.PX_W, WALL_PANEL.PX_H, paintWall, 'wallPanels');
  if (!tileCanvas) tileFailed = true;
  return tileCanvas;
}

/**
 * Paint and memoize the tile WITHOUT building a texture from it, so the cost
 * can be paid during a window that is already waiting on something else (the
 * GLB load) instead of inside createFocusRoom(). Safe to call any number of
 * times, and safe never to call — createWallPanelTexture() paints on demand.
 */
export function warmWallTile() { getTileCanvas(); }

/**
 * The wall finish texture, or null when no canvas is available (the caller
 * then keeps the flat ROOM.WALL_COLOR shell, which is black either way — only
 * the floor bounce is lost). The caller owns it and must dispose() it.
 */
export function createWallPanelTexture() {
  const canvas = getTileCanvas();
  if (!canvas) return null;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  // Height is spanned exactly once — clamping is what stops the floor bounce
  // from reappearing as a band partway up the wall.
  texture.wrapT = THREE.ClampToEdgeWrapping;
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  texture.anisotropy = Math.min(WALL_PANEL.ANISOTROPY, maxAniso || 1);
  return texture;
}
