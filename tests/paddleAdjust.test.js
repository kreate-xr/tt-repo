// Quick Fit knob math (js/xr/paddleAdjust.js).

const THREE = require('three');
const {
  applyAdjust, stepAdjust, clampAdjust, zeroAdjust,
  FACE_MAX_DEG, BAT_MAX_DEG, SLIDE_MAX_M, ANGLE_RATE_DEG_S, SLIDE_RATE_M_S,
} = require('../js/xr/paddleAdjust.js');
const { deriveHandleGripPreset } = require('../js/xr/handleGrip.js');

// Representative bat geometry (controller-local, metres): handle along −Y
// below the blade, face normal +Z. Only the shape matters for these checks.
const GEO = {
  handleEnd: new THREE.Vector3(0, -0.10, 0),
  bladeBottom: new THREE.Vector3(0, -0.016, 0),
  faceCenter: new THREE.Vector3(0, 0.06, 0),
};
const GRIP_POINT = new THREE.Vector3().lerpVectors(GEO.handleEnd, GEO.bladeBottom, 0.9);

function mapPoint(tcal, p) {
  return p.clone().applyQuaternion(tcal.rotOffset).add(tcal.posOffset);
}

describe('applyAdjust', () => {
  const base = deriveHandleGripPreset(GEO);

  test('zero knobs reproduce the base exactly', () => {
    const r = applyAdjust(base, zeroAdjust());
    expect(r.posOffset.distanceTo(base.posOffset)).toBeLessThan(1e-12);
    expect(Math.abs(r.rotOffset.dot(base.rotOffset))).toBeCloseTo(1, 12);
  });

  test('grip point stays on the fist for any face/bat angle', () => {
    for (const [faceDeg, batDeg] of [[30, 0], [0, -40], [55, 25], [-60, 60]]) {
      const r = applyAdjust(base, { faceDeg, batDeg, slideM: 0 });
      expect(mapPoint(r, GRIP_POINT).length()).toBeLessThan(1e-9);
    }
  });

  test('bat angle rotates the handle axis by exactly batDeg, toward grip +Y', () => {
    const headDir = new THREE.Vector3().subVectors(GEO.faceCenter, GEO.handleEnd).normalize();
    const r = applyAdjust(base, { faceDeg: 0, batDeg: 20, slideM: 0 });
    const axis = headDir.clone().applyQuaternion(r.rotOffset);
    const baseAxis = headDir.clone().applyQuaternion(base.rotOffset);  // grip −Z
    expect(axis.angleTo(baseAxis) * 180 / Math.PI).toBeCloseTo(20, 6);
    expect(axis.y).toBeGreaterThan(0);
  });

  test('face angle rolls about the handle axis without moving it', () => {
    const headDir = new THREE.Vector3().subVectors(GEO.faceCenter, GEO.handleEnd).normalize();
    const n = new THREE.Vector3(0, 0, 1);
    const r = applyAdjust(base, { faceDeg: 35, batDeg: 0, slideM: 0 });
    const axis = headDir.clone().applyQuaternion(r.rotOffset);
    expect(axis.distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-9);
    const n0 = n.clone().applyQuaternion(base.rotOffset);
    const n1 = n.clone().applyQuaternion(r.rotOffset);
    expect(n0.angleTo(n1) * 180 / Math.PI).toBeCloseTo(35, 6);
  });

  test('slide moves the bat along its handle, away from the fist', () => {
    const r = applyAdjust(base, { faceDeg: 0, batDeg: 0, slideM: 0.02 });
    const moved = mapPoint(r, GRIP_POINT);
    expect(moved.z).toBeCloseTo(-0.02, 9);
    expect(Math.hypot(moved.x, moved.y)).toBeLessThan(1e-9);
  });

  test('writes into `out` when given (per-frame path allocates nothing)', () => {
    const out = { posOffset: new THREE.Vector3(), rotOffset: new THREE.Quaternion() };
    expect(applyAdjust(base, { faceDeg: 5, batDeg: 5, slideM: 0.01 }, out)).toBe(out);
  });
});

describe('stepAdjust / clampAdjust', () => {
  test('stick inside the deadzone changes nothing', () => {
    const a = zeroAdjust();
    expect(stepAdjust(a, 0.19, -0.19, 0.15, 1)).toBe(false);
    expect(a).toEqual(zeroAdjust());
  });

  test('NaN axes are treated as centred', () => {
    const a = zeroAdjust();
    expect(stepAdjust(a, NaN, NaN, NaN, 1)).toBe(false);
  });

  test('full deflection runs at the documented rates; stick UP increases', () => {
    const a = zeroAdjust();
    expect(stepAdjust(a, 1, -1, -1, 0.1)).toBe(true);
    expect(a.faceDeg).toBeCloseTo(ANGLE_RATE_DEG_S * 0.1, 9);
    expect(a.batDeg).toBeCloseTo(ANGLE_RATE_DEG_S * 0.1, 9);
    expect(a.slideM).toBeCloseTo(SLIDE_RATE_M_S * 0.1, 9);
  });

  test('clamps hold under sustained input and report no change at the stop', () => {
    const a = zeroAdjust();
    for (let i = 0; i < 1000; i++) stepAdjust(a, 1, 1, 1, 0.05);
    expect(a.faceDeg).toBe(FACE_MAX_DEG);
    expect(a.batDeg).toBe(-BAT_MAX_DEG);
    expect(a.slideM).toBe(-SLIDE_MAX_M);
    expect(stepAdjust(a, 1, 1, 1, 0.05)).toBe(false);
  });

  test('clampAdjust bounds out-of-range stored values', () => {
    expect(clampAdjust({ faceDeg: 400, batDeg: -400, slideM: 1 }))
      .toEqual({ faceDeg: FACE_MAX_DEG, batDeg: -BAT_MAX_DEG, slideM: SLIDE_MAX_M });
  });
});
