// The /api/** and /webhooks/** routes. Everything external (Firestore, token
// verification, PayLayer, the clock) arrives through `deps`, so the emulator
// tests drive exactly this code. index.js does the wiring.
//
// ── DATA (named database 'tabletennis') ─────────────────────────────────────
//
//   users/{uid}           trial clock + checkout profile. Client may READ its
//                         own; only this backend writes.
//   entitlements/{uid}    { active, product, intentId, orderId, ... } — the one
//                         thing the game checks. Client may READ its own.
//   orders/{orderId}      one per checkout attempt; maps PayLayer's
//                         siteReference back to a uid. Server-only.
//   paylayerEvents/{id}   webhook dedupe (PayLayer delivers at least once).
//                         Server-only; `expireAt` is for a TTL policy.
//   trialIps/{hash_day}   new-trial counter per hashed IP per UTC day.
//                         Server-only; `expireAt` is for a TTL policy.
//
// firestore.rules spells out the same split.

import { createHmac, randomBytes } from 'node:crypto';
import { applyLease, remainingMs, LEASE_ACTIONS } from './trial.js';
import { priceFor, E164, PRODUCT_ID, PRODUCT_DESCRIPTION } from './pricing.js';
import {
  verifyWebhook, createPaymentIntent, WebhookSignatureError, PayLayerApiError, SIGNATURE_HEADER,
} from './paylayer.js';

const DAY_MS = 24 * 3600 * 1000;

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @typedef {object} Deps
 * @property {FirebaseFirestore.Firestore} db
 * @property {(idToken: string) => Promise<object>} verifyIdToken  firebase-admin auth().verifyIdToken
 * @property {(token: string) => Promise<object>} verifyAppCheck    firebase-admin appCheck().verifyToken
 * @property {() => number} now
 * @property {(event: object) => void} log    structured log; `alert: true` marks pageable lines
 * @property {() => {
 *   appCheckEnforce: boolean, trialIpDailyLimit: number, trialIpSalt: string,
 *   paylayerUrl: string, paylayerApiKey: string, paylayerWebhookSecret: string,
 * }} config  read per request: secrets are only readable at runtime
 * @property {typeof fetch} [fetchImpl]
 */

// ── request plumbing ────────────────────────────────────────────────────────

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Firebase Hosting puts the visitor's address first in X-Forwarded-For.
function clientIp(req) {
  const fwd = header(req, 'x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || '';
}

async function requireUser(req, deps) {
  const auth = header(req, 'authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'unauthenticated');
  let decoded;
  try {
    decoded = await deps.verifyIdToken(token);
  } catch {
    throw new HttpError(401, 'unauthenticated');
  }

  // App Check: always verified when present; required only once enforcement
  // is switched on (APP_CHECK_ENFORCE) — same rollout order as Firestore's
  // console switch, so an older client build is not locked out early.
  const appCheckToken = header(req, 'x-firebase-appcheck');
  const { appCheckEnforce } = deps.config();
  if (appCheckToken) {
    try {
      await deps.verifyAppCheck(appCheckToken);
    } catch {
      if (appCheckEnforce) throw new HttpError(401, 'app_check_failed');
      deps.log({ msg: 'app check token invalid (not enforced)', uid: decoded.uid });
    }
  } else if (appCheckEnforce) {
    throw new HttpError(401, 'app_check_required');
  }

  return {
    uid: decoded.uid,
    provider: decoded.firebase && decoded.firebase.sign_in_provider,
    email: decoded.email || null,
    emailVerified: decoded.email_verified === true,
  };
}

function ipBucketId(ip, salt, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  const hash = createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);
  return `${hash}_${day}`;
}

async function readAccess(db, uid) {
  const [userSnap, entSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`entitlements/${uid}`).get(),
  ]);
  return {
    user: userSnap.exists ? userSnap.data() : null,
    entitled: entSnap.exists && entSnap.data().active === true,
  };
}

// ── GET /api/me ─────────────────────────────────────────────────────────────

async function getMe(req, deps) {
  const who = await requireUser(req, deps);
  const { user, entitled } = await readAccess(deps.db, who.uid);
  return {
    entitled,
    trial: { remainingSec: Math.floor(remainingMs((user && user.trial) || {}) / 1000) },
    account: {
      // Same reasoning as postOrder: an upgraded account still reports
      // sign_in_provider 'anonymous'.
      anonymous: !who.email,
      email: who.email,
      emailVerified: who.emailVerified,
      hasCheckoutProfile: !!(user && user.profile && user.profile.phone),
    },
  };
}

// ── POST /api/trial/lease  { action: 'start' | 'renew' | 'end' } ────────────

async function postLease(req, deps) {
  const who = await requireUser(req, deps);
  const action = req.body && req.body.action;
  if (!LEASE_ACTIONS.includes(action)) throw new HttpError(400, 'invalid_action');

  const { db } = deps;
  const nowMs = deps.now();
  const userRef = db.doc(`users/${who.uid}`);
  const entRef = db.doc(`entitlements/${who.uid}`);
  const { trialIpDailyLimit, trialIpSalt } = deps.config();

  return db.runTransaction(async (tx) => {
    const [userSnap, entSnap] = await Promise.all([tx.get(userRef), tx.get(entRef)]);
    if (entSnap.exists && entSnap.data().active === true) {
      return { entitled: true, leaseSec: null, remainingSec: null };
    }

    const isNewTrial = !userSnap.exists;
    if (isNewTrial && action !== 'start') {
      // Nothing to renew or end — do not let a stray call create a trial.
      return { entitled: false, leaseSec: 0, remainingSec: Math.floor(remainingMs({}) / 1000) };
    }

    // Soft cap on new trials per IP per day. Loose on purpose: mobile carriers
    // put many real players behind one address (CGNAT), so this only slows
    // down someone wiping site data over and over. 0 disables it.
    let ipRef = null;
    let ipCount = 0;
    if (isNewTrial && trialIpDailyLimit > 0) {
      ipRef = db.doc(`trialIps/${ipBucketId(clientIp(req), trialIpSalt, nowMs)}`);
      const ipSnap = await tx.get(ipRef);
      ipCount = ipSnap.exists ? ipSnap.data().count || 0 : 0;
      if (ipCount >= trialIpDailyLimit) {
        throw new HttpError(429, 'trial_ip_limit', 'Too many new trials from this network today');
      }
    }

    const prev = userSnap.exists ? userSnap.data().trial || {} : {};
    const next = applyLease(prev, action, nowMs);

    const userPatch = {
      trial: { usedMs: next.usedMs, lastTickMs: next.lastTickMs, leaseMs: next.leaseMs },
      updatedAt: new Date(nowMs),
    };
    if (isNewTrial) userPatch.createdAt = new Date(nowMs);
    tx.set(userRef, userPatch, { merge: true });

    if (ipRef) {
      tx.set(ipRef, { count: ipCount + 1, expireAt: new Date(nowMs + 2 * DAY_MS) });
    }

    return {
      entitled: false,
      leaseSec: Math.floor(next.leaseMs / 1000),
      remainingSec: Math.floor(next.remainingMs / 1000),
    };
  });
}

// ── POST /api/orders  { name, phone } ───────────────────────────────────────

async function postOrder(req, deps) {
  const who = await requireUser(req, deps);
  // The email claim, not sign_in_provider: an anonymous trial account that
  // was upgraded with linkWithCredential keeps sign_in_provider 'anonymous'
  // (it names how THIS session signed in) but gains the email.
  if (!who.email) {
    throw new HttpError(403, 'account_required', 'Sign in with email and password to buy');
  }

  const name = String((req.body && req.body.name) || '').trim();
  const phone = String((req.body && req.body.phone) || '').replace(/[\s-]/g, '');
  if (name.length < 1 || name.length > 100) throw new HttpError(400, 'invalid_name');
  if (!E164.test(phone)) throw new HttpError(400, 'invalid_phone', 'Phone must look like +919876543210');

  const { db } = deps;
  const { entitled } = await readAccess(db, who.uid);
  if (entitled) throw new HttpError(409, 'already_owned');

  const { amount, currency } = priceFor(phone);
  const orderId = `ord_${randomBytes(10).toString('hex')}`;
  const orderRef = db.doc(`orders/${orderId}`);
  const nowMs = deps.now();

  // Written BEFORE PayLayer is called, so a webhook can never arrive for an
  // order this backend has no record of.
  await orderRef.set({
    uid: who.uid,
    product: PRODUCT_ID,
    amount,
    currency,
    status: 'creating',
    createdAt: new Date(nowMs),
  });
  await db.doc(`users/${who.uid}`).set(
    { profile: { name, phone }, updatedAt: new Date(nowMs) },
    { merge: true },
  );

  const cfg = deps.config();
  let intent;
  try {
    intent = await createPaymentIntent(
      { baseUrl: cfg.paylayerUrl, apiKey: cfg.paylayerApiKey, fetchImpl: deps.fetchImpl },
      {
        amount,
        currency,
        siteReference: orderId,
        customer: { name, email: who.email, contact: phone },
        description: PRODUCT_DESCRIPTION,
        metadata: { uid: who.uid, product: PRODUCT_ID },
      },
      orderId,
    );
  } catch (err) {
    await orderRef.update({ status: 'failed', error: (err && err.code) || 'unknown' });
    if (err instanceof PayLayerApiError) {
      deps.log({ msg: 'paylayer create intent failed', orderId, status: err.status, code: err.code });
      throw new HttpError(502, 'payment_unavailable', err.message);
    }
    throw err;
  }

  await orderRef.update({ status: 'created', intentId: intent.id });
  return { orderId, intentId: intent.id, clientSecret: intent.clientSecret, amount, currency };
}

// ── POST /webhooks/paylayer ─────────────────────────────────────────────────

async function postPayLayerWebhook(req, deps) {
  const cfg = deps.config();
  let event;
  try {
    event = verifyWebhook({
      rawBody: req.rawBody,
      signatureHeader: header(req, SIGNATURE_HEADER),
      secret: cfg.paylayerWebhookSecret,
    });
  } catch (err) {
    if (err instanceof WebhookSignatureError) throw new HttpError(400, 'bad_signature');
    throw new HttpError(400, 'bad_payload');
  }

  const intent = event && event.data && event.data.intent;
  if (!event.id || !/^[\w-]{1,128}$/.test(event.id) || !intent || !intent.siteReference
      || !/^ord_[0-9a-f]{20}$/.test(intent.siteReference)) {
    deps.log({ msg: 'paylayer webhook with unexpected shape', eventId: event.id, alert: true });
    return { received: true };
  }

  const { db } = deps;
  const nowMs = deps.now();
  const eventRef = db.doc(`paylayerEvents/${event.id}`);
  const orderRef = db.doc(`orders/${intent.siteReference}`);

  await db.runTransaction(async (tx) => {
    const [eventSnap, orderSnap] = await Promise.all([tx.get(eventRef), tx.get(orderRef)]);
    if (eventSnap.exists) return; // redelivery

    const record = {
      type: event.type,
      intentId: intent.id,
      orderId: intent.siteReference,
      receivedAt: new Date(nowMs),
      expireAt: new Date(nowMs + 30 * DAY_MS),
    };

    if (!orderSnap.exists) {
      deps.log({ msg: 'paylayer webhook for unknown order', ...record, alert: true });
      tx.create(eventRef, { ...record, outcome: 'unknown_order' });
      return;
    }
    const order = orderSnap.data();
    const entRef = db.doc(`entitlements/${order.uid}`);
    const entSnap = await tx.get(entRef);
    const ent = entSnap.exists ? entSnap.data() : null;
    let outcome = 'recorded';

    switch (event.type) {
      case 'payment_intent.paid':
        if (ent && ent.active === true && ent.intentId !== intent.id) {
          // Two checkouts both paid. Keep the first; this one needs a manual
          // refund (the policy allows one full refund inside the window).
          deps.log({ msg: 'duplicate purchase — refund manually', uid: order.uid, ...record, alert: true });
          tx.update(orderRef, { status: 'paid_duplicate', intentId: intent.id, updatedAt: new Date(nowMs) });
          outcome = 'duplicate';
          break;
        }
        tx.set(entRef, {
          active: true,
          product: order.product,
          intentId: intent.id,
          orderId: intent.siteReference,
          amount: intent.amount,
          currency: intent.currency,
          grantedAt: new Date(nowMs),
          revokedAt: null,
        });
        tx.update(orderRef, { status: 'paid', intentId: intent.id, updatedAt: new Date(nowMs) });
        outcome = 'granted';
        break;

      case 'refund.processed':
        if (ent && ent.intentId === intent.id && ent.active === true) {
          tx.update(entRef, { active: false, revokedAt: new Date(nowMs) });
          outcome = 'revoked';
        }
        tx.update(orderRef, { status: 'refunded', updatedAt: new Date(nowMs) });
        break;

      case 'payment_intent.payment_failed':
      case 'payment_intent.expired':
        if (order.status !== 'paid') {
          tx.update(orderRef, {
            status: event.type === 'payment_intent.expired' ? 'expired' : 'payment_failed',
            updatedAt: new Date(nowMs),
          });
        }
        break;

      default:
        // refund.created / refund.failed: nothing to change, keep the record.
        break;
    }
    tx.create(eventRef, { ...record, outcome });
  });

  return { received: true };
}

// ── router ──────────────────────────────────────────────────────────────────

const ROUTES = {
  'GET /api/me': getMe,
  'POST /api/trial/lease': postLease,
  'POST /api/orders': postOrder,
  'POST /webhooks/paylayer': postPayLayerWebhook,
};

/** @param {Deps} deps */
export function createHandler(deps) {
  return async function handle(req, res) {
    res.set('Cache-Control', 'no-store');
    const route = ROUTES[`${req.method} ${req.path}`];
    if (!route) {
      res.status(404).json({ error: { code: 'not_found' } });
      return;
    }
    try {
      const body = await route(req, deps);
      res.status(200).json(body);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      deps.log({ msg: 'unhandled error', route: `${req.method} ${req.path}`, error: String(err && err.stack || err), alert: true });
      res.status(500).json({ error: { code: 'internal' } });
    }
  };
}
