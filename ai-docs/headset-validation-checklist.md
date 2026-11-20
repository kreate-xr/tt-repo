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

## I. Fast-swing tracking test — DONE 2026-11-19
Run on a Quest 3 with a temporary capture tool (since removed). 74 balls, 65 hit.

- [x] Slow drives (1–2.4 m/s): 16 of 16 hit.
- [x] Fast forehand loops: 26 of 29 hit (totals only; the per-ball records were lost in a
      Wi-Fi drop, and the count may include the first smashes).
- [x] Smashes (8.2–9.8 m/s): 12 of 12 hit.
- [x] Backhand flicks (4.4–7.3 m/s): 12 of 16 hit. The 4 misses crossed the bat plane just
      outside the hit zone (0.1, 0.4, 1.2 and 5.5 cm): edge misses, not tunnelling.

Result: no tracking-loss suppression, no frozen paddle, no dropped frames (longest 15 ms).
The drawn paddle trails the hand by about 0.7 cm on slow drives and 5 cm on smashes, with no
effect on hits. Open: backhand contacts sit 7–12 cm off the bat centre; cause not known.

## J. Tournament (new, 2026-11-12)
- [ ] The **CUP** tile on the wrist menu opens the Tournament menu. CLOSE and BACK work.
- [ ] Free version: Club Cup is open; National Open and World Masters show a padlock.
- [ ] Club Cup quarter-final: the scoreboard shows the opponent's name, not "AI".
- [ ] **Win** a round: the card says "QUARTER-FINAL WON!" and NEXT ROUND starts the semi-final.
- [ ] **Lose** a round: RETRY ROUND replays the same opponent; the bracket hasn't moved.
- [ ] TOURNAMENT on the card goes back to the bracket, with the won round ticked.
- [ ] **Win the final:** CHAMPION!, and (Full version) the National Open opens.
- [ ] Restart the game: progress is still there.
- [ ] National Open (Full): the quarter-final opponent plays like an attacker, the semi like a blocker,
      the final like a chopper (plays far back).
- [ ] The wrist menu's four tiles are readable, and none is hard to aim at.

## K. Ball Machine (new, 2026-11-13)
- [ ] PLAY → **Ball Machine** opens the list of 8 practices plus "Random side". The small
      text on the right of each row is readable.
- [ ] Free version: Forehand drive and Backhand drive start; the other six show a padlock.
- [ ] Start **Forehand drive**: a "GO" card appears over the net, balls come to your forehand
      and keep coming.
- [ ] **Thumbstick up / down**: a SPEED card shows ("Speed 4 of 8") and the next balls are
      faster / slower. Check that up means faster.
- [ ] **Thumbstick left / right**: a TEMPO card shows and the gap between balls changes.
      Check that right means quicker.
- [ ] One push = one step (holding the stick doesn't run through the whole range).
- [ ] **Trigger (paddle hand)**: the next ball comes at once, without waiting for the gap or
      for the last ball to stop. The GO card says so. Check you do NOT squeeze it by accident
      while swinging; if you do, tell me.
- [ ] **Random side** On, then any practice: balls go left, middle and right unpredictably.
- [ ] Left-handed (Settings → Dominant hand): "Backhand drive" comes to YOUR backhand.
- [ ] (Full) Push the backspin, Loop the backspin, Return sidespin, Read the spin: every ball
      clears the net and lands. Note any that feel wrong.
- [ ] (Full) **Build your own**: tap Spin, Side and Length to change each, then START. The ball
      matches what you chose (try Backspin · Forehand · Short, and Sidespin · Random · Long).
      Thumbstick speed and tempo still work.
- [ ] Sidespin: the ball curves one way, then the other, on alternate balls.
- [ ] **New machine look (2026-11-15):** the machine is now a two-wheel robot: white head with
      orange wheels, clear ball bucket behind, control box, column on a three-leg caster base.
      Check in Mixed Reality AND in Arena / Focus Room: it is clearly visible (not dark), the
      ball comes out of the round muzzle between the wheels, the wheels spin up before each
      ball, and the base stands on the floor (not floating, not sunk).
- [ ] The machine is in place behind the table from the first moment (it does not appear
      under the table and jump).
- [ ] Frame rate with the machine on screen feels the same as before.
- [ ] A/X opens the menu and you can leave.
- [ ] **In Arena / Focus Room (VR):** the Training Session's "X left" line and its end score
      card are web-page overlays, which the Quest shows in Mixed Reality only. Check whether
      you can see them in VR venues. If not, tell me: that is an older problem to fix.

## Notes / results
(write here)
