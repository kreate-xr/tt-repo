// Rally-lifecycle scenarios targeting the three failure modes reported from
// old-code field sessions:
//
//   1. "opponent paddle movement" (frozen / stepping) — was the clock-domain
//      mismatch pinning interpolation to t=0/1.
//   2. "ball not visible / stuck" — was the stale-ball retransmit after a
//      hit plus ownership gaps where NOBODY simulated the ball (hitter
//      flipped to non-owner instantly; if the receiver also swung early and
//      flipped too, the ball was orphaned mid-air forever).
//   3. "don't know who needs to serve" — downstream of (2): an orphaned ball
//      never triggers BALL_LOST, so the host never schedules the respawn.
//
// Two full peers are simulated with the REAL protocol modules (ClockSync,
// GameStateSync, HandoffManager, PaddleSync) and the REAL flight physics
// (rollout.js), over a lossy/jittery 80 ms RTT link with clock origins
// 10^7 ms apart. A thin Side shim replicates the drill wiring in
// multiplayer.js (same handler order); the drill itself runs in-XR and needs
// on-device confirmation, but every protocol decision is exercised here.

import * as THREE from 'three';
import { GameStateSync, AUTHORITATIVE_EXTRAP_CAP_MS } from '../js/network/GameStateSync.js';
import { HandoffManager, HANDOFF_ACK_TIMEOUT_MS } from '../js/network/HandoffManager.js';
import { PaddleSync } from '../js/network/PaddleSync.js';
import { integrateFlightStep, applyTableBounce, isTableBounce } from '../js/physics/rollout.js';
import { PacketType } from '../js/network/serialization.js';
import { makeRng, EventQueue, FakeLink, FakePeer, startPingLoop } from './helpers/fakeNetwork.js';

const FRAME_MS = 1000 / 90;
const CLOCK_GAP_MS = 9_999_999;

const ENV = {
  ballRadius: 0.02,
  tableSurfaceY: 0,
  tableBox: { min: { x: -100, y: 0, z: -100 }, max: { x: 100, y: 0, z: 100 } },
};

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
function makeStepAdapter() {
  return function step(pos, vel, spin, dt) {
    _p.set(pos.x, pos.y, pos.z);
    _v.set(vel.x, vel.y, vel.z);
    _s.set(spin.x, spin.y, spin.z);
    integrateFlightStep(_p, _v, _s, dt);
    let hit = null;
    if (isTableBounce(_p, _v, ENV)) {
      _p.y = ENV.tableSurfaceY + ENV.ballRadius;
      const impactSpeed = applyTableBounce(_v, _s, ENV.ballRadius);
      hit = { x: _p.x, z: _p.z, impactSpeed };
    }
    pos.x = _p.x; pos.y = _p.y; pos.z = _p.z;
    vel.x = _v.x; vel.y = _v.y; vel.z = _v.z;
    spin.x = _s.x; spin.y = _s.y; spin.z = _s.z;
    return hit;
  };
}

function cloneState(s) {
  return {
    pos:  { ...s.pos },
    vel:  { ...s.vel },
    spin: { ...s.spin },
  };
}

function projectDecoded(step, decoded, ms) {
  let remaining = Math.min(Math.max(ms || 0, 0), AUTHORITATIVE_EXTRAP_CAP_MS);
  while (remaining > 1e-3) {
    const stepMs = remaining < 8 ? remaining : 8;
    step(decoded.pos, decoded.vel, decoded.spin, stepMs / 1000);
    remaining -= stepMs;
  }
}

// Thin replica of the drill wiring in multiplayer.js (same handler order).
class Side {
  constructor(role, peer) {
    this.role = role;
    this.peer = peer;
    this.step = makeStepAdapter();
    this.gameSync = new GameStateSync(role === 'host' ? 'self' : 'opponent', 0, {
      stepFlight: makeStepAdapter(),
    });
    this.outGame = null;  // wired by the harness
    this.outEvent = null;
    this.hm = new HandoffManager({
      role,
      sendReliable: (m) => this.outEvent(m),
      sendGame: (m) => this.outGame(m),
      now: () => this.peer.now(this.simT),
    });
    this.simT = 0;
    this.ball = null;            // local authoritative ball state
    this.drState = null;         // latest dead-reckoned view (non-owner)
    this.lastOwnedBall = null;   // snapshot at the moment of an ACK flip
    this.serveScheduled = 0;
  }

  isAuthoritative() { return this.gameSync.isLocalOwner() || this.hm.isPending(); }

  onGameMessage(packet) {
    if (packet.type === PacketType.BALL_STATE) {
      const verdict = this.hm.onBallStateHid(packet.h);
      if (verdict === 'stale') return;
      if (verdict === 'ack') this.release();
      if (!this.gameSync.isLocalOwner()) this.gameSync.onRemoteBallPacket(packet);
      return;
    }
    if (packet.type === PacketType.HANDOFF_G) this.adopt(packet);
  }

  onEventMessage(msg) {
    if (msg.type === PacketType.OWNERSHIP_HANDOFF) {
      this.adopt(msg);
    } else if (msg.type === PacketType.BALL_LOST) {
      this.drState = null;
      this.resetToHost();
      if (this.role === 'host') this.serveScheduled++;
    }
  }

  adopt(msg) {
    if (!this.hm.onRemoteHandoff(msg)) return;
    const decoded = this.gameSync.decodeFromWire(msg.ball);
    if (decoded) {
      const age = typeof msg.tLocal === 'number' ? this.peer.now(this.simT) - msg.tLocal : 0;
      projectDecoded(this.step, decoded, age);
      this.ball = decoded;
    }
    this.gameSync.clear();
    this.gameSync.setOwner('self');
  }

  release() {
    this.lastOwnedBall = this.ball ? cloneState(this.ball) : null;
    this.gameSync.clear();
    this.gameSync.setOwner('opponent');
  }

  resetToHost() {
    this.hm.cancelPending();
    this.gameSync.clear();
    this.gameSync.setOwner(this.role === 'host' ? 'self' : 'opponent');
    this.ball = null;
  }

  // Local paddle hit: optimistic authority (mirror of onPaddleHit).
  localHit(newVel) {
    if (!this.gameSync.isLocalOwner() && this.drState) {
      // Early swing at the incoming dead-reckoned ball.
      this.ball = cloneState(this.drState);
    }
    if (!this.ball) return;
    this.ball.vel = { ...newVel };
    this.hm.localHit(this.gameSync.encodeForWire(this.ball.pos, this.ball.vel, this.ball.spin));
    this.gameSync.clear();
    this.gameSync.setOwner('self');
  }

  // Mirror of onBallLost.
  localBallLost() {
    if (!this.gameSync.isLocalOwner()) return;
    if (this.hm.isPending()) {
      this.hm.cancelPending();
      this.release();
      return;
    }
    this.outEvent({ type: PacketType.BALL_LOST, reason: 'floor' });
    this.resetToHost();
    if (this.role === 'host') this.serveScheduled++;
  }

  frame(simT) {
    this.simT = simT;
    if (this.hm.tick(this.peer.now(simT))) this.release();
    if (this.gameSync.isLocalOwner()) {
      if (this.ball) {
        this.step(this.ball.pos, this.ball.vel, this.ball.spin, FRAME_MS / 1000);
        const out = {};
        this.gameSync.writeLocal(out, this.ball.pos, this.ball.vel, this.ball.spin, this.hm.currentHitId);
        this.outGame(out.ball);
      }
    } else {
      const dr = this.gameSync.getDeadReckonedBallState(this.peer.now(simT), FRAME_MS / 1000);
      this.drState = dr ? cloneState(dr) : this.drState && null;
    }
  }
}

// Wire two Sides over fake links with clock sync running both ways.
function makeWorld({ seed = 7, oneWayMs = 40, jitterMs = 10, lossPct = 2 } = {}) {
  const rng = makeRng(seed);
  const queue = new EventQueue();
  const peerH = new FakePeer({ clockOrigin: 0 });
  const peerG = new FakePeer({ clockOrigin: CLOCK_GAP_MS });
  const linkHG = new FakeLink({ oneWayMs, jitterMs, lossPct, rng });
  const linkGH = new FakeLink({ oneWayMs, jitterMs, lossPct, rng });
  const host = new Side('host', peerH);
  const guest = new Side('guest', peerG);
  const simClock = { t: 0 };

  function wire(from, to, link, toPeer) {
    from.outGame = (pkt) => {
      from.peer.stampOutbound(pkt, simClock.t);
      const d = link.sampleDelay(false);
      if (d !== null) queue.push(simClock.t + d, (t) => { toPeer.stampInbound(pkt, t); to.onGameMessage(pkt); });
    };
    from.outEvent = (pkt) => {
      from.peer.stampOutbound(pkt, simClock.t);
      const d = link.sampleDelay(true); // reliable: never dropped
      queue.push(simClock.t + d, (t) => { toPeer.stampInbound(pkt, t); to.onEventMessage(pkt); });
    };
  }
  wire(host, guest, linkHG, peerG);
  wire(guest, host, linkGH, peerH);

  startPingLoop({ pinger: peerG, ponger: peerH, link: linkGH, replyLink: linkHG, queue, untilT: 60_000 });
  startPingLoop({ pinger: peerH, ponger: peerG, link: linkHG, replyLink: linkGH, queue, untilT: 60_000 });

  function runFrames(untilMs, perFrame = null) {
    while (simClock.t < untilMs) {
      simClock.t += FRAME_MS;
      queue.runUntil(simClock.t);
      host.frame(simClock.t);
      guest.frame(simClock.t);
      jest.advanceTimersByTime(FRAME_MS); // fires handoff dup setTimeouts
      if (perFrame) perFrame(simClock.t);
    }
  }

  return { host, guest, simClock, runFrames };
}

const SERVE = {
  pos:  { x: 0, y: 1.2, z: 0.8 },
  vel:  { x: 0.2, y: 2.0, z: -2.0 },
  spin: { x: 5, y: 0, z: 0 },
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// ---------------------------------------------------------------------------
// Symptom 2a: "ball not visible" on the guest after the host serves
// ---------------------------------------------------------------------------

describe('serve visibility', () => {
  test('guest sees the served ball within 250 ms and it never disappears', () => {
    const { host, guest, runFrames } = makeWorld();
    host.ball = cloneState(SERVE);

    let firstVisibleAt = null;
    let disappearances = 0;
    runFrames(3000, (t) => {
      if (guest.drState && firstVisibleAt === null) firstVisibleAt = t;
      if (firstVisibleAt !== null && !guest.drState) disappearances++;
    });

    expect(firstVisibleAt).not.toBe(null);
    expect(firstVisibleAt).toBeLessThan(250); // one-way + first packet + jitter
    expect(disappearances).toBe(0);           // ball never goes invisible/stuck
    expect(guest.gameSync.snapCount).toBe(0); // and tracks without hard snaps
  });
});

// ---------------------------------------------------------------------------
// Symptom 2b: rally handoff — no orphaned ball, no rubber-band on the hitter
// ---------------------------------------------------------------------------

describe('rally handoff', () => {
  test('hit → adoption → implicit ACK, with at least one authority at all times', () => {
    const { host, guest, simClock, runFrames } = makeWorld();
    host.ball = cloneState(SERVE);
    runFrames(1000);

    // Host hits toward the guest. Under the OLD instant-flip design the host
    // would now be a non-owner with no data source for a full RTT.
    host.localHit({ x: -0.2, y: 2.2, z: -2.5 });
    const hitAt = simClock.t;
    expect(host.hm.isPending()).toBe(true);

    let orphanFrames = 0;
    let guestAdoptedAt = null;
    let hostFlippedAt = null;
    let prevHostView = null;
    let flipJump = null;
    runFrames(hitAt + 1000, (t) => {
      if (!host.isAuthoritative() && !guest.isAuthoritative()) orphanFrames++;
      if (guest.gameSync.isLocalOwner() && guestAdoptedAt === null) guestAdoptedAt = t;
      if (!host.isAuthoritative() && hostFlippedAt === null) hostFlippedAt = t;
      // Host's PERCEIVED ball: own sim while authoritative, dead-reckoned
      // view after the flip. The jump across the flip frame is the
      // rubber-band metric.
      const view = host.isAuthoritative()
        ? (host.ball && host.ball.pos)
        : (host.drState && host.drState.pos);
      if (view && prevHostView && flipJump === null && hostFlippedAt === t) {
        const jx = view.x - prevHostView.x;
        const jy = view.y - prevHostView.y;
        const jz = view.z - prevHostView.z;
        flipJump = Math.sqrt(jx * jx + jy * jy + jz * jz);
      }
      prevHostView = view ? { ...view } : prevHostView;
    });

    // Exactly one side ended up owning; nobody was ever orphaned. An orphaned
    // ball is precisely the old "ball stuck mid-air, nobody serves" symptom.
    expect(orphanFrames).toBe(0);
    expect(guest.gameSync.isLocalOwner()).toBe(true);
    expect(host.gameSync.isLocalOwner()).toBe(false);
    expect(host.hm.isPending()).toBe(false);

    // Guest adopted within one one-way trip + dup window + a frame or two —
    // far inside the 300 ms timeout fallback.
    expect(guestAdoptedAt - hitAt).toBeLessThan(150);
    // Host flipped only after the guest's tagged stream arrived (~1 RTT).
    expect(hostFlippedAt - hitAt).toBeLessThan(HANDOFF_ACK_TIMEOUT_MS);

    // No rubber-band: across the flip frame the host's perceived ball moves
    // by ≈ one frame of physical motion (|v| ≈ 3.3 m/s × 11 ms ≈ 3.7 cm),
    // NOT by an RTT of backtracking (~30 cm) as in the old instant-flip
    // design. Both sims ran identical physics from the identical handoff
    // state, so the residual correction is millimeters.
    expect(flipJump).not.toBe(null);
    expect(flipJump).toBeLessThan(0.08);
    expect(host.hm.lastAdoptMs).toBeGreaterThan(0); // telemetry recorded the adoption
  });

  test('simultaneous hits (sub-RTT race) converge to exactly one owner', () => {
    const { host, guest, runFrames, simClock } = makeWorld({ seed: 21 });
    host.ball = cloneState(SERVE);
    runFrames(1000);
    // Guest swings early at the incoming dead-reckoned ball in the same
    // frame the host hits — the race the old design could deadlock on
    // (both flip to non-owner → orphaned ball).
    expect(guest.drState).not.toBe(null);
    host.localHit({ x: 0, y: 2.0, z: -2.5 });
    guest.localHit({ x: 0, y: 2.0, z: -2.5 });

    let orphanFrames = 0;
    runFrames(simClock.t + 1000, () => {
      if (!host.isAuthoritative() && !guest.isAuthoritative()) orphanFrames++;
    });

    expect(orphanFrames).toBe(0);
    const owners = [host.gameSync.isLocalOwner(), guest.gameSync.isLocalOwner()].filter(Boolean);
    expect(owners).toHaveLength(1); // exactly one winner
    expect(host.hm.isPending()).toBe(false);
    expect(guest.hm.isPending()).toBe(false);
    // Both sides agree which epoch won.
    expect(host.hm.currentHitId).toBe(guest.hm.currentHitId);
  });
});

// ---------------------------------------------------------------------------
// Symptom 3: "don't know who needs to serve" after a lost ball
// ---------------------------------------------------------------------------

describe('ball lost → host serve', () => {
  test('both sides agree the host owns the next serve, and the serve is seen', () => {
    const { host, guest, simClock, runFrames } = makeWorld();
    host.ball = cloneState(SERVE);
    runFrames(1000);
    host.localHit({ x: 0, y: 2.2, z: -2.5 });
    runFrames(simClock.t + 500); // guest adopts, host flips
    expect(guest.gameSync.isLocalOwner()).toBe(true);

    // Guest (current owner) loses the ball.
    guest.localBallLost();
    runFrames(simClock.t + 500);

    // Ownership agreement: host self-owner, guest opponent-owner — the exact
    // invariant whose violation looked like "nobody serves".
    expect(host.gameSync.isLocalOwner()).toBe(true);
    expect(guest.gameSync.isLocalOwner()).toBe(false);
    // Respawn scheduled exactly once, on the host only.
    expect(host.serveScheduled).toBe(1);
    expect(guest.serveScheduled).toBe(0);

    // Host serves; the guest must see the new ball promptly.
    host.ball = cloneState(SERVE);
    const serveAt = simClock.t;
    let seenAt = null;
    runFrames(serveAt + 1000, (t) => {
      if (guest.drState && seenAt === null) seenAt = t;
    });
    expect(seenAt).not.toBe(null);
    expect(seenAt - serveAt).toBeLessThan(250);
  });

  test('ball lost during a pending handoff defers to the new owner instead of resetting', () => {
    const { host, guest, simClock, runFrames } = makeWorld();
    host.ball = cloneState(SERVE);
    runFrames(1000);
    host.localHit({ x: 0, y: 2.2, z: -2.5 });
    // Host's own sim declares the ball lost INSIDE the pending window
    // (divergence is possible there — the adopting owner is authoritative).
    host.localBallLost();
    expect(host.hm.isPending()).toBe(false);
    expect(host.gameSync.isLocalOwner()).toBe(false);
    expect(host.serveScheduled).toBe(0); // no false rally reset

    runFrames(simClock.t + 500);
    // The guest adopted the handoff and now owns the live ball.
    expect(guest.gameSync.isLocalOwner()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Symptom 1: opponent paddle motion — smooth, tracking, never frozen
// ---------------------------------------------------------------------------

describe('opponent paddle motion', () => {
  test('tracks a 1 Hz swing within 2.5 cm, continuously, across hostile clocks', () => {
    const rng = makeRng(99);
    const queue = new EventQueue();
    const sender = new FakePeer({ clockOrigin: 0 });
    const receiver = new FakePeer({ clockOrigin: CLOCK_GAP_MS });
    const link = new FakeLink({ oneWayMs: 40, jitterMs: 10, lossPct: 2, rng });
    const back = new FakeLink({ oneWayMs: 40, jitterMs: 10, lossPct: 2, rng });
    startPingLoop({ pinger: receiver, ponger: sender, link: back, replyLink: link, queue, untilT: 10_000 });

    const sync = new PaddleSync(0);
    const AMP = 0.5, FREQ = 1; // 0.5 m sweep at 1 Hz → ~3.1 m/s peak
    const truthX = (tMs) => AMP * Math.sin(2 * Math.PI * FREQ * (tMs / 1000));
    const truthVX = (tMs) => AMP * 2 * Math.PI * FREQ * Math.cos(2 * Math.PI * FREQ * (tMs / 1000));

    // Sender: 60 Hz paddle stream.
    for (let sendT = 0; sendT <= 10_000; sendT += 1000 / 60) {
      const pkt = sender.stampOutbound({
        type: PacketType.PADDLE_STATE,
        fc: [truthX(sendT), 1.0, 0.3],
        fn: [0, 0, 1],
        pv: [truthVX(sendT), 0, 0],
      }, sendT);
      const d = link.sampleDelay(false);
      if (d !== null) queue.push(sendT + d, (t) => { receiver.stampInbound(pkt, t); sync.onRemotePacket(pkt); });
    }

    // Receiver: 90 Hz evaluation at now − 35 ms on the translated timeline
    // (exactly what multiplayer.js does).
    const INTERP_DELAY_MS = 35;
    let prevX = null;
    let maxErr = 0;
    let maxJump = 0;
    let sweptTruth = 0;
    let sweptDisplayed = 0;
    let prevTruthX = null;
    for (let simT = FRAME_MS; simT <= 10_000; simT += FRAME_MS) {
      queue.runUntil(simT);
      const face = sync.getRemoteFace(receiver.now(simT) - INTERP_DELAY_MS);
      if (simT < 1000) { prevX = face.center.x; prevTruthX = truthX(simT - INTERP_DELAY_MS); continue; }

      // The displayed pose targets the sender's true pose 35 ms ago.
      const expected = truthX(simT - INTERP_DELAY_MS);
      maxErr = Math.max(maxErr, Math.abs(face.center.x - expected));
      maxJump = Math.max(maxJump, Math.abs(face.center.x - prevX));
      sweptDisplayed += Math.abs(face.center.x - prevX);
      sweptTruth += Math.abs(expected - prevTruthX);
      prevX = face.center.x;
      prevTruthX = expected;
    }

    // Old code: interpolation factor pinned to 0/1 → the paddle froze two
    // packets stale or stepped in packet-sized jumps. New behavior:
    expect(maxErr).toBeLessThan(0.025);               // ≤ 2.5 cm from truth
    // Per-frame movement never exceeds physical motion + a small margin
    // (peak 3.1 m/s × 11.1 ms ≈ 3.5 cm) — no packet-sized teleports.
    expect(maxJump).toBeLessThan(0.05);
    // And it MOVES — a frozen paddle sweeps ~0% of the true distance.
    expect(sweptDisplayed).toBeGreaterThan(sweptTruth * 0.9);
    expect(sweptDisplayed).toBeLessThan(sweptTruth * 1.1);
  });
});
