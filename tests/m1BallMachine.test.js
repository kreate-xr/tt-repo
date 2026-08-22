// M1 Ball Machine drill — feed accounting.
//
// The specific risk: a feed the solver refuses puts no ball in play, so it
// must not be charged to the player as a miss. That is silent when wrong —
// nothing errors, the return rate is simply wrong — and it feeds M7's
// weakness report, so a bad number there prescribes the wrong drills.

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
const { QUICK_FEED } = require('../js/modes/training/presets.js');

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
      config: validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE }),
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
      config: validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE }),
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
    ...QUICK_FEED.Warmup.config, speed: 2,
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
    ...QUICK_FEED.Warmup.config, interval: 6, burstCount: INFINITE,
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
      config: validateConfig({ ...QUICK_FEED.Warmup.config, interval: 1, burstCount: INFINITE }),
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
      config: validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE }),
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
      config: validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE }),
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
      config: validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE }),
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
      config: validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE }),
      ballEvents: events,
    });
    run(drill, 3);
    for (let i = 0; i < 3; i++) events.hit.forEach((f) => f(hitWith(0, -0.025)));
    expect(drill.getLog().meanContactOffset().y).toBeLessThan(0);
    drill.dispose();
  });
});

describe('rapid fire: the machine sweeps between feed origins', () => {
  // Rapid Fire's beat is the configured interval doubled (pattern paceMul 2),
  // so interval 2.0 → one ball per second.
  const rapidConfig = () => validateConfig({
    ...QUICK_FEED.Warmup.config, speed: 8, interval: 2.0, burstCount: INFINITE,
  });

  test('balls launch from both wings, all from behind the far rail', () => {
    const drill = createM1BallMachineDrill({
      config: rapidConfig(), ballEvents: makeEvents(), pattern: 'rapidFire',
    });
    run(drill, 15);
    expect(spawned.length).toBeGreaterThanOrEqual(4);
    const xs = spawned.map(([pos]) => pos.x);
    // The sweep origins sit at ±0.6·halfWidth ≈ ±0.46; seeing both signs
    // proves the per-feed origin actually reached the solver.
    expect(Math.min(...xs)).toBeLessThan(-0.3);
    expect(Math.max(...xs)).toBeGreaterThan(0.3);
    for (const [pos] of spawned) expect(pos.z).toBeLessThan(-1.37);
    drill.dispose();
  });

  test('the machine glides toward the next origin instead of teleporting', () => {
    const drill = createM1BallMachineDrill({
      config: rapidConfig(), ballEvents: makeEvents(), pattern: 'rapidFire',
    });
    // The drill snaps the figure to ball 0's origin (L-far, −x) at creation.
    expect(drill.figure.group.position.x).toBeLessThan(-0.3);

    // Track the figure between updates: after feeds start, its x must pass
    // through intermediate values on the way to the next origin — a teleport
    // would jump 0.46 m in a single 20 ms frame.
    let maxFrameStep = 0;
    let prevX = drill.figure.group.position.x;
    for (let i = 0; i < 15 / 0.02; i++) {
      drill.update(0.02);
      const x = drill.figure.group.position.x;
      maxFrameStep = Math.max(maxFrameStep, Math.abs(x - prevX));
      prevX = x;
    }
    expect(drill.getSnapshot().fed).toBeGreaterThanOrEqual(4);
    // beginSwing's authoritative aim() snap absorbs only residual travel, so
    // no frame should move anywhere near a full origin hop.
    expect(maxFrameStep).toBeLessThan(0.2);
    drill.dispose();
  });

  test('feeds on the beat even while a ball is still in play', () => {
    // The wait this removes: every other drill holds the next feed until the
    // previous ball clears, so the cadence was really "ball lifetime", not
    // the interval. Rapid Fire recycles the ball on the beat instead.
    const { ballModel } = require('../js/scene/models.js');
    ballModel.visible = true;   // a ball that never clears
    try {
      const drill = createM1BallMachineDrill({
        config: rapidConfig(), ballEvents: makeEvents(), pattern: 'rapidFire',
      });
      run(drill, 10);
      // 1 s beat → ~10 feeds in 10 s; anything close proves the gate is open.
      expect(drill.getSnapshot().fed).toBeGreaterThanOrEqual(6);
      drill.dispose();
      ballModel.visible = true;   // dispose() hides the ball — re-pin it

      // Control: a plain drill still waits for the ball to clear.
      const plain = createM1BallMachineDrill({
        config: rapidConfig(), ballEvents: makeEvents(),
      });
      run(plain, 10);
      expect(plain.getSnapshot().fed).toBe(0);
      plain.dispose();
    } finally {
      ballModel.visible = false;
    }
  });

  test('a fixed-origin pattern still feeds from one spot', () => {
    const drill = createM1BallMachineDrill({
      config: rapidConfig(), ballEvents: makeEvents(), pattern: 'falkenberg',
    });
    run(drill, 12);
    const xs = spawned.map(([pos]) => pos.x);
    expect(spawned.length).toBeGreaterThan(1);
    for (const x of xs) expect(x).toBeCloseTo(xs[0], 6);
    drill.dispose();
  });

  test('a plain (no-pattern) drill is unaffected by the preview wiring', () => {
    const drill = createM1BallMachineDrill({
      config: validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE }),
      ballEvents: makeEvents(),
    });
    run(drill, 8);
    expect(drill.getSnapshot().fed).toBeGreaterThan(0);
    expect(drill.getSnapshot().skipped).toBe(0);
    drill.dispose();
  });

  test('rapid fire survives a ladder tier change mid-run', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: rapidConfig(), ballEvents: events,
      pattern: 'rapidFire', ladderTier: 'bronze',
    });
    // Return every ball so the ladder promotes after its 20-ball window.
    for (let i = 0; i < 30 / 0.02; i++) {
      drill.update(0.02);
      events.firePaddleHit();
    }
    const snap = drill.getSnapshot();
    expect(snap.fed).toBeGreaterThan(20);
    expect(snap.tier).not.toBe('bronze');   // promoted without throwing
    drill.dispose();
  });
});

describe('metadata', () => {
  test('it exposes the event log for M7', () => {
    const drill = createM1BallMachineDrill({ config: QUICK_FEED.Warmup.config });
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
    ...QUICK_FEED.Warmup.config, interval: 6, burstCount: INFINITE,
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
      config: validateConfig({ ...QUICK_FEED.Warmup.config, interval: 1, burstCount: INFINITE }),
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

describe('curriculum tuner wiring (M10 closes the loop)', () => {
  const randomConfig = () => validateConfig({
    ...QUICK_FEED.Warmup.config, speed: 8, interval: 1, burstCount: INFINITE,
  });

  test('a random pattern drill records verdicts into the tuner', () => {
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: randomConfig(), ballEvents: events,
      pattern: 'twoPoint', random: true,
    });
    for (let i = 0; i < 10 / 0.02; i++) {
      drill.update(0.02);
      events.firePaddleHit();   // bare touch → credited via the fallback
    }
    expect(drill.tuner).toBeTruthy();
    const attempts = [...drill.tuner.stats.values()]
      .reduce((a, s) => a + s.attempts, 0);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBe(drill.getSnapshot().returned);
    expect(drill.getSnapshot().curriculum).not.toBeNull();
    drill.dispose();
  });

  test('no tuner without a random pattern, and adaptive:false opts out', () => {
    const sequenced = createM1BallMachineDrill({
      config: randomConfig(), ballEvents: makeEvents(), pattern: 'twoPoint',
    });
    expect(sequenced.tuner).toBeNull();
    sequenced.dispose();

    const optedOut = createM1BallMachineDrill({
      config: randomConfig(), ballEvents: makeEvents(),
      pattern: 'twoPoint', random: true, adaptive: false,
    });
    expect(optedOut.tuner).toBeNull();
    expect(optedOut.getSnapshot().curriculum).toBeNull();
    optedOut.dispose();
  });

  test('the tuner survives a ladder tier change', () => {
    // The runner is rebuilt on promotion; the tuner must NOT be — it would
    // forget the success surface it just learned.
    const events = makeEvents();
    const drill = createM1BallMachineDrill({
      config: randomConfig(), ballEvents: events,
      pattern: 'twoPoint', random: true, ladderTier: 'bronze',
    });
    const tunerBefore = drill.tuner;
    for (let i = 0; i < 30 / 0.02; i++) {
      drill.update(0.02);
      events.firePaddleHit();
    }
    expect(drill.getSnapshot().tier).not.toBe('bronze');
    expect(drill.tuner).toBe(tunerBefore);
    drill.dispose();
  });
});
