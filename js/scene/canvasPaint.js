// Canvas-painting primitives shared by the Focus Room's procedural surfaces
// (woodFloor.js, wallPanels.js). Pure — no three.js, no DOM. These only
// turn numbers into numbers and CSS color strings, so they are unit-testable
// headless and usable from any painter.

// Deterministic PRNG (mulberry32). The room's painters seed it with a fixed
// constant so every surface is identical board-for-board in both eyes, every
// session, on every device — a venue that reshuffled per session would be a
// very odd thing to notice.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** `rgb(...)` from a 0xRRGGBB literal plus a signed per-channel offset. */
export function tint(hex, delta = 0) {
  const r = clamp255(((hex >> 16) & 255) + delta);
  const g = clamp255(((hex >> 8) & 255) + delta);
  const b = clamp255((hex & 255) + delta);
  return `rgb(${r},${g},${b})`;
}

/** `rgba(...)` from a 0xRRGGBB literal at the given alpha. */
export function rgba(hex, alpha) {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${alpha})`;
}

/**
 * Runs `paint(ctx, w, h)` on a fresh w x h canvas and returns it, or null
 * when there is no canvas to paint on — jest runs on the node environment,
 * and a long-lived page can run out of 2D contexts. Every caller treats null
 * as "keep the flat material", so a missing canvas costs detail, never the
 * room.
 */
export function paintOffscreen(w, h, paint, tag) {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    paint(ctx, w, h);
    return canvas;
  } catch (err) {
    console.warn(`[${tag}] canvas unavailable — flat material:`, err && err.message);
    return null;
  }
}
