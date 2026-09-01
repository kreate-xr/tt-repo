// End-of-match report: the card's layout and the stats behind it.
//
// Two things are worth pinning down headlessly. First the BUTTON GEOMETRY —
// the panel hit-tests the same rects the card draws (js/scene/matchReport.js
// registers widgets from reportButtonRects), so a rect that drifts off the
// canvas is a button the laser can reach but the player can't see, or the
// reverse. Second ACCURACY, which is derived from the rulebook's point
// verdicts rather than from ball events: "you lost that point" and "your shot
// went out" are different claims, and only some reasons mean the second one.

const {
  REPORT_W, REPORT_H, reportButtonRects, renderMatchReport,
} = require('../js/scene/matchReportLayout.js');
const {
  createMatchStats, isPlayerShotError, totalPointsFromSets,
} = require('../js/modes/matchStats.js');

// Enough of CanvasRenderingContext2D to run the card, recording every
// fillText with the font that was live at the time.
function fakeCtx() {
  const grad = { addColorStop() {} };
  const ctx = {
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    texts: [],
    clearRect() {}, fillRect() {},
    beginPath() {}, closePath() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, ellipse() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    createLinearGradient: () => grad,
    measureText: (t) => ({
      width: String(t).length * (parseInt(ctx.font.match(/(\d+)px/)[1], 10) * 0.55),
    }),
    fillText(text, x, y) {
      ctx.texts.push({ text: String(text), x, y, font: ctx.font });
    },
  };
  return ctx;
}

const SETS = [
  { player: 11, opponent: 6 },
  { player: 11, opponent: 9 },
  { player: 8, opponent: 11 },
  { player: 11, opponent: 7 },
];

function draw(patch = {}) {
  const ctx = fakeCtx();
  renderMatchReport(ctx, {
    playerGames: 3,
    opponentGames: 1,
    bestOf: 5,
    sets: SETS,
    winner: 'player',
    durationMs: 12 * 60_000 + 43_000,
    stats: { accuracyPct: 87, maxSpeedKmh: 18.6, topSpinPct: 72, totalPoints: 42 },
    buttons: [
      { id: 'playAgain', label: 'PLAY AGAIN', tone: 'primary' },
      { id: 'exit', label: 'EXIT TO MENU', tone: 'ghost' },
    ],
    ...patch,
  });
  return ctx;
}

// Records path construction as well as text, so the two side panels can be
// compared shape-for-shape.
function pathSpy() {
  const ctx = fakeCtx();
  const groups = [];
  let cur = null;
  const op = (name) => (...args) => {
    if (cur) cur.ops.push({ name, args });
  };
  ctx.beginPath = () => { cur = { ops: [] }; groups.push(cur); };
  ctx.moveTo = op('moveTo');
  ctx.lineTo = op('lineTo');
  ctx.arcTo = op('arcTo');
  ctx.arc = op('arc');
  ctx.closePath = op('closePath');
  ctx.groups = groups;
  return ctx;
}

describe('the two side panels', () => {
  // The AI panel is the blue panel mirrored, so its path must be the blue
  // one's mirror image op for op. It wasn't: the mirrored half closed with a
  // lineTo straight back to the corner cut, skipping its bottom-left corner
  // and drawing the AI side as a wedge instead of a panel.
  test('are built from mirror-image paths', () => {
    const ctx = pathSpy();
    renderMatchReport(ctx, { winner: 'player' });
    // Panel paths are the ones living entirely inside the header band and
    // built from straight segments (the card background spans the whole card;
    // the avatars are arcs).
    const inHeader = (o) => o.args.every((v, i) => (i % 2 === 1 ? v >= 50 && v <= 170 : true));
    const panels = ctx.groups.filter((g) => g.ops.length > 0
      && g.ops.some((o) => o.name === 'lineTo')
      && g.ops.every((o) => o.name === 'closePath' || inHeader(o)));
    expect(panels).toHaveLength(2);

    const shape = (g) => g.ops.reduce((acc, o) => {
      acc[o.name] = (acc[o.name] || 0) + 1;
      return acc;
    }, {});
    expect(shape(panels[0])).toEqual(shape(panels[1]));
    // Three rounded corners and one diagonal cut on each side.
    expect(shape(panels[0])).toEqual({ moveTo: 1, lineTo: 2, arcTo: 3, closePath: 1 });
  });
});

describe('report button geometry', () => {
  test('rects stay inside the card and never overlap', () => {
    for (const n of [1, 2, 3]) {
      const rects = reportButtonRects(n);
      expect(rects).toHaveLength(n);
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(REPORT_W);
        expect(r.y + r.h).toBeLessThanOrEqual(REPORT_H);
      }
      for (let i = 1; i < n; i++) {
        expect(rects[i].x).toBeGreaterThanOrEqual(rects[i - 1].x + rects[i - 1].w);
      }
    }
  });

  test('the row is centred whatever the count', () => {
    for (const n of [1, 2, 3]) {
      const rects = reportButtonRects(n);
      const left = rects[0].x;
      const right = rects[n - 1].x + rects[n - 1].w;
      expect((left + right) / 2).toBeCloseTo(REPORT_W / 2, 6);
    }
  });

  test('zero buttons is a legal card, not a crash', () => {
    expect(reportButtonRects(0)).toEqual([]);
    expect(() => draw({ buttons: [] })).not.toThrow();
  });
});

describe('the card', () => {
  test('shows every finished set and dashes the ones never played', () => {
    const texts = draw().texts.map((t) => t.text);
    // Four finished games in a best-of-5: eight scores, then one dashed row
    // (two cells).
    for (const s of SETS) {
      expect(texts).toContain(String(s.player));
      expect(texts).toContain(String(s.opponent));
    }
    expect(texts.filter((t) => t === '–')).toHaveLength(2);
    // Set numbers 1..5 are all labelled even though only 4 were played.
    for (const n of ['1', '2', '3', '4', '5']) expect(texts).toContain(n);
  });

  test('header carries the games tally, best-of and duration', () => {
    const texts = draw().texts.map((t) => t.text);
    expect(texts).toContain('MATCH COMPLETE');
    expect(texts).toContain('BEST OF 5 · 12:43');
  });

  test('the WINNER tag sits on the winning side', () => {
    const player = draw({ winner: 'player' }).texts.find((t) => t.text === 'WINNER');
    const opponent = draw({ winner: 'opponent' }).texts.find((t) => t.text === 'WINNER');
    expect(player.x).toBeLessThan(REPORT_W / 2);
    expect(opponent.x).toBeGreaterThan(REPORT_W / 2);
    // A match with no winner recorded (a card raised defensively) shows none.
    expect(draw({ winner: null }).texts.find((t) => t.text === 'WINNER')).toBeUndefined();
  });

  test('stats strip renders the four match numbers', () => {
    const texts = draw().texts.map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining([
      'ACCURACY', '87%', 'MAX SPEED', '18.6', 'KM/H', 'TOP SPIN', '72%',
      'TOTAL POINTS', '42',
    ]));
  });

  test('percentages are clamped rather than drawn out of range', () => {
    const texts = draw({
      stats: { accuracyPct: 140, maxSpeedKmh: 0, topSpinPct: -5, totalPoints: 0 },
    }).texts.map((t) => t.text);
    expect(texts).toContain('100%');
    expect(texts).toContain('0%');
  });

  test('a long display name is ellipsized instead of running off the panel', () => {
    const long = 'A_VERY_LONG_MULTIPLAYER_DISPLAY_NAME_INDEED';
    const ctx = draw({ playerName: long });
    // The name appears twice: beside the avatar and atop its sets column.
    const truncated = ctx.texts.filter((t) => t.text.endsWith('…'));
    expect(truncated).toHaveLength(2);
    expect(ctx.texts.some((t) => t.text === long)).toBe(false);
    for (const t of truncated) {
      const px = parseInt(t.font.match(/(\d+)px/)[1], 10);
      // Header name (large font) is the tighter budget; the column header
      // has the width of half the table to play with.
      const budget = px >= 24 ? 230 : 300;
      expect(t.text.length * px * 0.55).toBeLessThanOrEqual(budget);
    }
  });

  test('status line only appears when there is one to show', () => {
    expect(draw().texts.map((t) => t.text)).not.toContain('WAITING FOR OPPONENT…');
    expect(draw({ status: 'WAITING FOR OPPONENT…' }).texts.map((t) => t.text))
      .toContain('WAITING FOR OPPONENT…');
  });

  test('the sets table stays inside its band at any best-of', () => {
    // bestOf is config, not a constant: a longer match has to pack its rows
    // tighter instead of running the last ones down through the stats strip.
    // (It did — a best-of-7 drew set 7 at y≈545, past ACCURACY at y≈512.)
    for (const bestOf of [1, 3, 5, 7, 9]) {
      const ctx = draw({ bestOf, sets: SETS.slice(0, 1) });
      const statsTop = ctx.texts
        .filter((t) => t.text === 'ACCURACY')
        .reduce((min, t) => Math.min(min, t.y - parseInt(t.font.match(/(\d+)px/)[1], 10) * 0.6), Infinity);
      // Every set row: the number in the SET column plus its two scores.
      const rowMarks = ctx.texts.filter((t) => t.text === '–' || t.text === String(bestOf));
      expect(rowMarks.length).toBeGreaterThan(0);
      for (const t of rowMarks) {
        const px = parseInt(t.font.match(/(\d+)px/)[1], 10);
        expect(t.y + px * 0.6).toBeLessThan(statsTop);
      }
    }
  });

  test('an empty model draws without throwing', () => {
    const ctx = fakeCtx();
    expect(() => renderMatchReport(ctx, {})).not.toThrow();
    expect(() => renderMatchReport(ctx)).not.toThrow();
  });
});

describe('shot-error classification', () => {
  test('only placement failures count against accuracy', () => {
    // The shot was played and did not land in.
    expect(isPlayerShotError('ballLost', 'out')).toBe(true);
    expect(isPlayerShotError('ownSideBounce')).toBe(true);
    expect(isPlayerShotError('serveFault', 'lowToss')).toBe(true);
    expect(isPlayerShotError('ballOut', 'out')).toBe(true);
    // No shot was played, or the point turned on a rule rather than placement.
    expect(isPlayerShotError('ballLost', 'missedReturn')).toBe(false);
    expect(isPlayerShotError('doubleBounce')).toBe(false);
    expect(isPlayerShotError('illegalVolley')).toBe(false);
    expect(isPlayerShotError('netTouch')).toBe(false);
    expect(isPlayerShotError(null)).toBe(false);
  });
});

describe('match stats', () => {
  function stats() {
    let t = 0;
    const s = createMatchStats({ now: () => t });
    return { s, tick: (ms) => { t += ms; } };
  }

  test('accuracy counts shots that were not placement errors', () => {
    const { s } = stats();
    for (let i = 0; i < 10; i++) s.recordShot({ outSpeed: 5 });
    s.recordPoint({ loser: 'player', reason: 'ballLost', detail: 'out' });
    s.recordPoint({ loser: 'player', reason: 'ownSideBounce' });
    // Lost, but by never reaching the ball — not a shot error.
    s.recordPoint({ loser: 'player', reason: 'ballLost', detail: 'missedReturn' });
    // The opponent's errors are theirs.
    s.recordPoint({ loser: 'opponent', reason: 'ballLost', detail: 'out' });
    // A let carries no loser at all.
    s.recordPoint({ loser: null, reason: 'let' });
    expect(s.getStats()).toMatchObject({ shots: 10, shotErrors: 2, accuracyPct: 80 });
  });

  test('accuracy is 0 before a shot and never goes negative', () => {
    const { s } = stats();
    expect(s.getStats().accuracyPct).toBe(0);
    s.recordShot({ outSpeed: 4 });
    // More faults than strokes (a serve faulted on contact position).
    s.recordPoint({ loser: 'player', reason: 'serveFault' });
    s.recordPoint({ loser: 'player', reason: 'serveFault' });
    expect(s.getStats().accuracyPct).toBe(0);
  });

  test('top spin share and max speed come off the paddle-hit payload', () => {
    const { s } = stats();
    s.recordShot({ outSpeed: 5, spinType: 'TOP' });
    s.recordShot({ outSpeed: 10, spinType: 'TOP' });
    s.recordShot({ outSpeed: 2, spinType: 'BACK' });
    s.recordShot({ outSpeed: 1, spinType: 'flat' });
    const out = s.getStats();
    expect(out.topSpinPct).toBe(50);
    // 10 m/s → 36 km/h, and the peak is kept, not the last.
    expect(out.maxSpeedKmh).toBeCloseTo(36, 6);
  });

  test('duration freezes at stop() and restarts on reset()', () => {
    const { s, tick } = stats();
    tick(5_000);
    expect(s.getStats().durationMs).toBe(5_000);
    s.stop();
    tick(60_000);
    expect(s.getStats().durationMs).toBe(5_000);
    s.reset();
    tick(2_000);
    expect(s.getStats()).toMatchObject({ durationMs: 2_000, shots: 0, shotErrors: 0 });
  });

  test('total points adds up both sides of every set', () => {
    expect(totalPointsFromSets(SETS)).toBe(11 + 6 + 11 + 9 + 8 + 11 + 11 + 7);
    expect(totalPointsFromSets([])).toBe(0);
    expect(totalPointsFromSets()).toBe(0);
  });
});
