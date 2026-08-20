// Paddle material correction pass.
//
// Paddle.glb ships ONE material for the entire bat: uniform roughness 0.55,
// metalness 0, and a KHR_materials_specular specularColorFactor of [2, 2, 2]
// — a 2× specular boost over physical. Under the arena key light that renders
// rubber, wood edge, and handle wrap with the exact same semi-gloss highlight,
// which the eye reads as "one molded plastic toy": the face/handle junction
// looks like a decal boundary instead of rubber glued onto a wood blade, and
// the whole paddle stops reading as separate real materials.
//
// The asset can't be re-authored at runtime, but the base-color texture DOES
// distinguish the regions (saturated red rubber, near-black rubber/side tape,
// tan wood ply, teal handle wrap). So we derive a per-pixel roughness map from
// the base color at load: rubber/tape pixels go matte (~0.85, real inverted
// rubber is chalky), wood/handle keep the authored ~0.55 satin. Combined with
// clamping the specular boost to the same neighborhood the table pass uses
// (matteTableSurface sets specularIntensity 0.3), the face and handle finally
// respond to light differently — the strongest "this is one real object made
// of two materials" cue available without touching the GLB.
//
// classifyPaddleRoughness is exported separately so the region classifier is
// unit-testable in Node (no canvas). buildPaddleRoughnessMap no-ops (returns
// null) outside a DOM environment for the same reason.

import * as THREE from 'three';

// Matte inverted rubber. Real tournament rubber is regulation-matt (same ITTF
// "matt" language as the ball); 0.85 kills the traveling highlight on the face.
export const RUBBER_ROUGHNESS = 0.85;

// Lacquered wood / handle wrap — keep the authored satin so the handle still
// picks up a live highlight the rubber doesn't. The contrast IS the effect.
export const BLADE_ROUGHNESS = 0.55;

// Neutralize the GLB's 2× specular boost. 0.35 sits next to the table's 0.3
// (matteTableSurface) so the paddle stops being the shiniest object in hand.
export const PADDLE_SPECULAR_INTENSITY = 0.35;

// Region classifier: base-color pixel (0–255 channels) → target roughness.
// Rubber is either saturated red or near-black in this texture; the dark
// side-tape strips also land in the near-black bucket, which is correct —
// real side tape is matte too. Everything else (tan ply, teal wrap, white
// trim) is blade/handle.
export function classifyPaddleRoughness(r, g, b) {
  const isRedRubber = r > 140 && g < 90 && b < 90;
  const isDarkRubber = r < 60 && g < 60 && b < 60;
  return (isRedRubber || isDarkRubber) ? RUBBER_ROUGHNESS : BLADE_ROUGHNESS;
}

// Build a grayscale roughness map from the paddle's base-color texture.
// 512² is plenty — roughness varies per-region, not per-texel — and keeps the
// one-time canvas readback + GPU upload cheap. Sampler state (flipY, wrap,
// UV channel) is copied from the base map so both textures address the same
// UV layout; three.js samples roughness from the green channel and multiplies
// by material.roughness, so the caller must set roughness = 1.0 when wiring
// the map in.
export function buildPaddleRoughnessMap(baseMap, size = 512) {
  if (typeof document === 'undefined') return null;
  const image = baseMap && baseMap.image;
  if (!image || !image.width || !image.height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, size, size);

  const imageData = ctx.getImageData(0, 0, size, size);
  const px = imageData.data;
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.round(classifyPaddleRoughness(px[i], px[i + 1], px[i + 2]) * 255);
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = baseMap.flipY;
  tex.wrapS = baseMap.wrapS;
  tex.wrapT = baseMap.wrapT;
  tex.channel = baseMap.channel;
  tex.needsUpdate = true;
  return tex;
}

// Apply the full correction to the loaded paddle scene. Idempotent — a mesh
// that already carries a roughnessMap (future re-authored GLB) is left alone,
// and the specular clamp is a fixed assignment.
export function enhancePaddleMaterial(root) {
  root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const mat of mats) {
      // KHR_materials_specular → MeshPhysicalMaterial.specularColor. The GLB
      // authors (2,2,2); clamp to physical white and dial intensity down.
      if (mat.specularColor) mat.specularColor.setRGB(1, 1, 1);
      if ('specularIntensity' in mat) mat.specularIntensity = PADDLE_SPECULAR_INTENSITY;

      if (mat.map && !mat.roughnessMap) {
        const rmap = buildPaddleRoughnessMap(mat.map);
        if (rmap) {
          mat.roughnessMap = rmap;
          // Map now carries the absolute per-region values; factor must be 1
          // or the authored 0.55 would multiply the map down globally.
          mat.roughness = 1.0;
        }
      }
      mat.needsUpdate = true;
    }
  });
}
