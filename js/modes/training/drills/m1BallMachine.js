// M1 Ball Machine — the P15 mode.
//
// Pairs the two halves the old feeder used to conflate:
//   FeedEngine   (feedEngine.js)   — scene-free. Solves a commanded landing
//                                    point and forward-verifies it through
//                                    the shared integrator.
//   ServerFigure (serverFigure.js) — scene-only. Plays the windup → swing →
//                                    recover animation and calls back at the
//                                    exact contact frame.
//
// The ball spawns on that contact callback, using the velocity and spin the
// engine solved, so what the player sees leave the paddle is the shot that was
// verified — not an approximation of it.
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
import { ServerFigure } from '../serverFigure.js';
import { BallMachineFigure, LAUNCH_LEAD_SEC } from '../ballMachineFigure.js';
import { validateConfig, INFINITE } from '../drillConfig.js';
import { QUICK_FEED } from '../presets.js';
import { PatternRunner } from '../patterns.js';
import { Ladder } from '../ladder.js';
import { mulberry32 } from '../../../util/rng.js';
import { EventLog, OUTCOMES } from '../../../profile/eventLog.js';

const MAX_RECENT_CONTACTS = 12;

export const M1_BALL_MACHINE = {
  id: 'm1BallMachine',
  label: 'Ball Machine',
  // Drives its own BallMachineFigure, so the legacy Feeder must not be built.
  usesFeeder: false,
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
  stats, ballEvents, config, seed,
  // M2: a pattern turns the same feeder into a sequenced drill. `ladderTier`
  // starts the progression at a tier; the ladder then moves it per 20 balls.
  pattern = null, random = false, hand = 'R', paceMul = 1, ladderTier = null,
} = {}) {
  const env = buildEnv();
  const baseCfg = validateConfig(config || QUICK_FEED.Warmup.config);

  // Seeded by default so a session is reproducible (M5/M6/M11 all depend on
  // the feed stream being replayable). A caller may pass an explicit seed to
  // reproduce a specific session.
  const rng = mulberry32(seed == null ? 0x5eed : seed);

  // M2 progression ladder. It scales the base config, so a ladder is a
  // difficulty ramp over the SAME drill rather than four separate ones.
  const ladder = ladderTier ? new Ladder({ tier: ladderTier }) : null;
  const cfg = ladder ? validateConfig(ladder.applyTo(baseCfg)) : baseCfg;

  // A ball machine, not a server figure. ServerFigure remains in use by the
  // four legacy drills that still feed through feeder.js.
  const figure = new BallMachineFigure();
  const engine = new FeedEngine(cfg, env, { rng, animationLeadSec: LAUNCH_LEAD_SEC });

  // A pattern supplies the engine's per-feed config; without one the engine
  // just repeats its own config, which is exactly M1's behaviour.
  let runner = null;
  const buildRunner = () => {
    if (!pattern) return null;
    const base = ladder ? validateConfig(ladder.applyTo(baseCfg)) : baseCfg;
    const r = new PatternRunner(pattern, base, { hand, paceMul, random, rng });
    r.attach(engine);
    return r;
  };
  runner = buildRunner();

  // M7's analytics sink. Separate from xr/contactLog.js, which clears on any
  // calibration change (migration-plan D5).
  const log = new EventLog({ drillId: M1_BALL_MACHINE.id });

  let currentBallReturned = false;
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
  // Ring of recent contacts for Why-Did-I-Miss. Bounded because it holds live
  // vectors, and the screen only ever shows the most recent handful.
  const recentContacts = [];

  // Feed one ball's verdict to the ladder. A tier change rebuilds the runner
  // so the new difficulty takes effect on the very next ball rather than at
  // some later boundary the player cannot perceive.
  let lastTierChange = null;
  const scoreForLadder = (success) => {
    if (!ladder) return;
    const move = ladder.record(success);
    if (move.changed) {
      lastTierChange = move;
      const next = validateConfig(ladder.applyTo(baseCfg));
      engine.setConfig(next);
      if (pattern) runner = buildRunner();
    }
  };

  // The zone/spin a verdict is attributed to is the one that was FED, so it
  // has to be read off the feed the player was actually facing.
  const recordMiss = () => {
    streak = 0;
    scoreForLadder(false);
    log.recordOutcome(OUTCOMES.MISS, {
      zone: lastFeed && lastFeed.config.placement ? lastFeed.config.placement.zone ?? null : null,
      spin: lastFeed ? lastFeed.config.spinType : null,
    });
    if (stats && stats.recordMiss) stats.recordMiss();
  };

  engine.onFeed((feed) => {
    // Count the PREVIOUS ball as a miss only if one was actually LAUNCHED.
    // A skipped (infeasible) feed puts no ball in play, so charging the
    // player a miss for it would invent failures they never had — and since
    // an unplayable config skips every feed, it would drive the return rate
    // to zero on balls that never existed.
    if (lastLaunched && !currentBallReturned) recordMiss();

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
    lastLaunched = true;

    if (stats && stats.recordFeed) {
      stats.recordFeed({
        spin: feed.config.spinType,
        placementX: feed.commandedLanding.x,
        landing: feed.commandedLanding.clone(),
        shotIndex: fed,
      });
    }

    // Pre-feed tick as a timing aid (M1's audio-cue attribute). Fired at the
    // engine's feed moment rather than at launch, so it lands one spin-up
    // BEFORE the ball leaves the barrel — useful for timing rather than a
    // report of something that already happened.
    if (cfg.audioCue) {
      try { playMenuHoverTick(); } catch (e) { /* audio unavailable — not fatal */ }
    }

    // The pose comes from ServerFigure's helper: it resolves a spawn point and
    // launch velocity into a position + facing, which is what the machine
    // needs to aim its barrel. The full launch velocity is passed too, so the
    // barrel's ELEVATION matches the real shot — a lob visibly points upward.
    const contactPose = ServerFigure.computeContactPose(feed.spawn, feed.velocity);
    figure.beginSwing(contactPose, () => {
      spawnBallAt(contactPose.position, feed.velocity, feed.spin);
    }, feed.velocity);
  });

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
        // class available at contact; M2's stroke isolation will refine it.
        stroke: hit.spinType || null,
      });
    }

    // Keep the full contact state for M7's Why-Did-I-Miss. It is NOT put in
    // the event log: those entries are compact, serialisable and replayable,
    // and stuffing six THREE vectors per contact into them would bloat every
    // session summary for a screen that only ever looks at the last few.
    if (hit && hit.contactPos) {
      recentContacts.push({
        contactPos: hit.contactPos,
        contactVel: hit.inVel,
        contactSpin: hit.inSpin,
        actualOutVel: hit.outVel,
        actualOutSpin: hit.outSpin,
        actualFaceNormal: hit.faceNormal,
        contactLocal: hit.contactLocal,
        edge: !!hit.edge,
      });
      if (recentContacts.length > MAX_RECENT_CONTACTS) recentContacts.shift();
    }

    if (!currentBallReturned) {
      currentBallReturned = true;
      returned++;
      streak++;
      if (streak > bestStreak) bestStreak = streak;
      scoreForLadder(true);
      log.recordOutcome(OUTCOMES.RETURNED, {
        zone: lastFeed && lastFeed.config.placement ? lastFeed.config.placement.zone ?? null : null,
        spin: lastFeed ? lastFeed.config.spinType : null,
        rallyLength: streak,
      });
      if (stats && stats.recordReturn) stats.recordReturn();
    }
  };

  const onBallLost = () => {
    if (!currentBallReturned) recordMiss();
  };

  if (ballEvents) {
    ballEvents.onPaddleHit(onPaddleHit);
    ballEvents.onBallLost(onBallLost);
  }

  return {
    // This drill drives its own ServerFigure, so the legacy Feeder instance
    // inGame.js constructs must stay hidden — otherwise two server paddles
    // render on the far side.
    usesFeeder: false,

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
      // A promotion the player cannot see feels like the drill got harder for
      // no reason, so the tier is shown while a ladder is running.
      if (ladder) line += `  · ${ladder.tier.toUpperCase()} (${ladder.ballsUntilReview} to review)`;
      if (runner) line += `  · next ${runner.describeNext(fed)}`;
      if (clampedCount > 0) line += '  · shortened to reach';
      return line;
    },

    // Exposed for tests and for the M7 handoff.
    getSnapshot() {
      return {
        fed, returned, streak, bestStreak, infeasibleCount,
        skipped, clampedCount,
        tier: ladder ? ladder.tier : null,
        tierRate: ladder ? ladder.rate : null,
        pattern: pattern || null,
        lastFeed,
        returnRate: fed > 0 ? returned / fed : 0,
      };
    },

    // M7 reads the full-fidelity event stream from here; Trends reads the
    // bounded summary. Both come from the same log so they cannot disagree.
    getLog() { return log; },
    getSummary() { return log.summary(); },

    /**
     * Recent contacts with the geometry M7's Why-Did-I-Miss needs, newest
     * last. `env` rides along so the review screen can run the solver without
     * reaching into scene modules itself.
     */
    getRecentContacts() { return { contacts: recentContacts.slice(), env }; },

    setConfig(next) { return engine.setConfig(next); },

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
