// Load-time silhouette refinement for the ball mesh.
//
// Ball.glb ships at 960 triangles (~32 silhouette segments). At rally
// distance the ball covers too few pixels for that to matter, but in the
// last ~30 cm before paddle contact the flat rim facets become visible —
// a 32-gon outline instead of a circle. Re-exporting the asset denser
// would also work, but doing it here keeps the fix independent of the
// art pipeline and applies to any future re-export that regresses.
//
// Each pass splits every triangle into 4 by edge midpoints, then projects
// the new vertices back onto the sphere (radius taken from the parent
// edge's endpoints, so a re-export at a different scale still refines
// correctly). UVs are interpolated per-edge, which is seam-safe: seam
// vertices are already duplicated per side in the source geometry, so
// midpoints inherit the correct side's UVs and positions still coincide.
//
// The refined geometry replaces mesh.geometry BEFORE the squash system
// caches vertex positions and before the ghost/preview meshes capture the
// geometry reference, so every consumer sees the same buffer.

import * as THREE from 'three';

// One subdivision pass over indexed triangle data. `attrs` maps attribute
// name → { array, itemSize }; midpoint values are the linear average of the
// edge endpoints for every attribute (position/normal get fixed up after).
function subdivideOnce(index, attrs, vertexCount) {
  const triCount = index.length / 3;
  const newIndex = new Uint32Array(triCount * 4 * 3);
  // Edge (a,b) → midpoint vertex index. Keyed on the ordered index pair, so
  // triangles sharing an edge share the midpoint and no cracks open.
  const midCache = new Map();
  const parents = [];   // per new vertex: [a, b] source indices

  let nextVertex = vertexCount;
  const midpoint = (a, b) => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a;
    let m = midCache.get(key);
    if (m === undefined) {
      m = nextVertex++;
      midCache.set(key, m);
      parents.push([a, b]);
    }
    return m;
  };

  let w = 0;
  for (let t = 0; t < triCount; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    newIndex[w++] = a;  newIndex[w++] = ab; newIndex[w++] = ca;
    newIndex[w++] = ab; newIndex[w++] = b;  newIndex[w++] = bc;
    newIndex[w++] = ca; newIndex[w++] = bc; newIndex[w++] = c;
    newIndex[w++] = ab; newIndex[w++] = bc; newIndex[w++] = ca;
  }

  const newAttrs = {};
  for (const [name, { array, itemSize }] of Object.entries(attrs)) {
    const out = new Float32Array(nextVertex * itemSize);
    out.set(array.subarray(0, vertexCount * itemSize));
    for (let i = 0; i < parents.length; i++) {
      const [a, b] = parents[i];
      const dst = (vertexCount + i) * itemSize;
      for (let k = 0; k < itemSize; k++) {
        out[dst + k] = (array[a * itemSize + k] + array[b * itemSize + k]) * 0.5;
      }
    }
    newAttrs[name] = { array: out, itemSize };
  }

  // Spherical projection of the new vertices only — originals are already on
  // the sphere. Target radius per vertex is the mean of its parents' radii
  // (exact for a sphere, and keeps the fix scale-agnostic). The projected
  // vertex's normal is its unit position, which is what smooth sphere
  // shading authors anyway.
  const pos = newAttrs.position;
  const nrm = newAttrs.normal;
  for (let i = 0; i < parents.length; i++) {
    const [a, b] = parents[i];
    const pa = a * 3, pb = b * 3, pm = (vertexCount + i) * 3;
    const ra = Math.hypot(pos.array[pa], pos.array[pa + 1], pos.array[pa + 2]);
    const rb = Math.hypot(pos.array[pb], pos.array[pb + 1], pos.array[pb + 2]);
    const r = (ra + rb) * 0.5;
    const len = Math.hypot(pos.array[pm], pos.array[pm + 1], pos.array[pm + 2]);
    if (len > 1e-12) {
      const s = r / len;
      pos.array[pm] *= s; pos.array[pm + 1] *= s; pos.array[pm + 2] *= s;
      if (nrm) {
        const inv = 1 / r;
        nrm.array[pm]     = pos.array[pm] * inv;
        nrm.array[pm + 1] = pos.array[pm + 1] * inv;
        nrm.array[pm + 2] = pos.array[pm + 2] * inv;
      }
    }
  }

  return { index: newIndex, attrs: newAttrs, vertexCount: nextVertex };
}

/**
 * Return `geometry` refined to at least `targetTriangles`, or the original
 * geometry unchanged when refinement is unnecessary or unsafe (already
 * dense enough, not sphere-like, morph targets, or material groups).
 *
 * The returned geometry (when new) carries position/normal/uv only — the
 * ball material uses no normal map, so tangents are intentionally dropped
 * rather than interpolated incorrectly.
 */
export function refineBallGeometry(geometry, targetTriangles = 3000) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return geometry;
  if (geometry.groups.length > 0) return geometry;
  if (Object.keys(geometry.morphAttributes).length > 0) return geometry;

  let index = geometry.getIndex()
    ? Array.from(geometry.getIndex().array)
    : Array.from({ length: posAttr.count }, (_, i) => i);
  if (index.length / 3 >= targetTriangles) return geometry;

  // Sphere check: all vertices within 5% of the mean radius about the local
  // origin. Anything else and midpoint projection would distort the shape —
  // bail and render the asset as authored.
  let minR = Infinity, maxR = 0;
  for (let i = 0; i < posAttr.count; i++) {
    const r = Math.hypot(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  if (minR <= 0 || (maxR - minR) / maxR > 0.05) return geometry;

  let data = {
    index: Uint32Array.from(index),
    vertexCount: posAttr.count,
    attrs: {},
  };
  for (const name of ['position', 'normal', 'uv']) {
    const attr = geometry.getAttribute(name);
    if (attr) {
      data.attrs[name] = {
        array: Float32Array.from(attr.array.subarray(0, attr.count * attr.itemSize)),
        itemSize: attr.itemSize,
      };
    }
  }

  while (data.index.length / 3 < targetTriangles) {
    data = subdivideOnce(data.index, data.attrs, data.vertexCount);
  }

  const refined = new THREE.BufferGeometry();
  refined.setIndex(new THREE.BufferAttribute(data.index, 1));
  for (const [name, { array, itemSize }] of Object.entries(data.attrs)) {
    refined.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  refined.computeBoundingSphere();
  refined.computeBoundingBox();
  return refined;
}
