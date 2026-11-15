// Ball Machine practice — the drill wrapper over the M1 machine
// (js/modes/training/drills/practice.js).
//
// What the model tests cannot see: the machine is actually driven by the
// practice (it feeds the practice's balls, without end), verdicts reach the
// model, a thumbstick step changes the NEXT ball and is announced in-world,
// and the in-world card is torn down on dispose.

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
const mockCard = { notices: [], updates: 0, disposed: 0 };
jest.mock('../js/scene/pointBurst.js', () => ({
  createPointBurst: () => ({
    notice: (cue, title) => mockCard.notices.push({ title, ...cue }),
    update: () => { mockCard.updates++; },
    dispose: () => { mockCard.disposed++; },
  }),
}));

const THREE = require('three');
const { createPracticeDrill, PRACTICE } = require('../js/modes/training/drills/practice.js');

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
// lofted over the net toward the machine half.
const goodHit = () => ({
  contactPos: new THREE.Vector3(0, 0.3, 1.2),
  outVel: new THREE.Vector3(0, 2.0, -3.2),
  outSpin: new THREE.Vector3(0, 0, 0),
});

// Step the drill until a new ball launches (or give up).
function untilLaunch(drill, maxSec = 15) {
  const before = spawned.length;
  for (let t = 0; t < maxSec && spawned.length === before; t += 0.05) drill.update(0.05);
  return spawned.length > before;
}

// spawnBallAt(position, velocity, spin)
const lastSpeed = () => {
  const v = spawned[spawned.length - 1][1];
  return Math.hypot(v.x, v.y, v.z);
};
const lastSpin = () => spawned[spawned.length - 1][2];
const lastNotice = () => mockCard.notices[mockCard.notices.length - 1];

beforeEach(() => {
  spawned.length = 0;
  mockCard.notices.length = 0;
  mockCard.updates = 0;
  mockCard.disposed = 0;
});

test('is registered under the practice id', () => {
  expect(PRACTICE.id).toBe('practice');
});

test('feeds the chosen practice without end and announces it once', () => {
  const drill = createPracticeDrill({ ballEvents: makeEvents(), seed: 1, practice: 'loop' });
  expect(mockCard.notices).toEqual([expect.objectContaining({ title: 'GO' })]);
  for (let i = 0; i < 5; i++) expect(untilLaunch(drill)).toBe(true);
  // Loop the backspin: backspin is -x on the spin vector.
  expect(lastSpin().x).toBeLessThan(0);
  expect(drill.isFinished()).toBe(false);
  expect(mockCard.updates).toBeGreaterThan(0);
});

test('verdicts reach the model', () => {
  const events = makeEvents();
  const drill = createPracticeDrill({ ballEvents: events, seed: 1, practice: 'forehand' });
  untilLaunch(drill);
  events.firePaddleHit(goodHit());
  untilLaunch(drill);
  events.fireBallLost();
  untilLaunch(drill);
  expect(drill.model.returned).toBe(1);
  expect(drill.model.faced).toBe(2);
  expect(drill.liveLine()).toMatch(/1\/2 back/);
});

test('a speed step changes the next ball and is announced; the end of the range says so', () => {
  const drill = createPracticeDrill({ ballEvents: makeEvents(), seed: 1, practice: 'forehand' });
  untilLaunch(drill);
  const v0 = lastSpeed();
  expect(drill.adjust('speed', 1)).toMatchObject({ changed: true, level: 4 });
  expect(drill.adjust('speed', 1)).toMatchObject({ changed: true, level: 5 });
  untilLaunch(drill);
  untilLaunch(drill);
  expect(lastSpeed()).toBeGreaterThan(v0);
  expect(lastNotice()).toMatchObject({ title: 'SPEED', reason: 'Speed 5 of 8' });
  for (let i = 0; i < 6; i++) drill.adjust('speed', 1);
  expect(lastNotice().tip).toMatch(/highest/);
  expect(drill.adjust('tempo', -1)).toMatchObject({ kind: 'tempo', level: 2 });
  expect(lastNotice().title).toBe('TEMPO');
});

test('the trigger feeds the next ball at once, one press = one ball', () => {
  const events = makeEvents();
  const drill = createPracticeDrill({ ballEvents: events, seed: 1, practice: 'forehand' });
  expect(lastNotice().tip).toMatch(/Trigger/);
  untilLaunch(drill);
  drill.update(0.2);                    // machine settles back to idle
  const n = spawned.length;
  const fedBefore = drill.getSnapshot().fed;

  expect(drill.launch()).toBe(true);
  expect(drill.launch()).toBe(false);   // already spinning one up
  // Well inside the 2.8 s tempo gap: only the trigger can explain this ball.
  for (let t = 0; t < 0.5; t += 0.05) drill.update(0.05);
  expect(spawned.length).toBe(n + 1);
  expect(drill.getSnapshot().fed).toBe(fedBefore + 1);
  // The skipped ball was never touched: it is charged as a miss, once.
  expect(drill.model.liveLine()).toBeTruthy();

  // The timed feed carries on from the triggered ball.
  expect(untilLaunch(drill)).toBe(true);
});

test('dispose tears down the in-world card', () => {
  const drill = createPracticeDrill({ ballEvents: makeEvents(), seed: 1 });
  drill.dispose();
  expect(mockCard.disposed).toBe(1);
});
