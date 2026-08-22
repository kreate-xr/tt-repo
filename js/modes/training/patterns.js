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

// Memoized random draws kept per runner. See stepIndexFor for why eviction
// of old indices is safe.
const STEP_CACHE_MAX = 256;

// Column index (0 = −x, 1 = middle, 2 = +x) for a wing and handedness.
export function wingColumn(wing, hand = 'R') {
  if (wing === WINGS.MID) return 1;
  const backhandIsMinusX = hand !== 'L';
  if (wing === WINGS.BH) return backhandIsMinusX ? 0 : 2;
  return backhandIsMinusX ? 2 : 0;
}

const DEPTH_ROW = { short: 0, 'half-long': 1, deep: 2 };

/**
 * Mirror a step's feed origin for handedness, the way resolveWing mirrors
 * landings. A step origin means "fire roughly straight at that wing", so a
 * left-hander gets the mirrored machine position or every feed would turn
 * cross-court.
 */
export function resolveOrigin(feedOrigin, hand = 'R') {
  if (hand !== 'L' || !feedOrigin) return feedOrigin;
  if (feedOrigin.startsWith('L-')) return `R-${feedOrigin.slice(2)}`;
  if (feedOrigin.startsWith('R-')) return `L-${feedOrigin.slice(2)}`;
  return feedOrigin;
}

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
  rapidFire: {
    id: 'rapidFire', label: 'Rapid fire',
    note: 'The machine sweeps the table on a fast rhythm',
    // The machine never waits for the previous ball to clear — the next feed
    // comes on the beat regardless, like a real ball machine. The drill's
    // update gate reads this flag.
    nonstop: true,
    // Pace tracks the CONFIGURED interval (Custom Feed's slider), doubled.
    // A step-level interval override would pin the rhythm and make the
    // slider a lie; this keeps "non-stop, based on the configuration" true:
    // default 2.0 s → 1.0 s beat, slider floor 0.8 s → the 0.8 s clamp.
    paceMul: 2,
    // All-far origins keep the machine's glide on one straight rail (constant
    // z and height), and each origin fires near-straight at its paired wing.
    steps: [
      { wing: WINGS.BH,  depth: 'deep', feedOrigin: 'L-far' },
      { wing: WINGS.MID, depth: 'deep', feedOrigin: 'center-far' },
      { wing: WINGS.FH,  depth: 'deep', feedOrigin: 'R-far' },
      { wing: WINGS.MID, depth: 'deep', feedOrigin: 'center-far' },
    ],
  },
});

// Rapid Fire is deliberately NOT in this order: it powers the Practice
// menu's Reaction intent (menuModel's PRACTICE_ITEMS) rather than appearing
// in the Movement list, so this order stays the eight classics. spinMix
// (below) powers the Spin intent and is likewise excluded.
export const PATTERN_ORDER = Object.freeze([
  'falkenberg', 'twoPoint', 'figureEight', 'middleWide',
  'shortLong', 'pivot', 'wideWide', 'pushBlock',
]);

// The Spin practice sequence. Every step feeds the SAME spot (middle, deep)
// so the only thing that varies is the spin — reading it is the whole drill.
// Not in PATTERN_ORDER: it is a Practice intent, not a footwork classic. In
// random mode the M10 curriculum tuner steers the draw toward whichever spin
// the player keeps missing, which is the drill adapting to the player rather
// than the player picking a preset.
export const SPIN_MIX = Object.freeze({
  id: 'spinMix', label: 'Spin mix',
  note: 'Same ball, different spin — read it before it bounces',
  steps: [
    { wing: WINGS.MID, depth: 'deep',      spinType: 'top' },
    { wing: WINGS.MID, depth: 'deep',      spinType: 'back',   speedMul: 0.85 },
    { wing: WINGS.MID, depth: 'deep',      spinType: 'side-L' },
    { wing: WINGS.MID, depth: 'deep',      spinType: 'side-R' },
    { wing: WINGS.MID, depth: 'half-long', spinType: 'none' },
  ],
});

export function getPattern(id) {
  if (id === 'spinMix') return SPIN_MIX;
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
  // A step may move the machine itself (Rapid Fire's sweep) or set its own
  // pace; both are handedness-resolved / clamped like every other field.
  if (step.feedOrigin) next.feedOrigin = resolveOrigin(step.feedOrigin, hand);
  const rawInterval = step.interval !== undefined ? step.interval : base.interval;
  // Pace multiplier shortens the gap between balls; M2 specifies 0.6–1.4.
  next.interval = (paceMul && paceMul !== 1) ? rawInterval / paceMul : rawInterval;
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
  constructor(pattern, baseConfig, {
    hand = 'R', paceMul = null, random = false, rng = Math.random,
    // M10 hook: a function returning one weight per step, read at each random
    // draw. The curriculum tuner supplies it so the draw can be steered toward
    // the steps sitting at the edge of the player's ability; null keeps the
    // draw uniform. A function rather than an array because the weights move
    // every resample and the runner must not hold a stale copy.
    stepWeights = null,
  } = {}) {
    this.pattern = typeof pattern === 'string' ? getPattern(pattern) : pattern;
    this.base = validateConfig(baseConfig);
    this.hand = hand;
    // An explicit paceMul wins; otherwise the pattern's own default (Rapid
    // Fire doubles the configured rhythm); otherwise no scaling.
    this.paceMul = paceMul ?? this.pattern.paceMul ?? 1;
    // M2: "Random Mode — interleaved placement/spin within user-set bounds.
    // DEFAULT after basics — random > blocked practice for retention."
    // Same steps, drawn in random order rather than in sequence.
    this.random = random;
    this.rng = rng;
    this.stepWeights = stepWeights;
    this.index = 0;
    // Random draws are memoized per ball index so stepFor(i) is idempotent:
    // the drill previews ball i's origin (to glide the machine there), the
    // HUD renders describeNext(i) every frame, and the engine finally feeds
    // ball i — all three must see the SAME step without draining the shared
    // rng stream that solveFeed's scatter depends on for reproducibility.
    this._stepCache = new Map();
  }

  get stepCount() { return this.pattern.steps.length; }

  /** Index into pattern.steps that ball `i` uses. Idempotent per `i`. */
  stepIndexFor(i) {
    const steps = this.pattern.steps;
    if (!this.random) return i % steps.length;
    if (!this._stepCache.has(i)) {
      this._stepCache.set(i, this._drawStepIndex());
      // Bound the memo. Only the current ball and the glide/HUD preview of
      // the next one are ever re-read, so evicting the oldest entry can never
      // change a step a caller still depends on — an infinite drill would
      // otherwise grow this map for its whole run.
      if (this._stepCache.size > STEP_CACHE_MAX) {
        this._stepCache.delete(this._stepCache.keys().next().value);
      }
    }
    return this._stepCache.get(i);
  }

  // One rng draw per ball, weighted or not — the stream must advance by the
  // same amount either way or toggling the tuner would desynchronise replays.
  _drawStepIndex() {
    const steps = this.pattern.steps;
    const r = this.rng();
    const w = this.stepWeights ? this.stepWeights() : null;
    if (Array.isArray(w) && w.length === steps.length) {
      let total = 0;
      for (const x of w) total += x > 0 ? x : 0;
      if (total > 0) {
        let acc = 0;
        for (let k = 0; k < w.length; k++) {
          acc += Math.max(0, w[k] || 0) / total;
          if (r <= acc) return k;
        }
        return steps.length - 1;
      }
    }
    return Math.floor(r * steps.length);
  }

  /** The step that ball `i` should use. */
  stepFor(i) {
    return this.pattern.steps[this.stepIndexFor(i)];
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
