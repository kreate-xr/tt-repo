// M9 Tutorial — the model.
//
// Deliberately small: four steps, ~3 minutes, every step gated by DOING
// something rather than reading something. The P15 M9 outline sketched a
// full curriculum; what shipped is the on-ramp — first return, timing,
// placement, one taste of spin — and each step ends by pointing at the mode
// that trains it properly. Depth belongs to the Ball Machine and the drills,
// not to a longer tutorial.
//
// Scene-free per migration-plan D4: this module owns the step sequence and
// the pass/fail logic, nothing else. The drill wrapper (drills/tutorial.js)
// feeds it per-ball verdicts from the M1 machine and renders target zones;
// this file never touches the scene, so every gating rule is unit-testable.
//
// Each step is a config over the shared M1 primitives (anti-dead-code rule 1)
// and every config here is held to the same feasibility contract as the Quick
// Feed presets: these are Warmup / BackspinPush shapes, both pinned feasible
// by the 500-feed test in tests/feedEngine.test.js.

import { validateConfig, INFINITE } from './drillConfig.js';

// Every step feeds forever (burstCount INFINITE): the step ends when the
// GOAL is met, not when a ball budget runs out — a tutorial that stops
// feeding mid-lesson strands the player with no way forward.
const step = (def) => Object.freeze({
  ...def,
  config: validateConfig({ ...def.config, burstCount: INFINITE, audioCue: true }),
});

export const TUTORIAL_STEPS = Object.freeze([
  step({
    id: 'firstReturn',
    goal: 1,
    // Slow, dead-centre, no spin, and a long gap between balls: the first
    // task is holding the paddle in the right place, nothing more.
    config: {
      speed: 6, spinType: 'none', spinMagnitude: 0,
      placement: { kind: 'zone', zone: 5 }, depth: 'half-long',
      scatterSigma: 0, interval: 3.0,
    },
    instruction: 'Hit the ball back — anywhere on the far half counts',
  }),
  step({
    id: 'threeInARow',
    goal: 3,
    // Consecutive, not cumulative: the lesson is rhythm, and a streak is the
    // only goal that actually requires it.
    resetOnMiss: true,
    config: {
      speed: 6, spinType: 'none', spinMagnitude: 0,
      placement: { kind: 'zone', zone: 5 }, depth: 'half-long',
      scatterSigma: 0, interval: 2.5,
    },
    instruction: 'Keep it going — return 3 in a row',
  }),
  step({
    id: 'placement',
    goal: 2,
    // `zones` tells the wrapper to show the target zones and judge landings.
    // Cumulative (a miss costs nothing): aiming is hard enough without a
    // streak penalty on top.
    zones: true,
    config: {
      speed: 6, spinType: 'none', spinMagnitude: 0,
      placement: { kind: 'zone', zone: 5 }, depth: 'half-long',
      scatterSigma: 0, interval: 3.0,
    },
    instruction: 'Now aim — land 2 returns inside a glowing zone',
  }),
  step({
    id: 'backspin',
    goal: 1,
    // The BackspinPush shape at its own proven settings. One successful lift
    // is the whole lesson; Spin Reader exists for the rest.
    config: {
      speed: 7, spinType: 'back', spinMagnitude: 110,
      placement: { kind: 'zone', zone: 2 }, depth: 'short',
      arc: 'flat', feedOrigin: 'center-far',
      scatterSigma: 0, interval: 3.0,
    },
    instruction: 'Backspin — the ball dies off the bounce. Open the paddle face and lift it back',
  }),
]);

export const TUTORIAL_COMPLETE_LINE =
  'Tutorial complete! Try Ball Machine › Quick Feed next';

export class TutorialModel {
  constructor() {
    this.stepIndex = 0;
    this.count = 0;      // progress toward the current step's goal
  }

  get complete() { return this.stepIndex >= TUTORIAL_STEPS.length; }

  get step() { return this.complete ? null : TUTORIAL_STEPS[this.stepIndex]; }

  /** Feed config for the current step; the last step's once complete. */
  config() {
    const s = this.complete
      ? TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1]
      : this.step;
    return s.config;
  }

  /** Whether the wrapper should have target zones up right now. */
  get needsZones() { return !this.complete && !!this.step.zones; }

  /**
   * One ball's verdict. `result` is the M1 outcome ('returned'|'miss'|'error');
   * `inZone` is the wrapper's zone judgement of where the return landed, only
   * meaningful on a zones step.
   *
   * Returns { advanced, completed } so the wrapper knows when to swap the feed
   * config and when to tear the whole thing down.
   */
  recordOutcome({ result, inZone = false } = {}) {
    if (this.complete) return { advanced: false, completed: false };
    const s = this.step;

    const success = result === 'returned' && (!s.zones || inZone === true);
    if (success) {
      this.count++;
    } else if (s.resetOnMiss && (result === 'miss' || result === 'error')) {
      // A return that lands OUTSIDE the zone on a zones step is neither: it
      // doesn't count and doesn't reset — only a genuine miss can zero a
      // streak step.
      this.count = 0;
    }

    if (this.count < s.goal) return { advanced: false, completed: false };
    this.stepIndex++;
    this.count = 0;
    return { advanced: true, completed: this.complete };
  }

  /** The HUD line: which step, what to do, how far along. */
  instruction() {
    if (this.complete) return TUTORIAL_COMPLETE_LINE;
    const s = this.step;
    const progress = s.goal > 1 ? `  (${this.count}/${s.goal})` : '';
    return `Step ${this.stepIndex + 1} of ${TUTORIAL_STEPS.length} — ${s.instruction}${progress}`;
  }
}
