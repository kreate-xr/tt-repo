// Loads a side-wall graphic for the Focus Room — the player poster on the
// left wall and the FOCUS / PRACTICE / IMPROVE / REPEAT piece on the right
// (SIDE_WALL_ART.WALLS).
//
// WebP, converted at build time rather than here: 2363 KB and 1296 KB of PNG
// became 255 KB and 121 KB with their alpha intact. That is the same contract brandLogo.js
// offers, minus its runtime pixel work — that module has to trim and recolor
// a lossy wordmark on the fly, this one is handed an asset that is already
// exactly what it needs to be. It reports the asset's measured aspect so the
// caller can size a quad from one dimension without guessing the other.
//
// Decoration, never a dependency: every failure path resolves to null and the
// room is built and playable without the graphic. It must never reject — a
// venue missing a poster is a venue, a venue that threw during setup is not.

import * as THREE from 'three';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

// Decoded ONCE per page PER URL and cached, but every caller gets its own
// Texture off the shared image — the Focus Room is rebuilt per session and
// disposes what it owns, so a shared texture would be killed for every later
// room by the first one to leave. Disposing a texture does not touch the
// HTMLImageElement, so the decode is genuinely paid once. Keyed by url so a
// second wall graphic can be added without the two fighting over one slot.
const imagePromises = new Map();

function decode(url) {
  // Headless (jest runs on the node environment) or any DOM-less consumer.
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(null);
  }
  return loadImage(url).then(img => ({
    img,
    aspect: (img.naturalWidth || img.width) / (img.naturalHeight || img.height),
  }));
}

/**
 * Resolves to { texture, aspect } for the side-wall graphic, or null when the
 * asset is unavailable or there is no DOM. Never rejects.
 */
export function loadSideWallArt(url) {
  if (!imagePromises.has(url)) {
    imagePromises.set(url, decode(url).catch((err) => {
      console.warn('[sideWallArt] graphic skipped:', err?.message || err);
      return null;
    }));
  }
  return imagePromises.get(url).then((built) => {
    if (!built) return null;
    const texture = new THREE.Texture(built.img);
    // Authored sRGB; without this it renders washed out under tone mapping
    // (same note as brandLogo.js / ballTexture.js).
    texture.colorSpace = THREE.SRGBColorSpace;
    // A Texture built from an existing image is not uploaded until told.
    texture.needsUpdate = true;
    // Read across the room and at grazing angles along the side wall, so it
    // smears without this. Clamped to the device maximum at upload.
    texture.anisotropy = 16;
    return { texture, aspect: built.aspect };
  });
}
