// Physical reference pins — the sim measured against the real ball.
//
// Every other physics test in this suite is either relative (topspin dips
// MORE than flat) or internal (the bounce uses the function it says it uses).
// None of them said what a 40 mm, 2.7 g ball actually does, which is how the
// 2026-08 realism pass could ship drag 30% above textbook, a Magnus model
// ~1.8× the empirical lift at loop spin and a table that lost 0.12 of COR
// between the certification speed and rally pace — all documented as feel
// choices, all invisible to the tests, and all reported by the first tester
// who plays real table tennis ("first hit too hard; after the bounce the ball
// gets heavy and falls too fast").
//
// These assertions pin the sim to numbers that come from outside the code:
//   - the ITTF certification drop test (30 cm → ~23 cm rebound)
//   - k = ½·ρ·Cd·A/m for the regulation ball
//   - the empirical sphere lift fit CL ≈ 1/(2 + v/(ωr))
//   - the hollow-sphere friction couple at the PHYSICAL capture gain, even
//     on a compensated player contact
// Tolerances are as wide as the underlying measurements are uncertain, and no
// wider. A change that moves the sim outside them is a physics claim and
// should say so in the constant's comment.

const THREE = require('three');

import { integrateFlightStep, applyTableBounce } from '../js/physics/rollout.js';
import { computeImpulse, HOLLOW_SPHERE_MOI_FACTOR } from '../js/physics/impulse.js';
import {
  GRAVITY, BUOYANCY_ACCEL, DRAG_COEFFICIENT, SPIN_CAPTURE_GAIN,
  PLAYER_SPIN_GAIN, tableRestitution,
} from '../js/physics/constants.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const R = 0.02;

describe('table: ITTF certification drop test', () => {
  // ITTF Technical Leaflet T3: a ball dropped from 30 cm onto the playing
  // surface must rebound 23-26 cm (measured at the bottom of the ball, on a
  // standard steel block ~24-26 cm; on the table itself ~23 cm). Impact
  // speed from 30 cm is √(2·g·0.30) ≈ 2.43 m/s.
  const impact = Math.sqrt(2 * 9.81 * 0.30);

  test('coefficient of restitution at the certification impact speed', () => {
    const e = tableRestitution(impact);
    expect(e).toBeGreaterThanOrEqual(0.865);
    expect(e).toBeLessThanOrEqual(0.895);
  });

  test('a ball dropped from 30 cm rebounds to ~23 cm through the live integrator', () => {
    const surfaceY = 0.76;
    const contactY = surfaceY + R;
    const dt = 1 / 240;
    const pos = v3(0, contactY + 0.30, 0);
    const vel = v3(0, 0, 0);
    const spin = v3(0, 0, 0);
    let bounced = false;
    let apex = 0;
    for (let i = 0; i < 2000; i++) {
      integrateFlightStep(pos, vel, spin, dt);
      if (!bounced) {
        if (pos.y <= contactY && vel.y < 0) {
          pos.y = contactY;
          applyTableBounce(vel, spin, R);
          bounced = true;
        }
      } else {
        apex = Math.max(apex, pos.y - contactY);
        if (vel.y < 0) break;
      }
    }
    expect(bounced).toBe(true);
    expect(apex).toBeGreaterThanOrEqual(0.21);
    expect(apex).toBeLessThanOrEqual(0.25);
  });

  test('the curve stays near the certified value at rally speed', () => {
    // Only the certification point is a measured number. Above it the deck
    // may lose a little more (wood flexes, the ball deforms more), but not
    // the 0.12 the previous curve took between 2.4 and 10 m/s.
    expect(tableRestitution(5) - tableRestitution(10)).toBeLessThanOrEqual(0.04);
    expect(tableRestitution(10)).toBeGreaterThanOrEqual(0.80);
    let prev = tableRestitution(0);
    for (let s = 0.5; s <= 15; s += 0.5) {
      const e = tableRestitution(s);
      expect(e).toBeLessThanOrEqual(prev + 1e-12);
      prev = e;
    }
  });
});

describe('air: quadratic drag for the regulation ball', () => {
  test('k = ½·ρ·Cd·A/m with Cd in the sub-critical sphere range', () => {
    // ρ = 1.2 kg/m³, A = π·(0.02)², m = 0.0027 kg → k = 0.279·Cd.
    // Cd for a smooth sphere at the ball's Reynolds number (~2e4) is
    // 0.45-0.50, so k lies in 0.126-0.140.
    expect(DRAG_COEFFICIENT).toBeGreaterThanOrEqual(0.11);
    expect(DRAG_COEFFICIENT).toBeLessThanOrEqual(0.14);
  });
});

describe('air: Magnus lift saturates with spin like a real sphere', () => {
  // Empirical fit for a spinning sphere: CL ≈ 1/(2 + v/(ω·r)). With
  // K = ½·ρ·A/m = 0.279 m⁻¹ the acceleration is K·CL·v² perpendicular to
  // both ω and v. A linear a = k·(ω × v) model can match this at ONE spin
  // and over-predicts above it — at 300 rad/s it read 9.6 m/s² against 5.4.
  function magnusAccel(omega, speed) {
    // ω about -z, v along +x → ω × v is purely along -y, so the Magnus term
    // is isolated on the y axis and gravity + buoyancy can be subtracted out.
    const dt = 1e-3;
    const pos = v3(0, 1, 0);
    const vel = v3(speed, 0, 0);
    const spin = v3(0, 0, -omega);
    integrateFlightStep(pos, vel, spin, dt);
    const ay = vel.y / dt - (GRAVITY + BUOYANCY_ACCEL);
    return Math.abs(ay);
  }

  function physicalFit(omega, speed) {
    const K = 0.5 * 1.2 * Math.PI * R * R / 0.0027;
    const CL = 1 / (2 + speed / (omega * R));
    return K * CL * speed * speed;
  }

  test('light rally spin (100 rad/s, 8 m/s) sits at the fit', () => {
    const a = magnusAccel(100, 8);
    expect(a).toBeGreaterThanOrEqual(3.0);
    expect(a).toBeLessThanOrEqual(3.3);
    expect(physicalFit(100, 8)).toBeCloseTo(3.0, 1);
  });

  test('loop spin (300 rad/s, 8 m/s) is within 20% of the fit, not 1.8× it', () => {
    const a = magnusAccel(300, 8);
    const fit = physicalFit(300, 8);
    expect(fit).toBeCloseTo(5.4, 1);
    expect(a).toBeGreaterThanOrEqual(fit * 0.8);
    expect(a).toBeLessThanOrEqual(fit * 1.2);
  });

  test('elite loop spin (400 rad/s, 10 m/s) is within 20% of the fit', () => {
    const a = magnusAccel(400, 10);
    const fit = physicalFit(400, 10);
    expect(a).toBeGreaterThanOrEqual(fit * 0.8);
    expect(a).toBeLessThanOrEqual(fit * 1.2);
  });
});

describe('racket: the player compensation does not add linear pace', () => {
  // PLAYER_SPIN_GAIN compensates a controller swing that reaches ~1/5 of a
  // real racket-head speed — in SPIN, which is what a slow brush under-
  // produces. The friction couple's linear half stays at the physical gain:
  // a brush at the compensated gain must not push the ball harder than the
  // same brush at the physical one.
  test('Δv_t per unit slip is bounded by the physical (2/3)·R·SPIN_CAPTURE_GAIN', () => {
    const compensated = SPIN_CAPTURE_GAIN * PLAYER_SPIN_GAIN;
    const r = computeImpulse(
      v3(6, 0, 0), v3(0, 0, -100), v3(0, 0, 0),
      v3(0, 0, 0), null, null,
      v3(-1, 0, 0),
      R, 0.82, compensated,
      { linearKickGain: SPIN_CAPTURE_GAIN },
    );
    const slip = r.slipTangent.length();
    expect(slip).toBeGreaterThan(0.5);   // not vacuous
    const dVt = Math.hypot(r.ballV_out.y, r.ballV_out.z);
    expect(dVt / slip).toBeLessThanOrEqual(HOLLOW_SPHERE_MOI_FACTOR * R * SPIN_CAPTURE_GAIN + 1e-9);
    // ...while the spin still receives the full compensation.
    expect(r.deltaOmega.length() / slip).toBeCloseTo(compensated, 6);
  });
});
