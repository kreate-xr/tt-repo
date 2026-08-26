// Unit tests for V2 rally manager + ITTF scoring. Spec §section_6.

const THREE = require('three');

// rallyManager imports js/physics/ball.js + js/scene/models.js (for ball
// spawn during player-serve). Mock both so tests run pure.
jest.mock('../js/physics/ball.js', () => {
  const T = require('three');
  return {
    spawnBallAt: jest.fn(),
    despawnBall: jest.fn(),
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

  test('shot into the net that falls back on own half → hitter loses', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    playRally(events, [
      { kind: 'paddleHit',  info: { origin: 'player' } },
      { kind: 'netHit',     info: { axis: 'z' } },
      { kind: 'tableBounce', info: { x: 0, z: 0.5 } }, // falls back, player's own half
    ]);

    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('ownSideBounce');
    rm.dispose();
  });

  test('net-cord ball that dribbles over plays on (legal in a rally)', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    playRally(events, [
      { kind: 'paddleHit',  info: { origin: 'player' } },
      { kind: 'netHit',     info: { axis: 'y' } },      // clips the cord…
      { kind: 'tableBounce', info: { x: 0, z: -0.4 } }, // …and carries over
    ]);
    expect(points).toHaveLength(0);                     // rally continues

    playRally(events, [
      { kind: 'tableBounce', info: { x: 0, z: -0.6 } }, // AI never returned it
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('player');
    expect(points[0].reason).toBe('doubleBounce');
    rm.dispose();
  });

  test('rally return bouncing on the hitter\'s own half → immediate fault', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    playRally(events, [
      { kind: 'paddleHit',  info: { origin: 'player' } },
      { kind: 'tableBounce', info: { x: 0, z: 0.6 } }, // player's own half
    ]);

    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('ownSideBounce');
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

// --- Serve legality (ITTF service rules) -------------------------------------
//
// A serve must bounce once on the server's own half, then land on the
// receiver's half. Landing directly on the receiver's half, or dying on the
// server's half, is a serveFault. A net-cord serve that still arrives
// legally is a let: replayed, no point.

describe('rallyManager — serve legality', () => {
  function makePlayerServeStub() {
    const launchListeners = [];
    return {
      arm: jest.fn(() => true),
      disarm: jest.fn(),
      isArmed: jest.fn(() => true),
      update: jest.fn(),
      launch: jest.fn(),
      onLaunch: (fn) => launchListeners.push(fn),
      dispose: jest.fn(),
      fireLaunch: () => { for (const fn of launchListeners) fn(); },
    };
  }

  // Score two quick AI-serve points so the serve rotates to the player.
  function reachPlayerServe(rm, events) {
    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('ballLost', { reason: 'out' });
    jest.advanceTimersByTime(2500);
    events.emit('ballLost', { reason: 'out' });
    jest.advanceTimersByTime(2500);
  }

  test('AI two-bounce serve: own half → player half → second player bounce wins the point', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    rm.start();
    jest.advanceTimersByTime(2500);                    // AI serve stroke armed
    events.emit('tableBounce', { x: 0, z: -0.8 });     // required own-half bounce
    expect(points).toHaveLength(0);
    events.emit('tableBounce', { x: 0, z: 0.4 });      // lands in player court
    expect(points).toHaveLength(0);                    // serve legal, rally live
    events.emit('tableBounce', { x: 0, z: 0.6 });      // player never touched it
    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('doubleBounce');
    rm.dispose();
  });

  test('AI serve landing directly on the player half (no own bounce) → serveFault, player point', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: 0.4 });      // straight into player court
    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('player');
    expect(points[0].reason).toBe('serveFault');
    rm.dispose();
  });

  test('AI serve dying on its own half (double own bounce) → serveFault, player point', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: -0.8 });     // legal first bounce
    events.emit('tableBounce', { x: 0, z: -0.3 });     // never crossed the net
    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('player');
    expect(points[0].reason).toBe('serveFault');
    rm.dispose();
  });

  test('net-cord AI serve that still lands legally → let, replayed, no point', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    const lets = [];
    const serveRequests = [];
    rm.on('onPointScored', (e) => points.push(e));
    rm.on('onLet', (e) => lets.push(e));
    rm.on('onServeRequested', (e) => serveRequests.push(e.server));

    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: -0.8 });     // own-half bounce
    events.emit('netHit', { axis: 'y' });              // clips the cord…
    events.emit('tableBounce', { x: 0, z: 0.3 });      // …and lands good
    expect(points).toHaveLength(0);
    expect(lets).toHaveLength(1);
    expect(lets[0].server).toBe('ai');

    // Same server replays after the inter-serve delay.
    jest.advanceTimersByTime(2500);
    expect(serveRequests).toEqual(['ai', 'ai']);
    expect(rm.getScore().currentServer).toBe('ai');
    rm.dispose();
  });

  test('net-cord AI serve that falls back on its own half → serveFault', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const rm = createRallyManager({ ballEvents: events, server });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: -0.8 });     // own-half bounce
    events.emit('netHit', { axis: 'z' });              // into the net body…
    events.emit('tableBounce', { x: 0, z: -0.2 });     // …falls back on AI half
    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('player');
    expect(points[0].reason).toBe('serveFault');
    rm.dispose();
  });

  test('player serve smashed directly onto the AI half → serveFault, AI point', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const playerServe = makePlayerServeStub();
    const rm = createRallyManager({ ballEvents: events, server, playerServe });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    reachPlayerServe(rm, events);
    playerServe.fireLaunch();
    events.emit('paddleHit', { origin: 'player' });    // the serve stroke
    events.emit('tableBounce', { x: 0, z: -0.5 });     // directly on AI half
    expect(points).toHaveLength(3);                    // 2 rotation points + this
    expect(points[2].winner).toBe('ai');
    expect(points[2].reason).toBe('serveFault');
    rm.dispose();
  });

  test('legal player serve (own half → AI half) starts a normal rally', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const playerServe = makePlayerServeStub();
    const rm = createRallyManager({ ballEvents: events, server, playerServe });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    reachPlayerServe(rm, events);
    playerServe.fireLaunch();
    events.emit('paddleHit', { origin: 'player' });
    events.emit('tableBounce', { x: 0, z: 0.6 });      // own-half bounce (required)
    events.emit('tableBounce', { x: 0, z: -0.5 });     // lands in AI court
    expect(points).toHaveLength(2);                    // no new point — serve legal
    events.emit('tableBounce', { x: 0, z: -0.7 });     // AI never returned it
    expect(points).toHaveLength(3);
    expect(points[2].winner).toBe('player');
    expect(points[2].reason).toBe('doubleBounce');
    rm.dispose();
  });

  test('receiver return of a legal serve is judged by rally rules, not serve rules', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const playerServe = makePlayerServeStub();
    const rm = createRallyManager({ ballEvents: events, server, playerServe });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    reachPlayerServe(rm, events);
    playerServe.fireLaunch();
    events.emit('paddleHit', { origin: 'player' });
    events.emit('tableBounce', { x: 0, z: 0.6 });      // serve: own half
    events.emit('tableBounce', { x: 0, z: -0.5 });     // serve: AI half — legal
    events.emit('paddleHit', { origin: 'ai-opponent' }); // AI returns
    events.emit('tableBounce', { x: 0, z: -0.4 });     // return clips AI's OWN half
    expect(points).toHaveLength(3);
    expect(points[2].winner).toBe('player');
    expect(points[2].reason).toBe('ownSideBounce');
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
    // Payload carries the game's FINAL point totals (captured before the
    // between-games reset) — the scoreboard's history row depends on them.
    expect(games[0].aiScore).toBe(11);
    expect(games[0].playerScore).toBe(0);
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

// --- Player-serve courtesy window -------------------------------------------
//
// Regression: waitingForServeStrike used to be set at arm() time, before any
// toss ball existed. The previous rally's leftover ball (still rolling on the
// table) could emit its stuck/floor ballLost AFTER the 2500ms serve delay,
// which the manager then misread as "the courtesy toss was lost" — scheduling
// a SECOND serve that fired mid-rally: rally state reset, player re-armed
// (phantom ball), serve arrow re-shown during play. The flag must only open
// when playerServe actually spawns the toss (onLaunch).

describe('rallyManager — player-serve courtesy window', () => {
  function makePlayerServeStub() {
    const launchListeners = [];
    return {
      arm: jest.fn(() => true),
      disarm: jest.fn(),
      isArmed: jest.fn(() => true),
      update: jest.fn(),
      launch: jest.fn(),
      onLaunch: (fn) => launchListeners.push(fn),
      dispose: jest.fn(),
      // Test hook — what the real controller does inside launch() after
      // spawning the toss ball.
      fireLaunch: () => { for (const fn of launchListeners) fn(); },
    };
  }

  // Drive the match to the player's first serve. Initial server is 'ai' and
  // the serve rotates after 2 points; the AI-serve path pre-sets
  // lastHitter='ai' / rallyInProgress=true, so a bare ballLost scores the
  // point for the player.
  function reachPlayerServe(rm, events) {
    rm.start();
    jest.advanceTimersByTime(2500);            // serve 1: ai
    events.emit('ballLost', { reason: 'out' });
    jest.advanceTimersByTime(2500);            // serve 2: ai
    events.emit('ballLost', { reason: 'out' });
    jest.advanceTimersByTime(2500);            // serve 3: player (rotated)
  }

  test('stale ballLost from previous rally while armed does NOT reschedule the serve', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const playerServe = makePlayerServeStub();
    const rm = createRallyManager({ ballEvents: events, server, playerServe });
    const serveRequests = [];
    rm.on('onServeRequested', (e) => serveRequests.push(e.server));

    reachPlayerServe(rm, events);
    expect(serveRequests).toEqual(['ai', 'ai', 'player']);
    expect(playerServe.arm).toHaveBeenCalledTimes(1);

    // The old rally's ball finally settles / falls off the table — a stale
    // ballLost arriving while the player is armed but has NOT tossed yet.
    events.emit('ballLost', { reason: 'stuck' });
    jest.advanceTimersByTime(10000);

    // No double-scheduled serve, no re-arm, no score change.
    expect(serveRequests).toEqual(['ai', 'ai', 'player']);
    expect(playerServe.arm).toHaveBeenCalledTimes(1);
    expect(rm.getScore().playerScore).toBe(2);
    expect(rm.getScore().aiScore).toBe(0);
    rm.dispose();
  });

  test('genuinely whiffed toss (launch then ballLost) still re-offers the serve', () => {
    const events = makeBallEvents();
    const server = makeStubServer();
    const playerServe = makePlayerServeStub();
    const rm = createRallyManager({ ballEvents: events, server, playerServe });
    const serveRequests = [];
    rm.on('onServeRequested', (e) => serveRequests.push(e.server));

    reachPlayerServe(rm, events);
    expect(serveRequests).toEqual(['ai', 'ai', 'player']);

    // Player pulls the trigger (toss spawns), then never hits it — the toss
    // ball falls to the floor.
    playerServe.fireLaunch();
    events.emit('ballLost', { reason: 'floor' });
    jest.advanceTimersByTime(2500);

    // Serve re-offered to the player, no point awarded either way.
    expect(serveRequests).toEqual(['ai', 'ai', 'player', 'player']);
    expect(playerServe.arm).toHaveBeenCalledTimes(2);
    expect(rm.getScore().playerScore).toBe(2);
    expect(rm.getScore().aiScore).toBe(0);
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

// --- Contact-time ITTF faults ----------------------------------------------
//
// These two rules are decided by WHERE the paddle met the ball, not by where
// the ball landed, so they can only be exercised through paddleHit payloads
// carrying contactPos/inVel (ball.js always ships both).

describe('rallyManager — obstruction (illegal volley)', () => {
  const contact = (z, vz, y = 0.4, vy = -1) => ({
    origin: 'player',
    contactPos: new THREE.Vector3(0, y, z),
    inVel: new THREE.Vector3(0, vy, vz),
  });

  // Drives the AI's serve up to the moment it has crossed into the player's
  // court but has NOT yet bounced there.
  function aiServeInFlight(rm, events) {
    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: -0.8 });   // serve's own-half bounce
  }

  test('taking the ball out of the air before it bounces loses the point', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    aiServeInFlight(rm, events);
    events.emit('paddleHit', contact(0.5, 2));       // heading into the player's court

    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('illegalVolley');
    expect(points[0].foul).toBe('player');
    rm.dispose();
  });

  test('swatting away a ball that was already going long wins the point', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    aiServeInFlight(rm, events);
    events.emit('paddleHit', contact(0.5, 6));       // clears the end line first

    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('player');
    expect(points[0].reason).toBe('ballOut');
    expect(points[0].foul).toBeNull();
    rm.dispose();
  });

  test('a normal return after the bounce is not a volley', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    aiServeInFlight(rm, events);
    events.emit('tableBounce', { x: 0, z: 0.4 });    // serve lands in, rally live
    events.emit('paddleHit', contact(0.9, 2));       // struck after the bounce

    expect(points).toHaveLength(0);
    rm.dispose();
  });

  test('a rally resumed with no observed opponent stroke is not judged', () => {
    // lastHitter is null here: we never saw how the ball got there, so
    // obstruction is unknowable and must not cost anyone a point.
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    events.emit('paddleHit', contact(0.5, 2));

    expect(points).toHaveLength(0);
    rm.dispose();
  });

  test('a second contact by the same player is not treated as a volley', () => {
    // Double hits are a separate rule; the bounce counter is only reset by
    // the OPPONENT's stroke, so a re-hit must not read as obstruction.
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    aiServeInFlight(rm, events);
    events.emit('tableBounce', { x: 0, z: 0.4 });
    events.emit('paddleHit', contact(0.9, 2));
    events.emit('paddleHit', contact(0.9, 2));

    expect(points).toHaveLength(0);
    rm.dispose();
  });
});

describe('rallyManager — service position', () => {
  // Rotate the serve to the player after a single point.
  function reachPlayerServeFast(rm, events) {
    rm.setConfig({ serveRotationEvery: 1 });
    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: 0.4 });   // AI serve fault → player point
    jest.advanceTimersByTime(2500);                 // player's serve is armed
  }

  const serveContact = (z, y = 0.35) => ({
    origin: 'player',
    contactPos: new THREE.Vector3(0, y, z),
    inVel: new THREE.Vector3(0, -1, 0),
  });

  test('a serve struck out over the table is a fault', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    reachPlayerServeFast(rm, events);
    rm.on('onPointScored', (e) => points.push(e));

    events.emit('paddleHit', serveContact(0.8));

    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('serveFault');
    expect(points[0].detail).toBe('overTable');
    expect(points[0].foul).toBe('player');
    rm.dispose();
  });

  test('a serve struck below the playing surface is a fault', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    reachPlayerServeFast(rm, events);
    rm.on('onPointScored', (e) => points.push(e));

    events.emit('paddleHit', serveContact(1.5, -0.2));

    expect(points).toHaveLength(1);
    expect(points[0].reason).toBe('serveFault');
    expect(points[0].detail).toBe('belowTable');
    rm.dispose();
  });

  test('a serve struck behind the end line plays on', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    reachPlayerServeFast(rm, events);
    rm.on('onPointScored', (e) => points.push(e));

    events.emit('paddleHit', serveContact(1.45));
    events.emit('tableBounce', { x: 0, z: 0.6 });   // own half, as required
    events.emit('tableBounce', { x: 0, z: -0.6 });  // then the AI's — legal serve

    expect(points).toHaveLength(0);
    rm.dispose();
  });

  test('an ordinary rally outcome carries no foul flag', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: -0.8 });
    events.emit('tableBounce', { x: 0, z: 0.4 });
    events.emit('tableBounce', { x: 0, z: 0.6 });   // player never returned it

    expect(points[0].reason).toBe('doubleBounce');
    expect(points[0].foul).toBeNull();
    rm.dispose();
  });
});

describe('rallyManager — dead-ball contacts', () => {
  test('playing the ball after a let is not scored against the player', () => {
    // The player cannot know a let was called until the panel says so, so
    // the reflex return of a cord serve must be ignored entirely — not read
    // as a volley (the let is called before the receiver-side bounce counts).
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    const lets = [];
    rm.on('onPointScored', (e) => points.push(e));
    rm.on('onLet', (e) => lets.push(e));

    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: -0.8 });   // own-half bounce
    events.emit('netHit', { axis: 'y' });            // clips the cord
    events.emit('tableBounce', { x: 0, z: 0.4 });    // still lands good → let
    expect(lets).toHaveLength(1);

    events.emit('paddleHit', {
      origin: 'player',
      contactPos: new THREE.Vector3(0, 0.4, 0.5),
      inVel: new THREE.Vector3(0, -1, 2),
    });

    expect(points).toHaveLength(0);
    rm.dispose();
  });

  test('a swing in the gap between points does not restart the rally', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: 0.4 });    // AI serve fault, point over
    expect(points).toHaveLength(1);

    // Player bats the dead ball around before the next serve.
    events.emit('paddleHit', {
      origin: 'player',
      contactPos: new THREE.Vector3(0, 0.4, 0.5),
      inVel: new THREE.Vector3(0, -1, 2),
    });
    events.emit('ballLost', { reason: 'floor' });

    expect(points).toHaveLength(1);
    rm.dispose();
  });
});

describe('rallyManager — net touch and double hit', () => {
  const contact = (z, vz) => ({
    origin: 'player',
    contactPos: new THREE.Vector3(0, 0.4, z),
    inVel: new THREE.Vector3(0, -1, vz),
  });

  function aiServeLandedIn(rm, events) {
    rm.start();
    jest.advanceTimersByTime(2500);
    events.emit('tableBounce', { x: 0, z: -0.8 });  // serve's own half
    events.emit('tableBounce', { x: 0, z: 0.4 });   // lands in, rally live
  }

  test('touching the net assembly mid-rally loses the point', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    aiServeLandedIn(rm, events);
    rm.reportNetTouch('player');

    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('netTouch');
    expect(points[0].foul).toBe('player');
    rm.dispose();
  });

  test('a net touch between points is ignored', () => {
    // The watcher runs every frame; only a live rally can be interrupted.
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    rm.reportNetTouch('player');
    expect(points).toHaveLength(0);
    rm.dispose();
  });

  test('striking the ball twice in succession loses the point', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({ ballEvents: events, server: makeStubServer() });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    aiServeLandedIn(rm, events);
    events.emit('paddleHit', contact(0.9, -2));   // legal return
    expect(points).toHaveLength(0);
    // A second stroke, well past the one-contact window.
    jest.advanceTimersByTime(400);
    events.emit('paddleHit', contact(0.9, -2));

    expect(points).toHaveLength(1);
    expect(points[0].reason).toBe('doubleHit');
    expect(points[0].foul).toBe('player');
    rm.dispose();
  });
});

describe('strict toss (ITTF 2.6.2 — 16 cm minimum rise)', () => {
  function makePlayerServeStub() {
    const launch = [];
    const low = [];
    return {
      arm: jest.fn(),
      disarm: jest.fn(),
      onLaunch: (fn) => launch.push(fn),
      onLowToss: (fn) => low.push(fn),
      fireLaunch: () => launch.forEach((f) => f()),
      fireLowToss: () => low.forEach((f) => f({ vy: 1.0 })),
    };
  }

  test('umpire ladder: first short toss warns and retakes, the second is a fault', () => {
    const events = makeBallEvents();
    const ps = makePlayerServeStub();
    const rm = createRallyManager({
      ballEvents: events,
      server: makeStubServer(),
      playerServe: ps,
      config: { firstServer: 'player', strictToss: true },
    });
    const points = [];
    rm.on('onPointScored', (e) => points.push(e));

    // First short toss — warning only: no point, serve re-offered.
    ps.fireLaunch();
    ps.fireLowToss();
    expect(points).toHaveLength(0);
    expect(rm.getScore().aiScore).toBe(0);
    expect(ps.disarm).toHaveBeenCalled();

    // Second short toss — service fault, point to the receiver.
    ps.fireLaunch();
    ps.fireLowToss();
    expect(points).toHaveLength(1);
    expect(points[0].winner).toBe('ai');
    expect(points[0].reason).toBe('serveFault');
    expect(points[0].detail).toBe('lowToss');
    expect(points[0].foul).toBe('player');
    expect(rm.getScore().aiScore).toBe(1);
  });

  test('off by default: short tosses never cost a point', () => {
    const events = makeBallEvents();
    const ps = makePlayerServeStub();
    const rm = createRallyManager({
      ballEvents: events,
      server: makeStubServer(),
      playerServe: ps,
      config: { firstServer: 'player' },
    });
    ps.fireLaunch();
    ps.fireLowToss();
    ps.fireLaunch();
    ps.fireLowToss();
    expect(rm.getScore().aiScore).toBe(0);
  });

  test('firstServer config: the player can win the toss and open the match serving', () => {
    const events = makeBallEvents();
    const rm = createRallyManager({
      ballEvents: events,
      server: makeStubServer(),
      config: { firstServer: 'player' },
    });
    expect(rm.getScore().currentServer).toBe('player');
    const rmDefault = createRallyManager({ ballEvents: makeBallEvents(), server: makeStubServer() });
    expect(rmDefault.getScore().currentServer).toBe('ai');
  });
});
