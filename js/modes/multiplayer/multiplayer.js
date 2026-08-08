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
  paddleModel, ballModel, tableBox, tableSurfaceY, ballRadius,
  paddleFaceOffset, paddleFaceNormalLocal, paddleHitRadius, paddleHalfThickness,
} from '../../scene/models.js';
import { integrateFlightStep, applyTableBounce, isTableBounce } from '../../physics/rollout.js';
import {
  ballVelocity, ballAngularVelocity, spawnBallAt,
  paddleFaceCenterWorld, paddleFaceNormalWorld, paddleVelocity,
} from '../../physics/ball.js';
import { resolvePaddleTablePenetration } from '../../physics/paddleTableClamp.js';
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

export const MULTIPLAYER = { id: 'multiplayer', label: 'Multiplayer', usesFeeder: false };

const SERVE_DELAY_MS = 1200;
const RESPAWN_DELAY_MS = 1200;
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
  // Always plain http(s) — telemetry sink is independent of the signaling
  // protocol. Match the page's protocol to avoid mixed-content blocking.
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'https' : 'http';
  return `${proto}://${host}:8081/telemetry`;
})();

export function createMultiplayerDrill({ ballEvents, multiplayer, hooks } = {}) {
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
        // Other side observed the loss; sync ownership + (if host) schedule
        // the next serve.
        resetOwnershipToHost();
        scheduleRespawn();
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
        remoteInterpDelayMs = msg.throttled
          ? REMOTE_INTERP_DELAY_THROTTLED_MS
          : REMOTE_INTERP_DELAY_MS;
        break;
      }
      case PacketType.PLAYER_PAUSED: {
        hudLog(`peer ${msg.paused ? 'paused' : 'resumed'}`);
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
    hm.localHit(gameSync.encodeForWire(ballModel.position, ballVelocity, ballAngularVelocity));
    // Keep (or grab — an early swing at a still-incoming dead-reckoned ball
    // can fire before we adopted the opponent's handoff) full authority for
    // the pending window. Drop any buffered remote state: our local sim is
    // the sole source of truth until the ACK.
    gameSync.clear();
    gameSync.setOwner('self');
    sessionState.ballOwner = 'self';
  }
  // While our handoff is pending, exactly one authority may emit wire events
  // — the new owner. Local sounds/haptics already fired inside ball.js, so
  // suppressing the wire send loses nothing on our side, and the adopting
  // peer's own sim produces the bounce/net events locally.
  function onTableBounce(info) {
    if (!gameSync.isLocalOwner() || hm.isPending()) return;
    nm.sendEvent({ type: PacketType.TABLE_BOUNCE, x: info.x, z: info.z, volume: 0.5 });
  }
  function onNetHit(info) {
    if (!gameSync.isLocalOwner() || hm.isPending()) return;
    // Dual-channel: unreliable copy lands one one-way trip sooner; reliable
    // copy guarantees delivery. Receiver dedupes by eid.
    netEidCounter += 2;
    nm.sendGame({ type: PacketType.NET_HIT_G, eid: netEidCounter, axis: info.axis });
    nm.sendEvent({ type: PacketType.NET_HIT, eid: netEidCounter, axis: info.axis });
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
    // Both sides will reset ownership to "host owns next"; this side is the
    // owner side, fire it locally.
    resetOwnershipToHost();
    scheduleRespawn();
  }
  ballEvents.onPaddleHit(onPaddleHit);
  ballEvents.onTableBounce(onTableBounce);
  ballEvents.onNetHit(onNetHit);
  ballEvents.onBallLost(onBallLost);

  // --- Serve / respawn (host-driven) ---
  // The host owns serves: both initial and post-miss respawn. Guest never
  // spawns the ball; it always arrives via BALL_STATE packets. This keeps a
  // single authority for the ball's existence — no race between peers about
  // who serves after a missed rally.
  let serveTimer = null;
  function hostServe() {
    if (!tableBox || !ballModel) return;
    const x = (tableBox.min.x + tableBox.max.x) / 2;
    const y = tableSurfaceY + 0.6;
    const z = tableBox.max.z - 0.1; // host's near edge
    spawnBallAt(
      new THREE.Vector3(x, y, z),
      new THREE.Vector3((Math.random() - 0.5) * 0.5, 1.6, -1.8),
      new THREE.Vector3(),
    );
    gameSync.setOwner('self');
    sessionState.ballOwner = 'self';
  }
  function scheduleRespawn() {
    if (role !== 'host') return;
    if (serveTimer) return; // already pending — don't double-schedule
    serveTimer = setTimeout(() => {
      serveTimer = null;
      hostServe();
    }, RESPAWN_DELAY_MS);
  }
  // Initial serve on entry
  if (role === 'host') {
    serveTimer = setTimeout(() => { serveTimer = null; hostServe(); }, SERVE_DELAY_MS);
  }

  // Ball-lost ownership reset: regardless of which peer's physics emitted the
  // loss, the next ball will come from the host's serve, so both sides snap
  // ownership accordingly. Called from local onBallLost and wire BALL_LOST.
  function resetOwnershipToHost() {
    // A guest that owned the ball when it was lost must also stop
    // retransmitting its final ball packet — same bug as onPaddleHit.
    releaseBallAuthority(role === 'host' ? 'self' : 'opponent');
  }

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
    nm.startSendLoop(60);
    startTelemetry();
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
      nm.sendEvent({ type: PacketType.RECONNECT_RESTORE, snapshot: sessionState.serialize() });
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

    // 1. Sample local paddle face → outbound paddle packet.
    paddleSync.writeLocal(nm.outboundState, paddleFaceCenterWorld, paddleFaceNormalWorld, paddleVelocity);

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
  }

  // Pending counts as owning: tickPhysics must keep integrating our post-hit
  // ball until the ACK flips us (gameSync stays owner='self' through the
  // pending window, so the || is belt-and-braces).
  function isLocalOwner() { return gameSync.isLocalOwner() || hm.isPending(); }
  function isFinished() { return false; }
  function liveLine() {
    const own = isLocalOwner() ? (hm.isPending() ? 'OWN*' : 'OWN') : 'OPP';
    return `Multiplayer (${role})  ball=${own}`;
  }
  function dispose() {
    if (serveTimer) clearTimeout(serveTimer);
    if (remotePaddleVisual) remoteGroup.remove(remotePaddleVisual);
    scene.remove(remoteGroup);
    if (nm) nm.stopSendLoop();
    if (removeThermalListener) removeThermalListener();
    if (telemetry) telemetry.stop();
    if (reconnect) reconnect.dispose();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    // Note: NetworkManager teardown is owned by the session end handler in
    // inGame.js, not the drill — so quitting back to the wrist menu doesn't
    // drop the peer connection.
  }

  return {
    update,
    isFinished,
    liveLine,
    dispose,
    isLocalOwner,
    usesFeeder: false,
  };
}
