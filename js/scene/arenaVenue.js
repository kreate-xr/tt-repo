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
// below); no reactive fixtures.

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

// Starts the download + decode. Independent of the table, so inGame.js can
// kick it off alongside loadModels and mount it once tableBox exists.
export function loadArenaVenue() {
  return makeLoader().loadAsync(ARENA_URL).then((gltf) => {
    showBakedLighting(gltf.scene);
    return gltf.scene;
  });
}

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
    getStadiumFixtures() { return []; },
  };
}
