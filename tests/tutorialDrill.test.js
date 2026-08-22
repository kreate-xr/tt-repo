// M9 Tutorial — the drill wrapper over the M1 machine.
//
// What the model tests cannot see: the wrapper must swap the machine's feed
// config when a step is passed, put the target zones up for exactly the
// placement step, judge zone hits off the RETURN's landing, and persist
// completion. A bug in any of those strands the player mid-tutorial with the
// HUD claiming one thing and the machine feeding another.

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
    ballModel: { visible: false },
    paddleModel: null,
    paddleFaceOffset: new T.Vector3(0, -0.1, 0),
    paddleFaceNormalLocal: new T.Vector3(0, 1, 0),
  };
});
// Zones are scene meshes; here they only need to be observable. testBounce
// says 'hit' so the placement step is passable without aiming physics.
jest.mock('../js/modes/training/targets.js', () => {
  const instances = [];
  class TargetZones {
    constructor() { this.allActive = false; this.disposed = false; this.bounces = []; instances.push(this); }
    activateAll() { this.allActive = true; }
    activate() {}
    testBounce(x, z) { this.bounces.push([x, z]); return 'hit'; }
    update() {}
    dispose() { this.disposed = true; }
  }
  return { TargetZones, __instances: instances };
});
jest.mock('../js/profile/store.js', () => {
  const written = [];
  return { setSetting: (k, v) => { written.push([k, v]); }, __written: written };
});

const THREE = require('three');
const { createTutorialDrill, TUTORIAL } = require('../js/modes/training/drills/tutorial.js');
const targets = require('../js/modes/training/targets.js');
const store = require('../js/profile/store.js');

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

// A return the M1 quality judge credits: struck on the player half (+z),
// lofted over the net toward the machine half. The rollout is the real one,
// so the outcome carries a real predicted landing for the zone judgement.
const goodHit = () => ({
  contactPos: new THREE.Vector3(0, 0.3, 1.2),
  outVel: new THREE.Vector3(0, 2.0, -3.2),
  outSpin: new THREE.Vector3(0, 0, 0),
});

// Tick until exactly ONE more ball has been fed, then stop. Fixed-seconds
// runs are wrong here: they can span two feeds, and the unresolved first
// ball would be charged as a miss — resetting the very streak under test.
function feedOne(drill) {
  const before = drill.getSnapshot().fed;
  for (let i = 0; i < 5000 && drill.getSnapshot().fed === before; i++) {
    drill.update(0.02);
  }
  if (drill.getSnapshot().fed === before) throw new Error('machine never fed');
}

const returnOne = (drill, events) => { feedOne(drill); events.firePaddleHit(goodHit()); };

beforeEach(() => {
  spawned.length = 0;
  targets.__instances.length = 0;
  store.__written.length = 0;
});

describe('meta', () => {
  test('carries the stable factory id', () => {
    expect(TUTORIAL.id).toBe('tutorial');
  });
});

describe('the whole tutorial, end to end', () => {
  test('seven good returns walk all four steps and persist completion', () => {
    const events = makeEvents();
    const drill = createTutorialDrill({ ballEvents: events, seed: 1 });

    expect(drill.liveLine()).toMatch(/^Step 1 of 4/);
    expect(targets.__instances).toHaveLength(0);

    returnOne(drill, events);                       // first return
    expect(drill.model.stepIndex).toBe(1);

    for (let i = 0; i < 3; i++) returnOne(drill, events);   // 3 in a row
    expect(drill.model.stepIndex).toBe(2);

    // Zones exist exactly while the placement step runs, all lit.
    expect(targets.__instances).toHaveLength(1);
    const zones = targets.__instances[0];
    expect(zones.allActive).toBe(true);

    for (let i = 0; i < 2; i++) returnOne(drill, events);   // 2 in-zone
    expect(drill.model.stepIndex).toBe(3);
    expect(zones.disposed).toBe(true);

    // The zone judgement ran on the RETURN's landing — machine half, on table.
    expect(zones.bounces.length).toBeGreaterThanOrEqual(2);
    for (const [x, z] of zones.bounces) {
      expect(Number.isFinite(x)).toBe(true);
      expect(z).toBeLessThan(0);
    }

    expect(drill.isFinished()).toBe(false);
    returnOne(drill, events);                       // lift the backspin ball
    expect(drill.isFinished()).toBe(true);
    expect(drill.liveLine()).toMatch(/complete/i);
    expect(store.__written).toContainEqual(['tutorialComplete', true]);

    expect(() => drill.dispose()).not.toThrow();
  });

  test('a missed ball never advances a step', () => {
    const events = makeEvents();
    const drill = createTutorialDrill({ ballEvents: events, seed: 2 });
    feedOne(drill);
    events.fireBallLost();                          // whiffed the first ball
    expect(drill.model.stepIndex).toBe(0);
    expect(drill.isFinished()).toBe(false);
    drill.dispose();
  });

  test('the machine feeds the step config it claims — backspin arrives last', () => {
    // The wrapper swaps configs via setConfig; if that wiring broke, the HUD
    // would announce backspin while the machine kept feeding flat balls.
    const events = makeEvents();
    const drill = createTutorialDrill({ ballEvents: events, seed: 3 });
    returnOne(drill, events);
    for (let i = 0; i < 3; i++) returnOne(drill, events);
    for (let i = 0; i < 2; i++) returnOne(drill, events);
    feedOne(drill);                                 // first backspin-step feed
    expect(drill.getSnapshot().lastFeed.config.spinType).toBe('back');
    drill.dispose();
  });
});
