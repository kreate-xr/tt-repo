// Procedural paddle junction detail.
//
// Paddle.glb models the bat as a single flat-shaded slab: no rubber lip where
// the face meets the handle, no visible sponge/ply sandwich at the rim, no
// straight rubber cut above the throat. Those missing layers are exactly what
// the eye checks at VR viewing distance to decide "assembled real paddle" vs
// "molded toy" — and they can't be patched with materials alone.
//
// The GLB does ship artist-authored blade-extent anchors (EdgeTop, EdgeBottom,
// EdgeLeft, EdgeRight as empties parented to the mesh node), which give the
// blade's ellipse in mesh-local space. From that we build, procedurally:
//
//   1. Two matte rubber caps — elliptical sheets extruded ~1.2 mm, silhouette
//      1 mm LARGER than the blade (the classic rubber-overhang lip), with a
//      straight chord cut above the throat. The extrusion's side wall is the
//      visible lip step; the chord edge is the straight factory cut.
//   2. An edge band — thin ribbon proud of the blade rim between the caps,
//      striped sponge/ply/sponge, so looking at the rim shows the sandwich.
//
// Everything is added to the GLB scene BEFORE models.js measures the bounding
// box, so collision thickness inherits the rubber automatically (~1 mm — far
// inside the 5 mm contact epsilon). Geometry builders are pure and unit-tested
// in Node; only the stripe texture needs a DOM and degrades to flat sponge
// color without one.

import * as THREE from 'three';

// All tuning in one place. Distances in meters, mesh-local space.
export const DETAIL_DEFAULTS = {
  rubberThickness: 0.0012,   // extruded sheet depth — reads as sheet, not slab
  rubberOverhang:  0.0010,   // silhouette growth past blade edge (the lip)
  rubberProud:     0.0002,   // gap between blade face and sheet underside
  cutAboveBottom:  0.010,    // straight cut height above blade bottom (throat)
  bandProud:       0.0003,   // rim band radius growth past blade edge
  segments:        96,       // ellipse tessellation
  frontColor:      0xd21a24, // tournament red (matches GLB face texture)
  backColor:       0x1a1a1a, // tournament black
  spongeColor:     0xe8d9b0, // cream sponge — band fallback when no DOM
  rubberRoughness: 0.85,     // same finish paddleMaterial.js gives the faces
};

// Blade ellipse from the GLB's authored anchor empties. Anchors are children
// of the (transform-less) mesh node, so their local translations ARE
// mesh-local coordinates. Throws on a missing anchor — same policy as
// Table.glb's getAnchor in models.js: a silently-wrong blade ellipse would
// place the lip visibly off the blade, worse than failing loud.
export function computeBladeEllipse(paddleScene) {
  const get = (name) => {
    const node = paddleScene.getObjectByName(name);
    if (!node) throw new Error(`Paddle.glb is missing anchor '${name}'`);
    return node.position;
  };
  const top = get('EdgeTop');
  const bottom = get('EdgeBottom');
  const left = get('EdgeLeft');
  const right = get('EdgeRight');
  return {
    cx: (left.x + right.x) / 2,
    cy: (top.y + bottom.y) / 2,
    rx: (right.x - left.x) / 2,
    ry: (top.y - bottom.y) / 2,
    bottomY: bottom.y,
  };
}

// Front/back blade face Z via raycast through the blade center. The bounding
// box can't answer this — the handle is thicker than the blade and would
// report its own extents. Must run BEFORE detail meshes are added (they'd
// intercept the ray). Returns null when nothing was hit (defensive: a future
// GLB without geometry at the sweet spot).
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
export function findBladeFaceZ(paddleScene, cx, cy) {
  paddleScene.updateMatrixWorld(true);
  const caster = new THREE.Raycaster();

  _rayOrigin.set(cx, cy, 1);
  _rayDir.set(0, 0, -1);
  caster.set(_rayOrigin, _rayDir);
  const frontHits = caster.intersectObject(paddleScene, true);
  if (frontHits.length === 0) return null;

  _rayOrigin.set(cx, cy, -1);
  _rayDir.set(0, 0, 1);
  caster.set(_rayOrigin, _rayDir);
  const backHits = caster.intersectObject(paddleScene, true);
  if (backHits.length === 0) return null;

  return { front: frontHits[0].point.z, back: backHits[0].point.z };
}

// Rubber sheet silhouette: blade ellipse grown by `overhang`, cut straight at
// `yCut`. Built as an ellipse arc between the two y=yCut crossings plus the
// chord, so the cut is a genuine straight edge with its own wall — not a
// clamped ellipse.
export function buildRubberCapShape({ cx, cy, rx, ry, yCut, overhang = 0 }) {
  const Rx = rx + overhang;
  const Ry = ry + overhang;
  // sin(t) at the cut line; clamp keeps a degenerate cut (at/below the ellipse
  // bottom) from NaNing the asin.
  const s = Math.max(-1, Math.min(1, (yCut - cy) / Ry));
  const tRight = Math.asin(s);            // right crossing, lower quadrant
  const tLeft = Math.PI - tRight;         // left crossing

  const shape = new THREE.Shape();
  shape.absellipse(cx, cy, Rx, Ry, tRight, tLeft, false, 0);
  shape.closePath();                      // chord: left crossing → right crossing
  return shape;
}

export function buildRubberCapGeometry(params, thickness, segments) {
  const shape = buildRubberCapShape(params);
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: segments,
  });
  return geom; // spans z ∈ [0, thickness] in shape space
}

// Rim band: ribbon at the blade silhouette (slightly proud), spanning the
// blade thickness between the two rubber caps. UV v runs across the width so
// the strata texture stripes lie parallel to the faces.
export function buildEdgeBandGeometry({ cx, cy, rx, ry, proud, z0, z1, segments }) {
  const Rx = rx + proud;
  const Ry = ry + proud;
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const normals = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];

  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const x = cx + Rx * Math.cos(t);
    const y = cy + Ry * Math.sin(t);
    // Outward normal of an ellipse: gradient (cos/Rx, sin/Ry), normalized.
    let nx = Math.cos(t) / Rx;
    let ny = Math.sin(t) / Ry;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;

    for (let j = 0; j < 2; j++) {
      const v = i * 2 + j;
      positions[v * 3 + 0] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = j === 0 ? z0 : z1;
      normals[v * 3 + 0] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = 0;
      uvs[v * 2 + 0] = i / segments;
      uvs[v * 2 + 1] = j;
    }
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

// Sponge/ply strata stripes for the rim band, drawn across UV v: sponge cream
// at both faces, wood ply through the middle with a couple of darker glue
// lines. 8×64 px is plenty — it's a 1 cm-wide band. DOM-only; callers fall
// back to flat sponge color.
export function buildStrataTexture() {
  if (typeof document === 'undefined') return null;
  const W = 8, H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bands = [
    [0.00, 0.18, '#e8d9b0'],   // sponge (back face side)
    [0.18, 0.24, '#8a6a44'],   // glue/ply line
    [0.24, 0.76, '#c8a878'],   // wood core
    [0.76, 0.82, '#8a6a44'],   // glue/ply line
    [0.82, 1.00, '#e8d9b0'],   // sponge (front face side)
  ];
  for (const [from, to, color] of bands) {
    ctx.fillStyle = color;
    ctx.fillRect(0, Math.floor(from * H), W, Math.ceil((to - from) * H));
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false; // 8 px wide — mips just blur the strata away
  return tex;
}

// Orchestrator. Adds the detail meshes to the GLB scene in mesh-local space
// and returns the group (null when the blade couldn't be measured). Call
// BEFORE models.js applies PADDLE_EULER / measures the bounding box so the
// caps rotate with the bat and collision thickness includes the rubber.
export function addPaddleJunctionDetail(paddleScene, opts = {}) {
  const o = { ...DETAIL_DEFAULTS, ...opts };

  let ellipse;
  try {
    ellipse = computeBladeEllipse(paddleScene);
  } catch (e) {
    console.warn('paddleDetail: skipped —', e.message);
    return null;
  }
  const faceZ = findBladeFaceZ(paddleScene, ellipse.cx, ellipse.cy);
  if (!faceZ) {
    console.warn('paddleDetail: skipped — blade face raycast found no geometry');
    return null;
  }

  const group = new THREE.Group();
  group.name = 'PaddleJunctionDetail';

  const yCut = ellipse.bottomY + o.cutAboveBottom;
  const capParams = {
    cx: ellipse.cx, cy: ellipse.cy, rx: ellipse.rx, ry: ellipse.ry,
    yCut, overhang: o.rubberOverhang,
  };
  const capGeom = buildRubberCapGeometry(capParams, o.rubberThickness, o.segments);

  const mkRubber = (color) => new THREE.MeshStandardMaterial({
    color, roughness: o.rubberRoughness, metalness: 0,
  });

  // Front cap: underside rests rubberProud above the front face, sheet
  // extrudes outward (+z). Back cap mirrors it via z-scale so the extrusion
  // grows in −z; the silhouette is x/y-symmetric so no winding issues show.
  const front = new THREE.Mesh(capGeom, mkRubber(o.frontColor));
  front.name = 'PaddleRubberFront';
  front.position.z = faceZ.front + o.rubberProud;
  group.add(front);

  const back = new THREE.Mesh(capGeom, mkRubber(o.backColor));
  back.name = 'PaddleRubberBack';
  back.position.z = faceZ.back - o.rubberProud;
  back.scale.z = -1;
  group.add(back);

  const bandGeom = buildEdgeBandGeometry({
    cx: ellipse.cx, cy: ellipse.cy, rx: ellipse.rx, ry: ellipse.ry,
    proud: o.bandProud, z0: faceZ.back, z1: faceZ.front, segments: o.segments,
  });
  const strata = buildStrataTexture();
  const bandMat = new THREE.MeshStandardMaterial({
    color: strata ? 0xffffff : o.spongeColor,
    map: strata,
    roughness: 0.9,
    metalness: 0,
  });
  const band = new THREE.Mesh(bandGeom, bandMat);
  band.name = 'PaddleEdgeBand';
  group.add(band);

  paddleScene.add(group);
  return group;
}
