// End-to-end flows through the real handlers against the Firestore emulator:
// trial lease, IP cap, shared network clock, checkout, webhook grant / dedupe,
// paid-play metering and the refund rules. Token verification and PayLayer
// are stubbed; Firestore is real.
//
//   npm run test:emulator   (from functions/; wraps this in emulators:exec)
//
// Skipped when no emulator is running, so `npm test` stays offline.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createHandler } from '../src/handlers.js';
import { signWebhookPayload } from '../src/paylayer.js';
import { TRIAL_MS } from '../src/trial.js';

const RUN = !!process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-functions-test';
const WEBHOOK_SECRET = 'whsec_test';
const DAY = 24 * 3600_000;
const HOUR = 3600_000;

let db;
let clock;
let pay;   // what the PayLayer stub holds and was asked
let logs;
let ipLimit;

// Token = "uid|provider|email" — stands in for verifyIdToken.
const token = (uid, provider = 'anonymous', email = null) => [uid, provider, email || ''].join('|');

const json = (status, body) => new Response(JSON.stringify(body), { status });
const payError = (status, code) => json(status, { error: { code, message: code } });

// PayLayer as the game sees it: create (with Stripe-style idempotent replay,
// 422 on a different body), retrieve, refund. `pay.onCreate` / `pay.onRefund`
// override those answers; throwing from one is a network failure.
async function payLayerStub(url, init) {
  const { pathname } = new URL(url);
  const method = init.method;
  const body = init.body ? JSON.parse(init.body) : undefined;
  const idempotencyKey = init.headers['idempotency-key'];
  pay.calls.push({ method, path: pathname, body, idempotencyKey, auth: init.headers.authorization });

  if (method === 'POST' && pathname === '/v1/payment-intents') {
    if (pay.onCreate) return pay.onCreate();
    const prior = pay.byKey.get(idempotencyKey);
    if (prior) {
      if (JSON.stringify(prior.body) !== JSON.stringify(body)) return payError(422, 'idempotency_key_reused');
      return json(201, prior.response);
    }
    const id = `pi_${String(pay.intents.size + 1).padStart(26, '0')}`;
    const intent = { id, status: 'created', paidAt: null, refundableUntil: null, ...body };
    pay.intents.set(id, intent);
    const response = { ...intent, clientSecret: `${id}_secret_x` };
    pay.byKey.set(idempotencyKey, { body, response });
    return json(201, response);
  }
  const get = pathname.match(/^\/v1\/payment-intents\/([^/]+)$/);
  if (method === 'GET' && get) {
    const intent = pay.intents.get(decodeURIComponent(get[1]));
    return intent ? json(200, { ...intent, payments: [], refunds: [] }) : payError(404, 'not_found');
  }
  const refund = pathname.match(/^\/v1\/payment-intents\/([^/]+)\/refunds$/);
  if (method === 'POST' && refund) {
    if (pay.onRefund) return pay.onRefund();
    return json(201, { id: 'rf_1', object: 'refund', status: 'processed', intentId: refund[1] });
  }
  return payError(404, 'not_found');
}

const createCalls = () => pay.calls.filter((c) => c.method === 'POST' && c.path === '/v1/payment-intents');
const refundCalls = () => pay.calls.filter((c) => c.path.endsWith('/refunds'));

function makeHandler() {
  return createHandler({
    db,
    verifyIdToken: async (t) => {
      const [uid, provider, email] = t.split('|');
      if (!uid) throw new Error('bad token');
      return { uid, email: email || undefined, email_verified: false, firebase: { sign_in_provider: provider } };
    },
    verifyAppCheck: async () => ({}),
    now: () => clock,
    log: (e) => logs.push(e),
    config: () => ({
      appCheckEnforce: false,
      trialIpDailyLimit: ipLimit,
      trialIpSalt: 'salt',
      paylayerUrl: 'https://pay.test',
      paylayerApiKey: 'sk_test_x',
      paylayerWebhookSecret: WEBHOOK_SECRET,
    }),
    fetchImpl: payLayerStub,
  });
}

async function call(method, path, { auth, body, headers = {}, rawBody, ip = '203.0.113.7' } = {}) {
  const req = {
    method,
    path,
    headers: { ...headers, 'x-forwarded-for': `${ip}, 10.0.0.1` },
    body,
    rawBody: rawBody ?? Buffer.from(body ? JSON.stringify(body) : ''),
  };
  if (auth) req.headers.authorization = `Bearer ${auth}`;
  const res = {
    statusCode: 0, payload: null, hdrs: {},
    set(k, v) { this.hdrs[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  await makeHandler()(req, res);
  return { status: res.statusCode, body: res.payload, headers: res.hdrs };
}

// Signed at the real time, as PayLayer does: verifyWebhook checks the
// signature age against the wall clock, not the test's `clock`.
async function webhook(event) {
  const raw = JSON.stringify(event);
  const r = await call('POST', '/webhooks/paylayer', {
    rawBody: Buffer.from(raw),
    headers: { 'x-paylayer-signature': signWebhookPayload(WEBHOOK_SECRET, raw) },
  });
  assert.equal(r.status, 200, `webhook ${event.type}: ${JSON.stringify(r.body)}`);
  return r;
}

const event = (id, type, intent, extra = {}) => ({
  id, type, created: Math.floor(clock / 1000), livemode: false, data: { intent, ...extra },
});

const paidEvent = (id, orderId, intentId) => event(id, 'payment_intent.paid',
  { id: intentId, siteReference: orderId, amount: 199700, currency: 'INR', status: 'paid' });

const order = async (orderId) => (await db.doc(`orders/${orderId}`).get()).data();
const ent = async (uid) => (await db.doc(`entitlements/${uid}`).get()).data();
const user = async (uid) => (await db.doc(`users/${uid}`).get()).data();

/** Checkout through POST /api/orders; returns the token and ids. */
async function checkout(uid, { phone = '+919876543210', name = 'Asha Rao' } = {}) {
  const t = token(uid, 'password', `${uid}@example.com`);
  const r = await call('POST', '/api/orders', { auth: t, body: { name, phone, consent: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const intent = pay.intents.get(r.body.intentId);
  return { t, uid, intentId: intent.id, orderId: intent.siteReference, body: r.body };
}

/** PayLayer captures the payment and sends payment_intent.paid. */
async function payFor({ intentId }, eventId = `evt_paid_${intentId}`) {
  const intent = pay.intents.get(intentId);
  intent.status = 'paid';
  intent.paidAt = new Date(clock).toISOString();
  intent.refundableUntil = new Date(clock + intent.refundWindowDays * DAY).toISOString();
  intent.capturedPaymentId = 'pay_1';
  const r = await webhook(event(eventId, 'payment_intent.paid', intent));
  assert.equal(r.status, 200);
  return intent;
}

const refundEvent = (type, { intentId, orderId }, id = `evt_${type.replace('.', '_')}_${intentId}`) => event(id, type,
  { ...pay.intents.get(intentId), id: intentId, siteReference: orderId },
  { refund: { id: 'rf_1', object: 'refund', intentId, status: type.split('.')[1] } });

/** Plays `ms` as the client does: start, renew every minute, end. Returns the end. */
async function playFor(t, ms) {
  const lease = (action) => call('POST', '/api/trial/lease', { auth: t, body: { action } });
  await lease('start');
  for (let left = ms; left > 0; left -= 60_000) {
    clock += Math.min(60_000, left);
    if (left > 60_000) await lease('renew');
  }
  return lease('end');
}

const requestRefund = (t) => call('POST', '/api/refund', { auth: t, body: {} });

before(() => {
  if (!RUN) return;
  db = getFirestore(initializeApp({ projectId: PROJECT }), 'tabletennis');
});

beforeEach(async () => {
  if (!RUN) return;
  clock = Date.now();
  pay = { intents: new Map(), byKey: new Map(), calls: [], onCreate: null, onRefund: null };
  logs = [];
  ipLimit = 5;
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/tabletennis/documents`, { method: 'DELETE' });
});

test('trial: start, renew, end, then exhaustion', { skip: !RUN }, async () => {
  const t = token('u-trial');
  let r = await call('POST', '/api/trial/lease', { auth: t, body: { action: 'start' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { entitled: false, leaseSec: 60, remainingSec: 600 });
  assert.equal(r.headers['Cache-Control'], 'no-store');

  clock += 50_000;
  r = await call('POST', '/api/trial/lease', { auth: t, body: { action: 'renew' } });
  assert.equal(r.body.remainingSec, 550);

  clock += 30_000;
  r = await call('POST', '/api/trial/lease', { auth: t, body: { action: 'end' } });
  assert.equal(r.body.remainingSec, 520);
  assert.equal(r.body.leaseSec, 0);

  r = await call('GET', '/api/me', { auth: t });
  assert.equal(r.body.trial.remainingSec, 520);
  assert.equal(r.body.entitled, false);
  assert.equal(r.body.account.anonymous, true);

  await db.doc('users/u-trial').set({ trial: { usedMs: TRIAL_MS, lastTickMs: null, leaseMs: 0 } }, { merge: true });
  r = await call('POST', '/api/trial/lease', { auth: t, body: { action: 'start' } });
  assert.deepEqual(r.body, { entitled: false, leaseSec: 0, remainingSec: 0 });
});

test('trial: renew/end without a trial does not create one', { skip: !RUN }, async () => {
  const r = await call('POST', '/api/trial/lease', { auth: token('u-stray'), body: { action: 'renew' } });
  assert.equal(r.status, 200);
  assert.equal((await db.doc('users/u-stray').get()).exists, false);
});

test('trial: rejects bad input and missing auth', { skip: !RUN }, async () => {
  assert.equal((await call('POST', '/api/trial/lease', { body: { action: 'start' } })).status, 401);
  assert.equal((await call('POST', '/api/trial/lease', { auth: token('u'), body: { action: 'reset' } })).status, 400);
  assert.equal((await call('GET', '/api/nope', { auth: token('u') })).status, 404);
});

test('trial: per-IP cap on NEW trials only', { skip: !RUN }, async () => {
  ipLimit = 2;
  for (const uid of ['a', 'b']) {
    const r = await call('POST', '/api/trial/lease', { auth: token(uid), body: { action: 'start' } });
    assert.equal(r.status, 200);
  }
  let r = await call('POST', '/api/trial/lease', { auth: token('c'), body: { action: 'start' } });
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'trial_ip_limit');
  assert.equal((await db.doc('users/c').get()).exists, false);

  // Existing trials keep working from the same network.
  r = await call('POST', '/api/trial/lease', { auth: token('a'), body: { action: 'start' } });
  assert.equal(r.status, 200);
  // A different network is unaffected.
  r = await call('POST', '/api/trial/lease', { auth: token('c'), body: { action: 'start' }, ip: '198.51.100.9' });
  assert.equal(r.status, 200);
});

// Plays `ms` of trial for `uid` from `ip`, renewing every lease like the client.
async function play(uid, ms, ip) {
  const lease = (action) => call('POST', '/api/trial/lease', { auth: token(uid), body: { action }, ip });
  await lease('start');
  for (let left = ms; left > 0; left -= 60_000) {
    clock += Math.min(60_000, left);
    if (left > 60_000) await lease('renew');
  }
  return lease('end');
}

test('trial: a private window on the same network inherits the minutes left', { skip: !RUN }, async () => {
  let r = await play('ravi', 7 * 60_000 - 20_000, '203.0.113.7');
  r = await play('ravi', 20_000, '203.0.113.7');
  assert.equal(r.body.remainingSec, 180);

  // New anonymous uid (private window), same Wi-Fi: 3 min, not 10.
  r = await call('GET', '/api/me', { auth: token('ravi-private') });
  assert.equal(r.body.trial.remainingSec, 180);
  r = await call('POST', '/api/trial/lease', { auth: token('ravi-private'), body: { action: 'start' } });
  assert.deepEqual(r.body, { entitled: false, leaseSec: 60, remainingSec: 180 });
  clock += 60_000;
  r = await call('POST', '/api/trial/lease', { auth: token('ravi-private'), body: { action: 'end' } });
  assert.equal(r.body.remainingSec, 120);

  // Used up on this network → the next fresh uid gets nothing.
  await play('ravi-private', 3 * 60_000, '203.0.113.7');
  r = await call('POST', '/api/trial/lease', { auth: token('ravi-again'), body: { action: 'start' } });
  assert.deepEqual(r.body, { entitled: false, leaseSec: 0, remainingSec: 0 });

  // The player's own clock still follows them to another network…
  r = await call('POST', '/api/trial/lease', { auth: token('ravi'), body: { action: 'start' }, ip: '198.51.100.9' });
  assert.equal(r.body.remainingSec, 180);
  // …while a fresh uid there gets a full trial.
  r = await call('POST', '/api/trial/lease', { auth: token('friend'), body: { action: 'start' }, ip: '198.51.100.9' });
  assert.equal(r.body.remainingSec, 600);
});

test('trial: IPv6 privacy addresses in one /64 share a network', { skip: !RUN }, async () => {
  await play('v6-a', 4 * 60_000, '2001:db8:abcd:12:1111:2222:3333:4444');
  const r = await call('POST', '/api/trial/lease', {
    auth: token('v6-b'), body: { action: 'start' }, ip: '2001:db8:abcd:12:aaaa:bbbb:cccc:dddd',
  });
  assert.equal(r.body.remainingSec, 360);
});

test('trial: a network forgets its minutes 30 days after it last played', { skip: !RUN }, async () => {
  await play('old', TRIAL_MS, '203.0.113.7');
  clock += 29 * 24 * 3600_000;
  let r = await call('GET', '/api/me', { auth: token('new-1') });
  assert.equal(r.body.trial.remainingSec, 0);
  clock += 2 * 24 * 3600_000;
  r = await call('POST', '/api/trial/lease', { auth: token('new-2'), body: { action: 'start' } });
  assert.equal(r.body.remainingSec, 600);
});

// ── orders ──────────────────────────────────────────────────────────────────

test('orders: anonymous accounts cannot buy', { skip: !RUN }, async () => {
  const r = await call('POST', '/api/orders', { auth: token('u-anon'), body: { name: 'A', phone: '+919876543210', consent: true } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'account_required');
  assert.equal(pay.calls.length, 0);
});

test('orders: an upgraded anonymous account (provider still "anonymous", email set) can buy', { skip: !RUN }, async () => {
  const t = token('u-linked', 'anonymous', 'linked@example.com');
  const r = await call('POST', '/api/orders', { auth: t, body: { name: 'L', phone: '+919876543210', consent: true } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', { auth: t })).body.account.anonymous, false);
});

test('orders: validates name and phone', { skip: !RUN }, async () => {
  const t = token('u-buy', 'password', 'a@example.com');
  const order = (body) => call('POST', '/api/orders', { auth: t, body: { consent: true, ...body } });
  assert.equal((await order({ name: '', phone: '+919876543210' })).body.error.code, 'invalid_name');
  assert.equal((await order({ name: 'A', phone: '98765' })).body.error.code, 'invalid_phone');
  assert.equal(pay.calls.length, 0);
});

test('orders: the server rejects a request without consent', { skip: !RUN }, async () => {
  const t = token('u-noconsent', 'password', 'n@example.com');
  for (const consent of [undefined, false, 'true', 1]) {
    const r = await call('POST', '/api/orders', { auth: t, body: { name: 'N', phone: '+919876543210', consent } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'consent_required');
  }
  assert.equal(pay.calls.length, 0);
  assert.equal((await db.doc('users/u-noconsent').get()).exists, false);
});

test('orders: intent params, consent record, and only intentId + clientSecret returned', { skip: !RUN }, async () => {
  const c = await checkout('u-params', { phone: '+91 98765-43210' });
  assert.deepEqual(Object.keys(c.body).sort(), ['clientSecret', 'intentId']);
  assert.equal(c.body.clientSecret, `${c.intentId}_secret_x`);

  const [req] = createCalls();
  assert.equal(req.auth, 'Bearer sk_test_x');
  assert.equal(req.idempotencyKey, c.orderId);
  assert.match(c.orderId, /^ord_[0-9a-f]{20}$/);
  assert.deepEqual(req.body, {
    amount: 199700,
    currency: 'INR',
    customer: { name: 'Asha Rao', email: 'u-params@example.com', contact: '+919876543210' },
    siteReference: c.orderId,
    description: 'Lifetime game unlock',
    metadata: { uid: 'u-params', product: 'full_game_lifetime' },
    refundWindowDays: 3,
  });

  const o = await order(c.orderId);
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(o.consentTextVersion, 'v1');
  assert.equal(o.consentAt.toMillis(), clock);
  assert.equal(o.intentId, c.intentId);
  assert.equal(o.refundWindowDays, 3);
  assert.equal(JSON.stringify(o).includes('secret'), false, 'clientSecret is never stored');
  assert.equal((await user('u-params')).profile.phone, '+919876543210');
  // Name/phone never reach the logs.
  assert.equal(JSON.stringify(logs).includes('98765'), false);
});

test('orders: USD for a non-Indian number', { skip: !RUN }, async () => {
  await checkout('u-usd', { phone: '+14155550100' });
  const [req] = createCalls();
  assert.equal(req.body.amount, 1997);
  assert.equal(req.body.currency, 'USD');
});

test('orders: an awaiting order under 1 h is handed back, not duplicated', { skip: !RUN }, async () => {
  const a = await checkout('u-reuse');
  clock += 59 * 60_000;
  const b = await checkout('u-reuse');
  assert.equal(b.intentId, a.intentId);
  assert.equal(b.body.clientSecret, a.body.clientSecret);
  assert.equal(pay.intents.size, 1, 'PayLayer replayed the same intent');
  assert.equal(createCalls()[1].idempotencyKey, a.orderId);

  // Over an hour: a new order and intent.
  clock += 2 * 60_000;
  const c = await checkout('u-reuse');
  assert.notEqual(c.orderId, a.orderId);
  assert.equal(pay.intents.size, 2);
});

test('orders: changed checkout details start a new order instead of a failed replay', { skip: !RUN }, async () => {
  const a = await checkout('u-change', { phone: '+919876543210' });
  const b = await checkout('u-change', { phone: '+14155550100' });
  assert.notEqual(b.orderId, a.orderId);
  assert.equal((await order(b.orderId)).currency, 'USD');
});

test('orders: PayLayer down → 502, order marked failed', { skip: !RUN }, async () => {
  const t = token('u-down', 'password', 'd@example.com');
  pay.onCreate = () => { throw new TypeError('fetch failed'); };
  const r = await call('POST', '/api/orders', { auth: t, body: { name: 'D', phone: '+919876543210', consent: true } });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'payment_unavailable');
  const orderId = (await user('u-down')).pendingOrderId;
  assert.equal((await order(orderId)).status, 'failed');
});

// ── webhooks ────────────────────────────────────────────────────────────────

test('webhook: paid unlocks; a duplicate delivery is a no-op; buying again is refused', { skip: !RUN }, async () => {
  const c = await checkout('u-buy');
  await payFor(c);
  const e = await ent('u-buy');
  assert.equal(e.active, true);
  assert.equal(e.intentId, c.intentId);
  assert.equal(e.orderId, c.orderId);
  assert.equal(e.refundableUntil.toMillis(), clock + 3 * DAY);
  const o = await order(c.orderId);
  assert.equal(o.status, 'paid');
  assert.equal(o.paidAt.toMillis(), clock);

  let r = await call('GET', '/api/me', { auth: c.t });
  assert.equal(r.body.entitled, true);
  assert.equal(r.body.account.hasCheckoutProfile, true);

  r = await call('POST', '/api/orders', { auth: c.t, body: { name: 'Asha Rao', phone: '+919876543210', consent: true } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'already_owned');

  // At-least-once delivery: the same event id again changes nothing.
  await db.doc('entitlements/u-buy').update({ marker: 1 });
  r = await webhook(event(`evt_paid_${c.intentId}`, 'payment_intent.paid', pay.intents.get(c.intentId)));
  assert.equal(r.status, 200);
  assert.equal((await ent('u-buy')).marker, 1);
  // A different event id for the same payment does not re-grant either.
  r = await webhook(event('evt_paid_again', 'payment_intent.paid', pay.intents.get(c.intentId)));
  assert.equal((await ent('u-buy')).marker, 1);
  assert.equal((await db.doc('paylayerEvents/evt_paid_again').get()).data().outcome, 'already_granted');
});

test('webhook: amount or currency mismatch does not unlock', { skip: !RUN }, async () => {
  const c = await checkout('u-mismatch');
  const intent = pay.intents.get(c.intentId);
  for (const [id, patch] of [['evt_m1', { amount: 100 }], ['evt_m2', { currency: 'USD' }]]) {
    const r = await webhook(event(id, 'payment_intent.paid', { ...intent, status: 'paid', ...patch }));
    assert.equal(r.status, 200);
    assert.equal((await db.doc(`paylayerEvents/${id}`).get()).data().outcome, 'amount_mismatch');
  }
  assert.equal((await db.doc('entitlements/u-mismatch').get()).exists, false);
  assert.equal((await order(c.orderId)).status, 'awaiting_payment');
  assert.ok(logs.some((l) => l.alert && /does not match/.test(l.msg)));
});

test('webhook: bad signature → 400 and changes nothing', { skip: !RUN }, async () => {
  const raw = JSON.stringify(paidEvent('evt_x', 'ord_00000000000000000000', 'pi_x'));
  const r = await call('POST', '/webhooks/paylayer', {
    rawBody: Buffer.from(raw),
    headers: { 'x-paylayer-signature': signWebhookPayload('whsec_wrong', raw, Math.floor(clock / 1000)) },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'bad_signature');
  assert.equal((await db.doc('paylayerEvents/evt_x').get()).exists, false);
});

test('webhook: unknown order is acknowledged, recorded and alerted', { skip: !RUN }, async () => {
  const r = await webhook(paidEvent('evt_unknown', 'ord_ffffffffffffffffffff', 'pi_y'));
  assert.equal(r.status, 200);
  assert.equal((await db.doc('paylayerEvents/evt_unknown').get()).data().outcome, 'unknown_order');
  assert.ok(logs.some((l) => l.alert && /unknown order/.test(l.msg)));
});

test('webhook: unknown event types get a 2xx and are ignored', { skip: !RUN }, async () => {
  const c = await checkout('u-unknown-type');
  const r = await webhook(event('evt_dispute', 'payment.dispute.created', pay.intents.get(c.intentId)));
  assert.equal(r.status, 200);
  assert.equal((await db.doc('paylayerEvents/evt_dispute').get()).exists, false);
  assert.equal((await order(c.orderId)).status, 'awaiting_payment');
});

test('webhook: payment_failed only logs; a later paid still unlocks', { skip: !RUN }, async () => {
  const c = await checkout('u-retry');
  const r = await webhook(event('evt_fail', 'payment_intent.payment_failed', pay.intents.get(c.intentId)));
  assert.equal(r.status, 200);
  assert.equal((await order(c.orderId)).status, 'awaiting_payment');
  assert.ok(logs.some((l) => /payment attempt failed/.test(l.msg)));
  await payFor(c);
  assert.equal((await ent('u-retry')).active, true);
});

test('webhook: expired marks an awaiting order expired; a paid order stays paid', { skip: !RUN }, async () => {
  const a = await checkout('u-exp');
  await webhook(event('evt_exp_a', 'payment_intent.expired', pay.intents.get(a.intentId)));
  assert.equal((await order(a.orderId)).status, 'expired');

  const b = await checkout('u-exp');
  await payFor(b);
  await webhook(event('evt_exp_b', 'payment_intent.expired', pay.intents.get(b.intentId)));
  assert.equal((await order(b.orderId)).status, 'paid');
});

test('webhook: a second paid checkout keeps the first unlock and refunds the second (no refundUsed)', { skip: !RUN }, async () => {
  const a = await checkout('u-dup', { phone: '+14155550100' });
  // Different details: a second, separate order (two devices, say).
  const b = await checkout('u-dup', { phone: '+14155550101' });
  await payFor(a);
  await payFor(b);

  assert.equal((await ent('u-dup')).orderId, a.orderId);
  const ob = await order(b.orderId);
  assert.equal(ob.status, 'paid_duplicate');
  assert.equal(ob.duplicateRefund, 'requested');
  const [rc] = refundCalls();
  assert.equal(rc.path, `/v1/payment-intents/${b.intentId}/refunds`);
  assert.equal(rc.idempotencyKey, `refund-${b.intentId}`);
  assert.deepEqual(rc.body, { reason: 'Duplicate purchase' });

  // Its refund webhook settles the duplicate only.
  await webhook(refundEvent('refund.processed', b));
  assert.equal((await order(b.orderId)).status, 'refunded');
  assert.equal((await ent('u-dup')).active, true);
  assert.notEqual((await user('u-dup')).refundUsed, true);
  // …so the player can still use their own refund.
  assert.equal((await requestRefund(a.t)).status, 200);
});

test('webhook: a duplicate PayLayer will not refund → alert to use the Razorpay Dashboard', { skip: !RUN }, async () => {
  const a = await checkout('u-dup2', { phone: '+14155550100' });
  const b = await checkout('u-dup2', { phone: '+14155550101' });
  await payFor(a);
  pay.onRefund = () => payError(409, 'not_refundable');
  await payFor(b);
  assert.equal((await order(b.orderId)).duplicateRefund, 'dashboard');
  assert.ok(logs.some((l) => l.alert && /Razorpay Dashboard/.test(l.msg)));
});

// ── paid-play metering ──────────────────────────────────────────────────────

test('metering: paid play is metered server-side while refundable, then stops', { skip: !RUN }, async () => {
  const c = await checkout('u-meter');
  await payFor(c);
  let r = await call('GET', '/api/me', { auth: c.t });
  assert.equal(r.body.metered, true);
  assert.equal(r.body.refund.eligible, true);

  r = await call('POST', '/api/trial/lease', { auth: c.t, body: { action: 'start' } });
  assert.deepEqual(r.body, { entitled: true, metered: true, leaseSec: 60, remainingSec: null });
  clock += 45_000;
  r = await call('POST', '/api/trial/lease', { auth: c.t, body: { action: 'end' } });
  assert.deepEqual(r.body, { entitled: true, metered: true, leaseSec: 0, remainingSec: null });
  assert.equal((await user('u-meter')).play.totalMs, 45_000);

  // A client that goes quiet mid-lease is billed at most lease + grace.
  await call('POST', '/api/trial/lease', { auth: c.t, body: { action: 'start' } });
  clock += 10 * 60_000;
  r = await call('GET', '/api/me', { auth: c.t });
  assert.equal(r.body.refund.playedSec, 45 + 75);

  // Past the window: no more metering, play is never interrupted again.
  clock += 3 * DAY;
  r = await call('POST', '/api/trial/lease', { auth: c.t, body: { action: 'start' } });
  assert.deepEqual(r.body, { entitled: true, metered: false, leaseSec: null, remainingSec: null });
  r = await call('GET', '/api/me', { auth: c.t });
  assert.equal(r.body.metered, false);
  assert.deepEqual([r.body.refund.eligible, r.body.refund.reason], [false, 'refund_window_expired']);
});

test('metering: trial minutes count, and metering stops at two hours', { skip: !RUN }, async () => {
  const t = token('u-2h', 'password', 'u-2h@example.com');
  await playFor(t, 4 * 60_000); // trial play before buying
  const c = await checkout('u-2h');
  await payFor(c);
  assert.equal((await user('u-2h')).play.totalMs, 4 * 60_000);

  const end = await playFor(c.t, 2 * HOUR - 4 * 60_000);
  assert.equal(end.body.metered, false, 'reaching 2 h ends metering');
  const me = (await call('GET', '/api/me', { auth: c.t })).body;
  assert.equal(me.metered, false);
  assert.equal(me.refund.reason, 'played_too_long');
});

// ── refunds ─────────────────────────────────────────────────────────────────

test('refund: allowed (<2 h, in window, first refund) revokes, then refund.processed finalises', { skip: !RUN }, async () => {
  const c = await checkout('u-ref');
  await payFor(c);
  await playFor(c.t, 30 * 60_000);

  const r = await requestRefund(c.t);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'refund_requested');
  const [rc] = refundCalls();
  assert.equal(rc.path, `/v1/payment-intents/${c.intentId}/refunds`);
  assert.equal(rc.idempotencyKey, `refund-${c.intentId}`);
  assert.equal(rc.body.amount, undefined, 'full refunds only: no amount is sent');
  assert.equal(typeof rc.body.reason, 'string');
  // The window came from PayLayer, not from our clock.
  assert.ok(pay.calls.some((x) => x.method === 'GET' && x.path === `/v1/payment-intents/${c.intentId}`));

  assert.equal((await order(c.orderId)).status, 'refund_requested');
  assert.equal((await ent('u-ref')).active, false);
  let me = (await call('GET', '/api/me', { auth: c.t })).body;
  assert.equal(me.entitled, false);
  assert.deepEqual([me.refund.eligible, me.refund.reason], [false, 'refund_in_progress']);

  await webhook(refundEvent('refund.processed', c));
  assert.equal((await order(c.orderId)).status, 'refunded');
  assert.equal((await ent('u-ref')).active, false);
  assert.equal((await user('u-ref')).refundUsed, true);
  me = (await call('GET', '/api/me', { auth: c.t })).body;
  assert.equal(me.refund.reason, 'already_refunded');

  // A delayed paid event for the refunded purchase does not unlock it again.
  await webhook(event('evt_late_paid', 'payment_intent.paid', pay.intents.get(c.intentId)));
  assert.equal((await ent('u-ref')).active, false);
});

test('refund: refund.created finalises the same way', { skip: !RUN }, async () => {
  const c = await checkout('u-ref-created');
  await payFor(c);
  pay.onRefund = () => json(202, { id: 'rf_1', status: 'pending' });
  assert.equal((await requestRefund(c.t)).status, 200);
  await webhook(refundEvent('refund.created', c));
  assert.equal((await order(c.orderId)).status, 'refunded');
  assert.equal((await user('u-ref-created')).refundUsed, true);
});

test('refund: blocked at 2 hours of play', { skip: !RUN }, async () => {
  const c = await checkout('u-long');
  await payFor(c);
  await db.doc('users/u-long').set({ play: { totalMs: 2 * HOUR, lastTickMs: null, leaseMs: 0 } }, { merge: true });
  const r = await requestRefund(c.t);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'played_too_long');
  assert.match(r.body.error.message, /2 hours/);
  assert.equal(refundCalls().length, 0);
  assert.equal((await ent('u-long')).active, true);

  // Just under is fine.
  await db.doc('users/u-long').set({ play: { totalMs: 2 * HOUR - 1000 } }, { merge: true });
  assert.equal((await requestRefund(c.t)).status, 200);
});

test('refund: blocked after PayLayer\'s window, whatever our cache says', { skip: !RUN }, async () => {
  const c = await checkout('u-late');
  await payFor(c);
  // Our cached copy claims plenty of time; the endpoint must not trust it.
  await db.doc('entitlements/u-late').update({ refundableUntil: new Date(clock + 30 * DAY) });
  clock += 3 * DAY;
  const r = await requestRefund(c.t);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'refund_window_expired');
  assert.equal(refundCalls().length, 0);
  assert.equal((await ent('u-late')).active, true);
});

test('refund: a second refund is blocked, and the next purchase is non-refundable', { skip: !RUN }, async () => {
  const first = await checkout('u-twice');
  await payFor(first);
  assert.equal((await requestRefund(first.t)).status, 200);
  await webhook(refundEvent('refund.processed', first));

  // Buying again after the one refund: refundWindowDays 0.
  const second = await checkout('u-twice');
  assert.equal(createCalls().at(-1).body.refundWindowDays, 0);
  assert.equal((await order(second.orderId)).refundWindowDays, 0);
  await payFor(second);
  assert.equal((await ent('u-twice')).active, true);

  const r = await requestRefund(second.t);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'refund_used');
  assert.equal(refundCalls().length, 1);
  const me = (await call('GET', '/api/me', { auth: second.t })).body;
  assert.deepEqual([me.refund.eligible, me.refund.reason], [false, 'refund_used']);
  assert.equal(me.metered, false, 'nothing to meter for a purchase that cannot be refunded');
});

test('refund: checks run in order a → d', { skip: !RUN }, async () => {
  // No purchase at all.
  let r = await requestRefund(token('u-none', 'password', 'none@example.com'));
  assert.deepEqual([r.status, r.body.error.code], [404, 'no_purchase']);

  const c = await checkout('u-order');
  await payFor(c);
  // b before c and d: refundUsed wins even when also late and over 2 h.
  await db.doc('users/u-order').set({ refundUsed: true, play: { totalMs: 3 * HOUR } }, { merge: true });
  clock += 4 * DAY;
  r = await requestRefund(c.t);
  assert.equal(r.body.error.code, 'refund_used');
  // c before d.
  await db.doc('users/u-order').set({ refundUsed: false }, { merge: true });
  r = await requestRefund(c.t);
  assert.equal(r.body.error.code, 'refund_window_expired');
  // a first of all.
  await db.doc(`orders/${c.orderId}`).update({ status: 'refunded' });
  r = await requestRefund(c.t);
  assert.equal(r.body.error.code, 'already_refunded');
});

test('refund: 422 refund_rejected restores the unlock', { skip: !RUN }, async () => {
  const c = await checkout('u-rejected');
  await payFor(c);
  pay.onRefund = () => payError(422, 'refund_rejected');
  const r = await requestRefund(c.t);
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'refund_rejected');
  assert.equal((await order(c.orderId)).status, 'paid');
  assert.equal((await ent('u-rejected')).active, true);
  assert.notEqual((await user('u-rejected')).refundUsed, true);
});

test('refund: PayLayer 409 refusals restore the unlock and say why; already_refunded keeps it requested', { skip: !RUN }, async () => {
  for (const code of ['refund_window_expired', 'not_refundable', 'intent_not_refundable']) {
    const uid = `u-409-${code}`;
    const c = await checkout(uid);
    await payFor(c);
    pay.onRefund = () => payError(409, code);
    const r = await requestRefund(c.t);
    assert.deepEqual([r.status, r.body.error.code], [409, code]);
    assert.ok(r.body.error.message.length > 0);
    assert.equal((await order(c.orderId)).status, 'paid');
    assert.equal((await ent(uid)).active, true);
  }
  const c = await checkout('u-409-already');
  await payFor(c);
  pay.onRefund = () => payError(409, 'already_refunded');
  assert.equal((await requestRefund(c.t)).status, 200);
  assert.equal((await order(c.orderId)).status, 'refund_requested');
  assert.equal((await ent('u-409-already')).active, false);
});

test('refund: a network error leaves refund_requested; the retry reuses the same key', { skip: !RUN }, async () => {
  const c = await checkout('u-net');
  await payFor(c);
  pay.onRefund = () => { throw new TypeError('fetch failed'); };
  let r = await requestRefund(c.t);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'refund_requested', pending: true });
  assert.equal((await order(c.orderId)).status, 'refund_requested');
  assert.equal((await ent('u-net')).active, false);

  pay.onRefund = null;
  r = await requestRefund(c.t);
  assert.deepEqual(r.body, { status: 'refund_requested' });
  const keys = refundCalls().map((x) => x.idempotencyKey);
  assert.deepEqual(keys, [`refund-${c.intentId}`, `refund-${c.intentId}`]);
  assert.deepEqual(refundCalls()[0].body, refundCalls()[1].body, 'same body under the same key');
});

test('refund: refund.failed restores the unlock', { skip: !RUN }, async () => {
  const c = await checkout('u-rfail');
  await payFor(c);
  pay.onRefund = () => json(202, { id: 'rf_1', status: 'submitting' });
  assert.equal((await requestRefund(c.t)).status, 200);
  assert.equal((await ent('u-rfail')).active, false);

  await webhook(refundEvent('refund.failed', c));
  assert.equal((await order(c.orderId)).status, 'paid');
  assert.equal((await ent('u-rfail')).active, true);
  assert.notEqual((await user('u-rfail')).refundUsed, true);
  assert.ok(logs.some((l) => l.alert && /refund failed/.test(l.msg)));
});

test('refund: only the account\'s own purchase', { skip: !RUN }, async () => {
  const c = await checkout('u-owner');
  await payFor(c);
  const r = await requestRefund(token('u-other', 'password', 'other@example.com'));
  assert.equal(r.status, 404);
  assert.equal((await ent('u-owner')).active, true);
  assert.equal((await call('POST', '/api/refund', { body: {} })).status, 401);
});
