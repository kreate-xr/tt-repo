// Placement practice — the Practice menu's Placement intent.
//
// The score must track the zone judgement of the RETURN's landing, and only
// that: a return with no landing data can be credited as a return but never
// scored, and a miss scores nothing. The lit zone rotates on every hit —
// that rotation is the drill.

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
jest.mock('../js/modes/training/targets.js', () => {
  const instances = [];
  class TargetZones {
    constructor() {
      this.activeIndex = -1; this.rotations = 0; this.bounces = [];
      this.disposed = false; this.nextResult = 'hit';
      instances.push(this);
    }
    activate(i) { this.activeIndex = i; }
    activateAll() { this.activeIndex = -1; }
    testBounce(x, z) { this.bounces.push([x, z]); return this.nextResult; }
    rotateActive() { this.rotations++; }
    update() {}
    dispose() { this.disposed = true; }
  }
  return { TargetZones, __instances: instances };
});

const THREE = require('three');
const { createPlacementPracticeDrill } = require('../js/modes/training/drills/placementPractice.js');
const targets = require('../js/modes/training/targets.js');

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

// A judged-good return with a real predicted landing on the machine half.
const goodHit = () => ({
  contactPos: new THREE.Vector3(0, 0.3, 1.2),
  outVel: new THREE.Vector3(0, 2.0, -3.2),
  outSpin: new THREE.Vector3(0, 0, 0),
});

function feedOne(drill) {
  const before = drill.getSnapshot().fed;
  for (let i = 0; i < 12000 && drill.getSnapshot().fed === before; i++) {
    drill.update(0.02);
  }
  if (drill.getSnapshot().fed === before) throw new Error('machine never fed');
}

beforeEach(() => {
  spawned.length = 0;
  targets.__instances.length = 0;
});

describe('scoring', () => {
  test('one zone lit at start; an in-zone return scores and rotates it', () => {
    const events = makeEvents();
    const drill = createPlacementPracticeDrill({ ballEvents: events, seed: 1 });
    const zones = targets.__instances[0];
    expect(zones.activeIndex).toBe(0);

    feedOne(drill);
    events.firePaddleHit(goodHit());

    expect(drill.getScore()).toEqual({ onTarget: 1, returned: 1 });
    expect(zones.rotations).toBe(1);
    // The judged point is the return's landing: machine half, on the table.
    const [x, z] = zones.bounces[0];
    expect(Number.isFinite(x)).toBe(true);
    expect(z).toBeLessThan(0);
    drill.dispose();
  });

  test('an out-of-zone return counts as a return but not a score', () => {
    const events = makeEvents();
    const drill = createPlacementPracticeDrill({ ballEvents: events, seed: 2 });
    targets.__instances[0].nextResult = 'miss';
    feedOne(drill);
    events.firePaddleHit(goodHit());
    expect(drill.getScore()).toEqual({ onTarget: 0, returned: 1 });
    expect(targets.__instances[0].rotations).toBe(0);
    drill.dispose();
  });

  test('a bare return with no landing data is never scored', () => {
    // Old shims and tests fire hit events without outgoing state; crediting
    // a zone hit for a point that was never computed would be a lie.
    const events = makeEvents();
    const drill = createPlacementPracticeDrill({ ballEvents: events, seed: 3 });
    feedOne(drill);
    events.firePaddleHit();
    expect(drill.getScore()).toEqual({ onTarget: 0, returned: 1 });
    expect(targets.__instances[0].bounces).toHaveLength(0);
    drill.dispose();
  });

  test('a miss scores nothing and the drill keeps feeding', () => {
    const events = makeEvents();
    const drill = createPlacementPracticeDrill({ ballEvents: events, seed: 4 });
    feedOne(drill);
    events.fireBallLost();
    expect(drill.getScore()).toEqual({ onTarget: 0, returned: 0 });
    expect(drill.isFinished()).toBe(false);
    drill.dispose();
  });

  test('the HUD line reports the score', () => {
    const events = makeEvents();
    const drill = createPlacementPracticeDrill({ ballEvents: events, seed: 5 });
    expect(drill.liveLine()).toMatch(/On target 0\/0/);
    drill.dispose();
  });

  test('dispose tears the zones down with the drill', () => {
    const events = makeEvents();
    const drill = createPlacementPracticeDrill({ ballEvents: events, seed: 6 });
    drill.dispose();
    expect(targets.__instances[0].disposed).toBe(true);
  });
});
