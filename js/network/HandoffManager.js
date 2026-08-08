// Optimistic-authority handoff state machine.
//
// The old design flipped the hitter to non-owner at the instant of the hit,
// which left their ball with NO data source for a full RTT — it froze, then
// rubber-banded onto the opponent's adopted trajectory. This module
// implements the replacement protocol:
//
//   1. You hit the ball → you KEEP simulating (optimistic authority) and
//      enter a pending state. The post-hit ball is purely local, so your own
//      shot feels exactly like single-player.
//   2. The handoff is sent on the reliable events channel AND duplicated on
//      the unreliable game channel at +0/+20/+40 ms. The receiver adopts the
//      first copy that lands (dedupe by hitId) — nearly always an unreliable
//      copy at one one-way trip.
//   3. The new owner tags its outbound BALL_STATE stream with the adopted
//      hitId (`h`). The first tagged packet the hitter sees is the implicit
//      ACK: flip to non-owner and let dead reckoning take over. Because both
//      peers integrated the identical physics from the same handoff state,
//      the first correction is millimeters — blended, never snapped.
//   4. If no ACK lands within HANDOFF_ACK_TIMEOUT_MS (loss burst; the
//      reliable copy still guarantees eventual delivery), flip anyway.
//
// hitIds are globally monotonic and parity-partitioned (host even, guest
// odd) so concurrently created ids can never collide. Staleness is a simple
// integer compare: any BALL_STATE tagged with h < currentHitId is a
// straggler from a previous authority epoch and must be dropped.
//
// This module owns ONLY the protocol state (ids, pending, dedupe); the drill
// owns the game-side effects (ball adoption, authority release) via the
// return values. No scene imports → fully unit-testable.

import { PacketType } from './serialization.js';

export const HANDOFF_ACK_TIMEOUT_MS = 300;
export const HANDOFF_DUP_DELAYS_MS = [0, 20, 40];

export class HandoffManager {
  // sendReliable / sendGame: bound to the live NetworkManager by the caller
  // (as closures, so a reconnect swap is picked up automatically).
  constructor({ role, sendReliable, sendGame, now } = {}) {
    if (role !== 'host' && role !== 'guest') {
      throw new Error('HandoffManager role must be "host" or "guest"');
    }
    this.parity = role === 'host' ? 0 : 1;
    this.sendReliable = sendReliable;
    this.sendGame = sendGame;
    this.now = now || (() => performance.now());

    // Id of the current authority epoch — the hitId of the last hit either
    // peer made. Monotonic across the whole session (never reset per rally,
    // so cross-rally stragglers stay droppable).
    this.currentHitId = 0;
    // { hitId, sentAt } while our own handoff awaits its implicit ACK.
    this.pending = null;
    // send → implicit-ACK latency of the most recent completed handoff, ms.
    // ≈ one RTT in the field; exported to telemetry as handoffAdoptMs.
    this.lastAdoptMs = null;
  }

  nextHitId() {
    let id = this.currentHitId + 1;
    if ((id & 1) !== this.parity) id++;
    return id;
  }

  // Local player hit the ball. Sends the handoff on both channels and enters
  // the pending (optimistic-authority) state. Returns the new hitId.
  localHit(ballWire) {
    const hitId = this.nextHitId();
    this.currentHitId = hitId;
    this.sendReliable({ type: PacketType.OWNERSHIP_HANDOFF, hitId, ball: ballWire });
    for (const delay of HANDOFF_DUP_DELAYS_MS) {
      // Fresh packet object per send — sendGame stamps seq/timestamp in place.
      const send = () => this.sendGame({ type: PacketType.HANDOFF_G, hitId, ball: ballWire });
      if (delay === 0) send();
      else setTimeout(send, delay);
    }
    this.pending = { hitId, sentAt: this.now() };
    return hitId;
  }

  // An OWNERSHIP_HANDOFF / HANDOFF_G arrived. Returns true when it is fresh
  // and the caller must adopt the ball (project + spawn + take ownership);
  // false for duplicates and stale copies. A remote handoff arriving while
  // our own is pending means the opponent already returned the ball — theirs
  // is causally later, so our pending epoch is over.
  onRemoteHandoff(msg) {
    if (!msg || typeof msg.hitId !== 'number') return false;
    if (msg.hitId <= this.currentHitId) return false;
    this.currentHitId = msg.hitId;
    this.pending = null;
    return true;
  }

  // Feed the `h` tag of an incoming BALL_STATE. Returns:
  //   'ack'   — our pending handoff was adopted; caller must release authority
  //             and may then ingest this same packet as the first remote state
  //   'stale' — straggler from a previous authority epoch; caller must drop it
  //   'ok'    — current-epoch packet, ingest normally
  onBallStateHid(h) {
    if (this.pending && h === this.pending.hitId) {
      this.lastAdoptMs = this.now() - this.pending.sentAt;
      this.pending = null;
      return 'ack';
    }
    if (typeof h === 'number' && h < this.currentHitId) return 'stale';
    return 'ok';
  }

  // Timeout fallback — call once per frame. Returns true when the pending
  // window expired and the caller must release authority.
  tick(nowMs) {
    if (this.pending && nowMs - this.pending.sentAt > HANDOFF_ACK_TIMEOUT_MS) {
      this.pending = null;
      return true;
    }
    return false;
  }

  isPending() {
    return this.pending !== null;
  }

  // End the pending epoch without an ACK (ball lost mid-window, reconnect).
  cancelPending() {
    this.pending = null;
  }
}
