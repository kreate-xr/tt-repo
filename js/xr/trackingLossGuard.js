// P13 spec §C7 — tracking-loss guard.
//
// Consumes XRFrame.getPose(inputSource.gripSpace, refSpace).emulatedPosition.
// When the runtime reports an emulated pose, the paddle's world pose is not
// tied to a physical hand — resolving a contact against it produces the
// classic "rocket ball on tracking hiccup" bug. This module lets the outer
// loop freeze the paddle at its last good pose and skip contact resolution
// for a short window (spec: up to 100 ms), then fade back to normal.
//
// Contract:
//   update(frame, gripInputSource, referenceSpace) — call once per frame,
//     BEFORE the paddle pose is smoothed or physics collision runs.
//   shouldFreezePaddle() — true if the pose read this frame is emulated
//     (paddle should not be updated to that pose).
//   shouldSuppressContact() — true while inside the 100 ms suppression
//     window that starts at the FIRST emulated frame and persists until
//     100 ms after the LAST emulated frame.
//
// All internal state is time-based on performance.now(). No allocation per
// frame — the pose object is cached and reused.

const FREEZE_WINDOW_MS = 100;

let _lastEmulatedTimestamp = -Infinity;
let _currentFrameEmulated = false;
let _lastPoseValid = false;

/**
 * Advance the guard for this frame. Safe to call with null args (non-XR
 * frames, or before the paddle is attached) — evaluates to "not frozen".
 */
export function update(frame, gripInputSource, referenceSpace) {
  _currentFrameEmulated = false;
  _lastPoseValid = false;

  if (!frame || !gripInputSource || !referenceSpace) return;

  const gripSpace = gripInputSource.gripSpace;
  if (!gripSpace) return;

  let pose;
  try {
    pose = frame.getPose(gripSpace, referenceSpace);
  } catch (e) {
    // Some runtimes throw on transient reference-space changes; treat as an
    // emulated frame (paddle freeze is the safer default).
    _currentFrameEmulated = true;
    _lastEmulatedTimestamp = performance.now();
    return;
  }

  if (!pose) {
    // No pose data at all — tracker just dropped. Treat as emulated so the
    // paddle freezes rather than snapping to origin.
    _currentFrameEmulated = true;
    _lastEmulatedTimestamp = performance.now();
    return;
  }

  _lastPoseValid = true;
  if (pose.emulatedPosition) {
    _currentFrameEmulated = true;
    _lastEmulatedTimestamp = performance.now();
  }
}

// True if the paddle pose in this frame is emulated / missing. The visual
// loop uses this to skip the anchor pose update (keeps last good pose).
export function shouldFreezePaddle() {
  return _currentFrameEmulated;
}

// True while inside the 100 ms suppression window after the most recent
// emulated frame. Physics uses this to skip paddle-ball contact resolution
// so a "teleported" paddle can't rocket the ball.
export function shouldSuppressContact() {
  return (performance.now() - _lastEmulatedTimestamp) < FREEZE_WINDOW_MS;
}

// Testing hook — resets internal state. Called by tests only.
export function _resetForTests() {
  _lastEmulatedTimestamp = -Infinity;
  _currentFrameEmulated = false;
  _lastPoseValid = false;
}

export function _wasPoseValidThisFrame() {
  return _lastPoseValid;
}
