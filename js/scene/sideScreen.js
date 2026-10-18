// Courtside "last point" monitor — the small screen beside the table at the
// net line in the Arena venue (GLB material 'Screen', see arenaVenue.js
// SIDE_SCREEN). The far hanging TV already carries the full scoreboard, so
// this one shows what a real arena can't: the player's last shot of the
// point (ball speed + spin), the rally length, and who serves next.
//
// Redrawn ONLY between points (the caller pushes one patch per point end).
// A display changing in peripheral vision while the eyes track the ball is a
// distraction, and one 1024x576 upload per point costs nothing.
//
// The layout is drawn by renderSideScreenLayout from a plain state object;
// formatting lives in formatSideScreen so the numbers are unit-testable
// without a canvas.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { BOARD_COLORS, FONT } from './scoreboardLayout.js';

// 16:9, matching the GLB screen face (1.36 x 0.77 m).
export const SIDE_W = 1024;
export const SIDE_H = 576;

const RAD_PER_S_TO_RPM = 60 / (2 * Math.PI);

// ball.js spinType → display label.
const SPIN_LABELS = {
  TOP: 'TOPSPIN',
  BACK: 'BACKSPIN',
  'R-SPIN': 'SIDESPIN',
  'L-SPIN': 'SIDESPIN',
  flat: 'FLAT',
};

export function createSideScreenState() {
  return {
    // Player's last paddle contact of the finished point; null when the
    // player never touched the ball that point (an unreturned serve).
    lastShot: null, // { outSpeed (m/s), spinMag (rad/s), spinType }
    rallyStrokes: 0,
    // Set once a point has finished — before that the screen shows the
    // pre-match idle state.
    pointPlayed: false,
    nextServer: 'ai',
    servesLeft: 2,
    matchOver: false,
  };
}

// State → display strings. Pure.
export function formatSideScreen(state) {
  const shot = state.lastShot;
  const speed = shot ? `${Math.round((shot.outSpeed || 0) * 3.6)}` : '—';
  const rpm = shot ? Math.round(((shot.spinMag || 0) * RAD_PER_S_TO_RPM) / 10) * 10 : null;
  const spin = rpm === null ? '—' : rpm.toLocaleString('en-US');
  const spinLabel = shot ? (SPIN_LABELS[shot.spinType] || 'SPIN') : (state.pointPlayed ? 'NO RETURN' : '');
  const rally = state.pointPlayed ? `${state.rallyStrokes}` : '—';
  let serve;
  if (state.matchOver) serve = 'MATCH OVER';
  else if (state.nextServer === 'player') serve = 'YOUR SERVE';
  else serve = 'AI SERVES';
  const servesLeft = state.matchOver ? '' : `${state.servesLeft} LEFT`;
  return { speed, spin, spinLabel, rally, serve, servesLeft };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// One stat cell: small dim label, big value, optional unit/sub-label.
// valuePx defaults to the top row's 112px; the shorter bottom row passes less.
function drawCell(ctx, x, y, w, h, label, value, unit, accent, valuePx = 112) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(30, 41, 72, 0.95)');
  g.addColorStop(1, 'rgba(14, 20, 40, 0.95)');
  roundRect(ctx, x, y, w, h, 18);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(x + 18, y, w - 36, 6);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = BOARD_COLORS.textDim;
  ctx.font = `bold 34px ${FONT}`;
  ctx.fillText(label, x + w / 2, y + 44);

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${valuePx}px ${FONT}`;
  ctx.fillText(value, x + w / 2, y + h / 2 + 10);

  if (unit) {
    ctx.fillStyle = accent;
    ctx.font = `bold 36px ${FONT}`;
    ctx.fillText(unit, x + w / 2, y + h - 30);
  }
}

export function renderSideScreenLayout(ctx, state) {
  const f = formatSideScreen(state);
  ctx.clearRect(0, 0, SIDE_W, SIDE_H);

  const bg = ctx.createLinearGradient(0, 0, 0, SIDE_H);
  bg.addColorStop(0, '#0b1124');
  bg.addColorStop(1, '#050812');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIDE_W, SIDE_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = BOARD_COLORS.gold;
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText('YOUR LAST SHOT', SIDE_W / 2, 40);

  const PAD = 24;
  const GAP = 20;
  const cellW = (SIDE_W - PAD * 2 - GAP) / 2;
  const topY = 76;
  const topH = 260;
  drawCell(ctx, PAD, topY, cellW, topH, 'BALL SPEED', f.speed, 'KM/H', BOARD_COLORS.blueBright);
  drawCell(ctx, PAD + cellW + GAP, topY, cellW, topH, 'SPIN · RPM', f.spin, f.spinLabel, BOARD_COLORS.purple);

  const botY = topY + topH + GAP;
  const botH = SIDE_H - botY - PAD;
  drawCell(ctx, PAD, botY, cellW, botH, 'RALLY', f.rally, state.pointPlayed ? 'SHOTS' : '', BOARD_COLORS.green, 72);

  // Next-serve cell: the value is a phrase, not a number, so it is drawn
  // here at its own size rather than through drawCell.
  const sx = PAD + cellW + GAP;
  const serveAccent = state.nextServer === 'player' ? BOARD_COLORS.blueBright : BOARD_COLORS.redBright;
  drawCell(ctx, sx, botY, cellW, botH, 'NEXT SERVE', '', '', state.matchOver ? BOARD_COLORS.gold : serveAccent);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 62px ${FONT}`;
  ctx.fillText(f.serve, sx + cellW / 2, botY + botH / 2 + 10);
  if (f.servesLeft) {
    ctx.fillStyle = serveAccent;
    ctx.font = `bold 36px ${FONT}`;
    ctx.fillText(f.servesLeft, sx + cellW / 2, botY + botH - 30);
  }
}

// anchor: { x, y, z, rotationY, width } in world space — the venue supplies
// it already offset off its screen face (see arenaVenue getSideScreenAnchor).
export function createSideScreen({ anchor } = {}) {
  if (!anchor) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SIDE_W;
  canvas.height = SIDE_H;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // The player reads this screen ~40° off-axis; anisotropic filtering keeps
  // the oblique text from smearing.
  texture.anisotropy = 8;

  const w = anchor.width;
  const geom = new THREE.PlaneGeometry(w, w * (SIDE_H / SIDE_W));
  const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide, toneMapped: false });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'SideScreen';
  mesh.position.set(anchor.x, anchor.y, anchor.z);
  mesh.rotation.y = anchor.rotationY || 0;
  scene.add(mesh);

  const state = createSideScreenState();

  function render() {
    renderSideScreenLayout(ctx, state);
    texture.needsUpdate = true;
  }
  render();

  function update(patch) {
    if (patch) Object.assign(state, patch);
    render();
  }

  function dispose() {
    scene.remove(mesh);
    geom.dispose();
    mat.dispose();
    texture.dispose();
  }

  return { update, dispose, mesh };
}
