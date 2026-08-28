// Pure geometric collision helpers.
// No side effects; module state is limited to reused scratch below.

import * as THREE from 'three';

// This function runs on the render hot path — once per registered paddle per
// XR frame, including the ~99.9% of frames with no contact — so it must not
// allocate (GC pauses on Quest's mobile heap read as dropped frames).
//
// The returned object and its Vector3 fields are REUSED across calls: consume
// the result before the next detectDiscCollision call and never store it or
// its vectors. Every current caller (ball.js tryPaddleCollision, the models.js
// startup self-test, unit tests) reads the result synchronously.
const _offsetPrev = new THREE.Vector3();
const _offsetCurr = new THREE.Vector3();
const _result = {
  hit: false,
  faceHit: false,
  edgeHit: false,
  crossed: false,
  dPrev: 0,
  dCurr: 0,
  t: 0,
  crossBallPos: new THREE.Vector3(),
  crossFaceCenter: new THREE.Vector3(),
  onPlane: new THREE.Vector3(),
  radialDist: 0,
  reflectNormal: new THREE.Vector3(),
};

// Detects whether a ball crossed a paddle face disc between two frames.
// Returns { hit, faceHit, edgeHit, crossed, dPrev, dCurr, t, crossBallPos,
//          crossFaceCenter, onPlane, radialDist, reflectNormal }.
// On a non-crossing frame only the flags and dPrev/dCurr are meaningful; the
// geometric fields hold stale values from the last crossing call.
//
// faceHit vs edgeHit split:
//   - `faceHit` — ball center is over the paddle rubber face (`radialDist <
//     faceRadius`). Standard rubber-face physics apply.
//   - `edgeHit` — ball is straddling the rim; center is outside the face but
//     the ball body still overlaps the disc (`faceRadius <= radialDist <
//     hitRadius + bRadius`). Callers can override restitution / spin capture
//     / normal to model a wood-blade edge strike. `hit` stays true so
//     downstream position correction still fires; only the impulse math is
//     re-parameterized by the caller.
//   - Neither is set when `radialDist >= hitRadius + bRadius` (clean miss).
//
// `hitRadius` is the swing-expanded catch radius (may include swingMargin);
// `faceRadius` is the physical rubber radius used solely for the face/edge
// split. When omitted, `faceRadius = hitRadius` (original single-zone
// behavior for callers that don't care about edge detection).
export function detectDiscCollision(prevBallPos, currBallPos, prevFaceCenter, currFaceCenter,
                                    prevFaceNormal, currFaceNormal, hitRadius, bRadius, dt,
                                    faceRadius) {
  if (faceRadius === undefined) faceRadius = hitRadius;
  _offsetPrev.copy(prevBallPos).sub(prevFaceCenter);
  _offsetCurr.copy(currBallPos).sub(currFaceCenter);
  const dPrev = _offsetPrev.dot(prevFaceNormal);
  const dCurr = _offsetCurr.dot(currFaceNormal);
  _result.dPrev = dPrev;
  _result.dCurr = dCurr;

  // Velocity-scaled proximity threshold for gentle contact
  const closingSpeed = Math.abs(dPrev - dCurr) / Math.max(dt, 0.001);
  const proximityThreshold = bRadius + Math.min(closingSpeed * dt * 0.5, 0.05);

  const crossed = (dPrev * dCurr < 0) ||
                  (Math.abs(dCurr) < proximityThreshold && Math.abs(dPrev) < proximityThreshold + 0.05);

  if (!crossed) {
    _result.hit = false;
    _result.faceHit = false;
    _result.edgeHit = false;
    _result.crossed = false;
    return _result;
  }

  let t = 0.5;
  const dDiff = dPrev - dCurr;
  if (Math.abs(dDiff) > 1e-6) {
    t = dPrev / dDiff;
    t = Math.max(0, Math.min(1, t));
  }
  _result.t = t;

  _result.crossBallPos.copy(prevBallPos).lerp(currBallPos, t);
  _result.crossFaceCenter.copy(prevFaceCenter).lerp(currFaceCenter, t);

  _result.onPlane.copy(_result.crossBallPos).sub(_result.crossFaceCenter);
  const normalDist = _result.onPlane.dot(currFaceNormal);
  _result.onPlane.addScaledVector(currFaceNormal, -normalDist);
  const radialDist = _result.onPlane.length();
  _result.radialDist = radialDist;

  _result.reflectNormal.copy(currFaceNormal);
  if (dPrev < 0) _result.reflectNormal.negate();

  const faceHit = radialDist < faceRadius;
  const edgeHit = !faceHit && radialDist < hitRadius + bRadius;
  _result.faceHit = faceHit;
  _result.edgeHit = edgeHit;
  _result.hit = faceHit || edgeHit;
  _result.crossed = true;

  return _result;
}
