// In-XR menu panel — landscape "hub" layout inspired by modern MR game menus.
// CanvasTexture plane, world-billboarded ~1.1m in front of the camera by
// inGame.js's updateMenuPlacement.
//
// Composition (left → right):
//   - Left dock: how the game plays — Calibrate Paddle, Competition Rules.
//   - Center row: three large circular mode tiles (Play / AI / Multi),
//     each with a coloured crosshair ring, icon, main label + subtitle.
//   - Right dock: how it looks — Table Color, Ball Color.
//   - Top pill: difficulty segmented control.
//   - Below the tiles: hover caption naming the dock button under the cursor.
//   - Bottom pill: Exit.
//
// The two docks are deliberately the same size (2 × 56px each, sharing the
// mode row's centreline) — a lone button on one side against a cluster on the
// other reads as a layout that ran out of room.
//
// Input paths: laser raycast, plus off-hand poke via inGame.js's
// updatePokeInput. Both flow through hitTestUV, which supports circles
// (mode tiles) and rects (everything else).

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { playMenuHoverTick, playMenuSelectClick } from './audio.js';
import * as haptics from '../xr/haptics.js';
import { BALL_COLORS, getBallColorId, TABLE_COLORS, getTableColorId } from './models.js';
import { getDriftFlag as getCalibrationDriftFlag } from '../xr/driftDetector.js';
import { TUNER_ENABLED } from './hud.js';

// Rotation order for the ball-color toggle. Keep in sync with BALL_COLORS.
const BALL_COLOR_ORDER = ['orange', 'white'];
// Rotation order for the table-color toggle. Keep in sync with TABLE_COLORS.
const TABLE_COLOR_ORDER = ['blue', 'green'];

const CANVAS_W = 1024;
const CANVAS_H = 410;
// Floor between hover-driven full repaints (each is a ~1.7 MB texture
// re-upload). 100 ms caps laser-jitter churn at 10 uploads/s while an
// isolated hover change still repaints on the very frame it happens.
const HOVER_REDRAW_MIN_MS = 100;
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
const FONT_PILL      = `600 17px ${FONT_FAMILY}`;
const FONT_EXIT      = `600 14px ${FONT_FAMILY}`;
const FONT_CAPTION   = `600 18px ${FONT_FAMILY}`;

// Mode-tile typography. Sizes are the *intended* ones; the real size is
// resolved at draw time by _modeTextFit() against the circle's interior, so
// these are a ceiling rather than a promise.
const MODE_LABEL_PX = 28;
const MODE_LABEL_LS = 1;
const MODE_SUB_PX   = 12;
const MODE_SUB_LS   = 1;
// Text baselines measured from the circle centre, and the clearance kept
// between the widest glyph and the coloured ring.
const MODE_ICON_DY  = -30;
const MODE_ICON_S   = 62;
const MODE_LABEL_DY = 20;
const MODE_SUB_DY   = 40;
const MODE_TEXT_INSET = 12;
// Floor for shrink-to-fit. Below this the text is unreadable at XR
// minification, so overflowing is the lesser evil and the caller gets a
// too-wide line it can see in the preview rather than an invisible one.
const MIN_FIT_PX = 9;

// Half-width of a circle of radius r at vertical offset dy from its centre.
// A label inside a circle is bounded by the chord at its *lowest* glyph, not
// by the diameter — which is why "RALLY · DRILLS" (115px, drawn where the
// chord is 110px) used to be painted straight across the PLAY tile's ring.
const chordHalf = (r, dy) => Math.sqrt(Math.max(0, r * r - dy * dy));

// Hover captions for the dock buttons. The mode circles carry their own
// label + subtitle; the dock buttons are icon-only and had no way to say what
// they do. A 56px tile has no room for text inside and no room for a label
// beneath it either — so the panel names whichever dock button the laser is
// on, on a shared line under the mode row.
//
// The trophy is why this exists: "competition rules" is not a guessable
// meaning for a cup glyph, and unlike the two color swatches (whose icons
// show their own state) nothing about it says what it changes. Wording is
// "what it does", not "what it is", because that is the question a player
// hovering an unfamiliar icon is actually asking.
const DOCK_CAPTIONS = {
  tune:       'Tune Physics  —  live A/B on ball & paddle constants',
  calibrate:  'Calibrate Paddle  —  align the bat with your controller',
  ballColor:  'Ball Color  —  orange or white, both ITTF legal',
  rules:      'Competition Rules  —  strict 16 cm serve toss + certified table',
  tableColor: 'Table Color  —  blue or green, both ITTF approved',
};

// Caption baseline. The band between the mode circles' crosshair ticks
// (which reach y = CIRCLE_Y + r + 14 = 310) and the top of the exit pill
// (y = CANVAS_H - EXIT_H - 20 = 356) is the only full-width gap in the
// layout; 332 centres an 18px line in it with ~13px clear on either side.
const CAPTION_Y = 332;

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
    // Heads + shoulders, drawn so the ink is centred on (cx, cy). It used to
    // hang low — heads at -0.10s but shoulders down at +0.40s — which pushed
    // the glyph's visual centre a third of the way down the tile and left the
    // shoulder arcs touching the MULTI label beneath.
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx - s * 0.22, cy - s * 0.24, s * 0.13, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + s * 0.22, cy - s * 0.24, s * 0.13, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx - s * 0.22, cy + s * 0.30, s * 0.22, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + s * 0.22, cy + s * 0.30, s * 0.22, Math.PI, 2 * Math.PI); ctx.stroke();
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
    // Calibrate-Paddle glyph. The previous version — a *stroked* circle with
    // a thin diagonal stick — is the exact construction of a magnifying-glass
    // icon, and that is what everyone read it as: a search button on a menu
    // with nothing to search. The fix is the same one the trophy needed:
    // fill the blade instead of outlining it (an outline is what makes a lens
    // read as a lens) and give the handle a bat's stubby proportions rather
    // than a stick's.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 5);
    ctx.fillStyle = color;
    ctx.lineJoin = 'round';
    // Blade: slightly taller than wide, sitting above the grip.
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.16, s * 0.30, s * 0.30, 0, 0, Math.PI * 2);
    ctx.fill();
    // Handle: overlaps the blade so the two read as one solid object, and
    // runs long enough to be a grip. A stub here just made the blade look
    // like a balloon — the handle is the whole silhouette cue.
    roundRectPath(ctx, -s * 0.08, s * 0.06, s * 0.16, s * 0.40, s * 0.06);
    ctx.fill();
    ctx.restore();
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
  tableSwatch(ctx, cx, cy, s, _color) {
    // Mini table (top view) filled in the CURRENT table color — same
    // stateful grammar as ballSwatch: the button reports the active state,
    // so the `color` arg is ignored on purpose. The white centre line is
    // what makes the glyph read "table" rather than a bare color chip.
    // Filled with the palette's `swatch` tint, not `base`: the real felt
    // colors are too dark to distinguish on the dark panel at button size,
    // which made the toggle look broken.
    const palette = TABLE_COLORS[getTableColorId()] || TABLE_COLORS.blue;
    const w = s * 0.94, h = s * 0.62;
    roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, s * 0.08);
    ctx.fillStyle = palette.swatch || palette.base;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy);
    ctx.lineTo(cx + w / 2, cy);
    ctx.stroke();
  },
  trophy(ctx, cx, cy, s, color) {
    // Competition-rules toggle glyph. Filled silhouette, not thin strokes:
    // at dock-button size under XR minification the stroked version broke
    // apart into a "Ψ" with floating parentheses.
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const cupW = s * 0.52;
    const rimY = cy - s * 0.42;
    const straight = s * 0.14;
    // Cup: filled rim + straight sides + round bottom.
    ctx.beginPath();
    ctx.moveTo(cx - cupW / 2, rimY);
    ctx.lineTo(cx + cupW / 2, rimY);
    ctx.lineTo(cx + cupW / 2, rimY + straight);
    ctx.arc(cx, rimY + straight, cupW / 2, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    // Handles: arcs overlapping the cup sides so they read attached.
    const hr = s * 0.12;
    ctx.beginPath(); ctx.arc(cx - cupW / 2 - hr * 0.55, rimY + hr, hr, -Math.PI / 2, Math.PI / 2, true); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + cupW / 2 + hr * 0.55, rimY + hr, hr, -Math.PI / 2, Math.PI / 2, false); ctx.stroke();
    // Stem + base plate.
    ctx.fillRect(cx - s * 0.05, cy - s * 0.06, s * 0.1, s * 0.28);
    ctx.fillRect(cx - s * 0.19, cy + s * 0.22, s * 0.38, s * 0.11);
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
    // Competition rules (ITTF-strict): strict 16cm serve toss + certified
    // table physics for the AI match. Persisted so the choice survives
    // sessions; storage can be absent/throwing in headless tests.
    this.competitionMode = false;
    try {
      this.competitionMode = localStorage.getItem('tt_competition_rules') === '1';
    } catch { /* no storage — default off */ }

    this.hoverProgress = 0;
    this.showProgress  = 0;
    this.pressProgress = 0;
    this.pokeCursor = null;
    // Hover-redraw throttle. Every draw() is a full-canvas repaint plus a
    // ~1.7 MB texture re-upload with mipmap rebuild, and laser jitter between
    // two adjacent buttons can flip setHovered every frame — so hover-driven
    // repaints are capped at one per HOVER_REDRAW_MIN_MS, with a deferred
    // flush in update(). Hover STATE always updates immediately; only the
    // repaint is throttled.
    this._lastDrawMs = -Infinity;
    this._hoverDrawPending = false;
    // Cached drift flag — driftDetector polled once per frame in update().
    // Only trigger a redraw when it flips (avoids per-frame canvas churn).
    this._driftFlagCache = false;
    // Resolved mode-tile font sizes, filled in on the first draw. Neither the
    // labels nor the circle geometry can change at runtime, so measuring once
    // is enough — and draw() runs on every hover tick, where re-measuring six
    // strings would be pure waste.
    this._modeFitCache = null;

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

    // Flush a hover repaint that setHovered deferred under the throttle.
    if (this._hoverDrawPending
        && performance.now() - this._lastDrawMs >= HOVER_REDRAW_MIN_MS) {
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
    const TOP_Y = 30;
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
    // 216, not 224: the row sat low enough that the crosshair ticks (which
    // reach CIRCLE_Y + 94) crowded the hover-caption line below them. Moving
    // it up 8px spends slack from the roomier gap under the difficulty pill.
    const CIRCLE_Y = 216;

    for (let i = 0; i < MODES.length; i++) {
      const cx = circleRowX + CIRCLE_R + i * (CIRCLE_R * 2 + CIRCLE_GAP);
      this.buttons.push({
        id: 'mode-' + MODES[i].id, kind: 'mode', index: i, modeId: MODES[i].id,
        shape: 'circle', cx, cy: CIRCLE_Y, r: CIRCLE_R,
      });
    }

    // --- Docks: a pair of 56px buttons on each side, sharing the mode row's
    // centreline. The two sides used to be one button on the left against
    // three on the right arranged in an L (two across, one hanging below
    // centred), which read as an unfinished layout rather than a deliberate
    // one — the eye has nothing to pair the lone left button with.
    //
    // The split is by what the button changes, so each side is one idea:
    //   left  — how the game plays (calibrate the bat, competition rules)
    //   right — how the table looks (table colour, ball colour)
    const DOCK = 56;
    const DOCK_GAP = 8;
    const DOCK_Y = CIRCLE_Y - DOCK / 2;
    const DOCK_MARGIN = 32;
    // Outer edges clear the mode row's crosshair ticks (which span
    // x ≈ 202…822) by 50px on both sides.
    const leftX  = DOCK_MARGIN;
    const rightX = CANVAS_W - DOCK_MARGIN - DOCK;

    this.buttons.push({
      id: 'calibrate', kind: 'dock', icon: 'paddle',
      shape: 'rect', x: leftX, y: DOCK_Y, w: DOCK, h: DOCK, radius: 15,
    });
    // Competition-rules toggle: trophy lit in the accent colour when ON.
    // Enables the strict ITTF serve-toss rule + certified table physics for
    // the AI match (see aiMatch competition wiring).
    this.buttons.push({
      id: 'rules', kind: 'dock', icon: 'trophy',
      shape: 'rect', x: leftX + DOCK + DOCK_GAP, y: DOCK_Y, w: DOCK, h: DOCK, radius: 15,
    });
    // Both swatch icons render in the CURRENT colour, so each button reports
    // its own state and needs no label. Clicks cycle the *_COLOR_ORDER lists
    // (orange ↔ white ball, blue ↔ green table — all ITTF legal).
    this.buttons.push({
      id: 'tableColor', kind: 'dock', icon: 'tableSwatch',
      shape: 'rect', x: rightX - DOCK - DOCK_GAP, y: DOCK_Y, w: DOCK, h: DOCK, radius: 15,
    });
    this.buttons.push({
      id: 'ballColor', kind: 'dock', icon: 'ballSwatch',
      shape: 'rect', x: rightX, y: DOCK_Y, w: DOCK, h: DOCK, radius: 15,
    });

    // Tune Physics exists only in dev sessions (?tuner / ?selftest — see
    // TUNER_ENABLED), so it gets the odd slot rather than displacing a
    // shipping button: centred under the left pair, where it mirrors nothing
    // and costs the production layout nothing. It cannot go beside them —
    // a third button in that row reaches the PLAY tile's ticks — nor flush
    // under `calibrate`, whose bottom-left corner would clip the capsule's
    // rounded end at x = 32.
    if (this.showTune) {
      this.buttons.push({
        id: 'tune', kind: 'dock', icon: 'gear',
        shape: 'rect', x: leftX + (DOCK + DOCK_GAP) / 2,
        y: DOCK_Y + DOCK + DOCK_GAP, w: DOCK, h: DOCK, radius: 15,
      });
    }

    // --- Bottom exit pill ---
    const EXIT_W = 100;
    const EXIT_H = 34;
    this.buttons.push({
      id: 'exit', kind: 'exit', label: 'EXIT',
      shape: 'rect', x: (CANVAS_W - EXIT_W) / 2, y: CANVAS_H - EXIT_H - 20, w: EXIT_W, h: EXIT_H,
    });
  }

  draw() {
    // Any repaint satisfies a pending hover redraw and restarts the throttle
    // window — the canvas is always painted whole.
    this._lastDrawMs = performance.now();
    this._hoverDrawPending = false;
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

    this.drawDockCaption();

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

  // One line naming the dock button under the cursor. Drawn after the button
  // pass so it is never overdrawn, and only while something is hovered — an
  // always-on caption would be dead text for the 90% of the time the laser
  // is on a mode circle.
  drawDockCaption() {
    const b = this.buttons.find((x) => x.kind === 'dock' && x.id === this.hovered);
    const base = b && DOCK_CAPTIONS[b.id];
    if (!base) return;
    // A stateful toggle also reports which way it is currently set: for the
    // trophy that is half of what the caption exists to answer, and the
    // accent/muted button tint alone doesn't read as ON vs OFF.
    const on = b.id === 'rules' && this.competitionMode;
    const text = b.id === 'rules' ? `${base}  ·  ${on ? 'ON' : 'OFF'}` : base;

    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = on ? ACCENT : COLORS.chromeMuted;
    ctx.font = FONT_CAPTION;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    // maxWidth keeps a long caption inside the capsule's waist (usable width
    // at this height is ~925px) instead of running off the rounded ends.
    ctx.fillText(text, CANVAS_W / 2, CAPTION_Y, CANVAS_W - 120);
    ctx.restore();
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
      drawIcon(ctx, cx, cy + MODE_ICON_DY, MODE_ICON_S, mode.ring);
      ctx.restore();
    }

    // Main label + subtitle (bottom of interior), at the one size that fits
    // every tile — see _modeTextFit.
    const fit = this._modeTextFit(b.r - 3);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = mode.ring;
    ctx.font = `700 ${fit.labelPx}px ${FONT_FAMILY}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${MODE_LABEL_LS}px`;
    ctx.fillText(mode.label, cx, cy + MODE_LABEL_DY);

    ctx.fillStyle = COLORS.chromeMuted;
    ctx.font = `600 ${fit.subPx}px ${FONT_FAMILY}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${MODE_SUB_LS}px`;
    ctx.fillText(mode.subtitle || '', cx, cy + MODE_SUB_DY);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  /**
   * Resolve the mode-tile label and subtitle sizes against the circle's
   * interior, once, and cache them.
   *
   * Canvas has no text-overflow: a line too wide for its container is simply
   * painted past it. "RALLY · DRILLS" measures 115px and was drawn where the
   * tile's chord is 110px, so the PLAY subtitle ran out over the ring on both
   * sides — the overlap this pass exists to fix. Measuring and stepping the
   * size down makes that structurally impossible for any future wording.
   *
   * The size is resolved across ALL tiles and the smallest wins, rather than
   * per tile: three subtitles at three different sizes in one row looks like
   * a bug even when each one individually fits.
   */
  _modeTextFit(R) {
    if (this._modeFitCache) return this._modeFitCache;
    const ctx = this.ctx;
    // Bound each line by the chord at its lowest glyph — roughly 40% of the
    // font size below the middle baseline for caps — inset from the ring.
    const labelMaxW = 2 * chordHalf(R, MODE_LABEL_DY + MODE_LABEL_PX * 0.4) - MODE_TEXT_INSET * 2;
    const subMaxW   = 2 * chordHalf(R, MODE_SUB_DY   + MODE_SUB_PX   * 0.4) - MODE_TEXT_INSET * 2;

    const fit = (texts, maxW, weight, size, spacing) => {
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
      let px = size;
      for (const t of texts) {
        if (!t) continue;
        while (px > MIN_FIT_PX) {
          ctx.font = `${weight} ${px}px ${FONT_FAMILY}`;
          if (ctx.measureText(t).width <= maxW) break;
          px -= 0.5;
        }
      }
      return px;
    };

    this._modeFitCache = {
      labelPx: fit(MODES.map((m) => m.label), labelMaxW, 700, MODE_LABEL_PX, MODE_LABEL_LS),
      subPx:   fit(MODES.map((m) => m.subtitle), subMaxW, 600, MODE_SUB_PX, MODE_SUB_LS),
    };
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    return this._modeFitCache;
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
    // maxWidth = the segment minus its selection-pill padding, so a label
    // that outgrows its third of the control condenses instead of running
    // under the neighbouring segment. "INTERNATIONAL" already uses 143 of
    // the 155 available.
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 - 1.5 * pp, b.w - 18);
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
    // The rules trophy is a stateful toggle: lit accent when competition
    // rules are on, muted when off — same visual grammar as the selected
    // difficulty segment. Icon tint alone was too subtle at dock size, so
    // ON also washes the button background in the accent.
    const rulesOn = b.id === 'rules' && this.competitionMode;
    if (rulesOn) {
      ctx.save();
      roundRectPath(ctx, b.x, dy, b.w, b.h, b.radius || 14);
      ctx.fillStyle = 'rgba(61,220,151,0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(61,220,151,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
    const drawIcon = ICONS[b.icon];
    const iconColor = b.id === 'rules'
      ? (rulesOn ? ACCENT : COLORS.chromeMuted)
      : COLORS.chromeText;
    if (drawIcon) drawIcon(ctx, b.x + b.w / 2, dy + b.h / 2, b.w * 0.62, iconColor);
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
    if (performance.now() - this._lastDrawMs >= HOVER_REDRAW_MIN_MS) {
      this.draw();
    } else {
      this._hoverDrawPending = true;
    }
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
      const competition = this.competitionMode;
      if (button.modeId === 'training') {
        // Opens the unified PLAY menu; what to play is chosen in there.
        this.emit('training', { difficulty: difficultyId });
      } else if (button.modeId === 'aiMatch') {
        this.emit('start', { drill: 'aiMatch', difficulty: difficultyId, options: { competition } });
      } else if (button.modeId === 'multiplayer') {
        // Competition physics is NOT applied in multiplayer yet — the two
        // peers would need to agree on it over the wire. Passed through so
        // the wiring exists when that handshake lands.
        this.emit('start', { drill: 'multiplayer', difficulty: difficultyId, options: { competition } });
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
    if (button.kind === 'dock' && button.id === 'rules') {
      this.competitionMode = !this.competitionMode;
      try {
        localStorage.setItem('tt_competition_rules', this.competitionMode ? '1' : '0');
      } catch { /* no storage — session-only toggle */ }
      this.emit('rules', { competition: this.competitionMode });
      this.draw();
      return;
    }
    if (button.kind === 'dock' && button.id === 'tableColor') {
      const currentId = getTableColorId();
      const idx = TABLE_COLOR_ORDER.indexOf(currentId);
      const nextId = TABLE_COLOR_ORDER[(idx + 1) % TABLE_COLOR_ORDER.length];
      this.emit('tableColor', { colorId: nextId });
      this.draw();  // refresh the swatch to the new color
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
