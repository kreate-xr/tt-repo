// Training Session — the model.
//
// The session is only as good as the balls it feeds and the verdicts it
// credits. These pin: every ball it can ever feed actually lands (at both
// levels, both hands, across the whole adaptive pace band); sets run in
// order with a rest between them; pace adapts within a set and resets across
// sets; verdicts land on the set that FED the ball even when they arrive
// during the next rest; and the score card adds up.

const THREE = require('three');
const { solveFeed } = require('../js/modes/training/feedEngine.js');
const { mulberry32 } = require('../js/util/rng.js');
const {
  SessionModel, SETS, LEVELS, LEVEL_ORDER, ADAPT, stepConfig,
  INTRO_SECONDS, REST_SECONDS, FINISH_TIMEOUT_SECONDS, FOCUS_MULTIPLIER,
} = require('../js/modes/training/session.js');

// Real ITTF table, player half +z (same env as tests/feedEngine.test.js).
const HALF_LEN = 1.37;
const HALF_WID = 0.7625;
const env = {
  ballRadius: 0.02,
  tableSurfaceY: 0,
  tableBox: new THREE.Box3(
    new THREE.Vector3(-HALF_WID, -0.001, -HALF_LEN),
    new THREE.Vector3(HALF_WID, 0.001, HALF_LEN),
  ),
  netBox: new THREE.Box3(
    new THREE.Vector3(-HALF_WID - 0.14, 0, -0.005),
    new THREE.Vector3(HALF_WID + 0.14, 0.1525, 0.005),
  ),
};

const tableHalf = { farZ: -HALF_LEN, netZ: 0 };

// Drive a model through the intro so it is feeding.
function playing(opts = {}) {
  const m = new SessionModel({ rng: mulberry32(7), tableHalf, ...opts });
  expect(m.tick(INTRO_SECONDS + 0.01)).toBe('resume');
  return m;
}

// Feed the rest of the current set, crediting each ball with `result`.
let nextBall = 0;
function playOutSet(m, result = 'returned', extra = {}) {
  while (!m.setFull) {
    const ball = nextBall++;
    m.nextConfig(ball);
    m.recordOutcome({ ball, result, ...extra });
  }
}

describe('feasibility', () => {
  // A ball the solver refuses is skipped by the machine — a hole in the set
  // the player reads as the machine breaking. Every step, at both levels,
  // both hands and the pace band's extremes, must be a real feed.
  const paces = [ADAPT.min, 1, ADAPT.max];
  for (const levelId of LEVEL_ORDER) {
    for (const set of SETS) {
      test(`${levelId} · ${set.id}: every step lands`, () => {
        for (const hand of ['R', 'L']) {
          for (const pace of paces) {
            for (const step of set.steps) {
              const cfg = { ...stepConfig(LEVELS[levelId], step, { hand, pace }), scatterSigma: 0 };
              const feed = solveFeed(cfg, env);
              expect({ hand, pace, step, feasible: feed.feasible })
                .toEqual({ hand, pace, step, feasible: true });
            }
          }
        }
      });
    }
  }

  test('forehand and backhand mirror for a left-hander', () => {
    const lvl = LEVELS.beginner;
    const fhR = stepConfig(lvl, SETS[0].steps[0], { hand: 'R' }).placement.zone;
    const fhL = stepConfig(lvl, SETS[0].steps[0], { hand: 'L' }).placement.zone;
    expect(fhR).toBe(9);
    expect(fhL).toBe(7);
  });
});

describe('flow', () => {
  test('nothing feeds during the intro, then the first set is the forehand', () => {
    const m = new SessionModel({ tableHalf });
    expect(m.playing).toBe(false);
    expect(m.liveLine()).toMatch(/Get ready/);
    expect(m.tick(INTRO_SECONDS - 0.5)).toBeNull();
    expect(m.tick(0.6)).toBe('resume');
    expect(m.set.id).toBe('forehand');
  });

  test('a full set pauses the machine, rests, then starts the next set', () => {
    const m = playing();
    playOutSet(m);
    expect(m.tick(0.016)).toBe('pause');
    expect(m.liveLine()).toMatch(/Rest {2}· {2}Next: Backhand/);
    expect(m.tick(REST_SECONDS - 0.5)).toBeNull();
    expect(m.tick(0.6)).toBe('resume');
    expect(m.set.id).toBe('backhand');
    expect(m.fedInSet).toBe(0);
  });

  test('runs every set in order and then completes', () => {
    const m = playing();
    const seen = [];
    for (;;) {
      seen.push(m.set.id);
      playOutSet(m);
      m.tick(0.016);
      if (m.phase === 'finishing') break;
      m.tick(REST_SECONDS + 0.01);
    }
    expect(seen).toEqual(SETS.map((s) => s.id));
    // Every ball already has its verdict, so the session scores at once.
    expect(m.tick(0.016)).toBe('done');
    expect(m.complete).toBe(true);
  });

  test('a final ball with no verdict holds the finish until the timeout', () => {
    const m = playing();
    m.setIndex = SETS.length - 1;
    for (let i = 0; i < m.level.ballsPerSet; i++) m.nextConfig(1000 + i);
    m.tick(0.016);
    expect(m.phase).toBe('finishing');
    expect(m.tick(1)).toBeNull();
    expect(m.tick(FINISH_TIMEOUT_SECONDS)).toBe('done');
  });

  test('the live line is a few words and a count, never a paragraph', () => {
    const m = playing();
    m.nextConfig(nextBall++);
    expect(m.liveLine()).toBe(`Forehand  ·  ${m.level.ballsPerSet - 1} left`);
  });

  test('fixed sets cycle their steps in order; random sets draw', () => {
    const m = playing();
    m.setIndex = SETS.findIndex((s) => s.id === 'falkenberg');
    const zones = [0, 1, 2, 3].map(() => m.nextConfig(nextBall++).placement.zone);
    expect(zones).toEqual([7, 8, 9, 7]);
  });
});

describe('adaptation', () => {
  test('three good returns in a row quicken the feed, capped', () => {
    const m = playing();
    const returnOne = () => {
      const ball = nextBall++;
      const cfg = m.nextConfig(ball);
      m.recordOutcome({ ball, result: 'returned' });
      return cfg.speed;
    };
    const base = returnOne();
    returnOne();
    returnOne();
    expect(m.pace).toBeCloseTo(1 + ADAPT.up);
    expect(returnOne()).toBeCloseTo(base * (1 + ADAPT.up));
    m.pace = ADAPT.max;
    returnOne();
    returnOne();
    expect(m.pace).toBe(ADAPT.max);
  });

  test('three failures in a row slow the feed and show the set\'s cue', () => {
    const m = playing();
    for (const result of ['miss', 'error', 'miss']) {
      const ball = nextBall++;
      m.nextConfig(ball);
      m.recordOutcome({ ball, result });
    }
    expect(m.pace).toBeCloseTo(1 - ADAPT.down);
    expect(m.tip).toBe(SETS[0].tip);
    expect(m.liveLine()).toMatch(/^Close the face/);
  });

  test('on a mixed-spin set the cue names the spin that was missed', () => {
    const m = playing();
    m.setIndex = SETS.findIndex((s) => s.id === 'pushBlock');
    for (let i = 0; i < 3; i++) {
      const ball = nextBall++;
      m.nextConfig(ball);
      m.recordOutcome({ ball, result: 'miss', spin: 'back' });
    }
    expect(m.tip).toMatch(/Backspin/);
  });

  test('the cue clears after a few seconds', () => {
    const m = playing();
    m.tip = 'x'; m.tipTime = 1;
    m.tick(1.1);
    expect(m.tip).toBeNull();
  });

  test('each set starts back at its level\'s pace', () => {
    const m = playing();
    m.pace = ADAPT.min;
    playOutSet(m);
    m.tick(0.016);
    m.tick(REST_SECONDS + 0.01);
    expect(m.pace).toBe(1);
  });
});

describe('attribution', () => {
  test('a verdict arriving during the rest is credited to the set that fed it', () => {
    const m = playing();
    const last = [];
    while (!m.setFull) { const b = nextBall++; last.push(b); m.nextConfig(b); }
    m.tick(0.016);
    m.tick(REST_SECONDS + 0.01);
    expect(m.set.id).toBe('backhand');
    for (const b of last) m.recordOutcome({ ball: b, result: 'returned' });
    const r = m.report();
    expect(r.sets.find((s) => s.id === 'forehand').fed).toBe(m.level.ballsPerSet);
    expect(r.sets.find((s) => s.id === 'backhand').fed).toBe(0);
  });

  test('a skipped feed (no verdict) does not shift later verdicts', () => {
    const m = playing();
    const skipped = nextBall++;
    m.nextConfig(skipped);
    const b = nextBall++;
    m.nextConfig(b);
    m.recordOutcome({ ball: b, result: 'returned' });
    expect(m.report().sets[0]).toMatchObject({ fed: 1, score: 100 });
  });

  test('an unknown or repeated ball index is ignored', () => {
    const m = playing();
    const b = nextBall++;
    m.nextConfig(b);
    m.recordOutcome({ ball: b, result: 'returned' });
    m.recordOutcome({ ball: b, result: 'miss' });
    m.recordOutcome({ ball: 99999, result: 'miss' });
    expect(m.report().sets[0]).toMatchObject({ fed: 1, score: 100 });
  });
});

describe('score card', () => {
  test('rolls sets up into blocks and names the strongest and weakest', () => {
    const m = playing();
    // Warm-up perfect; footwork half; spin and random all missed.
    const credit = (fn) => {
      while (!m.setFull) {
        const ball = nextBall++;
        m.nextConfig(ball);
        m.recordOutcome({ ball, result: fn(m.fedInSet) });
      }
      m.tick(0.016);
      if (m.phase === 'rest') m.tick(REST_SECONDS + 0.01);
    };
    credit(() => 'returned');                                   // forehand
    credit(() => 'returned');                                   // backhand
    credit((n) => (n % 2 ? 'returned' : 'miss'));               // twoPoint
    credit((n) => (n % 2 ? 'returned' : 'miss'));               // falkenberg
    credit(() => 'miss');                                       // pushBlock
    credit(() => 'returned');                                   // random
    const r = m.report();
    const byId = Object.fromEntries(r.blocks.map((b) => [b.id, b.score]));
    expect(byId).toEqual({ warmup: 100, footwork: 50, spin: 0, random: 100 });
    expect(r.strongest).toBe('warmup');
    expect(r.weakest).toBe('spin');
    expect(r.weakestSet).toBe('pushBlock');
    const n = m.level.ballsPerSet;
    expect(r.score).toBe(Math.round(100 * (n * 3 + n) / (n * 6)));
    // Both warm-up sets, plus the footwork set's first ball.
    expect(r.bestStreak).toBe(n * 2 + 1);
  });

  test('depth counts returns landing in the far third of the machine half', () => {
    const m = playing();
    const land = (z) => {
      const ball = nextBall++;
      m.nextConfig(ball);
      m.recordOutcome({ ball, result: 'returned', landing: { x: 0, z } });
    };
    land(-1.2);   // deep
    land(-0.3);   // short
    expect(m.report().depth).toBe(50);
  });

  test('depth is unknown, not zero, when no return carried a landing', () => {
    const m = playing();
    const ball = nextBall++;
    m.nextConfig(ball);
    m.recordOutcome({ ball, result: 'returned' });
    expect(m.report().depth).toBeNull();
  });
});

describe('focus run', () => {
  test('runs only the named set, for longer, then finishes', () => {
    const m = playing({ focus: 'falkenberg' });
    expect(m.sets.map((s) => s.id)).toEqual(['falkenberg']);
    expect(m.ballsPerSet).toBe(m.level.ballsPerSet * FOCUS_MULTIPLIER);
    playOutSet(m);
    m.tick(0.016);
    expect(m.phase).toBe('finishing');
    expect(m.tick(0.016)).toBe('done');
    expect(m.report()).toMatchObject({ focus: 'falkenberg', score: 100 });
  });

  test('an unknown focus falls back to the full session', () => {
    const m = new SessionModel({ focus: 'nonesuch', tableHalf });
    expect(m.focus).toBeNull();
    expect(m.sets).toBe(SETS);
  });

  test('the weakest set is the lower-scoring set inside the weakest block', () => {
    const m = playing();
    const credit = (fn) => {
      while (!m.setFull) {
        const ball = nextBall++;
        m.nextConfig(ball);
        m.recordOutcome({ ball, result: fn(m.fedInSet) });
      }
      m.tick(0.016);
      if (m.phase === 'rest') m.tick(REST_SECONDS + 0.01);
    };
    credit(() => 'returned');                         // forehand 100
    credit((n) => (n % 2 ? 'returned' : 'miss'));     // backhand 50
    for (let i = 0; i < 4; i++) credit(() => 'returned');
    const r = m.report();
    expect(r.weakest).toBe('warmup');
    expect(r.weakestSet).toBe('backhand');
  });
});
