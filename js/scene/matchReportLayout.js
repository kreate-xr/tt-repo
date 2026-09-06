// End-of-match report card, drawn onto a 2D canvas.
//
// The card the player reads when the match is over: who won, how every game
// went, four match-long stats, and the two things they can do next. Both match
// modes show the same card — the AI match (js/modes/aiMatch/aiMatch.js) and
// multiplayer (js/modes/multiplayer/multiplayer.js) — so the sets table and
// the stats strip can never say different things in the two places.
//
// Sized as one of the STABLE PANELS, not as a floating card: 1024×640 on a
// 1.40 m plane is exactly the multiplayer lobby panel's screen, and
// js/scene/matchReport.js asks inGame.js for the same fixed world anchor above
// the net that the wrist menu and the lobby use. A match report is something
// you read, lean toward and point at — head-billboarding it (the first cut of
// this panel) made it impossible to look away from and put it in a different
// place from every other panel in the game.
//
// Layout (canvas 1024×640):
//   ┌──────────────────────────────────────────────────────────┐
//   │                   MATCH COMPLETE                         │
//   │ ╔═ blue ═══╗        3  -  1        ╔═══ red ═╗           │
//   │ ║ ◉ YOU    ║   BEST OF 5 · 12:43   ║   AI  ◉ ║           │
//   │ ╚══════════╝                       ╚═════════╝           │
//   │  SET          YOU              AI                        │
//   │   1           11               6                         │
//   │   …                                                      │
//   │  ⊕ ACCURACY  ⚡ MAX SPEED  ↻ TOP SPIN  ★ TOTAL POINTS     │
//   │           [ PLAY AGAIN ]  [ EXIT TO MENU ]               │
//   └──────────────────────────────────────────────────────────┘
//
// Scene-free by design (same rule as panelKit.js): no THREE import, so the
// whole card — including the button geometry the laser hit-tests against —
// runs under Jest. js/scene/matchReport.js owns the mesh and the input
// routing.
//
// Palette, stat icons and the m:ss formatter come from scoreboardLayout.js
// rather than being restated here: this card is the same broadcast surface as
// the scoreboard that was live thirty seconds earlier.

import { BOARD_COLORS, FONT, drawStatIcon, formatTime } from './scoreboardLayout.js';
import { roundRect } from './panelStyle.js';

// The lobby panel's canvas, so this reads as the same screen in the same
// place. Physical size lives with the mesh (js/scene/matchReport.js).
export const REPORT_W = 1024;
export const REPORT_H = 640;

const C = BOARD_COLORS;
const WHITE = '#ffffff';
const DIM = '#7f8aa8';

// --- Vertical rhythm ---------------------------------------------------------
const TITLE_Y = 34;
const HEAD_Y0 = 56, HEAD_Y1 = 158;      // the two side panels
const SETS_HEAD_Y = 188;
const SETS_RULE_Y = 206;
const SETS_Y0 = 210;
const SETS_Y1 = 424;                     // the stats strip starts just below
const SETS_ROW_H = 44;                   // best-of-5's comfortable row height
const STATS_LABEL_Y = 456;
const STATS_VALUE_Y = 490;
const STATUS_Y = 522;

// Side panels leave a 204px centre column for the games tally and the
// best-of/duration line — measured against "BEST OF 5 · 12:43" at 18px, which
// is the widest thing that column ever carries.
const MARGIN = 24;
const PANEL_W = 386;
const BLUE_X0 = MARGIN, BLUE_X1 = MARGIN + PANEL_W;                  // 24 … 410
const RED_X1 = REPORT_W - MARGIN, RED_X0 = RED_X1 - PANEL_W;         // 614 … 1000

// Sets table columns.
const COL_SET = 140;
const COL_PLAYER = 400;
const COL_OPPONENT = 760;

// --- Buttons -----------------------------------------------------------------
// Exported so the Panel widgets and the drawn buttons come from one source:
// a laser that hit-tests a rect the player can't see is the classic way a VR
// panel goes subtly wrong.
const BTN_W = 264;
const BTN_H = 54;
const BTN_GAP = 18;
const BTN_Y = 546;

export function reportButtonRects(count) {
  const n = Math.max(0, count | 0);
  if (n === 0) return [];
  const total = n * BTN_W + (n - 1) * BTN_GAP;
  const x0 = (REPORT_W - total) / 2;
  const rects = [];
  for (let i = 0; i < n; i++) {
    rects.push({ x: x0 + i * (BTN_W + BTN_GAP), y: BTN_Y, w: BTN_W, h: BTN_H });
  }
  return rects;
}

/**
 * Default model. Callers patch what they know; anything they don't stays at a
 * value the card can actually draw (an empty sets list renders as all-dashes
 * rather than throwing on undefined).
 */
export function createReportModel(patch = {}) {
  return {
    title: 'MATCH COMPLETE',
    playerName: 'YOU',
    opponentName: 'OPPONENT',
    playerGames: 0,
    opponentGames: 0,
    bestOf: 5,
    // Finished games in play order, local perspective: [{ player, opponent }].
    sets: [],
    winner: null,            // 'player' | 'opponent' | null
    durationMs: 0,
    stats: {
      accuracyPct: 0,
      maxSpeedKmh: 0,
      topSpinPct: 0,
      totalPoints: 0,
    },
    buttons: [],             // [{ id, label, tone: 'primary'|'ghost', disabled }]
    hoveredId: null,
    status: null,            // one line above the buttons (multiplayer rematch)
    ...patch,
  };
}

export function renderMatchReport(ctx, modelIn) {
  const m = createReportModel(modelIn || {});
  const w = REPORT_W, h = REPORT_H;

  ctx.clearRect(0, 0, w, h);

  // --- Card ------------------------------------------------------------------
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0a1020');
  bg.addColorStop(0.5, '#070c18');
  bg.addColorStop(1, '#05070f');
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, w, h, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // --- Title -----------------------------------------------------------------
  // With a winner known the title IS the result announcement — the headline
  // the scoreboard used to banner across its own score area — so it's drawn
  // in gold at the larger size. Callers pass the wording ("YOU WIN!",
  // "OPPONENT WINS THE MATCH 3-1"); a plain "MATCH COMPLETE" stays white.
  // Multiplayer's strings are long enough to need measuring: the card is
  // 1024 wide and canvas paints straight past its edge.
  const titleGold = !!m.winner;
  fitPx(ctx, m.title, w - MARGIN * 2, titleGold ? 34 : 28, 18);
  ctx.fillStyle = titleGold ? C.gold : WHITE;
  ctx.fillText(m.title, w / 2, TITLE_Y);

  // --- Side panels -----------------------------------------------------------
  sidePanel(ctx, {
    x0: BLUE_X0, x1: BLUE_X1, cut: 'right',
    fillA: '#16357c', fillB: '#070d24', border: C.blue,
    won: m.winner === 'player',
  });
  sidePanel(ctx, {
    x0: RED_X0, x1: RED_X1, cut: 'left',
    fillA: '#7c1428', fillB: '#1c060d', border: C.red,
    won: m.winner === 'opponent',
  });

  const nameY = (HEAD_Y0 + HEAD_Y1) / 2 - 6;
  avatar(ctx, BLUE_X0 + 48, nameY, '#1d5cff');
  ctx.font = `bold 28px ${FONT}`;
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'left';
  ctx.fillText(ellipsize(ctx, m.playerName, 230), BLUE_X0 + 88, nameY);

  avatar(ctx, RED_X1 - 48, nameY, '#e11d3c');
  ctx.textAlign = 'right';
  ctx.fillText(ellipsize(ctx, m.opponentName, 230), RED_X1 - 88, nameY);

  // "WINNER" tag under whichever name took the match.
  if (m.winner) {
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillStyle = C.gold;
    if (m.winner === 'player') {
      ctx.textAlign = 'left';
      ctx.fillText('WINNER', BLUE_X0 + 88, nameY + 28);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText('WINNER', RED_X1 - 88, nameY + 28);
    }
  }

  // --- Centre column: games tally + best-of / duration ------------------------
  const cx = w / 2;
  ctx.textAlign = 'center';
  ctx.font = `bold 52px ${FONT}`;
  ctx.fillStyle = m.winner === 'player' ? C.gold : C.blueBright;
  ctx.fillText(String(m.playerGames), cx - 42, HEAD_Y0 + 48);
  ctx.fillStyle = DIM;
  ctx.fillText('-', cx, HEAD_Y0 + 48);
  ctx.fillStyle = m.winner === 'opponent' ? C.gold : C.redBright;
  ctx.fillText(String(m.opponentGames), cx + 42, HEAD_Y0 + 48);

  ctx.font = `bold 16px ${FONT}`;
  ctx.fillStyle = C.textDim;
  ctx.fillText(`BEST OF ${m.bestOf} · ${formatTime(m.durationMs)}`, cx, HEAD_Y0 + 88);

  // --- Sets table ------------------------------------------------------------
  ctx.font = `bold 18px ${FONT}`;
  ctx.fillStyle = C.textDim;
  ctx.fillText('SET', COL_SET, SETS_HEAD_Y);
  ctx.fillStyle = C.blueBright;
  ctx.fillText(ellipsize(ctx, m.playerName, 300), COL_PLAYER, SETS_HEAD_Y);
  ctx.fillStyle = C.redBright;
  ctx.fillText(ellipsize(ctx, m.opponentName, 300), COL_OPPONENT, SETS_HEAD_Y);
  hline(ctx, MARGIN + 40, w - MARGIN - 40, SETS_RULE_Y, 'rgba(255,255,255,0.18)');

  // Rows share a fixed band, so a longer match packs tighter rather than
  // running its last sets down through the stats strip. bestOf is data — the
  // match model takes it from config — so the table cannot assume five.
  const rows = Math.max(1, m.bestOf);
  const rowH = Math.min(SETS_ROW_H, (SETS_Y1 - SETS_Y0) / rows);
  const scorePx = Math.max(16, Math.min(28, Math.round(rowH * 0.6)));
  const labelPx = Math.max(14, Math.min(22, Math.round(rowH * 0.48)));
  for (let i = 0; i < rows; i++) {
    const y = SETS_Y0 + i * rowH + rowH / 2;
    if (i > 0) hline(ctx, MARGIN + 40, w - MARGIN - 40, y - rowH / 2, 'rgba(255,255,255,0.07)');

    ctx.font = `bold ${labelPx}px ${FONT}`;
    ctx.fillStyle = C.textDim;
    ctx.fillText(String(i + 1), COL_SET, y);

    const set = m.sets[i];
    if (!set) {
      ctx.fillStyle = DIM;
      ctx.font = `bold ${scorePx}px ${FONT}`;
      ctx.fillText('–', COL_PLAYER, y);
      ctx.fillText('–', COL_OPPONENT, y);
      continue;
    }
    const playerTook = set.player > set.opponent;
    ctx.font = `bold ${scorePx}px ${FONT}`;
    ctx.fillStyle = playerTook ? C.blueBright : DIM;
    ctx.fillText(String(set.player), COL_PLAYER, y);
    ctx.fillStyle = playerTook ? DIM : C.redBright;
    ctx.fillText(String(set.opponent), COL_OPPONENT, y);
  }
  hline(ctx, MARGIN + 40, w - MARGIN - 40, SETS_Y0 + rows * rowH, 'rgba(255,255,255,0.18)');

  // --- Stats strip -----------------------------------------------------------
  const s = m.stats || {};
  const cells = [
    { icon: 'crosshair', color: C.blueBright, label: 'ACCURACY',     value: `${clampPct(s.accuracyPct)}%` },
    { icon: 'bolt',      color: C.gold,       label: 'MAX SPEED',    value: `${(Number(s.maxSpeedKmh) || 0).toFixed(1)}`, unit: 'KM/H' },
    { icon: 'spin',      color: C.green,      label: 'TOP SPIN',     value: `${clampPct(s.topSpinPct)}%` },
    { icon: 'star',      color: C.purple,     label: 'TOTAL POINTS', value: String(s.totalPoints || 0) },
  ];
  const cellW = w / cells.length;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const cellCx = cellW * (i + 0.5);
    // Icons are drawn at the scoreboard's 2048-space radii; 0.55 brings them
    // to this card's scale without a second copy of the glyph code.
    ctx.save();
    ctx.translate(cellCx - 84, STATS_VALUE_Y - 18);
    ctx.scale(0.5, 0.5);
    drawStatIcon(ctx, c.icon, 0, 0, c.color);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillStyle = C.textDim;
    ctx.fillText(c.label, cellCx - 60, STATS_LABEL_Y);
    ctx.font = `bold 28px ${FONT}`;
    ctx.fillStyle = WHITE;
    ctx.fillText(c.value, cellCx - 60, STATS_VALUE_Y);
    if (c.unit) {
      const vw = ctx.measureText(c.value).width;
      ctx.font = `bold 13px ${FONT}`;
      ctx.fillStyle = C.textDim;
      ctx.fillText(c.unit, cellCx - 60 + vw + 8, STATS_VALUE_Y + 7);
    }
    ctx.textAlign = 'center';
  }

  // --- Status line (multiplayer rematch handshake) ---------------------------
  if (m.status) {
    ctx.font = `bold 17px ${FONT}`;
    ctx.fillStyle = C.gold;
    ctx.fillText(String(m.status), cx, STATUS_Y);
  }

  // --- Buttons ---------------------------------------------------------------
  const rects = reportButtonRects(m.buttons.length);
  for (let i = 0; i < m.buttons.length; i++) {
    const b = m.buttons[i];
    const r = rects[i];
    const hovered = m.hoveredId === b.id && !b.disabled;
    const primary = b.tone === 'primary';

    if (b.disabled) ctx.fillStyle = 'rgba(255,255,255,0.05)';
    else if (primary) ctx.fillStyle = hovered ? C.blueBright : C.blue;
    else ctx.fillStyle = hovered ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)';
    roundRect(ctx, r.x, r.y, r.w, r.h, 12);
    ctx.fill();
    if (hovered) {
      ctx.strokeStyle = primary ? WHITE : C.blueBright;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.font = `bold 21px ${FONT}`;
    ctx.fillStyle = b.disabled ? DIM : (primary ? WHITE : '#dbe2f4');
    ctx.fillText(b.label, r.x + r.w / 2, r.y + r.h / 2);
  }
}

// --- Drawing helpers ---------------------------------------------------------

function clampPct(v) {
  const n = Math.round(Number(v) || 0);
  return Math.min(100, Math.max(0, n));
}

// Esport-style panel with the INNER top corner cut away, mirroring the
// scoreboard's angular frames (there the cut is on the outer corner, because
// there the panels sit at the canvas edge).
//
// Every corner is walked explicitly as arcTo(cornerPoint, nextPoint, r). The
// mirrored half originally reused the scoreboard's "aim at the far corner"
// idiom and then closed with a lineTo straight back to the cut — which skipped
// the bottom-left corner entirely and drew the AI side as a wedge rather than
// a panel.
function sidePanel(ctx, { x0, x1, cut, fillA, fillB, border, won }) {
  const y0 = HEAD_Y0, y1 = HEAD_Y1;
  const r = 14, c = 30;
  ctx.beginPath();
  if (cut === 'right') {
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x1 - c, y0);          // top edge, stopping short of the cut
    ctx.lineTo(x1, y0 + c);          // the diagonal
    ctx.arcTo(x1, y1, x1 - r, y1, r);  // bottom-right
    ctx.arcTo(x0, y1, x0, y1 - r, r);  // bottom-left
    ctx.arcTo(x0, y0, x0 + r, y0, r);  // top-left
  } else {
    ctx.moveTo(x0 + c, y0);
    ctx.lineTo(x1 - r, y0);
    ctx.arcTo(x1, y0, x1, y0 + r, r);  // top-right
    ctx.arcTo(x1, y1, x1 - r, y1, r);  // bottom-right
    ctx.arcTo(x0, y1, x0, y0 + c, r);  // bottom-left
    ctx.lineTo(x0, y0 + c);            // up the left edge to the cut
  }
  ctx.closePath();
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, fillA);
  grad.addColorStop(1, fillB);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = won ? BOARD_COLORS.gold : border;
  ctx.lineWidth = won ? 3 : 2;
  ctx.stroke();
}

function avatar(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.arc(x, y - 7, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y + 15, 13, Math.PI, 0);
  ctx.fill();
}

function hline(ctx, x0, x1, y, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

// Largest size at which `text` fits `maxW`, stepping down from `size` and
// never below `min`. Same idea as scoreboardLayout's fitPx (headline text
// shrinks rather than being cut), kept local because this card's type is all
// bold. Leaves ctx.font set to the size it chose.
function fitPx(ctx, text, maxW, size, min) {
  let px = size;
  while (px > min) {
    ctx.font = `bold ${px}px ${FONT}`;
    if (ctx.measureText(text).width <= maxW) break;
    px -= 1;
  }
  ctx.font = `bold ${px}px ${FONT}`;
  return px;
}

// Canvas paints straight past its container, so anything whose width depends
// on runtime data (a multiplayer display name) has to be measured.
function ellipsize(ctx, text, maxW) {
  const t0 = String(text == null ? '' : text);
  if (ctx.measureText(t0).width <= maxW) return t0;
  let t = t0;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
