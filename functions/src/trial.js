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
// The same minutes are also charged to the player's NETWORK (see network.js),
// and a lease only runs while BOTH have time left. A private window is a new
// anonymous uid with a fresh clock, but it arrives from the same network, so
// it inherits what that network already used instead of a new 10 minutes.
// A network forgets its minutes NETWORK_MEMORY_MS after it last played.
//
// What this cannot do: stop a client that never calls at all. The game runs
// entirely in the browser, so the gate is enforced client-side and the server
// only holds the truth. See functions/index.js.

export const TRIAL_MS = 10 * 60 * 1000;
export const LEASE_MS = 60 * 1000;
export const GRACE_MS = 15 * 1000;
export const NETWORK_MEMORY_MS = 30 * 24 * 3600 * 1000;

export const LEASE_ACTIONS = ['start', 'renew', 'end'];

/**
 * @param {{ usedMs?: number, lastTickMs?: number|null, leaseMs?: number }} state
 *        what users/{uid} holds now (missing fields = a fresh trial)
 * @param {'start'|'renew'|'end'} action
 * @param {number} nowMs server clock
 * @param {number} [networkUsedMs] what the caller's network had used BEFORE this call
 * @returns {{ usedMs: number, lastTickMs: number|null, leaseMs: number, remainingMs: number,
 *             networkUsedMs: number }}
 *          the state to store (player and network), plus the lease granted by
 *          this call (0 = none); remainingMs is the smaller of the two clocks
 */
export function applyLease(state, action, nowMs, networkUsedMs = 0) {
  const startMs = Math.min(TRIAL_MS, Math.max(0, Number(state.usedMs) || 0));
  let usedMs = startMs;
  const last = Number.isFinite(state.lastTickMs) ? state.lastTickMs : null;

  if (last !== null) {
    const granted = Number.isFinite(state.leaseMs) ? state.leaseMs : LEASE_MS;
    const elapsed = Math.max(0, nowMs - last);
    usedMs += Math.min(elapsed, granted + GRACE_MS);
  }
  usedMs = Math.min(TRIAL_MS, Math.round(usedMs));
  const netUsedMs = Math.min(TRIAL_MS,
    Math.max(0, Number(networkUsedMs) || 0) + (usedMs - startMs));
  const remainingMs = TRIAL_MS - Math.max(usedMs, netUsedMs);

  if (action === 'end' || remainingMs <= 0) {
    return { usedMs, lastTickMs: null, leaseMs: 0, remainingMs, networkUsedMs: netUsedMs };
  }
  const leaseMs = Math.min(LEASE_MS, remainingMs);
  return { usedMs, lastTickMs: nowMs, leaseMs, remainingMs, networkUsedMs: netUsedMs };
}

/** Remaining trial for display, without moving either clock. */
export function remainingMs(state, networkUsedMs = 0) {
  const used = Math.max(Number(state.usedMs) || 0, Number(networkUsedMs) || 0, 0);
  return Math.max(0, TRIAL_MS - used);
}
