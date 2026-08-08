// Smoke test for the Firestore-based signaling stack.
// Reads .env.local, initializes Firebase, signs in anonymously, writes +
// reads + deletes a test document, then exits. If this passes, the browser
// path will work end-to-end. If it fails, the error tells us what to fix
// (missing config, auth not enabled, rules not deployed, etc.).
//
// Run:  node scripts/check-firebase.mjs

import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import {
  getFirestore, doc, setDoc, getDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

function loadEnvLocal() {
  let raw;
  try { raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8'); }
  catch { throw new Error('.env.local not found in repo root'); }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const env = loadEnvLocal();
  const required = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_APP_ID',
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error('[FAIL] missing env vars:', missing.join(', '));
    process.exit(1);
  }

  console.log(`[1/5] config loaded — projectId=${env.VITE_FIREBASE_PROJECT_ID}`);

  const app = initializeApp({
    apiKey:            env.VITE_FIREBASE_API_KEY,
    authDomain:        env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId:         env.VITE_FIREBASE_PROJECT_ID,
    storageBucket:     env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId:             env.VITE_FIREBASE_APP_ID,
  });
  console.log('[2/5] firebase app initialized');

  const auth = getAuth(app);
  let user;
  try {
    const cred = await signInAnonymously(auth);
    user = cred.user;
  } catch (err) {
    console.error('[FAIL] anonymous sign-in:', err.code || err.message);
    console.error('       Enable: Firebase Console → Authentication → Sign-in method → Anonymous');
    process.exit(2);
  }
  console.log(`[3/5] signed in anonymously — uid=${user.uid.slice(0, 8)}…`);

  const db = getFirestore(app);
  const testId = `smoketest-${Date.now().toString(36)}`;
  const testRef = doc(db, 'rooms', testId);
  try {
    await setDoc(testRef, {
      host: { joinedAt: serverTimestamp() },
      createdAt: serverTimestamp(),
      _smoke: true,
    });
  } catch (err) {
    console.error('[FAIL] write to /rooms:', err.code || err.message);
    console.error('       Likely: firestore.rules not deployed, or Firestore not in Native mode');
    process.exit(3);
  }
  console.log(`[4/5] wrote test doc /rooms/${testId}`);

  try {
    const snap = await getDoc(testRef);
    if (!snap.exists()) throw new Error('test doc disappeared');
    await deleteDoc(testRef);
  } catch (err) {
    console.error('[FAIL] read/delete test doc:', err.code || err.message);
    process.exit(4);
  }
  console.log('[5/5] read + cleaned up test doc');

  console.log('');
  console.log('PASS — Firestore signaling stack is wired correctly.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[FAIL] unexpected:', err);
  process.exit(99);
});
