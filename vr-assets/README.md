# VR venue assets — parked for the beta launch

The beta ships MR (passthrough) only. These files are referenced exclusively
by the VR venue modules (`js/scene/arena.js`, `js/scene/crowdAudio.js`), which
are currently commented out of the build, so they were moved out of `public/`
to keep them off the deployed site — everything in `public/` is copied into
`dist/` verbatim at guessable URLs (e.g. `models/arena.glb`), which would leak
the unreleased venues.

## To restore the venues for the full release

1. Move these folders back: `vr-assets/models/*` → `public/models/`,
   `vr-assets/sounds/*` → `public/sounds/` (the runtime fetches them from
   `models/...` and `sounds/...`).
2. Re-enable the code — search the repo for `BETA LAUNCH`:
   - `js/ui/overlay.js` — venue picker (Room / Arena / TT Arena)
   - `js/modes/inGame.js` — `createArena` import, `isVR` pin, arena load block
   - `js/modes/aiMatch/aiMatch.js` — stadium module imports + mount block
3. Restore the arena copy on the landing page (`index.html` hero sub-text and
   the third feature card) — it was reworded, not commented, because HTML
   comments are visible in view-source. See git history on the `beta` branch.
