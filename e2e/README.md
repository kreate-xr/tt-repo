# End-to-end: accounts, free trial, lifetime unlock

```
npm run test:e2e
```

Drives the real landing page (headless Chromium via Playwright) against:

- the real backend (`functions/`) in the Functions emulator,
- the Auth and Firestore emulators (`firebase.e2e.json`, project `demo-tt`),
- a **fake PayLayer** (`fakePayLayer.mjs`) in place of PayLayer + Razorpay. It
  speaks the same API and sends the same signed webhooks, but opens no checkout.

The page runs on `vite --mode e2e` (`.env.e2e`, http://localhost:5180), which
points Firebase at the emulators and proxies `/api` + `/webhooks` to the
Functions emulator. Nothing touches the test or prod project.

Covered: trial shown and metered server-side, venue gate, trial exhausted →
paywall, account creation linking the anonymous uid, checkout validation,
dismissed checkout, paid webhook → unlock, re-purchase refused, restore by
signing in on a second browser, sign-out, password reset, refund → revoked.

Screenshots land in `e2e/.artifacts/` (gitignored; override with `E2E_ARTIFACTS`).

## Not covered here — check by hand

- **Real Razorpay test-mode checkout** through a test-mode PayLayer deployment
  (`VITE_PAYLAYER_URL`), including the production CSP (`firebase.json`), which
  the dev server does not send.
- **In-headset trial expiry** (js/modes/inGame.js): WebXR cannot run headless.
  The lease logic itself is unit-tested in `tests/trialClock.test.js`.

## Notes

- Ports: 9199, 8189, 5101, 4419, 4519 (emulators), 5180 (Vite), 8790 (fake
  PayLayer). The runner frees them before and after a run (Windows leaves
  emulator JVMs behind).
- Browser: Playwright's Chromium if downloaded (`npx playwright install
  chromium`), otherwise the installed Google Chrome.
- The runner writes the fake PayLayer secrets to `functions/.secret.local` for
  the run and restores the previous file afterwards.
