// Paddle material correction pass — region classifier + specular clamp.
//
// Paddle.glb ships one uniform semi-gloss material with a 2× specular boost
// (KHR_materials_specular [2,2,2]) for the entire bat, which renders rubber
// and wood as the same plastic. paddleMaterial.js derives a per-region
// roughness map from the base-color texture and clamps the specular. The
// classifier and the material mutation are pure enough to test in Node; the
// canvas map build itself is DOM-only and must degrade to a null no-op here.

const THREE = require('three');
const {
  classifyPaddleRoughness,
  buildPaddleRoughnessMap,
  enhancePaddleMaterial,
  RUBBER_ROUGHNESS,
  BLADE_ROUGHNESS,
  PADDLE_SPECULAR_INTENSITY,
} = require('../js/scene/paddleMaterial.js');

describe('classifyPaddleRoughness — texture regions map to distinct finishes', () => {
  test('saturated red rubber → matte', () => {
    expect(classifyPaddleRoughness(237, 28, 36)).toBe(RUBBER_ROUGHNESS);
    expect(classifyPaddleRoughness(255, 0, 0)).toBe(RUBBER_ROUGHNESS);
  });

  test('near-black rubber and side tape → matte', () => {
    expect(classifyPaddleRoughness(26, 26, 26)).toBe(RUBBER_ROUGHNESS);
    expect(classifyPaddleRoughness(0, 0, 0)).toBe(RUBBER_ROUGHNESS);
  });

  test('tan wood ply → satin', () => {
    expect(classifyPaddleRoughness(205, 170, 125)).toBe(BLADE_ROUGHNESS);
  });

  test('teal handle wrap and white trim → satin', () => {
    expect(classifyPaddleRoughness(70, 130, 135)).toBe(BLADE_ROUGHNESS);
    expect(classifyPaddleRoughness(245, 245, 245)).toBe(BLADE_ROUGHNESS);
  });

  test('rubber is meaningfully rougher than blade (the contrast IS the cue)', () => {
    expect(RUBBER_ROUGHNESS - BLADE_ROUGHNESS).toBeGreaterThanOrEqual(0.2);
  });
});

describe('enhancePaddleMaterial — specular clamp on the loaded scene', () => {
  function makePaddleScene() {
    const root = new THREE.Group();
    const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.55, metalness: 0 });
    // Mirror the GLB's authored KHR_materials_specular boost.
    mat.specularColor.setRGB(2, 2, 2);
    mat.specularIntensity = 1.0;
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    root.add(mesh);
    return { root, mat };
  }

  test('clamps the authored 2× specular boost', () => {
    const { root, mat } = makePaddleScene();
    enhancePaddleMaterial(root);
    expect(mat.specularColor.r).toBe(1);
    expect(mat.specularColor.g).toBe(1);
    expect(mat.specularColor.b).toBe(1);
    expect(mat.specularIntensity).toBe(PADDLE_SPECULAR_INTENSITY);
  });

  test('without a base map (or DOM) the authored roughness is left untouched', () => {
    const { root, mat } = makePaddleScene();
    enhancePaddleMaterial(root);
    expect(mat.roughnessMap).toBeNull();
    expect(mat.roughness).toBeCloseTo(0.55, 6);
  });
});

describe('buildPaddleRoughnessMap — degrades cleanly outside the browser', () => {
  test('returns null in a DOM-less environment instead of throwing', () => {
    const fakeMap = { image: { width: 4, height: 4 }, flipY: false };
    expect(buildPaddleRoughnessMap(fakeMap)).toBeNull();
  });

  test('returns null for a map with no decoded image', () => {
    expect(buildPaddleRoughnessMap(null)).toBeNull();
    expect(buildPaddleRoughnessMap({ image: null })).toBeNull();
  });
});
