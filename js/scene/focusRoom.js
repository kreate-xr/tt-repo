// Procedural "Focus Room" — a distraction-free tournament practice hall
// built entirely in code: dark matte walls so the white ball keeps its
// silhouette, tournament-navy sport floor with a contrasting court border,
// surround barriers ringing the court, emissive ceiling light panels, and a
// back wall the existing scoreboard wall-mounts onto.
//
// Deliberately NOT an ARENA_VARIANTS entry in arena.js: that module is a
// GLB pipeline (GLTFLoader + DRACO, download caches, async ready) and stays
// tree-shaken out of the beta bundle. This builder is synchronous, weighs
// nothing on the wire, and returns the exact same handle shape as
// createArena() so every consumer (inGame.js factoryArgs, aiMatch.js,
// session-end cleanup) works unchanged.
//
// Lighting contract (see sceneSetup.js / arena.js): every mesh here ALSO
// enables ARENA_LIGHT_LAYER while KEEPING layer 0 — mesh-layer isolation is
// unreliable under the WebXR ArrayCamera, and the bright arena rig lives on
// layer 3 so it can never touch gameplay meshes. No lights are added here
// at all; the "luminaires" are unlit meshes, same trick as the stadium's
// fixtures (real SpotLights tanked Quest frame rate and strobed the ball's
// specular — arenaLighting.js header).

import * as THREE from 'three';
import { scene, ARENA_LIGHT_LAYER } from './sceneSetup.js';
import { tableBox } from './models.js';
import {
  ROOM, COURT, BARRIER, BARRIER_LOGO, LIGHT_PANELS, computeFocusRoomLayout,
} from './focusRoomSpec.js';
import { loadBrandLogoTexture } from './brandLogo.js';

export function createFocusRoom() {
  if (!tableBox) {
    console.warn('[focusRoom] tableBox not ready — call after loadModels()');
    return null;
  }

  const layout = computeFocusRoomLayout(tableBox);
  const { center } = layout;

  const group = new THREE.Group();
  group.name = 'FocusRoom';
  group.visible = false;
  // Read by the async branding load below — the room can be disposed while
  // the logo asset is still in flight (leave the venue during the first
  // session on a cold cache) and the callback must not resurrect it.
  let disposed = false;

  // Adds a mesh with the ArrayCamera-safe layer setup: enable() keeps
  // bit 0 (camera render) while adding bit 3 (arena light rig).
  function track(mesh) {
    mesh.layers.enable(ARENA_LIGHT_LAYER);
    group.add(mesh);
    return mesh;
  }

  // --- Wall shell: interior of an inverted box. BackSide flips normals in
  // the shader, so the interior faces light correctly under the layer-3
  // hemisphere/ambient fill.
  const wallMat = new THREE.MeshStandardMaterial({
    color: ROOM.WALL_COLOR, roughness: ROOM.WALL_ROUGHNESS, metalness: 0,
    side: THREE.BackSide,
  });
  const shell = track(new THREE.Mesh(
    new THREE.BoxGeometry(ROOM.WIDTH_X, ROOM.HEIGHT_Y, ROOM.LENGTH_Z), wallMat));
  shell.position.set(center.x, ROOM.HEIGHT_Y / 2, center.z);

  // --- Floor plane, 2 mm above the shell's bottom face. The physical
  // offset alone is NOT enough: two horizontal surfaces millimeters apart
  // viewed at grazing angle from meters away land in depth-buffer noise and
  // shimmer. polygonOffset biases the floor toward the camera in depth
  // only, so the decal stack (shell face < floor < court border) resolves
  // stably while the visual floor stays at y≈0 — it must, because the
  // physics ball bounces at y=0 and a raised floor would swallow it.
  const floorMat = new THREE.MeshStandardMaterial({
    color: ROOM.FLOOR_COLOR, roughness: ROOM.FLOOR_ROUGHNESS, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const floor = track(new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.WIDTH_X, ROOM.LENGTH_Z), floorMat));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(center.x, 0.002, center.z);

  // --- Ceiling plane, 1 cm below the shell top, slightly lighter than the
  // walls so "up" reads distinct without drawing the eye.
  const ceilMat = new THREE.MeshStandardMaterial({
    color: ROOM.CEILING_COLOR, roughness: ROOM.WALL_ROUGHNESS, metalness: 0,
  });
  const ceiling = track(new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.WIDTH_X, ROOM.LENGTH_Z), ceilMat));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(center.x, ROOM.HEIGHT_Y - 0.01, center.z);

  // --- Court border: a flat contrasting band ringing the court rectangle
  // (rect-with-hole ShapeGeometry — one draw call, core three only). The
  // shape is symmetric about its center, so laying it flat needs no flip
  // handling.
  const ox = COURT.HALF_X + COURT.BORDER_W;
  const oz = COURT.HALF_Z + COURT.BORDER_W;
  const borderShape = new THREE.Shape();
  borderShape.moveTo(-ox, -oz);
  borderShape.lineTo(ox, -oz);
  borderShape.lineTo(ox, oz);
  borderShape.lineTo(-ox, oz);
  borderShape.closePath();
  const borderHole = new THREE.Path();
  borderHole.moveTo(-COURT.HALF_X, -COURT.HALF_Z);
  borderHole.lineTo(COURT.HALF_X, -COURT.HALF_Z);
  borderHole.lineTo(COURT.HALF_X, COURT.HALF_Z);
  borderHole.lineTo(-COURT.HALF_X, COURT.HALF_Z);
  borderHole.closePath();
  borderShape.holes.push(borderHole);
  // One step further toward the camera than the floor (see floorMat) so
  // the border band never shimmers against it at grazing angles.
  const borderMat = new THREE.MeshStandardMaterial({
    color: ROOM.ACCENT_COLOR, roughness: ROOM.FLOOR_ROUGHNESS, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const border = track(new THREE.Mesh(new THREE.ShapeGeometry(borderShape), borderMat));
  border.rotation.x = -Math.PI / 2;
  border.position.set(center.x, 0.006, center.z);

  // --- Surround barriers: one InstancedMesh for the panels, one for the
  // pale top stripe that makes them read at a glance in peripheral vision.
  const segs = layout.barrierSegments;
  const barrierMat = new THREE.MeshStandardMaterial({
    color: BARRIER.COLOR, roughness: 0.9, metalness: 0,
  });
  const barriers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(BARRIER.SEG_W, BARRIER.HEIGHT, BARRIER.THICK),
    barrierMat, segs.length);
  const stripeMat = new THREE.MeshStandardMaterial({
    color: BARRIER.STRIPE_COLOR, roughness: 0.8, metalness: 0,
  });
  // Cap geometry: wider, deeper, AND lipped above the panel (see
  // BARRIER.STRIPE_* in focusRoomSpec.js) so no stripe face is ever
  // coplanar with a panel face — coplanar top/end faces z-fight into a
  // glittery shimmer on the barrier line at distance.
  const stripes = new THREE.InstancedMesh(
    new THREE.BoxGeometry(
      BARRIER.SEG_W + BARRIER.STRIPE_END,
      BARRIER.STRIPE_H,
      BARRIER.THICK + BARRIER.STRIPE_WRAP),
    stripeMat, segs.length);
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  segs.forEach((seg, i) => {
    _q.setFromEuler(_e.set(0, seg.rotY, 0));
    _m.compose(_p.set(seg.x, BARRIER.HEIGHT / 2, seg.z), _q, _s);
    barriers.setMatrixAt(i, _m);
    _m.compose(
      _p.set(seg.x, BARRIER.HEIGHT - BARRIER.STRIPE_H / 2 + BARRIER.STRIPE_LIP, seg.z),
      _q, _s);
    stripes.setMatrixAt(i, _m);
  });
  track(barriers);
  track(stripes);

  // --- Venue branding: the SportyXR mark printed on the court-facing face
  // of every barrier panel — where a real tournament puts its title
  // sponsor. One InstancedMesh of unit quads sharing one alpha-cutout
  // texture, so the whole ring is a single draw call.
  //
  // The quads are built now but sized later: the mark's aspect ratio is a
  // measured property of the trimmed asset (brandLogo.js) and is not
  // knowable until it decodes. So they start hidden with identity
  // matrices, and the load callback composes the real transforms. The room
  // itself never waits — `ready` stays resolved and the venue is complete
  // and playable with or without the mark.
  const logoSlots = layout.barrierLogos;
  const logoMat = new THREE.MeshStandardMaterial({
    roughness: 0.9, metalness: 0,
    transparent: true,
    // alphaTest drops the fully-clear background before the depth test, so
    // a decal quad never occludes what is behind it. The transparent path
    // is kept on top of that purely so the ink EDGES stay smooth — a pure
    // cutout goes crunchy on lettering this thin at this distance.
    alphaTest: 0.05,
    // A print sits ON the panel, not in front of it. Same decal-stack
    // reasoning as the floor/court-border pair above: the 6 mm physical
    // gap alone lands in depth-buffer noise when the barrier line is
    // viewed edge-on from the serve position.
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const logoMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1), logoMat, logoSlots.length);
  logoMesh.visible = false;
  track(logoMesh);

  let logoTexture = null;
  loadBrandLogoTexture().then((logo) => {
    if (!logo) return;
    if (disposed) { logo.texture.dispose(); return; }
    logoTexture = logo.texture;
    logoMat.map = logoTexture;
    logoMat.needsUpdate = true;

    // Fit to WIDTH, but if that overflows the height ceiling, back the
    // width off too — scaling one axis alone would squash the wordmark.
    let w = BARRIER_LOGO.WIDTH;
    let h = w / logo.aspect;
    if (h > BARRIER_LOGO.MAX_HEIGHT) {
      h = BARRIER_LOGO.MAX_HEIGHT;
      w = h * logo.aspect;
    }

    const lm = new THREE.Matrix4();
    const lq = new THREE.Quaternion();
    const le = new THREE.Euler();
    const lp = new THREE.Vector3();
    const ls = new THREE.Vector3(w, h, 1);
    logoSlots.forEach((slot, i) => {
      lq.setFromEuler(le.set(0, slot.rotY, 0));
      lm.compose(lp.set(slot.x, slot.y, slot.z), lq, ls);
      logoMesh.setMatrixAt(i, lm);
    });
    logoMesh.instanceMatrix.needsUpdate = true;
    // Instance matrices do not invalidate the bounding sphere. Without
    // this the sphere stays the one implied by the identity matrices the
    // quads were built with — a speck at the origin — and the whole ring
    // gets frustum-culled the moment you look at a barrier.
    logoMesh.computeBoundingSphere();
    logoMesh.visible = true;
    console.log(`[focusRoom] branding: mark on ${logoSlots.length} barrier panels`);
  });

  // --- Wall accent stripe: one thin band per wall at a constant height —
  // a quiet horizon line that keeps the dark walls from reading as a void.
  // Axis-aligned, so per-instance non-uniform scale does the work.
  const accentMat = new THREE.MeshStandardMaterial({
    color: ROOM.ACCENT_COLOR, roughness: 0.85, metalness: 0,
  });
  const accent = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), accentMat, 4);
  const halfW = ROOM.WIDTH_X / 2;
  const stripeWalls = [
    { x: center.x, z: layout.backWallInnerZ + 0.01, sx: ROOM.WIDTH_X - 0.04, sz: 0.012 },
    { x: center.x, z: layout.frontWallInnerZ - 0.01, sx: ROOM.WIDTH_X - 0.04, sz: 0.012 },
    { x: center.x - halfW + 0.01, z: center.z, sx: 0.012, sz: ROOM.LENGTH_Z - 0.04 },
    { x: center.x + halfW - 0.01, z: center.z, sx: 0.012, sz: ROOM.LENGTH_Z - 0.04 },
  ];
  _q.identity();
  stripeWalls.forEach((w, i) => {
    _m.compose(
      _p.set(w.x, ROOM.ACCENT_STRIPE_Y, w.z),
      _q,
      _s.set(w.sx, ROOM.ACCENT_STRIPE_H, w.sz));
    accent.setMatrixAt(i, _m);
  });
  _s.set(1, 1, 1);
  track(accent);

  // --- Ceiling light panels. Unlit (MeshBasicMaterial) so they read as
  // self-illuminating at zero lighting cost. Named after arenaLighting.js
  // FIXTURE_NAMES so its celebration pulses (pulsePoint on CenterLightBox,
  // pulseMatchPoint on CeilingRing) resolve with no changes there. Each
  // fixture gets its OWN material — the two must pulse independently.
  const panelGeo = new THREE.BoxGeometry(LIGHT_PANELS.W, LIGHT_PANELS.THICK, LIGHT_PANELS.D);
  const centerPanel = track(new THREE.Mesh(
    panelGeo, new THREE.MeshBasicMaterial({ color: LIGHT_PANELS.COLOR })));
  centerPanel.name = 'CenterLightBox';
  centerPanel.position.set(center.x, layout.panelY, center.z);
  const ringSlots = layout.panelSlots.filter((p) => !p.isCenter);
  const ring = new THREE.InstancedMesh(
    panelGeo, new THREE.MeshBasicMaterial({ color: LIGHT_PANELS.COLOR }), ringSlots.length);
  ring.name = 'CeilingRing';
  _q.identity();
  ringSlots.forEach((slot, i) => {
    _m.compose(_p.set(slot.x, layout.panelY, slot.z), _q, _s);
    ring.setMatrixAt(i, _m);
  });
  track(ring);

  const fixtures = [
    { name: 'CenterLightBox', mesh: centerPanel },
    { name: 'CeilingRing', mesh: ring },
  ];

  scene.add(group);
  console.log(`[focusRoom] built — ${segs.length} barrier segments, ${ringSlots.length + 1} light panels, back wall z=${layout.backWallInnerZ.toFixed(2)}`);

  function show() { group.visible = true; }
  function hide() { group.visible = false; }

  // Unlike arena.js (whose geometry/materials live in a cross-session GLB
  // cache), everything here is owned by this instance — dispose it all.
  // Rebuilding next session is sub-millisecond.
  function dispose() {
    disposed = true;
    scene.remove(group);
    group.traverse((obj) => {
      if (obj.isInstancedMesh) obj.dispose();
      if (obj.isMesh) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      }
    });
    // Material.dispose() does not release its maps, and this texture is
    // owned by this room — brandLogo.js caches the decoded canvas but
    // hands every caller its own CanvasTexture for exactly this reason.
    if (logoTexture) logoTexture.dispose();
  }

  return {
    show,
    hide,
    dispose,
    group,
    ready: Promise.resolve(),
    getBackWallAnchor() { return layout.backWallAnchor; },
    getStadiumScreens() { return []; },
    getCrowdAnchors() { return []; },
    getStadiumFixtures() { return fixtures; },
    getBrandingBoards() { return []; },
  };
}
