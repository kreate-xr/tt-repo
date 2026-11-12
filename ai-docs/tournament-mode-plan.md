# Tournament Mode — plan (for approval, no code yet)

Status: DRAFT 2026-11-12 · Source: Meta-store review analysis of Eleven Table Tennis
(5,433 reviews). "Single-player tournament / career / campaign" was the #1 feature
request (~133 reviews), e.g. "beat better and better AIs in each tourney",
"different countries host different tournaments".

## Goal

Give single players a reason to keep coming back and a clear progression,
reusing the AI match as-is. No physics change, no server, works offline.

## Design

### Structure — three knockout tournaments, three rounds each

| Tournament | AI level | Quarter-final | Semi-final | Final |
|---|---|---|---|---|
| **Club Cup** | Club (`beginner`) | allround | allround | allround |
| **National Open** | International (`intermediate`) | attacker | blocker | chopper |
| **World Masters** | Elite (`pro`) | blocker | chopper | attacker |

- The styles are FIXED per round (not random) so the player learns to beat each
  archetype: that is the training value real players asked for.
- Match length: quarter and semi best of 3, final best of 5 (free tier: single game,
  see Tiers).
- Winning a tournament unlocks the next one. Any unlocked tournament can be replayed.
- Each opponent is a fictional player with a name and a country (e.g. "K. Varga, HUN").
  No real players' names.
- Before each match an intro card shows: round, opponent name, style and a single line
  saying how that style plays ("Plays far back. Heavy backspin. Be patient, then attack the
  float.").
- After the match the report card buttons become: **NEXT ROUND** (won) or **RETRY ROUND**
  (lost), plus EXIT. Winning the final shows a trophy card.

### Tiers (fits js/account/tier.js)

- FREE: Club Cup in full (Club AI and single games are already free). It is the
  free player's taste of progression, and the upsell point is "National Open is in the
  full game".
- FULL: all three, with best of 3/5.

### Persistence

- New localStorage key `sportyxr.tour` (same idiom as js/profile/progress.js):
  `{ v:1, unlocked:['club'], current:{ tour, round }, trophies:{ club:1 } }`.
- Every tournament match is also recorded through the existing `recordAiMatch`, so the
  start page progress trends still include it.

## Code changes

1. **New `js/modes/tour/tourModel.js`** holds pure logic: the bracket definitions,
   next/retry/unlock state machine, persistence and tier gating. No THREE/DOM, unit tested.
2. **`js/modes/aiMatch/aiMatch.js`** gets small, backwards-compatible options:
   - `style` overrides `pickStyleForMatch` (aiMatch.js:265). Default stays random.
   - `opponentName` is passed to the scoreboard and report (the report already takes
     `opponentName`).
   - `reportButtons` / an `onMatchEnd` hook so the tournament can offer NEXT ROUND / RETRY.
3. **`js/modes/inGame.js`** routes a `tour` start, and the restart hook advances
   or retries the round.
4. **Intro card and trophy card** built from the existing panelKit / matchReport layout.
5. **Wrist menu entry point** (see open question 1).
6. Optional: trophies shown in the start page's "Your progress" panel.

Tests: tourModel (bracket, unlock, retry, tier gating, corrupt storage),
aiMatch style override, menu model. Then a headset check.

Not touched: physics, AI engines and tuning, multiplayer, payments.

## Decisions (2026-11-12)

- Entry point: a **4th dock tile**, labelled TOURNAMENT (or a short form if it doesn't fit).
- On a loss: **retry the same round**.
- Free tier: **Club Cup is free**; National Open and World Masters are Full.
- Name: **Tournament**.
- Club Cup variety: default accepted (allround only, opponents differ by name) unless changed.

## Open questions (original, answered above)

1. **Entry point:** (a) a 4th dock tile "TOUR" beside PLAY / AI / MULTI, or
   (b) a QUICK MATCH | TOURNAMENT switch inside the AI mode. *Recommendation: (a), it's discoverable.*
2. **On a loss:** (a) retry the same round, or (b) start the tournament again from the
   quarter-final (real knockout). *Recommendation: (a). Eleven reviewers complained about an
   "impossible 4th opponent" that blocked progress.*
3. **Free tier:** is Club Cup free? *Recommendation: yes.*
4. **Name:** "Tournament", "Tour", "Championship" or "Career"?
5. **Club Cup variety:** Club AI is always allround by design (playerStyles.js), so the
   three Club Cup opponents differ only by name. Accept that, or allow a mild style at
   Club level for the tournament only? *Recommendation: accept it for v1. It doesn't
   touch AI tuning.*
