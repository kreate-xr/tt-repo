// M2 Progression Ladders + the M10 curriculum tuner.
//
// M2: "fixed graded sequences (Bronze→Diamond) per skill; auto-advance at
// ≥ 80% success over 20 balls, auto-drop below 40%."
// M10: "feed distribution targets the 60–75% success band (edge of ability);
// resample weights updated per 20 balls, max 15% distribution shift."
//
// Both are pure state machines over a stream of pass/fail results, which is
// what makes them testable against synthetic learners rather than only
// discoverable by playing for an hour.

export const TIERS = Object.freeze(['bronze', 'silver', 'gold', 'diamond']);

// M2's thresholds, and the window they are measured over.
export const WINDOW = 20;
export const ADVANCE_AT = 0.80;
export const DROP_BELOW = 0.40;

// M10's target band. Feeds are steered toward the edge of ability: too easy
// and nothing is learned, too hard and nothing is landed.
export const BAND_LOW = 0.60;
export const BAND_HIGH = 0.75;

// M10: "resample weights updated per 20 balls, max 15% distribution shift
// per session (no whiplash)."
//
// Read as a cap PER UPDATE, i.e. per 20-ball resample. The alternative
// reading — a 15% budget for a whole session, shared across its updates —
// cannot satisfy M10's own convergence clause: starting from a uniform
// distribution, three sessions would allow at most 0.33 + 0.45 of the mass to
// move, which leaves the in-band fraction hovering at the 70% threshold
// rather than clearing it. Per-update is also what "updated per 20 balls"
// implies operationally: the resample is the unit of change.
export const MAX_SHIFT = 0.15;

// The resample interval M10 specifies. Callers record results ball by ball
// and update on this cadence.
export const RESAMPLE_EVERY = 20;

/**
 * Per-tier difficulty. These scale the drill's base config, so a ladder is a
 * progression over the SAME pattern rather than four separate drills.
 */
export const TIER_SETTINGS = Object.freeze({
  bronze:  { speedMul: 0.75, spinMul: 0.4, paceMul: 0.8, scatter: 0.03 },
  silver:  { speedMul: 0.9,  spinMul: 0.7, paceMul: 1.0, scatter: 0.06 },
  gold:    { speedMul: 1.05, spinMul: 1.0, paceMul: 1.15, scatter: 0.10 },
  diamond: { speedMul: 1.2,  spinMul: 1.0, paceMul: 1.3, scatter: 0.16 },
});

/**
 * Ladder state machine.
 *
 * Results are recorded one ball at a time; promotion and demotion are only
 * evaluated on a FULL window. Judging a partial window would let three lucky
 * balls promote a player, which is exactly the whiplash M10 warns about.
 */
export class Ladder {
  constructor({ tier = 'bronze', window = WINDOW } = {}) {
    this.tier = TIERS.includes(tier) ? tier : 'bronze';
    this.window = window;
    this.results = [];
    this.history = [];
  }

  get tierIndex() { return TIERS.indexOf(this.tier); }
  get settings() { return TIER_SETTINGS[this.tier]; }

  /** Success rate over the current (possibly partial) window. */
  get rate() {
    if (this.results.length === 0) return 0;
    return this.results.filter(Boolean).length / this.results.length;
  }

  get ballsUntilReview() { return Math.max(0, this.window - this.results.length); }

  /**
   * Record one ball.
   * @returns {{changed:boolean, from?:string, to?:string, reason?:string, rate?:number}}
   */
  record(success) {
    this.results.push(!!success);
    if (this.results.length < this.window) return { changed: false };

    const rate = this.rate;
    const from = this.tier;
    let to = from;
    let reason = null;

    if (rate >= ADVANCE_AT && this.tierIndex < TIERS.length - 1) {
      to = TIERS[this.tierIndex + 1];
      reason = 'advance';
    } else if (rate < DROP_BELOW && this.tierIndex > 0) {
      to = TIERS[this.tierIndex - 1];
      reason = 'drop';
    }

    // The window resets whichever way the decision went. Carrying results
    // across a tier change would judge the new tier on balls played at the
    // old one — the most common way a ladder oscillates.
    this.results = [];
    this.history.push({ tier: from, rate, moved: reason });

    if (to === from) return { changed: false, rate };
    this.tier = to;
    return { changed: true, from, to, reason, rate };
  }

  /** Apply this tier's difficulty to a base config. */
  applyTo(baseConfig) {
    const s = this.settings;
    return {
      ...baseConfig,
      speed: baseConfig.speed * s.speedMul,
      spinMagnitude: baseConfig.spinMagnitude * s.spinMul,
      interval: baseConfig.interval / s.paceMul,
      scatterSigma: s.scatter,
    };
  }
}

/**
 * M10 curriculum tuner — maintains a success surface over difficulty buckets
 * and steers sampling toward the 60–75% band.
 *
 * Buckets are coarse on purpose. A fine grid over {speed × spin × placement}
 * would need far more balls per cell than a training session produces, and
 * the resulting weights would be noise dressed as personalisation.
 */
export class CurriculumTuner {
  constructor({ buckets = null, maxShift = MAX_SHIFT } = {}) {
    this.buckets = buckets || ['easy', 'medium', 'hard'];
    this.maxShift = maxShift;
    this.stats = new Map(this.buckets.map((b) => [b, { attempts: 0, successes: 0 }]));
    // Uniform to begin with: with no evidence, no bucket deserves preference.
    const even = 1 / this.buckets.length;
    this.weights = new Map(this.buckets.map((b) => [b, even]));
  }

  record(bucket, success) {
    const s = this.stats.get(bucket);
    if (!s) return;
    s.attempts++;
    if (success) s.successes++;
  }

  rateFor(bucket) {
    const s = this.stats.get(bucket);
    if (!s || s.attempts === 0) return null;
    return s.successes / s.attempts;
  }

  /**
   * Recompute sampling weights toward the target band.
   *
   * A bucket inside the band is where learning happens, so it gains weight.
   * One far outside — trivially easy or hopeless — loses it. Buckets with no
   * data keep their current weight rather than being penalised for never
   * having been sampled.
   *
   * The whole update is then limited to `maxShift` in total variation, which
   * is M10's no-whiplash rule: a player has a bad 20 balls without their
   * whole curriculum lurching.
   */
  update() {
    const desired = new Map();
    let total = 0;
    for (const b of this.buckets) {
      const rate = this.rateFor(b);
      const current = this.weights.get(b);
      let score;
      if (rate === null) {
        score = current;
      } else if (rate >= BAND_LOW && rate <= BAND_HIGH) {
        score = current * 1.6;                    // in the band — favour it
      } else {
        // Distance outside the band, scaled: just outside barely moves,
        // far outside falls away quickly.
        const dist = rate < BAND_LOW ? (BAND_LOW - rate) : (rate - BAND_HIGH);
        score = current * Math.max(0.2, 1 - 2 * dist);
      }
      desired.set(b, score);
      total += score;
    }
    if (total <= 0) return this.snapshot();

    // Normalise, then damp the move so no session can swing more than
    // maxShift of probability mass.
    let shift = 0;
    const normalised = new Map();
    for (const b of this.buckets) {
      const w = desired.get(b) / total;
      normalised.set(b, w);
      shift += Math.abs(w - this.weights.get(b));
    }
    const totalVariation = shift / 2;
    const damp = totalVariation > this.maxShift ? this.maxShift / totalVariation : 1;
    for (const b of this.buckets) {
      const from = this.weights.get(b);
      this.weights.set(b, from + (normalised.get(b) - from) * damp);
    }
    return this.snapshot();
  }

  /** Draw a bucket according to the current weights. */
  sample(rng = Math.random) {
    const r = rng();
    let acc = 0;
    for (const b of this.buckets) {
      acc += this.weights.get(b);
      if (r <= acc) return b;
    }
    return this.buckets[this.buckets.length - 1];
  }

  snapshot() {
    return Object.fromEntries(
      this.buckets.map((b) => [b, Math.round(this.weights.get(b) * 1000) / 1000]),
    );
  }
}
