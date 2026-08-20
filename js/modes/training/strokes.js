// M2 Stroke Isolation and Footwork.
//
// Both are feed generators plus a success rule, sharing the M1 feeder exactly
// as patterns do. Neither owns physics or timing.
//
// ── STROKE CLASSIFICATION ───────────────────────────────────────────────────
//
// M2: "success = correct stroke class detected from contact signature (u_t/v_n
// ratio bands per stroke)". u_t is the tangential slip at contact, v_n the
// normal closing speed — both come straight out of the impulse solve, so the
// classifier and the physics cannot disagree about what the contact was.
//
// The ratio alone is not enough to name a stroke: a push and a chop are both
// mostly-tangential with backspin, and what separates them is pace. So the
// bands below are over (ratio, normalSpeed) together, and the classifier
// reports a confidence so a marginal contact can be scored as "unclear"
// rather than silently attributed to whichever band it fell nearest.

import { zoneForDepth } from './drillConfig.js';

export const STROKES = Object.freeze({
  PUSH: 'push',
  DRIVE: 'drive',
  LOOP: 'loop',
  BLOCK: 'block',
  CHOP: 'chop',
  FLICK: 'flick',
  SMASH: 'smash',
});

export const STROKE_ORDER = Object.freeze([
  STROKES.PUSH, STROKES.DRIVE, STROKES.LOOP,
  STROKES.BLOCK, STROKES.CHOP, STROKES.FLICK, STROKES.SMASH,
]);

/**
 * Bands per stroke.
 *
 * `ratio` is u_t/v_n; `normal` is the normal closing speed in m/s. Ranges
 * overlap deliberately — real strokes are not disjoint — and the classifier
 * scores every band rather than taking the first match.
 */
export const STROKE_BANDS = Object.freeze({
  // Slow, brushed, little drive through the ball.
  [STROKES.PUSH]:  { ratio: [0.6, 3.0], normal: [0.2, 2.5], label: 'Push',
                     depths: ['short', 'half-long'] },
  // The defensive block: almost no swing, the ball does the work.
  [STROKES.BLOCK]: { ratio: [0.0, 0.8], normal: [0.2, 2.0], label: 'Block',
                     depths: ['half-long', 'deep'] },
  // Flat and hard through the ball.
  [STROKES.DRIVE]: { ratio: [0.0, 1.0], normal: [2.5, 7.0], label: 'Drive',
                     depths: ['half-long', 'deep'] },
  // Heavy brush with real pace — the defining topspin stroke.
  [STROKES.LOOP]:  { ratio: [1.2, 4.0], normal: [2.0, 6.0], label: 'Loop',
                     depths: ['half-long', 'deep'] },
  // Heavy backspin, slow, steeply brushed, played back from the table.
  [STROKES.CHOP]:  { ratio: [2.0, 6.0], normal: [0.5, 3.0], label: 'Chop',
                     depths: ['deep'] },
  // Short quick wrist snap over the table.
  //
  // `depths: ['short']` is load-bearing, not a hint. A flick's contact
  // signature overlaps BOTH the loop's and the chop's — all three are brushed
  // with moderate pace — so it cannot be separated by (ratio, normal) alone.
  // What makes a flick a flick is that it is played over the table off a short
  // ball, which is positional. Without that context the classifier would be
  // picking between three strokes on band iteration order, i.e. arbitrarily.
  [STROKES.FLICK]: { ratio: [1.0, 3.5], normal: [1.5, 4.5], label: 'Flick',
                     depths: ['short'], needsShortBall: true },
  // Everything through the ball, as hard as possible.
  [STROKES.SMASH]: { ratio: [0.0, 0.9], normal: [7.0, 30.0], label: 'Smash',
                     depths: ['half-long', 'deep'] },
});

// Below this confidence the contact is not attributed to any stroke. Scoring
// an ambiguous contact as a success would tell the player they performed a
// stroke they may not have.
const MIN_CONFIDENCE = 0.34;

function bandScore(value, [lo, hi]) {
  if (value >= lo && value <= hi) return 1;
  const span = Math.max(hi - lo, 1e-6);
  const dist = value < lo ? (lo - value) : (value - hi);
  return Math.max(0, 1 - dist / span);
}

/**
 * Classify a contact.
 *
 * `context.incomingDepth` disambiguates the strokes that share a signature.
 * It is optional: without it, strokes marked `needsShortBall` are excluded
 * rather than guessed at, so the classifier degrades to "the stroke families
 * I can actually tell apart from contact alone".
 *
 * @param {{tangentSpeed:number, normalSpeed:number}} contact
 * @param {{incomingDepth?:string}} [context]
 * @returns {{stroke:string|null, confidence:number, ratio:number, scores:object}}
 */
export function classifyStroke(contact, context = {}) {
  if (!contact) return { stroke: null, confidence: 0, ratio: 0, scores: {} };
  const vn = Number(contact.normalSpeed);
  const ut = Number(contact.tangentSpeed);
  if (!Number.isFinite(vn) || !Number.isFinite(ut) || vn <= 1e-4) {
    // No normal component means no meaningful strike — a graze, or a contact
    // the solver could not resolve. Reporting a stroke here would be invention.
    return { stroke: null, confidence: 0, ratio: 0, scores: {} };
  }
  const ratio = ut / vn;

  const depth = context.incomingDepth || null;
  const scores = {};
  let best = null;
  let bestScore = 0;
  for (const [stroke, band] of Object.entries(STROKE_BANDS)) {
    // Both axes must agree, so the score is the product rather than a mean:
    // a contact with the right ratio but wildly wrong pace is not that stroke.
    let s = bandScore(ratio, band.ratio) * bandScore(vn, band.normal);

    if (band.needsShortBall && depth !== 'short') {
      // Not a candidate: its signature is indistinguishable from other
      // strokes, so without the context that separates it, claiming it would
      // be a coin flip dressed as a measurement.
      s = 0;
    } else if (depth && band.depths && !band.depths.includes(depth)) {
      // Implausible for this incoming ball. Damped rather than zeroed: a
      // player CAN loop a short ball, it is just not the likeliest reading,
      // and a better-fitting signature should still be able to win.
      s *= 0.55;
    }

    scores[stroke] = Math.round(s * 1000) / 1000;
    if (s > bestScore) { bestScore = s; best = stroke; }
  }

  return {
    stroke: bestScore >= MIN_CONFIDENCE ? best : null,
    confidence: Math.round(bestScore * 1000) / 1000,
    ratio: Math.round(ratio * 1000) / 1000,
    scores,
  };
}

/**
 * The incoming ball each stroke needs to practise against. M2: "the feeder
 * serves the matching incoming ball type" — you cannot practise a push
 * against a topspin loop, so the drill's feed follows from the stroke.
 */
export const STROKE_FEEDS = Object.freeze({
  [STROKES.PUSH]:  { speed: 6,  spinType: 'back', spinMagnitude: 90,  depth: 'short',     arc: 'flat' },
  [STROKES.BLOCK]: { speed: 12, spinType: 'top',  spinMagnitude: 140, depth: 'deep',      arc: 'flat' },
  [STROKES.DRIVE]: { speed: 9,  spinType: 'none', spinMagnitude: 0,   depth: 'half-long', arc: 'medium' },
  [STROKES.LOOP]:  { speed: 7,  spinType: 'back', spinMagnitude: 120, depth: 'half-long', arc: 'medium' },
  [STROKES.CHOP]:  { speed: 10, spinType: 'top',  spinMagnitude: 150, depth: 'deep',      arc: 'medium' },
  [STROKES.FLICK]: { speed: 6,  spinType: 'back', spinMagnitude: 70,  depth: 'short',     arc: 'flat' },
  [STROKES.SMASH]: { speed: 8,  spinType: 'top',  spinMagnitude: 60,  depth: 'half-long', arc: 'lob' },
});

export function strokeFeedConfig(base, stroke) {
  const over = STROKE_FEEDS[stroke];
  if (!over) return base;
  // The zone row is authoritative for landing depth, so the feed's depth has
  // to be folded into the zone. Keep the base's column (wing) if it has one.
  const col = base?.placement?.kind === 'zone' ? (base.placement.zone - 1) % 3 : 1;
  return {
    ...base, ...over,
    placement: { kind: 'zone', zone: zoneForDepth(over.depth, col) },
  };
}

// --- Footwork ---------------------------------------------------------------

// M2: "width (0.6–1.4 m), tempo (BPM-style 20–60 feeds/min), pattern
// (2-point / 3-point / random)".
export const FOOTWORK_PATTERNS = Object.freeze(['2-point', '3-point', 'random']);
export const FOOTWORK_LIMITS = Object.freeze({
  width: { min: 0.6, max: 1.4, default: 1.0 },
  tempo: { min: 20, max: 60, default: 32 },      // feeds per minute
});

/** Feeds-per-minute → the interval the feeder wants, in seconds. */
export function tempoToInterval(feedsPerMinute) {
  const t = Math.min(FOOTWORK_LIMITS.tempo.max,
    Math.max(FOOTWORK_LIMITS.tempo.min, Number(feedsPerMinute) || FOOTWORK_LIMITS.tempo.default));
  return 60 / t;
}

/**
 * Footwork feed generator.
 *
 * Width is expressed in metres between the two outer targets and converted to
 * a FREE placement rather than a zone, because the whole point of the mode is
 * a continuously adjustable stretch — snapping to the 3×3 grid would quantise
 * it to three fixed widths and lose the attribute.
 */
export class FootworkRunner {
  constructor(baseConfig, {
    pattern = '2-point', width = FOOTWORK_LIMITS.width.default,
    tempo = FOOTWORK_LIMITS.tempo.default, rng = Math.random, env = null,
  } = {}) {
    this.base = baseConfig;
    this.pattern = FOOTWORK_PATTERNS.includes(pattern) ? pattern : '2-point';
    this.width = Math.min(FOOTWORK_LIMITS.width.max,
      Math.max(FOOTWORK_LIMITS.width.min, Number(width) || FOOTWORK_LIMITS.width.default));
    this.interval = tempoToInterval(tempo);
    this.rng = rng;
    this.env = env;
  }

  /** Lateral offsets, in metres, for this pattern. */
  get offsets() {
    const half = this.width / 2;
    if (this.pattern === '3-point') return [-half, 0, half];
    return [-half, half];
  }

  offsetFor(i) {
    const o = this.offsets;
    if (this.pattern === 'random') {
      // Alternate SIDES but vary the amount, so the player still crosses the
      // table every ball. Pure random placement lets several balls land on the
      // same side, which stops being a footwork drill.
      const side = i % 2 === 0 ? -1 : 1;
      const half = this.width / 2;
      return side * (half * (0.55 + 0.45 * this.rng()));
    }
    return o[i % o.length];
  }

  configFor(i) {
    const x = this.offsetFor(i);
    // Clamp into the table when an env is supplied; the validator's generous
    // bounds would otherwise let a 1.4 m width sit off the side.
    const limit = this.env && this.env.tableBox
      ? (this.env.tableBox.max.x - 0.04)
      : 0.72;
    const clampedX = Math.min(limit, Math.max(-limit, x));
    return {
      ...this.base,
      interval: this.interval,
      placement: { kind: 'free', x: clampedX, z: this.footworkZ() },
    };
  }

  footworkZ() {
    if (!this.env || !this.env.tableBox) return 1.0;
    const box = this.env.tableBox;
    const centerZ = (box.min.z + box.max.z) / 2;
    // Deep-ish, so the player is moving along the baseline rather than
    // reaching in over the table.
    return centerZ + (box.max.z - centerZ) * 0.72;
  }

  attach(engine) {
    engine.setConfigProvider((i) => this.configFor(i));
    return this;
  }

  describeNext(i) {
    const x = this.offsetFor(i);
    return x < 0 ? 'wide left' : (x > 0 ? 'wide right' : 'middle');
  }
}
