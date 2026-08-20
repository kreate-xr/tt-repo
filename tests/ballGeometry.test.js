// Tests for scene/ballGeometry.js — load-time silhouette refinement of the
// ball mesh. The contract: sphere-like low-poly input comes back denser with
// the radius preserved exactly (the physics/visual 40 mm match check depends
// on it); anything unsafe to refine comes back as the SAME object, untouched.

import * as THREE from 'three';
import { refineBallGeometry } from '../js/scene/ballGeometry.js';

const RADIUS = 0.02;

function triCount(geom) {
  return (geom.getIndex() ? geom.getIndex().count : geom.getAttribute('position').count) / 3;
}

describe('refineBallGeometry', () => {
  test('refines a low-poly sphere to at least the target triangle count', () => {
    const src = new THREE.SphereGeometry(RADIUS, 8, 6);
    const out = refineBallGeometry(src, 3000);
    expect(out).not.toBe(src);
    expect(triCount(out)).toBeGreaterThanOrEqual(3000);
  });

  test('every vertex lies on the original radius', () => {
    const src = new THREE.SphereGeometry(RADIUS, 8, 6);
    const out = refineBallGeometry(src, 3000);
    const pos = out.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      expect(Math.abs(r - RADIUS)).toBeLessThan(1e-6);
    }
  });

  test('normals are unit length and radial (smooth sphere shading)', () => {
    const src = new THREE.SphereGeometry(RADIUS, 8, 6);
    const out = refineBallGeometry(src, 3000);
    const pos = out.getAttribute('position');
    const nrm = out.getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) {
      const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
      const len = Math.hypot(nx, ny, nz);
      expect(Math.abs(len - 1)).toBeLessThan(1e-3);
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      const dot = (nx * pos.getX(i) + ny * pos.getY(i) + nz * pos.getZ(i)) / r;
      expect(dot).toBeGreaterThan(0.999);
    }
  });

  test('UVs are carried through, one per vertex, inside the source envelope', () => {
    // Note: three's SphereGeometry authors pole u values slightly above 1
    // (pole-u correction), so the envelope is measured, not assumed [0,1].
    const src = new THREE.SphereGeometry(RADIUS, 8, 6);
    const srcUv = src.getAttribute('uv');
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < srcUv.count; i++) {
      minU = Math.min(minU, srcUv.getX(i)); maxU = Math.max(maxU, srcUv.getX(i));
      minV = Math.min(minV, srcUv.getY(i)); maxV = Math.max(maxV, srcUv.getY(i));
    }
    const out = refineBallGeometry(src, 3000);
    const uv = out.getAttribute('uv');
    expect(uv).toBeDefined();
    expect(uv.count).toBe(out.getAttribute('position').count);
    // Midpoint interpolation can never leave the source envelope.
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(minU);
      expect(uv.getX(i)).toBeLessThanOrEqual(maxU);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(minV);
      expect(uv.getY(i)).toBeLessThanOrEqual(maxV);
    }
  });

  test('index is valid: every entry addresses an existing vertex', () => {
    const src = new THREE.SphereGeometry(RADIUS, 8, 6);
    const out = refineBallGeometry(src, 3000);
    const index = out.getIndex();
    const vertexCount = out.getAttribute('position').count;
    expect(index.count % 3).toBe(0);
    for (let i = 0; i < index.count; i++) {
      const v = index.array[i];
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(vertexCount);
    }
  });

  test('shared edges share midpoints — one pass adds exactly V + E vertices', () => {
    // On indexed geometry, one subdivision pass must add exactly one vertex
    // per unique edge of the index. Duplicated midpoints (cracks waiting to
    // happen) would push the count higher.
    const src = new THREE.SphereGeometry(RADIUS, 8, 6); // 80 tris, indexed
    const index = src.getIndex().array;
    const edges = new Set();
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        edges.add(u < v ? `${u}_${v}` : `${v}_${u}`);
      }
    }
    const srcVerts = src.getAttribute('position').count;
    const out = refineBallGeometry(src, 100); // one pass: 80 -> 320 tris
    expect(triCount(out)).toBe(320);
    expect(out.getAttribute('position').count).toBe(srcVerts + edges.size);
  });

  test('accepts non-indexed geometry', () => {
    const src = new THREE.SphereGeometry(RADIUS, 8, 6).toNonIndexed();
    const out = refineBallGeometry(src, 3000);
    expect(triCount(out)).toBeGreaterThanOrEqual(3000);
    const pos = out.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      expect(Math.abs(r - RADIUS)).toBeLessThan(1e-6);
    }
  });

  test('returns the same geometry when already dense enough', () => {
    const src = new THREE.SphereGeometry(RADIUS, 64, 48); // 6016 tris
    expect(refineBallGeometry(src, 3000)).toBe(src);
  });

  test('returns the same geometry for non-sphere input', () => {
    const src = new THREE.BoxGeometry(0.04, 0.04, 0.04);
    expect(refineBallGeometry(src, 3000)).toBe(src);
  });

  test('bounding volumes are computed on the refined geometry', () => {
    const out = refineBallGeometry(new THREE.SphereGeometry(RADIUS, 8, 6), 3000);
    expect(out.boundingSphere).not.toBeNull();
    expect(Math.abs(out.boundingSphere.radius - RADIUS)).toBeLessThan(1e-4);
    expect(out.boundingBox).not.toBeNull();
  });
});
