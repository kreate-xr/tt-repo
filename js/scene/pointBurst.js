// Over-net point burst — a brief "+1" / "FOUL" flash right above the net.
//
// Marks the MOMENT where the action just happened — a short scale-pop text
// burst over the net with an expanding shockwave ring, in the winner's side
// color (or the umpire yellow for a foul). It is deliberately glanceable,
// not readable: one symbol, ~1 second, gone before the next serve window
// ends. The DETAIL (who won, why, which rule broke) lives on the scoreboard
// and the HUD log.
//
// Show/hide contract (wired in aiMatch.js / multiplayer.js):
//   burst({winner, foul}) — point just ended. winner 'player'|'ai' picks the
//                           side color; a non-null foul overrides both text
//                           and color with the FOUL treatment. Re-bursting
//                           mid-animation restarts the timeline.
//   update(dt)            — drives the pop / rise / fade. Called from tick;
//                           returns immediately while idle.
//   dispose()             — remove meshes, free GPU resources.
//
// Rendering: a CanvasTexture text plane (same technique as scoreboard.js)
// plus a RingGeometry shockwave, both additive-blended so they read as light
// rather than a solid sign. Facing +Z toward the player, no billboarding —
// same fixed-viewpoint rationale as scoreboard.js.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { netBox } from './models.js';

// Side colors, matching scoreboard / serveArrow so the palette already
// means "your side" / "their side" before the text is read.
const PLAYER_COLOR = '#8ea6ff';
const AI_COLOR = '#ff9c6b';
// Umpire yellow — deliberately outside the two side colors.
const FOUL_COLOR = '#ffcf4d';

const CANVAS_W = 256;
const CANVAS_H = 128;
const TEXT_PLANE_W_M = 0.34;
const TEXT_PLANE_H_M = TEXT_PLANE_W_M * (CANVAS_H / CANVAS_W);

// Burst origin sits just above the net tape; the text then rises RISE_M over
// the animation so the "+1" floats up and away like a score popup.
const HEIGHT_ABOVE_NET_M = 0.22;
const RISE_M = 0.18;

// Timeline. POP is the scale-overshoot window at the front; FADE_START →
// DURATION is the fade-out tail. Total stays comfortably inside
// rallyManager's 2500ms between-point window so the burst is gone before
// the next serve.
const DURATION_S = 1.1;
const POP_S = 0.18;
const FADE_START_S = 0.55;
// How far past 1.0 the pop overshoots at its peak.
const POP_OVERSHOOT = 0.35;

// Shockwave ring: expands from RING_SCALE_MIN to MAX (meters of radius,
// applied as mesh scale on a unit ring) and is fully faded by RING_LIFE_S.
const RING_LIFE_S = 0.5;
const RING_SCALE_MIN = 0.10;
const RING_SCALE_MAX = 0.55;
const RING_MAX_OPACITY = 0.85;

export function createPointBurst() {
  if (!netBox) {
    console.warn('[pointBurst] netBox not ready — call after loadModels()');
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // Additive so overlapping the ring (and anything behind) reads as glow,
  // not as an opaque card floating over the court.
  const textMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  });
  const textMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(TEXT_PLANE_W_M, TEXT_PLANE_H_M),
    textMat,
  );

  const ringMat = new THREE.MeshBasicMaterial({
    color: PLAYER_COLOR,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    opacity: 0,
  });
  // Unit-ish ring; expansion is pure mesh scale so there's no geometry churn.
  const ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.0, 48), ringMat);

  const cx = (netBox.min.x + netBox.max.x) / 2;
  const baseY = netBox.max.y + HEIGHT_ABOVE_NET_M;
  const cz = (netBox.min.z + netBox.max.z) / 2;
  for (const mesh of [textMesh, ringMesh]) {
    mesh.position.set(cx, baseY, cz);
    mesh.renderOrder = 7; // above the serve panel's 6 — it's the newer event
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
  }

  // Time since burst() — negative means idle.
  let t = -1;

  function drawLabel(label, color) {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 96px system-ui, sans-serif';
    // Glow pass in the side color, then a hot near-white core on top — the
    // additive blend turns the pair into a neon read instead of flat text.
    ctx.shadowColor = color;
    ctx.shadowBlur = 24;
    ctx.fillStyle = color;
    ctx.fillText(label, CANVAS_W / 2, CANVAS_H / 2);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = 'bold 88px system-ui, sans-serif';
    ctx.fillText(label, CANVAS_W / 2, CANVAS_H / 2);
    texture.needsUpdate = true;
  }

  // Point just ended. A foul outranks the side color for the same reason it
  // does on the panel: "a rule was broken" is the story, not who scored.
  function burst({ winner, foul = null } = {}) {
    const isFoul = foul === 'player' || foul === 'ai';
    if (!isFoul && winner !== 'player' && winner !== 'ai') return;
    const color = isFoul
      ? FOUL_COLOR
      : winner === 'player' ? PLAYER_COLOR : AI_COLOR;
    drawLabel(isFoul ? 'FOUL' : '+1', color);
    ringMat.color.set(color);
    t = 0;
    textMesh.visible = true;
    ringMesh.visible = true;
    // Apply the t=0 pose immediately so the first rendered frame is already
    // correct even if update() runs late this frame.
    update(0);
  }

  function update(dt) {
    if (t < 0) return;
    t += dt;
    if (t >= DURATION_S) {
      t = -1;
      textMat.opacity = 0;
      ringMat.opacity = 0;
      textMesh.visible = false;
      ringMesh.visible = false;
      return;
    }

    // Text: sine pop (0 → overshoot → 1) at the front, then hold at 1.
    const scale = t < POP_S
      ? Math.max(0.001, Math.sin((t / POP_S) * Math.PI * 0.5) * (1 + POP_OVERSHOOT))
      : 1 + POP_OVERSHOOT * Math.max(0, 1 - (t - POP_S) / POP_S);
    textMesh.scale.setScalar(scale);

    // Rise: ease-out so it launches with the pop and drifts at the end.
    const riseP = t / DURATION_S;
    textMesh.position.y = baseY + RISE_M * (1 - (1 - riseP) * (1 - riseP));

    // Opacity: instant-on (the pop supplies the entrance), tail fade-out.
    textMat.opacity = t < FADE_START_S
      ? 1
      : 1 - (t - FADE_START_S) / (DURATION_S - FADE_START_S);

    // Shockwave: ease-out expansion, linear fade, dead by RING_LIFE_S.
    if (t < RING_LIFE_S) {
      const p = t / RING_LIFE_S;
      const eased = 1 - (1 - p) * (1 - p) * (1 - p);
      ringMesh.scale.setScalar(RING_SCALE_MIN + (RING_SCALE_MAX - RING_SCALE_MIN) * eased);
      ringMat.opacity = RING_MAX_OPACITY * (1 - p);
    } else if (ringMesh.visible) {
      ringMat.opacity = 0;
      ringMesh.visible = false;
    }
  }

  function dispose() {
    for (const mesh of [textMesh, ringMesh]) {
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    textMat.dispose();
    ringMat.dispose();
    texture.dispose();
  }

  return { burst, update, dispose, textMesh, ringMesh };
}
