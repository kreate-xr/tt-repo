// Paid play time per player, and the refund rule that reads it. Pure — no
// Firestore, no Date.now() — so the arithmetic under test is the arithmetic
// that decides a refund.
//
// ── MODEL ───────────────────────────────────────────────────────────────────
//
// The free version is not metered at all: only a player with an active
// unlock calls /api/trial/lease (the path keeps its old name so builds from
// before the free version keep working). users/{uid}.play =
// { totalMs, lastTickMs, leaseMs } moves on every such call: the server
// credits the real time elapsed since the previous call on its own clock,
// capped at the lease it granted plus GRACE_MS. So the total is never
// client-reported, but it only grows while the client keeps calling.
// js/account/trialClock.js therefore FAILS CLOSED for a paid player who could
// still get a refund: play stops if the server has not been reachable for a
// while (see meterPaidPlay below). Past that point nothing depends on the
// total any more and metering stops.
//
// The refund's two hours are PAID play: the entitlement stores the total at
// the moment of purchase (`playAtGrantMs`) and only what came after counts.
// A user doc from the old free-trial days has no `play`; its trial minutes
// seed the total, and an entitlement granted before `playAtGrantMs` existed
// counts from zero, as it always did.

/** Length of one play lease handed to the client. */
export const LEASE_MS = 60 * 1000;
/** Network slack credited on top of a lease before the server stops counting. */
export const GRACE_MS = 15 * 1000;
export const LEASE_ACTIONS = ['start', 'renew', 'end'];

export const REFUND_PLAY_LIMIT_MS = 2 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** users/{uid} data → its play state, seeded from a legacy trial clock when absent. */
export function playState(user) {
  if (user && user.play) return user.play;
  const trial = (user && user.trial) || {};
  return {
    totalMs: Number(trial.usedMs) || 0,
    lastTickMs: Number.isFinite(trial.lastTickMs) ? trial.lastTickMs : null,
    leaseMs: Number(trial.leaseMs) || 0,
  };
}

function credit(state, nowMs) {
  const total = Math.max(0, Number(state.totalMs) || 0);
  if (!Number.isFinite(state.lastTickMs)) return total;
  const granted = Number.isFinite(state.leaseMs) ? state.leaseMs : LEASE_MS;
  return total + Math.min(Math.max(0, nowMs - state.lastTickMs), granted + GRACE_MS);
}

/**
 * @param {{ totalMs?: number, lastTickMs?: number|null, leaseMs?: number }} state
 * @param {'start'|'renew'|'end'} action
 * @param {number} nowMs server clock
 * @param {number} grantMs the lease handed to the client by this call (0 = none)
 */
export function applyPlayLease(state, action, nowMs, grantMs) {
  const totalMs = Math.round(credit(state, nowMs));
  if (action === 'end' || !(grantMs > 0)) return { totalMs, lastTickMs: null, leaseMs: 0 };
  return { totalMs, lastTickMs: nowMs, leaseMs: grantMs };
}

/** Played so far, including an open lease up to now (capped as above). */
export function playedMs(state, nowMs) {
  return Math.round(credit(state || {}, nowMs));
}

/** Total play when the entitlement was granted (0 for grants from before it was stored). */
export function playAtGrant(ent) {
  const v = Number(ent && ent.playAtGrantMs);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Play since the purchase — what the refund's two hours are measured against. */
export function paidPlayedMs(user, ent, nowMs) {
  return Math.max(0, playedMs(playState(user), nowMs) - playAtGrant(ent));
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The first rule that blocks a refund, checked in the order of the spec, or
 * null when it is allowed. A check whose input is `undefined` is skipped, so
 * the refund endpoint can run a–b before it asks PayLayer for the window.
 *
 * @returns {null|'not_paid'|'refund_in_progress'|'already_refunded'|'refund_used'
 *           |'refund_window_expired'|'played_too_long'}
 */
export function refundBlock({ orderStatus, refundUsed, refundableUntil, played, nowMs }) {
  // a. the purchase is paid ('refund_requested' is a retry of one that was)
  if (orderStatus === 'refunded') return 'already_refunded';
  if (orderStatus !== 'paid' && orderStatus !== 'refund_requested') return 'not_paid';
  // b. one refund per account
  if (refundUsed === true) return 'refund_used';
  // c. inside PayLayer's window (null = not refundable at all)
  if (refundableUntil !== undefined) {
    const until = toMs(refundableUntil);
    if (until === null || nowMs >= until) return 'refund_window_expired';
  }
  // d. under two hours of play
  if (played !== undefined && played >= REFUND_PLAY_LIMIT_MS) return 'played_too_long';
  return null;
}

/**
 * Whether a paid player's play must be metered (and the client fail closed):
 * only while a refund could still be granted. The window here is the one
 * cached on the entitlement from the paid webhook — the refund endpoint
 * itself always asks PayLayer. An entitlement without one (granted before it
 * was cached) falls back to its grant time plus the order's window.
 */
export function meterPaidPlay({ ent, order, user, nowMs }) {
  if (!ent || ent.active !== true || !order || order.status !== 'paid') return false;
  return refundBlock({
    orderStatus: order.status,
    refundUsed: !!(user && user.refundUsed),
    refundableUntil: cachedRefundableUntil(ent, order),
    played: paidPlayedMs(user, ent, nowMs),
    nowMs,
  }) === null;
}

/** End of the refund window as cached on the entitlement (ms), or null. */
export function cachedRefundableUntil(ent, order) {
  const until = toMs(ent && ent.refundableUntil);
  if (until !== null) return until;
  const days = order && Number.isFinite(order.refundWindowDays) ? order.refundWindowDays : 3;
  const granted = toMs(ent && ent.grantedAt);
  return granted === null ? null : granted + days * DAY_MS;
}
