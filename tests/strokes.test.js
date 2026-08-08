// M2 Stroke Isolation + Footwork.
//
// The classification bands are the load-bearing part: M2 scores a ball as a
// success only when the player produced the RIGHT stroke, so a classifier that
// guesses confidently is worse than one that abstains.

const THREE = require('three');

const {
  STROKES, STROKE_ORDER, STROKE_BANDS, STROKE_FEEDS,
  classifyStroke, strokeFeedConfig,
  FootworkRunner, FOOTWORK_PATTERNS, FOOTWORK_LIMITS, tempoToInterval,
} = require('../js/modes/training/strokes.js');
const { defaultConfig, validateConfig } = require('../js/modes/training/drillConfig.js');
const { mulberry32 } = require('../js/util/rng.js');

// A contact in the middle of a stroke's band, for round-trip checks.
const midContact = (stroke) => {
  const b = STROKE_BANDS[stroke];
  const ratio = (b.ratio[0] + b.ratio[1]) / 2;
  const normalSpeed = (b.normal[0] + b.normal[1]) / 2;
  return { normalSpeed, tangentSpeed: ratio * normalSpeed };
};

describe('stroke classification', () => {
  test('every stroke is recognised from the centre of its own band', () => {
    for (const stroke of STROKE_ORDER) {
      // A flick shares the loop's signature exactly, so it needs the
      // positional context that actually distinguishes it.
      const ctx = STROKE_BANDS[stroke].needsShortBall ? { incomingDepth: 'short' } : {};
      const got = classifyStroke(midContact(stroke), ctx);
      expect(got.stroke).toBe(stroke);
      expect(got.confidence).toBeGreaterThan(0.7);
    }
  });

  test('a flick is not claimed when there is no short-ball context', () => {
    // Guessing between flick and loop on band order would be a coin flip
    // presented as a measurement.
    const got = classifyStroke(midContact(STROKES.FLICK));
    expect(got.stroke).not.toBe(STROKES.FLICK);
    expect(got.scores[STROKES.FLICK]).toBe(0);
  });

  test('off a short ball, the same contact reads as a flick', () => {
    const flat = classifyStroke(midContact(STROKES.FLICK));
    const short = classifyStroke(midContact(STROKES.FLICK), { incomingDepth: 'short' });
    expect(flat.stroke).toBe(STROKES.LOOP);
    expect(short.stroke).toBe(STROKES.FLICK);
  });

  test('a brushed contact is a loop, not a drive', () => {
    // Mostly tangential with real pace.
    const r = classifyStroke({ normalSpeed: 4.0, tangentSpeed: 10.0 });
    expect(r.stroke).toBe(STROKES.LOOP);
  });

  test('a flat hard contact is a drive, not a loop', () => {
    const r = classifyStroke({ normalSpeed: 5.0, tangentSpeed: 1.0 });
    expect(r.stroke).toBe(STROKES.DRIVE);
  });

  test('pace separates a push from a chop at a similar ratio', () => {
    // The ratio alone cannot tell these apart — both are slow and brushed —
    // so the classifier must be using the normal speed too.
    const push = classifyStroke({ normalSpeed: 1.2, tangentSpeed: 1.8 });
    const chop = classifyStroke({ normalSpeed: 1.2, tangentSpeed: 4.2 });
    expect(push.stroke).not.toBe(chop.stroke);
  });

  test('pace separates a drive from a smash at the same ratio', () => {
    const drive = classifyStroke({ normalSpeed: 4.0, tangentSpeed: 1.0 });
    const smash = classifyStroke({ normalSpeed: 14.0, tangentSpeed: 3.5 });
    expect(drive.stroke).toBe(STROKES.DRIVE);
    expect(smash.stroke).toBe(STROKES.SMASH);
  });

  test('a graze with no normal component is not attributed to any stroke', () => {
    // Naming a stroke here would be invention.
    expect(classifyStroke({ normalSpeed: 0, tangentSpeed: 5 }).stroke).toBeNull();
    expect(classifyStroke({ normalSpeed: 1e-9, tangentSpeed: 5 }).stroke).toBeNull();
  });

  test('nonsense input abstains rather than throwing', () => {
    for (const c of [null, undefined, {}, { normalSpeed: NaN, tangentSpeed: 1 },
      { normalSpeed: 3, tangentSpeed: NaN }]) {
      expect(() => classifyStroke(c)).not.toThrow();
      expect(classifyStroke(c).stroke).toBeNull();
    }
  });

  test('a contact far outside every band abstains', () => {
    // Confidently mislabelling a weird contact is worse than saying nothing.
    const r = classifyStroke({ normalSpeed: 0.05, tangentSpeed: 80 });
    expect(r.stroke).toBeNull();
    expect(r.confidence).toBeLessThan(0.34);
  });

  test('confidence is reported so a marginal contact can be judged', () => {
    const strong = classifyStroke(midContact(STROKES.LOOP));
    // Well outside every band on the pace axis: slow but heavily brushed
    // beyond even a chop.
    const weak = classifyStroke({ normalSpeed: 0.3, tangentSpeed: 4.5 });
    expect(strong.confidence).toBe(1);
    expect(weak.confidence).toBeLessThan(strong.confidence);
  });

  test('the ratio is reported for display', () => {
    expect(classifyStroke({ normalSpeed: 2, tangentSpeed: 4 }).ratio).toBeCloseTo(2, 3);
  });

  test('scores are given for every stroke, not just the winner', () => {
    const r = classifyStroke(midContact(STROKES.PUSH));
    expect(Object.keys(r.scores).sort()).toEqual([...STROKE_ORDER].sort());
  });
});

describe('stroke feeds', () => {
  test('every stroke has a matching incoming ball defined', () => {
    // You cannot practise a push against a topspin loop, so the feed follows
    // from the stroke.
    for (const stroke of STROKE_ORDER) {
      expect(STROKE_FEEDS[stroke]).toBeDefined();
    }
  });

  test('a push is fed backspin and short; a block is fed fast topspin deep', () => {
    expect(STROKE_FEEDS[STROKES.PUSH].spinType).toBe('back');
    expect(STROKE_FEEDS[STROKES.PUSH].depth).toBe('short');
    expect(STROKE_FEEDS[STROKES.BLOCK].spinType).toBe('top');
    expect(STROKE_FEEDS[STROKES.BLOCK].depth).toBe('deep');
  });

  test('a smash is set up with a lob, not a fast flat ball', () => {
    expect(STROKE_FEEDS[STROKES.SMASH].arc).toBe('lob');
  });

  test('every stroke feed produces a valid config', () => {
    for (const stroke of STROKE_ORDER) {
      const c = validateConfig(strokeFeedConfig(defaultConfig(), stroke));
      expect(c).toEqual(validateConfig(c));
    }
  });

  test('an unknown stroke leaves the base config alone', () => {
    const base = defaultConfig();
    expect(strokeFeedConfig(base, 'nonsense')).toBe(base);
  });
});

describe('footwork', () => {
  const env = {
    tableBox: new THREE.Box3(
      new THREE.Vector3(-0.7625, -0.001, -1.37),
      new THREE.Vector3(0.7625, 0.001, 1.37),
    ),
    tableSurfaceY: 0, ballRadius: 0.02,
  };
  const base = defaultConfig();

  test('tempo converts feeds-per-minute to an interval', () => {
    expect(tempoToInterval(60)).toBeCloseTo(1, 6);
    expect(tempoToInterval(30)).toBeCloseTo(2, 6);
  });

  test('tempo is clamped to the specified 20–60 range', () => {
    expect(tempoToInterval(999)).toBeCloseTo(60 / 60, 6);
    expect(tempoToInterval(1)).toBeCloseTo(60 / 20, 6);
    expect(tempoToInterval('nonsense')).toBeCloseTo(60 / FOOTWORK_LIMITS.tempo.default, 6);
  });

  test('2-point alternates strictly side to side', () => {
    const r = new FootworkRunner(base, { pattern: '2-point', width: 1.2, env });
    const xs = [0, 1, 2, 3].map((i) => r.configFor(i).placement.x);
    expect(Math.sign(xs[0])).toBe(-1);
    expect(Math.sign(xs[1])).toBe(1);
    expect(xs[0]).toBeCloseTo(xs[2], 6);
  });

  test('3-point adds the middle', () => {
    const r = new FootworkRunner(base, { pattern: '3-point', width: 1.2, env });
    const xs = [0, 1, 2].map((i) => r.configFor(i).placement.x);
    expect(xs[1]).toBeCloseTo(0, 6);
    expect(new Set(xs.map(Math.sign)).size).toBe(3);
  });

  test('random still crosses the table every ball', () => {
    // Pure random placement lets several balls land on the same side, which
    // stops being a footwork drill.
    const r = new FootworkRunner(base, { pattern: 'random', width: 1.2, env, rng: mulberry32(4) });
    const signs = Array.from({ length: 12 }, (_, i) => Math.sign(r.configFor(i).placement.x));
    for (let i = 1; i < signs.length; i++) expect(signs[i]).not.toBe(signs[i - 1]);
  });

  test('random varies the stretch rather than repeating one width', () => {
    const r = new FootworkRunner(base, { pattern: 'random', width: 1.4, env, rng: mulberry32(6) });
    const mags = Array.from({ length: 10 }, (_, i) => Math.abs(r.configFor(i).placement.x));
    expect(new Set(mags.map((m) => m.toFixed(3))).size).toBeGreaterThan(1);
  });

  test('width is clamped to the specified 0.6–1.4 m range', () => {
    expect(new FootworkRunner(base, { width: 99, env }).width).toBe(1.4);
    expect(new FootworkRunner(base, { width: 0.1, env }).width).toBe(0.6);
  });

  test('placements stay on the table even at maximum width', () => {
    const r = new FootworkRunner(base, { pattern: '2-point', width: 1.4, env });
    for (let i = 0; i < 8; i++) {
      const c = validateConfig(r.configFor(i));
      expect(Math.abs(c.placement.x)).toBeLessThanOrEqual(0.7625);
      expect(c.placement.z).toBeGreaterThan(0);
    }
  });

  test('it uses free placement, not the 3x3 grid', () => {
    // Snapping to zones would quantise width to three fixed values and lose
    // the attribute entirely.
    const c = new FootworkRunner(base, { width: 0.9, env }).configFor(0);
    expect(c.placement.kind).toBe('free');
  });

  test('an unknown pattern falls back to 2-point', () => {
    expect(new FootworkRunner(base, { pattern: 'nonsense', env }).pattern).toBe('2-point');
  });

  test('attach installs itself as the engine config provider', () => {
    const calls = [];
    new FootworkRunner(base, { env }).attach({ setConfigProvider: (fn) => calls.push(fn) });
    expect(calls).toHaveLength(1);
  });

  test('every listed pattern is usable', () => {
    for (const pattern of FOOTWORK_PATTERNS) {
      const r = new FootworkRunner(base, { pattern, env, rng: mulberry32(1) });
      expect(() => validateConfig(r.configFor(0))).not.toThrow();
      expect(typeof r.describeNext(0)).toBe('string');
    }
  });

  test('it works without an env, using a safe default width', () => {
    const r = new FootworkRunner(base, { width: 1.4 });
    const c = validateConfig(r.configFor(0));
    expect(Math.abs(c.placement.x)).toBeLessThanOrEqual(0.72);
  });
});
