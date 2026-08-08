// Unit tests for V2 ready-position module. Spec §section_4.

const THREE = require('three');

import {
  computeReadyPose,
  recordPlayerLanding,
  resetRecentLandings,
  _recentLandingCount,
  READY_POSITION_CONSTANTS,
} from '../js/modes/aiMatch/readyPosition.js';

function makeEnv() {
  // ITTF-correct table, centered at origin.
  return {
    tableBox: new THREE.Box3(
      new THREE.Vector3(-0.7625, -0.01, -1.37),
      new THREE.Vector3( 0.7625,  0.01,  1.37),
    ),
    tableSurfaceY: 0.0,
  };
}

beforeEach(() => {
  resetRecentLandings();
});

describe('READY_POSITION_CONSTANTS — spec-pinned values', () => {
  test('neutral offsets match spec', () => {
    expect(READY_POSITION_CONSTANTS.NEUTRAL_Y_ABOVE_TABLE_M).toBeCloseTo(0.19, 8);
    expect(READY_POSITION_CONSTANTS.NEUTRAL_Z_BEHIND_AI_EDGE_M).toBeCloseTo(0.13, 8);
  });

  test('bias factor 30% and cap 0.20m', () => {
    expect(READY_POSITION_CONSTANTS.BIAS_FACTOR).toBeCloseTo(0.30, 8);
    expect(READY_POSITION_CONSTANTS.BIAS_CAP_M).toBeCloseTo(0.20, 8);
  });

  test('recent landing capacity 10', () => {
    expect(READY_POSITION_CONSTANTS.RECENT_LANDINGS_CAPACITY).toBe(10);
  });
});

describe('computeReadyPose — neutral baseline (no landings recorded)', () => {
  test('beginner returns neutral pose anchored to table geometry', () => {
    const env = makeEnv();
    const pose = computeReadyPose({ ...env, difficulty: 'beginner' });
    expect(pose.position.x).toBeCloseTo(0, 6);            // center x
    expect(pose.position.y).toBeCloseTo(0.19, 6);          // 19cm above surface
    expect(pose.position.z).toBeCloseTo(-1.37 - 0.13, 6);  // 13cm behind AI edge
    expect(pose.normal.length()).toBeCloseTo(1.0, 5);
    expect(pose.normal.z).toBeGreaterThan(0);              // faces toward player (+z)
  });

  test('intermediate returns same neutral pose as beginner (no bias)', () => {
    const env = makeEnv();
    const beg = computeReadyPose({ ...env, difficulty: 'beginner' });
    const int = computeReadyPose({ ...env, difficulty: 'intermediate' });
    expect(int.position.equals(beg.position)).toBe(true);
    expect(int.normal.equals(beg.normal)).toBe(true);
  });

  test('pro returns neutral pose when no landings recorded', () => {
    const env = makeEnv();
    const pose = computeReadyPose({ ...env, difficulty: 'pro' });
    expect(pose.position.x).toBeCloseTo(0, 6);
    expect(pose.position.z).toBeCloseTo(-1.50, 6);
  });

  test('falls back gracefully when tableBox is missing', () => {
    const pose = computeReadyPose({ difficulty: 'beginner' });
    expect(pose.position).toBeDefined();
    expect(pose.normal.length()).toBeCloseTo(1.0, 5);
  });
});

describe('recordPlayerLanding + Pro anticipatory bias', () => {
  test('non-Pro difficulties IGNORE recorded landings', () => {
    const env = makeEnv();
    for (let i = 0; i < 10; i++) recordPlayerLanding(0.6, -0.5);
    const begPose = computeReadyPose({ ...env, difficulty: 'beginner' });
    expect(begPose.position.x).toBeCloseTo(0, 6); // still neutral
    const interPose = computeReadyPose({ ...env, difficulty: 'intermediate' });
    expect(interPose.position.x).toBeCloseTo(0, 6);
  });

  test('Pro shifts ready position TOWARD player landing centroid', () => {
    const env = makeEnv();
    const neutral = computeReadyPose({ ...env, difficulty: 'pro' });
    // 5 landings all at x=+0.6, z=-0.5 (AI side, player-right corner).
    for (let i = 0; i < 5; i++) recordPlayerLanding(0.6, -0.5);
    const biased = computeReadyPose({ ...env, difficulty: 'pro' });
    expect(biased.position.x).toBeGreaterThan(neutral.position.x);
    expect(biased.position.z).toBeGreaterThan(neutral.position.z); // toward centroid z
  });

  test('Pro bias is exactly 30% of the displacement, capped at ±0.20m', () => {
    const env = makeEnv();
    // Single landing at x=+0.5 → centroid (+0.5, -0.5). Neutral x=0, z=-1.50.
    // bias_x = 0.30 * (0.5 - 0) = +0.15 (well under 0.20 cap).
    // bias_z = 0.30 * (-0.5 - (-1.50)) = +0.30 → capped to +0.20.
    recordPlayerLanding(0.5, -0.5);
    const pose = computeReadyPose({ ...env, difficulty: 'pro' });
    expect(pose.position.x).toBeCloseTo(0 + 0.15, 5);
    expect(pose.position.z).toBeCloseTo(-1.50 + 0.20, 5);  // capped at +0.20
  });

  test('extreme centroid is clamped to ±0.20m on both axes', () => {
    const env = makeEnv();
    // Landing way off-table (huge x). Centroid huge.
    recordPlayerLanding(5.0, 5.0);
    const pose = computeReadyPose({ ...env, difficulty: 'pro' });
    expect(Math.abs(pose.position.x - 0)).toBeLessThanOrEqual(0.20 + 1e-6);
    expect(Math.abs(pose.position.z - (-1.50))).toBeLessThanOrEqual(0.20 + 1e-6);
  });

  test('ring buffer drops oldest beyond capacity', () => {
    const env = makeEnv();
    for (let i = 0; i < 20; i++) recordPlayerLanding(i * 0.1, -0.5);
    expect(_recentLandingCount()).toBe(10);
    // Centroid uses only the last 10: x ranges from 1.0 to 1.9.
    // Mean ≈ 1.45. Bias = 0.30 * 1.45 = 0.435 → capped to 0.20.
    const pose = computeReadyPose({ ...env, difficulty: 'pro' });
    expect(pose.position.x).toBeCloseTo(0.20, 5);
  });

  test('reset clears the buffer', () => {
    recordPlayerLanding(0.5, -0.5);
    recordPlayerLanding(-0.5, -0.5);
    expect(_recentLandingCount()).toBe(2);
    resetRecentLandings();
    expect(_recentLandingCount()).toBe(0);
    const pose = computeReadyPose({ ...makeEnv(), difficulty: 'pro' });
    expect(pose.position.x).toBeCloseTo(0, 6);
  });

  test('non-finite landings are ignored', () => {
    recordPlayerLanding(NaN, 0);
    recordPlayerLanding(0, Infinity);
    recordPlayerLanding(undefined, 0);
    expect(_recentLandingCount()).toBe(0);
  });
});
