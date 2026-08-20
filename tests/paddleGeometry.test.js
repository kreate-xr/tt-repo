// The procedural paddle: authored numbers vs. what the loader measures.
//
// The whole reason for building the bat from a spec instead of loading a GLB is
// that the physical facts stop being recovered by measurement and start being
// definitions. That only pays off if the two agree — models.js still derives
// the collision disc by measuring the loaded scene (deliberately: ONE derivation
// path for both assets, so the A/B is honest). So the load-bearing test here is
// the round trip: build the mesh from PADDLE_SPEC, run models.js's measurement
// on it, and require the answer to come back as the spec.
//
// The rest guards the two things the GLB gets wrong that this asset exists to
// fix: contact-visual agreement at the rim, and a throat that reads as an
// assembled joint rather than a butt joint.

const THREE = require('three');
const {
  PADDLE_SPEC, getPaddleSpec, setPaddleSpec, resetPaddleSpec, derivePaddle,
  paddleOutlineHalfWidth, handleHalfWidthAt, handleHalfDepthAt,
  paddleMassProperties, swingWeightScale, superellipseArea,
  paddleSpecOverridesFromQuery,
} = require('../js/physics/paddleSpec.js');
const {
  buildOutlinePoints, buildPaddleGeometry, buildProceduralPaddle,
  buildPaddleAnchors, MATERIAL_SLOTS,
} = require('../js/scene/paddleGeometry.js');

// models.js's fixed model→controller Euler. Duplicated rather than imported
// because models.js pulls in the whole scene graph; if it ever changes, the
// orientation test below is exactly the one that should fail.
const PADDLE_EULER = new THREE.Euler(Math.PI / 2, Math.PI / 2, Math.PI, 'XYZ');

afterEach(() => { resetPaddleSpec(); });

// --- The round trip ---------------------------------------------------------

// Verbatim reproduction of the derivation in js/scene/models.js: bbox axes,
// anchor-derived disc, blade-band thickness scan. If this drifts from the
// loader the test is worthless, so it is written to mirror that code's shape
// rather than to be clever.
function measureLikeLoader(paddleModel) {
  paddleModel.rotation.set(0, 0, 0);
  paddleModel.updateMatrixWorld(true);
  const unrotatedSize = new THREE.Box3()
    .setFromObject(paddleModel).getSize(new THREE.Vector3());

  const dims = [
    { axis: 'x', size: unrotatedSize.x },
    { axis: 'y', size: unrotatedSize.y },
    { axis: 'z', size: unrotatedSize.z },
  ].sort((a, b) => a.size - b.size);
  const thinAxis = dims[0].axis;
  const medAxis = dims[1].axis;
  const longAxis = dims[2].axis;

  const faceNormalModel = new THREE.Vector3(
    thinAxis === 'x' ? 1 : 0, thinAxis === 'y' ? 1 : 0, thinAxis === 'z' ? 1 : 0,
  );

  const bladeAnchor = (name) => {
    const node = paddleModel.getObjectByName(name);
    if (!node) throw new Error(`missing anchor '${name}'`);
    return paddleModel.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
  };
  const bladeTop = bladeAnchor('EdgeTop');
  const bladeBottom = bladeAnchor('EdgeBottom');
  const bladeLeft = bladeAnchor('EdgeLeft');
  const bladeRight = bladeAnchor('EdgeRight');

  const faceCenterModel = new THREE.Vector3();
  faceCenterModel[longAxis] = (bladeTop[longAxis] + bladeBottom[longAxis]) / 2;

  const bladeHalfWidth = Math.abs(bladeRight[medAxis] - bladeLeft[medAxis]) / 2;
  const bladeHalfLength = Math.abs(bladeTop[longAxis] - bladeBottom[longAxis]) / 2;
  const hitRadius = Math.max(bladeHalfWidth, bladeHalfLength, 0.05);

  const bladeMid = faceCenterModel[longAxis];
  const sampleBand = bladeHalfLength * 0.5;
  let thinMin = Infinity;
  let thinMax = -Infinity;
  const v = new THREE.Vector3();
  paddleModel.traverse((node) => {
    const pos = node.isMesh && node.geometry && node.geometry.attributes.position;
    if (!pos) return;
    node.updateMatrixWorld(true);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
      paddleModel.worldToLocal(v);
      if (Math.abs(v[longAxis] - bladeMid) > sampleBand) continue;
      if (v[thinAxis] < thinMin) thinMin = v[thinAxis];
      if (v[thinAxis] > thinMax) thinMax = v[thinAxis];
    }
  });
  const halfThickness = thinMin <= thinMax
    ? (thinMax - thinMin) / 2
    : unrotatedSize[thinAxis] / 2;

  paddleModel.rotation.copy(PADDLE_EULER);
  const q = new THREE.Quaternion().setFromEuler(paddleModel.rotation);
  return {
    thinAxis, medAxis, longAxis, hitRadius, halfThickness, unrotatedSize,
    faceNormalLocal: faceNormalModel.clone().applyQuaternion(q).normalize(),
    faceOffset: faceCenterModel.clone().applyQuaternion(q),
    faceCenterModel,
  };
}

describe('measured == authored — the procedural bat survives the GLB loader path', () => {
  const spec = getPaddleSpec();
  const d = derivePaddle(spec);
  const m = measureLikeLoader(buildProceduralPaddle());

  test('axis convention matches what PADDLE_EULER was validated against', () => {
    // thin = face normal, long = handle→tip, med = width. The handle must stay
    // the thickest part of the bat and the blade the widest, or the loader
    // picks different axes and the bat arrives sideways in the player's hand.
    expect(m.thinAxis).toBe('z');
    expect(m.medAxis).toBe('x');
    expect(m.longAxis).toBe('y');
  });

  test('collision disc radius comes back as the authored blade radius', () => {
    expect(m.hitRadius).toBeCloseTo(d.hitRadius, 9);
  });

  test('disc center comes back as the authored blade center', () => {
    expect(m.faceCenterModel.y).toBeCloseTo(spec.bladeCenterY, 9);
    expect(m.faceOffset.length()).toBeCloseTo(spec.bladeCenterY, 9);
  });

  test('blade half-thickness is measured on the blade, not the handle', () => {
    // The vertex scan samples the middle half of the blade. It must find the
    // rubber stack (6.8 mm), not the handle (12.2 mm) — the exact confusion
    // that made the GLB report 10.15 mm for a 5.3 mm blade and lifted the bat
    // off the felt.
    expect(m.halfThickness).toBeCloseTo(d.bladeHalfThickness, 6);
    expect(m.halfThickness).toBeLessThan(m.unrotatedSize.z / 2 * 0.8);
  });

  test('face normal lands on the controller axis the presets assume', () => {
    // Model +Z → grip +X (out through the knuckles), model +Y → grip −Z (blade
    // along the barrel). Every posOffset in calibrationPresets.js is written in
    // that frame, so this is what keeps them meaningful.
    expect(m.faceNormalLocal.x).toBeCloseTo(1, 6);
    expect(m.faceNormalLocal.y).toBeCloseTo(0, 6);
    expect(m.faceNormalLocal.z).toBeCloseTo(0, 6);

    const tip = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(new THREE.Quaternion().setFromEuler(PADDLE_EULER));
    expect(tip.z).toBeCloseTo(-1, 6);
  });

  test('every anchor models.js depends on is present', () => {
    const root = buildProceduralPaddle();
    for (const name of ['EdgeTop', 'EdgeBottom', 'EdgeLeft', 'EdgeRight',
      'HandleEnd', 'SweetSpot']) {
      expect(root.getObjectByName(name)).toBeDefined();
    }
    // The collider is deliberately NOT centered on the sweet spot; assert they
    // are genuinely different so a future "simplification" to SweetSpot bites.
    const sweet = root.getObjectByName('SweetSpot');
    expect(Math.abs(sweet.position.y - spec.bladeCenterY)).toBeGreaterThan(0.01);
  });
});

// --- Contact-visual agreement ----------------------------------------------

describe('the disc IS the rubber — zero rim disagreement', () => {
  // The GLB's blade is not a circle, so a disc collider either leaves ~10 mm of
  // rim rubber resolving as a wood strike or hangs phantom face over the
  // throat. A circular blade removes the trade entirely. Judged against the
  // MESH, not against the spec it was built from, so this cannot become a
  // tautology that drifts with the formula.
  const spec = getPaddleSpec();
  const d = derivePaddle(spec);
  const geom = buildPaddleGeometry();
  const pos = geom.getAttribute('position');

  // Rubber-layer vertices only: everything at or beyond the sponge's inner
  // face, above the factory cut. That is the surface the player sees and aims.
  // Widest rubber vertex in each 2 mm band, carrying its OWN y rather than the
  // band's nominal height — comparing a width sampled at one height against a
  // disc evaluated at another manufactures ~1 mm of error that is an artifact
  // of the bucketing, not of the bat.
  const rim = [];
  {
    const v = new THREE.Vector3();
    const bands = new Map();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.y < d.rubberCutY - 1e-6) continue;
      if (Math.abs(v.z) < d.spongeInnerZ - 1e-6) continue;
      const key = Math.round(v.y / 0.002);
      const w = Math.abs(v.x);
      const prev = bands.get(key);
      if (!prev || prev[1] < w) bands.set(key, [v.y, w]);
    }
    for (const entry of bands.values()) rim.push(entry);
  }

  test('the sample actually covers the blade', () => {
    expect(rim.length).toBeGreaterThan(30);
  });

  test('essentially no visible rubber falls outside the clean-face disc', () => {
    // This is the direction that matters most: rubber outside the disc drops
    // into detectDiscCollision's edge band and resolves as a wood strike, so a
    // visually clean hit sprays. The GLB sits at 10.0 mm here and its own test
    // allows 12 mm. The superellipse pushes its corners barely past the disc
    // because the exponent was fitted with exactly this bound in mind — at
    // n = 2.8 it would be 6.4 mm.
    let worstOutside = 0;
    for (const [y, w] of rim) {
      worstOutside = Math.max(worstOutside,
        Math.hypot(y - spec.bladeCenterY, w) - d.hitRadius);
    }
    expect(worstOutside).toBeLessThanOrEqual(0.002);
  });

  test('collar over the blade proper is only the long-vs-wide difference', () => {
    // models.js takes the disc radius as the LARGER blade half-extent (the same
    // derivation both assets go through), and a real head is 157 long by 150
    // wide, so some collar at the widest point is structural — it is the 7 mm
    // the head is longer than it is wide, halved. It must not exceed that.
    let worst = 0;
    for (const [y, w] of rim) {
      if (y < d.shoulderY) continue;
      const dy = y - spec.bladeCenterY;
      const discW = Math.sqrt(Math.max(0, d.hitRadius * d.hitRadius - dy * dy));
      worst = Math.max(worst, discW - w);
    }
    expect(worst).toBeLessThanOrEqual(
      (spec.bladeHalfLength - spec.bladeHalfWidth) + 1e-4,
    );
  });

  test('worst-case phantom face is bounded, and lives where balls do not', () => {
    // The direction the GLB's test never checked: a disc LARGER than the blade
    // means balls that visually miss still come back — the "invisible collar"
    // failure the old 0.09 radius floor caused at 15.2 mm.
    //
    // Worst case is 4.8 mm and sits at the rubber cut, down in the throat where
    // the outline is still necking into the handle. That is inside the 10 mm
    // contact-visual agreement budget, and the trade is deliberate: a circular
    // head made this exactly zero but read as visibly undersized next to a real
    // bat. Removing it without shrinking the blade needs an elliptical collider,
    // not a different constant — a disc cannot represent a shape that necks.
    //
    // Raise this bound only with a measurement; do not relax it to make a spec
    // edit pass.
    let worst = 0;
    let worstY = 0;
    for (const [y, w] of rim) {
      const dy = y - spec.bladeCenterY;
      if (Math.abs(dy) > d.hitRadius) continue;
      const discW = Math.sqrt(Math.max(0, d.hitRadius * d.hitRadius - dy * dy));
      if (discW - w > worst) { worst = discW - w; worstY = y; }
    }
    expect(worst).toBeLessThanOrEqual(0.006);
    // If the worst case ever migrates up onto the blade proper, the head has
    // been reshaped into something a disc fits worse.
    expect(worstY).toBeLessThan(d.shoulderY);
  });

  test('no phantom face past the blade tip', () => {
    let meshMax = -Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.y > meshMax) meshMax = v.y;
    }
    expect((spec.bladeCenterY + d.hitRadius) - meshMax).toBeLessThanOrEqual(0.001);
  });
});

// --- Silhouette -------------------------------------------------------------

describe('silhouette — the throat is a joint, not a butt joint', () => {
  const spec = getPaddleSpec();
  const d = derivePaddle(spec);

  test('outline is continuous across both throat seams', () => {
    const eps = 1e-6;
    for (const y of [d.throatY, d.shoulderY]) {
      const below = paddleOutlineHalfWidth(y - eps);
      const above = paddleOutlineHalfWidth(y + eps);
      expect(Math.abs(above - below)).toBeLessThan(1e-5);
    }
  });

  test('outline is tangent-continuous — no crease for the key light to catch', () => {
    const h = 2e-5;
    const slope = (y) => (paddleOutlineHalfWidth(y + h) - paddleOutlineHalfWidth(y - h)) / (2 * h);
    for (const y of [d.throatY, d.shoulderY]) {
      expect(Math.abs(slope(y - 3 * h) - slope(y + 3 * h))).toBeLessThan(0.15);
    }
  });

  test('the throat is CONCAVE — the wings flare late, as real wood does', () => {
    // A straight ramp from handle width to blade width is the butt joint we are
    // removing, so the flare must sit INSIDE its own chord for most of the run.
    // It is not required to be strictly concave: the Hermite matches the blade
    // circle's slope at the shoulder, which is steep, and that tangency costs a
    // ~1.2 mm overshoot just before the join. Tangency is worth more than
    // textbook concavity — a slope discontinuity there would put a hard
    // highlight line across the throat, which is the artifact this shape exists
    // to remove.
    const w0 = paddleOutlineHalfWidth(d.throatY);
    const w1 = paddleOutlineHalfWidth(d.shoulderY);
    const chordAt = (t) => w0 + (w1 - w0) * t;
    const widthAt = (t) => paddleOutlineHalfWidth(
      d.throatY + (d.shoulderY - d.throatY) * t,
    );

    let dipped = 0;
    let overshoot = 0;
    const samples = 40;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const delta = widthAt(t) - chordAt(t);
      if (delta < -1e-4) dipped++;
      overshoot = Math.max(overshoot, delta);
    }
    expect(dipped / (samples - 1)).toBeGreaterThan(0.6);
    expect(overshoot).toBeLessThan(0.0015);
    // The waist of the flare is where the eye reads "assembled": it must be
    // visibly inside the chord, not a rounding error away from it.
    expect(chordAt(0.5) - widthAt(0.5)).toBeGreaterThan(0.001);
  });

  test('the outline never crosses itself or goes negative', () => {
    for (let y = d.handleButtY; y <= d.bladeTopY; y += 0.0005) {
      const w = paddleOutlineHalfWidth(y);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(spec.bladeHalfWidth + 1e-9);
    }
  });

  test('the head is FULLER than an ellipse — low, wide shoulders', () => {
    // The regression this guards is the one that actually shipped and had to be
    // caught by eye: a head that is technically the right size but pinches away
    // from its widest point too fast reads as undersized, because what the eye
    // judges is the area of red, not the bounding box. An ellipse (n = 2) is
    // the pinchiest realistic outline and a circle is worse still.
    //
    // Checked low on the blade, where the difference lives: the ellipse of the
    // same half-extents must be materially narrower down there.
    expect(spec.bladeShapeExponent).toBeGreaterThan(2);
    const cy = spec.bladeCenterY;
    const ry = spec.bladeHalfLength;
    for (const frac of [0.55, 0.7, 0.85]) {
      const y = cy - ry * frac;
      const v = frac;
      const ellipse = spec.bladeHalfWidth * Math.sqrt(1 - v * v);
      expect(paddleOutlineHalfWidth(y)).toBeGreaterThan(ellipse + 0.002);
    }
  });

  test('head proportions are a real competition blade', () => {
    // 150 × 157 mm. Guards against anyone "simplifying" back to a square or
    // circular head to make the disc collider exact — that was tried, and it
    // is the change that made the bat look small.
    expect(spec.bladeHalfWidth * 2).toBeCloseTo(0.150, 4);
    expect(spec.bladeHalfLength * 2).toBeCloseTo(0.157, 4);
    expect(spec.bladeHalfLength).toBeGreaterThan(spec.bladeHalfWidth);
  });

  test('shoulders sit low — the head reaches near-full width fast', () => {
    // A long lazy throat flare holds the outline well inside the blade curve
    // for the whole lower third and produces the "narrow head on a stick" look.
    // By a quarter of the way up the head, the outline must already be at 80%
    // of maximum width.
    const y = derivePaddle().bladeBottomY + spec.bladeHalfLength * 0.5;
    expect(paddleOutlineHalfWidth(y)).toBeGreaterThan(spec.bladeHalfWidth * 0.8);
  });

  test('handle is flared — widest at the butt, narrowest at the waist', () => {
    const butt = handleHalfWidthAt(d.handleButtY);
    const waist = handleHalfWidthAt(d.handleButtY + spec.handleLength * 0.45);
    const throat = handleHalfWidthAt(d.throatY);
    expect(butt).toBeGreaterThan(waist);
    expect(throat).toBeGreaterThan(waist);
    expect(butt).toBeCloseTo(spec.handleHalfWidthButt, 9);
  });

  test('handle cheeks taper into the ply instead of ending in a step', () => {
    const atBevel = handleHalfDepthAt(d.bevelStartY);
    const atTop = handleHalfDepthAt(d.throatY);
    expect(atBevel).toBeGreaterThan(atTop);
    // Must land near the ply half-thickness, or a cheek edge sticks out of the
    // blade at the throat — the exact tell the GLB has.
    expect(atTop).toBeLessThan(d.coreHalfThickness + 0.002);
  });

  test('outline points form a closed, mirrored loop with a flat bottom', () => {
    const pts = buildOutlinePoints(d.handleButtY);
    expect(pts.length).toBeGreaterThan(50);
    expect(pts[0].y).toBeCloseTo(d.handleButtY, 9);
    expect(pts[pts.length - 1].y).toBeCloseTo(d.handleButtY, 9);
    expect(pts[0].x).toBeCloseTo(-pts[pts.length - 1].x, 9);
    // Exactly one point at the tip, shared by both sides.
    const tips = pts.filter((p) => p.y > d.bladeTopY - 1e-9);
    expect(tips).toHaveLength(1);
    expect(tips[0].x).toBeCloseTo(0, 6);
  });
});

// --- Mesh -------------------------------------------------------------------

describe('mesh — one rigid body, five real layers', () => {
  test('the whole bat is ONE mesh: handle and face share a world matrix', () => {
    // The rigidity guarantee tests/paddleRigidity.test.js protects for the GLB,
    // held here by construction rather than by an export setting.
    const root = buildProceduralPaddle();
    const meshes = [];
    root.traverse((n) => { if (n.isMesh) meshes.push(n); });
    expect(meshes).toHaveLength(1);
    expect(meshes[0].scale.x).toBe(1);
    expect(meshes[0].scale.y).toBe(1);
    expect(meshes[0].scale.z).toBe(1);
    expect(meshes[0].position.lengthSq()).toBe(0);
  });

  test('material groups tile the geometry with no gap and no overlap', () => {
    const geom = buildPaddleGeometry();
    const count = geom.getAttribute('position').count;
    const sorted = [...geom.groups].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const g of sorted) {
      expect(g.start).toBe(cursor);
      cursor += g.count;
    }
    expect(cursor).toBe(count);
    // An unassigned slot renders as default white plastic in three.js.
    const slots = new Set(Object.values(MATERIAL_SLOTS));
    for (const g of geom.groups) expect(slots.has(g.materialIndex)).toBe(true);
  });

  test('the rim shows the sandwich — five distinct z layers at the blade edge', () => {
    const d = derivePaddle();
    const geom = buildPaddleGeometry();
    const pos = geom.getAttribute('position');
    const zs = new Set();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.y < d.rubberCutY) continue;
      zs.add(Math.round(v.z * 1e5));
    }
    // ±ply, ±sponge outer, ±topsheet outer = 6 distinct planes.
    const expected = [
      d.coreHalfThickness, d.spongeOuterZ,
      d.spongeOuterZ + getPaddleSpec().topsheetThickness,
    ];
    for (const z of expected) {
      expect(zs.has(Math.round(z * 1e5))).toBe(true);
      expect(zs.has(Math.round(-z * 1e5))).toBe(true);
    }
  });

  test('no NaN survives into the buffers', () => {
    const geom = buildPaddleGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const a = geom.getAttribute(name).array;
      for (let i = 0; i < a.length; i++) expect(Number.isFinite(a[i])).toBe(true);
    }
  });

  test('triangle budget stays inside the asset checklist range', () => {
    const tris = buildPaddleGeometry().getAttribute('position').count / 3;
    expect(tris).toBeGreaterThan(1000);
    expect(tris).toBeLessThan(8000);
  });

  test('real-bat envelope — matches the re-authoring checklist §2', () => {
    const root = buildProceduralPaddle();
    root.rotation.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    expect(size.x).toBeGreaterThan(0.140);
    expect(size.x).toBeLessThan(0.160);
    expect(size.y).toBeGreaterThan(0.240);
    expect(size.y).toBeLessThan(0.270);
    // Blade stack 12–20 mm; the bbox thin axis is the handle, which is thicker.
    expect(derivePaddle().bladeHalfThickness * 2).toBeGreaterThan(0.012);
    expect(derivePaddle().bladeHalfThickness * 2).toBeLessThan(0.020);
  });

  test('anchors sit on the geometry they claim to describe', () => {
    const spec = getPaddleSpec();
    const d = derivePaddle(spec);
    const byName = Object.fromEntries(
      buildPaddleAnchors().map((a) => [a.name, a.position]),
    );
    expect(byName.EdgeTop.y).toBeCloseTo(d.bladeTopY, 9);
    expect(byName.EdgeBottom.y).toBeCloseTo(d.bladeBottomY, 9);
    expect(byName.EdgeRight.x).toBeCloseTo(spec.bladeHalfWidth, 9);
    expect(byName.EdgeLeft.x).toBeCloseTo(-spec.bladeHalfWidth, 9);
    expect(byName.HandleEnd.y).toBeCloseTo(d.handleButtY, 9);
    // EdgeLeft/Right must sit at the widest point, or the loader's radius is
    // narrower than the blade.
    expect(paddleOutlineHalfWidth(spec.bladeCenterY))
      .toBeCloseTo(spec.bladeHalfWidth, 9);
  });
});

// --- Mass and swing weight --------------------------------------------------

describe('mass properties — a bat that weighs what a bat weighs', () => {
  const p = paddleMassProperties();

  test('assembled mass lands where a real racket does', () => {
    expect(p.massGrams).toBeGreaterThan(160);
    expect(p.massGrams).toBeLessThan(210);
  });

  test('the split between blade and rubber is realistic', () => {
    // A bare allround blade is 80–95 g; a sheet of rubber with sponge is
    // 45–52 g per side. Getting the SPLIT right matters more than the total,
    // because it is what puts the mass out at the head and sets swing weight.
    expect(p.bladeGrams).toBeGreaterThan(75);
    expect(p.bladeGrams).toBeLessThan(95);
    expect(p.rubberGrams / 2).toBeGreaterThan(42);
    expect(p.rubberGrams / 2).toBeLessThan(55);
    expect(p.bladeGrams + p.rubberGrams).toBeCloseTo(p.massGrams, 6);
  });

  test('balance point sits ahead of the hand, as a head-heavy bat does', () => {
    expect(p.balanceY).toBeGreaterThan(0.060);
    expect(p.balanceY).toBeLessThan(0.095);
  });

  test('swing weight about the grip is in the real range', () => {
    expect(p.inertiaGripX).toBeGreaterThan(1.0e-3);
    expect(p.inertiaGripX).toBeLessThan(2.5e-3);
  });

  test('the shipped spec is feel-neutral by construction', () => {
    // Same contract paddleWeight.js holds for its slider: the default must be
    // exactly 1, so "did my edit change the feel?" stays decidable.
    expect(swingWeightScale()).toBe(1);
  });

  test('moving mass away from the hand raises swing weight, and vice versa', () => {
    const base = paddleMassProperties().inertiaGripX;

    setPaddleSpec({ bladeCenterY: PADDLE_SPEC.bladeCenterY + 0.02 });
    const further = paddleMassProperties().inertiaGripX;
    expect(further).toBeGreaterThan(base);
    resetPaddleSpec();

    setPaddleSpec({ topsheetThickness: PADDLE_SPEC.topsheetThickness * 2 });
    const thicker = paddleMassProperties();
    expect(thicker.inertiaGripX).toBeGreaterThan(base);
    expect(thicker.massGrams).toBeGreaterThan(paddleMassProperties(PADDLE_SPEC).massGrams);
    resetPaddleSpec();

    // A longer handle adds mass BEHIND the hand, which pulls the balance back
    // toward the grip — the classic way to de-tune a head-heavy bat.
    setPaddleSpec({ handleLength: PADDLE_SPEC.handleLength + 0.02 });
    expect(paddleMassProperties().balanceY)
      .toBeLessThan(paddleMassProperties(PADDLE_SPEC).balanceY);
    resetPaddleSpec();
  });

  test('recoil follows the geometry, still neutral on the shipped bat', () => {
    const { recoilWeightScale, geometrySwingScale, DEFAULT_WEIGHT } =
      require('../js/physics/paddleWeight.js');
    expect(geometrySwingScale()).toBe(1);
    expect(recoilWeightScale(DEFAULT_WEIGHT)).toBeCloseTo(1, 12);

    setPaddleSpec({ bladeCenterY: PADDLE_SPEC.bladeCenterY + 0.03 });
    expect(geometrySwingScale()).toBeGreaterThan(1);
    expect(recoilWeightScale(DEFAULT_WEIGHT)).toBeGreaterThan(1);
    resetPaddleSpec();
  });

  test('superellipse area interpolates between ellipse and rectangle', () => {
    expect(superellipseArea(1, 1, 2)).toBeCloseTo(Math.PI, 6);
    expect(superellipseArea(1, 1, 4)).toBeGreaterThan(Math.PI);
    expect(superellipseArea(1, 1, 4)).toBeLessThan(4);
    expect(superellipseArea(2, 3, 2)).toBeCloseTo(Math.PI * 6, 6);
  });
});

// --- Dev overrides ----------------------------------------------------------

describe('spec overrides — dial the bat in from the headset browser', () => {
  test('known numeric keys are applied', () => {
    const o = paddleSpecOverridesFromQuery('?paddle.handleLength=0.115&other=1');
    expect(o).toEqual({ handleLength: 0.115 });
  });

  test('unknown keys and non-numbers are ignored, not passed through', () => {
    // A NaN here would propagate straight into the collision radius.
    expect(paddleSpecOverridesFromQuery('?paddle.nope=1')).toEqual({});
    expect(paddleSpecOverridesFromQuery('?paddle.handleLength=wide')).toEqual({});
    expect(paddleSpecOverridesFromQuery('')).toEqual({});
    expect(paddleSpecOverridesFromQuery(undefined)).toEqual({});
  });

  test('an override rebuilds the mesh AND the collision numbers together', () => {
    setPaddleSpec({ bladeHalfWidth: 0.070, bladeHalfLength: 0.070 });
    const m = measureLikeLoader(buildProceduralPaddle());
    expect(m.hitRadius).toBeCloseTo(0.070, 9);
    expect(derivePaddle().hitRadius).toBeCloseTo(0.070, 9);
    resetPaddleSpec();
  });
});
