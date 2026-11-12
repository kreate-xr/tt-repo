# Headset validation checklist

Created 2026-11-12. One headset session covering everything still marked
"headset validation pending", plus the fast-swing tracking test. Tick each box,
note FAIL with a short description. Run on the TEST project (sportyxr-test).

Do this before starting new features. Eleven's two big rating drops both followed
updates that weren't validated.

## A. Entering the game and orientation
- [ ] From the website, enter **MR**, **Arena** and **Focus Room** in turn. The table is in front
      of you, NOT sideways (viewer alignment, 0d524e1).
- [ ] The table spawns about **0.6 m** away, so it's not too close to swing (346a877).
- [ ] **Hold the Meta button** to recenter. Does the world re-align? (If not, we agreed on an in-app
      recenter fallback. Note which.)

## B. Hands and paddle
- [ ] **Meta resume, wrong hand:** exit the boundary, press Meta, resume. Repeat ×5. The paddle stays on the
      correct hand every time. Then toggle R/L in Settings: it switches.
- [ ] **Virtual off-hand:** the serving hand is visible, palm faces the right way, resting curl looks natural.
- [ ] **Paddle Quick Fit:** on a fresh profile, the thumbsticks move the bat the expected way. Switch
      hands: each hand keeps its own fit.

## C. Physics feel
- [ ] First brushing stroke doesn't leave too hard.
- [ ] AI loops don't nose-dive after the bounce.
- [ ] Drop a ball from about 30 cm: it rebounds about 23 cm.
- [ ] Spin fights blocks believably (you have to close the bat against topspin).
- [ ] Elite AI still sustains rallies (it doesn't keep netting or overshooting).

## D. Rules and feedback
- [ ] **Fault reason card:** readable before the next serve (under 2.5 s), with reason + fix shown.
- [ ] **Foul Rules Off** in Settings: AI match ignores toss faults. In multiplayer the
      HOST's setting wins.

## E. Training Session
- [ ] Beginner level: runs start to finish, score shown at the end.
- [ ] Player level (Full): same.

## F. Multiplayer (two headsets, or headset + desktop)
- [ ] Finish a match, leave, press MULTI again. You get the **lobby**, not an empty
      match. Test as host AND as guest.
- [ ] A real dropout (turn Wi-Fi off briefly) still reconnects.

## G. Mixed Reality
- [ ] The Backdrop tile appears only in MR, and the setting persists after restarting.

## H. Performance
- [ ] Open with `?fps`. Arena stays at or above the refresh rate during long rallies.
- [ ] 20 minutes of play: no hitching or thermal slowdown.

## I. Fast-swing tracking test
Before this session I'll add a temporary `?selftest` capture (POST to the dev
server; removed afterwards) that logs paddle speed and near-misses per swing.

On the ball machine (Warmup feed), 20 of each:
- [ ] Slow drives (the control group)
- [ ] Fast forehand loops
- [ ] Smashes
- [ ] Backhand flicks

Note any ball that **passes through the paddle**. PASS = the fast-swing miss rate is close
to the slow-drive miss rate.

## Notes / results
(write here)
