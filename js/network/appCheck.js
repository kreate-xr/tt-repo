// Firebase App Check — proves to Firestore that a request came from THIS web
// app running in a real browser, not from a script that copied the (public)
// Firebase config out of the bundle.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// firestore.rules already shape-locks every write, but the identity behind
// them is an ANONYMOUS account, and anonymous accounts are free to mint. With
// nothing else in the way, one curl loop can fill `sessions`, `feedback` and
// `signups` with junk at our billing rate. App Check closes that: each request
// carries a short-lived token minted from a reCAPTCHA Enterprise assessment,
// and once ENFORCEMENT is switched on in the Firebase console (Security → App
// Check → Firestore), requests without one are refused.
//
// This module only attests. Enforcement is a console switch, flipped after the
// metrics tab shows the deployed client producing valid tokens — flipping it
// first locks out every visitor on an older build.
//
// ── MODES ───────────────────────────────────────────────────────────────────
//
//   recaptcha  production builds: ReCaptchaEnterpriseProvider(site key).
//              Invisible — no challenge, no click. The key is public (it is in
//              every page that uses it); what matters is that its registered
//              domains include the hosting domain.
//   debug      the Vite DEV SERVER only: the SDK's debug exchange, keyed by a
//              token registered under Security → App Check → Apps → Manage
//              debug tokens. Needed because the dev origin is a LAN address
//              the headset dials (https://192.168.x.x:5173), which reCAPTCHA
//              cannot be registered for. A FIXED token string (APPCHECK_DEBUG_
//              TOKEN in .env.local) is required for the Quest: with `true`
//              the SDK mints a random token and prints it to a console the
//              headset does not have (see headset-diagnostics notes).
//   off        no site key configured. Firestore keeps working exactly as
//              before UNTIL enforcement is on — after that, every write is
//              permission-denied. Hence the loud warning.
//
// Both values arrive via vite.config.js `define`, not import.meta.env, for two
// reasons. (1) babel-jest cannot transform import.meta, so a module that reads
// it is un-unit-testable (the js/analytics/gtm.js constraint). (2) The debug
// token must NEVER reach dist/: a VITE_-prefixed variable is inlined into any
// module that references it, whereas the define is the empty string on
// `vite build`, so the production bundle cannot contain it by construction.
//
// Nothing here may throw into app startup — a broken App Check is a Firestore
// problem later, not a blank page now.

import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

const SITE_KEY =
  typeof __RECAPTCHA_SITE_KEY__ !== 'undefined' ? __RECAPTCHA_SITE_KEY__ : '';
const DEBUG_TOKEN =
  typeof __APPCHECK_DEBUG_TOKEN__ !== 'undefined' ? __APPCHECK_DEBUG_TOKEN__ : '';

/**
 * Decide how App Check runs for a given configuration. Pure, so the branch
 * that decides what ships is the branch that is tested.
 *
 * @param {{ siteKey?: string, debugToken?: string, isDevServer?: boolean }} cfg
 * @returns {{ mode: 'recaptcha' | 'debug' | 'off', siteKey?: string, debugToken?: string, warning?: string }}
 */
export function planAppCheck({ siteKey = '', debugToken = '', isDevServer = false } = {}) {
  siteKey = String(siteKey || '').trim();
  debugToken = String(debugToken || '').trim();

  if (isDevServer) {
    // Dev server: the debug exchange, never reCAPTCHA (see MODES above).
    // Without a fixed token the SDK generates one and logs it — usable on
    // desktop, invisible on the headset.
    return {
      mode: 'debug',
      debugToken,
      siteKey: siteKey || 'debug-placeholder',
      warning: debugToken ? undefined
        : '[appCheck] no APPCHECK_DEBUG_TOKEN in .env.local — the SDK will print a fresh '
          + 'debug token to this console; register it in the Firebase console '
          + '(Security → App Check → Apps → Manage debug tokens). The headset has no '
          + 'console: set a fixed token for it.',
    };
  }

  if (!siteKey) {
    return {
      mode: 'off',
      warning: '[appCheck] VITE_RECAPTCHA_ENTERPRISE_SITE_KEY is not set — App Check is OFF for '
        + 'this build. Fine until enforcement is enabled in the Firebase console; after '
        + 'that every Firestore write from this build is permission-denied.',
    };
  }

  return { mode: 'recaptcha', siteKey };
}

let installed = false;

/**
 * Attach App Check to the Firebase app. Must run right after initializeApp()
 * and BEFORE the first getFirestore()/getAuth() — the SDK attaches its token
 * interceptor at init, and a Firestore instance created earlier sends bare.
 *
 * Idempotent; safe to call from every path that might initialize Firebase.
 *
 * @param {import('firebase/app').FirebaseApp} app
 * @param {object} [deps] test seams
 */
export function installAppCheck(app, {
  siteKey = SITE_KEY,
  debugToken = DEBUG_TOKEN,
  // `import.meta.env.DEV` would be the natural flag, but this module must stay
  // free of import.meta (see header). vite.config.js substitutes the token
  // define ONLY under `vite`/`vite dev`, so its presence — or the empty string
  // it becomes on build — is not the signal; the explicit define is.
  isDevServer = typeof __IS_DEV_SERVER__ !== 'undefined' ? __IS_DEV_SERVER__ : false,
  globals = typeof globalThis !== 'undefined' ? globalThis : {},
  initialize = initializeAppCheck,
  Provider = ReCaptchaEnterpriseProvider,
  warn = (...a) => console.warn(...a),
} = {}) {
  if (installed) return { mode: 'already' };
  const plan = planAppCheck({ siteKey, debugToken, isDevServer });
  if (plan.warning) warn(plan.warning);
  if (plan.mode === 'off') return plan;

  try {
    if (plan.mode === 'debug') {
      // Read by the SDK inside initializeAppCheck(); `true` means "mint and
      // persist one in IndexedDB, log it", a string means "use exactly this".
      globals.FIREBASE_APPCHECK_DEBUG_TOKEN = plan.debugToken || true;
    }
    initialize(app, {
      provider: new Provider(plan.siteKey),
      // Without this the token silently expires after ~1h and a long session
      // (or a lobby left open) starts failing writes mid-match.
      isTokenAutoRefreshEnabled: true,
    });
    installed = true;
  } catch (err) {
    // Same posture as the rest of startup: log, do not throw. The symptom
    // downstream is permission-denied from Firestore, which every caller
    // already handles.
    warn('[appCheck] initialization failed (Firestore writes will be refused once '
      + 'enforcement is on):', (err && err.message) || err);
    return { ...plan, mode: 'off', error: err };
  }
  return plan;
}

/** Test-only: forget that installAppCheck ran. */
export function _resetAppCheckForTests() {
  installed = false;
}
