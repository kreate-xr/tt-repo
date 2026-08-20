// Procedural paddle junction detail — blade measurement + geometry builders.
//
// paddleDetail.js compensates for Paddle.glb's flat-slab authoring by adding
// rubber caps (overhang lip + straight throat cut) and a sponge/ply rim band,
// all derived from the GLB's Edge* anchor empties. The builders are pure
// three.js geometry, so their invariants are checkable in Node:
//   - blade ellipse comes out of the anchors, not the (handle-polluted) bbox
//   - caps genuinely OVERHANG the blade silhouette and stop at the cut line
//   - the band wraps the full rim, proud of the blade, spanning face-to-face
//   - the full pipeline degrades to a no-op (never throws) on an asset
//     without anchors, and the DOM-only strata texture returns null here.

const THREE = require('three');
const {
  DETAIL_DEFAULTS,
  computeBladeEllipse,
  findBladeFaceZ,
  buildRubberCapShape,
  buildRubberCapGeometry,
  buildEdgeBandGeometry,
  buildStrataTexture,
  addPaddleJunctionDetail,
} = require('../js/scene/paddleDetail.js');

// Synthetic paddle scene mirroring the real GLB's layout: a blade slab plus
// anchor empties at the ellipse extremes (values from the actual asset).
const ANCHORS = {
  EdgeTop: [0, 0.16682, 0],
  EdgeBottom: [0, 0.01729, 0],
  EdgeLeft: [-0.07429, 0.08987, 0],
  EdgeRight: [0.07486, 0.08987, 0],
};
const BLADE_HALF_Z = 0.006;

function makePaddleScene({ withAnchors = true, withBlade = true } = {}) {
  const scene = new THREE.Group();
  if (withAnchors) {
    for (const [name, pos] of Object.entries(ANCHORS)) {
      const empty = new THREE.Object3D();
      empty.name = name;
      empty.position.fromArray(pos);
      scene.add(empty);
    }
  }
  if (withBlade) {
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.15, BLADE_HALF_Z * 2),
      new THREE.MeshBasicMaterial(),
    );
    blade.position.set(0, 0.092, 0);
    scene.add(blade);
  }
  return scene;
}

describe('computeBladeEllipse — anchors in, ellipse out', () => {
  test('center and semi-axes match the anchor extremes', () => {
    const e = computeBladeEllipse(makePaddleScene());
    expect(e.cx).toBeCloseTo((ANCHORS.EdgeLeft[0] + ANCHORS.EdgeRight[0]) / 2, 9);
    expect(e.cy).toBeCloseTo((ANCHORS.EdgeTop[1] + ANCHORS.EdgeBottom[1]) / 2, 9);
    expect(e.rx).toBeCloseTo((ANCHORS.EdgeRight[0] - ANCHORS.EdgeLeft[0]) / 2, 9);
    expect(e.ry).toBeCloseTo((ANCHORS.EdgeTop[1] - ANCHORS.EdgeBottom[1]) / 2, 9);
    expect(e.bottomY).toBeCloseTo(ANCHORS.EdgeBottom[1], 9);
  });

  test('throws loudly on a GLB without anchors', () => {
    expect(() => computeBladeEllipse(makePaddleScene({ withAnchors: false })))
      .toThrow(/missing anchor/);
  });
});

describe('findBladeFaceZ — raycast, not bbox', () => {
  test('finds both blade faces through the sweet spot', () => {
    const z = findBladeFaceZ(makePaddleScene(), 0, 0.092);
    expect(z.front).toBeCloseTo(BLADE_HALF_Z, 6);
    expect(z.back).toBeCloseTo(-BLADE_HALF_Z, 6);
  });

  test('returns null when there is no geometry to hit', () => {
    expect(findBladeFaceZ(makePaddleScene({ withBlade: false }), 0, 0.092)).toBeNull();
  });
});

describe('rubber cap — overhang lip and straight throat cut', () => {
  const ellipse = computeBladeEllipse(makePaddleScene());
  const yCut = ellipse.bottomY + DETAIL_DEFAULTS.cutAboveBottom;
  const params = { ...ellipse, yCut, overhang: DETAIL_DEFAULTS.rubberOverhang };

  test('silhouette overhangs the blade edge but stops at the cut line', () => {
    const pts = buildRubberCapShape(params).getPoints(128);
    let maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      maxX = Math.max(maxX, p.x - ellipse.cx);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // Overhang: widest point is past the blade ellipse by ~the overhang.
    expect(maxX).toBeGreaterThan(ellipse.rx);
    expect(maxX).toBeLessThanOrEqual(ellipse.rx + DETAIL_DEFAULTS.rubberOverhang + 1e-6);
    // Straight cut: nothing below yCut; top reaches the (overhung) blade tip.
    expect(minY).toBeGreaterThanOrEqual(yCut - 1e-6);
    expect(maxY).toBeCloseTo(ellipse.cy + ellipse.ry + DETAIL_DEFAULTS.rubberOverhang, 4);
  });

  test('extruded sheet spans exactly the rubber thickness in z', () => {
    const geom = buildRubberCapGeometry(
      params, DETAIL_DEFAULTS.rubberThickness, DETAIL_DEFAULTS.segments,
    );
    geom.computeBoundingBox();
    expect(geom.boundingBox.min.z).toBeCloseTo(0, 9);
    expect(geom.boundingBox.max.z).toBeCloseTo(DETAIL_DEFAULTS.rubberThickness, 9);
  });
});

describe('edge band — proud of the rim, face to face', () => {
  test('geometry wraps the ellipse at the proud radius across the blade thickness', () => {
    const ellipse = computeBladeEllipse(makePaddleScene());
    const geom = buildEdgeBandGeometry({
      ...ellipse, proud: DETAIL_DEFAULTS.bandProud,
      z0: -BLADE_HALF_Z, z1: BLADE_HALF_Z, segments: 64,
    });
    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    expect(bb.max.x - ellipse.cx).toBeCloseTo(ellipse.rx + DETAIL_DEFAULTS.bandProud, 6);
    expect(bb.max.y).toBeCloseTo(ellipse.cy + ellipse.ry + DETAIL_DEFAULTS.bandProud, 6);
    expect(bb.min.z).toBeCloseTo(-BLADE_HALF_Z, 9);
    expect(bb.max.z).toBeCloseTo(BLADE_HALF_Z, 9);
    // Normals point outward (positive radial dot), never along z.
    const pos = geom.getAttribute('position');
    const nor = geom.getAttribute('normal');
    for (let i = 0; i < pos.count; i += 7) {
      const rx = pos.getX(i) - ellipse.cx;
      const ry = pos.getY(i) - ellipse.cy;
      expect(rx * nor.getX(i) + ry * nor.getY(i)).toBeGreaterThan(0);
      expect(nor.getZ(i)).toBe(0);
    }
  });
});

describe('addPaddleJunctionDetail — full pipeline', () => {
  test('adds lip caps and rim band to a well-formed paddle scene', () => {
    const scene = makePaddleScene();
    const group = addPaddleJunctionDetail(scene);
    expect(group).not.toBeNull();
    expect(scene.getObjectByName('PaddleJunctionDetail')).toBe(group);
    expect(group.getObjectByName('PaddleRubberFront')).toBeDefined();
    expect(group.getObjectByName('PaddleRubberBack')).toBeDefined();
    expect(group.getObjectByName('PaddleEdgeBand')).toBeDefined();

    // Front rubber outer surface sits proud of the blade face by
    // rubberProud + rubberThickness — the visible lip step (~1.4 mm), well
    // inside the 5 mm contact epsilon so collision agreement holds.
    const front = group.getObjectByName('PaddleRubberFront');
    const outerZ = front.position.z + DETAIL_DEFAULTS.rubberThickness;
    const stepHeight = outerZ - BLADE_HALF_Z;
    expect(stepHeight).toBeGreaterThan(0.001);
    expect(stepHeight).toBeLessThan(0.005);

    // Back cap mirrors in −z.
    const back = group.getObjectByName('PaddleRubberBack');
    expect(back.position.z).toBeCloseTo(-front.position.z, 9);
    expect(back.scale.z).toBe(-1);
  });

  test('degrades to a no-op (null, no throw) without anchors or geometry', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(addPaddleJunctionDetail(makePaddleScene({ withAnchors: false }))).toBeNull();
    expect(addPaddleJunctionDetail(makePaddleScene({ withBlade: false }))).toBeNull();
    warn.mockRestore();
  });

  test('strata texture is DOM-only and returns null in Node', () => {
    expect(buildStrataTexture()).toBeNull();
  });
});
