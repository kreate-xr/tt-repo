// Procedural "Focus Room" — a distraction-free tournament practice hall
// built entirely in code: dark matte walls so the white ball keeps its
// silhouette, tournament-navy sport floor with a contrasting court border,
// emissive ceiling light panels, and a back wall the existing scoreboard
// wall-mounts onto.
//
// The court used to be ringed by ITTF surround barriers carrying the SportyXR
// mark on every panel. They were purely decorative — nothing in physics ever
// referenced them — and 14 copies of one wordmark at 1.4 m intervals read as
// tiling, so the ring is gone and the mark moved to the end walls. The floor's
// navy court border is now what marks the court.
//
// Deliberately NOT an ARENA_VARIANTS entry in arena.js: that module is a
// GLB pipeline (GLTFLoader + DRACO, download caches, async ready) and stays
// tree-shaken out of the beta bundle. This builder is synchronous, weighs
// nothing on the wire, and returns the exact same handle shape as
// createArena() so every consumer (inGame.js factoryArgs, aiMatch.js,
// session-end cleanup) works unchanged.
//
// Lighting contract. No lights are added here at all, and none can be:
// three.js has no per-mesh light masking. In WebGLRenderer the only layer
// test involving a light is `object.layers.test(camera.layers)` in
// projectObject() — a light either joins the frame's single global light
// state or is dropped entirely; it is never filtered per mesh. So a light
// added for this room would also light the ball, paddle and table, and the
// old "arena rig on layer 3" was not isolation — the camera never enabled
// layer 3, so those six lights were silently dropped every frame and the
// room was lit by hemiLight alone.
//
// This room therefore lights itself: every material sets `emissive` to its
// own color at ROOM.SELF_LIT intensity, which is an ambient term scoped to
// these materials and unreachable by gameplay meshes. On top of that the
// meshes still keep ARENA_LIGHT_LAYER enabled alongside layer 0 (arena.js
// marks venue geometry the same way, and tests assert it).
//
// Screen values this produces, under hemiLight @2.2 + NeutralToneMapping.
// A surface's value depends on which way it FACES: the hemisphere gives an
// up-facing plane its full sky term, a horizontal wall the half mix, and a
// down-facing plane only the dark ground term. So the ceiling and the floor
// are NOT comparable by albedo — only by what they land on:
//   walls          rgb(0,0,0)       luma   0   (horizontal, true void)
//   ceiling        rgb(73,79,95)    luma  79   (down-facing)
//   floor base     rgb(135,143,156) luma 142   (up-facing; wood map ~luma 135)
//   wall stripe    rgb(70,122,205)  luma 117   court border rgb(76,131,217)
//   cornice soffit rgb(62,114,191)  luma 109
//   recess reveal  rgb(126,123,118) luma 123
//   light panels   rgb(229,232,240) luma 232   (unlit, the cap is ~251)
// The ladder that matters overhead: panels 232 over a ceiling at 79, with the
// reveal at 123 between them, so a fixture reads as lamp / reflector / dark
// ceiling. The ball is seen against that 79, which is the point of it.
// Barriers were listed here once; the court surround is gone and the floor
// border band is all that marks the court now.
//
// The "luminaires" stay unlit meshes, same trick as the stadium's fixtures
// (real SpotLights tanked Quest frame rate and strobed the ball's specular
// — arenaLighting.js header).

import * as THREE from 'three';
import { scene, ARENA_LIGHT_LAYER } from './sceneSetup.js';
import { tableBox } from './models.js';
import {
  ROOM, COURT, LIGHT_PANELS, SIDE_WALL_ART, WALL_MARK,
  computeFocusRoomLayout,
} from './focusRoomSpec.js';
import { loadBrandLogoTexture } from './brandLogo.js';
import { createWoodFloorTexture } from './woodFloor.js';
import { createWallPanelTexture } from './wallPanels.js';
import { loadSideWallArt } from './sideWallArt.js';

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
  // the shader, so the interior faces light correctly under the hemisphere
  // fill.
  //
  // The walls are black — they are the ground the side-wall graphic is
  // printed on. wallPanels.js paints the wood's floor bounce back over the
  // bottom of them so the floor does not appear to end in midair. Null with
  // no canvas, and then the plain black shell stands.
  const wallTexture = createWallPanelTexture();
  const wallTone = wallTexture ? 0xffffff : ROOM.WALL_COLOR;
  const wallMat = new THREE.MeshStandardMaterial({
    color: wallTone, roughness: ROOM.WALL_ROUGHNESS, metalness: 0,
    side: THREE.BackSide,
    emissive: wallTone, emissiveIntensity: ROOM.SELF_LIT,
    map: wallTexture, emissiveMap: wallTexture,
  });
  // No per-face UV work: the wall texture is a vertical gradient with no
  // horizontal structure, so every face sampling its own 0..1 square lands on
  // the same column whatever that wall's length.
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
  //
  // Wood boards (woodFloor.js). The texture carries the whole look, so
  // color/emissive drop to white and let it through unmultiplied — the
  // board tones in WOOD are already albedos on the same footing as
  // ROOM.WALL_COLOR. `map` and `emissiveMap` are the SAME texture for the
  // same reason the brand mark uses both: emissive is what lifts this room
  // out of the near-black it was rendering in, and a flat emissive color
  // under a textured albedo would wash the grain straight back out.
  // Returns null with no canvas (jest's node environment, or a page that
  // has run out of 2D contexts) — then the flat FLOOR_COLOR floor stands.
  const woodTexture = createWoodFloorTexture(ROOM.WIDTH_X, ROOM.LENGTH_Z);
  const floorTone = woodTexture ? 0xffffff : ROOM.FLOOR_COLOR;
  const floorMat = new THREE.MeshStandardMaterial({
    color: floorTone, roughness: ROOM.FLOOR_ROUGHNESS, metalness: 0,
    emissive: floorTone, emissiveIntensity: ROOM.SELF_LIT,
    map: woodTexture, emissiveMap: woodTexture,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const floor = track(new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.WIDTH_X, ROOM.LENGTH_Z), floorMat));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(center.x, 0.002, center.z);

  // --- Ceiling plane, 1 cm below the shell top, slightly lighter than the
  // walls so "up" reads distinct without drawing the eye.
  // The ceiling plane faces down, so the hemisphere gives it only its dark
  // ground term — without the self-lit term it renders pure black.
  const ceilMat = new THREE.MeshStandardMaterial({
    color: ROOM.CEILING_COLOR, roughness: ROOM.WALL_ROUGHNESS, metalness: 0,
    emissive: ROOM.CEILING_COLOR, emissiveIntensity: ROOM.SELF_LIT,
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
    emissive: ROOM.ACCENT_COLOR, emissiveIntensity: ROOM.SELF_LIT,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const border = track(new THREE.Mesh(new THREE.ShapeGeometry(borderShape), borderMat));
  border.rotation.x = -Math.PI / 2;
  border.position.set(center.x, 0.006, center.z);

  // Scratch objects reused by every InstancedMesh below — composing matrices
  // in place keeps room construction allocation-free.
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);

  // --- Venue branding: the SportyXR mark on the two END walls — the back
  // wall behind the AI and the front wall behind the player.
  //
  // It used to be printed on the court-surround barriers, one mark per panel.
  // With 14 panels ringing the court that was the same wordmark repeated at
  // 1.4 m intervals, which reads as tiling rather than as branding; the
  // barriers themselves are gone now (see the room header) and the mark moved
  // to where a venue actually puts its name.
  //
  // Async, and the room never waits on it: `ready` stays resolved and the
  // venue is complete and playable with or without the mark. The load can
  // land after the player has left, hence the `disposed` check.
  let logoTexture = null;
  loadBrandLogoTexture().then((logo) => {
    if (!logo) return;
    if (disposed) { logo.texture.dispose(); return; }
    logoTexture = logo.texture;

    // Fit to WIDTH, but if that overflows the height ceiling, back the width
    // off too — scaling one axis alone would squash the wordmark.
    let w = WALL_MARK.WIDTH_M;
    let h = w / logo.aspect;
    if (h > WALL_MARK.MAX_HEIGHT_M) {
      h = WALL_MARK.MAX_HEIGHT_M;
      w = h * logo.aspect;
    }

    const markMat = new THREE.MeshStandardMaterial({
      map: logoTexture, emissiveMap: logoTexture,
      // The mark is white ink on transparent (brandLogo.js recolors it), so
      // TONE is what stops it burning out against a black wall; the same
      // value on emissive keeps it on the room's self-lit footing.
      color: WALL_MARK.TONE, emissive: WALL_MARK.TONE,
      emissiveIntensity: ROOM.SELF_LIT,
      roughness: 0.9, metalness: 0,
      // Ink, not a soft glow — unlike the side-wall art this WANTS a cutout,
      // so the transparent surround never occludes what is behind it. The
      // transparent path on top of it keeps the letter edges smooth.
      transparent: true, alphaTest: 0.05,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const markGeo = new THREE.PlaneGeometry(w, h);

    // Back wall (-Z, behind the AI). A PlaneGeometry already faces +Z, which
    // is into the room from here, so it needs no rotation. Sits ABOVE the
    // scoreboard, which wall-mounts on this same wall.
    const back = track(new THREE.Mesh(markGeo, markMat));
    back.position.set(center.x, WALL_MARK.BACK_Y, layout.backWallInnerZ + WALL_MARK.OFFSET);

    // Front wall (+Z, behind the player). Turned to face -Z, into the room.
    const front = track(new THREE.Mesh(markGeo, markMat));
    front.position.set(center.x, WALL_MARK.FRONT_Y, layout.frontWallInnerZ - WALL_MARK.OFFSET);
    front.rotation.y = Math.PI;

    console.log(`[focusRoom] branding: ${w.toFixed(2)}x${h.toFixed(2)} m mark on the front and back walls`);
  });

  // --- Side-wall graphics: the player poster on the LEFT wall (-X) and the
  // FOCUS / PRACTICE / IMPROVE / REPEAT piece on the RIGHT (+X). The player
  // faces -Z, so forward x up puts their right toward +X.
  //
  // Async like the barrier mark, and for the same reason: the room is
  // complete and playable with or without them, `ready` never waits, and a
  // load can land after the player has already left the venue — hence the
  // `disposed` check before anything is added to a group that may be gone.
  const artTextures = [];
  for (const wall of SIDE_WALL_ART.WALLS) {
    loadSideWallArt(wall.URL).then((art) => {
      if (!art) return;
      if (disposed) { art.texture.dispose(); return; }
      artTextures.push(art.texture);

      const w = wall.WIDTH_M;
      // From the asset's MEASURED aspect — swapping in art of a different
      // shape must resize the quad, never stretch the picture.
      const h = w / art.aspect;
      const artMat = new THREE.MeshStandardMaterial({
        map: art.texture, emissiveMap: art.texture,
        // TONE scales the art down so it reads as a lit print instead of a
        // light source; the SAME value on emissive keeps it on the room's
        // self-lit footing (see the floor for why both maps are one texture).
        color: SIDE_WALL_ART.TONE, emissive: SIDE_WALL_ART.TONE,
        emissiveIntensity: ROOM.SELF_LIT,
        roughness: 0.9, metalness: 0,
        // Straight alpha blending, and deliberately NO alphaTest: both assets
        // are feathered to zero alpha at their edges so they melt into the
        // black wall, and any cutout threshold would slice that glow back
        // into a hard rectangle. depthWrite off is the usual companion — the
        // quad writes no depth, so it cannot fight the wall behind it, and
        // the 2 cm standoff keeps the depth TEST unambiguous.
        transparent: true, depthWrite: false,
      });

      // A PlaneGeometry faces +Z. +90 deg about Y sends that to +X, the
      // inward normal of the LEFT (-X) wall; -90 deg to -X for the RIGHT.
      const isLeft = wall.side === 'left';
      const panel = track(new THREE.Mesh(new THREE.PlaneGeometry(w, h), artMat));
      panel.position.set(
        center.x + (isLeft ? -1 : 1) * (ROOM.WIDTH_X / 2 - SIDE_WALL_ART.OFFSET),
        wall.CENTER_Y,
        center.z);
      panel.rotation.y = isLeft ? Math.PI / 2 : -Math.PI / 2;
      console.log(`[focusRoom] ${wall.side}-wall graphic: ${w.toFixed(2)}x${h.toFixed(2)} m`);
    });
  }

  // --- Wall accent stripe: one thin band per wall at a constant height —
  // a quiet horizon line that keeps the dark walls from reading as a void.
  // Axis-aligned, so per-instance non-uniform scale does the work.
  const accentMat = new THREE.MeshStandardMaterial({
    color: ROOM.ACCENT_COLOR, roughness: 0.85, metalness: 0,
    emissive: ROOM.ACCENT_COLOR, emissiveIntensity: ROOM.SELF_LIT,
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

  // --- Edge trim: four vertical corner posts and a cornice band per wall.
  //
  // These are the room's only edges. See ROOM.TRIM_COLOR for why a black
  // room needs them: with no shading of its own, nothing marks where one
  // wall stops and the next starts, and the venue reads as a black
  // rectangle rather than a space with corners and a far end.
  //
  // A second InstancedMesh rather than more instances on `accent`, because
  // InstancedMesh's per-instance color multiplies `color` but NOT `emissive`
  // — and emissive is what lights every surface in this room — so two
  // self-lit colors genuinely need two materials.
  const trimMat = new THREE.MeshStandardMaterial({
    color: ROOM.TRIM_COLOR, roughness: 0.85, metalness: 0,
    emissive: ROOM.TRIM_COLOR, emissiveIntensity: ROOM.SELF_LIT,
  });
  const trim = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), trimMat, 8);
  // Stood off both wall faces it meets, so no face is ever coplanar with a
  // wall — the same z-fight reasoning as the barrier stripe cap.
  const trimInset = ROOM.TRIM_W / 2 + 0.004;
  // Tucked under the ceiling plane (which sits 1 cm below the shell top).
  const corniceY = ROOM.HEIGHT_Y - 0.02 - ROOM.CORNICE_H / 2;
  const zBack = layout.backWallInnerZ + trimInset;
  const zFront = layout.frontWallInnerZ - trimInset;
  const xLeft = center.x - halfW + trimInset;
  const xRight = center.x + halfW - trimInset;
  const trimParts = [
    // Corner posts, floor to ceiling. They run the full height and let the
    // floor and ceiling planes clip them, so both ends read as a junction.
    { x: xLeft, y: ROOM.HEIGHT_Y / 2, z: zBack, sx: ROOM.TRIM_W, sy: ROOM.HEIGHT_Y, sz: ROOM.TRIM_W },
    { x: xRight, y: ROOM.HEIGHT_Y / 2, z: zBack, sx: ROOM.TRIM_W, sy: ROOM.HEIGHT_Y, sz: ROOM.TRIM_W },
    { x: xLeft, y: ROOM.HEIGHT_Y / 2, z: zFront, sx: ROOM.TRIM_W, sy: ROOM.HEIGHT_Y, sz: ROOM.TRIM_W },
    { x: xRight, y: ROOM.HEIGHT_Y / 2, z: zFront, sx: ROOM.TRIM_W, sy: ROOM.HEIGHT_Y, sz: ROOM.TRIM_W },
    // Cornice, one band per wall.
    { x: center.x, y: corniceY, z: zBack, sx: ROOM.WIDTH_X - 0.04, sy: ROOM.CORNICE_H, sz: 0.014 },
    { x: center.x, y: corniceY, z: zFront, sx: ROOM.WIDTH_X - 0.04, sy: ROOM.CORNICE_H, sz: 0.014 },
    { x: xLeft, y: corniceY, z: center.z, sx: 0.014, sy: ROOM.CORNICE_H, sz: ROOM.LENGTH_Z - 0.04 },
    { x: xRight, y: corniceY, z: center.z, sx: 0.014, sy: ROOM.CORNICE_H, sz: ROOM.LENGTH_Z - 0.04 },
  ];
  _q.identity();
  trimParts.forEach((t, i) => {
    _m.compose(_p.set(t.x, t.y, t.z), _q, _s.set(t.sx, t.sy, t.sz));
    trim.setMatrixAt(i, _m);
  });
  _s.set(1, 1, 1);
  track(trim);

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

  // --- Recess reveals: a mid-value frame tucked in the gap between each
  // panel and the ceiling, giving every fixture the lamp / reflector / dark
  // ceiling falloff a recessed troffer actually has (see
  // LIGHT_PANELS.REVEAL_COLOR). Deliberately NOT part of `fixtures` —
  // arenaLighting pulses those on celebrations, and a reflector that pulsed
  // in lockstep with the lamp inside it would read as one flat slab.
  const revealGeo = new THREE.BoxGeometry(
    LIGHT_PANELS.W + 2 * LIGHT_PANELS.REVEAL_MARGIN,
    LIGHT_PANELS.REVEAL_THICK,
    LIGHT_PANELS.D + 2 * LIGHT_PANELS.REVEAL_MARGIN);
  const revealMat = new THREE.MeshStandardMaterial({
    color: LIGHT_PANELS.REVEAL_COLOR, roughness: 0.9, metalness: 0,
    emissive: LIGHT_PANELS.REVEAL_COLOR, emissiveIntensity: ROOM.SELF_LIT,
  });
  const reveals = new THREE.InstancedMesh(
    revealGeo, revealMat, layout.panelSlots.length);
  // Slung just under the ceiling plane, clear of BOTH it and the panel tops —
  // a face coplanar with either would z-fight into a shimmer overhead.
  const revealY = ROOM.HEIGHT_Y - 0.01 - 0.002 - LIGHT_PANELS.REVEAL_THICK / 2;
  _q.identity();
  layout.panelSlots.forEach((slot, i) => {
    _m.compose(_p.set(slot.x, revealY, slot.z), _q, _s);
    reveals.setMatrixAt(i, _m);
  });
  track(reveals);

  const fixtures = [
    { name: 'CenterLightBox', mesh: centerPanel },
    { name: 'CeilingRing', mesh: ring },
  ];

  scene.add(group);
  console.log(`[focusRoom] built — ${ringSlots.length + 1} light panels, back wall z=${layout.backWallInnerZ.toFixed(2)}`);

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
    // Material.dispose() does not release its maps, and these textures are
    // owned by this room — brandLogo.js and woodFloor.js both cache the
    // painted canvas but hand every caller its own CanvasTexture for
    // exactly this reason.
    if (logoTexture) logoTexture.dispose();
    if (woodTexture) woodTexture.dispose();
    if (wallTexture) wallTexture.dispose();
    for (const tex of artTextures) tex.dispose();
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
