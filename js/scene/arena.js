// Virtual "arena" environment for VR mode: an artist-authored venue loaded from
// public/models/arena.glb. Replaces the earlier procedurally-built dark room
// (walls/floor/ceiling + emissive fixture discs).
//
// Only assembled when the player picks Arena mode on the start screen
// (see js/ui/overlay.js). Called from js/modes/inGame.js when xrMode === 'vr'.
//
// Layer strategy:
//   Venue meshes stay on layer 0 (so the WebXR ArrayCamera renders them
//   in both eyes — layer isolation on meshes is unreliable in stereo XR)
//   AND ADDITIONALLY have ARENA_LIGHT_LAYER (3) enabled. That bit is now a
//   MARKER for venue geometry, not a lighting route: three.js has no
//   per-mesh light masking (see the LIGHTING LAYERS note in sceneSetup.js),
//   so the layer-3 arena rig this once described never illuminated
//   anything and has been deleted. A venue that needs to be brighter
//   lights itself with emissive on its own materials, the way the Focus
//   Room does with ROOM.SELF_LIT.
//
//   In VR mode setArenaLighting() also swings the P16 keyLight + rimLight
//   onto layer 3, so the direct-key rig for AR mode stops touching gameplay
//   the moment the player enters the arena — the player sees gameplay lit
//   by hemi only (indirect-feeling, no specular streak on a smashing ball).
//
//   Any THREE.Light baked into the GLB is force-isolated to the quarantine
//   layer below so it can never leak onto anything.
//
// Loading:
//   arena.glb is ~58 MB, so loading is deferred to the first createArena()
//   call (AR sessions never pay the cost) and cached across subsequent calls.
//   createArena() returns its handle synchronously and swaps the geometry in
//   as soon as the GLB resolves, so callers don't need to await anything.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { scene, ARENA_LIGHT_LAYER } from './sceneSetup.js';
import { tableBox } from './models.js';
import { hudLog } from './hud.js';

// Baked-in GLB lights are switched off with visible=false, NOT by moving
// them to a layer. The old quarantine layer was 2 — which is precisely
// WebXR's right-eye layer (WebXRManager sets cameraXR.layers.mask =
// camera.layers.mask | 0b110, then strips bit 1 from the left eye and bit 2
// from the right). A light parked there passed the right eye's layer test
// and was dropped by the left, so the venue's baked lights were live in ONE
// EYE ONLY — binocular rivalry, the worst possible outcome for a headset.
// visible=false is what actually makes a light inert: projectObject()
// returns early on it, so it never reaches the frame's light state.

// Node names in arena.glb that must be hidden because we render the real,
// physics-driven equivalents from other GLBs. The venue ships its own
// decorative table + net; leaving them visible would overlap our Table.glb
// and confuse the player about which surface is real. Match is case-
// insensitive and by whole-name equality (see hideVenueDuplicates below).
const HIDDEN_VENUE_NODE_NAMES = new Set(['table', 'net']);

// Deep tournament-blue color applied to the venue's floor meshes at load
// time. ITTF broadcast courts use this palette because it maximizes the
// silhouette contrast for both white and orange balls (orange is the
// complementary hue; white reads bright against dark blue).
const FLOOR_COLOR = 0x1a3a6b;
// Substrings we look for in node/material names to identify the floor. Kept
// broad because artists label these variably ('Floor', 'GroundPlane',
// 'Court_Surface', 'parquet_01', etc.). Case-insensitive substring match.
// Excludes 'ceiling'/'wall' explicitly in the traversal below so a node
// like 'CeilingFloor' or 'FloorLamp' doesn't get miscolored.
const FLOOR_NAME_PATTERNS = ['floor', 'ground', 'court', 'parquet'];
const FLOOR_NAME_EXCLUDE  = ['ceiling', 'wall', 'lamp', 'light', 'sign'];

// Repaint any mesh under `root` whose node or material name reads as a
// floor surface. Called once inside loadArenaScene BEFORE the parsed scene
// is cached, so the recolor is applied a single time and inherited by
// every subsequent clone in createArena. Material is cloned per matched
// mesh so we don't recolor unrelated meshes that happened to share the
// same source material. Logs both matched and unmatched candidate names so
// a naming mismatch is caught in one load rather than hunted for.
function recolorArenaFloor(root) {
  const matched = [];
  const otherMeshNames = [];
  const target = new THREE.Color(FLOOR_COLOR);
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const nodeName = (obj.name || '').toLowerCase();
    const matName  = (obj.material.name || '').toLowerCase();
    const combined = `${nodeName} ${matName}`;
    const isCandidate = FLOOR_NAME_PATTERNS.some((p) => combined.includes(p));
    const isExcluded  = FLOOR_NAME_EXCLUDE.some((p) => combined.includes(p));
    if (!isCandidate || isExcluded) {
      if (obj.name) otherMeshNames.push(obj.name);
      return;
    }
    // Diagnostic dump BEFORE we mutate — tells us why an authored floor was
    // reading black (dark albedo texture? metalness=1? unlit + emissive?).
    const src = obj.material;
    console.log(`[arena] floor mesh '${obj.name}': type=${src.type} ` +
      `color=${src.color?.getHexString?.() ?? 'n/a'} ` +
      `map=${!!src.map} metalness=${src.metalness ?? 'n/a'} ` +
      `roughness=${src.roughness ?? 'n/a'} ` +
      `emissive=${src.emissive?.getHexString?.() ?? 'n/a'}`);
    // Replace the material outright rather than clone+tint. Cloning + setting
    // .color still leaves an authored albedo `map` (which multiplies against
    // color — a dark texture stays dark) and any metalness/emissive quirks
    // that suppress the diffuse color. A fresh MeshStandardMaterial with
    // deterministic PBR values guarantees the target color reads correctly
    // under the current scene lighting.
    obj.material = new THREE.MeshStandardMaterial({
      color: target,
      roughness: 0.85,
      metalness: 0.0,
    });
    obj.material.needsUpdate = true;
    matched.push(obj.name || '(unnamed)');
  });
  console.log(`[arena] floor recolor: matched ${matched.length} mesh(es):`, matched);
  if (matched.length === 0) {
    console.warn('[arena] floor recolor matched NO meshes. Candidate mesh names in GLB:', otherMeshNames.slice(0, 40));
  }
}

// Arena lighting is handled entirely by the AR-tuned scene lights in
// sceneSetup.js (ambient + directional + fill). Adding per-fixture
// SpotLights above the table both (a) slowed the frame rate on Quest
// because per-mesh lighting scales with light count × the ~70 venue meshes
// and (b) made the ball look "strobe-lit" — Ball.glb ships with
// KHR_materials_specular boosted 2×, so a fast-moving ball punched a bright
// specular highlight through each spotlight cone in turn.
//
// The venue's own ceiling-fixture meshes use KHR_materials_unlit and read
// as "lit up" regardless of scene lights, so the visual cue of overhead
// fixtures is preserved without paying the per-light cost.

// Selectable venues. Keyed by the variant name passed to createArena(); the
// start-screen mode toggle picks between them. Caches are per-URL so switching
// venues (or re-picking one) doesn't re-download.
//
// TableTennis_Stadium.glb is Draco-compressed (KHR_draco_mesh_compression,
// required extension), so GLTFLoader needs a DRACOLoader wired in or the
// parse silently fails with "no DRACOLoader instance provided". Decoder
// files are fetched from Google's static CDN on first use — ~200 KB WASM,
// cached after that. If we ever want offline support, copy the files from
// node_modules/three/examples/jsm/libs/draco/gltf/ into public/draco/ and
// switch this path to '/draco/'.
// recolorFloor: whether to force-paint the venue's floor tournament-blue.
// Only the stadium ships with a floor material that reads too dark under our
// lighting (see recolorArenaFloor for the diagnostic path). tt-arena is
// authored with its own floor material and must be left alone.
const ARENA_VARIANTS = {
  stadium: { url: 'models/TableTennis_Stadium.glb', approxMB: 22, recolorFloor: true  },
  tt:      { url: 'models/tt-arena.glb',            approxMB: 2,  recolorFloor: false },
};
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);
const cachedArenaScenes = new Map();       // url -> parsed THREE.Scene
const cachedArenaLoadPromises = new Map(); // url -> in-flight load Promise

// Subscribers get called with (loaded, total, pct) on every progress tick.
// inGame.js uses this to update the pre-XR DOM loading screen; the in-HUD
// log is driven from the same tick below. Cleared when load completes.
const _progressListeners = new Set();
export function onArenaLoadProgress(cb) {
  _progressListeners.add(cb);
  return () => _progressListeners.delete(cb);
}

function loadArenaScene(url, approxMB, recolorFloor) {
  if (cachedArenaScenes.has(url)) return Promise.resolve(cachedArenaScenes.get(url));
  if (cachedArenaLoadPromises.has(url)) return cachedArenaLoadPromises.get(url);
  const sizeHint = approxMB != null ? ` (~${approxMB} MB — first load only)` : '';
  console.log(`[arena] fetching ${url}${sizeHint}`);
  hudLog(`arena: fetching${approxMB != null ? ` (~${approxMB} MB)` : ''}`);
  const t0 = performance.now();
  // Throttle in-HUD progress so we don't spam log lines every frame — one
  // update per ~10% download step is enough to see the download is alive.
  let nextHudPct = 10;
  const promise = new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const ms = (performance.now() - t0).toFixed(0);
        const childCount = gltf.scene?.children?.length ?? 0;
        console.log(`[arena] GLB parsed in ${ms} ms — scene children:`, childCount);
        hudLog(`arena: parsed in ${ms}ms, ${childCount} nodes`);
        // Recolor the floor once, on the source scene, before caching. All
        // createArena() clones inherit the recolor for free — no per-clone
        // work needed at show time. Gated per-variant: venues authored with
        // an acceptable floor material opt out (see ARENA_VARIANTS).
        if (recolorFloor) recolorArenaFloor(gltf.scene);
        _progressListeners.clear();
        cachedArenaScenes.set(url, gltf.scene);
        resolve(gltf.scene);
      },
      (evt) => {
        if (evt.lengthComputable) {
          const pct = evt.loaded / evt.total * 100;
          console.log(`[arena] download ${pct.toFixed(1)}% (${(evt.loaded / 1e6).toFixed(1)} / ${(evt.total / 1e6).toFixed(1)} MB)`);
          if (pct >= nextHudPct) {
            hudLog(`arena: ${Math.floor(pct)}% (${(evt.loaded / 1e6).toFixed(0)}/${(evt.total / 1e6).toFixed(0)} MB)`);
            nextHudPct = Math.floor(pct / 10) * 10 + 10;
          }
          for (const cb of _progressListeners) {
            try { cb(evt.loaded, evt.total, pct); } catch (e) { console.error('[arena] progress cb threw:', e); }
          }
        }
      },
      (err) => {
        console.error('[arena] GLTFLoader error:', err);
        hudLog(`arena: LOAD FAILED — ${err?.message || err}`);
        _progressListeners.clear();
        reject(err);
      },
    );
  });
  cachedArenaLoadPromises.set(url, promise);
  return promise;
}

export function createArena(variantName = 'stadium') {
  if (!tableBox) {
    console.warn('[arena] tableBox not ready — call after loadModels()');
    return null;
  }
  const variant = ARENA_VARIANTS[variantName] || ARENA_VARIANTS.stadium;

  const group = new THREE.Group();
  group.name = `Arena:${variantName}`;

  group.visible = false;
  scene.add(group);

  let arenaMesh = null;
  let disposed = false;

  // Populated for variants whose GLB exposes named wall nodes (currently just
  // 'tt' — Wall00..Wall03). Consumers await ready then read this to mount
  // wall-attached UI (e.g. scoreboard) instead of the default floating panel.
  // Shape: { x, y, z, wallWidth, wallHeight } in world coords, or null.
  let backWallAnchor = null;

  // Populated for the stadium variant. Arrays of Object3D handles into the
  // arena hierarchy — consumers use them to (a) paint a CanvasTexture onto
  // the venue's built-in TV/Screen meshes and (b) anchor positional crowd
  // audio to each of the 24 audience sections. Empty for non-stadium
  // variants (tt-arena has no such nodes).
  let stadiumScreens = [];       // [Mesh, ...] for TV, Screen (and Billboard)
  let crowdAnchors = [];         // [{ position: Vector3, node: Object3D }, ...]
  // Ceiling-fixture meshes whose emissive/color the arenaLighting module
  // animates for match-point pulse + match-won celebration. Populated by
  // name lookup below; empty for non-stadium variants.
  let stadiumFixtures = [];      // [{ name, mesh }, ...]
  // Branding boards around the ring (7 total). Painted with rotating
  // sponsor content by sponsorBoards.js.
  let brandingBoards = [];       // [Mesh, ...]

  // Exposed so the caller can await full mount before requesting the XR
  // session — see startInGame in js/modes/inGame.js. Resolves once arenaMesh
  // is added to the scene; rejects on parse/network failure. Also resolves
  // (no value) if dispose() fires before the load completes so the caller's
  // await doesn't hang.
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  loadArenaScene(variant.url, variant.approxMB, variant.recolorFloor).then((sourceScene) => {
    if (disposed) { readyResolve(); return; }
    // Clone so multiple arena instances (or a re-created arena after dispose)
    // don't share mutable node transforms with the cached original.
    arenaMesh = sourceScene.clone(true);

    // Shift the venue horizontally so its OWN decorative Table node lands on
    // top of our real gameplay table. Just centering the arena's overall
    // bounding box on our table isn't right — the artist may have placed the
    // court off-center in the bowl (e.g. against a broadcast wall). Anchoring
    // on the venue's Table node guarantees seats/branding/lights all face
    // the correct side.
    //
    // Y is left at the authored value: stadium meshes conventionally place
    // the play-surface floor at y=0 with foundations/exterior bowl going
    // below zero. Lifting them so box.min.y == 0 puts the floor ABOVE the
    // player. Trust the authored origin.
    const box = new THREE.Box3().setFromObject(arenaMesh);
    const size = box.getSize(new THREE.Vector3());
    const tableCenter = new THREE.Vector3(
      (tableBox.min.x + tableBox.max.x) / 2,
      0,
      (tableBox.min.z + tableBox.max.z) / 2,
    );
    // getWorldPosition works here because arenaMesh.position is still (0,0,0)
    // and updateMatrixWorld is called internally — so the "world" pos of the
    // Table node equals its local pos inside arenaMesh, which is exactly the
    // offset we need to cancel.
    const venueTableNode = arenaMesh.getObjectByName('Table');
    if (venueTableNode) {
      arenaMesh.updateMatrixWorld(true);
      const venueTablePos = venueTableNode.getWorldPosition(new THREE.Vector3());
      arenaMesh.position.x = tableCenter.x - venueTablePos.x;
      arenaMesh.position.z = tableCenter.z - venueTablePos.z;
      console.log('[arena] anchored to venue Table node at local pos:', venueTablePos);
    } else {
      // Fallback: center the whole bounding box on our table. Should not hit
      // for this arena.glb (Table node is present) but keeps the code robust
      // if the venue is ever swapped for one that lacks the node.
      const center = box.getCenter(new THREE.Vector3());
      arenaMesh.position.x = tableCenter.x - center.x;
      arenaMesh.position.z = tableCenter.z - center.z;
      console.warn('[arena] no "Table" node — fell back to bbox-center alignment');
    }
    console.log('[arena] GLB loaded — size:', size, 'centered at:', tableCenter, 'box.min.y:', box.min.y);

    // Meshes stay on default layer 0 so both eyes render them (see file
    // header for the WebXR ArrayCamera layer-propagation caveat). THREE.Light
    // nodes are set invisible so any baked-in venue lights can't leak onto
    // gameplay meshes' shading — see the note above on why a layer cannot
    // do this job.
    // Nodes whose name is in HIDDEN_VENUE_NODE_NAMES get set invisible so the
    // venue's decorative table/net don't overlap our real Table.glb.
    // Also count mesh vs. light nodes so the HUD tells us both "the file
    // parsed" (nodeCount) and "the venue actually has render-able geometry"
    // (meshCount) — a load that returns 0 meshes will otherwise look
    // identical to a working load that just isn't visible.
    let meshCount = 0, lightCount = 0, hiddenCount = 0;
    arenaMesh.traverse((obj) => {
      if (obj.isLight) {
        obj.visible = false;
        lightCount++;
        return;
      }
      // Hide venue nodes that duplicate our real gameplay objects. Setting
      // visible=false on the node also hides all its descendants — three.js
      // renders based on inherited visibility, so we don't need to walk into
      // the subtree ourselves.
      const rawName = obj.name || '';
      if (HIDDEN_VENUE_NODE_NAMES.has(rawName.toLowerCase())) {
        obj.visible = false;
        hiddenCount++;
        return;
      }
      if (obj.isMesh) {
        // Add the arena lighting layer WITHOUT removing layer 0 — the
        // camera still needs to render this mesh (layer 0), we just also
        // want it to receive the bright arena-only lights (layer 3).
        obj.layers.enable(ARENA_LIGHT_LAYER);
        meshCount++;
      }
    });

    group.add(arenaMesh);

    // Stadium-only: harvest handles into the built-in screen meshes and the
    // 24 audience-section nodes so consumers (aiMatch.js) can paint a live
    // scoreboard onto the TVs and anchor positional crowd cheers to each
    // stand. arenaMesh has just been added, so world matrices are current
    // enough for getWorldPosition to return the final placement.
    if (variantName === 'stadium') {
      arenaMesh.updateMatrixWorld(true);
      // Screen mesh candidates. TV + Screen are the primary broadcast
      // displays; Billboard is a larger overhead panel. All three share
      // the same live-scoreboard content.
      const SCREEN_NAMES = ['TV', 'Screen', 'Billboard'];
      for (const name of SCREEN_NAMES) {
        const node = arenaMesh.getObjectByName(name);
        if (!node) continue;
        // Node may be a Group with a Mesh child; walk it to collect meshes.
        node.traverse((obj) => {
          if (obj.isMesh) stadiumScreens.push(obj);
        });
      }
      console.log(`[arena] stadium screens found: ${stadiumScreens.length}`);

      // Crowd anchors — 24 Seats_Audi_* nodes. Names are inconsistent in
      // the GLB (Seats_Audi_1..7 and Seats_Audi_08..24 — mixed zero-padding).
      // Iterate 1..24 and try both padded and unpadded variants.
      const _tmpBox = new THREE.Box3();
      const _tmpCenter = new THREE.Vector3();
      for (let i = 1; i <= 24; i++) {
        const padded = `Seats_Audi_${String(i).padStart(2, '0')}`;
        const plain = `Seats_Audi_${i}`;
        const node = arenaMesh.getObjectByName(plain) || arenaMesh.getObjectByName(padded);
        if (!node) continue;
        _tmpBox.setFromObject(node);
        if (!isFinite(_tmpBox.min.x)) continue;
        _tmpBox.getCenter(_tmpCenter);
        crowdAnchors.push({
          position: _tmpCenter.clone(),
          node,
        });
      }
      console.log(`[arena] crowd anchors found: ${crowdAnchors.length}`);

      // Ceiling fixture meshes for reactive lighting. Same node-name
      // convention as arenaLighting.js's FIXTURE_NAMES — we harvest
      // whichever ones exist and let the lighting module decide what to
      // do with them.
      const FIXTURE_NODE_NAMES = [
        'CeilingRing', 'CenterLightBox', 'Light_Box_Big', 'LightBox',
        'CeilingGrill002', 'CeilingGrill006', 'CeilingGrill010', 'CeilingGrill015',
      ];
      for (const name of FIXTURE_NODE_NAMES) {
        const node = arenaMesh.getObjectByName(name);
        if (!node) continue;
        node.traverse((obj) => {
          if (obj.isMesh) stadiumFixtures.push({ name, mesh: obj });
        });
      }
      console.log(`[arena] fixture meshes found: ${stadiumFixtures.length}`);

      // Branding boards for rotating sponsor content. Two naming patterns
      // in the GLB: 'Branding<NN>' (flat panels) and 'Branding_Board<NN>'
      // (larger boards). Both accept the same texture treatment.
      const BRANDING_NODE_NAMES = [
        'Branding01', 'Branding11', 'Branding20', 'Branding22',
        'Branding_Board02', 'Branding_Board10', 'Branding_Board24',
      ];
      for (const name of BRANDING_NODE_NAMES) {
        const node = arenaMesh.getObjectByName(name);
        if (!node) continue;
        node.traverse((obj) => {
          if (obj.isMesh) brandingBoards.push(obj);
        });
      }
      console.log(`[arena] branding boards found: ${brandingBoards.length}`);
    }

    // tt-arena.glb ships as a simple box room: Floor, Ceiling, Podium and
    // Wall00..Wall03. To wall-mount the scoreboard we pick the wall whose
    // world-Z center is smallest (most negative) — that's the wall behind
    // the AI baseline, since AI sits at tableBox.min.z (-Z) and the player
    // at tableBox.max.z (+Z). We expose an anchor on the FRONT face (toward
    // the player, +Z-biased by 2 cm to avoid z-fighting with the wall mesh)
    // near the top of the wall so the panel reads like an overhead banner.
    // Other variants leave backWallAnchor null — scoreboard.js falls back
    // to its historical float-behind-baseline position.
    if (variantName === 'tt') {
      arenaMesh.updateMatrixWorld(true);
      const wallCandidates = [];
      for (let i = 0; i <= 3; i++) {
        const node = arenaMesh.getObjectByName(`Wall0${i}`);
        if (!node) continue;
        const b = new THREE.Box3().setFromObject(node);
        if (!isFinite(b.min.z) || !isFinite(b.max.z)) continue;
        wallCandidates.push({ name: node.name, box: b, cz: (b.min.z + b.max.z) / 2 });
      }
      if (wallCandidates.length > 0) {
        const backWall = wallCandidates.reduce((a, b) => (a.cz < b.cz ? a : b));
        const bx = backWall.box;
        const width = bx.max.x - bx.min.x;
        const height = bx.max.y - bx.min.y;
        backWallAnchor = {
          x: (bx.min.x + bx.max.x) / 2,
          // ~2.2 m above the wall base (typical broadcast-banner height, a
          // gentle upward glance from a standing player), OR 70% up the
          // wall — whichever is lower. Guarantees the panel top stays
          // clear of the ceiling even on shorter rooms.
          y: bx.min.y + Math.min(2.2, height * 0.7),
          z: bx.max.z + 0.02,
          wallWidth: width,
          wallHeight: height,
        };
        console.log(`[arena] tt back-wall anchor picked ${backWall.name} (cz=${backWall.cz.toFixed(2)}):`, backWallAnchor);
      } else {
        console.warn('[arena] tt variant: no Wall0[0-3] nodes found — scoreboard falls back to floating');
      }

      // NOTE: a PointLight used to be added here for interior fill, on
      // ARENA_LIGHT_LAYER "so it does not touch gameplay meshes". It never
      // lit anything at all — no camera enables layer 3, so it was dropped
      // from every frame (sceneSetup.js LIGHTING LAYERS). It has been
      // removed rather than repaired: repairing it means the light reaches
      // the ball and paddle too, which the P16 no-specular-on-gameplay rule
      // forbids. Brighten this venue with emissive on its own materials.
    }

    hudLog(`arena: SHOWN — ${meshCount} meshes, ${lightCount} lights, ` +
           `${hiddenCount} hidden, ` +
           `size ${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}m`);
    readyResolve();
  }).catch((err) => {
    console.error('[arena] Failed to load arena.glb:', err);
    readyReject(err);
  });

  function show() {
    group.visible = true;
  }
  function hide() {
    group.visible = false;
  }

  function dispose() {
    disposed = true;
    // Unblock any caller that's still awaiting ready — dispose implies the
    // player abandoned before mount, so resolving (rather than rejecting)
    // keeps the caller's error path free for real load failures.
    if (readyResolve) readyResolve();
    scene.remove(group);
    // Intentionally NOT disposing geometry/material here: arenaMesh is a
    // shallow clone of cachedArenaScene (clone(true) shares geometry +
    // material refs across clones). Disposing them would break every future
    // createArena() call for the session. We only tear down the light shadow
    // maps, which are per-Light-instance and safe to reclaim.
    group.traverse((obj) => {
      if (obj.shadow && obj.shadow.map) obj.shadow.map.dispose();
    });
  }

  return {
    show, hide, dispose, group, ready,
    // Getter so callers see the value populated inside the load .then()
    // without racing on capture order.
    getBackWallAnchor() { return backWallAnchor; },
    // Stadium-only. Empty arrays when the current variant is tt-arena or
    // when the load .then hasn't run yet — callers should read these only
    // after awaiting ready.
    getStadiumScreens() { return stadiumScreens; },
    getCrowdAnchors() { return crowdAnchors; },
    getStadiumFixtures() { return stadiumFixtures; },
    getBrandingBoards() { return brandingBoards; },
  };
}
