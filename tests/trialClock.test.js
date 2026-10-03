// js/account/trialClock.js — the in-session side of the free trial. The
// lease call, timers and clock are injected; these drive the whole lifecycle
// with a scripted server and manual timers.

import { createTrialClock } from '../js/account/trialClock.js';

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
