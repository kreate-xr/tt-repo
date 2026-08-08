// Rally manager + ITTF scoring. V2 spec §section_6.
//
// Subscribes to the existing ball-event listeners in js/physics/ball.js
// (paddleHit, tableBounce, netHit, ballLost) and runs a tiny state machine
// per rally to figure out who won the point. Then awards the point, rotates
// the serve, checks for game/match end, and triggers the next serve (AI via
// the serve subsystem, player via a courtesy ball-spawn on their side).
//
// Spec §section_6.rally_end_conditions maps to the rules below:
//   - Two consecutive table bounces on the same side without a paddle hit
//     in between = the side that DIDN'T return loses the point.
//   - onNetHit = the player who just hit it INTO the net loses the point.
//   - onBallLost with no bounce on the opponent's side after the hitter's
//     contact = hitter's shot went out/short, hitter loses.
//   - onBallLost AFTER a bounce on the opponent's side = opponent failed
//     to return, opponent loses.
//
// "Persistent state across rallies" (spec): shot history + heatmap live in
// the worker; this module only tracks current-game / current-match score
// and the per-rally bounce bookkeeping.

import * as THREE from 'three';
import { spawnBallAt } from '../../physics/ball.js';
import { tableBox, tableSurfaceY, ballModel } from '../../scene/models.js';
import { hudLog } from '../../scene/hud.js';

// AI paddle id from physics — string-matched against paddleHit.origin.
const AI_PADDLE_ORIGIN = 'ai-opponent';

// Default match format (spec §section_6.scoring_rules_ittf_simplified).
const DEFAULT_CONFIG = Object.freeze({
  bestOf: 5,           // games per match
  firstTo: 11,         // points to win a game
  deucePoint: 10,      // at 10-10 deuce, serve swaps every point
  serveRotationEvery: 2, // points between serve swaps (becomes 1 at deuce)
});

// Inter-rally delay before triggering next serve. Long enough for the
// between-point "READY" indicator (js/scene/serveIndicator.js) to fade in,
// let the player read who's serving next, and fade out again without feeling
// rushed. Was 1200ms — too short to breathe.
const NEXT_SERVE_DELAY_MS = 2500;

export function createRallyManager({
  ballEvents,
  server,
  playerServe = null,
  config: cfgIn = {},
  rng = Math.random,
} = {}) {
  const config = { ...DEFAULT_CONFIG, ...cfgIn };

  // --- Match / game / rally state ----------------------------------------
  let aiScore = 0, playerScore = 0;
  let aiGames = 0, playerGames = 0;
  // Initial server choice: spec doesn't pin, default AI. Alternates between
  // games per ITTF rules.
  let currentServer = 'ai';
  let pointsSinceServerSwitch = 0;
  let matchOver = false;
  let initialServerForGame = currentServer;

  // Per-rally bookkeeping.
  let rallyInProgress = false;
  let lastHitter = null;          // 'ai' | 'player' | null
  let aiSideBounces = 0;
  let playerSideBounces = 0;
  let waitingForServeStrike = false; // player-serve: ball spawned, no paddle yet
  // Per-rally paddle-hit counters. Used to detect "return of serve" — the
  // first time the receiver strikes the ball in a rally after the server's
  // serve. AI's return of serve should use specialized weights
  // (push/block/flip, no loops/smashes).
  let aiHitsThisRally = 0;
  let playerHitsThisRally = 0;

  let nextServeTimer = null;

  // External event subscribers.
  const listeners = {
    onPointScored: [],
    onGameEnd: [],
    onMatchEnd: [],
    onServerChange: [],
    onServeRequested: [], // emitted when next-serve fires (UI hooks)
  };
  function on(eventName, fn) { if (listeners[eventName]) listeners[eventName].push(fn); }
  function emit(eventName, payload) {
    const arr = listeners[eventName];
    if (!arr) return;
    for (const fn of arr) fn(payload);
  }

  function tableCenterZ() {
    return tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0;
  }

  function resetRallyState() {
    rallyInProgress = false;
    lastHitter = null;
    aiSideBounces = 0;
    playerSideBounces = 0;
    waitingForServeStrike = false;
    aiHitsThisRally = 0;
    playerHitsThisRally = 0;
  }

  // --- Ball event handlers -----------------------------------------------

  function onPaddleHitInternal(info) {
    if (!info || matchOver) return;
    const origin = info.origin === 'player' ? 'player'
                 : info.origin === AI_PADDLE_ORIGIN ? 'ai' : null;
    if (!origin) return;
    lastHitter = origin;
    waitingForServeStrike = false;
    rallyInProgress = true;
    // Reset the count on the side the ball is heading to.
    if (origin === 'player') {
      aiSideBounces = 0;
      playerHitsThisRally += 1;
    } else {
      playerSideBounces = 0;
      aiHitsThisRally += 1;
    }
  }

  function onTableBounceInternal(info) {
    if (!info || matchOver || !rallyInProgress) return;
    const onAISide = info.z < tableCenterZ();
    if (onAISide) {
      aiSideBounces += 1;
    } else {
      playerSideBounces += 1;
    }
    // Two bounces on the same side without an intervening paddle hit from
    // that side = miss by the receiver on that side.
    if (lastHitter === 'player' && aiSideBounces >= 2) {
      finishRally('player', 'doubleBounce');
    } else if (lastHitter === 'ai' && playerSideBounces >= 2) {
      finishRally('ai', 'doubleBounce');
    }
  }

  function onNetHitInternal(/* info */) {
    if (matchOver || !rallyInProgress) return;
    // Net hit = the side that hit it loses the point. lastHitter loses.
    if (lastHitter) {
      finishRally(lastHitter === 'player' ? 'ai' : 'player', 'netHit');
    }
  }

  function onBallLostInternal(/* info */) {
    if (matchOver) return;
    if (waitingForServeStrike) {
      // Player-serve courtesy ball was lost before player struck. Just
      // re-spawn after delay; no point assigned.
      waitingForServeStrike = false;
      scheduleNextServe();
      return;
    }
    if (!rallyInProgress) return;
    let winner;
    if (lastHitter === 'player') {
      // Player hit toward AI. If AI never bounced (0) the player's shot
      // went out → AI wins. Otherwise AI bounced ≥1 and then ball lost
      // before AI returned → AI failed → player wins.
      winner = aiSideBounces === 0 ? 'ai' : 'player';
    } else if (lastHitter === 'ai') {
      winner = playerSideBounces === 0 ? 'player' : 'ai';
    } else {
      // No one hit (e.g., AI's serve toss never connected). Default the
      // point to the receiver.
      winner = currentServer === 'ai' ? 'player' : 'ai';
    }
    finishRally(winner, 'ballLost');
  }

  // --- Scoring ------------------------------------------------------------

  function finishRally(winner, reason) {
    // Strict re-entry guard: every ball-event handler already checks
    // rallyInProgress before calling us, so entering with it already false
    // means either a stale event slipped through or something re-entered
    // finishRally itself. Either way we must not increment again.
    if (!rallyInProgress) {
      hudLog(`[SCORE-DBG] finishRally BLOCKED reason=${reason} winner=${winner} lastHitter=${lastHitter} wait=${waitingForServeStrike} aiB=${aiSideBounces} pB=${playerSideBounces}`);
      return;
    }
    hudLog(`[SCORE-DBG] finishRally reason=${reason} winner=${winner} lastHitter=${lastHitter} aiB=${aiSideBounces} pB=${playerSideBounces} before P${playerScore}-AI${aiScore}`);
    rallyInProgress = false;
    if (winner === 'ai') aiScore += 1;
    else playerScore += 1;
    pointsSinceServerSwitch += 1;

    emit('onPointScored', { winner, reason, aiScore, playerScore });

    // Game-end check: leader at or above firstTo with ≥2-point lead.
    const lead = Math.abs(aiScore - playerScore);
    const top = Math.max(aiScore, playerScore);
    if (top >= config.firstTo && lead >= 2) {
      const gameWinner = aiScore > playerScore ? 'ai' : 'player';
      if (gameWinner === 'ai') aiGames += 1;
      else playerGames += 1;
      emit('onGameEnd', { winner: gameWinner, aiGames, playerGames });

      // Match-end check.
      const gamesNeeded = Math.floor(config.bestOf / 2) + 1;
      if (aiGames >= gamesNeeded || playerGames >= gamesNeeded) {
        matchOver = true;
        emit('onMatchEnd', {
          winner: aiGames > playerGames ? 'ai' : 'player',
          aiGames, playerGames,
        });
        return;
      }

      // Reset for next game; first server alternates between games.
      aiScore = 0; playerScore = 0;
      pointsSinceServerSwitch = 0;
      currentServer = initialServerForGame === 'ai' ? 'player' : 'ai';
      initialServerForGame = currentServer;
      emit('onServerChange', { currentServer });
      scheduleNextServe();
      return;
    }

    // Serve rotation. At deuce (both sides ≥ deucePoint) swap every 1
    // point; otherwise swap every `serveRotationEvery` points.
    const isDeuce = aiScore >= config.deucePoint && playerScore >= config.deucePoint;
    const swapAt = isDeuce ? 1 : config.serveRotationEvery;
    if (pointsSinceServerSwitch >= swapAt) {
      currentServer = currentServer === 'ai' ? 'player' : 'ai';
      pointsSinceServerSwitch = 0;
      emit('onServerChange', { currentServer });
    }

    scheduleNextServe();
  }

  // --- Next serve ---------------------------------------------------------

  function scheduleNextServe() {
    if (matchOver) return;
    if (nextServeTimer) {
      clearTimeout(nextServeTimer);
      nextServeTimer = null;
    }
    nextServeTimer = setTimeout(() => {
      nextServeTimer = null;
      triggerNextServe();
    }, NEXT_SERVE_DELAY_MS);
  }

  // Pressure context for the AI's serve archetype selection. Deuce raises
  // pressure; game point (server one point from taking the game) raises it;
  // match point (in a deciding game, server one from winning the match)
  // is critical.
  function buildGameContext() {
    const serverScore = currentServer === 'ai' ? aiScore : playerScore;
    const opponentScore = currentServer === 'ai' ? playerScore : aiScore;
    const isDeuce = aiScore >= config.deucePoint && playerScore >= config.deucePoint;
    // Game point: serverScore already at firstTo - 1 AND has 2-point lead
    // over opponent (otherwise it's just approaching-deuce, not game point).
    const isGamePoint = serverScore >= config.firstTo - 1 && (serverScore - opponentScore) >= 1;
    // Match point: game point AND winning it would clinch the match.
    const gamesNeeded = Math.floor(config.bestOf / 2) + 1;
    const serverGames = currentServer === 'ai' ? aiGames : playerGames;
    const isMatchPoint = isGamePoint && (serverGames + 1 >= gamesNeeded);
    return {
      isDeuce, isGamePoint, isMatchPoint,
      servingSideScore: serverScore, opponentScore,
    };
  }

  function triggerNextServe() {
    if (matchOver) return;
    resetRallyState();
    emit('onServeRequested', { server: currentServer });
    if (currentServer === 'ai') {
      if (server && server.startServe && server.isFinished && server.isFinished()) {
        // AI serves via spawnBallAt (no paddle collision → no onPaddleHit
        // fires), so the rally would otherwise stay rallyInProgress=false
        // and lastHitter=null forever. Under that state a player miss
        // early-returns from onTableBounce / onBallLost — no point is
        // scored, no next serve scheduled, match freezes. Synthesize the
        // "AI just struck it" state here so a missed AI serve resolves.
        lastHitter = 'ai';
        rallyInProgress = true;
        aiSideBounces = 0;
        playerSideBounces = 0;
        server.startServe({ gameContext: buildGameContext() });
      }
    } else {
      // Player serves. Prefer the trigger-armed controller so the player
      // decides when the ball appears (auto-toss surprised players — no
      // idea when to expect the ball). The controller waits for a trigger
      // pull, then spawns via its own launch() → spawnBallAt path. Fall
      // back to inline auto-toss only when no controller was provided
      // (headless tests, older callers).
      if (playerServe && typeof playerServe.arm === 'function') {
        playerServe.arm();
        // Set the wait flag now so a stray ballLost between arm() and
        // launch() re-schedules gracefully instead of scoring. In practice
        // no ball exists during this window so ballLost shouldn't fire —
        // but if it does, the courtesy path handles it.
        waitingForServeStrike = true;
      } else {
        spawnPlayerServeBall();
        waitingForServeStrike = true;
      }
    }
  }

  function spawnPlayerServeBall() {
    if (!tableBox || !ballModel) return;
    const x = (tableBox.min.x + tableBox.max.x) / 2;
    const y = (tableSurfaceY || 0) + 0.30;
    const z = tableBox.max.z - 0.05;
    spawnBallAt(
      new THREE.Vector3(x, y, z),
      // Toss upward with a taller arc so the player clearly sees it rise
      // before striking. Slight inward z so the ball stays over the player's
      // half rather than drifting off the near edge.
      new THREE.Vector3((Math.random() - 0.5) * 0.2, 2.0, -0.4),
      new THREE.Vector3(0, 0, 0),
    );
  }

  // --- Public API ---------------------------------------------------------

  function start() {
    scheduleNextServe();
  }

  function dispose() {
    if (nextServeTimer) {
      clearTimeout(nextServeTimer);
      nextServeTimer = null;
    }
    // Unsubscribe ball events so a re-created rally manager doesn't score in
    // parallel with the previous one. Function declaration below is hoisted,
    // so calling it before its textual definition is fine.
    unsubscribeBallEvents();
    listeners.onPointScored.length = 0;
    listeners.onGameEnd.length = 0;
    listeners.onMatchEnd.length = 0;
    listeners.onServerChange.length = 0;
    listeners.onServeRequested.length = 0;
  }

  function getScore() {
    return {
      aiScore, playerScore, aiGames, playerGames,
      currentServer, pointsSinceServerSwitch, matchOver,
    };
  }

  // True when the AI's NEXT strike will be its return-of-serve — i.e.
  // the player is the server for this point, they've just hit (their
  // serve), and the AI has not yet contacted the ball this rally.
  // Consumed by aiMatch to pass isServeReturn=true into the target
  // request context so the engine uses SERVE_RETURN_WEIGHTS.
  function isAINextShotServeReturn() {
    return currentServer === 'player'
        && rallyInProgress
        && lastHitter === 'player'
        && aiHitsThisRally === 0
        && playerHitsThisRally === 1;
  }

  function setConfig(c) {
    if (typeof c.bestOf === 'number') config.bestOf = c.bestOf;
    if (typeof c.firstTo === 'number') config.firstTo = c.firstTo;
    if (typeof c.deucePoint === 'number') config.deucePoint = c.deucePoint;
    if (typeof c.serveRotationEvery === 'number') config.serveRotationEvery = c.serveRotationEvery;
  }

  // Instance tag — makes it visible in the log if two rally managers are ever
  // alive at once (subscription-leak diagnostic).
  const instanceTag = Math.random().toString(36).slice(2, 6);

  // Wrap each handler so the log records who fired. If two rally managers are
  // live simultaneously (dispose didn't clean up), we'll see two distinct
  // instanceTag prefixes for the same underlying ball event.
  function tagged(name, fn) {
    return (info) => {
      hudLog(`[SCORE-DBG ${instanceTag}] ${name}`);
      fn(info);
    };
  }
  const onPaddleHitBound  = tagged('paddleHit',  onPaddleHitInternal);
  const onTableBounceBound = tagged('tableBounce', onTableBounceInternal);
  const onNetHitBound     = tagged('netHit',     onNetHitInternal);
  const onBallLostBound   = tagged('ballLost',   onBallLostInternal);

  // Subscribe to ball events. ballEvents follows the shotAdapter pattern —
  // each onX(fn) registers a listener.
  ballEvents.onPaddleHit(onPaddleHitBound);
  ballEvents.onTableBounce(onTableBounceBound);
  ballEvents.onNetHit(onNetHitBound);
  ballEvents.onBallLost(onBallLostBound);
  hudLog(`[SCORE-DBG ${instanceTag}] rally manager SUBSCRIBED`);

  function unsubscribeBallEvents() {
    // ballEvents may be built without off* (older callers). Skip cleanly.
    if (ballEvents.offPaddleHit)   ballEvents.offPaddleHit(onPaddleHitBound);
    if (ballEvents.offTableBounce) ballEvents.offTableBounce(onTableBounceBound);
    if (ballEvents.offNetHit)      ballEvents.offNetHit(onNetHitBound);
    if (ballEvents.offBallLost)    ballEvents.offBallLost(onBallLostBound);
    hudLog(`[SCORE-DBG ${instanceTag}] rally manager UNSUBSCRIBED`);
  }

  return { start, dispose, on, getScore, setConfig, isAINextShotServeReturn };
}
