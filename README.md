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
  ui/               DOM overlay (lobby UI on the landing page)
tests/              Jest suites (jsdom; three.js mapped to its CJS build)
public/             Static assets copied verbatim into dist/
vr-assets/          Unreleased VR venue assets, parked for beta — see its README
server/             Dev-only telemetry receiver (not deployed)
scripts/            check-firebase.mjs smoke test, asset analysis
firestore.rules     Multiplayer lobby security rules (rules unit tests in tests-rules/)
```

## Beta scope

The beta ships mixed-reality passthrough only. The VR venue modes (arena,
stadium, crowd audio) are compiled out and their assets parked under
`vr-assets/` — `vr-assets/README.md` documents exactly how to restore them.
