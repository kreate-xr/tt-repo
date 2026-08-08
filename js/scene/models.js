import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { scene } from './sceneSetup.js';
import { SELF_TEST, initDebugHud } from './hud.js';
import { detectDiscCollision } from '../physics/collisions.js';
import { createBallTrail } from './ballTrail.js';
import { createBallSeamTexture } from './ballTexture.js';
import { createBallShadow } from './ballShadow.js';
import { createBallGhost } from './ballGhost.js';
import { ballEnvMap } from './sceneSetup.js';

const loader = new GLTFLoader();

// Model refs (assigned in loadModels). Live ESM bindings — readers see updates.
export let paddleModel = null;
// Wrapper Group physics writes to. Position is world. Quaternion is the ball's
// accumulating world-frame spin. Scale is always 1 — squash-and-stretch is
// applied as a vertex-buffer deformation on the inner meshes (see
// setBallSquash / updateBallSquashAmount / resetBallSquash) so that the
// world-aligned squash direction never has to compose with the spin
// quaternion through the transform hierarchy.
export let ballModel = null;
export let tableModel = null;
export let tableBox = null;
export let netBox = null;
export let tableSurfaceY = 0;
export let ballRadius = 0.02;
export let paddleHitRadius = 0.15;
export let paddleHalfThickness = 0.01;

// Paddle face geometry, in controller-local space (computed once at load).
export const paddleFaceOffset = new THREE.Vector3();
export const paddleFaceNormalLocal = new THREE.Vector3(0, 1, 0);

// Paddle orientation Euler XYZ, validated visually in MR with Quest controllers.
// Do not change unless re-tested in headset — Euler XYZ order means these
// values do not correspond to independent per-axis rotations.
export const PADDLE_EULER_X = Math.PI / 2;
export const PADDLE_EULER_Y = Math.PI / 2;
export const PADDLE_EULER_Z = Math.PI;

let debugFaceSphere = null;
let debugNormalArrow = null;
let debugDiscMesh = null;

let modelsLoaded = false;

// Two ITTF-legal tournament colors (rule 2.03: "white or orange, matt").
// `id` is the stable key the wrist menu toggles between; `base` is the
// diffuse color that multiplies against the grayscale seam+logo texture.
//
// White is `#fafafa` — near-pure white matching a fresh tournament ball
// (Nittaku Premium 40+, DHS D40+, Butterfly A40+ all read this bright).
// Left a hair of headroom below `#ffffff` because the scene runs ACES
// tone mapping and a pure-white base clips against the specular lobe,
// flattening the ball's roundness. The texture background is already
// 0.98 gray for the same reason, so the compounded product still leaves
// tone-map headroom.
//
// Spin legibility: the grayscale texture (see ballTexture.js) bakes an
// equatorial seam and a small off-equator swoosh. These break rotational
// symmetry so a fast spinning ball reads its axis correctly at 90 Hz VR
// instead of wagon-wheeling. Prior versions with a bare sphere suffered
// the wagon-wheel artifact above ~15 Hz rotation.
export const BALL_COLORS = {
  // Measured average of ITTF-approved balls (Nittaku Premium 40+, Butterfly
  // R40+, DHS D40+). Not a spec — ITTF rule 2.03 only says "orange, and matt"
  // without a Pantone/hex reference — but reads correctly as tournament
  // orange on-screen while staying close to real ball hue.
  orange: { id: 'orange', base: '#ff6600' },
  white:  { id: 'white',  base: '#fafafa' },
};

// Current color id. Read by setBallColor and by the wrist menu to render
// its color-swatch button. Default white — ITTF-legal tournament color and
// the one most world-federation events use with dark tables.
let currentBallColorId = 'white';
export function getBallColorId() { return currentBallColorId; }
export function getBallColorHex() { return BALL_COLORS[currentBallColorId].base; }

// Live refs to every ball mesh so setBallColor can update the diffuse color
// after load. Populated inline in loadModels.
const _ballMaterialMeshes = [];

// Swap the ball's base color at runtime (called from the wrist menu). Updates
// every ball mesh's material color in place. Effectively free — no texture
// rebuild, no GPU upload beyond the uniform change.
export function setBallColor(colorId) {
  if (!BALL_COLORS[colorId]) return;
  if (colorId === currentBallColorId && _ballMaterialMeshes.length > 0) return;
  currentBallColorId = colorId;
  const newColor = new THREE.Color(BALL_COLORS[colorId].base);
  for (const mesh of _ballMaterialMeshes) {
    const mat = mesh.material;
    if (!mat) continue;
    mat.color.copy(newColor);
    mat.needsUpdate = true;
  }
}

// --- Ball squash-and-stretch (vertex-buffer deformation) --------------------
// The ball's visible squash is a world-aligned non-uniform "pancake" along the
// paddle's reflection normal at the moment of impact. If it were applied as a
// parent-node quaternion + non-uniform scale, the child mesh's spin would be
// composed with that transform every frame — during the 80 ms squash window
// the visible spin axis would drift to (parent_q · ω/|ω|) and the parent's
// non-uniform scale would shear the rotating markings, both discretely
// snapping back at squash end. Instead we deform the mesh's own vertex buffer
// in place. Because ballModel then carries nothing but position + spin
// quaternion, spin stays clean in world regardless of squash state.
//
// Cost: N vertices per ball mesh per frame during squash (~80 ms). The ball
// GLB is a low-poly sphere, so this is a few hundred vertices at most; the
// per-frame cost is well under 100 µs.
const _ballSquashMeshes = [];
const _squashDirWorld = new THREE.Vector3(0, 1, 0);
let _squashAmount = 0;

const _squashDirLocal = new THREE.Vector3();
const _squashCenterLocal = new THREE.Vector3();
const _invMeshWorld = new THREE.Matrix4();

function _applySquashToVertices() {
  if (!ballModel || _ballSquashMeshes.length === 0) return;
  // Make sure each mesh's matrixWorld reflects the current ballModel spin
  // quaternion — worldToLocal / transformDirection below both depend on it.
  ballModel.updateMatrixWorld(true);

  const A = _squashAmount;
  const perpScale = 1 + A;
  const paraScale = 1 - A;

  for (const { mesh, originalPositions } of _ballSquashMeshes) {
    // Transform world squash direction + world ball center into this mesh's
    // local frame. Handled per-mesh (not just per-ballModel) so a GLB with
    // nested mesh transforms or offset origins still squashes about the
    // ball's actual center of mass along the correct world direction.
    _invMeshWorld.copy(mesh.matrixWorld).invert();
    _squashDirLocal.copy(_squashDirWorld).transformDirection(_invMeshWorld).normalize();
    _squashCenterLocal.copy(ballModel.position).applyMatrix4(_invMeshWorld);

    const dx = _squashDirLocal.x;
    const dy = _squashDirLocal.y;
    const dz = _squashDirLocal.z;
    const cx = _squashCenterLocal.x;
    const cy = _squashCenterLocal.y;
    const cz = _squashCenterLocal.z;

    const posAttr = mesh.geometry.getAttribute('position');
    const arr = posAttr.array;
    const orig = originalPositions;
    const n = arr.length;
    for (let i = 0; i < n; i += 3) {
      const ox = orig[i]     - cx;
      const oy = orig[i + 1] - cy;
      const oz = orig[i + 2] - cz;
      const par = ox * dx + oy * dy + oz * dz;
      const parX = par * dx;
      const parY = par * dy;
      const parZ = par * dz;
      const perpX = ox - parX;
      const perpY = oy - parY;
      const perpZ = oz - parZ;
      arr[i]     = cx + perpX * perpScale + parX * paraScale;
      arr[i + 1] = cy + perpY * perpScale + parY * paraScale;
      arr[i + 2] = cz + perpZ * perpScale + parZ * paraScale;
    }
    posAttr.needsUpdate = true;
  }
}

// Called from ball.js at impact. `worldDir` is the paddle's reflection normal;
// the "pancake" compresses along it. `amount` is the peak deformation (0..1).
export function setBallSquash(worldDir, amount) {
  _squashDirWorld.copy(worldDir).normalize();
  _squashAmount = amount;
  _applySquashToVertices();
}

// Called from ball.js each frame during recovery. Deformation direction is
// held from setBallSquash; only the amount changes as it tapers to 0.
export function updateBallSquashAmount(amount) {
  _squashAmount = amount;
  _applySquashToVertices();
}

// Restores every ball mesh's vertex buffer to its pristine GLB positions.
// Called at squash-window end and on spawnBallAt to guarantee no residual
// deformation carries into the next life.
export function resetBallSquash() {
  _squashAmount = 0;
  for (const { mesh, originalPositions } of _ballSquashMeshes) {
    const posAttr = mesh.geometry.getAttribute('position');
    posAttr.array.set(originalPositions);
    posAttr.needsUpdate = true;
  }
}

// Procedural mesh-grid alpha map for nets whose GLB ships without one. 8×8
// tile with a 2-pixel string on the top+left edges (12 white + 4 black corner
// pixels + 48 fully-black hole pixels = 28/64 ≈ 0.44 average alpha), tiled
// via RepeatWrapping and combined with alphaTest=0.5 in the material. Mipmaps
// are disabled: at higher mip levels the sparse strings average out below the
// alphaTest threshold and the entire net vanishes at distance; with mipmaps
// off we get some grazing-angle shimmer but the strings never disappear.
// `repeat.set(N, M)` controls apparent hole density in world space; (64, 6)
// across a regulation 1.83 m × 15.25 cm net gives ~2.8 cm × 2.5 cm cells,
// chunky compared to real ITTF ~15 mm mesh but legible at VR viewing distance.
let _netAlphaMap = null;
function getNetMeshAlphaMap() {
  if (_netAlphaMap) return _netAlphaMap;
  const T = 8;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = T;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, T, T);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 2, T); // vertical string, 2 px wide
  ctx.fillRect(0, 0, T, 2); // horizontal string, 2 px tall
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.repeat.set(64, 6);
  _netAlphaMap = tex;
  return tex;
}

// Traverse the loaded table and rewrite the net's material so it reads well
// against AR pass-through. GLB ships the net as alpha-blended with a mesh
// texture — great for offline renders, mostly-invisible in MR. Switching
// to alphaTest gives a hard cutout that preserves the grid holes while
// keeping the strings fully opaque. Also brightens the base color so the
// mesh reads against dark rooms.
//
// Detection is name-first (any node/material with 'net' in the name), with a
// geometric fallback for GLBs that don't use that naming — e.g. the current
// TableTennis export ships one mesh with 5 materials (Material.001..005) and
// no 'net' substring anywhere, so the name check alone matches nothing and the
// net renders as its authored pure-black solid plane (invisible against dark
// scene backgrounds). The fallback matches any thin (dz<3 cm) vertical
// (dy>5 cm) wide (dx>1 m) plane centered near the table's z=0 line, which is
// how a regulation TT net is always modelled regardless of naming.
//
// If the detected net's material has neither a baseColor map nor an alphaMap,
// we install the procedural mesh grid so the visible cue "strings + holes"
// exists — a solid plane, even lifted from black, still reads as "wrong slab"
// rather than "TT net" because the eye looks for the mesh pattern.
function enhanceNetVisibility(root) {
  const matched = [];
  root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const nodeName  = (node.name || '').toLowerCase();
    const matName   = (node.material.name || '').toLowerCase();
    let isNet = nodeName.includes('net') || matName.includes('net');
    if (!isNet && node.geometry) {
      const geom = node.geometry;
      if (!geom.boundingBox) geom.computeBoundingBox();
      const bb = geom.boundingBox;
      if (bb) {
        const dx = bb.max.x - bb.min.x;
        const dy = bb.max.y - bb.min.y;
        const dz = bb.max.z - bb.min.z;
        const cz = (bb.min.z + bb.max.z) / 2;
        isNet = dz < 0.03 && dy > 0.05 && dx > 1.0 && Math.abs(cz) < 0.05;
      }
    }
    if (!isNet) return;

    const mat = node.material;
    // Install the procedural mesh alpha map when the GLB shipped no texture
    // at all — otherwise the net remains a solid rectangle without the
    // through-holes that make it visually read as a net.
    if (!mat.map && !mat.alphaMap) {
      mat.alphaMap = getNetMeshAlphaMap();
    }
    // Alpha cutout: preserves textured mesh holes without fade-out. Threshold
    // 0.5 keeps grid strings fully opaque and clips the transparent gaps.
    if (mat.map || mat.alphaMap) {
      mat.transparent = false;
      mat.alphaTest = 0.5;
      mat.depthWrite = true;
    } else {
      mat.transparent = false;
      mat.opacity = 1.0;
    }
    mat.side = THREE.DoubleSide;
    // Brighten a touch — the stock color is often mid-gray, which disappears
    // in typical rooms. Keep the artist's hue, just lift toward white.
    if (mat.color) mat.color.lerp(new THREE.Color(0xffffff), 0.35);
    mat.needsUpdate = true;
    matched.push(node.name || '(unnamed)');
  });
  console.log('Net visibility enhancement applied to:', matched.length ? matched : '(no meshes matched — check GLB node names)');
}

// P16 §2.5: table roughness clamped to [0.35, 0.45]. With the P16 rig's
// near-vertical key (0.6, 5, 0.4), the mirror-angle bounce lands on the
// table far away from the player's eyeline, so we no longer need a fully
// matte surface to hide a moving hotspot — and the mid-roughness reads
// more like real ITTF venue felt-on-wood than the chalky 0.75+ it used to
// force. Glare check per §2.5: if a hotspot ever lands in the eyeline
// from serve or wide-forehand, nudge key azimuth ±15°, not this range.
// specularIntensity kept at 0.3 to tame any KHR_materials_specular boost
// authored into the GLB. Net meshes skipped — they have their own
// material pipeline in enhanceNetVisibility.
function matteTableSurface(root) {
  root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const nodeName = (node.name || '').toLowerCase();
    const matName  = (node.material.name || '').toLowerCase();
    if (nodeName.includes('net') || matName.includes('net')) return;
    const mat = node.material;
    if ('roughness' in mat) {
      const cur = mat.roughness ?? 0.5;
      mat.roughness = THREE.MathUtils.clamp(cur, 0.35, 0.45);
    }
    if ('specularIntensity' in mat) mat.specularIntensity = 0.3;
    mat.needsUpdate = true;
  });
}

// Mark table meshes as shadow receivers so the ball's real cast shadow lands
// on the play surface (and side rails). The net is intentionally skipped —
// its alphaTest cutout would produce speckled shadow through the grid holes.
// Not setting castShadow on the table: the ball is the only small dynamic
// caster we care about, and every extra caster costs a shadow-map draw.
function applyTableShadowFlags(root) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    const nodeName = (node.name || '').toLowerCase();
    const matName  = (node.material?.name || '').toLowerCase();
    const isNet = nodeName.includes('net') || matName.includes('net');
    if (isNet) return;
    node.receiveShadow = true;
  });
}

export async function loadModels(loadingScreen, statusEl) {
  if (modelsLoaded) return;
  if (loadingScreen) loadingScreen.style.display = 'flex';

  try {
    const [paddleGltf, tableGltf] = await Promise.all([
      loader.loadAsync('models/Paddle.glb'),
      loader.loadAsync('models/Table.glb'),
    ]);

    // --- Table ---
    tableModel = tableGltf.scene;
    scene.add(tableModel);

    // Force the net's material to render its grid crisply. The GLB ships
    // with alpha-blended net material that fades to near-invisible against
    // AR pass-through; alpha-test gives a hard cutout instead so the mesh
    // pattern reads as opaque strings + real holes. Also drops opacity to 1
    // and sets DoubleSide so the net is visible from both sides of the
    // table. Runs on any mesh whose node name contains 'net' (case-insensitive).
    enhanceNetVisibility(tableModel);
    matteTableSurface(tableModel);
    applyTableShadowFlags(tableModel);

    const rawBox = new THREE.Box3().setFromObject(tableModel);
    const tableLength = rawBox.max.z - rawBox.min.z;
    const nearEdgeOffset = -0.3 - rawBox.max.z;
    tableModel.position.set(0, 0, nearEdgeOffset);

    // Derive play-surface bounds and net AABB from the named anchor empties
    // baked into Table.glb. setFromObject(tableModel) is too generous — it
    // unions every primitive (legs, net plane, side markings), so the X span
    // ends up ~15 cm wider than the actual blue felt. The artist-authored
    // Edge_*, TableCenter, and NetCenter empties give exact play-area bounds.
    tableModel.updateMatrixWorld(true);
    const getAnchor = (name) => {
      const node = tableModel.getObjectByName(name);
      if (!node) throw new Error(`Table.glb is missing anchor '${name}'`);
      return node.getWorldPosition(new THREE.Vector3());
    };
    const edgeLeft  = getAnchor('Edge_Left');
    const edgeRight = getAnchor('Edge_Right');
    const edgeFar   = getAnchor('Edge_Far');
    const edgeNear  = getAnchor('Edge_Near');
    const tableCtr  = getAnchor('TableCenter');

    tableSurfaceY = tableCtr.y;
    tableBox = new THREE.Box3(
      new THREE.Vector3(edgeLeft.x,  tableSurfaceY - 0.02, edgeFar.z),
      new THREE.Vector3(edgeRight.x, tableSurfaceY,        edgeNear.z),
    );
    console.log('Table play-surface bounds:', tableBox.min, tableBox.max);
    console.log('Table length:', tableLength, 'Surface Y:', tableSurfaceY);

    // --- Ball ---
    // Procedural sphere at the real 40 mm ITTF diameter (radius 0.02 m).
    // Never scaled up "for visibility": if the visual ball is larger than
    // the physics ball, contact points stop matching what players see, and
    // that mismatch is felt in VR before it's articulated. Visibility is
    // solved by rendering (matte material + envMap + rim light + blob
    // shadow), not by size.
    //
    // The mesh lives inside a wrapper Group. The wrapper (`ballModel`) is
    // the single node physics writes to: world position AND accumulating
    // world-frame spin quaternion. Squash-and-stretch is applied downstream
    // as a vertex-buffer deformation on the inner mesh (see setBallSquash /
    // updateBallSquashAmount / resetBallSquash), not through the transform
    // hierarchy — otherwise a parent scale/quaternion would corrupt the
    // child's world spin axis for the duration of the squash window.
    ballModel = new THREE.Group();

    const ballGeom = new THREE.SphereGeometry(0.02, 32, 24);
    const ballTex  = createBallSeamTexture();
    // P16 §2.7: roughness 0.6 (matte-with-microspecular, matches real ITTF
    // celluloid better than fully-flat 0.85), metalness 0. envMap wired
    // with clamped intensity (§2.6): 0.15 is the ceiling that gives the
    // ball a hair of environmental brightness without reintroducing the
    // "glowing plastic" halo that the old ACES+exposure 1.2 combo produced.
    // toneMapped explicit (defends against future material clones that
    // might inherit a false). emissive stays black — enforced by Step 0.1.
    const ballMat = new THREE.MeshStandardMaterial({
      map: ballTex,
      color: new THREE.Color(BALL_COLORS[currentBallColorId].base),
      roughness: 0.6,
      metalness: 0.0,
      envMap: ballEnvMap,
      envMapIntensity: 0.15,
      toneMapped: true,
    });
    const ballMesh = new THREE.Mesh(ballGeom, ballMat);
    // castShadow OFF: the blob shadow (see ballShadow.js) is the sole ground-
    // contact cue. Enabling castShadow rendered a SECOND shadow via the
    // angled directional light at (2, 4, 3), landing offset from the blob's
    // directly-below position and reading as two shadows in headset. Spec:
    // "the blob is the load-bearing one." Also, PCFSoft on a 40 mm caster
    // at 2.7 m flickers because the shadow map can't resolve the ball edge.
    ballMesh.castShadow = false;
    ballMesh.receiveShadow = false;
    ballModel.add(ballMesh);
    ballModel.visible = false;
    scene.add(ballModel);

    // Register the mesh for wrist-menu color swap (setBallColor mutates
    // mat.color on every entry).
    _ballMaterialMeshes.length = 0;
    _ballMaterialMeshes.push(ballMesh);

    // Cache the pristine vertex positions BEFORE any render or squash call,
    // so the squash system has a clean baseline to restore each frame.
    _ballSquashMeshes.length = 0;
    _ballSquashMeshes.push({
      mesh: ballMesh,
      originalPositions: new Float32Array(ballGeom.getAttribute('position').array),
    });

    // Ball radius is now a hard fact of the geometry, not a bbox reading —
    // physics uses this same 0.02 constant for collision shapes.
    ballRadius = 0.02;
    console.log('Ball radius:', ballRadius);

    // Motion trail — sibling of ballModel in the scene (NOT a child, so it
    // stays where the ball WAS). Threshold-gated on speed; see ballTrail.js.
    createBallTrail(scene);

    // Blob shadow — soft radial-gradient quad on the table surface that
    // follows the ball's XZ and fades/shrinks with height. Load-bearing
    // depth cue for a 4 cm object flying at the player in VR; see
    // ballShadow.js. Needs tableSurfaceY, already extracted above.
    createBallShadow(scene, tableSurfaceY);

    // Mirror-ghost reflection (P16 §3.2) — dim mirrored copy below the
    // table plane, visible only when ball is within 0.5 m over the table
    // AND within the table rect. Companion depth cue to the blob for the
    // near-bounce moment. Needs the ball mesh (for shared geometry + map
    // + live color) and tableBox (rect gate).
    createBallGhost(scene, ballMesh, tableSurfaceY, tableBox);

    // Net AABB — derived from NetCenter (top-center of the net) plus the
    // GLB's known net dimensions. NetCenter.y is the *top* of the net, the
    // base sits on the play surface. Net plane overhangs the play surface
    // by ~14 cm each side (regulation TT geometry). Inflated by ballRadius
    // as a Minkowski-sum swept-sphere approximation for the AABB slab test.
    const netCtr = getAnchor('NetCenter');
    const NET_OVERHANG = 0.14;
    const NET_HALF_X = Math.max(Math.abs(edgeLeft.x), Math.abs(edgeRight.x)) + NET_OVERHANG;
    const NET_THICKNESS = 0.01;
    netBox = new THREE.Box3(
      new THREE.Vector3(netCtr.x - NET_HALF_X, tableSurfaceY, netCtr.z - NET_THICKNESS / 2),
      new THREE.Vector3(netCtr.x + NET_HALF_X, netCtr.y,      netCtr.z + NET_THICKNESS / 2),
    ).expandByScalar(ballRadius);
    console.log('Net bounds (inflated):', netBox.min, netBox.max);

    // --- Paddle ---
    paddleModel = paddleGltf.scene;
    paddleModel.rotation.x = PADDLE_EULER_X;
    paddleModel.rotation.y = PADDLE_EULER_Y;
    paddleModel.rotation.z = PADDLE_EULER_Z;

    // Compute paddle face geometry for disc collision.
    // Step 1: bbox BEFORE rotation to understand the model's axes.
    const savedRotX = paddleModel.rotation.x;
    const savedRotY = paddleModel.rotation.y;
    const savedRotZ = paddleModel.rotation.z;
    paddleModel.rotation.set(0, 0, 0);
    paddleModel.updateMatrixWorld(true);
    const unrotatedBox = new THREE.Box3().setFromObject(paddleModel);
    const unrotatedSize = unrotatedBox.getSize(new THREE.Vector3());

    // Step 2: thinnest axis = face normal direction; longest axis = handle→head.
    const dims = [
      { axis: 'x', size: unrotatedSize.x },
      { axis: 'y', size: unrotatedSize.y },
      { axis: 'z', size: unrotatedSize.z },
    ];
    dims.sort((a, b) => a.size - b.size);
    const thinAxis = dims[0].axis;
    const longAxis = dims[2].axis;

    const faceNormalModel = new THREE.Vector3(
      thinAxis === 'x' ? 1 : 0,
      thinAxis === 'y' ? 1 : 0,
      thinAxis === 'z' ? 1 : 0,
    );

    const faceCenterModel = new THREE.Vector3();
    const longMin = unrotatedBox.min[longAxis];
    const longMax = unrotatedBox.max[longAxis];
    const headEnd = Math.abs(longMin) > Math.abs(longMax) ? longMin : longMax;
    faceCenterModel[longAxis] = headEnd * 0.65;

    const medAxis = dims[1].axis;
    paddleHitRadius = Math.max(unrotatedSize[medAxis] / 2, 0.09);
    paddleHalfThickness = unrotatedSize[thinAxis] / 2;

    // Step 3: restore rotation, compute controller-local-space vectors.
    paddleModel.rotation.set(savedRotX, savedRotY, savedRotZ);
    const paddleLocalQuat = new THREE.Quaternion().setFromEuler(paddleModel.rotation);
    paddleFaceNormalLocal.copy(faceNormalModel).applyQuaternion(paddleLocalQuat).normalize();
    paddleFaceOffset.copy(faceCenterModel).applyQuaternion(paddleLocalQuat);

    console.log('Paddle model size (unrotated):', unrotatedSize);
    console.log('Thin/normal axis:', thinAxis, '| Long/handle axis:', longAxis);
    console.log('Face normal (controller-local):', paddleFaceNormalLocal);
    console.log('Face center offset (controller-local):', paddleFaceOffset);
    console.log('Paddle face hit radius:', paddleHitRadius);

    if (SELF_TEST) {
      debugFaceSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.01, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x00ff00 })
      );
      scene.add(debugFaceSphere);

      debugNormalArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.15, 0xff0000
      );
      scene.add(debugNormalArrow);

      debugDiscMesh = new THREE.Mesh(
        new THREE.RingGeometry(0, paddleHitRadius + ballRadius, 32),
        new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true, side: THREE.DoubleSide })
      );
      scene.add(debugDiscMesh);

      initDebugHud();
      runCollisionSelfTest();
    }

    if (loadingScreen) loadingScreen.style.display = 'none';
    modelsLoaded = true;
    console.log('All models loaded successfully');
  } catch (err) {
    console.error('Failed to load models:', err);
    if (loadingScreen) loadingScreen.style.display = 'none';
    if (statusEl) statusEl.textContent = 'Failed to load 3D models. Check console for details.';
    throw err;
  }
}

export function getDebugHelpers() {
  return { debugFaceSphere, debugNormalArrow, debugDiscMesh };
}

// --- Collision Self-Test ---
// Validates geometry and disc-collision math against the actual loaded model.
function runCollisionSelfTest() {
  const results = [];
  function test(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`[COLLISION TEST] ${pass ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
  }

  const testControllerPos = new THREE.Vector3(0, 1, 0);
  const testControllerQuat = new THREE.Quaternion();
  const testFaceCenter = paddleFaceOffset.clone();
  if (paddleModel) testFaceCenter.add(new THREE.Vector3(0, 0.005, -0.02));
  testFaceCenter.applyQuaternion(testControllerQuat).add(testControllerPos);
  const testFaceNormal = paddleFaceNormalLocal.clone().applyQuaternion(testControllerQuat).normalize();

  const offsetMag = paddleFaceOffset.length();
  const normalLen = paddleFaceNormalLocal.length();
  const geomOk = paddleHitRadius >= 0.05 && paddleHitRadius <= 0.20 &&
                 offsetMag >= 0.02 && offsetMag <= 0.30 &&
                 Math.abs(normalLen - 1.0) < 0.01;
  test('Geometry sanity',
    geomOk,
    `hitRadius=${paddleHitRadius.toFixed(4)}, offsetMag=${offsetMag.toFixed(4)}, normalLen=${normalLen.toFixed(4)}`);

  const nyAbs = Math.abs(paddleFaceNormalLocal.y);
  const nzAbs = Math.abs(paddleFaceNormalLocal.z);
  const orientOk = nyAbs > 0.1 || nzAbs > 0.1;
  test('Normal orientation',
    orientOk,
    `normalLocal=(${paddleFaceNormalLocal.x.toFixed(3)}, ${paddleFaceNormalLocal.y.toFixed(3)}, ${paddleFaceNormalLocal.z.toFixed(3)})`);

  {
    const prev = testFaceCenter.clone().addScaledVector(testFaceNormal, 0.1);
    const curr = testFaceCenter.clone().addScaledVector(testFaceNormal, -0.1);
    const r = detectDiscCollision(prev, curr, testFaceCenter, testFaceCenter,
                                   testFaceNormal, testFaceNormal, paddleHitRadius, ballRadius, 0.016);
    test('Plane crossing (sign change)',
      r.crossed && r.dPrev * r.dCurr < 0,
      `dPrev=${r.dPrev.toFixed(4)}, dCurr=${r.dCurr.toFixed(4)}, crossed=${r.crossed}`);
  }

  {
    const prev = testFaceCenter.clone().addScaledVector(testFaceNormal, ballRadius + 0.02);
    const curr = testFaceCenter.clone().addScaledVector(testFaceNormal, ballRadius * 0.5);
    const r = detectDiscCollision(prev, curr, testFaceCenter, testFaceCenter,
                                   testFaceNormal, testFaceNormal, paddleHitRadius, ballRadius, 0.016);
    test('Plane crossing (gentle contact)',
      r.crossed,
      `dPrev=${r.dPrev.toFixed(4)}, dCurr=${r.dCurr.toFixed(4)}, crossed=${r.crossed}`);
  }

  {
    const prev = testFaceCenter.clone().addScaledVector(testFaceNormal, 0.05);
    const curr = testFaceCenter.clone().addScaledVector(testFaceNormal, -0.05);
    const r = detectDiscCollision(prev, curr, testFaceCenter, testFaceCenter,
                                   testFaceNormal, testFaceNormal, paddleHitRadius, ballRadius, 0.016);
    test('Radial check (hit at center)',
      r.hit && r.radialDist < 0.001,
      `hit=${r.hit}, radialDist=${r.radialDist?.toFixed(4)}`);
  }

  {
    const tangent = new THREE.Vector3(1, 0, 0);
    if (Math.abs(testFaceNormal.dot(tangent)) > 0.9) tangent.set(0, 1, 0);
    tangent.cross(testFaceNormal).normalize();
    const farOffset = tangent.multiplyScalar(paddleHitRadius + ballRadius + 0.1);
    const prev = testFaceCenter.clone().add(farOffset).addScaledVector(testFaceNormal, 0.05);
    const curr = testFaceCenter.clone().add(farOffset).addScaledVector(testFaceNormal, -0.05);
    const r = detectDiscCollision(prev, curr, testFaceCenter, testFaceCenter,
                                   testFaceNormal, testFaceNormal, paddleHitRadius, ballRadius, 0.016);
    test('Radial check (miss outside disc)',
      r.crossed && !r.hit,
      `crossed=${r.crossed}, hit=${r.hit}, radialDist=${r.radialDist?.toFixed(4)}`);
  }

  {
    const incomingVel = testFaceNormal.clone().multiplyScalar(-2.0);
    const dt = 0.016;
    const prev = testFaceCenter.clone().addScaledVector(testFaceNormal, 0.05);
    const curr = prev.clone().addScaledVector(incomingVel, dt);
    const r = detectDiscCollision(prev, curr, testFaceCenter, testFaceCenter,
                                   testFaceNormal, testFaceNormal, paddleHitRadius, ballRadius, dt);
    let reflectedAway = false;
    if (r.hit && r.reflectNormal) {
      const velDot = incomingVel.dot(r.reflectNormal);
      const reflected = incomingVel.clone().sub(r.reflectNormal.clone().multiplyScalar(2 * velDot));
      reflectedAway = reflected.dot(r.reflectNormal) > 0;
    }
    test('End-to-end (hit + reflection)',
      r.hit && reflectedAway,
      `hit=${r.hit}, reflectedAway=${reflectedAway}`);
  }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`[COLLISION TEST] === ${passed}/${total} ${passed === total ? 'PASSED' : 'PASSED, ' + (total - passed) + ' FAILED'} ===`);

  if (passed < total) {
    const el = document.createElement('div');
    el.textContent = `COLLISION TEST: ${total - passed} FAILED`;
    el.style.cssText = 'position:fixed;top:8px;left:8px;background:red;color:white;padding:4px 8px;font:12px monospace;z-index:999;border-radius:4px;';
    document.body.appendChild(el);
  }
}
