// Dead-ball settle — a ball left bouncing on the table must come to rest.
//
// The specific risk: with the lively-table default (TABLE_RESTITUTION 0.92)
// the speed-dependent COR curve sits at the COR_MAX clamp (0.95) for every
// impact below ~3.9 m/s, so an unplayed ball lost only 5% of its vertical
// speed per bounce and took ~2v/(g(1−e)) ≈ 15+ seconds to dwindle below the
// stuck-ball detector. Every feeder waits on ballLost before the next feed,
// so the tutorial (and any drill) visibly stalled behind a ball bouncing in
// place. The fix (DEAD_BALL_BOUNCES / DEAD_BALL_COR_SCALE in constants.js)
// bleeds extra energy from the third bounce since the last paddle contact —
// dead in every mode — while leaving the first two live bounces on the full
// shared curve that feeds, serves, and predictions are calibrated against.

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
const { ballModel, ballRadius } = require('../js/scene/models.js');

const DT = 1 / 90;

// Run tickPhysics as the owner with no XR controller.
function simulate(seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    ball.tickPhysics(DT, null, (i + 1) * DT);
  }
}

afterEach(() => ball.clearListeners());

describe('dead-ball settle on the table', () => {
  test('first two bounces keep the live COR curve; third-and-later bleed extra energy', () => {
    const impacts = [];
    ball.onTableBounce(({ impactSpeed }) => impacts.push(impactSpeed));

    // Drop dead-centre with pure vertical velocity — the worst case, since
    // the ball can never roll off an edge.
    ball.spawnBallAt(new THREE.Vector3(0, ballRadius + 0.001, 0.6), new THREE.Vector3(0, -4, 0), null);
    simulate(4);

    expect(impacts.length).toBeGreaterThanOrEqual(4);
    // Live bounces: only the COR curve (≈0.95 at these speeds) plus drag
    // across the hop (measured ≈0.85 end to end).
    expect(impacts[1] / impacts[0]).toBeGreaterThan(0.8);
    // Dead bounces: the extra DEAD_BALL_COR_SCALE shows up in the following
    // impact (0.95 · 0.65 ≈ 0.62).
    expect(impacts[3] / impacts[2]).toBeLessThan(0.75);
  });

  test('an unplayed ball bouncing on the table is lost (comes to rest) within a few seconds', () => {
    const lost = [];
    ball.onTableBounce(() => {});
    ball.onBallLost((e) => lost.push(e));

    ball.spawnBallAt(new THREE.Vector3(0, ballRadius + 0.001, 0.6), new THREE.Vector3(0, -4, 0), null);
    simulate(8);

    expect(lost.length).toBe(1);
    expect(lost[0].reason).toBe('stuck');
    expect(ballModel.visible).toBe(false);
  });
});
