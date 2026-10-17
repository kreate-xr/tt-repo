// Which hand holds the paddle.
//
// Split out of xrPaddle.js because that module imports the WebGL renderer at
// load time and so cannot be unit tested — while this policy is precisely the
// part that needs testing. A right-handed developer never sees the left-handed
// path fail; the original hardcoded 'right' shipped because nothing forced the
// question. These two functions are the whole policy, and both are pure.

// Used whenever the profile has no opinion (no store, unset value, or a value
// from a newer build that we don't recognise). Right-handed is the majority
// case, so it is the least-surprising default — but it is a DEFAULT, never an
// assumption baked into the binding logic.
export const DEFAULT_PADDLE_HAND = 'right';

/**
 * Map the profile's `dominantHand` setting ('L' | 'R') onto the WebXR
 * handedness string ('left' | 'right') that XRInputSource reports.
 *
 * Anything unrecognised falls back to the default rather than throwing: this
 * runs against persisted JSON that a hand-edited localStorage blob or an older
 * build could have put anything into.
 */
export function paddleHandFromSetting(setting) {
  return setting === 'L' ? 'left' : DEFAULT_PADDLE_HAND;
}

/**
 * Should a paddle currently bound to `currentHand` move to a grip that just
 * became available on `incomingHand`?
 *
 * Only when the incoming grip is the player's preferred hand and we are not
 * already on it. The asymmetry is the point: a controller waking up on the
 * NON-preferred hand must never steal the paddle, or the player loses their bat
 * mid-rally to a controller they aren't holding. The inverse — which is what
 * the hardcoded 'right' produced — is the left-handed bug: a lefty bound to
 * their left hand had the paddle yanked away the moment the right controller
 * connected or regained tracking.
 */
export function shouldSwitchPaddleHand(currentHand, incomingHand, preferredHand) {
  return incomingHand === preferredHand && currentHand !== preferredHand;
}

/**
 * Can the paddle be bound to this grip slot right now?
 *
 * Needs BOTH a live XRInputSource on the slot and a posed grip (non-zero
 * translation in `matrixElements`, a column-major Matrix4 `elements` array).
 * The pose alone is not enough: three.js's WebXRController.disconnect() only
 * hides the grip, it never clears its matrix, so a slot whose controller left
 * during the Quest system menu still carries its last pose. Binding to that
 * dead slot with no handedness was the wrong-hand-after-Meta-button bug — the
 * returning left controller re-used the slot, inherited the paddle, and the
 * stale 'right' handedness blocked every attempt to move it back.
 */
export function isGripBindable(inputSource, matrixElements) {
  if (!inputSource || !matrixElements) return false;
  const e = matrixElements;
  return Math.abs(e[12]) > 1e-4 || Math.abs(e[13]) > 1e-4 || Math.abs(e[14]) > 1e-4;
}
