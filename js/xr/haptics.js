// WebXR haptics wrapper. The Meta Quest browser exposes haptic actuators via
// the Gamepad API on each XRInputSource — `gamepad.hapticActuators[0].pulse(value, durationMs)`.
// Some older Quest builds also expose `inputSource.hapticActuators` directly
// (legacy WebXR draft); we probe both. No-ops gracefully on desktop / non-XR
// or when the device lacks haptics.

let currentSession = null;
let activeHandedness = null;

export function setSession(session) {
  currentSession = session || null;
  if (!session) {
    activeHandedness = null;
    return;
  }
  session.addEventListener('end', () => {
    if (currentSession === session) {
      currentSession = null;
      activeHandedness = null;
    }
  });
}

// Called by xrPaddle when the paddle attaches / re-attaches to a hand. Lets
// ball.js fire haptics without knowing which controller currently holds the paddle.
export function setActiveHandedness(hand) {
  activeHandedness = hand || null;
}

function getActuator(inputSource) {
  if (!inputSource) return null;
  const gp = inputSource.gamepad;
  if (gp && gp.hapticActuators && gp.hapticActuators[0]) return gp.hapticActuators[0];
  if (inputSource.hapticActuators && inputSource.hapticActuators[0]) return inputSource.hapticActuators[0];
  return null;
}

// Fire a single haptic pulse on the controller matching `handedness` ('left' | 'right').
// intensity in [0, 1]; duration in milliseconds. Silently no-ops if the session
// or actuator is missing.
export function pulseHand(handedness, intensity, durationMs) {
  if (!currentSession || !handedness) return;
  const v = Math.min(Math.max(intensity, 0), 1);
  const d = Math.max(0, durationMs | 0);
  if (v <= 0 || d <= 0) return;
  for (const src of currentSession.inputSources) {
    if (src.handedness !== handedness) continue;
    const act = getActuator(src);
    if (act && typeof act.pulse === 'function') {
      // pulse() returns a Promise that resolves when the pulse completes.
      // We don't await — fire-and-forget so callers don't block on the physics tick.
      try { act.pulse(v, d); } catch { /* device rejected — ignore */ }
    }
    return;
  }
}

// Convenience — fire on whichever hand currently holds the paddle. Used by
// the physics tick for impact / bounce feedback.
export function pulseActive(intensity, durationMs) {
  if (activeHandedness) pulseHand(activeHandedness, intensity, durationMs);
}

// Extended impact envelope: main pulse followed by a low-intensity tail after
// the main one finishes. A 120 ms flat buzz reads as a "click"; adding a 100 ms
// tail at ~40% intensity extends the felt event to ~220 ms without adding a
// second sharp attack. Longer envelopes psychoacoustically read as more mass
// transfer — the arm-nerve integration window is ~200 ms.
export function pulseImpact(intensity, durationMs) {
  if (!activeHandedness) return;
  const hand = activeHandedness;
  const v = Math.min(Math.max(intensity, 0), 1);
  const d = Math.max(0, durationMs | 0);
  if (v <= 0 || d <= 0) return;
  pulseHand(hand, v, d);
  // Tail: fire after the main pulse completes so the two overlap smoothly
  // on the motor rather than stacking a single stronger pulse.
  const tailIntensity = v * 0.4;
  const tailDuration  = Math.min(100, Math.max(60, d));
  setTimeout(() => {
    // Guard: hand may have changed (paddle re-attached, session ended) between
    // scheduling and firing; only tail-buzz if the paddle is still on the same
    // hand we impacted with.
    if (activeHandedness === hand) pulseHand(hand, tailIntensity, tailDuration);
  }, d);
}

// Continuous-swing haptic. Called every physics tick with the current paddle
// speed; fires a short pulse whose intensity scales with speed above the
// threshold. The pulses overlap on the Quest haptic motor and produce a
// continuous "drag through air" sensation. Below threshold this is a no-op.
export function pulseSwing(speed, threshold, maxSpeed, maxIntensity, durationMs) {
  if (!activeHandedness || speed < threshold) return;
  const range = Math.max(0.001, maxSpeed - threshold);
  const t = Math.min((speed - threshold) / range, 1);
  // Square the curve so light hand-positioning movement reads as silent and
  // only deliberate swings produce noticeable buzz.
  const intensity = maxIntensity * t * t;
  pulseHand(activeHandedness, intensity, durationMs);
}
