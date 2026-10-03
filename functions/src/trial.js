// Free-trial clock. Pure — no Firestore, no Date.now() — so the arithmetic
// that decides when a player hits the paywall is the arithmetic under test.
//
// ── MODEL ───────────────────────────────────────────────────────────────────
//
// The client asks for a short LEASE of play time and renews it while a rally
// or match is actually running (menus, lobby and headset-on time do not
// count). The server credits the REAL time elapsed since the previous call,
// measured on its own clock, so a client cannot claim to have played less
// than it did between two calls.
//
// Credit per call is capped at the lease that was granted plus a grace for
// network latency. That cap is what makes a crash or a dropped connection
// cheap for an honest player (they lose at most one lease) while a client
// that renews late still pays for every second it was covered.
//
// What this cannot do: stop a client that never calls at all. The game runs
// entirely in the browser, so the gate is enforced client-side and the server
// only holds the truth. See functions/index.js.

export const TRIAL_MS = 10 * 60 * 1000;
export const LEASE_MS = 60 * 1000;
export const GRACE_MS = 15 * 1000;

export const LEASE_ACTIONS = ['start', 'renew', 'end'];

/**
 * @param {{ usedMs?: number, lastTickMs?: number|null, leaseMs?: number }} state
 *        what users/{uid} holds now (missing fields = a fresh trial)
 * @param {'start'|'renew'|'end'} action
 * @param {number} nowMs server clock
 * @returns {{ usedMs: number, lastTickMs: number|null, leaseMs: number, remainingMs: number }}
 *          the state to store, plus the lease granted by this call (0 = none)
 */
export function applyLease(state, action, nowMs) {
  let usedMs = Math.max(0, Number(state.usedMs) || 0);
  const last = Number.isFinite(state.lastTickMs) ? state.lastTickMs : null;

  if (last !== null) {
    const granted = Number.isFinite(state.leaseMs) ? state.leaseMs : LEASE_MS;
    const elapsed = Math.max(0, nowMs - last);
    usedMs += Math.min(elapsed, granted + GRACE_MS);
  }
  usedMs = Math.min(TRIAL_MS, Math.round(usedMs));
  const remainingMs = TRIAL_MS - usedMs;

  if (action === 'end' || remainingMs <= 0) {
    return { usedMs, lastTickMs: null, leaseMs: 0, remainingMs };
  }
  const leaseMs = Math.min(LEASE_MS, remainingMs);
  return { usedMs, lastTickMs: nowMs, leaseMs, remainingMs };
}

/** Remaining trial for display, without moving the clock. */
export function remainingMs(state) {
  return Math.max(0, TRIAL_MS - Math.max(0, Number(state.usedMs) || 0));
}
