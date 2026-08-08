// Slice 5 — panel toolkit. Hit geometry and input routing, the parts every
// hand-rolled panel got subtly wrong in its own way.

const {
  Panel, WIDGETS,
  uvToCanvas, hitRect, hitCircle, sliderValueAt, sliderFraction,
  listRows, clampScroll,
} = require('../js/scene/panelKit.js');

const W = 1024;
const H = 410;

describe('uvToCanvas', () => {
  test('flips v, because UV is bottom-up and canvas is top-down', () => {
    // The single most-copied line in the old panels: (1 - v) * H.
    expect(uvToCanvas(0, 1, W, H)).toEqual({ px: 0, py: 0 });
    expect(uvToCanvas(1, 0, W, H)).toEqual({ px: W, py: H });
    expect(uvToCanvas(0.5, 0.5, W, H)).toEqual({ px: W / 2, py: H / 2 });
  });

  test('returns null outside the panel rather than a bogus pixel', () => {
    for (const [u, v] of [[-0.01, 0.5], [1.01, 0.5], [0.5, -0.01], [0.5, 1.01]]) {
      expect(uvToCanvas(u, v, W, H)).toBeNull();
    }
  });

  test('rejects NaN instead of producing NaN pixels', () => {
    expect(uvToCanvas(NaN, 0.5, W, H)).toBeNull();
    expect(uvToCanvas(0.5, NaN, W, H)).toBeNull();
  });
});

describe('hit primitives', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };

  test('rect hits include edges', () => {
    expect(hitRect(10, 20, r)).toBe(true);
    expect(hitRect(110, 70, r)).toBe(true);
    expect(hitRect(60, 45, r)).toBe(true);
  });

  test('rect misses just outside', () => {
    expect(hitRect(9.9, 45, r)).toBe(false);
    expect(hitRect(110.1, 45, r)).toBe(false);
    expect(hitRect(60, 70.1, r)).toBe(false);
  });

  test('circle honours its slop radius', () => {
    const c = { cx: 100, cy: 100, r: 20 };
    expect(hitCircle(100, 100, c)).toBe(true);
    expect(hitCircle(121, 100, c)).toBe(false);
    expect(hitCircle(121, 100, c, 12)).toBe(true); // slop covers crosshair ticks
  });
});

describe('sliderValueAt', () => {
  const s = { x: 100, w: 400, min: 0, max: 10, step: 0 };

  test('maps position across the track', () => {
    expect(sliderValueAt(100, s)).toBeCloseTo(0, 6);
    expect(sliderValueAt(500, s)).toBeCloseTo(10, 6);
    expect(sliderValueAt(300, s)).toBeCloseTo(5, 6);
  });

  test('clamps rather than extrapolating past the track', () => {
    // A laser drifting past the end must peg the slider, not drive the value
    // out of range and into the engine.
    expect(sliderValueAt(0, s)).toBe(0);
    expect(sliderValueAt(9999, s)).toBe(10);
  });

  test('snaps to step and stays inside bounds', () => {
    const stepped = { x: 0, w: 100, min: 2, max: 25, step: 0.5 };
    const v = sliderValueAt(43, stepped);
    expect(v % 0.5).toBeCloseTo(0, 9);
    expect(v).toBeGreaterThanOrEqual(2);
    expect(v).toBeLessThanOrEqual(25);
  });

  test('snapping never pushes past a bound', () => {
    // max is not a whole number of steps from min — the classic overshoot.
    const odd = { x: 0, w: 100, min: 0, max: 0.9, step: 0.4 };
    expect(sliderValueAt(100, odd)).toBeLessThanOrEqual(0.9);
    expect(sliderValueAt(0, odd)).toBeGreaterThanOrEqual(0);
  });

  test('produces clean values, not float dust', () => {
    const s2 = { x: 0, w: 100, min: 0, max: 1, step: 0.1 };
    const v = sliderValueAt(30, s2);
    expect(String(v).length).toBeLessThan(6); // not 0.30000000000000004
  });

  test('sliderFraction is the inverse and clamps', () => {
    expect(sliderFraction(5, s)).toBeCloseTo(0.5, 6);
    expect(sliderFraction(-5, s)).toBe(0);
    expect(sliderFraction(99, s)).toBe(1);
  });

  test('a zero-width value range does not divide by zero', () => {
    expect(sliderFraction(5, { min: 5, max: 5 })).toBe(0);
  });
});

describe('Panel hit routing', () => {
  const makePanel = () => {
    const p = new Panel({ width: W, height: H });
    p.add({ id: 'bg', kind: WIDGETS.BUTTON, shape: 'rect', x: 0, y: 0, w: W, h: H });
    p.add({ id: 'tile', kind: WIDGETS.BUTTON, shape: 'circle', cx: 200, cy: 200, r: 40 });
    p.add({ id: 'row', kind: WIDGETS.LIST_ROW, shape: 'rect', x: 400, y: 100, w: 300, h: 50 });
    return p;
  };

  test('circles win over overlapping rects', () => {
    // The mode tiles sit on a full-panel background; without this ordering the
    // background swallows every tile press.
    const p = makePanel();
    const uv = (px, py) => [px / W, 1 - py / H];
    expect(p.hitTestUV(...uv(200, 200))).toBe('tile');
  });

  test('rects resolve when no circle matches', () => {
    const p = makePanel();
    expect(p.hitTestUV(500 / W, 1 - 120 / H)).toBe('row');
  });

  test('a later widget beats an earlier one it overlaps', () => {
    // Registration order is draw order, so the row drawn on top of the
    // full-panel background must take the hit — a forward first-match-wins
    // loop gives it to the background instead.
    const p = makePanel();
    expect(p.hitTestUV(410 / W, 1 - 105 / H)).toBe('row');
    // ...and a point outside the row still falls through to the background.
    expect(p.hitTestUV(900 / W, 1 - 300 / H)).toBe('bg');
  });

  test('a hit outside the panel resolves to null', () => {
    expect(makePanel().hitTestUV(-1, 0.5)).toBeNull();
  });

  test('disabled widgets are not hit', () => {
    const p = makePanel();
    p.get('tile').disabled = true;
    expect(p.hitTestUV(200 / W, 1 - 200 / H)).toBe('bg');
  });
});

describe('Panel hover', () => {
  const panelWithRow = () => {
    const p = new Panel({ width: W, height: H });
    p.add({ id: 'a', kind: WIDGETS.BUTTON, shape: 'rect', x: 0, y: 0, w: 100, h: 100 });
    p.add({ id: 'b', kind: WIDGETS.BUTTON, shape: 'rect', x: 200, y: 0, w: 100, h: 100 });
    return p;
  };

  test('reports true only when hover actually changes', () => {
    // Panels that redrew every frame regardless are why the hover tick used
    // to machine-gun.
    const p = panelWithRow();
    expect(p.setHoverUV(0.02, 0.95)).toBe(true);   // none -> a
    expect(p.setHoverUV(0.03, 0.94)).toBe(false);  // still a
    expect(p.setHoverUV(0.25, 0.95)).toBe(true);   // a -> b
  });

  test('moving off the panel clears hover', () => {
    const p = panelWithRow();
    p.setHoverUV(0.02, 0.95);
    expect(p.setHoverUV(-1, -1)).toBe(true);
    expect(p.hoveredId).toBeNull();
  });

  test('relayout drops stale hover', () => {
    // The hovered id may not exist after clear(), and a stale hover renders a
    // highlight on nothing.
    const p = panelWithRow();
    p.setHoverUV(0.02, 0.95);
    expect(p.hoveredId).toBe('a');
    p.clear();
    expect(p.hoveredId).toBeNull();
  });

  test('hide clears hover', () => {
    const p = panelWithRow();
    p.setHoverUV(0.02, 0.95);
    p.hide();
    expect(p.hoveredId).toBeNull();
  });
});

describe('Panel activation', () => {
  test('activate emits the hovered widget action', () => {
    const p = new Panel({ width: W, height: H });
    p.add({ id: 'go', kind: WIDGETS.BUTTON, shape: 'rect', x: 0, y: 0, w: 100, h: 100, action: 'start', value: 'x' });
    const seen = [];
    p.on('start', (e) => seen.push(e));
    p.setHoverUV(0.02, 0.95);
    p.activate();
    expect(seen).toHaveLength(1);
    expect(seen[0].value).toBe('x');
  });

  test('activate with nothing hovered is a no-op, not a throw', () => {
    const p = new Panel({ width: W, height: H });
    expect(p.activate()).toBeNull();
  });

  test('toggles flip their value', () => {
    const p = new Panel({ width: W, height: H });
    p.add({ id: 't', kind: WIDGETS.TOGGLE, shape: 'rect', x: 0, y: 0, w: 10, h: 10, value: false });
    expect(p.activateId('t').value).toBe(true);
    expect(p.activateId('t').value).toBe(false);
  });

  test('steppers report their own delta', () => {
    // One id per arrow, so handlers do not re-derive direction from position.
    const p = new Panel({ width: W, height: H });
    p.add({ id: 'up', kind: WIDGETS.STEPPER, shape: 'rect', x: 0, y: 0, w: 10, h: 10, delta: +1 });
    p.add({ id: 'down', kind: WIDGETS.STEPPER, shape: 'rect', x: 20, y: 0, w: 10, h: 10, delta: -1 });
    expect(p.activateId('up').value).toBe(1);
    expect(p.activateId('down').value).toBe(-1);
  });

  test('disabled widgets cannot be activated', () => {
    const p = new Panel({ width: W, height: H });
    p.add({ id: 'x', kind: WIDGETS.BUTTON, shape: 'rect', x: 0, y: 0, w: 10, h: 10, disabled: true });
    expect(p.activateId('x')).toBeNull();
  });

  test('one throwing handler cannot disable the rest of the menu', () => {
    const p = new Panel({ width: W, height: H });
    p.add({ id: 'x', kind: WIDGETS.BUTTON, shape: 'rect', x: 0, y: 0, w: 10, h: 10, action: 'go' });
    let reached = false;
    p.on('go', () => { throw new Error('bad'); });
    p.on('go', () => { reached = true; });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => p.activateId('x')).not.toThrow();
    expect(reached).toBe(true);
    console.error.mockRestore();
  });

  test('unsubscribing stops delivery', () => {
    const p = new Panel({ width: W, height: H });
    p.add({ id: 'x', kind: WIDGETS.BUTTON, shape: 'rect', x: 0, y: 0, w: 10, h: 10, action: 'go' });
    let n = 0;
    const off = p.on('go', () => { n++; });
    p.activateId('x');
    off();
    p.activateId('x');
    expect(n).toBe(1);
  });

  test('adding a widget without an id throws rather than failing silently', () => {
    const p = new Panel({ width: W, height: H });
    expect(() => p.add({ kind: WIDGETS.BUTTON })).toThrow();
  });
});

describe('slider dragging', () => {
  const sliderPanel = () => {
    const p = new Panel({ width: W, height: H });
    p.add({
      id: 'speed', kind: WIDGETS.SLIDER, shape: 'rect',
      x: 100, y: 100, w: 400, h: 30,
      min: 2, max: 25, step: 0.5, value: 8, action: 'speedChange',
    });
    return p;
  };

  test('dragging emits the new value', () => {
    const p = sliderPanel();
    const seen = [];
    p.on('speedChange', (e) => seen.push(e.value));
    p.dragSliderUV('speed', 500 / W, 1 - 110 / H);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(8);
  });

  test('dragging to the same value does not re-emit', () => {
    // Otherwise a held laser floods handlers every frame.
    const p = sliderPanel();
    let n = 0;
    p.on('speedChange', () => { n++; });
    p.dragSliderUV('speed', 500 / W, 1 - 110 / H);
    p.dragSliderUV('speed', 500 / W, 1 - 110 / H);
    expect(n).toBe(1);
  });

  test('dragging a non-slider is a no-op', () => {
    const p = sliderPanel();
    p.add({ id: 'btn', kind: WIDGETS.BUTTON, shape: 'rect', x: 0, y: 0, w: 10, h: 10 });
    expect(p.dragSliderUV('btn', 0.5, 0.5)).toBeNull();
  });

  test('a drag outside the panel is ignored', () => {
    expect(sliderPanel().dragSliderUV('speed', 5, 5)).toBeNull();
  });
});

describe('list layout', () => {
  test('rows are evenly spaced and carry their source index', () => {
    const rows = listRows({ x: 10, y: 50, w: 300, rowH: 40, gap: 8, count: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0].y).toBe(50);
    expect(rows[1].y).toBe(98);
    expect(rows[2].index).toBe(2);
  });

  test('maxRows caps visible rows and scroll offsets the indices', () => {
    const rows = listRows({ x: 0, y: 0, w: 100, rowH: 10, count: 9, maxRows: 4, scroll: 3 });
    expect(rows).toHaveLength(4);
    expect(rows[0].index).toBe(3);
    expect(rows[3].index).toBe(6);
  });

  test('clampScroll stops a list scrolling past its end', () => {
    expect(clampScroll(99, 9, 4)).toBe(5);
    expect(clampScroll(-3, 9, 4)).toBe(0);
  });

  test('a list that fits is not scrollable at all', () => {
    expect(clampScroll(3, 3, 9)).toBe(0);
  });
});
