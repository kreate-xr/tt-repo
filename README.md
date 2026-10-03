# SportyXR — Table Tennis

A WebXR table tennis game for Meta Quest (mixed-reality passthrough).
Realistic ball physics with spin and Magnus lift, AI opponents across three
tiers (club / international / elite), a training mode with drills and a ball
machine, ITTF match rules, and peer-to-peer multiplayer over WebRTC with
Firestore signaling.

Built with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/).
No framework; plain ES modules.

## Requirements

- Node.js ≥ 20.19
- [Git LFS](https://git-lfs.com/) (large `.glb`/`.mp3` assets are LFS-tracked —
  run `git lfs install` once after cloning)
- A Firebase project with **Firestore** (Native mode) and **Anonymous
  Authentication** enabled, for the multiplayer lobby
- A Meta Quest headset on the same network (or the WebXR Emulator extension
  for desktop testing)

## Setup

```sh
npm ci
cp .env.example .env.local   # then fill in your Firebase web-app config
firebase deploy --only firestore:rules
node scripts/check-firebase.mjs   # smoke-tests auth + rules end-to-end
```

There are two Firebase projects and two env files (details in `.env.example`):

| | project | Hosting site | env file | commands |
|---|---|---|---|---|
| test / beta | `sportyxr-test` | `sportyxr-test.web.app` | `.env.local` | `npm run dev`, `build`, `deploy:test`, the smoke scripts |
| production | `sportyxr-tech` | `tt-sportyxr.web.app` → `tt.sportyxr.com` | `.env.prod.local` | `npm run dev:prod`, `build:prod`, `deploy:prod` |

Test is the default everywhere — bare `npm run build` / `firebase deploy`
never touch production; only the explicit `:prod` scripts (or
`--project prod`) do. `.env.prod.local` must repeat every key with its prod
value: Vite layers it over `.env.local`, so a key left out inherits the test
value into the prod bundle. `vite --mode prod` refuses to run if the file is
missing, and every build prints the project id it resolved.

Before the first rules deploy to a project, the **`tabletennis` named
database** must exist in it (Firestore → Add database); `firebase deploy
--only firestore:rules` fails otherwise.

## Develop

```sh
npm run dev
```

Vite serves over HTTPS (self-signed, required by WebXR) — open the LAN URL it
prints on the Quest browser and accept the certificate warning. For desktop
testing with the WebXR Emulator, set `DEV_HTTP=1` to serve plain HTTP:

```powershell
$env:DEV_HTTP="1"; npm run dev
```

Useful query params: `?selftest` (verbose console diagnostics),
`?tuner` (in-XR physics tuning panel), `?paddle=procedural` (procedural
paddle instead of the GLB).

## Test / lint

```sh
npm test       # ~1300 Jest tests: physics, AI, rules, XR calibration, UI, network
npm run lint   # ESLint (flat config, eslint.config.mjs)
```

## Build & deploy

```sh
npm run deploy:test    # build → dist/, deploy hosting + rules to sportyxr-test
npm run deploy:prod    # build:prod → dist/, deploy hosting + rules to sportyxr-tech
```

Or by hand: `npm run build[:prod]` then `firebase deploy --only hosting
--project test|prod` (hosting deploys go through the `app` target in
`.firebaserc`, which maps to the `sportyxr-test` / `tt-sportyxr` site). The
aliases live in `.firebaserc`; `default` is test on purpose. Firestore
security rules (`firestore.rules`) are the entire security boundary of
multiplayer — deploy them with `firebase deploy --only firestore:rules
--project <alias>` whenever they change, to BOTH projects.

Before the first prod build, `rm -rf dist .firebase` — an old `dist/` has the
previous project's config baked in and `.firebase/` caches the previous
hosting upload.

## App Check

The Firebase web config in the bundle is public by design; the rules decide
what a write may look like, but anonymous accounts are free to mint, so
without App Check one script can fill `sessions`, `feedback` and `signups` at
our billing rate. `js/network/appCheck.js` attaches a reCAPTCHA Enterprise
attestation to every Firestore request; **enforcement** — actually refusing
unattested requests — is a switch in the Firebase console, flipped last.

One-time setup, in this order — **per project**: keys, registrations and
debug tokens belong to a Firebase project, so `sportyxr-test` and
`sportyxr-tech` each need their own, going into `.env.local` and
`.env.prod.local` respectively.

1. **reCAPTCHA key.** GCP Console → Security → reCAPTCHA (enable the
   reCAPTCHA Enterprise API if prompted) → Create key → Web, **score-based**
   ("Use checkbox challenge" off). Domains: the Firebase Hosting domain(s)
   and `localhost` — for prod that is `tt.sportyxr.com`,
   `tt-sportyxr.web.app` and `tt-sportyxr.firebaseapp.com`. Copy the site key.
2. **Register it.** Firebase Console → App Check → Apps → the web app →
   reCAPTCHA Enterprise → paste the key, and set **Token TTL to 1 day** on
   the same form (default is 1 hour). One reCAPTCHA assessment is spent per
   token minted, not per request: a 1-hour TTL costs an open tab ~2 per
   hour, a 1-day TTL costs a session at most one, and a return visit that
   day none. The free tier is 10,000 assessments/month per organization.
3. **Debug token** for the dev server, the Quest and the smoke scripts (the
   dev origin is a LAN address reCAPTCHA cannot be registered for): same
   page → ⋮ Manage debug tokens → Add → any UUID.
4. `.env.local` (or `.env.prod.local`): `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY=`
   the site key, `APPCHECK_DEBUG_TOKEN=` the UUID. The token is not
   `VITE_`-prefixed on purpose — `vite.config.js` substitutes it only under
   the dev server (`npm run dev` / `dev:prod`), so a built bundle cannot
   contain it.
5. `npm run deploy:test` or `deploy:prod`. The CSP in `firebase.json` already
   allows the reCAPTCHA script, frame and endpoint.
6. **Wait.** App Check → Firestore shows verified vs unverified request
   counts. Once the deployed build is producing verified tokens and the
   unverified line is only old tabs, click **Enforce**. Enforcing first locks
   out every visitor still on the previous build.

A build with no site key logs a loud `[appCheck]` warning and runs unattested,
which works until enforcement is on and is permission-denied everywhere after.
The smoke scripts (`check-firebase.mjs`, `check-beta-collections.mjs`) use
the debug token the same way the dev server does; without it they run bare.
They read `.env.local` unless `ENV_FILE=.env.prod.local` is set.

## Project layout

```
index.html          Landing page + single Vite entry
js/
  main.js           Bootstrap; global error handlers
  physics/          Ball flight, spin, collisions, paddle model, tunable constants
  ai/               Opponent engines (beginner/intermediate/pro) + paddle solver,
                    run in a web worker (js/ai/worker.js)
  modes/            Game modes: training drills, machine play, AI match, multiplayer
  scene/            Three.js scene, models, in-XR menus/panels, audio
  xr/               Session, controllers, paddle calibration, drift detection
  network/          WebRTC + Firestore signaling (SignalingClient, NetworkManager),
                    Firebase init + App Check attestation
  lobby/            Room codes / LobbyManager over the signaling stack
  ui/               DOM overlay (lobby UI + post-session card on the landing page)
  analytics/        Beta session collector (one Firestore doc per session)
  data/             Feedback + early-access signup writes
tests/              Jest suites (jsdom; three.js mapped to its CJS build)
public/             Static assets copied verbatim into dist/
vr-assets/          Unreleased VR venue assets, parked for beta — see its README
server/             Dev-only telemetry receiver (not deployed)
scripts/            check-firebase.mjs smoke test, query-sessions.mjs read-out,
                    asset analysis
firestore.rules     Lobby + beta-instrumentation security rules (unit tests in
                    tests-rules/)
```

## Beta instrumentation

The beta goes out on a public link, so the players who hit something broken are
the ones who will never tell us about it. Three write-only Firestore
collections cover that, all behind the existing anonymous-auth gate:

```
sessions/{uid}/runs/{runId}   one doc per play session: funnel milestones,
                              match stats, WebRTC health, JS errors
feedback/{uid}/items/{id}     rating + optional note
signups/{uid}                 early-access email, one row per account
```

All three live in the **`tabletennis`** named database, not `(default)` —
`js/network/firebaseClient.js` sets `DATABASE_ID` and `firebase.json` must
agree, or `firebase deploy --only firestore:rules` sends the rules to a
database nothing reads and every write comes back permission-denied.

None of them is readable from the client — `allow read: if false`, deliberately,
so a player's feedback and email are not fetchable by anyone who can open the
app. There are exactly two ways to read the data back: the Firebase console,
and `scripts/query-sessions.mjs` (Admin SDK; needs a service-account key).

```sh
node scripts/check-beta-collections.mjs      # verify the DEPLOYED rules accept/refuse correctly
node scripts/query-sessions.mjs              # funnel, failed joins, errors, feedback
node scripts/query-sessions.mjs --emails     # the early-access list as CSV
```

Run `check-beta-collections.mjs` after any `firebase deploy --only
firestore:rules`. The emulator suite proves the rules FILE is right; this
proves what is actually deployed is, against the real project, with anonymous
auth really enabled. It also asserts the negatives — if a client can read back
its own feedback or signup row, the deployed rules are older than this repo and
the beta is collecting email addresses anyone can fetch. It leaves tagged rows
behind (the rules deny delete), so run it only against the test project
(the default). For prod, `ENV_FILE=.env.prod.local node
scripts/check-firebase.mjs` is the smoke test — it cleans up after itself.
`query-sessions.mjs` reads whichever project the service-account key in
`GOOGLE_APPLICATION_CREDENTIALS` belongs to.

Web analytics is separate and deliberately thin: a Google Tag Manager
container, bootstrapped from `js/analytics/gtm.js` and configured with
`VITE_GTM_CONTAINER_ID`. It is a module rather than GTM's copy-paste snippet
because that snippet is an inline `<script>` and `firebase.json` ships
`script-src` with no `'unsafe-inline'` — pasted in, the browser would block the
bootstrap, `gtm.js` would never load, and the page would look completely fine
while collecting nothing. **GTM Custom HTML tags are blocked by that same
CSP**; tags GTM loads from googletagmanager.com (GA4 config and most
Google-built tags) work.

Consent Mode v2 defaults are pushed before the container is requested — order
is the whole guarantee, since a default arriving after GTM boots is ignored and
a cookie has already been written by then. Ad signals are denied everywhere;
analytics storage is denied across the EEA, UK and Switzerland until an opt-in.
There is no banner yet, so `grantConsent()` has no caller — until one exists,
EEA visitors are counted cookielessly rather than not at all.

Points worth knowing before changing any of it:

- **The session doc is written twice** — created at XR session start, updated
  once at end. A headset coming off kills the tab, so an end-only write loses
  exactly the sessions that ended badly.
- **A failed multiplayer join gets its own doc** (`xrMode: 'lobby-*'`). The
  lobby negotiates before XR entry, so those never reach the normal path, and
  they carry the `connectTrace` phase breakdown — the only way to see which
  round trip stalled on a stranger's network.
- **`connectTrace` now collects unconditionally**; `?trace` gates only the
  console output. Nobody adds a query param before hitting a bug.
- **There is no sign-in.** An earlier cut linked the anonymous account with
  `linkWithPopup`, which preserved the uid but pulled in an auth-handler
  iframe, a third-party-cookie dependency on `authDomain`, a CSP `frame-src`,
  and a merge path — a lot of failure modes in front of "tell me when it
  launches", none of them ever proven in the Quest browser. A typed address
  needs none of it. The row is still keyed by the anonymous uid, so it still
  joins to that player's sessions and feedback.
- **Stack traces need the local sourcemaps.** `vite build` emits them
  (`sourcemap: 'hidden'`) but `firebase.json` keeps `**/*.map` out of the
  deploy — symbolicate against your own `dist/` for the `appVersion` the
  session doc reports.

Setup this depends on: the production project `sportyxr-tech` (public at
`tt.sportyxr.com`), the `tabletennis` database existing in it with these rules
deployed, Anonymous sign-in enabled, and a Firestore TTL policy on `sessions`
(`endedAt`) — TTL policies, indexes and App Check registration are per project
and do not carry over from `sportyxr-test`.

## Beta scope

The beta ships mixed-reality passthrough only. The VR venue modes (arena,
stadium, crowd audio) are compiled out and their assets parked under
`vr-assets/` — `vr-assets/README.md` documents exactly how to restore them.
