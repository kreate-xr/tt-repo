// Collision detection tests — face vs edge zone split.
//
// Pins the geometric boundary so the edge-hit code path in
// js/physics/ball.js stays wired to the correct radial band:
//   radialDist < hitRadius              → face hit (rubber)
//   hitRadius <= radialDist < h + bR    → edge hit (wood rim)
//   radialDist >= hitRadius + bRadius   → clean miss

const THREE = require('three');
import { detectDiscCollision } from '../js/physics/collisions.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

describe('detectDiscCollision — face vs edge zones', () => {
  const HIT_RADIUS = 0.08;
  const BALL_RADIUS = 0.02;
  const DT = 0.016;

  // Paddle stationary, face at origin, normal pointing +Y.
  // Ball crosses the plane going -Y at various radial offsets.
  function crossingAt(radialOffset) {
    const prev = v(radialOffset, 0.05, 0);
    const curr = v(radialOffset, -0.05, 0);
    const faceCenter = v(0, 0, 0);
    const faceNormal = v(0, 1, 0);
    return detectDiscCollision(
      prev, curr, faceCenter, faceCenter, faceNormal, faceNormal,
      HIT_RADIUS, BALL_RADIUS, DT,
    );
  }

  test('dead center → faceHit true, edgeHit false', () => {
    const r = crossingAt(0);
    expect(r.hit).toBe(true);
    expect(r.faceHit).toBe(true);
    expect(r.edgeHit).toBe(false);
  });

  test('just inside face rim → faceHit true, edgeHit false', () => {
    const r = crossingAt(HIT_RADIUS - 0.005);
    expect(r.faceHit).toBe(true);
    expect(r.edgeHit).toBe(false);
  });

  test('ball straddling the rim → edgeHit true, faceHit false', () => {
    const r = crossingAt(HIT_RADIUS + 0.005);  // inside the ballRadius band
    expect(r.hit).toBe(true);
    expect(r.faceHit).toBe(false);
    expect(r.edgeHit).toBe(true);
  });

  test('ball just barely overlapping the disc → edgeHit', () => {
    const r = crossingAt(HIT_RADIUS + BALL_RADIUS - 0.001);
    expect(r.edgeHit).toBe(true);
    expect(r.faceHit).toBe(false);
  });

  test('ball fully clear of the disc → no hit', () => {
    const r = crossingAt(HIT_RADIUS + BALL_RADIUS + 0.005);
    expect(r.hit).toBe(false);
    expect(r.faceHit).toBe(false);
    expect(r.edgeHit).toBe(false);
  });

  test('swing-expanded hitRadius does NOT shift the face/edge boundary', () => {
    // Simulates a fast paddle swing where the caller expands hitRadius by
    // swingMargin but wants the face/edge split to stay at the physical rim.
    const FACE_R = 0.08;
    const EXPANDED_R = 0.11;  // face + 3 cm swing margin
    const prev = v(FACE_R + 0.005, 0.05, 0);  // just past the physical rim
    const curr = v(FACE_R + 0.005, -0.05, 0);
    const c = v(0, 0, 0);
    const n = v(0, 1, 0);
    const r = detectDiscCollision(
      prev, curr, c, c, n, n,
      EXPANDED_R, BALL_RADIUS, DT,
      FACE_R,  // faceRadius = physical rim
    );
    expect(r.faceHit).toBe(false);
    expect(r.edgeHit).toBe(true);
  });

  test('faceRadius omitted → single-zone behavior (backward compat)', () => {
    // Callers that don't care about the split (e.g., self-test in models.js)
    // pass no faceRadius; everything inside hitRadius becomes faceHit.
    const prev = v(HIT_RADIUS - 0.005, 0.05, 0);
    const curr = v(HIT_RADIUS - 0.005, -0.05, 0);
    const c = v(0, 0, 0);
    const n = v(0, 1, 0);
    const r = detectDiscCollision(
      prev, curr, c, c, n, n,
      HIT_RADIUS, BALL_RADIUS, DT,
    );
    expect(r.faceHit).toBe(true);
    expect(r.edgeHit).toBe(false);
  });

  test('no plane crossing → all false, crossed false', () => {
    // Ball stays on the +Y side entirely.
    const prev = v(0, 0.10, 0);
    const curr = v(0, 0.08, 0);
    const faceCenter = v(0, 0, 0);
    const faceNormal = v(0, 1, 0);
    const r = detectDiscCollision(
      prev, curr, faceCenter, faceCenter, faceNormal, faceNormal,
      HIT_RADIUS, BALL_RADIUS, DT,
    );
    expect(r.hit).toBe(false);
    expect(r.faceHit).toBe(false);
    expect(r.edgeHit).toBe(false);
  });
});
