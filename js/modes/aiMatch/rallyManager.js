// Rally manager + ITTF scoring. V2 spec §section_6.
//
// Subscribes to the existing ball-event listeners in js/physics/ball.js
// (paddleHit, tableBounce, netHit, ballLost) and runs a tiny state machine
// per rally to figure out who won the point. Then awards the point, rotates
// the serve, checks for game/match end, and triggers the next serve (AI via
// the serve subsystem, player via a courtesy ball-spawn on their side).
//
// THE RULES THEMSELVES LIVE IN ../rallyRules.js, shared with multiplayer so
// the two modes can't drift apart (they had: multiplayer used to end the point
// on any net contact, and had no service-legality test at all). This module
// feeds ball events in and turns the verdicts that come back into score.
// Everything below documents what that engine decides on our behalf.
//
// Spec §section_6.rally_end_conditions maps to the rules below:
//   - Two consecutive table bounces on the same side without a paddle hit
//     in between = the side that DIDN'T return loses the point.
//   - A rally return that touches the hitter's OWN half = hitter loses
//     immediately (ITTF: a return must land directly in the opponent's court).
//   - onBallLost with no bounce on the opponent's side after the hitter's
//     contact = hitter's shot went out/short, hitter loses.
//   - onBallLost AFTER a bounce on the opponent's side = opponent failed
//     to return, opponent loses.
//
// Two further ITTF faults are decided at CONTACT time rather than by where
// the ball lands, so they can't come from the bounce bookkeeping above. Both
// are judged by the pure geometry in ittfFaults.js:
//   - Obstruction (volley): striking the ball before it has bounced on your
//     own half, while it was genuinely heading for your court. Point to the
//     opponent. A ball already sailing past the end line is NOT obstruction —
//     that shot was out, so the point goes to the striker instead.
//   - Service position: the serve must be struck from behind the server's end
//     line and above the level of the playing surface. Point to the receiver.
//
// Serve legality (ITTF): the server's first stroke of the rally must bounce
// once on the server's own half, then land on the receiver's half. A serve
// that lands directly on the receiver's half, or dies on the server's half,
// is a serveFault — point to the receiver. A serve that touches the net and
// STILL arrives legally is a let: no point, same server replays.
//
// Net touches do not end the rally by themselves: ball.js models the
// top-cord hit preserving horizontal drift, so a cord ball can genuinely
// dribble over and play on (legal in a rally). Where the ball comes down
// after the touch decides the point via the bounce rules above.
//
// "Persistent state across rallies" (spec): shot history + heatmap live in
// the worker; this module only tracks current-game / current-match score
// and the per-rally bounce bookkeeping.

import * as THREE from 'three';
import { spawnBallAt, despawnBall } from '../../physics/ball.js';
import { tableBox, tableSurfaceY, ballModel } from '../../scene/models.js';
import { GRAVITY, BALL_FADE_OUT_MS } from '../../physics/constants.js';
import { hudLog } from '../../scene/hud.js';
import { createRallyRules } from '../rallyRules.js';

// AI paddle id from physics — string-matched against paddleHit.origin.
const AI_PADDLE_ORIGIN = 'ai-opponent';

// Default match format (spec §section_6.scoring_rules_ittf_simplified).
const DEFAULT_CONFIG = Object.freeze({
  bestOf: 5,           // games per match
  firstTo: 11,         // points to win a game
  deucePoint: 10,      // at 10-10 deuce, serve swaps every point
  serveRotationEvery: 2, // points between serve swaps (becomes 1 at deuce)
  firstServer: 'ai',   // 'ai' | 'player' — the caller's serve toss
  // ITTF 2.6.2 enforcement — the physical toss must rise ≥16 cm. Off by
  // default (casual play coaches via HUD instead); a strict/competitive
  // mode turns it on and gets the umpire's ladder: one warning per match,
  // fault thereafter.
  strictToss: false,
  // ITTF 2.9.1.2 — a let when the receiver is not ready. Supplied by the
  // caller because readiness is a scene question, not a rules one: give it a
  // predicate returning false while the receiver can't play the serve, and
  // the AI's serve waits instead of being struck into an empty half. Null
  // (the default, and every headless test) means "always ready".
  isReceiverReady: null,
});

// Inter-rally delay before triggering next serve. Long enough for the
// player to register the point (over-net burst, scoreboard update) and see
// who serves next without feeling rushed. Was 1200ms — too short to breathe.
const NEXT_SERVE_DELAY_MS = 2500;

// Once a point (or let) is decided, the old ball is FORCED off the table
// after this beat. This is a backstop, not the normal exit: the decided
// point's ball is left alone to finish what it was doing — drop off the
// edge, bounce out on the floor, dribble down off the net cord — and the
// dead-ball damping in the physics layer (DEAD_BALL_COR_SCALE) settles it in
// a few hops, at which point it retires itself through the stuck-ball path
// and this timer finds nothing to do.
//
// Was 700 ms, which was shorter than the ending it was supposed to let the
// player watch: the ball blinked out mid-bounce or mid-arc off the table,
// then the table sat empty for the remaining 1.8 s of the serve delay. The
// deciding event is exactly the thing you want to see play out, and on a net
// cord or a double bounce it is still in motion at 700 ms.
//
// Sized against NEXT_SERVE_DELAY_MS: this plus the ball's fade must finish
// before the next serve, so the table is always clear when it arrives.
const POINT_END_DESPAWN_MS = 2000;

// Receiver-readiness poll, and the cap on how long the serve will wait.
//
// On a flat screen the receiver is always ready, which is why no version of
// this game needed the rule. In a headset they may be recentring, stepping
// back into the box, or holding a controller that dropped tracking for a
// few hundred milliseconds — and the fixed NEXT_SERVE_DELAY_MS timer serves
// into all three and takes the point. Only the AI's serve needs this; the
// player's own waits on their trigger pull by construction.
//
// The cap matters as much as the rule: a controller that never comes back
// must not freeze the match. Missing a let is a far smaller failure than a
// match that never resumes, so after the cap we serve anyway and say so.
const RECEIVER_READY_POLL_MS = 150;
const RECEIVER_READY_MAX_HOLD_MS = 5000;

export function createRallyManager({
  ballEvents,
  server,
  playerServe = null,
  config: cfgIn = {},
} = {}) {
  const config = { ...DEFAULT_CONFIG, ...cfgIn };

  // --- Match / game / rally state ----------------------------------------
  let aiScore = 0, playerScore = 0;
  let aiGames = 0, playerGames = 0;
  // Initial server: the caller's choice ('ai' | 'player', e.g. a coin flip
  // at match start — real matches toss for it), defaulting to the historic
  // AI-serves-first. Alternates between games per ITTF rules.
  let currentServer = config.firstServer === 'player' ? 'player' : 'ai';
  let pointsSinceServerSwitch = 0;
  let matchOver = false;
  // Timestamp the current receiver-not-ready hold began, 0 when not holding.
  let receiverHoldStartedAt = 0;
  let initialServerForGame = currentServer;

  // Every rally rule — who struck what, service legality, obstruction, lets,
  // double bounces — lives in the shared engine, which multiplayer runs too.
  // This module keeps only the things a rulebook has no opinion about:
  // scoring, serve rotation, timers and ball spawning.
  const rules = createRallyRules({
    near: 'player',   // player owns +Z, matching the rest of the codebase
    far: 'ai',
    // Read live: tableBox/tableSurfaceY are null until the models load, and
    // GRAVITY is runtime-tunable from the in-XR physics panel.
    getGeometry: () => ({ tableBox, tableSurfaceY, gravity: GRAVITY }),
  });

  // Per-rally bookkeeping owned here.
  //   rallyInProgress — this rally is live and undecided; also the re-entry
  //     guard that stops one event from scoring twice.
  //   waitingForServeStrike — a player-serve toss ball is airborne, unstruck.
  //   ballDead — a point/let was just decided and the corpse ball is still on
  //     the table. Swings at it are ignored outright (see onPaddleHitInternal).
  let rallyInProgress = false;
  let waitingForServeStrike = false;
  let ballDead = false;

  let nextServeTimer = null;
  let despawnTimer = null;

  // Mark the ball dead the moment the point/let is decided, and force it off
  // the table if it is still moving when the serve window comes round.
  // Called by both finishRally and callLet immediately after they clear
  // rallyInProgress, which makes it the one place that always marks the ball
  // dead — the flag onPaddleHitInternal uses to ignore swings at a corpse.
  //
  // Two stages, because despawnBall dissolves a moving ball rather than
  // cutting it (BALL_FADE_OUT_MS) and a ball you can still see is a ball
  // someone can still swing at: ballDead has to outlast the pixels, not the
  // timer. Clearing it on the ball's real disappearance rather than at the
  // next serve keeps the dead window exactly as long as the dead BALL — a
  // rally started by a paddle hit alone (headless callers, and the player's
  // own serve stroke) still works the moment the table is clear.
  //
  // The second setTimeout reuses `despawnTimer` so there is still one handle
  // to cancel in resetRallyState and dispose.
  function scheduleBallDespawn() {
    ballDead = true;
    if (despawnTimer) clearTimeout(despawnTimer);
    despawnTimer = setTimeout(() => {
      // No-op if the ball already settled and retired itself, which is the
      // common case; otherwise this starts the fade.
      despawnBall();
      despawnTimer = setTimeout(() => {
        despawnTimer = null;
        ballDead = false;
      }, BALL_FADE_OUT_MS);
    }, POINT_END_DESPAWN_MS);
  }

  // External event subscribers.
  const listeners = {
    onPointScored: [],
    onGameEnd: [],
    onMatchEnd: [],
    onServerChange: [],
    onServeRequested: [], // emitted when next-serve fires (UI hooks)
    // A let: replay, no point. `reason` is 'netCord' (cord serve landed
    // good) or 'receiverNotReady' (the serve is being held, ITTF 2.9.1.2).
    onLet: [],
  };
  function on(eventName, fn) { if (listeners[eventName]) listeners[eventName].push(fn); }
  function emit(eventName, payload) {
    const arr = listeners[eventName];
    if (!arr) return;
    for (const fn of arr) fn(payload);
  }

  function resetRallyState() {
    rallyInProgress = false;
    ballDead = false;
    waitingForServeStrike = false;
    rules.beginRally({ server: currentServer });
  }

  // Route a rules verdict into scoring. Everything the rulebook can say ends
  // up here: a point (with the fault flag the UI needs), or a let.
  function applyVerdict(verdict) {
    if (!verdict) return false;
    if (verdict.let) {
      callLet();
      return true;
    }
    finishRally(verdict.winner, verdict.reason, verdict.detail, verdict.foul);
    return true;
  }

  // --- Ball event handlers -----------------------------------------------

  function onPaddleHitInternal(info) {
    if (!info || matchOver) return;
    const origin = info.origin === 'player' ? 'player'
                 : info.origin === AI_PADDLE_ORIGIN ? 'ai' : null;
    if (!origin) return;
    // Ignore contacts on a ball whose point is already decided. The ball stays
    // visible for POINT_END_DESPAWN_MS and the next serve is 2.5s out, so a
    // player swinging at it in that window must not be scored against — the
    // rally is over, they just can't tell yet.
    //
    // A let makes that certain rather than likely: the cord serve lands good,
    // callLet ends the rally, and the receiver — who has no way to know it was
    // a let — plays the ball on reflex. Without this guard that swing restarted
    // the rally bookkeeping mid-air, and because a let is called BEFORE the
    // receiver-side bounce is counted, it read as an illegal volley and cost
    // them the point they were just handed a replay of.
    //
    // Deliberately NOT `!rallyInProgress`: a rally may legitimately begin with
    // a paddle hit (the player's serve stroke, and every headless caller that
    // drives a rally without a serve). Only a rally that has ENDED is dead.
    if (ballDead) return;
    waitingForServeStrike = false;
    // Set before consulting the rules: a service fault is decided by the very
    // stroke that starts the rally, and finishRally's re-entry guard requires
    // the rally to be live.
    rallyInProgress = true;
    applyVerdict(rules.registerHit(origin, {
      contactPos: info.contactPos, inVel: info.inVel,
    }));
  }

  function onTableBounceInternal(info) {
    if (!info || matchOver || !rallyInProgress) return;
    applyVerdict(rules.registerBounce(info));
  }

  function onNetHitInternal(/* info */) {
    if (matchOver || !rallyInProgress) return;
    // A net touch is not a point by itself — the ball can still dribble over
    // the cord (ball.js preserves horizontal drift on top-cord hits). Where
    // it comes down decides the point via the bounce rules: falling back on
    // the hitter's half is an ownSideBounce/serveFault, carrying over plays
    // on, and a net-cord SERVE that lands legally becomes a let.
    rules.registerNetHit();
  }

  // Law 2.10: a player, or anything they wear or carry, touching the net
  // assembly while the ball is in play. Reported by the net-touch watcher in
  // aiMatch's update loop — nothing in the ball's own event stream can see it.
  function reportNetTouch(side) {
    if (matchOver || !rallyInProgress || ballDead) return;
    applyVerdict(rules.registerNetTouch(side));
  }

  // Net-cord serve that landed legally: ITTF let — no point, the same server
  // replays. The live ball keeps rolling but rallyInProgress is false, so its
  // remaining bounce/lost events are ignored (same stale-ball handling as any
  // between-points window).
  function callLet() {
    hudLog(`[SCORE-DBG] LET — net-cord serve landed good, replay (server=${currentServer})`);
    rallyInProgress = false;
    scheduleBallDespawn();
    emit('onLet', { server: currentServer, reason: 'netCord' });
    scheduleNextServe();
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
    // `detail` disambiguates the two very different ways a ballLost point
    // happens, so the UI can say "SHOT WENT OUT" vs "NOT RETURNED" instead
    // of a generic message. `reason` deliberately stays 'ballLost' — it's
    // the coarse cause and consumers already switch on it.
    if (!applyVerdict(rules.registerBallLost())) {
      // The rulebook had nothing to say — no stroke was ever observed this
      // rally. Don't freeze the match waiting for a verdict that isn't
      // coming: kill the ball and re-offer the serve with no point.
      rallyInProgress = false;
      scheduleBallDespawn();
      scheduleNextServe();
    }
  }

  // --- Scoring ------------------------------------------------------------

  // `foul` names the side that broke a rule (as opposed to simply missing).
  // It rides along on onPointScored so the UI can announce a fault as a fault
  // — different panel treatment, a distinct haptic buzz, and a corrective
  // hint — instead of showing "AI POINT / SERVE FAULT" in the same voice as
  // "AI POINT / NOT RETURNED". null for ordinary rally outcomes.
  function finishRally(winner, reason, detail = null, foul = null) {
    // Strict re-entry guard: every ball-event handler already checks
    // rallyInProgress before calling us, so entering with it already false
    // means either a stale event slipped through or something re-entered
    // finishRally itself. Either way we must not increment again.
    if (!rallyInProgress) {
      hudLog(`[SCORE-DBG] finishRally BLOCKED reason=${reason} winner=${winner} lastHitter=${rules.getLastHitter()} wait=${waitingForServeStrike} aiB=${rules.bouncesOn('ai')} pB=${rules.bouncesOn('player')}`);
      return;
    }
    hudLog(`[SCORE-DBG] finishRally reason=${reason} winner=${winner} lastHitter=${rules.getLastHitter()} aiB=${rules.bouncesOn('ai')} pB=${rules.bouncesOn('player')} before P${playerScore}-AI${aiScore}`);
    if (foul) hudLog(`[FOUL] ${foul}: ${reason}${detail ? '/' + detail : ''} — point to ${winner}`);
    rallyInProgress = false;
    scheduleBallDespawn();
    if (winner === 'ai') aiScore += 1;
    else playerScore += 1;
    pointsSinceServerSwitch += 1;

    emit('onPointScored', { winner, reason, detail, foul, aiScore, playerScore });

    // Game-end check: leader at or above firstTo with ≥2-point lead.
    const lead = Math.abs(aiScore - playerScore);
    const top = Math.max(aiScore, playerScore);
    if (top >= config.firstTo && lead >= 2) {
      const gameWinner = aiScore > playerScore ? 'ai' : 'player';
      if (gameWinner === 'ai') aiGames += 1;
      else playerGames += 1;
      // playerScore/aiScore here are the game's FINAL point totals (reset
      // happens below) — consumers use them for the per-game history row on
      // the scoreboard.
      emit('onGameEnd', { winner: gameWinner, aiGames, playerGames, playerScore, aiScore });

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

  // A missing predicate, or one that throws because the scene tore down
  // mid-match, both mean "ready". The failure that matters here is a serve
  // that never comes, not one that comes a beat early.
  function receiverIsReady() {
    if (typeof config.isReceiverReady !== 'function') return true;
    try {
      return config.isReceiverReady() !== false;
    } catch (e) {
      return true;
    }
  }

  function scheduleNextServe(delayMs = NEXT_SERVE_DELAY_MS) {
    if (matchOver) return;
    if (nextServeTimer) {
      clearTimeout(nextServeTimer);
      nextServeTimer = null;
    }
    nextServeTimer = setTimeout(() => {
      nextServeTimer = null;
      triggerNextServe();
    }, delayMs);
  }

  // Pressure context for the AI's serve archetype selection. Deuce raises
  // pressure; game point (server one point from taking the game) raises it;
  // match point (in a deciding game, server one from winning the match)
  // is critical.
  function buildGameContext() {
    const serverScore = currentServer === 'ai' ? aiScore : playerScore;
    const opponentScore = currentServer === 'ai' ? playerScore : aiScore;
    const isDeuce = aiScore >= config.deucePoint && playerScore >= config.deucePoint;
    // Game point: server is one point from firstTo (or past it in deuce) AND
    // leads by at least 1 — i.e. winning the next point wins the game. A tie
    // (e.g. 10-10) is not game point: winning only reaches advantage.
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

    // ITTF 2.9.1.2 — receiver not ready. Checked BEFORE resetRallyState and
    // the onServeRequested emit so a hold is silent after the first beat:
    // re-emitting per poll would re-show the serve arrow and re-buzz the
    // paddle hand six times a second.
    if (currentServer === 'ai' && !receiverIsReady()) {
      const heldFor = receiverHoldStartedAt ? Date.now() - receiverHoldStartedAt : 0;
      if (!receiverHoldStartedAt) {
        receiverHoldStartedAt = Date.now();
        emit('onLet', { server: currentServer, reason: 'receiverNotReady' });
      }
      if (heldFor < RECEIVER_READY_MAX_HOLD_MS) {
        scheduleNextServe(RECEIVER_READY_POLL_MS);
        return;
      }
      hudLog('[serve] receiver still not tracked after '
        + `${(RECEIVER_READY_MAX_HOLD_MS / 1000).toFixed(0)}s — serving anyway.`);
    }
    receiverHoldStartedAt = 0;

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
        // armServeStroke arms the ITTF service rules (own-half bounce
        // required, net touch → let) for this stroke; the toss itself is
        // released behind the end line, off the table footprint, so no
        // bounce events can fire before the strike. The service POSITION
        // rule can't apply — there is no contact event to measure — which is
        // correct: the AI's scripted serve is legal by construction.
        rules.armServeStroke('ai');
        rallyInProgress = true;
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
        // waitingForServeStrike is deliberately NOT set here. Between arm()
        // and the player's trigger pull no courtesy ball exists — the only
        // ball that can emit events in that window is the previous rally's
        // leftover (still rolling on the table / falling to the floor; its
        // stuck/floor ballLost can arrive well after NEXT_SERVE_DELAY_MS).
        // Setting the flag now made that stale ballLost read as "toss lost"
        // → scheduleNextServe() a second time → a pending triggerNextServe
        // firing MID-RALLY after the real serve: rally bookkeeping reset,
        // player re-armed (phantom second ball on the next trigger pull),
        // and the serve arrow / panel re-shown during play. The flag is set
        // by the playerServe.onLaunch subscription below, i.e. only while a
        // courtesy ball is actually live.
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
    // Behind the end line (ITTF: the toss starts behind the server's end
    // line). The inward drift below carries it to roughly the line by the
    // time the player strikes it.
    const z = tableBox.max.z + 0.05;
    spawnBallAt(
      new THREE.Vector3(x, y, z),
      // Toss upward with a taller arc so the player clearly sees it rise
      // before striking. Slight inward z so the ball arcs toward the end
      // line rather than falling further behind the player — but only
      // slight: -0.4 carried it ~16cm inside the line over the flight,
      // far enough that a late strike tripped the serve-position fault on
      // the game's own toss. See playerServe.js TOSS_FORWARD_VZ_MPS.
      new THREE.Vector3((Math.random() - 0.5) * 0.2, 2.0, -0.15),
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
    if (despawnTimer) {
      clearTimeout(despawnTimer);
      despawnTimer = null;
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
    listeners.onLet.length = 0;
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
        && rules.getLastHitter() === 'player'
        && rules.hitsBy('ai') === 0
        && rules.hitsBy('player') === 1;
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

  // Open the "courtesy ball is live" window only when the toss actually
  // spawns (see the long comment in triggerNextServe's player branch). From
  // this moment a ballLost-before-paddleHit legitimately means the player
  // whiffed the toss and the serve should be re-offered.
  if (playerServe && typeof playerServe.onLaunch === 'function') {
    playerServe.onLaunch(() => { waitingForServeStrike = true; });
  }

  // Strict service rule (ITTF 2.6.2): the toss must rise at least 16 cm.
  // playerServe measures the release velocity and reports a short toss the
  // moment it leaves the hand — before any strike. The umpire's ladder:
  // first offence of the match is a warning and the serve is retaken;
  // every one after that is a fault, point to the receiver.
  let lowTossWarned = false;
  if (config.strictToss && playerServe && typeof playerServe.onLowToss === 'function') {
    playerServe.onLowToss(() => {
      if (matchOver || currentServer !== 'player') return;
      // onLowToss fires after onLaunch, so the courtesy-ball window is open;
      // closing it keeps the doomed toss's own ballLost from re-offering the
      // serve a second time underneath us.
      if (!waitingForServeStrike) return;
      waitingForServeStrike = false;
      if (playerServe.disarm) playerServe.disarm();
      if (!lowTossWarned) {
        lowTossWarned = true;
        hudLog('[serve] WARNING — toss under the 16 cm minimum. Retake; the next short toss is a fault.');
        scheduleBallDespawn();
        scheduleNextServe();
        return;
      }
      // The rulebook never saw a stroke (the fault happens before contact),
      // so arm the re-entry guard finishRally checks and score it directly.
      rallyInProgress = true;
      finishRally('ai', 'serveFault', 'lowToss', 'player');
    });
  }

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

  return {
    start, dispose, on, getScore, setConfig, isAINextShotServeReturn,
    reportNetTouch,
  };
}
