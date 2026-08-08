// In-memory two-peer network simulation for latency-behavior tests.
//
// Critically, each peer has an INDEPENDENT clock origin (peer B's
// performance.now() equivalent can sit 10^7 ms away from A's), so the
// clock-domain bug class — comparing a sender timestamp against the
// receiver's clock — can never regress silently: any code path that does it
// produces kilometer-scale projection errors and fails the assertions.
//
// The harness emulates exactly the seams NetworkManager owns in production:
//   - sender stamping (`timestamp` in the sender's clock domain, monotonic seq)
//   - PING/PONG ping-pong feeding a real ClockSync
//   - receiver stamping (`tLocal` via ClockSync translation, arrival-time
//     fallback before the first pong)
// Everything downstream (GameStateSync, PaddleSync, HandoffManager) is the
// real production code.

import { ClockSync } from '../../js/network/ClockSync.js';

// Deterministic LCG so failures reproduce exactly.
export function makeRng(seed = 1234) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Time-ordered event queue over simulation time (ms).
export class EventQueue {
  constructor() {
    this.items = [];
    this._seq = 0; // stable FIFO tiebreak for equal timestamps
  }

  push(t, fn) {
    this.items.push({ t, seq: this._seq++, fn });
  }

  // Run every event due at or before simulation time `t`, in time order.
  runUntil(t) {
    this.items.sort((a, b) => (a.t - b.t) || (a.seq - b.seq));
    while (this.items.length && this.items[0].t <= t) {
      const item = this.items.shift();
      item.fn(item.t);
    }
  }
}

// One-way link with base delay, uniform ±jitter, and percentage loss.
export class FakeLink {
  constructor({ oneWayMs = 40, jitterMs = 0, lossPct = 0, rng = makeRng() } = {}) {
    this.oneWayMs = oneWayMs;
    this.jitterMs = jitterMs;
    this.lossPct = lossPct;
    this.rng = rng;
  }

  // Delivery delay for one packet, or null when dropped. `reliable` packets
  // are never dropped — a "lost" transmission costs a retransmit round trip
  // instead, mirroring SCTP reliable-channel behavior.
  sampleDelay(reliable = false) {
    let delay = this.oneWayMs + (this.rng() * 2 - 1) * this.jitterMs;
    if (delay < 1) delay = 1;
    if (this.lossPct > 0 && this.rng() * 100 < this.lossPct) {
      if (!reliable) return null;
      delay += this.oneWayMs * 2;
    }
    return delay;
  }
}

// A peer with its own clock origin plus the NetworkManager-equivalent
// inbound stamping (ClockSync translation with arrival-time fallback).
export class FakePeer {
  constructor({ clockOrigin = 0 } = {}) {
    this.clockOrigin = clockOrigin;
    this.clock = new ClockSync();
    this.outboundSeq = 0;
  }

  now(simT) {
    return simT + this.clockOrigin;
  }

  // Sender side: stamp like NetworkManager.sendGame.
  stampOutbound(packet, simT) {
    packet.seq = ++this.outboundSeq;
    packet.timestamp = this.now(simT);
    return packet;
  }

  // Receiver side: stamp like NetworkManager._stampLocalTime.
  stampInbound(packet, simT) {
    packet.tLocal = (this.clock.isReady() && typeof packet.timestamp === 'number')
      ? this.clock.toLocalTime(packet.timestamp)
      : this.now(simT);
    return packet;
  }
}

// Drive the PING/PONG exchange from `pinger` through `link` (and back over
// `replyLink`) into pinger.clock, scheduling on `queue`. Call once; it
// re-arms itself every `intervalMs` of simulation time until `untilT`.
export function startPingLoop({ pinger, ponger, link, replyLink, queue, intervalMs = 250, untilT = Infinity }) {
  function firePing(simT) {
    const t0 = pinger.now(simT);
    const up = link.sampleDelay(false);
    if (up !== null) {
      queue.push(simT + up, (arriveT) => {
        // Ponger replies synchronously with its own clock reading.
        const t1 = ponger.now(arriveT);
        const down = replyLink.sampleDelay(false);
        if (down !== null) {
          queue.push(arriveT + down, (backT) => {
            pinger.clock.onPong({ t0, t1 }, pinger.now(backT));
          });
        }
      });
    }
    const next = simT + intervalMs;
    if (next <= untilT) queue.push(next, firePing);
  }
  queue.push(0, firePing);
}
