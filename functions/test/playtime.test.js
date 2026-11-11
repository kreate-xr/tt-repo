import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlayLease, playedMs, playState, refundBlock, meterPaidPlay, paidPlayedMs, playAtGrant,
  REFUND_PLAY_LIMIT_MS,
} from '../src/playtime.js';

const T0 = 1_700_000_000_000;
const DAY = 24 * 3600_000;

test('play lease credits server-clock time, capped at lease + grace', () => {
  let s = applyPlayLease({}, 'start', T0, 60_000);
  assert.deepEqual(s, { totalMs: 0, lastTickMs: T0, leaseMs: 60_000 });
  s = applyPlayLease(s, 'renew', T0 + 50_000, 60_000);
  assert.equal(s.totalMs, 50_000);
  // A client that goes quiet for ten minutes is billed one lease + 15 s grace.
  s = applyPlayLease(s, 'end', T0 + 50_000 + 600_000, 0);
  assert.deepEqual(s, { totalMs: 50_000 + 75_000, lastTickMs: null, leaseMs: 0 });
});

test('playedMs includes an open lease; playState seeds from a legacy trial', () => {
  assert.equal(playedMs({ totalMs: 1000, lastTickMs: T0, leaseMs: 60_000 }, T0 + 30_000), 31_000);
  assert.deepEqual(playState({ trial: { usedMs: 240_000, lastTickMs: null, leaseMs: 0 } }),
    { totalMs: 240_000, lastTickMs: null, leaseMs: 0 });
  assert.deepEqual(playState({ play: { totalMs: 5 }, trial: { usedMs: 9 } }), { totalMs: 5 });
});

test('refundBlock checks a → d in order', () => {
  const ok = { orderStatus: 'paid', refundUsed: false, refundableUntil: T0 + DAY, played: 0, nowMs: T0 };
  assert.equal(refundBlock(ok), null);
  assert.equal(refundBlock({ ...ok, orderStatus: 'awaiting_payment', refundUsed: true }), 'not_paid');
  assert.equal(refundBlock({ ...ok, orderStatus: 'refunded' }), 'already_refunded');
  assert.equal(refundBlock({ ...ok, refundUsed: true, refundableUntil: T0 - 1, played: 1e9 }), 'refund_used');
  assert.equal(refundBlock({ ...ok, refundableUntil: T0, played: 1e9 }), 'refund_window_expired');
  assert.equal(refundBlock({ ...ok, refundableUntil: null }), 'refund_window_expired');
  assert.equal(refundBlock({ ...ok, played: REFUND_PLAY_LIMIT_MS }), 'played_too_long');
  assert.equal(refundBlock({ ...ok, played: REFUND_PLAY_LIMIT_MS - 1 }), null);
  // Skipped checks (undefined) let the endpoint run a–b before asking PayLayer.
  assert.equal(refundBlock({ orderStatus: 'paid', refundUsed: false, nowMs: T0 }), null);
  // A retry of a refund already requested passes a.
  assert.equal(refundBlock({ ...ok, orderStatus: 'refund_requested' }), null);
});

test('meterPaidPlay: only an active, paid, still-refundable purchase is metered', () => {
  const ent = { active: true, refundableUntil: new Date(T0 + DAY), grantedAt: new Date(T0) };
  const order = { status: 'paid', refundWindowDays: 3 };
  const user = { play: { totalMs: 0 } };
  assert.equal(meterPaidPlay({ ent, order, user, nowMs: T0 }), true);
  assert.equal(meterPaidPlay({ ent: { ...ent, active: false }, order, user, nowMs: T0 }), false);
  assert.equal(meterPaidPlay({ ent, order: { ...order, status: 'refund_requested' }, user, nowMs: T0 }), false);
  assert.equal(meterPaidPlay({ ent, order, user: { ...user, refundUsed: true }, nowMs: T0 }), false);
  assert.equal(meterPaidPlay({ ent, order, user, nowMs: T0 + DAY }), false);
  assert.equal(meterPaidPlay({ ent, order, user: { play: { totalMs: REFUND_PLAY_LIMIT_MS } }, nowMs: T0 }), false);
  // No cached window (granted before it was cached): grant time + the order's days.
  const old = { active: true, grantedAt: new Date(T0) };
  assert.equal(meterPaidPlay({ ent: old, order, user, nowMs: T0 + 2 * DAY }), true);
  assert.equal(meterPaidPlay({ ent: old, order, user, nowMs: T0 + 3 * DAY }), false);
});

test('paid play counts from the purchase; grants from before playAtGrantMs count from zero', () => {
  const user = { play: { totalMs: 50 * 60_000, lastTickMs: null, leaseMs: 0 } };
  assert.equal(playAtGrant({}), 0);
  assert.equal(playAtGrant({ playAtGrantMs: 'x' }), 0);
  assert.equal(paidPlayedMs(user, { playAtGrantMs: 30 * 60_000 }, T0), 20 * 60_000);
  assert.equal(paidPlayedMs(user, {}, T0), 50 * 60_000);
  // Never negative, whatever the stored numbers say.
  assert.equal(paidPlayedMs(user, { playAtGrantMs: 99 * 60_000 }, T0), 0);
});

test('meterPaidPlay reads paid play only', () => {
  const order = { status: 'paid', refundWindowDays: 3 };
  const user = { play: { totalMs: 3 * 3600_000, lastTickMs: null, leaseMs: 0 } };
  const ent = { active: true, refundableUntil: T0 + DAY, playAtGrantMs: 2 * 3600_000 };
  assert.equal(meterPaidPlay({ ent, order, user, nowMs: T0 }), true);
  assert.equal(meterPaidPlay({ ent: { ...ent, playAtGrantMs: 0 }, order, user, nowMs: T0 }), false);
});
