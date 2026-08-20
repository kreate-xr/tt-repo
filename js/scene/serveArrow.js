// Serve-turn arrow — animated chevrons on the player's half of the table.
//
// The primary "it's your serve" cue, placed where the player is already
// looking — three semi-transparent chevrons laid flat on their half of the
// felt, streaming toward the net (the direction the serve has to go).
// Player-serve only; the AI's serve is already telegraphed by its figure
// animation, and the scoreboard's server dot marks whose serve it is.
//
// Show/hide contract (wired in aiMatch.js / multiplayer.js):
//   show()     — fade in. Called on serve-requested when the player serves,
//                i.e. the moment their trigger is armed.
//   hide()     — fade out. Called on successful player launch, on
//                serve-requested for AI serves, and on match-end.
//   update(dt) — fade ramp + opacity pulse + chevron flow. Called from tick.
//
// Rendering: one PlaneGeometry lying 2mm above the felt (targets.js offset
// convention) with a canvas-drawn chevron tile repeated 3× along its length.
// The flow animation is pure UV scroll — no canvas redraws after init.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { tableBox, tableSurfaceY } from './models.js';

// Power-of-two so RepeatWrapping + mipmaps work.
const CANVAS_SIZE = 256;

const ARROW_W_M = 0.45;
const ARROW_L_M = 0.90;
const CHEVRON_REPEATS = 3;

// Same 2mm lift targets.js uses for its zone quads — above the felt but
// below any plausible ball-contact height, and no z-fighting.
const SURFACE_LIFT_M = 0.002;

// Opacity = fadeProgress * (BASE + pulse). The pulse swings around BASE so
// the arrow "breathes" rather than blinks; amplitude kept well under BASE so
// it never fully vanishes mid-show.
const BASE_OPACITY = 0.35;
const PULSE_AMPLITUDE = 0.10;
const PULSE_PERIOD_S = 1.6;

// UV-scroll rate in texture tiles per second. One tile = one chevron, so
// this reads as "chevrons advance about half a step per second" — a calm
// drift toward the net, not a marquee.
const FLOW_SPEED_TILES_PER_S = 0.45;

// Fade timings + safety net. hide() schedules a hard snap-to-zero shortly
// after the fade so the arrow can never linger if a frame tick is dropped.
const FADE_IN_MS = 200;
const FADE_OUT_MS = 180;
const HIDE_SAFETY_MS = FADE_OUT_MS + 80;

// Player-side blue — same as the scoreboard server dot, so the palette
// already reads as "your side".
const PLAYER_BLUE = '#8ea6ff';

export function createServeArrow() {
  if (!tableBox) {
    console.warn('[serveArrow] tableBox not ready — call after loadModels()');
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  drawChevronTile(canvas.getContext('2d'), CANVAS_SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  // Repeat along the plane's length (V) so one drawn chevron becomes a
  // stacked column of three.
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, CHEVRON_REPEATS);

  const geom = new THREE.PlaneGeometry(ARROW_W_M, ARROW_L_M);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);

  // Lie flat, centered on the player's half. Rotating -90° about X maps the
  // plane's local +Y (canvas-up, where the chevron apex points) onto world
  // -Z — which is toward the net, because the player side is tableBox.max.z.
  const cx = (tableBox.min.x + tableBox.max.x) / 2;
  const tableCenterZ = (tableBox.min.z + tableBox.max.z) / 2;
  const cz = (tableCenterZ + tableBox.max.z) / 2;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx, tableSurfaceY + SURFACE_LIFT_M, cz);
  // Above the ball-shadow blob (1), below the serve panel (6).
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  // Fade state machine — a 0..1 progress ramped toward a target at a
  // per-phase rate. Actual material opacity is progress * (BASE + pulse),
  // composed in update().
  let fadeProgress = 0;
  let targetFade = 0;
  let fadeRatePerSec = 0;
  // Pulse clock, reset on show() so each appearance starts at base opacity.
  let pulseT = 0;

  // Safety-net timer set by hide() and cleared by show(). Forces the arrow
  // invisible if the fade-driven path fails to reach 0 (dropped frames,
  // paused XR update loop).
  let hideSafetyTimer = null;
  function clearHideSafetyTimer() {
    if (hideSafetyTimer !== null) {
      clearTimeout(hideSafetyTimer);
      hideSafetyTimer = null;
    }
  }
  function forceHidden() {
    fadeProgress = 0;
    targetFade = 0;
    mat.opacity = 0;
    mesh.visible = false;
  }

  function show() {
    clearHideSafetyTimer();
    pulseT = 0;
    mesh.visible = true;
    targetFade = 1;
    fadeRatePerSec = 1000 / FADE_IN_MS;
  }

  function hide() {
    targetFade = 0;
    fadeRatePerSec = 1000 / FADE_OUT_MS;
    clearHideSafetyTimer();
    hideSafetyTimer = setTimeout(() => {
      hideSafetyTimer = null;
      // Only snap if we're still on the "should be hidden" side — a show()
      // between hide() and this firing would have cleared us.
      if (targetFade === 0) forceHidden();
    }, HIDE_SAFETY_MS);
  }

  function update(dt) {
    if (fadeProgress !== targetFade) {
      const step = fadeRatePerSec * dt;
      fadeProgress = fadeProgress < targetFade
        ? Math.min(targetFade, fadeProgress + step)
        : Math.max(targetFade, fadeProgress - step);
    }
    if (fadeProgress === 0) {
      if (mesh.visible) {
        mat.opacity = 0;
        mesh.visible = false;
      }
      return;
    }
    pulseT += dt;
    // Decreasing the V offset makes the sampled pattern travel toward +V,
    // i.e. the chevrons stream toward the net.
    texture.offset.y = (texture.offset.y - FLOW_SPEED_TILES_PER_S * dt) % 1;
    const pulse = PULSE_AMPLITUDE * Math.sin((pulseT * 2 * Math.PI) / PULSE_PERIOD_S);
    mat.opacity = fadeProgress * (BASE_OPACITY + pulse);
  }

  function dispose() {
    clearHideSafetyTimer();
    scene.remove(mesh);
    geom.dispose();
    mat.dispose();
    texture.dispose();
  }

  return { show, hide, update, dispose, mesh };
}

// One chevron on a transparent tile, apex pointing canvas-up. Vertically the
// stroke spans the middle of the tile with clear margins so the RepeatWrapping
// seam falls in empty space and adjacent chevrons read as separate arrows.
function drawChevronTile(ctx, size) {
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = PLAYER_BLUE;
  ctx.lineWidth = size * 0.14;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = PLAYER_BLUE;
  ctx.shadowBlur = size * 0.09;
  ctx.beginPath();
  ctx.moveTo(size * 0.13, size * 0.72);
  ctx.lineTo(size * 0.50, size * 0.28);
  ctx.lineTo(size * 0.87, size * 0.72);
  ctx.stroke();
}
