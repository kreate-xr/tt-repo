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
npm run build                    # → dist/
firebase deploy --only hosting   # serves dist/ (see firebase.json)
```

The Firebase project alias lives in `.firebaserc`. Firestore security rules
(`firestore.rules`) are the entire security boundary of multiplayer — deploy
them with `firebase deploy --only firestore:rules` whenever they change.

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
  network/          WebRTC + Firestore signaling (SignalingClient, NetworkManager)
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
behind (the rules deny delete), so point it at the test project.

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

Setup this depends on: a production Firebase project (not `sportyxr-test`), the
`tabletennis` database existing in it with these rules deployed, and a
Firestore TTL policy on `sessions`.

## Beta scope

The beta ships mixed-reality passthrough only. The VR venue modes (arena,
stadium, crowd audio) are compiled out and their assets parked under
`vr-assets/` — `vr-assets/README.md` documents exactly how to restore them.
