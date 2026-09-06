// Google Analytics 4 — the standard gtag.js snippet, as a module.
//
// WHY NOT INLINE IN index.html: firebase.json ships `script-src 'self'`, which
// blocks both an inline <script> and a third-party <script src>. Keeping the
// snippet here means only the googletagmanager HOST has to be allowed (for the
// tag file itself) — no 'unsafe-inline', and no CSP hash to re-compute every
// time this file is touched. The head is also already busy preloading three
// GLBs and three sounds; letting the tag start from the bundle keeps a
// third-party request out of that first-paint contention.
//
// This measures the landing page and the funnel around it. In-session
// gameplay telemetry is NOT here — that is one Firestore doc per session
// (js/analytics/session.js), which GA4 cannot express and we would not want it
// to. Nothing in this file may throw into app startup.
//
// Loads in dev too, on purpose: the app is exercised on the headset through
// the Vite dev server, and analytics that only exist in a production build are
// analytics nobody verifies. Filter localhost with an "internal traffic" rule
// in the GA4 admin if the noise matters.

const MEASUREMENT_ID = 'G-J3XDFHWP0F';

// `arguments`, not a rest array: gtag.js reads the arguments object it finds
// in dataLayer, and an Array pushes the wrong shape.
function gtag() { window.dataLayer.push(arguments); }

try {
  window.dataLayer = window.dataLayer || [];
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);

  // Queued into dataLayer above, so the ordering is safe either way: the tag
  // drains whatever is already there when it finishes loading.
  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(tag);
} catch (err) {
  console.warn('[ga] disabled:', err);
}
