// Machine Play — playing AGAINST the ball machine, rather than drilling with it.
//
// The difference from a training drill is the fail state, not the feed. A
// drill fires a fixed burst and reports how many you returned; these modes
// fire forever and end on a condition you can lose to (Survival) or win
// (Score Challenge), or never (Quick Rally). That is the whole reason the mode
// exists: a burst of 20 with a percentage at the end is practice, and a streak
// you can break is a game.
//
// So this is a thin scorer wrapping createM1BallMachineDrill, NOT a second
// feeder. Everything about how a ball is solved, launched, animated and logged
// stays in the one implementation; this module only watches the per-ball
// verdicts and decides when the session is over.

import { createM1BallMachineDrill } from '../training/drills/m1BallMachine.js';
import { validateConfig, INFINITE } from '../training/drillConfig.js';
import { QUICK_FEED } from '../training/presets.js';
import { MACHINE_MODES, DEFAULT_CHALLENGE_TARGET } from './machineModes.js';

export { MACHINE_MODES, DEFAULT_CHALLENGE_TARGET };

export const MACHINE_PLAY = {
  id: 'machinePlay',
  label: 'Machine Play',
};

/**
 * @param {object}  opts
 * @param {string}  opts.machineMode  one of MACHINE_MODES; unknown falls back
 *                                    to RALLY rather than throwing, because a
 *                                    stale deep link should still play.
 * @param {number}  opts.target       returns needed to clear a Score Challenge
 */
export function createMachinePlayDrill({
  ballEvents, config, seed,
  machineMode = MACHINE_MODES.RALLY,
  target = DEFAULT_CHALLENGE_TARGET,
} = {}) {
  const mode = Object.values(MACHINE_MODES).includes(machineMode)
    ? machineMode
    : MACHINE_MODES.RALLY;

  // Every mode owns its own ending, so the burst is always infinite — a
  // burstCount arriving from a preset or a saved config would otherwise stop
  // the machine mid-game for reasons the player cannot see.
  const cfg = validateConfig({
    ...(config || QUICK_FEED.Warmup.config),
    burstCount: INFINITE,
  });

  const goal = Math.max(1, Math.round(Number(target) || DEFAULT_CHALLENGE_TARGET));

  let returns = 0;
  let misses = 0;
  let streak = 0;
  let bestStreak = 0;
  let over = false;
  let outcome = null;   // 'cleared' | 'failed' | null while still running

  const finish = (result) => {
    if (over) return;
    over = true;
    outcome = result;
  };

  const inner = createM1BallMachineDrill({
    ballEvents, config: cfg, seed,
    onOutcome: (o) => {
      // Verdicts can still arrive after the run ends — the ball that broke a
      // Survival streak is often still in the air, and its ballLost fires
      // later. Ignoring them keeps the final score equal to the score shown
      // at the moment the run ended.
      if (over) return;
      if (o.result === 'returned') {
        returns++;
        streak++;
        if (streak > bestStreak) bestStreak = streak;
        if (mode === MACHINE_MODES.CHALLENGE && returns >= goal) finish('cleared');
      } else {
        misses++;
        streak = 0;
        if (mode === MACHINE_MODES.SURVIVAL) finish('failed');
      }
    },
  });

  return {
    // Exposed for the same reason the M1 drill exposes it: tests observe the
    // machine's glide between feeds through it.
    figure: inner.figure,

    update(dt) {
      // Once the run is over the inner drill stops being ticked, which stops
      // the engine feeding. Ending the feed is the point — a machine that
      // keeps firing into a finished game reads as a bug.
      if (over) return;
      inner.update(dt);
    },

    isFinished() { return over || inner.isFinished(); },

    liveLine() {
      switch (mode) {
        case MACHINE_MODES.SURVIVAL:
          return over
            ? `Survival over  —  ${returns} returned  ·  best streak ${bestStreak}`
            : `Survival  —  ${returns} returned  ·  one miss ends it`;
        case MACHINE_MODES.CHALLENGE:
          return over
            ? `Challenge ${outcome === 'cleared' ? 'cleared' : 'over'}  —  ${returns}/${goal}  ·  ${misses} missed`
            : `Challenge  —  ${returns}/${goal}  ·  ${misses} missed  ·  streak ${streak}`;
        default:
          return `Rally  —  ${returns} returned  ·  streak ${streak} (best ${bestStreak})`;
      }
    },

    getSnapshot() {
      return {
        mode, target: goal, returns, misses, streak, bestStreak, over, outcome,
        // The feed-side counters stay available so a caller that wants the
        // return RATE can still get it without a second accounting path.
        feed: inner.getSnapshot(),
      };
    },

    getLog() { return inner.getLog(); },
    getSummary() { return inner.getSummary(); },
    getRecentContacts() { return inner.getRecentContacts(); },

    // Live retune from the settings screen without restarting the run.
    setConfig(next) {
      return inner.setConfig(validateConfig({ ...next, burstCount: INFINITE }));
    },

    dispose() { inner.dispose(); },
  };
}
