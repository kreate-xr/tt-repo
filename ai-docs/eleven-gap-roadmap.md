# SportyXR roadmap: fix what Eleven players hate, beat what they love

Status: DRAFT 2026-11-13, for approval. Nothing here is built unless marked ✅.
Evidence: 5,433 Meta Store reviews of Eleven Table Tennis (2020-2026), each labelled
for topic, sentiment and intent, plus a hand-read pass over 507 training-related
reviews. Counts are reviews mentioning the topic **negatively** unless stated.
Training counts are approximate.

## The core lesson

Eleven's average rating fell from 4.71 (2021-22) to 3.85 (2026). Negative reviews went from
4% to 24%. The drops followed **big updates that broke things** (April 2023 overhaul,
2025 physics change) and **bugs left unfixed for years**. Missing features hurt much less.
So the first rule of "a version people love" is: **small, headset-validated releases.
Never ship a feel change untested.**

## 1. Fixing Eleven's problems

| # | Eleven problem | Neg. reviews | SportyXR today | What we do |
|---|---|---|---|---|
| 1 | Bugs: ball not appearing, wrong points, freezes | 361 | 1,700+ automated tests, diagnostics round-trip | Headset validation before every release (checklist exists). Fix tester bugs before adding features. Web deploy means instant rollback. |
| 2 | Updates that broke the feel | 165 | Physics changes made in small steps (soften ladder) | Never bundle physics + UI + feature changes in one release. Headset sign-off on any feel change. |
| 3 | Confusing UI and menus | 271 | Wrist menu, one-tap Training Session | Readability and clarity pass in the headset test. Keep "nothing to configure" as the default. |
| 4 | Not enough content (venues, modes, single-player) | 281 | MR, Focus Room, Arena; ✅ **Tournament mode** | Tournament built. More single-player depth in Phases 2-3. Music dropped by decision (2026-11-13). |
| 5 | Online lag, ghost balls | 184 | P2P WebRTC, friends' rooms only | Keep friends-first. Measure lag before any public play. |
| 6 | Unfair matchmaking (Elo gaps) | 179 | No public matchmaking | Don't build public ranked play yet (see "Later / avoid"). |
| 7 | Fast swings pass through the paddle | 148 | ⏳ Capture built, headset test pending | Fix based on the data. Suspects: tracking-loss contact suppression, smoothed-paddle lag. |
| 8 | Unrealistic spin serves, exploits | 123 | ITTF toss and serve faults, Foul Rules toggle, fault reason card | Keep rules on in competitive modes. |
| 9 | Space / injuries (falling onto the virtual table) | 113 | Mixed Reality mode, spawn 0.6 m away, recenter | Validate in the headset. A lean warning is optional (new UI, ask first). |
| 10 | Toxicity, no mute or block | 92 | No voice chat, no strangers | Keep it that way until moderation is designed. |
| 11 | AI too perfect, plays no spin | 101 | 3 levels, 4 play styles, momentum easing | ✅ Styles shown in the Tournament. Show them in quick matches too (Phase 1). |
| 12 | Paid extras on top of the price | 62 (value) | One-time Full unlock, free tier | Promise: **no paid extras after you buy the full game.** |
| 13 | No guidance on how to improve | ~40 requests (top training ask) | Fault card (why a serve faulted) | **Coaching tips** (Phase 2). |

## 2. Beating what Eleven players love

| Loved in Eleven | Positive reviews | SportyXR today | How we go further |
|---|---|---|---|
| Realistic physics | 2,387 | ITTF realism passes | Protect it: headset sign-off on every feel change. |
| Skill transfer to real table tennis | 345 (4.93★ avg) | Scored Training Session (6 coach-style drills, adaptive) | Coaching tips plus "practise this ball". Market to club players. |
| Ball machine you can set up | ~75 (most-loved training feature) | Preset drills only; no custom feed | **Smart Ball Machine** (Phase 2). |
| Practice against the AI | ~45 | AI matches, Tournament | Show styles, offer rematches against the same style. |
| Exercise | 367 (never negative) | Not shown | Active time on the report card (Phase 1). Calories skipped: only 1 of 371 fitness reviews asked for a counter. |
| Mini-games (Quadrants target, beer pong) | ~45 | None | Later, maybe a target mode inside the Smart Ball Machine. |
| Mirror mode (see your own swing) | ~4, very strong | None | Later. |

## 3. Phases

### Phase 0: stabilise (now, blocks everything)
- Headset session together: `ai-docs/headset-validation-checklist.md`, incl. Tournament and the fast-swing test.
- Fix what it finds. Remove the temporary swing capture. Commit.

### Phase 1: quick wins on existing code (small)
- **AI style in quick matches:** "Opponent: CHOPPER" with the style's one-line tip (the text already exists in the tournament code).
- **Rally stats on the report card:** longest rally, rally count, plus active play time. Players asked for "max rally" and "rally count".

### Phase 2: signature features (medium)
- ✅ **Smart Ball Machine: v1 built 2026-11-13** (uncommitted, headset check pending). As built:
  PLAY → Ball Machine, 8 practices (forehand, backhand, push, loop, sidespin, two-point and
  three-point footwork, read the spin), "Random side" switch, thumbstick up/down = speed and
  left/right = tempo (placement comes from the practice or the Random switch), left-hand
  mirroring, every ball feasibility-tested. Free: the two drives. Code:
  `js/modes/training/practice.js`, `drills/practice.js`. Original design notes:
- **Smart Ball Machine** (in Free Play). It fixes each Eleven complaint about the ball machine:
  - Pick **what to practise** ("Backhand vs topspin", "Push short backspin", "Loop the backspin",
    "Footwork"…) instead of sliders, with 6-8 presets. The machine picks speed, spin and placement.
  - **Adjust live with the thumbsticks** while balls come (speed, placement), like Paddle Quick Fit.
  - **Random** switch: mixed placement and/or spin.
  - **Automatic left-hand mirroring.** "Backhand" means your backhand (resolveWing exists).
  - Every preset tested to clear the net and land, like the existing feed tests.
  - Later: save favourites.
- **Coaching tips:** one short tip tied to what the player just did, e.g. the ball went long after
  topspin → "close the bat face against topspin". It extends the existing fault card and Training
  Session cues. Wording reviewed with a real coach if possible.

### Phase 3: things nobody else has (medium-large)
- **"Practise this ball":** the report card offers to feed the ball you struggled with most, at the same
  speed, spin and placement, in the Smart Ball Machine. Hit balls are already recorded (speed, spin);
  missed balls need their path captured.
- **Friends:** one-tap rematch with your last partner, and winner-stays rooms with a waiting spectator.

### Later / avoid for now
- Public ranked matchmaking: the root of Eleven's Elo, lag and toxicity problems. Needs players and moderation first.
- Voice chat with strangers.
- Avatars and customization (popular but expensive to build and maintain).
- Doubles (only 34 requests, heavy networking).
- Music: dropped by decision.
- Calorie counter: low demand, needs body weight.

## 4. Positioning ("why players will love SportyXR")
1. **Real table tennis training**, not just a game: coach-style drills, coaching tips, practise your weak ball.
2. **Stable**: we don't break the feel with updates.
3. **Safe and friendly**: Mixed Reality, no strangers shouting at you.
4. **Fair price**: free forever to try, one-time unlock, no paid extras.

## Decisions needed
1. Approve the phase order (0 → 1 → 2 → 3).
2. Approve the new on-screen elements: Phase 1 (style label, rally stats) and Phase 2 (Smart Ball Machine
   menu, coaching tips). Each gets a short plan before code.
3. The "no paid extras" promise: is it OK to state it publicly?
