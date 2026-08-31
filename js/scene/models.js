import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { scene, renderer } from './sceneSetup.js';
import { SELF_TEST } from './hud.js';
import { detectDiscCollision } from '../physics/collisions.js';
// compositeSpinMarkings stamps spin-legibility markings (cert dots + faint
// arcs) onto Ball.glb's baked base-color map at load — the authored map is a
// near-uniform gray whose rotation is invisible without them. The procedural
// createBallSeamTexture is only used by the commented-out fallback ball.
import { compositeSpinMarkings } from './ballTexture.js';
// import { createBallSeamTexture } from './ballTexture.js';
import { createBallShadow } from './ballShadow.js';
import { createBallGhost } from './ballGhost.js';
import { refineBallGeometry } from './ballGeometry.js';
import { ballEnvMap } from './sceneSetup.js';
import { enhancePaddleMaterial } from './paddleMaterial.js';
import { buildProceduralPaddle } from './paddleGeometry.js';
import { setPaddleSpec, paddleSpecOverridesFromQuery } from '../physics/paddleSpec.js';
import { deriveHandleGripPreset } from '../xr/handleGrip.js';
import { registerDerivedPreset } from '../xr/calibrationPresets.js';

const loader = new GLTFLoader();

// Load-time geometry diagnostics stay out of the production console; warnings
// and errors still go through console.warn/error unconditionally.
const logInfo = (...args) => { if (SELF_TEST) console.log(...args); };

// Paddle asset selection. The re-authored Paddle.glb is now the DEFAULT; the
// procedural bat (scene/paddleGeometry.js, defined by physics/paddleSpec.js)
// stays loadable behind `?paddle=procedural` so the two can still be compared
// in the same session rather than across builds. Both go through the SAME
// measurement code below, so a difference you see in headset is a difference in
// the asset, not in the path.
//
// The new GLB ships the full anchor set the measurement code requires
// (EdgeTop/EdgeBottom/EdgeLeft/EdgeRight, plus HandleEnd/SweetSpot/BladeNormal)
// as children of the single blade mesh node, so the disc center, hit radius and
// blade half-thickness are all derived from artist-authored geometry exactly as
// before — no private shortcut for either asset.
function useGlbPaddle() {
  if (typeof location === 'undefined') return true;
  return new URLSearchParams(location.search).get('paddle') !== 'procedural';
}

// Previous selection — procedural by default, GLB behind `?paddle=glb`. Kept
// commented rather than deleted so flipping the default back is a one-line
// swap if the new asset regresses in headset.
// function useGlbPaddle() {
//   if (typeof location === 'undefined') return false;
//   return new URLSearchParams(location.search).get('paddle') === 'glb';
// }

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
// The textured net node baked into Table.glb (named 'Net') — see loadModels.
// Was a standalone models/Net.glb until the 2026-08-29 combined export.
export let netModel = null;
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
// geometric fallback for meshes that don't use that naming — e.g. the table
// mesh in the combined TableTennis export ships 6 materials
// (Material.001..006) with no 'net' substring anywhere, so its legacy net
// primitive renders as an authored pure-black solid plane (invisible against
// dark scene backgrounds) that only geometry can identify. The fallback
// matches any thin (dz<3 cm) vertical (dy>5 cm) wide (dx>1 m) plane centered
// near the table's z=0 line, which is how a regulation TT net is always
// modelled regardless of naming.
//
// If the detected net's material has neither a baseColor map nor an alphaMap,
// we install the procedural mesh grid so the visible cue "strings + holes"
// exists — a solid plane, even lifted from black, still reads as "wrong slab"
// rather than "TT net" because the eye looks for the mesh pattern.
//
// Detection (isNetMesh) is factored out of the material rewrite because two
// callers need it: enhanceNetVisibility, which restyles the textured 'Net'
// node, and hideTableNet, which switches off the legacy black net plane also
// present in Table.glb. Sharing one predicate is what guarantees the mesh we
// hide is exactly the mesh the old code used to enhance.
//
// The geometric fallback measures in WORLD space, not geometry-local: the
// 2026-08-29 combined export puts a x0.01 scale on the 'TableTennis' node, so
// raw accessor bounds are 100x world size and a local-space threshold test
// silently matches nothing. Both callers run before the table is re-placed
// (tableModel still at the origin), so world coordinates here are still the
// asset's authored space and the |cz| < 0.05 net-line test stays valid.
// Callers must updateMatrixWorld(true) on their root first.
const _netMeshBox = new THREE.Box3();
function isNetMesh(node) {
  if (!node.isMesh || !node.material) return false;
  const nodeName = (node.name || '').toLowerCase();
  const matName  = (node.material.name || '').toLowerCase();
  if (nodeName.includes('net') || matName.includes('net')) return true;
  if (!node.geometry) return false;
  const bb = _netMeshBox.setFromObject(node);
  if (bb.isEmpty()) return false;
  const dx = bb.max.x - bb.min.x;
  const dy = bb.max.y - bb.min.y;
  const dz = bb.max.z - bb.min.z;
  const cz = (bb.min.z + bb.max.z) / 2;
  return dz < 0.03 && dy > 0.05 && dx > 1.0 && Math.abs(cz) < 0.05;
}

// Hide the solid-black net plane baked into Table.glb's table mesh. The
// table asset is authored with a crude net as part of the table geometry — a
// 1.80 m × 0.14 m pure-black untextured plane at z≈0 — which duplicates the
// textured 'Net' node in the same file. The two are near-coincident planes:
// drawn together they z-fight, and the black slab fills the textured net's
// see-through holes from both sides. Hidden rather than stripped from the
// asset: the GLB is kept exactly as delivered, and hiding survives any
// re-export that ships the plane again. The
// felt, rails and white lines all fail either the thin-in-z or the
// tall-enough test. The 'Net' node itself ALSO matches the predicate (by
// name), so the netModel subtree is skipped explicitly — netModel must be
// assigned before this runs.
function hideTableNet(root) {
  const hidden = [];
  root.updateMatrixWorld(true); // isNetMesh measures world-space boxes
  root.traverse((node) => {
    if (netModel && (node === netModel || netModel.getObjectById(node.id))) return;
    if (!isNetMesh(node)) return;
    node.visible = false;
    hidden.push(node.name || '(unnamed)');
  });
  logInfo('Table.glb built-in net hidden:', hidden.length ? hidden : '(none matched)');
}

// RETIRED: stripTableNetTape (see git history for the implementation).
//
// The white tape band along the net's top (part of the Material.002 mesh,
// which also carries the table's boundary and centre lines) used to be
// index-buffer-stripped at load. That was correct for the standalone-Net.glb
// era: the standalone net hung ~1 cm below the baked tape, so the tape read
// as a second, floating net. With the net now baked into Table.glb in the
// same authored assembly — netting quad, tape, posts — the tape sits where a
// real net's white top tape sits, and stripping it just made the net look
// incomplete (reported from headset 2026-08-29). The assembled net is now
// used exactly as authored: textured mesh + white tape + posts.

function enhanceNetVisibility(root) {
  const matched = [];
  root.traverse((node) => {
    if (!isNetMesh(node)) return;

    const mat = node.material;
    // Install the procedural mesh alpha map when the GLB shipped no texture
    // at all — otherwise the net remains a solid rectangle without the
    // through-holes that make it visually read as a net.
    if (!mat.map && !mat.alphaMap) {
      mat.alphaMap = getNetMeshAlphaMap();
    }
    // Alpha-to-coverage cutout: preserves the textured mesh holes without
    // blend-sorting artifacts, and — because coverage is resolved through
    // MSAA (renderer is antialias: true, and the WebXR session framebuffer is
    // antialiased too) — the thin strings get PARTIAL pixel coverage instead
    // of a hard keep/discard per sample.
    //
    // Why not plain alphaTest? Both of its configurations fail on this map
    // (TT_Net: binary alpha, ~24% opaque string coverage):
    //   - alphaTest 0.5 + mipmaps: every mip below the top averages to ~0.24
    //     alpha, under the threshold, so the whole net VANISHES beyond a
    //     couple of metres (verified in desktop preview).
    //   - alphaTest 0.5 + mipmaps off: visible at distance, but the strings
    //     alias per-frame — a hard glitter/shimmer across the whole net,
    //     reported from headset 2026-08-29 as unstable.
    // Alpha-to-coverage keeps mipmaps ON (so distant sampling is stable and
    // the net fades toward a semi-dense weave instead of vanishing) while
    // MSAA dithers the string edges smooth. Max anisotropy stabilizes the
    // long, near-grazing view down the net line. The small 0.1 alphaTest only
    // discards fully-transparent fragments so the holes never occlude via the
    // depth buffer — it is low enough that distant mips (~0.24) still render.
    if (mat.map || mat.alphaMap) {
      mat.transparent = false;
      mat.alphaToCoverage = true;
      mat.alphaTest = 0.1;
      mat.depthWrite = true;
      for (const tex of [mat.map, mat.alphaMap]) {
        if (!tex) continue;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        tex.needsUpdate = true;
      }
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
  logInfo('Net visibility enhancement applied to:', matched.length ? matched : '(no meshes matched — check GLB node names)');
}

// Mode-dependent net compositing. Called by inGame.js once the session type
// is known (assets load inside the live XR session, so this always runs after
// enhanceNetVisibility has installed the cutout).
//
// 'ar' — keep the alpha-to-coverage cutout from enhanceNetVisibility. The
//   authored alpha-BLEND net fades to near-invisible against passthrough, so
//   MR needs the cutout; confirmed clean in headset (2026-08-29).
// 'vr' — switch the netting back to authored smooth alpha BLEND. The cutout's
//   per-pixel keep/discard edges are what shimmers under the VR compositor
//   (headset report 2026-08-29: glitter in VR, rock-solid in MR, identical
//   material — so the failure is in how VR presents hard 1-px edges, not in
//   the material config). Blending has no threshold to alias: the mipmapped
//   texture fades smoothly whatever the compositor does. Its one failure
//   mode — washing out against passthrough — cannot happen in VR's opaque
//   environments. depthWrite stays off so the semi-transparent netting never
//   occludes the ball behind it through the holes; three.js draws transparent
//   objects after the opaque pass, which handles the compositing order.
//
// Desktop preview keeps the 'ar' cutout so the MR path stays testable
// without a headset.
export function setNetXRMode(mode) {
  if (!netModel) return;
  netModel.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const mat = node.material;
    if (mode === 'vr') {
      mat.alphaToCoverage = false;
      mat.transparent = true;
      mat.alphaTest = 0;
      mat.depthWrite = false;
    } else {
      mat.alphaToCoverage = true;
      mat.transparent = false;
      mat.alphaTest = 0.1;
      mat.depthWrite = true;
    }
    mat.needsUpdate = true;
  });
  logInfo(`Net compositing set for '${mode}' session`);
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

// ITTF law 2.1.4 mandates only that the playing surface be "uniformly dark
// coloured and matt" — no specific hue. Same shape as BALL_COLORS so the
// wrist menu can render a stateful swatch from `base`. 'blue' is Table.glb's
// authored color (baseColorFactor ≈ #0D478D). Black (WTT-style) was tried
// and cut after headset testing: it merged with the dark Focus Room surround.
// `base` is the felt color applied to the 3D table. `swatch` is a brightened
// display tint for the wrist-menu chip ONLY: both ITTF felt colors are dark
// enough that the raw value reads near-black on the menu's dark panel, so
// toggling looked like nothing happened. The chip's job is to say "blue" or
// "green" at a glance, not to be colorimetrically faithful.
export const TABLE_COLORS = {
  blue:  { id: 'blue',  base: '#0d478d', swatch: '#2e7cd6' },  // tournament blue, as authored
  green: { id: 'green', base: '#1e6b47', swatch: '#2fa36c' },  // classic club green
};

// Current color id. Read by setTableColor and by the wrist menu to render
// its table-swatch button.
let currentTableColorId = 'blue';
export function getTableColorId() { return currentTableColorId; }

// Live refs to the felt material(s) found at load, so the wrist menu can
// recolor the table without re-running the hue heuristic below.
const _tableFeltMaterials = [];

// Retint the felt without touching the GLB: Table.glb's blue is a flat
// baseColorFactor (no texture) on its own material, so swapping mat.color is
// a lossless recolor. The white lines, frame/legs and net all live on other
// materials and pass through untouched.
export function setTableColor(colorId, { persist = true } = {}) {
  if (!TABLE_COLORS[colorId]) return;
  currentTableColorId = colorId;
  const newColor = new THREE.Color(TABLE_COLORS[colorId].base);
  for (const mat of _tableFeltMaterials) {
    mat.color.copy(newColor);
    mat.needsUpdate = true;
  }
  if (persist) {
    try { localStorage.setItem('tt_table_color', colorId); } catch { /* session-only */ }
  }
}

// Find the felt material(s) and apply the startup color. The felt is
// identified by hue — the only strongly blue-dominant material in the model —
// because GLB material names ('Material.001') are export artifacts that
// renumber on re-export. Startup precedence: ?table.color= dev override
// (headset-browser testing without a rebuild, same idea as ?paddle.*), then
// the persisted wrist-menu choice, then the authored blue. persist:false so
// merely loading with an override never overwrites the saved preference.
function initTableColor(root) {
  root.traverse((node) => {
    if (!node.isMesh || !node.material?.color) return;
    const c = node.material.color;
    if (!(c.b > 0.15 && c.b > c.r * 2.5 && c.b > c.g * 2.5)) return;
    if (!_tableFeltMaterials.includes(node.material)) {
      _tableFeltMaterials.push(node.material);
    }
  });
  logInfo(`Table felt material(s) found: ${_tableFeltMaterials.length}`);

  let initial = typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('table.color') : null;
  if (initial && !TABLE_COLORS[initial]) {
    logInfo(`Unknown table.color '${initial}' — expected one of:`, Object.keys(TABLE_COLORS));
    initial = null;
  }
  if (!initial) {
    try { initial = localStorage.getItem('tt_table_color'); } catch { initial = null; }
  }
  if (initial && TABLE_COLORS[initial]) setTableColor(initial, { persist: false });
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

// Loud check that the GLB-embedded base-color textures actually decoded.
//
// GLTFLoader swallows a failed texture decode: loadTextureImage catches the
// rejection and resolves to null, so the mesh loads perfectly with map = null
// and nothing is logged. Both of our textured assets — Paddle.glb's WebP
// base color and Table.glb's TT_Net PNG — went blank in production for nine
// days that way (2026-08-22 → 08-31): the hosting CSP shipped
// `connect-src 'self' https://*.googleapis.com`, which does not allow blob:,
// and GLTFLoader decodes embedded images by fetching a blob: object URL
// through ImageBitmapLoader on every browser except old Safari/Firefox.
// img-src DID allow blob:, so nothing else on the page broke and the console
// stayed clean.
//
// A console.error, not a throw: unlike the missing-node checks below (a
// Table.glb without its 'Net' is a broken asset), a texture that failed to
// decode is a runtime/environment condition — the game is still playable
// untextured, and bricking a live session over cosmetics is the wrong trade.
// The message names the CSP because that is the only cause we have seen.
function assertGlbTexturesDecoded() {
  const missing = [];
  const check = (root, label) => {
    if (!root) return;
    root.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of mats) if (!mat.map) missing.push(`${label}/${node.name || '(unnamed)'}`);
    });
  };
  // Only the GLB bat ships a base-color map; the procedural one paints with
  // per-material colors and is expected to have none.
  if (useGlbPaddle()) check(paddleModel, 'Paddle.glb');
  check(netModel, "Table.glb 'Net'");
  if (!missing.length) return;
  console.error(
    '[models] GLB base-color texture(s) failed to decode — rendering untextured: '
    + missing.join(', ')
    + '. GLTFLoader fetches embedded images as blob: URLs via ImageBitmapLoader, '
    + "so the hosting Content-Security-Policy must list blob: in connect-src "
    + '(img-src alone is not enough). Check the CSP header in firebase.json.',
  );
}

export async function loadModels(loadingScreen, statusEl) {
  if (modelsLoaded) return;
  if (loadingScreen) loadingScreen.style.display = 'flex';

  try {
    // Spec overrides (`?paddle.handleLength=0.11`) are applied BEFORE the mesh
    // is built, so the geometry, the collision disc and the mass properties all
    // see the same numbers. Applying them later would leave the bat you swing
    // and the bat physics thinks you're holding out of sync.
    const glbPaddle = useGlbPaddle();
    if (!glbPaddle && typeof location !== 'undefined') {
      const overrides = paddleSpecOverridesFromQuery(location.search);
      if (Object.keys(overrides).length) {
        logInfo('Paddle spec overrides:', overrides);
        setPaddleSpec(overrides);
      }
    }

    const [paddleGltf, tableGltf, ballGltf] = await Promise.all([
      glbPaddle ? loader.loadAsync('models/Paddle.glb') : Promise.resolve(null),
      loader.loadAsync('models/Table.glb'),
      loader.loadAsync('models/Ball.glb'),
    ]);

    // --- Table (and its baked-in net) ---
    tableModel = tableGltf.scene;
    scene.add(tableModel);

    // --- Net (Table.glb node 'Net') ---
    // The net ships baked into Table.glb as its own named node — a single
    // textured quad hung at the net line (x -0.96..0.82, y 0.79..0.93, z=0),
    // formerly the standalone models/Net.glb, merged into the table export
    // 2026-08-29 so the two can never drift out of sync. Fail-loud on a
    // missing node, same policy as the anchors below: a Table.glb without its
    // net is a broken asset, not a runtime condition.
    //
    // Found FIRST because hideTableNet must skip this subtree — the node is
    // named 'Net', so the shared isNetMesh predicate matches it just like the
    // legacy black plane it exists to replace.
    //
    // enhanceNetVisibility: the GLB authors the net as alpha-BLEND, which
    // fades to near-invisible against AR pass-through, so it is switched to a
    // hard alphaTest cutout that keeps the strings opaque and the holes
    // genuinely see-through. The GLB ships an RGBA mesh texture, so the
    // procedural grid alphaMap in that function is not used here.
    netModel = tableModel.getObjectByName('Net');
    if (!netModel) throw new Error("Table.glb is missing its 'Net' node");
    enhanceNetVisibility(netModel);

    // Hide the solid-black duplicate net plane baked into the table mesh
    // before anything else measures or restyles the table, so the textured
    // node above is the only net drawn.
    hideTableNet(tableModel);

    matteTableSurface(tableModel);
    initTableColor(tableModel);
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
    const netCtr    = getAnchor('NetCenter');

    tableSurfaceY = tableCtr.y;
    tableBox = new THREE.Box3(
      new THREE.Vector3(edgeLeft.x,  tableSurfaceY - 0.02, edgeFar.z),
      new THREE.Vector3(edgeRight.x, tableSurfaceY,        edgeNear.z),
    );
    logInfo('Table play-surface bounds:', tableBox.min, tableBox.max);
    logInfo('Table length:', tableLength, 'Surface Y:', tableSurfaceY);

    // The net's white top tape (baked into the table mesh) is kept as
    // authored — a stripTableNetTape pass used to delete it here; see the
    // RETIRED note below hideTableNet for why it no longer runs.

    // --- Ball ---
    // models/Ball.glb, authored at the real 40 mm ITTF diameter (radius
    // 0.02 m) with its own baked base-color texture. Never scaled up "for
    // visibility": if the visual ball is larger than the physics ball, contact
    // points stop matching what players see, and that mismatch is felt in VR
    // before it's articulated. Visibility is solved by rendering (matte
    // material + envMap + rim light + blob shadow), not by size.
    //
    // The GLB's meshes live inside a wrapper Group. The wrapper (`ballModel`)
    // is the single node physics writes to: world position AND accumulating
    // world-frame spin quaternion. Squash-and-stretch is applied downstream
    // as a vertex-buffer deformation on the inner meshes (see setBallSquash /
    // updateBallSquashAmount / resetBallSquash), not through the transform
    // hierarchy — otherwise a parent scale/quaternion would corrupt the
    // child's world spin axis for the duration of the squash window.
    ballModel = new THREE.Group();

    const ballRoot = ballGltf.scene;
    const ballMeshes = [];
    ballRoot.traverse((node) => { if (node.isMesh && node.geometry) ballMeshes.push(node); });
    if (ballMeshes.length === 0) throw new Error('Ball.glb contains no mesh');

    // Silhouette refinement — Ball.glb ships at 960 tris (~32-segment rim),
    // which reads as a polygon instead of a circle in the last ~30 cm before
    // paddle contact. Subdivide-and-reproject to ≥3000 tris at load (see
    // ballGeometry.js). MUST run here, before the squash system caches vertex
    // positions and before createBallGhost captures the geometry reference,
    // so every consumer sees the refined buffer. Radius is preserved exactly,
    // so the 40 mm physics/visual match check below is unaffected.
    for (const mesh of ballMeshes) {
      const refined = refineBallGeometry(mesh.geometry);
      if (refined !== mesh.geometry) {
        mesh.geometry.dispose();
        mesh.geometry = refined;
      }
    }

    // Material tuning, applied ON TOP of the GLB's authored base-color map
    // rather than replacing it — the same numbers the procedural ball used, so
    // swapping the asset does not silently change how the ball responds to the
    // lighting rig.
    //
    // P16 §2.7: roughness 0.6 (matte-with-microspecular, matches real ITTF
    // celluloid better than fully-flat 0.85), metalness 0.
    // toneMapped explicit (defends against future material clones that
    // might inherit a false). emissive stays black — enforced by Step 0.1.
    //
    // envMapIntensity 0.40, raised from the 0.15 that §2.6 set as a ceiling
    // against the "glowing plastic" halo. Two things justify reopening it:
    //
    //   1. That ceiling was measured against ACES at exposure 1.2. The
    //      pipeline is now NeutralToneMapping at 1.0, which rolls highlights
    //      off instead of clipping them, so the halo it was guarding against
    //      no longer forms at the same intensity.
    //   2. The ball's dark side had no light source at all. The key is
    //      near-vertical and the hemisphere fill's ground colour is 0x3a3830,
    //      a dark warm brown standing in for a wooden floor — but a ball in
    //      play flies over a large, brightly-lit table, which in reality
    //      bounces a lot of light back up onto it. With nothing modelling
    //      that, the lower hemisphere fell away to near-black and the ball
    //      read as dim and hard to pick out.
    //
    // The env map (a neutral RoomEnvironment PMREM) is the right lever for
    // this rather than the lights: it is per-material, so it lifts the ball
    // without touching the paddle, table or arena, and at roughness 0.6 it
    // arrives as a soft wrap rather than a specular hotspot. Measured in
    // ball-preview.html — 0.70 visibly flattens the sphere's shading
    // gradient (the actual "glowing plastic" failure mode), 0.40 lifts the
    // shadow side while keeping the gradient that makes it read as round.
    //
    // specularColor/specularIntensity: Ball.glb authors
    // KHR_materials_specular specularColorFactor [2,2,2], a 2× boost over
    // physical that the loader maps onto MeshPhysicalMaterial. Left alone it
    // puts a hard travelling hotspot on a fast-moving 40 mm sphere (the
    // "strobe-lit ball" arenaLighting.js already calls out); clamped to
    // physical white at the same 0.3 intensity matteTableSurface uses.
    for (const mesh of ballMeshes) {
      const mat = mesh.material;
      if (mat.color) mat.color.set(BALL_COLORS[currentBallColorId].base);
      mat.roughness = 0.6;
      mat.metalness = 0.0;
      mat.envMap = ballEnvMap;
      mat.envMapIntensity = 0.40;
      mat.toneMapped = true;
      if (mat.specularColor) mat.specularColor.setRGB(1, 1, 1);
      if ('specularIntensity' in mat) mat.specularIntensity = 0.3;
      // Spin legibility — the authored map is a near-uniform gray (~1%
      // island/background contrast) with one logo on one hemisphere; a ball
      // wearing it reads as a featureless sphere, and a featureless sphere's
      // rotation is invisible no matter how much spin the physics imparts.
      // Composite cert dots + faint arcs onto both hemisphere islands at
      // load. Idempotent, so shared materials across meshes are safe.
      if (mat.map) mat.map = compositeSpinMarkings(mat.map);
      mat.needsUpdate = true;
      // castShadow OFF: the blob shadow (see ballShadow.js) is the sole ground-
      // contact cue. Enabling castShadow rendered a SECOND shadow via the
      // angled directional light at (2, 4, 3), landing offset from the blob's
      // directly-below position and reading as two shadows in headset. Spec:
      // "the blob is the load-bearing one." Also, PCFSoft on a 40 mm caster
      // at 2.7 m flickers because the shadow map can't resolve the ball edge.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
    const ballMesh = ballMeshes[0];
    ballModel.add(ballRoot);
    ballModel.visible = false;
    scene.add(ballModel);

    // Previous ball — a procedural 32×24 sphere carrying the generated
    // seam+logo texture from scene/ballTexture.js. Superseded by Ball.glb.
    // NOTE: an earlier version of this comment claimed the GLB "bakes an
    // equivalent off-axis marking into its own map" — it does not (measured:
    // near-uniform gray, one logo on one hemisphere, nothing on the other),
    // which is why compositeSpinMarkings above adds the rotational-symmetry
    // break at load. Kept commented as the fallback if the GLB is pulled.
    // const ballGeom = new THREE.SphereGeometry(0.02, 32, 24);
    // const ballTex  = createBallSeamTexture();
    // const ballMat = new THREE.MeshStandardMaterial({
    //   map: ballTex,
    //   color: new THREE.Color(BALL_COLORS[currentBallColorId].base),
    //   roughness: 0.6,
    //   metalness: 0.0,
    //   envMap: ballEnvMap,
    //   envMapIntensity: 0.40,
    //   toneMapped: true,
    // });
    // const ballMesh = new THREE.Mesh(ballGeom, ballMat);
    // ballMesh.castShadow = false;
    // ballMesh.receiveShadow = false;
    // ballModel.add(ballMesh);

    // Register every ball mesh for wrist-menu color swap (setBallColor mutates
    // mat.color on every entry). The GLB authors no baseColorFactor, so its
    // map arrives untinted and these multiply cleanly — white (#fafafa) is
    // effectively a no-op, orange tints the same grayscale map.
    _ballMaterialMeshes.length = 0;
    _ballMaterialMeshes.push(...ballMeshes);

    // Cache the pristine vertex positions BEFORE any render or squash call,
    // so the squash system has a clean baseline to restore each frame.
    _ballSquashMeshes.length = 0;
    for (const mesh of ballMeshes) {
      _ballSquashMeshes.push({
        mesh,
        originalPositions: new Float32Array(mesh.geometry.getAttribute('position').array),
      });
    }

    // Ball radius stays the 0.02 constant physics uses for collision shapes —
    // NOT a bbox reading, so a re-export that quietly rescales the mesh cannot
    // move the physics ball. It is checked against the asset instead: a
    // mismatch means the visual and physical balls have diverged, which is the
    // one thing this must never do silently.
    ballRadius = 0.02;
    const ballSize = new THREE.Box3().setFromObject(ballRoot).getSize(new THREE.Vector3());
    const measuredRadius = Math.max(ballSize.x, ballSize.y, ballSize.z) / 2;
    if (Math.abs(measuredRadius - ballRadius) > 0.001) {
      console.warn(`Ball.glb radius is ${measuredRadius.toFixed(4)} m but physics uses ` +
        `${ballRadius} m — re-export the asset at 40 mm diameter.`);
    }
    logInfo('Ball radius:', ballRadius, '(Ball.glb measured', measuredRadius.toFixed(4), ')');

    // Blob shadow — soft radial-gradient quad on the table surface that
    // follows the ball's XZ and fades/shrinks with height. Load-bearing
    // depth cue for a 4 cm object flying at the player in VR; see
    // ballShadow.js. Needs tableSurfaceY, already extracted above, and
    // tableBox so the blob hides once the ball leaves the table footprint
    // instead of hanging at surface height in mid-air.
    createBallShadow(scene, tableSurfaceY, tableBox);

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
    // netCtr is read once with the other anchors above.
    const NET_OVERHANG = 0.14;
    const NET_HALF_X = Math.max(Math.abs(edgeLeft.x), Math.abs(edgeRight.x)) + NET_OVERHANG;
    const NET_THICKNESS = 0.01;
    netBox = new THREE.Box3(
      new THREE.Vector3(netCtr.x - NET_HALF_X, tableSurfaceY, netCtr.z - NET_THICKNESS / 2),
      new THREE.Vector3(netCtr.x + NET_HALF_X, netCtr.y,      netCtr.z + NET_THICKNESS / 2),
    ).expandByScalar(ballRadius);
    logInfo('Net bounds (inflated):', netBox.min, netBox.max);

    // ITTF conformance check. Every rule, physics tolerance and AI envelope
    // in this codebase assumes a regulation table (2.74 × 1.525 m, net cord
    // 15.25 cm above the surface) — but the dimensions come entirely from
    // Table.glb's anchors, so a re-exported asset can silently change them
    // and with them the game's claim to play real table tennis. The ball is
    // asserted against its spec at load already (below); the table gets the
    // same treatment. Warn, don't throw: a 2 cm-off table still plays, but
    // whoever swapped the asset must see it.
    {
      const ITTF_LENGTH_M = 2.74;
      const ITTF_WIDTH_M = 1.525;
      const ITTF_NET_HEIGHT_M = 0.1525;
      const DIM_TOLERANCE_M = 0.01;
      const measured = {
        length: edgeNear.z - edgeFar.z,
        width: edgeRight.x - edgeLeft.x,
        netHeight: netCtr.y - tableSurfaceY,
      };
      const offSpec = [
        ['table length', measured.length, ITTF_LENGTH_M],
        ['table width', measured.width, ITTF_WIDTH_M],
        ['net height', measured.netHeight, ITTF_NET_HEIGHT_M],
      ].filter(([, got, want]) => Math.abs(got - want) > DIM_TOLERANCE_M);
      for (const [what, got, want] of offSpec) {
        console.warn(
          `[models] Table.glb is off ITTF spec: ${what} = ${got.toFixed(4)} m ` +
          `(regulation ${want} m). Rules, physics tuning and AI envelopes ` +
          'assume regulation geometry — re-export the asset or expect drift.',
        );
      }
    }

    // --- Paddle ---
    if (glbPaddle) {
      paddleModel = paddleGltf.scene;

      // Split rubber (matte) from wood/handle (satin) via a derived roughness
      // map, and neutralize the GLB's 2× specular boost. Without this the single
      // authored material renders the whole bat as uniform semi-gloss plastic
      // and the face/handle junction reads as a decal seam, not two materials.
      //
      // Procedural-only: skipped, because that bat is authored with one material
      // per real material already. The pass would be a no-op anyway (it needs a
      // base-color map to classify), but skipping is the honest statement.
      enhancePaddleMaterial(paddleModel);
    } else {
      // Wood, sponge and topsheet as separate extrusions sharing one
      // silhouette — the rim sandwich is geometry, not a texture. See
      // scene/paddleGeometry.js; the numbers live in physics/paddleSpec.js.
      paddleModel = buildProceduralPaddle();
    }

    // NOTE: there is deliberately no procedural geometry pass ON THE GLB here.
    // An earlier build added rubber caps + a sponge/ply rim band to the loaded
    // GLB scene to fake the assembled-layers look it lacks. It was removed: it
    // coupled the collision radius to a cosmetic lip, which is a physics
    // dependency on a decoration. Patching an asset at load and authoring one
    // from a spec are different things — the branch above is the second.
    //
    // Everything below measures whichever bat we ended up with, unchanged. One
    // derivation path for both assets is the point: it makes the A/B honest,
    // and it means the procedural bat has to satisfy the same anchor contract
    // the GLB does rather than getting a private shortcut.

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
    const medAxis = dims[1].axis;

    // Step 2b: blade extent from the GLB's ARTIST-AUTHORED anchors, not from
    // the bounding box.
    //
    // The bbox spans the whole bat — blade AND handle — so anything derived
    // from it about the BLADE is a guess. The disc center used to be one:
    // `faceCenterModel[longAxis] = headEnd * 0.65`, an unexplained constant
    // against the far end of the bbox. For this asset it lands at 0.1083 where
    // the true blade center (EdgeTop/EdgeBottom midpoint) is 0.0921 — the disc
    // sat 16.2 mm too far toward the tip, so:
    //   - the bottom ~16 mm of visible rubber fell OUTSIDE the clean-face disc
    //     but inside detectDiscCollision's edge band, and therefore resolved
    //     through the wood-edge model: stiffer COR, reduced spin capture,
    //     JITTERED normal. Hitting clean rubber near the throat sprayed.
    //   - ~16 mm of air past the tip resolved as a pristine face hit.
    // Both are >1 cm, i.e. outside the contact-visual agreement budget, and
    // both are the "what I hit isn't what I see" failure the radius comment
    // below already describes. The radius was audited against these anchors;
    // the center never was, and nothing tested it.
    //
    // Worse, it was not something calibration could absorb: a player who felt
    // throat hits misbehaving would drag T_cal in the wizard to compensate,
    // which moves the RENDERED paddle off their hand to patch a COLLIDER
    // error. The wizard would converge on a wrong answer. Collider geometry has
    // to be right before calibration on top of it means anything.
    //
    // Anchors are mandatory (ai-docs/paddle-glb-reauthor-checklist.md §1, gated
    // by tests/paddleRigidity.test.js) so a missing one is a broken asset, not
    // a runtime condition — same fail-loud policy as Table.glb's getAnchor.
    // Read via world position + worldToLocal so any future re-parenting or node
    // transform is handled rather than assumed away.
    const bladeAnchor = (name) => {
      const node = paddleModel.getObjectByName(name);
      if (!node) throw new Error(`Paddle.glb is missing anchor '${name}'`);
      return paddleModel.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
    };
    const bladeTop = bladeAnchor('EdgeTop');
    const bladeBottom = bladeAnchor('EdgeBottom');
    const bladeLeft = bladeAnchor('EdgeLeft');
    const bladeRight = bladeAnchor('EdgeRight');
    const handleEndModel = bladeAnchor('HandleEnd');

    // Disc center = the blade's geometric center. Deliberately NOT the
    // SweetSpot anchor: a sweet spot legitimately sits above geometric center
    // (that is where a blade is liveliest), and centering the COLLIDER there
    // would reproduce most of the 16 mm error we are removing — plausibly how
    // the 0.65 constant was arrived at, since it lands within 1.5 mm of it.
    const faceCenterModel = new THREE.Vector3();
    faceCenterModel[longAxis] = (bladeTop[longAxis] + bladeBottom[longAxis]) / 2;

    // Clean-face radius. Must match what the player SEES — the contact-visual
    // agreement requirement is a bound on the RADIAL direction too, not just
    // perpendicular distance to the face plane.
    //
    // This used to read `Math.max(size/2, 0.09)`. For this asset the 0.09 floor
    // won (blade half-width is 0.0746), which put the clean-face disc 15.2 mm
    // OUTSIDE the visible rubber all the way around: a ball that visually
    // grazed past the rim still resolved as a pristine face hit, so the paddle
    // behaved as though it had an invisible 1.5 cm collar. That is a "what I
    // hit isn't what I see" mismatch, and it reads as the paddle not being the
    // object on screen.
    //
    // Forgiveness is NOT lost by tightening this: detectDiscCollision's edge
    // band (faceRadius → faceRadius + ballRadius) still catches everything the
    // 0.09 disc used to, and routes it through the wood-blade edge-strike model
    // in ball.js — stiffer COR, reduced spin capture, jittered normal. So rim
    // contacts still come back, they just now behave and sound like rim
    // contacts. The floor is kept only as a broken-asset guard, below the
    // self-test's 0.05 lower bound rather than above the real blade size.
    //
    // Now sourced from the anchors like the center, so the disc is exact by
    // construction on both axes instead of inheriting whatever else happens to
    // be widest in the bbox (a future GLB with a wide handle guard would have
    // silently inflated it). A blade is an ellipse and a disc is not, so the
    // larger half-extent wins: under-covering would put dead rubber at the
    // rim, which is worse than the 0.2 mm of collar it costs on this asset.
    const bladeHalfWidth = Math.abs(bladeRight[medAxis] - bladeLeft[medAxis]) / 2;
    const bladeHalfLength = Math.abs(bladeTop[longAxis] - bladeBottom[longAxis]) / 2;
    paddleHitRadius = Math.max(bladeHalfWidth, bladeHalfLength, 0.05);

    // Blade half-thickness, measured on the BLADE. The bbox thin axis spans the
    // whole model and the handle is the thickest part of it (20.3 mm vs the
    // blade's 10.6 mm), so `unrotatedSize[thinAxis] / 2` reported the handle —
    // 10.15 mm for a 5.3 mm blade, ~2× over. It feeds the safety margin in
    // resolvePaddleTablePenetration (`yTop = tableTop + halfThickness + 0.005`),
    // so the paddle hovered ~5 mm higher above the felt than intended and the
    // clamp engaged earlier and more often than it needed to.
    //
    // Sample only vertices in the middle half of the blade along its own axis:
    // that excludes the handle AND the throat flare, where the wood thickens
    // into the grip and is not representative of the hitting surface.
    const bladeMid = faceCenterModel[longAxis];
    const sampleBand = bladeHalfLength * 0.5;
    let thinMin = Infinity;
    let thinMax = -Infinity;
    const _vtx = new THREE.Vector3();
    paddleModel.traverse((node) => {
      const pos = node.isMesh && node.geometry && node.geometry.attributes.position;
      if (!pos) return;
      node.updateMatrixWorld(true);
      for (let i = 0; i < pos.count; i++) {
        _vtx.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
        paddleModel.worldToLocal(_vtx);
        if (Math.abs(_vtx[longAxis] - bladeMid) > sampleBand) continue;
        if (_vtx[thinAxis] < thinMin) thinMin = _vtx[thinAxis];
        if (_vtx[thinAxis] > thinMax) thinMax = _vtx[thinAxis];
      }
    });
    paddleHalfThickness = thinMin <= thinMax
      ? (thinMax - thinMin) / 2
      : unrotatedSize[thinAxis] / 2;   // no vertices in band — broken asset guard

    // Step 3: restore rotation, compute controller-local-space vectors.
    paddleModel.rotation.set(savedRotX, savedRotY, savedRotZ);
    const paddleLocalQuat = new THREE.Quaternion().setFromEuler(paddleModel.rotation);
    paddleFaceNormalLocal.copy(faceNormalModel).applyQuaternion(paddleLocalQuat).normalize();
    paddleFaceOffset.copy(faceCenterModel).applyQuaternion(paddleLocalQuat);

    // Derive the 'handle_grip' calibration preset from the measured geometry:
    // T_cal that puts the handle axis along grip -Z (WebXR's held-rod
    // direction) with the handle's grip point (GRIP_POINT_FRACTION) at the
    // grip origin — the controller body becomes the paddle handle. Computed per loaded asset from its authored
    // anchors, so it stays exact across GLB re-exports and the procedural bat.
    // Registered into the shared preset table; the wizard exposes it.
    const handleGrip = deriveHandleGripPreset({
      handleEnd: handleEndModel.clone().applyQuaternion(paddleLocalQuat),
      bladeBottom: bladeBottom.clone().applyQuaternion(paddleLocalQuat),
      faceCenter: paddleFaceOffset,
    });
    if (handleGrip) {
      registerDerivedPreset('handle_grip', handleGrip);
      logInfo('Handle-grip preset (derived): posOffset',
        handleGrip.posOffset, 'rotOffset', handleGrip.rotOffset);
    } else {
      console.warn('Handle-grip preset NOT derived — degenerate handle geometry');
    }

    logInfo('Paddle model size (unrotated):', unrotatedSize);
    logInfo('Thin/normal axis:', thinAxis, '| Long/handle axis:', longAxis);
    logInfo('Face normal (controller-local):', paddleFaceNormalLocal);
    logInfo('Face center offset (controller-local):', paddleFaceOffset);
    logInfo('Paddle face hit radius:', paddleHitRadius,
      '(blade half-extents', bladeHalfWidth, bladeHalfLength, ')');
    logInfo('Paddle blade half-thickness:', paddleHalfThickness,
      '(bbox thin axis was', unrotatedSize[thinAxis] / 2, '— includes the handle)');

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

      runCollisionSelfTest();
    }

    // Ungated (not logInfo) — this is the check that would have caught the
    // blank paddle/net in production without a headset session to see it.
    assertGlbTexturesDecoded();

    if (loadingScreen) loadingScreen.style.display = 'none';
    modelsLoaded = true;
    logInfo('All models loaded successfully');
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
    logInfo(`[COLLISION TEST] ${pass ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
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
  logInfo(`[COLLISION TEST] === ${passed}/${total} ${passed === total ? 'PASSED' : 'PASSED, ' + (total - passed) + ' FAILED'} ===`);

  if (passed < total) {
    const el = document.createElement('div');
    el.textContent = `COLLISION TEST: ${total - passed} FAILED`;
    el.style.cssText = 'position:fixed;top:8px;left:8px;background:red;color:white;padding:4px 8px;font:12px monospace;z-index:999;border-radius:4px;';
    document.body.appendChild(el);
  }
}
