// PLAYER_SPIN_GAIN — the VR input-domain compensation on spin capture.
//
// WHY IT EXISTS. A 20-contact headset capture (2026-09-02) measured paddle
// face-centre speed at median 2.68 m/s against the 15-20 m/s a real racket
// head reaches. The transfer chain itself was verified sound in the same
// capture (tangentSpeed 1.80 × SPIN_CAPTURE_GAIN 35 = 63 predicted vs 65
// observed), so the shortfall is entirely in how fast a human can swing a
// controller — not in the physics.
//
// WHAT MUST NOT BREAK. The AI's paddleSolver plans real-scale strike speeds,
// so it has no input gap to compensate for. Applying this gain to AI contacts
// would hand the opponent several times the spin its shot tables were tuned
// against, silently rewriting every rally. That asymmetry is the whole
// contract of this constant and is what the AI test below pins down.

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
const C = require('../js/physics/constants.js');

const DT = 1 / 90;
const BALL_AT = new THREE.Vector3(0, 1.0, 0.6);

let clock = 100;

// The swing must BRUSH, not just push. A face-normal-aligned sweep produces
// zero tangential slip and therefore zero spin at any gain — the ratio under
// test would be 0/0. So the paddle rises 0.13 m (to cross the ball) while also
// sliding 0.022 m along its own face, giving ~2 m/s of tangential contact
// speed: enough spin to measure, and low enough that PADDLE_SPIN_CAP does not
// compress the gained case and hide the difference.
const LIFT = 0.13;
const BRUSH = 0.022;

// One player swing: identity-quaternion paddle carrying its face 0.1 below the
// controller (paddleFaceOffset), swept up past a ball hanging at rest.
function playerSwing() {
  const ctrl = new THREE.Object3D();
  ball.spawnBallAt(BALL_AT, new THREE.Vector3(0, 0, 0), null);
  ctrl.position.set(0, 1.00, 0.600);
  ctrl.updateMatrixWorld(true);
  ball.tickPhysics(DT, ctrl, (clock += 1));
  ctrl.position.set(0, 1.00 + LIFT, 0.600 + BRUSH);
  ctrl.updateMatrixWorld(true);
  ball.tickPhysics(DT, ctrl, clock + DT);
}

// The same brushing sweep driven through the AI registration path instead.
function aiSwing() {
  let y = 0.90;
  let z = 0.600;
  const handle = ball.registerAIPaddle({
    id: 'ai-test',
    hitRadius: 0.08,
    getFace: () => ({
      center: new THREE.Vector3(0, y, z),
      normal: new THREE.Vector3(0, 1, 0),
      velocity: new THREE.Vector3(0, LIFT / DT, BRUSH / DT),
    }),
  });
  try {
    ball.spawnBallAt(BALL_AT, new THREE.Vector3(0, 0, 0), null);
    ball.tickPhysics(DT, null, (clock += 1));
    y = 0.90 + LIFT;
    z = 0.600 + BRUSH;
    ball.tickPhysics(DT, null, clock + DT);
  } finally {
    ball.unregisterAIPaddle(handle);
  }
}

// Run a swing at a given gain and return the contact it produced.
function spinAtGain(swing, gain) {
  C.setPlayerSpinGain(gain);
  let hit = null;
  ball.onPaddleHit((p) => { if (!hit) hit = p; });
  try {
    swing();
  } finally {
    ball.clearListeners();
  }
  return hit;
}

afterEach(() => {
  C.setPlayerSpinGain(2.5);
  ball.clearListeners();
});

describe('PLAYER_SPIN_GAIN', () => {
  test('ships at 2.5 and clamps to a range that cannot reduce spin', () => {
    expect(C.PLAYER_SPIN_GAIN).toBe(2.5);
    // Below 1 would mean generating LESS spin than the physics says, which is
    // a different claim than compensating for a slow swing.
    C.setPlayerSpinGain(0.1);
    expect(C.PLAYER_SPIN_GAIN).toBe(1);
    C.setPlayerSpinGain(99);
    expect(C.PLAYER_SPIN_GAIN).toBe(6);
  });

  test('scales player spin by exactly the gain', () => {
    const base = spinAtGain(playerSwing, 1);
    const gained = spinAtGain(playerSwing, 2.5);
    expect(base).toBeTruthy();
    expect(gained).toBeTruthy();
    expect(base.origin).toBe('player');
    // Same swing, same slip — only the capture gain differs. Guard against the
    // cap swallowing the difference and making this pass vacuously.
    expect(gained.spinMag).toBeLessThan(C.PADDLE_SPIN_CAP_KNEE);
    expect(gained.spinMag / base.spinMag).toBeCloseTo(2.5, 2);
  });

  test('leaves AI spin untouched — the opponent has no input gap', () => {
    const base = spinAtGain(aiSwing, 1);
    const gained = spinAtGain(aiSwing, 2.5);
    expect(base).toBeTruthy();
    expect(base.origin).toBe('ai-test');
    expect(base.spinMag).toBeGreaterThan(0); // not vacuous
    expect(gained.spinMag / base.spinMag).toBeCloseTo(1.0, 6);
  });

  test('does not change pace — only spin capture is compensated', () => {
    // The gain multiplies spinCaptureGain, which feeds Δω and the tangential
    // friction kick. The normal-direction reflection that sets shot speed must
    // not move, or "more spin" would silently become "harder ball" too.
    const base = spinAtGain(playerSwing, 1);
    const gained = spinAtGain(playerSwing, 2.5);
    expect(gained.impactSpeed).toBeCloseTo(base.impactSpeed, 6);
  });
});
