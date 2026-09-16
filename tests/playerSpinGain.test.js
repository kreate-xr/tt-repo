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
//
// IT IS SPIN ONLY. The gain multiplies spinCaptureGain; the linear half of
// the friction couple (HOLLOW_SPHERE_MOI_FACTOR: Δv_t = (2/3)·R·Δω) stays at
// the physical SPIN_CAPTURE_GAIN via computeImpulse's linearKickGain opt. It
// used to be locked to the compensated gain, so at 2.5 a player's brush
// injected 1.167 m/s of ball speed per m/s of slip against the AI's 0.467,
// through the one channel PADDLE_CONTACT_SPEED_CAP never bounded (it caps
// only the NORMAL component) — a prepared first stroke left the bat too
// hard. Two tests below pin that the gain no longer changes outgoing speed.
//
// IT IS A CEILING, NOT A FLAT MULTIPLIER. What a contact actually receives
// is scaled by how much stroke went into it (swingPreparation.js). The last
// describe block pins both halves of that: the ceiling is still reached by a
// real stroke, and a jab does not reach it.

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
    setBallOpacity: () => {},
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
//
// `prepSteps` run-up frames precede the contact, each advancing the paddle by
// the SAME (LIFT, BRUSH) vector as the contact step. That matters twice over:
// the gain is now earned by stroke travel (swingPreparation.js), and a run-up
// of identical steps leaves the median-of-3 velocity filter reporting exactly
// the value the unprepared two-frame swing passes through raw — so prepared
// and unprepared swings meet the ball with identical contact kinematics and
// differ ONLY in the history behind them.
//
// The ball is spawned two frames before contact in every case, so gravity has
// moved it by the same amount no matter how long the run-up was.
const PREP_STEPS_COMMITTED = 3;   // 4 × 0.132 m = 0.53 m — past SWING_PREP_FULL_M
const PREP_STEPS_JAB = 0;         // 1 × 0.132 m — a stab, under the ramp

function playerSwing(prepSteps = PREP_STEPS_COMMITTED) {
  const ctrl = new THREE.Object3D();
  // Start every swing from a clean paddle history. Without this the median-of-3
  // velocity ring and the previous swing's face position leak across swings —
  // the first frame of a new swing finite-differences against wherever the last
  // one ended, and a short swing then meets the ball at a median of two junk
  // samples. Run-ups of different lengths would be comparing different
  // collisions, which is exactly what these tests must not do.
  ball.resetPaddleTracking();
  let t = (clock += 1);
  for (let k = prepSteps; k >= 1; k--) {
    ctrl.position.set(0, 1.00 - k * LIFT, 0.600 - k * BRUSH);
    ctrl.updateMatrixWorld(true);
    ball.tickPhysics(DT, ctrl, t);
    t += DT;
  }
  ball.spawnBallAt(BALL_AT, new THREE.Vector3(0, 0, 0), null);
  ctrl.position.set(0, 1.00, 0.600);
  ctrl.updateMatrixWorld(true);
  ball.tickPhysics(DT, ctrl, t);
  t += DT;
  ctrl.position.set(0, 1.00 + LIFT, 0.600 + BRUSH);
  ctrl.updateMatrixWorld(true);
  ball.tickPhysics(DT, ctrl, t);
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

// The same, for a player swing with a specific amount of run-up behind it.
function hitWithPrep(prepSteps) {
  return spinAtGain(() => playerSwing(prepSteps), 2.5);
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

  test('leaves the normal-axis reflection alone and does NOT add pace', () => {
    const base = spinAtGain(playerSwing, 1);
    const gained = spinAtGain(playerSwing, 2.5);
    // impactSpeed is |v_rel · n| measured BEFORE the impulse, so the gain
    // cannot move it — this line alone proves nothing about pace.
    expect(gained.impactSpeed).toBeCloseTo(base.impactSpeed, 6);
    // The assertion that matters is on the OUTGOING speed. The friction
    // impulse that carries the spin also drags the ball along the slip
    // direction, and for a long time the two halves of that couple were
    // locked, so the gain made a faster ball as well as a spinnier one — the
    // unbounded channel behind "the first hit is too hard". ball.js now
    // hands computeImpulse the physical SPIN_CAPTURE_GAIN as linearKickGain
    // on player contacts: the compensated brush spins the ball 2.5× and
    // pushes it exactly as hard as the uncompensated one.
    expect(gained.outSpeed).toBeCloseTo(base.outSpeed, 6);
  });
});

// --- The governor -----------------------------------------------------------
// Same ball, same contact kinematics, same ceiling — only the stroke behind
// the contact differs. Everything here is a controlled comparison: the run-up
// steps are the contact step repeated, so the median-of-3 velocity filter
// hands both swings the identical contact velocity, and the ball is spawned
// two frames before contact either way.
describe('swing preparation governs the gain', () => {
  test('a committed stroke still earns the full ceiling', () => {
    const raw = spinAtGain(() => playerSwing(PREP_STEPS_COMMITTED), 1);
    const committed = hitWithPrep(PREP_STEPS_COMMITTED);
    expect(committed.swingTravel).toBeGreaterThan(0.40); // SWING_PREP_FULL_M
    expect(committed.spinMag).toBeLessThan(C.PADDLE_SPIN_CAP_KNEE); // not vacuous
    expect(committed.spinMag / raw.spinMag).toBeCloseTo(2.5, 2);
  });

  test('a jab earns none of it — a block gets raw physics', () => {
    const raw = spinAtGain(() => playerSwing(PREP_STEPS_JAB), 1);
    const jab = hitWithPrep(PREP_STEPS_JAB);
    expect(jab.swingTravel).toBeLessThan(0.40);
    // Not literally 1.0 — one 0.132 m step sits just above SWING_PREP_MIN_M,
    // on the flat bottom of the smoothstep. The point is that it is nowhere
    // near the ceiling a real stroke reaches.
    expect(jab.spinMag / raw.spinMag).toBeGreaterThanOrEqual(1);
    expect(jab.spinMag / raw.spinMag).toBeLessThan(1.2);
  });

  test('the contact itself is identical — only the history differs', () => {
    // If this drifts, the two tests above are comparing different collisions
    // and prove nothing about preparation.
    const jab = hitWithPrep(PREP_STEPS_JAB);
    const committed = hitWithPrep(PREP_STEPS_COMMITTED);
    expect(committed.impactSpeed).toBeCloseTo(jab.impactSpeed, 6);
    expect(committed.contactRadius).toBeCloseTo(jab.contactRadius, 6);
    expect(committed.swingSpeed).toBeCloseTo(jab.swingSpeed, 6);
  });

  test('preparation controls spin; pace is physical either way', () => {
    // The compounding loop the since-removed MULTIPLAYER_PADDLE_COR_SCALE was
    // trimming (in the wrong term) ran through the linear half of the
    // friction couple, which the gain used to scale. That half is now pinned
    // to the physical gain on every player contact (linearKickGain), so a
    // committed stroke and a jab push the ball identically and differ only
    // in spin. Pace between two humans no longer has an amplifier to damp.
    const jab = hitWithPrep(PREP_STEPS_JAB);
    const committed = hitWithPrep(PREP_STEPS_COMMITTED);
    expect(committed.spinMag).toBeGreaterThan(jab.spinMag * 2);
    expect(committed.outSpeed).toBeCloseTo(jab.outSpeed, 6);
  });

  test('AI contacts are untouched by preparation', () => {
    // The AI never consults the tracker: its windup distance already caps its
    // stroke, and double-governing it would quietly rewrite its shot tables.
    const hit = spinAtGain(aiSwing, 2.5);
    expect(hit.origin).toBe('ai-test');
    expect(hit.swingTravel).toBe(0);
  });
});
