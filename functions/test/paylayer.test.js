import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhook, signWebhookPayload, WebhookSignatureError } from '../src/paylayer.js';
import { priceFor, E164 } from '../src/pricing.js';

const SECRET = 'whsec_test';
const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.paid' });
const now = 1_700_000_000;

test('accepts a valid signature and returns the event', () => {
  const sig = signWebhookPayload(SECRET, body, now);
  assert.deepEqual(verifyWebhook({ rawBody: body, signatureHeader: sig, secret: SECRET, now }),
    { id: 'evt_1', type: 'payment_intent.paid' });
});

test('accepts a Buffer raw body', () => {
  const sig = signWebhookPayload(SECRET, body, now);
  assert.equal(verifyWebhook({ rawBody: Buffer.from(body), signatureHeader: sig, secret: SECRET, now }).id, 'evt_1');
});

test('rejects a wrong secret, a tampered body, a stale timestamp and a missing header', () => {
  const sig = signWebhookPayload(SECRET, body, now);
  const bad = [
    { rawBody: body, signatureHeader: sig, secret: 'whsec_other', now },
    { rawBody: body.replace('paid', 'expired'), signatureHeader: sig, secret: SECRET, now },
    { rawBody: body, signatureHeader: sig, secret: SECRET, now: now + 301 },
    { rawBody: body, signatureHeader: undefined, secret: SECRET, now },
    { rawBody: body, signatureHeader: 'garbage', secret: SECRET, now },
  ];
  for (const opts of bad) assert.throws(() => verifyWebhook(opts), WebhookSignatureError);
});

test('pricing: Indian numbers pay INR, everyone else USD', () => {
  assert.deepEqual(priceFor('+919876543210'), { amount: 49900, currency: 'INR' });
  assert.deepEqual(priceFor('+14155550100'), { amount: 999, currency: 'USD' });
  assert.deepEqual(priceFor('+447700900123'), { amount: 999, currency: 'USD' });
});

test('E164 matches what PayLayer validates', () => {
  assert.ok(E164.test('+919876543210'));
  assert.ok(!E164.test('9876543210'));
  assert.ok(!E164.test('+0123456789'));
  assert.ok(!E164.test('+91 98765'));
});
