// SwingTracker / preparationGain — the player's biomechanical governor.
//
// WHAT THIS PINS DOWN. PLAYER_SPIN_GAIN is a ceiling that has to be earned by
// an actual stroke, because the friction impulse it scales carries a LINEAR
// half (impulse.js, HOLLOW_SPHERE_MOI_FACTOR) as well as spin. Without a
// governor a VR player can produce a maximum-energy stroke against any ball
// at any rally speed — which is invisible against the AI (paddleSolver
// inverts through (1 + e) and dissipates the surplus) and compounds between
// two humans. These tests fix the shape of the earning curve and the
// walk-back that measures it.

const {
  SwingTracker,
  preparationFraction,
  preparationGain,
  SWING_PREP_MIN_M,
  SWING_PREP_FULL_M,
  SWING_PREP_WINDOW_SEC,
  SWING_PREP_STALL_MPS,
} = require('../js/physics/swingPreparation.js');

const DT = 1 / 90;

// Push `n` frames of straight-line motion at `speed` along +y, starting at
// time t0 / height y0. Returns the state after the last sample.
function pushRun(tr, { n, speed, t0 = 0, y0 = 0, dt = DT }) {
  let t = t0;
  let y = y0;
  tr.sample(t, 0, y, 0);
  for (let i = 0; i < n; i++) {
    t += dt;
    y += speed * dt;
    tr.sample(t, 0, y, 0);
  }
  return { t, y };
}

describe('preparationFraction', () => {
  test('is zero at or below the jab threshold and one at a committed stroke', () => {
    expect(preparationFraction(0)).toBe(0);
    expect(preparationFraction(SWING_PREP_MIN_M)).toBe(0);
    expect(preparationFraction(SWING_PREP_FULL_M)).toBe(1);
    expect(preparationFraction(SWING_PREP_FULL_M * 3)).toBe(1);
  });

  test('rises monotonically and smoothly between them', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const travel = SWING_PREP_MIN_M +
        (SWING_PREP_FULL_M - SWING_PREP_MIN_M) * (i / 20);
      const f = preparationFraction(travel);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
    // Smoothstep: flat at both ends, half-way at the midpoint.
    const mid = (SWING_PREP_MIN_M + SWING_PREP_FULL_M) / 2;
    expect(preparationFraction(mid)).toBeCloseTo(0.5, 6);
  });

  test('handles a degenerate range without dividing by zero', () => {
    expect(preparationFraction(0.2, 0.3, 0.3)).toBe(0);
    expect(preparationFraction(0.4, 0.3, 0.3)).toBe(1);
  });
});

describe('preparationGain', () => {
  test('never reduces spin below raw physics', () => {
    // The same floor setPlayerSpinGain clamps to: this compensates a slow
    // input, it does not model a worse-than-physical contact.
    expect(preparationGain(0, 2.5)).toBe(1);
    expect(preparationGain(-1, 2.5)).toBe(1);
    expect(preparationGain(SWING_PREP_MIN_M, 2.5)).toBe(1);
  });

  test('reaches exactly the ceiling for a committed stroke', () => {
    expect(preparationGain(SWING_PREP_FULL_M, 2.5)).toBeCloseTo(2.5, 12);
    expect(preparationGain(10, 2.5)).toBeCloseTo(2.5, 12);
  });

  test('a disabled ceiling stays disabled at any travel', () => {
    expect(preparationGain(10, 1)).toBe(1);
    expect(preparationGain(10, 0)).toBe(1);
  });
});

describe('SwingTracker.strokeTravel', () => {
  test('accumulates a straight run-up along the swing axis', () => {
    const tr = new SwingTracker();
    pushRun(tr, { n: 10, speed: 2.7 });
    // 10 frames at 2.7 m/s and 1/90 s each.
    expect(tr.strokeTravel(0, 1, 0)).toBeCloseTo(10 * 2.7 * DT, 9);
  });

  test('needs two samples before it will report anything', () => {
    const tr = new SwingTracker();
    expect(tr.strokeTravel(0, 1, 0)).toBe(0);
    tr.sample(0, 0, 0, 0);
    expect(tr.strokeTravel(0, 1, 0)).toBe(0);
  });

  test('a stationary paddle earns nothing — a block is not a stroke', () => {
    const tr = new SwingTracker();
    pushRun(tr, { n: 10, speed: 0 });
    // Direction comes from paddle velocity, which is zero here.
    expect(tr.strokeTravel(0, 0, 0)).toBe(0);
    // Even given a direction, there is no forward motion to find.
    expect(tr.strokeTravel(0, 1, 0)).toBe(0);
  });

  test('stops at the turnaround — the backswing is not part of the stroke', () => {
    const tr = new SwingTracker();
    // Pull back 0.30 m, then drive forward 0.12 m. Only the forward half is
    // the stroke; the walk-back must stop dead at the reversal.
    const back = pushRun(tr, { n: 10, speed: -2.7 });
    pushRun(tr, { n: 4, speed: 2.7, t0: back.t, y0: back.y });
    expect(tr.strokeTravel(0, 1, 0)).toBeCloseTo(4 * 2.7 * DT, 9);
  });

  test('ignores drift below the stall speed', () => {
    const tr = new SwingTracker();
    // Hold the paddle out, creeping forward well under the stall threshold,
    // then make a real 4-frame move. Only the real move counts.
    const drift = pushRun(tr, { n: 20, speed: SWING_PREP_STALL_MPS * 0.5 });
    pushRun(tr, { n: 4, speed: 2.7, t0: drift.t, y0: drift.y });
    expect(tr.strokeTravel(0, 1, 0)).toBeCloseTo(4 * 2.7 * DT, 9);
  });

  test('drops motion older than the stroke window', () => {
    const tr = new SwingTracker();
    const tracked = new SwingTracker();
    // One continuous forward motion, but spanning longer than the window:
    // only the tail within SWING_PREP_WINDOW_SEC may be counted.
    const frames = Math.ceil((SWING_PREP_WINDOW_SEC * 2) / DT);
    pushRun(tr, { n: frames, speed: 2.7 });
    const travel = tr.strokeTravel(0, 1, 0);
    expect(travel).toBeLessThan(2.7 * SWING_PREP_WINDOW_SEC + 1e-6);
    // And it really is capped by the window, not by the ring running out.
    expect(travel).toBeGreaterThan(0);
    expect(tracked.strokeTravel(0, 1, 0)).toBe(0);
  });

  test('measures along the swing axis, not total path length', () => {
    const tr = new SwingTracker();
    // Move diagonally at 45° in the y/z plane; travel along +y is the
    // projection, so 1/sqrt(2) of the path.
    let t = 0;
    let y = 0;
    let z = 0;
    tr.sample(t, 0, y, z);
    for (let i = 0; i < 10; i++) {
      t += DT; y += 0.02; z += 0.02;
      tr.sample(t, 0, y, z);
    }
    expect(tr.strokeTravel(0, 1, 0)).toBeCloseTo(0.2, 9);
    // Given the actual swing direction it recovers the full path.
    expect(tr.strokeTravel(0, 1, 1)).toBeCloseTo(0.2 * Math.SQRT2, 9);
  });

  test('accepts an unnormalized direction — callers pass raw velocity', () => {
    const tr = new SwingTracker();
    pushRun(tr, { n: 6, speed: 2.7 });
    const unit = tr.strokeTravel(0, 1, 0);
    expect(tr.strokeTravel(0, 12.5, 0)).toBeCloseTo(unit, 12);
  });

  test('survives ring wraparound without reading stale slots', () => {
    const tr = new SwingTracker(8);
    // 40 frames through an 8-slot ring: the walk-back must stop at the
    // oldest live sample, never wrap into slots it has already overwritten.
    pushRun(tr, { n: 40, speed: 2.7 });
    expect(tr.strokeTravel(0, 1, 0)).toBeCloseTo(7 * 2.7 * DT, 9);
  });

  test('reset drops the previous stroke entirely', () => {
    const tr = new SwingTracker();
    pushRun(tr, { n: 10, speed: 2.7 });
    expect(tr.strokeTravel(0, 1, 0)).toBeGreaterThan(0);
    tr.reset();
    expect(tr.strokeTravel(0, 1, 0)).toBe(0);
  });

  test('does not allocate on the sample path', () => {
    // The tick calls sample() every XR frame; a GC pause on Quest reads as a
    // dropped frame. Flat typed storage is the contract — assert the buffer
    // identity never changes across a long run.
    const tr = new SwingTracker(16);
    const buf = tr.buf;
    for (let i = 0; i < 500; i++) tr.sample(i * DT, 0, i * 0.01, 0);
    expect(tr.buf).toBe(buf);
    expect(tr.buf.length).toBe(16 * 4);
  });
});
