// Multiplayer drill — drill-shaped factory that owns the live NetworkManager
// for the duration of an in-XR session. The only file that imports both
// js/network/* and js/physics|scene/* (per the architectural rule in the plan).
//
// Per-frame contract with inGame.js:
//   1) update(dt) runs BEFORE tickPhysics. If non-owner, it overwrites
//      ballModel.position / ballVelocity / ballAngularVelocity with the
//      interpolated remote state so swept paddle collision still has a
//      meaningful prev → curr displacement.
//   2) tickPhysics is called by inGame.js with { ballOwned: drill.isLocalOwner() }.
//      Integration + table/net/lost emission are skipped for the non-owner.
//   3) Local outbound state is written into networkManager.outboundState; the
//      send loop drains at 60 Hz independently of rAF.
//
// Remote paddle: VISUAL ONLY. It deliberately does NOT participate in local
// collision: every real hit is computed on the hitter's own machine with
// ground-truth paddle pose and communicated via OWNERSHIP_HANDOFF. A
// mirrored paddle is ≥35 ms stale by construction, so any collision it
// produced locally would be physically wrong and immediately contradicted by
// the incoming handoff — the dual-simulation conflict the spec forbids.

import * as THREE from 'three';
import { scene } from '../../scene/sceneSetup.js';
import {
  paddleModel, ballModel, tableBox, tableSurfaceY, ballRadius, netBox,
  paddleFaceOffset, paddleFaceNormalLocal, paddleHitRadius, paddleHalfThickness,
} from '../../scene/models.js';
import { integrateFlightStep, applyTableBounce, isTableBounce } from '../../physics/rollout.js';
import {
  ballVelocity, ballAngularVelocity, spawnBallAt,
  paddleFaceCenterWorld, paddleFaceNormalWorld, paddleVelocity,
} from '../../physics/ball.js';
import { resolvePaddleTablePenetration } from '../../physics/paddleTableClamp.js';
import { GRAVITY } from '../../physics/constants.js';
import { playBounceSound } from '../../scene/audio.js';
import { PaddleSync } from '../../network/PaddleSync.js';
import { GameStateSync, AUTHORITATIVE_EXTRAP_CAP_MS, BALL_EXTRAP_SUBSTEP_MS } from '../../network/GameStateSync.js';
import { HandoffManager } from '../../network/HandoffManager.js';
import { PacketType } from '../../network/serialization.js';
import * as ThermalMonitor from '../../network/ThermalMonitor.js';
import { TelemetryReporter } from '../../network/TelemetryReporter.js';
import { ReconnectHandler } from '../../network/ReconnectHandler.js';
import { SessionState } from '../../lobby/SessionState.js';
import { hudLog } from '../../scene/hud.js';
import { createMatchModel, createRallyTracker, firstServerFromCode } from './matchModel.js';
import { normalizeBestOf, loadBestOf, matchLengthLabel } from '../matchFormat.js';
import { createPlayerServeController } from '../aiMatch/playerServe.js';
import { createScoreboard } from '../../scene/scoreboard.js';
import { createMatchReport } from '../../scene/matchReport.js';
import { createMatchStats, totalPointsFromSets } from '../matchStats.js';
import { faultRuleText } from '../../scene/faultText.js';
import { pulseFoul } from '../../xr/haptics.js';
import { createNetTouchWatcher } from '../../scene/netTouch.js';
import { playFoulWhistle } from '../../scene/audio.js';
import { createServeArrow } from '../../scene/serveArrow.js';
import { createPointBurst } from '../../scene/pointBurst.js';

export const MULTIPLAYER = { id: 'multiplayer', label: 'Multiplayer' };

// Inter-rally window before the next serve arms: long enough to read the
// serve indicator + scoreboard update (mirrors rallyManager's pacing).
const NEXT_SERVE_DELAY_MS = 2500;
const RECONCILIATION_INTERVAL_S = 1.5;

// Remote state is evaluated on the sender's (clock-translated) timeline at
// now - delay so interpolation always has a bracketing pair of packets:
// ~2 send intervals + jitter margin. Doubles when the PEER reports thermal
// throttling (their send rate halves to 30 Hz, so packet spacing doubles).
const REMOTE_INTERP_DELAY_MS = 35;
const REMOTE_INTERP_DELAY_THROTTLED_MS = 70;

// Table-bounce sound dedupe between the locally-predicted bounce (from the
// dead-reckoning mini-sim, zero network latency) and the wire TABLE_BOUNCE
// fallback that arrives RTT/2 later.
const BOUNCE_SOUND_DEDUPE_MS = 120;

const TELEMETRY_URL = (() => {
  const fromEnv = typeof import.meta !== 'undefined'
    && import.meta.env
    && import.meta.env.VITE_TELEMETRY_URL;
  if (fromEnv) return fromEnv;
  const host = (typeof location !== 'undefined' && location.hostname) || 'localhost';
  // No deployed sink: the :8081 dev server (server/telemetry-server.js) only
  // exists locally. Off localhost, disable beaconing (TelemetryReporter keeps
  // sampling for the in-session HUD; it just doesn't POST anywhere).
  if (host !== 'localhost' && host !== '127.0.0.1') return null;
  // Always plain http(s) — telemetry sink is independent of the signaling
  // protocol. Match the page's protocol to avoid mixed-content blocking.
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'https' : 'http';
  return `${proto}://${host}:8081/telemetry`;
})();

// `scoreboardAnchor` was `arenaAnchor` pre-beta — renamed because destructured
// keys survive minification and the beta bundle must not hint at the
// unreleased venues (see js/modes/inGame.js drill-args note).
export function createMultiplayerDrill({ ballEvents, multiplayer, hooks, xr = null, scoreboardAnchor = null } = {}) {
  if (!multiplayer || !multiplayer.networkManager) {
    throw new Error('createMultiplayerDrill requires { multiplayer: { networkManager, role } }');
  }
  const endSession = (hooks && hooks.endSession) || null;
  // nm is mutable: ReconnectHandler may swap to a fresh NetworkManager after a
  // dropped connection. Closures over `nm` see the new value because `let`
  // captures the binding, not the value.
  let nm = multiplayer.networkManager;
  const { role } = multiplayer;
  const lobby = multiplayer.lobby || null;

  const sessionState = new SessionState();
  sessionState.ballOwner = role === 'host' ? 'self' : 'opponent';

  const tableCenterZ = tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0;

  // --- Match state (scoring, serve turns, game end) ---
  // Absolute side names ('host'/'guest') keep the model identical on both
  // peers; myAbs/oppAbs translate to/from this peer's perspective.
  const myAbs = role === 'host' ? 'host' : 'guest';
  const oppAbs = myAbs === 'host' ? 'guest' : 'host';
  // Match length. The HOST's choice is the room's, latched in the lobby when
  // the room was created and carried through on the connection bundle; the
  // guest has none to carry, so it opens on its own last choice and adopts
  // the host's from the first SCORE_UPDATE (matchModel.restore). Starting the
  // guest on a stored default rather than a hardcoded 5 means its scoreboard
  // is usually right immediately and, when it isn't, wrong for under a rally.
  const bestOf = normalizeBestOf(multiplayer.bestOf ?? loadBestOf());
  // First server comes from a deterministic hash of the room code — a serve
  // "toss" both peers compute identically with no extra wire traffic. The
  // old hardcoded 'host' gave the host the first serve of every match.
  const match = createMatchModel({
    bestOf,
    firstServer: firstServerFromCode(lobby && lobby.code),
  });
  // Full ITTF rulebook, shared with the AI match (js/modes/rallyRules.js).
  // Geometry is read live so service-position and obstruction tests use the
  // same table the physics does.
  const tracker = createRallyTracker({
    getGeometry: () => ({ tableBox, tableSurfaceY, centerZ: tableCenterZ, gravity: GRAVITY }),
  });
  // Net-assembly touch watcher — the one rule the ball's event stream can't
  // see. Probes the paddle face centre that PaddleSync already samples.
  const netTouchWatcher = createNetTouchWatcher({
    getProbe: () => paddleFaceCenterWorld,
    getNetBox: () => netBox,
  });
  // With the xr handle the physical toss is available (off-hand GRIP hold /
  // release); the trigger auto-toss remains the fallback path.
  const playerServe = createPlayerServeController({ xr });
  const scoreboard = createScoreboard({
    config: { bestOf, playerName: 'YOU', aiName: 'OPPONENT' },
    anchor: scoreboardAnchor,
  });
  // On-table serve cue, same as the AI match: pulsing chevrons on whichever
  // half is serving, pointing at the net. Both peers render their own half at
  // tableBox.max.z (the opponent is mirrored across tableCenterZ by
  // paddleSync), so 'player'/'opponent' is a purely LOCAL side — each client
  // shows the same serve on the half it renders that server on. Whoever
  // serves, both peers see the cue.
  const serveArrow = createServeArrow();
  // Over-net "+1" / "FOUL" flash at the moment a point is called; the
  // scoreboard and HUD log carry the detail.
  const pointBurst = createPointBurst();

  // --- Match-long stats + the end-of-match report ---
  // Same collector the AI match runs, fed from the same two places: our own
  // paddle contacts, and the shared rulebook's verdict for each point. Both
  // are available identically on either side of the wire — ball events after
  // our shot are not (ownership hands off ~1 RTT after contact), which is why
  // accuracy is derived from verdicts. See js/modes/matchStats.js.
  const statTracker = createMatchStats({ now: () => performance.now() });
  // TOTAL TIME on the board, and the duration on the report. The AI match has
  // had this since the board shipped; multiplayer's whole stats row was
  // reading 0 because nothing ever fed it.
  let matchStartMs = performance.now();
  let clockTimer = null;
  function startMatchClock() {
    stopMatchClock();
    matchStartMs = performance.now();
    if (scoreboard) scoreboard.update({ elapsedMs: 0 });
    clockTimer = setInterval(() => {
      if (scoreboard) scoreboard.update({ elapsedMs: performance.now() - matchStartMs });
    }, 1000);
  }
  function stopMatchClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  }
  startMatchClock();
  const report = createMatchReport();
  // Delay so the deciding point is still on the table when the match ends,
  // rather than a panel appearing over it instantly.
  const REPORT_DELAY_MS = 3000;
  let reportTimer = null;
  let matchDone = false;
  // Rematch handshake. Both peers must ask before either resets — see
  // PacketType.REMATCH_REQUEST. `matchEpoch` counts completed rematches and
  // fences packets from the match that just ended.
  let matchEpoch = 0;
  let localRematch = false;
  let peerRematch = false;
  let peerLeft = false;

  report.on('rematch', () => requestRematch());
  report.on('exit', () => {
    // Tell the peer before going, so a "WAITING FOR OPPONENT…" on their card
    // resolves instead of hanging on an answer that will never arrive.
    try {
      nm.sendEvent({ type: PacketType.REMATCH_REQUEST, epoch: matchEpoch, wants: false });
    } catch (err) { /* leaving anyway */ }
    // queueMicrotask: this runs inside the panel's own press handler, and
    // leaving tears the drill (and the panel) down.
    if (hooks && hooks.exitToMenu) queueMicrotask(() => hooks.exitToMenu());
  });

  // Buttons + status line, recomputed whenever either side's rematch intent
  // changes. Patch-only: the sets table and stats stay as showMatchReport
  // left them.
  function refreshReportButtons() {
    const status = peerLeft ? 'OPPONENT LEFT THE MATCH'
      : localRematch ? 'WAITING FOR OPPONENT…'
      : peerRematch ? 'OPPONENT WANTS A REMATCH' : null;
    report.setModel({
      status,
      buttons: [
        {
          id: 'rematch',
          label: localRematch ? 'REMATCH SENT' : 'REMATCH',
          tone: 'primary',
          // Asking twice does nothing (the handshake is already pending), and
          // there is nobody left to ask once the opponent has gone.
          disabled: localRematch || peerLeft,
        },
        { id: 'exit', label: 'EXIT TO MENU', tone: 'ghost' },
      ],
    });
  }

  function showMatchReport(s) {
    const sets = s.games.map((g) => ({
      player: myAbs === 'host' ? g.scoreHost : g.scoreGuest,
      opponent: myAbs === 'host' ? g.scoreGuest : g.scoreHost,
    }));
    const st = statTracker.getStats();
    report.setModel({
      playerName: 'YOU',
      opponentName: 'OPPONENT',
      playerGames: myAbs === 'host' ? s.gamesHost : s.gamesGuest,
      opponentGames: myAbs === 'host' ? s.gamesGuest : s.gamesHost,
      bestOf: s.bestOf,
      sets,
      winner: s.matchWinner === myAbs ? 'player' : 'opponent',
      durationMs: st.durationMs,
      stats: {
        accuracyPct: st.accuracyPct,
        maxSpeedKmh: st.maxSpeedKmh,
        topSpinPct: st.topSpinPct,
        totalPoints: totalPointsFromSets(sets),
      },
    });
    refreshReportButtons();
    matchDone = true;
    report.show();
  }

  // Both match-over paths (our own applyRallyEnd, and adopting the host's
  // reconciled state) come through here, so a guest that only learns the match
  // is over from a SCORE_UPDATE still gets the card — and never gets it twice.
  function scheduleMatchReport(s) {
    if (matchDone || reportTimer) return;
    statTracker.stop();
    stopMatchClock();
    reportTimer = setTimeout(() => {
      reportTimer = null;
      showMatchReport(s);
    }, REPORT_DELAY_MS);
  }

  function requestRematch() {
    if (localRematch || peerLeft) return;
    localRematch = true;
    hudLog('rematch requested — waiting for opponent');
    try {
      nm.sendEvent({ type: PacketType.REMATCH_REQUEST, epoch: matchEpoch, wants: true });
    } catch (err) {
      // A dead channel must not leave the button stuck in "sent" forever.
      localRematch = false;
      hudLog(`rematch request failed: ${err.message || err}`);
    }
    if (!(localRematch && peerRematch)) {
      refreshReportButtons();
      return;
    }
    startRematch();
  }

  // Runs on both peers off the same agreed handshake. Everything it touches is
  // derived from the shared config (matchModel.reset) or is local presentation,
  // so no snapshot exchange is needed to come back up in sync.
  function startRematch() {
    matchEpoch += 1;
    localRematch = false;
    peerRematch = false;
    peerLeft = false;
    match.reset();
    statTracker.reset();
    startMatchClock();
    if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; }
    matchDone = false;
    report.hide();
    if (scoreboard) scoreboard.setMatchOverBanner(null);
    refreshScoreUi();
    // Clean slate for the rally machinery — same shape as the reconnect path.
    // Marked decided so a swing at the previous match's dead ball can't start
    // a phantom rally before the serve window opens.
    tracker.reset();
    rallyDecided = true;
    tossLive = false;
    playerServe.disarm();
    if (serveArrow) serveArrow.hide();
    if (ballModel) ballModel.visible = false;
    hudLog(`rematch starting (match ${matchEpoch + 1})`);
    scheduleServeWindow();
  }
  let tossLive = false;             // my serve toss is airborne, not yet struck
  // A point (or let) has been called and the dead ball is still on the table
  // until openServeWindow hides it. Contacts and verdicts are ignored in that
  // window — see onPaddleHit.
  let rallyDecided = false;
  // Fires for BOTH toss paths (off-hand grip release AND trigger auto-toss),
  // so the serve UI hides here rather than in the launch() wrapper — the
  // grip-release path never goes through launch() at all.
  playerServe.onLaunch(() => {
    tossLive = true;
    if (serveArrow) serveArrow.hide();
  });

  const paddleSync = new PaddleSync(tableCenterZ);

  // Dead-reckoning integrator for the mirrored ball: the SAME
  // rollout.integrateFlightStep the owner's tickPhysics runs, plus the full
  // table-bounce response (restitution curve, spin friction, sidespin kick)
  // so a predicted ball doesn't sink through the table mid-extrapolation.
  // Adapter copies plain {x,y,z} state through scratch Vector3s because the
  // rollout primitives need real THREE math; GameStateSync stays Three-free.
  const _drPos = new THREE.Vector3();
  const _drVel = new THREE.Vector3();
  const _drSpin = new THREE.Vector3();
  const _drBounce = { x: 0, z: 0, impactSpeed: 0 };
  const flightEnv = { ballRadius, tableSurfaceY, tableBox };
  function stepFlightAdapter(pos, vel, spin, dt) {
    _drPos.set(pos.x, pos.y, pos.z);
    _drVel.set(vel.x, vel.y, vel.z);
    _drSpin.set(spin.x, spin.y, spin.z);
    integrateFlightStep(_drPos, _drVel, _drSpin, dt);
    let hit = null;
    if (isTableBounce(_drPos, _drVel, flightEnv)) {
      _drPos.y = tableSurfaceY + ballRadius;
      _drBounce.impactSpeed = applyTableBounce(_drVel, _drSpin, ballRadius);
      _drBounce.x = _drPos.x;
      _drBounce.z = _drPos.z;
      hit = _drBounce;
    }
    pos.x = _drPos.x; pos.y = _drPos.y; pos.z = _drPos.z;
    vel.x = _drVel.x; vel.y = _drVel.y; vel.z = _drVel.z;
    spin.x = _drSpin.x; spin.y = _drSpin.y; spin.z = _drSpin.z;
    return hit;
  }

  const gameSync = new GameStateSync(role === 'host' ? 'self' : 'opponent', tableCenterZ, {
    stepFlight: stepFlightAdapter,
  });

  // Render delay for the remote timeline; widened while the peer is
  // thermally throttled (see REMOTE_INTERP_DELAY_MS).
  let remoteInterpDelayMs = REMOTE_INTERP_DELAY_MS;
  // The peer's send rate halves under EITHER its thermal governor or its
  // congestion governor; both must widen our interpolation delay, and it
  // narrows again only when both have cleared.
  let peerThrottled = false;
  let peerCongested = false;
  function recomputeInterpDelay() {
    remoteInterpDelayMs = (peerThrottled || peerCongested)
      ? REMOTE_INTERP_DELAY_THROTTLED_MS
      : REMOTE_INTERP_DELAY_MS;
  }

  // --- Instant event sounds ---
  // Table bounce: played from the local mini-sim the moment the displayed
  // ball strikes the plane (synchronized with the visual by construction);
  // the wire event is only a fallback. Net hit: dual-channel with exact eid
  // dedupe (parity-partitioned counters, so peers' eids can't collide).
  let lastBounceSoundAt = -Infinity;
  function playDedupedBounce(volume) {
    const nowMs = performance.now();
    if (nowMs - lastBounceSoundAt <= BOUNCE_SOUND_DEDUPE_MS) return;
    lastBounceSoundAt = nowMs;
    playBounceSound(volume);
  }
  let netEidCounter = role === 'host' ? 0 : 1;
  const seenNetEids = [];
  function shouldPlayNetSound(eid) {
    if (typeof eid !== 'number') return true; // eid-less legacy event
    if (seenNetEids.includes(eid)) return false;
    seenNetEids.push(eid);
    if (seenNetEids.length > 8) seenNetEids.shift();
    return true;
  }

  // Optimistic-authority handoff protocol state (hit ids, pending epoch,
  // dedupe). Send closures capture the `nm` binding so a reconnect swap is
  // picked up automatically.
  const hm = new HandoffManager({
    role,
    sendReliable: (msg) => nm.sendEvent(msg),
    sendGame: (msg) => nm.sendGame(msg),
  });

  // Project an already-mirrored {pos, vel, spin} state forward by `ms`
  // (capped) through the shared integrator — used to move a handoff /
  // reconciliation snapshot from "when the sender stamped it" to "now".
  function projectDecoded(decoded, ms) {
    let remaining = Math.min(Math.max(ms || 0, 0), AUTHORITATIVE_EXTRAP_CAP_MS);
    while (remaining > 1e-3) {
      const stepMs = remaining < BALL_EXTRAP_SUBSTEP_MS ? remaining : BALL_EXTRAP_SUBSTEP_MS;
      stepFlightAdapter(decoded.pos, decoded.vel, decoded.spin, stepMs / 1000);
      remaining -= stepMs;
    }
  }

  // A handoff arrived (reliable OWNERSHIP_HANDOFF or unreliable HANDOFF_G —
  // first copy wins, HandoffManager dedupes by hitId): the opponent hit the
  // ball, it is now flying toward us, we take authority.
  function adoptHandoff(msg) {
    if (!hm.onRemoteHandoff(msg)) return; // duplicate or stale
    // Serve-window race: both peers schedule their serve windows from their
    // OWN applyRallyEnd, so the two timers start one-way-latency apart. On a
    // slow link the server can toss and strike before our (later) window
    // fires — this handoff IS that serve arriving. Open the rally state our
    // window would have set and cancel the pending timer, which would
    // otherwise fire mid-rally, hide the live ball, reset the tracker and
    // strand authority on both sides.
    if (rallyDecided) {
      if (serveTimer) { clearTimeout(serveTimer); serveTimer = null; }
      tracker.reset({ server: 'opponent' });
      rallyDecided = false;
      tossLive = false;
      playerServe.disarm();
      if (serveArrow) serveArrow.hide();
    }
    const decoded = gameSync.decodeFromWire(msg.ball);
    if (decoded && ballModel) {
      // Project by the packet's age so adoption lands on the CURRENT point
      // of the post-hit trajectory instead of teleporting to where the ball
      // was one one-way trip ago.
      const age = typeof msg.tLocal === 'number' ? performance.now() - msg.tLocal : 0;
      projectDecoded(decoded, age);
      spawnBallAt(
        new THREE.Vector3(decoded.pos.x, decoded.pos.y, decoded.pos.z),
        new THREE.Vector3(decoded.vel.x, decoded.vel.y, decoded.vel.z),
        new THREE.Vector3(decoded.spin.x, decoded.spin.y, decoded.spin.z),
      );
    }
    // Clear stale buffered remote state from before the handoff, take
    // ownership; our outbound stream (tagged h = currentHitId) is the
    // hitter's implicit ACK.
    gameSync.clear();
    gameSync.setOwner('self');
    sessionState.ballOwner = 'self';
    // Match bookkeeping: a handoff IS "the opponent struck the ball". From
    // here every bounce runs in our sim, so our tracker can decide the rally.
    //
    // Two deliberate asymmetries, both because we only integrated the ball
    // from this moment on and never saw their contact:
    //   - the returned verdict is DISCARDED. Their contact is theirs to
    //     judge (their sim has the ground-truth paddle pose), and they
    //     publish any fault of their own.
    //   - assumeServeBounced: on a slow link the handoff can arrive after
    //     their serve already bounced on their half, and we'd read a legal
    //     serve as one that skipped it. Never fault them for a bounce we
    //     might simply not have been watching for.
    tracker.registerHit('opponent', { assumeServeBounced: true });
  }

  // --- Remote paddle visual ---
  // paddleGroup acts as the "remote controller grip" equivalent. Each frame
  // we set its position to the interpolated face center, and its quaternion
  // so that paddleFaceNormalLocal rotates onto the interpolated face normal.
  const remoteGroup = new THREE.Group();
  scene.add(remoteGroup);
  let remotePaddleVisual = null;
  if (paddleModel) {
    remotePaddleVisual = paddleModel.clone(true);
    // Place the visual so its face center coincides with the group origin,
    // which is where collision treats the face center.
    remotePaddleVisual.position.copy(paddleFaceOffset).negate();
    remoteGroup.add(remotePaddleVisual);
  }

  // Pose vectors for the remote paddle VISUAL (see header note — the remote
  // paddle is not registered for collision). Updated each frame from
  // paddleSync.getRemoteFace() output.
  const aiFaceCenter   = new THREE.Vector3();
  const aiFaceNormal   = new THREE.Vector3(0, 0, 1);
  const aiFaceVelocity = new THREE.Vector3();

  // --- Network listeners ---
  function onGameMessage(packet) {
    if (!packet) return;
    if (packet.type === PacketType.PADDLE_STATE) {
      paddleSync.onRemotePacket(packet);
      return;
    }
    if (packet.type === PacketType.BALL_STATE) {
      const verdict = hm.onBallStateHid(packet.h);
      if (verdict === 'stale') return; // straggler from a previous authority epoch
      if (verdict === 'ack') {
        // The new owner's tagged stream confirms adoption of our hit — flip
        // to non-owner; this same packet then seeds the dead-reckoning sim.
        releaseBallAuthority('opponent');
      }
      if (!gameSync.isLocalOwner()) gameSync.onRemoteBallPacket(packet);
      return;
    }
    if (packet.type === PacketType.HANDOFF_G) {
      adoptHandoff(packet);
      return;
    }
    if (packet.type === PacketType.NET_HIT_G) {
      if (shouldPlayNetSound(packet.eid)) playBounceSound(0.2);
    }
  }
  function onEventMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case PacketType.OWNERSHIP_HANDOFF: {
        adoptHandoff(msg);
        break;
      }
      case PacketType.TABLE_BOUNCE: playDedupedBounce(msg.volume ?? 0.5); break;
      case PacketType.NET_HIT: {
        if (shouldPlayNetSound(msg.eid)) playBounceSound(0.2);
        break;
      }
      case PacketType.BALL_LOST: {
        if (ballModel) ballModel.visible = false;
        // The owner observed the loss. Hide the mirrored ball and drop any
        // buffered remote state; the rally verdict + next serve arrive via
        // the owner's RALLY_END (sent just after this message, same ordered
        // channel).
        releaseBallAuthority(match.getState().currentServer === myAbs ? 'self' : 'opponent');
        break;
      }
      case PacketType.RALLY_END: {
        // Only apply a verdict for the rally we're currently in — a stale or
        // duplicated verdict (both sides deciding the same rally in a race)
        // arrives with a rallySeq that no longer matches and is dropped.
        // Named rallySeq (not seq): sendEvent stamps the transport sequence
        // number into `seq` in place, which would clobber this field.
        if (typeof msg.rallySeq === 'number' && msg.rallySeq !== match.getState().rallySeq) break;
        applyRallyEnd(msg.winner || null, msg.reason || 'remote', msg.detail || null, msg.foul || null);
        break;
      }
      case PacketType.RECONCILIATION: {
        const decoded = gameSync.decodeFromWire(msg.ball);
        if (decoded && !gameSync.isLocalOwner()) {
          // Only the owner's reconciliation packets are authoritative. Feed
          // through the projection + blend path instead of a hard spawnBallAt
          // snap — the 60 Hz stream keeps the mini-sim continuously
          // corrected, so this mainly guards seq stalls and loss bursts.
          gameSync.applyAuthoritative(decoded, msg.tLocal, performance.now());
        }
        break;
      }
      case PacketType.THERMAL_STATE: {
        hudLog(`peer thermal: ${msg.throttled ? 'THROTTLED' : 'ok'}`);
        // Peer's send rate halves to 30 Hz while throttled — widen the
        // interpolation delay so we still bracket between two packets.
        peerThrottled = !!msg.throttled;
        recomputeInterpDelay();
        break;
      }
      case PacketType.CONGESTION_STATE: {
        hudLog(`peer congestion: ${msg.congested ? 'backing off' : 'clear'}`);
        // Same physics as the thermal path: their packet spacing doubled, so
        // our jitter buffer must look further back or their paddle freezes
        // at extrapolation's 50 ms cap exactly when we're reading a swing.
        peerCongested = !!msg.congested;
        recomputeInterpDelay();
        break;
      }
      case PacketType.SCORE_UPDATE: {
        // Host-authoritative score reconciliation. Crossed rally verdicts
        // (both peers deciding the same rally in a race) are DROPPED by the
        // rallySeq dedupe, which prevented double-counting but let the two
        // scoreboards diverge permanently — each peer kept its own verdict
        // and nothing ever reconciled them. The host's serialized match
        // state is the tie-break: the guest adopts whenever the host is
        // ahead, or level on rallySeq with different state. Not a cheat
        // defence (nothing peer-to-peer is) — a divergence repair.
        if (role === 'host' || !msg.match) break;
        // Epoch fence: a snapshot of the match we just agreed to replay would
        // otherwise restore the finished score straight over the fresh one.
        if ((msg.epoch | 0) !== matchEpoch) break;
        const snap = msg.match;
        const local = match.getState();
        if (typeof snap.rallySeq !== 'number') break;
        if (snap.rallySeq < local.rallySeq) break;   // we're ahead; host will catch up
        const differs = JSON.stringify(match.serialize()) !== JSON.stringify(snap);
        if (!differs) break;
        match.restore(snap);
        refreshScoreUi();
        // The host's snapshot carries the room's match length as well as its
        // score, so this is also where a guest finds out it joined a
        // best-of-3. Announced separately — "score reconciled" would be a
        // strange way to tell somebody the match got shorter.
        if (local.bestOf !== match.getState().bestOf) {
          hudLog(`match length: ${matchLengthLabel(match.getState().bestOf)} (set by the host)`);
        }
        hudLog(`score reconciled from host (rally ${snap.rallySeq})`);
        const s = match.getState();
        if (s.matchOver) {
          const myGames = myAbs === 'host' ? s.gamesHost : s.gamesGuest;
          const oppGames = myAbs === 'host' ? s.gamesGuest : s.gamesHost;
          if (scoreboard) {
            scoreboard.setMatchOverBanner(
              s.matchWinner === myAbs
                ? `YOU WIN THE MATCH ${myGames}-${oppGames}`
                : `OPPONENT WINS THE MATCH ${oppGames}-${myGames}`,
            );
          }
          // Reconciliation is the only way a peer whose own verdict was
          // dropped learns the match is over — so the card is raised here too.
          scheduleMatchReport(s);
        }
        break;
      }
      case PacketType.REMATCH_REQUEST: {
        // Stale epoch = intent about a match that has already been replayed.
        if ((msg.epoch | 0) !== matchEpoch) break;
        // Absent `wants` = a peer on the pre-decline build; treat as "yes",
        // which is what the field originally meant.
        if (msg.wants === false) {
          if (peerLeft) break;
          peerLeft = true;
          peerRematch = false;
          hudLog('opponent left the match');
          if (matchDone) refreshReportButtons();
          break;
        }
        if (peerRematch) break;
        peerRematch = true;
        hudLog('opponent wants a rematch');
        if (localRematch) startRematch();
        else if (matchDone) refreshReportButtons();
        break;
      }
      case PacketType.PLAYER_PAUSED: {
        hudLog(`peer ${msg.paused ? 'paused' : 'resumed'}`);
        break;
      }
      case PacketType.GAME_READY: {
        // "I'm in the match now." The two peers enter XR independently — the
        // host can be serving before the guest has left the start screen — so
        // the host answers with its match state instead of leaving the guest
        // to wait up to a full heartbeat (SCORE_SYNC_INTERVAL_S) to find out
        // the room's match length. Everything about the reply is idempotent.
        if (role !== 'host') break;
        nm.sendEvent({ type: PacketType.SCORE_UPDATE, match: match.serialize(), epoch: matchEpoch });
        break;
      }
      case PacketType.RECONNECT_RESTORE: {
        // Spec: after reconnect both peers exchange snapshots and the one
        // with higher seq wins. v1 picks a simpler authority — the HOST's
        // snapshot is ground truth. Host ignores incoming; guest adopts and
        // inverts the perspective fields (their 'self' is our 'opponent').
        if (role === 'host' || !msg.snapshot) {
          hudLog(`peer restored (ack): ${JSON.stringify(msg.snapshot || {})}`);
          break;
        }
        const snap = msg.snapshot;
        const invertedOwner = snap.ballOwner === 'self' ? 'opponent'
                            : snap.ballOwner === 'opponent' ? 'self'
                            : null;
        if (invertedOwner) {
          gameSync.setOwner(invertedOwner);
          sessionState.ballOwner = invertedOwner;
        }
        // Score is symmetric: their scoreSelf is our scoreOpponent.
        sessionState.scoreOpponent = snap.scoreSelf | 0;
        sessionState.scoreSelf     = snap.scoreOpponent | 0;
        sessionState.rallyCount    = snap.rallyCount | 0;
        // Match snapshot uses absolute host/guest sides — no inversion needed.
        if (snap.match) {
          match.restore(snap.match);
          refreshScoreUi();
          // The outage voided any in-flight rally; restart from a clean serve.
          // Marked decided so a swing at the orphaned ball can't start a
          // phantom rally before the serve window reopens.
          tracker.reset();
          rallyDecided = true;
          tossLive = false;
          playerServe.disarm();
          if (serveArrow) serveArrow.hide();
          if (!match.getState().gameOver) scheduleServeWindow();
        }
        hudLog(`restored from host: owner=${invertedOwner}  rally=${sessionState.rallyCount}`);
        break;
      }
    }
  }

  // Give up ball authority: stop draining the (now stale) outbound ball
  // packet, drop buffered remote packets from before the flip, and record the
  // new owner. Clearing outboundState.ball here is load-bearing — the send
  // loop retransmits whatever sits in that slot at 60 Hz, so leaving the last
  // pre-flip state there makes the peer see the ball hang at the old position
  // until the handoff lands, then teleport.
  function releaseBallAuthority(nextOwner) {
    nm.outboundState.ball = null;
    gameSync.clear();
    gameSync.setOwner(nextOwner);
    sessionState.ballOwner = nextOwner;
  }

  // --- Ball event subscriptions ---
  // Local-player paddle hits trigger ownership handoff: I just hit the ball,
  // it's now flying toward the opponent. OPTIMISTIC AUTHORITY: keep
  // simulating locally (the shot leaves the paddle exactly like
  // single-player — never overwritten by a stale remote stream) until the
  // new owner's hid-tagged BALL_STATE confirms adoption; only then flip to
  // non-owner. See network/HandoffManager.js for the protocol.
  function onPaddleHit(info) {
    if (!info || info.origin !== 'player') return;
    if (!ballModel) return;
    // Swings at a ball whose point is already decided are not play. The
    // corpse stays visible until the next serve window opens 2.5s later, and
    // a reflex return of a let (which the player has no way to know was a
    // let) must not restart the rally or read as an obstruction.
    if (rallyDecided) return;
    // Report stats: our own contacts are the one shot-level signal that is
    // just as reliable online as offline (the ball itself leaves our
    // authority a moment later).
    statTracker.recordShot({ outSpeed: info.outSpeed, spinType: info.spinType });
    hm.localHit(gameSync.encodeForWire(ballModel.position, ballVelocity, ballAngularVelocity));
    // Keep (or grab — an early swing at a still-incoming dead-reckoned ball
    // can fire before we adopted the opponent's handoff) full authority for
    // the pending window. Drop any buffered remote state: our local sim is
    // the sole source of truth until the ACK.
    gameSync.clear();
    gameSync.setOwner('self');
    sessionState.ballOwner = 'self';
    // Match bookkeeping: our strike (serve or return) starts/continues the
    // rally. It can also END it on the spot — an illegal volley, a double
    // hit, or a serve struck from over the table. Only the ball owner may
    // publish a verdict; during a handoff the adopting peer sees the same
    // contact and issues it from their side.
    const verdict = tracker.registerHit('self', {
      contactPos: info.contactPos, inVel: info.inVel,
    });
    tossLive = false;
    // Serve struck (or rally shot) — the "serve toward the net" cue has done
    // its job. launch() already hides it on the toss; this covers the case
    // where the strike lands first (fast toss-and-hit).
    if (serveArrow) serveArrow.hide();
    // Our own fault: we're the authority on our own paddle, so publish it
    // even mid-handoff — the opponent's sim never saw our contact.
    applyVerdictLocal(verdict);
  }
  // While our handoff is pending, exactly one authority may emit wire events
  // — the new owner. Local sounds/haptics already fired inside ball.js, so
  // suppressing the wire send loses nothing on our side, and the adopting
  // peer's own sim produces the bounce/net events locally.
  function onTableBounce(info) {
    // Bounce events only fire while our sim integrates the ball (owner or
    // pending hitter), so the tracker sees exactly the flight we're
    // authoritative for.
    const verdict = tracker.registerBounce(info.z, info.x);
    if (!gameSync.isLocalOwner() || hm.isPending()) return;
    nm.sendEvent({ type: PacketType.TABLE_BOUNCE, x: info.x, z: info.z, volume: 0.5 });
    // Where the ball lands is what ends rallies: a double bounce on the
    // receiver's side, a return that came down on the hitter's own half, an
    // illegal serve — or a cord serve that still landed good, which is a let.
    applyVerdictLocal(verdict);
  }
  function onNetHit(info) {
    if (!gameSync.isLocalOwner() || hm.isPending()) return;
    // Dual-channel: unreliable copy lands one one-way trip sooner; reliable
    // copy guarantees delivery. Receiver dedupes by eid.
    netEidCounter += 2;
    nm.sendGame({ type: PacketType.NET_HIT_G, eid: netEidCounter, axis: info.axis });
    nm.sendEvent({ type: PacketType.NET_HIT, eid: netEidCounter, axis: info.axis });
    // A net contact is NOT a point. This used to end the rally with "last
    // hitter loses", which is not an ITTF rule and contradicted the AI match:
    // a cord ball may dribble over and play on, and where it comes down
    // decides. Recorded only so a cord SERVE that lands good becomes a let.
    tracker.registerNetHit();
  }
  function onBallLost(info) {
    if (!gameSync.isLocalOwner()) return;
    if (hm.isPending()) {
      // Our post-hit sim lost the ball inside the pending window. Divergence
      // is possible here — the adopting owner's sim is authoritative — so
      // don't declare the rally over; just complete the flip and let the
      // owner's stream (or their BALL_LOST) decide.
      hm.cancelPending();
      releaseBallAuthority('opponent');
      return;
    }
    nm.sendEvent({ type: PacketType.BALL_LOST, reason: info.reason });
    // Stop retransmitting the dead ball's final state.
    nm.outboundState.ball = null;
    if (tossLive && !tracker.isActive()) {
      // Serve toss whiffed before the strike — re-offer the serve, no point.
      finishRallyLocal(null, 'serveTossLost');
    } else if (tracker.isActive()) {
      // A live rally always yields a verdict here (someone struck the ball,
      // so someone owns the miss). Void it rather than hang the match if the
      // rulebook ever has nothing to say.
      if (!applyVerdictLocal(tracker.decideBallLost())) {
        finishRallyLocal(null, 'ballLost');
      }
    }
    // else: leftover ball from an already-decided rally (netHit/doubleBounce
    // verdict) — the serve window is already scheduled; nothing to score.
  }
  ballEvents.onPaddleHit(onPaddleHit);
  ballEvents.onTableBounce(onTableBounce);
  ballEvents.onNetHit(onNetHit);
  ballEvents.onBallLost(onBallLost);

  // --- Serve turns + rally end (match-driven) ---
  // The shared match model says whose serve it is; both peers run identical
  // deterministic transitions, so they always agree. When the serve window
  // opens, the server takes ball authority and arms a trigger toss (same
  // press-trigger-to-toss controller the AI match uses); the receiver
  // releases authority and waits for BALL_STATE packets. The serve strike is
  // an ordinary paddle hit — the existing handoff protocol takes over.
  let serveTimer = null;
  // Break between games — long enough to read the game banner and reset,
  // short enough that a 2-player session doesn't stall. (ITTF allows up to
  // a minute; nobody wants that in a headset.)
  const GAME_BREAK_MS = 6000;
  function scheduleServeWindow(delayMs = NEXT_SERVE_DELAY_MS) {
    if (serveTimer) clearTimeout(serveTimer);
    serveTimer = setTimeout(() => {
      serveTimer = null;
      openServeWindow();
    }, delayMs);
  }
  function openServeWindow() {
    if (match.getState().gameOver) return;
    // Backstop for the serve-window race (see adoptHandoff): if a rally is
    // already live — the opponent's serve beat this timer — opening the
    // window now would hide the live ball and reset the rulebook mid-point.
    if (!rallyDecided && tracker.isActive()) return;
    // A between-games banner ("GAME 2: 11-7") stays up through the game
    // break; the next game's first serve clears it.
    if (scoreboard) scoreboard.setMatchOverBanner(null);
    // Retire the previous rally's ball on both sides BEFORE authority flips —
    // a dead ball still rolling in the ex-owner's sim would freeze mid-air
    // the moment tickPhysics stops integrating for the new non-owner.
    if (ballModel) ballModel.visible = false;
    const iServe = match.getState().currentServer === myAbs;
    // Tell the rulebook whose serve this is — the service-position and
    // first-bounce rules key off it.
    tracker.reset({ server: iServe ? 'self' : 'opponent' });
    rallyDecided = false;
    tossLive = false;
    if (iServe) {
      releaseBallAuthority('self');
      playerServe.arm();
      if (serveArrow) serveArrow.show('player');
    } else {
      releaseBallAuthority('opponent');
      // Receiving: the cue goes on THEIR half so this peer can still read
      // whose serve it is. It clears the moment their ball goes live (see
      // the dead-reckoning branch in update()).
      if (serveArrow) serveArrow.show('opponent');
    }
  }

  // Push the current match state onto the scoreboard + session snapshot.
  function refreshScoreUi() {
    const s = match.getState();
    sessionState.scoreSelf = myAbs === 'host' ? s.scoreHost : s.scoreGuest;
    sessionState.scoreOpponent = myAbs === 'host' ? s.scoreGuest : s.scoreHost;
    sessionState.rallyCount = s.rallySeq;
    if (scoreboard) {
      const st = statTracker.getStats();
      scoreboard.update({
        shotsHit: st.shots,
        topSpeedKmh: st.maxSpeedKmh,
        playerScore: sessionState.scoreSelf,
        aiScore: sessionState.scoreOpponent,
        playerGames: myAbs === 'host' ? s.gamesHost : s.gamesGuest,
        aiGames: myAbs === 'host' ? s.gamesGuest : s.gamesHost,
        bestOf: s.bestOf,
        // Layout convention: per-game history rows are { playerScore, aiScore }
        // in the LOCAL perspective.
        gameHistory: s.games.map((g) => ({
          playerScore: myAbs === 'host' ? g.scoreHost : g.scoreGuest,
          aiScore: myAbs === 'host' ? g.scoreGuest : g.scoreHost,
        })),
        currentServer: s.currentServer === myAbs ? 'player' : 'ai',
      });
    }
  }

  // Turn a rulebook verdict into a rally end. Returns true if it ended one.
  // A let carries no winner: same server replays, nobody scores.
  function applyVerdictLocal(verdict) {
    if (!verdict || rallyDecided) return false;
    if (verdict.let) {
      finishRallyLocal(null, 'let');
      return true;
    }
    finishRallyLocal(verdict.winner, verdict.reason, verdict.detail, verdict.foul);
    return true;
  }

  // The ball owner decided the rally: broadcast the verdict (rallySeq =
  // pre-apply rally counter for dedupe), then run the same transition locally.
  // `foul` travels as an absolute side so each peer can work out whether the
  // offender was them (and show the corrective coaching) or the opponent.
  function finishRallyLocal(winnerLocal, reason, detail = null, foulLocal = null) {
    const toAbs = (side) => (side === 'self' ? myAbs : side === 'opponent' ? oppAbs : null);
    const winnerAbs = toAbs(winnerLocal);
    nm.sendEvent({
      type: PacketType.RALLY_END,
      rallySeq: match.getState().rallySeq,
      winner: winnerAbs,
      reason,
      detail,
      foul: toAbs(foulLocal),
    });
    applyRallyEnd(winnerAbs, reason, detail, toAbs(foulLocal));
  }

  // Shared transition — runs on the deciding peer right after sending
  // RALLY_END and on the other peer when the message arrives. Identical
  // inputs (absolute winner) + identical model = identical resulting state.
  function applyRallyEnd(winnerAbs, reason, detail = null, foulAbs = null) {
    const s = match.applyRallyEnd(winnerAbs);
    // Host broadcasts its post-transition state after every rally (plus a
    // periodic heartbeat in update()) — the reconciliation half of the
    // crossed-verdict story; see the SCORE_UPDATE receive handler.
    if (role === 'host') {
      nm.sendEvent({ type: PacketType.SCORE_UPDATE, match: match.serialize(), epoch: matchEpoch });
    }
    // The rally is over but the ball is still on the table until the serve
    // window opens. Nothing that happens to it from here counts.
    rallyDecided = true;
    tracker.reset();
    tossLive = false;
    playerServe.disarm();
    // Rally's over — the serve window is closed until openServeWindow()
    // reopens it, so the on-table cue must not survive into the READY window
    // (covers a whiffed toss, where no paddle hit ever fired).
    if (serveArrow) serveArrow.hide();
    // Accuracy for the end-of-match card. Runs on both peers (this whole
    // function does), from the same verdict, so the two cards agree about who
    // put the ball out. Lets carry no winner and are not judged.
    if (winnerAbs) {
      statTracker.recordPoint({
        loser: winnerAbs === myAbs ? 'opponent' : 'player',
        reason,
        detail,
      });
    }
    refreshScoreUi();
    if (winnerAbs) {
      hudLog(`point ${winnerAbs === myAbs ? 'YOU' : 'OPPONENT'} (${reason})  ${sessionState.scoreSelf}-${sessionState.scoreOpponent}`);
      // Instant over-net flash where the point just happened (skipped for
      // lets — nobody scored). Fires on the deciding peer and, via
      // RALLY_END, on the other peer too.
      if (pointBurst) {
        pointBurst.burst({
          winner: winnerAbs === myAbs ? 'player' : 'ai',
          foul: foulAbs ? (foulAbs === myAbs ? 'player' : 'ai') : null,
        });
      }
    } else if (reason === 'let') {
      hudLog('LET — net-cord serve landed good, replay');
    }
    // A fault of ours gets the umpire treatment: the whistle buzz on the
    // paddle hand at the moment it's called, and the rule spelled out in the
    // log.
    if (foulAbs && foulAbs === myAbs) {
      pulseFoul();
      playFoulWhistle();
      hudLog(`[FOUL] ${faultRuleText(reason, detail)}`);
    }
    if (s.matchOver) {
      const myGames = myAbs === 'host' ? s.gamesHost : s.gamesGuest;
      const oppGames = myAbs === 'host' ? s.gamesGuest : s.gamesHost;
      if (scoreboard) {
        scoreboard.setMatchOverBanner(
          s.matchWinner === myAbs
            ? `YOU WIN THE MATCH ${myGames}-${oppGames}`
            : `OPPONENT WINS THE MATCH ${oppGames}-${myGames}`,
        );
      }
      hudLog(`match over: ${s.matchWinner === myAbs ? 'you win' : 'opponent wins'} ${myGames}-${oppGames}`);
      scheduleMatchReport(s);
      return;
    }
    if (s.gameJustEnded) {
      // A game ended mid-match: banner it through the break, then the next
      // game's serve window (openServeWindow) clears the banner.
      const g = s.gameJustEnded;
      const my = myAbs === 'host' ? g.scoreHost : g.scoreGuest;
      const opp = myAbs === 'host' ? g.scoreGuest : g.scoreHost;
      const n = s.games.length;
      if (scoreboard) {
        scoreboard.setMatchOverBanner(
          g.winner === myAbs
            ? `GAME ${n} TO YOU  ${my}-${opp}`
            : `GAME ${n} TO OPPONENT  ${opp}-${my}`,
        );
      }
      hudLog(`game ${n} over: ${g.winner === myAbs ? 'you' : 'opponent'} ${my}-${opp}`);
      scheduleServeWindow(GAME_BREAK_MS);
      return;
    }
    scheduleServeWindow();
  }

  // Initial serve on entry: host serves first, both peers arrive at the same
  // conclusion from the shared model — no wire coordination needed.
  refreshScoreUi();
  scheduleServeWindow();

  // --- Telemetry: pc.getStats() every 2 s → POST to telemetry server ---
  // Reassigned on reconnect (new pc).
  let telemetry = null;
  function startTelemetry() {
    if (telemetry) telemetry.stop();
    telemetry = nm.pc
      ? new TelemetryReporter({
          pc: nm.pc,
          serverUrl: TELEMETRY_URL,
          sessionId: `${role}-${Date.now().toString(36)}`,
          clock: nm.clock,
          // The objective definition of "feels like no latency": snaps → 0,
          // correction p95 < 3 cm, adoption ≈ one RTT.
          extraMetrics: () => {
            const { ballCorrectionP95, snaps } = gameSync.takeCorrectionStats();
            return {
              ballCorrectionP95,
              // 2 s sample window → per-minute rate.
              snapsPerMinute: snaps * 30,
              handoffAdoptMs: hm.lastAdoptMs,
            };
          },
        })
      : null;
    if (telemetry) telemetry.start();
  }

  // Wire all the connection-bound side-effects: incoming-message handlers,
  // send loop, telemetry. Called once on entry; called again after each
  // successful reconnect against the new NetworkManager.
  function wireConnection() {
    nm.on('gameMessage', onGameMessage);
    nm.on('eventMessage', onEventMessage);
    // Congestion governor transitions. NetworkManager halves/restores the
    // send rate itself; we log for operator visibility AND tell the peer —
    // like the thermal path — so it widens its interpolation delay to match
    // our doubled packet spacing instead of under-running its jitter buffer.
    nm.on('congestion', ({ congested, bufferedBytes, queuingDelayMs }) => {
      hudLog(congested
        ? `net congestion: backing off (buffered=${bufferedBytes}B queue=${queuingDelayMs === null ? '?' : queuingDelayMs.toFixed(0)}ms)`
        : 'net congestion: clear — rate restored');
      nm.sendEvent({ type: PacketType.CONGESTION_STATE, congested: !!congested });
    });
    nm.startSendLoop(60);
    startTelemetry();
    // Announce arrival AFTER the handlers are attached, so the host's reply
    // (see the GAME_READY case) cannot land before we can hear it. Sent on
    // reconnect too — the peer's answer costs one packet and re-agreeing the
    // format after an outage is exactly what we want.
    try {
      nm.sendEvent({ type: PacketType.GAME_READY, role });
    } catch (err) { /* a channel that can't take this will surface elsewhere */ }
    // The host answers guests that arrive later; this covers the opposite
    // order, where the guest was already waiting when we got here.
    if (role === 'host') {
      try {
        nm.sendEvent({ type: PacketType.SCORE_UPDATE, match: match.serialize(), epoch: matchEpoch });
      } catch (err) { /* heartbeat in update() will repeat it */ }
    }
  }
  wireConnection();

  // --- Thermal: halve send rate + notify peer when CPU dt creeps up ---
  // Listener captures `nm` by reference (the `let`), so it follows a swap.
  ThermalMonitor.reset();
  const removeThermalListener = ThermalMonitor.onChange(({ throttled, avgFrameMs }) => {
    const rate = throttled ? 30 : 60;
    nm.setSendRate(rate);
    nm.sendEvent({ type: PacketType.THERMAL_STATE, throttled, avgFrameMs });
    hudLog(`thermal: ${throttled ? 'THROTTLED' : 'ok'}  rate=${rate}Hz  avg=${avgFrameMs.toFixed(1)}ms`);
  });

  // --- Page Visibility: pause notification on tab background / unfocus ---
  function onVisibilityChange() {
    const paused = document.hidden;
    nm.sendEvent({ type: PacketType.PLAYER_PAUSED, paused });
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  // --- Reconnect handler. Without a lobby reference we can't re-signal, so
  // we only detect failures and notify; with one we attempt re-negotiation.
  let reconnect = null;
  if (lobby) {
    reconnect = new ReconnectHandler({ lobby, sessionState });
    reconnect.watch(nm);
    reconnect.on('attempting', ({ attempt }) => hudLog(`reconnecting #${attempt}…`));
    reconnect.on('reconnected', ({ networkManager: newNm }) => {
      hudLog('reconnected');
      // Old nm is torn down by lobby.reconnect() — its listeners are dead, no
      // explicit removal needed. Swap in the new manager and re-wire.
      if (telemetry) telemetry.stop();
      // Seq counters reset on the new NetworkManager — drop buffered packets
      // and lastSeq so the first new packet doesn't get rejected as old.
      // A handoff pending across the outage is unresolvable — the host's
      // RECONNECT_RESTORE snapshot re-establishes ownership instead.
      hm.cancelPending();
      paddleSync.clear();
      gameSync.clear();
      // Carry the clock offset so timestamp translation doesn't regress to
      // arrival-time fallback for the first ping interval.
      if (nm.clock && nm.clock.isReady() && newNm.clock) newNm.clock.seed(nm.clock.offset);
      nm = newNm;
      wireConnection();
      reconnect.watch(nm);
      // Match snapshot rides along in absolute host/guest sides; the guest
      // adopts it verbatim (host is ground truth after an outage).
      nm.sendEvent({
        type: PacketType.RECONNECT_RESTORE,
        snapshot: { ...sessionState.serialize(), match: match.serialize() },
      });
      // The outage voided any in-flight rally on this side too — restart
      // from a clean serve window (no point awarded).
      tracker.reset();
      rallyDecided = true;
      tossLive = false;
      playerServe.disarm();
      if (serveArrow) serveArrow.hide();
      if (!match.getState().gameOver) scheduleServeWindow();
    });
    reconnect.on('failed', ({ attempts }) => {
      hudLog(`reconnect failed after ${attempts} attempts — ending session`);
      // Permanently lost: drop the user back to the overlay rather than
      // leaving them stuck in XR with a dead peer.
      if (endSession) setTimeout(() => endSession(), 2000);
    });
  } else {
    nm.on('disconnected', (info) => hudLog(`peer disconnected (${info.state || '?'})`));
    nm.on('iceFailed', () => hudLog('ICE failed — no lobby to retry'));
  }

  // Initial send-loop kickoff happens inside wireConnection().

  // --- Per-frame update (called by inGame.js before tickPhysics) ---
  let reconcilAccum = 0;
  let scoreSyncAccum = 0;
  const SCORE_SYNC_INTERVAL_S = 5;
  // Silent-peer watchdog state — see 0e below.
  let peerSilentWarned = false;
  const PEER_SILENT_WARN_MS = 3000;
  const tmpQuat = new THREE.Quaternion();
  const tmpRemoteDelta = new THREE.Vector3();
  function update(dt) {
    // 0. Thermal sampling — runs every frame, only fires listeners on state change.
    ThermalMonitor.tick();

    // 0b. Handoff ACK timeout fallback: a loss burst ate the tagged stream —
    // flip anyway (the reliable handoff copy guarantees eventual adoption).
    if (hm.tick(performance.now())) {
      releaseBallAuthority('opponent');
    }

    // 0c. Feed measured one-way latency into the ball projection cap so slow
    // links dead-reckon to "now" instead of lagging by (packet age − cap),
    // and scale the handoff ACK timeout to the same measured link — a fixed
    // window fires on every shot once RTT exceeds it.
    if (nm.clock) {
      gameSync.setLatencyMs(nm.clock.oneWayMs());
      const rtt = nm.clock.smoothedRttMs && nm.clock.smoothedRttMs();
      if (rtt !== null && rtt !== undefined) hm.setAckTimeoutMs(rtt * 1.5 + 100);
    }

    // 0d. Host score heartbeat — repairs any divergence RALLY_END racing
    // left behind, even if the immediate post-rally SCORE_UPDATE was lost.
    if (role === 'host') {
      scoreSyncAccum += dt;
      if (scoreSyncAccum >= SCORE_SYNC_INTERVAL_S) {
        scoreSyncAccum = 0;
        nm.sendEvent({ type: PacketType.SCORE_UPDATE, match: match.serialize(), epoch: matchEpoch });
      }
    }

    // 0e. Silent-peer watchdog. Pings run at 4 Hz, so seconds without a pong
    // means the peer is gone (dead tab, slept headset) even while the
    // RTCPeerConnection still reports 'connected'. Surface it — a silent
    // freeze with no message reads as "the game broke", not "they left".
    // The transport-level grace timer in NetworkManager handles the actual
    // disconnect escalation; this is the early human-facing signal.
    if (nm.clock && nm.clock.msSinceLastPong) {
      const silentMs = nm.clock.msSinceLastPong(performance.now());
      if (silentMs !== null && silentMs > PEER_SILENT_WARN_MS) {
        if (!peerSilentWarned) {
          peerSilentWarned = true;
          hudLog(`opponent not responding (${(silentMs / 1000).toFixed(0)}s) — connection unstable`);
        }
      } else if (peerSilentWarned && silentMs !== null && silentMs < 1000) {
        peerSilentWarned = false;
        hudLog('opponent connection recovered');
      }
    }

    // 1. Sample local paddle face → outbound paddle packet.
    paddleSync.writeLocal(nm.outboundState, paddleFaceCenterWorld, paddleFaceNormalWorld, paddleVelocity);

    // 1b. ITTF Law 2.10 — touching the net assembly while the ball is in
    // play. Each peer is the only authority on where its own paddle is, so
    // we call our own and publish it like any other verdict. Guarded on an
    // undecided, active rally.
    if (!rallyDecided && tracker.isActive() && netTouchWatcher.update()) {
      applyVerdictLocal(tracker.registerNetTouch('self'));
    }

    // 2. If owner, sample local ball → outbound ball packet.
    //    If non-owner, overwrite local ball state with interpolated remote.
    if (gameSync.isLocalOwner()) {
      if (ballModel && ballModel.visible) {
        gameSync.writeLocal(nm.outboundState, ballModel.position, ballVelocity, ballAngularVelocity, hm.currentHitId);
      } else {
        nm.outboundState.ball = null;
      }
      // 5s reconciliation snapshot on the reliable channel.
      reconcilAccum += dt;
      if (reconcilAccum >= RECONCILIATION_INTERVAL_S && ballModel && ballModel.visible) {
        reconcilAccum = 0;
        nm.sendEvent({
          type: PacketType.RECONCILIATION,
          ball: gameSync.encodeForWire(ballModel.position, ballVelocity, ballAngularVelocity),
        });
      }
    } else {
      // Dead reckoning: the mini-sim projects received state forward by its
      // age, so the ball is where physics says it is NOW — not one-way
      // latency in the past. No interp delay here (that's paddle-only).
      const dr = gameSync.getDeadReckonedBallState(performance.now(), dt);
      if (dr && ballModel) {
        ballModel.position.set(dr.pos.x, dr.pos.y, dr.pos.z);
        ballVelocity.set(dr.vel.x, dr.vel.y, dr.vel.z);
        ballAngularVelocity.set(dr.spin.x, dr.spin.y, dr.spin.z);
        ballModel.visible = true;
        // Their ball is airborne, so their serve cue has done its job — this
        // is the receiver's mirror of the server hiding on its own toss
        // (playerServe.onLaunch). hide() is a no-op once faded, so calling it
        // every rally frame costs nothing.
        if (serveArrow) serveArrow.hide();
        // Locally predicted table bounce: zero network latency, synchronized
        // with the visual by construction. Same intensity curve as ball.js;
        // the wire TABLE_BOUNCE fallback dedupes against this.
        if (gameSync.lastBounce) {
          playDedupedBounce(Math.min(gameSync.lastBounce.impactSpeed / 5, 1.0));
        }
      }
    }

    // 3. Update remote paddle visual + collision face.
    const rf = paddleSync.getRemoteFace(performance.now() - remoteInterpDelayMs);
    aiFaceCenter.set(rf.center.x, rf.center.y, rf.center.z);
    aiFaceNormal.set(rf.normal.x, rf.normal.y, rf.normal.z).normalize();
    aiFaceVelocity.set(rf.velocity.x, rf.velocity.y, rf.velocity.z);

    // Interpolated remote pose can put the paddle inside the table (packet
    // loss, high jitter, or the remote peer's own clamp being weaker than
    // ours). Push it out here so both the visual and the collision face
    // stay above/outside the felt.
    if (tableBox) {
      resolvePaddleTablePenetration(
        aiFaceCenter, aiFaceNormal,
        paddleHitRadius, paddleHalfThickness,
        tableBox, tmpRemoteDelta,
      );
      aiFaceCenter.add(tmpRemoteDelta);
    }

    remoteGroup.position.copy(aiFaceCenter);
    tmpQuat.setFromUnitVectors(paddleFaceNormalLocal, aiFaceNormal);
    remoteGroup.quaternion.copy(tmpQuat);

    // 4. Serve/score UI.
    // Off-hand grip poll for the physical serve toss — only does work while
    // this peer is armed to serve or mid-hold.
    playerServe.update(dt);
    // Drives the arrow's fade ramp, opacity pulse and chevron UV scroll —
    // without this call the mesh never becomes visible at all.
    if (serveArrow) serveArrow.update(dt);
    if (pointBurst) pointBurst.update(dt);
  }

  // Pending counts as owning: tickPhysics must keep integrating our post-hit
  // ball until the ACK flips us (gameSync stays owner='self' through the
  // pending window, so the || is belt-and-braces).
  function isLocalOwner() { return gameSync.isLocalOwner() || hm.isPending(); }
  function isFinished() { return false; }
  // Trigger pull routed from inGame.js — spawns the auto-toss when armed
  // (i.e. it's our serve and the window is open); no-op otherwise, including
  // while the ball is held in the off-hand. UI hiding lives in the
  // playerServe.onLaunch subscription above (covers both toss paths).
  function launch() {
    return playerServe.launch();
  }
  function liveLine() {
    const s = match.getState();
    const my = myAbs === 'host' ? s.scoreHost : s.scoreGuest;
    const opp = myAbs === 'host' ? s.scoreGuest : s.scoreHost;
    if (s.gameOver) {
      return `Multiplayer — ${s.gameWinner === myAbs ? 'YOU WIN' : 'OPPONENT WINS'}  ${my}-${opp}`;
    }
    const own = isLocalOwner() ? (hm.isPending() ? 'OWN*' : 'OWN') : 'OPP';
    const serve = s.currentServer === myAbs ? 'your serve' : 'opponent serves';
    return `Multiplayer ${my}-${opp}  ${serve}  ball=${own}`;
  }
  function dispose() {
    if (serveTimer) clearTimeout(serveTimer);
    if (reportTimer) clearTimeout(reportTimer);
    stopMatchClock();
    report.dispose();
    if (remotePaddleVisual) remoteGroup.remove(remotePaddleVisual);
    scene.remove(remoteGroup);
    if (nm) nm.stopSendLoop();
    if (removeThermalListener) removeThermalListener();
    if (telemetry) telemetry.stop();
    if (reconnect) reconnect.dispose();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (scoreboard) scoreboard.dispose();
    if (serveArrow) serveArrow.dispose();
    if (pointBurst) pointBurst.dispose();
    playerServe.dispose();
    // Unsubscribe ball events so a re-entered multiplayer session doesn't
    // score through this dead drill's handlers (same double-scoring leak
    // rallyManager guards against).
    if (ballEvents.offPaddleHit)   ballEvents.offPaddleHit(onPaddleHit);
    if (ballEvents.offTableBounce) ballEvents.offTableBounce(onTableBounce);
    if (ballEvents.offNetHit)      ballEvents.offNetHit(onNetHit);
    if (ballEvents.offBallLost)    ballEvents.offBallLost(onBallLost);
    // Note: NetworkManager teardown is owned by the session end handler in
    // inGame.js, not the drill — so quitting back to the wrist menu doesn't
    // drop the peer connection.
  }

  return {
    update,
    isFinished,
    launch,
    liveLine,
    dispose,
    isLocalOwner,
    // Only the end-of-match card, and only once the match is over — until then
    // this stays null so A/X keeps opening the wrist menu (see the same note
    // in aiMatch.js).
    get panel() { return matchDone ? report : null; },
    panelMesh: report.mesh,
  };
}
