// Pure geometric collision helpers.
// No module state, no side effects.

// Detects whether a ball crossed a paddle face disc between two frames.
// Returns { hit, faceHit, edgeHit, crossed, dPrev, dCurr, t?, crossBallPos?,
//          crossFaceCenter?, onPlane?, radialDist?, reflectNormal? }.
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
  const offsetPrev = prevBallPos.clone().sub(prevFaceCenter);
  const offsetCurr = currBallPos.clone().sub(currFaceCenter);
  const dPrev = offsetPrev.dot(prevFaceNormal);
  const dCurr = offsetCurr.dot(currFaceNormal);

  // Velocity-scaled proximity threshold for gentle contact
  const closingSpeed = Math.abs(dPrev - dCurr) / Math.max(dt, 0.001);
  const proximityThreshold = bRadius + Math.min(closingSpeed * dt * 0.5, 0.05);

  const crossed = (dPrev * dCurr < 0) ||
                  (Math.abs(dCurr) < proximityThreshold && Math.abs(dPrev) < proximityThreshold + 0.05);

  if (!crossed) {
    return { hit: false, faceHit: false, edgeHit: false, crossed: false, dPrev, dCurr };
  }

  let t = 0.5;
  const dDiff = dPrev - dCurr;
  if (Math.abs(dDiff) > 1e-6) {
    t = dPrev / dDiff;
    t = Math.max(0, Math.min(1, t));
  }

  const crossBallPos = prevBallPos.clone().lerp(currBallPos, t);
  const crossFaceCenter = prevFaceCenter.clone().lerp(currFaceCenter, t);

  const crossOffset = crossBallPos.clone().sub(crossFaceCenter);
  const normalDist = crossOffset.dot(currFaceNormal);
  const onPlane = crossOffset.clone().addScaledVector(currFaceNormal, -normalDist);
  const radialDist = onPlane.length();

  const reflectNormal = currFaceNormal.clone();
  if (dPrev < 0) reflectNormal.negate();

  const faceHit = radialDist < faceRadius;
  const edgeHit = !faceHit && radialDist < hitRadius + bRadius;
  const hit = faceHit || edgeHit;

  return { hit, faceHit, edgeHit, crossed: true, dPrev, dCurr, t, crossBallPos, crossFaceCenter, onPlane, radialDist, reflectNormal };
}
