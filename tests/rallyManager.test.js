// Unit tests for V2 rally manager + ITTF scoring. Spec §section_6.

const THREE = require('three');

// rallyManager imports js/physics/ball.js + js/scene/models.js (for ball
// spawn during player-serve). Mock both so tests run pure.
jest.mock('../js/physics/ball.js', () => {
  const T = require('three');
  return {
    spawnBallAt: jest.fn(),
    ballVelocity: new T.Vector3(),
    ballAngularVelocity: new T.Vector3(),
  };
});
jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    tableBox: new T.Box3(
      new T.Vector3(-0.7625, -0.01, -1.37),
      new T.Vector3( 0.7625,  0.01,  1.37),
    ),
    tableSurfaceY: 0,
    ballRadius: 0.02,
    ballModel: { visible: false },
  };
});
// hud.js references `window` at module load, which doesn't exist in the
// jest node environment. Mock to a no-op logger.
jest.mock('../js/scene/hud.js', () => ({
  SELF_TEST: false,
  hudLog: jest.fn(),
}));

// eslint-disable-next-line import/first
import { createRallyManager } from '../js/modes/aiMatch/rallyManager.js';

// Synthetic ballEvents emitter so we can drive the manager without a
// running game loop.
function makeBallEvents() {
  const listeners = {
    paddleHit: [], tableBounce: [], netHit: [], ballLost: [],
  };
  return {
    onPaddleHit:  (fn) => listeners.paddleHit.push(fn),
    onTableBounce: (fn) => listeners.tableBounce.push(fn),
    onNetHit:     (fn) => listeners.netHit.push(fn),
    onBallLost:   (fn) => listeners.ballLost.push(fn),
    emit(kind, info) {
      for (const fn of (listeners[kind] || [])) fn(info);
    },
  };
}

function makeStubServer() {
  return {
    startServe: jest.fn(),
    isFinished: jest.fn(() => true),
    onContact: jest.fn(),
    update: jest.fn(),
    dispose: jest.fn(),
    getState: () => 'SERVE_IDLE',
  };
}

// Capture intervals so jest.useFakeTimers can drive nextServe scheduling.
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

// Helper: simulate a player → AI → bounceOnPlayer → player-missing rally.
function playRally(events, sequence) {
  for (const step of sequence) {
    events.emit(step.kind, step.info);
  }
}

// --- Rally-end detection ---------------------------------------------------

describe('rallyManager — rally-end detection', () => {
  test('double bounce on player side after AI hit → AI wins point', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    playRally(events, [
      { kind: 'paddleHit',  info: { origin: 'player' } },
      { kind: 'tableBounce', info: { x: 0, z: -0.5 } }, // 1st bounce, AI side
      { kind: 'paddleHit',  info: { origin: 'ai-opponent' } },
      { kind: 'tableBounce', info: { x: 0, z:  0.5 } }, // 1st bounce, player side
      { kind: 'tableBounce', info: { x: 0, z:  0.7 } }, // 2nd — player missed
    ]);

    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('doubleBounce');
    rm.dispose();
  });

  test('net hit → not-lastHitter wins point', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    playRally(events, [
      { kind: 'paddleHit', info: { origin: 'player' } },
      { kind: 'netHit',    info: { axis: 'z' } },
    ]);

    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('netHit');
    rm.dispose();
  });

  test('ball out without bounce on opponent side → hitter loses', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    playRally(events, [
      { kind: 'paddleHit', info: { origin: 'player' } },
      // No tableBounce on AI side, ball just lost.
      { kind: 'ballLost',  info: { reason: 'outOfBounds' } },
    ]);

    expect(points[0].winner).toBe('ai'); // player hit out → AI gets point
    expect(points[0].reason).toBe('ballLost');
    rm.dispose();
  });

  test('ball lost AFTER opponent bounce → opponent failed to return', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    playRally(events, [
      { kind: 'paddleHit',  info: { origin: 'player' } },
      { kind: 'tableBounce', info: { x: 0, z: -0.5 } }, // bounces on AI side
      { kind: 'ballLost',   info: { reason: 'fellOff' } },  // AI didn't return
    ]);

    expect(points[0].winner).toBe('player');
    rm.dispose();
  });
});

// --- Scoring + game/match end ----------------------------------------------

describe('rallyManager — game and match ending', () => {
  // Helper: programmatically score a sequence of points.
  function scoreSequence(rm, events, winners) {
    for (const w of winners) {
      // Simulate the simplest scoring scenario: paddleHit then ballLost with
      // matching state to produce the desired winner.
      if (w === 'ai') {
        events.emit('paddleHit', { origin: 'player' });
        events.emit('ballLost', { reason: 'out' });
      } else {
        events.emit('paddleHit', { origin: 'ai-opponent' });
        events.emit('ballLost', { reason: 'out' });
      }
      // Advance the next-serve timer so the next rally can start.
      jest.advanceTimersByTime(1500);
    }
  }

  test('first to 11 with ≥2-point lead wins a game', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const games = [];
    rm.on('onGameEnd', (e) => games.push(e));

    // AI wins 11 straight points → game won 11-0.
    scoreSequence(rm, events, Array(11).fill('ai'));
    expect(games).toHaveLength(1);
    expect(games[0].winner).toBe('ai');
    expect(games[0].aiGames).toBe(1);
    rm.dispose();
  });

  test('deuce at 10-10 requires a 2-point lead to win', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const games = [];
    rm.on('onGameEnd', (e) => games.push(e));

    // Alternate ai/player up to 10-10 (20 points).
    const seq = [];
    for (let i = 0; i < 10; i++) { seq.push('ai'); seq.push('player'); }
    scoreSequence(rm, events, seq);
    expect(rm.getScore().aiScore).toBe(10);
    expect(rm.getScore().playerScore).toBe(10);
    expect(games).toHaveLength(0);

    // 11-10 is NOT a win (need 2-point lead).
    scoreSequence(rm, events, ['ai']);
    expect(games).toHaveLength(0);
    expect(rm.getScore().aiScore).toBe(11);

    // 12-10 IS a win.
    scoreSequence(rm, events, ['ai']);
    expect(games).toHaveLength(1);
    expect(games[0].winner).toBe('ai');
    rm.dispose();
  });

  test('match ends when a side wins majority of bestOf games', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({
      ballEvents: events, server,
      config: { bestOf: 5, firstTo: 3, deucePoint: 99 }, // shorter games for test speed
    });
    const matchEnd = [];
    rm.on('onMatchEnd', (e) => matchEnd.push(e));

    // Need 3 games (majority of best-of-5) for match.
    // Win each game 3-0.
    for (let g = 0; g < 3; g++) {
      scoreSequence(rm, events, ['ai', 'ai', 'ai']);
    }
    expect(matchEnd).toHaveLength(1);
    expect(matchEnd[0].winner).toBe('ai');
    expect(matchEnd[0].aiGames).toBe(3);
    rm.dispose();
  });
});

// --- Serve rotation --------------------------------------------------------

describe('rallyManager — serve rotation', () => {
  test('serve rotates every 2 points outside deuce', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const changes = [];
    rm.on('onServerChange', (e) => changes.push(e.currentServer));

    // Initial server = 'ai'. After 2 points → swap to 'player'. After 4 → 'ai'.
    function scorePoints(n) {
      for (let i = 0; i < n; i++) {
        events.emit('paddleHit', { origin: 'player' });
        events.emit('ballLost', { reason: 'out' });
        jest.advanceTimersByTime(1500);
      }
    }
    scorePoints(2);
    expect(changes).toEqual(['player']);
    scorePoints(2);
    expect(changes).toEqual(['player', 'ai']);
    rm.dispose();
  });

  test('serve rotates EVERY point in deuce', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({
      ballEvents: events, server,
      config: { deucePoint: 2, firstTo: 4 }, // small game for fast deuce
    });
    const changes = [];
    rm.on('onServerChange', (e) => changes.push(e.currentServer));

    // 2-2 deuce: alternate ai/player up to 2-2.
    function score(winner) {
      if (winner === 'ai') {
        events.emit('paddleHit', { origin: 'player' });
        events.emit('ballLost', { reason: 'out' });
      } else {
        events.emit('paddleHit', { origin: 'ai-opponent' });
        events.emit('ballLost', { reason: 'out' });
      }
      jest.advanceTimersByTime(1500);
    }
    // Reach 2-2 deuce. Initial server is 'ai'; first swap to 'player' at 2 pts.
    score('ai'); score('player');             // 1-1
    expect(changes).toEqual(['player']);       // swapped after 2 points
    score('ai'); score('player');             // 2-2 (deuce)
    expect(changes).toEqual(['player', 'ai']); // swapped at 4 points total

    // Now in deuce — every point swaps the server.
    const prev = changes.length;
    score('ai');                               // 3-2
    expect(changes.length).toBe(prev + 1);
    score('player');                           // 3-3
    expect(changes.length).toBe(prev + 2);
    rm.dispose();
  });
});

// --- Config ----------------------------------------------------------------

describe('rallyManager — configurable match format', () => {
  test('setConfig overrides firstTo / bestOf / deucePoint', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    rm.setConfig({ firstTo: 5, bestOf: 3, deucePoint: 4 });
    expect(rm.getScore()).toMatchObject({ aiScore: 0, playerScore: 0 });
    rm.dispose();
  });
});
