// Net-assembly touch detector (ITTF Law 2.10: a player, or anything they wear
// or carry, touching the net assembly while the ball is in play).
//
// Every other rule in the game is decided from the ball's event stream. This
// one never touches the ball at all, so it needs its own per-frame watch on
// where the paddle is. Without it, "reach over and block at the net" is a
// free exploit in a headset — and it's the natural next move for a player who
// has just been stopped from volleying.
//
// Edge-triggered with hysteresis: one touch fires one fault. The paddle has
// to leave a larger release volume before another can fire, so a blade
// resting against the cord (or jittering across the boundary while tracking
// is noisy) doesn't machine-gun faults at 90Hz.

// How close the paddle's FACE CENTRE has to come to the net volume to count.
//
// Deliberately smaller than the blade: the probe is a single point, so any
// margin large enough to catch every real edge-first touch would also fire on
// legal follow-throughs that pass near the cord. Under-detecting is the
// correct error here — a fault wrongly called takes a point the player
// earned, while one missed just means the game is slightly permissive about
// a rule nobody exploits by accident.
export const NET_TOUCH_MARGIN_M = 0.06;
// The paddle must get this much clear of the net before a second touch can be
// called. Pure hysteresis — prevents boundary chatter.
export const NET_RELEASE_MARGIN_M = 0.11;

// Distance from a point to an axis-aligned box; 0 inside.
export function distanceToBox(point, box) {
  if (!point || !box) return Infinity;
  const dx = Math.max(box.min.x - point.x, 0, point.x - box.max.x);
  const dy = Math.max(box.min.y - point.y, 0, point.y - box.max.y);
  const dz = Math.max(box.min.z - point.z, 0, point.z - box.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// `getProbe` returns the world position to test (the paddle face centre) or
// null when it isn't tracked this frame. `getNetBox` returns the net's
// bounding box, or null before the models load.
export function createNetTouchWatcher({
  getProbe,
  getNetBox,
  touchMargin = NET_TOUCH_MARGIN_M,
  releaseMargin = NET_RELEASE_MARGIN_M,
} = {}) {
  // True between a fired touch and the paddle clearing the release volume.
  let latched = false;

  // Returns true on the frame a NEW touch begins, false otherwise.
  function update() {
    const probe = getProbe ? getProbe() : null;
    const netBox = getNetBox ? getNetBox() : null;
    if (!probe || !netBox) return false;
    // An untracked controller reports the world origin; that's not a touch,
    // it's a dropout. (Same test the xrPaddle attach sweep uses.)
    if (probe.x === 0 && probe.y === 0 && probe.z === 0) return false;

    const d = distanceToBox(probe, netBox);
    if (latched) {
      if (d > releaseMargin) latched = false;
      return false;
    }
    if (d <= touchMargin) {
      latched = true;
      return true;
    }
    return false;
  }

  // Called when a rally ends: the next rally starts with a clean slate, but a
  // paddle still parked against the net must not fire the instant play
  // resumes — so the latch survives until the paddle actually leaves.
  function reset() { /* latch intentionally preserved */ }

  return { update, reset, isLatched: () => latched };
}
