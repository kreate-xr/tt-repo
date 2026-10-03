// Passthrough backdrop — one flat screen behind the far end of the table,
// in the Focus Room's finish, for players whose real room is busier than
// they want to look at (tester, 2026-09: "a screen like in Eleven Table
// Tennis to cover up the background for those who play against a wall with
// decor"). See mrBackdropSpec.js for what it is and why it stands where it
// does.
//
// Built the way focusRoom.js builds its walls, with the same materials and
// the same self-lit contract (ROOM.SELF_LIT — the emissive term is what lets
// the finish read under whatever the passthrough light estimate lands on),
// so it looks like a piece of that venue and not a new one. Deliberately
// NOT a Focus Room with the floor and ceiling switched off: the player is
// in their own room and should stay there; only the view past the far end
// is replaced.
//
// Optional and toggled live from the wrist menu (the profile setting
// `mrBackdrop`), so the handle keeps show/hide cheap: visibility only, the
// meshes stay built for the session. Passthrough only — the Focus Room has
// its own back wall and inGame.js never builds this there.

import * as THREE from 'three';
import { scene, ARENA_LIGHT_LAYER } from './sceneSetup.js';
import { tableBox } from './models.js';
import { ROOM, WALL_MARK } from './focusRoomSpec.js';
import { BACKDROP, computeMRBackdropLayout } from './mrBackdropSpec.js';
import { loadBrandLogoTexture } from './brandLogo.js';
import { createWallPanelTexture } from './wallPanels.js';

export function createMRBackdrop() {
  if (!tableBox) {
    console.warn('[mrBackdrop] tableBox not ready — call after loadModels()');
    return null;
  }

  const layout = computeMRBackdropLayout(tableBox);
  const { centerX, wallZ, faceZ, width, height } = layout;

  const group = new THREE.Group();
  group.name = 'MRBackdrop';
  group.visible = false;
  // The brand mark loads async; a session can end before it lands.
  let disposed = false;

  // Same layer setup as the Focus Room (bit 0 for the camera, bit 3 for the
  // arena light rig) so the finish is lit identically in both venues.
  function track(mesh) {
    mesh.layers.enable(ARENA_LIGHT_LAYER);
    group.add(mesh);
    return mesh;
  }

  // --- The wall. A single plane facing +Z (toward the player) — the Focus
  // Room uses the same texture on a BackSide box, but here there is only
  // one face and it looks straight at the camera. The texture is a vertical
  // gradient (the wood floor's warm bounce over the bottom 1.5 m and the
  // blue skirting rail at the foot), which is exactly what stops the screen
  // from reading as a black rectangle standing on the real floor: it meets
  // the passthrough floor the way a wall meets a floor.
  const wallTexture = createWallPanelTexture();
  const wallTone = wallTexture ? 0xffffff : ROOM.WALL_COLOR;
  const wallMat = new THREE.MeshStandardMaterial({
    color: wallTone, roughness: ROOM.WALL_ROUGHNESS, metalness: 0,
    emissive: wallTone, emissiveIntensity: ROOM.SELF_LIT,
    map: wallTexture, emissiveMap: wallTexture,
  });
  const wall = track(new THREE.Mesh(new THREE.PlaneGeometry(width, height), wallMat));
  wall.position.set(centerX, height / 2, wallZ);

  // No edge trim. The Focus Room frames its walls in venue blue because a
  // black box needs edges to read as a room; a screen standing in the
  // player's real room does not — the tester found the blue posts and
  // cornice "looking bad" against passthrough (2026-09), and without them
  // the screen reads as a dark wall rather than a framed board. The only
  // line left is the skirting rail at the foot, painted into the shared
  // wall texture, which is what ties the screen to the real floor.

  // --- Venue mark, above the floating scoreboard. Async and never awaited:
  // the screen is complete with or without it (focusRoom.js, same contract).
  let logoTexture = null;
  loadBrandLogoTexture().then((logo) => {
    if (!logo) return;
    if (disposed) { logo.texture.dispose(); return; }
    logoTexture = logo.texture;

    let w = WALL_MARK.WIDTH_M;
    let h = w / logo.aspect;
    if (h > BACKDROP.MARK_MAX_HEIGHT_M) {
      h = BACKDROP.MARK_MAX_HEIGHT_M;
      w = h * logo.aspect;
    }
    const markMat = new THREE.MeshStandardMaterial({
      map: logoTexture, emissiveMap: logoTexture,
      color: WALL_MARK.TONE, emissive: WALL_MARK.TONE,
      emissiveIntensity: ROOM.SELF_LIT,
      roughness: 0.9, metalness: 0,
      transparent: true, alphaTest: 0.05,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const mark = track(new THREE.Mesh(new THREE.PlaneGeometry(w, h), markMat));
    mark.position.set(centerX, BACKDROP.MARK_Y, faceZ);
    console.log(`[mrBackdrop] branding: ${w.toFixed(2)}x${h.toFixed(2)} m mark`);
  });

  scene.add(group);
  console.log(`[mrBackdrop] built — ${width}x${height} m screen at z=${wallZ.toFixed(2)}`);

  function show() { group.visible = true; }
  function hide() { group.visible = false; }
  function setVisible(on) { group.visible = !!on; }
  function isVisible() { return group.visible; }

  // Everything here is owned by this instance (the wall and logo textures
  // are per-caller CanvasTextures over cached canvases — see focusRoom.js).
  function dispose() {
    disposed = true;
    scene.remove(group);
    group.traverse((obj) => {
      if (obj.isMesh) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      }
    });
    if (logoTexture) logoTexture.dispose();
    if (wallTexture) wallTexture.dispose();
  }

  return { show, hide, setVisible, isVisible, dispose, group, layout };
}
