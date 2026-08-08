// Ball motion trail tests — verify the streak turns on above the speed
// threshold, stays off below, ramps in over the fade window, and clears on
// reset. Uses the trail module in isolation with a stubbed scene (a bare
// THREE.Group is enough — the trail is added via scene.add and we only
// need to inspect visibility + vertex buffers).

const THREE = require('three');

import {
  createBallTrail, updateBallTrail, resetBallTrail, _trailStateForTest,
  TRAIL_SAMPLES, TRAIL_HEAD_SKIP, TRAIL_MIN_VISIBLE_SAMPLES,
} from '../js/scene/ballTrail.js';

// Push `n` samples at `speed`, spaced far enough apart to look like real
// motion. Several tests need "enough samples to be visible" and hardcoding
// that count is what let these tests drift out of sync with the module when
// TRAIL_HEAD_SKIP was introduced.
function feed(n, speed) {
  for (let i = 0; i < n; i++) updateBallTrail(pos(0, 1, i * 0.17), speed);
}

function pos(x, y, z) { return new THREE.Vector3(x, y, z); }

describe('ballTrail', () => {
  let scene;
  beforeAll(() => {
    scene = new THREE.Group();   // Group is enough — has .add / .children
    createBallTrail(scene);
  });

  beforeEach(() => {
    resetBallTrail();
  });

  test('createBallTrail adds a Line to the scene exactly once', () => {
    const beforeChildren = scene.children.length;
    // Second call is a no-op.
    createBallTrail(scene);
    expect(scene.children.length).toBe(beforeChildren);
    // The Line is present.
    const line = _trailStateForTest().line;
    expect(line).not.toBeNull();
    expect(line.isLine).toBe(true);
  });

  test('trail is invisible when speed is below the fade-in threshold', () => {
    // Push several samples at low speed.
    for (let i = 0; i < 5; i++) {
      updateBallTrail(pos(0, 1, i * 0.02), 2.0);   // 2 m/s < TRAIL_MIN_SPEED (6)
    }
    expect(_trailStateForTest().visible).toBe(false);
  });

  test('trail is invisible with only 1 sample regardless of speed', () => {
    // Speed above threshold but only one push — nothing to draw yet.
    updateBallTrail(pos(0, 1, 0), 15.0);
    expect(_trailStateForTest().visible).toBe(false);
  });

  // The visibility threshold is TRAIL_HEAD_SKIP + 2, not 2: the newest
  // TRAIL_HEAD_SKIP samples are hidden behind the ball, and a line still needs
  // 2 drawable vertices behind them. These assert the RELATIONSHIP so changing
  // the head skip can't silently invalidate them again.
  test('trail stays invisible one sample below the threshold', () => {
    feed(TRAIL_MIN_VISIBLE_SAMPLES - 1, 15.0);
    const s = _trailStateForTest();
    expect(s.sampleCount).toBe(TRAIL_MIN_VISIBLE_SAMPLES - 1);
    expect(s.visible).toBe(false);
  });

  test('trail becomes visible above threshold once enough samples exist', () => {
    feed(TRAIL_MIN_VISIBLE_SAMPLES, 15.0);
    const s = _trailStateForTest();
    expect(s.visible).toBe(true);
    expect(s.sampleCount).toBe(TRAIL_MIN_VISIBLE_SAMPLES);
  });

  test('draw range excludes the head-skip vertices', () => {
    // The whole point of the skip: the newest vertices must not be drawn, or
    // the line paints through the ball at bounce kinks.
    feed(TRAIL_SAMPLES, 15.0);
    const drawRange = _trailStateForTest().line.geometry.drawRange;
    expect(drawRange.count).toBe(TRAIL_SAMPLES - TRAIL_HEAD_SKIP);
  });

  test('head vertex is brightest, tail vertex is dimmest (fade shape)', () => {
    // Fill the buffer completely at max speed → all samples valid, full head brightness.
    for (let i = 0; i < 12; i++) {
      updateBallTrail(pos(0, 1, i * 0.17), 20.0);   // > TRAIL_MAX_SPEED (10) → head at peak
    }
    const s = _trailStateForTest();
    expect(s.visible).toBe(true);
    // Head is the LAST vertex in the buffer (index TRAIL_SAMPLES-1).
    const N = 10;
    const headR = s.colors[(N - 1) * 3];
    const tailR = s.colors[0];
    expect(headR).toBeGreaterThan(tailR);
    expect(headR).toBeGreaterThan(0);
    expect(tailR).toBeCloseTo(0, 6);   // squared falloff → exactly 0 at oldest
  });

  test('head brightness scales linearly with speed inside the fade window', () => {
    // At speed halfway through the fade window, head brightness should be
    // roughly half of the max. Fill the buffer, then read the head color.
    const N = 10;
    for (let i = 0; i < N; i++) {
      updateBallTrail(pos(0, 1, i * 0.09), 8.0);   // midpoint of 6..10
    }
    const midHeadR = _trailStateForTest().colors[(N - 1) * 3];

    resetBallTrail();
    for (let i = 0; i < N; i++) {
      updateBallTrail(pos(0, 1, i * 0.09), 20.0);   // > max → full brightness
    }
    const fullHeadR = _trailStateForTest().colors[(N - 1) * 3];

    // Midpoint of 6..10 is 8, so t = 0.5 → midHead ≈ 0.5 · fullHead.
    expect(midHeadR / fullHeadR).toBeGreaterThan(0.4);
    expect(midHeadR / fullHeadR).toBeLessThan(0.6);
  });

  test('resetBallTrail hides the line and clears the sample count', () => {
    feed(TRAIL_MIN_VISIBLE_SAMPLES, 15.0);
    expect(_trailStateForTest().visible).toBe(true);
    resetBallTrail();
    expect(_trailStateForTest().visible).toBe(false);
    expect(_trailStateForTest().sampleCount).toBe(0);
  });

  test('ring buffer wraps: oldest → newest ordering preserved past N samples', () => {
    const N = 10;
    // Push 15 monotonically-increasing z positions at high speed.
    for (let i = 0; i < 15; i++) {
      updateBallTrail(pos(0, 1, i), 20.0);
    }
    const s = _trailStateForTest();
    // Vertices should reflect the last N samples: z ∈ [5, 6, ..., 14].
    // Index 0 is the OLDEST kept (z=5), index N-1 is the NEWEST (z=14).
    expect(s.positions[0 * 3 + 2]).toBeCloseTo(5, 6);
    expect(s.positions[(N - 1) * 3 + 2]).toBeCloseTo(14, 6);
    // And the tail is properly ordered — strictly increasing z.
    for (let i = 1; i < N; i++) {
      expect(s.positions[i * 3 + 2]).toBeGreaterThan(s.positions[(i - 1) * 3 + 2]);
    }
  });

  test('trail does not blow up on very high speeds or bad inputs', () => {
    feed(TRAIL_MIN_VISIBLE_SAMPLES, 40.0);
    const s = _trailStateForTest();
    expect(s.visible).toBe(true);
    // Head brightness clamped at peak — no runaway.
    const headR = s.colors[(TRAIL_SAMPLES - 1) * 3];
    expect(headR).toBeLessThanOrEqual(1.0);
    expect(headR).toBeGreaterThan(0);
  });
});
