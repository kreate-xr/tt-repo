// Spin practice — the Practice menu's Spin intent.
//
// What matters here: the drill actually feeds (every spinMix step must be
// feasible — an infeasible step is silently skipped by the machine, which
// would turn "read the spin" into "wait for nothing"), the spins genuinely
// vary, and the ring cue follows the difficulty contract ported from the
// legacy Spin Reader.

const spawned = [];
jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/audio.js', () => ({ playMenuHoverTick: () => {} }));
jest.mock('../js/physics/ball.js', () => ({
  spawnBallAt: (...args) => { spawned.push(args); },
}));
jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  const HALF_WID = 0.7625;
  const HALF_LEN = 1.37;
  // ballModel is a real Object3D: the drill parents its ring cue to it.
  const ballModel = new T.Object3D();
  ballModel.visible = false;
  return {
    tableBox: new T.Box3(
      new T.Vector3(-HALF_WID, -0.001, -HALF_LEN),
      new T.Vector3(HALF_WID, 0.001, HALF_LEN),
    ),
    netBox: new T.Box3(
      new T.Vector3(-HALF_WID - 0.14, 0, -0.005),
      new T.Vector3(HALF_WID + 0.14, 0.1525, 0.005),
    ),
    tableSurfaceY: 0,
    ballRadius: 0.02,
    ballModel,
    paddleModel: null,
    paddleFaceOffset: new T.Vector3(0, -0.1, 0),
    paddleFaceNormalLocal: new T.Vector3(0, 1, 0),
  };
});

const { createSpinPracticeDrill } = require('../js/modes/training/drills/spinPractice.js');
const { ballModel } = require('../js/scene/models.js');

function makeEvents() {
  const hit = [];
  const lost = [];
  return {
    onPaddleHit: (fn) => hit.push(fn),
    onBallLost: (fn) => lost.push(fn),
    offPaddleHit: () => {},
    offBallLost: () => {},
    firePaddleHit: (payload) => hit.forEach((f) => f(payload)),
    fireBallLost: () => lost.forEach((f) => f()),
  };
}

function feedOne(drill) {
  const before = drill.getSnapshot().fed;
  for (let i = 0; i < 12000 && drill.getSnapshot().fed === before; i++) {
    drill.update(0.02);
  }
  if (drill.getSnapshot().fed === before) throw new Error('machine never fed');
}

beforeEach(() => { spawned.length = 0; });

describe('feeding', () => {
  test('runs the spinMix pattern with no skipped feeds and varied spin', () => {
    const events = makeEvents();
    const drill = createSpinPracticeDrill({ ballEvents: events, seed: 1 });

    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      feedOne(drill);
      seen.add(drill.getSnapshot().lastFeed.config.spinType);
      events.firePaddleHit();
    }
    const snap = drill.getSnapshot();
    expect(snap.pattern).toBe('spinMix');
    expect(snap.skipped).toBe(0);          // every step config is feasible
    expect(seen.size).toBeGreaterThanOrEqual(3);
    drill.dispose();
  });

  test('reads are tallied per spin off the M1 verdicts', () => {
    const events = makeEvents();
    const drill = createSpinPracticeDrill({ ballEvents: events, seed: 2 });
    feedOne(drill);
    events.firePaddleHit();                // returned
    feedOne(drill);
    events.fireBallLost();                 // missed

    const per = drill.getPerSpin();
    const faced = Object.values(per).reduce((a, r) => a + r.faced, 0);
    const returned = Object.values(per).reduce((a, r) => a + r.returned, 0);
    expect(faced).toBe(2);
    expect(returned).toBe(1);
    expect(drill.liveLine()).toMatch(/Read 1\/2/);
    drill.dispose();
  });
});

describe('the ring cue', () => {
  test('beginner: ring appears on feed, tinted, and never fades', () => {
    const events = makeEvents();
    const drill = createSpinPracticeDrill({
      ballEvents: events, seed: 3, profile: { id: 'beginner' },
    });
    feedOne(drill);
    const ring = ballModel.children[0];
    expect(ring).toBeTruthy();
    expect(ring.visible).toBe(true);
    for (let i = 0; i < 100; i++) drill.update(0.02);   // 2 s later...
    expect(ring.visible).toBe(true);                     // ...still there
    drill.dispose();
  });

  test('pro: the ring never shows — read the ball itself', () => {
    const events = makeEvents();
    const drill = createSpinPracticeDrill({
      ballEvents: events, seed: 4, profile: { id: 'pro' },
    });
    feedOne(drill);
    expect(ballModel.children[0].visible).toBe(false);
    drill.dispose();
  });

  test('intermediate: a glimpse, then it fades out', () => {
    const events = makeEvents();
    const drill = createSpinPracticeDrill({
      ballEvents: events, seed: 5, profile: { id: 'intermediate' },
    });
    feedOne(drill);
    const ring = ballModel.children[0];
    expect(ring.visible).toBe(true);
    for (let i = 0; i < 60; i++) drill.update(0.02);    // past fadeStart+fade
    expect(ring.visible).toBe(false);
    drill.dispose();
  });

  test('dispose removes the ring from the ball', () => {
    const events = makeEvents();
    const drill = createSpinPracticeDrill({ ballEvents: events, seed: 6 });
    expect(ballModel.children.length).toBe(1);
    drill.dispose();
    expect(ballModel.children.length).toBe(0);
  });
});
