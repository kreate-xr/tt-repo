// Google Tag Manager container bootstrap.
//
// ── WHY THIS IS A MODULE AND NOT THE SNIPPET IN index.html ──────────────────
//
// GTM's copy-paste snippet is an INLINE <script>. firebase.json ships
// `script-src 'self' https://www.googletagmanager.com` with no 'unsafe-inline',
// so pasting it in would fail in the worst possible way: the browser blocks the
// inline bootstrap, gtm.js is never requested, and the page looks completely
// fine while collecting nothing. Firebase Hosting serves static headers, so a
// per-request nonce is not available either — the alternative would be a
// 'sha256-' hash that has to be recomputed every time the snippet changes.
//
// Doing the same work from a module needs neither. Only the googletagmanager
// HOST has to be allowed, which it already is.
//
// ── WHAT GTM CAN AND CANNOT DO UNDER THIS CSP ───────────────────────────────
//
// Tags that GTM LOADS FROM googletagmanager.com — GA4 configuration, most
// Google-built tags — work, because the host is allowlisted.
//
// **Custom HTML tags do NOT.** GTM injects those as inline script, which
// `script-src` blocks. If you need one, the choice is adding 'unsafe-inline'
// to script-src — which disables the main XSS protection for the whole app,
// and is not worth it for a tag — or doing the work here in the bundle
// instead. Tags from any other third-party host also need that host added.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
//
// This measures the landing page and the funnel around it. In-session
// gameplay telemetry is NOT here — that is one Firestore doc per session
// (js/analytics/session.js), which no tag manager can express: GA4 cannot say
// which phase of a multiplayer join stalled, and that is the whole reason the
// session doc exists.
//
// Loads in dev too, on purpose: the app is exercised on the headset through
// the Vite dev server, and analytics that only exist in a production build are
// analytics nobody verifies. Filter it with an internal-traffic rule in GA4,
// or a container-level exception in GTM.
//
// Nothing here may throw into app startup.

// Container id, e.g. 'GTM-XXXXXXX', from VITE_GTM_CONTAINER_ID. Absent (no
// .env.local entry, or a build that never set it) means GTM simply does not
// load — deliberately silent, since a missing analytics tag is not a reason to
// interrupt a player.
//
// Substituted by vite.config.js `define` rather than read from
// import.meta.env: babel-jest cannot transform import.meta to CJS, so a module
// that touches it cannot be unit-tested at all (the constraint
// js/network/iceConfig.js documents). The typeof guard is what lets this file
// run under Jest, where no substitution happens.
const CONTAINER_ID =
  typeof __GTM_CONTAINER_ID__ !== 'undefined' ? __GTM_CONTAINER_ID__ : '';

// ── CONSENT MODE v2 ─────────────────────────────────────────────────────────
//
// Countries where an identifier may not be stored before the visitor agrees:
// EEA + UK + Switzerland, ISO 3166-1 alpha-2, the codes the `region` key takes.
const CONSENT_REQUIRED_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',              // EU 27
  'IS', 'LI', 'NO',              // rest of the EEA
  'GB', 'CH',                    // UK + Switzerland
];

/**
 * Declare the pre-consent defaults. MUST be pushed before gtm.js is requested:
 * a default that arrives after the container has booted is ignored, and by
 * then a cookie has already been written.
 *
 * Two calls, most-specific-wins — the regional one overrides the global one
 * for the countries it names:
 *
 *  - Everywhere: analytics granted, every ad signal denied. We run no ads, and
 *    the privacy notice promises no ad profiling; denying them here is what
 *    makes that true on the wire rather than only in the container's config.
 *  - CONSENT_REQUIRED_REGIONS: everything denied. GA4 still gets cookieless
 *    pings, so those visits are modelled rather than lost — but nothing is
 *    stored on the device, which is the part the law is about.
 *
 * `arguments` and not a rest array: Google reads the arguments object back out
 * of dataLayer, and an Array is the wrong shape.
 *
 * NOTE: there is no consent banner in the app, so nothing calls grantConsent()
 * and EU/UK traffic stays denied. That is the conservative end of the trade —
 * lawful with no banner, at the cost of modelled rather than measured EU
 * numbers. A banner calling grantConsent() on accept is the missing piece.
 */
function setConsentDefaults(win) {
  function gtag() { win.dataLayer.push(arguments); }

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'granted',
  });

  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    region: CONSENT_REQUIRED_REGIONS,
  });
}

/**
 * Raise analytics consent after an explicit opt-in — for the banner that does
 * not exist yet, so adding one is a call rather than a rewrite of this file.
 * The ad signals stay denied: we have no use for them.
 *
 * @param {{win?: object}} env  injected for tests, as initGtm's is
 * @returns {boolean} whether an update was pushed
 */
export function grantConsent(env = {}) {
  const win = env.win || (typeof window !== 'undefined' ? window : null);
  if (!win || !win.dataLayer) return false;
  function gtag() { win.dataLayer.push(arguments); }
  gtag('consent', 'update', { analytics_storage: 'granted' });
  return true;
}

/**
 * @param {string} containerId  defaults to the build-time VITE_GTM_CONTAINER_ID
 * @param {{win?: object, doc?: object}} env  injected for tests. This project
 *   has no jsdom (jest runs the `node` environment), so a module that reached
 *   for the globals directly could not be tested at all — the same reason
 *   js/modes/matchStats.js takes an injected clock.
 * @returns {boolean} whether the container was loaded by this call
 */
export function initGtm(containerId = CONTAINER_ID, env = {}) {
  const win = env.win || (typeof window !== 'undefined' ? window : null);
  const doc = env.doc || (typeof document !== 'undefined' ? document : null);
  if (!containerId || !win || !doc) return false;
  // Idempotent: a second call must not load the container twice, which would
  // double every event GTM fires.
  if (win.__gtmLoaded) return false;

  try {
    win.dataLayer = win.dataLayer || [];

    // Before the gtm.start push, never after: the container reads the consent
    // state as it boots.
    setConsentDefaults(win);

    // The snippet's opening push. GTM reads gtm.start to measure container
    // load time, and the container will not initialise without the gtm.js
    // event — this is not boilerplate that can be dropped.
    win.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });

    const tag = doc.createElement('script');
    tag.async = true;
    tag.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
    doc.head.appendChild(tag);
    win.__gtmLoaded = true;
    return true;
  } catch (err) {
    console.warn('[gtm] disabled:', err);
    return false;
  }
}

// Side effect on import — js/main.js imports this first so the container
// bootstrap does not sit behind three.js evaluating. No-ops under Jest, where
// there is no document and no substituted container id.
initGtm();
