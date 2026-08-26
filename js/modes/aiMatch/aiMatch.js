// AI Match drill — plays the player against the AI opponent.
//
// Plugs into the existing DRILL_FACTORIES in js/modes/inGame.js exactly the
// same way Multiplayer does, so the wrist menu, ball-event plumbing, and
// drill lifecycle stay unchanged. The AI owns serves (Phase 1 cheats: ball is
// auto-spawned with a feed-style toss toward the player; Phase 3+ adds proper
// AI-driven serve animation).
//
// Wiring:
//   shotAdapter   — converts player paddle hits into shot events posted to
//                   the AI worker, runs the physics rollout for landing_x/z
//                   AND for the AI's interception point.
//   aiPaddle      — mounts via registerAIPaddle, owns the visual + getFace()
//                   for the existing swept-disc collision.
//   intent        — single source of truth read by the FSM and the paddle.
//   aiFSM         — drives the rally state machine, owns transitions.
//   worker        — Web Worker hosting the decision-layer engine, message-
//                   routed via worker.postMessage / .onmessage.
//
// Event routing discipline (matters for ordering):
//   The orchestrator subscribes to ballEvents.onPaddleHit ONCE. On a player
//   hit we let the shotAdapter process first (so its lastRollout is fresh),
//   THEN pass that rollout to the FSM. The shotAdapter's own listener also
//   runs because it self-subscribes — that's fine, both observe the same
//   event, the order between them is deterministic because we register the
//   adapter before the FSM-bound listener.

import * as THREE from 'three';
import { ballModel, paddleModel, tableBox, tableSurfaceY, netBox } from '../../scene/models.js';
import { paddleFaceCenterWorld } from '../../physics/ball.js';
import { hudLog } from '../../scene/hud.js';
import { createShotAdapter, AI_PADDLE_ID } from '../../ai/shotAdapter.js';
import { AIPaddle } from './aiPaddle.js';
import { createIntent } from './intent.js';
import { createAIFSM } from './aiFSM.js';
import { recordPlayerLanding, recordIncomingBall, resetRecentLandings, setStyleHomeDistance } from './readyPosition.js';
import { pickStyleForMatch, homeDistanceForStyle, contactDelayForStyle } from '../../ai/playerStyles.js';
import { createServer } from './serve.js';
import { createPlayerServeController } from './playerServe.js';
import { createRallyManager } from './rallyManager.js';
import { createFailureHandler } from './failureHandler.js';
import { createScoreboard } from '../../scene/scoreboard.js';
// BETA LAUNCH: stadium venue disabled (see js/ui/overlay.js) — these imports
// are commented out so the stadium/crowd modules are tree-shaken out of the
// shipped bundle. Restore together with the mount block further down.
// arenaLighting is live again: the Focus Room exposes ceiling fixtures.
// import { createStadiumScoreboard } from '../../scene/stadiumScoreboard.js';
// import { createCrowdAudio } from '../../scene/crowdAudio.js';
// import { createCrowdWave } from '../../scene/crowdWave.js';
import { createArenaLighting } from '../../scene/arenaLighting.js';
// import { createSponsorBoards } from '../../scene/sponsorBoards.js';
import { faultRuleText } from '../../scene/faultText.js';
import { createServeArrow } from '../../scene/serveArrow.js';
import { createPointBurst } from '../../scene/pointBurst.js';
import { pulseActive, pulseFoul } from '../../xr/haptics.js';
import { createNetTouchWatcher } from '../../scene/netTouch.js';
import { playFoulWhistle } from '../../scene/audio.js';

export const AI_MATCH = { id: 'aiMatch', label: 'AI Match' };

// Convert the shotAdapter rollout into the incoming-ball snapshot the
// worker's shot-type selector consumes. Everything here is derived from
// the predicted state at the AI's contact point:
//   speed_mps         magnitude of ball velocity at contact
//   spin_topspin      signed scalar. + = topspin (upper surface rolls
//                     toward AI), − = backspin. Computed by projecting
//                     angular velocity onto (travel × up).
//   contact_height_m  height of ball above table surface at contact
//   contact_vy_mps    signed vertical velocity at contact. Negative =
//                     descending. High + fast-descending = attackable
//                     kill ball; high + slow = floater to loop, not smash.
//   bounce_depth_m    distance from net where the ball bounced on AI
//                     side (before rising to the contact point)
// Returns null when the rollout produced no interception, so the engine
// falls back to its situation-independent base weights.
const _tmpTravel = new THREE.Vector3();
const _tmpSpinAxis = new THREE.Vector3();
const _tmpUp = new THREE.Vector3(0, 1, 0);
function buildIncomingContext(rolloutResult) {
  if (!rolloutResult || !rolloutResult.contactPoint || !rolloutResult.contactVelocity) return null;
  const cv = rolloutResult.contactVelocity;
  const cs = rolloutResult.contactSpin || { x: 0, y: 0, z: 0 };
  const speed_mps = Math.hypot(cv.x, cv.y, cv.z);
  _tmpTravel.set(cv.x, 0, cv.z);
  const horizLen = _tmpTravel.length();
  let spin_topspin = 0;
  if (horizLen > 1e-3) {
    _tmpTravel.multiplyScalar(1 / horizLen);
    // spin axis = travel × up → topspin ω projects positively onto it.
    _tmpSpinAxis.crossVectors(_tmpTravel, _tmpUp);
    // Ball angular velocity is in rad/s. Convert projection to rps by
    // dividing by 2π so the type selector's thresholds (in rps) line up
    // with what buildShotAdapter also reports.
    spin_topspin = (cs.x * _tmpSpinAxis.x + cs.y * _tmpSpinAxis.y + cs.z * _tmpSpinAxis.z) / (2 * Math.PI);
  }
  const contact_height_m = (tableSurfaceY !== undefined && rolloutResult.contactPoint.y !== undefined)
    ? Math.max(0, rolloutResult.contactPoint.y - tableSurfaceY)
    : 0;
  const contact_vy_mps = (typeof cv.y === 'number' && Number.isFinite(cv.y)) ? cv.y : 0;
  let bounce_depth_m = 0;
  if (rolloutResult.bouncePoint && tableBox) {
    const tableCenterZ = (tableBox.min.z + tableBox.max.z) / 2;
    bounce_depth_m = Math.abs(rolloutResult.bouncePoint.z - tableCenterZ);
  }
  return { speed_mps, spin_topspin, contact_height_m, contact_vy_mps, bounce_depth_m };
}

// Convert the player paddle's current world position to spec coords (signed
// lateral x, non-negative "from net" z on the player side) so the AI worker
// can bias targeting away from where the player is standing. Mirrors the
// same shotAdapter conversion used for landings: x is directly signed, z is
// abs(world_z - tableCenterZ).
//
// Returns null when the paddle model isn't available (early boot, or if the
// player is out of tracking): engines fall back to the plain neutral picker.
function buildPlayerXZ() {
  if (!paddleModel || !tableBox) return null;
  const tableCenterZ = (tableBox.min.z + tableBox.max.z) / 2;
  const x = paddleModel.position.x;
  const z = Math.abs(paddleModel.position.z - tableCenterZ);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

// Player paddle velocity tracker — smoothed lateral velocity (x, z) used
// by the tactical zone picker's wrong-footing heuristic. EMA over ~4
// frames strips out the high-frequency swing noise while still catching
// the "player is drifting left" body motion. Reset when the paddle isn't
// available.
const PLAYER_VEL_ALPHA = 0.25;
const _playerVelState = { hasPrev: false, prevX: 0, prevZ: 0, prevT: 0, vx: 0, vz: 0 };
function sampleAndSmoothPlayerVelocity(nowMs) {
  if (!paddleModel || !tableBox) {
    _playerVelState.hasPrev = false;
    _playerVelState.vx = 0;
    _playerVelState.vz = 0;
    return;
  }
  const tableCenterZ = (tableBox.min.z + tableBox.max.z) / 2;
  const x = paddleModel.position.x;
  const z = Math.abs(paddleModel.position.z - tableCenterZ);
  if (!_playerVelState.hasPrev) {
    _playerVelState.hasPrev = true;
    _playerVelState.prevX = x;
    _playerVelState.prevZ = z;
    _playerVelState.prevT = nowMs;
    return;
  }
  const dt = (nowMs - _playerVelState.prevT) / 1000;
  if (dt > 1e-4 && dt < 0.25) {
    const instVx = (x - _playerVelState.prevX) / dt;
    const instVz = (z - _playerVelState.prevZ) / dt;
    _playerVelState.vx += PLAYER_VEL_ALPHA * (instVx - _playerVelState.vx);
    _playerVelState.vz += PLAYER_VEL_ALPHA * (instVz - _playerVelState.vz);
  }
  _playerVelState.prevX = x;
  _playerVelState.prevZ = z;
  _playerVelState.prevT = nowMs;
}
function currentPlayerVelocityXZ() {
  if (!_playerVelState.hasPrev) return null;
  return { x: _playerVelState.vx, z: _playerVelState.vz };
}
function resetPlayerVelocity() {
  _playerVelState.hasPrev = false;
  _playerVelState.vx = 0;
  _playerVelState.vz = 0;
}

// Difficulty interval at which the AI worker should re-target. Spec puts
// decision at ~5Hz. In Phase 1 a target is requested ONCE per rally (after
// PREDICTING → DECIDING), so this constant isn't actively used yet but is
// kept here so Phase 2 can switch to a periodic re-target inside MOVING.

// `scoreboardAnchor` / `env` were `arenaAnchor` / `arena` pre-beta — renamed
// because destructured keys survive minification and the beta bundle must not
// hint at the unreleased venues. `env` is live again for the Focus Room's
// venue handle (wall-anchored scoreboard + fixture lighting); the GLB
// stadium mount block below stays commented out.
export function createAIMatchDrill({ ballEvents, profile, xr, scoreboardAnchor = null, env = null } = {}) {
  if (!ballEvents) throw new Error('createAIMatchDrill requires { ballEvents }');
  const arena = env;

  // Difficulty comes from the wrist menu's difficulty buttons via
  // getProfile(id). Key off the profile's stable `id`, never its display
  // label: the label is UI copy (the wrist menu already renders different
  // wording), so lowercasing it to reach ENGINE_FACTORIES worked only as long
  // as the two strings happened to match.
  const difficulty = (profile && profile.id) || 'beginner';

  // --- AI worker -----------------------------------------------------------
  // Vite picks up new URL(..., import.meta.url) with { type: 'module' } and
  // bundles the worker chunk. No COOP/COEP headers required since we don't
  // use SharedArrayBuffer.
  const worker = new Worker(
    new URL('../../ai/worker.js', import.meta.url),
    { type: 'module' },
  );
  // V2 §section_7: failure handler wraps worker round-trips with timeouts,
  // tracks solver-infeasibility 3x, and validates ball state each frame.
  const failureHandler = createFailureHandler({ worker, log: hudLog });

  // --- Adapter (must be created BEFORE the FSM-bound paddleHit listener
  //     so its lastRollout is populated before the FSM reads it).
  const shotAdapter = createShotAdapter({ worker, ballEvents });

  // --- Player style for this match ----------------------------------------
  // Pick a style (attacker / blocker / chopper / allround) based on
  // difficulty. Beginner always allround; Intermediate skews to
  // attacker/blocker/allround; Pro can also be a chopper. Each match
  // instance rolls a fresh style so back-to-back matches at the same
  // difficulty feel like different opponents.
  const style = pickStyleForMatch(difficulty, Math.random);

  // --- AI paddle + intent + FSM -------------------------------------------
  // V2 §section_4: reset any landing history from a prior session so Pro's
  // anticipatory bias starts fresh.
  resetRecentLandings();
  setStyleHomeDistance(homeDistanceForStyle(style));
  // Contact TIMING is the other half of the style signature: the blocker
  // takes the ball on the rise, the chopper late on the descent (see
  // STYLE_CONTACT_DELAY_MS). Set once — the interception rollout uses it
  // for every ball of the match.
  shotAdapter.setContactDelayMs(contactDelayForStyle(style));
  const paddle = new AIPaddle({ difficulty, style });
  const intent = createIntent();
  intent.difficulty = difficulty;
  intent.style = style;
  const fsm = createAIFSM({ paddle, intent, difficulty, failureHandler });

  // --- Worker message routing ---------------------------------------------
  worker.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;
    switch (msg.type) {
      case 'ready':  hudLog(`[AI] worker ready (${difficulty} · ${style})`); break;
      case 'target': failureHandler.onTargetResponse(msg.payload); break;
      case 'error':  hudLog(`[AI] worker error: ${msg.message}`); break;
    }
  };
  worker.postMessage({ type: 'init', config: { difficulty, style } });

  // --- Ball event routing into the FSM. shotAdapter self-subscribes, so
  //     when the player hits we react with a SECOND listener here that
  //     reads the adapter's freshly-computed rollout and requests a target
  //     from the worker.
  function onPaddleHit(info) {
    if (!info) return;
    if (info.origin === 'player') {
      // Scoreboard stats: every player paddle contact counts as a shot hit;
      // TOP SPEED tracks the fastest outgoing ball speed (km/h) off the
      // player's paddle. updateBoards / matchStats are defined below with
      // the scoreboards; both exist long before the first rally fires this.
      matchStats.shotsHit += 1;
      const kmh = (info.outSpeed || 0) * 3.6;
      if (kmh > matchStats.topSpeedKmh) matchStats.topSpeedKmh = kmh;
      updateBoards({ shotsHit: matchStats.shotsHit, topSpeedKmh: matchStats.topSpeedKmh });
      const rolloutResult = shotAdapter.getLastRollout();
      // Spin-blind read for the AI's initial approach — see READ_LATENCY_MS
      // in aiFSM. Passing it is optional; the FSM falls back to the true
      // rollout when it's null.
      fsm.onPlayerHit(rolloutResult, shotAdapter.getLastRolloutSpinBlind());
      // V2 §section_4: record player's outgoing-shot landing for Pro's
      // anticipatory bias. The rollout's bouncePoint is on the AI side
      // (where the player's shot lands), exactly what the bias formula
      // wants. Non-Pro difficulties ignore the recorded landings.
      if (rolloutResult && rolloutResult.bouncePoint) {
        recordPlayerLanding(rolloutResult.bouncePoint.x, rolloutResult.bouncePoint.z);
      }
      // V2 §section_7: route through failureHandler so a worker timeout
      // delivers a fallback target to the FSM instead of stalling.
      // Enrich the context with the incoming-ball snapshot at the AI's
      // predicted contact point — the shot-type selector inside the
      // engine reads this to pick a plausible response (push a short
      // ball, loop a heavy backspin, smash a floater) instead of drawing
      // (speed, spin) uniformly.
      const incoming = buildIncomingContext(rolloutResult);
      // Feed the incoming ball snapshot into readyPosition so between-
      // rally ready-pose picks up the vertical bias (squat after a high
      // ball, rise after a short one).
      if (incoming) recordIncomingBall(incoming);
      const player_xz = buildPlayerXZ();
      const player_velocity_xz = currentPlayerVelocityXZ();
      // Score margin lets the shot selector tighten up on close points
      // (real players rarely gamble on kill shots at 9-9). rallyManager
      // is created later in this closure but populated before the first
      // rally hits — safe to read at callback time.
      let score_margin = 0;
      let score_total = 0;
      try {
        if (typeof rallyManager !== 'undefined' && rallyManager && rallyManager.getScore) {
          const s = rallyManager.getScore();
          score_margin = (s.aiScore || 0) - (s.playerScore || 0);
          score_total  = (s.aiScore || 0) + (s.playerScore || 0);
        }
      } catch (_) { /* rallyManager not up yet — harmless */ }

      // Third-ball attack — if this player hit is the first return after an
      // intermediate-or-pro serve with a planned attack, and the return landed
      // inside the expected zone, activate the plan for the next AI shot. The
      // engine will override its normal shot-type + target with the
      // planned attack (loop to open forehand, smash down the line, etc).
      // Gate lives in serve.js; both tiers consume it.
      // Return-of-serve flag — set true when this AI hit will be the
      // FIRST receive of a player-served rally. Engine swaps to
      // SERVE_RETURN_WEIGHTS (push / block / flip; no loops or smashes)
      // for this shot only.
      let isServeReturn = false;
      try {
        if (rallyManager && rallyManager.isAINextShotServeReturn) {
          isServeReturn = rallyManager.isAINextShotServeReturn();
        }
      } catch (_) { /* rallyManager not up — skip */ }

      let thirdBallOpportunity = null;
      try {
        const plan = server && server.consumeLastServeThirdBallPlan
          ? server.consumeLastServeThirdBallPlan()
          : null;
        if (plan && rolloutResult && rolloutResult.bouncePoint && tableBox) {
          const tableCenterZ = (tableBox.min.z + tableBox.max.z) / 2;
          // Convert bouncePoint world → spec coords (signed x, from-net z
          // on AI side, mirroring buildPlayerXZ conventions).
          const bx = rolloutResult.bouncePoint.x;
          const bz = Math.abs(rolloutResult.bouncePoint.z - tableCenterZ);
          const dx = bx - plan.expectedReturnZone.x;
          const dz = bz - plan.expectedReturnZone.z;
          const dist = Math.hypot(dx, dz);
          if (dist <= plan.expectedReturnZone.tolerance) {
            thirdBallOpportunity = {
              attackShotType: plan.attackShotType,
              attackTargetX:  plan.attackTargetX,
              attackTargetZ:  plan.attackTargetZ,
            };
            hudLog(`[AI] 3rd-ball plan fires: ${plan.attackShotType} → (${plan.attackTargetX.toFixed(2)}, ${plan.attackTargetZ.toFixed(2)})`);
          }
        }
      } catch (_) { /* serve not up yet or malformed rollout — skip */ }

      failureHandler.requestTarget(
        () => worker.postMessage({
          type: 'request_target',
          context: { incoming, player_xz, player_velocity_xz, score_margin, score_total, thirdBallOpportunity, isServeReturn },
        }),
        (target) => fsm.onTargetReceived(target),
      );
    } else if (info.origin === AI_PADDLE_ID) {
      // AI paddle hits during a serve never fire: the toss contact is
      // scripted by serve.js and the collider is gated off for that window,
      // so no paddleHit is emitted. Outside a serve it's a rally return.
      if (server.isFinished()) fsm.onAIContact();
    }
  }

  function onBallLost() {
    fsm.onBallLost();
    // rallyManager (created below) owns next-serve scheduling — no
    // scheduleRespawn here.
  }

  ballEvents.onPaddleHit(onPaddleHit);
  ballEvents.onBallLost(onBallLost);

  // --- Serve subsystem + rally manager ------------------------------------
  // V2 §section_5: 5-state serve sub-FSM owns the paddle during the AI's
  // serves.
  // V2 §section_6: rally manager owns rally-end detection, ITTF scoring,
  // and next-serve scheduling (both AI and player serves).
  const server = createServer({ paddle, difficulty });
  // Player-serve controller. With the xr handle it offers the physical toss
  // (squeeze off-hand GRIP to hold the ball, release to toss with the hand's
  // real velocity); the trigger auto-toss stays as the always-available
  // fallback, so this remains constructable without xr (headless tests).
  const playerServe = createPlayerServeController({ xr });
  // Serve toss: a fair coin decides who serves first, like the real thing —
  // the AI used to serve first every match, which also meant the player
  // NEVER opened a match with their own serve.
  const rallyManager = createRallyManager({
    ballEvents, server, playerServe,
    config: { firstServer: Math.random() < 0.5 ? 'player' : 'ai' },
  });
  // Probe is the paddle's face centre, which ball.js already maintains every
  // frame for collision — no extra pose work, and it's the point that
  // actually contacts things.
  const netTouchWatcher = createNetTouchWatcher({
    getProbe: () => paddleFaceCenterWorld,
    getNetBox: () => netBox,
  });

  // Floating scoreboard above the net. Seeded from rallyManager's initial
  // state (so the first-serve indicator lights up before any events fire),
  // then patched from each event.
  const initialScore = rallyManager.getScore();
  // scoreboardAnchor is populated by venues with a named back wall — the
  // Focus Room (js/scene/focusRoom.js) and the tt-arena GLB (js/scene/
  // arena.js getBackWallAnchor). Other modes leave it null and the
  // scoreboard falls back to its floating position behind the AI baseline.
  const scoreboard = createScoreboard({ config: { bestOf: 5 }, anchor: scoreboardAnchor });

  // Stadium-only enhancements. When the player is inside the broadcast-
  // stadium venue, mirror the scoreboard onto the venue's TV / Screen /
  // Billboard meshes so the game reads like a live-televised match, and
  // anchor positional crowd cheers to each of the 24 audience sections.
  // Both are no-ops in AR mode or in the tt-arena variant.
  let stadiumScoreboard = null;
  let crowdAudio = null;
  let crowdWave = null;
  let arenaLighting = null;
  let sponsorBoards = null;
  // Any venue exposing ceiling fixtures (currently the Focus Room) gets
  // celebration pulses on its light panels — pulsePoint / pulseMatchPoint /
  // celebrateMatch call sites below are live and null-guarded already.
  if (arena && arena.getStadiumFixtures) {
    const fixtures = arena.getStadiumFixtures();
    if (fixtures && fixtures.length > 0) {
      arenaLighting = createArenaLighting({ fixtures });
      if (arenaLighting) {
        hudLog(`[venue] reactive lighting on ${arenaLighting.fixtureCount} fixture(s)`);
      }
    }
  }
  // BETA LAUNCH: stadium mounts disabled with the imports above. `arena` is
  // non-null only for the Focus Room, which exposes no screens/crowd
  // anchors, so this block still could never run; every reference below
  // (update/dispose/event hooks) null-guards.
  /*
  if (arena && arena.getStadiumScreens && arena.getCrowdAnchors) {
    const screens = arena.getStadiumScreens();
    if (screens && screens.length > 0) {
      stadiumScoreboard = createStadiumScoreboard({
        screenMeshes: screens,
        config: { bestOf: 5 },
      });
      if (stadiumScoreboard) {
        hudLog(`[arena] stadium scoreboard mounted on ${stadiumScoreboard.screenCount} screen(s)`);
      }
    }
    const anchors = arena.getCrowdAnchors();
    if (anchors && anchors.length > 0 && tableBox) {
      const tableCenterZ = (tableBox.min.z + tableBox.max.z) / 2;
      crowdAudio = createCrowdAudio({ anchors, tableCenterZ });
      if (crowdAudio) {
        hudLog(`[arena] crowd audio mounted with ${crowdAudio.anchorCount} anchor(s)`);
        // Fire the PA-style match-start anthem as soon as the MP3s decode.
        // The first serve is delayed by NEXT_SERVE_DELAY_MS (2500ms) after
        // rallyManager.start(), so a ~1-2s network fetch + decode still
        // lands the anthem BEFORE the first rally begins.
        crowdAudio.ready.then(() => {
          if (crowdAudio && crowdAudio.isLoaded()) crowdAudio.playMatchStart();
        });
      }
      // Visual counterpart to the audio: sweeping color pulse across the
      // 24 seat sections. Same anchor list — the crowdWave module uses
      // the .node field to walk into each section's meshes and pulse
      // their material. tableCenter (Vector3) sorts sections by angle so
      // the wave sweeps continuously around the ring.
      const tableCenter = new THREE.Vector3(
        (tableBox.min.x + tableBox.max.x) / 2,
        0,
        tableCenterZ,
      );
      crowdWave = createCrowdWave({ sections: anchors, tableCenter });
      if (crowdWave) {
        hudLog(`[arena] crowd wave mounted with ${crowdWave.sectionCount} section(s)`);
        // Kick off a welcoming wave a moment after the anthem starts —
        // 1.5s in so the audio lands first, then the visual joins.
        setTimeout(() => {
          if (crowdWave) crowdWave.startWave({ laps: 2, direction: 'ccw' });
        }, 1500);
      }
    }
    if (arena.getStadiumFixtures) {
      const fixtures = arena.getStadiumFixtures();
      if (fixtures && fixtures.length > 0) {
        arenaLighting = createArenaLighting({ fixtures });
        if (arenaLighting) {
          hudLog(`[arena] reactive lighting on ${arenaLighting.fixtureCount} fixture(s)`);
        }
      }
    }
    if (arena.getBrandingBoards) {
      const boards = arena.getBrandingBoards();
      if (boards && boards.length > 0) {
        sponsorBoards = createSponsorBoards({ boardMeshes: boards });
        if (sponsorBoards) {
          hudLog(`[arena] sponsor rotation on ${sponsorBoards.boardCount} board(s)`);
        }
      }
    }
  }
  */

  // Single patch point for both scoreboard surfaces (floating/wall panel +
  // stadium TVs) so every producer below keeps them in sync with one call.
  function updateBoards(patch) {
    if (scoreboard) scoreboard.update(patch);
    if (stadiumScoreboard) stadiumScoreboard.update(patch);
  }
  // Match-long stats feeding the SportyXR layout's history + stats rows.
  // gameHistory holds each finished game's final score in play order.
  const matchStats = { shotsHit: 0, topSpeedKmh: 0, gameHistory: [] };
  // TOTAL TIME stat: ticks once a second, frozen at match end (see
  // onMatchEnd) so the final board shows the match duration. One canvas
  // re-render per surface per second — cheap relative to VR frame budget.
  const matchStartMs = performance.now();
  const clockTimer = setInterval(() => {
    updateBoards({ elapsedMs: performance.now() - matchStartMs });
  }, 1000);
  // Seed the first-serve indicator so it lights before any events fire.
  updateBoards({ currentServer: initialScore.currentServer });

  // Helper: is EITHER side one point away from winning the match with the
  // CURRENT score state? Called right after a point is scored to decide
  // whether to pulse the ceiling ring for the upcoming point. bestOf 5 =>
  // 3 games needed; a side with 2 games + score ≥ 10 and (score − opp) ≥ 1
  // is at match point.
  function isEitherSideAtMatchPoint(playerGames, aiGames, playerScore, aiScore) {
    const gamesNeeded = 3;
    const playerMP = playerGames + 1 >= gamesNeeded
      && playerScore >= 10 && (playerScore - aiScore) >= 1;
    const aiMP = aiGames + 1 >= gamesNeeded
      && aiScore >= 10 && (aiScore - playerScore) >= 1;
    return playerMP || aiMP;
  }

  // On-table serve cue: pulsing chevrons on the player's half whenever
  // it's their serve, pointing toward the net (see onServeRequested / launch
  // below for the show/hide lifecycle).
  const serveArrow = createServeArrow();
  // Over-net "+1" / "FOUL" flash at the moment a point is called; the
  // scoreboard and HUD log carry the detail.
  const pointBurst = createPointBurst();

  // Toss went up (either path: off-hand grip release OR trigger auto-toss) —
  // the serve prompt has done its job. This subscription is the single hide
  // point; the launch() wrapper below must not duplicate it because the
  // grip-release path never goes through launch() at all.
  playerServe.onLaunch(() => {
    if (serveArrow) serveArrow.hide();
  });

  rallyManager.on('onPointScored', (e) => {
    hudLog(`[AI Match] point ${e.winner} (${e.reason}): P${e.playerScore} - AI${e.aiScore}`);
    updateBoards({ playerScore: e.playerScore, aiScore: e.aiScore });
    // Instant over-net flash where the point just happened — a brief burst
    // under the match-end celebration is fine.
    if (pointBurst) pointBurst.burst({ winner: e.winner, foul: e.foul });
    // Fouls the PLAYER committed get an immediate tactile call, fired from
    // inside the offending contact's own event — the buzz lands while the
    // paddle is still moving, so the rule attaches to the action that broke
    // it. The HUD log's rule explanation is there when the player goes
    // looking for why.
    if (e.foul === 'player') {
      pulseFoul();
      playFoulWhistle();
      hudLog(`[FOUL] ${faultRuleText(e.reason, e.detail)}`);
    }
    // Crowd reaction. Escalate intensity as the game gets closer:
    //   deuce (≥10-10) or match point → 'big'
    //   game point (server one from taking the game) → 'medium'
    //   otherwise 'small'
    // Cheer fires on the WINNER's side of the arena — real venues split
    // that way when a home crowd has favorites; here the player-side stands
    // are the player's supporters and the AI-side are the AI's.
    if (crowdAudio) {
      const top = Math.max(e.playerScore, e.aiScore);
      const isDeuce = e.playerScore >= 10 && e.aiScore >= 10;
      const nearGame = top >= 10;
      const intensity = (isDeuce || nearGame) ? 'big' : (top >= 8 ? 'medium' : 'small');
      // reactToPoint plays pointWin.mp3 on the winner's stands and
      // disapointment.mp3 on the loser's stands so both sides audibly
      // respond to the point.
      crowdAudio.reactToPoint(e.winner, intensity);
    }
    // Match-point pulse: the point just scored may have brought a side to
    // match point (score 10 in the final game, one win from the match).
    // Rally manager's onPointScored fires with the CURRENT-game score
    // (games from onGameEnd fire separately). We use rallyManager.getScore()
    // for the authoritative games count.
    if (arenaLighting) {
      const s = rallyManager.getScore();
      if (!s.matchOver && isEitherSideAtMatchPoint(s.playerGames, s.aiGames, s.playerScore, s.aiScore)) {
        arenaLighting.pulseMatchPoint();
      }
      // Peripheral companion to the table wash: one soft swell in the
      // winner's color. Skipped at match end, where celebrateMatch() takes
      // over the fixtures with something much bigger.
      if (!s.matchOver) arenaLighting.pulsePoint(e.winner);
    }
    // Feed the score event into the worker's momentum model. Momentum then
    // scales exploit factor and biases shot-type weights on the next
    // request_target. See js/ai/momentum.js for the shape.
    worker.postMessage({
      type: 'point_result',
      payload: { winner: e.winner, aiScore: e.aiScore, playerScore: e.playerScore },
    });
    // Also feed the FSM so it can track its own consecutive-loss streak
    // and inflate the injected miss rate when it's getting rolled ("defense
    // sag" — 3+ losses in a row causes visible unforced errors).
    if (fsm && fsm.onPointResult) fsm.onPointResult({ winner: e.winner });
  });
  rallyManager.on('onServerChange', (e) => {
    updateBoards({ currentServer: e.currentServer });
  });
  rallyManager.on('onGameEnd', (e) => {
    hudLog(`[AI Match] game ${e.winner}: games P${e.playerGames} - AI${e.aiGames}`);
    // Record the finished game's final score for the GAME 1..N history row.
    // slice() so each board holds an immutable snapshot, not our live array.
    matchStats.gameHistory.push({ playerScore: e.playerScore, aiScore: e.aiScore });
    updateBoards({
      playerGames: e.playerGames,
      aiGames: e.aiGames,
      playerScore: 0,
      aiScore: 0,
      gameHistory: matchStats.gameHistory.slice(),
    });
    // Game-end warrants a big cheer on the winner's side (bigger than a
    // regular point). Scattered applause too — the whole arena
    // acknowledges the game.
    if (crowdAudio) {
      crowdAudio.cheerForSide(e.winner, 'big');
      setTimeout(() => crowdAudio.playScatteredApplause(), 800);
    }
    // One lap of the wave — quick acknowledgement, not full celebration.
    if (crowdWave) crowdWave.startWave({ laps: 1, direction: 'ccw' });
    // Fresh game → clear serve placement history so pattern-progression
    // doesn't carry over "you served left too much LAST game" bias.
    if (server && server.resetPlacementPattern) server.resetPlacementPattern();
  });
  rallyManager.on('onMatchEnd', (e) => {
    hudLog(`[AI Match] MATCH WON BY ${e.winner.toUpperCase()}: ${e.aiGames}-${e.playerGames}`);
    // Freeze the TOTAL TIME stat at the exact match duration. onGameEnd for
    // the deciding game already fired (rallyManager emits it first), so the
    // history row is complete by now.
    clearInterval(clockTimer);
    updateBoards({ elapsedMs: performance.now() - matchStartMs });
    const banner = e.winner === 'player' ? 'YOU WIN!' : 'AI WINS';
    if (scoreboard) scoreboard.setMatchOverBanner(banner);
    if (stadiumScoreboard) stadiumScoreboard.setMatchOverBanner(banner);
    // Full-arena celebration: sustained roar on the winner's side + polite
    // applause on the loser's side (see crowdAudio.playMatchWon).
    if (crowdAudio) crowdAudio.playMatchWon(e.winner);
    if (arenaLighting) arenaLighting.celebrateMatch(e.winner);
    // Match-end: 3-lap wave — sustained visual to match the sustained
    // audio celebration. Alternates direction on the second call for a
    // "waves crossing" effect.
    if (crowdWave) {
      crowdWave.startWave({ laps: 3, direction: 'ccw' });
      setTimeout(() => {
        if (crowdWave) crowdWave.startWave({ laps: 2, direction: 'cw' });
      }, 700);
    }
    // Match's over — retire the serve cue.
    if (serveArrow) serveArrow.hide();
  });
  // Net-cord serve that still landed good — ITTF let, replayed with no
  // point.
  rallyManager.on('onLet', (e) => {
    hudLog(`[AI Match] LET — net-cord serve, replaying (server=${e.server})`);
  });
  // Fires at the end of the NEXT_SERVE_DELAY_MS window. For AI serves the
  // ball is about to spawn automatically. For player serves the controller
  // has just been armed and is waiting on a trigger pull → show the on-table
  // arrow (stays visible until launch() hides it) and buzz the paddle-hand
  // as an attention cue.
  rallyManager.on('onServeRequested', (e) => {
    // Crowd quiets down as the server steps up — natural broadcast
    // pattern (cheer after a point → hush before the next serve). Fades
    // every currently-playing cheer / disappointment / anthem source over
    // ~500ms so nothing gets hard-cut mid-word. Also fades the match-
    // start anthem the first time this fires, which is exactly the
    // right feel (crowd settles as the umpire calls play).
    if (crowdAudio) crowdAudio.quietDown();
    if (e.server === 'player') {
      if (serveArrow) serveArrow.show();
      pulseActive(0.6, 100);
    } else {
      if (serveArrow) serveArrow.hide();
    }
  });
  // Kick off the first serve.
  rallyManager.start();

  // --- Drill interface -----------------------------------------------------
  function update(dt) {
    // Advance arena-enhancement animations. All three are cheap when idle
    // (arenaLighting.update / crowdWave.update return immediately if no
    // active pulse; sponsorBoards.update only redraws canvases inside
    // the fade window).
    if (arenaLighting) arenaLighting.update(dt);
    if (crowdWave) crowdWave.update(dt);
    if (sponsorBoards) sponsorBoards.update(dt);
    // Sample player paddle position each frame and update the smoothed
    // velocity EMA. Read at request-target time to feed the tactical
    // wrong-footing model.
    sampleAndSmoothPlayerVelocity(performance.now());
    // V2 §section_7: ball-state corruption check at the top of each tick.
    // If the host's physics has gone wrong (NaN position, impossible
    // velocity), we auto-reset the ball and skip this frame's AI logic
    // rather than feed the corruption into solver/trajectory math.
    if (!failureHandler.validateBallState()) {
      return;
    }
    shotAdapter.sampleEachFrame();
    // Off-hand grip poll for the physical serve toss. Runs independently of
    // AI serve / FSM — it only does work while armed (i.e. the player is
    // currently the server) or mid-hold. Cheap when idle.
    if (playerServe) playerServe.update(dt);
    if (serveArrow) serveArrow.update(dt);
    if (pointBurst) pointBurst.update(dt);
    // ITTF Law 2.10: touching the net assembly while the ball is in play.
    // Nothing in the ball's event stream can see this one, so it's watched
    // here. rallyManager ignores the report unless a rally is actually live.
    if (netTouchWatcher.update()) rallyManager.reportNetTouch('player');
    // V2 §section_5: when the server is active, it owns the paddle (the
    // main FSM stays IDLE). Otherwise normal rally flow.
    if (!server.isFinished()) {
      server.update(dt);
      paddle.refreshVelocity(dt);
    } else {
      fsm.update(dt);
    }
  }
  function liveLine() {
    const servePhase = server.isFinished() ? '' : ` serve=${server.getState()}`;
    const s = rallyManager.getScore();
    const games = (s.aiGames > 0 || s.playerGames > 0)
      ? ` games:${s.playerGames}-${s.aiGames}` : '';
    const srv = s.currentServer === 'ai' ? 'AI' : 'P';
    return `AI Match — ${difficulty}  P${s.playerScore}-AI${s.aiScore}${games} svr:${srv}${servePhase}`;
  }
  function isFinished() { return false; }
  function dispose() {
    // V2 §section_7: failureHandler.dispose terminates the worker safely
    // even if a round-trip is mid-flight. We delegate worker.terminate()
    // to it instead of calling worker.terminate() directly.
    failureHandler.dispose();
    rallyManager.dispose();
    clearInterval(clockTimer);
    if (scoreboard) scoreboard.dispose();
    if (stadiumScoreboard) stadiumScoreboard.dispose();
    if (crowdAudio) crowdAudio.dispose();
    if (crowdWave) crowdWave.dispose();
    if (arenaLighting) arenaLighting.dispose();
    if (sponsorBoards) sponsorBoards.dispose();
    if (serveArrow) serveArrow.dispose();
    if (pointBurst) pointBurst.dispose();
    server.dispose();
    if (playerServe) playerServe.dispose();
    shotAdapter.dispose();
    paddle.dispose();
    intent.reset();
    resetRecentLandings();
    resetPlayerVelocity();
    if (ballModel) ballModel.visible = false;
  }

  // Exposed to inGame.js's handleTrigger — when the drill is active and no
  // panel is being hovered, any trigger press routes here. Delegated to the
  // player-serve controller, which no-ops unless it's armed for a serve (and
  // not already holding the ball in the off-hand). Arrow hiding lives in the
  // playerServe.onLaunch subscription above, which fires for BOTH toss
  // paths. Idle trigger pulls (paddle-hand poke gestures mid-rally) still get
  // no-oped by playerServe.launch() and leave the arrow state alone.
  function launch() {
    if (playerServe) playerServe.launch();
  }

  return {
    update,
    liveLine,
    isFinished,
    dispose,
    launch,
  };
}
