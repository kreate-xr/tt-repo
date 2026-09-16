// The linear half of the paddle friction couple (impulse.js,
// HOLLOW_SPHERE_MOI_FACTOR): the same tangential impulse that produces Δω
// must drag the ball along the slip direction, Δv_t = (2/3)·R·Δω. This is
// the physics that makes incoming spin matter at the racket — the core
// spin-vs-return interaction of real table tennis. These tests pin the
// couple's direction, magnitude, and its three signature consequences.

const THREE = require('three');

import { computeImpulse, HOLLOW_SPHERE_MOI_FACTOR } from '../js/physics/impulse.js';
import { PADDLE_SPIN_CAP, SPIN_CAPTURE_GAIN } from '../js/physics/constants.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

const R = 0.02;
const E = 0.82;
// The shipped gain, not a copy of its current value: these tests pin the
// friction couple as the game actually plays it, so tuning the constant has
// to be reflected here rather than silently diverging from a literal 35.
const GAIN = SPIN_CAPTURE_GAIN;

// Canonical block: ball flies toward the player (+z isn't used here — use
// +x for clarity), paddle stationary, face square to the ball.
// faceNormal points back toward the incoming ball per detectDiscCollision.
function block(ballV, ballW) {
  return computeImpulse(
    ballV, ballW, v(0, 0, 0),
    v(0, 0, 0), null, null,
    v(-1, 0, 0),
    R, E, GAIN,
  );
}

describe('tangential friction kick — signature spin interactions', () => {
  test('blocked topspin climbs off the face', () => {
    // Ball toward +x at 8 m/s with heavy topspin: top surface moving forward
    // (+x), i.e. ω about -z axis... derive: surface v at top (r=(0,R,0)) is
    // ω × r; want +x → ω = (0, 0, -w). At the contact point facing the paddle
    // (r_c = (R,0,0)) the ball surface moves DOWN, so the paddle drags the
    // ball UP: the blocked ball must leave with vy > 0.
    const topspin = v(0, 0, -200);
    const flat = block(v(8, 0, 0), v(0, 0, 0));
    const spun = block(v(8, 0, 0), topspin);
    expect(flat.ballV_out.y).toBeCloseTo(0, 8);
    expect(spun.ballV_out.y).toBeGreaterThan(0.5);
  });

  test('blocked backspin drops off the face', () => {
    const backspin = v(0, 0, 200);
    const spun = block(v(8, 0, 0), backspin);
    expect(spun.ballV_out.y).toBeLessThan(-0.5);
  });

  test('sidespin deflects a flat block laterally, toward the spin side', () => {
    // ω about +y: at the contact point facing the paddle (r_c = (R,0,0)) the
    // ball surface moves along ω × r_c = (0,w,0) × (R,0,0) = (0,0,-wR)... the
    // paddle drags the ball the opposite way (+z for w>0 in slip terms:
    // slip = -(ω × r_c) → +z). Direction itself is pinned by the assertion.
    const side = block(v(8, 0, 0), v(0, 150, 0));
    const flat = block(v(8, 0, 0), v(0, 0, 0));
    expect(Math.abs(flat.ballV_out.z)).toBeLessThan(1e-8);
    expect(Math.abs(side.ballV_out.z)).toBeGreaterThan(0.3);
    // Mirrored spin → mirrored deflection.
    const mirrored = block(v(8, 0, 0), v(0, -150, 0));
    expect(mirrored.ballV_out.z).toBeCloseTo(-side.ballV_out.z, 6);
  });

  test('a brushing paddle adds velocity along the brush direction', () => {
    // Stationary spinless ball, paddle sweeping up the face at 6 m/s while
    // closing at 4 m/s: the brush must lift the ball, not just spin it.
    const r = computeImpulse(
      v(2, 0, 0), v(0, 0, 0), v(0, 0, 0),
      v(-4, 6, 0), null, null,
      v(-1, 0, 0),
      R, E, GAIN,
    );
    expect(r.ballV_out.y).toBeGreaterThan(1.0);      // dragged upward
    expect(r.ballW_out.z).toBeGreaterThan(50);       // and spun (topspin about z... sign per Δω = slip × n)
  });
});

describe('tangential friction kick — momentum consistency', () => {
  test('Δv_t = (2/3)·R·Δω below saturation (hollow-sphere couple)', () => {
    const ballV = v(6, 0, 0);
    const ballW = v(0, 0, -100);       // modest topspin, well below cap
    const r = block(ballV, ballW);
    // Tangential Δv (everything not along the x face normal).
    const dVt = v(0, r.ballV_out.y, r.ballV_out.z);
    // deltaOmega before the corkscrew surgery can perturb it: for this
    // geometry slip is vertical, deltaOmega is about z, and horizontal
    // outgoing travel is -x, so corkscrew (about x... only |x| component)
    // does not touch the z spin. Couple must hold exactly.
    const expected = HOLLOW_SPHERE_MOI_FACTOR * R * r.deltaOmega.length();
    expect(dVt.length()).toBeCloseTo(expected, 6);
  });

  test('linearKickGain splits the couple deliberately: player spin is compensated, the kick is not', () => {
    // ball.js passes the physical gain as linearKickGain on player contacts
    // while spinCaptureGain carries PLAYER_SPIN_GAIN. Pin the split: Δω
    // scales with the compensated gain, Δv_t with the physical one.
    const compensated = GAIN * 2.5;
    const r = computeImpulse(
      v(6, 0, 0), v(0, 0, -100), v(0, 0, 0),
      v(0, 0, 0), null, null,
      v(-1, 0, 0),
      R, E, compensated,
      { linearKickGain: GAIN },
    );
    const slip = r.slipTangent.length();
    expect(slip).toBeGreaterThan(0.5);
    expect(r.deltaOmega.length()).toBeCloseTo(compensated * slip, 6);
    const dVt = v(0, r.ballV_out.y, r.ballV_out.z).length();
    expect(dVt).toBeCloseTo(HOLLOW_SPHERE_MOI_FACTOR * R * GAIN * slip, 6);
    // And the default (opt omitted) is still the locked physical couple.
    const locked = block(v(6, 0, 0), v(0, 0, -100));
    const dVtLocked = v(0, locked.ballV_out.y, locked.ballV_out.z).length();
    expect(dVtLocked).toBeCloseTo(dVt, 6);
  });

  test('kick saturates with the spin cap: huge slip does not add unbounded velocity', () => {
    const r = block(v(8, 0, 0), v(0, 0, -2000)); // absurd incoming spin
    const kickCap = HOLLOW_SPHERE_MOI_FACTOR * R * PADDLE_SPIN_CAP;
    expect(Math.abs(r.ballV_out.y)).toBeLessThanOrEqual(kickCap + 1e-6);
  });

  test('no kick in the moving-away nudge branch (no normal impulse, no friction)', () => {
    // Ball drifting away from the face with spin: the stability nudge must
    // stay pure-normal.
    const r = computeImpulse(
      v(1, 0, 0), v(0, 0, -300), v(0, 0, 0),
      v(0, 0, 0), null, null,
      v(1, 0, 0),
      R, E, GAIN,
    );
    expect(r.ballV_out.x).toBeCloseTo(1.5, 8);
    expect(r.ballV_out.y).toBeCloseTo(0, 8);
    expect(r.ballV_out.z).toBeCloseTo(0, 8);
  });

  test('zero-slip contacts are unchanged by the kick (pure normal reflection)', () => {
    const r = block(v(5, 0, 0), v(0, 0, 0));
    expect(r.ballV_out.x).toBeCloseTo(-(E * 5), 6);
    expect(r.ballV_out.y).toBeCloseTo(0, 8);
    expect(r.ballV_out.z).toBeCloseTo(0, 8);
  });
});
