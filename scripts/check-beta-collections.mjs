// Smoke test for the beta instrumentation collections — sessions, feedback,
// signups. Companion to check-firebase.mjs, which covers the signaling rooms.
//
// WHY THIS EXISTS. The rules for these three collections are unit-tested
// against the emulator (tests-rules/), but that proves the rules FILE is
// correct, not that it was deployed, nor that the project it was deployed to
// has anonymous auth enabled. Those are exactly the failures that otherwise
// surface as a silent console.warn in a headset, halfway through a test
// session, with nothing written and no obvious cause.
//
// Checks the negative cases too: a client that can READ its own feedback or
// signup row means the deployed rules are not the ones in this repo, and the
// beta would be collecting email addresses that anyone can fetch back.
//
// Run:  node scripts/check-beta-collections.mjs
//
// NOTE: it leaves rows behind — the rules deny delete by design, so the test
// cannot clean up after itself. They are tagged xrMode 'smoke-test' and
// method 'manual' with an @example.invalid address so they are easy to spot
// and exclude. Run it against the TEST project, not production.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { initializeApp } from 'firebase/app';
import {
  getFirestore, doc, collection, setDoc, updateDoc, addDoc, getDoc, getDocs,
  serverTimestamp,
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

let failures = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg, err) => {
  failures += 1;
  console.log(`  ✗ ${msg}${err ? ` — ${err.code || err.message}` : ''}`);
};

/** A write we expect to be ACCEPTED. */
async function expectAllowed(label, fn) {
  try { await fn(); pass(label); }
  catch (err) { fail(label, err); }
}

/** A write or read we expect the rules to REFUSE. */
async function expectDenied(label, fn) {
  try {
    await fn();
    fail(`${label} — it was ALLOWED, deployed rules do not match this repo`);
  } catch (err) {
    if (err.code === 'permission-denied') pass(label);
    else fail(label, err);
  }
}

async function main() {
  const env = loadEnvLocal();
  const missing = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID']
    .filter((k) => !env[k]);
  if (missing.length) {
    console.error(`[FAIL] missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const projectId = env.VITE_FIREBASE_PROJECT_ID;
  console.log(`\nProject: ${projectId}`);
  console.log(`Auth domain: ${env.VITE_FIREBASE_AUTH_DOMAIN}`);
  if (/\.firebaseapp\.com$/.test(env.VITE_FIREBASE_AUTH_DOMAIN || '')) {
    console.log('  ! authDomain is the default *.firebaseapp.com. Google sign-in from');
    console.log('    the Quest browser is likely to fail on third-party-cookie blocking —');
    console.log('    point it at your Hosting domain before testing that flow.');
  }

  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  });

  let user;
  try {
    user = (await signInAnonymously(getAuth(app))).user;
  } catch (err) {
    console.error(`\n[FAIL] anonymous sign-in: ${err.code || err.message}`);
    console.error('       Enable: Firebase Console → Authentication → Sign-in method → Anonymous');
    process.exit(2);
  }
  const uid = user.uid;
  console.log(`Signed in anonymously — uid=${uid.slice(0, 8)}…\n`);

  const db = getFirestore(app);
  const runId = `smoke-${Date.now().toString(36)}`;
  const runRef = doc(db, 'sessions', uid, 'runs', runId);

  console.log('sessions/{uid}/runs/{runId}');
  // Exactly the payload js/analytics/session.js beginSession() writes.
  await expectAllowed('create at session start', () => setDoc(runRef, {
    startedAt: serverTimestamp(),
    xrMode: 'smoke-test',
    appVersion: 'smoke',
    ua: 'check-beta-collections.mjs',
    screen: '0x0',
  }));
  // ...and the single merge endSession() makes.
  await expectAllowed('update at session end', () => updateDoc(runRef, {
    endedAt: serverTimestamp(),
    durationMs: 1234,
    milestones: { pageLoad: 0, sessionStart: 900, firstRally: 4200 },
    net: { thermalThrottled: false, connectFailed: false },
    match: { shots: 3, accuracyPct: 66 },
  }));
  await expectDenied('read back is refused', () => getDoc(runRef));
  await expectDenied('foreign uid is refused', () => setDoc(
    doc(db, 'sessions', 'not-my-uid', 'runs', runId),
    { startedAt: serverTimestamp(), xrMode: 'smoke-test' },
  ));
  await expectDenied('unknown field is refused', () => setDoc(
    doc(db, 'sessions', uid, 'runs', `${runId}-x`),
    { startedAt: serverTimestamp(), xrMode: 'smoke-test', evil: 1 },
  ));

  console.log('\nfeedback/{uid}/items/{id}');
  const items = collection(db, 'feedback', uid, 'items');
  await expectAllowed('rating + note', () => addDoc(items, {
    createdAt: serverTimestamp(),
    rating: 4,
    text: 'smoke test — safe to delete',
    context: { page: 'smoke' },
  }));
  await expectDenied('rating outside 1..5 is refused',
    () => addDoc(items, { createdAt: serverTimestamp(), rating: 9 }));
  await expectDenied('listing feedback is refused', () => getDocs(items));

  console.log('\nsignups/{uid}');
  const signupRef = doc(db, 'signups', uid);
  await expectAllowed('one signup row', () => setDoc(signupRef, {
    email: 'smoke-test@example.invalid',
    method: 'manual',
    createdAt: serverTimestamp(),
  }));
  await expectDenied('a second signup is refused (already on the list)',
    () => setDoc(signupRef, {
      email: 'smoke-test2@example.invalid',
      method: 'manual',
      createdAt: serverTimestamp(),
    }));
  await expectDenied('reading the email list is refused', () => getDoc(signupRef));

  console.log('');
  if (failures) {
    console.error(`${failures} check(s) failed.\n`);
    console.error('If writes were refused: deploy the rules —');
    console.error('  firebase deploy --only firestore:rules');
    console.error('If reads were ALLOWED: the deployed rules are older than this repo.\n');
    process.exit(3);
  }
  console.log(`All checks passed against ${projectId}.`);
  console.log(`Smoke rows left behind (rules deny delete): sessions/${uid.slice(0, 8)}…, `
    + 'feedback (1 item), signups (1 row).\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n[FAIL] ${err.stack || err.message}\n`);
  process.exit(1);
});
