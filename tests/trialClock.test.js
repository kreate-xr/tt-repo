// js/account/trialClock.js — the in-session side of the free trial. The
// lease call, timers and clock are injected; these drive the whole lifecycle
// with a scripted server and manual timers.

import { createTrialClock, OFFLINE_GRACE_MS } from '../js/account/trialClock.js';

function harness(responses) {
  const calls = [];
  const timers = [];
  const expired = [];
  const warned = [];
  const queue = [...responses];
  const clock = createTrialClock({
    lease: async (action) => {
      calls.push(action);
      const next = queue.length ? queue.shift() : { entitled: false, leaseSec: 60, remainingSec: 500 };
      if (next instanceof Error) throw next;
      return next;
    },
    onExpired: (info) => expired.push(info),
    onWarn: (sec) => warned.push(sec),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
  });
  const liveTimers = () => timers.filter((t) => t.live);
  const fire = async () => {
    const t = liveTimers().pop();
    if (!t) throw new Error('no live timer');
    t.live = false;
    t.fn();
    await clock._settled();
    return t.ms;
  };
  return { clock, calls, expired, warned, liveTimers, fire };
}

const lease = (leaseSec, remainingSec) => ({ entitled: false, leaseSec, remainingSec });
const apiError = (code, status = 0) => Object.assign(new Error(code), { code, status });

test('start → renew before the lease runs out → end', async () => {
  const h = harness([lease(60, 600), lease(60, 550), lease(0, 520)]);
  await h.clock.setPlaying(true);
  expect(h.calls).toEqual(['start']);
  // Renews 10 s before the 60 s lease expires.
  expect(h.liveTimers()[0].ms).toBe(50_000);

  await h.fire();
  expect(h.calls).toEqual(['start', 'renew']);

  await h.clock.setPlaying(false);
  expect(h.calls).toEqual(['start', 'renew', 'end']);
  expect(h.liveTimers()).toHaveLength(0);
  expect(h.expired).toEqual([]);
});

test('repeated setPlaying with the same value makes no calls (per-frame safe)', async () => {
  const h = harness([]);
  await h.clock.setPlaying(false);
  expect(h.calls).toEqual([]);
  await h.clock.setPlaying(true);
  await h.clock.setPlaying(true);
  await h.clock.setPlaying(true);
  expect(h.calls).toEqual(['start']);
});

test('server says no lease left → expires once and stops metering', async () => {
  const h = harness([lease(0, 0)]);
  await h.clock.setPlaying(true);
  expect(h.expired).toEqual([{ reason: 'trial_over' }]);
  expect(h.clock.expired).toBe(true);
  await h.clock.setPlaying(false);
  await h.clock.setPlaying(true);
  expect(h.calls).toEqual(['start']);
  expect(h.liveTimers()).toHaveLength(0);
});

test('the trial running out on a renew expires the clock', async () => {
  const h = harness([lease(60, 70), lease(10, 10), lease(0, 0)]);
  await h.clock.setPlaying(true);
  await h.fire();
  // A short final lease renews early, not at a negative delay.
  expect(h.liveTimers()[0].ms).toBe(1000);
  await h.fire();
  expect(h.expired).toEqual([{ reason: 'trial_over' }]);
});

test('warns once when a minute or less is left', async () => {
  const h = harness([lease(60, 120), lease(60, 60), lease(30, 30)]);
  await h.clock.setPlaying(true);
  expect(h.warned).toEqual([]);
  await h.fire();
  await h.fire();
  expect(h.warned).toEqual([60]);
});

test('entitled players are never metered', async () => {
  const h = harness([{ entitled: true, leaseSec: null, remainingSec: null }]);
  await h.clock.setPlaying(true);
  expect(h.liveTimers()).toHaveLength(0);
  await h.clock.setPlaying(false);
  await h.clock.setPlaying(true);
  await h.clock.dispose();
  expect(h.calls).toEqual(['start']);
  expect(h.expired).toEqual([]);
});

test('fail-open: a network error retries and never expires the trial', async () => {
  const h = harness([apiError('network_error'), apiError('http_error', 500), lease(60, 400)]);
  await h.clock.setPlaying(true);
  expect(h.liveTimers()[0].ms).toBe(10_000);
  await h.fire();
  await h.fire();
  expect(h.calls).toEqual(['start', 'start', 'start']);
  expect(h.expired).toEqual([]);
  expect(h.clock.running).toBe(true);
});

test('the per-network new-trial cap ends the trial', async () => {
  const h = harness([apiError('trial_ip_limit', 429)]);
  await h.clock.setPlaying(true);
  expect(h.expired).toEqual([{ reason: 'ip_limit' }]);
});

test('dispose while playing settles the bill with a final end', async () => {
  const h = harness([lease(60, 500)]);
  await h.clock.setPlaying(true);
  await h.clock.dispose();
  expect(h.calls).toEqual(['start', 'end']);
  expect(h.liveTimers()).toHaveLength(0);
  // Nothing after dispose.
  await h.clock.setPlaying(true);
  expect(h.calls).toEqual(['start', 'end']);
});

test('dispose when not playing sends nothing', async () => {
  const h = harness([]);
  await h.clock.dispose();
  expect(h.calls).toEqual([]);
});

test('a renew queued behind a stop does not go out', async () => {
  const h = harness([lease(60, 500)]);
  await h.clock.setPlaying(true);
  const timer = h.liveTimers()[0];
  await h.clock.setPlaying(false);
  // The cancelled timer firing late (a race the real setTimeout can lose).
  timer.fn();
  await h.clock._settled();
  expect(h.calls).toEqual(['start', 'end']);
});

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
    onExpired: () => {},
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

test('the trial stays fail-open even when offline for long', async () => {
  const h = meteredHarness(
    [lease(60, 600), ...Array.from({ length: 200 }, () => apiError('network_error'))],
    { metered: false },
  );
  h.clock.setPlaying(true);
  await h.flush();
  await h.advance(20 * 60_000);
  expect(h.blocked).toEqual([]);
  expect(h.clock.running).toBe(true);
});
