// End-to-end latency-behavior harness: real ClockSync + GameStateSync +
// HandoffManager + the real flight physics (rollout.js), over a simulated
// lossy/jittery link between two peers whose clocks are 10^7 ms apart.
//
// This is the regression net for the entire "negligible latency" stack:
//   - clock translation (sender timestamp → receiver tLocal)
//   - dead reckoning (projection by packet age + mini-sim + blend)
//   - handoff duplication/dedupe under loss
// If any layer silently falls back to comparing raw sender timestamps
// against the local clock, projection ages explode and the error assertions
// here fail loudly.

import * as THREE from 'three';
import { GameStateSync } from '../js/network/GameStateSync.js';
import { HandoffManager, HANDOFF_DUP_DELAYS_MS } from '../js/network/HandoffManager.js';
import { integrateFlightStep, applyTableBounce, isTableBounce } from '../js/physics/rollout.js';
import { PacketType } from '../js/network/serialization.js';
import { makeRng, EventQueue, FakeLink, FakePeer, startPingLoop } from './helpers/fakeNetwork.js';

// ---------------------------------------------------------------------------
// Shared physics adapter — the same shape multiplayer.js injects.
// ---------------------------------------------------------------------------

const ENV = {
  ballRadius: 0.02,
  tableSurfaceY: 0,
  // Oversized footprint so the scripted ball keeps bouncing for the whole
  // scenario instead of rolling off the edge.
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

function mirror(state) {
  return {
    pos:  { x:  state.pos.x,  y:  state.pos.y,  z: -state.pos.z },
    vel:  { x:  state.vel.x,  y:  state.vel.y,  z: -state.vel.z },
    spin: { x: -state.spin.x, y: -state.spin.y, z:  state.spin.z },
  };
}

// ---------------------------------------------------------------------------
// Scenario: 80 ms RTT, ±10 ms jitter, 2% loss, clocks 10^7 ms apart
// ---------------------------------------------------------------------------

describe('dead-reckoned ball vs ground truth over a hostile link', () => {
  const FRAME_MS = 1000 / 90;
  const SEND_INTERVAL_MS = 1000 / 60;
  const DURATION_MS = 10_000;
  const WARMUP_MS = 1_000;
  const CLOCK_GAP_MS = 9_999_999;

  test('error stays small, motion stays continuous, zero snaps', () => {
    const rng = makeRng(42);
    const queue = new EventQueue();
    const peerA = new FakePeer({ clockOrigin: 0 });
    const peerB = new FakePeer({ clockOrigin: CLOCK_GAP_MS });
    const linkAtoB = new FakeLink({ oneWayMs: 40, jitterMs: 10, lossPct: 2, rng });
    const linkBtoA = new FakeLink({ oneWayMs: 40, jitterMs: 10, lossPct: 2, rng });

    // B pings A so B's ClockSync learns (A clock − B clock).
    startPingLoop({
      pinger: peerB, ponger: peerA,
      link: linkBtoA, replyLink: linkAtoB,
      queue, untilT: DURATION_MS,
    });

    // A: authoritative truth sim. B: dead-reckoning consumer.
    const stepA = makeStepAdapter();
    const truth = {
      pos:  { x: 0, y: 1.2, z: 0.5 },
      vel:  { x: 0.4, y: 2.5, z: -1.5 },
      spin: { x: 15, y: 3, z: 0 },
    };
    const gameSyncB = new GameStateSync('opponent', 0, { stepFlight: makeStepAdapter() });

    // A's 60 Hz send loop.
    function scheduleSend(simT) {
      if (simT > DURATION_MS) return;
      queue.push(simT, (t) => {
        const packet = peerA.stampOutbound({
          type: PacketType.BALL_STATE,
          h: 0,
          p: [truth.pos.x, truth.pos.y, truth.pos.z],
          v: [truth.vel.x, truth.vel.y, truth.vel.z],
          s: [truth.spin.x, truth.spin.y, truth.spin.z],
        }, t);
        const delay = linkAtoB.sampleDelay(false);
        if (delay !== null) {
          queue.push(t + delay, (arriveT) => {
            peerB.stampInbound(packet, arriveT);
            gameSyncB.onRemoteBallPacket(packet);
          });
        }
        scheduleSend(simT + SEND_INTERVAL_MS);
      });
    }
    scheduleSend(SEND_INTERVAL_MS);

    // Frame loop: 90 Hz on both sides; A advances truth, B dead-reckons.
    const errors = [];
    let prevDisplayed = null;
    let maxFrameJump = 0;
    for (let simT = FRAME_MS; simT <= DURATION_MS; simT += FRAME_MS) {
      queue.runUntil(simT);
      stepA(truth.pos, truth.vel, truth.spin, FRAME_MS / 1000);
      const dr = gameSyncB.getDeadReckonedBallState(peerB.now(simT), FRAME_MS / 1000);

      if (simT < WARMUP_MS || !dr) { prevDisplayed = dr ? { ...dr.pos } : null; continue; }

      const expected = mirror(truth);
      const dx = dr.pos.x - expected.pos.x;
      const dy = dr.pos.y - expected.pos.y;
      const dz = dr.pos.z - expected.pos.z;
      errors.push(Math.sqrt(dx * dx + dy * dy + dz * dz));

      if (prevDisplayed) {
        const jx = dr.pos.x - prevDisplayed.x;
        const jy = dr.pos.y - prevDisplayed.y;
        const jz = dr.pos.z - prevDisplayed.z;
        const jump = Math.sqrt(jx * jx + jy * jy + jz * jz);
        const speed = Math.sqrt(dr.vel.x ** 2 + dr.vel.y ** 2 + dr.vel.z ** 2);
        // Physical motion this frame plus the correction budget: the blend
        // folds in at most (1 - e^(-dt/τ)) of a sub-snap error per frame.
        const allowance = speed * (FRAME_MS / 1000) + 0.03;
        maxFrameJump = Math.max(maxFrameJump, Math.max(0, jump - allowance));
      }
      prevDisplayed = { ...dr.pos };
    }

    expect(errors.length).toBeGreaterThan(500);
    const sorted = errors.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];

    // Goal (b): the ball is where physics says it is when the player swings.
    expect(p95).toBeLessThan(0.03);   // < 3 cm for 95% of frames
    expect(max).toBeLessThan(0.08);   // bounce-phase transients stay tiny
    expect(maxFrameJump).toBe(0);     // no discontinuity beyond the blend budget
    expect(gameSyncB.snapCount).toBe(0);

    // Clock estimation recovered the 10^7 ms offset to within a few ms.
    expect(Math.abs(peerB.clock.offset - (0 - CLOCK_GAP_MS))).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Handoff duplication under loss
// ---------------------------------------------------------------------------

describe('handoff adoption under 5% loss', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const BALL = { p: [0, 1, 0], v: [0, 0, 3], s: [0, 0, 0] };

  test('adopts exactly once, within the dup window + one-way worst case, every trial', () => {
    for (let trial = 0; trial < 50; trial++) {
      const rng = makeRng(1000 + trial);
      const link = new FakeLink({ oneWayMs: 40, jitterMs: 10, lossPct: 5, rng });

      let currentT = 0;
      const gameSends = [];
      const reliableSends = [];
      const hmA = new HandoffManager({
        role: 'host',
        sendReliable: (m) => reliableSends.push({ m, at: currentT }),
        sendGame: (m) => gameSends.push({ m, at: currentT }),
        now: () => currentT,
      });
      const hmB = new HandoffManager({
        role: 'guest',
        sendReliable: () => {},
        sendGame: () => {},
        now: () => currentT,
      });

      hmA.localHit(BALL);
      // Flush the delayed unreliable duplicates (setTimeout-based).
      for (const stepMs of [20, 20]) {
        currentT += stepMs;
        jest.advanceTimersByTime(stepMs);
      }
      expect(gameSends).toHaveLength(HANDOFF_DUP_DELAYS_MS.length);
      expect(reliableSends).toHaveLength(1);

      // Compute arrivals: unreliable copies may drop; the reliable copy
      // always arrives (retransmit-delayed on "loss").
      const arrivals = [];
      for (const g of gameSends) {
        const d = link.sampleDelay(false);
        if (d !== null) arrivals.push({ at: g.at + d, msg: g.m });
      }
      arrivals.push({ at: reliableSends[0].at + link.sampleDelay(true), msg: reliableSends[0].m });
      arrivals.sort((a, b) => a.at - b.at);

      let adoptions = 0;
      for (const a of arrivals) {
        if (hmB.onRemoteHandoff(a.msg)) adoptions++;
      }
      expect(adoptions).toBe(1); // dedupe by hitId — first copy wins, once

      // Worst case: all three unreliable copies dropped → reliable copy with
      // one retransmit: 40 (last dup slot is irrelevant then) + 40 + 10
      // jitter + 80 retransmit = 130 ms.
      expect(arrivals[0].at).toBeLessThanOrEqual(130);
    }
  });
});
