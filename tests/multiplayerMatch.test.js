// Unit tests for the multiplayer match model + rally tracker
// (js/modes/multiplayer/matchModel.js). Pure logic — no scene/physics mocks.

import { createMatchModel, createRallyTracker, MATCH_DEFAULTS } from '../js/modes/multiplayer/matchModel.js';

describe('createMatchModel', () => {
  test('host serves first by default', () => {
    const m = createMatchModel();
    expect(m.getState().currentServer).toBe('host');
    expect(m.getState().scoreHost).toBe(0);
    expect(m.getState().scoreGuest).toBe(0);
  });

  test('serve rotates every 2 points', () => {
    const m = createMatchModel();
    m.applyRallyEnd('host');
    expect(m.getState().currentServer).toBe('host');
    m.applyRallyEnd('guest');
    expect(m.getState().currentServer).toBe('guest'); // 2 points played → swap
    m.applyRallyEnd('host');
    m.applyRallyEnd('host');
    expect(m.getState().currentServer).toBe('host'); // 4 points → swap back
  });

  test('null winner voids the rally: no score, no rotation, seq still advances', () => {
    const m = createMatchModel();
    const before = m.getState();
    const after = m.applyRallyEnd(null);
    expect(after.scoreHost).toBe(before.scoreHost);
    expect(after.scoreGuest).toBe(before.scoreGuest);
    expect(after.currentServer).toBe(before.currentServer);
    expect(after.pointsSinceSwitch).toBe(before.pointsSinceSwitch);
    expect(after.rallySeq).toBe(before.rallySeq + 1);
  });

  test('game ends at 11 with a 2-point lead', () => {
    const m = createMatchModel();
    for (let i = 0; i < 10; i++) m.applyRallyEnd('host');
    for (let i = 0; i < 5; i++) m.applyRallyEnd('guest');
    expect(m.getState().gameOver).toBe(false);
    m.applyRallyEnd('host'); // 11-5
    const s = m.getState();
    expect(s.gameOver).toBe(true);
    expect(s.gameWinner).toBe('host');
    expect(s.scoreHost).toBe(11);
  });

  test('no game end at 11-10; deuce swaps serve every point', () => {
    const m = createMatchModel();
    for (let i = 0; i < 10; i++) { m.applyRallyEnd('host'); m.applyRallyEnd('guest'); }
    // 10-10 deuce
    expect(m.getState().gameOver).toBe(false);
    const serverAtDeuce = m.getState().currentServer;
    m.applyRallyEnd('host'); // 11-10 — not over (needs 2-point lead)
    expect(m.getState().gameOver).toBe(false);
    expect(m.getState().currentServer).not.toBe(serverAtDeuce); // deuce: swap every point
    m.applyRallyEnd('host'); // 12-10 — over
    expect(m.getState().gameOver).toBe(true);
    expect(m.getState().gameWinner).toBe('host');
  });

  test('scoring is frozen after game over', () => {
    const m = createMatchModel({ firstTo: 2, deucePoint: 99 });
    m.applyRallyEnd('guest');
    m.applyRallyEnd('guest'); // 0-2, game over
    const seq = m.getState().rallySeq;
    const s = m.applyRallyEnd('host');
    expect(s.scoreHost).toBe(0);
    expect(s.rallySeq).toBe(seq); // no seq advance either — match is closed
  });

  test('serialize/restore round-trips absolute state', () => {
    const m = createMatchModel();
    m.applyRallyEnd('host');
    m.applyRallyEnd('guest');
    m.applyRallyEnd(null);
    const snap = m.serialize();
    const m2 = createMatchModel();
    m2.restore(snap);
    expect(m2.getState()).toEqual(m.getState());
  });

  test('crossed verdicts dedupe via rallySeq check (receiver pattern)', () => {
    // Both peers decide rally seq=0; each applies its own then receives the
    // other's message stamped seq=0 — which no longer matches and is dropped.
    const m = createMatchModel();
    const incoming = { seq: 0, winner: 'host' };
    m.applyRallyEnd('host'); // local apply → rallySeq now 1
    if (incoming.seq === m.getState().rallySeq) m.applyRallyEnd(incoming.winner);
    expect(m.getState().scoreHost).toBe(1); // not double-counted
  });

  test('defaults match ITTF-simplified config', () => {
    expect(MATCH_DEFAULTS.firstTo).toBe(11);
    expect(MATCH_DEFAULTS.deucePoint).toBe(10);
    expect(MATCH_DEFAULTS.serveRotationEvery).toBe(2);
  });
});

describe('createRallyTracker', () => {
  // Local frame: own side is z > tableCenterZ (0 here). The tracker delegates
  // to the shared ITTF rulebook (js/modes/rallyRules.js) — the same engine the
  // AI match runs — so verdicts are objects: the caller needs the reason and
  // the offending side, not just a winner.
  const OWN_Z = 0.5, OPP_Z = -0.5;
  // Real table geometry, so the projection-based obstruction test has
  // something to work with. Own side is +Z.
  const GEO = {
    tableBox: {
      min: { x: -0.7625, y: -0.01, z: -1.37 },
      max: { x: 0.7625, y: 0.01, z: 1.37 },
    },
    tableSurfaceY: 0,
    centerZ: 0,
    gravity: -9.81,
  };
  const make = (opts = {}) => createRallyTracker({ tableCenterZ: 0, ...opts });
  const winnerOf = (v) => (v ? v.winner : null);

  test('inactive until a hit registers; bounces before that are ignored', () => {
    const t = make();
    expect(t.isActive()).toBe(false);
    expect(t.registerBounce(OWN_Z)).toBeNull();
    expect(t.decideBallLost()).toBeNull(); // no hits → void rally (toss whiff)
  });

  test('opponent hit, no bounce on my side, ball lost → I win (their shot went out)', () => {
    const t = make();
    t.registerHit('opponent');
    const v = t.decideBallLost();
    expect(v.winner).toBe('self');
    expect(v.detail).toBe('out');
  });

  test('opponent hit, bounced on my side, ball lost → opponent wins (I failed to return)', () => {
    const t = make();
    t.registerHit('opponent');
    t.registerBounce(OWN_Z);
    const v = t.decideBallLost();
    expect(v.winner).toBe('opponent');
    expect(v.detail).toBe('missedReturn');
  });

  test('my hit, no bounce on opponent side, ball lost → opponent wins', () => {
    const t = make();
    t.registerHit('self');
    expect(winnerOf(t.decideBallLost())).toBe('opponent');
  });

  test('my hit, bounced on opponent side, ball lost → I win', () => {
    const t = make();
    t.registerHit('self');
    t.registerBounce(OPP_Z);
    expect(winnerOf(t.decideBallLost())).toBe('self');
  });

  test('double bounce on my side after opponent hit → opponent wins immediately', () => {
    const t = make();
    t.registerHit('opponent');
    expect(t.registerBounce(OWN_Z)).toBeNull();
    const v = t.registerBounce(OWN_Z);
    expect(v.winner).toBe('opponent');
    expect(v.reason).toBe('doubleBounce');
  });

  test('serve: own-side bounce then opponent-side bounce keeps rally alive', () => {
    const t = make();
    t.reset({ server: 'self' });
    t.registerHit('self'); // my serve strike
    expect(t.registerBounce(OWN_Z)).toBeNull(); // legal serve bounce, my side
    expect(t.registerBounce(OPP_Z)).toBeNull(); // over the net
    // Opponent returns — counts reset.
    t.registerHit('opponent');
    expect(t.registerBounce(OWN_Z)).toBeNull();
    expect(winnerOf(t.decideBallLost())).toBe('opponent'); // I let their return drop
  });

  test('a net contact does NOT end the rally', () => {
    // The old tracker scored "last hitter loses" on any net hit. That is not
    // an ITTF rule, and it contradicted the AI match: a cord ball can dribble
    // over and play on, and where it comes down decides.
    const t = make();
    t.reset({ server: 'self' });
    t.registerHit('self');
    expect(t.registerNetHit()).toBeNull();
    expect(t.isActive()).toBe(true);
  });

  test('a cord serve that still lands good is a let', () => {
    const t = make();
    t.reset({ server: 'self' });
    t.registerHit('self');
    t.registerBounce(OWN_Z);
    t.registerNetHit();
    expect(t.registerBounce(OPP_Z)).toEqual({ let: true });
  });

  test('a serve that misses my own half first is a fault', () => {
    const t = make();
    t.reset({ server: 'self' });
    t.registerHit('self');
    const v = t.registerBounce(OPP_Z); // straight into their court
    expect(v.winner).toBe('opponent');
    expect(v.reason).toBe('serveFault');
  });

  test('a return that lands on my own half loses the point', () => {
    const t = make();
    t.reset({ server: 'opponent' });
    t.registerHit('opponent');
    t.registerBounce(OWN_Z);
    t.registerHit('self');             // my return
    const v = t.registerBounce(OWN_Z); // …which never crossed the net
    expect(v.winner).toBe('opponent');
    expect(v.reason).toBe('ownSideBounce');
  });

  test('volleying the opponent ball before it bounces loses the point', () => {
    const t = make({ getGeometry: () => GEO });
    t.reset({ server: 'opponent' });
    t.registerHit('opponent');
    const v = t.registerHit('self', {
      contactPos: { x: 0, y: 0.4, z: 0.5 },
      inVel: { x: 0, y: -1, z: 2 },      // dropping into my court
    });
    expect(v.winner).toBe('opponent');
    expect(v.reason).toBe('illegalVolley');
    expect(v.foul).toBe('self');
  });

  test('swatting a ball that was already going long wins the point', () => {
    const t = make({ getGeometry: () => GEO });
    t.reset({ server: 'opponent' });
    t.registerHit('opponent');
    const v = t.registerHit('self', {
      contactPos: { x: 0, y: 0.4, z: 0.5 },
      inVel: { x: 0, y: -1, z: 6 },      // clears my end line first
    });
    expect(v.winner).toBe('self');
    expect(v.reason).toBe('ballOut');
    expect(v.foul).toBeNull();
  });

  test('serving from out over the table is a fault', () => {
    const t = make({ getGeometry: () => GEO });
    t.reset({ server: 'self' });
    const v = t.registerHit('self', {
      contactPos: { x: 0, y: 0.35, z: 0.8 }, // well inside my end line
      inVel: { x: 0, y: -1, z: 0 },
    });
    expect(v.winner).toBe('opponent');
    expect(v.reason).toBe('serveFault');
    expect(v.detail).toBe('overTable');
  });

  test('touching the net assembly loses the point', () => {
    const t = make();
    t.reset({ server: 'self' });
    t.registerHit('self');
    const v = t.registerNetTouch('self');
    expect(v.winner).toBe('opponent');
    expect(v.reason).toBe('netTouch');
    expect(v.foul).toBe('self');
    // Not judgeable when no rally is running.
    t.reset();
    expect(t.registerNetTouch('self')).toBeNull();
  });

  test('striking twice in a row is a double hit', () => {
    let clock = 0;
    const t = make({ now: () => clock });
    t.reset({ server: 'opponent' });
    t.registerHit('opponent');
    t.registerBounce(OWN_Z);
    clock = 1000;
    expect(t.registerHit('self')).toBeNull();
    clock = 1400;                       // a genuine second stroke
    const v = t.registerHit('self');
    expect(v.reason).toBe('doubleHit');
    expect(v.foul).toBe('self');
  });

  test('a re-contact inside one stroke is not a double hit', () => {
    // The physics can register a single intended swing twice; only a real
    // second stroke counts. See DOUBLE_HIT_MIN_GAP_MS.
    let clock = 0;
    const t = make({ now: () => clock });
    t.reset({ server: 'opponent' });
    t.registerHit('opponent');
    t.registerBounce(OWN_Z);
    clock = 1000;
    t.registerHit('self');
    clock = 1060;                       // 60ms later — same swing
    expect(t.registerHit('self')).toBeNull();
  });

  test('reset clears the rally', () => {
    const t = make();
    t.registerHit('self');
    t.reset();
    expect(t.isActive()).toBe(false);
    expect(t.getLastHitter()).toBeNull();
    expect(t.registerNetTouch('self')).toBeNull();
  });
});

describe('createRallyTracker — what a peer can honestly judge', () => {
  const OWN_Z = 0.5, OPP_Z = -0.5;

  test('assumeServeBounced stops a late handoff faulting a legal serve', () => {
    // The receiving peer only starts integrating the ball when the handoff
    // lands. On a slow link that can be AFTER the server's own-half bounce,
    // so the first bounce it ever sees is on its own half — indistinguishable
    // from a serve that skipped the server's half entirely.
    const t = createRallyTracker({ tableCenterZ: 0 });
    t.reset({ server: 'opponent' });
    t.registerHit('opponent', { assumeServeBounced: true });
    expect(t.registerBounce(OWN_Z)).toBeNull(); // plays on, no phantom fault
  });

  test('without that credit the same sequence is a serve fault', () => {
    // Which is the correct call when we DID watch the whole flight — this is
    // the AI match's path, where one sim sees everything.
    const t = createRallyTracker({ tableCenterZ: 0 });
    t.reset({ server: 'opponent' });
    t.registerHit('opponent');
    const v = t.registerBounce(OWN_Z);
    expect(v.reason).toBe('serveFault');
    expect(v.winner).toBe('self');
  });

  test('a credited serve can still be a let', () => {
    const t = createRallyTracker({ tableCenterZ: 0 });
    t.reset({ server: 'opponent' });
    t.registerHit('opponent', { assumeServeBounced: true });
    t.registerNetHit();
    expect(t.registerBounce(OWN_Z)).toEqual({ let: true });
  });
});
