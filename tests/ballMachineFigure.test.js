// BallMachineFigure — muzzle alignment and aiming.
//
// Reported from the headset: "the ball is not coming from its hole, it is
// coming from some other place." The cause was geometric, so it is testable:
// the barrel mouth has to land exactly on the point the ball spawns from, at
// every aim angle.

const THREE = require('three');

jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/models.js', () => ({ tableSurfaceY: 0, ballRadius: 0.02 }));

const {
  BallMachineFigure, MUZZLE_LOCAL_Z, LAUNCH_LEAD_SEC,
} = require('../js/modes/training/ballMachineFigure.js');

// Where the barrel mouth actually is in world space, derived from the scene
// graph rather than from the same maths aim() uses.
function muzzleWorld(fig) {
  fig.group.updateMatrixWorld(true);
  return fig.head.localToWorld(new THREE.Vector3(0, 0, MUZZLE_LOCAL_Z));
}

describe('muzzle alignment', () => {
  test('the mouth lands on the spawn point for a flat feed', () => {
    const fig = new BallMachineFigure();
    const spawn = new THREE.Vector3(0.2, 0.38, -1.7);
    fig.aim(spawn, new THREE.Vector3(0, 0, 1));
    expect(muzzleWorld(fig).distanceTo(spawn)).toBeLessThan(1e-6);
  });

  test('it stays aligned across elevations, including steep lobs', () => {
    // The original bug: the body was offset along a FLATTENED horizontal
    // direction while the head rotated, so any elevation swung the mouth off
    // the spawn point.
    const fig = new BallMachineFigure();
    const spawn = new THREE.Vector3(0, 0.38, -1.7);
    for (const vy of [-3, -1, 0, 1, 3, 6, 9]) {
      fig.aim(spawn, new THREE.Vector3(0, vy, 6));
      expect(muzzleWorld(fig).distanceTo(spawn)).toBeLessThan(1e-6);
    }
  });

  test('it stays aligned across yaw', () => {
    const fig = new BallMachineFigure();
    const spawn = new THREE.Vector3(-0.4, 0.38, -1.7);
    for (const vx of [-4, -1, 0, 1, 4]) {
      fig.aim(spawn, new THREE.Vector3(vx, 1.5, 6));
      expect(muzzleWorld(fig).distanceTo(spawn)).toBeLessThan(1e-6);
    }
  });

  test('a degenerate aim direction does not produce NaN', () => {
    const fig = new BallMachineFigure();
    const spawn = new THREE.Vector3(0, 0.38, -1.7);
    fig.aim(spawn, new THREE.Vector3(0, 0, 0));
    const m = muzzleWorld(fig);
    expect(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z)).toBe(true);
  });
});

describe('barrel elevation direction', () => {
  const barrelDir = (fig) => {
    fig.group.updateMatrixWorld(true);
    return new THREE.Vector3(0, 0, 1).applyQuaternion(fig.head.getWorldQuaternion(new THREE.Quaternion()));
  };

  test('a lob raises the barrel, it does not point at the floor', () => {
    // The sign bug: a positive rotation about X carries +Z toward −Y, so
    // passing +elevation aimed every lob downward.
    const fig = new BallMachineFigure();
    fig.aim(new THREE.Vector3(0, 0.38, -1.7), new THREE.Vector3(0, 5, 5));
    expect(barrelDir(fig).y).toBeGreaterThan(0.3);
  });

  test('a driven feed points the barrel slightly down', () => {
    const fig = new BallMachineFigure();
    fig.aim(new THREE.Vector3(0, 0.38, -1.7), new THREE.Vector3(0, -2, 12));
    expect(barrelDir(fig).y).toBeLessThan(0);
  });

  test('the barrel follows the aim direction in the horizontal plane', () => {
    const fig = new BallMachineFigure();
    fig.aim(new THREE.Vector3(0, 0.38, -1.7), new THREE.Vector3(3, 0, 6));
    expect(barrelDir(fig).x).toBeGreaterThan(0);
  });

  test('the machine stays upright regardless of aim', () => {
    // Only the head tilts; rolling the whole unit would look broken.
    const fig = new BallMachineFigure();
    fig.aim(new THREE.Vector3(0, 0.38, -1.7), new THREE.Vector3(2, 4, 6));
    const up = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(fig.group.getWorldQuaternion(new THREE.Quaternion()));
    expect(up.y).toBeCloseTo(1, 6);
  });
});

describe('feed cycle', () => {
  test('contact fires after the spin-up and returns to idle', () => {
    const fig = new BallMachineFigure();
    let fired = 0;
    const pose = { position: new THREE.Vector3(0, 0.38, -1.7), normal: new THREE.Vector3(0, 0, 1) };
    fig.beginSwing(pose, () => { fired++; }, new THREE.Vector3(0, 1, 6));
    expect(fig.isIdle).toBe(false);

    for (let i = 0; i < 5; i++) fig.update(0.01);
    expect(fired).toBe(0);                       // still spinning up

    for (let i = 0; i < 40; i++) fig.update(0.01);
    expect(fired).toBe(1);

    for (let i = 0; i < 40; i++) fig.update(0.01);
    expect(fig.isIdle).toBe(true);
  });

  test('a second swing is refused while one is in progress', () => {
    const fig = new BallMachineFigure();
    const pose = { position: new THREE.Vector3(0, 0.38, -1.7), normal: new THREE.Vector3(0, 0, 1) };
    expect(fig.beginSwing(pose, () => {})).toBe(true);
    expect(fig.beginSwing(pose, () => {})).toBe(false);
  });

  test('the launch lead matches the spin-up the animation actually plays', () => {
    // FeedEngine subtracts this from the interval; if it drifts from the
    // animation the feed rhythm drifts with it.
    expect(LAUNCH_LEAD_SEC).toBeGreaterThan(0);
    expect(LAUNCH_LEAD_SEC).toBeLessThan(0.5);
  });

  test('wheels spin about their own axle, not end over end', () => {
    // Setting rotation.z and rotation.y on one mesh tumbles it, because with
    // Euler order XYZ the z-rotation is applied first.
    const fig = new BallMachineFigure();
    const wheel = fig.wheels[0].mesh;
    fig.update(0.1);
    expect(wheel.rotation.y).not.toBe(0);
    expect(wheel.rotation.z).toBe(0);
    expect(wheel.parent.rotation.z).toBeCloseTo(Math.PI / 2, 6);
  });

  test('the two wheels counter-rotate', () => {
    const fig = new BallMachineFigure();
    fig.update(0.1);
    expect(Math.sign(fig.wheels[0].mesh.rotation.y))
      .toBe(-Math.sign(fig.wheels[1].mesh.rotation.y));
  });

  test('dispose clears the scene handles', () => {
    const fig = new BallMachineFigure();
    fig.dispose();
    expect(fig.group).toBeNull();
    expect(fig.emitter).toBeNull();
  });
});
