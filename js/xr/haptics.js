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

// Foul buzz — the umpire's whistle, felt rather than heard.
//
// Fired when the local player breaks a rule (illegal volley, serve struck
// from over the table). It has to be unmistakably NOT a ball contact: an
// impact is one sharp attack with a decaying tail, so this is the opposite
// shape — three flat, evenly spaced, equal-strength buzzes. Rhythm is what
// makes it read as a signal instead of a collision, and it lands at the
// moment of the offence, well before the result panel explains it.
const FOUL_PULSE_MS = 90;
const FOUL_GAP_MS = 70;
const FOUL_PULSE_COUNT = 3;
const FOUL_INTENSITY = 0.7;

export function pulseFoul() {
  if (!activeHandedness) return;
  const hand = activeHandedness;
  for (let i = 0; i < FOUL_PULSE_COUNT; i++) {
    const delay = i * (FOUL_PULSE_MS + FOUL_GAP_MS);
    if (delay === 0) {
      pulseHand(hand, FOUL_INTENSITY, FOUL_PULSE_MS);
      continue;
    }
    setTimeout(() => {
      // The paddle may have changed hands (or the session ended) between
      // scheduling and firing — same guard as pulseImpact's tail.
      if (activeHandedness === hand) pulseHand(hand, FOUL_INTENSITY, FOUL_PULSE_MS);
    }, delay);
  }
}

// Continuous-swing haptic. Called every physics tick with the current paddle
// speed; fires a short pulse whose intensity scales with speed above the
// threshold. The pulses overlap on the Quest haptic motor and produce a
// continuous "drag through air" sensation. Below threshold this is a no-op.
// `curve` shapes the speed→intensity ramp. It used to be hardcoded to 2 (a
// square) to keep light hand-positioning silent, but the threshold already
// does that job, and squaring on top of it crushed the entire mid-range where
// wrist strokes actually live: a 2.5 m/s flick came out at 0.009 intensity —
// three orders below anything a Quest motor can render. The deadzone is the
// threshold's job; the curve's job is only to keep the ramp from feeling
// front-loaded. Exponents near 1.4 do that without deleting the mid-range.
export function pulseSwing(speed, threshold, maxSpeed, maxIntensity, durationMs, curve = 1.4) {
  if (!activeHandedness || speed < threshold) return;
  const range = Math.max(0.001, maxSpeed - threshold);
  const t = Math.min((speed - threshold) / range, 1);
  const intensity = maxIntensity * Math.pow(t, curve);
  pulseHand(activeHandedness, intensity, durationMs);
}
