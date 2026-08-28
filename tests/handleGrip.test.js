// Tests for the derived "handle in grip" calibration (js/xr/handleGrip.js)
// and its registration path into the preset table.
//
// Frame reminder: deriveHandleGripPreset inputs are controller-local; a mesh
// point p renders at grip-local (rotOffset * p + posOffset) — the same
// composition calibration.js composeCalibratedPose applies (see its comment).

const THREE = require('three');

import { deriveHandleGripPreset, GRIP_POINT_FRACTION } from '../js/xr/handleGrip.js';
import {
  PRESETS, registerDerivedPreset, getPresetCopy, presetWeightClass, ADAPTER_PRESETS,
} from '../js/xr/calibrationPresets.js';

// Map a controller-local point into grip-local space under a derived T_cal.
function toGripLocal(p, { posOffset, rotOffset }) {
  return p.clone().applyQuaternion(rotOffset).add(posOffset);
}

// Controller-local geometry of a straight bat pointing an arbitrary direction.
// Numbers echo the real GLB's proportions (handle butt 8.4 cm behind the
// blade-bottom, blade center ~9 cm past it — see paddleRigidity.test.js).
function batAlong(dir) {
  const d = dir.clone().normalize();
  return {
    handleEnd: d.clone().multiplyScalar(-0.084),
    bladeBottom: new THREE.Vector3(0, 0, 0),
    faceCenter: d.clone().multiplyScalar(0.092),
  };
}

describe('deriveHandleGripPreset', () => {
  test('handle axis lands on grip -Z regardless of model orientation', () => {
    const dirs = [
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0.3, -0.8, 0.52),
    ];
    for (const dir of dirs) {
      const geo = batAlong(dir);
      const t = deriveHandleGripPreset(geo);
      expect(t).not.toBeNull();
      const headDir = geo.faceCenter.clone().sub(geo.handleEnd).normalize();
      const mapped = headDir.applyQuaternion(t.rotOffset);
      expect(mapped.x).toBeCloseTo(0, 6);
      expect(mapped.y).toBeCloseTo(0, 6);
      expect(mapped.z).toBeCloseTo(-1, 6);
    }
  });

  test('handle grip point maps exactly onto the grip origin (fist centroid)', () => {
    const geo = batAlong(new THREE.Vector3(0.3, 0.9, -0.1));
    const t = deriveHandleGripPreset(geo);
    const gripPoint = new THREE.Vector3()
      .lerpVectors(geo.handleEnd, geo.bladeBottom, GRIP_POINT_FRACTION);
    const mapped = toGripLocal(gripPoint, t);
    expect(mapped.length()).toBeLessThan(1e-9);
  });

  test('blade center ends up straight ahead on -Z at handle+blade distance', () => {
    // Collinear bat → the blade center must land at (0, 0, -d) where d is its
    // distance from the fist point. With these proportions d ≈ 10.9 cm — the
    // same ballpark as the spec C1 shakehand seed's 14 cm, which is a good
    // sign the derivation and the hand-tuned preset agree about reality.
    const geo = batAlong(new THREE.Vector3(0, 1, 0));
    const t = deriveHandleGripPreset(geo);
    const mapped = toGripLocal(geo.faceCenter, t);
    expect(mapped.x).toBeCloseTo(0, 9);
    expect(mapped.y).toBeCloseTo(0, 9);
    expect(mapped.z).toBeCloseTo(-(0.092 + 0.084 * (1 - GRIP_POINT_FRACTION)), 6);
  });

  test('already-aligned bat yields identity rotation and pure translation', () => {
    const geo = batAlong(new THREE.Vector3(0, 0, -1));
    const t = deriveHandleGripPreset(geo);
    expect(Math.abs(t.rotOffset.w)).toBeCloseTo(1, 9);
    const gripPoint = new THREE.Vector3()
      .lerpVectors(geo.handleEnd, geo.bladeBottom, GRIP_POINT_FRACTION);
    expect(t.posOffset.distanceTo(gripPoint.clone().negate())).toBeLessThan(1e-9);
  });

  test('rotation is rigid — face normal keeps its angle to the handle axis', () => {
    const geo = batAlong(new THREE.Vector3(0.2, 0.95, 0.1));
    const t = deriveHandleGripPreset(geo);
    const headDir = geo.faceCenter.clone().sub(geo.handleEnd).normalize();
    // Any vector perpendicular to the handle axis stands in for the normal.
    const faceNormal = new THREE.Vector3(1, 0, 0)
      .sub(headDir.clone().multiplyScalar(headDir.x)).normalize();
    const before = faceNormal.dot(headDir);
    const after = faceNormal.clone().applyQuaternion(t.rotOffset)
      .dot(headDir.clone().applyQuaternion(t.rotOffset));
    expect(after).toBeCloseTo(before, 9);
  });

  test('degenerate geometry (zero-length axis) returns null', () => {
    const p = new THREE.Vector3(0.01, 0.02, 0.03);
    expect(deriveHandleGripPreset({
      handleEnd: p.clone(), bladeBottom: p.clone(), faceCenter: p.clone(),
    })).toBeNull();
  });

  test('inputs are not mutated', () => {
    const geo = batAlong(new THREE.Vector3(0, 1, 0));
    const snapshot = {
      handleEnd: geo.handleEnd.clone(),
      bladeBottom: geo.bladeBottom.clone(),
      faceCenter: geo.faceCenter.clone(),
    };
    deriveHandleGripPreset(geo);
    expect(geo.handleEnd.equals(snapshot.handleEnd)).toBe(true);
    expect(geo.bladeBottom.equals(snapshot.bladeBottom)).toBe(true);
    expect(geo.faceCenter.equals(snapshot.faceCenter)).toBe(true);
  });
});

describe('registerDerivedPreset', () => {
  test('registered preset round-trips through getPresetCopy', () => {
    const t = deriveHandleGripPreset(batAlong(new THREE.Vector3(0, 1, 0)));
    registerDerivedPreset('handle_grip', t);

    expect(PRESETS.handle_grip).toBeDefined();
    const copy = getPresetCopy('handle_grip');
    expect(copy.posOffset.distanceTo(t.posOffset)).toBeLessThan(1e-12);
    // angleTo goes through acos, which amplifies float error near 0 — 1e-6
    // rad (≈ 0.00006°) is still far below anything perceptible.
    expect(copy.rotOffset.angleTo(t.rotOffset)).toBeLessThan(1e-6);
    // Snapshot semantics: mutating the copy must not touch the table.
    copy.posOffset.setX(99);
    expect(PRESETS.handle_grip.posOffset.x).not.toBe(99);
    // Registration stores clones — mutating the source must not either.
    t.posOffset.setY(42);
    expect(PRESETS.handle_grip.posOffset.y).not.toBe(42);
  });

  test('derived presets are bare-controller: no weight class, not adapters', () => {
    registerDerivedPreset('handle_grip',
      deriveHandleGripPreset(batAlong(new THREE.Vector3(0, 1, 0))));
    expect(presetWeightClass('handle_grip')).toBeNull();
    expect(ADAPTER_PRESETS).not.toContain('handle_grip');
    expect(getPresetCopy('handle_grip').isAdapter).toBe(false);
  });
});
