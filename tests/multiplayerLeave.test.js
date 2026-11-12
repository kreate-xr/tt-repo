// Leaving a multiplayer match — the "opponent gone, no rematch possible" path.
//
// The bug: a finished match never let go of its peer connection. The drill
// was disposed, but its listeners stayed on the NetworkManager (no off()), the
// opponent's reconnect watcher read a deliberate leave as an outage (guest:
// retried a deleted room and ENDED the XR session; host: waited forever), and
// inGame's MULTI tile, seeing a connection object, skipped the lobby into a
// match with nobody in it.
//
// These tests run the REAL drill (js/modes/multiplayer/multiplayer.js) against
// a scripted peer over a fake connection. Rendering-only collaborators are
// stubbed; the match model, rulebook, sync, handoff and ReconnectHandler are
// the real ones.

jest.mock('../js/network/telemetryUrl.js', () => ({ TELEMETRY_URL: null }));
jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    ballModel: new T.Object3D(),
    paddleModel: null,
    tableBox: new T.Box3(new T.Vector3(-0.7625, -0.001, -1.37), new T.Vector3(0.7625, 0.001, 1.37)),
    netBox: new T.Box3(new T.Vector3(-0.9, 0, -0.005), new T.Vector3(0.9, 0.1525, 0.005)),
    tableSurfaceY: 0,
    ballRadius: 0.02,
    paddleHitRadius: 0.08,
    paddleHalfThickness: 0.005,
    paddleFaceOffset: new T.Vector3(0, -0.1, 0),
    paddleFaceNormalLocal: new T.Vector3(0, 1, 0),
  };
});
jest.mock('../js/physics/ball.js', () => {
  const T = require('three');
  return {
    ballVelocity: new T.Vector3(),
    ballAngularVelocity: new T.Vector3(),
    spawnBallAt: () => {},
    paddleFaceCenterWorld: new T.Vector3(),
    paddleFaceNormalWorld: new T.Vector3(0, 1, 0),
    paddleVelocity: new T.Vector3(),
  };
});
jest.mock('../js/scene/audio.js', () => ({
  playBounceSound: () => {}, playPaddleHitSound: () => {}, playPaddleEdgeSound: () => {},
  playFoulWhistle: () => {},
}));
jest.mock('../js/scene/hud.js', () => ({ SELF_TEST: false, hudLog: () => {} }));
jest.mock('../js/xr/haptics.js', () => ({ pulseFoul: () => {} }));
jest.mock('../js/analytics/session.js', () => ({
  mark: () => {}, setMatchSummary: () => {}, setNetSource: () => {},
}));
jest.mock('../js/profile/store.js', () => ({ getSetting: () => undefined, subscribe: () => () => {} }));
jest.mock('../js/scene/netTouch.js', () => ({ createNetTouchWatcher: () => ({ update: () => false }) }));
jest.mock('../js/modes/aiMatch/playerServe.js', () => ({
  createPlayerServeController: () => ({
    onLaunch: () => {}, arm: () => {}, disarm: () => {}, dispose: () => {},
    update: () => {}, launch: () => false,
  }),
}));
jest.mock('../js/scene/scoreboard.js', () => ({
  createScoreboard: () => ({ update: () => {}, setMatchOverBanner: () => {}, dispose: () => {} }),
}));
jest.mock('../js/scene/serveArrow.js', () => ({
  createServeArrow: () => ({ show: () => {}, hide: () => {}, update: () => {}, dispose: () => {} }),
}));
jest.mock('../js/scene/pointBurst.js', () => ({
  createPointBurst: () => ({ burst: () => {}, notice: () => {}, update: () => {}, dispose: () => {} }),
}));
// The end-of-match card: keep the model and visibility, drop the canvas.
jest.mock('../js/scene/matchReport.js', () => ({
  createMatchReport: () => {
    const listeners = {};
    const card = {
      model: {}, visible: false, mesh: {},
      on: (e, fn) => { (listeners[e] = listeners[e] || []).push(fn); },
      emit: (e, p) => (listeners[e] || []).forEach((fn) => fn(p)),
      setModel: (patch) => Object.assign(card.model, patch),
      show: () => { card.visible = true; },
      hide: () => { card.visible = false; },
      isVisible: () => card.visible,
      dispose: () => {},
    };
    return card;
  },
}));

import { createMultiplayerDrill } from '../js/modes/multiplayer/multiplayer.js';
import { createMatchModel } from '../js/modes/multiplayer/matchModel.js';
import { NetworkManager } from '../js/network/NetworkManager.js';
import { PacketType } from '../js/network/serialization.js';

// The slice of NetworkManager the drill touches, with the REAL on/off/_emit/
// isOpen so the listener bookkeeping under test is the production code.
function makeEndpoint() {
  const nm = new NetworkManager({ role: 'host', signaling: {}, lagSim: null });
  nm.eventChannel = { readyState: 'open', bufferedAmount: 0 };
  nm.peer = null;
  nm.sent = [];
  nm.sendEvent = (p) => {
    if (!nm.isOpen()) return;
    nm.sent.push(p);
    if (nm.peer) nm.peer._emit('eventMessage', JSON.parse(JSON.stringify(p)));
  };
  nm.sendGame = () => {};
  nm.startSendLoop = () => {};
  nm.stopSendLoop = () => {};
  nm.setSendRate = () => {};
  return nm;
}
function link(a, b) { a.peer = b; b.peer = a; }

const ballEvents = {
  onPaddleHit: () => {}, onTableBounce: () => {}, onNetHit: () => {}, onBallLost: () => {},
  offPaddleHit: () => {}, offTableBounce: () => {}, offNetHit: () => {}, offBallLost: () => {},
};

function makeDrill(role, nm, { lobbyReconnect } = {}) {
  const hooks = { exitToMenu: jest.fn(), endSession: jest.fn() };
  const lobby = {
    code: 'ABC123',
    networkManager: nm,
    reconnect: lobbyReconnect || jest.fn(() => Promise.reject(new Error('ROOM_NOT_FOUND'))),
  };
  const drill = createMultiplayerDrill({
    ballEvents, hooks, multiplayer: { networkManager: nm, role, lobby, bestOf: 1 },
  });
  return { drill, hooks, lobby };
}

function finishedMatchSnapshot() {
  const m = createMatchModel({ bestOf: 1 });
  for (let i = 0; i < 11; i++) m.applyRallyEnd('host');
  return m.serialize();
}

beforeAll(() => {
  // The drill subscribes to Page Visibility; node has no document.
  global.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };
});
afterAll(() => { delete global.document; });
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('opponent leaves after the match is over', () => {
  test('card says OPPONENT LEFT, rematch disabled, and their close does not end our session', async () => {
    const mine = makeEndpoint();
    const theirs = makeEndpoint();
    link(mine, theirs);
    const { drill, hooks, lobby } = makeDrill('guest', mine);

    // The host's state says the match is over → our card goes up.
    theirs.sendEvent({ type: PacketType.SCORE_UPDATE, match: finishedMatchSnapshot(), epoch: 0 });
    expect(drill.panel).not.toBeNull();
    expect(drill.panel.model.title).toMatch(/OPPONENT WINS THE MATCH/);

    // They press EXIT TO MENU: their dispose() sends this.
    theirs.sendEvent({ type: PacketType.REMATCH_REQUEST, epoch: 0, wants: false });
    expect(drill.panel.model.status).toBe('OPPONENT LEFT THE MATCH');
    expect(drill.panel.model.buttons.find((b) => b.id === 'rematch').disabled).toBe(true);

    // Then their connection closes. Before the fix this ran 3 reconnects into
    // a deleted room and called endSession() — kicking us out of XR.
    mine._emit('disconnected', { state: 'closed' });
    await jest.runAllTimersAsync();
    expect(lobby.reconnect).not.toHaveBeenCalled();
    expect(hooks.endSession).not.toHaveBeenCalled();
    drill.dispose();
  });
});

describe('opponent leaves mid-match', () => {
  test('the card goes up (no winner) and no serve window opens against nobody', async () => {
    const mine = makeEndpoint();
    const theirs = makeEndpoint();
    link(mine, theirs);
    const { drill, hooks, lobby } = makeDrill('guest', mine);
    expect(drill.panel).toBeNull(); // match in progress: A/X opens the wrist menu

    theirs.sendEvent({ type: PacketType.REMATCH_REQUEST, epoch: 0, wants: false });
    expect(drill.panel).not.toBeNull();
    expect(drill.panel.isVisible()).toBe(true);
    expect(drill.panel.model.title).toBe('MATCH ENDED');
    expect(drill.panel.model.winner).toBeNull();
    expect(drill.panel.model.status).toBe('OPPONENT LEFT THE MATCH');

    mine._emit('disconnected', { state: 'closed' });
    await jest.runAllTimersAsync();
    expect(lobby.reconnect).not.toHaveBeenCalled();
    expect(hooks.endSession).not.toHaveBeenCalled();
    drill.dispose();
  });
});

describe('leaving', () => {
  test('dispose() tells the peer, then stops listening to the connection', () => {
    const mine = makeEndpoint();
    const theirs = makeEndpoint();
    link(mine, theirs);
    const { drill } = makeDrill('host', mine);
    expect(mine.listeners.eventMessage.length).toBe(1);

    drill.dispose();
    const last = mine.sent[mine.sent.length - 1];
    expect(last).toMatchObject({ type: PacketType.REMATCH_REQUEST, wants: false });
    expect(mine.listeners.eventMessage.length).toBe(0);
    expect(mine.listeners.gameMessage.length).toBe(0);
    expect(mine.listeners.congestion.length).toBe(0);
  });

  test('a disposed host drill no longer answers a GAME_READY with the finished score', () => {
    // Before the fix: the guest re-entering on the kept connection got the
    // OLD match's final score from the host's dead drill and saw the old card.
    const hostNm = makeEndpoint();
    const guestNm = makeEndpoint();
    link(hostNm, guestNm);
    const host = makeDrill('host', hostNm);
    guestNm.sendEvent({ type: PacketType.SCORE_UPDATE, match: finishedMatchSnapshot(), epoch: 0 });
    host.drill.dispose();
    hostNm.sent.length = 0;

    guestNm.sendEvent({ type: PacketType.GAME_READY, role: 'guest' });
    expect(hostNm.sent.filter((p) => p.type === PacketType.SCORE_UPDATE)).toHaveLength(0);
  });
});

describe('a real outage still reconnects (unchanged behaviour)', () => {
  test('a drop with no leave notice runs the reconnect watcher', async () => {
    const mine = makeEndpoint();
    const theirs = makeEndpoint();
    link(mine, theirs);
    const { drill, lobby } = makeDrill('guest', mine);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mine._emit('disconnected', { state: 'failed' });
    await Promise.resolve();
    expect(lobby.reconnect).toHaveBeenCalledTimes(1);
    drill.dispose();
    warn.mockRestore();
  });
});

describe('NetworkManager listener + open helpers', () => {
  test('off() removes only the given listener; removing during emit is safe', () => {
    const nm = new NetworkManager({ role: 'host', signaling: {}, lagSim: null });
    const calls = [];
    const a = () => { calls.push('a'); nm.off('eventMessage', a); };
    const b = () => calls.push('b');
    nm.on('eventMessage', a);
    nm.on('eventMessage', b);
    nm._emit('eventMessage', {});
    nm._emit('eventMessage', {});
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  test('isOpen() is false once torn down or the channel closed', async () => {
    const nm = new NetworkManager({ role: 'host', signaling: {}, lagSim: null });
    expect(nm.isOpen()).toBe(false);
    nm.eventChannel = { readyState: 'open', close: () => {} };
    expect(nm.isOpen()).toBe(true);
    nm.eventChannel.readyState = 'closed';
    expect(nm.isOpen()).toBe(false);
    nm.eventChannel.readyState = 'open';
    await nm.teardown();
    expect(nm.isOpen()).toBe(false);
  });

  test('flushEvents() waits for the queue to drain, or the timeout', async () => {
    const nm = new NetworkManager({ role: 'host', signaling: {}, lagSim: null });
    nm.eventChannel = { readyState: 'open', bufferedAmount: 100 };
    let done = false;
    nm.flushEvents(500).then(() => { done = true; });
    await jest.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    nm.eventChannel.bufferedAmount = 0;
    await jest.advanceTimersByTimeAsync(40);
    expect(done).toBe(true);

    nm.eventChannel.bufferedAmount = 100; // never drains
    let late = false;
    nm.flushEvents(200).then(() => { late = true; });
    await jest.advanceTimersByTimeAsync(260);
    expect(late).toBe(true);
  });
});
