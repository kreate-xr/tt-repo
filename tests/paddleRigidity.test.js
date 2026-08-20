// Paddle rigidity guarantees (asset + pose pipeline + contact timeline).
//
// The paddle must read as ONE rigid object: handle and face may never move
// relative to each other, the rendered pose and the physics contact pose must
// be the same sample, and a resolved contact must land on the face the player
// SEES at fire time (not a stale or extrapolated pose). Three layers:
//
//   1. Asset structure — Paddle.glb must stay a single mesh under a single
//      node with no animations/skins/scale. With one mesh, handle+face share
//      one world matrix by construction; a re-export that splits them into
//      separately-animatable nodes is the regression this catches.
//   2. Pose pipeline rigidity — composePoseWith (the T_cal composition every
//      rendered frame goes through) must be a rigid transform: pairwise
//      distances between paddle-fixed points (handle end, face sweet spot)
//      are preserved through arbitrary fast wrist-flick poses, and both
//      points derive from the SAME (gripPos, gripQuat) sample — zero
//      temporal offset between handle and face.
//   3. Contact–visual agreement — the swept-disc collision plus ball.js's
//      position correction must resolve the contact within 1 cm of the
//      CURRENT rendered face surface, even in a single-frame wrist flick
//      where the face moved several cm since the previous frame. The same
//      scenario shows the previous frame's face plane is >1 cm away, so a
//      regression that resolves contacts on a stale/extrapolated timeline
//      fails loudly.

const fs = require('fs');
const path = require('path');
const THREE = require('three');
const { detectDiscCollision } = require('../js/physics/collisions.js');
const { composePoseWith } = require('../js/xr/calibration.js');

const GLB_PATH = path.join(__dirname, '..', 'public', 'models', 'Paddle.glb');

function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  // 0x46546C67 = 'glTF'
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
}

// Decoded mesh vertices, in model space. Tests that check collision geometry
// against a formula can only ever be tautologies — the derivation and the
// assertion drift together. The mesh is the independent witness: it is what the
// player actually sees, and it is not derived from anything.
function readGlbPositions(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const bin = buf.subarray(20 + jsonLen + 8); // skip BIN chunk header
  const acc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  expect(acc.componentType).toBe(5126); // FLOAT — no other path implemented
  expect(acc.type).toBe('VEC3');
  const bv = gltf.bufferViews[acc.bufferView];
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const o = start + i * 12;
    out.push(new THREE.Vector3(
      bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8),
    ));
  }
  return out;
}

// models.js's axis convention, re-derived from the bbox the same way the loader
// does: thinnest extent = face normal, longest = handle→tip, middle = width.
function modelAxes(gltf) {
  const acc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  const ext = [0, 1, 2].map((i) => acc.max[i] - acc.min[i]);
  const order = [0, 1, 2].sort((a, b) => ext[a] - ext[b]);
  const name = ['x', 'y', 'z'];
  return {
    thin: name[order[0]], med: name[order[1]], long: name[order[2]],
    extent: { thin: ext[order[0]], med: ext[order[1]], long: ext[order[2]] },
  };
}

describe('asset structure — handle and face are one rigid mesh', () => {
  const gltf = readGlbJson(GLB_PATH);

  test('exactly one mesh-bearing node (one world matrix for the whole bat)', () => {
    const meshNodes = (gltf.nodes || []).filter((n) => n.mesh !== undefined);
    expect(meshNodes.length).toBe(1);
  });

  test('no animations or skins that could move parts independently', () => {
    expect(gltf.animations || []).toHaveLength(0);
    expect(gltf.skins || []).toHaveLength(0);
  });

  test('mesh node carries no scale (T_cal + anchor assume unit rigid body)', () => {
    const meshNode = gltf.nodes.find((n) => n.mesh !== undefined);
    if (meshNode.scale) {
      expect(meshNode.scale[0]).toBeCloseTo(1, 6);
      expect(meshNode.scale[1]).toBeCloseTo(1, 6);
      expect(meshNode.scale[2]).toBeCloseTo(1, 6);
    }
  });

  test('all geometry lives in ONE mesh — material slots may split primitives, nodes may not', () => {
    // Multiple primitives (e.g. a rubber/blade material split, which the
    // re-authored asset SHOULD have) are fine: primitives share their node's
    // world matrix. What must never appear is a second mesh — that's the
    // "separate handle object" regression this suite exists to block.
    expect((gltf.meshes || []).length).toBe(1);
    const mesh = gltf.meshes[gltf.nodes.find((n) => n.mesh !== undefined).mesh];
    expect(mesh.primitives.length).toBeGreaterThanOrEqual(1);
    // Every primitive must reference a real material — an unassigned slot
    // renders as default white plastic in three.js and would look broken.
    for (const prim of mesh.primitives) {
      expect(prim.material).toBeDefined();
      expect(gltf.materials[prim.material]).toBeDefined();
    }
  });
});

describe('pose pipeline rigidity — one pose sample, distances preserved', () => {
  // Paddle-fixed points, from the GLB's authored anchor empties (HandleEnd
  // and SweetSpot). If the pipeline ever scales/shears, or handle and face
  // stop sharing a sample, their separation changes.
  const handleLocal = new THREE.Vector3(0.000167, -0.08351, 0);
  const faceLocal = new THREE.Vector3(0, 0.10982, 0.00509);
  const restSeparation = handleLocal.distanceTo(faceLocal);

  // Non-trivial T_cal so the composition path is actually exercised.
  const posOffset = new THREE.Vector3(0.012, -0.008, -0.025);
  const rotOffset = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0.3, -0.15, 0.4),
  );

  test('fast wrist-flick pose stream keeps handle–face distance constant', () => {
    // Deterministic flick: 20 frames of large per-frame rotation (~30°/frame
    // ≈ 2700°/s at 90 Hz — beyond any human flick) plus translation.
    const outPos = new THREE.Vector3();
    const outQuat = new THREE.Quaternion();
    const handleWorld = new THREE.Vector3();
    const faceWorld = new THREE.Vector3();

    for (let i = 0; i < 20; i++) {
      const gripPos = new THREE.Vector3(
        0.2 * Math.sin(i * 0.7), 1.1 + 0.1 * Math.cos(i * 0.9), -0.3 + 0.05 * i,
      );
      const gripQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(i * 0.5, i * 0.33, i * 0.21),
      );

      // ONE sample composes the anchor pose; both points derive from it.
      composePoseWith(gripPos, gripQuat, posOffset, rotOffset, outPos, outQuat);
      handleWorld.copy(handleLocal).applyQuaternion(outQuat).add(outPos);
      faceWorld.copy(faceLocal).applyQuaternion(outQuat).add(outPos);

      expect(handleWorld.distanceTo(faceWorld)).toBeCloseTo(restSeparation, 9);
    }
  });
});

describe('wrist-roll pivot — face spins about the handle axis, no orbiting', () => {
  // Replicates the real controller-local layout: mesh rotated by PADDLE_EULER,
  // then T_cal posOffset applied on the anchor. The grip origin is the pivot.
  const PADDLE_EULER = new THREE.Euler(Math.PI / 2, Math.PI / 2, Math.PI, 'XYZ');
  const DEFAULT_POS_OFFSET = new THREE.Vector3(0, 0.005, -0.02); // presets.default
  const handleLocal = new THREE.Vector3(0.000167, -0.08351, 0);  // HandleEnd anchor
  const faceLocal = new THREE.Vector3(0, 0.10982, 0.00509);      // SweetSpot anchor

  const q = new THREE.Quaternion().setFromEuler(PADDLE_EULER);
  const toGrip = (v) => v.clone().applyQuaternion(q).add(DEFAULT_POS_OFFSET);
  const handleGrip = toGrip(handleLocal);
  const faceGrip = toGrip(faceLocal);
  const handleAxis = faceGrip.clone().sub(handleGrip).normalize();

  test('the grip pivot lies on the handle axis (wrong-pivot check)', () => {
    // Perpendicular distance from the pivot (grip origin) to the handle→face
    // line. If a future PADDLE_EULER or preset change moves the paddle off its
    // own axis, wrist roll starts orbiting the bat around the hand instead of
    // spinning it — the classic "not attached to me" artifact.
    const toPivot = handleGrip.clone().negate();
    const along = toPivot.dot(handleAxis);
    const perpDist = toPivot.clone()
      .sub(handleAxis.clone().multiplyScalar(along)).length();
    expect(perpDist).toBeLessThan(0.015);
    // Pivot must sit BETWEEN the handle end and the face, i.e. the hand is on
    // the handle — not beyond either end of the bat.
    expect(along).toBeGreaterThan(0);
    expect(along).toBeLessThan(faceGrip.distanceTo(handleGrip));
  });

  test('90° roll about the handle axis translates face and handle < 1 cm', () => {
    const roll = new THREE.Quaternion().setFromAxisAngle(handleAxis, Math.PI / 2);
    const faceTravel = faceGrip.clone().applyQuaternion(roll).distanceTo(faceGrip);
    const handleTravel = handleGrip.clone().applyQuaternion(roll).distanceTo(handleGrip);
    expect(faceTravel).toBeLessThan(0.01);
    expect(handleTravel).toBeLessThan(0.01);
  });
});

describe('contact–visual agreement — contact fires on the rendered face', () => {
  const BALL_R = 0.02;
  const HIT_RADIUS = 0.15;
  const DT = 1 / 90;
  // Position-correction epsilon from ball.js (ballRadius + 0.005).
  const CORRECTION_EPS = 0.005;

  // Single-frame wrist flick: face rotates 25° and translates ~9 cm between
  // prev and curr — the worst realistic one-frame pose delta. The ball drifts
  // slowly toward the player and the paddle sweeps through it.
  const prevCenter = new THREE.Vector3(0, 1.0, -0.3);
  const prevNormal = new THREE.Vector3(0, 0, 1);
  const flickRot = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(25),
  );
  const currNormal = prevNormal.clone().applyQuaternion(flickRot).normalize();
  const currCenter = prevCenter.clone().add(new THREE.Vector3(0.01, 0.005, 0.09));

  const prevBall = new THREE.Vector3(0, 1.0, -0.21);
  const currBall = prevBall.clone().add(new THREE.Vector3(0, 0, -0.02));

  test('resolved contact point lies within 1 cm of the CURRENT face surface', () => {
    const r = detectDiscCollision(
      prevBall, currBall, prevCenter, currCenter,
      prevNormal, currNormal, HIT_RADIUS, BALL_R, DT,
    );
    expect(r.crossed).toBe(true);
    expect(r.hit).toBe(true);

    // Reproduce ball.js's post-hit position correction, then take the point
    // on the ball surface facing the paddle — that's the resolved contact.
    const correctedBall = currCenter.clone()
      .add(r.onPlane)
      .addScaledVector(r.reflectNormal, BALL_R + CORRECTION_EPS);
    const contactPoint = correctedBall.clone()
      .addScaledVector(r.reflectNormal, -BALL_R);

    const distToRenderedFace = Math.abs(
      contactPoint.clone().sub(currCenter).dot(currNormal),
    );
    expect(distToRenderedFace).toBeLessThanOrEqual(0.01);

    // Contact is on the blade, not off the rim.
    expect(r.radialDist).toBeLessThan(HIT_RADIUS);
  });

  test('RADIAL agreement — the clean-face disc matches the visible blade edge', () => {
    // The ≤1 cm agreement bound applies radially too, not just perpendicular
    // to the face plane. models.js derives paddleHitRadius (the clean-face
    // radius) from the mesh bbox alone; this asserts it against the GLB's own
    // blade anchors, which is what the player sees.
    //
    // Two regressions are guarded here. First, an arbitrary floor (the old
    // Math.max(_, 0.09)) put the clean-face disc 15.2 mm outside the visible
    // blade, so balls that visually missed the rim resolved as pristine face
    // hits. Second, the procedural rubber lip that briefly lived in
    // paddleDetail.js was added to the mesh BEFORE this bbox was measured and
    // then added to the radius a second time — a 1 mm collar that this test
    // did not catch, because it reproduced the intended formula rather than
    // the one the loader ran. The derivation is now bbox-only on both sides,
    // so there is no second term to fall out of sync.
    const gltf = readGlbJson(GLB_PATH);
    const anchor = (name) => {
      const node = (gltf.nodes || []).find((n) => n.name === name);
      expect(node).toBeDefined();
      return new THREE.Vector3().fromArray(node.translation || [0, 0, 0]);
    };
    const left = anchor('EdgeLeft');
    const right = anchor('EdgeRight');
    const top = anchor('EdgeTop');
    const bottom = anchor('EdgeBottom');

    const bladeRx = (right.x - left.x) / 2;
    const bladeRy = (top.y - bottom.y) / 2;
    const visibleBladeEdge = Math.max(bladeRx, bladeRy);

    // Reproduce models.js's derivation from the mesh bbox.
    const posAcc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
    const sizes = [0, 1, 2].map((i) => posAcc.max[i] - posAcc.min[i]).sort((a, b) => a - b);
    const bladeHalfWidth = sizes[1] / 2; // medium axis = blade width
    const hitRadius = Math.max(bladeHalfWidth, 0.05);

    expect(Math.abs(hitRadius - visibleBladeEdge)).toBeLessThanOrEqual(0.01);
  });

  test('AXIAL agreement — the collision disc is CENTERED on the visible blade', () => {
    // The counterpart to the radial test above, and the one that was missing.
    // models.js used to place the disc center at `headEnd * 0.65` — an
    // unexplained constant against the bbox's far end — which put it 16.2 mm
    // toward the tip of where the blade actually is. The radius was audited
    // against these anchors; the center never was, so a disc of exactly the
    // right size sat in the wrong place and nothing failed.
    //
    // The two failure modes that produced, both >1 cm and so both outside the
    // contact-visual agreement budget:
    //   - throat: the bottom ~16 mm of visible rubber fell outside the
    //     clean-face disc and into detectDiscCollision's edge band, resolving
    //     through the wood-edge model — jittered normal, so a visually clean
    //     hit sprayed unpredictably.
    //   - tip: ~16 mm of air past the blade resolved as a pristine face hit.
    const gltf = readGlbJson(GLB_PATH);
    const anchor = (name) => {
      const node = (gltf.nodes || []).find((n) => n.name === name);
      expect(node).toBeDefined();
      return new THREE.Vector3().fromArray(node.translation || [0, 0, 0]);
    };
    const top = anchor('EdgeTop');
    const bottom = anchor('EdgeBottom');

    // Reproduce models.js: long axis = largest bbox extent, center = the
    // EdgeTop/EdgeBottom midpoint on it.
    const posAcc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
    const extents = [0, 1, 2].map((i) => posAcc.max[i] - posAcc.min[i]);
    const longIdx = extents.indexOf(Math.max(...extents));
    const axis = ['x', 'y', 'z'][longIdx];

    const discCenter = (top[axis] + bottom[axis]) / 2;
    const hitRadius = Math.max(
      Math.abs(anchor('EdgeRight').x - anchor('EdgeLeft').x) / 2,
      Math.abs(top[axis] - bottom[axis]) / 2,
      0.05,
    );

    // Judge the disc against the MESH, not against the anchors it was derived
    // from — otherwise this is a tautology that drifts with the formula (the
    // exact weakness the radial test above documents in its own comment).
    const verts = readGlbPositions(GLB_PATH);
    const { med } = modelAxes(readGlbJson(GLB_PATH));
    const maxHalfWidth = Math.max(...verts.map((v) => Math.abs(v[med])));

    // 1. AXIAL centering. The blade's own width profile is the witness: take
    //    the span of vertices that are out past half the max half-width (well
    //    clear of the handle's ~16 mm) and compare its midpoint to the disc
    //    center. This is what the 0.65 constant failed — it landed 20.4 mm off
    //    this midpoint, where the anchor-derived center lands 4.2 mm off.
    const wide = verts.filter((v) => Math.abs(v[med]) >= maxHalfWidth * 0.5);
    expect(wide.length).toBeGreaterThan(50);
    const wideVals = wide.map((v) => v[axis]);
    const bladeMid = (Math.min(...wideVals) + Math.max(...wideVals)) / 2;
    expect(Math.abs(discCenter - bladeMid)).toBeLessThanOrEqual(0.012);

    // 2. RADIAL coverage of the rim, bounded rather than zero — and the bound
    //    is a regression guard, NOT a statement that the residual is fine.
    //
    //    A disc cannot represent this blade. The outline is not an ellipse: it
    //    holds near-maximum width from y≈0.076 to 0.10 and flares wide low
    //    down, so the minimum circle that fully encloses it needs r≈81.3 mm
    //    against a blade half-extent of 74.7 mm. Every choice is a trade:
    //      - r = 74.7 at the anchor midpoint (shipped): axially exact, no
    //        phantom face anywhere, but up to 10.0 mm of rim rubber falls into
    //        detectDiscCollision's edge band and resolves as a wood strike.
    //      - r = 81.3 centered at 0.0869: covers all rubber, but hangs 11.7 mm
    //        past the blade bottom into the throat — phantom face over the
    //        handle, which is the failure the 0.09 floor was removed for.
    //    Shipped choice follows the standing policy in models.js: a disc LARGER
    //    than the visible rubber is the worse error. Removing the residual
    //    needs an elliptical collider, not a better constant.
    const rim = [];
    for (let y = Math.min(top[axis], bottom[axis]);
      y < Math.max(top[axis], bottom[axis]); y += 0.002) {
      const band = verts.filter((v) => v[axis] >= y && v[axis] < y + 0.002);
      if (!band.length) continue;
      rim.push([y + 0.001, Math.max(...band.map((v) => Math.abs(v[med])))]);
    }
    expect(rim.length).toBeGreaterThan(20);

    let worstOutside = 0;
    for (const [y, w] of rim) {
      worstOutside = Math.max(worstOutside, Math.hypot(y - discCenter, w) - hitRadius);
    }
    // 12 mm: current geometry sits at 10.0 mm, the old 0.65 center at 24.3 mm.
    expect(worstOutside).toBeLessThanOrEqual(0.012);

    // 3. No phantom face past the blade tip.
    const meshMax = Math.max(...verts.map((v) => v[axis]));
    expect((discCenter + hitRadius) - meshMax).toBeLessThanOrEqual(0.01);

    // And explicitly NOT the SweetSpot anchor: a sweet spot sits above
    // geometric center by design, so centering the collider there would
    // reproduce most of the error. Assert they are genuinely different, so
    // this test still bites if someone "simplifies" to SweetSpot later.
    const sweet = anchor('SweetSpot');
    expect(Math.abs(sweet[axis] - discCenter)).toBeGreaterThan(0.01);
  });

  test('every anchor models.js depends on is present (fail-loud contract)', () => {
    // models.js throws on a missing anchor rather than silently falling back to
    // a bbox guess. That is the right policy, but it turns a bad export into a
    // runtime failure — so catch it here instead.
    const gltf = readGlbJson(GLB_PATH);
    const names = (gltf.nodes || []).map((n) => n.name);
    // HandleEnd joined the required set when the derived handle_grip preset
    // landed (models.js reads it to place the fist on the handle).
    for (const required of ['EdgeTop', 'EdgeBottom', 'EdgeLeft', 'EdgeRight', 'HandleEnd']) {
      expect(names).toContain(required);
    }
  });

  test('blade half-thickness is measured on the blade, not the handle', () => {
    // The bbox thin axis spans the whole bat and the handle is its thickest
    // part, so `unrotatedSize[thinAxis] / 2` reported the HANDLE: 10.15 mm for
    // a 5.3 mm blade. It feeds the table-clamp safety margin, so the paddle
    // hovered ~5 mm high and the clamp fired earlier than intended.
    const gltf = readGlbJson(GLB_PATH);
    const { thin, long, extent } = modelAxes(gltf);
    const bboxHalf = extent.thin / 2;

    // Reproduce the loader's sampling: middle half of the blade along its own
    // axis, which excludes both the handle and the throat flare.
    const verts = readGlbPositions(GLB_PATH);
    const top = (gltf.nodes.find((n) => n.name === 'EdgeTop').translation || [0, 0, 0]);
    const bot = (gltf.nodes.find((n) => n.name === 'EdgeBottom').translation || [0, 0, 0]);
    const idx = { x: 0, y: 1, z: 2 }[long];
    const mid = (top[idx] + bot[idx]) / 2;
    const band = Math.abs(top[idx] - bot[idx]) / 2 * 0.5;
    const inBand = verts.filter((v) => Math.abs(v[long] - mid) <= band);
    expect(inBand.length).toBeGreaterThan(20);

    const vals = inBand.map((v) => v[thin]);
    const bladeHalf = (Math.max(...vals) - Math.min(...vals)) / 2;

    // The blade must be materially thinner than the whole-model bbox, or the
    // bbox was silently standing in for it. This is the regression: the bbox
    // reported the HANDLE (10.15 mm half) for a blade that is 5.3 mm.
    expect(bladeHalf).toBeLessThan(bboxHalf * 0.8);
    // Sane absolute range — checklist §2 puts a real blade with rubber at
    // 12–20 mm total. Guards a sampling band that accidentally selects nothing
    // or drifts onto the handle.
    expect(bladeHalf).toBeGreaterThan(0.002);
    expect(bladeHalf).toBeLessThan(0.011);
  });

  test('no procedural geometry is injected into the paddle at load', () => {
    // The collision disc is derived from the loaded scene's bounding box, so
    // ANY mesh added before that measurement silently becomes part of the
    // paddle's physical size. That is how the rubber-lip pass ended up owning
    // a term in paddleHitRadius. Keep the load path measurement-clean: if a
    // future pass needs to add geometry to the paddle, it has to be added
    // after the bbox step or deliberately accounted for here.
    //
    // Note this is about PATCHING a loaded asset, which is still banned.
    // Building one from a spec (scene/paddleGeometry.js, the default since the
    // procedural bat landed) is a different thing and is covered separately:
    // tests/paddleGeometry.test.js runs this exact derivation over the
    // procedural mesh and requires it to return the authored numbers, which is
    // the guarantee this test approximates for the GLB by forbidding additions.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../js/scene/models.js'), 'utf8',
    );
    expect(src).not.toMatch(/addPaddleJunctionDetail/);
    expect(src).not.toMatch(/from ['"].*paddleDetail/);
  });

  test('the same contact is >1 cm from the PREVIOUS face — a stale-pose regression would fail the test above', () => {
    const r = detectDiscCollision(
      prevBall, currBall, prevCenter, currCenter,
      prevNormal, currNormal, HIT_RADIUS, BALL_R, DT,
    );
    const correctedBall = currCenter.clone()
      .add(r.onPlane)
      .addScaledVector(r.reflectNormal, BALL_R + CORRECTION_EPS);
    const contactPoint = correctedBall.clone()
      .addScaledVector(r.reflectNormal, -BALL_R);

    const distToPrevFace = Math.abs(
      contactPoint.clone().sub(prevCenter).dot(prevNormal),
    );
    expect(distToPrevFace).toBeGreaterThan(0.01);
  });
});
