// P13 spec §C8 — contact ring buffer feeding the drift detector.
//
// Per contact, record: r_c (vector from face center to contact point on the
// disc plane), |u_t|/|v_n| (tangential-to-normal speed ratio, classifies
// "flat" hits), and landZSign (long/short bounce sign, filled in async by
// the subsequent table bounce). We record ONLY player-origin hits — AI
// paddles have authoritative poses and can't produce drift signal.
//
// The buffer is cleared on any T_cal change (calibration.js.subscribe →
// clear()) so stale calibration signal doesn't survive recalibration
// (plan Gotcha d). It is NOT cleared between rallies — a player's grip
// drifts over minutes to hours, not seconds.

import { subscribe as subscribeCalibration } from './calibration.js';

const RING_SIZE = 40;

const _buf = new Array(RING_SIZE);
let _writeIdx = 0;
let _count = 0;
let _nextHitId = 1;

/**
 * Record a paddle-hit event. Returns a hit id that the caller can pass to
 * annotateLandZSign() when the subsequent table bounce fires. Only call
 * from the player-origin branch of tryPaddleCollision — AI paddles must
 * not enter this buffer.
 *
 * @param {number} rcX  x-component of r_c in the disc-plane basis
 * @param {number} rcY  y-component of r_c
 * @param {number} rcZ  z-component of r_c (typically ~0 since r_c lies in the disc plane)
 * @param {number} utOverVn  |u_t|/|v_n| ratio (flat-hit classifier)
 * @returns {number} hitId
 */
export function recordHit(rcX, rcY, rcZ, utOverVn) {
  const id = _nextHitId++;
  _buf[_writeIdx] = {
    id,
    rcX, rcY, rcZ,
    utOverVn,
    landZSign: 0,   // 0 = not yet resolved; -1/+1 = short/long
    timestamp: performance.now(),
  };
  _writeIdx = (_writeIdx + 1) % RING_SIZE;
  if (_count < RING_SIZE) _count++;
  return id;
}

/**
 * Fill in landZSign for a previously recorded hit. Called from the ball.js
 * table-bounce branch. Silently no-ops if the id was pushed out of the ring
 * (long time between hit and bounce is fine; ring overflow is not).
 */
export function annotateLandZSign(hitId, sign) {
  if (sign !== -1 && sign !== 1) return;
  for (let i = 0; i < _count; i++) {
    if (_buf[i] && _buf[i].id === hitId) {
      _buf[i].landZSign = sign;
      return;
    }
  }
}

/** Snapshot of the current buffer contents (newest-first). Callers own the
 *  returned array; safe to mutate. */
export function snapshot() {
  const out = [];
  for (let i = 0; i < _count; i++) {
    // Walk backwards from _writeIdx-1 to get newest-first ordering.
    const idx = (_writeIdx - 1 - i + RING_SIZE) % RING_SIZE;
    if (_buf[idx]) out.push({ ..._buf[idx] });
  }
  return out;
}

export function count() { return _count; }

/** Reset the buffer — called on any T_cal change (spec §C8 / plan Gotcha d). */
export function clear() {
  for (let i = 0; i < RING_SIZE; i++) _buf[i] = null;
  _writeIdx = 0;
  _count = 0;
  // Do NOT reset _nextHitId — outstanding table-bounce callbacks might still
  // reference ids from before the clear; they'll just no-op which is correct.
}

// Wire the calibration-change flush. Fires exactly once at module load; the
// unsubscriber is intentionally discarded because the singleton lives for
// the app's lifetime.
subscribeCalibration(clear);

// Test hooks.
export function _resetForTests() {
  clear();
  _nextHitId = 1;
}
