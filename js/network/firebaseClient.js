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
// Anonymous-auth gate. Never use open rules in production.

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

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

let app = null;
let db = null;
let auth = null;
let signedInPromise = null;

export function initFirebase() {
  if (app) return { app, db, auth };
  const config = readConfig();
  app = getApps().length ? getApps()[0] : initializeApp(config);
  db = getFirestore(app);
  auth = getAuth(app);
  return { app, db, auth };
}

export function getDb() {
  if (!db) initFirebase();
  return db;
}

// Idempotent anonymous sign-in — the SignalingClient calls this before any
// Firestore read/write so security rules can require request.auth != null.
export function ensureAnonymousAuth() {
  if (!auth) initFirebase();
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  if (signedInPromise) return signedInPromise;
  signedInPromise = signInAnonymously(auth).then((cred) => cred.user);
  return signedInPromise;
}
