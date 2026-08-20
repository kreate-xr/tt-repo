// Shared canvas-panel styling.
//
// trainingMenu.js and machinePlayMenu.js draw the same visual language — dark
// glass card, accent-green selection, muted subtitles. These constants and the
// roundRect helper lived in trainingMenu.js as file-locals; a second panel
// wanting the same look had to copy them, and the two copies would then drift
// apart one hex value at a time.
//
// Only the parts that are genuinely shared live here. Panel-specific geometry
// (header height, footer position, row layout) stays with each panel, because
// those differ on purpose.

export const ACCENT = '#3ddc97';

export const COLORS = Object.freeze({
  bg: 'rgba(14,17,22,0.94)',
  panel: 'rgba(255,255,255,0.05)',
  panelHover: 'rgba(61,220,151,0.16)',
  text: '#eef2f6',
  muted: '#8b97a5',
  disabled: '#59626e',
  accent: ACCENT,
  accentBright: '#5ef0b0',
  warn: '#ff9a9a',
  warnHover: 'rgba(255,120,120,0.16)',
  track: 'rgba(255,255,255,0.12)',
  hairline: 'rgba(255,255,255,0.10)',
});

/** Font shorthand: F(600, 18) → '600 18px <ui stack>'. */
export const F = (weight, size) =>
  `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/**
 * Rounded-rect path. Falls back to arcTo when ctx.roundRect is missing —
 * the headless canvas stub used in tests has neither, and older WebViews
 * shipped without it.
 */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
