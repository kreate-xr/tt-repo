// App Check for the Node smoke scripts (check-firebase.mjs,
// check-beta-collections.mjs).
//
// Those scripts talk to the DEPLOYED Firestore with the client SDK and an
// anonymous sign-in — i.e. exactly the traffic App Check enforcement exists
// to refuse. Node has no reCAPTCHA, so they attest the way the dev server
// does: the SDK's debug exchange, keyed by a token registered in the Firebase
// console (Security → App Check → Apps → Manage debug tokens). Same
// APPCHECK_DEBUG_TOKEN line in the env file the script read (.env.local or
// .env.prod.local — a debug token is per project) that the headset uses.
//
// No token → nothing is installed and the script runs bare, which is correct
// until enforcement is on and permission-denied everywhere after — the
// message at the bottom of each script points here.

import { initializeAppCheck, CustomProvider } from 'firebase/app-check';

export function installDebugAppCheck(app, env) {
  const token = (env.APPCHECK_DEBUG_TOKEN || '').trim();
  if (!token) {
    console.log('App Check: no APPCHECK_DEBUG_TOKEN in the env file — running WITHOUT '
      + 'attestation (fails once enforcement is on).');
    return false;
  }
  // Must be set before initializeAppCheck(); the SDK reads it inside.
  globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
  initializeAppCheck(app, {
    // Never consulted in debug mode; a reCAPTCHA provider would try to touch
    // `document` here. CustomProvider's initialize() is a no-op.
    provider: new CustomProvider({
      getToken: () => Promise.reject(new Error('debug mode expected')),
    }),
    isTokenAutoRefreshEnabled: false,
  });
  console.log(`App Check: debug token …${token.slice(-6)}`);
  return true;
}
