import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

// P16 §4.1: near 0.02 (not 0.01) avoids depth-precision waste at the ball's
// arm's-length interception distance without causing a near-clip pop when
// the ball reaches the face (ball radius = 0.02 m). Far 40 m is well past
// arena wall depth and preserves more far-plane precision than the old 100.
export const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 40);
camera.position.set(0, 1.6, 2);
camera.lookAt(0, 0.8, 0);

export const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
// XR framebuffer budget. History: this shipped at 1.5× scale + foveation 0
// to keep panel text crisp (three.js's default 1.0× is below Quest panel
// native, and max foveation blurs a menu sitting in the periphery). But that
// combination costs ~3× the fragment work of the defaults, and on device it
// pushed GPU frame time past the 11.1 ms 90 Hz budget — the compositor then
// reprojects, which keeps head rotation smooth but double-steps every
// ANIMATED object. The ball, the fastest mover on screen, is where that
// judder is seen, and a smooth ball matters more than a tack-sharp menu.
//
// 1.2× keeps a useful amount of supersampling for text; foveation 0.4 only
// discounts the far periphery (a panel you're actually reading sits in the
// fovea and is unaffected). If panels need more sharpness later, the right
// tool is a WebXR quad layer (compositor samples the panel at full
// resolution independent of the eye buffer), NOT a global scale bump.
// Must be set before the XR session starts to take effect.
renderer.xr.setFramebufferScaleFactor(1.2);
renderer.xr.setFoveation(0.4);
// P16: shadow map disabled in XR. The ball's blob shadow (ballShadow.js) is
// the sole ground-contact cue; every other caster we might want (paddle,
// arena props) either flickers at ball size, costs a full shadow pass, or
// baked-shades already. Nothing in the scene needs the real shadow pipeline.
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// P16: Khronos PBR Neutral tone map. Cheaper than ACES and hue-preserving —
// the ITTF-orange ball stays orange (ACES pushed it toward red-brown at
// exposure 1.2). Exposure pinned at 1.0 — earlier 1.2 was the primary cause
// of the ball reading as "glowing plastic" under a strong directional key.
// ACES upgrade permitted only with measured ≥1.0 ms frame-time headroom on
// device AND an orange-swatch recheck post-tonemap.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// P16 hall-authentic rig. Modern three.js physical units (r≥155). No
// AmbientLight — a HemisphereLight covers the ambient wash with directional
// bias, which reads correctly on a matte sphere. All castShadow=false;
// blob-shadow only (see renderer.shadowMap disable above).
//
// LIGHTING LAYER STRATEGY (VR arena mode):
//   Layer 0 (default): gameplay meshes — ball, paddle, table, wristMenu.
//   Layer 3 (arena):   arena venue meshes get this layer ENABLED (kept on 0
//                       too, so the WebXR camera still renders them).
//   A THREE.Light only illuminates a mesh whose layer mask overlaps the
//   light's layer mask. In VR arena mode:
//     • keyLight + rimLight get moved to layer 3 (arena-only). No direct
//       key hits ball/paddle/table anymore — those show no hotspot / no
//       specular streak from an overhead directional. They read as
//       "indirectly lit" while still being visible via hemi.
//     • hemiLight stays on layer 0 (lights EVERYTHING), and gets boosted
//       so gameplay still reads without the key contribution.
//     • arenaKeyLight + arenaFillHemi are dedicated layer-3 lights that
//       boost arena venue brightness without leaking onto gameplay.
//   In AR/MR mode all lights collapse back to layer 0.
//
// Why layers, not disabling lights: layer masks are per-mesh at shader
// time, so this is one setter per light (no per-frame branching) and
// stereo-safe (light-layer isolation works in the WebXR ArrayCamera; the
// caveat noted in arena.js is about MESH layers, not lights).
export const ARENA_LIGHT_LAYER = 3;

// KEY — near-vertical, mimics real ITTF hall luminaires (mounted overhead,
// slight offset). ~80° elevation from horizontal. The near-vertical angle
// resolves two things at once: (a) matches club players' visual memory of
// real venues, and (b) makes the blob shadow geometrically correct as a
// directly-below quad (Kersten consistency: shadow direction must match
// key direction; any restyle that moves the key must move the blob).
export const keyLight = new THREE.DirectionalLight(0xfff4ea, 2.6);
keyLight.position.set(0.6, 5, 0.4);
keyLight.castShadow = false;
scene.add(keyLight);
scene.add(keyLight.target);

// FILL — hemisphere wash, generous because real halls are flat-lit. Ratio
// key:fill on the ball is ~1.8:1 (deliberately stronger than a real hall
// but weaker than cinematic) to compensate for headset stereo acuity while
// still giving the sphere a readable brightness gradient. NEVER add a
// second DirectionalLight as fill — competing directional keys erase the
// sphere gradient and were the cause of the "flat plastic" look in earlier
// rigs. Sky color cool-white (fluorescent-like), ground warm-dark (wood).
export const hemiLight = new THREE.HemisphereLight(0xe8edf5, 0x3a3830, 1.4);
scene.add(hemiLight);

// RIM — far-side separation for the small distant ball against the far wall
// / floor / passthrough background. Weak and cool. Kept in MR too because
// virtual-ball silhouette against arbitrary real-world backgrounds still
// needs an edge cue.
export const rimLight = new THREE.DirectionalLight(0xeaf2ff, 0.7);
rimLight.position.set(-1.5, 3, -5);
rimLight.castShadow = false;
scene.add(rimLight);
scene.add(rimLight.target);

// ARENA-ONLY overhead key. Very hot (20 units) — the venue's authored
// albedo is a deep broadcast-color palette (floor is 0x1a3a6b navy) AND
// Neutral tone mapping compresses highlights hard, so anything less than
// this lands the interior in visible shadow. Layer 3 keeps it clear of
// gameplay meshes.
export const arenaKeyLight = new THREE.DirectionalLight(0xfff4ea, 20.0);
arenaKeyLight.position.set(0.6, 8, 0.4);
arenaKeyLight.castShadow = false;
arenaKeyLight.layers.set(ARENA_LIGHT_LAYER);
arenaKeyLight.target.layers.set(ARENA_LIGHT_LAYER);
scene.add(arenaKeyLight);
scene.add(arenaKeyLight.target);

// ARENA-ONLY BACK KEY: from the opposite side of the venue so the walls
// behind the player don't drop into deep shadow. Half the primary's
// intensity keeps directional shading (not flat) while still filling in
// the "back of the room" that was reading nearly black.
export const arenaBackKeyLight = new THREE.DirectionalLight(0xdde6f5, 10.0);
arenaBackKeyLight.position.set(-2.0, 6, -6);
arenaBackKeyLight.castShadow = false;
arenaBackKeyLight.layers.set(ARENA_LIGHT_LAYER);
arenaBackKeyLight.target.layers.set(ARENA_LIGHT_LAYER);
scene.add(arenaBackKeyLight);
scene.add(arenaBackKeyLight.target);

// ARENA-ONLY SIDE KEYS: left + right so the mid-court walls (which sit
// perpendicular to the front+back keys and would otherwise fall into a
// vertical shadow band) get direct contribution. Warm, moderate.
export const arenaSideKeyL = new THREE.DirectionalLight(0xfff4ea, 6.0);
arenaSideKeyL.position.set(-8, 5, 0);
arenaSideKeyL.castShadow = false;
arenaSideKeyL.layers.set(ARENA_LIGHT_LAYER);
arenaSideKeyL.target.layers.set(ARENA_LIGHT_LAYER);
scene.add(arenaSideKeyL);
scene.add(arenaSideKeyL.target);

export const arenaSideKeyR = new THREE.DirectionalLight(0xfff4ea, 6.0);
arenaSideKeyR.position.set(8, 5, 0);
arenaSideKeyR.castShadow = false;
arenaSideKeyR.layers.set(ARENA_LIGHT_LAYER);
arenaSideKeyR.target.layers.set(ARENA_LIGHT_LAYER);
scene.add(arenaSideKeyR);
scene.add(arenaSideKeyR.target);

// ARENA-ONLY: broad hemispheric fill for the venue's walls / floor / seats.
// Sky cool (fluorescent bounce), ground warm (wood/felt bounce). Pushed
// to 10 so every mesh gets a strong hemispheric baseline before any
// directional contribution lands.
export const arenaFillHemi = new THREE.HemisphereLight(0xdde6f5, 0x2a2618, 10.0);
arenaFillHemi.layers.set(ARENA_LIGHT_LAYER);
scene.add(arenaFillHemi);

// ARENA-ONLY raw brightness floor. AmbientLight has no direction and no
// distance falloff, so it lifts EVERY arena mesh's shading by a flat
// value — the cheapest way to make sure no corner of the venue is
// darker than a legible minimum. Layer 3 keeps it off gameplay.
export const arenaAmbient = new THREE.AmbientLight(0xffffff, 3.0);
arenaAmbient.layers.set(ARENA_LIGHT_LAYER);
scene.add(arenaAmbient);

// Procedural neutral-studio IBL, applied ONLY to the ball material (see
// the ball setup in models.js loadModels) via material.envMap. Setting this on
// scene.environment would also affect the paddle / table / arena walls and
// visibly desaturate their authored colors — we only need the indirect
// specular on the glossy ball, so keep it scoped. RoomEnvironment ships with
// three.js (no HDR asset to load) and the PMREM prefilter is ~1ms at startup.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const roomEnvScene = new RoomEnvironment();
const envRT = pmrem.fromScene(roomEnvScene, 0.04);
export const ballEnvMap = envRT.texture;
pmrem.dispose();

// Snapshot of the AR (passthrough MR) intensities as the FALLBACK when
// XRLightProbe is unavailable. When the runtime supplies a light probe,
// applyLightEstimate() drives the key + hemi from the estimate instead.
// Restored on session end.
const AR_LIGHT_INTENSITY = Object.freeze({
  key: keyLight.intensity,
  hemi: hemiLight.intensity,
  rim: rimLight.intensity,
});

// MR fallback (Step 5.1): warmer key, dropped fill — passthrough already
// supplies a lot of real ambient, so overdriving hemi crushes contrast.
const MR_FALLBACK_KEY_COLOR = 0xfff4e6;
const MR_FALLBACK_HEMI_INTENSITY = 0.5;

// Called when entering VR/arena mode. Moves keyLight + rimLight to the
// arena layer so gameplay meshes (ball/paddle/table on layer 0) stop
// receiving direct illumination — no specular hotspot, no directional
// gradient on the paddle rubber. Gameplay now reads from hemiLight only,
// which is boosted to compensate for losing the key's contribution.
// arenaKeyLight + arenaFillHemi (also on layer 3) provide the additional
// brightness the venue interior needs.
const VR_GAMEPLAY_HEMI = 2.2;
export function setArenaLighting() {
  keyLight.layers.set(ARENA_LIGHT_LAYER);
  keyLight.target.layers.set(ARENA_LIGHT_LAYER);
  rimLight.layers.set(ARENA_LIGHT_LAYER);
  rimLight.target.layers.set(ARENA_LIGHT_LAYER);
  keyLight.intensity  = AR_LIGHT_INTENSITY.key;
  rimLight.intensity  = AR_LIGHT_INTENSITY.rim;
  hemiLight.intensity = VR_GAMEPLAY_HEMI;
  keyLight.color.setHex(0xfff4ea);
}

// Restore AR/MR mode: all lights back on layer 0 (default), hemi back to
// P16-tuned intensity. Cheap to call unconditionally.
export function restoreARLighting() {
  keyLight.layers.set(0);
  keyLight.target.layers.set(0);
  rimLight.layers.set(0);
  rimLight.target.layers.set(0);
  keyLight.intensity  = AR_LIGHT_INTENSITY.key;
  hemiLight.intensity = AR_LIGHT_INTENSITY.hemi;
  rimLight.intensity  = AR_LIGHT_INTENSITY.rim;
  keyLight.color.setHex(0xfff4ea);
}

// Apply the MR (passthrough) fallback tint before an XRLightProbe estimate
// arrives (or if none is available). Rim stays on for silhouette against
// real backgrounds.
export function applyMRFallbackLighting() {
  keyLight.color.setHex(MR_FALLBACK_KEY_COLOR);
  hemiLight.intensity = MR_FALLBACK_HEMI_INTENSITY;
}

// Drive key + hemi from an XRLightProbe estimate. Called per frame from the
// XR loop when light-estimation is active. Values are smoothed toward the
// target with a τ≈2s time constant to avoid the "lights breathing" artifact
// when the estimate updates. `direction` is a THREE.Vector3 unit vector in
// world space; `intensity` is a scalar mean; `sh` (optional) is a
// SphericalHarmonics3 for the hemi sky/ground.
const _keyDirTarget = new THREE.Vector3(0.6, 5, 0.4).normalize();
const _keyDirCurrent = _keyDirTarget.clone();
const _KEY_DISTANCE = 5.0; // Position magnitude; direction is what matters for a DirectionalLight.
let _keyIntensityTarget = keyLight.intensity;
let _hemiIntensityTarget = hemiLight.intensity;
export function applyLightEstimate({ direction, intensity, hemiIntensity } = {}, dt = 0.016) {
  // Exponential smoothing: alpha = 1 - exp(-dt/τ), τ = 2 s.
  const alpha = 1 - Math.exp(-dt / 2.0);
  if (direction) _keyDirTarget.copy(direction).normalize();
  if (typeof intensity === 'number') _keyIntensityTarget = intensity;
  if (typeof hemiIntensity === 'number') _hemiIntensityTarget = hemiIntensity;
  _keyDirCurrent.lerp(_keyDirTarget, alpha);
  keyLight.position.copy(_keyDirCurrent).multiplyScalar(_KEY_DISTANCE);
  keyLight.target.position.set(0, 0, 0);
  keyLight.target.updateMatrixWorld();
  keyLight.intensity  += (_keyIntensityTarget  - keyLight.intensity)  * alpha;
  hemiLight.intensity += (_hemiIntensityTarget - hemiLight.intensity) * alpha;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

export function setSceneBackground(color) {
  scene.background = color;
}

export function setTransparentClear() {
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
}

// Arena-mode counterpart: solid opaque background so the VR session has
// something to render behind the room geometry (avoids z-fighting flashes
// on the wall seams and gives a consistent void color if the player peeks
// outside the geometry during setup).
export function setArenaClear(hexColor = 0x02030a) {
  scene.background = new THREE.Color(hexColor);
  renderer.setClearColor(hexColor, 1);
}
