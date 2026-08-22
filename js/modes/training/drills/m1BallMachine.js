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
import { FeedEngine, originPosition } from '../feedEngine.js';
import { BallMachineFigure, LAUNCH_LEAD_SEC, computeContactPose } from '../ballMachineFigure.js';
import { validateConfig, INFINITE } from '../drillConfig.js';
import { QUICK_FEED } from '../presets.js';
import { PatternRunner } from '../patterns.js';
import { Ladder, CurriculumTuner, RESAMPLE_EVERY } from '../ladder.js';
import { rolloutToSurfacePlane, DT_PRESETS } from '../../../physics/rollout.js';
import { mulberry32 } from '../../../util/rng.js';
import { EventLog, OUTCOMES } from '../../../profile/eventLog.js';

const MAX_RECENT_CONTACTS = 12;

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
  // M2: a pattern turns the same feeder into a sequenced drill. `ladderTier`
  // starts the progression at a tier; the ladder then moves it per 20 balls.
  // paceMul: null lets a pattern's own default pace apply (PatternRunner
  // falls back to pattern.paceMul); an explicit value overrides it.
  pattern = null, random = false, hand = 'R', paceMul = null, ladderTier = null,
  // M10 curriculum steering. Only engages in random-pattern mode, where there
  // is a draw to steer; sequenced patterns keep their fixed order regardless.
  adaptive = true,
  // Per-ball verdict, fired once the drill has decided whether a ball was
  // returned or missed. Machine Play builds its fail states and score on this
  // rather than inferring them from getSnapshot(): a ball in flight is
  // counted as fed but not yet returned, so any difference of counters reads
  // as a phantom miss for exactly as long as the ball is airborne — which is
  // enough to end a Survival run on the very first feed.
  onOutcome = null,
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

  const figure = new BallMachineFigure();
  const engine = new FeedEngine(cfg, env, { rng, animationLeadSec: LAUNCH_LEAD_SEC });

  // M10's curriculum tuner — the loop between the verdicts the event log
  // records and the feeds the player faces next. Each pattern step is a
  // bucket; per-ball verdicts build a success surface over them, and every
  // RESAMPLE_EVERY balls the resample steers the random draw toward the
  // steps in the 60–75% band (edge of ability). Declared before buildRunner
  // so the weights closure below can see it, and OWNED here rather than by
  // the runner so a ladder tier change (which rebuilds the runner) does not
  // wipe what the tuner has learned.
  let tuner = null;
  const stepWeights = () =>
    (tuner ? tuner.buckets.map((b) => tuner.weights.get(b)) : null);

  // A pattern supplies the engine's per-feed config; without one the engine
  // just repeats its own config, which is exactly M1's behaviour.
  let runner = null;
  const buildRunner = () => {
    if (!pattern) return null;
    const base = ladder ? validateConfig(ladder.applyTo(baseCfg)) : baseCfg;
    const r = new PatternRunner(pattern, base, {
      hand, paceMul, random, rng, stepWeights,
    });
    r.attach(engine);
    return r;
  };
  runner = buildRunner();
  if (adaptive && runner && random) {
    tuner = new CurriculumTuner({
      buckets: runner.pattern.steps.map((_, i) => String(i)),
    });
  }

  // Glide the machine toward the NEXT ball's origin (Rapid Fire's sweep).
  // Safe to call speculatively: PatternRunner.configFor is memoized per index,
  // so this preview, the HUD's describeNext and the engine's eventual
  // configProvider call all see the same step without draining the rng.
  const previewNextOrigin = (immediate = false) => {
    if (!runner || engine.finished) return;
    figure.glideTo(originPosition(runner.configFor(engine.fedCount), env), { immediate });
  };
  // At drill start, snap to ball 0's origin rather than gliding in from
  // wherever the group was built.
  previewNextOrigin(true);

  // M7's analytics sink. Separate from xr/contactLog.js, which clears on any
  // calibration change (migration-plan D5).
  const log = new EventLog({ drillId: M1_BALL_MACHINE.id });

  let currentBallReturned = false;
  // Whether the current ball was TOUCHED without producing a good return.
  // MISS is "never touched it", ERROR is "touched it and put it wrong" — the
  // distinction eventLog's OUTCOMES already draws, and M7's weakness report
  // prescribes different drills for each.
  let currentBallTouched = false;
  // Pattern step the current ball was drawn from, captured at feed time (the
  // runner may be rebuilt on a ladder tier change, which clears its memo).
  let lastStepIndex = null;
  let ballsSinceResample = 0;
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
  // Ring of recent contacts for Why-Did-I-Miss. Bounded because it holds live
  // vectors, and the screen only ever shows the most recent handful.
  const recentContacts = [];

  // A host callback must never take the drill down with it: these fire from
  // inside the physics tick's paddle-hit emit, where a throw would abort the
  // rest of the frame's collision handling.
  const emitOutcome = (payload) => {
    if (!onOutcome) return;
    try { onOutcome(payload); } catch (e) { console.error('onOutcome threw:', e); }
  };

  // Feed one ball's verdict to the ladder. A tier change rebuilds the runner
  // so the new difficulty takes effect on the very next ball rather than at
  // some later boundary the player cannot perceive.
  const scoreForLadder = (success) => {
    if (!ladder) return;
    const move = ladder.record(success);
    if (move.changed) {
      const next = validateConfig(ladder.applyTo(baseCfg));
      engine.setConfig(next);
      if (pattern) runner = buildRunner();
      // The rebuilt runner may pick a different next step (random mode), so
      // re-arm the glide to keep machine and ball agreeing.
      previewNextOrigin();
    }
  };

  // Feed one ball's verdict to the tuner, attributed to the pattern step it
  // was drawn from, and resample on M10's cadence.
  const scoreForTuner = (success) => {
    if (!tuner || lastStepIndex == null) return;
    tuner.record(String(lastStepIndex), success);
    if (++ballsSinceResample >= RESAMPLE_EVERY) {
      ballsSinceResample = 0;
      tuner.update();
    }
  };

  // The zone/spin a verdict is attributed to is the one that was FED, so it
  // has to be read off the feed the player was actually facing.
  const recordMiss = () => {
    streak = 0;
    scoreForLadder(false);
    scoreForTuner(false);
    const verdict = currentBallTouched ? OUTCOMES.ERROR : OUTCOMES.MISS;
    log.recordOutcome(verdict, {
      zone: lastFeed && lastFeed.config.placement ? lastFeed.config.placement.zone ?? null : null,
      spin: lastFeed ? lastFeed.config.spinType : null,
    });
    emitOutcome({
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
    // feed.index is the post-increment count, so the ball's ordinal is one
    // less. stepIndexFor is memoized from the configProvider call that built
    // this very feed, so this read drains no rng.
    lastStepIndex = runner ? runner.stepIndexFor(feed.index - 1) : null;
    if (!feed.feasible) infeasibleCount++;
    if (feed.reachClamped) clampedCount++;
    log.recordFeed(feed, fed);

    // Start travelling toward the next ball's origin now — BEFORE the
    // infeasible early-return, so a skipped feed still re-arms the glide.
    // The target is inert until this feed's spin-up ends, so ordering
    // relative to beginSwing below doesn't matter.
    previewNextOrigin();

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
  // along for consumers that judge WHERE a good return went (the tutorial's
  // target-zone step); it is null exactly when the quality call fell back.
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
      scoreForLadder(true);
      scoreForTuner(true);
      log.recordOutcome(OUTCOMES.RETURNED, {
        zone: lastFeed && lastFeed.config.placement ? lastFeed.config.placement.zone ?? null : null,
        spin: lastFeed ? lastFeed.config.spinType : null,
        rallyLength: streak,
      });
      emitOutcome({
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
    // Exposed so tests can observe the machine's glide between feeds.
    figure,

    // Exposed so tests can observe verdicts landing in the curriculum tuner.
    // Null unless the drill is running a random pattern with adaptive on.
    tuner,

    update(dt) {
      // The log's clock is driven by the same dt the physics uses, so a
      // session stays reproducible and headless runs stay comparable.
      log.tick(dt);
      figure.update(dt);
      // Hold the next feed until the figure has finished its swing AND the
      // previous ball has cleared. Replaces the legacy feeder's inline
      // ballModel.visible check — the engine itself stays scene-free.
      //
      // A nonstop pattern (Rapid Fire) skips the ball-clear wait: the next
      // feed comes on the interval beat like a real machine, recycling the
      // single ball model. Miss accounting is unaffected — an unreturned
      // ball is charged at the NEXT feed, launched or recycled alike.
      const nonstop = !!(runner && runner.pattern && runner.pattern.nonstop);
      engine.update(dt, () => figure.isIdle && (nonstop || !(ballModel && ballModel.visible)));
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
        curriculum: tuner ? tuner.snapshot() : null,
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
