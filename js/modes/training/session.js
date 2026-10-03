// Training Session — the model.
//
// A hands-on first session built the way coaches run multiball, not a
// tutorial to read: fixed sets first (one stroke, one spot), then movement,
// then spin, then an irregular feed the player cannot predict. Each set is a
// short burst with a rest after it, and the whole thing ends in a score the
// player can beat next time.
//
// Every value is predefined. The player chooses one thing, a level, and the
// session adapts within it: a run of good returns quickens the feed, a run of
// failures slows it and shows one short cue. There is nothing to configure
// and no state in which the player can get stuck.
//
// Scene-free per migration-plan D4. The drill wrapper (drills/session.js)
// asks this model for each ball's config and hands back each ball's verdict;
// sets, rests, adaptation and scoring all live here where they are testable.

import { validateConfig, INFINITE } from './drillConfig.js';

// Steps name a wing rather than a zone, because which side is the backhand
// depends on the hand. The player stands at +z facing −z, so their left is
// −x: for a right-hander the backhand is the −x column (zones 1/4/7) and the
// forehand the +x column (3/6/9). Left-handers get the mirror.
export const WINGS = Object.freeze({ BH: 'BH', MID: 'MID', FH: 'FH' });

const DEPTH_ROW = { short: 0, 'half-long': 1, deep: 2 };

/** Zone number (1–9) for a wing at a depth, given handedness. */
export function resolveWing(wing, depth = 'deep', hand = 'R') {
  let col = 1;
  if (wing === WINGS.BH) col = hand === 'L' ? 2 : 0;
  else if (wing === WINGS.FH) col = hand === 'L' ? 0 : 2;
  return (DEPTH_ROW[depth] ?? 2) * 3 + col + 1;
}

// Two levels, one tap before the first ball. "player" is someone who already
// rallies: quicker, spun, a little scatter so the ball is not groovable.
// `bestKey` is the profile setting holding the level's best score.
export const LEVELS = Object.freeze({
  beginner: Object.freeze({
    id: 'beginner', label: 'Beginner', blurb: 'Slower feed, light spin',
    bestKey: 'sessionBestBeginner',
    speed: 6, spin: 150, interval: 2.8, scatterSigma: 0, ballsPerSet: 10,
  }),
  player: Object.freeze({
    id: 'player', label: 'Player', blurb: 'Match pace, real spin',
    bestKey: 'sessionBestPlayer',
    speed: 8, spin: 275, interval: 2.1, scatterSigma: 0.05, ballsPerSet: 12,
  }),
});

export const LEVEL_ORDER = Object.freeze(['beginner', 'player']);

// The score card's rows. Sets roll up into these; the wrapper maps each to
// the practice mode that keeps training it.
export const BLOCKS = Object.freeze({
  warmup:   { id: 'warmup',   label: 'Warm-up' },
  footwork: { id: 'footwork', label: 'Footwork' },
  spin:     { id: 'spin',     label: 'Spin' },
  random:   { id: 'random',   label: 'Random' },
});

// The sets, in order. A step names a wing and depth (mirrored for
// left-handers by resolveWing) plus optional spin, arc and speed scaling;
// the level supplies everything else. `tip` is shown after three failures in
// a row; on the mixed-spin sets SPIN_TIPS override it by the spin of the ball
// just missed, since reading that spin is the whole lesson.
//
// Short backspin rides a flat arc from the far origin — the Backspin Push
// preset's proven shape (see presets.js for why the near origin fails).
export const SETS = Object.freeze([
  {
    id: 'forehand', block: 'warmup', label: 'Forehand',
    steps: [{ wing: WINGS.FH, depth: 'deep', spinType: 'top' }],
    tip: 'Close the face',
  },
  {
    id: 'backhand', block: 'warmup', label: 'Backhand',
    steps: [{ wing: WINGS.BH, depth: 'deep', spinType: 'top' }],
    tip: 'Elbow forward, brush up',
  },
  {
    id: 'twoPoint', block: 'footwork', label: 'Forehand – Backhand',
    steps: [
      { wing: WINGS.BH, depth: 'deep', spinType: 'top' },
      { wing: WINGS.FH, depth: 'deep', spinType: 'top' },
    ],
    tip: 'Back to the middle',
  },
  {
    id: 'falkenberg', block: 'footwork', label: 'Falkenberg',
    steps: [
      { wing: WINGS.BH,  depth: 'deep', spinType: 'top' },
      { wing: WINGS.MID, depth: 'deep', spinType: 'top' },
      { wing: WINGS.FH,  depth: 'deep', spinType: 'top' },
    ],
    tip: 'Small steps, stay low',
  },
  {
    id: 'pushBlock', block: 'spin', label: 'Push or Block',
    random: true,
    steps: [
      { wing: WINGS.MID, depth: 'short', spinType: 'back', arc: 'flat', speedMul: 1.1, spinMul: 1.25 },
      { wing: WINGS.MID, depth: 'deep',  spinType: 'top',  speedMul: 1.1 },
    ],
    tip: 'Read the spin first',
  },
  {
    id: 'random', block: 'random', label: 'Random',
    random: true,
    steps: [
      { wing: WINGS.FH,  depth: 'deep',      spinType: 'top' },
      { wing: WINGS.BH,  depth: 'deep',      spinType: 'top' },
      { wing: WINGS.MID, depth: 'deep',      spinType: 'none' },
      { wing: WINGS.FH,  depth: 'half-long', spinType: 'top' },
      { wing: WINGS.MID, depth: 'short',     spinType: 'back', arc: 'flat', speedMul: 1.1, spinMul: 1.25 },
    ],
    tip: 'Ready early, stay centred',
  },
].map((s) => Object.freeze(s)));

const SPIN_TIPS = Object.freeze({
  back: 'Backspin: open the face, lift',
  top: 'Topspin: close the face',
});

// Adaptation. Three in a row either way moves the pace one notch; the band
// is narrow on purpose — the level sets the difficulty, this only keeps a
// struggling player returning balls and a comfortable one working.
export const ADAPT = Object.freeze({
  streak: 3,
  up: 0.05,
  down: 0.1,
  min: 0.85,
  max: 1.15,
});

export const TIP_SECONDS = 4;
export const REST_SECONDS = 3;
// Longest the session waits for its final ball to resolve before scoring.
export const FINISH_TIMEOUT_SECONDS = 6;
export const INTRO_SECONDS = 3;

// A focus run (the score card's "Train" button) repeats one set, this many
// times its usual length, so the weakest skill gets real volume.
export const FOCUS_MULTIPLIER = 2;

// A return is "deep" when it lands in the last third of the machine's half.
// Depth is what a coach watches in a counter-hitting drill: a short return is
// the ball an opponent attacks.
export const DEEP_FRACTION = 1 / 3;

/**
 * Config for one ball of a set at a level and pace. Exported so the
 * feasibility test can sweep every ball the session can ever feed.
 */
export function stepConfig(level, step, { hand = 'R', pace = 1 } = {}) {
  const depth = step.depth || 'deep';
  return validateConfig({
    speed: level.speed * (step.speedMul || 1) * pace,
    spinType: step.spinType || 'none',
    spinMagnitude: level.spin * (step.spinMul || 1),
    placement: { kind: 'zone', zone: resolveWing(step.wing, depth, hand) },
    depth,
    arc: step.arc || 'medium',
    feedOrigin: 'center-far',
    scatterSigma: level.scatterSigma,
    interval: level.interval,
    burstCount: INFINITE,
    audioCue: true,
  });
}

const emptyStats = () => ({ returned: 0, missed: 0, errors: 0, deep: 0, landed: 0 });
const faced = (st) => st.returned + st.missed + st.errors;

const rate = (num, den) => (den > 0 ? num / den : 0);

export class SessionModel {
  /**
   * `rng` draws the random sets' steps. `tableHalf` ({ farZ, netZ }) lets the
   * model judge return depth without importing scene geometry.
   */
  /**
   * `focus` (a set id) runs just that set, FOCUS_MULTIPLIER times as long,
   * instead of the whole session.
   */
  constructor({
    level = 'beginner', hand = 'R', rng = Math.random, tableHalf = null, focus = null,
  } = {}) {
    this.level = LEVELS[level] || LEVELS.beginner;
    const focusSet = focus ? SETS.find((set) => set.id === focus) : null;
    this.focus = focusSet ? focusSet.id : null;
    this.sets = focusSet ? [focusSet] : SETS;
    this.ballsPerSet = this.level.ballsPerSet * (focusSet ? FOCUS_MULTIPLIER : 1);
    this.hand = hand === 'L' ? 'L' : 'R';
    this.rng = rng;
    this.tableHalf = tableHalf;

    this.setIndex = 0;
    this.fedInSet = 0;
    this.pace = 1;
    this.runUp = 0;     // consecutive successes in the current set
    this.runDown = 0;   // consecutive failures in the current set
    this.tip = null;
    this.tipTime = 0;
    this.phase = 'intro';
    this.restTime = INTRO_SECONDS;
    this.stats = this.sets.map(emptyStats);
    this.bestStreak = 0;
    this.streak = 0;
    // Set of each ball, by the machine's ball index, so a verdict that
    // arrives after the set changed (a set's last ball resolves during the
    // rest) is still credited to the set that fed it. Keyed rather than
    // queued: a feed the machine skips never gets a verdict, and a queue
    // would shift every later verdict onto the wrong set.
    this.ballSet = new Map();
  }

  get set() { return this.sets[this.setIndex] || null; }
  get complete() { return this.phase === 'done'; }
  get playing() { return this.phase === 'play'; }
  get setFull() { return this.fedInSet >= this.ballsPerSet; }

  /** Config for machine ball `ball`. Call exactly once per feed. */
  nextConfig(ball) {
    const set = this.set || this.sets[this.sets.length - 1];
    const k = set.random
      ? Math.floor(this.rng() * set.steps.length)
      : this.fedInSet % set.steps.length;
    this.fedInSet++;
    this.ballSet.set(ball, this.setIndex);
    return stepConfig(this.level, set.steps[k], { hand: this.hand, pace: this.pace });
  }

  /**
   * One ball's verdict. `ball` is the machine's ball index, `result` the M1
   * outcome ('returned'|'miss'|'error'), `spin` the fed spin and `landing`
   * the return's predicted bounce.
   */
  recordOutcome({ ball, result, spin = null, landing = null } = {}) {
    if (!this.ballSet.has(ball)) return;
    const si = this.ballSet.get(ball);
    this.ballSet.delete(ball);
    const st = this.stats[si];
    const current = si === this.setIndex && this.phase === 'play';

    if (result === 'returned') {
      st.returned++;
      if (landing && this.tableHalf) {
        st.landed++;
        if (this._isDeep(landing.z)) st.deep++;
      }
      this.streak++;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      if (!current) return;
      this.runDown = 0;
      if (++this.runUp >= ADAPT.streak) {
        this.runUp = 0;
        this.pace = Math.min(ADAPT.max, this.pace + ADAPT.up);
      }
      return;
    }

    if (result === 'error') st.errors++;
    else st.missed++;
    this.streak = 0;
    if (!current) return;
    this.runUp = 0;
    if (++this.runDown >= ADAPT.streak) {
      this.runDown = 0;
      this.pace = Math.max(ADAPT.min, this.pace - ADAPT.down);
      this.tip = SPIN_TIPS[spin] && this.set.random ? SPIN_TIPS[spin] : this.set.tip;
      this.tipTime = TIP_SECONDS;
    }
  }

  /**
   * Advance the rest/tip clocks. Returns 'resume' when a rest ends and the
   * machine should feed again, 'done' on the tick the session completes.
   */
  tick(dt) {
    if (this.tipTime > 0) {
      this.tipTime -= dt;
      if (this.tipTime <= 0) this.tip = null;
    }
    if (this.phase === 'play' && this.setFull) {
      // The set's last ball is out; rest while it resolves.
      if (this.setIndex >= this.sets.length - 1) {
        this.phase = 'finishing';
        this.restTime = FINISH_TIMEOUT_SECONDS;
      } else {
        this.phase = 'rest';
        this.restTime = REST_SECONDS;
      }
      return 'pause';
    }
    if (this.phase === 'intro' || this.phase === 'rest' || this.phase === 'finishing') {
      this.restTime -= dt;
      if (this.phase === 'finishing') {
        // Score once every ball has its verdict; the timeout covers a feed
        // the machine skipped, which never gets one.
        if (this._lastSetUnresolved() && this.restTime > 0) return null;
        this.phase = 'done';
        return 'done';
      }
      if (this.restTime > 0) return null;
      if (this.phase === 'rest') this._startSet(this.setIndex + 1);
      this.phase = 'play';
      return 'resume';
    }
    return null;
  }

  _startSet(i) {
    this.setIndex = i;
    this.fedInSet = 0;
    this.runUp = 0;
    this.runDown = 0;
    // Each set starts at its level's pace: a slowdown earned on the forehand
    // says nothing about the backhand.
    this.pace = 1;
    this.tip = null;
    this.tipTime = 0;
  }

  _lastSetUnresolved() {
    for (const si of this.ballSet.values()) if (si === this.setIndex) return true;
    return false;
  }

  _isDeep(z) {
    const { farZ, netZ } = this.tableHalf;
    const len = Math.abs(netZ - farZ);
    return Math.abs(z - farZ) <= len * DEEP_FRACTION;
  }

  /** The one HUD line: a few words, never a paragraph. */
  liveLine() {
    const set = this.set;
    switch (this.phase) {
      case 'intro':
        return `Get ready  ·  ${set.label}`;
      case 'rest': {
        const next = this.sets[this.setIndex + 1];
        return `Rest  ·  Next: ${next.label}`;
      }
      case 'finishing':
      case 'done':
        return 'Session complete';
      default: {
        const left = Math.max(0, this.ballsPerSet - this.fedInSet);
        const head = this.tip || set.label;
        return `${head}  ·  ${left} left`;
      }
    }
  }

  /** The score card. Percentages are whole numbers, 0–100. */
  report() {
    const sum = (ids, key) => this.sets.reduce((a, s, i) => {
      if (!ids.includes(s.block)) return a;
      const st = this.stats[i];
      return a + (key === 'fed' ? faced(st) : st[key]);
    }, 0);
    const blocks = Object.values(BLOCKS).map((b) => {
      const fed = sum([b.id], 'fed');
      return {
        id: b.id,
        label: b.label,
        fed,
        score: Math.round(100 * rate(sum([b.id], 'returned'), fed)),
      };
    });
    const all = Object.keys(BLOCKS);
    const fed = sum(all, 'fed');
    const returned = sum(all, 'returned');
    const landed = sum(all, 'landed');
    const played = blocks.filter((b) => b.fed > 0);
    // Ties go to the earlier block: weakest = the foundation to fix first,
    // strongest = the first thing the player got right.
    const pick = (better) => played.reduce((a, b) => (better(b.score, a.score) ? b : a), played[0]);
    const weakest = played.length ? pick((x, y) => x < y).id : null;
    const sets = this.sets.map((set, i) => ({
      id: set.id,
      label: set.label,
      block: set.block,
      fed: faced(this.stats[i]),
      score: Math.round(100 * rate(this.stats[i].returned, faced(this.stats[i]))),
    }));
    // The one set to train next: the lowest-scoring set of the weakest block.
    const weakestSet = sets
      .filter((st) => st.block === weakest && st.fed > 0)
      .reduce((a, b) => (!a || b.score < a.score ? b : a), null);
    return {
      focus: this.focus,
      level: this.level.id,
      levelLabel: this.level.label,
      // The headline number is consistency — balls returned of balls faced.
      score: Math.round(100 * rate(returned, fed)),
      depth: landed > 0 ? Math.round(100 * rate(sum(all, 'deep'), landed)) : null,
      bestStreak: this.bestStreak,
      blocks,
      sets,
      strongest: played.length ? pick((x, y) => x > y).id : null,
      weakest,
      weakestSet: weakestSet ? weakestSet.id : null,
    };
  }
}
