// ClockSync — NTP-style offset estimation over simulated ping-pong exchanges.
//
// The simulation runs two independent clocks: local time `t` and peer time
// `t + TRUE_OFFSET`. Each exchange:
//   t0 = local send time
//   t1 = peer receipt time  = t0 + up + TRUE_OFFSET   (up = uplink delay)
//   t2 = local receipt time = t0 + up + down
// ClockSync sees only {t0, t1} and t2 — never TRUE_OFFSET.

import { ClockSync, PING_INTERVAL_MS } from '../js/network/ClockSync.js';

const TRUE_OFFSET = 12345678; // peer clock minus local clock, ms

// Deterministic PRNG so failures reproduce.
function makeRng(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function exchange(clock, t0, upMs, downMs) {
  const t1 = t0 + upMs + TRUE_OFFSET;
  const t2 = t0 + upMs + downMs;
  clock.onPong({ t0, t1 }, t2);
  return t2;
}

describe('ClockSync', () => {
  test('single symmetric exchange recovers the exact offset', () => {
    const c = new ClockSync();
    exchange(c, 1000, 20, 20);
    expect(c.isReady()).toBe(true);
    expect(c.offset).toBeCloseTo(TRUE_OFFSET, 6);
    expect(c.toLocalTime(5000 + TRUE_OFFSET)).toBeCloseTo(5000, 6);
    expect(c.oneWayMs()).toBeCloseTo(20, 6);
  });

  test('converges near truth under noisy RTT (40 ± 20 ms)', () => {
    const c = new ClockSync();
    const rng = makeRng();
    let t = 1000;
    for (let i = 0; i < 16; i++) {
      // Base 20 ms each way plus up to 20 ms of asymmetric queuing noise.
      const up = 10 + rng() * 20;
      const down = 10 + rng() * 20;
      exchange(c, t, up, down);
      t += PING_INTERVAL_MS;
    }
    // Accuracy is bounded by the asymmetry of the min-RTT sample:
    // (rtt_min - 20 ms floor) / 2. With 16 uniform samples that lands within
    // a few ms — far below the 35 ms interpolation-delay granularity it feeds.
    expect(Math.abs(c.offset - TRUE_OFFSET)).toBeLessThan(3);
  });

  test('min-RTT sample wins over high-RTT outliers', () => {
    const c = new ClockSync();
    // One clean symmetric sample...
    exchange(c, 1000, 15, 15);
    // ...followed by grossly asymmetric congested samples. Their raw offsets
    // are wrong by (down-up)/2 = 90 ms, but their RTT (400) never beats 30,
    // so the estimate must stay pinned to the clean sample.
    let t = 1000 + PING_INTERVAL_MS;
    for (let i = 0; i < 10; i++) {
      exchange(c, t, 10, 190);
      t += PING_INTERVAL_MS;
    }
    expect(Math.abs(c.offset - TRUE_OFFSET)).toBeLessThan(0.001);
  });

  test('window slides: old minimum expires after SAMPLE_WINDOW exchanges', () => {
    const c = new ClockSync();
    exchange(c, 1000, 15, 15); // clean sample, rtt 30
    let t = 1000 + PING_INTERVAL_MS;
    // 20 samples (> window of 16) with rtt 100 and a consistent 10 ms
    // asymmetry — once the clean sample ages out, EWMA slews toward the
    // asymmetric estimate rather than staying pinned forever.
    for (let i = 0; i < 20; i++) {
      exchange(c, t, 40, 60);
      t += PING_INTERVAL_MS;
    }
    expect(Math.abs(c.offset - TRUE_OFFSET)).toBeGreaterThan(1);
    expect(Math.abs(c.offset - TRUE_OFFSET)).toBeLessThanOrEqual(10);
  });

  test('rejects malformed and negative-RTT pongs', () => {
    const c = new ClockSync();
    c.onPong(null, 100);
    c.onPong({ t0: 'x', t1: 5 }, 100);
    c.onPong({ t0: 500, t1: 5 }, 400); // t2 < t0 → negative rtt
    expect(c.isReady()).toBe(false);
    expect(c.oneWayMs()).toBe(null);
  });

  test('seed() carries an offset across reconnects', () => {
    const c = new ClockSync();
    c.seed(TRUE_OFFSET);
    expect(c.isReady()).toBe(true);
    expect(c.toLocalTime(TRUE_OFFSET + 777)).toBeCloseTo(777, 6);
    c.seed(NaN); // ignored
    expect(c.offset).toBe(TRUE_OFFSET);
  });

  test('queuingDelayMs is null before any pong, ~0 on a stable link', () => {
    const c = new ClockSync();
    expect(c.queuingDelayMs()).toBe(null);
    let t = 1000;
    for (let i = 0; i < 8; i++) {
      exchange(c, t, 20, 20); // constant rtt 40
      t += PING_INTERVAL_MS;
    }
    expect(c.queuingDelayMs()).toBeCloseTo(0, 6);
  });

  test('queuingDelayMs rises under bufferbloat and decays on recovery', () => {
    const c = new ClockSync();
    let t = 1000;
    for (let i = 0; i < 8; i++) { exchange(c, t, 20, 20); t += PING_INTERVAL_MS; }
    // Bufferbloat: rtt jumps 40 → 200 while the windowed min still holds 40.
    for (let i = 0; i < 8; i++) { exchange(c, t, 20, 180); t += PING_INTERVAL_MS; }
    expect(c.queuingDelayMs()).toBeGreaterThan(100);
    // Load removed: smoothed rtt decays back toward the 40 ms base.
    for (let i = 0; i < 24; i++) { exchange(c, t, 20, 20); t += PING_INTERVAL_MS; }
    expect(c.queuingDelayMs()).toBeLessThan(5);
  });

  test('makePing / makePong round-trip carries t0 through', () => {
    const c = new ClockSync();
    const ping = c.makePing(1234);
    expect(ping.t0).toBe(1234);
    const pong = c.makePong(ping, 9999);
    expect(pong.t0).toBe(1234);
    expect(pong.t1).toBe(9999);
  });
});
