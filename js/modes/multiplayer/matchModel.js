// Multiplayer match model — pure logic, no scene/physics imports.
//
// (createRallyTracker delegates to the shared ITTF rulebook in
// ../rallyRules.js, which is pure too — no scene singletons, geometry is
// injected.)
//
// Two pieces:
//
//   createMatchModel  — the shared score/serve state machine. Sides are named
//     ABSOLUTELY ('host' | 'guest'), the same on both peers, so a rally-end
//     verdict travels the wire without perspective inversion and both peers
//     run the identical deterministic transition. Rules mirror the AI match's
//     rallyManager: game to `firstTo` win-by-2, serve swaps every
//     `serveRotationEvery` points (every point at deuce). Single game per
//     session (no best-of yet).
//
//   createRallyTracker — per-rally bookkeeping in the LOCAL frame
//     ('self' | 'opponent'). Only the ball owner's tracker ever decides a
//     rally (the owner's sim saw the final flight with ground-truth physics);
//     the non-owner just mirrors hits so a mid-rally ownership flip lands on
//     a tracker that already knows who struck last. Verdicts follow
//     rallyManager's rules:
//       - ballLost after opponent's hit with no bounce on my side → their
//         shot went out → I win; with ≥1 bounce → I failed to return → they win
//       - two bounces on the receiver's side without a return → hitter wins
//       - net hit → the last hitter loses
//       - no hits yet (serve toss whiffed) → null: re-serve, no point

import { createRallyRules } from '../rallyRules.js';

export const MATCH_DEFAULTS = Object.freeze({
  firstTo: 11,
  deucePoint: 10,
  serveRotationEvery: 2,
  firstServer: 'host',
});

export function createMatchModel(cfgIn = {}) {
  const cfg = { ...MATCH_DEFAULTS, ...cfgIn };

  let scoreHost = 0;
  let scoreGuest = 0;
  let currentServer = cfg.firstServer;
  let pointsSinceSwitch = 0;
  let gameOver = false;
  let gameWinner = null;
  // Increments on EVERY rally end (including no-point re-serves). RALLY_END
  // wire messages carry the sender's pre-apply seq; a receiver only applies
  // when it matches its own, so duplicate / crossed verdicts are dropped.
  let rallySeq = 0;

  function getState() {
    return {
      scoreHost, scoreGuest, currentServer, pointsSinceSwitch,
      gameOver, gameWinner, rallySeq, firstTo: cfg.firstTo,
    };
  }

  // winner: 'host' | 'guest' | null (null = void rally, same server re-serves)
  function applyRallyEnd(winner) {
    if (gameOver) return getState();
    rallySeq += 1;
    if (winner !== 'host' && winner !== 'guest') return getState();

    if (winner === 'host') scoreHost += 1;
    else scoreGuest += 1;
    pointsSinceSwitch += 1;

    const top = Math.max(scoreHost, scoreGuest);
    const lead = Math.abs(scoreHost - scoreGuest);
    if (top >= cfg.firstTo && lead >= 2) {
      gameOver = true;
      gameWinner = scoreHost > scoreGuest ? 'host' : 'guest';
      return getState();
    }

    const isDeuce = scoreHost >= cfg.deucePoint && scoreGuest >= cfg.deucePoint;
    const swapAt = isDeuce ? 1 : cfg.serveRotationEvery;
    if (pointsSinceSwitch >= swapAt) {
      currentServer = currentServer === 'host' ? 'guest' : 'host';
      pointsSinceSwitch = 0;
    }
    return getState();
  }

  const serialize = getState;

  function restore(snap) {
    if (!snap) return;
    scoreHost = snap.scoreHost | 0;
    scoreGuest = snap.scoreGuest | 0;
    currentServer = snap.currentServer === 'guest' ? 'guest' : 'host';
    pointsSinceSwitch = snap.pointsSinceSwitch | 0;
    gameOver = !!snap.gameOver;
    gameWinner = snap.gameWinner === 'host' || snap.gameWinner === 'guest' ? snap.gameWinner : null;
    rallySeq = snap.rallySeq | 0;
  }

  return { applyRallyEnd, getState, serialize, restore };
}

// Per-rally verdicts, in the LOCAL frame ('self' | 'opponent').
//
// This is a thin adapter over the shared rulebook in ../rallyRules.js — the
// same engine the AI match runs. It used to be an independent (and quietly
// different) implementation: any net contact ended the point, which is not a
// rule, and there was no service-legality test, no let, no own-side-bounce
// rule and no obstruction test. A player who learned the game against the AI
// was playing a different sport online.
//
// Local frame convention (same as everywhere in this codebase): each peer's
// own side is z > tableCenterZ (their near edge is tableBox.max.z), which
// maps to the engine's `near` side.
//
// Every register* call returns a verdict — `null`, `{ let: true }`, or
// `{ winner, reason, detail, foul }` — rather than the bare winner string the
// old tracker returned, because the caller now needs to announce WHY.
export function createRallyTracker({
  tableCenterZ = 0,
  tableBox = null,
  getGeometry = null,
  tableSurfaceY = 0,
  gravity = -9.81,
  now = undefined,
} = {}) {
  const rules = createRallyRules({
    near: 'self',
    far: 'opponent',
    // Callers with a live scene pass getGeometry so tableBox/gravity are read
    // fresh each event; the static fields are the headless-test path.
    getGeometry: getGeometry || (() => ({ tableBox, tableSurfaceY, centerZ: tableCenterZ, gravity })),
    ...(now ? { now } : {}),
  });

  // `server` is 'self' | 'opponent' | null — the serve rules stand down when
  // the caller doesn't know (a rally restored mid-flight after a reconnect).
  function reset({ server = null } = {}) {
    rules.beginRally({ server });
  }

  return {
    reset,
    registerHit: (side, contact) => rules.registerHit(side === 'opponent' ? 'opponent' : 'self', contact),
    registerBounce: (z, x = 0) => rules.registerBounce({ x, z }),
    registerNetHit: () => rules.registerNetHit(),
    registerNetTouch: (side) => rules.registerNetTouch(side),
    decideBallLost: () => rules.registerBallLost(),
    isActive: rules.isActive,
    getLastHitter: rules.getLastHitter,
  };
}
