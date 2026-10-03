// End-to-end flows through the real handlers against the Firestore emulator:
// trial lease, IP cap, checkout, webhook grant / dedupe / refund. Token
// verification and PayLayer are stubbed; Firestore is real.
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

let db;
let clock;
let intents; // PayLayer calls the stub received
let logs;
let ipLimit;

// Token = "uid|provider|email" — stands in for verifyIdToken.
const token = (uid, provider = 'anonymous', email = null) => [uid, provider, email || ''].join('|');

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
    fetchImpl: async (url, init) => {
      const params = JSON.parse(init.body);
      intents.push({ url, params, idempotencyKey: init.headers['idempotency-key'] });
      const id = `pi_${String(intents.length).padStart(26, '0')}`;
      return new Response(JSON.stringify({ id, clientSecret: `cs_${id}`, ...params }), { status: 201 });
    },
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

async function webhook(event) {
  const raw = JSON.stringify(event);
  return call('POST', '/webhooks/paylayer', {
    rawBody: Buffer.from(raw),
    headers: { 'x-paylayer-signature': signWebhookPayload(WEBHOOK_SECRET, raw, Math.floor(clock / 1000)) },
  });
}

const paidEvent = (id, orderId, intentId) => ({
  id, type: 'payment_intent.paid', created: 0, livemode: false,
  data: { intent: { id: intentId, siteReference: orderId, amount: 49900, currency: 'INR', status: 'paid' } },
});

before(() => {
  if (!RUN) return;
  db = getFirestore(initializeApp({ projectId: PROJECT }), 'tabletennis');
});

beforeEach(async () => {
  if (!RUN) return;
  clock = Date.now();
  intents = [];
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

test('orders: anonymous accounts cannot buy', { skip: !RUN }, async () => {
  const r = await call('POST', '/api/orders', { auth: token('u-anon'), body: { name: 'A', phone: '+919876543210' } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'account_required');
  assert.equal(intents.length, 0);
});

test('orders: an upgraded anonymous account (provider still "anonymous", email set) can buy', { skip: !RUN }, async () => {
  const t = token('u-linked', 'anonymous', 'linked@example.com');
  const r = await call('POST', '/api/orders', { auth: t, body: { name: 'L', phone: '+919876543210' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', { auth: t })).body.account.anonymous, false);
});

test('orders: validates name and phone', { skip: !RUN }, async () => {
  const t = token('u-buy', 'password', 'a@example.com');
  assert.equal((await call('POST', '/api/orders', { auth: t, body: { name: '', phone: '+919876543210' } })).body.error.code, 'invalid_name');
  assert.equal((await call('POST', '/api/orders', { auth: t, body: { name: 'A', phone: '98765' } })).body.error.code, 'invalid_phone');
  assert.equal(intents.length, 0);
});

test('full purchase: order → paid webhook → entitlement → duplicate delivery → refund', { skip: !RUN }, async () => {
  const t = token('u-buy', 'password', 'buyer@example.com');
  let r = await call('POST', '/api/orders', { auth: t, body: { name: 'Asha Rao', phone: '+91 98765-43210' } });
  assert.equal(r.status, 200);
  const { orderId, intentId, clientSecret, amount, currency } = r.body;
  assert.match(orderId, /^ord_[0-9a-f]{20}$/);
  assert.equal(clientSecret, `cs_${intentId}`);
  assert.equal(amount, 49900);
  assert.equal(currency, 'INR');

  // What PayLayer was asked for: server-side price, real customer, idempotent.
  assert.equal(intents.length, 1);
  assert.equal(intents[0].url, 'https://pay.test/v1/payment-intents');
  assert.equal(intents[0].idempotencyKey, orderId);
  assert.deepEqual(intents[0].params.customer, { name: 'Asha Rao', email: 'buyer@example.com', contact: '+919876543210' });
  assert.equal(intents[0].params.siteReference, orderId);

  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'created');
  assert.equal((await db.doc('users/u-buy').get()).data().profile.phone, '+919876543210');

  r = await webhook(paidEvent('evt_paid_1', orderId, intentId));
  assert.equal(r.status, 200);
  const ent = (await db.doc('entitlements/u-buy').get()).data();
  assert.equal(ent.active, true);
  assert.equal(ent.intentId, intentId);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'paid');

  r = await call('GET', '/api/me', { auth: t });
  assert.equal(r.body.entitled, true);
  assert.equal(r.body.account.hasCheckoutProfile, true);

  // Entitled players skip the trial clock entirely.
  r = await call('POST', '/api/trial/lease', { auth: t, body: { action: 'start' } });
  assert.deepEqual(r.body, { entitled: true, leaseSec: null, remainingSec: null });

  // Second order is refused once owned.
  r = await call('POST', '/api/orders', { auth: t, body: { name: 'Asha Rao', phone: '+919876543210' } });
  assert.equal(r.status, 409);

  // At-least-once delivery: the same event again changes nothing.
  await db.doc('entitlements/u-buy').update({ marker: 1 });
  r = await webhook(paidEvent('evt_paid_1', orderId, intentId));
  assert.equal(r.status, 200);
  assert.equal((await db.doc('entitlements/u-buy').get()).data().marker, 1);

  // Refund revokes.
  r = await webhook({
    id: 'evt_refund_1', type: 'refund.processed', created: 0, livemode: false,
    data: { intent: { id: intentId, siteReference: orderId }, refund: { id: 'rf_1', status: 'processed' } },
  });
  assert.equal(r.status, 200);
  assert.equal((await db.doc('entitlements/u-buy').get()).data().active, false);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'refunded');
  assert.equal((await call('GET', '/api/me', { auth: t })).body.entitled, false);
});

test('webhook: bad signature is rejected and changes nothing', { skip: !RUN }, async () => {
  const raw = JSON.stringify(paidEvent('evt_x', 'ord_00000000000000000000', 'pi_x'));
  const r = await call('POST', '/webhooks/paylayer', {
    rawBody: Buffer.from(raw),
    headers: { 'x-paylayer-signature': signWebhookPayload('whsec_wrong', raw, Math.floor(clock / 1000)) },
  });
  assert.equal(r.status, 400);
  assert.equal((await db.doc('paylayerEvents/evt_x').get()).exists, false);
});

test('webhook: unknown order is acknowledged, recorded and alerted', { skip: !RUN }, async () => {
  const r = await webhook(paidEvent('evt_unknown', 'ord_ffffffffffffffffffff', 'pi_y'));
  assert.equal(r.status, 200);
  assert.equal((await db.doc('paylayerEvents/evt_unknown').get()).data().outcome, 'unknown_order');
  assert.ok(logs.some((l) => l.alert && /unknown order/.test(l.msg)));
});

test('webhook: a second paid checkout keeps the first and alerts for a refund', { skip: !RUN }, async () => {
  const t = token('u-dup', 'password', 'dup@example.com');
  const a = (await call('POST', '/api/orders', { auth: t, body: { name: 'D', phone: '+14155550100' } })).body;
  const b = (await call('POST', '/api/orders', { auth: t, body: { name: 'D', phone: '+14155550100' } })).body;
  assert.equal(a.currency, 'USD');
  assert.equal(a.amount, 999);

  await webhook(paidEvent('evt_a', a.orderId, a.intentId));
  await webhook(paidEvent('evt_b', b.orderId, b.intentId));

  assert.equal((await db.doc('entitlements/u-dup').get()).data().intentId, a.intentId);
  assert.equal((await db.doc(`orders/${b.orderId}`).get()).data().status, 'paid_duplicate');
  assert.ok(logs.some((l) => l.alert && /duplicate purchase/.test(l.msg)));
});
