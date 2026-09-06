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
// LIGHTING LAYERS — READ THIS BEFORE ADDING A LIGHT.
//
// three.js does NOT mask lights per mesh. The claim that once stood here —
// "a THREE.Light only illuminates a mesh whose layer mask overlaps the
// light's" — is false for WebGLRenderer. The only layer test involving a
// light is in projectObject():
//     const visible = object.layers.test( camera.layers );
//     if ( visible ) { ... else if ( object.isLight ) pushLight( object ); }
// (three r183, three.module.js:17598). Lights that pass are merged into ONE
// global light-uniform block by WebGLRenderState.setupLights() and applied
// to every material in the frame. A light's layers are compared against the
// CAMERA, never against a mesh.
//
// What that means in practice:
//   • Putting a light on layer 3 does not scope it to arena meshes. It
//     scopes it to a camera that enables layer 3 — and nothing here does.
//     `camera` below is mask 1; WebXR widens it to `camera.layers.mask |
//     0b110` = 7 (layers 1/2 are the per-eye layers). Layer 3 is never set.
//   • So the old arena rig — arenaKeyLight 20, arenaBackKeyLight 10, two
//     side keys at 6, arenaFillHemi 10, arenaAmbient 3 — was dropped every
//     single frame and lit nothing. Those six lights have been deleted.
//     Their intensities had been walked up to 20/10/6/6 precisely because
//     raising them had no visible effect. Do not reintroduce them.
//   • Consequently there is no way to brighten the venue with a light
//     without also hitting the ball, paddle and table. The Focus Room
//     instead lights itself with an emissive term on its own materials
//     (ROOM.SELF_LIT in focusRoomSpec.js), which genuinely cannot leak.
//
// setArenaLighting() still parks keyLight + rimLight on layer 3 in VR. That
// is a switch-OFF, not an isolation: gameplay in VR is lit by hemiLight
// alone at VR_GAMEPLAY_HEMI. It is kept exactly as it was because the ball
// and paddle are tuned against it (see the P16 tone-mapping note above);
// changing it changes how gameplay looks. In AR/MR all lights return to
// layer 0 and are live again.
//
// ARENA_LIGHT_LAYER is still enabled on venue meshes by arena.js and
// focusRoom.js (and asserted by tests/focusRoom.test.js). It now marks
// venue geometry and parks the VR-disabled keys; it does not route light.
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

// Called when entering VR/arena mode. Parks keyLight + rimLight on layer 3,
// which — see the LIGHTING LAYERS note above — switches them OFF entirely
// rather than restricting them to venue meshes. The intended effect on
// gameplay holds either way: ball/paddle/table stop receiving direct
// illumination, so no specular hotspot and no directional gradient on the
// paddle rubber. Everything in VR is then lit by hemiLight alone, boosted
// to VR_GAMEPLAY_HEMI to compensate. The venue does not get extra light
// from here — the Focus Room supplies its own via ROOM.SELF_LIT.
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
