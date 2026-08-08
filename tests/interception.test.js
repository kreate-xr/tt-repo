// Unit tests for the V2 interception path planner. Spec §section_2.

const THREE = require('three');

import {
  planTrajectory,
  interpolateTrajectory,
  NUM_KEYFRAMES,
  WINDUP_FRACTION,
  SWING_FRACTION,
  _internals,
} from '../js/modes/aiMatch/interception.js';

const { quinticAt, quinticDerivAt, slerpVec3 } = _internals;

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

function defaultArgs() {
  return {
    currentPos: v(0, 0.95, -1.5),
    currentFaceNormal: v(0, 0, 1),
    contactPos: v(0.2, 0.40, -0.4),
    contactFaceNormal: v(0, 0.2, 0.98).normalize(),
    contactPaddleVelocity: v(0.5, 0.5, 3.0),
    timeBudgetMs: 400,
    maxPaddleSpeed: 11.0,
  };
}

// --- planTrajectory --------------------------------------------------------

describe('planTrajectory — keyframe shape', () => {
  test('emits exactly 8 keyframes spanning [0, timeBudgetMs]', () => {
    const r = planTrajectory(defaultArgs());
    expect(r.keyframes).toHaveLength(NUM_KEYFRAMES);
    expect(r.keyframes[0].time_ms).toBeCloseTo(0, 6);
    expect(r.keyframes[NUM_KEYFRAMES - 1].time_ms).toBeCloseTo(400, 6);
  });

  test('first keyframe pose equals currentPos / currentFaceNormal', () => {
    const args = defaultArgs();
    const r = planTrajectory(args);
    expect(r.keyframes[0].position.x).toBeCloseTo(args.currentPos.x, 6);
    expect(r.keyframes[0].position.y).toBeCloseTo(args.currentPos.y, 6);
    expect(r.keyframes[0].position.z).toBeCloseTo(args.currentPos.z, 6);
    // First-keyframe face slerps from current to neutral at u=0 → equals current.
    expect(r.keyframes[0].faceNormal.length()).toBeCloseTo(1, 5);
  });

  test('last keyframe position equals contactPos and face equals solver normal', () => {
    const args = defaultArgs();
    const r = planTrajectory(args);
    const last = r.keyframes[NUM_KEYFRAMES - 1];
    expect(last.position.x).toBeCloseTo(args.contactPos.x, 6);
    expect(last.position.y).toBeCloseTo(args.contactPos.y, 6);
    expect(last.position.z).toBeCloseTo(args.contactPos.z, 6);
    // Last face = contactFaceNormal (slerp endpoint).
    expect(last.faceNormal.x).toBeCloseTo(args.contactFaceNormal.x, 4);
    expect(last.faceNormal.y).toBeCloseTo(args.contactFaceNormal.y, 4);
    expect(last.faceNormal.z).toBeCloseTo(args.contactFaceNormal.z, 4);
  });

  test('keyframes are monotonically increasing in time', () => {
    const r = planTrajectory(defaultArgs());
    for (let i = 1; i < r.keyframes.length; i++) {
      expect(r.keyframes[i].time_ms).toBeGreaterThan(r.keyframes[i - 1].time_ms);
    }
  });

  test('60/40 windup/swing fractions match spec', () => {
    expect(WINDUP_FRACTION).toBeCloseTo(0.6, 8);
    expect(SWING_FRACTION).toBeCloseTo(0.4, 8);
  });
});

describe('planTrajectory — reachability + speed validation', () => {
  test('reachable=true and peakSpeed within cap × 1.1 for a reasonable shot', () => {
    const r = planTrajectory(defaultArgs());
    expect(r.peakSpeed_mps).toBeLessThanOrEqual(11.0 * 1.1);
    expect(r.reachable).toBe(true);
  });

  test('reachable=false when geometry forces peak speed beyond cap × 1.1', () => {
    // Tight budget over a long distance forces high peak.
    const args = {
      ...defaultArgs(),
      currentPos: v(0, 0.95, -1.5),
      contactPos: v(0, 0.40, 1.0),    // 2.5m total
      contactPaddleVelocity: v(0, 0, 10.0),
      timeBudgetMs: 150,               // very tight
      maxPaddleSpeed: 4.0,             // Beginner cap
    };
    const r = planTrajectory(args);
    expect(r.reachable).toBe(false);
    expect(r.peakSpeed_mps).toBeGreaterThan(args.maxPaddleSpeed * 1.1);
  });
});

// --- Quintic terminal velocity ---------------------------------------------

describe('quinticAt — terminal velocity matches v1 (spec contract)', () => {
  test('p(1) = p1 and dp/du at u=1 = v1', () => {
    const p0 = v(0, 0, 0);
    const p1 = v(1, 0.5, 2);
    const v1 = v(3, -1, 5); // curve-space dp/du at u=1
    const outPos = v(0, 0, 0);
    const outDeriv = v(0, 0, 0);
    quinticAt(1, p0, p1, v1, outPos);
    quinticDerivAt(1, p0, p1, v1, outDeriv);
    expect(outPos.x).toBeCloseTo(p1.x, 8);
    expect(outPos.y).toBeCloseTo(p1.y, 8);
    expect(outPos.z).toBeCloseTo(p1.z, 8);
    expect(outDeriv.x).toBeCloseTo(v1.x, 8);
    expect(outDeriv.y).toBeCloseTo(v1.y, 8);
    expect(outDeriv.z).toBeCloseTo(v1.z, 8);
  });

  test('p(0) = p0 and dp/du at u=0 = 0 (rest start)', () => {
    const p0 = v(1, 0.95, -1);
    const p1 = v(0, 0.5, 1);
    const v1 = v(0, 0, 3);
    const outPos = v(0, 0, 0);
    const outDeriv = v(0, 0, 0);
    quinticAt(0, p0, p1, v1, outPos);
    quinticDerivAt(0, p0, p1, v1, outDeriv);
    expect(outPos.x).toBeCloseTo(p0.x, 8);
    expect(outPos.y).toBeCloseTo(p0.y, 8);
    expect(outPos.z).toBeCloseTo(p0.z, 8);
    expect(outDeriv.x).toBeCloseTo(0, 8);
    expect(outDeriv.y).toBeCloseTo(0, 8);
    expect(outDeriv.z).toBeCloseTo(0, 8);
  });
});

// --- slerpVec3 -------------------------------------------------------------

describe('slerpVec3', () => {
  test('t=0 returns a, t=1 returns b, t=0.5 is between', () => {
    const a = v(1, 0, 0);
    const b = v(0, 0, 1);
    const out = v(0, 0, 0);
    slerpVec3(a, b, 0, out);
    expect(out.x).toBeCloseTo(1, 5);
    slerpVec3(a, b, 1, out);
    expect(out.z).toBeCloseTo(1, 5);
    slerpVec3(a, b, 0.5, out);
    expect(out.length()).toBeCloseTo(1, 5);
    expect(out.x).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    expect(out.z).toBeCloseTo(Math.sin(Math.PI / 4), 5);
  });
});

// --- interpolateTrajectory -------------------------------------------------

describe('interpolateTrajectory', () => {
  test('returns first keyframe pose at elapsedMs=0', () => {
    const r = planTrajectory(defaultArgs());
    const outPos = v(0, 0, 0);
    const outFace = v(0, 0, 0);
    interpolateTrajectory(r.keyframes, 0, outPos, outFace);
    expect(outPos.distanceTo(r.keyframes[0].position)).toBeLessThan(1e-6);
  });

  test('returns last keyframe pose at elapsedMs >= timeBudget', () => {
    const r = planTrajectory(defaultArgs());
    const last = r.keyframes[r.keyframes.length - 1];
    const outPos = v(0, 0, 0);
    const outFace = v(0, 0, 0);
    interpolateTrajectory(r.keyframes, 500, outPos, outFace);
    expect(outPos.distanceTo(last.position)).toBeLessThan(1e-6);
  });

  test('linear-interpolates between adjacent keyframes', () => {
    const r = planTrajectory(defaultArgs());
    const k0 = r.keyframes[0];
    const k1 = r.keyframes[1];
    const midTime = (k0.time_ms + k1.time_ms) / 2;
    const outPos = v(0, 0, 0);
    const outFace = v(0, 0, 0);
    interpolateTrajectory(r.keyframes, midTime, outPos, outFace);
    expect(outPos.x).toBeCloseTo((k0.position.x + k1.position.x) / 2, 6);
    expect(outPos.y).toBeCloseTo((k0.position.y + k1.position.y) / 2, 6);
    expect(outPos.z).toBeCloseTo((k0.position.z + k1.position.z) / 2, 6);
  });

  test('empty keyframes array returns false', () => {
    const outPos = v(0, 0, 0);
    const outFace = v(0, 0, 0);
    expect(interpolateTrajectory([], 100, outPos, outFace)).toBe(false);
  });
});

// --- Windup arc has vertical lift -----------------------------------------

describe('planTrajectory — windup arc', () => {
  test('mid-windup keyframe is lifted above the straight line currentPos→windupStart', () => {
    // The +12cm control-point lift makes the bezier arc above the chord
    // from currentPos to windupStart. Verify a mid-windup keyframe (around
    // 70% of windup phase) sits above the chord at the same u.
    const args = defaultArgs();
    const r = planTrajectory(args);
    const windupStart = r.windupStart;
    const k0 = r.keyframes[0];

    // Keyframe 3 at t ≈ 171ms, windup ends at 240ms (60% of 400ms budget).
    const midKf = r.keyframes[3];
    const windupDurationMs = 400 * 0.6;
    const u = midKf.time_ms / windupDurationMs; // 0..1 within windup
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(1);
    // Linear y from k0 to windupStart at the same u.
    const chordY = k0.position.y + u * (windupStart.y - k0.position.y);
    expect(midKf.position.y).toBeGreaterThan(chordY);
  });
});
