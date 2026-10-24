// Arena venue ('vr-arena'): the artist-authored stadium GLB
// (public/models/tts-v1.glb), loaded as exported — no geometry, texture,
// scale or rotation changes. Two things are done to it at load: its
// materials are drawn unlit so the baked lighting shows (showBakedLighting
// below), and it is translated so its court centre sits under the table.
//
// GLB facts this relies on (measured from the export):
//   - metres, Y-up, floor at y=0 — the same basis as models.js (world y=0 is
//     the physical floor), so no vertical offset;
//   - court floor (Floor_Main) centred on the GLB origin with its long axis
//     on Z, matching the table's long axis — so no rotation;
//   - KHR_draco_mesh_compression + KHR_texture_basisu + EXT_mesh_gpu_instancing,
//     hence the Draco (public/draco/) and KTX2 (public/basis/) decoders below.
//     Both run WebAssembly in blob: workers, which is why firebase.json's
//     script-src carries 'wasm-unsafe-eval'.
//
// The stands reach ~40 m from the court centre, past the default 40 m camera
// far plane, so the far plane is pushed out while the venue is mounted and
// restored on dispose.
//
// Handle shape matches createFocusRoom (show / hide / dispose / group /
// getBackWallAnchor / getStadiumFixtures) so inGame.js and aiMatch.js consume
// it unchanged. The back-wall anchor is the far hanging screen (FAR_SCREEN
// below); no reactive fixtures. getSideScreenAnchor is Arena-only — drills
// that get null from a venue without it simply build no side screen.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { scene, camera, renderer } from './sceneSetup.js';

const ARENA_URL = '/models/tts-v1.glb';
const ARENA_CAMERA_FAR = 150;

// The far-end hanging screen (material 'TV', behind the AI), measured from
// the export in GLB-local metres: display face x -3.06..2.17, y 5.02..8.01,
// facing +Z at z = -13.72. The scoreboard mounts on it, 3 cm proud of the
// face against z-fighting, at 5.1 m wide — the board's 2048x1152 canvas then
// stands 2.87 m tall, inside the 5.23 x 2.99 m face.
const FAR_SCREEN = { x: -0.445, y: 6.515, z: -13.72, width: 5.23, height: 2.99 };
const SCOREBOARD_WIDTH_M = 5.1;

// The courtside monitor at the net line (material 'Screen'), measured from
// the export: a 1.36 x 0.77 m face in the plane x = -2.699, spanning
// y 0.80..1.57 and z -0.68..0.68, i.e. on the table's left as the player
// sees it. The last-point stats screen (sideScreen.js) mounts 1 cm proud of
// it, turned +90° about Y so its front faces +X — toward the table and the
// player. 1.34 m wide keeps the 16:9 canvas inside the face.
const SIDE_SCREEN = { x: -2.699, y: 1.186, z: 0, width: 1.34 };

let dracoLoader = null;
let ktx2Loader = null;

function makeLoader() {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('/draco/');
  }
  if (!ktx2Loader) {
    ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath('/basis/');
    ktx2Loader.detectSupport(renderer);
  }
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  loader.setKTX2Loader(ktx2Loader);
  return loader;
}

// The export's lighting is baked into its base-colour textures, but every
// material arrives as a lit PBR material — and with metallicFactor omitted,
// glTF's default of 1.0 makes all 69 of them fully metallic. A metal has no
// diffuse term, and with no envMap to reflect, the whole stadium rendered
// near-black under the VR hemi light. Showing a bake means drawing it unlit:
// swap each material for a MeshBasicMaterial carrying the SAME texture,
// colour, sidedness and transparency, with tone mapping off so the baked
// values reach the display as authored. The GLB file itself is untouched.
function showBakedLighting(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const toBasic = (m) => {
      const basic = new THREE.MeshBasicMaterial({
        name: m.name,
        map: m.map,
        color: m.color,
        side: m.side,
        transparent: m.transparent,
        opacity: m.opacity,
        alphaTest: m.alphaTest,
        alphaMap: m.alphaMap,
        vertexColors: m.vertexColors,
        toneMapped: false,
      });
      m.dispose();
      return basic;
    };
    obj.material = Array.isArray(obj.material) ? obj.material.map(toBasic) : toBasic(obj.material);
  });
}

// The one in-flight / finished load, shared by the start-page preload
// (js/ui/overlay.js shows its progress before the XR session is requested)
// and startInGame, which then finds the venue already decoded instead of
// loading it inside the headset next to a bare table. Cleared on failure and
// on dispose — dispose frees the GPU resources, so a disposed scene cannot be
// mounted again and the next entry loads afresh (from the HTTP cache).
let arenaLoad = null;
let arenaLoaded = false;
const progressListeners = new Set();

// Starts the download + decode, or returns the one already running. Optional
// onProgress(fraction 0..1) follows the download; decode follows it, so 1 is
// reported only once the scene is ready to mount.
export function loadArenaVenue(onProgress) {
  if (onProgress) progressListeners.add(onProgress);
  if (!arenaLoad) {
    arenaLoad = makeLoader().loadAsync(ARENA_URL, (e) => {
      // Content-Length is absent on some compressed responses; the bar then
      // simply waits at 0 until the decode lands.
      if (!e.lengthComputable || !e.total) return;
      // Hold back the last 10% for the Draco/KTX2 decode after the bytes land.
      const f = Math.min(e.loaded / e.total, 1) * 0.9;
      for (const cb of progressListeners) cb(f);
    }).then((gltf) => {
      showBakedLighting(gltf.scene);
      arenaLoaded = true;
      for (const cb of progressListeners) cb(1);
      progressListeners.clear();
      return gltf.scene;
    }, (err) => {
      arenaLoad = null;
      progressListeners.clear();
      throw err;
    });
  } else if (onProgress && arenaLoaded) {
    onProgress(1);
  }
  return arenaLoad;
}

export function isArenaVenueLoaded() { return arenaLoaded; }

export function removeArenaProgressListener(cb) { progressListeners.delete(cb); }

// Mount a loaded arena scene with its court centre under the table.
export function createArenaVenue(arenaScene, tableBox) {
  const group = new THREE.Group();
  group.name = 'ArenaVenue';
  group.visible = false;
  group.position.set(
    (tableBox.min.x + tableBox.max.x) / 2,
    0,
    (tableBox.min.z + tableBox.max.z) / 2,
  );
  group.add(arenaScene);
  scene.add(group);

  const prevFar = camera.far;
  camera.far = ARENA_CAMERA_FAR;
  camera.updateProjectionMatrix();
  console.log(`[arenaVenue] mounted at x=${group.position.x.toFixed(2)} z=${group.position.z.toFixed(2)}`);

  function dispose() {
    scene.remove(group);
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) {
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose();
      }
    });
    camera.far = prevFar;
    camera.updateProjectionMatrix();
    arenaLoad = null;
    arenaLoaded = false;
  }

  return {
    show() { group.visible = true; },
    hide() { group.visible = false; },
    dispose,
    group,
    ready: Promise.resolve(),
    getBackWallAnchor() {
      return {
        x: group.position.x + FAR_SCREEN.x,
        y: FAR_SCREEN.y,
        z: group.position.z + FAR_SCREEN.z + 0.03,
        wallWidth: FAR_SCREEN.width,
        wallHeight: FAR_SCREEN.height,
        panelWidth: SCOREBOARD_WIDTH_M,
      };
    },
    getSideScreenAnchor() {
      return {
        x: group.position.x + SIDE_SCREEN.x + 0.01,
        y: SIDE_SCREEN.y,
        z: group.position.z + SIDE_SCREEN.z,
        rotationY: Math.PI / 2,
        width: SIDE_SCREEN.width,
      };
    },
    getStadiumFixtures() { return []; },
  };
}
