// Between-point "READY" indicator floating above the net.
//
// Purpose: rallyManager inserts NEXT_SERVE_DELAY_MS between point-end and
// next-serve; without feedback the ball just re-appears. This module owns a
// small floating panel that fills that window with a clear cue, then either
// fades out (AI serves — the ball comes out automatically) or transitions
// to an "awaiting player trigger" state (player serves — panel stays up
// until the player fires their trigger, so they control the pace).
//
// Show/hide contract:
//   showReady(server)        — start-of-window: "READY" + "X SERVES".
//   showAwaitingTrigger()    — end-of-window when it's the player's serve:
//                              "YOUR SERVE" + "PULL TRIGGER". Stays visible
//                              until hide() is called (from the launch hook).
//   hide()                   — fade out. Called on serve-requested for AI,
//                              on successful player launch, or on match-end.
//   update(dt)               — animates the opacity fade. Called from tick.
//
// Position mirrors scoreboard.js style: CanvasTexture on a PlaneGeometry.
// Anchored above the net line, faces +Z (player side), no billboarding needed
// because the player's position is roughly fixed (same rationale as
// scoreboard.js).

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { netBox, tableBox, tableSurfaceY } from './models.js';

const CANVAS_W = 512;
// Taller than wide-single-line: the panel now shows READY over a
// "PLAYER SERVES" / "AI SERVES" subtitle, so the canvas is proportioned to
// fit two stacked text rows without either feeling cramped.
const CANVAS_H = 320;
const PANEL_W_M = 0.60;
const PANEL_H_M = PANEL_W_M * (CANVAS_H / CANVAS_W);

// Positioning: previously the panel floated above the net, right in the
// ball's flight path — distracting during rallies. Now stacked directly
// above the scoreboard behind the AI baseline so it lives in the same
// "info column" as the score and never crosses the player's active gaze
// during a rally. Numbers match scoreboard.js:
//   scoreboard center y ≈ tableSurfaceY + 1.0m, panel h ≈ 0.70m
//   → scoreboard top edge at tableSurfaceY + 1.35m
//   → our center at tableSurfaceY + 1.60m sits ~5cm above that
const HEIGHT_ABOVE_TABLE_M = 1.60;
const DISTANCE_BEHIND_AI_M = 0.80;

// Fade timings.
const FADE_IN_MS  = 150;
const FADE_OUT_MS = 180;
// Safety-net delay: hide() schedules a hard snap-to-zero this long after
// starting the fade so the panel can never linger past the animation
// window even if a frame tick is dropped or the update loop is paused.
const HIDE_SAFETY_MS = FADE_OUT_MS + 80;

export function createServeIndicator() {
  if (!netBox || !tableBox) {
    console.warn('[serveIndicator] tableBox/netBox not ready — call after loadModels()');
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

  const geom = new THREE.PlaneGeometry(PANEL_W_M, PANEL_H_M);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity: 0,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geom, mat);

  // Centered on the net's X (same column as the scoreboard) and set back
  // behind the AI baseline. Plane's front normal is +Z which faces the
  // player — no rotation needed. Same conventions as scoreboard.js.
  const cx = (netBox.min.x + netBox.max.x) / 2;
  const cy = tableSurfaceY + HEIGHT_ABOVE_TABLE_M;
  const cz = tableBox.min.z - DISTANCE_BEHIND_AI_M;
  mesh.position.set(cx, cy, cz);
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  // Which side is about to serve. Stored so setServer() can update the
  // subtitle without callers having to call showReady() again.
  let currentServerName = null;
  // Panel content mode. 'ready' → "READY" + "X SERVES"; 'trigger' → "YOUR
  // SERVE" + "PULL TRIGGER". renderCanvas branches on this.
  let mode = 'ready';

  renderCanvas();

  // Fade animation state. currentOpacity ramps toward targetOpacity at a rate
  // set by whichever phase is active (fade-in vs fade-out).
  let currentOpacity = 0;
  let targetOpacity = 0;
  let fadeRatePerSec = 0;
  // Safety-net timer set by hide() and cleared by any subsequent show*().
  // Forces the panel invisible if the fade-driven path fails to reach 0
  // (dropped frames, paused update loop, etc).
  let hideSafetyTimer = null;
  function clearHideSafetyTimer() {
    if (hideSafetyTimer !== null) {
      clearTimeout(hideSafetyTimer);
      hideSafetyTimer = null;
    }
  }
  function forceHidden() {
    currentOpacity = 0;
    targetOpacity = 0;
    mat.opacity = 0;
    mesh.visible = false;
  }

  function renderCanvas() {
    const w = CANVAS_W, h = CANVAS_H;
    ctx.clearRect(0, 0, w, h);

    // Rounded slab background — same visual language as the scoreboard.
    ctx.fillStyle = 'rgba(15, 20, 30, 0.85)';
    roundRect(ctx, 8, 8, w - 16, h - 16, 24);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 226, 122, 0.55)';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (mode === 'trigger') {
      // Player's turn to serve. Main headline uses player-blue so the palette
      // already reads as "your side"; call-to-action sits below in the same
      // yellow READY previously used, keeping the visual weight balanced.
      ctx.font = 'bold 96px system-ui, sans-serif';
      ctx.fillStyle = '#8ea6ff';
      ctx.fillText('YOUR SERVE', w * 0.5, h * 0.38);

      ctx.font = 'bold 44px system-ui, sans-serif';
      ctx.fillStyle = '#ffe27a';
      ctx.fillText('PULL TRIGGER', w * 0.5, h * 0.75);
    } else {
      // Main READY line, biased upward so the subtitle has room below.
      ctx.font = 'bold 112px system-ui, sans-serif';
      ctx.fillStyle = '#ffe27a';
      ctx.fillText('READY', w * 0.5, h * 0.38);

      // Subtitle: who is about to serve. Colors mirror scoreboard.js so the
      // player already associates the palette with each side.
      if (currentServerName === 'player' || currentServerName === 'ai') {
        const label = currentServerName === 'player' ? 'PLAYER SERVES' : 'AI SERVES';
        const color = currentServerName === 'player' ? '#8ea6ff' : '#ff9c6b';
        ctx.font = 'bold 44px system-ui, sans-serif';
        ctx.fillStyle = color;
        ctx.fillText(label, w * 0.5, h * 0.75);
      }
    }

    texture.needsUpdate = true;
  }

  function showReady(server = null) {
    clearHideSafetyTimer();
    mode = 'ready';
    currentServerName = server;
    renderCanvas();
    mesh.visible = true;
    targetOpacity = 1;
    fadeRatePerSec = 1000 / FADE_IN_MS;
  }

  function showAwaitingTrigger() {
    clearHideSafetyTimer();
    mode = 'trigger';
    renderCanvas();
    mesh.visible = true;
    targetOpacity = 1;
    // Snappier fade-in on transition — the panel is already visible from
    // the preceding READY state, so this is just re-asserting opacity.
    fadeRatePerSec = 1000 / FADE_IN_MS;
  }

  function setServer(server) {
    if (server !== currentServerName) {
      currentServerName = server;
      renderCanvas();
    }
  }

  function hide() {
    targetOpacity = 0;
    fadeRatePerSec = 1000 / FADE_OUT_MS;
    // Belt-and-braces: if the fade-driven path fails to reach zero for any
    // reason (dropped frames, render-loop pause, XR reference-space swap),
    // force the panel off after the fade window.
    clearHideSafetyTimer();
    hideSafetyTimer = setTimeout(() => {
      hideSafetyTimer = null;
      // Only snap if we're still on the "should be hidden" side — a
      // show*() call between hide() and this firing would have cleared us.
      if (targetOpacity === 0) forceHidden();
    }, HIDE_SAFETY_MS);
  }

  function update(dt) {
    if (currentOpacity === targetOpacity) {
      // Nothing to do; if fully invisible, drop the draw.
      if (currentOpacity === 0 && mesh.visible) mesh.visible = false;
      return;
    }
    const step = fadeRatePerSec * dt;
    if (currentOpacity < targetOpacity) {
      currentOpacity = Math.min(targetOpacity, currentOpacity + step);
    } else {
      currentOpacity = Math.max(targetOpacity, currentOpacity - step);
    }
    mat.opacity = currentOpacity;
    if (currentOpacity === 0) mesh.visible = false;
  }

  function dispose() {
    clearHideSafetyTimer();
    scene.remove(mesh);
    geom.dispose();
    mat.dispose();
    texture.dispose();
  }

  return { showReady, showAwaitingTrigger, setServer, hide, update, dispose, mesh };
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
