// In-XR menu panel — landscape "hub" layout inspired by modern MR game menus.
// CanvasTexture plane, world-billboarded ~1.1m in front of the camera by
// inGame.js's updateMenuPlacement.
//
// Composition (left → right):
//   - Left dock: single utility icon (Tune Physics).
//   - Center row: three large circular mode tiles (Play / AI / Multi),
//     each with a coloured crosshair ring, icon, main label + subtitle.
//   - Top pill: difficulty segmented control.
//   - Bottom pill: Exit.
//
// Input paths: laser raycast, plus off-hand poke via inGame.js's
// updatePokeInput. Both flow through hitTestUV, which supports circles
// (mode tiles) and rects (everything else).

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { playMenuHoverTick, playMenuSelectClick } from './audio.js';
import * as haptics from '../xr/haptics.js';
import { BALL_COLORS, getBallColorId } from './models.js';
import { getDriftFlag as getCalibrationDriftFlag } from '../xr/driftDetector.js';
import { TUNER_ENABLED } from './hud.js';

// Rotation order for the ball-color toggle. Keep in sync with BALL_COLORS.
const BALL_COLOR_ORDER = ['orange', 'white'];

const CANVAS_W = 1024;
const CANVAS_H = 410;
// Matches the scoreboard's physical width (see scoreboard.js PANEL_W_M) so
// the two floating panels feel like part of the same UI system. Height
// tracks the canvas aspect (1024 × 410 → 2.5:1) rather than the scoreboard's
// 2:1 so the menu's own layout doesn't reflow.
export const PLANE_W = 1.40;
export const PLANE_H = PLANE_W * (CANVAS_H / CANVAS_W);

const ACCENT       = '#3ddc97';

const COLORS = {
  bgTop:          'rgba(12,17,28,0.82)',
  bgBottom:       'rgba(18,24,38,0.90)',
  bgVignette:     'rgba(0,0,0,0.35)',
  border:         'rgba(255,255,255,0.10)',
  panelInner:     'rgba(255,255,255,0.06)',
  buttonShadow:   'rgba(0,0,0,0.35)',

  chromeBg:       'rgba(0,0,0,0.35)',
  chromeText:     '#e6edf5',
  chromeMuted:    '#8ba3bd',
  chromeHoverBg:  'rgba(255,255,255,0.12)',

  segmentSelBg:   ACCENT,
  segmentSelText: '#0a1a12',

  circleInterior: 'rgba(0,0,0,0.55)',

  exitText:       '#ff9a9a',
  exitHoverBg:    'rgba(255,120,120,0.14)',
};

const FONT_FAMILY    = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_MODE_MAIN = `700 28px ${FONT_FAMILY}`;
const FONT_MODE_SUB  = `600 13px ${FONT_FAMILY}`;
const FONT_PILL      = `600 17px ${FONT_FAMILY}`;
const FONT_EXIT      = `600 14px ${FONT_FAMILY}`;

// The drill picker that used to live here is gone. Every drill — the ball
// machine and the four legacy ones — is now reached through the TRAINING
// tile, which opens the P15 M0 menu (scene/trainingMenu.js) with its own
// nested menus for presets and settings. A flat ◀ NAME ▶ cycler cannot
// express that tree, which is why it was replaced rather than kept alongside.

// Labels describe what the tier actually plays like. The middle rung is
// tuned to international pace (loop 13 m/s, drive 16, smash 22 — see
// PROFILE_OVERRIDES in js/ai/shotTypeSelector.js), so calling it "MEDIUM"
// misrepresented it badly.
//
// The `id` values are the stable engine keys and must NOT be renamed —
// ENGINE_FACTORIES in js/ai/worker.js is keyed off them.
const DIFFICULTIES = [
  { id: 'beginner',     label: 'CLUB' },
  { id: 'intermediate', label: 'INTERNATIONAL' },
  { id: 'pro',          label: 'ELITE' },
];

// Top-level modes rendered as crosshair circles; the row centres itself from
// this list's length. Each has its own ring colour so the tile is instantly
// telegraphed.
//
// PLAY is the one front door to the ball machine. It used to be two tiles —
// TRAINING (drills menu) and PLAY (Machine Play menu) — both opening menus
// over the same machine; the Machine Play menu's modes are now rows and an
// end-condition cycler inside the unified menu, so the second tile had
// nothing left to open. The id stays 'training' because it is the stable
// event key inGame.js listens on.
const MODES = [
  { id: 'training',    label: 'PLAY',  ring: '#ffc857', icon: 'ballMachine', subtitle: 'RALLY · DRILLS' },
  { id: 'aiMatch',     label: 'AI',    ring: '#3ddc97', icon: 'aiMatch',    subtitle: 'MATCH'  },
  { id: 'multiplayer', label: 'MULTI', ring: '#ff8a5b', icon: 'multiplayer', subtitle: 'PLAYER' },
];

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// Card glyphs — pure canvas 2D so no asset loading. Each takes
// (ctx, cx, cy, size, color). Kept simple; glanceable, not photoreal.
const ICONS = {
  ballMachine(ctx, cx, cy, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    for (const [dx, dy] of [[-0.32, -0.18], [0.06, -0.06], [-0.14, 0.24]]) {
      ctx.beginPath();
      ctx.arc(cx + dx * s, cy + dy * s, s * 0.15, 0, Math.PI * 2);
      ctx.stroke();
    }
  },
  multiplayer(ctx, cx, cy, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx - s * 0.22, cy - s * 0.1, s * 0.13, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + s * 0.22, cy - s * 0.1, s * 0.13, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx - s * 0.22, cy + s * 0.4, s * 0.22, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + s * 0.22, cy + s * 0.4, s * 0.22, Math.PI, 2 * Math.PI); ctx.stroke();
  },
  aiMatch(ctx, cx, cy, s, color) {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    const w = s * 0.55, h = s * 0.5;
    roundRectPath(ctx, cx - w / 2, cy - h / 2 + s * 0.05, w, h, s * 0.1);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx - s * 0.1, cy + s * 0.05, s * 0.05, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + s * 0.1, cy + s * 0.05, s * 0.05, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx, cy - h / 2 + s * 0.05); ctx.lineTo(cx, cy - s * 0.32); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy - s * 0.38, s * 0.05, 0, Math.PI * 2); ctx.fill();
  },
  paddle(ctx, cx, cy, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx - s * 0.06, cy - s * 0.08, s * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.14, cy + s * 0.16);
    ctx.lineTo(cx + s * 0.38, cy + s * 0.42);
    ctx.stroke();
  },
  ballSwatch(ctx, cx, cy, s, _color) {
    // Filled disc in the CURRENT ball color so the dock button visually
    // reports the active state — the `color` arg from drawDock is ignored
    // on purpose. Border stroke provides silhouette against the dark panel
    // when the swatch itself is near-white.
    const palette = BALL_COLORS[getBallColorId()] || BALL_COLORS.orange;
    ctx.fillStyle = palette.base;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  },
  gear(ctx, cx, cy, s, color) {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.6;
    const rOuter = s * 0.42;
    const rInner = s * 0.32;
    const rHole = s * 0.14;
    const teeth = 8;
    ctx.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2;
      const r = i % 2 === 0 ? rOuter : rInner;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, rHole, 0, Math.PI * 2); ctx.stroke();
  },
};

export class WristMenu {
  constructor({ showTune = TUNER_ENABLED } = {}) {
    this.showTune = showTune;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Trilinear + anisotropic. Without mipmaps the panel shimmers ("glitter")
    // when minified: 1024px canvas → ~300 display px at typical viewing
    // distance, so head micro-motion re-samples different texels each frame.
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = 16;

    const geometry = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.DoubleSide,
      transparent: true,
      // Matches physicsTuner / trajectoryControl: with depthTest on, the
      // menu z-fights transparent geometry rendered before it (ball trail,
      // shadow, serve indicator, drill targets), which reads as shimmer.
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.mesh.position.set(0, 0.06, -0.04);
    this.mesh.rotation.set(-Math.PI / 2 + 0.55, 0, 0);
    this.mesh.visible = false;

    this.parent = null;
    this.selectedDifficultyIndex = 0;
    this.hovered = null;

    this.hoverProgress = 0;
    this.showProgress  = 0;
    this.pressProgress = 0;
    this.pokeCursor = null;
    // Cached drift flag — driftDetector polled once per frame in update().
    // Only trigger a redraw when it flips (avoids per-frame canvas churn).
    this._driftFlagCache = false;

    // Chrome regions computed by layoutButtons(). Drawn as background before
    // the interactive buttons so segment / arrow highlights layer on top.
    this._diffPill = null;

    this.buttons = [];
    this.layoutButtons();

    // Event name → handlers.
    //
    // This used to be a fixed object literal listing the known event names,
    // with `on()` guarded by `if (this.listeners[event])`. Registering a
    // handler for any event NOT in that literal was silently discarded — no
    // error, no warning — so adding the TRAINING tile produced a button that
    // hit-tested correctly, ran activate(), called emit()… and did nothing,
    // while every pre-existing option kept working. A Map created on demand
    // makes that failure mode impossible.
    this.listeners = new Map();

    this.draw();
  }

  attachTo(grip) {
    if (this.parent === grip) return;
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    if (grip) grip.add(this.mesh);
    else scene.add(this.mesh);
    this.parent = grip;
  }

  show() {
    this.mesh.visible = true;
    this.showProgress = 0;
    this.pressProgress = 0;
    this.mesh.scale.setScalar(0.94);
    this.draw();
  }
  hide() {
    this.mesh.visible = false;
    this.hovered = null;
    this.hoverProgress = 0;
    this.showProgress  = 0;
    this.pressProgress = 0;
    this.mesh.scale.setScalar(1);
  }
  isVisible() { return this.mesh.visible; }

  setPokeCursor(u, v, proximity) { this.pokeCursor = { u, v, proximity }; }
  clearPokeCursor() { this.pokeCursor = null; }

  update(dt) {
    if (!this.mesh.visible) return;
    let dirty = false;

    const targetHover = this.hovered ? 1 : 0;
    if (this.hoverProgress !== targetHover) {
      const step = 14 * dt;
      if (targetHover > this.hoverProgress) this.hoverProgress = Math.min(1, this.hoverProgress + step);
      else this.hoverProgress = Math.max(0, this.hoverProgress - step);
      dirty = true;
    }
    if (this.showProgress < 1) {
      this.showProgress = Math.min(1, this.showProgress + 6 * dt);
      dirty = true;
    }
    if (this.pressProgress > 0) {
      this.pressProgress = Math.max(0, this.pressProgress - 9 * dt);
      dirty = true;
    }

    // Poll calibration drift flag once per frame; redraw only on transition
    // so the badge appears/disappears without per-frame canvas rebuild.
    const drift = getCalibrationDriftFlag();
    if (drift !== this._driftFlagCache) {
      this._driftFlagCache = drift;
      dirty = true;
    }

    if (dirty) {
      const t = easeOutCubic(this.showProgress);
      this.mesh.scale.setScalar(0.94 + 0.06 * t);
      this.draw();
    }
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  emit(event, payload) {
    const arr = this.listeners.get(event);
    if (!arr) return;
    // One throwing handler must not stop the others, and must not propagate
    // back out through activate() → selectHovered() → the XR select event,
    // where it would be swallowed and look like "the button does nothing".
    for (const fn of arr) {
      try { fn(payload); } catch (e) { console.error(`menu handler "${event}" threw:`, e); }
    }
  }

  layoutButtons() {
    // --- Top pill row: difficulty segmented control ---
    // The drill picker that sat beside it is gone; drills are chosen inside
    // the TRAINING menu now. The difficulty control stays because it selects
    // the AI tier for the match modes, which is independent of training.
    // With the picker's half of the row freed, the control takes the width
    // it always needed: at 300px each segment was 100px, which clipped
    // "INTERNATIONAL" at any legible font size.
    const TOP_Y = 36;
    const TOP_H = 54;
    const diffW  = 520;
    const rowX = (CANVAS_W - diffW) / 2;

    this._diffPill = { x: rowX, y: TOP_Y, w: diffW, h: TOP_H };

    const segW = diffW / 3;
    for (let i = 0; i < DIFFICULTIES.length; i++) {
      this.buttons.push({
        id: 'diff-' + i, kind: 'segment', index: i, label: DIFFICULTIES[i].label,
        shape: 'rect', x: rowX + i * segW, y: TOP_Y, w: segW, h: TOP_H,
      });
    }

    // --- Mode circles: main row ---
    // Sized for a three-tile row: dropping the fourth tile freed enough
    // width that 70px tiles floated in empty panel, so both radius and gap
    // grew. Row centre sits midway between the difficulty pill's bottom and
    // the exit pill's top.
    const CIRCLE_R = 80;
    const CIRCLE_GAP = 56;
    const CIRCLE_ROW_W = MODES.length * (CIRCLE_R * 2) + (MODES.length - 1) * CIRCLE_GAP;
    const circleRowX = (CANVAS_W - CIRCLE_ROW_W) / 2;
    const CIRCLE_Y = 224;

    for (let i = 0; i < MODES.length; i++) {
      const cx = circleRowX + CIRCLE_R + i * (CIRCLE_R * 2 + CIRCLE_GAP);
      this.buttons.push({
        id: 'mode-' + MODES[i].id, kind: 'mode', index: i, modeId: MODES[i].id,
        shape: 'circle', cx, cy: CIRCLE_Y, r: CIRCLE_R,
      });
    }

    // --- Left dock: Calibrate Paddle, plus Tune Physics in dev sessions
    // (?tuner / ?selftest — see TUNER_ENABLED). Calibrate takes the first
    // slot when the tuner is absent so the dock never shows a gap.
    if (this.showTune) {
      this.buttons.push({
        id: 'tune', kind: 'dock', icon: 'gear',
        shape: 'rect', x: 32, y: CIRCLE_Y - 28, w: 56, h: 56, radius: 15,
      });
    }
    this.buttons.push({
      id: 'calibrate', kind: 'dock', icon: 'paddle',
      shape: 'rect', x: this.showTune ? 32 + 56 + 8 : 32,
      y: CIRCLE_Y - 28, w: 56, h: 56, radius: 15,
    });

    // --- Right dock: ball color toggle. Mirror of the left gear so the
    // panel reads symmetric. Icon renders a filled swatch in the CURRENT
    // ball color so the button's visual state matches what the ball looks
    // like on the table — no separate label needed. Click cycles through
    // BALL_COLOR_ORDER (currently just orange ↔ white — ITTF legal).
    this.buttons.push({
      id: 'ballColor', kind: 'dock', icon: 'ballSwatch',
      shape: 'rect', x: CANVAS_W - 32 - 56, y: CIRCLE_Y - 28, w: 56, h: 56, radius: 15,
    });

    // --- Bottom exit pill ---
    const EXIT_W = 100;
    const EXIT_H = 34;
    this.buttons.push({
      id: 'exit', kind: 'exit', label: 'EXIT',
      shape: 'rect', x: (CANVAS_W - EXIT_W) / 2, y: CANVAS_H - EXIT_H - 22, w: EXIT_W, h: EXIT_H,
    });
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.globalAlpha = easeOutCubic(this.showProgress);

    // Wide translucent capsule.
    const panelR = (CANVAS_H - 8) / 2;
    ctx.save();
    roundRectPath(ctx, 4, 4, CANVAS_W - 8, CANVAS_H - 8, panelR);
    const glass = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
    glass.addColorStop(0, COLORS.bgTop);
    glass.addColorStop(1, COLORS.bgBottom);
    ctx.fillStyle = glass;
    ctx.fill();
    const vg = ctx.createRadialGradient(
      CANVAS_W / 2, CANVAS_H / 2, CANVAS_W * 0.15,
      CANVAS_W / 2, CANVAS_H / 2, CANVAS_W * 0.65,
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, COLORS.bgVignette);
    ctx.fillStyle = vg;
    ctx.fill();
    ctx.restore();

    // Panel border/rim strokes intentionally omitted: thin 1-2px strokes on
    // the rounded rect shimmered badly under XR minification, and the alpha
    // edge of the capsule fill is enough to define the silhouette.

    // --- Chrome pass: static pill containers behind the interactive buttons.
    // Difficulty container.
    if (this._diffPill) {
      const p = this._diffPill;
      ctx.save();
      roundRectPath(ctx, p.x, p.y, p.w, p.h, p.h / 2);
      ctx.fillStyle = COLORS.chromeBg;
      ctx.fill();
      ctx.restore();
    }

    // --- Buttons pass ---
    for (const b of this.buttons) {
      this.drawButton(b);
    }

    // Poke cursor.
    if (this.pokeCursor) {
      const { u, v, proximity } = this.pokeCursor;
      const cx = u * CANVAS_W;
      const cy = (1 - v) * CANVAS_H;
      const p = Math.max(0, Math.min(1, proximity));
      const rOuter = 26 - 12 * p;
      const rInner = 6 + 2 * p;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rOuter);
      g.addColorStop(0,   `rgba(61,220,151,${0.55 * (0.5 + 0.5 * p)})`);
      g.addColorStop(0.5, `rgba(61,220,151,${0.20 * (0.5 + 0.5 * p)})`);
      g.addColorStop(1,   'rgba(61,220,151,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.75 + 0.2 * p})`;
      ctx.beginPath(); ctx.arc(cx, cy, rInner, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    this.texture.needsUpdate = true;
  }

  drawButton(b) {
    const isHovered = this.hovered === b.id;
    const hp = isHovered ? easeOutCubic(this.hoverProgress) : 0;
    const pp = isHovered ? this.pressProgress : 0;

    switch (b.kind) {
      case 'mode':    return this.drawModeCircle(b, hp, pp);
      case 'segment': return this.drawSegment(b, hp, pp);
      case 'dock':    return this.drawDock(b, hp, pp);
      case 'exit':    return this.drawExit(b, hp, pp);
    }
  }

  drawModeCircle(b, hp, pp) {
    const ctx = this.ctx;
    const mode = MODES[b.index];
    const lift = -3 * hp + 1.5 * pp;
    const cx = b.cx;
    const cy = b.cy + lift;
    const R = b.r - 3;

    // Interior fill with drop shadow beneath.
    ctx.save();
    ctx.shadowColor = COLORS.buttonShadow;
    ctx.shadowBlur = 14 + 8 * hp;
    ctx.shadowOffsetY = 5 + 2 * hp - 1 * pp;
    ctx.fillStyle = COLORS.circleInterior;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Hover tint on interior.
    if (hp > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(255,255,255,${0.06 * hp})`;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Coloured ring.
    ctx.strokeStyle = mode.ring;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Crosshair ticks at the four cardinal points.
    ctx.lineWidth = 4;
    const tickIn  = b.r + 2;
    const tickOut = b.r + 14;
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i;
      const cos = Math.cos(a), sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + cos * tickIn,  cy + sin * tickIn);
      ctx.lineTo(cx + cos * tickOut, cy + sin * tickOut);
      ctx.stroke();
    }

    // Icon (top of interior).
    const drawIcon = ICONS[mode.icon];
    if (drawIcon) {
      ctx.save();
      drawIcon(ctx, cx, cy - 24, 68, mode.ring);
      ctx.restore();
    }

    // Main label + subtitle (bottom of interior).
    ctx.fillStyle = mode.ring;
    ctx.font = FONT_MODE_MAIN;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
    ctx.fillText(mode.label, cx, cy + 26);

    ctx.fillStyle = COLORS.chromeMuted;
    ctx.font = FONT_MODE_SUB;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    ctx.fillText(mode.subtitle || '', cx, cy + 48);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  drawSegment(b, hp, pp) {
    const ctx = this.ctx;
    const isSelected = b.index === this.selectedDifficultyIndex;
    const pad = 3;
    if (isSelected) {
      ctx.save();
      roundRectPath(ctx, b.x + pad, b.y + pad, b.w - pad * 2, b.h - pad * 2, (b.h - pad * 2) / 2);
      ctx.fillStyle = COLORS.segmentSelBg;
      ctx.fill();
      ctx.restore();
    } else if (hp > 0) {
      ctx.save();
      roundRectPath(ctx, b.x + pad, b.y + pad, b.w - pad * 2, b.h - pad * 2, (b.h - pad * 2) / 2);
      ctx.fillStyle = `rgba(255,255,255,${0.14 * hp})`;
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = isSelected ? COLORS.segmentSelText : COLORS.chromeText;
    ctx.font = FONT_PILL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 - 1.5 * pp);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  drawDock(b, hp, pp) {
    const ctx = this.ctx;
    const lift = -2 * hp + 1 * pp;
    const dy = b.y + lift;
    ctx.save();
    ctx.shadowColor = COLORS.buttonShadow;
    ctx.shadowBlur = 6 + 6 * hp;
    ctx.shadowOffsetY = 3 + 1 * hp;
    roundRectPath(ctx, b.x, dy, b.w, b.h, b.radius || 14);
    ctx.fillStyle = hp > 0 ? COLORS.chromeHoverBg : COLORS.chromeBg;
    ctx.fill();
    ctx.restore();
    const drawIcon = ICONS[b.icon];
    if (drawIcon) drawIcon(ctx, b.x + b.w / 2, dy + b.h / 2, b.w * 0.62, COLORS.chromeText);
    // Calibration drift badge (spec §C8) — small yellow dot on top-right
    // of the calibrate button when the drift detector suggests recalibration.
    if (b.id === 'calibrate' && this._driftFlagCache) {
      ctx.save();
      ctx.fillStyle = '#ffcc33';
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(b.x + b.w - 8, dy + 8, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Same pill geometry as EXIT but in the accent colour — it is an entry
  // point, not a way out, and colouring it like EXIT would read as one.
  drawExit(b, hp, pp) {
    const ctx = this.ctx;
    const lift = -1.5 * hp + 1 * pp;
    const dy = b.y + lift;
    ctx.save();
    ctx.shadowColor = COLORS.buttonShadow;
    ctx.shadowBlur = 6 + 4 * hp;
    ctx.shadowOffsetY = 2 + 1 * hp;
    roundRectPath(ctx, b.x, dy, b.w, b.h, b.h / 2);
    ctx.fillStyle = hp > 0 ? COLORS.exitHoverBg : COLORS.chromeBg;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = COLORS.exitText;
    ctx.font = FONT_EXIT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    ctx.fillText(b.label, b.x + b.w / 2, dy + b.h / 2);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  hitTestUV(u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const px = u * CANVAS_W;
    const py = (1 - v) * CANVAS_H;
    // Circles win over overlapping rects, and the crosshair ticks that
    // extend past the circle radius are counted as part of the tile.
    for (const b of this.buttons) {
      if (b.shape === 'circle') {
        const dx = px - b.cx, dy = py - b.cy;
        if (dx * dx + dy * dy <= (b.r + 12) * (b.r + 12)) return b.id;
      }
    }
    for (const b of this.buttons) {
      if (b.shape !== 'circle') {
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.id;
      }
    }
    return null;
  }

  setHovered(id) {
    if (this.hovered === id) return;
    this.hovered = id;
    if (id != null) {
      try { playMenuHoverTick(); } catch {}
      haptics.pulseActive(0.15, 15);
    }
    this.draw();
  }

  selectHovered() {
    if (!this.hovered) return false;
    const button = this.buttons.find(b => b.id === this.hovered);
    if (!button) return false;
    this.pressProgress = 1;
    try { playMenuSelectClick(); } catch {}
    haptics.pulseActive(0.5, 30);
    this.activate(button);
    return true;
  }

  activate(button) {
    if (button.kind === 'segment') {
      this.selectedDifficultyIndex = button.index;
      this.draw();
      return;
    }
    if (button.kind === 'mode') {
      const difficultyId = DIFFICULTIES[this.selectedDifficultyIndex].id;
      if (button.modeId === 'training') {
        // Opens the unified PLAY menu; what to play is chosen in there.
        this.emit('training', { difficulty: difficultyId });
      } else if (button.modeId === 'aiMatch') {
        this.emit('start', { drill: 'aiMatch', difficulty: difficultyId });
      } else if (button.modeId === 'multiplayer') {
        this.emit('start', { drill: 'multiplayer', difficulty: difficultyId });
      }
      return;
    }
    if (button.kind === 'dock' && button.id === 'tune') {
      this.emit('tune');
      return;
    }
    if (button.kind === 'dock' && button.id === 'calibrate') {
      this.emit('calibrate');
      return;
    }
    if (button.kind === 'dock' && button.id === 'ballColor') {
      const currentId = getBallColorId();
      const idx = BALL_COLOR_ORDER.indexOf(currentId);
      const nextId = BALL_COLOR_ORDER[(idx + 1) % BALL_COLOR_ORDER.length];
      this.emit('ballColor', { colorId: nextId });
      this.draw();  // refresh the swatch to the new color
      return;
    }
    if (button.kind === 'exit') {
      this.emit('exit');
      return;
    }
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    // Clearing the Map drops every event's handlers, including ones added
    // after construction — the per-key list here was another place a new
    // event name had to be remembered, and silently leaked when it wasn't.
    this.listeners.clear();
  }
}

// Visible laser line from a controller's target ray. Length-clamped to the
// first hit when in menu mode.
/**
 * Pointer ray from the controller.
 *
 * Was a THREE.Line, which looks poor in a headset for reasons that are not
 * fixable by tweaking its colour: LineBasicMaterial ignores `linewidth` on
 * essentially every WebGL/WebXR platform, so it renders as a hard 1-pixel
 * thread that aliases and crawls with head motion, and it had no endpoint —
 * you could see the beam but not precisely what it was pointing at.
 *
 * This is a tapered tube plus a flat tip disc:
 *   - real geometric thickness, so it antialiases like everything else;
 *   - a brightness gradient (dim at the hand, bright at the target) so the
 *     eye is drawn to the business end rather than the controller;
 *   - a disc AT the hit point, which is the part that actually communicates
 *     where you are aiming.
 *
 * Callers scale it along Z by the hit distance. The tip is a disc in the XY
 * plane precisely so that scaling cannot deform it — a sphere would stretch
 * into an ellipsoid at every distance but one.
 */
export function createLaserLine() {
  const group = new THREE.Group();
  // System-pointer white (Quest style), not the UI accent: the beam is an
  // input affordance, not part of the panel's visual identity.
  const BEAM_RGB = new THREE.Color(0xffffff);

  // Unit-length tube along -Z, tapering toward the tip. Kept deliberately
  // thin — a fat beam reads as a prop rather than a pointer, and the tip disc
  // (not the tube) is what communicates aim.
  // 12 height segments, not 1: the fade-in curve below lives in vertex
  // colours, and with a single segment they could only lerp end-to-end.
  const beamGeom = new THREE.CylinderGeometry(0.0007, 0.0016, 1, 8, 12, true);
  beamGeom.rotateX(-Math.PI / 2);   // +Y axis → -Z
  beamGeom.translate(0, 0, -0.5);   // span 0 → -1

  // Fade to nothing at the hand: the near end of the beam would otherwise sit
  // on top of the paddle blade. Additive blending means a black vertex
  // contributes nothing, so ramping the colour up from 0 over the first
  // quarter of the beam makes it materialise a little way out from the paddle
  // and brighten toward the tip — no hard cut, no beam-over-paddle.
  const pos = beamGeom.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, -pos.getZ(i)));      // 0 at hand, 1 at tip
    const fadeIn = Math.min(1, t / 0.25);
    const k = fadeIn * fadeIn * (0.45 + 0.55 * t * t);
    colors[i * 3] = BEAM_RGB.r * k;
    colors[i * 3 + 1] = BEAM_RGB.g * k;
    colors[i * 3 + 2] = BEAM_RGB.b * k;
  }
  beamGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const beam = new THREE.Mesh(beamGeom, new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  group.add(beam);

  const tip = new THREE.Mesh(
    new THREE.CircleGeometry(0.006, 20),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  tip.position.z = -1;
  group.add(tip);

  group.renderOrder = 1001;
  group.visible = false;
  return group;
}
