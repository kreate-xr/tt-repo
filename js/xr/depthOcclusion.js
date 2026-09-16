// Real-world occlusion in passthrough MR.
//
// THE PROBLEM. Passthrough is a flat video feed with no depth, so every
// virtual object draws on top of everything real. Hold the free hand over
// the table and the table paints over it: the ball you are about to toss
// floats above a hand you cannot see, and the only way to see your own
// controller is to pull it back past the near edge. Tester, 2026-09: "the
// table render doesn't take my left hand into consideration ... you can
// never place your hand above the table".
//
// THE FIX, in two tiers:
//
// 1. WebXR depth sensing (Quest 3 / 3S and any runtime that offers it).
//    Requested as an optional feature with GPU-optimized float32 depth —
//    the pairing Meta's own web samples use. three.js's WebXRManager then
//    injects a full-screen mesh ahead of the scene that copies the sensed
//    depth into the depth buffer, so the table, net and ball are depth-
//    tested against the real hand, arm and body for free. We swap that
//    mesh's material for our own once it exists, for two reasons:
//      - three's stock shader never writes a colour yet leaves colour
//        writes enabled, so the fragment output is undefined; ours masks
//        colour off so nothing but depth can reach the passthrough
//        composite.
//      - ours only occludes within OCCLUSION_RANGE_M of the eyes. The
//        sensed depth includes the room, and a wall or sofa 2 m in front
//        of a small-room player would otherwise slice the far half of the
//        table away. Hands and arms live inside arm's reach; walls do not.
//
// 2. A depth-only sphere on the off-hand grip where depth sensing is not
//    available (Quest 2, emulator, any non-depth runtime). It punches a
//    hand-sized hole in the virtual scene so the passthrough hand shows
//    through — approximate (a fist plus controller is not a sphere), but it
//    is the hand the complaint is about and it costs nothing.
//
// Nothing here touches physics, input or the paddle pose. Pure rendering.

import * as THREE from 'three';

// How far from the eyes real-world depth is allowed to occlude, in metres.
// An extended arm plus a lean is about 1.1 m; the AI end of the table is
// ~3 m away. 1.5 m keeps every hand and arm inside and every far wall out.
export const OCCLUSION_RANGE_M = 1.5;

// Fallback occluder radius. A closed hand around a Touch controller is
// ~9-10 cm across; 6 cm errs toward showing a little table around the hand
// rather than a halo of passthrough floor around it. The held serve ball
// sits 8.5 cm ahead of the grip (playerServe HOLD_OFFSET_LOCAL), outside
// this radius plus the ball's own 2 cm, so it stays visible in the hand.
export const OFFHAND_OCCLUDER_RADIUS_M = 0.06;

// Session-init fields to merge into requestSession() for passthrough
// sessions. Optional, so a runtime without depth sensing (or without this
// format) starts the session without it; `null` for non-passthrough modes,
// where there is nothing real to occlude against.
export function depthSensingSessionInit(xrMode) {
  if (xrMode !== 'ar') return null;
  return {
    optionalFeatures: ['depth-sensing'],
    depthSensing: {
      usagePreference: ['gpu-optimized'],
      // float32 is the format three's occlusion shader reads directly
      // (`.r` → gl_FragDepth). Preferring it explicitly, rather than
      // letting the runtime choose, means a runtime that can only give
      // luminance-alpha drops the feature instead of feeding the shader a
      // texture it would misread.
      dataFormatPreference: ['float32'],
    },
  };
}

// Window-space depth (0..1, the value the depth buffer holds) of a point
// `rangeM` straight ahead of a camera with this projection matrix. Uses the
// runtime's own projection, so it stays consistent with however the depth
// texture was encoded — including an infinite far plane, where the standard
// formula degenerates cleanly (w = R, z → e10·(−R) + e14).
export function occlusionWindowDepth(projectionMatrix, rangeM) {
  const e = projectionMatrix.elements;
  const z = e[10] * -rangeM + e[14];
  const w = e[11] * -rangeM + e[15];
  if (!(Math.abs(w) > 1e-9)) return 1;
  const ndc = z / w;
  return Math.min(1, Math.max(0, ndc * 0.5 + 0.5));
}

// three's WebXRDepthSensing vertex shader, verbatim: a clip-space quad.
const OCCLUSION_VERTEX = /* glsl */`
void main() {
  gl_Position = vec4( position, 1.0 );
}`;

// three's fragment shader plus the range gate. `discard` leaves the depth
// buffer at its cleared far value, so anything beyond the range renders as
// if there were no depth sensing at all.
const OCCLUSION_FRAGMENT = /* glsl */`
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;
uniform float occlusionFarWindow;

void main() {
  vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );
  float d;
  if ( coord.x >= 1.0 ) {
    d = texture( depthColor, vec3( coord.x - 1.0, coord.y, 1 ) ).r;
  } else {
    d = texture( depthColor, vec3( coord.x, coord.y, 0 ) ).r;
  }
  if ( d > occlusionFarWindow ) discard;
  gl_FragDepth = d;
}`;

// Per-session driver for tier 1. Call update() once per frame before
// renderer.render(); it is a no-op until the runtime delivers depth.
//
// `renderer.xr` is the only dependency, so this runs headless under a fake
// manager in tests. The material is built once and survives session ends
// (three discards its mesh on end and makes a new one next session; we
// re-attach).
export function createDepthOcclusion(renderer, { rangeM = OCCLUSION_RANGE_M } = {}) {
  let material = null;
  let attachedTo = null;

  function buildMaterial(stockMaterial) {
    const stock = stockMaterial.uniforms;
    return new THREE.ShaderMaterial({
      vertexShader: OCCLUSION_VERTEX,
      fragmentShader: OCCLUSION_FRAGMENT,
      uniforms: {
        depthColor: { value: stock.depthColor.value },
        depthWidth: { value: stock.depthWidth.value },
        depthHeight: { value: stock.depthHeight.value },
        occlusionFarWindow: { value: 1 },
      },
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
    });
  }

  function update() {
    const xr = renderer.xr;
    if (!xr.hasDepthSensing || !xr.hasDepthSensing()) {
      attachedTo = null;
      return false;
    }
    const mesh = xr.getDepthSensingMesh();
    if (!mesh) {
      attachedTo = null;
      return false;
    }
    if (mesh.material !== material) {
      if (!material) material = buildMaterial(mesh.material);
      else material.uniforms.depthColor.value = mesh.material.uniforms.depthColor.value;
      mesh.material = material;
      attachedTo = mesh;
    }
    // The texture object is stable within a session but three wraps a new
    // one per session; keep the uniform pointed at the live one.
    const tex = xr.getDepthTexture ? xr.getDepthTexture() : null;
    if (tex) material.uniforms.depthColor.value = tex;

    const cam = xr.getCamera && xr.getCamera();
    const eye = cam && cam.cameras && cam.cameras[0];
    if (eye) {
      material.uniforms.occlusionFarWindow.value =
        occlusionWindowDepth(eye.projectionMatrix, rangeM);
    }
    return true;
  }

  return {
    update,
    // True while the runtime is delivering depth and our material is on
    // three's occlusion mesh — i.e. tier 1 is doing the work this frame.
    isActive: () => attachedTo !== null,
    dispose() {
      if (material) material.dispose();
      material = null;
      attachedTo = null;
    },
  };
}

// Tier 2: a depth-only sphere to park on the off-hand grip. Draws first
// among opaque objects (renderOrder −1) so everything virtual behind the
// real hand fails the depth test and the passthrough shows through. Starts
// hidden; the caller shows it only while tier 1 is not active.
export function createOffHandOccluder({ radiusM = OFFHAND_OCCLUDER_RADIUS_M } = {}) {
  const geometry = new THREE.SphereGeometry(radiusM, 20, 14);
  const material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'offHandOccluder';
  mesh.renderOrder = -1;
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}
