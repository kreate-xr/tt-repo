// P13 spec §C3 tests: solver recovers a known R from synthetic samples, and
// rejects degenerate inputs rather than solving garbage.

const THREE = require('three');
import {
  solveRotOffset,
  sampleIsSteady,
  DEGENERATE_ANGLE_THRESHOLD_DEG,
} from '../js/xr/calibrationSolver.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }
function qAxisAngle(ax, ay, az, deg) {
  return new THREE.Quaternion().setFromAxisAngle(
    v(ax, ay, az).normalize(),
    (deg * Math.PI) / 180,
  );
}

// Generate a Sample A / Sample B pair from a known R_true and known player
// grip choices that put the paddle exactly in the required poses.
function samplesFromR(R_true, nLocal, handleLocal) {
  // Sample A: q_grip_A · R_true rotates n_local → world +Z. So
  // q_grip_A = worldUpRotator · (R_true · n_local → world+Z rotation)⁻¹... simpler:
  // just pick q_grip_A such that q_grip_A · R_true · n_local = (0,0,1).
  //
  // Approach: R_true · n_local is some vector n'. We need q_grip_A to rotate
  // n' → world+Z. There's a one-DOF family; pick the shortest rotation.
  const nAfterR = nLocal.clone().applyQuaternion(R_true);
  const qGripA = new THREE.Quaternion().setFromUnitVectors(nAfterR, v(0, 0, 1));

  // Sample B: q_grip_B · R_true · handle_local = (0,0,1). Same approach.
  const handleAfterR = handleLocal.clone().applyQuaternion(R_true);
  const qGripB = new THREE.Quaternion().setFromUnitVectors(handleAfterR, v(0, 0, 1));

  return { qGripA, qGripB };
}

describe('calibrationSolver.solveRotOffset', () => {
  const N_LOCAL = v(0, 0, 1);       // face normal in paddle-local frame
  const HANDLE_LOCAL = v(0, 1, 0);  // handle→tip axis

  test('recovers a known R_true within 1e-6 for clean synthetic samples', () => {
    // Various R_true rotations covering different axes.
    const cases = [
      qAxisAngle(1, 0, 0, -80),
      qAxisAngle(0, 1, 0, 30),
      qAxisAngle(1, 1, 0, 45),
      qAxisAngle(0.3, 0.7, 0.5, 90),
    ];
    for (const R_true of cases) {
      const { qGripA, qGripB } = samplesFromR(R_true, N_LOCAL, HANDLE_LOCAL);
      const { R, error } = solveRotOffset(qGripA, qGripB, N_LOCAL, HANDLE_LOCAL);
      expect(error).toBeNull();
      // Compare via |dot(R, R_true)| — quaternion invariant under sign flip.
      const dot = Math.abs(R.dot(R_true));
      expect(1 - dot).toBeLessThan(1e-10);
    }
  });

  test('spec C3a — recovers R_true within 1.5° from noisy (~1°) synthetic samples', () => {
    // Perturb each grip sample by ~1° about a random axis; solver should
    // still land within 1.5° of the true R.
    const R_true = qAxisAngle(1, 0, 0, -80);
    const { qGripA: cleanA, qGripB: cleanB } = samplesFromR(R_true, N_LOCAL, HANDLE_LOCAL);

    const noise = (axis) => new THREE.Quaternion().setFromAxisAngle(axis, (1 * Math.PI) / 180);
    const noisyA = cleanA.clone().multiply(noise(v(0.5, 0.3, 0.7).normalize()));
    const noisyB = cleanB.clone().multiply(noise(v(-0.2, 0.8, 0.4).normalize()));

    const { R, error } = solveRotOffset(noisyA, noisyB, N_LOCAL, HANDLE_LOCAL);
    expect(error).toBeNull();
    const dot = Math.abs(R.dot(R_true));
    const angleDeg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    expect(angleDeg).toBeLessThan(1.5);
  });

  test('spec C3b — rejects samples with < 15° grip delta as degenerate', () => {
    // Two samples nearly identical to each other → solver refuses.
    const qA = qAxisAngle(1, 0, 0, 10);
    const qB = qAxisAngle(1, 0, 0, 15);  // 5° apart, below threshold
    const { R, error } = solveRotOffset(qA, qB, N_LOCAL, HANDLE_LOCAL);
    expect(R).toBeNull();
    expect(error).toBe('poses-too-similar');
  });

});

describe('sampleIsSteady', () => {
  test('accepts angular speeds up to 0.5 rad/s', () => {
    expect(sampleIsSteady(0)).toBe(true);
    expect(sampleIsSteady(0.5)).toBe(true);
  });
  test('rejects angular speeds above 0.5 rad/s', () => {
    expect(sampleIsSteady(0.51)).toBe(false);
    expect(sampleIsSteady(2.0)).toBe(false);
  });
});

describe('DEGENERATE_ANGLE_THRESHOLD_DEG constant', () => {
  test('matches spec §C3 (15°)', () => {
    expect(DEGENERATE_ANGLE_THRESHOLD_DEG).toBe(15);
  });
});
