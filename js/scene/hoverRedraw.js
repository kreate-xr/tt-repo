// Hover-repaint throttle for the canvas menu panels (training, multiplayer,
// physics tuner, Paddle Fit, match report) — the same rule wristMenu.js has
// carried on its own since its HOVER_REDRAW_MIN_MS was introduced.
//
// Every draw() on these panels is a full-canvas repaint plus a mipmapped
// texture re-upload, and laser jitter on the border between two rows can flip
// the hovered id frame to frame. Hover STATE still changes immediately (so a
// trigger press always selects what is under the ray); only the repaint is
// capped at one per HOVER_REDRAW_MIN_MS, and a deferred one is flushed from the
// per-frame raycast via flushHoverDraw().
//
// Only hover-driven repaints count toward the throttle. A repaint for any
// other reason (screen change, value edit, rebuild) still runs at once, and
// because it paints the current hover state too, it clears a pending one.

export const HOVER_REDRAW_MIN_MS = 100;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Install requestHoverDraw() / flushHoverDraw() on a panel that has draw().
 * Call once, at the end of the panel's constructor.
 */
export function installHoverRedraw(panel) {
  const draw = panel.draw.bind(panel);
  let lastHoverDrawMs = -Infinity;
  let pending = false;

  panel.draw = function drawAndClearPending(...args) {
    pending = false;
    return draw(...args);
  };

  panel.requestHoverDraw = function requestHoverDraw() {
    if (now() - lastHoverDrawMs >= HOVER_REDRAW_MIN_MS) {
      lastHoverDrawMs = now();
      panel.draw();
    } else {
      pending = true;
    }
  };

  panel.flushHoverDraw = function flushHoverDraw() {
    if (pending && now() - lastHoverDrawMs >= HOVER_REDRAW_MIN_MS) {
      lastHoverDrawMs = now();
      panel.draw();
    }
  };
}
