// In-XR menu panel — landscape "hub" layout inspired by modern MR game menus.
// CanvasTexture plane, world-billboarded ~1.1m in front of the camera by
// inGame.js's updateMenuPlacement.
//
// Composition (left → right):
//   - Left dock: how the game plays — Calibrate Paddle, Competition Rules.
//   - Center row: three large circular mode tiles (Play / AI / Multi),
//     each with a coloured crosshair ring, icon, main label + subtitle.
//   - Right dock: how it looks — Table Color, Ball Color — with Dominant
//     Hand centred beneath the pair.
//   - Top pills: difficulty segmented control, and match length (BEST OF).
//   - Below the tiles: hover caption naming the dock button under the cursor.
//   - Bottom pill: Exit.
//
// The two docks are deliberately the same size (2 × 56px each, sharing the
// mode row's centreline) — a lone button on one side against a cluster on the
// other reads as a layout that ran out of room. The hand button hangs
// centred under the right pair (a T, not an L): a third button IN the row
// would reach the MULTI tile's crosshair ticks.
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
import { BEST_OF_OPTIONS, loadBestOf, saveBestOf } from '../modes/matchFormat.js';

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
// Wording is "what it does", not "what it is", because that is the question
// a player hovering an unfamiliar icon is actually asking.
const DOCK_CAPTIONS = {
  tune:       'Tune Physics  —  live A/B on ball & paddle constants',
  calibrate:  'Calibrate Paddle  —  align the bat with your controller',
  ballColor:  'Ball Color  —  orange or white, both ITTF legal',
  tableColor: 'Table Color  —  blue or green, both ITTF approved',
  // Stateful: the live line is composed in drawDockCaption so it names the
  // CURRENT hand, which the icon alone shows only as one letter.
  dominantHand: 'Dominant Hand  —  which hand holds the paddle',
  // Stateful like the hand: the live line says whether the screen is up.
  mrBackdrop: 'Backdrop  —  a screen behind the far end that hides your room',
  help:       'Rules  —  how the serve, the rally and the score are judged',
};

// What the caption line says when nothing is hovered, which is most of the
// time the menu is open. States the one rule that costs a point on the first
// serve of the first match, and points at the ? for the rest.
const SERVE_RULE_CAPTION =
  'SERVE from behind your end line, toss 16 cm  ·  tap ? for all the rules';

// The rules card behind the ? dock button.
//
// The game enforces the service law — struck from behind your end line, above
// the surface, tossed 16 cm from an open palm, first bounce on your own half
// — and until now told the player none of it. The fault copy in faultText.js
// is written but only reaches the dev HUD log, so a player who serves from
// over the table just loses a point with no idea why. A rule you enforce has
// to be a rule you stated.
//
// Three columns because the rules fall into three groups a player asks about
// separately: how do I serve, what ends a rally, how do I win. Every line is
// what the code actually judges — nothing aspirational, nothing we don't
// enforce.
//
// Hard limits on the copy, both from drawHelp's geometry:
//   ~34 characters per line. The column's text width is ~257px at 16px, and
//   fillText's maxWidth CONDENSES rather than wraps, so a line written long
//   doesn't overflow — it silently squeezes, and a 14% horizontal squeeze on
//   one bullet in a column of five is more obvious than the extra words are
//   worth. Shorten the line instead.
//   6 bullets per column. The sixth ends at y=316 against the BACK pill's
//   top edge at 356; a seventh collides.
export const RULES_COLUMNS = Object.freeze([
  {
    title: 'SERVICE',
    points: [
      'Ball flat on an open palm',
      'Behind your end line',
      'Above the table, never below',
      'Toss it 16 cm straight up, no spin',
      'Strike it on the way down',
      'Your half first, then theirs',
    ],
  },
  {
    title: 'RALLY',
    points: [
      'Let it bounce before you hit it',
      'Hitting it early is a volley',
      'Landing on your own half loses it',
      'Don’t touch the net',
      'Clipping the net mid-rally is fine',
    ],
  },
  {
    title: 'SCORING',
    points: [
      'First to 11, win by 2',
      'Serve changes every 2 points',
      'At 10–10, every point',
      'Net-cord serve that lands = let',
      'Best of 1, 3 or 5 — your pick',
    ],
  },
]);

// Caption baseline. The band between the mode circles' crosshair ticks
// (which reach y = CIRCLE_Y + r + 14 = 310) and the top of the exit pill
// (y = CANVAS_H - EXIT_H - 20 = 356) is the only full-width gap in the
// layout; 332 centres an 18px line in it with ~13px clear on either side.
const CAPTION_Y = 332;

// The drill picker that used to live here is gone. Training is reached
// through the PLAY tile, which opens the Play menu (scene/trainingMenu.js):
// the Training Session's levels plus a Settings screen.

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
// PLAY opens the Training Session. The id stays 'training' because it is the
// stable event key inGame.js listens on.
const MODES = [
  { id: 'training',    label: 'PLAY',  ring: '#ffc857', icon: 'ballMachine', subtitle: 'TRAINING' },
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

  // Drawn as a glyph rather than as a path. Every other icon here is a
  // shape with no typographic equivalent; a question mark is a letterform,
  // and hand-pathing one at 35px only makes it worse than the font's.
  help(ctx, cx, cy, s, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `700 ${Math.round(s * 0.58)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // +1px: the glyph's optical centre sits above its box centre.
    ctx.fillText('?', cx, cy + 1);
    ctx.restore();
  },
  hand(ctx, cx, cy, s, color, hand) {
    // Dominant-hand glyph: one bold letter, L or R. It began as the letter
    // beside a small bat on the held side, but at dock size the bat shrank
    // to a dot-on-a-stick and the pair read as "R + magnifier". A single
    // letter is the one thing here that survives XR minification; the hover
    // caption names the setting and the current hand in full, the same way
    // the other icon-only dock buttons rely on theirs.
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `800 ${Math.round(s * 0.92)}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // +1px: optical centre, as for the ? glyph.
    ctx.fillText(hand === 'L' ? 'L' : 'R', cx, cy + 1);
    ctx.restore();
  },
  backdrop(ctx, cx, cy, s, color, on) {
    // Passthrough backdrop toggle: a wide screen standing behind a small
    // table seen end-on. Stateful in the swatch grammar — the screen is
    // FILLED while the backdrop is up and an outline while it is down, so
    // the button reports the current state without a label. The table in
    // front is always solid: it is the fixed point the screen is behind.
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = 2; ctx.lineJoin = 'round';
    const w = s * 0.92, h = s * 0.50;
    const top = cy - s * 0.44;
    roundRectPath(ctx, cx - w / 2, top, w, h, s * 0.05);
    if (on) ctx.fill(); else ctx.stroke();
    // Table: a slab plus two legs, wholly BELOW the screen with a gap. The
    // panel is one canvas, so a table cut out of a filled screen would have
    // to be composited through the button chrome; stacking them instead
    // keeps the table identical in both states and only the screen changes.
    const tw = s * 0.46, ty = top + h + s * 0.08, th = s * 0.08;
    ctx.fillRect(cx - tw / 2, ty, tw, th);
    ctx.fillRect(cx - tw / 2 + s * 0.04, ty + th, s * 0.06, s * 0.20);
    ctx.fillRect(cx + tw / 2 - s * 0.10, ty + th, s * 0.06, s * 0.20);
    ctx.restore();
  },
};

export class WristMenu {
  // `getDominantHand` reports the current 'L' / 'R' for the hand button's
  // icon and caption. Read on every draw rather than copied: the setting
  // also changes from the PLAY › SETTINGS screen and from first-swing
  // detection, and the button must show whichever is current. The menu
  // never writes it — like the colour swatches, a click only emits the next
  // value and inGame.js owns the store.
  // `showBackdrop` adds the passthrough backdrop toggle — MR sessions only,
  // the Focus Room has its own back wall — and `getBackdropOn` reports its
  // live state for the icon and caption, on the same read-don't-copy terms
  // as the hand: the menu emits the next value and inGame.js owns the store.
  constructor({
    showTune = TUNER_ENABLED, getDominantHand = () => 'R',
    showBackdrop = false, getBackdropOn = () => false,
  } = {}) {
    this.showTune = showTune;
    this.getDominantHand = getDominantHand;
    this.showBackdrop = showBackdrop;
    this.getBackdropOn = getBackdropOn;
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
      // Matches physicsTuner: with depthTest on, the
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
    // Competition rules — strict 16 cm serve toss + certified table physics —
    // used to be a trophy toggle here, defaulting off. It is now simply how
    // the AI match plays (see aiMatch's `competition` default), so there is
    // no state to hold and nothing to persist. A game that claims ITTF rules
    // should not ship with them behind an icon nobody can guess the meaning
    // of; the serve law is stated in the panel caption instead.
    // Match length for the AI match, and the default for any multiplayer room
    // this player hosts (the lobby reads the same stored preference). Best-of-5
    // to 11 is 20-40 minutes in a headset; this is how you ask for one game.
    this.bestOf = loadBestOf();

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
    this._formatPill = null;

    // The rules card is a second SCREEN on the same canvas, not an overlay:
    // it replaces the button set and the chrome rather than floating over
    // them. A translucent panel of text on top of a panel of controls is
    // unreadable in a headset, where the whole thing is already being read
    // through passthrough.
    this.helpOpen = false;

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
    // Reopening the menu lands on the main screen. A player who closed it
    // while reading the rules wants the controls back next time, not the
    // card they already read.
    if (this.helpOpen) {
      this.helpOpen = false;
      this.layoutButtons();
    }
  }

  // Swap screens: relay the buttons out, drop any hover held on a control
  // that no longer exists, and repaint.
  setHelpOpen(open) {
    if (this.helpOpen === open) return;
    this.helpOpen = open;
    this.hovered = null;
    this.hoverProgress = 0;
    this.layoutButtons();
    this.draw();
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
    // Rebuilt from scratch: this runs again on every screen change, and an
    // append-only layout would stack the main screen's buttons behind the
    // rules card's BACK pill and keep them clickable.
    this.buttons = [];

    // Rules screen: one BACK pill and nothing else. Nulling the pill chrome
    // is what keeps the difficulty/format containers from painting through
    // from the main screen — draw() gates on those fields, not on helpOpen.
    if (this.helpOpen) {
      this._diffPill = null;
      this._formatPill = null;
      const BACK_W = 110;
      const BACK_H = 34;
      this.buttons.push({
        id: 'help-close', kind: 'exit', label: 'BACK',
        shape: 'rect', x: (CANVAS_W - BACK_W) / 2, y: CANVAS_H - BACK_H - 20,
        w: BACK_W, h: BACK_H,
      });
      return;
    }

    // --- Top pill row: difficulty + match length ---
    // The drill picker that sat beside the difficulty control is gone; drills
    // are chosen inside the TRAINING menu now. The difficulty control stays
    // because it selects the AI tier for the match modes, which is independent
    // of training, and it keeps its full 520px: at 300px each segment was
    // 100px, which clipped "INTERNATIONAL" at any legible font size.
    //
    // Match length joins it as a second pill rather than a dock button because
    // it is a CHOICE OF THREE, not a toggle — the dock's icon-only tiles can
    // show two states at most, and "how many games" is not a guessable glyph.
    // The two pills centre as a group. The row is bounded by the capsule's
    // rounded left/right ends: at the pills' own vertical centre the capsule
    // is 136px wider on each side than it is at their top edge, and each
    // pill's rounded end pulls its corner inward by another 27px, so 800px of
    // row inside a 1024px canvas clears the sides with room to spare.
    const TOP_Y = 30;
    const TOP_H = 54;
    const PILL_GAP = 22;
    const diffW  = 520;
    // "BEST OF" is drawn as static chrome inside the pill: three segments
    // reading "1 / 3 / 5" are unambiguous with it and meaningless without.
    const FORMAT_LABEL_W = 96;
    const formatSegW = 54;
    const formatW = FORMAT_LABEL_W + BEST_OF_OPTIONS.length * formatSegW;
    const rowW = diffW + PILL_GAP + formatW;
    const rowX = (CANVAS_W - rowW) / 2;

    this._diffPill = { x: rowX, y: TOP_Y, w: diffW, h: TOP_H };

    const segW = diffW / 3;
    for (let i = 0; i < DIFFICULTIES.length; i++) {
      this.buttons.push({
        id: 'diff-' + i, kind: 'segment', index: i, label: DIFFICULTIES[i].label,
        shape: 'rect', x: rowX + i * segW, y: TOP_Y, w: segW, h: TOP_H,
      });
    }

    const formatX = rowX + diffW + PILL_GAP;
    this._formatPill = { x: formatX, y: TOP_Y, w: formatW, h: TOP_H, labelW: FORMAT_LABEL_W };
    for (let i = 0; i < BEST_OF_OPTIONS.length; i++) {
      const n = BEST_OF_OPTIONS[i];
      this.buttons.push({
        id: 'bestOf-' + n, kind: 'format', value: n, label: String(n),
        shape: 'rect', x: formatX + FORMAT_LABEL_W + i * formatSegW,
        y: TOP_Y, w: formatSegW, h: TOP_H,
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
    // The competition-rules trophy used to sit here. It is gone — ITTF rules
    // are always on, so it had nothing left to toggle — and the slot goes to
    // the rules card, which keeps the left dock as "how the game plays" and
    // keeps the pair-per-side balance the layout was built around.
    this.buttons.push({
      id: 'help', kind: 'dock', icon: 'help',
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
    // Dominant hand sits with the two swatches — the player-facing "set up
    // my game" cluster — rather than three screens deep in PLAY › SETTINGS
    // (which keeps its row; both write the same profile key). Centred under
    // the pair: a third button in the row would overlap the MULTI tile's
    // crosshair ticks (x ≈ 822), and hanging it flush under `ballColor`
    // would clip the capsule's rounded end. At y = 252…308 it clears the
    // caption line (text from y ≈ 323) and the capsule boundary (x ≈ 992 at
    // that height) with room to spare.
    this.buttons.push({
      id: 'dominantHand', kind: 'dock', icon: 'hand',
      shape: 'rect', x: rightX - (DOCK + DOCK_GAP) / 2,
      y: DOCK_Y + DOCK + DOCK_GAP, w: DOCK, h: DOCK, radius: 15,
    });
    // Passthrough backdrop, MR sessions only: beside the hand button on its
    // row, toward the centre. It belongs on this side — it is how the game
    // LOOKS — and this is the one slot left there: the top pair is bounded
    // by the capsule's end (x ≈ 992) and the hand's slot cannot move without
    // re-deriving the layout above. At x = 840…896 it clears the MULTI
    // tile's ring (which reaches x ≈ 799 at this height) by 40px. Same as
    // the dev-only Tune button, the layout is unchanged when it is absent.
    if (this.showBackdrop) {
      this.buttons.push({
        id: 'mrBackdrop', kind: 'dock', icon: 'backdrop',
        shape: 'rect', x: rightX - (DOCK + DOCK_GAP) / 2 - DOCK - DOCK_GAP,
        y: DOCK_Y + DOCK + DOCK_GAP, w: DOCK, h: DOCK, radius: 15,
      });
    }

    // Tune Physics exists only in dev sessions (?tuner / ?selftest — see
    // TUNER_ENABLED), so it gets the odd slot rather than displacing a
    // shipping button: centred under the left pair, mirroring the hand
    // button on the right, and costing the production layout nothing. It
    // cannot go beside them — a third button in that row reaches the PLAY
    // tile's ticks — nor flush under `calibrate`, whose bottom-left corner
    // would clip the capsule's rounded end at x = 32.
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

    // Match-length container, plus the "BEST OF" it is answering. The label is
    // chrome, not a button: tapping it would do nothing and it must not
    // hit-test away part of the "1" segment beside it.
    if (this._formatPill) {
      const p = this._formatPill;
      ctx.save();
      roundRectPath(ctx, p.x, p.y, p.w, p.h, p.h / 2);
      ctx.fillStyle = COLORS.chromeBg;
      ctx.fill();
      ctx.fillStyle = COLORS.chromeMuted;
      ctx.font = FONT_PILL;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
      // Centred in its own slot, not nudged inward: the text sits on the
      // pill's vertical centreline, where the rounded end is at full width.
      ctx.fillText('BEST OF', p.x + p.labelW / 2, p.y + p.h / 2 - 1, p.labelW - 16);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.restore();
    }

    if (this.helpOpen) this.drawHelp();

    // --- Buttons pass ---
    for (const b of this.buttons) {
      this.drawButton(b);
    }

    if (!this.helpOpen) this.drawDockCaption();

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

  // The rules card. Three columns of short bullets under a title, sized to
  // the same 1024x410 canvas the main screen uses.
  //
  // Column geometry is derived, not hand-placed, so the layout survives an
  // edit to RULES_COLUMNS: the three columns split the width inside a margin
  // wide enough to clear the capsule's rounded ends at bullet height.
  drawHelp() {
    const ctx = this.ctx;
    const MARGIN = 58;
    const colW = (CANVAS_W - MARGIN * 2) / RULES_COLUMNS.length;
    const TITLE_Y = 52;
    const HEAD_Y = 108;
    const FIRST_BULLET_Y = 146;
    const BULLET_STEP = 34;
    const DOT_R = 3;

    ctx.save();
    ctx.textBaseline = 'middle';

    ctx.textAlign = 'center';
    ctx.fillStyle = ACCENT;
    ctx.font = `700 24px ${FONT_FAMILY}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    ctx.fillText('ITTF RULES', CANVAS_W / 2, TITLE_Y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // Hairline under the title, fading at both ends so it doesn't collide
    // with the capsule's curve.
    const rule = ctx.createLinearGradient(MARGIN, 0, CANVAS_W - MARGIN, 0);
    rule.addColorStop(0, 'rgba(255,255,255,0)');
    rule.addColorStop(0.5, 'rgba(255,255,255,0.16)');
    rule.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rule;
    ctx.fillRect(MARGIN, TITLE_Y + 24, CANVAS_W - MARGIN * 2, 1);

    RULES_COLUMNS.forEach((col, i) => {
      const x = MARGIN + colW * i + 18;

      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.chromeMuted;
      ctx.font = `700 14px ${FONT_FAMILY}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
      ctx.fillText(col.title, x, HEAD_Y);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

      ctx.font = `500 16px ${FONT_FAMILY}`;
      col.points.forEach((line, j) => {
        const y = FIRST_BULLET_Y + j * BULLET_STEP;
        ctx.fillStyle = ACCENT;
        ctx.beginPath();
        ctx.arc(x + DOT_R, y, DOT_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = COLORS.chromeText;
        // maxWidth is a backstop, not the layout: every line in
        // RULES_COLUMNS is written to fit inside it uncondensed.
        ctx.fillText(line, x + DOT_R * 2 + 10, y, colW - 46);
      });
    });

    ctx.restore();
  }

  // One line naming the dock button under the cursor. Drawn after the button
  // pass so it is never overdrawn, and only while something is hovered — an
  // always-on caption would be dead text for the 90% of the time the laser
  // is on a mode circle.
  drawDockCaption() {
    const b = this.buttons.find((x) => x.kind === 'dock' && x.id === this.hovered);
    // Falls back to the service law rather than going blank — see
    // SERVE_RULE_CAPTION. Hovering a dock button still wins, because that is
    // an answer to a question the player just asked.
    let text = (b && DOCK_CAPTIONS[b.id]) || SERVE_RULE_CAPTION;
    if (b && b.id === 'dominantHand') {
      const hand = this.getDominantHand() === 'L' ? 'Left' : 'Right';
      text = `Dominant Hand  —  ${hand}  ·  tap to switch, the paddle follows`;
    }
    if (b && b.id === 'mrBackdrop') {
      text = this.getBackdropOn()
        ? 'Backdrop  —  On  ·  tap to see your room past the far end again'
        : 'Backdrop  —  Off  ·  tap for a screen behind the far end that hides your room';
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = COLORS.chromeMuted;
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
      case 'format':  return this.drawSegment(b, hp, pp);
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

  // Both segmented controls draw identically — only the question of "which
  // one is selected" differs, so the two pills stay visually consistent by
  // construction rather than by two functions being kept in step.
  drawSegment(b, hp, pp) {
    const ctx = this.ctx;
    const isSelected = b.kind === 'format'
      ? b.value === this.bestOf
      : b.index === this.selectedDifficultyIndex;
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
    // Every dock button is now stateless — the accent wash and the ON/OFF
    // icon tint that lived here existed only for the competition-rules
    // trophy, which is gone.
    const drawIcon = ICONS[b.icon];
    if (drawIcon) {
      // The hand letter and the backdrop screen are the icons whose state
      // lives outside this module.
      let state;
      if (b.id === 'dominantHand') state = this.getDominantHand();
      else if (b.id === 'mrBackdrop') state = !!this.getBackdropOn();
      drawIcon(ctx, b.x + b.w / 2, dy + b.h / 2, b.w * 0.62, COLORS.chromeText, state);
    }
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
    // Screen changes come first: both re-lay the buttons out under us, so
    // nothing below may hold a reference to the button it was handed.
    if (button.kind === 'dock' && button.id === 'help') {
      this.setHelpOpen(true);
      return;
    }
    if (button.id === 'help-close') {
      this.setHelpOpen(false);
      return;
    }
    if (button.kind === 'segment') {
      this.selectedDifficultyIndex = button.index;
      this.draw();
      return;
    }
    if (button.kind === 'format') {
      // Persisted immediately: the multiplayer lobby reads this same stored
      // value as the default format for a room the player hosts, and it may
      // be opened from the 2D start screen in a later session.
      this.bestOf = saveBestOf(button.value);
      this.emit('bestOf', { bestOf: this.bestOf });
      this.draw();
      return;
    }
    if (button.kind === 'mode') {
      const difficultyId = DIFFICULTIES[this.selectedDifficultyIndex].id;
      const bestOf = this.bestOf;
      if (button.modeId === 'training') {
        // Opens the unified PLAY menu; what to play is chosen in there.
        this.emit('training', { difficulty: difficultyId });
      } else if (button.modeId === 'aiMatch') {
        this.emit('start', { drill: 'aiMatch', difficulty: difficultyId, options: { bestOf } });
      } else if (button.modeId === 'multiplayer') {
        // Competition physics is NOT applied in multiplayer — the two peers
        // would need to agree on it over the wire. The flag used to be passed
        // through here for a handshake that never landed, and multiplayer.js
        // never read it, so it is no longer sent.
        //
        // Match length is deliberately NOT passed here: online, the format
        // belongs to whoever created the room, and it reaches the drill on the
        // lobby's connection bundle. Sending it from the tile as well would
        // give the guest a second, losing opinion.
        this.emit('start', { drill: 'multiplayer', difficulty: difficultyId, options: {} });
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
    if (button.kind === 'dock' && button.id === 'dominantHand') {
      // Two values, so a tap is a toggle. The store coerces anything odd back
      // to a legal value, and the redraw reads the result through the getter
      // rather than assuming the write took.
      const next = this.getDominantHand() === 'L' ? 'R' : 'L';
      this.emit('dominantHand', { hand: next });
      this.draw();  // refresh the letter / bat side and the caption
      return;
    }
    if (button.kind === 'dock' && button.id === 'mrBackdrop') {
      // A toggle: emits the OTHER state, and the redraw reads the result
      // back through the getter once inGame.js has stored it.
      this.emit('mrBackdrop', { on: !this.getBackdropOn() });
      this.draw();  // refresh the screen fill and the caption
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
