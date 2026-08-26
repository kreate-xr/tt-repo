// M2 Pattern Drills, progression ladders, and the M10 curriculum tuner.
//
// TEST M2 (spec): "ladder auto-advance/drop logic unit-tested on synthetic
// success streams."
// TEST M10 (spec): "synthetic learner with known skill surface converges:
// ≥ 70% of feeds inside its 60–75% band within 3 simulated sessions."

const {
  PATTERNS, PATTERN_ORDER, WINGS, getPattern,
  resolveWing, wingColumn, resolveOrigin, buildStepConfig, PatternRunner,
} = require('../js/modes/training/patterns.js');
const {
  Ladder, CurriculumTuner, TIERS, TIER_SETTINGS,
  WINDOW, ADVANCE_AT, DROP_BELOW, BAND_LOW, BAND_HIGH, MAX_SHIFT, RESAMPLE_EVERY,
} = require('../js/modes/training/ladder.js');
const { defaultConfig, validateConfig } = require('../js/modes/training/drillConfig.js');
const { mulberry32 } = require('../js/util/rng.js');

describe('patterns', () => {
  test('ships at least the eight classics M2 asks for', () => {
    expect(PATTERN_ORDER.length).toBeGreaterThanOrEqual(8);
    for (const id of PATTERN_ORDER) {
      expect(PATTERNS[id]).toBeDefined();
      expect(PATTERNS[id].steps.length).toBeGreaterThan(1);
    }
  });

  test('Falkenberg is BH → middle → wide FH', () => {
    expect(PATTERNS.falkenberg.steps.map((s) => s.wing))
      .toEqual([WINGS.BH, WINGS.MID, WINGS.FH]);
  });

  test('getPattern falls back rather than returning undefined', () => {
    expect(getPattern('nonsense')).toBe(PATTERNS.falkenberg);
  });

  test('every step names a wing the resolver understands', () => {
    for (const id of PATTERN_ORDER) {
      for (const step of PATTERNS[id].steps) {
        expect(Object.values(WINGS)).toContain(step.wing);
      }
    }
  });
});

describe('handedness', () => {
  // The player faces −z, so their left is −x: a right-hander's backhand is
  // the −x column. Left-handers must get the mirror without duplicating any
  // pattern definition.
  test('backhand and forehand swap sides for a left-hander', () => {
    expect(wingColumn(WINGS.BH, 'R')).toBe(0);
    expect(wingColumn(WINGS.FH, 'R')).toBe(2);
    expect(wingColumn(WINGS.BH, 'L')).toBe(2);
    expect(wingColumn(WINGS.FH, 'L')).toBe(0);
  });

  test('middle is the middle for everyone', () => {
    expect(wingColumn(WINGS.MID, 'R')).toBe(1);
    expect(wingColumn(WINGS.MID, 'L')).toBe(1);
  });

  test('resolveWing maps wing and depth onto the 3x3 grid', () => {
    expect(resolveWing(WINGS.BH, 'short', 'R')).toBe(1);
    expect(resolveWing(WINGS.MID, 'half-long', 'R')).toBe(5);
    expect(resolveWing(WINGS.FH, 'deep', 'R')).toBe(9);
  });

  test('a left-hander gets mirrored zones for the same pattern', () => {
    const base = defaultConfig();
    const r = buildStepConfig(base, { wing: WINGS.BH, depth: 'deep' }, { hand: 'R' });
    const l = buildStepConfig(base, { wing: WINGS.BH, depth: 'deep' }, { hand: 'L' });
    expect(r.placement.zone).not.toBe(l.placement.zone);
  });
});

describe('buildStepConfig', () => {
  const base = validateConfig({ ...defaultConfig(), speed: 10, interval: 2 });

  test('a step only overrides what it names', () => {
    const c = buildStepConfig(base, { wing: WINGS.FH, depth: 'deep' });
    expect(c.speed).toBe(10);
    expect(c.spinType).toBe(base.spinType);
  });

  test('speedMul scales speed and is clamped to the legal range', () => {
    expect(buildStepConfig(base, { wing: WINGS.FH, speedMul: 1.2 }).speed).toBeCloseTo(12, 6);
    expect(buildStepConfig(base, { wing: WINGS.FH, speedMul: 99 }).speed).toBe(25);
  });

  test('paceMul shortens the interval and stays in range', () => {
    expect(buildStepConfig(base, { wing: WINGS.FH }, { paceMul: 1.4 }).interval)
      .toBeCloseTo(2 / 1.4, 3);
    expect(buildStepConfig(base, { wing: WINGS.FH }, { paceMul: 99 }).interval).toBe(0.8);
  });

  test('a step cannot inject an out-of-range value', () => {
    const c = buildStepConfig(base, { wing: WINGS.FH, spinMagnitude: 9000 });
    expect(c.spinMagnitude).toBeLessThanOrEqual(400);
  });

  test('a step can move the machine itself', () => {
    const c = buildStepConfig(base, { wing: WINGS.BH, feedOrigin: 'L-far' });
    expect(c.feedOrigin).toBe('L-far');
    // Absent → the base config's origin is untouched.
    expect(buildStepConfig(base, { wing: WINGS.BH }).feedOrigin).toBe(base.feedOrigin);
  });

  test('a garbage step origin is validated back to the default', () => {
    const c = buildStepConfig(base, { wing: WINGS.BH, feedOrigin: 'moon-base' });
    expect(c.feedOrigin).toBe(base.feedOrigin);
  });

  test('a step can carry its own interval, still scaled by paceMul and clamped', () => {
    expect(buildStepConfig(base, { wing: WINGS.FH, interval: 1.1 }).interval)
      .toBeCloseTo(1.1, 6);
    expect(buildStepConfig(base, { wing: WINGS.FH, interval: 1.4 }, { paceMul: 1.4 }).interval)
      .toBeCloseTo(1.0, 3);
    // Below the floor — whether from the step itself or paceMul — clamps.
    expect(buildStepConfig(base, { wing: WINGS.FH, interval: 0.1 }).interval).toBe(0.8);
    expect(buildStepConfig(base, { wing: WINGS.FH, interval: 1.1 }, { paceMul: 1.4 }).interval).toBe(0.8);
  });
});

describe('resolveOrigin', () => {
  test('mirrors L and R for a left-hander, center stays put', () => {
    expect(resolveOrigin('L-far', 'L')).toBe('R-far');
    expect(resolveOrigin('R-near', 'L')).toBe('L-near');
    expect(resolveOrigin('center-far', 'L')).toBe('center-far');
  });

  test('right-handers get the origin as written', () => {
    expect(resolveOrigin('L-far', 'R')).toBe('L-far');
    expect(resolveOrigin('R-far')).toBe('R-far');
  });

  test('a left-hander step origin mirrors through buildStepConfig', () => {
    const base = defaultConfig();
    const c = buildStepConfig(base, { wing: WINGS.BH, feedOrigin: 'L-far' }, { hand: 'L' });
    expect(c.feedOrigin).toBe('R-far');
  });
});

describe('rapid fire pattern', () => {
  test('is shipped, but launches from the Drills menu, not the pattern list', () => {
    expect(PATTERNS.rapidFire).toBeDefined();
    // Not in PATTERN_ORDER: the Patterns screen lists only the classics;
    // Rapid Fire has its own row in DRILL_ITEMS one level up.
    expect(PATTERN_ORDER).not.toContain('rapidFire');
  });

  test('produces valid configs like any listed pattern', () => {
    // It skips the PATTERN_ORDER validity loop above, so cover it here.
    const r = new PatternRunner('rapidFire', defaultConfig());
    for (let i = 0; i < 8; i++) {
      const c = r.configFor(i);
      expect(c).toEqual(validateConfig(c));
    }
  });

  test('sweeps the machine across all three far positions', () => {
    const origins = PATTERNS.rapidFire.steps.map((s) => s.feedOrigin);
    expect(origins).toContain('L-far');
    expect(origins).toContain('center-far');
    expect(origins).toContain('R-far');
    for (const step of PATTERNS.rapidFire.steps) {
      // All-far origins keep the glide on one straight rail.
      expect(step.feedOrigin.endsWith('-far')).toBe(true);
    }
  });

  test('feeds non-stop rather than waiting for the previous ball', () => {
    expect(PATTERNS.rapidFire.nonstop).toBe(true);
    // The classics keep the one-ball-at-a-time gate.
    expect(PATTERNS.falkenberg.nonstop).toBeUndefined();
  });

  test('pace follows the configured interval, doubled', () => {
    // No step-level interval override: the Custom Feed slider must stay in
    // control of the rhythm ("non-stop, based on the configuration").
    for (const step of PATTERNS.rapidFire.steps) {
      expect(step.interval).toBeUndefined();
    }
    const base = validateConfig({ ...defaultConfig(), interval: 2.0 });
    const r = new PatternRunner('rapidFire', base);
    expect(r.configFor(0).interval).toBeCloseTo(1.0, 6);
    // The slider floor still holds at its fastest setting.
    const fast = new PatternRunner('rapidFire', validateConfig({ ...base, interval: 0.8 }));
    expect(fast.configFor(0).interval).toBe(0.8);
  });

  test('an explicit paceMul overrides the pattern default', () => {
    const base = validateConfig({ ...defaultConfig(), interval: 2.0 });
    const r = new PatternRunner('rapidFire', base, { paceMul: 1 });
    expect(r.configFor(0).interval).toBeCloseTo(2.0, 6);
  });

  test('each origin fires near-straight at its paired wing (right-hander)', () => {
    // L origin (−x) pairs with the BH column (−x for hand R), and so on —
    // the sweep should never command a cross-court feed.
    const colForOrigin = { 'L-far': 0, 'center-far': 1, 'R-far': 2 };
    for (const step of PATTERNS.rapidFire.steps) {
      expect(wingColumn(step.wing, 'R')).toBe(colForOrigin[step.feedOrigin]);
    }
  });
});

describe('PatternRunner', () => {
  const base = defaultConfig();

  test('cycles its steps in order', () => {
    const r = new PatternRunner('falkenberg', base);
    const zones = [0, 1, 2, 3, 4, 5].map((i) => r.configFor(i).placement.zone);
    expect(zones[0]).toBe(zones[3]);   // wraps after 3 steps
    expect(zones[1]).toBe(zones[4]);
    expect(zones[0]).not.toBe(zones[1]);
  });

  test('random mode still only plays steps from the pattern', () => {
    const r = new PatternRunner('falkenberg', base, { random: true, rng: mulberry32(5) });
    const legal = new Set(PATTERNS.falkenberg.steps
      .map((s) => resolveWing(s.wing, s.depth, 'R')));
    for (let i = 0; i < 60; i++) {
      expect(legal.has(r.configFor(i).placement.zone)).toBe(true);
    }
  });

  test('random mode does not simply repeat the sequence', () => {
    const seq = new PatternRunner('figureEight', base);
    const rnd = new PatternRunner('figureEight', base, { random: true, rng: mulberry32(9) });
    const a = Array.from({ length: 24 }, (_, i) => seq.configFor(i).placement.zone);
    const b = Array.from({ length: 24 }, (_, i) => rnd.configFor(i).placement.zone);
    expect(a).not.toEqual(b);
  });

  test('random mode is reproducible for a seed', () => {
    const mk = () => new PatternRunner('figureEight', base, { random: true, rng: mulberry32(3) });
    const a = Array.from({ length: 20 }, (_, i) => mk().configFor(i).placement.zone);
    const b = Array.from({ length: 20 }, (_, i) => mk().configFor(i).placement.zone);
    expect(a).toEqual(b);
  });

  test('every produced config is valid', () => {
    for (const id of PATTERN_ORDER) {
      const r = new PatternRunner(id, base, { paceMul: 1.4 });
      for (let i = 0; i < 12; i++) {
        const c = r.configFor(i);
        expect(c).toEqual(validateConfig(c));
      }
    }
  });

  test('random steps are memoized: repeated lookups do not drain the rng', () => {
    // The drill previews ball i's origin (machine glide), the HUD renders
    // describeNext(i) every frame, and the engine finally feeds ball i. All
    // three must see the SAME step, and none may consume an extra rng draw —
    // solveFeed's scatter shares the stream, so reproducibility depends on it.
    const zonesOf = (r, n) => Array.from({ length: n }, (_, i) => r.configFor(i).placement.zone);

    const clean = new PatternRunner('figureEight', base, { random: true, rng: mulberry32(11) });
    const expected = zonesOf(clean, 20);

    const hammered = new PatternRunner('figureEight', base, { random: true, rng: mulberry32(11) });
    for (let k = 0; k < 10; k++) hammered.describeNext(0);   // HUD spam
    hammered.configFor(0);                                   // glide preview
    expect(zonesOf(hammered, 20)).toEqual(expected);
  });

  test('configFor is idempotent per index in random mode', () => {
    const r = new PatternRunner('figureEight', base, { random: true, rng: mulberry32(7) });
    const first = r.configFor(3).placement.zone;
    expect(r.configFor(3).placement.zone).toBe(first);
    expect(r.configFor(3).placement.zone).toBe(first);
  });

  test('attach installs itself as the engine config provider', () => {
    const calls = [];
    const fakeEngine = { setConfigProvider: (fn) => calls.push(fn) };
    new PatternRunner('twoPoint', base).attach(fakeEngine);
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]).toBe('function');
  });
});

// --- TEST M2 ---------------------------------------------------------------

describe('TEST M2: ladder logic on synthetic success streams', () => {
  const feed = (ladder, results) => results.map((r) => ladder.record(r));
  const streak = (n, val) => Array.from({ length: n }, () => val);

  test('nothing is decided before a full window', () => {
    // Three lucky balls must not promote anyone.
    const l = new Ladder();
    const events = feed(l, streak(WINDOW - 1, true));
    expect(events.every((e) => !e.changed)).toBe(true);
    expect(l.tier).toBe('bronze');
  });

  test(`advances at ${ADVANCE_AT * 100}% over ${WINDOW} balls`, () => {
    const l = new Ladder();
    // 16/20 = 80%, exactly the threshold.
    feed(l, [...streak(16, true), ...streak(4, false)]);
    expect(l.tier).toBe('silver');
  });

  test('just under the threshold does not advance', () => {
    const l = new Ladder();
    feed(l, [...streak(15, true), ...streak(5, false)]);   // 75%
    expect(l.tier).toBe('bronze');
  });

  test(`drops below ${DROP_BELOW * 100}%`, () => {
    const l = new Ladder({ tier: 'gold' });
    feed(l, [...streak(7, true), ...streak(13, false)]);   // 35%
    expect(l.tier).toBe('silver');
  });

  test('exactly at the drop threshold does NOT drop', () => {
    const l = new Ladder({ tier: 'gold' });
    feed(l, [...streak(8, true), ...streak(12, false)]);   // 40%
    expect(l.tier).toBe('gold');
  });

  test('cannot advance past the top or drop below the bottom', () => {
    const top = new Ladder({ tier: 'diamond' });
    feed(top, streak(WINDOW, true));
    expect(top.tier).toBe('diamond');

    const bottom = new Ladder({ tier: 'bronze' });
    feed(bottom, streak(WINDOW, false));
    expect(bottom.tier).toBe('bronze');
  });

  test('the window resets on a tier change', () => {
    // Carrying results across a change would judge the new tier on balls
    // played at the old one — the classic way a ladder oscillates.
    const l = new Ladder();
    feed(l, streak(WINDOW, true));
    expect(l.tier).toBe('silver');
    expect(l.results).toHaveLength(0);
    expect(l.rate).toBe(0);
  });

  test('a steadily improving learner climbs to the top', () => {
    const l = new Ladder();
    for (let round = 0; round < 12; round++) feed(l, streak(WINDOW, true));
    expect(l.tier).toBe('diamond');
  });

  test('a struggling learner settles rather than falling forever', () => {
    const l = new Ladder({ tier: 'diamond' });
    for (let round = 0; round < 12; round++) feed(l, streak(WINDOW, false));
    expect(l.tier).toBe('bronze');
  });

  test('a player inside the band is left alone', () => {
    // 70% is the point of the exercise; moving them would be wrong.
    const l = new Ladder({ tier: 'silver' });
    for (let round = 0; round < 6; round++) {
      feed(l, [...streak(14, true), ...streak(6, false)]);
    }
    expect(l.tier).toBe('silver');
  });

  test('history records each review', () => {
    const l = new Ladder();
    feed(l, streak(WINDOW, true));
    feed(l, streak(WINDOW, false));
    expect(l.history).toHaveLength(2);
    expect(l.history[0].moved).toBe('advance');
  });

  test('tier settings get harder monotonically', () => {
    for (let i = 1; i < TIERS.length; i++) {
      const prev = TIER_SETTINGS[TIERS[i - 1]];
      const cur = TIER_SETTINGS[TIERS[i]];
      expect(cur.speedMul).toBeGreaterThanOrEqual(prev.speedMul);
      expect(cur.scatter).toBeGreaterThanOrEqual(prev.scatter);
    }
  });

  test('applyTo scales a config and keeps it legal', () => {
    const l = new Ladder({ tier: 'diamond' });
    const c = validateConfig(l.applyTo(defaultConfig()));
    expect(c.speed).toBeLessThanOrEqual(25);
    expect(c.interval).toBeGreaterThanOrEqual(0.8);
  });
});

// --- TEST M10 --------------------------------------------------------------

describe('TEST M10: the curriculum tuner converges on the target band', () => {
  // A synthetic learner with a KNOWN skill surface: easy is trivial for them,
  // medium sits in the target band, hard is beyond them.
  const LEARNER = { easy: 0.95, medium: 0.68, hard: 0.25 };

  // M10 resamples every 20 balls, not once per session — updating only at
  // session boundaries gives the tuner half the updates the spec assumes.
  const simulate = (sessions, ballsPerSession = 60, seed = 77) => {
    const rng = mulberry32(seed);
    const tuner = new CurriculumTuner();
    let inBand = 0;
    let total = 0;
    let sinceResample = 0;
    for (let s = 0; s < sessions; s++) {
      for (let i = 0; i < ballsPerSession; i++) {
        const bucket = tuner.sample(rng);
        tuner.record(bucket, rng() < LEARNER[bucket]);
        // Only score the final session — convergence is about where it ENDS.
        if (s === sessions - 1) {
          total++;
          if (LEARNER[bucket] >= BAND_LOW && LEARNER[bucket] <= BAND_HIGH) inBand++;
        }
        if (++sinceResample >= RESAMPLE_EVERY) { tuner.update(); sinceResample = 0; }
      }
    }
    return { tuner, fraction: total ? inBand / total : 0 };
  };

  test('≥ 70% of feeds land in the 60–75% band within 3 sessions', () => {
    const { fraction } = simulate(3);
    expect(fraction).toBeGreaterThanOrEqual(0.7);
  });

  test('it converges on the bucket that sits in the band', () => {
    const { tuner } = simulate(3);
    const w = tuner.snapshot();
    expect(w.medium).toBeGreaterThan(w.easy);
    expect(w.medium).toBeGreaterThan(w.hard);
  });

  test('it starts uniform, since no bucket deserves preference without data', () => {
    const t = new CurriculumTuner();
    const w = t.snapshot();
    expect(w.easy).toBeCloseTo(1 / 3, 3);
    expect(w.medium).toBeCloseTo(1 / 3, 3);
  });

  test('weights always remain a probability distribution', () => {
    const { tuner } = simulate(4);
    const w = Object.values(tuner.snapshot());
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    for (const v of w) expect(v).toBeGreaterThanOrEqual(0);
  });

  test(`no single update shifts more than ${MAX_SHIFT * 100}% of the mass`, () => {
    // M10's no-whiplash rule: a bad 20 balls must not lurch the curriculum.
    const tuner = new CurriculumTuner();
    for (let i = 0; i < 30; i++) tuner.record('easy', true);
    for (let i = 0; i < 30; i++) tuner.record('hard', false);
    const before = tuner.snapshot();
    tuner.update();
    const after = tuner.snapshot();
    const tv = Object.keys(before)
      .reduce((acc, k) => acc + Math.abs(after[k] - before[k]), 0) / 2;
    expect(tv).toBeLessThanOrEqual(MAX_SHIFT + 1e-9);
  });

  test('a bucket with no data is not penalised for never being sampled', () => {
    const tuner = new CurriculumTuner();
    for (let i = 0; i < 20; i++) tuner.record('easy', true);
    const before = tuner.snapshot().hard;
    tuner.update();
    // hard was never tried; it should not collapse toward zero.
    expect(tuner.snapshot().hard).toBeGreaterThan(before * 0.7);
  });

  test('rateFor reports null with no attempts rather than a fake zero', () => {
    expect(new CurriculumTuner().rateFor('easy')).toBeNull();
  });

  test('sampling is reproducible for a seed', () => {
    const draw = () => {
      const t = new CurriculumTuner();
      const rng = mulberry32(21);
      return Array.from({ length: 30 }, () => t.sample(rng));
    };
    expect(draw()).toEqual(draw());
  });
});

// --- weighted random draws (the M10 → runner hook) ---------------------------

describe('PatternRunner stepWeights: the tuner can steer the random draw', () => {
  const base = defaultConfig();

  test('a zero-weighted step is never drawn', () => {
    const r = new PatternRunner('twoPoint', base, {
      random: true, rng: mulberry32(5), stepWeights: () => [1, 0],
    });
    for (let i = 0; i < 40; i++) expect(r.stepIndexFor(i)).toBe(0);
  });

  test('equal weights reproduce the uniform draw for the same seed', () => {
    // Both paths must consume exactly one rng call per ball, or toggling the
    // tuner on would desynchronise a seeded replay.
    const uniform = new PatternRunner('figureEight', base, {
      random: true, rng: mulberry32(9),
    });
    const weighted = new PatternRunner('figureEight', base, {
      random: true, rng: mulberry32(9), stepWeights: () => [1, 1, 1, 1],
    });
    for (let i = 0; i < 50; i++) {
      expect(weighted.stepIndexFor(i)).toBe(uniform.stepIndexFor(i));
    }
  });

  test('malformed weights fall back to uniform rather than throwing', () => {
    const r = new PatternRunner('twoPoint', base, {
      random: true, rng: mulberry32(3), stepWeights: () => [0, 0],
    });
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(r.stepIndexFor(i));
    expect(seen.size).toBe(2);
  });

  test('the memo stays bounded over an infinite drill', () => {
    const r = new PatternRunner('twoPoint', base, { random: true, rng: mulberry32(1) });
    for (let i = 0; i < 2000; i++) r.stepIndexFor(i);
    expect(r._stepCache.size).toBeLessThanOrEqual(256);
    // Recent indices — the only ones the drill re-reads — stay memoized.
    const last = r.stepIndexFor(1999);
    expect(r.stepIndexFor(1999)).toBe(last);
  });
});

// --- ladder scatter is a floor, not an override ------------------------------

describe('Ladder.applyTo respects a session that asked for more scatter', () => {
  test('a base scatter wider than the tier survives', () => {
    const l = new Ladder({ tier: 'bronze' });   // tier scatter 0.03
    const c = l.applyTo(validateConfig({ ...defaultConfig(), scatterSigma: 0.3 }));
    expect(c.scatterSigma).toBeCloseTo(0.3, 6);
  });

  test('the tier ramp still applies when the base is tighter', () => {
    const l = new Ladder({ tier: 'gold' });     // tier scatter 0.10
    const c = l.applyTo(validateConfig({ ...defaultConfig(), scatterSigma: 0 }));
    expect(c.scatterSigma).toBeCloseTo(TIER_SETTINGS.gold.scatter, 6);
  });
});
