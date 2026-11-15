// In-XR menu panel — landscape "hub" layout inspired by modern MR game menus.
// CanvasTexture plane, world-billboarded ~1.1m in front of the camera by
// inGame.js's updateMenuPlacement.
//
// Composition (left → right):
//   - Left dock: Rules (?).
//   - Center row: three large circular mode tiles (Play / AI / Multi),
//     each with a coloured crosshair ring, icon, main label + subtitle.
//   - Right dock: Settings (gear).
//   - Top pills: difficulty segmented control, and match length (BEST OF).
//     On the free version (js/account/tier.js) INTERNATIONAL, ELITE and best
//     of 3 / 5 carry a padlock; tapping one says so on the caption line
//     instead of selecting it.
//   - Below the tiles: hover caption naming the dock button under the cursor.
//   - Bottom pill: Exit.
//
// Three screens share the one canvas: the main controls above, the rules
// card behind ?, and the Settings page behind the gear — ball colour, table
// colour, dominant hand, MR backdrop, Paddle Fit (and Tune Physics in dev
// sessions) as a row of labelled tiles. They used to be icon-only dock
// buttons, and the dock ran out of room for them.
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
import { drawPadlock } from './panelStyle.js';
import {
  canUseAiLevel, canUseBestOf, effectiveAiLevel, effectiveBestOf, onTierChange, LOCKED,
} from '../account/tier.js';

// How long the "that is in the full game" line holds the caption after a tap
// on a locked segment.
const LOCK_NOTICE_MS = 4000;

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
  lockNotice:     '#ffc857',
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
// The radius every constant above was tuned at. Tiles laid out smaller are
// drawn at this radius and scaled down (drawModeCircle).
const MODE_DESIGN_R = 80;
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
  settings:   'Settings  —  ball, table, hand, foul rules, backdrop, paddle fit',
  help:       'Rules  —  how the serve, the rally and the score are judged',
};

// What the caption line says when nothing is hovered, which is most of the
// time the menu is open. States the one rule that costs a point on the first
// serve of the first match, and points at the ? for the rest.
const SERVE_RULE_CAPTION =
  'SERVE from behind your end line, toss 16 cm  ·  tap ? for all the rules';
// ...unless the player switched foul calls off, when that law isn't enforced.
const FREE_PLAY_CAPTION =
  'FREE PLAY  —  foul rules are off  ·  Settings › Foul Rules to turn them on';

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
  // Opens the Tournament menu (js/modes/tournament/). The label is CUP
  // because every tile label shares one fitted size (_modeTextFit), and
  // "TOURNAMENT" at label size would shrink all four.
  { id: 'tournament',  label: 'CUP',   ring: '#7aa2ff', icon: 'trophy',      subtitle: 'TOURNAMENT' },
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
  whistle(ctx, cx, cy, s, color, on) {
    // Foul Rules toggle: a referee's whistle — barrel, mouthpiece, ring.
    // Same stateful grammar as the backdrop: the barrel is FILLED while
    // fouls are called and an outline in free play.
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = 2; ctx.lineJoin = 'round';
    const r = s * 0.26;
    const bx = cx - s * 0.08, by = cy + s * 0.08;
    // Barrel and mouthpiece as one outline so the stroked state has no seam.
    ctx.beginPath();
    ctx.arc(bx, by, r, Math.PI * 0.5, Math.PI * 2, false);
    ctx.lineTo(cx + s * 0.44, by - r);
    ctx.lineTo(cx + s * 0.44, by - r * 0.35);
    ctx.lineTo(bx + r * 0.85, by - r * 0.35);
    ctx.arc(bx, by, r, -Math.PI * 0.05, Math.PI * 0.5, false);
    ctx.closePath();
    if (on) ctx.fill(); else ctx.stroke();
    // Lanyard ring on top of the barrel.
    ctx.beginPath();
    ctx.arc(bx - r * 0.35, by - r * 1.35, s * 0.08, 0, Math.PI * 2);
    ctx.stroke();
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

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

// The Settings page's tiles, in display order. Ids are the same ones the dock
// buttons used, so activate() and every listener in inGame.js are unchanged.
// `value(menu)` is read on every draw — like the swatch icons, each tile
// reports the CURRENT state, which can also change from PLAY › SETTINGS or
// first-swing detection. `when` gates the session-specific tiles.
const SETTINGS_TILES = [
  { id: 'ballColor',    icon: 'ballSwatch',  label: 'Ball Color',
    value: () => capitalize(getBallColorId()) },
  { id: 'tableColor',   icon: 'tableSwatch', label: 'Table Color',
    value: () => capitalize(getTableColorId()) },
  { id: 'dominantHand', icon: 'hand',        label: 'Dominant Hand',
    value: (m) => (m.getDominantHand() === 'L' ? 'Left' : 'Right') },
  { id: 'foulRules',    icon: 'whistle',     label: 'Foul Rules',
    value: (m) => (m.getFoulRulesOn() ? 'On' : 'Off · Free') },
  { id: 'mrBackdrop',   icon: 'backdrop',    label: 'Backdrop',
    value: (m) => (m.getBackdropOn() ? 'On' : 'Off'), when: (m) => m.showBackdrop },
  { id: 'calibrate',    icon: 'paddle',      label: 'Paddle Fit',
    value: (m) => (m._driftFlagCache ? 'Recheck ›' : 'Adjust ›') },
  { id: 'tune',         icon: 'gear',        label: 'Tune Physics',
    value: () => 'Dev ›', when: (m) => m.showTune },
];

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
  // `getFoulRulesOn` is the Foul Rules toggle's state, on the same terms.
  constructor({
    showTune = TUNER_ENABLED, getDominantHand = () => 'R',
    showBackdrop = false, getBackdropOn = () => false,
    getFoulRulesOn = () => true,
  } = {}) {
    this.showTune = showTune;
    this.getDominantHand = getDominantHand;
    this.getFoulRulesOn = getFoulRulesOn;
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
    // { text, untilMs } after a tap on a locked segment; the caption shows it.
    this.lockNotice = null;
    // An /api/me answer can land while the menu is up (it is fetched on an
    // idle moment): repaint so the padlocks match, and step off a tier that
    // just became locked.
    this._offTier = onTierChange(() => {
      const current = DIFFICULTIES[this.selectedDifficultyIndex].id;
      const allowed = DIFFICULTIES.findIndex((d) => d.id === effectiveAiLevel(current));
      this.selectedDifficultyIndex = Math.max(0, allowed);
      this.draw();
    });

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

    // The rules card and the Settings page are SCREENS on the same canvas,
    // not overlays: each replaces the button set and the chrome rather than
    // floating over them. A translucent panel of text on top of a panel of
    // controls is unreadable in a headset, where the whole thing is already
    // being read through passthrough. 'main' | 'help' | 'settings'.
    this.screen = 'main';

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
    // card they already read. (inGame.js reopens Settings explicitly after
    // Paddle Fit, which was launched from there.)
    if (this.screen !== 'main') {
      this.screen = 'main';
      this.layoutButtons();
    }
  }

  get helpOpen() { return this.screen === 'help'; }
  get settingsOpen() { return this.screen === 'settings'; }

  // Swap screens: relay the buttons out, drop any hover held on a control
  // that no longer exists, and repaint.
  setScreen(screen) {
    if (this.screen === screen) return;
    this.screen = screen;
    this.hovered = null;
    this.hoverProgress = 0;
    this.layoutButtons();
    this.draw();
  }
  setHelpOpen(open) {
    if (open) this.setScreen('help');
    else if (this.screen === 'help') this.setScreen('main');
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

    // The locked-segment notice ran its course: back to the usual caption.
    if (this.lockNotice && performance.now() >= this.lockNotice.untilMs) {
      this.lockNotice = null;
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

    // Rules and Settings screens: their own content plus one BACK pill.
    // Nulling the pill chrome is what keeps the difficulty/format containers
    // from painting through from the main screen — draw() gates on those
    // fields, not on the screen.
    if (this.screen !== 'main') {
      this._diffPill = null;
      this._formatPill = null;
      if (this.screen === 'settings') this.layoutSettingsTiles();
      const BACK_W = 110;
      const BACK_H = 34;
      this.buttons.push({
        id: this.screen === 'help' ? 'help-close' : 'settings-close', kind: 'exit', label: 'BACK',
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
    // Four tiles (PLAY, AI, MULTI, CUP) in the same 592px span the three-tile
    // row used, so the row's crosshair ticks still clear the Rules and
    // Settings docks (x ≈ 202…822). The tiles draw at MODE_DESIGN_R and scale
    // down to this radius. Row centre sits midway between the difficulty
    // pill's bottom and the exit pill's top.
    const CIRCLE_R = 65;
    const CIRCLE_GAP = 24;
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

    // --- Docks: one 56px button on each side, on the mode row's centreline,
    // each centred where the old pair of buttons was. Rules on the left,
    // Settings on the right; everything Settings holds used to be icon-only
    // dock buttons here (see SETTINGS_TILES). Both clear the mode row's
    // crosshair ticks (x ≈ 202…822) by 80px.
    const DOCK = 56;
    const DOCK_GAP = 8;
    const DOCK_Y = CIRCLE_Y - DOCK / 2;
    const DOCK_MARGIN = 32;
    const leftX  = DOCK_MARGIN + (DOCK + DOCK_GAP) / 2;
    const rightX = CANVAS_W - DOCK_MARGIN - DOCK - (DOCK + DOCK_GAP) / 2;

    this.buttons.push({
      id: 'help', kind: 'dock', icon: 'help',
      shape: 'rect', x: leftX, y: DOCK_Y, w: DOCK, h: DOCK, radius: 15,
    });
    this.buttons.push({
      id: 'settings', kind: 'dock', icon: 'gear',
      shape: 'rect', x: rightX, y: DOCK_Y, w: DOCK, h: DOCK, radius: 15,
    });

    // --- Bottom exit pill ---
    const EXIT_W = 100;
    const EXIT_H = 34;
    this.buttons.push({
      id: 'exit', kind: 'exit', label: 'EXIT',
      shape: 'rect', x: (CANVAS_W - EXIT_W) / 2, y: CANVAS_H - EXIT_H - 20, w: EXIT_W, h: EXIT_H,
    });
  }

  // One centred row of tiles between the title and the BACK pill. Width is
  // derived from the tile count (5 in VR, 6 in MR, +1 in dev sessions) inside
  // a margin that clears the capsule's rounded ends at the tiles' top and
  // bottom edges (≈ 20px inset at y = 120), so no count clips.
  layoutSettingsTiles() {
    const tiles = SETTINGS_TILES.filter((t) => !t.when || t.when(this));
    // Seven tiles (MR + dev Tune) only stay ≥ 120px — a laser target — by
    // tightening the margin to the capsule's 40px limit and the gaps.
    const crowded = tiles.length > 6;
    const MARGIN = crowded ? 44 : 70;
    const GAP = crowded ? 12 : 18;
    const TILE_MAX_W = 150;
    const TILE_Y = 120;
    const TILE_H = 180;
    const w = Math.min(TILE_MAX_W, (CANVAS_W - MARGIN * 2 - GAP * (tiles.length - 1)) / tiles.length);
    const rowW = tiles.length * w + (tiles.length - 1) * GAP;
    const x0 = (CANVAS_W - rowW) / 2;
    tiles.forEach((t, i) => {
      this.buttons.push({
        id: t.id, kind: 'tile', icon: t.icon, label: t.label, tile: t,
        shape: 'rect', x: x0 + i * (w + GAP), y: TILE_Y, w, h: TILE_H, radius: 18,
      });
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

    if (this.screen === 'help') this.drawHelp();
    else if (this.screen === 'settings') this.drawScreenTitle('SETTINGS');

    // --- Buttons pass ---
    for (const b of this.buttons) {
      this.drawButton(b);
    }

    if (this.screen === 'main') this.drawDockCaption();

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
    const HEAD_Y = 108;
    const FIRST_BULLET_Y = 146;
    const BULLET_STEP = 34;
    const DOT_R = 3;

    this.drawScreenTitle('ITTF RULES');

    ctx.save();
    ctx.textBaseline = 'middle';

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

  // Accent title plus a hairline under it, shared by the rules card and the
  // Settings page so the two secondary screens read as one family.
  drawScreenTitle(title) {
    const ctx = this.ctx;
    const MARGIN = 58;
    const TITLE_Y = 52;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = ACCENT;
    ctx.font = `700 24px ${FONT_FAMILY}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    ctx.fillText(title, CANVAS_W / 2, TITLE_Y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // Hairline under the title, fading at both ends so it doesn't collide
    // with the capsule's curve.
    const rule = ctx.createLinearGradient(MARGIN, 0, CANVAS_W - MARGIN, 0);
    rule.addColorStop(0, 'rgba(255,255,255,0)');
    rule.addColorStop(0.5, 'rgba(255,255,255,0.16)');
    rule.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rule;
    ctx.fillRect(MARGIN, TITLE_Y + 24, CANVAS_W - MARGIN * 2, 1);
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
    const notice = this.lockNotice && performance.now() < this.lockNotice.untilMs
      ? this.lockNotice.text : null;
    const text = notice
      || (b && DOCK_CAPTIONS[b.id])
      || (this.getFoulRulesOn() ? SERVE_RULE_CAPTION : FREE_PLAY_CAPTION);

    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = notice ? COLORS.lockNotice : COLORS.chromeMuted;
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
      case 'tile':    return this.drawTile(b, hp, pp);
      case 'exit':    return this.drawExit(b, hp, pp);
    }
  }

  drawModeCircle(b, hp, pp) {
    const ctx = this.ctx;
    const mode = MODES[b.index];
    const lift = -3 * hp + 1.5 * pp;
    // The tile is drawn at its design radius and scaled to the laid-out one,
    // so icon, label and subtitle shrink together with the circle. The row
    // went from three tiles to four (TOURNAMENT); scaling keeps every
    // proportion the three-tile design was tuned at.
    const k = b.r / MODE_DESIGN_R;
    ctx.save();
    ctx.translate(b.cx, b.cy + lift);
    ctx.scale(k, k);
    const cx = 0;
    const cy = 0;
    const r = MODE_DESIGN_R;
    const R = r - 3;

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
    const tickIn  = r + 2;
    const tickOut = r + 14;
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
    const fit = this._modeTextFit(R);
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
    ctx.restore();
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
      ? b.value === effectiveBestOf(this.bestOf)
      : b.index === this.selectedDifficultyIndex;
    const locked = this.isLocked(b);
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
    ctx.fillStyle = isSelected
      ? COLORS.segmentSelText
      : (locked ? COLORS.chromeMuted : COLORS.chromeText);
    ctx.font = FONT_PILL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
    // maxWidth = the segment minus its selection-pill padding, so a label
    // that outgrows its third of the control condenses instead of running
    // under the neighbouring segment. "INTERNATIONAL" already uses 143 of
    // the 155 available.
    //
    // A locked difficulty gives up room on the right for the padlock. On a
    // best-of digit the lock sits at the number's top right instead: the
    // 54px segment has no room beside it.
    const cy = b.y + b.h / 2 - 1.5 * pp;
    if (locked && b.kind === 'segment') {
      const LOCK_W = 18;
      const maxW = b.w - 18 - LOCK_W;
      const textCx = b.x + b.w / 2 - LOCK_W / 2;
      ctx.fillText(b.label, textCx, cy, maxW);
      const half = Math.min(ctx.measureText(b.label).width, maxW) / 2;
      drawPadlock(ctx, textCx + half + LOCK_W / 2 + 2, cy, 12, COLORS.chromeMuted);
    } else {
      ctx.fillText(b.label, b.x + b.w / 2, cy, b.w - 18);
      if (locked) drawPadlock(ctx, b.x + b.w / 2 + 12, cy - 11, 9, COLORS.chromeMuted);
    }
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  /** A difficulty or match-length segment that is in the full game only. */
  isLocked(b) {
    if (b.kind === 'format') return !canUseBestOf(b.value);
    if (b.kind === 'segment') return !canUseAiLevel(DIFFICULTIES[b.index].id);
    return false;
  }

  showLockNotice(text) {
    this.lockNotice = { text, untilMs: performance.now() + LOCK_NOTICE_MS };
    this.draw();
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
    // Calibration drift badge (spec §C8). Paddle Fit lives behind the gear
    // now, so the gear carries the hint on the main screen and the tile
    // carries it inside Settings.
    if (b.id === 'settings' && this._driftFlagCache) this.drawDriftBadge(b.x + b.w - 8, dy + 8);
  }

  drawDriftBadge(x, y) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#ffcc33';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Settings tile: the dock button's chrome at tile size, with the icon on
  // top, the setting's name, and its CURRENT value in the accent colour —
  // the label the 56px dock buttons never had room for.
  drawTile(b, hp, pp) {
    const ctx = this.ctx;
    const lift = -2 * hp + 1 * pp;
    const dy = b.y + lift;
    const cx = b.x + b.w / 2;
    ctx.save();
    ctx.shadowColor = COLORS.buttonShadow;
    ctx.shadowBlur = 8 + 6 * hp;
    ctx.shadowOffsetY = 3 + 1 * hp;
    roundRectPath(ctx, b.x, dy, b.w, b.h, b.radius || 18);
    ctx.fillStyle = hp > 0 ? COLORS.chromeHoverBg : COLORS.chromeBg;
    ctx.fill();
    ctx.restore();

    const drawIcon = ICONS[b.icon];
    if (drawIcon) {
      // The hand letter and the backdrop screen are the icons whose state
      // lives outside this module.
      let state;
      if (b.id === 'dominantHand') state = this.getDominantHand();
      else if (b.id === 'mrBackdrop') state = !!this.getBackdropOn();
      else if (b.id === 'foulRules') state = !!this.getFoulRulesOn();
      ctx.save();
      drawIcon(ctx, cx, dy + 64, 64, COLORS.chromeText, state);
      ctx.restore();
    }

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.chromeText;
    ctx.font = `700 17px ${FONT_FAMILY}`;
    ctx.fillText(b.label, cx, dy + 126, b.w - 16);
    ctx.fillStyle = ACCENT;
    ctx.font = `600 16px ${FONT_FAMILY}`;
    ctx.fillText(b.tile.value(this), cx, dy + 152, b.w - 16);
    ctx.restore();

    if (b.id === 'calibrate' && this._driftFlagCache) this.drawDriftBadge(b.x + b.w - 12, dy + 12);
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
    if (button.id === 'settings') {
      this.setScreen('settings');
      return;
    }
    if (button.id === 'settings-close') {
      this.setScreen('main');
      return;
    }
    if ((button.kind === 'segment' || button.kind === 'format') && this.isLocked(button)) {
      const feature = button.kind === 'format' ? 'bestOf' : 'aiLevel';
      this.showLockNotice(LOCKED[feature].head);
      this.emit('locked', { feature });
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
      // What the tier allows, whatever was stored: a best-of-5 saved while
      // the full game was unlocked plays as a single game on the free one.
      const difficultyId = effectiveAiLevel(DIFFICULTIES[this.selectedDifficultyIndex].id);
      const bestOf = effectiveBestOf(this.bestOf);
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
      } else if (button.modeId === 'tournament') {
        // Opens the Tournament menu. Each tournament sets its own AI tier
        // and match length, so neither pill above applies here.
        this.emit('tournament');
      }
      return;
    }
    if (button.id === 'tune') {
      this.emit('tune');
      return;
    }
    if (button.id === 'calibrate') {
      this.emit('calibrate');
      return;
    }
    if (button.id === 'tableColor') {
      const currentId = getTableColorId();
      const idx = TABLE_COLOR_ORDER.indexOf(currentId);
      const nextId = TABLE_COLOR_ORDER[(idx + 1) % TABLE_COLOR_ORDER.length];
      this.emit('tableColor', { colorId: nextId });
      this.draw();  // refresh the swatch to the new color
      return;
    }
    if (button.id === 'ballColor') {
      const currentId = getBallColorId();
      const idx = BALL_COLOR_ORDER.indexOf(currentId);
      const nextId = BALL_COLOR_ORDER[(idx + 1) % BALL_COLOR_ORDER.length];
      this.emit('ballColor', { colorId: nextId });
      this.draw();  // refresh the swatch to the new color
      return;
    }
    if (button.id === 'dominantHand') {
      // Two values, so a tap is a toggle. The store coerces anything odd back
      // to a legal value, and the redraw reads the result through the getter
      // rather than assuming the write took.
      const next = this.getDominantHand() === 'L' ? 'R' : 'L';
      this.emit('dominantHand', { hand: next });
      this.draw();  // refresh the letter / bat side and the caption
      return;
    }
    if (button.id === 'foulRules') {
      // A toggle, like the backdrop: emit the other state, read it back.
      this.emit('foulRules', { on: !this.getFoulRulesOn() });
      this.draw();  // refresh the whistle fill and the caption
      return;
    }
    if (button.id === 'mrBackdrop') {
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
    if (this._offTier) { this._offTier(); this._offTier = null; }
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
