// Stand-in for PayLayer (D:\Bhuvnesh_Data\Payment) + Razorpay in the e2e
// suite. Implements exactly the surface the game touches:
//
//   POST /v1/payment-intents      backend → create intent (Bearer sk_ key);
//                                 the same Idempotency-Key + body replays the
//                                 first response, as PayLayer does
//   GET  /v1/payment-intents/:id  backend → retrieve (refundableUntil)
//   POST /v1/payment-intents/:id/refunds
//                                 backend → refund less the processing fee; answers 201, then
//                                 sends the signed refund.processed webhook
//   GET  /sdk/v1/pay.js           browser SDK: window.Pay.checkout(...)
//   POST /v1/checkout/:id/pay     what the fake SDK calls instead of opening
//                                 Razorpay; marks the intent paid and sends the
//                                 SIGNED payment_intent.paid webhook — the same
//                                 t=…,v1=HMAC scheme as PayLayer's outbound
//                                 webhooks — to the backend
//   GET  /__intents               test hook: what the backend asked for
//
// Real Razorpay test-mode checkout is the manual step after this suite.

import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';

export const FAKE_API_KEY = 'sk_test_e2e';
export const FAKE_WEBHOOK_SECRET = 'whsec_e2e';

function sign(secret, body) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex')}`;
}

const SDK = `
(function () {
  var base = ${'${BASE}'};
  function PayError(code, message) { var e = new Error(message); e.code = code; return e; }
  window.Pay = {
    checkout: function (opts) {
      if (window.__E2E_PAY_DISMISS) return Promise.reject(PayError('dismissed', 'Checkout was closed'));
      return fetch(base + '/v1/checkout/' + encodeURIComponent(opts.intentId) + '/pay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientSecret: opts.clientSecret }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) throw PayError(j.error.code, j.error.message);
        return { intentId: opts.intentId, status: 'paid', settled: true, paymentId: 'pay_fake' };
      });
    },
  };
})();
`;

/**
 * @param {{ port: number, webhookUrl: string, log?: (msg: string) => void }} opts
 * @returns {Promise<{ close: () => Promise<void>, intents: Map<string, object>, refunds: object[] }>}
 */
export function startFakePayLayer({ port, webhookUrl, log = () => {} }) {
  const intents = new Map();
  const byKey = new Map();
  const refunds = [];
  let seq = 0;
  const DAY_MS = 24 * 3600 * 1000;
  const authorized = (req) => req.headers.authorization === `Bearer ${FAKE_API_KEY}`;

  async function sendWebhook(type, intent, extra = {}) {
    const event = {
      id: `evt_${randomBytes(8).toString('hex')}`,
      type, created: Math.floor(Date.now() / 1000), livemode: false,
      data: { intent: { ...intent, clientSecret: undefined }, ...extra },
    };
    const body = JSON.stringify(event);
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paylayer-signature': sign(FAKE_WEBHOOK_SECRET, body) },
      body,
    });
    log(`webhook ${type} → ${res.status}`);
    if (!res.ok) throw new Error(`webhook ${type} rejected: ${res.status} ${await res.text()}`);
  }

  const server = createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors, ...headers });
      res.end(JSON.stringify(json));
    };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (req.method === 'GET' && url.pathname === '/sdk/v1/pay.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', ...cors });
        res.end(SDK.replace('${BASE}', JSON.stringify(`http://127.0.0.1:${port}`)));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/payment-intents') {
        if (!authorized(req)) return send(401, { error: { code: 'unauthorized' } });
        const key = req.headers['idempotency-key'];
        const prior = byKey.get(key);
        if (prior) {
          if (prior.body !== JSON.stringify(body)) return send(422, { error: { code: 'idempotency_key_reused' } });
          log(`intent ${prior.intent.id} replayed for ${key}`);
          return send(201, prior.intent);
        }
        if (!/^\+[1-9]\d{6,14}$/.test(body.customer && body.customer.contact)) {
          return send(400, { error: { code: 'validation_error', message: 'contact must be E.164' } });
        }
        seq += 1;
        const id = `pi_${String(seq).padStart(26, '0')}`;
        const intent = {
          id, object: 'payment_intent', livemode: false, status: 'created',
          amount: body.amount, currency: body.currency, siteReference: body.siteReference,
          customer: body.customer, metadata: body.metadata || {}, description: body.description,
          refundWindowDays: body.refundWindowDays, paidAt: null, refundableUntil: null,
          idempotencyKey: key,
          clientSecret: `${id}_secret_${randomBytes(6).toString('hex')}`,
        };
        intents.set(id, intent);
        byKey.set(key, { body: JSON.stringify(body), intent });
        log(`intent ${id} ${intent.amount} ${intent.currency} for ${intent.siteReference}`);
        return send(201, intent);
      }

      const pay = url.pathname.match(/^\/v1\/checkout\/([^/]+)\/pay$/);
      if (req.method === 'POST' && pay) {
        const intent = intents.get(pay[1]);
        if (!intent || intent.clientSecret !== body.clientSecret) return send(404, { error: { code: 'intent_not_found' } });
        intent.status = 'paid';
        intent.paidAt = new Date().toISOString();
        intent.refundableUntil = new Date(Date.now() + intent.refundWindowDays * DAY_MS).toISOString();
        await sendWebhook('payment_intent.paid', intent);
        return send(200, { status: 'paid', settled: true });
      }

      const one = url.pathname.match(/^\/v1\/payment-intents\/([^/]+)$/);
      if (req.method === 'GET' && one) {
        if (!authorized(req)) return send(401, { error: { code: 'unauthorized' } });
        const intent = intents.get(one[1]);
        if (!intent) return send(404, { error: { code: 'not_found' } });
        return send(200, { ...intent, clientSecret: undefined, payments: [], refunds: [] });
      }

      const refund = url.pathname.match(/^\/v1\/payment-intents\/([^/]+)\/refunds$/);
      if (req.method === 'POST' && refund) {
        if (!authorized(req)) return send(401, { error: { code: 'unauthorized' } });
        const intent = intents.get(refund[1]);
        if (!intent) return send(404, { error: { code: 'not_found' } });
        if (intent.status === 'refunded') return send(409, { error: { code: 'already_refunded' } });
        if (body.amount !== undefined) return send(400, { error: { code: 'partial_refund_not_supported' } });
        intent.status = 'refunded';
        refunds.push({ intentId: intent.id, body, idempotencyKey: req.headers['idempotency-key'] });
        // The gateway keeps its processing fee; amount + processingFee = paid.
        const processingFee = Math.floor(intent.amount * 0.0236);
        const money = { amount: intent.amount - processingFee, processingFee, currency: intent.currency };
        send(201, { id: 'rf_fake', object: 'refund', intentId: intent.id, status: 'processed', ...money });
        // After the answer, as Razorpay's own notification would arrive.
        setTimeout(() => {
          sendWebhook('refund.processed', intent, { refund: { id: 'rf_fake', status: 'processed', ...money } })
            .catch((err) => log(`refund webhook failed: ${err.message}`));
        }, 50);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/__intents') {
        return send(200, [...intents.values()]);
      }

      send(404, { error: { code: 'not_found' } });
    } catch (err) {
      log(`error: ${err.message}`);
      send(500, { error: { code: 'internal', message: err.message } });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      intents,
      refunds,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}
