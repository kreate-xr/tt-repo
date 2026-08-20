// The paddle mesh, built from physics/paddleSpec.js.
//
// NOTE: no longer the default — models.js now ships the re-authored Paddle.glb
// and this bat is the A/B alternative, reachable with `?paddle=procedural`.
// The reasoning below is why it was the default, and is why it stays loadable:
// everything the game needs to know about the bat is exact here instead of
// measured off an asset.
//
//   - the collision disc is the blade circle, so the surface the ball hits and
//     the rubber the player sees are the SAME shape (the GLB leaves ~10 mm of
//     rim rubber resolving through the wood-edge model, see the RADIAL
//     agreement notes in tests/paddleRigidity.test.js),
//   - blade half-thickness is a spec constant, not a vertex scan that used to
//     accidentally report the handle,
//   - mass, balance point and swing weight fall out of the same silhouette the
//     mesh is extruded from, so changing the bat changes how it feels.
//
// Construction is five coplanar extrusions sharing ONE silhouette —
//
//     topsheet │ sponge │ ply │ sponge │ topsheet
//       1.8mm     2.0mm   6mm   2.0mm     1.8mm
//
// — plus a lofted handle. Because the layers share the silhouette they are
// flush at the rim, and the rim therefore shows the real sandwich as geometry.
// That is the "assembled layers, not a molded piece" cue that
// ai-docs/paddle-glb-reauthor-checklist.md §3 asks an artist for, obtained here
// for free from the construction.
//
// Everything is merged into a SINGLE Mesh with material groups. That is not
// just a draw-call optimisation: handle and face sharing one world matrix by
// construction is the rigidity guarantee tests/paddleRigidity.test.js exists to
// protect, and a merged mesh cannot violate it even if someone later animates
// something.

import * as THREE from 'three';
import {
  getPaddleSpec, derivePaddle, paddleOutlineHalfWidth,
  handleHalfWidthAt, handleHalfDepthAt, superellipsePoint,
  bladeOutlinePoint, bladeAngleAtHeight,
} from '../physics/paddleSpec.js';
import { RUBBER_ROUGHNESS, BLADE_ROUGHNESS } from './paddleMaterial.js';

// Tournament colours. Red is ITTF-legal bright red rather than crimson; black
// is not pure black because a 0x000000 surface under the arena rig reads as a
// hole rather than as rubber.
export const PADDLE_COLORS = {
  topsheetFront: 0xc4271f,
  topsheetBack:  0x161616,
  sponge:        0xe3d3a8,
  ply:           0xd9bc8c,
  handle:        0x7a5230,
};

// Material slot order. The merged geometry emits one group per part carrying
// the matching index, so the mesh's material array is indexed by this.
export const MATERIAL_SLOTS = {
  TOPSHEET_FRONT: 0,
  TOPSHEET_BACK:  1,
  SPONGE:         2,
  PLY:            3,
  HANDLE:         4,
};

// --- Silhouette → 2D outline ------------------------------------------------

// Closed CCW outline of the bat in the XY plane, from `yMin` up to the tip and
// back down the mirrored side. Sampling is deliberately non-uniform: the handle
// and throat are walked in y (where the profile is a smooth function of height)
// but the blade is walked by ANGLE around its circle, because uniform-in-y
// sampling starves the tip exactly where the silhouette curves hardest and
// leaves a visible facet on the one part of the bat the player looks straight
// down at.
export function buildOutlinePoints(yMin, spec = getPaddleSpec()) {
  const d = derivePaddle(spec);
  const start = Math.max(yMin, d.handleButtY);

  const ys = [];
  const pushY = (y) => {
    if (ys.length === 0 || y > ys[ys.length - 1] + 1e-9) ys.push(y);
  };

  if (start < d.throatY) {
    const n = Math.max(2, spec.handleSegments);
    for (let i = 0; i <= n; i++) pushY(start + (d.throatY - start) * (i / n));
  }
  const throatStart = Math.max(start, d.throatY);
  if (throatStart < d.shoulderY) {
    const n = Math.max(2, spec.throatSegments);
    for (let i = 0; i <= n; i++) {
      pushY(throatStart + (d.shoulderY - throatStart) * (i / n));
    }
  }

  const right = ys.map(
    (y) => new THREE.Vector2(paddleOutlineHalfWidth(y, spec), y),
  );

  // Blade head: from wherever the outline enters the superellipse, round to the
  // tip. Walked by angle so the tip stays smooth (see the note above).
  const arcFromY = Math.max(start, d.shoulderY);
  const thetaStart = bladeAngleAtHeight(arcFromY, spec);
  const arcSteps = Math.max(4, Math.round(spec.bladeArcSegments / 2));
  for (let i = 1; i <= arcSteps; i++) {
    const theta = thetaStart + (Math.PI / 2 - thetaStart) * (i / arcSteps);
    const p = bladeOutlinePoint(theta, spec);
    right.push(new THREE.Vector2(p.x, p.y));
  }

  // Mirror everything except the tip (shared) and re-walk downward, then let
  // Shape close the loop across the flat bottom edge.
  const points = right.slice();
  for (let i = right.length - 2; i >= 0; i--) {
    points.push(new THREE.Vector2(-right[i].x, right[i].y));
  }
  return points;
}

// One flat layer of the sandwich: the outline extruded from z0 to z0 + depth.
function buildLayerGeometry(yMin, z0, depth, spec) {
  const shape = new THREE.Shape(buildOutlinePoints(yMin, spec));
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    // The outline is already an explicit polyline, so curve subdivision has
    // nothing to subdivide — kept at 1 so three doesn't re-tessellate it.
    curveSegments: 1,
  });
  geom.translate(0, 0, z0);
  return geom;
}

// --- Handle -----------------------------------------------------------------

// Lofted superellipse sections from the butt up to the throat. The top rings
// taper toward the ply thickness (see handleHalfDepthAt) so the glued-on cheeks
// die into the blade wood instead of ending in a step — the throat is the whole
// reason this module exists, and a stepped cheek would give it away.
export function buildHandleGeometry(spec = getPaddleSpec()) {
  const d = derivePaddle(spec);
  const rings = Math.max(2, spec.handleRings);
  const radial = Math.max(6, spec.handleRadial);
  const n = spec.handleShapeExponent;

  const positions = [];
  const uvs = [];
  const indices = [];

  const ringY = (i) => d.handleButtY + (d.throatY - d.handleButtY) * (i / rings);

  // Side wall.
  for (let i = 0; i <= rings; i++) {
    const y = ringY(i);
    const a = handleHalfWidthAt(y, spec);
    const b = handleHalfDepthAt(y, spec);
    for (let j = 0; j < radial; j++) {
      const p = superellipsePoint((j / radial) * Math.PI * 2, a, b, n);
      positions.push(p.x, y, p.z);
      uvs.push(j / radial, i / rings);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const jn = (j + 1) % radial;
      const bl = i * radial + j;
      const br = i * radial + jn;
      const tl = (i + 1) * radial + j;
      const tr = (i + 1) * radial + jn;
      indices.push(bl, tl, tr, bl, tr, br);
    }
  }

  // Caps get their own vertices so computeVertexNormals keeps the rim crease
  // sharp instead of smearing the side normals over the flat butt.
  const cap = (i, facing) => {
    const y = ringY(i);
    const a = handleHalfWidthAt(y, spec);
    const b = handleHalfDepthAt(y, spec);
    const center = positions.length / 3;
    positions.push(0, y, 0);
    uvs.push(0.5, 0.5);
    for (let j = 0; j < radial; j++) {
      const p = superellipsePoint((j / radial) * Math.PI * 2, a, b, n);
      positions.push(p.x, y, p.z);
      uvs.push(0.5 + p.x / (2 * a || 1), 0.5 + p.z / (2 * b || 1));
    }
    for (let j = 0; j < radial; j++) {
      const v0 = center + 1 + j;
      const v1 = center + 1 + ((j + 1) % radial);
      if (facing < 0) indices.push(center, v0, v1);
      else indices.push(center, v1, v0);
    }
  };
  cap(0, -1);        // butt, facing −Y
  cap(rings, +1);    // throat, facing +Y (buried under the wings)

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// --- Merge ------------------------------------------------------------------

// Concatenate parts into one geometry with a material group each. Written out
// rather than pulled from BufferGeometryUtils so this module's only import is
// bare `three` and the whole builder stays runnable under jest.
export function mergeParts(parts) {
  let vertexCount = 0;
  const flat = parts.map(({ geometry, slot }) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const count = g.getAttribute('position').count;
    vertexCount += count;
    return { g, slot, count };
  });

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const merged = new THREE.BufferGeometry();

  let offset = 0;
  for (const { g, slot, count } of flat) {
    position.set(g.getAttribute('position').array, offset * 3);
    normal.set(g.getAttribute('normal').array, offset * 3);
    const srcUv = g.getAttribute('uv');
    if (srcUv) uv.set(srcUv.array, offset * 2);
    merged.addGroup(offset, count, slot);
    offset += count;
  }

  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// The whole bat as one geometry. Parts are ordered wood-outward so that a
// glance at the group list reads like a cross-section.
export function buildPaddleGeometry(spec = getPaddleSpec()) {
  const d = derivePaddle(spec);
  const S = MATERIAL_SLOTS;

  return mergeParts([
    {
      slot: S.PLY,
      geometry: buildLayerGeometry(
        d.handleButtY, -spec.plyThickness / 2, spec.plyThickness, spec,
      ),
    },
    {
      slot: S.SPONGE,
      geometry: buildLayerGeometry(
        d.rubberCutY, d.spongeInnerZ, spec.spongeThickness, spec,
      ),
    },
    {
      slot: S.SPONGE,
      geometry: buildLayerGeometry(
        d.rubberCutY, -d.spongeInnerZ - spec.spongeThickness,
        spec.spongeThickness, spec,
      ),
    },
    {
      slot: S.TOPSHEET_FRONT,
      geometry: buildLayerGeometry(
        d.rubberCutY, d.spongeOuterZ, spec.topsheetThickness, spec,
      ),
    },
    {
      slot: S.TOPSHEET_BACK,
      geometry: buildLayerGeometry(
        d.rubberCutY, -d.spongeOuterZ - spec.topsheetThickness,
        spec.topsheetThickness, spec,
      ),
    },
    { slot: S.HANDLE, geometry: buildHandleGeometry(spec) },
  ]);
}

// --- Materials --------------------------------------------------------------

// Roughness values are the ones paddleMaterial.js derived for the GLB and tuned
// in headset — reused rather than re-picked, because the reason they work (the
// rubber/wood contrast IS the "two real materials" cue) has nothing to do with
// which asset carries them. No maps: with the layers as real geometry there is
// nothing left for a texture to fake, and a flat matte surface is what
// regulation rubber actually looks like.
export function buildPaddleMaterials(colors = PADDLE_COLORS) {
  const mat = (color, roughness) => new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness,
    metalness: 0,
    toneMapped: true,
  });

  const materials = [];
  materials[MATERIAL_SLOTS.TOPSHEET_FRONT] = mat(colors.topsheetFront, RUBBER_ROUGHNESS);
  materials[MATERIAL_SLOTS.TOPSHEET_BACK] = mat(colors.topsheetBack, RUBBER_ROUGHNESS);
  // Sponge is a cut cell foam edge — chalkier than the topsheet, and it is the
  // layer that sells the rim as a sandwich, so it must not pick up a highlight.
  materials[MATERIAL_SLOTS.SPONGE] = mat(colors.sponge, 0.95);
  materials[MATERIAL_SLOTS.PLY] = mat(colors.ply, BLADE_ROUGHNESS);
  materials[MATERIAL_SLOTS.HANDLE] = mat(colors.handle, BLADE_ROUGHNESS - 0.05);
  return materials;
}

// --- Assembly ---------------------------------------------------------------

// Anchor empties, at the same names Paddle.glb ships. models.js reads these to
// derive the collision disc, so emitting them keeps ONE derivation path for
// both assets — the procedural bat is a drop-in, and the A/B is genuinely
// comparing assets rather than comparing code paths.
export function buildPaddleAnchors(spec = getPaddleSpec()) {
  const d = derivePaddle(spec);
  const anchor = (name, x, y, z) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    return o;
  };

  const sweetSpot = anchor('SweetSpot', 0, spec.bladeCenterY + 0.018, 0);
  // A blade's liveliest point sits above geometric center; the collider is
  // deliberately NOT centered here (see models.js), but the anchor is still
  // worth carrying for audio/feel work that wants the real sweet spot.
  const bladeNormal = anchor('BladeNormal', 0, 0, 0.05);
  sweetSpot.add(bladeNormal);

  return [
    anchor('EdgeTop', 0, d.bladeTopY, 0),
    anchor('EdgeBottom', 0, d.bladeBottomY, 0),
    anchor('EdgeLeft', -spec.bladeHalfWidth, spec.bladeCenterY, 0),
    anchor('EdgeRight', spec.bladeHalfWidth, spec.bladeCenterY, 0),
    anchor('HandleEnd', 0, d.handleButtY, 0),
    sweetSpot,
  ];
}

// Root object models.js assigns to `paddleModel`. Structurally mirrors the GLB
// scene graph — a group holding one mesh plus the anchor empties — so nothing
// downstream needs to know which asset it got.
export function buildProceduralPaddle(spec = getPaddleSpec()) {
  const root = new THREE.Group();
  root.name = 'ProceduralPaddle';

  const mesh = new THREE.Mesh(buildPaddleGeometry(spec), buildPaddleMaterials());
  mesh.name = 'PaddleBody';
  // Matching the GLB's shadow flags. The paddle casting onto the felt would be
  // a real depth cue, but it is a rendering change with its own perf budget and
  // does not belong in an asset swap.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  root.add(mesh);

  for (const a of buildPaddleAnchors(spec)) root.add(a);
  return root;
}
