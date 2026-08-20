# P15 Training — Migration Plan

How the existing training mode becomes the P15 spec without carrying dead code.
Companion to `tt-training-spec.md` (P15). Read that first; this document only
records **decisions, dispositions, and sequencing**, not the feature spec.

Status: Phase 0 slices 1, 2, 3 and 6 landed. **M1 Ball Machine is wired and
reachable in-headset** via the wrist menu's six Quick Feed entries, and M8's
feeder toggle works. Slices 4 (event log) and 5 (panel toolkit) remain.

Test count: 608 across 38 suites (baseline before this work: 449 / 33).
`vite build` clean at 148 modules.

**Not yet verified in a headset.** Tests and build pass; no one has watched
the ball machine actually feed. The scene-touching paths (ball spawn, audio
cue, server figure) have no headless coverage by construction.

---

## 1. Verdict

P15 supersedes the *content* of today's training mode. It does **not** supersede
the primitives underneath it — roughly a third of the existing training code is
worth keeping and the rest is subsumed.

Scale, stated honestly so it isn't rediscovered mid-build: today's training is
~1,400 lines across 5 flat drills. P15 is 9 top-level modes with ~30 submodes
plus persistence, analytics, curriculum and deep-links. This is a program to be
staged, not a refactor to be landed.

The spec's own build order (M1+M8 → M7 → M2 → M4 → M3/M6 → M5/M9) is sound, but
it presumes infrastructure that does not exist. **Phase 0 below is a
prerequisite, not a nicety** — three of P15's TEST clauses are unwritable
without it.

## 2. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | **P11 assist is out of scope.** M10's `assist level` setting is dropped until a P11 spec exists. | No assist/forgiveness system exists anywhere in the codebase. Inventing one would silently change how every mode — including AI matches — feels. |
| D2 | **No backend for v1.** M5 Daily Drill and the M10 representativeness guard run client-local against the local event log. | Firebase and a telemetry server exist but no per-player logs are uploaded. A server dependency on the critical path of a training mode buys little and costs an availability story. Revisit once the local log format has settled. |
| D3 | **Predictive physics is shared, control flow is not.** One module owns the integration; each caller keeps its own loop. | Folding four rollout loops into one configurable `rollout()` needs stop-condition callbacks and a union result shape — worse than four short explicit loops over shared steps. |
| D4 | **Training logic modules import nothing from `js/scene/`.** Geometry arrives via an injected `env`. | This is why there is not one training test today: `feeder.js` imports `sceneSetup`/`models` at module scope. `serveBallistics.js` was already split out of `launchKinematics.js` for exactly this reason — D4 generalises the precedent. |
| D5 | **`xr/contactLog.js` is not the analytics log.** M7 gets its own sink. | contactLog clears on any calibration change (correct for drift detection, destructive for a session history) and holds 40 entries. Overloading it would break C8. |

## 3. Spec issues to resolve before the modes they affect

1. ~~**M1 spin range is ~5× beyond the engine.**~~ **RESOLVED — clamped.**
   M1 offers `spinMagnitude` 0–900 rad/s (default 150). The AI code works in
   REVOLUTIONS PER SECOND, not rad/s: `shotTypeSelector` records the solver
   losing backspin past ~−25 rps and topping out near +26 rps, i.e. ≈±160
   rad/s — the spec's range is ~5.6× beyond what the physics can honour.
   `drillConfig.js` now clamps to `SPIN_MAX_RAD_S = 160`, the single source of
   truth for that ceiling; raising it later is a one-line change gated by the
   M1 landing test. The spec's default of 150 sits just inside it, so default
   feeds are unaffected.
   *This still cuts in P15's favour:* the AI hits 15–30 rps while today's
   training feeds 2–6 rps, so current drills are unrepresentative of match
   play — exactly what M10's representativeness guard exists to catch, live
   today.
2. **M3 Legality Coach's "palm-open start" needs hand tracking**, which is an
   *optional* feature at session request (`inGame.js`). On controllers that
   check cannot run, so the strict-ITTF verdict must degrade explicitly rather
   than claim a pass it did not evaluate.
3. **M11 bit-for-bit parity constrains the architecture more than it appears.**
   It requires seeded RNG *and* a fixed-timestep path — the render loop runs on
   `clock.getDelta()`, so nothing is frame-reproducible today — *and* a log
   format with no wall-clock timestamps in the compared surface.

## 4. Disposition of existing code

Nothing on this list is deleted before its replacement is in place; each phase
removes its predecessor in the same commit rather than leaving both paths live.

| File | Disposition |
|---|---|
| `training/serveBallistics.js` | **Keep as-is.** Pure, scene-free, already the model for D4. |
| `training/launchKinematics.js` | **Keep.** Spawn/landing helpers stay; they gain the zone-grid placement from M1. |
| `training/trajectoryPreview.js` | **Renderer keeps, integrator ported** (done — slice 1). Becomes the basis of M4 Trajectory X-Ray. |
| `training/targets.js` | **Keep the class, replace the layout.** 3 hardcoded corners → data-driven 3×3 grid + free point + radius, needed by M1/M2/M3/M5. |
| `training/feeder.js` | **Split — done.** `FeedEngine` → `training/feedEngine.js` (scene-free, forward-verified). `ServerFigure` → `training/serverFigure.js` (scene-only, animation + contact callback). `feeder.js` dropped 423 → ~200 lines and keeps only scheduling and shot planning. Its public API is unchanged, so the four remaining legacy drills are unaffected. It stays live for those four; M1 no longer uses it. |
| `training/drills/ballMachine.js` | **Deleted.** Replaced by `drills/m1BallMachine.js` in the same change, per rule 3. |
| `training/difficulty.js` | **Demote to presets.** The three `id`s must survive — they key `ENGINE_FACTORIES` in `ai/worker.js`. The pacing/spin fields move under M10's curriculum tuner. |
| `training/stats.js` | **Delete** once M7's event log lands. Its "no persistence, no localStorage" premise is what M7 inverts. |
| `training/drills/*.js` (5) | **All 5 survive as configs, none as files.** ballMachine→M1 Quick Feed preset; targetPractice→M2 strictness; spinReader→M4 Spin Call; reactionRally→M5 Score Attack (its ramp is superseded by M10); trajectoryPractice→M4 X-Ray. |
| `scene/statsHud.js` | **Keep the live line** (M7 mandates a minimal in-drill HUD — this already is one). **Replace the summary** with a world-space panel: the DOM overlay path is weaker in `immersive-vr` and M11 requires parity. |
| `scene/wristMenu.js` | **Rebuild on the panel toolkit.** A flat 5-item picker cannot express M0's 9-branch tree or M1's 12 ranged attributes. |

## 5. Phase 0 — prerequisites

**Slice 1 — one predictive physics. ✅ Done.**
`js/physics/rollout.js` now owns the flight integration and table-bounce
response; `shotAdapter`, `paddleSolver`, `trajectoryPreview` and
`aiMatch/serve.js` all call it.

There were **four** copies, not the three visible on inspection — the fourth
(serve.js's net-clearance guard) was found by the source-level guard test, not
by reading. All four had drifted from `tickPhysics`:

- **all four omitted `BUOYANCY_ACCEL`** — a systematic bias leaving every
  predicted landing low by >1.5 cm at typical feed flight time, which alone
  exceeds M1's 2 cm placement tolerance;
- **the two that model the post-bounce arc omitted `TABLE_SIDESPIN_KICK`** —
  up to ~1 m/s of missing lateral velocity on a sidespin bounce, i.e. wrong
  exactly where M4's Spin Call and M1's side-L/side-R feeds live.

So this was never only deduplication: M1's forward-verified feeds and M4's
"render = physics, no separate approximation" clause were both unbuildable
until it was fixed. `tests/rollout.test.js` pins the two recovered terms and
carries a source guard that fails if any module outside `physics/` integrates
Magnus itself.

**Slice 2 — seeded RNG. ✅ Done.** `js/util/rng.js` — mulberry32 (matching the
generator `tests/imperfection.test.js` already hand-rolled, so its pinned
sequences stay valid), `hashSeed` for text seeds, `deriveStream` for
per-subsystem independence, and gaussian/shuffle helpers. Consumers take
`rng` as a first argument rather than closing over module state, matching the
convention `imperfection.js` already used.

Named streams matter more than they look: two subsystems drawing from one
generator are order-coupled, so adding a single draw to the feeder would shift
every later miss-injection decision and silently invalidate a replay.

Still outstanding from this slice: the fixed-timestep path for headless runs,
and threading the generator into the ~20 files that still call `Math.random()`
directly. Only the training path is seeded so far.

**Slice 3 — profile store. ✅ Done.** `js/profile/store.js`. Modelled on
`xr/calibration.js`'s persist/subscribe/failure shape, with two departures:

- **Migration instead of discard.** calibration.js drops persisted state on a
  version mismatch, which is right for a transform the wizard re-fits in 20
  seconds and wrong for saved presets and history. Unknown versions migrate
  forward; a FUTURE-version blob is left byte-intact on disk and the session
  runs on defaults, because stripping fields we don't recognise would destroy
  data belonging to a build the player may still be using.
- **Visible quota failures.** A dropped calibration write is invisible and
  recoverable; a dropped preset save reads as data loss, so it surfaces via
  `lastWriteError()`.

A test caught a real bug here: an explicit `dominantHand` choice didn't mark
the hand resolved, so the next swing's auto-detection overwrote what the
player had just set.

**Slice 4 — event log. ⬜ Not started** — belongs to M7; nothing in M1 needs
it. Append-only structured events (feed, contact, bounce,
outcome) with derived-stat selectors. Powers M7, M10 and the M2 ladders.
Separate sink from `contactLog` (D5).

**Slice 5 — panel toolkit. ⬜ Not started** — the largest remaining risk to
working gameplay, since it refactors five live UI surfaces. Nothing from this
session is reachable in-headset until it (or a smaller stand-in) lands.
`wristMenu` (843), `calibrationWizard` (475),
`physicsTuner` (373), `calibrationTuner` (334) and `trajectoryControl` (322)
each hand-roll draw / `hitTestUV` / hover / press — ~2,350 lines of near
duplicate. Extract one canvas panel base with a widget set (segment, stepper,
slider, list, toggle) and a single poke/laser router, then port all five. P15
adds more UI than currently exists; without this it is another ~3k lines of
copy-paste.

**Slice 6 — config codec. ✅ Done.** `js/modes/training/drillConfig.js` —
versioned DrillConfig over M1's 12 attributes, positional-CSV URL codec behind
a version prefix, and `parseDeepLink`/`buildDeepLink`.

Two properties worth keeping when this is extended:
- **Canonical encoding.** The ω components are zeroed unless `spinType` is
  `combo`, so two configs that FEED identically also ENCODE identically. M5's
  "seed the daily drill from its config string" depends on that.
- **Decode never returns null.** A truncated or future-version link yields a
  usable config for the fields it could read. Half a link should still start a
  drill; dropping the player into nothing is the worse failure.

Field ORDER is frozen per version — a new field means `CONFIG_VERSION + 1` and
a new decoder branch, never an insertion into the v1 order.


## 5b. M1 FeedEngine — what building it established

`js/modes/training/feedEngine.js` is the scene-free half of the old feeder:
DrillConfig → commanded outcome → forward verification → spawn parameters.
`ServerFigure` (the windup→swing→recover animation) has NOT been split out
yet; `feeder.js` is still live and untouched.

**Placement accuracy achieved: 0.0–0.4 mm** against M1's 2 cm budget, across
all nine zones, every spin type at the full ±160 rad/s envelope, and all
depth × origin combinations. Six 500-feed presets plus a χ² scatter fit pass.

**Aiming needs Newton, not error-shifting.** The obvious loop — aim at the
target, see where it lands, shift the aim against the error — assumes the
landing responds to the aim one-for-one. Under heavy sidespin it does not:
moving the aim also changes how long Magnus acts along the new heading, so the
response gain is ~1.5. Correcting by the full error overshoots and oscillates
(measured: −1.16 m → −0.22 m → +0.56 m …), needing 8+ passes to reach
centimetres. A 2-D Newton on (elevation, azimuth) with a numerical Jacobian
converges in ~3 and costs fewer rollouts overall.

**Interpolate the surface crossing.** Reporting the landing at whichever
discrete step first dips below the table quantises it by a full step — ~4.5 cm
at 15 m/s, twice M1's entire budget. An aiming search over a quantised
objective cannot converge below the step size however long it iterates; this
was the ~21 mm error floor. `rolloutToSurfacePlane` interpolates.
(`rolloutToFirstBounce` deliberately does NOT — the AI paths depend on its
current semantics and were left alone.)

**Arc cannot be an independent constraint.** Given a launch point, a commanded
speed and a commanded landing point, exactly two trajectories exist. Their net
clearances are therefore already determined, so arc SELECTS between them:
flat takes the lower, lob the upper, and only medium picks by proximity to its
nominal clearance. Nearest-match matching reads plausibly and is wrong — the
lofted branch clears by ~1.7 m against lob's nominal 0.5 m while the flat
branch clears by ~0.16 m, so "closest" hands lob the FLAT trajectory and lob
and flat emit identical feeds.

**Some feeds are physically impossible, and the engine says so.** This
constrains which presets can ship, and M2's pattern drills will hit the same
wall:
- 5 m/s cannot cross 2.9 m of table — vacuum max range at 45° is v²/g = 2.55 m.
- Nothing lands 23 cm past a 15.25 cm net at 15 m/s.
- Short placements need the FAR origin; from the near origin at 8 m/s the
  flattest arc reaching the point crosses below the cord.
- Muzzle height was raised 0.25 m → 0.38 m. At 0.25 m short feeds clipped the
  net by 4 mm and were unmakeable at any angle.

The contract is therefore **"succeed accurately, or report infeasible"** — not
"always succeed". `feasible` is judged on the FINAL verified trajectory, never
the seed: judging the seed produced feeds marked feasible whose measured net
clearance was −4 mm, a net ball the engine called good. Curated presets are
held to 100% feasibility; if one fails, the preset is wrong, not the solver.

## 5c. M1/M8 wiring — how it reaches the player

`drills/m1BallMachine.js` pairs FeedEngine with ServerFigure and spawns the
ball on the figure's contact callback, so what leaves the paddle IS the
verified shot. `presets.js` holds M1's six Quick Feed presets.

**The drill picker is an arrow cycler, not a fixed list.** It shows one entry
at a time, so list length costs nothing on screen — which is why all six
presets could ship as their own menu entries without waiting for Slice 5's
nested menus. The six share `id: 'ballMachine'` (the stable factory key, also
the tile icon) and differ by a `preset` field.

**`animationLeadSec`.** The ball launches windup+swing (0.36 s) after the
engine emits a feed, so that lead is subtracted from the next interval.
Without it every feed runs late by the animation length and the user-facing
`interval` quietly means something other than what it says. The legacy feeder
did the same subtraction inline.

**M8's feeder is the M1 drill with `burstCount: INFINITE` and no stats sink** —
a config over a shared primitive, not a second feed implementation (rule 1).
Bound to B/Y (gamepad button 5), scoped to `state === 'freePlay'` so it cannot
fire inside a drill that owns its own schedule. Torn down from
`teardownDrill()`, which is the universal exit path — it owns a ServerFigure
in the scene, so leaking it would leave a second paddle floating.

Still missing from M8: the dispenser/grab interaction and C4 bounce-mode
reachability. Free Play's manual trigger-serve is unchanged.

## 6. Anti-dead-code rules

1. Every mode is a **config over shared primitives**. No per-mode file that
   holds only a settings object.
2. A primitive is extracted **at its second caller**, not in anticipation of one.
3. Each phase **deletes its predecessor in the same commit**. Two live paths for
   the same behaviour is the failure mode this plan exists to avoid.
4. Every mode ships with **the TEST clause P15 already specifies for it**. A
   mode whose test clause is unwritable is a mode whose prerequisites are not
   done.
5. Guard tests over conventions: where a rule matters (one physics, one panel
   base), assert it in CI rather than documenting it and hoping.
