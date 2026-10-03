// M1 Ball Machine — the P15 mode.
//
// Pairs the two halves the old feeder used to conflate:
//   FeedEngine        (feedEngine.js)        — scene-free. Solves a commanded
//                                              landing point and forward-verifies
//                                              it through the shared integrator.
//   BallMachineFigure (ballMachineFigure.js) — scene-only. Plays the wheel
//                                              spin-up → release animation and
//                                              calls back at the launch frame.
//
// The ball spawns on that launch callback, using the velocity and spin the
// engine solved, so what the player sees leave the machine is the shot that
// was verified — not an approximation of it.
//
// HUD: P15 §M7 mandates a minimal in-drill HUD ("success tick + streak only").
// The analysis belongs in Review & Stats, not over the table, so liveLine()
// stays to one short line and no real-time coaching cue is shown.

import {
  tableBox, tableSurfaceY, ballRadius, netBox, ballModel,
} from '../../../scene/models.js';
import { spawnBallAt } from '../../../physics/ball.js';
import { playMenuHoverTick } from '../../../scene/audio.js';
import { FeedEngine } from '../feedEngine.js';
import { BallMachineFigure, LAUNCH_LEAD_SEC, computeContactPose } from '../ballMachineFigure.js';
import { validateConfig, INFINITE } from '../drillConfig.js';
import { WARMUP_FEED } from '../presets.js';
import { rolloutToSurfacePlane, DT_PRESETS } from '../../../physics/rollout.js';
import { mulberry32 } from '../../../util/rng.js';
import { EventLog, OUTCOMES } from '../../../profile/eventLog.js';

export const M1_BALL_MACHINE = {
  id: 'm1BallMachine',
  label: 'Ball Machine',
};

// LAUNCH_LEAD_SEC comes from the machine itself: the ball leaves at the end
// of the wheel spin-up, and FeedEngine subtracts exactly that from the next
// interval. Importing it rather than re-deriving it here means the rhythm
// can't drift if the animation's timing changes.

/**
 * Build the geometry bundle FeedEngine needs. This is the injection point
 * that keeps feedEngine.js out of the scene module graph (migration-plan D4):
 * the drill reads js/scene/models.js, the engine never does.
 */
export function buildEnv() {
  return { ballRadius, tableSurfaceY, tableBox, netBox };
}

export function createM1BallMachineDrill({
  ballEvents, config, seed,
  // Per-ball verdict, fired once the drill has decided whether a ball was
  // returned or missed. Callers build on this rather than inferring verdicts
  // from getSnapshot(): a ball in flight is counted as fed but not yet
  // returned, so any difference of counters reads as a phantom miss for
  // exactly as long as the ball is airborne.
  onOutcome = null,
  // A caller that decides every ball itself (the Training Session: sets,
  // adaptive pace) supplies FeedEngine's per-ball config directly. Called
  // exactly once per feed with the ball's index; without one the machine
  // repeats `config`.
  configProvider = null,
} = {}) {
  const env = buildEnv();
  const cfg = validateConfig(config || WARMUP_FEED);

  // Seeded by default so a session is reproducible (M5/M6/M11 all depend on
  // the feed stream being replayable). A caller may pass an explicit seed to
  // reproduce a specific session.
  const rng = mulberry32(seed == null ? 0x5eed : seed);

  const figure = new BallMachineFigure();
  const engine = new FeedEngine(cfg, env, { rng, animationLeadSec: LAUNCH_LEAD_SEC });
  if (configProvider) engine.setConfigProvider(configProvider);

  // M7's analytics sink. Separate from xr/contactLog.js, which clears on any
  // calibration change (migration-plan D5).
  const log = new EventLog({ drillId: M1_BALL_MACHINE.id });

  let currentBallReturned = false;
  // Whether the current ball was TOUCHED without producing a good return.
  // MISS is "never touched it", ERROR is "touched it and put it wrong" — the
  // distinction eventLog's OUTCOMES already draws.
  let currentBallTouched = false;
  let fed = 0;
  let returned = 0;
  let streak = 0;
  let bestStreak = 0;
  let lastFeed = null;
  let infeasibleCount = 0;
  let skipped = 0;
  let clampedCount = 0;
  // Whether the most recent feed actually put a ball in play. Guards the
  // miss accounting against skipped feeds.
  let lastLaunched = false;
  // Whether a launched ball is CURRENTLY live. Verdicts are only handed out
  // while this is true: a paddle wave before the first feed, or after the
  // ball has already died, must not credit a return of a ball that does not
  // exist — that was quietly possible before and inflated the return rate.
  let ballInPlay = false;

  // A host callback must never take the drill down with it: these fire from
  // inside the physics tick's paddle-hit emit, where a throw would abort the
  // rest of the frame's collision handling.
  const emitOutcome = (payload) => {
    if (!onOutcome) return;
    try { onOutcome(payload); } catch (e) { console.error('onOutcome threw:', e); }
  };

  // The zone/spin a verdict is attributed to is the one that was FED, so it
  // has to be read off the feed the player was actually facing.
  const recordMiss = () => {
    streak = 0;
    const verdict = currentBallTouched ? OUTCOMES.ERROR : OUTCOMES.MISS;
    log.recordOutcome(verdict, {
      zone: lastFeed && lastFeed.config.placement ? lastFeed.config.placement.zone ?? null : null,
      spin: lastFeed ? lastFeed.config.spinType : null,
    });
    emitOutcome({
      ball: lastFeed ? lastFeed.index - 1 : null,
      result: currentBallTouched ? 'error' : 'miss',
      zone: lastFeed && lastFeed.config.placement ? lastFeed.config.placement.zone ?? null : null,
      spin: lastFeed ? lastFeed.config.spinType : null,
      streak: 0,
    });
  };

  engine.onFeed((feed) => {
    // Count the PREVIOUS ball as a miss only if one was actually LAUNCHED
    // and is still UNRESOLVED. A skipped (infeasible) feed puts no ball in
    // play, so charging the player a miss for it would invent failures they
    // never had; and a ball that already resolved via ballLost must not be
    // charged a second time here.
    if (lastLaunched && ballInPlay && !currentBallReturned) recordMiss();
    ballInPlay = false;   // previous ball is resolved; a launch below re-arms

    fed++;
    lastFeed = feed;
    if (!feed.feasible) infeasibleCount++;
    if (feed.reachClamped) clampedCount++;
    log.recordFeed(feed, fed);

    // Never launch a shot the solver's own forward verification says cannot
    // work: an infeasible feed pitches on the MACHINE's half and never
    // crosses the net, which reads as the machine being broken rather than as
    // the settings being impossible. The reach clamp in solveFeed resolves
    // nearly all of these; what survives is a speed too low to clear the net
    // at all, where there is no shot to make.
    if (!feed.feasible) {
      skipped++;
      lastLaunched = false;
      return;
    }

    currentBallReturned = false;
    currentBallTouched = false;
    lastLaunched = true;
    ballInPlay = true;

    // Pre-feed tick as a timing aid (M1's audio-cue attribute). Fired at the
    // engine's feed moment rather than at launch, so it lands one spin-up
    // BEFORE the ball leaves the barrel — useful for timing rather than a
    // report of something that already happened.
    if (cfg.audioCue) {
      try { playMenuHoverTick(); } catch (e) { /* audio unavailable — not fatal */ }
    }

    // computeContactPose resolves a spawn point and launch velocity into a
    // position + facing, which is what the machine needs to aim its barrel.
    // The full launch velocity is passed too, so the barrel's ELEVATION
    // matches the real shot — a lob visibly points upward.
    const contactPose = computeContactPose(feed.spawn, feed.velocity);
    figure.beginSwing(contactPose, () => {
      spawnBallAt(contactPose.position, feed.velocity, feed.spin);
    }, feed.velocity);
  });

  // Judge a return's QUALITY at contact time by rolling the outgoing ball
  // forward through the shared integrator — the same trust argument the feed
  // itself rests on: prediction and live flight cannot drift. A good return
  // clears the net and lands on the MACHINE's half; a touch that puts the
  // ball into the net, off the end, or back onto the player's own half is
  // not credited, and the existing loss accounting then charges it (as an
  // ERROR, since it was touched) when the ball dies or the next feed fires.
  //
  // A hit with no outgoing state falls back to crediting the touch — that is
  // the pre-quality behaviour, and it is what keeps callers that synthesise
  // bare hit events (tests, older shims) working unchanged. The landing rides
  // along for consumers that judge WHERE a good return went (the Training
  // Session's depth score); it is null exactly when the quality call fell back.
  const centerZ = (env.tableBox.min.z + env.tableBox.max.z) / 2;
  const judgeReturn = (hit) => {
    if (!hit || !hit.contactPos || !hit.outVel || !hit.outSpin) {
      return { good: true, landing: null };
    }
    try {
      const r = rolloutToSurfacePlane(hit.contactPos, hit.outVel, hit.outSpin, env, {
        // INTERCEPT fidelity: this runs inside the live paddle-hit emit, and
        // the judgement is half-table coarse — it needs "which side, over the
        // net, on the table", not the solver's 2 cm.
        dt: DT_PRESETS.INTERCEPT,
      });
      return {
        good: !!(r && r.clearedNet && r.onTable && r.z < centerZ),
        landing: r ? { x: r.x, z: r.z } : null,
      };
    } catch (e) {
      // Fires inside the physics tick's emit — never take the frame down.
      return { good: true, landing: null };
    }
  };

  const onPaddleHit = (hit) => {
    // Record the contact regardless of whether it counts as a "return" — the
    // Blade Heatmap wants every strike, including the second touch of a ball
    // that was already credited, since mishits are exactly what it exists to
    // show. `contactLocal` comes from the collision itself (physics/ball.js).
    if (hit && hit.contactLocal) {
      log.recordContact({
        localX: hit.contactLocal.x,
        localY: hit.contactLocal.y,
        speed: hit.impactSpeed,
        // The spin the PLAYER imparted is the closest thing to a stroke
        // class available at contact.
        stroke: hit.spinType || null,
      });
    }

    if (ballInPlay && !currentBallReturned) {
      // A bad touch does not consume the ball: if it pops up and a second
      // stroke sends it over properly, the later contact still earns the
      // credit — the ball was returned, however untidily.
      const judged = judgeReturn(hit);
      if (!judged.good) {
        currentBallTouched = true;
        return;
      }
      currentBallReturned = true;
      returned++;
      streak++;
      if (streak > bestStreak) bestStreak = streak;
      log.recordOutcome(OUTCOMES.RETURNED, {
        zone: lastFeed && lastFeed.config.placement ? lastFeed.config.placement.zone ?? null : null,
        spin: lastFeed ? lastFeed.config.spinType : null,
        rallyLength: streak,
      });
      emitOutcome({
        ball: lastFeed ? lastFeed.index - 1 : null,
        result: 'returned',
        zone: lastFeed && lastFeed.config.placement ? lastFeed.config.placement.zone ?? null : null,
        spin: lastFeed ? lastFeed.config.spinType : null,
        // Predicted landing of the RETURN (same integrator the credit above
        // trusts). Null when the quality judgement fell back.
        landing: judged.landing,
        streak,
      });
    }
  };

  const onBallLost = () => {
    if (!ballInPlay) return;
    if (!currentBallReturned) recordMiss();
    ballInPlay = false;
  };

  if (ballEvents) {
    ballEvents.onPaddleHit(onPaddleHit);
    ballEvents.onBallLost(onBallLost);
  }

  return {
    // Exposed for tests.
    figure,

    update(dt) {
      // The log's clock is driven by the same dt the physics uses, so a
      // session stays reproducible and headless runs stay comparable.
      log.tick(dt);
      figure.update(dt);
      // Hold the next feed until the figure has finished its swing AND the
      // previous ball has cleared. Replaces the legacy feeder's inline
      // ballModel.visible check — the engine itself stays scene-free.
      engine.update(dt, () => figure.isIdle && !(ballModel && ballModel.visible));
      if (figure.isIdle && !(ballModel && ballModel.visible)) figure.showHeldBall(true);
    },

    isFinished() { return engine.finished; },

    liveLine() {
      // A machine that silently refuses to feed reads as broken. If nothing
      // is playable at these settings, say why instead of sitting idle —
      // this is the only place the player can find out.
      if (skipped > 0 && fed === skipped) {
        return 'Too slow to clear the net at that placement — raise speed or pick a shorter zone';
      }
      const total = cfg.burstCount === INFINITE ? '∞' : cfg.burstCount;
      let line = `Returns ${returned}/${fed - skipped}/${total}  Streak ${streak}`;
      if (clampedCount > 0) line += '  · shortened to reach';
      return line;
    },

    // Exposed for tests.
    getSnapshot() {
      return {
        fed, returned, streak, bestStreak, infeasibleCount,
        skipped, clampedCount,
        lastFeed,
        returnRate: fed > 0 ? returned / fed : 0,
      };
    },

    // The end-of-set panel reads the bounded summary; the full event stream
    // stays readable for tests. Both come from the same log.
    getLog() { return log; },
    getSummary() { return log.summary(); },

    setConfig(next) { return engine.setConfig(next); },

    // Hold and restart the feed without losing the session (the Training
    // Session's rests). A ball already in flight still gets its verdict.
    pause() { engine.pause(); },
    resume() { engine.resume(); },

    dispose() {
      if (ballEvents) {
        if (ballEvents.offPaddleHit) ballEvents.offPaddleHit(onPaddleHit);
        if (ballEvents.offBallLost) ballEvents.offBallLost(onBallLost);
      }
      engine.dispose();
      figure.dispose();
      if (ballModel) ballModel.visible = false;
    },
  };
}
