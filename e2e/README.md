# End-to-end: accounts, free version, lifetime unlock

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

Covered: free version shown with no clock and never metered, free venues
pass the gate, the Arena and Create Room open the unlock dialog, account
creation linking the anonymous uid, checkout validation,
dismissed checkout, paid webhook → unlock, re-purchase refused, restore by
signing in on a second browser, sign-out (back to the free version),
password reset, refund → revoked → free version again.

Screenshots land in `e2e/.artifacts/` (gitignored; override with `E2E_ARTIFACTS`).

## Not covered here — check by hand

- **Real Razorpay test-mode checkout** through a test-mode PayLayer deployment
  (`VITE_PAYLAYER_URL`), including the production CSP (`firebase.json`), which
  the dev server does not send.
- **In-headset locks** (INTERNATIONAL / ELITE, best of 3 / 5, Player
  training, hosting from the in-XR lobby): WebXR cannot run headless. The
  menus are unit-tested (`tests/wristMenu.test.js`, `menuModel.test.js`,
  `lobbyMenuModel.test.js`), the tier in `tests/tier.test.js`, and paid-play
  metering in `tests/trialClock.test.js`.

## Notes

- Ports: 9199, 8189, 5101, 4419, 4519 (emulators), 5180 (Vite), 8790 (fake
  PayLayer). The runner frees them before and after a run (Windows leaves
  emulator JVMs behind).
- Browser: Playwright's Chromium if downloaded (`npx playwright install
  chromium`), otherwise the installed Google Chrome.
- The runner writes the fake PayLayer secrets to `functions/.env.local` for
  the run and restores the previous file afterwards.
