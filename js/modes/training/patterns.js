// M2 Pattern Drills — the classic multi-ball sequences, plus the runner that
// plays them on the M1 feeder.
//
// A pattern is NOT a different feeder. It is the same FeedEngine handed a
// different placement each ball, which is why this module produces configs
// rather than owning any physics: `PatternRunner` supplies FeedEngine's
// per-feed config provider and nothing else.
//
// ── WING NAMING ─────────────────────────────────────────────────────────────
//
// Steps are written as BH / MID / FH rather than zone numbers, because a
// pattern is a tactical shape ("wide to the backhand, then pivot") and the
// zone that corresponds to a wing depends on which hand the player uses.
// resolveWing() applies handedness once, here, so no pattern definition has
// to be duplicated for left-handers.
//
// Geometry: the player stands at +z facing −z, so their LEFT is −x. For a
// right-hander the backhand is therefore the −x column (zones 1/4/7) and the
// forehand the +x column (3/6/9). Left-handers get the mirror.

import { validateConfig } from './drillConfig.js';

export const WINGS = Object.freeze({ BH: 'BH', MID: 'MID', FH: 'FH' });

// Column index (0 = −x, 1 = middle, 2 = +x) for a wing and handedness.
export function wingColumn(wing, hand = 'R') {
  if (wing === WINGS.MID) return 1;
  const backhandIsMinusX = hand !== 'L';
  if (wing === WINGS.BH) return backhandIsMinusX ? 0 : 2;
  return backhandIsMinusX ? 2 : 0;
}

const DEPTH_ROW = { short: 0, 'half-long': 1, deep: 2 };

/** Zone number (1–9) for a wing at a depth, given handedness. */
export function resolveWing(wing, depth = 'deep', hand = 'R') {
  const col = wingColumn(wing, hand);
  const row = DEPTH_ROW[depth] ?? 2;
  return row * 3 + col + 1;
}

/**
 * The shipped classics. M2 asks for ≥ 8.
 *
 * Each step may carry `wing`, `depth`, `spinType`, `spinMagnitude` and
 * `speedMul` — anything omitted falls through to the drill's base config, so
 * a pattern describes only what makes it that pattern.
 */
export const PATTERNS = Object.freeze({
  falkenberg: {
    id: 'falkenberg', label: 'Falkenberg',
    note: 'BH, then middle stepped around, then wide FH',
    steps: [
      { wing: WINGS.BH,  depth: 'deep' },
      { wing: WINGS.MID, depth: 'deep' },
      { wing: WINGS.FH,  depth: 'deep' },
    ],
  },
  twoPoint: {
    id: 'twoPoint', label: 'Two-point',
    note: 'Straight alternation, corner to corner',
    steps: [
      { wing: WINGS.BH, depth: 'deep' },
      { wing: WINGS.FH, depth: 'deep' },
    ],
  },
  figureEight: {
    id: 'figureEight', label: 'Figure of eight',
    note: 'Crosscourt and down-the-line in turn',
    steps: [
      { wing: WINGS.BH, depth: 'deep' },
      { wing: WINGS.FH, depth: 'half-long' },
      { wing: WINGS.FH, depth: 'deep' },
      { wing: WINGS.BH, depth: 'half-long' },
    ],
  },
  middleWide: {
    id: 'middleWide', label: 'Middle and wide',
    note: 'Elbow, then stretched to a corner',
    steps: [
      { wing: WINGS.MID, depth: 'deep' },
      { wing: WINGS.FH,  depth: 'deep' },
      { wing: WINGS.MID, depth: 'deep' },
      { wing: WINGS.BH,  depth: 'deep' },
    ],
  },
  shortLong: {
    id: 'shortLong', label: 'Short then long',
    note: 'Push the short ball, then open on the deep one',
    steps: [
      { wing: WINGS.BH, depth: 'short', spinType: 'back', speedMul: 0.75 },
      { wing: WINGS.FH, depth: 'deep',  spinType: 'top' },
    ],
  },
  pivot: {
    id: 'pivot', label: 'Backhand pivot',
    note: 'Two backhands, then step around for the forehand',
    steps: [
      { wing: WINGS.BH, depth: 'deep' },
      { wing: WINGS.BH, depth: 'deep' },
      { wing: WINGS.BH, depth: 'half-long' },
      { wing: WINGS.FH, depth: 'deep' },
    ],
  },
  wideWide: {
    id: 'wideWide', label: 'Corner to corner',
    note: 'Maximum width, footwork under pressure',
    steps: [
      { wing: WINGS.FH, depth: 'deep' },
      { wing: WINGS.BH, depth: 'deep' },
      { wing: WINGS.FH, depth: 'half-long' },
      { wing: WINGS.BH, depth: 'half-long' },
    ],
  },
  pushBlock: {
    id: 'pushBlock', label: 'Push and block',
    note: 'Backspin to the middle, then a quicker topspin block',
    steps: [
      { wing: WINGS.MID, depth: 'half-long', spinType: 'back', speedMul: 0.8 },
      { wing: WINGS.MID, depth: 'deep',      spinType: 'top', speedMul: 1.15 },
      { wing: WINGS.BH,  depth: 'deep',      spinType: 'top' },
    ],
  },
});

export const PATTERN_ORDER = Object.freeze([
  'falkenberg', 'twoPoint', 'figureEight', 'middleWide',
  'shortLong', 'pivot', 'wideWide', 'pushBlock',
]);

export function getPattern(id) {
  return PATTERNS[id] || PATTERNS.falkenberg;
}

/**
 * Apply one pattern step on top of a base config.
 *
 * Everything routes through validateConfig, so a step cannot introduce a
 * value the engine would reject — `speedMul` in particular is applied and
 * then clamped rather than trusted.
 */
export function buildStepConfig(base, step, { hand = 'R', paceMul = 1 } = {}) {
  const depth = step.depth || base.depth;
  const next = {
    ...base,
    depth,
    placement: { kind: 'zone', zone: resolveWing(step.wing, depth, hand) },
  };
  if (step.spinType) next.spinType = step.spinType;
  if (step.spinMagnitude !== undefined) next.spinMagnitude = step.spinMagnitude;
  if (step.speedMul) next.speed = base.speed * step.speedMul;
  // Pace multiplier shortens the gap between balls; M2 specifies 0.6–1.4.
  if (paceMul && paceMul !== 1) next.interval = base.interval / paceMul;
  return validateConfig(next);
}

/**
 * Plays a pattern by supplying FeedEngine's per-feed config.
 *
 * Deliberately owns no timing: the engine keeps the schedule, the runner only
 * answers "what is the next ball?". That keeps a pattern testable by asking
 * it for N configs in a row, with no clock involved.
 */
export class PatternRunner {
  constructor(pattern, baseConfig, { hand = 'R', paceMul = 1, random = false, rng = Math.random } = {}) {
    this.pattern = typeof pattern === 'string' ? getPattern(pattern) : pattern;
    this.base = validateConfig(baseConfig);
    this.hand = hand;
    this.paceMul = paceMul;
    // M2: "Random Mode — interleaved placement/spin within user-set bounds.
    // DEFAULT after basics — random > blocked practice for retention."
    // Same steps, drawn in random order rather than in sequence.
    this.random = random;
    this.rng = rng;
    this.index = 0;
  }

  get stepCount() { return this.pattern.steps.length; }

  /** The step that ball `i` should use. */
  stepFor(i) {
    const steps = this.pattern.steps;
    if (!this.random) return steps[i % steps.length];
    return steps[Math.floor(this.rng() * steps.length)];
  }

  /** Config for ball `i`. Suitable directly as FeedEngine's configProvider. */
  configFor(i) {
    return buildStepConfig(this.base, this.stepFor(i), {
      hand: this.hand, paceMul: this.paceMul,
    });
  }

  /** Bind to an engine so it plays this pattern. */
  attach(engine) {
    engine.setConfigProvider((i) => this.configFor(i));
    return this;
  }

  /** Human-readable description of the next ball, for the in-drill HUD. */
  describeNext(i) {
    const step = this.stepFor(i);
    return `${step.wing}${step.depth ? ` · ${step.depth}` : ''}`;
  }
}
