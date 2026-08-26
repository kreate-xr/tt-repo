// Momentum model — tracks match emotional state and modulates the AI's
// exploit rate and shot-type aggression. Adds a second axis of realism on
// top of the shot-history heatmap: at 8-2 the AI plays looser and hunts
// smashes; at 2-8 it tightens and stops gambling.
//
// Design notes:
//   - The value lives in [-1, +1]:
//       +1 = AI is running away with it (aggressive, looking for kills)
//        0 = neutral rally state
//       -1 = AI is behind (plays it safe, high-percentage shots)
//   - Recency weighting: recent points move the value more than old ones.
//     Simple exponential moving average with alpha=0.30 gives a "last ~5
//     points dominate" feel that matches how real players talk about
//     momentum.
//   - Score-delta signal: aiScore - playerScore, normalised by expected
//     game length (11). Both wins and current lead influence value —
//     winning the last point AND being ahead is more momentum than just
//     one of them.
//
// Consumers:
//   - shotTypeSelector (via engine ctx): shifts weights toward smash/drive
//     when momentum > 0.3, toward push/block when momentum < -0.3.
//   - exploit factor scaling in intermediate/pro engines: 1.0 baseline,
//     ~1.2× at +1 momentum (more exploit), ~0.8× at -1 (more caution).
//
// Worker-safe: no THREE, no DOM. Pure logic + one number of state.

const SMOOTHING_ALPHA = 0.30;

// How much the current score delta contributes to the target value on each
// point (vs how much the last-point win/loss contributes). Both signals
// blend into the same [-1, +1] value.
const DELTA_WEIGHT = 0.6;
const POINT_WEIGHT = 0.4;

// Normaliser for score delta. A +5 lead maps to ~+0.6 from the delta
// component; further leads saturate toward +1.
const DELTA_NORMALISER = 8;

// Consecutive-point streak tuning — separate from score margin. Losing
// 3 points IN A ROW shakes a real player more than losing 3 points spread
// across 10 rallies, even at the same margin. Winning 3 in a row builds
// visible confidence (attacks come off crisper). These constants
// modulate miss-rate and smash-appetite based on the current streak
// direction and length.
// Exported because aiFSM (main thread) applies the miss-rate half of this
// rule — it owns the miss dice — while this module owns the shot-type half.
// Both used to hard-code 3 and 0.06 independently with nothing linking them,
// so the two halves of one behaviour could drift apart silently.
export const STREAK_THRESHOLD = 3;
// Miss-rate boost when the AI has just LOST 3+ in a row (defense sags,
// grip tightens). Additive to the base miss rate.
export const STREAK_MISS_BOOST_ADDITIVE = 0.06;
// Smash / loop weight boost when the AI has just WON 3+ in a row
// (confidence surge — swings more aggressively).
const STREAK_CONFIDENCE_SMASH_MULT = 1.25;
const STREAK_CONFIDENCE_LOOP_MULT  = 1.15;

// Rubber-band tuning — keeps matches engaging by softening the AI's play
// when it's crushing the player and sharpening it when the player is
// running away. Not to be confused with momentum: momentum modulates
// aggression based on recent point trend; rubber-band modulates SKILL
// based on absolute score margin. Both fire simultaneously.
//
//   |AI - Player| ≤ 3     : neutral (no rubber-band effect)
//   AI leading by > 3     : ease up — exploit factor drops, swings soften
//   AI trailing by > 3    : press — exploit factor rises, swings sharpen
//
// Cap deltas so an 11-0 game doesn't push the AI into "practice mode."
const RUBBER_BAND_DEADZONE = 3;
const RUBBER_BAND_MAX_MARGIN = 8;
const RUBBER_BAND_MAX_EXPLOIT_DROP = 0.25;
const RUBBER_BAND_MAX_EXPLOIT_LIFT = 0.15;
const RUBBER_BAND_MAX_SWING_DROP = 0.10;

// `easeUpWhenLeading` gates the rubber-band's LEADING half. It defaults on
// (the engagement mechanic for casual tiers), but the top tier passes false:
// an elite opponent that plays worse the moment it gets ahead caps how
// strong ELITE can ever feel, and reads as condescension once noticed. The
// TRAILING half ("press when behind") stays in either case — pressing when
// down is authentic competitive behaviour, not a handicap.
export function createMomentumModel({ easeUpWhenLeading = true } = {}) {
  let value = 0;
  let currentMargin = 0; // aiScore - playerScore, updated per point_result
  // Consecutive streak counters — track only the CURRENT run. Reset to
  // the opposite direction as soon as the streak breaks.
  let consecutiveWon = 0;
  let consecutiveLost = 0;

  function update({ winner, aiScore, playerScore }) {
    if (winner !== 'ai' && winner !== 'player') return;
    const pointSignal = winner === 'ai' ? 1 : -1;
    const rawDelta = (aiScore - playerScore) / DELTA_NORMALISER;
    const deltaSignal = Math.max(-1, Math.min(1, rawDelta));
    const target = DELTA_WEIGHT * deltaSignal + POINT_WEIGHT * pointSignal;
    value = value + SMOOTHING_ALPHA * (target - value);
    // Numerical clamp — arithmetic could drift very slightly out of range.
    if (value > 1) value = 1;
    if (value < -1) value = -1;
    currentMargin = aiScore - playerScore;
    // Update streak counters. A win resets the loss streak and vice versa.
    if (winner === 'ai') {
      consecutiveWon += 1;
      consecutiveLost = 0;
    } else {
      consecutiveLost += 1;
      consecutiveWon = 0;
    }
  }

  // Streak-based bonuses. Return additive amounts (0 when no streak).
  // Used by aiFSM.js to bump miss rate on a losing streak, and by
  // biasShotTypeWeights to boost smash/loop weights on a winning streak.
  function missRateStreakBoost() {
    return (consecutiveLost >= STREAK_THRESHOLD) ? STREAK_MISS_BOOST_ADDITIVE : 0;
  }
  function isOnConfidenceStreak() {
    return consecutiveWon >= STREAK_THRESHOLD;
  }

  // Rubber-band scalar: positive when AI is leading big (should ease
  // up), negative when AI is trailing big (should press). Returns
  // 0 inside the deadzone. Range [-1, +1] after clamping.
  function rubberBandStrength() {
    const absMargin = Math.abs(currentMargin);
    if (absMargin <= RUBBER_BAND_DEADZONE) return 0;
    // Leading side disabled at the honest tier (see easeUpWhenLeading).
    if (currentMargin > 0 && !easeUpWhenLeading) return 0;
    const excess = absMargin - RUBBER_BAND_DEADZONE;
    const denom = RUBBER_BAND_MAX_MARGIN - RUBBER_BAND_DEADZONE;
    const magnitude = Math.min(1, excess / denom);
    return currentMargin > 0 ? magnitude : -magnitude;
  }

  function get() { return value; }

  // Multiplier on the engine's exploit factor. Baseline 1.0 at neutral;
  // ±0.20 from momentum, ± up to -0.25 / +0.15 from rubber-band. When
  // the AI is way ahead, rubber-band knocks exploit DOWN so it stops
  // hunting weak zones and plays more neutral (keeps matches engaging).
  // When way behind, rubber-band lifts exploit slightly to press.
  function exploitScale() {
    const momentumTerm = 0.20 * value;
    const rb = rubberBandStrength();
    // rb > 0 = AI leading big → drop exploit; rb < 0 = trailing → lift.
    const rubberTerm = rb > 0
      ? -RUBBER_BAND_MAX_EXPLOIT_DROP * rb
      : -RUBBER_BAND_MAX_EXPLOIT_LIFT * rb; // -rb * -mult = +mult when rb<0
    return 1.0 + momentumTerm + rubberTerm;
  }

  // Multiplier on target ball speed at contact. Winning momentum → the AI
  // "swings loose" and hits a touch harder (up to +15% at max value);
  // losing → tightens up and pulls back on pace (down to -15%). This is
  // what makes momentum VISIBLE in paddle motion instead of only shifting
  // shot-type weights. Rubber-band adds up to -10% when AI is running
  // away with the game so shots visibly relax (feels less bullying).
  function swingSpeedScale() {
    const momentumTerm = 0.15 * value;
    const rb = rubberBandStrength();
    const rubberTerm = rb > 0 ? -RUBBER_BAND_MAX_SWING_DROP * rb : 0;
    return 1.0 + momentumTerm + rubberTerm;
  }

  // Additive bias applied to shot-type weights BEFORE anti-repeat penalty.
  // Positive momentum → tilts toward smash/drive; negative → toward
  // push/block. Consumers pass their base weights and receive a modified
  // copy — shotTypeSelector's applyIncomingBias uses the same shape.
  //
  // On top of momentum, a "confidence streak" (3+ AI wins in a row) adds
  // a further multiplicative boost to smash/loop — real players hit
  // more decisively when they're rolling.
  function biasShotTypeWeights(weights) {
    let out = { ...weights };
    if (Math.abs(value) >= 0.15) {
      if (value > 0) {
        const gain = 1 + value * 0.8;
        out.smash         = (out.smash         ?? 0) * gain;
        out.topspin_drive = (out.topspin_drive ?? 0) * (1 + value * 0.4);
        out.push          = (out.push          ?? 0) * (1 - value * 0.4);
      } else {
        const gain = 1 + (-value) * 0.8;
        out.push  = (out.push  ?? 0) * gain;
        out.block = (out.block ?? 0) * (1 + (-value) * 0.5);
        out.smash = (out.smash ?? 0) * (1 - (-value) * 0.5);
      }
    }
    if (isOnConfidenceStreak()) {
      out.smash = (out.smash ?? 0) * STREAK_CONFIDENCE_SMASH_MULT;
      out.loop  = (out.loop  ?? 0) * STREAK_CONFIDENCE_LOOP_MULT;
    }
    return out;
  }

  function reset() {
    value = 0;
    currentMargin = 0;
    consecutiveWon = 0;
    consecutiveLost = 0;
  }

  return {
    update, get, exploitScale, swingSpeedScale, biasShotTypeWeights,
    missRateStreakBoost, isOnConfidenceStreak, reset,
  };
}
