// Hover-repaint throttle shared by the canvas menu panels (hoverRedraw.js).
// The contract: hover-driven repaints are capped at one per
// HOVER_REDRAW_MIN_MS, a deferred one is painted by flushHoverDraw() once the
// window has passed, and any non-hover draw() runs immediately and clears it.

const { installHoverRedraw, HOVER_REDRAW_MIN_MS } = require('../js/scene/hoverRedraw.js');

let nowMs = 1000;
beforeEach(() => {
  nowMs = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => nowMs);
});
afterEach(() => jest.restoreAllMocks());

function makePanel() {
  const panel = { draws: 0, draw() { this.draws++; } };
  installHoverRedraw(panel);
  return panel;
}

test('the first hover change paints immediately', () => {
  const p = makePanel();
  p.requestHoverDraw();
  expect(p.draws).toBe(1);
});

test('a burst of hover changes inside the window paints once, then flushes once', () => {
  const p = makePanel();
  p.requestHoverDraw();
  for (let i = 0; i < 10; i++) { nowMs += 5; p.requestHoverDraw(); p.flushHoverDraw(); }
  expect(p.draws).toBe(1);
  nowMs += HOVER_REDRAW_MIN_MS;
  p.flushHoverDraw();
  expect(p.draws).toBe(2);
  // Nothing pending any more: further flushes are free.
  nowMs += HOVER_REDRAW_MIN_MS;
  p.flushHoverDraw();
  expect(p.draws).toBe(2);
});

test('a non-hover draw() runs at once and clears the pending hover repaint', () => {
  const p = makePanel();
  p.requestHoverDraw();
  nowMs += 10;
  p.requestHoverDraw();       // deferred
  p.draw();                   // e.g. a screen change
  expect(p.draws).toBe(2);
  nowMs += HOVER_REDRAW_MIN_MS;
  p.flushHoverDraw();         // already painted by draw()
  expect(p.draws).toBe(2);
});

test('draw keeps its receiver and arguments', () => {
  const seen = [];
  const panel = { draw(...a) { seen.push([this, a]); } };
  installHoverRedraw(panel);
  panel.draw(1, 2);
  expect(seen[0][0]).toBe(panel);
  expect(seen[0][1]).toEqual([1, 2]);
});
