// Ball state synchronization + ownership bookkeeping.
//
// Owner side:
//   - writeLocal(ballPos, ballVel, ballSpin) each frame → outboundState.ball
//   - on local hit / table bounce / etc., the drill emits explicit events on
//     the reliable eventChannel; this module does not own those.
//
// Non-owner side — dead reckoning, not interpolation:
//   - onRemoteBallPacket() ingests msgpack ball packets (seq drop, keep newest)
//   - getDeadReckonedBallState(now, dt) produces the mirrored ball state to
//     overwrite ballModel.position / ballVelocity / ballAngularVelocity
//     *before* tickPhysics runs that frame.
//
// Why dead reckoning: interpolation renders the ball one-way-latency +
// interp-delay (~50-90 ms) in the PAST — 20-35 cm behind truth at smash
// speed at the exact moment the receiving player swings. Ballistic flight
// has no mid-flight input and both peers run the identical integrator
// (physics/flightStep.js), so projecting the received state forward by its
// age is accurate to millimeters. The model:
//
//   displayed  — a persistent local mini-sim of the mirrored ball, advanced
//                by the injected integrator every frame. This is what the
//                player sees; it is smooth regardless of packet phase.
//   target     — on packet arrival, the packet state projected forward by
//                clamp(now - tLocal, 0, BALL_EXTRAP_CAP_MS).
//   correction — target minus displayed. |err| < deadzone: ignored (sub-3 cm
//                is invisible on a 4 cm ball in flight). Mid-range: folded in
//                exponentially with τ = CORRECTION_TAU_S (halves every
//                ~35 ms, gone in ~150 ms). ≥ snap threshold: hard snap.
//                Velocity/spin always copy from the target directly —
//                velocity discontinuities are imperceptible; position
//                discontinuities are not.
//
// Mirror rules (sender world → receiver world, across net plane z = Cz):
//   position:        (x, y, z) → (x, y, 2*Cz - z)
//   linear velocity: (x, y, z) → (x, y, -z)
//   angular vel.:    (x, y, z) → (-x, -y,  z)   (pseudovector)

import { PacketType } from './serialization.js';

export const BALL_EXTRAP_CAP_MS = 120;        // regular packet projection cap
export const AUTHORITATIVE_EXTRAP_CAP_MS = 150; // handoff / reconciliation cap
export const BALL_EXTRAP_SUBSTEP_MS = 8;
export const CORRECTION_TAU_S = 0.05;
export const CORRECTION_DEADZONE_M = 0.03;
export const SNAP_THRESHOLD_M = 0.25;

function copyVec(dst, src) { dst.x = src.x; dst.y = src.y; dst.z = src.z; }

export class GameStateSync {
  // opts.stepFlight(pos, vel, spin, dtSeconds) → bounceInfo|null — advances
  // the state one step, mutating in place; returns truthy info ({x, z,
  // impactSpeed}) when the ball struck the table this step. The multiplayer
  // drill injects an adapter over physics/rollout.js (the same integrator
  // the owner's tickPhysics uses); injected rather than imported so this
  // module stays physics-agnostic and unit-testable with stub integrators.
  constructor(initialOwner, tableCenterZ = 0, opts = {}) {
    // 'self' | 'opponent'
    this.owner = initialOwner;
    this.tableCenterZ = tableCenterZ;
    this.stepFlight = opts.stepFlight || null;

    this.lastSeq = 0;
    // Newest accepted remote state, already mirrored into the receiver frame:
    // { ts (receiver clock), capMs, p, v, s }
    this.latest = null;
    this.latestConsumed = true;

    // The displayed mini-sim state (pre-allocated, reused as the return value).
    this.displayed = {
      pos:  { x: 0, y: 0, z: 0 },
      vel:  { x: 0, y: 0, z: 0 },
      spin: { x: 0, y: 0, z: 0 },
    };
    this.hasDisplayed = false;

    // Pending positional correction (error vector still to fold in).
    this.corr = { x: 0, y: 0, z: 0 };
    this.hasCorr = false;

    // Scratch target state for packet projection (zero-alloc absorb path).
    this._target = {
      pos:  { x: 0, y: 0, z: 0 },
      vel:  { x: 0, y: 0, z: 0 },
      spin: { x: 0, y: 0, z: 0 },
    };

    // Set when the displayed mini-sim struck the table plane this frame —
    // lets the drill play the bounce sound with zero network latency.
    this.lastBounce = null;

    // Field-telemetry counters ("feels like no latency" = snaps ≈ 0 and
    // correction magnitudes staying tiny).
    this.snapCount = 0;
    this.lastCorrectionM = 0;
    this.corrections = []; // per-packet correction magnitudes since last take
  }

  // Drain the correction stats accumulated since the previous call — the
  // TelemetryReporter samples this on its 2 s cadence. ballCorrectionP95 in
  // meters; snaps is the count within the window.
  takeCorrectionStats() {
    let p95 = 0;
    const n = this.corrections.length;
    if (n > 0) {
      const sorted = this.corrections.slice().sort((a, b) => a - b);
      p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    }
    const snaps = this.snapCount;
    this.corrections.length = 0;
    this.snapCount = 0;
    return { ballCorrectionP95: p95, snaps };
  }

  setOwner(who) { this.owner = who; }
  isLocalOwner() { return this.owner === 'self'; }

  // Drop remote state and reset seq tracking. Use on ownership change so
  // stale pre-flip packets don't poison the mini-sim, and after a reconnect
  // swap when the seq stream restarts from a new NetworkManager.
  clear() {
    this.latest = null;
    this.latestConsumed = true;
    this.hasDisplayed = false;
    this.hasCorr = false;
    this.lastBounce = null;
    this.lastSeq = 0;
  }

  // `hid` tags the packet with the current authority epoch (last adopted
  // hitId) — the receiver drops stragglers from earlier epochs and the
  // original hitter treats the first matching tag as the implicit handoff
  // ACK. See network/HandoffManager.js.
  writeLocal(outboundState, ballPos, ballVel, ballSpin, hid = 0) {
    outboundState.ball = {
      type: PacketType.BALL_STATE,
      h: hid,
      p: [ballPos.x, ballPos.y, ballPos.z],
      v: [ballVel.x, ballVel.y, ballVel.z],
      s: [ballSpin.x, ballSpin.y, ballSpin.z],
    };
  }

  onRemoteBallPacket(packet) {
    if (!packet || typeof packet.seq !== 'number') return;
    if (packet.seq <= this.lastSeq) return;
    this.lastSeq = packet.seq;

    const p = packet.p, v = packet.v, s = packet.s;
    if (!p || !v || !s) return;

    const cz2 = 2 * this.tableCenterZ;
    // tLocal is the receiver-clock translation of the sender's timestamp,
    // stamped by NetworkManager. The raw sender timestamp must never be
    // compared against the local clock — the two origins are unrelated.
    this.latest = {
      ts: packet.tLocal,
      capMs: BALL_EXTRAP_CAP_MS,
      p: { x:  p[0], y:  p[1], z: cz2 - p[2] },
      v: { x:  v[0], y:  v[1], z:      -v[2] },
      s: { x: -s[0], y: -s[1], z:       s[2] },
    };
    this.latestConsumed = false;
  }

  // Ingest an authoritative snapshot (OWNERSHIP_HANDOFF / RECONCILIATION)
  // that has already been mirrored via decodeFromWire. Runs through the same
  // projection + correction path as the 60 Hz stream, so reconciliation
  // blends instead of hard-snapping.
  applyAuthoritative(decoded, tsLocal, now) {
    if (!decoded) return;
    this.latest = {
      ts: typeof tsLocal === 'number' ? tsLocal : now,
      capMs: AUTHORITATIVE_EXTRAP_CAP_MS,
      p: { x: decoded.pos.x,  y: decoded.pos.y,  z: decoded.pos.z },
      v: { x: decoded.vel.x,  y: decoded.vel.y,  z: decoded.vel.z },
      s: { x: decoded.spin.x, y: decoded.spin.y, z: decoded.spin.z },
    };
    this.latestConsumed = false;
  }

  // Mirrored dead-reckoned state to overwrite the local ball this frame.
  // `now` in ms (receiver clock), `dt` in seconds (frame delta). Returns
  // null until the first packet arrives after a clear().
  getDeadReckonedBallState(now, dt) {
    this.lastBounce = null;

    // 1. Advance the mini-sim by the frame delta — continuous motion
    //    regardless of packet arrival phase.
    if (this.hasDisplayed && dt > 0 && this.stepFlight) {
      const hit = this.stepFlight(
        this.displayed.pos, this.displayed.vel, this.displayed.spin, dt,
      );
      if (hit) this.lastBounce = hit;
    }

    // 2. Absorb a newly arrived packet as a projected target.
    if (this.latest && !this.latestConsumed) this._absorbLatest(now);
    if (!this.hasDisplayed) return null;

    // 3. Fold in the pending position correction.
    if (this.hasCorr && dt > 0) {
      const decay = Math.exp(-dt / CORRECTION_TAU_S);
      const k = 1 - decay;
      this.displayed.pos.x += this.corr.x * k;
      this.displayed.pos.y += this.corr.y * k;
      this.displayed.pos.z += this.corr.z * k;
      this.corr.x *= decay;
      this.corr.y *= decay;
      this.corr.z *= decay;
      const residSq = this.corr.x * this.corr.x + this.corr.y * this.corr.y + this.corr.z * this.corr.z;
      if (residSq < CORRECTION_DEADZONE_M * CORRECTION_DEADZONE_M) this.hasCorr = false;
    }

    return this.displayed;
  }

  _absorbLatest(now) {
    const pkt = this.latest;
    this.latestConsumed = true;

    const t = this._target;
    copyVec(t.pos, pkt.p);
    copyVec(t.vel, pkt.v);
    copyVec(t.spin, pkt.s);

    // Project the packet forward from "when the sender sampled it" to "now"
    // in fixed substeps. Runs on packet arrival (≤ send rate), not per frame
    // — worst case 15 substeps, trivial on Quest frame budget.
    if (this.stepFlight && typeof pkt.ts === 'number') {
      let age = now - pkt.ts;
      if (age > pkt.capMs) age = pkt.capMs;
      while (age > 1e-3) {
        const stepMs = age < BALL_EXTRAP_SUBSTEP_MS ? age : BALL_EXTRAP_SUBSTEP_MS;
        this.stepFlight(t.pos, t.vel, t.spin, stepMs / 1000);
        age -= stepMs;
      }
    }

    if (!this.hasDisplayed) {
      // First packet after clear(): adopt outright.
      copyVec(this.displayed.pos, t.pos);
      copyVec(this.displayed.vel, t.vel);
      copyVec(this.displayed.spin, t.spin);
      this.hasDisplayed = true;
      this.hasCorr = false;
      return;
    }

    const ex = t.pos.x - this.displayed.pos.x;
    const ey = t.pos.y - this.displayed.pos.y;
    const ez = t.pos.z - this.displayed.pos.z;
    const err = Math.sqrt(ex * ex + ey * ey + ez * ez);
    this.lastCorrectionM = err;
    if (this.corrections.length < 512) this.corrections.push(err);

    // Velocity/spin: copy from target directly every packet.
    copyVec(this.displayed.vel, t.vel);
    copyVec(this.displayed.spin, t.spin);

    if (err >= SNAP_THRESHOLD_M) {
      copyVec(this.displayed.pos, t.pos);
      this.hasCorr = false;
      this.snapCount++;
    } else if (err >= CORRECTION_DEADZONE_M) {
      this.corr.x = ex;
      this.corr.y = ey;
      this.corr.z = ez;
      this.hasCorr = true;
    }
    // else: sub-deadzone — leave position alone (no micro-jitter).
  }

  // Convert a ball state from local frame to mirrored "wire" frame for
  // OWNERSHIP_HANDOFF / RECONCILIATION packets on the reliable eventChannel.
  // The receiver applies the inverse mirror when consuming.
  encodeForWire(ballPos, ballVel, ballSpin) {
    return {
      p: [ballPos.x, ballPos.y, ballPos.z],
      v: [ballVel.x, ballVel.y, ballVel.z],
      s: [ballSpin.x, ballSpin.y, ballSpin.z],
    };
  }

  // Decode an OWNERSHIP_HANDOFF / RECONCILIATION ball payload into the local
  // receiver frame (mirrored). Returns plain {pos, vel, spin} {x,y,z} objects.
  decodeFromWire(wirePayload) {
    if (!wirePayload || !wirePayload.p) return null;
    const cz2 = 2 * this.tableCenterZ;
    return {
      pos:  { x:  wirePayload.p[0], y:  wirePayload.p[1], z: cz2 - wirePayload.p[2] },
      vel:  { x:  wirePayload.v[0], y:  wirePayload.v[1], z:      -wirePayload.v[2] },
      spin: { x: -wirePayload.s[0], y: -wirePayload.s[1], z:       wirePayload.s[2] },
    };
  }
}
