// Real-world occlusion in passthrough (js/xr/depthOcclusion.js).
//
// The rendering itself needs a headset; what can be pinned headless is the
// contract around it: what the session asks for, the range gate's depth
// math against a real projection, how the driver attaches to (and survives
// the reset of) three's depth-sensing mesh, and the fallback occluder's
// draw-order/colour-mask properties.

const THREE = require('three');

import {
  depthSensingSessionInit, occlusionWindowDepth, createDepthOcclusion,
  createOffHandOccluder, OCCLUSION_RANGE_M, OFFHAND_OCCLUDER_RADIUS_M,
} from '../js/xr/depthOcclusion.js';

describe('session init', () => {
  test('passthrough asks for optional GPU float32 depth sensing', () => {
    const init = depthSensingSessionInit('ar');
    expect(init.optionalFeatures).toEqual(['depth-sensing']);
    expect(init.depthSensing.usagePreference).toEqual(['gpu-optimized']);
    expect(init.depthSensing.dataFormatPreference).toEqual(['float32']);
  });

  test('the Focus Room asks for nothing — there is no real world to occlude against', () => {
    expect(depthSensingSessionInit('vr-focus')).toBeNull();
    expect(depthSensingSessionInit('vr')).toBeNull();
  });
});

describe('range gate', () => {
  test('window depth of a point in range sits between near and far, and is monotonic', () => {
    const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    const d05 = occlusionWindowDepth(cam.projectionMatrix, 0.5);
    const d15 = occlusionWindowDepth(cam.projectionMatrix, 1.5);
    const d30 = occlusionWindowDepth(cam.projectionMatrix, 3.0);
    expect(d05).toBeGreaterThan(0);
    expect(d05).toBeLessThan(d15);
    expect(d15).toBeLessThan(d30);
    expect(d30).toBeLessThan(1);
  });

  test('matches an explicit projection of the same point', () => {
    const cam = new THREE.PerspectiveCamera(70, 1.2, 0.05, 40);
    const p = new THREE.Vector4(0, 0, -OCCLUSION_RANGE_M, 1).applyMatrix4(cam.projectionMatrix);
    const expected = (p.z / p.w) * 0.5 + 0.5;
    expect(occlusionWindowDepth(cam.projectionMatrix, OCCLUSION_RANGE_M)).toBeCloseTo(expected, 9);
  });

  test('survives an infinite far plane (what the Quest runtime reports with depth sensing)', () => {
    // Standard GL perspective with far → ∞: e10 = -1, e14 = -2n.
    const n = 0.1;
    const m = new THREE.Matrix4().set(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, -1, -2 * n,
      0, 0, -1, 0,
    );
    const d = occlusionWindowDepth(m, 1.5);
    // z_ndc = 1 - 2n/R → window = 1 - n/R
    expect(d).toBeCloseTo(1 - n / 1.5, 9);
    expect(Number.isFinite(d)).toBe(true);
  });

  test('a degenerate matrix gates nothing rather than throwing', () => {
    expect(occlusionWindowDepth(new THREE.Matrix4().set(
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), 1.5)).toBe(1);
  });
});

// A stand-in for renderer.xr with just the depth-sensing surface three
// exposes, plus the ArrayCamera the range gate reads.
function fakeXR({ sensing = false } = {}) {
  const eye = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const state = {
    sensing,
    texture: { isTexture: true, id: 1 },
    mesh: null,
  };
  const stockMaterial = () => new THREE.ShaderMaterial({
    uniforms: {
      depthColor: { value: state.texture },
      depthWidth: { value: 1024 },
      depthHeight: { value: 1024 },
    },
  });
  return {
    state,
    eye,
    hasDepthSensing: () => state.sensing,
    getDepthSensingMesh: () => {
      if (!state.sensing) return null;
      if (!state.mesh) state.mesh = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), stockMaterial());
      return state.mesh;
    },
    getDepthTexture: () => (state.sensing ? state.texture : null),
    getCamera: () => ({ cameras: [eye] }),
    // What three does on session end.
    reset() { state.mesh = null; state.sensing = false; },
  };
}

describe('depth occlusion driver', () => {
  test('is inert until the runtime delivers depth', () => {
    const xr = fakeXR();
    const occ = createDepthOcclusion({ xr });
    expect(occ.update()).toBe(false);
    expect(occ.isActive()).toBe(false);
  });

  test('takes over three\'s mesh with a colour-masked, range-gated material', () => {
    const xr = fakeXR({ sensing: true });
    const occ = createDepthOcclusion({ xr });
    expect(occ.update()).toBe(true);
    expect(occ.isActive()).toBe(true);
    const mat = xr.state.mesh.material;
    expect(mat.colorWrite).toBe(false);
    expect(mat.depthWrite).toBe(true);
    expect(mat.fragmentShader).toContain('occlusionFarWindow');
    expect(mat.fragmentShader).toContain('discard');
    // Carries three's uniforms across and points at the live texture.
    expect(mat.uniforms.depthColor.value).toBe(xr.state.texture);
    expect(mat.uniforms.depthWidth.value).toBe(1024);
    // Range gate evaluated against the eye projection.
    expect(mat.uniforms.occlusionFarWindow.value)
      .toBeCloseTo(occlusionWindowDepth(xr.eye.projectionMatrix, OCCLUSION_RANGE_M), 9);
  });

  test('re-attaches after a session reset without leaking a second material', () => {
    const xr = fakeXR({ sensing: true });
    const occ = createDepthOcclusion({ xr });
    occ.update();
    const first = xr.state.mesh.material;
    xr.reset();
    expect(occ.update()).toBe(false);
    expect(occ.isActive()).toBe(false);
    // Next session: a new texture and a fresh stock mesh from three.
    xr.state.sensing = true;
    xr.state.texture = { isTexture: true, id: 2 };
    expect(occ.update()).toBe(true);
    expect(xr.state.mesh.material).toBe(first);
    expect(first.uniforms.depthColor.value).toBe(xr.state.texture);
  });

  test('honours a custom range', () => {
    const xr = fakeXR({ sensing: true });
    const occ = createDepthOcclusion({ xr }, { rangeM: 0.8 });
    occ.update();
    expect(xr.state.mesh.material.uniforms.occlusionFarWindow.value)
      .toBeCloseTo(occlusionWindowDepth(xr.eye.projectionMatrix, 0.8), 9);
  });
});

describe('off-hand fallback occluder', () => {
  test('is a hidden, depth-only sphere that draws before the scene', () => {
    const m = createOffHandOccluder();
    expect(m.visible).toBe(false);
    expect(m.renderOrder).toBeLessThan(0);
    expect(m.material.colorWrite).toBe(false);
    expect(m.material.depthWrite).toBe(true);
    expect(m.material.transparent).toBe(false);
    expect(m.geometry.parameters.radius).toBe(OFFHAND_OCCLUDER_RADIUS_M);
  });

  test('leaves the held serve ball outside its volume', () => {
    // playerServe holds the preview ball 8.5 cm ahead of the grip; the
    // sphere must not swallow it (radius + ball radius < hold offset).
    const HOLD_OFFSET = 0.085;
    const BALL_R = 0.02;
    expect(OFFHAND_OCCLUDER_RADIUS_M + BALL_R).toBeLessThan(HOLD_OFFSET);
  });
});
