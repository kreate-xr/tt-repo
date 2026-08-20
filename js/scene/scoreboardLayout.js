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
const BLUE = '#3b82f6';
const BLUE_BRIGHT = '#4d8bff';
const RED = '#ef4444';
const RED_BRIGHT = '#ff4d64';
const TEXT_DIM = '#aab6d4';
const GOLD = '#f5b83d';
const PURPLE = '#8b5cf6';
const GREEN = '#22c55e';

const FONT = 'system-ui, sans-serif';

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

export function renderScoreboardLayout(ctx, state) {
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
    x0: 36, x1: 950, y0: panelTop, y1: panelBot,
    cutCorner: 'top-left',
    gradFrom: [36, panelTop], gradTo: [950, panelBot],
    fillA: '#16357c', fillB: '#070d24',
    border: BLUE,
  });
  drawSidePanel(ctx, {
    x0: 1098, x1: 2012, y0: panelTop, y1: panelBot,
    cutCorner: 'top-right',
    gradFrom: [2012, panelTop], gradTo: [1098, panelBot],
    fillA: '#7c1428', fillB: '#1c060d',
    border: RED,
  });

  // Panel contents. Names sit on a row with the avatar; the serve dot glows
  // beside whichever name is serving (replaces the old dedicated dot row).
  const blueCx = (36 + 950) / 2;
  const redCx = (1098 + 2012) / 2;
  const nameY = 215;

  drawAvatar(ctx, blueCx - 250, nameY, '#1d5cff');
  ctx.font = `bold 60px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  const blueName = state.playerName;
  ctx.fillText(blueName, blueCx - 165, nameY);
  if (state.currentServer === 'player') {
    const nw = ctx.measureText(blueName).width;
    drawServeDot(ctx, blueCx - 165 + nw + 44, nameY, BLUE_BRIGHT);
  }

  drawAvatar(ctx, redCx + 250, nameY, '#e11d3c');
  ctx.textAlign = 'right';
  const redName = state.aiName;
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

  roundRect(ctx, cx - 140, 340, 280, 72, 16);
  ctx.fillStyle = '#141c33';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = `bold 36px ${FONT}`;
  ctx.fillStyle = '#dbe2f4';
  withLetterSpacing(ctx, '3px', () => ctx.fillText(`BEST OF ${state.bestOf}`, cx, 377));

  // --- Games history row ------------------------------------------------------
  // Only games that exist are shown: every finished game plus the one in
  // progress, centered as a group. No placeholder "—" columns for games
  // that haven't started (mid-game-1 the row is just "GAME 1").
  hline(ctx, 36, 2012, 592);
  const rowX0 = 36, rowX1 = 2012;
  const cols = Math.max(1, state.bestOf);
  const colW = (rowX1 - rowX0) / cols;
  const played = state.gameHistory.length;
  const showLive = !state.matchOverBanner && played < cols;
  const visible = Math.max(1, Math.min(cols, played + (showLive ? 1 : 0)));
  const startX = (rowX0 + rowX1) / 2 - (visible * colW) / 2;
  for (let i = 0; i < visible; i++) {
    const gx = startX + colW * (i + 0.5);
    if (i > 0) vline(ctx, startX + colW * i, 625, 745);

    ctx.font = `bold 34px ${FONT}`;
    ctx.fillStyle = TEXT_DIM;
    withLetterSpacing(ctx, '3px', () => ctx.fillText(`GAME ${i + 1}`, gx, 645));

    const finished = state.gameHistory[i];
    if (finished) {
      drawGameScore(ctx, gx, 715, finished.playerScore, finished.aiScore, 1.0);
    } else {
      drawGameScore(ctx, gx, 715, state.playerScore, state.aiScore, 0.5);
    }
  }

  // --- Stats row ---------------------------------------------------------------
  hline(ctx, 36, 2012, 778);
  const totalPoints = state.gameHistory.reduce(
    (sum, g) => sum + g.playerScore + g.aiScore,
    state.playerScore + state.aiScore,
  );
  const statY = 950;
  drawStat(ctx, 283, statY, 'crosshair', BLUE_BRIGHT, 'SHOTS HIT', String(state.shotsHit));
  drawStat(ctx, 777, statY, 'bolt', GREEN, 'TOP SPEED', String(Math.round(state.topSpeedKmh)), 'KM/H');
  drawStat(ctx, 1271, statY, 'clock', PURPLE, 'TOTAL TIME', formatTime(state.elapsedMs));
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
  ctx.fillRect(36, 1108, w - 72, 8);

  // --- Match-over banner (masks the score area) ------------------------------------
  if (state.matchOverBanner) {
    roundRect(ctx, 300, 210, w - 600, 270, 28);
    ctx.fillStyle = 'rgba(5, 8, 20, 0.95)';
    ctx.fill();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 4;
    ctx.shadowColor = GOLD;
    ctx.shadowBlur = 26;
    ctx.stroke();
    clearShadow(ctx);
    ctx.font = `bold 150px ${FONT}`;
    ctx.fillStyle = '#ffe27a';
    ctx.fillText(state.matchOverBanner, w / 2, 348);
  }
}

// --- Drawing helpers ---------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTime(ms) {
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

function hline(ctx, x0, x1, y) {
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

function vline(ctx, x, y0, y1) {
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
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
  ctx.font = `bold 58px ${FONT}`;
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
  ctx.font = `bold 36px ${FONT}`;
  ctx.fillStyle = TEXT_DIM;
  withLetterSpacing(ctx, '2px', () => ctx.fillText(label, gx - 115, gy - 36));
  ctx.font = `bold 76px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(value, gx - 115, gy + 32);
  if (unit) {
    const vw = ctx.measureText(value).width;
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(unit, gx - 115 + vw + 14, gy + 44);
  }
  ctx.textAlign = 'center';
}

function drawStatIcon(ctx, kind, x, y, color) {
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
