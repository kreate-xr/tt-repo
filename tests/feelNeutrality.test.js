// P13 spec §C6a — feel-neutrality invariant.
//
// The rule: calibration changes WHERE the blade is; it must never change HOW
// the blade behaves. No T_cal parameter may reach restitution / grip / friction
// constants, and two different (T_cal, grip trajectory) pairs that produce the
// SAME world-space blade trajectory must produce the SAME contact physics.
//
// Grounded on the P13 architecture in this codebase: T_cal is composed onto
// paddleAnchor in xrPaddle.js:updatePaddleVisual via composeCalibratedPose,
// and ball.js reads pose from that same anchor via inGame.js → tickPhysics.
// So if two composed anchor poses match at every timestep, the physics tick
// sees identical inputs and must produce identical outputs — this file
// enforces the composition invariance directly, and the "no physics constant
// import" rule via source-scan.

const THREE = require('three');
const fs = require('fs');
const path = require('path');
import {
  composeCalibratedPose,
  composePoseWith,
  setCalibration,
  setPreset,
} from '../js/xr/calibration.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }
function q(x, y, z, w) { return new THREE.Quaternion(x, y, z, w); }
function qAxisAngle(ax, ay, az, deg) {
  return new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(ax, ay, az).normalize(),
    (deg * Math.PI) / 180,
  );
}

// Given a desired world blade pose T_world and a T_cal, solve backwards for
// the grip world pose that produces T_world when calibrated:
//   T_world.pos  = gripPos + gripQuat * posOffset
//   T_world.quat = gripQuat * rotOffset
// So gripQuat = T_world.quat * rotOffset⁻¹, and gripPos = T_world.pos -
// gripQuat * posOffset.
function solveGripForCalibratedPose(worldPos, worldQuat, posOffset, rotOffset, outGripPos, outGripQuat) {
  outGripQuat.copy(worldQuat).multiply(rotOffset.clone().invert());
  const shifted = posOffset.clone().applyQuaternion(outGripQuat);
  outGripPos.copy(worldPos).sub(shifted);
}

describe('C6a — feel-neutrality of calibration', () => {
  beforeEach(() => {
    setPreset('default');  // reset to a known baseline
  });

  test('composePoseWith is the exact inverse of solveGripForCalibratedPose', () => {
    // Sanity: our synthetic-trajectory generator is invertible. If this fails
    // the rest of the file is meaningless.
    const worldPos = v(0.3, 1.2, -0.5);
    const worldQuat = qAxisAngle(0.2, 0.9, 0.1, 47);
    const posOffset = v(0.01, 0.02, -0.12);
    const rotOffset = qAxisAngle(1, 0, 0, -73);

    const gripPos = v(0, 0, 0);
    const gripQuat = q(0, 0, 0, 1);
    solveGripForCalibratedPose(worldPos, worldQuat, posOffset, rotOffset, gripPos, gripQuat);

    const recPos = v(0, 0, 0);
    const recQuat = q(0, 0, 0, 1);
    composePoseWith(gripPos, gripQuat, posOffset, rotOffset, recPos, recQuat);

    expect(recPos.distanceTo(worldPos)).toBeLessThan(1e-12);
    expect(Math.abs(recQuat.dot(worldQuat)) - 1).toBeLessThan(1e-12);
  });

  test('two different (T_cal, grip trajectory) pairs yielding the SAME world blade pose produce identical anchor pose to 1e-9', () => {
    // For each of several randomized world trajectories, solve two different
    // grip trajectories under two different T_cal values that both hit the
    // same world pose. Compose each via the SHARED composeCalibratedPose
    // helper (via setCalibration on the singleton) and assert equality.
    const T_cal_A = { posOffset: v(0.00, 0.005, -0.02), rotOffset: q(0, 0, 0, 1) };
    const T_cal_B = { posOffset: v(0.02, 0.03, -0.11), rotOffset: qAxisAngle(1, 0, 0, -55) };

    // 50 substeps mimicking spec C6a's "trajectory sample" cadence.
    let maxPosDelta = 0;
    let maxQuatDelta = 0;
    for (let i = 0; i < 50; i++) {
      const t = i / 49;
      // A curved world blade trajectory covering translation + rotation.
      const worldPos = v(
        0.4 * Math.sin(t * Math.PI * 2),
        1.0 + 0.3 * t,
        -0.2 + 0.5 * t,
      );
      const worldQuat = qAxisAngle(
        Math.sin(t * 3),
        Math.cos(t * 2),
        Math.sin(t * 5) + 0.3,
        60 * t - 30,
      );

      const gripPosA = v(0, 0, 0), gripQuatA = q(0, 0, 0, 1);
      const gripPosB = v(0, 0, 0), gripQuatB = q(0, 0, 0, 1);
      solveGripForCalibratedPose(worldPos, worldQuat, T_cal_A.posOffset, T_cal_A.rotOffset, gripPosA, gripQuatA);
      solveGripForCalibratedPose(worldPos, worldQuat, T_cal_B.posOffset, T_cal_B.rotOffset, gripPosB, gripQuatB);

      // Compose via the SAME helper the runtime uses (setCalibration then
      // composeCalibratedPose) so we're exercising the production path.
      setCalibration({ posOffset: T_cal_A.posOffset, rotOffset: T_cal_A.rotOffset });
      const anchorPosA = v(0, 0, 0), anchorQuatA = q(0, 0, 0, 1);
      composeCalibratedPose(gripPosA, gripQuatA, anchorPosA, anchorQuatA);

      setCalibration({ posOffset: T_cal_B.posOffset, rotOffset: T_cal_B.rotOffset });
      const anchorPosB = v(0, 0, 0), anchorQuatB = q(0, 0, 0, 1);
      composeCalibratedPose(gripPosB, gripQuatB, anchorPosB, anchorQuatB);

      maxPosDelta = Math.max(maxPosDelta, anchorPosA.distanceTo(anchorPosB));
      // |dot| = 1 for equal quaternions (up to sign). Difference from 1 is
      // the invariance error.
      const dotAbs = Math.abs(anchorQuatA.dot(anchorQuatB));
      maxQuatDelta = Math.max(maxQuatDelta, 1 - dotAbs);
    }

    expect(maxPosDelta).toBeLessThan(1e-9);
    expect(maxQuatDelta).toBeLessThan(1e-9);
  });

  test('spec C2a — pure grip rotation produces v_blade = |ω × posOffset|', () => {
    // Spec: v_grip = 0, ω_grip = (30, 0, 0), shakehand default offset
    // magnitude ≈ 0.1414 m → |v_blade| ≈ 30 · 0.1414 ≈ 4.25 m/s.
    //
    // With the P13 architecture, the blade-center velocity is what ball.js
    // finite-differences from paddleFaceCenterWorld (line 454). Simulate one
    // dt of pure rotation and check the resulting anchor-position delta over
    // dt matches ω × r.
    const shakehandOffset = v(0, 0.02, -0.14);
    setCalibration({ posOffset: shakehandOffset, rotOffset: q(0, 0, 0, 1) });

    const omega = 30;
    const dt = 1 / 1000;  // small dt for finite-difference accuracy

    const gripPos = v(0, 1, 0);
    const gripQuatA = q(0, 0, 0, 1);
    const gripQuatB = new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), omega * dt);

    const anchorPosA = v(0, 0, 0), anchorQuatA = q(0, 0, 0, 1);
    const anchorPosB = v(0, 0, 0), anchorQuatB = q(0, 0, 0, 1);
    composeCalibratedPose(gripPos, gripQuatA, anchorPosA, anchorQuatA);
    composeCalibratedPose(gripPos, gripQuatB, anchorPosB, anchorQuatB);

    // Anchor is at gripPos + gripQuat * posOffset. Velocity of the anchor
    // point under pure rotation = ω × (gripQuat * posOffset).
    const v_anchor = anchorPosB.clone().sub(anchorPosA).divideScalar(dt);
    const expected_speed = omega * shakehandOffset.length();
    expect(Math.abs(v_anchor.length() - expected_speed)).toBeLessThan(0.05);
  });

  test('spec C6 no-touch-physics-constants — calibration.js does not import from physics/constants.js', () => {
    // The "non-negotiable" invariant. If someone accidentally imports a
    // restitution/friction/grip constant into calibration.js, calibration
    // gains the power to change HOW the blade behaves, not just where — the
    // exact thing spec §C6 forbids. Enforce syntactically at test time so
    // review can't miss it.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../js/xr/calibration.js'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"].*physics\/constants/);
    expect(src).not.toMatch(/require\s*\(\s*['"].*physics\/constants/);
    // Also block indirect imports through impulse / ball / collisions —
    // those all depend on physics constants.
    expect(src).not.toMatch(/from ['"].*physics\/impulse/);
    expect(src).not.toMatch(/from ['"].*physics\/ball/);
    expect(src).not.toMatch(/from ['"].*physics\/collisions/);
  });
});
