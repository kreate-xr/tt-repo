// Training Session — the drill wrapper over the M1 machine.
//
// What the model tests cannot see: the machine must actually be driven by the
// session (it feeds the session's balls, stays silent through the intro and
// the rests, and resumes after), verdicts must reach the model with the
// machine's ball index, the best score must persist only when beaten, and the
// score card's button must start a focus run of the weakest set.

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
jest.mock('../js/profile/store.js', () => {
  const values = {};
  const written = [];
  return {
    getSetting: (k) => values[k],
    setSetting: (k, v) => { values[k] = v; written.push([k, v]); },
    __values: values,
    __written: written,
  };
});

const THREE = require('three');
const { createSessionDrill, SESSION, nextTraining } = require('../js/modes/training/drills/session.js');
const { SETS, INTRO_SECONDS, REST_SECONDS } = require('../js/modes/training/session.js');
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

beforeEach(() => {
  spawned.length = 0;
  store.__written.length = 0;
  for (const k of Object.keys(store.__values)) delete store.__values[k];
});

test('is registered under the session id', () => {
  expect(SESSION.id).toBe('session');
});

test('the machine stays silent through the intro, then feeds the forehand', () => {
  const drill = createSessionDrill({ ballEvents: makeEvents(), seed: 1 });
  for (let t = 0; t < INTRO_SECONDS - 0.2; t += 0.05) drill.update(0.05);
  expect(spawned).toHaveLength(0);
  expect(drill.liveLine()).toMatch(/Get ready/);
  expect(untilLaunch(drill)).toBe(true);
  expect(drill.model.set.id).toBe('forehand');
  expect(drill.liveLine()).toMatch(/^Forehand/);
  drill.dispose();
});

test('returns reach the model and a full set pauses the machine for the rest', () => {
  const events = makeEvents();
  const drill = createSessionDrill({ ballEvents: events, seed: 1, level: 'beginner' });
  const n = drill.model.level.ballsPerSet;
  for (let i = 0; i < n; i++) {
    expect(untilLaunch(drill)).toBe(true);
    events.firePaddleHit(goodHit());
    events.fireBallLost();
  }
  drill.update(0.05);
  expect(drill.model.phase).toBe('rest');
  expect(drill.model.report().sets[0]).toMatchObject({ fed: n, score: 100 });

  // Nothing launches during the rest...
  const during = spawned.length;
  for (let t = 0; t < REST_SECONDS - 0.2; t += 0.05) drill.update(0.05);
  expect(spawned.length).toBe(during);
  // ...then the backhand starts.
  expect(untilLaunch(drill)).toBe(true);
  expect(drill.model.set.id).toBe('backhand');
  drill.dispose();
});

test('the whole session completes and persists a beaten best score', () => {
  store.__values.sessionBestBeginner = 40;
  const events = makeEvents();
  const drill = createSessionDrill({ ballEvents: events, seed: 3, level: 'beginner' });
  const total = SETS.length * drill.model.level.ballsPerSet;
  for (let i = 0; i < total; i++) {
    expect(untilLaunch(drill)).toBe(true);
    events.firePaddleHit(goodHit());
    events.fireBallLost();
  }
  for (let t = 0; t < 1 && !drill.isFinished(); t += 0.05) drill.update(0.05);
  expect(drill.isFinished()).toBe(true);
  const r = drill.getReport();
  expect(r.score).toBe(100);
  expect(r.newBest).toBe(true);
  expect(r.previousBest).toBe(40);
  expect(store.__written).toEqual([['sessionBestBeginner', 100]]);
  drill.dispose();
});

test('a score below the best is reported but not written', () => {
  store.__values.sessionBestPlayer = 90;
  const drill = createSessionDrill({ ballEvents: makeEvents(), seed: 1, level: 'player' });
  drill.model.phase = 'finishing';
  drill.model.restTime = 0;
  drill.update(0.05);
  expect(drill.isFinished()).toBe(true);
  expect(drill.getReport()).toMatchObject({ newBest: false, best: 90 });
  expect(store.__written).toEqual([]);
  drill.dispose();
});

describe('next training', () => {
  test('points at a focus run of the weakest set, at the same level and hand', () => {
    const r = nextTraining({ focus: null, weakestSet: 'pushBlock' }, { level: 'player', hand: 'L' });
    expect(r).toEqual({
      label: 'Push or Block', drill: 'session', config: null,
      options: { level: 'player', hand: 'L', focus: 'pushBlock' },
    });
  });

  test('offers nothing after a focus run, or with nothing played', () => {
    expect(nextTraining({ focus: 'forehand', weakestSet: 'forehand' }, { level: 'beginner' })).toBeNull();
    expect(nextTraining({ focus: null, weakestSet: null }, { level: 'beginner' })).toBeNull();
  });
});

test('a focus run plays one set at double length and never touches the best score', () => {
  store.__values.sessionBestBeginner = 10;
  const events = makeEvents();
  const drill = createSessionDrill({ ballEvents: events, seed: 2, level: 'beginner', focus: 'backhand' });
  const n = drill.model.ballsPerSet;
  expect(n).toBe(drill.model.level.ballsPerSet * 2);
  for (let i = 0; i < n; i++) {
    expect(untilLaunch(drill)).toBe(true);
    expect(drill.model.set.id).toBe('backhand');
    events.firePaddleHit(goodHit());
    events.fireBallLost();
  }
  for (let t = 0; t < 1 && !drill.isFinished(); t += 0.05) drill.update(0.05);
  expect(drill.isFinished()).toBe(true);
  const r = drill.getReport();
  expect(r).toMatchObject({ focus: 'backhand', focusLabel: 'Backhand', score: 100, best: null, newBest: false, next: null });
  expect(store.__written).toEqual([]);
  drill.dispose();
});
