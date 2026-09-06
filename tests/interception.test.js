// Unit tests for the V2 interception path planner. Spec §section_2.

const THREE = require('three');

import {
  planTrajectory,
  interpolateTrajectory,
  followThroughMs,
  NUM_WINDUP_KEYFRAMES,
  SWING_KEYFRAME_MAX_SPAN_MS,
  swingKeyframeCount,
  WINDUP_FRACTION,
  SWING_FRACTION,
  _internals,
} from '../js/modes/aiMatch/interception.js';

const { quinticAt, quinticDerivAt, slerpVec3 } = _internals;

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

// The keyframe AT the contact instant. The plan now continues past it for the
// follow-through, so the contact pose is no longer the last sample.
function contactKeyframe(r, timeBudgetMs) {
  let best = r.keyframes[0];
  for (const k of r.keyframes) {
    if (Math.abs(k.time_ms - timeBudgetMs) < Math.abs(best.time_ms - timeBudgetMs)) best = k;
  }
  return best;
}

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
  test('spans [0, timeBudgetMs] plus the follow-through', () => {
    const args = defaultArgs();
    const r = planTrajectory(args);
    expect(r.keyframes[0].time_ms).toBeCloseTo(0, 6);
    expect(contactKeyframe(r, 400).time_ms).toBeCloseTo(400, 6);
    const ftMs = followThroughMs(
      args.contactPos, args.contactPaddleVelocity.clone().normalize(),
      args.contactPaddleVelocity.length(), null);
    expect(ftMs).toBeGreaterThan(0);
    expect(r.keyframes[r.keyframes.length - 1].time_ms).toBeCloseTo(400 + ftMs, 6);
  });

  // The whole point of the phase-aware spacing: the FSM reads paddle velocity
  // as a per-frame finite difference of a LINEAR interpolation of these
  // samples, so a swing segment longer than a display frame delivers the
  // chord average of an accelerating curve instead of its derivative. See the
  // note at the top of interception.js, and executionGap.test.js.
  test('swing samples are spaced under a display frame', () => {
    for (const timeBudgetMs of [150, 250, 400, 700]) {
      const r = planTrajectory({ ...defaultArgs(), timeBudgetMs });
      const windupMs = timeBudgetMs * WINDUP_FRACTION;
      for (let i = 1; i < r.keyframes.length; i++) {
        if (r.keyframes[i].time_ms <= windupMs) continue;
        const span = r.keyframes[i].time_ms - r.keyframes[i - 1].time_ms;
        expect(span).toBeLessThanOrEqual(SWING_KEYFRAME_MAX_SPAN_MS + 1e-9);
      }
    }
  });

  test('windup keeps its coarse spacing — only the swing is densified', () => {
    const r = planTrajectory(defaultArgs());
    const windupMs = 400 * WINDUP_FRACTION;
    const windupSamples = r.keyframes.filter((k) => k.time_ms <= windupMs);
    expect(windupSamples).toHaveLength(NUM_WINDUP_KEYFRAMES);
    expect(swingKeyframeCount(400 * SWING_FRACTION)).toBeGreaterThan(NUM_WINDUP_KEYFRAMES);
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

  test('contact keyframe position equals contactPos and face equals solver normal', () => {
    const args = defaultArgs();
    const r = planTrajectory(args);
    const last = contactKeyframe(r, 400);
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

// --- Pace-scaled face reveal + disguise -----------------------------------

describe('planTrajectory — telegraphLeadMs face reveal', () => {
  // Angle between a keyframe face and the neutral face tells us whether the
  // reveal has begun at that keyframe.
  function faceAngleTo(kf, ref) {
    const d = Math.min(1, Math.max(-1,
      kf.faceNormal.x * ref.x + kf.faceNormal.y * ref.y + kf.faceNormal.z * ref.z));
    return Math.acos(d);
  }

  test('a long lead starts the reveal earlier than the legacy 50%-of-swing rule', () => {
    const args = defaultArgs();               // budget 400ms → legacy reveal at 320ms
    const legacy = planTrajectory(args);
    const led = planTrajectory({ ...defaultArgs(), telegraphLeadMs: 350 }); // reveal at 50ms
    // Keyframe index 3 sits at ~171ms — before the legacy reveal, well after
    // the 350ms-lead reveal. Under the lead it must already have rotated
    // toward the contact normal; under legacy it is still neutral-ish.
    const contactFace = defaultArgs().contactFaceNormal;
    expect(faceAngleTo(led.keyframes[3], contactFace))
      .toBeLessThan(faceAngleTo(legacy.keyframes[3], contactFace));
  });

  test('face at contact always equals the solver normal, lead or not', () => {
    for (const telegraphLeadMs of [null, 150, 350]) {
      const args = { ...defaultArgs(), telegraphLeadMs };
      const r = planTrajectory(args);
      const last = contactKeyframe(r, 400);
      expect(last.faceNormal.x).toBeCloseTo(args.contactFaceNormal.x, 4);
      expect(last.faceNormal.y).toBeCloseTo(args.contactFaceNormal.y, 4);
      expect(last.faceNormal.z).toBeCloseTo(args.contactFaceNormal.z, 4);
    }
  });

  test('disguise face is shown mid-reveal, true face restored by contact', () => {
    const disguise = v(0, -0.35, 0.94).normalize();  // slice-like open face
    const args = {
      ...defaultArgs(),
      timeBudgetMs: 600,
      telegraphLeadMs: 350,
      disguiseFaceNormal: disguise,
    };
    const r = planTrajectory(args);
    // Mid-reveal keyframes should sit closer to the disguise face than to
    // the true contact face at least once.
    const contactFace = args.contactFaceNormal;
    let sawDisguise = false;
    for (const kf of r.keyframes.filter((k) => k.time_ms < 600)) {
      const toDisguise = Math.acos(Math.min(1, kf.faceNormal.dot(disguise)));
      const toContact = Math.acos(Math.min(1, kf.faceNormal.dot(contactFace)));
      if (toDisguise < 0.15 && toDisguise < toContact) sawDisguise = true;
    }
    expect(sawDisguise).toBe(true);
    // And the wrist snap lands on the truth.
    const last = contactKeyframe(r, 600);
    expect(last.faceNormal.x).toBeCloseTo(contactFace.x, 4);
    expect(last.faceNormal.y).toBeCloseTo(contactFace.y, 4);
    expect(last.faceNormal.z).toBeCloseTo(contactFace.z, 4);
  });
});

// The 2026-08-30 "paddle vanishes under the table" bug. Two causes, both
// pinned here:
//   1. The windup pull-back distance was contactSpeed × swingDur/2, UNCAPPED —
//      a 15 m/s loop with a 240 ms swing phase asked for a ~1.8 m backswing.
//   2. A topspin loop's swing direction points steeply upward, so the anchor
//      lands far BELOW the contact — under the tabletop, where the AIPaddle's
//      slab-penetration clamp never fires (fully beneath the slab is "clear").
// planTrajectory now caps the pull-back at a human backswing and, when given
// table geometry, keeps the anchor and every keyframe above the felt while
// inside the table footprint.
describe('planTrajectory — stays above the table on upward strikes', () => {
  const tableSurfaceY = 0.78;
  const tableBox = new THREE.Box3(
    v(-0.83, tableSurfaceY - 0.02, -1.37),
    v(0.68, tableSurfaceY + 0.005, 1.37),
  );

  // Elite topspin loop off a mid-height ball taken over the AI side of the
  // table: swing direction mostly upward at real racket-head speed.
  function loopArgs() {
    return {
      currentPos: v(0.3, 1.05, -1.9),
      currentFaceNormal: v(0, 0, 1),
      contactPos: v(0.1, 0.92, -1.1),
      contactFaceNormal: v(0, -0.1, 0.99).normalize(),
      contactPaddleVelocity: v(2.0, 10.0, 4.0), // ~11 m/s, steeply upward
      timeBudgetMs: 600,
      maxPaddleSpeed: 18.0,
      tableBox, tableSurfaceY,
    };
  }

  test('no keyframe over the table dips below the felt', () => {
    const r = planTrajectory(loopArgs());
    for (const k of r.keyframes) {
      const overTable =
        k.position.x >= tableBox.min.x && k.position.x <= tableBox.max.x &&
        k.position.z >= tableBox.min.z && k.position.z <= tableBox.max.z;
      if (overTable) {
        expect(k.position.y).toBeGreaterThanOrEqual(tableSurfaceY);
      }
    }
    // The clamp must not disturb the contact itself (it is above the felt).
    expect(contactKeyframe(r, 600).position.y).toBeCloseTo(0.92, 6);
  });

  test('windup pull-back is capped at a human backswing', () => {
    const args = loopArgs();
    const r = planTrajectory(args);
    // windupStart is the pre-clamp capped anchor only in direction; measure
    // the actual planned pull-back from the emitted keyframes instead: no
    // keyframe may sit further than the cap from the contact.
    const CAP_M = 0.85;
    // Swing-phase frames only; the windup bezier starts from currentPos,
    // which is legitimately further away than the pull-back cap.
    const windupMs = args.timeBudgetMs * WINDUP_FRACTION;
    for (const k of r.keyframes.filter((kf) => kf.time_ms >= windupMs)) {
      expect(k.position.distanceTo(args.contactPos)).toBeLessThanOrEqual(CAP_M + 0.15);
    }
  });

  test('omitting table geometry changes nothing for legal swings', () => {
    // A flat drive whose windup never nears the table must plan identically
    // with and without the table param (the clamp is a no-op there).
    const base = {
      currentPos: v(0, 0.95, -1.8),
      currentFaceNormal: v(0, 0, 1),
      contactPos: v(0.2, 1.0, -1.3),
      contactFaceNormal: v(0, 0.1, 0.99).normalize(),
      contactPaddleVelocity: v(0.5, 1.0, 6.0),
      timeBudgetMs: 500,
      maxPaddleSpeed: 15.0,
    };
    const a = planTrajectory({ ...base });
    const b = planTrajectory({ ...base, tableBox, tableSurfaceY });
    for (let i = 0; i < a.keyframes.length; i++) {
      expect(a.keyframes[i].position.distanceTo(b.keyframes[i].position)).toBeLessThan(1e-9);
    }
  });
});
