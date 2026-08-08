// Pure-function regression tests for the extracted impulse helper. The
// host's tryPaddleCollision in js/physics/ball.js now delegates to this
// helper; the existing 125 tests already serve as the bit-identical
// behavioral regression. These additional tests pin the math against
// hand-computed values so future refactors don't drift silently.

const THREE = require('three');

import { computeImpulse } from '../js/physics/impulse.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

describe('computeImpulse — analytical cases', () => {
  test('stationary paddle, normal-incidence ball reflects with restitution × incoming', () => {
    // Ball moving toward +x at 5 m/s, paddle stationary facing -x (normal points -x toward ball).
    // velDot = (ballV - paddleV) · faceNormal = (5,0,0) · (-1,0,0) = -5 (negative = closing).
    // ballV_out = ballV - (1+e) * velDot * n = (5,0,0) - (1.65)*(-5)*(-1,0,0) = (5,0,0) - (8.25,0,0) = (-3.25,0,0).
    // Speed magnitude 3.25 = 0.65 × 5 (matches restitution).
    const result = computeImpulse(
      v(5, 0, 0), v(0, 0, 0), v(0, 0, 0),
      v(0, 0, 0), null, null,
      v(-1, 0, 0),
      0.02, 0.65, 35,
    );
    expect(result.ballV_out.x).toBeCloseTo(-3.25, 8);
    expect(result.ballV_out.y).toBeCloseTo(0, 8);
    expect(result.ballV_out.z).toBeCloseTo(0, 8);
    expect(result.velDot).toBeCloseTo(-5, 8);
    expect(result.impactSpeed).toBeCloseTo(5, 8);
  });

  test('paddle moving toward ball adds (1+e)×v_paddle on top of elastic reflection', () => {
    // Ball at -3 m/s (already moving toward -x); paddle moving at +4 m/s toward +x.
    // relativeVel = (-3,0,0) - (4,0,0) = (-7,0,0)
    // velDot = (-7) · (-1,0,0) = 7? wait normal is -1, so 7 > 0 means already moving away.
    // Let me redo. Ball moving toward +x at 3, paddle moving toward +x at 4. Both moving same direction.
    // relativeVel = (3,0,0) - (4,0,0) = (-1,0,0)
    // faceNormal = (-1,0,0) (points from paddle face toward ball-incoming side)
    // velDot = -1 * -1 = 1 > 0 → "ball moving away from paddle" branch → +0.5 nudge.
    // Less interesting. Let me try a clearer case:
    // Ball moving in -x at 3 m/s (toward paddle), paddle moving in -x at 4 m/s away from ball.
    // Hm let's just use the canonical setup: ball flies +x, paddle flies +x faster.
    // Wait — for paddle to STRIKE ball, paddle must move IN the same direction as the resulting ball.
    // Real case: ball flies toward paddle (ball: +x), paddle strikes back (paddle: -x).
    // Ball at +5, paddle at -3. faceNormal = (-1,0,0).
    // relativeVel = ballV - paddleV = (5,0,0) - (-3,0,0) = (8,0,0).
    // velDot = (8) · (-1,0,0) = -8 → closing branch.
    // ballV_out = (5,0,0) - (1+0.65)*(-8)*(-1,0,0) = (5,0,0) - (13.2,0,0) = (-8.2,0,0).
    // Sanity: e×|v_ball_in| + (1+e)×|v_paddle| = 0.65×5 + 1.65×3 = 3.25 + 4.95 = 8.2. ✓
    const result = computeImpulse(
      v(5, 0, 0), v(0, 0, 0), v(0, 0, 0),
      v(-3, 0, 0), null, null,
      v(-1, 0, 0),
      0.02, 0.65, 35,
    );
    expect(result.ballV_out.x).toBeCloseTo(-8.2, 6);
    expect(result.impactSpeed).toBeCloseTo(8, 6);
  });

  test('ball moving away from paddle (velDot >= 0) gets gentle outward nudge, not full reflection', () => {
    // Ball moving in +x at 1, paddle stationary, faceNormal points +x (away from ball direction).
    // relativeVel = (1,0,0), velDot = +1 → "moving away" branch.
    // ballV_out = (1,0,0) + 0.5 * (+1,0,0) = (1.5,0,0).
    const result = computeImpulse(
      v(1, 0, 0), v(0, 0, 0), v(0, 0, 0),
      v(0, 0, 0), null, null,
      v(1, 0, 0),
      0.02, 0.65, 35,
    );
    expect(result.ballV_out.x).toBeCloseTo(1.5, 8);
  });

  test('does NOT mutate input vectors (pure function)', () => {
    const ballV = v(5, 0, 0);
    const ballW = v(0, 0, 0);
    const ballPos = v(0, 0, 0);
    const paddleV = v(-3, 0, 0);
    const faceNormal = v(-1, 0, 0);
    const ballVCopy = ballV.clone();
    const ballWCopy = ballW.clone();
    const paddleVCopy = paddleV.clone();
    const faceNCopy = faceNormal.clone();
    computeImpulse(ballV, ballW, ballPos, paddleV, null, null, faceNormal, 0.02, 0.65, 35);
    expect(ballV.equals(ballVCopy)).toBe(true);
    expect(ballW.equals(ballWCopy)).toBe(true);
    expect(paddleV.equals(paddleVCopy)).toBe(true);
    expect(faceNormal.equals(faceNCopy)).toBe(true);
  });

  test('contactSpeedCap tanh soft-clip: |v|<<cap ≈ 1:1, |v|=cap ≈ 76%, |v|>>cap bounded by cap', () => {
    // Paddle at 2 m/s with cap=6.5: scale = 6.5·tanh(2/6.5)/2 = 6.5·0.2988/2 ≈ 0.971 → 1.94 m/s.
    const cap = 6.5;
    const softClip = (s) => cap * Math.tanh(s / cap);
    const lowCase = computeImpulse(
      v(0, 0, 0), v(0, 0, 0), v(0, 0, 0),
      v(-2, 0, 0), null, null,
      v(-1, 0, 0),
      0.02, 0.82, 35,
      { contactSpeedCap: cap },
    );
    expect(-lowCase.vContact.x).toBeCloseTo(softClip(2), 4);   // ≈ 1.94
    expect(-lowCase.vContact.x).toBeLessThan(2);               // clipped, even if slightly

    const atCap = computeImpulse(
      v(0, 0, 0), v(0, 0, 0), v(0, 0, 0),
      v(-6.5, 0, 0), null, null,
      v(-1, 0, 0),
      0.02, 0.82, 35,
      { contactSpeedCap: cap },
    );
    expect(-atCap.vContact.x).toBeCloseTo(softClip(6.5), 4);   // ≈ 4.95 (76%)

    const hardSwing = computeImpulse(
      v(0, 0, 0), v(0, 0, 0), v(0, 0, 0),
      v(-15, 0, 0), null, null,
      v(-1, 0, 0),
      0.02, 0.82, 35,
      { contactSpeedCap: cap },
    );
    expect(-hardSwing.vContact.x).toBeLessThan(cap);           // bounded by cap
    expect(-hardSwing.vContact.x).toBeCloseTo(softClip(15), 4); // ≈ 6.49
  });

  test('paddle angular velocity contributes to contact-point velocity via ω × r', () => {
    // Paddle face center at origin, paddle ω = (0, 0, 5) rad/s (spin around z).
    // pivot also at origin. Ball at (0, 0.05, 0) — slightly above center.
    // r_contact = ballPos - faceNormal*radius - pivot = (0, 0.05, 0) - (-0.02, 0, 0) = (0.02, 0.05, 0).
    // ω × r = (0,0,5) × (0.02, 0.05, 0) = (-0.25, 0.10, 0).
    // vContact = paddleV + ω × r = (0,0,0) + (-0.25, 0.10, 0).
    // We don't check the full reflection here — just verify vContact has the rotation contribution.
    const result = computeImpulse(
      v(0, 0, 0), v(0, 0, 0), v(0, 0.05, 0),
      v(0, 0, 0), v(0, 0, 5), v(0, 0, 0),
      v(-1, 0, 0),
      0.02, 0.65, 35,
    );
    expect(result.vContact.x).toBeCloseTo(-0.25, 6);
    expect(result.vContact.y).toBeCloseTo(0.10, 6);
    expect(result.vContact.z).toBeCloseTo(0, 6);
  });
});
