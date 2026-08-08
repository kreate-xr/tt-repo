// Peer clock synchronization over the unreliable game channel.
//
// Every game packet is stamped with the SENDER's performance.now(), but
// interpolation/extrapolation must evaluate those timestamps against the
// RECEIVER's clock — the two time origins are unrelated (different page
// loads, different devices). This module estimates the offset between the
// two clocks with an NTP-style ping-pong:
//
//   A sends PING {t0 = A.now()}
//   B replies immediately PONG {t0, t1 = B.now()}
//   A receives at t2 and computes:
//     rtt    = t2 - t0
//     offset = t1 - (t0 + t2) / 2     (peer clock minus local clock,
//                                      assuming a symmetric path)
//
// Filtering: keep a sliding window of samples and adopt the offset from the
// MINIMUM-RTT sample — low-RTT samples have the least queuing-delay
// asymmetry, hence the most accurate offset (same principle as NTP's clock
// filter). The chosen candidate is EWMA-smoothed so a new minimum doesn't
// step the translated timeline.
//
// The unreliable channel is deliberate: a lost ping is just a skipped sample,
// and reliable-channel retransmits would corrupt RTT measurement.
//
// This module never calls performance.now() itself — callers pass `now` in —
// so it is trivially unit-testable with simulated clocks.

import { PacketType } from './serialization.js';

export const PING_INTERVAL_MS = 250;
const SAMPLE_WINDOW = 16; // ~4 s of history at 250 ms cadence
const EWMA_ALPHA = 0.2;

export class ClockSync {
  constructor() {
    this.samples = []; // { offset, rtt }, newest last
    this.offset = 0;   // peer clock minus local clock, ms
    this.hasSync = false;
  }

  // Build a ping packet. Caller sends it on the game channel.
  makePing(now) {
    return { type: PacketType.PING, t0: now };
  }

  // Build the reply to an incoming ping. Reply synchronously in the message
  // handler so turnaround delay stays ~0 (it adds directly to measured RTT).
  makePong(ping, now) {
    return { type: PacketType.PONG, t0: ping.t0, t1: now };
  }

  // Ingest a pong received at local time `now` (= t2).
  onPong(pong, now) {
    if (!pong || typeof pong.t0 !== 'number' || typeof pong.t1 !== 'number') return;
    const rtt = now - pong.t0;
    if (rtt < 0) return; // nonsense sample (clock adjustment mid-flight)

    this.samples.push({ offset: pong.t1 - (pong.t0 + now) / 2, rtt });
    if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();

    let best = this.samples[0];
    for (const s of this.samples) {
      if (s.rtt < best.rtt) best = s;
    }
    if (!this.hasSync) {
      // Adopt the first sample directly so translation works within one ping
      // interval of connecting instead of slewing up from zero.
      this.offset = best.offset;
      this.hasSync = true;
    } else {
      this.offset += EWMA_ALPHA * (best.offset - this.offset);
    }
  }

  // Translate a sender-clock timestamp into the local clock domain.
  toLocalTime(remoteTs) {
    return remoteTs - this.offset;
  }

  // Best current estimate of one-way latency, or null before the first pong.
  oneWayMs() {
    if (this.samples.length === 0) return null;
    let min = Infinity;
    for (const s of this.samples) {
      if (s.rtt < min) min = s.rtt;
    }
    return min / 2;
  }

  isReady() {
    return this.hasSync;
  }

  // Carry an offset across a reconnect so translation doesn't regress to
  // untranslated for the first ping interval on the new connection.
  seed(offset) {
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return;
    this.offset = offset;
    this.hasSync = true;
  }
}
