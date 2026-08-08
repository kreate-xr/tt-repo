// Panel toolkit (Phase 0 slice 5) — the shared canvas-panel base.
//
// wristMenu (843 lines), calibrationWizard (475), physicsTuner (373),
// calibrationTuner (334) and trajectoryControl (322) each hand-rolled their
// own draw loop, hitTestUV, hover tracking and press routing: ~2,350 lines of
// near-duplicate. P15 adds more UI than currently exists, so without a shared
// base it would have been another ~3k lines of the same copy-paste.
//
// ── WHAT IS AND IS NOT HERE ─────────────────────────────────────────────────
//
// This module owns HIT GEOMETRY and INPUT ROUTING — the parts that are pure
// arithmetic, that every panel gets subtly wrong in its own way, and that are
// therefore worth testing headless. `Panel` (below) is scene-free by design:
// it holds no THREE objects and imports nothing from three.js, so the whole
// layout/hit/routing layer runs under Jest.
//
// Rendering and mesh ownership stay with each panel, because canvas drawing
// is genuinely per-panel and abstracting it would produce a worse API than
// the ctx calls it replaced. `PanelMesh` (also below) is the thin THREE
// wrapper, kept separate so importing the logic never pulls in the scene.
//
// ── COORDINATES ─────────────────────────────────────────────────────────────
//
// Widgets are laid out in CANVAS pixels (origin top-left, y down), which is
// what the ctx drawing calls use. Hit tests arrive as UV (origin bottom-left,
// v up) because that is what a THREE raycast reports. The flip lives in ONE
// place — uvToCanvas — rather than being re-derived per panel, which is where
// the existing panels each independently wrote `(1 - v) * CANVAS_H`.

// --- Widget kinds -----------------------------------------------------------

export const WIDGETS = Object.freeze({
  BUTTON: 'button',
  LIST_ROW: 'listRow',
  SEGMENT: 'segment',
  STEPPER: 'stepper',
  SLIDER: 'slider',
  TOGGLE: 'toggle',
});

/**
 * Convert a UV hit to canvas pixel space.
 * Returns null when outside the panel, so callers never have to bounds-check
 * twice.
 */
export function uvToCanvas(u, v, width, height) {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
  return { px: u * width, py: (1 - v) * height };
}

/** Point-in-rect, inclusive of edges. */
export function hitRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Point-in-circle, with an optional slop radius for generous VR targeting. */
export function hitCircle(px, py, c, slop = 0) {
  const dx = px - c.cx;
  const dy = py - c.cy;
  const r = c.r + slop;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Map a hit inside a slider track to its value.
 *
 * Clamps rather than extrapolating: a laser that drifts a few pixels past the
 * track end should peg the slider at its bound, not drive the value out of
 * range — every panel that hand-rolled this had to remember to clamp, and a
 * missed clamp is how an out-of-range config reaches the engine.
 */
export function sliderValueAt(px, widget) {
  const t = (px - widget.x) / widget.w;
  const clamped = Math.min(1, Math.max(0, t));
  const raw = widget.min + clamped * (widget.max - widget.min);
  if (!widget.step) return raw;
  const snapped = Math.round(raw / widget.step) * widget.step;
  // Re-clamp: snapping can push a value a half-step past the bound.
  const bounded = Math.min(widget.max, Math.max(widget.min, snapped));
  // Kill float dust from the division (0.30000000000000004 in a UI label).
  return Math.round(bounded * 1e6) / 1e6;
}

/** Fractional position of a value along its slider track, for drawing. */
export function sliderFraction(value, widget) {
  if (widget.max === widget.min) return 0;
  const t = (value - widget.min) / (widget.max - widget.min);
  return Math.min(1, Math.max(0, t));
}

/**
 * Scene-free panel logic: widget registry, hit routing, hover and press state.
 *
 * A panel subclass (or plain owner) calls clear()/add() to lay out, then feeds
 * pointer events in. It never touches THREE — see PanelMesh for that.
 */
export class Panel {
  constructor({ width = 1024, height = 410 } = {}) {
    this.width = width;
    this.height = height;
    this.widgets = [];
    this.hoveredId = null;
    this.listeners = new Map();
    this.visible = false;
    this.dirty = true;
  }

  clear() {
    this.widgets.length = 0;
    // Hover must not survive a relayout: the id it pointed at may no longer
    // exist, and a stale hover renders a highlight on nothing.
    this.hoveredId = null;
    this.dirty = true;
  }

  add(widget) {
    if (!widget || !widget.id) throw new Error('panel widget needs an id');
    this.widgets.push(widget);
    this.dirty = true;
    return widget;
  }

  get(id) {
    return this.widgets.find((w) => w.id === id) || null;
  }

  /**
   * Resolve a UV hit to a widget id.
   *
   * Two ordering rules, both load-bearing:
   *
   * 1. Circles before rects, with a slop radius. Mode tiles have crosshair
   *    ticks extending past the drawn circle that players legitimately aim
   *    at, and a tile sitting on a background panel must win.
   *
   * 2. Within each pass, REVERSE registration order — last added wins.
   *    Registration order is draw order, so a widget added later renders on
   *    top and must therefore receive the hit. Testing forwards means a
   *    full-panel background registered first swallows every button drawn
   *    over it, which is exactly what a naive first-match-wins loop does.
   */
  hitTestUV(u, v, { circleSlop = 12 } = {}) {
    const p = uvToCanvas(u, v, this.width, this.height);
    if (!p) return null;
    for (let i = this.widgets.length - 1; i >= 0; i--) {
      const w = this.widgets[i];
      if (w.disabled) continue;
      if (w.shape === 'circle' && hitCircle(p.px, p.py, w, circleSlop)) return w.id;
    }
    for (let i = this.widgets.length - 1; i >= 0; i--) {
      const w = this.widgets[i];
      if (w.disabled) continue;
      if (w.shape !== 'circle' && hitRect(p.px, p.py, w)) return w.id;
    }
    return null;
  }

  /**
   * Update hover from a UV position. Returns true when the hover CHANGED,
   * which is the signal to play a tick and redraw — panels that redrew every
   * frame regardless were the reason the hover tick used to machine-gun.
   */
  setHoverUV(u, v) {
    const id = u === null ? null : this.hitTestUV(u, v);
    if (id === this.hoveredId) return false;
    this.hoveredId = id;
    this.dirty = true;
    return true;
  }

  clearHover() {
    if (this.hoveredId === null) return false;
    this.hoveredId = null;
    this.dirty = true;
    return true;
  }

  /**
   * Activate the hovered widget (trigger press, or poke-through).
   * Returns the emitted {id, value} or null when nothing was hovered.
   */
  activate() {
    if (!this.hoveredId) return null;
    return this.activateId(this.hoveredId);
  }

  activateId(id) {
    const w = this.get(id);
    if (!w || w.disabled) return null;
    let value;
    switch (w.kind) {
      case WIDGETS.TOGGLE:
        w.value = !w.value;
        value = w.value;
        break;
      case WIDGETS.STEPPER:
        // Steppers carry their own delta so one widget id can serve both
        // arrows without the handler re-deriving direction from position.
        value = w.delta;
        break;
      default:
        value = w.value;
        break;
    }
    this.dirty = true;
    this.emit(w.action || w.id, { id, value, widget: w });
    return { id, value };
  }

  /**
   * Drag a slider to the value under a UV position. Separate from activate()
   * because sliders track continuously while held rather than firing once.
   */
  dragSliderUV(id, u, v) {
    const w = this.get(id);
    if (!w || w.kind !== WIDGETS.SLIDER) return null;
    const p = uvToCanvas(u, v, this.width, this.height);
    if (!p) return null;
    const next = sliderValueAt(p.px, w);
    if (next === w.value) return null;
    w.value = next;
    this.dirty = true;
    this.emit(w.action || w.id, { id, value: next, widget: w });
    return next;
  }

  // --- events ---------------------------------------------------------------

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
    return () => {
      const arr = this.listeners.get(event) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      // One throwing handler must not stop the others, or a single bad
      // listener silently disables the rest of the menu.
      try { fn(payload); } catch (e) { console.error(`panel handler "${event}" threw:`, e); }
    }
  }

  show() { this.visible = true; this.dirty = true; }
  hide() { this.visible = false; this.clearHover(); }
  isVisible() { return this.visible; }
}

// --- Layout helpers ---------------------------------------------------------

/**
 * Lay out a vertical list of rows, returning rects in canvas space.
 *
 * Used by M0's tree and by any panel showing a scrollable set. Kept pure so
 * the row geometry can be asserted without a canvas.
 */
export function listRows({
  x, y, w, rowH, gap = 0, count, maxRows = Infinity, scroll = 0,
}) {
  const visible = Math.min(count, maxRows);
  const rows = [];
  for (let i = 0; i < visible; i++) {
    rows.push({
      index: i + scroll,
      x, w, h: rowH,
      y: y + i * (rowH + gap),
    });
  }
  return rows;
}

/**
 * Clamp a scroll offset so a list can never scroll past its own end.
 * Returns 0 when everything fits, which is what stops a short list from
 * being scrollable at all.
 */
export function clampScroll(scroll, count, maxRows) {
  const maxScroll = Math.max(0, count - maxRows);
  return Math.min(maxScroll, Math.max(0, scroll));
}
