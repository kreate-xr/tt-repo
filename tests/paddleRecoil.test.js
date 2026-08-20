// Impact recoil — must kick the blade without detaching the paddle from the hand.
//
// The original recoil translated paddleAnchor by up to 12 mm along
// -contactNormal for 130 ms after each hit. A held object cannot translate
// relative to the hand holding it, so that read as the bat coming loose from
// the grip, and it put the rendered paddle 12 mm from the true grip pose —
// outside the 1 cm contact-visual agreement budget. It is now a rotation about
// the grip pivot: the hand is a fixed point, the blade still kicks.
//
// Rotating about the grip fixed detachment but NOT the agreement budget: the
// face still swung by the full RECOIL_PEAK_M (12 mm ≈ 6° on the live lever)
// while the player's hand did not rotate. A fixed point at the hand with the
// blade swinging around it is a hinge at the hand, which is what "the bat feels
// snapped at the throat" actually was. The old budget test missed it because it
// measured the PIVOT — a fixed point by construction, so always zero. The bound
// now applies where it matters, at the face.
//
// The load-bearing invariants:
//   - the point at the hand does not move, at all, ever
//   - the FACE stays inside the 1 cm agreement budget for the whole window,
//     at any impact speed and any blade weight
//   - the blade moves by the requested distance, in the requested direction
//   - the pose stays rigid (paddle-fixed distances preserved)
//   - the envelope starts at ZERO (an impulse steps angular velocity, not
//     angle), peaks, and terminates

const THREE = require('three');
const {
  RECOIL_PEAK_M, RECOIL_DURATION, RECOIL_MAX_SPEED,
  RECOIL_FACE_BUDGET_M, RECOIL_ATTACK_FRAC,
  recoilEnvelope, recoilPeakForImpact, applyRecoilAboutPivot,
} = require('../js/xr/paddleRecoil.js');

// Realistic geometry from the live rig (see the pivot analysis): the hand at
// the grip origin, the face center ~130 mm out along grip -Z, face normal
// roughly grip +Y (perpendicular to the handle, as a real blade is).
const PIVOT = new THREE.Vector3(0.1, 1.2, -0.35);
const FACE_LOCAL = new THREE.Vector3(0.005, 0.005, -0.130);
const HANDLE_LOCAL = new THREE.Vector3(0, 0.005, 0.0635);

function freshPose() {
  return {
    pos: PIVOT.clone().add(new THREE.Vector3(0, 0.005, -0.02)), // anchor origin
    quat: new THREE.Quaternion(),
  };
}

describe('recoilEnvelope — rises from zero, peaks, decays, terminates', () => {
  test('displacement is CONTINUOUS at impact — no single-frame pose jump', () => {
    // The regression this replaces: the envelope used to be cos(t·π/2), which
    // is 1 at t=0, so the whole kick landed in one frame. An impulse steps
    // angular velocity; it cannot step an angle. Starting anywhere but zero is
    // a pose discontinuity, and the eye reads discontinuity as breakage.
    expect(recoilEnvelope(0)).toBe(0);
    // Still moving off the line immediately (it is struck, not eased into).
    expect(recoilEnvelope(RECOIL_DURATION * 0.02)).toBeGreaterThan(0);
  });

  test('peaks at the attack point and reaches zero at the duration', () => {
    expect(recoilEnvelope(RECOIL_DURATION * RECOIL_ATTACK_FRAC)).toBeCloseTo(1, 9);
    expect(recoilEnvelope(RECOIL_DURATION * 0.5)).toBeLessThan(1);
    expect(recoilEnvelope(RECOIL_DURATION * 0.5)).toBeGreaterThan(0);
    expect(recoilEnvelope(RECOIL_DURATION)).toBe(0);
    expect(recoilEnvelope(RECOIL_DURATION * 2)).toBe(0);
  });

  test('never exceeds 1, rises to the peak then falls monotonically', () => {
    const peakT = RECOIL_DURATION * RECOIL_ATTACK_FRAC;
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {           // rise
      const v = recoilEnvelope((i / 20) * peakT);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    prev = Infinity;
    for (let i = 0; i <= 20; i++) {           // decay
      const v = recoilEnvelope(peakT + (i / 20) * (RECOIL_DURATION - peakT));
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  test('no corner at the peak — the two halves meet with matching slope', () => {
    // A kink here would put a velocity step mid-swing, which reads as a second,
    // smaller impact. Sample the slope either side of the join.
    const peakT = RECOIL_DURATION * RECOIL_ATTACK_FRAC;
    const h = RECOIL_DURATION * 1e-4;
    const slopeBefore = (recoilEnvelope(peakT) - recoilEnvelope(peakT - h)) / h;
    const slopeAfter = (recoilEnvelope(peakT + h) - recoilEnvelope(peakT)) / h;
    expect(Math.abs(slopeBefore)).toBeLessThan(0.5);
    expect(Math.abs(slopeAfter)).toBeLessThan(0.5);
  });

  test('negative or bogus elapsed yields no kick', () => {
    expect(recoilEnvelope(-0.01)).toBe(0);
    expect(recoilEnvelope(NaN)).toBe(0);
  });
});

describe('recoilPeakForImpact — scales with speed, saturates', () => {
  test('zero for a non-impact, saturates at the cap', () => {
    expect(recoilPeakForImpact(0)).toBe(0);
    expect(recoilPeakForImpact(-5)).toBe(0);
    expect(recoilPeakForImpact(RECOIL_MAX_SPEED)).toBeCloseTo(RECOIL_PEAK_M, 9);
    expect(recoilPeakForImpact(RECOIL_MAX_SPEED * 3)).toBeCloseTo(RECOIL_PEAK_M, 9);
  });

  test('a soft touch kicks proportionally less than a smash', () => {
    const soft = recoilPeakForImpact(1.0);
    const smash = recoilPeakForImpact(RECOIL_MAX_SPEED);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(smash / 4);
  });

  test('the face budget clamps last — no multiplier stack can escape it', () => {
    // weightScale is applied before the clamp, so an absurd one must still land
    // inside the bound rather than scaling straight through it.
    expect(recoilPeakForImpact(RECOIL_MAX_SPEED * 10, 50))
      .toBeLessThanOrEqual(RECOIL_FACE_BUDGET_M);
    expect(RECOIL_PEAK_M).toBeLessThanOrEqual(RECOIL_FACE_BUDGET_M);
  });
});

describe('applyRecoilAboutPivot — hand fixed, blade kicks', () => {
  const recoilDir = new THREE.Vector3(0, -1, 0); // into the paddle body

  test('THE invariant: the point at the hand does not move', () => {
    const pose = freshPose();
    const faceBefore = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);
    // Track the paddle-fixed point that currently coincides with the pivot.
    const pivotLocal = PIVOT.clone().sub(pose.pos)
      .applyQuaternion(pose.quat.clone().invert());

    applyRecoilAboutPivot(
      PIVOT, faceBefore, recoilDir, RECOIL_PEAK_M, pose.pos, pose.quat,
    );

    const pivotAfter = pivotLocal.applyQuaternion(pose.quat).add(pose.pos);
    expect(pivotAfter.distanceTo(PIVOT)).toBeLessThan(1e-9);
  });

  test('the blade tip moves the requested distance along the recoil direction', () => {
    const pose = freshPose();
    const faceBefore = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);

    applyRecoilAboutPivot(
      PIVOT, faceBefore, recoilDir, RECOIL_PEAK_M, pose.pos, pose.quat,
    );

    const faceAfter = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);
    const travel = faceAfter.clone().sub(faceBefore);
    // Small-angle: magnitude matches the request to well under a millimeter,
    // and the motion is into the paddle body, not sideways.
    expect(travel.length()).toBeCloseTo(RECOIL_PEAK_M, 4);
    expect(travel.clone().normalize().dot(recoilDir)).toBeGreaterThan(0.99);
  });

  test('the pose stays rigid — handle-to-face distance is unchanged', () => {
    const pose = freshPose();
    const faceBefore = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);
    const handleBefore = HANDLE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);
    const sep = faceBefore.distanceTo(handleBefore);

    applyRecoilAboutPivot(
      PIVOT, faceBefore, recoilDir, RECOIL_PEAK_M, pose.pos, pose.quat,
    );

    const faceAfter = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);
    const handleAfter = HANDLE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);
    expect(faceAfter.distanceTo(handleAfter)).toBeCloseTo(sep, 9);
    expect(pose.quat.length()).toBeCloseTo(1, 9); // still a unit quaternion
  });

  test('THE budget: the FACE stays inside 1 cm for every frame of the window', () => {
    // The test this replaces measured displacement at the PIVOT, which
    // applyRecoilAboutPivot holds fixed by construction — it read zero no
    // matter how far the blade swung, and so passed while the face was 12 mm
    // (≈6°) off the hand. The face is what the player sights down and hits
    // with, so bind the face. Worst case: a saturating smash with the heaviest
    // blade, sampled across the whole envelope.
    const heaviest = 1 + 0.40 * 0.5; // RECOIL_WEIGHT_RANGE at weight 1.0
    const peak = recoilPeakForImpact(RECOIL_MAX_SPEED * 3, heaviest);

    for (let i = 0; i <= 24; i++) {
      const pose = freshPose();
      const env = recoilEnvelope((i / 24) * RECOIL_DURATION);
      const faceBefore = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);

      applyRecoilAboutPivot(
        PIVOT, faceBefore, recoilDir, peak * env, pose.pos, pose.quat,
      );

      const faceAfter = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);
      expect(faceAfter.distanceTo(faceBefore)).toBeLessThan(0.01);
    }
  });

  test('the blade swing stays under 2° — above that it reads as a hinge at the hand', () => {
    // The percept being guarded: hand held still while the blade rotates is
    // kinematically a hinge, and the brain's cheapest explanation for it is a
    // broken throat. Magnitude is the whole defense, since the hand genuinely
    // does not rotate. On the live rig the grip→face lever is ~115 mm.
    const heaviest = 1 + 0.40 * 0.5;
    const peak = recoilPeakForImpact(RECOIL_MAX_SPEED * 3, heaviest);
    const pose = freshPose();
    const faceBefore = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);

    const angle = applyRecoilAboutPivot(
      PIVOT, faceBefore, recoilDir, peak, pose.pos, pose.quat,
    );

    expect(THREE.MathUtils.radToDeg(angle)).toBeLessThan(2);
    expect(angle).toBeGreaterThan(0); // still present — this is a fix, not a delete
  });

  test('degenerate inputs are no-ops, not NaN', () => {
    // Zero displacement.
    let pose = freshPose();
    const before = pose.pos.clone();
    expect(applyRecoilAboutPivot(PIVOT, before.clone(), recoilDir, 0, pose.pos, pose.quat)).toBe(0);
    expect(pose.pos.distanceTo(before)).toBe(0);

    // Face coincident with the pivot (zero lever).
    pose = freshPose();
    expect(applyRecoilAboutPivot(PIVOT, PIVOT.clone(), recoilDir, RECOIL_PEAK_M, pose.pos, pose.quat)).toBe(0);
    expect(Number.isFinite(pose.pos.x)).toBe(true);

    // Recoil direction parallel to the lever — a rotation cannot move a point
    // along its own lever, so no rotation is applied (rather than a huge one).
    pose = freshPose();
    const face = FACE_LOCAL.clone().applyQuaternion(pose.quat).add(pose.pos);
    const alongLever = face.clone().sub(PIVOT).normalize();
    expect(applyRecoilAboutPivot(PIVOT, face, alongLever, RECOIL_PEAK_M, pose.pos, pose.quat)).toBe(0);
    expect(Number.isFinite(pose.quat.w)).toBe(true);
  });
});
