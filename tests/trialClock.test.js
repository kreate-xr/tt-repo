// js/account/trialClock.js — the in-session side of paid-play metering (the
// file keeps its free-trial-era name; the free version is never metered). The
// lease call, timers and clock are injected; these drive the whole lifecycle
// with a scripted server and fake time.

import { createTrialClock, OFFLINE_GRACE_MS } from '../js/account/trialClock.js';

const apiError = (code, status = 0) => Object.assign(new Error(code), { code, status });

// ── paid play while a refund is still possible: fail-closed ─────────────────

const HANG = Symbol('hang');
const paid = (leaseSec = 60) => ({ entitled: true, metered: true, leaseSec, remainingSec: null });

// Fake clock + timers that fire in time order, so the renew chain and the
// offline watchdog run side by side as they would in the headset.
function meteredHarness(responses, { metered = true, stored = 0 } = {}) {
  let t = 0;
  let store = stored;
  const timers = [];
  const calls = [];
  const blocked = [];
  const queue = [...responses];
  const clock = createTrialClock({
    lease: async (action) => {
      calls.push(action);
      const next = queue.length ? queue.shift() : paid();
      if (next === HANG) return new Promise(() => {});
      if (next instanceof Error) throw next;
      return next;
    },
    onBlocked: () => blocked.push(t),
    metered,
    offlineStore: { get: () => store, set: (v) => { store = v; } },
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms, live: true }; timers.push(x); return x; },
    clearTimer: (x) => { x.live = false; },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      due.live = false;
      due.fn();
      await flush();
    }
    t = end;
  }
  return { clock, calls, blocked, advance, flush, store: () => store };
}

test('paid + refundable: keeps renewing and is never blocked while the server answers', async () => {
  const h = meteredHarness([]);
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(10 * 60_000);
  expect(h.calls[0]).toBe('start');
  expect(h.calls.filter((c) => c === 'renew').length).toBeGreaterThanOrEqual(11);
  expect(h.blocked).toEqual([]);
  expect(h.store()).toBe(0);
});

test('paid + refundable, offline: play is blocked after two unmetered minutes', async () => {
  const offline = Array.from({ length: 50 }, () => apiError('network_error'));
  const h = meteredHarness(offline);
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(OFFLINE_GRACE_MS - 5_000);
  expect(h.blocked).toEqual([]);
  await h.advance(5_000);
  expect(h.blocked).toEqual([OFFLINE_GRACE_MS]);
  expect(h.clock.blocked).toBe(true);
  expect(h.clock.running).toBe(false);
  // Remembered for the next session.
  expect(h.store()).toBeGreaterThanOrEqual(OFFLINE_GRACE_MS);
  const n = h.calls.length;
  await h.advance(60_000);
  expect(h.calls.length).toBe(n);
});

test('the lease the server granted covers its own minute: only time past it counts', async () => {
  // One good lease, then the network drops.
  const h = meteredHarness([paid(60), ...Array.from({ length: 50 }, () => apiError('network_error'))]);
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(60_000 + OFFLINE_GRACE_MS - 5_000);
  expect(h.blocked).toEqual([]);
  await h.advance(5_000);
  expect(h.blocked).toEqual([60_000 + OFFLINE_GRACE_MS]);
});

test('re-entering offline does not start a fresh allowance', async () => {
  const offline = Array.from({ length: 10 }, () => apiError('network_error'));
  const h = meteredHarness(offline, { stored: OFFLINE_GRACE_MS });
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(5_000);
  expect(h.blocked).toEqual([5_000]);
});

test('re-entering online clears what was owed', async () => {
  const h = meteredHarness([paid(60)], { stored: OFFLINE_GRACE_MS + 30_000 });
  h.clock.setPlaying(true);
  await h.flush();
  expect(h.store()).toBe(0);
  await h.advance(5 * 60_000);
  expect(h.blocked).toEqual([]);
});

test('a request that hangs forever still blocks', async () => {
  const h = meteredHarness([HANG]);
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(OFFLINE_GRACE_MS);
  expect(h.blocked).toEqual([OFFLINE_GRACE_MS]);
});

test('menu time is free: only unmetered PLAY counts toward the two minutes', async () => {
  const offline = Array.from({ length: 50 }, () => apiError('network_error'));
  const h = meteredHarness(offline);
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(60_000);
  h.clock.setPlaying(false);
  await h.flush();
  await h.advance(10 * 60_000);
  expect(h.blocked).toEqual([]);
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(55_000);
  expect(h.blocked).toEqual([]);
  await h.advance(10_000);
  expect(h.blocked.length).toBe(1);
});

test('once the server says metered:false, nothing is metered and nothing blocks', async () => {
  const h = meteredHarness([
    { entitled: true, metered: false, leaseSec: null, remainingSec: null },
    ...Array.from({ length: 50 }, () => apiError('network_error')),
  ]);
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(30 * 60_000);
  expect(h.calls).toEqual(['start']);
  expect(h.blocked).toEqual([]);
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test('start → renew before the lease runs out → end', async () => {
  const h = meteredHarness([paid(60), paid(60), paid(0)], { metered: false });
  h.clock.setPlaying(true);
  await h.flush();
  expect(h.calls).toEqual(['start']);
  // Renews 10 s before the 60 s lease expires.
  await h.advance(49_000);
  expect(h.calls).toEqual(['start']);
  await h.advance(1_000);
  expect(h.calls).toEqual(['start', 'renew']);
  h.clock.setPlaying(false);
  await h.flush();
  expect(h.calls).toEqual(['start', 'renew', 'end']);
  await h.advance(10 * 60_000);
  expect(h.calls).toEqual(['start', 'renew', 'end']);
  expect(h.blocked).toEqual([]);
});

test('repeated setPlaying with the same value makes no calls (per-frame safe)', async () => {
  const h = meteredHarness([], { metered: false });
  h.clock.setPlaying(false);
  await h.flush();
  expect(h.calls).toEqual([]);
  h.clock.setPlaying(true);
  h.clock.setPlaying(true);
  h.clock.setPlaying(true);
  await h.flush();
  expect(h.calls).toEqual(['start']);
});

test('a not-entitled answer (refunded, or a stale cached tier) just stops the clock', async () => {
  const h = meteredHarness([{ entitled: false, metered: false, leaseSec: 60, remainingSec: 600 }]);
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(30 * 60_000);
  h.clock.setPlaying(false);
  h.clock.setPlaying(true);
  await h.clock.dispose();
  expect(h.calls).toEqual(['start']);
  expect(h.blocked).toEqual([]);
  expect(h.clock.running).toBe(false);
});

test('a network error retries every 10 s while the refund state is unknown', async () => {
  const h = meteredHarness([apiError('network_error'), apiError('http_error', 500), paid(60)], { metered: false });
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(20_000);
  expect(h.calls).toEqual(['start', 'start', 'start']);
  expect(h.clock.running).toBe(true);
});

test('dispose while playing settles the bill with a final end', async () => {
  const h = meteredHarness([paid(60)]);
  h.clock.setPlaying(true);
  await h.flush();
  await h.clock.dispose();
  expect(h.calls).toEqual(['start', 'end']);
  // Nothing after dispose.
  h.clock.setPlaying(true);
  await h.advance(5 * 60_000);
  expect(h.calls).toEqual(['start', 'end']);
  expect(h.blocked).toEqual([]);
});

test('dispose when not playing sends nothing', async () => {
  const h = meteredHarness([]);
  await h.clock.dispose();
  expect(h.calls).toEqual([]);
});

test('a renew queued behind a stop does not go out', async () => {
  const h = meteredHarness([paid(60)]);
  h.clock.setPlaying(true);
  await h.flush();
  h.clock.setPlaying(false);
  await h.flush();
  // The renew timer was cancelled; even long after, only start + end went out.
  await h.advance(5 * 60_000);
  expect(h.calls).toEqual(['start', 'end']);
});
