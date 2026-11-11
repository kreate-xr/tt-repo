// The /api/** and /webhooks/** routes. Everything external (Firestore, token
// verification, PayLayer, the clock) arrives through `deps`, so the emulator
// tests drive exactly this code. index.js does the wiring.
//
// ── DATA (named database 'tabletennis') ─────────────────────────────────────
//
//   users/{uid}           paid play (`play`, playtime.js),
//                         checkout profile, `refundUsed` (one refund per
//                         account, ever) and `pendingOrderId`. Client may READ
//                         its own; only this backend writes.
//   entitlements/{uid}    { active, product, intentId, orderId, refundableUntil,
//                         playAtGrantMs, ... } — the one thing the game checks:
//                         active = the full version, absent = the free one.
//                         orderId is the purchase it came from. Client may
//                         READ its own.
//   orders/{orderId}      one per checkout attempt; maps PayLayer's
//                         siteReference back to a uid. status:
//                         awaiting_payment → paid → refund_requested → refunded,
//                         or failed / expired / paid_duplicate. Also consentAt,
//                         consentTextVersion, refundWindowDays, paidAt.
//                         Server-only.
//   paylayerEvents/{id}   webhook dedupe (PayLayer delivers at least once).
//                         Server-only; `expireAt` is for a TTL policy.
//   trialIps/, trialNets/ are left over from the 10-minute free trial (gone
//                         since the free version). Nothing reads or writes
//                         them; their TTL policy, if set, clears them out.
//
// firestore.rules spells out the same split.

import { createHash, randomBytes } from 'node:crypto';
import {
  priceFor, E164, PRODUCT_ID, PRODUCT_DESCRIPTION, REFUND_WINDOW_DAYS, CONSENT_TEXT_VERSION,
} from './pricing.js';
import {
  playState, applyPlayLease, playedMs, paidPlayedMs, playAtGrant, refundBlock, meterPaidPlay,
  cachedRefundableUntil, REFUND_PLAY_LIMIT_MS, LEASE_ACTIONS, LEASE_MS,
} from './playtime.js';
import {
  verifyWebhook, createPaymentIntent, retrieveIntent, createRefund,
  WebhookSignatureError, PayLayerApiError, SIGNATURE_HEADER,
} from './paylayer.js';

const DAY_MS = 24 * 3600 * 1000;
// A checkout started less than this long ago is handed back instead of a new one.
const PENDING_REUSE_MS = 3600 * 1000;
// Sent with every refund. Fixed strings: a retry must repeat the same body
// under the same idempotency key.
const REFUND_REASON = 'Customer request within refund policy';
const DUPLICATE_REFUND_REASON = 'Duplicate purchase';

const WEBHOOK_TYPES = new Set([
  'payment_intent.paid', 'payment_intent.payment_failed', 'payment_intent.expired',
  'refund.created', 'refund.processed', 'refund.failed',
]);
// Order states a payment_intent.paid may grant from. A payment can follow a
// failed attempt (the intent stays payable), so failures never block it; a
// paid event that turns up after a refund began must not undo the refund.
const GRANTABLE = new Set(['awaiting_payment', 'failed', 'expired']);

// What the player reads when a refund is refused (refundBlock codes and
// PayLayer's own refusals).
const REFUND_MESSAGES = {
  no_purchase: 'There is no purchase on this account to refund.',
  not_paid: 'There is no paid purchase on this account to refund.',
  refund_in_progress: 'Your refund is already being processed.',
  already_refunded: 'This purchase has already been refunded.',
  refund_used: 'Refund not available: this account has already used its one refund.',
  refund_window_expired: 'Refund not available: the 3-day refund window has passed.',
  played_too_long: 'Refund not available: refunds are only for less than 2 hours of play.',
  not_refundable: 'Refund not available: this purchase is non-refundable.',
  intent_not_refundable: 'Refund not available: this payment cannot be refunded.',
  refund_rejected: 'The payment provider declined the refund. Please contact support.',
};

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
 *   appCheckEnforce: boolean,
 *   paylayerUrl: string, paylayerApiKey: string, paylayerWebhookSecret: string,
 * }} config  read per request: secrets are only readable at runtime
 * @property {typeof fetch} [fetchImpl]
 */

// ── request plumbing ────────────────────────────────────────────────────────

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
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

async function readAccess(db, uid) {
  const [userSnap, entSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`entitlements/${uid}`).get(),
  ]);
  const ent = entSnap.exists ? entSnap.data() : null;
  return {
    user: userSnap.exists ? userSnap.data() : null,
    ent,
    entitled: !!ent && ent.active === true,
  };
}

async function readOrder(db, orderId) {
  if (!orderId) return null;
  const snap = await db.doc(`orders/${orderId}`).get();
  return snap.exists ? snap.data() : null;
}

function payCfg(deps) {
  const cfg = deps.config();
  return { baseUrl: cfg.paylayerUrl, apiKey: cfg.paylayerApiKey, fetchImpl: deps.fetchImpl };
}

function toDate(v) {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The refund line on the account screen, from the cached window (display only). */
function refundView(ent, order, user, uid, nowMs) {
  if (!ent || !order || order.uid !== uid) return null;
  if (!['paid', 'refund_requested', 'refunded'].includes(order.status)) return null;
  const until = cachedRefundableUntil(ent, order);
  const played = paidPlayedMs(user, ent, nowMs);
  const reason = order.status === 'refund_requested'
    ? 'refund_in_progress'
    : refundBlock({
      orderStatus: order.status,
      refundUsed: !!(user && user.refundUsed),
      refundableUntil: until,
      played,
      nowMs,
    });
  return {
    eligible: reason === null,
    reason,
    refundableUntil: until === null ? null : new Date(until).toISOString(),
    playedSec: Math.floor(played / 1000),
  };
}

// ── GET /api/me ─────────────────────────────────────────────────────────────

async function getMe(req, deps) {
  const who = await requireUser(req, deps);
  const nowMs = deps.now();
  const { user, ent, entitled } = await readAccess(deps.db, who.uid);
  const order = ent ? await readOrder(deps.db, ent.orderId) : null;
  return {
    // true = the full version, false = the free one. There is no trial.
    entitled,
    // Builds from before the free version gate on this (0 = paywall). A full
    // allowance keeps a page left open across the deploy playable until it
    // reloads. Drop it a release after the free version ships.
    trial: { remainingSec: LEGACY_TRIAL_SEC },
    // Paid play is metered — and the client fails closed — while a refund
    // is still possible (playtime.js).
    metered: meterPaidPlay({ ent, order, user, nowMs }),
    refund: refundView(ent, order, user, who.uid, nowMs),
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
//
// Paid-play metering (playtime.js), and nothing else: the free version is not
// metered. The path keeps the old trial name so older builds keep working.
// A paid player is metered only while a refund is still possible; past that
// the answer is `metered: false` and the client stops calling.

// What a build from before the free version needs to keep playing: a lease
// that never runs out (see LEGACY_TRIAL_SEC). Nothing is written for it.
const LEGACY_TRIAL_SEC = 10 * 60;
const FREE_LEASE = Object.freeze({
  entitled: false, metered: false, leaseSec: LEASE_MS / 1000, remainingSec: LEGACY_TRIAL_SEC,
});

function paidLease(tx, userRef, user, ent, order, action, nowMs) {
  const prev = playState(user);
  const metered = meterPaidPlay({ ent, order, user, nowMs });
  const next = applyPlayLease(prev, action, nowMs, metered ? LEASE_MS : 0);
  // The call that crosses two hours of paid play ends metering on the spot.
  const still = metered && next.totalMs - playAtGrant(ent) < REFUND_PLAY_LIMIT_MS;
  const play = still ? next : { ...next, lastTickMs: null, leaseMs: 0 };
  if (metered || Number.isFinite(prev.lastTickMs) || !(user && user.play)) {
    tx.set(userRef, { play, updatedAt: new Date(nowMs) }, { merge: true });
  }
  return {
    entitled: true,
    metered: still,
    leaseSec: still ? Math.floor(play.leaseMs / 1000) : null,
    remainingSec: null,
  };
}

async function postLease(req, deps) {
  const who = await requireUser(req, deps);
  const action = req.body && req.body.action;
  if (!LEASE_ACTIONS.includes(action)) throw new HttpError(400, 'invalid_action');

  const { db } = deps;
  const nowMs = deps.now();
  const userRef = db.doc(`users/${who.uid}`);
  const entRef = db.doc(`entitlements/${who.uid}`);

  return db.runTransaction(async (tx) => {
    const [userSnap, entSnap] = await Promise.all([tx.get(userRef), tx.get(entRef)]);
    if (!entSnap.exists || entSnap.data().active !== true) return { ...FREE_LEASE };
    const user = userSnap.exists ? userSnap.data() : null;
    const ent = entSnap.data();
    const orderSnap = ent.orderId ? await tx.get(db.doc(`orders/${ent.orderId}`)) : null;
    const order = orderSnap && orderSnap.exists ? orderSnap.data() : null;
    return paidLease(tx, userRef, user, ent, order, action, nowMs);
  });
}

// ── POST /api/orders  { name, phone, consent } ──────────────────────────────

// The exact params an order's intent is created with. A reused order sends
// them again under the same key, and PayLayer replays the original response
// only when they are identical.
function intentParams(orderId, order, customer) {
  return {
    amount: order.amount,
    currency: order.currency,
    customer,
    siteReference: orderId,
    description: PRODUCT_DESCRIPTION,
    metadata: { uid: order.uid, product: order.product },
    refundWindowDays: order.refundWindowDays,
  };
}

// Lets a reused order be matched to the same checkout details without
// keeping a second copy of them on the order.
function customerKey({ name, email, contact }) {
  return createHash('sha256').update(`${name}\n${email}\n${contact}`).digest('hex');
}

/** The open checkout from the last hour, handed back again, or null. */
async function reusePendingOrder(deps, user, uid, customer, currency, consent) {
  const pendingId = user && user.pendingOrderId;
  if (!pendingId) return null;
  const ref = deps.db.doc(`orders/${pendingId}`);
  const snap = await ref.get();
  const order = snap.exists ? snap.data() : null;
  const createdMs = order && order.createdAt && order.createdAt.toMillis ? order.createdAt.toMillis() : 0;
  if (!order || order.uid !== uid || order.status !== 'awaiting_payment' || !order.intentId
      || deps.now() - createdMs >= PENDING_REUSE_MS) {
    return null;
  }
  if (order.customerKey !== customerKey(customer) || order.currency !== currency) {
    // Name or phone changed (a typo fixed, another country's number): the
    // old intent cannot be replayed with new details, so a new order starts.
    deps.log({ msg: 'pending order superseded: checkout details changed', orderId: pendingId });
    return null;
  }
  let intent;
  try {
    intent = await createPaymentIntent(payCfg(deps), intentParams(pendingId, order, customer), pendingId);
  } catch (err) {
    deps.log({ msg: 'paylayer replay of pending order failed', orderId: pendingId, status: err.status, code: err.code });
    if (err instanceof PayLayerApiError && err.status === 422) return null;
    throw new HttpError(502, 'payment_unavailable', 'Payments are unavailable — try again shortly');
  }
  await ref.update({ ...consent, updatedAt: new Date(deps.now()) });
  return { intentId: intent.id, clientSecret: intent.clientSecret };
}

async function postOrder(req, deps) {
  const who = await requireUser(req, deps);
  // The email claim, not sign_in_provider: an anonymous trial account that
  // was upgraded with linkWithCredential keeps sign_in_provider 'anonymous'
  // (it names how THIS session signed in) but gains the email.
  if (!who.email) {
    throw new HttpError(403, 'account_required', 'Sign in with email and password to buy');
  }

  const body = req.body || {};
  // The checkout form will not submit without the box ticked; this is the
  // check that counts.
  if (body.consent !== true) {
    throw new HttpError(400, 'consent_required', 'Tick the box to agree before paying');
  }
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').replace(/[\s-]/g, '');
  if (name.length < 1 || name.length > 100) throw new HttpError(400, 'invalid_name');
  if (!E164.test(phone)) throw new HttpError(400, 'invalid_phone', 'Phone must look like +919876543210');

  const { db } = deps;
  const { user, entitled } = await readAccess(db, who.uid);
  if (entitled) throw new HttpError(409, 'already_owned');

  const { amount, currency } = priceFor(phone);
  const customer = { name, email: who.email, contact: phone };
  const nowMs = deps.now();
  const consent = { consentAt: new Date(nowMs), consentTextVersion: CONSENT_TEXT_VERSION };

  const reused = await reusePendingOrder(deps, user, who.uid, customer, currency, consent);
  if (reused) return reused;

  const orderId = `ord_${randomBytes(10).toString('hex')}`;
  const orderRef = db.doc(`orders/${orderId}`);
  const order = {
    uid: who.uid,
    product: PRODUCT_ID,
    amount,
    currency,
    // After the one refund, a new purchase is final.
    refundWindowDays: user && user.refundUsed ? 0 : REFUND_WINDOW_DAYS,
    customerKey: customerKey(customer),
    status: 'awaiting_payment',
    ...consent,
    createdAt: new Date(nowMs),
    paidAt: null,
  };

  // Written BEFORE PayLayer is called, so a webhook can never arrive for an
  // order this backend has no record of.
  await orderRef.set(order);
  await db.doc(`users/${who.uid}`).set(
    { profile: { name, phone }, pendingOrderId: orderId, updatedAt: new Date(nowMs) },
    { merge: true },
  );

  let intent;
  try {
    intent = await createPaymentIntent(payCfg(deps), intentParams(orderId, order, customer), orderId);
  } catch (err) {
    await orderRef.update({ status: 'failed', error: (err && err.code) || 'unknown' });
    deps.log({ msg: 'paylayer create intent failed', orderId, status: err.status, code: err.code });
    throw new HttpError(502, 'payment_unavailable', 'Payments are unavailable — try again shortly');
  }

  await orderRef.update({ intentId: intent.id });
  // Only what the browser SDK needs; the price was decided here.
  return { intentId: intent.id, clientSecret: intent.clientSecret };
}

// ── POST /api/refund ────────────────────────────────────────────────────────
//
// Self-service refund of the account's own purchase. The rules are checked
// here, in this order, every time: (a) the purchase is paid, (b) the account
// has not used its one refund, (c) PayLayer's refundableUntil has not passed
// (asked of PayLayer, never computed here), (d) under two hours of play.
// The unlock is removed BEFORE PayLayer is asked, and put back only when
// PayLayer definitely refused; the refund.* webhook settles the rest.

function refundError(code) {
  const status = code === 'no_purchase' ? 404 : code === 'refund_rejected' ? 422 : 409;
  return new HttpError(status, code, REFUND_MESSAGES[code] || code);
}

async function restorePaid(db, orderId, uid) {
  const orderRef = db.doc(`orders/${orderId}`);
  const entRef = db.doc(`entitlements/${uid}`);
  await db.runTransaction(async (tx) => {
    const [o, e] = await Promise.all([tx.get(orderRef), tx.get(entRef)]);
    if (!o.exists || o.data().status !== 'refund_requested') return;
    tx.update(orderRef, { status: 'paid', updatedAt: new Date() });
    if (e.exists && e.data().orderId === orderId) tx.update(entRef, { active: true, revokedAt: null });
  });
}

async function postRefund(req, deps) {
  const who = await requireUser(req, deps);
  const { db } = deps;
  const { user, ent } = await readAccess(db, who.uid);
  const orderId = ent && ent.orderId;
  const order = await readOrder(db, orderId);
  if (!order || order.uid !== who.uid || !order.intentId) throw refundError('no_purchase');

  // a, b
  const refundUsed = !!(user && user.refundUsed);
  let block = refundBlock({ orderStatus: order.status, refundUsed, nowMs: deps.now() });
  if (block) throw refundError(block);

  // c: the window as PayLayer holds it
  let intent;
  try {
    intent = await retrieveIntent(payCfg(deps), order.intentId);
  } catch (err) {
    deps.log({ msg: 'paylayer retrieve intent failed', orderId, status: err.status, code: err.code });
    throw new HttpError(502, 'refund_unavailable', 'Refunds are unavailable right now — try again shortly');
  }
  const nowMs = deps.now();
  block = refundBlock({
    orderStatus: order.status,
    refundUsed,
    refundableUntil: intent.refundableUntil ?? null,
    // d: server-metered play since the purchase, including a lease still open
    played: paidPlayedMs(user, ent, nowMs),
    nowMs,
  });
  if (block) throw refundError(block);

  const orderRef = db.doc(`orders/${orderId}`);
  const entRef = db.doc(`entitlements/${who.uid}`);
  const userRef = db.doc(`users/${who.uid}`);
  await db.runTransaction(async (tx) => {
    const [o, e, u] = await Promise.all([tx.get(orderRef), tx.get(entRef), tx.get(userRef)]);
    const status = o.data().status;
    if (status === 'refund_requested') return; // a retry: same request again
    if (status !== 'paid') throw refundError(status === 'refunded' ? 'already_refunded' : 'not_paid');
    const ts = new Date(nowMs);
    tx.update(orderRef, { status: 'refund_requested', refundRequestedAt: ts, updatedAt: ts });
    if (e.exists && e.data().orderId === orderId) tx.update(entRef, { active: false, revokedAt: ts });
    // Close an open lease: no more play is billed against this purchase.
    const play = playState(u.exists ? u.data() : null);
    if (Number.isFinite(play.lastTickMs)) {
      tx.set(userRef, { play: applyPlayLease(play, 'end', nowMs, 0) }, { merge: true });
    }
  });

  try {
    await createRefund(payCfg(deps), order.intentId, { reason: REFUND_REASON }, `refund-${order.intentId}`);
  } catch (err) {
    if (err instanceof PayLayerApiError && err.status < 500) {
      // Already refunded, or the same key still in flight: the webhook settles it.
      if (err.code === 'already_refunded' || err.code === 'request_in_progress') return { status: 'refund_requested' };
      // Anything else below 500 means PayLayer did not refund: put the unlock back.
      await restorePaid(db, orderId, who.uid);
      deps.log({
        msg: 'refund refused by paylayer — unlock restored', orderId, status: err.status, code: err.code,
        alert: !REFUND_MESSAGES[err.code],
      });
      if (REFUND_MESSAGES[err.code]) throw refundError(err.code);
      throw new HttpError(502, 'refund_unavailable', 'Refunds are unavailable right now — try again shortly');
    }
    // Timeout, network error or a PayLayer 5xx: the outcome is unknown, so
    // the order stays 'refund_requested'. A retry reuses `refund-<intentId>`.
    deps.log({ msg: 'refund outcome unknown — left refund_requested', orderId, error: String((err && err.message) || err), alert: true });
    return { status: 'refund_requested', pending: true };
  }
  return { status: 'refund_requested' };
}

// ── POST /webhooks/paylayer ─────────────────────────────────────────────────

// Two checkouts both paid: the second one is refunded straight away, through
// the same API as a player's refund but WITHOUT touching refundUsed (the
// refund.* webhooks see `duplicate: true` on the order).
async function refundDuplicate(deps, orderId, intentId) {
  const ref = deps.db.doc(`orders/${orderId}`);
  try {
    await createRefund(payCfg(deps), intentId, { reason: DUPLICATE_REFUND_REASON }, `refund-${intentId}`);
    await ref.update({ duplicateRefund: 'requested' });
  } catch (err) {
    const code = err instanceof PayLayerApiError ? err.code : 'network_error';
    if (code === 'already_refunded') {
      await ref.update({ duplicateRefund: 'requested' });
      return;
    }
    const dashboard = err instanceof PayLayerApiError && err.status === 409
      && (code === 'not_refundable' || code === 'refund_window_expired');
    deps.log({
      msg: dashboard
        ? 'duplicate purchase cannot be refunded through PayLayer — refund it from the Razorpay Dashboard'
        : 'duplicate purchase refund did not go through — check it and refund manually',
      orderId, intentId, code, alert: true,
    });
    await ref.update({ duplicateRefund: dashboard ? 'dashboard' : 'failed' });
  }
}

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

  if (!event || !WEBHOOK_TYPES.has(event.type)) {
    deps.log({ msg: 'paylayer webhook type ignored', type: event && event.type });
    return { received: true };
  }
  const intent = event.data && event.data.intent;
  if (!event.id || !/^[\w-]{1,128}$/.test(event.id) || !intent || !intent.siteReference
      || !/^ord_[0-9a-f]{20}$/.test(intent.siteReference)) {
    deps.log({ msg: 'paylayer webhook with unexpected shape', eventId: event.id, alert: true });
    return { received: true };
  }

  const { db } = deps;
  const nowMs = deps.now();
  const orderId = intent.siteReference;
  const eventRef = db.doc(`paylayerEvents/${event.id}`);
  const orderRef = db.doc(`orders/${orderId}`);

  const duplicate = await db.runTransaction(async (tx) => {
    const [eventSnap, orderSnap] = await Promise.all([tx.get(eventRef), tx.get(orderRef)]);
    if (eventSnap.exists) return false; // redelivery

    const record = {
      type: event.type,
      intentId: intent.id,
      orderId,
      receivedAt: new Date(nowMs),
      expireAt: new Date(nowMs + 30 * DAY_MS),
    };

    if (!orderSnap.exists) {
      deps.log({ msg: 'paylayer webhook for unknown order', ...record, alert: true });
      tx.create(eventRef, { ...record, outcome: 'unknown_order' });
      return false;
    }
    const order = orderSnap.data();
    const entRef = db.doc(`entitlements/${order.uid}`);
    const userRef = db.doc(`users/${order.uid}`);
    const entSnap = await tx.get(entRef);
    const ent = entSnap.exists ? entSnap.data() : null;
    const isSource = !!ent && ent.orderId === orderId;
    const ts = new Date(nowMs);
    let outcome = 'recorded';
    let refundIt = false;

    switch (event.type) {
      case 'payment_intent.paid': {
        if (intent.amount !== order.amount || intent.currency !== order.currency) {
          deps.log({
            msg: 'paid amount/currency does not match the order — not unlocking', ...record,
            paidAmount: intent.amount, paidCurrency: intent.currency, alert: true,
          });
          outcome = 'amount_mismatch';
          break;
        }
        if (order.status === 'paid' && isSource) { outcome = 'already_granted'; break; }
        if (!GRANTABLE.has(order.status)) {
          deps.log({ msg: 'paid event for an order past payment — ignored', ...record, status: order.status });
          outcome = 'stale';
          break;
        }
        const paidAt = toDate(intent.paidAt) || ts;
        if (ent && ent.active === true && !isSource) {
          // Two checkouts both paid. Keep the first unlock; refund this one.
          deps.log({ msg: 'duplicate purchase — refunding it', uid: order.uid, ...record, alert: true });
          tx.update(orderRef, { status: 'paid_duplicate', duplicate: true, intentId: intent.id, paidAt, updatedAt: ts });
          outcome = 'duplicate';
          refundIt = true;
          break;
        }
        // The refund's two hours count from here (playtime.js).
        const userSnap = await tx.get(userRef);
        tx.set(entRef, {
          playAtGrantMs: playedMs(playState(userSnap.exists ? userSnap.data() : null), nowMs),
          active: true,
          product: order.product,
          intentId: intent.id,
          orderId,
          amount: intent.amount,
          currency: intent.currency,
          // Display + metering only; the refund endpoint asks PayLayer.
          refundableUntil: toDate(intent.refundableUntil),
          grantedAt: ts,
          revokedAt: null,
        });
        tx.update(orderRef, { status: 'paid', intentId: intent.id, paidAt, updatedAt: ts });
        outcome = 'granted';
        break;
      }

      case 'payment_intent.payment_failed':
        // The intent stays payable and the player may retry; nothing changes.
        deps.log({ msg: 'paylayer payment attempt failed', orderId, intentId: intent.id });
        outcome = 'logged';
        break;

      case 'payment_intent.expired':
        if (order.status === 'awaiting_payment') {
          tx.update(orderRef, { status: 'expired', updatedAt: ts });
          outcome = 'expired';
        }
        break;

      case 'refund.created':
      case 'refund.processed':
        if (order.status !== 'refunded') tx.update(orderRef, { status: 'refunded', refundedAt: ts, updatedAt: ts });
        if (order.duplicate === true) { outcome = 'duplicate_refunded'; break; }
        if (isSource && ent.active === true) tx.update(entRef, { active: false, revokedAt: ts });
        tx.set(userRef, { refundUsed: true, updatedAt: ts }, { merge: true });
        outcome = 'revoked';
        break;

      case 'refund.failed':
        if (order.duplicate === true) {
          deps.log({ msg: 'duplicate purchase refund failed — refund it from the Razorpay Dashboard', ...record, alert: true });
          outcome = 'duplicate_refund_failed';
        } else if (order.status === 'refund_requested') {
          // The player paid and the money did not go back: give the game back.
          tx.update(orderRef, { status: 'paid', updatedAt: ts });
          if (isSource) tx.update(entRef, { active: true, revokedAt: null });
          deps.log({ msg: 'refund failed — unlock restored, player was not refunded', ...record, alert: true });
          outcome = 'restored';
        } else {
          deps.log({
            msg: 'refund failed for an order not awaiting a refund — check it manually', ...record,
            status: order.status, alert: true,
          });
        }
        break;
    }
    tx.create(eventRef, { ...record, outcome });
    return refundIt;
  });

  if (duplicate) await refundDuplicate(deps, orderId, intent.id);
  return { received: true };
}

// ── router ──────────────────────────────────────────────────────────────────

const ROUTES = {
  'GET /api/me': getMe,
  'POST /api/trial/lease': postLease,
  'POST /api/orders': postOrder,
  'POST /api/refund': postRefund,
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
