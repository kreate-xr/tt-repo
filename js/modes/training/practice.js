// Ball Machine practice — the model.
//
// "Pick what to practise", not a feed editor. The player chooses one
// practice from a short list; the machine feeds it without end until they
// leave. Two things can be changed while the balls keep coming, each a step
// at a time from the thumbstick: SPEED (the ball's pace, with spin rising
// alongside it) and TEMPO (the gap between balls). A Random switch moves each
// ball to an unpredictable side.
//
// Why this shape: in the review analysis of Eleven Table Tennis the ball
// machine was the most-loved training feature and also the most complained
// about: confusing sliders, too predictable, left-handers forgotten. So
// there are no sliders, there is a Random switch, and every practice names a
// wing (resolveWing) so "backhand" is the player's own backhand.
//
// The earlier Ball Machine editor was removed on 2026-09-23 because it was
// all settings. This is not that: every value is predefined and every ball
// this model can ask for is held feasible by tests/practice.test.js, across
// both hands, every speed step and the Random switch.
//
// Scene-free (migration-plan D4), like session.js. The drill wrapper
// (drills/practice.js) asks for each ball's config and hands back verdicts.

import { WINGS, stepConfig } from './session.js';

// Speed step 0 is the Training Session's Beginner feed. Each step is 10% of
// pace; spin rises with the positive steps so the top step is close to the
// Player level's "match pace, real spin" (8 m/s, 275 rad/s).
export const BASE = Object.freeze({
  speed: 6, spin: 150, interval: 2.8, scatterSigma: 0.03,
});
export const SPEED_STEPS = Object.freeze({ min: -2, max: 5, pace: 0.1, spin: 0.17 });
export const TEMPO_STEPS = Object.freeze({ min: -2, max: 4, seconds: 0.3 });

const RANDOM_WINGS = [WINGS.BH, WINGS.MID, WINGS.FH];

// A step is a session.js step: wing + depth, optional spin / arc / scaling.
// `random` practices draw a step per ball instead of cycling. Short backspin
// rides the flat arc that session.js's push set already proves.
const SHORT_BACKSPIN = { depth: 'short', spinType: 'back', arc: 'flat', speedMul: 1.1, spinMul: 1.25 };

export const PRACTICES = Object.freeze([
  {
    id: 'forehand', label: 'Forehand drive', blurb: 'Topspin to your forehand',
    steps: [{ wing: WINGS.FH, depth: 'deep', spinType: 'top' }],
  },
  {
    id: 'backhand', label: 'Backhand drive', blurb: 'Topspin to your backhand',
    steps: [{ wing: WINGS.BH, depth: 'deep', spinType: 'top' }],
  },
  {
    id: 'push', label: 'Push the backspin', blurb: 'Short backspin: open the face, push it back low',
    steps: [{ wing: WINGS.MID, ...SHORT_BACKSPIN }],
  },
  {
    id: 'loop', label: 'Loop the backspin', blurb: 'Long backspin: brush up to lift it over',
    steps: [{ wing: WINGS.BH, depth: 'deep', spinType: 'back' }],
  },
  {
    id: 'sidespin', label: 'Return sidespin', blurb: 'The ball curves: watch it and adjust your angle',
    steps: [
      { wing: WINGS.MID, depth: 'deep', spinType: 'side-L' },
      { wing: WINGS.MID, depth: 'deep', spinType: 'side-R' },
    ],
  },
  {
    id: 'twoPoint', label: 'Footwork: two points', blurb: 'Backhand, forehand, back to the middle',
    steps: [
      { wing: WINGS.BH, depth: 'deep', spinType: 'top' },
      { wing: WINGS.FH, depth: 'deep', spinType: 'top' },
    ],
  },
  {
    id: 'threePoint', label: 'Footwork: three points', blurb: 'Backhand, middle, forehand: small steps',
    steps: [
      { wing: WINGS.BH,  depth: 'deep', spinType: 'top' },
      { wing: WINGS.MID, depth: 'deep', spinType: 'top' },
      { wing: WINGS.FH,  depth: 'deep', spinType: 'top' },
    ],
  },
  {
    id: 'readSpin', label: 'Read the spin', blurb: 'Backspin or topspin: push one, block the other',
    random: true,
    steps: [
      { wing: WINGS.MID, ...SHORT_BACKSPIN },
      { wing: WINGS.MID, depth: 'deep', spinType: 'top', speedMul: 1.1 },
    ],
  },
].map((p) => Object.freeze(p)));

export const PRACTICE_ORDER = Object.freeze(PRACTICES.map((p) => p.id));

export function getPractice(id) {
  return PRACTICES.find((p) => p.id === id) || null;
}

// --- Build your own ----------------------------------------------------------
//
// Three choices, each a short list the player taps through: the spin, the
// side and the length. Speed and tempo stay on the thumbstick. No sliders,
// and no combination the machine cannot land (tests/practice.test.js sweeps
// all of them).
//
// Sidespin is one choice, not two: the machine alternates both directions,
// because a real server gives you both and the player should not have to
// know which way "left" sidespin curves.
export const CUSTOM_ID = 'custom';
export const CUSTOM_OPTIONS = Object.freeze({
  spin: Object.freeze([
    { id: 'top', label: 'Topspin' },
    { id: 'back', label: 'Backspin' },
    { id: 'side', label: 'Sidespin' },
    { id: 'none', label: 'No spin' },
  ]),
  side: Object.freeze([
    { id: 'forehand', label: 'Forehand' },
    { id: 'middle', label: 'Middle' },
    { id: 'backhand', label: 'Backhand' },
    { id: 'random', label: 'Random' },
  ]),
  length: Object.freeze([
    { id: 'long', label: 'Long' },
    { id: 'short', label: 'Short' },
  ]),
});
export const CUSTOM_DEFAULT = Object.freeze({ spin: 'top', side: 'forehand', length: 'long' });

const CUSTOM_WING = { forehand: WINGS.FH, middle: WINGS.MID, backhand: WINGS.BH, random: WINGS.MID };

const optionOf = (key, id) => CUSTOM_OPTIONS[key].find((o) => o.id === id)
  || CUSTOM_OPTIONS[key].find((o) => o.id === CUSTOM_DEFAULT[key]);

/** Coerce anything into a valid { spin, side, length } choice. */
export function normalizeCustom(choice) {
  const c = choice && typeof choice === 'object' ? choice : {};
  return {
    spin: optionOf('spin', c.spin).id,
    side: optionOf('side', c.side).id,
    length: optionOf('length', c.length).id,
  };
}

/** "Backspin  ·  Forehand  ·  Short": the choice in the player's words. */
export function customSummary(choice) {
  const c = normalizeCustom(choice);
  return ['spin', 'side', 'length'].map((k) => optionOf(k, c[k]).label).join('  ·  ');
}

/**
 * The practice a choice stands for, in the same shape as a PRACTICES entry.
 * `randomSide` tells the model to draw the side per ball.
 */
export function customPractice(choice) {
  const c = normalizeCustom(choice);
  const wing = CUSTOM_WING[c.side];
  const short = c.length === 'short';
  let steps;
  if (c.spin === 'back' && short) {
    steps = [{ wing, ...SHORT_BACKSPIN }];
  } else if (c.spin === 'side') {
    // Short sidespin to the corners is not a reliable feed (the solver refuses
    // it at some speeds), so sidespin's short is the half-long band.
    const depth = short ? 'half-long' : 'deep';
    steps = [
      { wing, depth, spinType: 'side-L' },
      { wing, depth, spinType: 'side-R' },
    ];
  } else {
    steps = [{ wing, depth: short ? 'short' : 'deep', spinType: c.spin }];
  }
  return Object.freeze({
    id: CUSTOM_ID,
    label: 'Your ball',
    blurb: customSummary(c),
    steps,
    randomSide: c.side === 'random',
  });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The feed values a speed/tempo step pair stands for. */
export function feedLevel(speedStep, tempoStep) {
  return {
    speed: BASE.speed,
    spin: BASE.spin * (1 + SPEED_STEPS.spin * Math.max(0, speedStep)),
    interval: BASE.interval - TEMPO_STEPS.seconds * tempoStep,
    scatterSigma: BASE.scatterSigma,
  };
}

/**
 * Config for one ball. Exported so the feasibility test can sweep every ball
 * this mode can ever feed. `wing` overrides the step's own (the Random switch).
 */
export function practiceConfig(step, {
  hand = 'R', speedStep = 0, tempoStep = 0, wing = null,
} = {}) {
  return stepConfig(
    feedLevel(speedStep, tempoStep),
    wing ? { ...step, wing } : step,
    { hand, pace: 1 + SPEED_STEPS.pace * speedStep },
  );
}

export class PracticeModel {
  /**
   * @param {object} opts
   * @param {string} opts.practice  a PRACTICES id (unknown → the first)
   * @param {'L'|'R'} [opts.hand]
   * @param {boolean} [opts.random] the Random switch: each ball to a random side
   * @param {() => number} [opts.rng]
   */
  constructor({
    practice, custom = null, hand = 'R', random = false, rng = Math.random,
  } = {}) {
    // 'custom' is the Build-your-own ball; `custom` is its { spin, side, length }.
    this.practice = practice === CUSTOM_ID
      ? customPractice(custom)
      : getPractice(practice) || PRACTICES[0];
    this.hand = hand === 'L' ? 'L' : 'R';
    // A built ball carries its own side choice; the list's Random switch is
    // for the ready-made practices.
    this.random = this.practice.id === CUSTOM_ID ? !!this.practice.randomSide : !!random;
    this.rng = rng;
    this.speedStep = 0;
    this.tempoStep = 0;
    this.faced = 0;
    this.returned = 0;
    this.streak = 0;
    this.bestStreak = 0;
  }

  /** The config for ball number `ball` (0-based), asked once per feed. */
  nextConfig(ball) {
    const { steps } = this.practice;
    const step = this.practice.random
      ? steps[Math.min(steps.length - 1, Math.floor(this.rng() * steps.length))]
      : steps[ball % steps.length];
    const wing = this.random
      ? RANDOM_WINGS[Math.min(2, Math.floor(this.rng() * 3))]
      : null;
    return practiceConfig(step, {
      hand: this.hand, speedStep: this.speedStep, tempoStep: this.tempoStep, wing,
    });
  }

  recordOutcome({ result } = {}) {
    this.faced++;
    if (result === 'returned') {
      this.returned++;
      this.streak++;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
    } else {
      this.streak = 0;
    }
  }

  /**
   * One thumbstick step. Returns what changed, for the in-world notice, or
   * null when `kind` is unknown. `changed` is false at either end of the range.
   */
  adjust(kind, dir) {
    const d = dir > 0 ? 1 : -1;
    if (kind === 'speed') {
      const next = clamp(this.speedStep + d, SPEED_STEPS.min, SPEED_STEPS.max);
      const changed = next !== this.speedStep;
      this.speedStep = next;
      return { kind, changed, level: this.speedLevel, of: this.speedLevels };
    }
    if (kind === 'tempo') {
      const next = clamp(this.tempoStep + d, TEMPO_STEPS.min, TEMPO_STEPS.max);
      const changed = next !== this.tempoStep;
      this.tempoStep = next;
      return { kind, changed, level: this.tempoLevel, of: this.tempoLevels };
    }
    return null;
  }

  // Levels as the player reads them: 1 is the gentlest.
  get speedLevel() { return this.speedStep - SPEED_STEPS.min + 1; }
  get speedLevels() { return SPEED_STEPS.max - SPEED_STEPS.min + 1; }
  get tempoLevel() { return this.tempoStep - TEMPO_STEPS.min + 1; }
  get tempoLevels() { return TEMPO_STEPS.max - TEMPO_STEPS.min + 1; }

  /** The one HUD line. */
  liveLine() {
    const head = this.practice.id === CUSTOM_ID
      ? this.practice.blurb
      : this.random ? `${this.practice.label} (random)` : this.practice.label;
    return `${head}  ·  Speed ${this.speedLevel}/${this.speedLevels}`
      + `  ·  Tempo ${this.tempoLevel}/${this.tempoLevels}`
      + `  ·  ${this.returned}/${this.faced} back`;
  }
}
