// Procedural wood sport-hall floor for the Focus Room — painted onto a
// canvas at runtime and handed back as one tiling CanvasTexture. Nothing is
// downloaded: this venue is built entirely in code (focusRoom.js header) and
// a floor texture is not the place to break that.
//
// WHY ALBEDO ONLY — no normal map, no roughness map. The floor is a flat
// plane, so every fragment on it shares one normal, and the only light that
// reaches it is hemiLight (sceneSetup.js LIGHTING LAYERS: the layer-3 rig
// never ran and has been deleted). A hemisphere's contribution is a function
// of the normal alone, so it is CONSTANT across this surface — there is no
// directional term for a normal map to perturb and no specular lobe for a
// roughness map to widen. Either map would cost a texture fetch, and a
// normal map would cost tangents too, to change literally nothing on screen.
// Every cue that makes this read as wood is therefore in the albedo: board
// seams, staggered end joints, grain, and per-board color variation.
//
// COST. One 1024² RGBA CanvasTexture (~5.3 MB with mips), shared by `map`
// and `emissiveMap` so it is one GPU texture and stays in cache, on a
// material that was already MeshStandardMaterial. No extra draw call, no
// extra geometry, no per-frame work. If the floor ever needs to get cheaper
// still, note that its shading is constant: a MeshBasicMaterial with the
// gain baked into these colors would be pixel-identical for less, at the
// cost of no longer following ROOM.SELF_LIT.
//
// SEAMLESSNESS. The tile repeats 2x3 across the room, so it must wrap on
// both axes or the joins read as a grid. Across the boards it wraps because
// TILE_M is divided into a whole number of them, putting a board edge
// exactly on the tile edge. Along the boards it wraps because each column's
// end joints are scaled to sum to exactly one tile and then rotated by a
// random offset, with any board crossing the edge painted a second time one
// tile up — from the same pre-rolled parameters, so the two halves match.

import * as THREE from 'three';
import { renderer } from './sceneSetup.js';
import { WOOD } from './focusRoomSpec.js';
import { mulberry32, tint, rgba, paintOffscreen } from './canvasPaint.js';

// Everything a single board needs, rolled ONCE. A board that crosses the
// tile edge is painted twice from this same object; re-rolling per paint
// would make its two halves disagree and put a visible line across the room.
function rollBoard(rand) {
  const grain = [];
  for (let i = 0; i < WOOD.GRAIN_PER_BOARD; i++) {
    grain.push({
      // Fractional position across the board's width.
      u: rand(),
      alpha: 0.05 + rand() * 0.16,
      width: 0.6 + rand() * 1.7,
      // Grain wanders slightly rather than running dead straight.
      wobble: (rand() - 0.5) * 2.2,
      phase: rand() * Math.PI * 2,
      waves: 1 + rand() * 2,
    });
  }
  return {
    base: WOOD.PLANKS[(rand() * WOOD.PLANKS.length) | 0],
    jitter: Math.round((rand() - 0.5) * 2 * WOOD.JITTER),
    grain,
  };
}

// Paint one board with its top-left at (x, y). Canvas clipping handles the
// part that falls outside the tile, which is what makes the wrap work.
function paintBoard(ctx, x, y, w, len, board) {
  ctx.fillStyle = tint(board.base, board.jitter);
  ctx.fillRect(x, y, w, len);

  ctx.save();
  // Keep grain inside its own board — a streak must not bleed across an end
  // joint, which is exactly the tell that gives away a fake wood texture.
  ctx.beginPath();
  ctx.rect(x, y, w, len);
  ctx.clip();

  for (const g of board.grain) {
    ctx.strokeStyle = rgba(WOOD.GRAIN_COLOR, g.alpha);
    ctx.lineWidth = g.width;
    ctx.beginPath();
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const gx = x + g.u * w + Math.sin(g.phase + t * Math.PI * 2 * g.waves) * g.wobble;
      const gy = y + t * len;
      if (i === 0) ctx.moveTo(gx, gy); else ctx.lineTo(gx, gy);
    }
    ctx.stroke();
  }
  ctx.restore();

  // End joint at the board's leading edge.
  ctx.strokeStyle = rgba(WOOD.SEAM_COLOR, 0.55);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5);
  ctx.lineTo(x + w, y + 0.5);
  ctx.stroke();
}

// Board lengths for one column, scaled to sum to EXACTLY the tile so the end
// joints wrap. Returned in pixels.
function columnBoards(rand, px, minPx, maxPx) {
  const lens = [];
  let total = 0;
  while (total < px) {
    const len = minPx + rand() * (maxPx - minPx);
    lens.push(len);
    total += len;
  }
  const scale = px / total;
  return lens.map(l => l * scale);
}

/**
 * The board layout for one tile, in pixels. Pure and deterministic (fixed
 * WOOD.SEED), and exported so the wrap invariants can be asserted without a
 * canvas: every column's boards sum to exactly `px`, and the columns divide
 * `px` exactly. Those two are what make the tile seamless — see the header.
 */
export function planTile(px) {
  const rand = mulberry32(WOOD.SEED);
  const cols = Math.max(1, Math.round(WOOD.TILE_M / WOOD.PLANK_W_M));
  const colW = px / cols;
  const perM = px / WOOD.TILE_M;
  const minPx = WOOD.BOARD_MIN_M * perM;
  const maxPx = WOOD.BOARD_MAX_M * perM;

  const columns = [];
  for (let c = 0; c < cols; c++) {
    const lens = columnBoards(rand, px, minPx, maxPx);
    // Rotating the column by a random offset is what staggers the end
    // joints against its neighbours; taking it mod px is what lets the
    // board that runs off the edge come back at the top.
    const offset = rand() * px;
    const boards = [];
    let cursor = 0;
    for (const len of lens) {
      boards.push({ y: (cursor + offset) % px, len, board: rollBoard(rand) });
      cursor += len;
    }
    columns.push({ x: c * colW, boards });
  }
  return { cols, colW, columns };
}

function paintTile(ctx, px) {
  const { cols, colW, columns } = planTile(px);

  // Base coat, so an anti-aliased gap between two boards never shows white.
  ctx.fillStyle = tint(WOOD.PLANKS[0], 0);
  ctx.fillRect(0, 0, px, px);

  for (const col of columns) {
    for (const { y, len, board } of col.boards) {
      paintBoard(ctx, col.x, y, colW, len, board);
      // The board that runs off the bottom edge continues at the top, from
      // the same rolled parameters so the two halves line up.
      if (y + len > px) paintBoard(ctx, col.x, y - px, colW, len, board);
    }
  }

  // Board edges last, over the joints, so the grid of boards reads cleanly.
  // Drawn at 0 AND at px: a line centered on the tile edge is otherwise half
  // painted here and half on the neighbouring tile.
  ctx.strokeStyle = rgba(WOOD.SEAM_COLOR, 0.7);
  ctx.lineWidth = 1.4;
  for (let c = 0; c <= cols; c++) {
    const x = c * colW;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, px);
    ctx.stroke();
  }
}

// Painted once per page and cached; each caller still gets its OWN
// CanvasTexture off it. Same reasoning as brandLogo.js — the Focus Room is
// rebuilt per session and disposes everything it owns, so a shared texture
// would be killed for every later room by the first one to leave.
let tileCanvas;
let tileFailed = false;

function getTileCanvas() {
  if (tileCanvas) return tileCanvas;
  if (tileFailed) return null;
  tileCanvas = paintOffscreen(WOOD.PX, WOOD.PX, paintTile, 'woodFloor');
  if (!tileCanvas) tileFailed = true;
  return tileCanvas;
}

/**
 * Paint and memoize the tile WITHOUT building a texture from it, so the cost
 * can be paid during a window that is already waiting on something else (the
 * GLB load) instead of inside createFocusRoom(). Safe to call any number of
 * times, and safe never to call — createWoodFloorTexture() paints on demand.
 */
export function warmWoodTile() { getTileCanvas(); }

/**
 * A tiling wood-floor texture for a floor plane of `widthX` x `lengthZ`
 * metres, or null when no canvas is available (the caller then keeps the
 * flat ROOM.FLOOR_COLOR floor). The caller owns the texture and must
 * dispose() it.
 */
export function createWoodFloorTexture(widthX, lengthZ) {
  const canvas = getTileCanvas();
  if (!canvas) return null;

  const texture = new THREE.CanvasTexture(canvas);
  // The boards are authored as albedo, so this is color data, not data-data.
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // PlaneGeometry(widthX, lengthZ) lays u across the width and v along the
  // length, and the plane is rotated flat about X — so v runs along world Z
  // and the boards, painted along the canvas' v, run down the room's long
  // axis. That is how a hall is actually laid.
  texture.repeat.set(widthX / WOOD.TILE_M, lengthZ / WOOD.TILE_M);
  // renderer is absent when sceneSetup is mocked (tests); 1 is three's own
  // default and simply means no anisotropic filtering.
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  texture.anisotropy = Math.min(WOOD.ANISOTROPY, maxAniso || 1);
  texture.needsUpdate = true;
  return texture;
}
