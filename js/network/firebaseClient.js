// Single point of Firebase initialization. Pulled into the bundle once; both
// the SignalingClient (Firestore listeners) and the eventual TelemetryReporter
// migration (Cloud Logging via Identity Platform) read their handles from here.
//
// Setup (one-time, per GCP project):
//   1. GCP Console → enable Firestore in Native mode in your project
//   2. GCP Console → Identity Platform → enable the Anonymous provider
//   3. GCP Console → APIs & Services → Credentials → Web API key
//      (or: Firebase Console → Project Settings → "Your apps" → register a web
//      app; the snippet there gives you all the fields below)
//   4. Copy values into .env.local (see .env.example) — VITE_FIREBASE_*
//   5. Restart `npm run dev` (env vars are read at startup)
//
// Security note: the apiKey is PUBLIC and safe to expose to the client. What
// protects your data is Firestore security rules (firestore.rules) plus the
// Anonymous-auth gate, plus App Check (js/network/appCheck.js), which is what
// stops the config being replayed from outside a browser. Never use open
// rules in production.

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, getDoc, connectFirestoreEmulator } from 'firebase/firestore';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import { installAppCheck } from './appCheck.js';
import { traceBoot } from './connectTrace.js';

function readConfig() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const cfg = {
    apiKey:            env.VITE_FIREBASE_API_KEY,
    authDomain:        env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId:         env.VITE_FIREBASE_PROJECT_ID,
    storageBucket:     env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId:             env.VITE_FIREBASE_APP_ID,
  };
  const missing = ['apiKey', 'authDomain', 'projectId', 'appId']
    .filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `Firebase config missing required fields: ${missing.join(', ')}. ` +
      `Set VITE_FIREBASE_* in .env.local — see .env.example.`
    );
  }
  return cfg;
}

// Named Firestore database. NOT '(default)' — this project has a dedicated
// database for the game, and every collection (signaling rooms, sessions,
// feedback, signups) lives in it.
//
// Two things must agree with this constant or nothing works:
//   - firebase.json's `firestore.database`, which decides where
//     `firebase deploy --only firestore:rules` sends the rules
//   - the database actually existing in the project
// A mismatch does not fail loudly at startup; it surfaces as
// permission-denied on the first write, because an undeployed database has no
// rules. scripts/check-beta-collections.mjs is the fast way to confirm.
export const DATABASE_ID = 'tabletennis';

let app = null;
let db = null;
let auth = null;
let signedInPromise = null;

// Local emulators, for the end-to-end suite only (`vite --mode e2e`, see
// e2e/README.md). Both hosts set → Auth and Firestore talk to the emulators
// and App Check is skipped (its debug exchange would hit the real backend
// with a demo project). Never set in .env.local / .env.prod.local.
function readEmulators() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const authHost = env.VITE_EMULATOR_AUTH;
  const firestoreHost = env.VITE_EMULATOR_FIRESTORE;
  return authHost && firestoreHost ? { authHost, firestoreHost } : null;
}

export function initFirebase() {
  if (app) return { app, db, auth };
  const config = readConfig();
  const emulators = readEmulators();
  app = getApps().length ? getApps()[0] : initializeApp(config);
  // Order matters: App Check hooks the app BEFORE any service instance exists.
  // A Firestore created first would keep sending unattested requests.
  if (!emulators) installAppCheck(app);
  db = getFirestore(app, DATABASE_ID);
  auth = getAuth(app);
  if (emulators) {
    const [fsHost, fsPort] = emulators.firestoreHost.split(':');
    connectFirestoreEmulator(db, fsHost, Number(fsPort));
    connectAuthEmulator(auth, `http://${emulators.authHost}`, { disableWarnings: true });
  }
  return { app, db, auth };
}

export function getFirebaseAuth() {
  if (!auth) initFirebase();
  return auth;
}

export function getDb() {
  if (!db) initFirebase();
  return db;
}


// Idempotent anonymous sign-in — the SignalingClient calls this before any
// Firestore read/write so security rules can require request.auth != null.
export async function ensureAnonymousAuth() {
  if (!auth) initFirebase();
  // A returning player's session is restored from IndexedDB asynchronously;
  // currentUser is null until that finishes. Signing in anonymously before it
  // does would throw away a signed-in (possibly paid) account.
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  if (signedInPromise) return signedInPromise;
  // Memoized only while in flight (concurrent callers share one sign-in).
  // Kept after it settles, a sign-out would get the OLD resolved promise back
  // and never sign in again — leaving currentUser null.
  signedInPromise = signInAnonymously(auth)
    .then((cred) => {
      signedInPromise = null;
      return cred.user;
    })
    .catch((err) => {
      // Drop the memoized promise so a transient failure (offline, quota)
      // doesn't poison every later lobby attempt until a page reload.
      signedInPromise = null;
      throw err;
    });
  return signedInPromise;
}

// Speculative warm-up, called when the player opens the multiplayer lobby
// rather than when they press CREATE/JOIN.
//
// WHY. Everything this touches is cold on the first attempt and all of it sits
// on the critical path of SignalingClient.connect(): initializeApp +
// getFirestore + getAuth, a full HTTPS round trip to identitytoolkit for the
// anonymous sign-in, then the first Firestore round trip, which is what
// actually opens the backend channel. On Quest Wi-Fi that is seconds, and
// every promise continuation in the chain is queued behind a rendered frame —
// so it costs more in a VR venue, which has far less per-frame slack than an
// MR passthrough scene, than it does in MR. Paying it while the player is
// still choosing CREATE vs JOIN (or typing six characters on the in-XR
// keyboard) takes it out of the wait they actually feel.
//
// Never rejects: a warm that doesn't work leaves the cold path exactly as it
// was, and ensureAnonymousAuth already drops its own memo on failure.
let warmed = false;

export function prewarmSignaling() {
  if (warmed) return Promise.resolve();
  warmed = true;
  // readConfig() throws SYNCHRONOUSLY on a missing VITE_FIREBASE_*, and
  // ensureAnonymousAuth reaches it via initFirebase() before it returns a
  // promise — so this needs try/catch, not just a .catch().
  try {
    return ensureAnonymousAuth()
      // A get on a doc id that can never be a room code: ROOM_CODE_ALPHABET
      // omits 0 and 1, and codes are 6 chars, not 7. firestore.rules allows
      // `get: if signedIn()`, so this reads a document that does not exist —
      // it creates nothing, writes nothing, and consumes no code. Its only
      // job is to open the Firestore channel.
      .then(() => getDoc(doc(getDb(), 'rooms', '0warmup')))
      .then(
        () => { traceBoot('firebase init + anon auth warm done'); },
        (err) => {
          warmed = false; // let a later CREATE/JOIN retry from cold
          traceBoot('firebase warm FAILED', (err && err.code) || '');
          console.warn('[multiplayer] signaling warm-up failed (harmless):', err && err.code);
        }
      );
  } catch (err) {
    warmed = false;
    traceBoot('firebase warm unavailable', (err && err.message) || '');
    console.warn('[multiplayer] signaling warm-up unavailable:', err && err.message);
    return Promise.resolve();
  }
}
