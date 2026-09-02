// Turns the shipped SportyXR wordmark (public/logo.webp) into a scene-ready
// texture. The asset is a 394x235 lossy WebP with NO alpha channel: black
// "Sporty" and a blue-violet "XR" on an opaque white plate, with generous
// padding around the mark. Mapped onto geometry as-is it reads as a white
// sticker — which in the Focus Room would also fight the entire premise of
// that venue (dark matte surround so a white ball keeps its silhouette,
// focusRoomSpec.js ROOM.WALL_COLOR).
//
// Two passes over the pixels fix that:
//
//   1. ALPHA FROM INK — alpha = srcAlpha * (255 - min(r,g,b)). The white
//      plate falls to zero while ink stays opaque. Written against min()
//      rather than luminance on purpose: the XR gradient is mid-luminance
//      but far from neutral, and a luminance rule would half-fade it.
//      The srcAlpha term is a no-op for today's opaque asset and is what
//      keeps this correct if the logo is ever replaced with an alpha PNG.
//
//   2. NEUTRAL INK -> WHITE — the "Sporty" half is black, invisible against
//      the dark surfaces this texture exists for. Near-zero-saturation
//      pixels are repainted white; saturated ones (the XR gradient) keep
//      their authored color. That lands on exactly the treatment
//      scoreboardLayout.js drawLogo() paints by hand — white wordmark,
//      blue->purple XR — so the two brand marks in a session agree.
//
// The result is then tight-trimmed to its own ink bounding box, so the
// returned `aspect` is the MARK's aspect and not the padded asset's.
// Callers MUST size geometry from it (index.html crops the same padding
// with hand-tuned CSS offsets; this measures it instead, so replacing
// logo.webp needs no code change here).

import * as THREE from 'three';

export const LOGO_URL = '/logo.webp';

// max(r,g,b) - min(r,g,b) below this counts as neutral ink -> repainted
// white. Loose enough to catch the lossy codec's color noise in the black
// wordmark, tight enough to leave the XR gradient alone.
const NEUTRAL_SAT = 24;
// Alpha above this counts as content when measuring the trim box. Above
// the codec's ringing around the mark, below any real ink edge.
const INK_ALPHA = 16;
// Fully-clear pixels kept around the trim so bilinear filtering and the
// mip chain never sample past the edge into whatever is adjacent in the
// atlas-less canvas (which would fringe the mark at distance).
const PAD = 2;

// Decode + pixel work is done ONCE per page; the trimmed canvas is cached
// and each caller gets its OWN CanvasTexture off it. Sharing the texture
// instead would mean the first consumer to dispose() kills the mark for
// every later one — the Focus Room is rebuilt per session and does exactly
// that.
let canvasPromise = null;

/**
 * Repaints RGBA bytes in place: white plate -> transparent, black ink ->
 * white ink, saturated ink -> unchanged. Pure; exported for tests.
 */
export function recolorToBrandInk(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const min = Math.min(r, g, b);
    const sat = Math.max(r, g, b) - min;
    rgba[i + 3] = Math.round((rgba[i + 3] / 255) * (255 - min));
    if (sat < NEUTRAL_SAT) {
      rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255;
    }
  }
  return rgba;
}

/**
 * Tight bounding box of pixels with alpha > INK_ALPHA, inclusive on both
 * ends, or null when nothing is left. Pure; exported for tests.
 */
export function inkBounds(rgba, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] <= INK_ALPHA) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

function buildCanvas(url) {
  // Headless (jest) and any DOM-less consumer: no mark, no throw.
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(null);
  }
  return loadImage(url).then((img) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    if (!sctx) return null;
    sctx.drawImage(img, 0, 0);

    // Same-origin asset, so the canvas is untainted and readable.
    const image = sctx.getImageData(0, 0, w, h);
    recolorToBrandInk(image.data);
    const box = inkBounds(image.data, w, h);
    if (!box) return null;

    const bw = box.x1 - box.x0 + 1;
    const bh = box.y1 - box.y0 + 1;
    const canvas = document.createElement('canvas');
    canvas.width = bw + PAD * 2;
    canvas.height = bh + PAD * 2;
    // putImageData writes raw (unblended, non-premultiplied) bytes and
    // lands the dirty rect at (dx + dirtyX, dy + dirtyY) — so the offsets
    // below place the trim box at exactly (PAD, PAD).
    canvas.getContext('2d').putImageData(
      image, PAD - box.x0, PAD - box.y0, box.x0, box.y0, bw, bh);
    return { canvas, aspect: canvas.width / canvas.height };
  });
}

/**
 * Resolves to { texture, aspect } for the brand mark, or null when the
 * asset is unavailable or there is no DOM. Never rejects: branding is
 * decoration, and a venue missing its logo must still be playable.
 */
export function loadBrandLogoTexture(url = LOGO_URL) {
  if (!canvasPromise) {
    canvasPromise = buildCanvas(url).catch((err) => {
      console.warn('[brandLogo] branding skipped:', err?.message || err);
      return null;
    });
  }
  return canvasPromise.then((built) => {
    if (!built) return null;
    const texture = new THREE.CanvasTexture(built.canvas);
    // CanvasTexture defaults to NoColorSpace in modern three.js; the mark
    // is authored sRGB and would render washed out under tone mapping
    // without this (same note as ballTexture.js).
    texture.colorSpace = THREE.SRGBColorSpace;
    // The mark is read at a distance and at grazing angles down the
    // barrier line — without anisotropy the lettering smears. Clamped to
    // the device maximum by the renderer at upload.
    texture.anisotropy = 16;
    return { texture, aspect: built.aspect };
  });
}
