// Floating scoreboard mounted BEHIND the AI's baseline, like a scoreboard
// on the far wall of a real TT venue. Sits well above the ball's flight
// path and outside the play area so it never occludes the rally. Player
// glances forward-and-up to read it, same natural gaze as watching the AI.
//
// The visual layout itself (SportyXR broadcast style: gradient player
// panels, VS badge, per-game history, stats row) lives in
// scoreboardLayout.js and is shared with the stadium TV screens
// (stadiumScoreboard.js) — this module only owns the floating/wall mesh.
//
// Single-sided (FrontSide) facing +Z (toward the player's near edge). Only
// the player views it, so mirrored back-face text isn't a concern.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { netBox, tableBox, tableSurfaceY } from './models.js';
import {
  LAYOUT_W, LAYOUT_H, createScoreboardState, renderScoreboardLayout,
} from './scoreboardLayout.js';

// Bigger than the original above-net panel — it's further away now, so it
// needs more physical width to preserve the same readable angular size.
const PANEL_W_M = 1.40;
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
  canvas.width = LAYOUT_W;
  canvas.height = LAYOUT_H;
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
  const panelH = panelW * (LAYOUT_H / LAYOUT_W);

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
  const state = createScoreboardState(config);

  function render() {
    renderScoreboardLayout(ctx, state);
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
