// The floating panel paints the TOTAL TIME digits onto a small overlay texture
// (CLOCK_VALUE_RECT) instead of the 2048×1152 base canvas, so the 1 Hz tick
// doesn't re-upload the whole board. That only reads identically if the
// overlay lands on the exact same anchor — same x, same y, same textBaseline —
// that drawStat uses inline. It didn't: the overlay anchored on 'alphabetic'
// while the layout runs on 'middle', lifting the digits ~0.3em into the
// "TOTAL TIME" label above them.

const {
  CLOCK_VALUE_RECT, renderClockValue, renderScoreboardLayout,
  createScoreboardState,
} = require('../js/scene/scoreboardLayout.js');

const ELAPSED_MS = 65_000;
const TIME_TEXT = '1:05';

// Enough of CanvasRenderingContext2D for the layout to run, recording every
// fillText with the state (font/baseline/align) that was live at the time.
function fakeCtx() {
  const grad = { addColorStop() {} };
  const ctx = {
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetY: 0,
    texts: [],
    clearRect() {}, fillRect() {},
    beginPath() {}, closePath() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, ellipse() {},
    save() {}, restore() {}, translate() {}, rotate() {},
    createLinearGradient: () => grad,
    // Rough monospace-ish metric: the layout only uses widths for centering,
    // and this test asserts on the recorded anchors, not on pixel widths.
    measureText: t => ({ width: String(t).length * (parseInt(ctx.font.match(/(\d+)px/)[1], 10) * 0.55) }),
    fillText(text, x, y) {
      ctx.texts.push({
        text, x, y, font: ctx.font,
        baseline: ctx.textBaseline, align: ctx.textAlign,
      });
    },
  };
  return ctx;
}

function inlineClockDraw() {
  const ctx = fakeCtx();
  const state = Object.assign(createScoreboardState(), { elapsedMs: ELAPSED_MS });
  renderScoreboardLayout(ctx, state);
  const hit = ctx.texts.filter(t => t.text === TIME_TEXT);
  expect(hit).toHaveLength(1);
  return hit[0];
}

function overlayClockDraw() {
  const ctx = fakeCtx();
  renderClockValue(ctx, ELAPSED_MS);
  expect(ctx.texts).toHaveLength(1);
  return ctx.texts[0];
}

test('the clock overlay lands on the same anchor drawStat uses inline', () => {
  const inline = inlineClockDraw();
  const overlay = overlayClockDraw();

  // The overlay canvas is rect-local, so shift it back into layout space.
  expect(overlay.x + CLOCK_VALUE_RECT.x).toBe(inline.x);
  expect(overlay.y + CLOCK_VALUE_RECT.y).toBe(inline.y);
  expect(overlay.baseline).toBe(inline.baseline);
  expect(overlay.align).toBe(inline.align);
  expect(overlay.font).toBe(inline.font);
});

test('the digits sit clear of the TOTAL TIME label and inside their rect', () => {
  const inline = inlineClockDraw();
  const px = parseInt(inline.font.match(/(\d+)px/)[1], 10);

  // 'middle' anchors the em box's centre, so ink is confined to y ± px/2.
  expect(inline.baseline).toBe('middle');
  const inkTop = inline.y - px / 2;
  const inkBot = inline.y + px / 2;

  expect(inkTop).toBeGreaterThanOrEqual(CLOCK_VALUE_RECT.y);
  expect(inkBot).toBeLessThanOrEqual(CLOCK_VALUE_RECT.y + CLOCK_VALUE_RECT.h);

  // …and below the label stacked above it in the same stat cell.
  const label = inlineClockLabel();
  const labelPx = parseInt(label.font.match(/(\d+)px/)[1], 10);
  expect(inkTop).toBeGreaterThan(label.y + labelPx / 2);
});

function inlineClockLabel() {
  const ctx = fakeCtx();
  renderScoreboardLayout(ctx, createScoreboardState());
  const hit = ctx.texts.filter(t => t.text === 'TOTAL TIME');
  expect(hit).toHaveLength(1);
  return hit[0];
}
