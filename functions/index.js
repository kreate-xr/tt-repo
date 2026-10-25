// Accounts, free trial and payments backend. One HTTPS function, `api`, served
// on the game's own origin through Firebase Hosting rewrites (firebase.json):
//
//   GET  /api/me              entitlement + trial remaining + account kind
//   POST /api/trial/lease     start / renew / end a play lease (src/trial.js,
//                             src/playtime.js)
//   POST /api/orders          create (or hand back) a PayLayer payment intent
//   POST /api/refund          self-service refund of the account's purchase
//   POST /webhooks/paylayer   PayLayer → grant / revoke entitlements/{uid}
//
// Same origin means no CORS, and the existing CSP `connect-src 'self'` already
// covers it. Payments go through PayLayer (D:\Bhuvnesh_Data\Payment), which
// holds the Razorpay keys; this backend holds only the PayLayer site key.
//
// ── SETUP, per project (test first, then prod) ──────────────────────────────
//
//   1. Register the game as a PayLayer site — test-mode PayLayer for the test
//      project, live PayLayer for prod:
//        npm run cli -- site:create --name "Table Tennis XR" \
//          --origins https://<hosting-domain> --currencies INR,USD \
//          --webhook-url https://<hosting-domain>/webhooks/paylayer
//   2. functions/.env.<projectId> (gitignored, never uploaded with the source —
//      the CLI reads it locally and sets plain function env vars). Set ALL of
//      these: the CLI stops to ask interactively for any param missing here,
//      defaults included, which hangs a scripted deploy or emulator run.
//        PAYLAYER_URL=https://<paylayer-host>
//        PAYLAYER_API_KEY=sk_test_...            (from site:create)
//        PAYLAYER_WEBHOOK_SECRET=whsec_...       (from site:create)
//        TRIAL_IP_SALT=<any long random string>
//        TRIAL_IP_DAILY_LIMIT=5
//        APP_CHECK_ENFORCE=false
//      Kept out of Secret Manager by choice: the values are visible in plain
//      text to anyone with view access to the function's Cloud Run config.
//      Emulator runs read the same keys from functions/.env.local instead.
//   3. Firestore TTL policies on `paylayerEvents.expireAt`, `trialIps.expireAt`
//      and `trialNets.expireAt` (console → Firestore → TTL), database 'tabletennis'.
//   4. npm run deploy:test
//
// The game itself runs entirely in the browser, so the trial and the paywall
// are ENFORCED client-side; this backend is the source of truth the client
// asks. A patched client can skip the gate — that is accepted at this price.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import { onRequest } from 'firebase-functions/v2/https';
import { defineString, defineInt, defineBoolean } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { createHandler } from './src/handlers.js';

// Must match DATABASE_ID in js/network/firebaseClient.js and firebase.json.
const DATABASE_ID = 'tabletennis';
// Also named in firebase.json's rewrites — change both together.
const REGION = 'us-central1';

const PAYLAYER_API_KEY = defineString('PAYLAYER_API_KEY');
const PAYLAYER_WEBHOOK_SECRET = defineString('PAYLAYER_WEBHOOK_SECRET');
const TRIAL_IP_SALT = defineString('TRIAL_IP_SALT');
const PAYLAYER_URL = defineString('PAYLAYER_URL');
const TRIAL_IP_DAILY_LIMIT = defineInt('TRIAL_IP_DAILY_LIMIT', { default: 5 });
// Flip to true together with the App Check enforcement switch in the console.
const APP_CHECK_ENFORCE = defineBoolean('APP_CHECK_ENFORCE', { default: false });

const app = initializeApp();
const db = getFirestore(app, DATABASE_ID);

const handler = createHandler({
  db,
  verifyIdToken: (token) => getAuth(app).verifyIdToken(token),
  verifyAppCheck: (token) => getAppCheck(app).verifyToken(token),
  now: () => Date.now(),
  log: (event) => (event.alert ? logger.error(event) : logger.info(event)),
  config: () => ({
    appCheckEnforce: APP_CHECK_ENFORCE.value(),
    trialIpDailyLimit: TRIAL_IP_DAILY_LIMIT.value(),
    trialIpSalt: TRIAL_IP_SALT.value(),
    paylayerUrl: PAYLAYER_URL.value(),
    paylayerApiKey: PAYLAYER_API_KEY.value(),
    paylayerWebhookSecret: PAYLAYER_WEBHOOK_SECRET.value(),
  }),
});

export const api = onRequest(
  {
    region: REGION,
    // Reached only through Hosting; no browser calls it cross-origin.
    cors: false,
    memory: '256MiB',
    maxInstances: 10,
  },
  handler,
);
