// Net top-cord ("let ball") collision — escape behavior.
//
// The specific risk: the top-of-net response used a 0.1 mm escape epsilon,
// which one 90 Hz gravity step (~1.2 mm) beats immediately, so the collision
// re-fired every frame. Each re-fire rewound the frame's horizontal travel,
// re-damped horizontal velocity, and re-applied the random lateral jitter —
// the ball visibly froze on the cord for seconds (the jitter's random-walk
// speed sat just above STATIONARY_VEL, so even the stuck-ball watchdog only
// fired intermittently), with the bounce sound and netHit event machine-
// gunning the whole time.

const THREE = require('three');

jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  const HALF_WID = 0.7625;
  const HALF_LEN = 1.37;
  const BALL_R = 0.02;
  const NET_TOP = 0.1525;
  return {
    ballModel: new T.Object3D(),
    paddleModel: null,
    tableBox: new T.Box3(
      new T.Vector3(-HALF_WID, -0.001, -HALF_LEN),
      new T.Vector3(HALF_WID, 0.001, HALF_LEN),
    ),
    // Physical net slab expanded by the ball radius (Minkowski form), same as
    // models.js does for the real asset.
    netBox: new T.Box3(
      new T.Vector3(-HALF_WID - 0.14, 0, -0.005),
      new T.Vector3(HALF_WID + 0.14, NET_TOP, 0.005),
    ).expandByScalar(BALL_R),
    tableSurfaceY: 0,
    ballRadius: BALL_R,
    paddleHitRadius: 0.08,
    paddleFaceOffset: new T.Vector3(0, -0.1, 0),
    paddleFaceNormalLocal: new T.Vector3(0, 1, 0),
    getDebugHelpers: () => ({}),
    setBallSquash: () => {},
    updateBallSquashAmount: () => {},
    resetBallSquash: () => {},
  };
});
jest.mock('../js/scene/audio.js', () => ({
  playBounceSound: () => {},
  playPaddleHitSound: () => {},
  playPaddleEdgeSound: () => {},
  updateSwingWhoosh: () => {},
  updateBallRoll: () => {},
}));
jest.mock('../js/scene/ballShadow.js', () => ({ updateBallShadow: () => {}, resetBallShadow: () => {} }));
jest.mock('../js/scene/ballGhost.js', () => ({ updateBallGhost: () => {}, resetBallGhost: () => {} }));
jest.mock('../js/scene/hud.js', () => ({ SELF_TEST: false, hudLog: () => {} }));
jest.mock('../js/xr/haptics.js', () => ({
  pulseActive: () => {}, pulseImpact: () => {}, pulseSwing: () => {},
}));
jest.mock('../js/xr/trackingLossGuard.js', () => ({ shouldSuppressContact: () => false }));
jest.mock('../js/xr/contactLog.js', () => ({ recordHit: () => {} }));

const ball = require('../js/physics/ball.js');
const { ballModel, netBox } = require('../js/scene/models.js');

const DT = 1 / 90;
const NET_TOP = 0.1525;

// Run tickPhysics as the owner with no XR controller, tracking events.
function simulate(seconds, events) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    ball.tickPhysics(DT, null, (i + 1) * DT);
    if (events.onStep) events.onStep(i);
  }
}

function onNetTop(pos) {
  return pos.x >= netBox.min.x && pos.x <= netBox.max.x &&
         pos.z >= netBox.min.z && pos.z <= netBox.max.z &&
         pos.y > NET_TOP;
}

let randomSpy;

beforeEach(() => {
  ball.clearListeners();
  // azimuth = π/2 → the cord jitter kicks purely +z, deterministically.
  randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.25);
});

afterEach(() => randomSpy.mockRestore());

test('a ball clipping the net top dribbles over instead of sticking', () => {
  const netHits = [];
  const tableBounces = [];
  ball.onNetHit((e) => netHits.push(e));
  ball.onTableBounce((e) => tableBounces.push(e));

  // Directly above the net, descending with forward drift — the classic
  // let-ball. Only the y slab is crossed, so the hit axis is the top cord.
  ball.spawnBallAt(new THREE.Vector3(0, 0.30, 0), new THREE.Vector3(0, -2.0, 0.3));
  simulate(1.5, {});

  expect(netHits.length).toBe(1);
  expect(netHits[0].axis).toBe('y');
  // The ball made it off the cord and landed on the far side of the table.
  expect(tableBounces.length).toBeGreaterThan(0);
  expect(tableBounces[0].z).toBeGreaterThan(netBox.max.z);
  expect(onNetTop(ballModel.position)).toBe(false);
});

test('even a near-dead drop rolls off the cord within half a second', () => {
  // Slow drop → the reflected v_y is under the micro-bounce cutoff and gets
  // clamped to zero: the ball rests on the cord and must be carried off by
  // horizontal drift + gravity, the worst case for the old re-trigger loop
  // (which pinned exactly this ball in place for seconds).
  let firstHitStep = -1;
  let stepsOnNet = 0;
  ball.onNetHit(() => { if (firstHitStep < 0) firstHitStep = 1; });
  ball.spawnBallAt(new THREE.Vector3(0, 0.20, 0), new THREE.Vector3(0, -0.5, 0.05));

  simulate(2.0, {
    onStep: () => { if (firstHitStep > 0 && onNetTop(ballModel.position)) stepsOnNet++; },
  });

  expect(firstHitStep).toBeGreaterThan(0);          // it did hit the cord
  expect(stepsOnNet).toBeLessThan(45);              // ...but left within 0.5 s
  expect(onNetTop(ballModel.position)).toBe(false); // and is not there now
});

test('face hits still reflect the ball back', () => {
  const netHits = [];
  ball.onNetHit((e) => netHits.push(e));
  // Level drive straight into the net face from the near side.
  ball.spawnBallAt(new THREE.Vector3(0, 0.08, -0.5), new THREE.Vector3(0, 0, 4.0));
  simulate(0.5, {});

  expect(netHits.length).toBe(1);
  expect(netHits[0].axis).toBe('z');
  // Reflected: the ball ended up on the side it came from.
  expect(ballModel.position.z).toBeLessThan(netBox.min.z);
});
