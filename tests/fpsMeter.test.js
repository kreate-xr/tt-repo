// Refresh-rate estimation for the in-headset FPS meter.
//
// The regression these tests exist for: the first implementation estimated the
// display period from the MINIMUM interval in the window. A single short
// interval (XR runtime bursting frames after a stall, or near-duplicate
// timestamps) then set the period to a fraction of a millisecond, which
// collapsed the drop threshold and made every subsequent NORMAL frame count as
// a dropped one — the meter reported ~200 drops/5s on a session that was
// holding a clean 90 Hz. The median is immune to that.

const { estimateDisplayHz } = require('../js/scene/fpsMeter.js');

const P90 = 1 / 90;
const P72 = 1 / 72;
const P60 = 1 / 60;

// A window of `n` intervals at `hz`, with mild jitter so nothing depends on
// the samples being bit-identical.
function window_(hz, n = 120, jitter = 0.0002) {
  const p = 1 / hz;
  const out = [];
  for (let i = 0; i < n; i++) {
    // Deterministic alternating jitter — no RNG, so failures reproduce.
    out.push(p + (i % 2 ? jitter : -jitter));
  }
  return out;
}

describe('estimateDisplayHz', () => {
  test('identifies clean sessions at each common rate', () => {
    expect(estimateDisplayHz(window_(90))).toBe(90);
    expect(estimateDisplayHz(window_(72))).toBe(72);
    expect(estimateDisplayHz(window_(120))).toBe(120);
    expect(estimateDisplayHz(window_(60))).toBe(60);
  });

  test('one anomalously SHORT interval does not poison the estimate', () => {
    // This is the exact bug. A min-based estimator returns ~2000 Hz here.
    const w = window_(90);
    w[47] = 0.0005;
    expect(estimateDisplayHz(w)).toBe(90);
  });

  test('several short bursts still do not poison the estimate', () => {
    const w = window_(90);
    for (const i of [3, 19, 44, 71, 98]) w[i] = 0.0008;
    expect(estimateDisplayHz(w)).toBe(90);
  });

  test('occasional long hitches do not drag the estimate down either', () => {
    const w = window_(90);
    for (const i of [10, 55, 90]) w[i] = 0.25; // quarter-second stalls
    expect(estimateDisplayHz(w)).toBe(90);
  });

  test('a genuinely half-rate session reads as its real rate, not as 90', () => {
    // Every frame doubled: this is a 45 Hz delivery, and the meter should say
    // so via FPS rather than silently calling them all "drops".
    expect(estimateDisplayHz(window_(45))).toBe(45);
  });

  test('estimate is clamped to plausible display rates', () => {
    expect(estimateDisplayHz([1e-6, 1e-6, 1e-6])).toBeLessThanOrEqual(240);
    expect(estimateDisplayHz([10, 10, 10])).toBeGreaterThanOrEqual(30);
  });

  test('degenerate input falls back rather than returning NaN/Infinity', () => {
    expect(estimateDisplayHz([])).toBe(90);
    expect(estimateDisplayHz([0, 0, 0])).toBe(90);
    expect(Number.isFinite(estimateDisplayHz(window_(90), 0))).toBe(true);
  });

  test('respects the count argument (partially-filled ring buffer)', () => {
    const w = window_(90, 120).concat(window_(30, 60));
    // Only the first 120 entries are "valid" — the 30 Hz tail must be ignored.
    expect(estimateDisplayHz(w, 120)).toBe(90);
  });
});

describe('drop classification against the estimated period', () => {
  // Mirrors the meter's rule: an interval spanning >= 1.5 periods is a frame
  // the compositor actually skipped.
  const DROP_FACTOR = 1.5;
  const isDrop = (dt, hz) => dt >= (1 / hz) * DROP_FACTOR;

  test('normal frames at the display rate are never drops', () => {
    for (const [p, hz] of [[P90, 90], [P72, 72], [P60, 60]]) {
      expect(isDrop(p, hz)).toBe(false);
      expect(isDrop(p * 1.2, hz)).toBe(false); // jitter within tolerance
    }
  });

  test('a doubled interval is a drop at every rate', () => {
    expect(isDrop(P90 * 2, 90)).toBe(true);
    expect(isDrop(P72 * 2, 72)).toBe(true);
    expect(isDrop(P60 * 2, 60)).toBe(true);
  });

  test('a clean 90 Hz window produces zero drops end to end', () => {
    const w = window_(90);
    const hz = estimateDisplayHz(w);
    expect(w.filter((dt) => isDrop(dt, hz)).length).toBe(0);
  });

  test('the poisoned-window scenario now yields ~0 drops, not ~every frame', () => {
    const w = window_(90);
    w[47] = 0.0005; // the outlier that used to break everything
    const hz = estimateDisplayHz(w);
    const drops = w.filter((dt) => isDrop(dt, hz)).length;
    expect(drops).toBe(0);
  });

  test('real skips are still counted', () => {
    const w = window_(90);
    for (const i of [5, 25, 60]) w[i] = P90 * 2;
    const hz = estimateDisplayHz(w);
    expect(w.filter((dt) => isDrop(dt, hz)).length).toBe(3);
  });
});
