// Unit tests for the player-serve controller: physical off-hand toss
// (grip hold/release) + trigger auto-toss fallback.

const THREE = require('three');

// playerServe imports ball.js / models.js / hud.js / haptics.js. Mock them so
// tests run pure (no WebGL, no XR session).
jest.mock('../js/physics/ball.js', () => ({
  spawnBallAt: jest.fn(),
}));
jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  // Real ball stand-in: a Group wrapping one mesh, parented under a scene —
  // mirrors Ball.glb's wrapper-Group structure so the held-ball preview's
  // ballModel.clone() path is exercised for real.
  const scene = new T.Object3D();
  const ballModel = new T.Group();
  ballModel.add(new T.Mesh(new T.SphereGeometry(0.02, 8, 6), new T.MeshStandardMaterial()));
  ballModel.visible = false;
  scene.add(ballModel);
  return {
    tableBox: new T.Box3(
      new T.Vector3(-0.7625, -0.01, -1.37),
      new T.Vector3( 0.7625,  0.01,  1.37),
    ),
    tableSurfaceY: 0,
    ballRadius: 0.02,
    ballModel,
  };
});
jest.mock('../js/scene/hud.js', () => ({
  SELF_TEST: false,
  hudLog: jest.fn(),
}));
jest.mock('../js/xr/haptics.js', () => ({
  pulseHand: jest.fn(),
}));

import {
  createPlayerServeController,
  estimateReleaseVelocity,
} from '../js/modes/aiMatch/playerServe.js';
import { spawnBallAt } from '../js/physics/ball.js';

beforeEach(() => {
  spawnBallAt.mockClear();
  // Capture clones — the controller passes reusable tmp vectors that the real
  // spawnBallAt would copy, so the mock must snapshot them too.
  spawnBallAt.mockImplementation(() => {});
});

function lastSpawn() {
  const call = spawnBallAt.mock.calls[spawnBallAt.mock.calls.length - 1];
  return { pos: call[0].clone(), vel: call[1].clone() };
}

// Fake setupXRPaddle handle: one off-hand grip whose pose and squeeze state
// the test drives directly.
function makeFakeXR() {
  const grip = new THREE.Object3D();
  grip.position.set(0.3, 1.0, 1.5); // non-zero → "tracked"
  const state = { pressed: false, gone: false };
  return {
    grip,
    state,
    getOffHandGrip: () => (state.gone ? null : grip),
    getOffHandInputSource: () => (state.gone ? null : {
      gamepad: { buttons: [{ pressed: false }, { get pressed() { return state.pressed; } }] },
    }),
    getOffHandHandedness: () => 'left',
  };
}

// Controller with an injectable clock so sample spans are deterministic.
function makeController(xr) {
  let t = 0;
  const ctrl = createPlayerServeController({ xr, now: () => t });
  return { ctrl, setTime: (ms) => { t = ms; } };
}

describe('estimateReleaseVelocity', () => {
  const out = new THREE.Vector3();

  test('fewer than two samples → zero velocity', () => {
    estimateReleaseVelocity([], out);
    expect(out.length()).toBe(0);
    estimateReleaseVelocity([{ t: 0, x: 0, y: 0, z: 0 }], out);
    expect(out.length()).toBe(0);
  });

  test('straight-line motion → displacement over span', () => {
    const samples = [
      { t: 0,   x: 0, y: 1.00, z: 0 },
      { t: 50,  x: 0, y: 1.10, z: 0 },
      { t: 100, x: 0, y: 1.20, z: 0 },
    ];
    estimateReleaseVelocity(samples, out);
    expect(out.y).toBeCloseTo(2.0, 5); // 0.20m over 100ms
    expect(out.x).toBeCloseTo(0, 5);
  });

  test('samples older than the window are ignored', () => {
    // Slow drift long ago, fast rise in the last 100ms — only the rise counts.
    const samples = [
      { t: 0,   x: 5, y: 0.0, z: 0 },  // outside the 110ms window
      { t: 300, x: 0, y: 1.0, z: 0 },
      { t: 400, x: 0, y: 1.2, z: 0 },
    ];
    estimateReleaseVelocity(samples, out);
    expect(out.y).toBeCloseTo(2.0, 5);
    expect(out.x).toBeCloseTo(0, 5); // the ancient x=5 sample never contributes
  });

  test('span below the noise floor → treated as a stationary drop', () => {
    const samples = [
      { t: 0,  x: 0, y: 1.00, z: 0 },
      { t: 10, x: 0, y: 1.05, z: 0 }, // 5 m/s if trusted — but only 10ms span
    ];
    estimateReleaseVelocity(samples, out);
    expect(out.length()).toBe(0);
  });

  test('speed is clamped to the ballistic cap', () => {
    const samples = [
      { t: 0,   x: 0, y: 0, z: 0 },
      { t: 100, x: 0, y: 2, z: 0 }, // 20 m/s raw
    ];
    estimateReleaseVelocity(samples, out);
    expect(out.length()).toBeCloseTo(5, 5);
    expect(out.y).toBeCloseTo(5, 5); // direction preserved
  });
});

describe('trigger fallback', () => {
  test('trigger tosses the attached ball from its position, not a fixed spot', () => {
    const xr = makeFakeXR();
    const { ctrl } = makeController(xr);
    ctrl.arm();
    ctrl.update(1 / 72); // ready preview attaches to the off-hand
    expect(ctrl.launch()).toBe(true);
    const { pos, vel } = lastSpawn();
    expect(pos.x).toBeCloseTo(0.3, 5);   // launched from the hand...
    expect(pos.y).toBeCloseTo(1.0, 5);
    expect(pos.z).toBeCloseTo(1.415, 5); // ...where the preview ball sat
    expect(vel.y).toBeCloseTo(4.0, 5);   // auto-toss arc unchanged
  });

  test('launch() spawns only while armed, then disarms and notifies', () => {
    const { ctrl } = makeController(null); // no xr — pure trigger contract
    const launches = jest.fn();
    ctrl.onLaunch(launches);

    expect(ctrl.launch()).toBe(false); // not armed yet
    ctrl.arm();
    expect(ctrl.launch()).toBe(true);
    expect(spawnBallAt).toHaveBeenCalledTimes(1);
    expect(launches).toHaveBeenCalledTimes(1);
    expect(ctrl.isArmed()).toBe(false);
    expect(ctrl.launch()).toBe(false); // consumed
  });
});

describe('ready-ball preview (ball visible before any button press)', () => {
  // The preview mesh is parented under ballModel.parent (the mocked scene).
  // Each controller creates its own, so grab the most recently added one.
  function findPreview() {
    const { ballModel } = require('../js/scene/models.js');
    const matches = ballModel.parent.children.filter(
      (c) => c.name === 'playerServeHeldBall',
    );
    return matches[matches.length - 1] || null;
  }

  test('armed with a tracked off-hand → ball rests visibly at that controller', () => {
    const xr = makeFakeXR();
    const { ctrl } = makeController(xr);
    ctrl.arm();
    ctrl.update(1 / 72); // no buttons pressed at all
    const mesh = findPreview();
    expect(mesh).not.toBeNull();
    expect(mesh.visible).toBe(true);
    expect(mesh.position.x).toBeCloseTo(0.3, 5);
    expect(mesh.position.y).toBeCloseTo(1.0, 5);
    expect(mesh.position.z).toBeCloseTo(1.415, 5); // grip-local -Z: past the controller head
    expect(spawnBallAt).not.toHaveBeenCalled();    // still just a preview
  });

  test('preview is a clone of the real game ball, not a stand-in sphere', () => {
    const { ballModel } = require('../js/scene/models.js');
    const { ctrl } = makeController(makeFakeXR());
    ctrl.arm();
    ctrl.update(1 / 72);
    const mesh = findPreview();
    expect(mesh.children.length).toBe(ballModel.children.length);
    // Shared asset — same geometry object, so the held ball renders identically.
    expect(mesh.children[0].geometry).toBe(ballModel.children[0].geometry);
  });

  test('hold offset follows the controller orientation, not world up', () => {
    const xr = makeFakeXR();
    // Pitch the controller 90° nose-up: grip-local -Z now points at world +Y.
    xr.grip.rotation.x = Math.PI / 2;
    const { ctrl } = makeController(xr);
    ctrl.arm();
    ctrl.update(1 / 72);
    const mesh = findPreview();
    expect(mesh.position.x).toBeCloseTo(0.3, 5);
    expect(mesh.position.y).toBeCloseTo(1.0 + 0.085, 5); // offset rotated with the grip
    expect(mesh.position.z).toBeCloseTo(1.5, 5);
  });

  test('armed with no off-hand → ball floats at the trigger-toss spawn point', () => {
    const { ctrl } = makeController(null);
    ctrl.arm();
    ctrl.update(1 / 72);
    const mesh = findPreview();
    expect(mesh).not.toBeNull();
    expect(mesh.visible).toBe(true);
    expect(mesh.position.x).toBeCloseTo(0, 5);      // table centerline
    expect(mesh.position.y).toBeCloseTo(0.30, 5);   // TOSS_HEIGHT_ABOVE_TABLE_M
    expect(mesh.position.z).toBeCloseTo(1.42, 5);   // behind the end line
  });

  test('trigger launch hides the preview along with disarming', () => {
    const { ctrl } = makeController(null);
    ctrl.arm();
    ctrl.update(1 / 72);
    const mesh = findPreview();
    expect(mesh.visible).toBe(true);
    expect(ctrl.launch()).toBe(true);
    expect(mesh.visible).toBe(false);
  });

  test('disarm hides the preview', () => {
    const xr = makeFakeXR();
    const { ctrl } = makeController(xr);
    ctrl.arm();
    ctrl.update(1 / 72);
    const mesh = findPreview();
    expect(mesh.visible).toBe(true);
    ctrl.disarm();
    expect(mesh.visible).toBe(false);
  });
});

describe('physical toss (grip hold/release)', () => {
  test('squeeze picks the ball up; release tosses it with the hand velocity', () => {
    const xr = makeFakeXR();
    const { ctrl, setTime } = makeController(xr);
    const launches = jest.fn();
    ctrl.onLaunch(launches);
    ctrl.arm();

    // Rising edge → hold begins. No physics ball yet.
    xr.state.pressed = true;
    ctrl.update(1 / 72);
    expect(ctrl.isHolding()).toBe(true);
    expect(spawnBallAt).not.toHaveBeenCalled();

    // Swing upward at 2 m/s across four frames.
    for (const [ms, y] of [[30, 1.06], [60, 1.12], [90, 1.18]]) {
      setTime(ms);
      xr.grip.position.y = y;
      ctrl.update(1 / 72);
    }

    // Falling edge → toss.
    setTime(120);
    xr.grip.position.y = 1.24;
    xr.state.pressed = false;
    ctrl.update(1 / 72);

    expect(ctrl.isHolding()).toBe(false);
    expect(ctrl.isArmed()).toBe(false);
    expect(launches).toHaveBeenCalledTimes(1);
    expect(spawnBallAt).toHaveBeenCalledTimes(1);
    const { pos, vel } = lastSpawn();
    expect(vel.y).toBeCloseTo(2.0, 3);      // 0.06m per 30ms straight up
    expect(pos.x).toBeCloseTo(0.3, 5);      // released from the hand, not a fixed spot
    expect(pos.y).toBeCloseTo(1.24, 5);     // at the grip height (offset is along -Z)
    expect(pos.z).toBeCloseTo(1.415, 5);    // 8.5cm past the grip → clear of the head
  });

  test('trigger pull while the ball is held does not spawn a second ball', () => {
    const xr = makeFakeXR();
    const { ctrl } = makeController(xr);
    ctrl.arm();
    xr.state.pressed = true;
    ctrl.update(1 / 72);
    expect(ctrl.isHolding()).toBe(true);

    expect(ctrl.launch()).toBe(false);
    expect(spawnBallAt).not.toHaveBeenCalled();
  });

  test('controller lost mid-hold falls back to armed; trigger still works', () => {
    const xr = makeFakeXR();
    const { ctrl } = makeController(xr);
    ctrl.arm();
    xr.state.pressed = true;
    ctrl.update(1 / 72);
    expect(ctrl.isHolding()).toBe(true);

    xr.state.gone = true;
    ctrl.update(1 / 72);
    expect(ctrl.isHolding()).toBe(false);
    expect(ctrl.isArmed()).toBe(true);
    expect(spawnBallAt).not.toHaveBeenCalled();

    expect(ctrl.launch()).toBe(true); // fallback path intact
  });

  test('stationary release still spawns (a drop → whiffed toss, re-offered serve)', () => {
    const xr = makeFakeXR();
    const { ctrl, setTime } = makeController(xr);
    ctrl.arm();
    xr.state.pressed = true;
    ctrl.update(1 / 72);
    setTime(50);
    ctrl.update(1 / 72);
    setTime(100);
    xr.state.pressed = false;
    ctrl.update(1 / 72);

    expect(spawnBallAt).toHaveBeenCalledTimes(1);
    const { vel } = lastSpawn();
    expect(vel.length()).toBe(0);
  });

  test('disarm mid-hold cancels the hold', () => {
    const xr = makeFakeXR();
    const { ctrl } = makeController(xr);
    ctrl.arm();
    xr.state.pressed = true;
    ctrl.update(1 / 72);
    expect(ctrl.isHolding()).toBe(true);

    ctrl.disarm();
    expect(ctrl.isHolding()).toBe(false);
    expect(ctrl.isArmed()).toBe(false);

    // A later release edge must not toss anything.
    xr.state.pressed = false;
    ctrl.update(1 / 72);
    expect(spawnBallAt).not.toHaveBeenCalled();
  });
});
