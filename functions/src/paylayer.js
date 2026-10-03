// The two things this backend needs from PayLayer (D:\Bhuvnesh_Data\Payment):
// create a payment intent, and verify the webhooks it sends back.
//
// Ported from PayLayer's packages/node (client.ts, signature.ts) rather than
// depended on: that package is not published to npm, and a `file:` dependency
// pointing outside this folder is not part of what `firebase deploy` uploads,
// so Cloud Build could never install it. Keep the two in step — the signature
// scheme below is the contract.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-paylayer-signature';
const DEFAULT_TOLERANCE_SEC = 300;

export class WebhookSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export class PayLayerApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PayLayerApiError';
    this.status = status;
    this.code = code;
  }
}

function computeSignature(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** `t=<unix>,v1=<hex>` — used by the tests to build valid deliveries. */
export function signWebhookPayload(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

/**
 * Verifies `X-PayLayer-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`
 * over the RAW body and returns the parsed event. Throws WebhookSignatureError.
 *
 * @param {{ rawBody: string|Buffer, signatureHeader: string|undefined, secret: string,
 *           toleranceSec?: number, now?: number }} opts
 */
export function verifyWebhook({ rawBody, signatureHeader, secret, toleranceSec = DEFAULT_TOLERANCE_SEC, now }) {
  if (!signatureHeader) throw new WebhookSignatureError('Missing signature header');
  let timestamp = NaN;
  const signatures = [];
  for (const part of String(signatureHeader).split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new WebhookSignatureError('Malformed signature header');
  }
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSec) {
    throw new WebhookSignatureError('Signature timestamp outside tolerance');
  }
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody || '').toString('utf8');
  const expected = Buffer.from(computeSignature(secret, timestamp, body), 'hex');
  const ok = signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new WebhookSignatureError('Signature mismatch');
  return JSON.parse(body);
}

/**
 * POST /v1/payment-intents. Returns the intent including the one-time
 * `clientSecret` the browser SDK needs.
 *
 * @param {{ baseUrl: string, apiKey: string, fetchImpl?: typeof fetch }} cfg
 * @param {object} params CreatePaymentIntentParams (see PayLayer README)
 * @param {string} idempotencyKey
 */
export async function createPaymentIntent({ baseUrl, apiKey, fetchImpl = fetch }, params, idempotencyKey) {
  const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/v1/payment-intents`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) {
    const err = (json && json.error) || {};
    throw new PayLayerApiError(res.status, err.code || 'http_error', err.message || `HTTP ${res.status}`);
  }
  return json;
}
