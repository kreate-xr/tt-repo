// Shared "SportyXR" broadcast scoreboard layout, drawn onto a 2D canvas.
//
// Both scoreboard surfaces — the floating/wall panel (scoreboard.js) and the
// stadium's built-in TV meshes (stadiumScoreboard.js) — render the exact same
// layout; only the mesh/material plumbing differs. This module owns the
// canvas drawing and the default state shape so the two can never drift.
//
// Layout (canvas 2048×1024, esport-broadcast style):
//   ┌──────────────────────────────────────────────────────┐
//   │                    🏓 SportyXR                        │
//   │ ╔═ blue panel ═╗        VS        ╔═ red panel ═╗    │
//   │ ║ ◉ PLAYER 1   ║   [BEST OF 5]    ║   PLAYER 2 ◉ ║   │
//   │ ║     11       ║                  ║      09      ║   │
//   │ ╚══════════════╝                  ╚══════════════╝   │
//   │  GAME 1 · GAME 2 · GAME 3 · GAME 4 · GAME 5          │
//   │  11-8     11-9     9-11    11-7     11-9              │
//   │  ⊕ SHOTS HIT     ◷ TOTAL TIME     ★ TOTAL POINTS     │
//   │      102             15:42             120            │
//   └──────────────────────────────────────────────────────┘
//
// The canvas is 16:9 — same as the SportyXR mock AND the stadium's Screen
// quad (1.359×0.770 m in the GLB), so the venue TV shows it without any
// stretch. The floating panel derives its physical height from this ratio.
// 2048-wide rather than the old 1024 — this layout is much denser, and the
// games/stats rows need the extra texels to stay crisp at VR distances.

export const LAYOUT_W = 2048;
export const LAYOUT_H = 1152;

// Palette — blue side = player, red side = AI, per the SportyXR mock.
//
// Exported as one object because the end-of-match report (matchReportLayout.js)
// is the same broadcast surface seen at the end of the match it summarises. Two
// private copies of these hexes is exactly how the board and the report would
// drift into looking like two different products, one colour at a time.
export const BOARD_COLORS = Object.freeze({
  blue: '#3b82f6',
  blueBright: '#4d8bff',
  red: '#ef4444',
  redBright: '#ff4d64',
  textDim: '#c3cde8',
  gold: '#f5b83d',
  purple: '#8b5cf6',
  green: '#22c55e',
});

const BLUE = BOARD_COLORS.blue;
const BLUE_BRIGHT = BOARD_COLORS.blueBright;
const RED = BOARD_COLORS.red;
const RED_BRIGHT = BOARD_COLORS.redBright;
const TEXT_DIM = BOARD_COLORS.textDim;
const GOLD = BOARD_COLORS.gold;
const PURPLE = BOARD_COLORS.purple;
const GREEN = BOARD_COLORS.green;

export const FONT = 'system-ui, sans-serif';

// Stat values render both on the base canvas (drawStat) and on the floating
// panel's clock overlay (renderClockValue) — one constant so they can't drift.
const STAT_VALUE_FONT = `bold 84px ${FONT}`;

// Content margins. The games-history row, the stats row and the accent bar all
// span these, so they are the outer edge of everything on the board.
const ROW_X0 = 36;
const ROW_X1 = 2012;

// Side-panel bounds, and with them the width of the centre column.
//
// The centre column carries three things stacked: VS (140px), the
// best-of/callout badge (up to 392px for MATCH POINT), and the games tally
// (213px at bold 80px). The panels used to run to 950 / 1098, leaving that
// column just 148px — so the badge sat across both panel borders and the
// tally painted its two digits directly on top of the panel gradients. The
// column is now sized for its widest occupant with ~24px to spare.
const PANEL_GAP = 440;
const PANEL_W = (ROW_X1 - ROW_X0 - PANEL_GAP) / 2;   // 768
const BLUE_X0 = ROW_X0,            BLUE_X1 = ROW_X0 + PANEL_W;         // 36 … 804
const RED_X0  = BLUE_X1 + PANEL_GAP, RED_X1 = ROW_X1;                  // 1244 … 2012

// Largest font size at which `text` fits `maxW`, stepping down from `size`
// and never below `min`. Canvas has no text-overflow — it paints straight
// past its container — so anything whose width depends on runtime data (match
// banners, player names) has to be measured rather than assumed to fit.
// Leaves ctx.font set to the returned size.
function fitPx(ctx, text, maxW, weight, size, min) {
  let px = size;
  while (px > min) {
    ctx.font = `${weight} ${px}px ${FONT}`;
    if (ctx.measureText(text).width <= maxW) break;
    px -= 2;
  }
  ctx.font = `${weight} ${px}px ${FONT}`;
  return px;
}

export function createScoreboardState(config = {}) {
  return {
    playerScore: 0,
    aiScore: 0,
    playerGames: 0,
    aiGames: 0,
    currentServer: 'ai',
    matchOverBanner: null,
    bestOf: config.bestOf ?? 5,
    playerName: config.playerName ?? 'PLAYER 1',
    aiName: config.aiName ?? 'AI',
    // Finished games in order: [{ playerScore, aiScore }]. The in-progress
    // game renders live in slot gameHistory.length from playerScore/aiScore.
    gameHistory: [],
    shotsHit: 0,
    elapsedMs: 0,
    // Fastest outgoing ball speed off the player's paddle this match, km/h.
    topSpeedKmh: 0,
  };
}

// Region of the TOTAL TIME value digits, in layout px. The floating panel
// (scoreboard.js) renders the digits onto a small dedicated overlay texture
// so the 1 Hz clock tick re-uploads ~135 KB instead of the full 2048×1152
// canvas (~9.4 MB + mipmap rebuild — a recurring one-frame spike on Quest).
// The rect sits inside the clock stat cell (vlines at 1024/1518) and overlaps
// nothing but the background slab gradient, so a transparent overlay reads
// identically to drawing on the base canvas.
//
// Vertically it spans the full 84px em box of the digits (940…1024 in layout
// space) plus ~10px of slack, and starts below the "TOTAL TIME" label's ink.
// The old 912…1008 rect was sized for digits drawn on the alphabetic baseline;
// on the layout's own 'middle' baseline the glyphs run to 1024 and would clip.
export const CLOCK_VALUE_RECT = { x: 1150, y: 930, w: 360, h: 104 };

// Draw just the clock digits into a CLOCK_VALUE_RECT-sized canvas, with the
// exact style drawStat uses for stat values on the base layout.
export function renderClockValue(ctx, elapsedMs) {
  ctx.clearRect(0, 0, CLOCK_VALUE_RECT.w, CLOCK_VALUE_RECT.h);
  ctx.textAlign = 'left';
  // 'middle', not 'alphabetic' — renderScoreboardLayout sets 'middle' once at
  // the top and drawStat inherits it, so anchoring the overlay on the
  // alphabetic baseline lifted the digits ~0.3em (25px) and pushed their tops
  // into the "TOTAL TIME" label above them.
  ctx.textBaseline = 'middle';
  ctx.font = STAT_VALUE_FONT;
  ctx.fillStyle = '#ffffff';
  // Same layout-space anchor drawStat uses (gx=1271 → value x = gx-115=1156,
  // y = statY+32 = 982), translated into the rect's local px.
  ctx.fillText(formatTime(elapsedMs), 1156 - CLOCK_VALUE_RECT.x, 982 - CLOCK_VALUE_RECT.y);
}

// Tension callout for the center badge, from standard 11-point win-by-2
// scoring. A side holds game point when it leads by ≥1 at ≥10 (play stops at
// a 2-point lead, so that lead is always exactly 1); it's match point when
// taking this game also takes the match. Exported for tests.
export function computeCallout(state) {
  if (state.matchOverBanner) return null;
  const p = state.playerScore, a = state.aiScore;
  if (p >= 10 && p === a) return { text: 'DEUCE', color: '#ffffff' };
  const side = p >= 10 && p > a ? 'player' : a >= 10 && a > p ? 'ai' : null;
  if (!side) return null;
  const gamesNeeded = Math.floor(state.bestOf / 2) + 1;
  const games = side === 'player' ? state.playerGames : state.aiGames;
  if (games + 1 >= gamesNeeded) return { text: 'MATCH POINT', color: GOLD };
  return { text: 'GAME POINT', color: side === 'player' ? BLUE_BRIGHT : RED_BRIGHT };
}

export function renderScoreboardLayout(ctx, state, opts = {}) {
  const w = LAYOUT_W, h = LAYOUT_H;
  ctx.clearRect(0, 0, w, h);

  // --- Background slab -----------------------------------------------------
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#05070f');
  bg.addColorStop(0.5, '#0a1226');
  bg.addColorStop(1, '#05070f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // --- Header logo ----------------------------------------------------------
  drawLogo(ctx, w / 2, 56);

  // --- Player panels ---------------------------------------------------------
  const panelTop = 112, panelBot = 570;
  drawSidePanel(ctx, {
    x0: BLUE_X0, x1: BLUE_X1, y0: panelTop, y1: panelBot,
    cutCorner: 'top-left',
    gradFrom: [BLUE_X0, panelTop], gradTo: [BLUE_X1, panelBot],
    fillA: '#16357c', fillB: '#070d24',
    border: BLUE,
  });
  drawSidePanel(ctx, {
    x0: RED_X0, x1: RED_X1, y0: panelTop, y1: panelBot,
    cutCorner: 'top-right',
    gradFrom: [RED_X1, panelTop], gradTo: [RED_X0, panelBot],
    fillA: '#7c1428', fillB: '#1c060d',
    border: RED,
  });

  // Panel contents. Names sit on a row with the avatar; the serve dot glows
  // beside whichever name is serving (replaces the old dedicated dot row).
  const blueCx = (BLUE_X0 + BLUE_X1) / 2;
  const redCx = (RED_X0 + RED_X1) / 2;
  const nameY = 215;

  // Names are clamped so a long multiplayer display name can't walk the
  // serve dot into the VS column. ~549px sit between the name anchor and the
  // panel's inner edge; 380 leaves room for the dot + glow and a clear gap
  // to the VS glyph even with the dot appended.
  const NAME_MAX_W = 380;

  drawAvatar(ctx, blueCx - 250, nameY, '#1d5cff');
  ctx.font = `bold 60px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  const blueName = ellipsize(ctx, state.playerName, NAME_MAX_W);
  ctx.fillText(blueName, blueCx - 165, nameY);
  if (state.currentServer === 'player') {
    const nw = ctx.measureText(blueName).width;
    drawServeDot(ctx, blueCx - 165 + nw + 44, nameY, BLUE_BRIGHT);
  }

  drawAvatar(ctx, redCx + 250, nameY, '#e11d3c');
  ctx.textAlign = 'right';
  const redName = ellipsize(ctx, state.aiName, NAME_MAX_W);
  ctx.fillText(redName, redCx + 165, nameY);
  if (state.currentServer === 'ai') {
    const nw = ctx.measureText(redName).width;
    drawServeDot(ctx, redCx + 165 - nw - 44, nameY, RED_BRIGHT);
  }

  // Big current-game scores, zero-padded to two digits like the broadcast mock.
  ctx.textAlign = 'center';
  ctx.font = `bold 270px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  ctx.fillText(pad2(state.playerScore), blueCx, 425);
  ctx.fillText(pad2(state.aiScore), redCx, 425);
  clearShadow(ctx);

  // --- Center column: VS + best-of badge ------------------------------------
  const cx = w / 2;
  ctx.font = `italic 900 110px ${FONT}`;
  const vsGrad = ctx.createLinearGradient(cx, 190, cx, 290);
  vsGrad.addColorStop(0, '#ffffff');
  vsGrad.addColorStop(1, '#8a94ad');
  ctx.fillStyle = vsGrad;
  ctx.fillText('VS', cx, 240);

  // The badge shows "BEST OF n" normally, but flips to a tension callout —
  // DEUCE / GAME POINT / MATCH POINT — whenever one is live. The static
  // best-of info is the least valuable thing on the board at those moments.
  const callout = computeCallout(state);
  const badgeText = callout ? callout.text : `BEST OF ${state.bestOf}`;
  ctx.font = `bold 40px ${FONT}`;
  // Width from measured text + 3px/char tracking; floor at the classic 280.
  const badgeW = Math.max(
    280, ctx.measureText(badgeText).width + 3 * badgeText.length + 84,
  );
  roundRect(ctx, cx - badgeW / 2, 340, badgeW, 76, 16);
  ctx.fillStyle = '#141c33';
  ctx.fill();
  ctx.strokeStyle = callout ? callout.color : 'rgba(255,255,255,0.14)';
  ctx.lineWidth = callout ? 4 : 2;
  if (callout) {
    ctx.shadowColor = callout.color;
    ctx.shadowBlur = 20;
  }
  ctx.stroke();
  clearShadow(ctx);
  ctx.fillStyle = callout ? callout.color : '#dbe2f4';
  withLetterSpacing(ctx, '3px', () => ctx.fillText(badgeText, cx, 380));

  // Games-won tally under the badge — the headline "how far into the match
  // are we" number the history row only implies. Pointless in a single-game
  // match (always 0 - 0), so best-of-1 skips it.
  if (state.bestOf > 1) {
    ctx.font = `bold 80px ${FONT}`;
    const pG = String(state.playerGames);
    const aG = String(state.aiGames);
    const dash = '  -  ';
    const pw = ctx.measureText(pG).width;
    const dw = ctx.measureText(dash).width;
    let gxx = cx - (pw + dw + ctx.measureText(aG).width) / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = BLUE_BRIGHT;
    ctx.fillText(pG, gxx, 512); gxx += pw;
    ctx.fillStyle = '#7f8aa8';
    ctx.fillText(dash, gxx, 512); gxx += dw;
    ctx.fillStyle = RED_BRIGHT;
    ctx.fillText(aG, gxx, 512);
    ctx.textAlign = 'center';
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillStyle = TEXT_DIM;
    withLetterSpacing(ctx, '3px', () => ctx.fillText('GAMES', cx, 566));
  }

  // --- Games history row ------------------------------------------------------
  // Only games that exist are shown: every finished game plus the one in
  // progress, centered as a group. No placeholder "—" columns for games
  // that haven't started (mid-game-1 the row is just "GAME 1").
  hline(ctx, ROW_X0, ROW_X1, 592);
  const rowX0 = ROW_X0, rowX1 = ROW_X1;
  const cols = Math.max(1, state.bestOf);
  const colW = (rowX1 - rowX0) / cols;
  const played = state.gameHistory.length;
  const showLive = !state.matchOverBanner && played < cols;
  const visible = Math.max(1, Math.min(cols, played + (showLive ? 1 : 0)));
  const startX = (rowX0 + rowX1) / 2 - (visible * colW) / 2;
  for (let i = 0; i < visible; i++) {
    const gx = startX + colW * (i + 0.5);
    if (i > 0) vline(ctx, startX + colW * i, 625, 745);

    ctx.font = `bold 38px ${FONT}`;
    ctx.fillStyle = TEXT_DIM;
    withLetterSpacing(ctx, '3px', () => ctx.fillText(`GAME ${i + 1}`, gx, 645));

    const finished = state.gameHistory[i];
    if (finished) {
      drawGameScore(ctx, gx, 715, finished.playerScore, finished.aiScore, 1.0);
    } else {
      // 0.65 (was 0.5) — the live game still reads as "in progress" but the
      // digits stay legible at panel distance.
      drawGameScore(ctx, gx, 715, state.playerScore, state.aiScore, 0.65);
    }
  }

  // --- Stats row ---------------------------------------------------------------
  hline(ctx, ROW_X0, ROW_X1, 778);
  const totalPoints = state.gameHistory.reduce(
    (sum, g) => sum + g.playerScore + g.aiScore,
    state.playerScore + state.aiScore,
  );
  const statY = 950;
  drawStat(ctx, 283, statY, 'crosshair', BLUE_BRIGHT, 'SHOTS HIT', String(state.shotsHit));
  drawStat(ctx, 777, statY, 'bolt', GREEN, 'TOP SPEED', String(Math.round(state.topSpeedKmh)), 'KM/H');
  // The floating panel draws the time digits on its own overlay texture
  // (see CLOCK_VALUE_RECT above) so the per-second tick doesn't force a full
  // canvas re-upload; label + icon still render here. Surfaces that don't
  // mount the overlay (stadium TVs) keep drawing the value inline.
  drawStat(ctx, 1271, statY, 'clock', PURPLE, 'TOTAL TIME',
    opts.skipClockValue ? '' : formatTime(state.elapsedMs));
  drawStat(ctx, 1765, statY, 'star', GOLD, 'TOTAL POINTS', String(totalPoints));
  vline(ctx, 530, 890, 1010);
  vline(ctx, 1024, 890, 1010);
  vline(ctx, 1518, 890, 1010);

  // --- Bottom accent bar ---------------------------------------------------------
  const accent = ctx.createLinearGradient(0, 0, w, 0);
  accent.addColorStop(0, BLUE);
  accent.addColorStop(0.45, 'rgba(59,130,246,0.05)');
  accent.addColorStop(0.55, 'rgba(239,68,68,0.05)');
  accent.addColorStop(1, RED);
  ctx.fillStyle = accent;
  ctx.fillRect(ROW_X0, 1108, ROW_X1 - ROW_X0, 8);

  // --- Match-over banner (masks the score area) ------------------------------------
  if (state.matchOverBanner) {
    // The box grows to the text, then the text shrinks to whatever box it
    // got. Both halves are needed: the banner was a fixed 1448px box with a
    // fixed 150px headline, which only ever fitted the AI match's "YOU WIN!"
    // (717px). Multiplayer's strings are far longer — "OPPONENT WINS THE
    // MATCH 3-1" measures 2428px, so it overran the gold border by ~490px a
    // side AND ran off both edges of the 2048px canvas with its first and
    // last characters clipped away. Every multiplayer match-end and
    // game-break banner was drawn that way.
    const text = String(state.matchOverBanner);
    const PAD = 48;
    ctx.font = `bold 150px ${FONT}`;
    const boxW = Math.max(
      1448,                                    // classic box — short banners keep it
      Math.min(ROW_X1 - ROW_X0, ctx.measureText(text).width + PAD * 2),
    );
    roundRect(ctx, cx - boxW / 2, 210, boxW, 270, 28);
    ctx.fillStyle = 'rgba(5, 8, 20, 0.95)';
    ctx.fill();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 4;
    ctx.shadowColor = GOLD;
    ctx.shadowBlur = 26;
    ctx.stroke();
    clearShadow(ctx);
    // Floor of 90px: still larger than the 84px stat values, so even the
    // longest banner reads as the headline it is.
    fitPx(ctx, text, boxW - PAD * 2, 'bold', 150, 90);
    ctx.fillStyle = '#ffe27a';
    ctx.fillText(text, cx, 348);
  }
}

// --- Drawing helpers ---------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTime(ms) {
  const totalS = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function clearShadow(ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

// ctx.letterSpacing is Chromium-only; harmless no-op elsewhere (jsdom, older
// engines) so headline tracking degrades gracefully.
function withLetterSpacing(ctx, spacing, draw) {
  const had = 'letterSpacing' in ctx;
  const prev = had ? ctx.letterSpacing : null;
  if (had) ctx.letterSpacing = spacing;
  draw();
  if (had) ctx.letterSpacing = prev;
}

// Truncate text with an ellipsis so it fits maxW at the current ctx.font.
function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = String(text);
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function hline(ctx, x0, x1, y) {
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

function vline(ctx, x, y0, y1) {
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
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

// Esport-style panel: rounded corners except one diagonal-cut corner
// (top-outer, like the mock's angular frames), gradient fill brightest at the
// outer top corner, glowing border in the side's color.
function drawSidePanel(ctx, { x0, x1, y0, y1, cutCorner, gradFrom, gradTo, fillA, fillB, border }) {
  const r = 26;   // rounded-corner radius
  const cut = 90; // diagonal-cut size
  ctx.beginPath();
  if (cutCorner === 'top-left') {
    ctx.moveTo(x0 + cut, y0);
    ctx.arcTo(x1, y0, x1, y1, r);
    ctx.arcTo(x1, y1, x0, y1, r);
    ctx.arcTo(x0, y1, x0, y0, r);
    ctx.lineTo(x0, y0 + cut);
    ctx.closePath();
  } else {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 - cut, y0);
    ctx.lineTo(x1, y0 + cut);
    ctx.arcTo(x1, y1, x0, y1, r);
    ctx.arcTo(x0, y1, x0, y0, r);
    ctx.arcTo(x0, y0, x1, y0, r);
    ctx.closePath();
  }
  const grad = ctx.createLinearGradient(gradFrom[0], gradFrom[1], gradTo[0], gradTo[1]);
  grad.addColorStop(0, fillA);
  grad.addColorStop(1, fillB);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 4;
  ctx.shadowColor = border;
  ctx.shadowBlur = 22;
  ctx.stroke();
  clearShadow(ctx);
}

// Filled circle with a simple white person glyph (head + shoulders).
function drawAvatar(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y - 16, 17, 0, Math.PI * 2); // head
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y + 34, 27, Math.PI, 0);     // shoulders
  ctx.fill();
}

function drawServeDot(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(x, y, 13, 0, Math.PI * 2);
  ctx.fill();
  clearShadow(ctx);
}

// One "11 - 8" cell of the games row: player score blue, dash gray, AI red.
function drawGameScore(ctx, cx, y, p, a, alpha) {
  ctx.font = `bold 66px ${FONT}`;
  const pStr = String(p), aStr = String(a), dash = ' - ';
  const pw = ctx.measureText(pStr).width;
  const dw = ctx.measureText(dash).width;
  const aw = ctx.measureText(aStr).width;
  let x = cx - (pw + dw + aw) / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'left';
  ctx.fillStyle = BLUE_BRIGHT;
  ctx.fillText(pStr, x, y); x += pw;
  ctx.fillStyle = '#7f8aa8';
  ctx.fillText(dash, x, y); x += dw;
  ctx.fillStyle = RED_BRIGHT;
  ctx.fillText(aStr, x, y);
  ctx.restore();
  ctx.textAlign = 'center';
}

// Icon + stacked label/value, icon left of the text block like the mock.
// Optional unit renders small and dim after the big value ("62 KM/H").
function drawStat(ctx, gx, gy, icon, color, label, value, unit) {
  drawStatIcon(ctx, icon, gx - 190, gy, color);
  ctx.textAlign = 'left';
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillStyle = TEXT_DIM;
  withLetterSpacing(ctx, '2px', () => ctx.fillText(label, gx - 115, gy - 36));
  ctx.font = STAT_VALUE_FONT;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(value, gx - 115, gy + 32);
  if (unit) {
    const vw = ctx.measureText(value).width;
    ctx.font = `bold 36px ${FONT}`;
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(unit, gx - 115 + vw + 14, gy + 44);
  }
  ctx.textAlign = 'center';
}

// Exported so the match report draws the same glyph set at its own scale
// (wrap in a ctx scale transform — the radii here are sized for this 2048px
// layout).
export function drawStatIcon(ctx, kind, x, y, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 6;
  if (kind === 'crosshair') {
    ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 40, y); ctx.lineTo(x - 26, y);
    ctx.moveTo(x + 26, y); ctx.lineTo(x + 40, y);
    ctx.moveTo(x, y - 40); ctx.lineTo(x, y - 26);
    ctx.moveTo(x, y + 26); ctx.lineTo(x, y + 40);
    ctx.stroke();
  } else if (kind === 'clock') {
    ctx.beginPath(); ctx.arc(x, y, 32, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x, y - 18);   // minute hand
    ctx.moveTo(x, y); ctx.lineTo(x + 13, y + 5); // hour hand
    ctx.stroke();
  } else if (kind === 'bolt') {
    ctx.beginPath();
    ctx.moveTo(x + 8, y - 36);
    ctx.lineTo(x - 20, y + 6);
    ctx.lineTo(x - 2, y + 6);
    ctx.lineTo(x - 8, y + 36);
    ctx.lineTo(x + 20, y - 6);
    ctx.lineTo(x + 2, y - 6);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'star') {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const outer = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const inner = outer + Math.PI / 5;
      const ox = x + Math.cos(outer) * 34, oy = y + Math.sin(outer) * 34;
      const ix = x + Math.cos(inner) * 14, iy = y + Math.sin(inner) * 14;
      if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
      ctx.lineTo(ix, iy);
    }
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'spin') {
    // Three-quarter arc with an arrowhead — the "ball is rotating" mark the
    // match report uses for TOP SPIN.
    ctx.beginPath();
    ctx.arc(x, y, 28, Math.PI * 0.35, Math.PI * 1.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 26, y + 2);
    ctx.lineTo(x + 8, y + 16);
    ctx.lineTo(x + 30, y + 26);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
}

// "🏓 SportyXR" header: a drawn paddle-and-ball mark plus two-tone wordmark.
function drawLogo(ctx, cx, cy) {
  ctx.font = `bold 54px ${FONT}`;
  const sportyW = ctx.measureText('Sporty').width;
  ctx.font = `italic bold 54px ${FONT}`;
  const xrW = ctx.measureText('XR').width;
  const iconW = 70;
  const totalW = iconW + sportyW + xrW + 8;
  let x = cx - totalW / 2;

  // Paddle mark: tilted blue-violet blade + handle + white ball.
  const px = x + 26, py = cy;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-0.5);
  const grad = ctx.createLinearGradient(-22, -22, 22, 22);
  grad.addColorStop(0, BLUE);
  grad.addColorStop(1, PURPLE);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(0, -6, 20, 23, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-5, 14, 10, 18); // handle
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(px + 24, py - 18, 7, 0, Math.PI * 2);
  ctx.fill();

  x += iconW;
  ctx.textAlign = 'left';
  ctx.font = `bold 54px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Sporty', x, cy);
  x += sportyW + 8;
  ctx.font = `italic bold 54px ${FONT}`;
  const xrGrad = ctx.createLinearGradient(x, cy, x + xrW, cy);
  xrGrad.addColorStop(0, BLUE_BRIGHT);
  xrGrad.addColorStop(1, PURPLE);
  ctx.fillStyle = xrGrad;
  ctx.fillText('XR', x, cy);
  ctx.textAlign = 'center';
}
