// Rolling audio gating logic — the Web Audio side is untestable in Jest
// (no AudioContext), but the predicate that decides "is the ball rolling
// on a surface right now" is pure logic pulled directly from ball.js. Pin
// it here so a future refactor can't silently break either direction:
//   - False when airborne (would produce a stuck hiss)
//   - True when settled on a surface with movement (must play)
//   - False when settled but stationary (no sound needed)

const THREE = require('three');

import {
  BALL_ROLL_MIN_SPEED, BALL_ROLL_MAX_SPEED, BALL_ROLL_MAX_GAIN,
  ROLLING_VY_THRESHOLD, FLOOR_LEVEL_Y,
} from '../js/physics/constants.js';

const ballRadius = 0.02;
const tableSurfaceY = 0.76;
const tableBox = {
  min: { x: -0.7625, z: -1.37 },
  max: { x:  0.7625, z:  1.37 },
};

// Mirror of the gating predicate in ball.js. Returns { audible, hSpeed }.
function rollingState(ballPos, ballVel) {
  const vyAbs = Math.abs(ballVel.y);
  const hSpeed = Math.hypot(ballVel.x, ballVel.z);
  const onTable =
    ballPos.y - ballRadius - tableSurfaceY < 0.005 &&
    vyAbs < ROLLING_VY_THRESHOLD &&
    ballPos.x >= tableBox.min.x && ballPos.x <= tableBox.max.x &&
    ballPos.z >= tableBox.min.z && ballPos.z <= tableBox.max.z;
  const onFloor =
    ballPos.y - ballRadius - FLOOR_LEVEL_Y < 0.005 &&
    vyAbs < ROLLING_VY_THRESHOLD &&
    ballPos.y < tableSurfaceY;
  return { audible: (onTable || onFloor) && hSpeed > 0, hSpeed };
}

function pos(x, y, z) { return new THREE.Vector3(x, y, z); }

describe('ball rolling audio gating', () => {
  test('constants sanity', () => {
    expect(BALL_ROLL_MIN_SPEED).toBeGreaterThan(0);
    expect(BALL_ROLL_MAX_SPEED).toBeGreaterThan(BALL_ROLL_MIN_SPEED);
    expect(BALL_ROLL_MAX_GAIN).toBeGreaterThan(0);
    // Keep the peak subtle — this is a scene-continuity cue, must not
    // dominate paddle/table impacts.
    expect(BALL_ROLL_MAX_GAIN).toBeLessThan(0.15);
  });

  test('airborne ball (well above table, high |vy|) is NOT audible', () => {
    const s = rollingState(pos(0, 1.5, 0), new THREE.Vector3(2, 3, 0));
    expect(s.audible).toBe(false);
  });

  test('ball on the table, moving horizontally, IS audible', () => {
    // Ball sitting on the table with mild horizontal roll.
    const s = rollingState(
      pos(0, tableSurfaceY + ballRadius, 0),
      new THREE.Vector3(0.5, 0.02, 0),
    );
    expect(s.audible).toBe(true);
    expect(s.hSpeed).toBeCloseTo(0.5, 6);
  });

  test('ball fully stationary on table is NOT audible', () => {
    const s = rollingState(
      pos(0, tableSurfaceY + ballRadius, 0),
      new THREE.Vector3(0, 0, 0),
    );
    // audible requires hSpeed > 0; a fully stopped ball is silent.
    expect(s.audible).toBe(false);
  });

  test('ball on the floor (below table height), moving horizontally, IS audible', () => {
    const s = rollingState(
      pos(1.5, FLOOR_LEVEL_Y + ballRadius, 0),   // past +x table edge, on floor
      new THREE.Vector3(0.3, 0.01, 0.1),
    );
    expect(s.audible).toBe(true);
  });

  test('ball just above the floor (bouncing) is NOT audible — |vy| too big', () => {
    // High |vy| means the ball is mid-bounce, not rolling.
    const s = rollingState(
      pos(1.5, FLOOR_LEVEL_Y + ballRadius, 0),
      new THREE.Vector3(0.3, 2.5, 0),
    );
    expect(s.audible).toBe(false);
  });

  test('ball above the table but not touching it is NOT audible', () => {
    // Inside table XZ but well above the surface — mid-flight, not rolling.
    const s = rollingState(
      pos(0, tableSurfaceY + 0.30, 0),
      new THREE.Vector3(1, 0.05, 0),
    );
    expect(s.audible).toBe(false);
  });

  test('ball just barely past the table edge, at table height, is NOT audible on table branch', () => {
    // Center outside AABB by 1 cm; height still at surface. The table
    // branch's XZ AABB check fails; the floor branch requires ball.y <
    // tableSurfaceY, which also fails. So no sound — matches physical
    // reality (there's no surface directly under the ball at this instant).
    const s = rollingState(
      pos(tableBox.max.x + 0.01, tableSurfaceY + ballRadius, 0),
      new THREE.Vector3(0.5, 0, 0),
    );
    expect(s.audible).toBe(false);
  });
});
