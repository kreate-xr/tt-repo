// Interception path planner. V2 spec §section_2.
//
// Given: where the paddle is now, where the solver says it must be at
// contact (position + face normal + velocity), and the time budget until
// contact — produce a smooth 8-keyframe trajectory the FSM can read at
// 90Hz to drive the paddle through windup → strike → contact.
//
// Two-segment path per spec:
//   Windup phase  (first 60% of time budget): quadratic bezier from
//     currentPos → windupStart, control point = midpoint lifted +12cm.
//     The lift produces a natural arc (paddle doesn't move in a straight
//     line — robotic if it did).
//   Swing phase   (last 40% of time budget): hermite quintic from
//     windupStart → contactPos. Terminal velocity = solverPaddleVelocity,
//     terminal/initial acceleration = 0, initial velocity = 0. Quintic
//     guarantees C1 continuity inside the swing segment and lets the
//     paddle arrive with the EXACT velocity the solver requires (the
//     piece that makes the host's collision produce the engine's target
//     shot).
//
// Face rotation: slerp current → neutral during windup; neutral →
// solverFaceNormal during the LAST HALF of swing (≈T-150ms before
// contact — the visible telegraph window).
//
// 8 keyframes evenly spaced in time. The FSM linearly interpolates
// between bracketing keyframes for position and slerps for face normal.
// With 8 samples over typical ~400ms budget, sample spacing is ~57ms —
// well under the visual threshold for keyframe transitions.
//
// Speed validation: tracks peak instantaneous speed (finite-difference
// between adjacent keyframes). Returns reachable=false if peak exceeds
// max_paddle_speed × 1.1 — caller can downgrade to lunge-and-miss.

import * as THREE from 'three';

export const NUM_KEYFRAMES = 8;
export const WINDUP_FRACTION = 0.6;
export const SWING_FRACTION  = 0.4;

// Spec §section_2.algorithm.windup_phase_path: control-point midpoint
// raised 10-15cm. Midpoint of 12cm splits the spec range.
const BEZIER_CONTROL_Y_LIFT_M = 0.12;

// Spec §section_2.algorithm.speed_validation: peak ≤ cap × 1.1.
const SPEED_VALIDATION_TOLERANCE = 1.1;

// Fraction of swing phase where face starts rotating from neutral to the
// solver's contact normal. Spec §section_2.algorithm.face_rotation:
// "Telegraph rotation begins at the 50% mark of swing phase".
const FACE_TELEGRAPH_START_FRACTION = 0.5;

// --- Curve helpers (pure) -------------------------------------------------

// Quadratic bezier B(u) = (1-u)² P0 + 2u(1-u) P1 + u² P2.
function bezierAt(u, p0, p1, p2, out) {
  const omu = 1 - u;
  const a = omu * omu;
  const b = 2 * omu * u;
  const c = u * u;
  out.set(
    a * p0.x + b * p1.x + c * p2.x,
    a * p0.y + b * p1.y + c * p2.y,
    a * p0.z + b * p1.z + c * p2.z,
  );
  return out;
}

// Hermite quintic with:
//   p(0) = p0,  p'(0) = 0,  p''(0) = 0
//   p(1) = p1,  p'(1) = v1, p''(1) = 0
// Coefficients derived in interception.test.js comments. v1 is in
// curve-space (dp/du), i.e., world dp/dt × swingDuration_seconds.
function quinticAt(u, p0, p1, v1, out) {
  const u3 = u * u * u;
  const u4 = u3 * u;
  const u5 = u4 * u;
  const fp = 10 * u3 - 15 * u4 +  6 * u5;
  const fv = -4 * u3 +  7 * u4 -  3 * u5;
  out.set(
    p0.x + fp * (p1.x - p0.x) + fv * v1.x,
    p0.y + fp * (p1.y - p0.y) + fv * v1.y,
    p0.z + fp * (p1.z - p0.z) + fv * v1.z,
  );
  return out;
}

// Quintic derivative dp/du. Useful for verifying terminal velocity in tests.
function quinticDerivAt(u, p0, p1, v1, out) {
  const u2 = u * u;
  const u3 = u2 * u;
  const u4 = u3 * u;
  const dfp = 30 * u2 - 60 * u3 + 30 * u4;
  const dfv = -12 * u2 + 28 * u3 - 15 * u4;
  out.set(
    dfp * (p1.x - p0.x) + dfv * v1.x,
    dfp * (p1.y - p0.y) + dfv * v1.y,
    dfp * (p1.z - p0.z) + dfv * v1.z,
  );
  return out;
}

// Slerp two normalized 3D vectors. Returns out, normalized.
function slerpVec3(a, b, t, out) {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z;
  if (dot > 1) dot = 1;
  if (dot < -1) dot = -1;
  const theta = Math.acos(dot);
  if (Math.abs(theta) < 1e-6 || Math.abs(theta - Math.PI) < 1e-6) {
    // Degenerate; fall back to linear lerp + normalize.
    out.set(
      a.x + t * (b.x - a.x),
      a.y + t * (b.y - a.y),
      a.z + t * (b.z - a.z),
    );
    if (out.lengthSq() < 1e-12) out.copy(a);
    return out.normalize();
  }
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  out.set(
    wa * a.x + wb * b.x,
    wa * a.y + wb * b.y,
    wa * a.z + wb * b.z,
  );
  return out.normalize();
}

// --- Planner --------------------------------------------------------------

// Plan an 8-keyframe paddle trajectory from current pose to contact pose.
//
// args: {
//   currentPos, currentFaceNormal           Vector3 world — paddle now
//   contactPos, contactFaceNormal           Vector3 world — solver outputs
//   contactPaddleVelocity                   Vector3 world — solver's
//                                            required paddle velocity AT
//                                            contact moment (m/s)
//   timeBudgetMs                            ms from now until contact
//   maxPaddleSpeed                          m/s STRIKE cap from
//                                            paddleSolver.MAX_PADDLE_SPEED_MPS
//   maxApproachSpeed (optional)             m/s FOOTWORK cap from
//                                            aiPaddle.MOVEMENT_SPEED_MPS.
//                                            Defaults to maxPaddleSpeed.
//   neutralFaceNormal (optional)            Vector3 world — face during
//                                            windup. Defaults to a face
//                                            pointing XZ-toward target
//                                            with Y = 0 (body orientation).
// }
//
// Approach and strike are validated against SEPARATE caps, because they are
// different physical acts. Getting the body to the ball is footwork (~2-4 m/s
// even for elite players); accelerating the racket head through contact is
// arm speed (much faster). Validating both against the strike cap let a tier
// cover ground at its racket-head speed, which erased footwork as a
// difficulty dimension — see MOVEMENT_SPEED_MPS in aiPaddle.js.
//
// returns: {
//   keyframes:      Array<{ time_ms: number, position: Vector3, faceNormal: Vector3 }>
//                   length === NUM_KEYFRAMES, time_ms spans [0, timeBudgetMs]
//   reachable:      boolean — both phases within their own cap × 1.1
//   peakSpeed_mps:          number — overall peak
//   peakApproachSpeed_mps:  number — windup phase only
//   peakSwingSpeed_mps:     number — swing phase only
//   windupStart:    Vector3 — internal anchor (last windup keyframe ≈ here)
// }
export function planTrajectory({
  currentPos, currentFaceNormal,
  contactPos, contactFaceNormal, contactPaddleVelocity,
  timeBudgetMs, maxPaddleSpeed, maxApproachSpeed,
  neutralFaceNormal,
}) {
  // Back-compat: callers that don't distinguish the two get the old behaviour.
  const approachCap = (typeof maxApproachSpeed === 'number' && maxApproachSpeed > 0)
    ? maxApproachSpeed
    : maxPaddleSpeed;
  const windupDurationMs = timeBudgetMs * WINDUP_FRACTION;
  const swingDurationMs  = timeBudgetMs * SWING_FRACTION;
  const swingDurationS   = swingDurationMs / 1000;

  // Windup start = contact - swingDir × windupDistance.
  // windupDistance = |contactPaddleVelocity| × swingDuration × 0.5
  //   (rough average speed for the quintic with rest start ≈ half peak).
  const swingDir = new THREE.Vector3();
  const contactSpeed = contactPaddleVelocity.length();
  if (contactSpeed > 1e-6) {
    swingDir.copy(contactPaddleVelocity).multiplyScalar(1 / contactSpeed);
  } else {
    swingDir.set(0, 0, 1);
  }
  const windupDistance = contactSpeed * swingDurationS * 0.5;
  const windupStart = new THREE.Vector3()
    .copy(contactPos)
    .addScaledVector(swingDir, -windupDistance);

  // Bezier control point: midpoint of (currentPos, windupStart) raised +Y.
  const bezMid = new THREE.Vector3()
    .addVectors(currentPos, windupStart)
    .multiplyScalar(0.5);
  bezMid.y += BEZIER_CONTROL_Y_LIFT_M;

  // Quintic curve-space terminal velocity = (dp/dt at u=1) × swingDuration.
  const quinticV1 = new THREE.Vector3()
    .copy(contactPaddleVelocity)
    .multiplyScalar(swingDurationS);

  // Default neutral face = horizontal direction from current toward contact.
  const neutralFace = neutralFaceNormal ? neutralFaceNormal.clone() : (() => {
    const d = new THREE.Vector3().subVectors(contactPos, currentPos);
    d.y = 0;
    if (d.lengthSq() < 1e-6) d.copy(currentFaceNormal);
    return d.normalize();
  })();

  // Build 8 keyframes evenly spaced in time.
  const keyframes = [];
  let peakSpeed = 0;
  let peakApproachSpeed = 0;
  let peakSwingSpeed = 0;
  for (let i = 0; i < NUM_KEYFRAMES; i++) {
    const time_ms = (i / (NUM_KEYFRAMES - 1)) * timeBudgetMs;
    const position = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();

    if (time_ms <= windupDurationMs) {
      const u = windupDurationMs > 0 ? time_ms / windupDurationMs : 0;
      bezierAt(u, currentPos, bezMid, windupStart, position);
      slerpVec3(currentFaceNormal, neutralFace, u, faceNormal);
    } else {
      const u = swingDurationMs > 0
        ? (time_ms - windupDurationMs) / swingDurationMs
        : 0;
      quinticAt(u, windupStart, contactPos, quinticV1, position);
      // Face stays neutral for first 50% of swing, then slerps to contact.
      const faceU = Math.max(0, (u - FACE_TELEGRAPH_START_FRACTION))
                  / (1 - FACE_TELEGRAPH_START_FRACTION);
      slerpVec3(neutralFace, contactFaceNormal, Math.min(1, faceU), faceNormal);
    }

    // Track peak instantaneous speed via finite difference. Skip i=0.
    // A segment belongs to the approach phase if it ENDS inside the windup
    // window; the one segment straddling the boundary counts as swing, which
    // is the conservative choice (swing caps are the higher of the two).
    if (i > 0) {
      const k0 = keyframes[i - 1];
      const dtSec = (time_ms - k0.time_ms) / 1000;
      if (dtSec > 0) {
        const dist = position.distanceTo(k0.position);
        const speed = dist / dtSec;
        if (speed > peakSpeed) peakSpeed = speed;
        if (time_ms <= windupDurationMs) {
          if (speed > peakApproachSpeed) peakApproachSpeed = speed;
        } else if (speed > peakSwingSpeed) {
          peakSwingSpeed = speed;
        }
      }
    }
    keyframes.push({ time_ms, position, faceNormal });
  }

  const approachOk = peakApproachSpeed <= approachCap    * SPEED_VALIDATION_TOLERANCE;
  const strikeOk   = peakSwingSpeed    <= maxPaddleSpeed * SPEED_VALIDATION_TOLERANCE;
  const reachable = approachOk && strikeOk;
  return {
    keyframes,
    reachable,
    peakSpeed_mps: peakSpeed,
    peakApproachSpeed_mps: peakApproachSpeed,
    peakSwingSpeed_mps: peakSwingSpeed,
    windupStart,
  };
}

// Find the bracketing keyframes for `elapsedMs` and linearly interpolate
// position + slerp face normal between them. Writes into `outPos` and
// `outFaceN`. Returns true on success, false if keyframes is empty.
//
// We use linear position interpolation between keyframes (not Catmull-Rom)
// because with 8 evenly-spaced samples on smooth curves the visible
// artifact of linear vs spline is minimal and the math is simpler.
// Phase 7 polish can swap in Catmull-Rom if testers notice.
export function interpolateTrajectory(keyframes, elapsedMs, outPos, outFaceN) {
  if (!keyframes || keyframes.length === 0) return false;
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (elapsedMs <= first.time_ms) {
    outPos.copy(first.position);
    outFaceN.copy(first.faceNormal);
    return true;
  }
  if (elapsedMs >= last.time_ms) {
    outPos.copy(last.position);
    outFaceN.copy(last.faceNormal);
    return true;
  }
  // Binary search bracket.
  let lo = 0, hi = keyframes.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid].time_ms <= elapsedMs) lo = mid;
    else hi = mid;
  }
  const k0 = keyframes[lo];
  const k1 = keyframes[hi];
  const span = k1.time_ms - k0.time_ms;
  const t = span > 0 ? (elapsedMs - k0.time_ms) / span : 0;
  outPos.set(
    k0.position.x + t * (k1.position.x - k0.position.x),
    k0.position.y + t * (k1.position.y - k0.position.y),
    k0.position.z + t * (k1.position.z - k0.position.z),
  );
  slerpVec3(k0.faceNormal, k1.faceNormal, t, outFaceN);
  return true;
}

// Test-only helpers re-exported for the test suite. Not part of the public
// runtime API but stable across Phase 2-7.
export const _internals = {
  bezierAt,
  quinticAt,
  quinticDerivAt,
  slerpVec3,
};
