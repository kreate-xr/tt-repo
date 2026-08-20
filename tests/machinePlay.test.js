// Machine Play — fail states and scoring.
//
// The specific risk this covers: the mode ends on a CONDITION rather than on a
// ball count, so an off-by-one or a phantom miss does not error, it just ends
// the game at the wrong moment. Survival is the sharpest case — a run that
// dies on the first feed because a ball in flight was counted as missed looks
// exactly like a run that ended fairly.

const THREE = require('three');

jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/audio.js', () => ({ playMenuHoverTick: () => {} }));
jest.mock('../js/physics/ball.js', () => ({ spawnBallAt: () => {} }));
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

const {
  createMachinePlayDrill, MACHINE_MODES, MACHINE_PLAY,
} = require('../js/modes/machinePlay/machinePlay.js');
const { INFINITE } = require('../js/modes/training/drillConfig.js');
const { QUICK_FEED } = require('../js/modes/training/presets.js');

// Minimal ballEvents shim matching what inGame.js supplies.
function makeEvents() {
  const hit = [];
  const lost = [];
  return {
    onPaddleHit: (fn) => hit.push(fn),
    onBallLost: (fn) => lost.push(fn),
    offPaddleHit: () => {},
    offBallLost: () => {},
    firePaddleHit: (payload = {}) => hit.forEach((f) => f(payload)),
    fireBallLost: () => lost.forEach((f) => f()),
  };
}

// Warmup at a short interval, so a test does not have to simulate minutes of
// wall-clock to see several feeds.
const fastConfig = { ...QUICK_FEED.Warmup.config, interval: 0.8 };

function run(drill, seconds, dt = 0.02) {
  for (let i = 0; i < Math.round(seconds / dt); i++) drill.update(dt);
}

/** Advance until `n` balls have been fed, or give up after `limit` seconds. */
function feedBalls(drill, n, limit = 60) {
  const dt = 0.02;
  for (let t = 0; t < limit / dt; t++) {
    if (drill.getSnapshot().feed.fed >= n) return true;
    drill.update(dt);
  }
  return drill.getSnapshot().feed.fed >= n;
}

describe('mode metadata', () => {
  test('does not build the legacy Feeder — it drives the M1 machine figure', () => {
    // Two server rigs in the scene is the failure this flag prevents, and it
    // is only visible in a headset.
    expect(MACHINE_PLAY.usesFeeder).toBe(false);
    const drill = createMachinePlayDrill({ ballEvents: makeEvents(), config: fastConfig });
    expect(drill.usesFeeder).toBe(false);
    drill.dispose();
  });
});

describe('burst', () => {
  test('a finite burst from the incoming config is overridden to infinite', () => {
    // Every mode owns its own ending. A 20-ball preset would otherwise stop
    // the machine mid-game for a reason the player cannot see.
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events,
      config: { ...fastConfig, burstCount: 5 },
      machineMode: MACHINE_MODES.RALLY,
    });
    expect(feedBalls(drill, 8)).toBe(true);
    expect(drill.isFinished()).toBe(false);
    drill.dispose();
  });

  test('setConfig cannot reintroduce a finite burst mid-rally', () => {
    const drill = createMachinePlayDrill({ ballEvents: makeEvents(), config: fastConfig });
    const applied = drill.setConfig({ ...fastConfig, burstCount: 10 });
    expect(applied.burstCount).toBe(INFINITE);
    drill.dispose();
  });
});

describe('survival', () => {
  test('a ball still in flight does not end the run', () => {
    // The phantom-miss case: after the first feed the ball is counted as fed
    // but not yet returned. Inferring misses by differencing those counters
    // would end a Survival run before the player could reach the ball.
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig, machineMode: MACHINE_MODES.SURVIVAL,
    });
    expect(feedBalls(drill, 1)).toBe(true);
    expect(drill.isFinished()).toBe(false);
    expect(drill.getSnapshot().over).toBe(false);
    drill.dispose();
  });

  test('returns keep it alive and build the streak', () => {
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig, machineMode: MACHINE_MODES.SURVIVAL,
    });
    for (let i = 0; i < 3; i++) {
      expect(feedBalls(drill, i + 1)).toBe(true);
      events.firePaddleHit();
      run(drill, 0.1);
    }
    const s = drill.getSnapshot();
    expect(s.returns).toBe(3);
    expect(s.streak).toBe(3);
    expect(s.bestStreak).toBe(3);
    expect(drill.isFinished()).toBe(false);
    drill.dispose();
  });

  test('the first miss ends it', () => {
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig, machineMode: MACHINE_MODES.SURVIVAL,
    });
    expect(feedBalls(drill, 1)).toBe(true);
    events.firePaddleHit();      // ball 1 returned
    expect(feedBalls(drill, 2)).toBe(true);
    events.fireBallLost();       // ball 2 missed

    expect(drill.isFinished()).toBe(true);
    const s = drill.getSnapshot();
    expect(s.over).toBe(true);
    expect(s.outcome).toBe('failed');
    expect(s.returns).toBe(1);
    expect(s.misses).toBe(1);
    drill.dispose();
  });

  test('the machine stops feeding once the run is over', () => {
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig, machineMode: MACHINE_MODES.SURVIVAL,
    });
    expect(feedBalls(drill, 1)).toBe(true);
    events.fireBallLost();
    const fedAtEnd = drill.getSnapshot().feed.fed;
    run(drill, 10);
    expect(drill.getSnapshot().feed.fed).toBe(fedAtEnd);
    drill.dispose();
  });

  test('a late verdict cannot change the final score', () => {
    // The ball that broke the streak is often still in the air when the run
    // ends; its ballLost arrives afterwards. The score shown at the end must
    // be the score that stands.
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig, machineMode: MACHINE_MODES.SURVIVAL,
    });
    expect(feedBalls(drill, 1)).toBe(true);
    events.fireBallLost();
    const after = drill.getSnapshot();
    events.firePaddleHit();
    events.fireBallLost();
    const later = drill.getSnapshot();
    expect(later.returns).toBe(after.returns);
    expect(later.misses).toBe(after.misses);
    drill.dispose();
  });
});

describe('score challenge', () => {
  test('ends the moment the target is reached, not a ball later', () => {
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig,
      machineMode: MACHINE_MODES.CHALLENGE, target: 3,
    });
    for (let i = 0; i < 3; i++) {
      expect(feedBalls(drill, i + 1)).toBe(true);
      expect(drill.isFinished()).toBe(false);   // still short of the target
      events.firePaddleHit();
      if (i < 2) run(drill, 0.1);
    }
    expect(drill.isFinished()).toBe(true);
    const s = drill.getSnapshot();
    expect(s.outcome).toBe('cleared');
    expect(s.returns).toBe(3);
    drill.dispose();
  });

  test('a miss costs progress but does not end the run', () => {
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig,
      machineMode: MACHINE_MODES.CHALLENGE, target: 3,
    });
    expect(feedBalls(drill, 1)).toBe(true);
    events.fireBallLost();
    expect(drill.isFinished()).toBe(false);
    const s = drill.getSnapshot();
    expect(s.misses).toBe(1);
    expect(s.streak).toBe(0);
    drill.dispose();
  });

  test('a nonsense target falls back to a playable one rather than throwing', () => {
    const drill = createMachinePlayDrill({
      ballEvents: makeEvents(), config: fastConfig,
      machineMode: MACHINE_MODES.CHALLENGE, target: 'banana',
    });
    expect(drill.getSnapshot().target).toBeGreaterThan(0);
    drill.dispose();
  });
});

describe('quick rally', () => {
  test('never ends on its own, however many balls are missed', () => {
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig, machineMode: MACHINE_MODES.RALLY,
    });
    for (let i = 0; i < 4; i++) {
      expect(feedBalls(drill, i + 1)).toBe(true);
      events.fireBallLost();
    }
    expect(drill.isFinished()).toBe(false);
    expect(drill.getSnapshot().misses).toBeGreaterThan(0);
    drill.dispose();
  });

  test('an unknown mode falls back to rally rather than throwing', () => {
    // A stale deep link or a renamed mode should still play.
    const drill = createMachinePlayDrill({
      ballEvents: makeEvents(), config: fastConfig, machineMode: 'nope',
    });
    expect(drill.getSnapshot().mode).toBe(MACHINE_MODES.RALLY);
    drill.dispose();
  });

  test('best streak survives a miss', () => {
    const events = makeEvents();
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig, machineMode: MACHINE_MODES.RALLY,
    });
    for (let i = 0; i < 2; i++) {
      expect(feedBalls(drill, i + 1)).toBe(true);
      events.firePaddleHit();
      run(drill, 0.1);
    }
    expect(feedBalls(drill, 3)).toBe(true);
    events.fireBallLost();
    const s = drill.getSnapshot();
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(2);
    drill.dispose();
  });
});

describe('host interface', () => {
  test('exposes everything inGame.js drives a drill through', () => {
    const drill = createMachinePlayDrill({ ballEvents: makeEvents(), config: fastConfig });
    for (const m of ['update', 'isFinished', 'liveLine', 'getSnapshot', 'getLog',
      'getRecentContacts', 'dispose']) {
      expect(typeof drill[m]).toBe('function');
    }
    drill.dispose();
  });

  test('liveLine reports the mode and never throws', () => {
    for (const mode of Object.values(MACHINE_MODES)) {
      const drill = createMachinePlayDrill({
        ballEvents: makeEvents(), config: fastConfig, machineMode: mode,
      });
      expect(typeof drill.liveLine()).toBe('string');
      expect(drill.liveLine().length).toBeGreaterThan(0);
      drill.dispose();
    }
  });

  test('stats receive feeds and returns, so the summary panel has numbers', () => {
    const events = makeEvents();
    const stats = { feeds: 0, returns: 0, misses: 0 };
    const drill = createMachinePlayDrill({
      ballEvents: events, config: fastConfig,
      stats: {
        recordFeed: () => { stats.feeds++; },
        recordReturn: () => { stats.returns++; },
        recordMiss: () => { stats.misses++; },
      },
    });
    expect(feedBalls(drill, 1)).toBe(true);
    events.firePaddleHit();
    expect(stats.feeds).toBeGreaterThan(0);
    expect(stats.returns).toBe(1);
    drill.dispose();
  });
});
