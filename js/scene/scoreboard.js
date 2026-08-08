// Floating scoreboard mounted BEHIND the AI's baseline, like a scoreboard
// on the far wall of a real TT venue. Sits well above the ball's flight
// path and outside the play area so it never occludes the rally. Player
// glances forward-and-up to read it, same natural gaze as watching the AI.
//
// Layout (canvas, 1024×512):
//   PLAYER            AI             ← side labels
//    ●                                ← server indicator (lit on server side)
//    3        ·        5              ← current-game points
//        SETS 1 – 0  ·  BEST OF 5     ← games won + format
//
// Single-sided (FrontSide) facing +Z (toward the player's near edge). Only
// the player views it, so mirrored back-face text isn't a concern.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { netBox, tableBox, tableSurfaceY } from './models.js';

const CANVAS_W = 1024;
const CANVAS_H = 512;
// Bigger than the original above-net panel — it's further away now, so it
// needs more physical width to preserve the same readable angular size.
const PANEL_W_M = 1.40;
const PANEL_H_M = PANEL_W_M * (CANVAS_H / CANVAS_W);
// Position behind the far (AI) baseline and above the table. 1.0 m above
// the table top puts the center just above standing-player eye height so
// the read is a gentle upward glance, not a neck-craning look up. 0.8 m
// behind the baseline keeps it out of the AI paddle's swing volume.
const HEIGHT_ABOVE_TABLE_M = 1.0;
const DISTANCE_BEHIND_AI_M = 0.8;

export function createScoreboard({ config = {}, anchor = null } = {}) {
  if (!netBox || !tableBox) {
    console.warn('[scoreboard] tableBox/netBox not ready — call after loadModels()');
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;

  // Wall-mounted variant: upscale ~2× so the panel preserves the same
  // readable angular size from the player's eye position even though it
  // now sits several meters further away against the venue's back wall.
  // Aspect (2:1) is preserved.
  const panelW = anchor ? PANEL_W_M * 2.0 : PANEL_W_M;
  const panelH = panelW * (CANVAS_H / CANVAS_W);

  const geom = new THREE.PlaneGeometry(panelW, panelH);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geom, mat);

  if (anchor) {
    // Wall-mount: caller supplies the world-space anchor already offset
    // slightly off the wall to avoid z-fighting. Plane's front normal is
    // +Z; anchor is chosen on the wall behind the AI (min-Z side) so no
    // rotation is needed — the front face already looks toward the player.
    mesh.position.set(anchor.x, anchor.y, anchor.z);
  } else {
    // Floating variant (default): centered on the net's X, sat back behind
    // the AI's far baseline (tableBox.min.z is the AI-side edge). Player is
    // at +Z, looks toward -Z, so the scoreboard is beyond the AI in the
    // player's line of sight.
    const cx = (netBox.min.x + netBox.max.x) / 2;
    const cy = tableSurfaceY + HEIGHT_ABOVE_TABLE_M;
    const cz = tableBox.min.z - DISTANCE_BEHIND_AI_M;
    mesh.position.set(cx, cy, cz);
  }
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  scene.add(mesh);

  // Kept internally so partial patches (server change with no score change)
  // don't force the caller to remember the full state.
  const state = {
    playerScore: 0,
    aiScore: 0,
    playerGames: 0,
    aiGames: 0,
    currentServer: 'ai',
    matchOverBanner: null,
    bestOf: config.bestOf ?? 5,
  };

  function render() {
    const w = CANVAS_W, h = CANVAS_H;

    ctx.clearRect(0, 0, w, h);

    // Rounded slab background.
    ctx.fillStyle = 'rgba(15, 20, 30, 0.88)';
    roundRect(ctx, 8, 8, w - 16, h - 16, 24);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Side labels.
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.fillStyle = '#8ea6ff';
    ctx.fillText('PLAYER', w * 0.25, 80);
    ctx.fillStyle = '#ff9c6b';
    ctx.fillText('AI', w * 0.75, 80);

    // Server dot — lit on the serving side, dim on the other.
    const dotY = 140;
    ctx.fillStyle = state.currentServer === 'player' ? '#8ea6ff' : 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(w * 0.25, dotY, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = state.currentServer === 'ai' ? '#ff9c6b' : 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(w * 0.75, dotY, 12, 0, Math.PI * 2); ctx.fill();

    // Big current-game points + center divider.
    ctx.font = 'bold 220px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(state.playerScore), w * 0.25, 300);
    ctx.fillText(String(state.aiScore),     w * 0.75, 300);
    ctx.font = 'bold 140px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('·', w * 0.5, 290);

    // Games / best-of footer.
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(
      `SETS  ${state.playerGames} – ${state.aiGames}   ·   BEST OF ${state.bestOf}`,
      w * 0.5, h - 60,
    );

    // Match-over overlay masks the score area.
    if (state.matchOverBanner) {
      ctx.fillStyle = 'rgba(15, 20, 30, 0.94)';
      ctx.fillRect(20, 210, w - 40, 180);
      ctx.font = 'bold 96px system-ui, sans-serif';
      ctx.fillStyle = '#ffe27a';
      ctx.fillText(state.matchOverBanner, w * 0.5, 300);
    }

    texture.needsUpdate = true;
  }

  render();

  function update(patch) {
    if (patch) Object.assign(state, patch);
    render();
  }

  function setMatchOverBanner(text) {
    state.matchOverBanner = text;
    render();
  }

  function setVisible(v) { mesh.visible = !!v; }

  function dispose() {
    scene.remove(mesh);
    geom.dispose();
    mat.dispose();
    texture.dispose();
  }

  return { update, setMatchOverBanner, setVisible, dispose, mesh };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}
