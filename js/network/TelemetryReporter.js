// In-game black box. Quest browser exposes no chrome://webrtc-internals, so
// when a player says "the game felt broken" we have no data — unless we
// gather it ourselves. Every 2 seconds: pc.getStats() → extract RTT, jitter,
// packet loss, connection type (p2p / relay), thermal state → POST to a
// telemetry sink via sendBeacon (survives page unload).

import { isThrottled } from './ThermalMonitor.js';

const INTERVAL_MS = 2000;

function extractMetrics(stats, sessionId, clock) {
  const metrics = {
    sessionId,
    ts: Date.now(),
    rtt: null,
    jitter: null,
    packetsLost: null,
    connectionType: null,
    thermalThrottled: isThrottled(),
    // ClockSync estimates — lets field data validate the ping-pong estimator
    // against getStats' currentRoundTripTime.
    clockOffset: clock && clock.isReady() ? clock.offset : null,
    pingRtt: clock ? (clock.oneWayMs() !== null ? clock.oneWayMs() * 2 : null) : null,
  };
  stats.forEach((report) => {
    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated !== false) {
      if (typeof report.currentRoundTripTime === 'number') {
        metrics.rtt = report.currentRoundTripTime * 1000; // s → ms
      }
      // The remote candidate type tells us whether we are relayed (TURN) or
      // direct (host/srflx). getStats doesn't always expose it under one key;
      // try a couple.
      const remoteId = report.remoteCandidateId;
      if (remoteId) {
        const remote = stats.get ? stats.get(remoteId) : null;
        if (remote && remote.candidateType) {
          metrics.connectionType = remote.candidateType === 'relay' ? 'relay' : 'p2p';
        }
      }
    }
    if (report.type === 'inbound-rtp') {
      if (typeof report.packetsLost === 'number') metrics.packetsLost = report.packetsLost;
      if (typeof report.jitter === 'number') metrics.jitter = report.jitter * 1000; // s → ms
    }
  });
  return metrics;
}

export class TelemetryReporter {
  // `extraMetrics` — optional callback returning an object merged into every
  // sample (game-level metrics: ball correction p95, snap rate, handoff
  // adoption latency). Kept as a callback so this module stays free of game
  // imports.
  constructor({ pc, serverUrl, sessionId, intervalMs = INTERVAL_MS, clock = null, extraMetrics = null } = {}) {
    if (!pc) throw new Error('TelemetryReporter requires a peer connection');
    this.pc = pc;
    this.clock = clock;
    this.extraMetrics = extraMetrics;
    this.serverUrl = serverUrl;
    this.sessionId = sessionId || `${Math.random().toString(36).slice(2, 8)}-${Date.now()}`;
    this.intervalMs = intervalMs;
    this.handle = null;
    this.lastMetrics = null;
  }

  start() {
    if (this.handle) return;
    const tick = async () => {
      try {
        const stats = await this.pc.getStats();
        const payload = extractMetrics(stats, this.sessionId, this.clock);
        if (this.extraMetrics) {
          try { Object.assign(payload, this.extraMetrics()); }
          catch (e) { console.warn('TelemetryReporter extraMetrics failed:', e); }
        }
        this.lastMetrics = payload;
        if (this.serverUrl && typeof navigator !== 'undefined' && navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
          navigator.sendBeacon(this.serverUrl, blob);
        }
      } catch (e) {
        // getStats can throw if the pc is mid-teardown — log but don't crash.
        console.warn('TelemetryReporter sample failed:', e);
      }
    };
    // Fire once immediately so a fast disconnect still records a sample.
    tick();
    this.handle = setInterval(tick, this.intervalMs);
  }

  stop() {
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }
}
