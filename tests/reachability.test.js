// Reachability gate unit tests. Spec §section_3.

const THREE = require('three');

import {
  checkReachability,
  REACHABILITY,
} from '../js/modes/aiMatch/reachability.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

describe('checkReachability', () => {
  test('zero distance is always reachable', () => {
    const r = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: v(0, 0, 0),
      timeBudgetMs: 500,
      maxPaddleSpeed: 4.0,
    });
    expect(r.status).toBe(REACHABILITY.REACHABLE);
    expect(r.requiredAvgSpeed).toBe(0);
    expect(r.missDirection).toBeNull();
  });

  test('distance / time within 0.80x cap = reachable', () => {
    // distance 1m in 500ms → required 2 m/s. Cap = 4 m/s. 0.80×4 = 3.2. 2 ≤ 3.2.
    const r = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: v(1, 0, 0),
      timeBudgetMs: 500,
      maxPaddleSpeed: 4.0,
    });
    expect(r.status).toBe(REACHABILITY.REACHABLE);
    expect(r.requiredAvgSpeed).toBeCloseTo(2.0, 6);
  });

  test('distance / time between 0.80x and 1.00x = stretched', () => {
    // required 3.5 m/s. 0.80×4 = 3.2, 1.00×4 = 4. 3.2 < 3.5 ≤ 4.
    const r = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: v(1.75, 0, 0),
      timeBudgetMs: 500,
      maxPaddleSpeed: 4.0,
    });
    expect(r.status).toBe(REACHABILITY.STRETCHED);
    expect(r.requiredAvgSpeed).toBeCloseTo(3.5, 6);
  });

  test('distance / time exceeding cap = unreachable, with miss direction', () => {
    const r = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: v(3, 0, 0),
      timeBudgetMs: 500,
      maxPaddleSpeed: 4.0,
    });
    expect(r.status).toBe(REACHABILITY.UNREACHABLE);
    expect(r.requiredAvgSpeed).toBeCloseTo(6.0, 6);
    expect(r.missDirection).not.toBeNull();
    expect(r.missDirection.x).toBeCloseTo(1.0, 6);
    expect(r.missDirection.length()).toBeCloseTo(1.0, 6); // normalized
  });

  test('zero/negative time budget = unreachable', () => {
    const r = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: v(0.5, 0, 0),
      timeBudgetMs: 0,
      maxPaddleSpeed: 4.0,
    });
    expect(r.status).toBe(REACHABILITY.UNREACHABLE);
    expect(r.requiredAvgSpeed).toBe(Infinity);
  });

  test('3D distance is used (not just XZ)', () => {
    // 1m on each axis → distance = sqrt(3) ≈ 1.732. In 500ms = 3.46 m/s.
    // 0.80×4 = 3.2 < 3.46 ≤ 4 → stretched.
    const r = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: v(1, 1, 1),
      timeBudgetMs: 500,
      maxPaddleSpeed: 4.0,
    });
    expect(r.status).toBe(REACHABILITY.STRETCHED);
    expect(r.requiredAvgSpeed).toBeCloseTo(Math.sqrt(3) / 0.5, 5);
  });

  test('cap scales linearly — Pro can reach what Beginner cannot', () => {
    // 2.5m in 500ms = 5 m/s. Beginner cap 4 → 5/4 = 1.25× → unreachable.
    // Pro cap 11 → 5/(11*0.8) = 0.57× → reachable.
    const distance = v(2.5, 0, 0);
    const beginnerR = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: distance,
      timeBudgetMs: 500,
      maxPaddleSpeed: 4.0,
    });
    const proR = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: distance,
      timeBudgetMs: 500,
      maxPaddleSpeed: 11.0,
    });
    expect(beginnerR.status).toBe(REACHABILITY.UNREACHABLE);
    expect(proR.status).toBe(REACHABILITY.REACHABLE);
  });
});

// The gate must measure FOOTWORK, not racket-head speed. It used to be handed
// the strike cap, which meant Intermediate was treated as covering 0.80 x 7.0
// = 5.6 m/s of court while its documented body speed was 2.2 m/s. Wide balls
// that should have stretched or beaten it came back as routine, and per-tier
// footwork stopped affecting play at all.
describe('checkReachability — gated on footwork, not strike speed', () => {
  test('maxApproachSpeed takes precedence over the legacy maxPaddleSpeed alias', () => {
    // 2m in 500ms → 4 m/s required. Footwork 2.2 m/s cannot do it; the old
    // strike cap of 7.0 would have called it reachable.
    const args = {
      currentPos: v(0, 0, 0),
      contactPos: v(2, 0, 0),
      timeBudgetMs: 500,
    };
    const footwork = checkReachability({ ...args, maxApproachSpeed: 2.2, maxPaddleSpeed: 7.0 });
    const strike   = checkReachability({ ...args, maxPaddleSpeed: 7.0 });
    expect(footwork.status).toBe(REACHABILITY.UNREACHABLE);
    expect(strike.status).toBe(REACHABILITY.REACHABLE);
  });

  test('the legacy alias still works alone (back-compat)', () => {
    const r = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: v(1, 0, 0),
      timeBudgetMs: 500,
      maxPaddleSpeed: 4.0,
    });
    expect(r.status).toBe(REACHABILITY.REACHABLE);
  });

  test('faster footwork covers strictly more court', () => {
    // A ball 1.4m wide with 500ms to reach it: required 2.8 m/s.
    const args = {
      currentPos: v(0, 0, 0),
      contactPos: v(1.4, 0, 0),
      timeBudgetMs: 500,
    };
    // 1.5 m/s (beginner) can't. 4.0 m/s (international) can.
    expect(checkReachability({ ...args, maxApproachSpeed: 1.5 }).status)
      .toBe(REACHABILITY.UNREACHABLE);
    expect(checkReachability({ ...args, maxApproachSpeed: 4.0 }).status)
      .toBe(REACHABILITY.REACHABLE);
  });

  test('a wide ball still beats even international footwork', () => {
    // The tier must have a reachable limit, or there is no skill ceiling.
    // 1.6m in 250ms → 6.4 m/s required; 4.0 m/s footwork cannot.
    const r = checkReachability({
      currentPos: v(0, 0, 0),
      contactPos: v(1.6, 0, 0),
      timeBudgetMs: 250,
      maxApproachSpeed: 4.0,
    });
    expect(r.status).toBe(REACHABILITY.UNREACHABLE);
    expect(r.missDirection).not.toBeNull();
  });
});
