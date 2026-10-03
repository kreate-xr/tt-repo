import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLease, remainingMs, TRIAL_MS, LEASE_MS, GRACE_MS } from '../src/trial.js';

const T0 = 1_700_000_000_000;

test('first start grants a lease and charges nothing', () => {
  const s = applyLease({}, 'start', T0);
  assert.equal(s.usedMs, 0);
  assert.equal(s.leaseMs, LEASE_MS);
  assert.equal(s.lastTickMs, T0);
  assert.equal(s.remainingMs, TRIAL_MS);
});

test('renew charges the real time elapsed', () => {
  const a = applyLease({}, 'start', T0);
  const b = applyLease(a, 'renew', T0 + 45_000);
  assert.equal(b.usedMs, 45_000);
  assert.equal(b.lastTickMs, T0 + 45_000);
});

test('a late renew is charged at most lease + grace', () => {
  const a = applyLease({}, 'start', T0);
  const b = applyLease(a, 'renew', T0 + 10 * 60_000);
  assert.equal(b.usedMs, LEASE_MS + GRACE_MS);
});

test('a crash (start over a stale lease) costs at most one lease', () => {
  const a = applyLease({}, 'start', T0);
  const b = applyLease(a, 'start', T0 + 3 * 3600_000);
  assert.equal(b.usedMs, LEASE_MS + GRACE_MS);
  assert.equal(b.leaseMs, LEASE_MS);
});

test('end charges the elapsed time and stops the clock', () => {
  const a = applyLease({}, 'start', T0);
  const b = applyLease(a, 'end', T0 + 20_000);
  assert.equal(b.usedMs, 20_000);
  assert.equal(b.lastTickMs, null);
  assert.equal(b.leaseMs, 0);
  // Time in menus after `end` is free.
  const c = applyLease(b, 'start', T0 + 600_000);
  assert.equal(c.usedMs, 20_000);
});

test('the last lease is shortened to what is left', () => {
  const s = applyLease({ usedMs: TRIAL_MS - 25_000 }, 'start', T0);
  assert.equal(s.leaseMs, 25_000);
});

test('an exhausted trial grants nothing and never goes past 10 minutes', () => {
  const a = applyLease({ usedMs: TRIAL_MS - 10_000 }, 'start', T0);
  const b = applyLease(a, 'renew', T0 + 60_000);
  assert.equal(b.usedMs, TRIAL_MS);
  assert.equal(b.leaseMs, 0);
  assert.equal(b.remainingMs, 0);
  assert.equal(b.lastTickMs, null);
});

test('a clock going backwards never refunds time', () => {
  const a = applyLease({ usedMs: 30_000, lastTickMs: T0, leaseMs: LEASE_MS }, 'renew', T0 - 5_000);
  assert.equal(a.usedMs, 30_000);
});

test('ten minutes of steady play exhausts the trial', () => {
  let s = applyLease({}, 'start', T0);
  let t = T0;
  while (s.leaseMs > 0) {
    t += s.leaseMs;
    s = applyLease(s, 'renew', t);
  }
  assert.equal(s.usedMs, TRIAL_MS);
  assert.equal(t - T0, TRIAL_MS);
});

test('remainingMs reads without moving the clock', () => {
  assert.equal(remainingMs({}), TRIAL_MS);
  assert.equal(remainingMs({ usedMs: 100_000 }), TRIAL_MS - 100_000);
  assert.equal(remainingMs({ usedMs: TRIAL_MS * 2 }), 0);
});
