// M1 Ball Machine drill — feed accounting.
//
// The specific risk: a feed the solver refuses puts no ball in play, so it
// must not be charged to the player as a miss. That is silent when wrong —
// nothing errors, the return rate is simply wrong — and it feeds the
// Training Session's score.

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

const { createM1BallMachineDrill } = require('../js/modes/training/drills/m1BallMachine.js');
const { validateConfig, INFINITE } = require('../js/modes/training/drillConfig.js');
const { WARMUP_FEED } = require('../js/modes/training/presets.js');

// Minimal ballEvents shim matching what inGame.js supplies.
function makeEvents() {
  const hit = [];
  const lost = [];
  return {
    hit,
    lost,
    onPaddleHit: (fn) => hit.push(fn),
    onBallLost: (fn) => lost.push(fn),
    offPaddleHit: () => {},
    offBallLost: () => {},
    firePaddleHit: (payload) => hit.forEach((f) => f(payload)),
    fireBallLost: () => lost.forEach((f) => f()),
  };
}

// Advance the drill far enough to emit `n` feeds.
function run(drill, seconds, dt = 0.02) {
  for (let i = 0; i < seconds / dt; i++) drill.update(dt);
}

beforeEach(() => { spawned.length = 0; });

describe('playable config', () => {
  test('feeds balls and spawns them', () => {
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...WARMUP_FEED, burstCount: INFINITE }),
      ballEvents: makeEvents(),
    });
    run(drill, 12);
    const snap = drill.getSnapshot();
    expect(snap.fed).toBeGreaterThan(0);
    expect(snap.skipped).toBe(0);
    expect(spawned.length).toBeGreaterThan(0);
    drill.dispose();
  });

  test('a returned ball counts once, however many paddle hits land', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...WARMUP_FEED, burstCount: INFINITE }),
      ballEvents: events,
    });
    run(drill, 4);
    events.firePaddleHit();
    events.firePaddleHit();
    events.firePaddleHit();
    expect(drill.getSnapshot().returned).toBe(1);
    drill.dispose();
  });
});

describe('unplayable config', () => {
  // 2 m/s cannot clear the net to any placement: max ballistic range is
  // v²/g ≈ 0.4 m. Every feed is refused.
  const impossible = () => validateConfig({
    ...WARMUP_FEED, speed: 2,
    placement: { kind: 'zone', zone: 8 }, depth: 'deep',
    feedOrigin: 'center-far', burstCount: INFINITE,
  });

  test('no ball is spawned for a feed the solver refuses', () => {
    const drill = createM1BallMachineDrill({ config: impossible(), ballEvents: makeEvents() });
    run(drill, 12);
    const snap = drill.getSnapshot();
    if (snap.skipped > 0) expect(spawned.length).toBe(0);
    drill.dispose();
  });

  test('skipped feeds are NOT charged to the player as misses', () => {
    // The bug: the miss for the "previous ball" fired even when the previous
    // feed never launched, driving the return rate to zero on balls that
    // never existed — and feeding that into M7's weakness report.
    const drill = createM1BallMachineDrill({ config: impossible(), ballEvents: makeEvents() });
    run(drill, 12);
    const snap = drill.getSnapshot();
    if (snap.skipped > 0) {
      const counts = drill.getLog().outcomeCounts();
      expect(counts.miss).toBe(0);
      expect(counts.returned).toBe(0);
    }
    drill.dispose();
  });

  test('the live line explains why nothing is coming, rather than sitting idle', () => {
    const drill = createM1BallMachineDrill({ config: impossible(), ballEvents: makeEvents() });
    run(drill, 12);
    if (drill.getSnapshot().skipped > 0) {
      expect(drill.liveLine()).toMatch(/raise speed|shorter zone/i);
    }
    drill.dispose();
  });
});

describe('miss accounting across a mixed sequence', () => {
  // A long interval so exactly ONE ball is in play: the mocked ballModel is
  // never visible, so the drill's "wait for the previous ball to clear" gate
  // is always open and a short interval would feed several balls, each
  // legitimately counting as its own miss.
  const oneBallConfig = () => validateConfig({
    ...WARMUP_FEED, interval: 6, burstCount: INFINITE,
  });

  test('an unreturned launched ball IS a miss', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({ config: oneBallConfig(), ballEvents: events });
    run(drill, 2);
    expect(drill.getSnapshot().fed).toBe(1);
    events.fireBallLost();
    expect(drill.getLog().outcomeCounts().miss).toBe(1);
    drill.dispose();
  });

  test('a returned ball is not also counted as a miss when it leaves play', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({ config: oneBallConfig(), ballEvents: events });
    run(drill, 2);
    events.firePaddleHit();
    expect(drill.getSnapshot().streak).toBe(1);
    events.fireBallLost();       // already returned — must not double-count
    expect(drill.getLog().outcomeCounts().miss).toBe(0);
    expect(drill.getSnapshot().streak).toBe(1);
    drill.dispose();
  });

  test('every launched ball is accounted for exactly once', () => {
    // fed − skipped should equal returned + missed once play has settled.
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...WARMUP_FEED, interval: 1, burstCount: INFINITE }),
      ballEvents: events,
    });
    run(drill, 8);
    events.fireBallLost();       // resolve the ball still in play
    const snap = drill.getSnapshot();
    const counts = drill.getLog().outcomeCounts();
    expect(counts.returned + counts.miss).toBe(snap.fed - snap.skipped);
    drill.dispose();
  });
});

describe('blade contact recording (M7 heatmap input)', () => {
  // The gap this closes: the heatmap UI was rendering log.contactPoints(),
  // but nothing ever called recordContact — so it drew an always-empty grid.
  const hitWith = (x, y) => ({
    contactLocal: { x, y }, impactSpeed: 6.2, spinType: 'TOP', contactRadius: 0.03,
  });

  test('a paddle hit records its contact point', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...WARMUP_FEED, burstCount: INFINITE }),
      ballEvents: events,
    });
    run(drill, 3);
    events.hit.forEach((f) => f(hitWith(0.01, -0.02)));
    const pts = drill.getLog().contactPoints();
    expect(pts).toHaveLength(1);
    expect(pts[0].x).toBeCloseTo(0.01, 6);
    expect(pts[0].y).toBeCloseTo(-0.02, 6);
    drill.dispose();
  });

  test('every strike is recorded, including a second touch of the same ball', () => {
    // Mishits are exactly what the heatmap exists to show, so they must not
    // be filtered out by the "already returned" check.
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...WARMUP_FEED, burstCount: INFINITE }),
      ballEvents: events,
    });
    run(drill, 3);
    events.hit.forEach((f) => f(hitWith(0.01, 0)));
    events.hit.forEach((f) => f(hitWith(0.04, -0.05)));
    expect(drill.getLog().contactPoints()).toHaveLength(2);
    expect(drill.getSnapshot().returned).toBe(1);   // still one return
    drill.dispose();
  });

  test('a hit with no contact data does not corrupt the log', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...WARMUP_FEED, burstCount: INFINITE }),
      ballEvents: events,
    });
    run(drill, 3);
    events.hit.forEach((f) => f(undefined));
    events.hit.forEach((f) => f({}));
    expect(drill.getLog().contactPoints()).toHaveLength(0);
    expect(drill.getSnapshot().returned).toBe(1);
    drill.dispose();
  });

  test('the mean offset is directional, so "low" survives to the advice', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...WARMUP_FEED, burstCount: INFINITE }),
      ballEvents: events,
    });
    run(drill, 3);
    for (let i = 0; i < 3; i++) events.hit.forEach((f) => f(hitWith(0, -0.025)));
    expect(drill.getLog().meanContactOffset().y).toBeLessThan(0);
    drill.dispose();
  });
});

describe('config provider and pause (the Training Session hooks)', () => {
  const base = () => validateConfig({ ...WARMUP_FEED, interval: 1, burstCount: INFINITE });

  test('a provider picks every ball, called once per feed with its index', () => {
    const calls = [];
    const drill = createM1BallMachineDrill({
      config: base(), ballEvents: makeEvents(),
      configProvider: (i) => {
        calls.push(i);
        return validateConfig({ ...base(), placement: { kind: 'zone', zone: i % 2 ? 7 : 9 } });
      },
    });
    run(drill, 3.5);
    expect(calls).toEqual([...calls.keys()]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(drill.getSnapshot().lastFeed.config.placement.zone).toBe(calls.length % 2 ? 9 : 7);
    drill.dispose();
  });

  test('verdicts carry the index of the ball they judge', () => {
    const seen = [];
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: base(), ballEvents: events, onOutcome: (o) => seen.push(o),
    });
    run(drill, 1.5);
    events.fireBallLost();
    run(drill, 1.5);
    events.fireBallLost();
    expect(seen.map((o) => o.ball)).toEqual([0, 1]);
    drill.dispose();
  });

  test('pause holds the feed and resume restarts it', () => {
    const drill = createM1BallMachineDrill({ config: base(), ballEvents: makeEvents() });
    drill.pause();
    run(drill, 3);
    expect(spawned).toHaveLength(0);
    drill.resume();
    run(drill, 2);
    expect(spawned.length).toBeGreaterThan(0);
    drill.dispose();
  });
});

describe('metadata', () => {
  test('it exposes the event log for M7', () => {
    const drill = createM1BallMachineDrill({ config: WARMUP_FEED });
    expect(typeof drill.getLog).toBe('function');
    expect(drill.getSummary()).toHaveProperty('returnRate');
    drill.dispose();
  });
});

describe('return quality: a touch is not a return', () => {
  const T = require('three');

  // A long interval so exactly one ball is in play (see the miss-accounting
  // block above for why).
  const oneBallConfig = () => validateConfig({
    ...WARMUP_FEED, interval: 6, burstCount: INFINITE,
  });

  // Outgoing state a real paddleHit carries. The judge rolls it through the
  // shared integrator, so these are physical shots, not magic flags.
  const goodHit = () => ({
    contactLocal: { x: 0, y: 0 },
    contactPos: new T.Vector3(0, 0.3, 1.3),
    outVel: new T.Vector3(0, 2.5, -3.5),   // over the net, onto the far half
    outSpin: new T.Vector3(0, 0, 0),
  });
  const outHit = () => ({
    contactLocal: { x: 0, y: 0 },
    contactPos: new T.Vector3(0, 0.3, 1.0),
    outVel: new T.Vector3(0, 1.5, 3),      // away from the table entirely
    outSpin: new T.Vector3(0, 0, 0),
  });
  const ownHalfHit = () => ({
    contactLocal: { x: 0, y: 0 },
    contactPos: new T.Vector3(0, 0.15, 1.2),
    outVel: new T.Vector3(0, -0.5, -3),    // dribbles onto the player's own half
    outSpin: new T.Vector3(0, 0, 0),
  });

  test('a verified good return is credited', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({ config: oneBallConfig(), ballEvents: events });
    run(drill, 2);
    events.firePaddleHit(goodHit());
    expect(drill.getSnapshot().returned).toBe(1);
    events.fireBallLost();
    const counts = drill.getLog().outcomeCounts();
    expect(counts.miss).toBe(0);
    expect(counts.error).toBe(0);
    drill.dispose();
  });

  test('a touch hit off the table is an ERROR, not a return and not a MISS', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({ config: oneBallConfig(), ballEvents: events });
    run(drill, 2);
    events.firePaddleHit(outHit());
    expect(drill.getSnapshot().returned).toBe(0);
    expect(drill.getSnapshot().streak).toBe(0);
    events.fireBallLost();
    const counts = drill.getLog().outcomeCounts();
    expect(counts.error).toBe(1);
    expect(counts.miss).toBe(0);
    drill.dispose();
  });

  test('a return onto your own half does not count either', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({ config: oneBallConfig(), ballEvents: events });
    run(drill, 2);
    events.firePaddleHit(ownHalfHit());
    expect(drill.getSnapshot().returned).toBe(0);
    events.fireBallLost();
    expect(drill.getLog().outcomeCounts().error).toBe(1);
    drill.dispose();
  });

  test('a bad touch followed by a good second stroke still earns the credit', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({ config: oneBallConfig(), ballEvents: events });
    run(drill, 2);
    events.firePaddleHit(ownHalfHit());
    events.firePaddleHit(goodHit());
    expect(drill.getSnapshot().returned).toBe(1);
    events.fireBallLost();
    expect(drill.getLog().outcomeCounts().error).toBe(0);
    drill.dispose();
  });

  test('an untouched ball stays a MISS — the verdicts do not blur', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({ config: oneBallConfig(), ballEvents: events });
    run(drill, 2);
    events.fireBallLost();
    const counts = drill.getLog().outcomeCounts();
    expect(counts.miss).toBe(1);
    expect(counts.error).toBe(0);
    drill.dispose();
  });

  test('every launched ball is accounted for exactly once, errors included', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...WARMUP_FEED, interval: 1, burstCount: INFINITE }),
      ballEvents: events,
    });
    let flip = 0;
    for (let i = 0; i < 8 / 0.02; i++) {
      drill.update(0.02);
      // Alternate good and bad touches across the run.
      if (i % 40 === 0) events.firePaddleHit((flip++ % 2) ? goodHit() : outHit());
    }
    events.fireBallLost();
    const snap = drill.getSnapshot();
    const counts = drill.getLog().outcomeCounts();
    expect(counts.returned + counts.miss + counts.error).toBe(snap.fed - snap.skipped);
    drill.dispose();
  });
});
