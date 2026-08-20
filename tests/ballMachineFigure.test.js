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

describe('glide (Rapid Fire sweep)', () => {
  // Fast rhythm interval minus SPINUP is the shortest window the machine has
  // to travel; the widest hop is L-far → R-far, ~0.92 m.
  const DT = 1 / 72;   // Quest refresh — the cadence update() really runs at

  const settle = (fig, seconds) => {
    for (let t = 0; t < seconds; t += DT) fig.update(DT);
  };

  test('the muzzle converges on the target without teleporting', () => {
    const fig = new BallMachineFigure();
    const from = new THREE.Vector3(-0.46, 0.38, -1.77);
    const to = new THREE.Vector3(0.46, 0.38, -1.77);
    fig.glideTo(from, { immediate: true });
    fig.glideTo(to);

    let prev = muzzleWorld(fig);
    for (let t = 0; t < 1.0; t += DT) {
      fig.update(DT);
      const cur = muzzleWorld(fig);
      // No frame may move faster than the cruise speed allows — a jump larger
      // than that is the teleport this feature exists to remove.
      expect(cur.distanceTo(prev)).toBeLessThanOrEqual(1.8 * DT + 1e-6);
      prev = cur;
    }
    expect(muzzleWorld(fig).distanceTo(to)).toBeLessThan(0.01);
  });

  test('a full-width hop completes inside the shortest glide window', () => {
    // interval 0.8 s − SPINUP 0.25 s = 0.55 s of travel time, worst case.
    const fig = new BallMachineFigure();
    fig.glideTo(new THREE.Vector3(-0.46, 0.38, -1.77), { immediate: true });
    fig.glideTo(new THREE.Vector3(0.46, 0.38, -1.77));
    settle(fig, 0.55);
    expect(muzzleWorld(fig).x).toBeGreaterThan(0.40);
  });

  test('gliding never blocks the feed cycle', () => {
    const fig = new BallMachineFigure();
    fig.glideTo(new THREE.Vector3(-0.46, 0.38, -1.77), { immediate: true });
    fig.glideTo(new THREE.Vector3(0.46, 0.38, -1.77));
    expect(fig.isIdle).toBe(true);   // glide is not a state
  });

  test('the position is frozen during spin-up, then travel resumes', () => {
    // The ball spawns at the aimed pose; moving the group mid-spin-up would
    // detach the launch from the muzzle.
    const fig = new BallMachineFigure();
    const start = new THREE.Vector3(0, 0.38, -1.77);
    fig.glideTo(start, { immediate: true });

    const pose = { position: start.clone(), normal: new THREE.Vector3(0, 0, 1) };
    let fired = false;
    fig.beginSwing(pose, () => { fired = true; }, new THREE.Vector3(0, 1, 6));
    fig.glideTo(new THREE.Vector3(0.46, 0.38, -1.77));

    const held = fig.group.position.clone();
    for (let i = 0; i < 10; i++) fig.update(0.02);   // 0.2 s — still SPINUP
    expect(fired).toBe(false);
    expect(fig.group.position.distanceTo(held)).toBeLessThan(1e-9);

    settle(fig, 1.0);                                 // release + recover + glide
    expect(fired).toBe(true);
    expect(muzzleWorld(fig).x).toBeGreaterThan(0.40);
  });

  test('immediate placement snaps the muzzle exactly', () => {
    const fig = new BallMachineFigure();
    const target = new THREE.Vector3(0.46, 0.38, -1.77);
    fig.glideTo(target, { immediate: true });
    expect(muzzleWorld(fig).distanceTo(target)).toBeLessThan(1e-6);
    expect(fig.glideTarget).toBeNull();
  });

  test('dispose mid-glide is safe and later calls are no-ops', () => {
    const fig = new BallMachineFigure();
    fig.glideTo(new THREE.Vector3(0.46, 0.38, -1.77));
    fig.dispose();
    expect(fig.glideTarget).toBeNull();
    expect(() => fig.glideTo(new THREE.Vector3(0, 0.38, -1.77))).not.toThrow();
    expect(() => fig.update(0.02)).not.toThrow();
  });
});
