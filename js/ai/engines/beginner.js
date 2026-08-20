// Beginner engine — plays REAL table tennis shots (push, block, occasional
// drive) drawn from the shared shot-type selector, but with beginner-tuned
// weights (heavy on push/block, almost never smashes/loops) and beginner
// caps (speed <= 5.5 m/s, spin <= 15 rps). A patient practice partner that
// keeps the ball in play with recognizable strokes.
//
// Before: Beginner emitted raw (speed, spin) uniformly from a narrow band
// with no shot-type semantics. The result was that the ball came back with
// the same neutral arc every time, indistinguishable from a ball machine —
// and no matter how much we improved Intermediate/Pro variety, Beginner
// felt like the same engine at a slower speed. Wiring it into the shot-
// type system means the AI now visibly picks between a push, a block, a
// drive — with the corresponding face angles, windups, and spin — but
// with beginner-scale execution.
//
// Exploit-lite: this tier is shown as CLUB, and a club player DOES notice
// "their backhand is shaky" — slowly, and they don't punish it every ball.
// So Beginner now runs the same struggle-heatmap pipeline as Int/Pro
// (imported from intermediate.js, same direction pro.js already depends on)
// but tuned down on every axis:
//   exploit factor 0.20 vs 0.85/0.95 — most balls remain unaimed
//   min shots 7 vs 5                 — needs more evidence before noticing
//   punish delay 4 rallies vs 2      — slower to act on a new weakness
//   exploit jitter σ 0.18 vs 0.08    — aims "over there-ish", not at a spot
// The heatmap itself costs nothing extra: the worker feeds ShotHistory
// regardless of tier, Beginner just used to ignore it.
//
// computeTarget returns the 7-element wire payload (same shape as Int/Pro):
//   [target_x, target_z, target_speed_mps, target_spin_rps, confidence,
//    shotType, target_sidespin_rps]

import {
  selectShotType, sampleShotParameters, depthSpeedFactor, DIFFICULTY_CAPS,
} from '../shotTypeSelector.js';
import {
  pickTacticalTarget,
  TACTICAL_PROBABILITY_BY_DIFFICULTY,
} from '../tacticalZones.js';
import {
  buildSeeds, filterByCellArea, shrinkScores, weightedSampleIndex, keepTopK,
} from './intermediate.js';

// Where a beginner's ORDINARY shots land — a narrow box around the middle,
// because beginners aim at "the table", not at a spot.
const TARGET_X_MIN = -0.55;
const TARGET_X_MAX =  0.55;
const TARGET_Z_MIN =  0.30;
const TARGET_Z_MAX =  1.10;
const X_JITTER_SIGMA = 0.32;

// Light position-awareness on the ordinary box: shift its CENTER gently away
// from the player's side. A club player doesn't mirror or wrong-foot (those
// are deliberate skills — smart-tier tools, fed by anticipatePlayerXZ), but
// they do semi-consciously hit toward the open half rather than straight at
// the opponent. Gain × offset, hard-capped small: with the player at
// x = ±0.6 the lean is 0.15m against the smart tiers' ~0.26m mirror — the
// gaussian spread (σ 0.32) still dominates every individual shot.
const AWAY_BIAS_GAIN = 0.30;
const AWAY_BIAS_MAX_M = 0.15;

// Bounds for the rare (3%) tactical pick. Deliberately WIDER than the ordinary
// box — these are the full player-side safe-zone limits shared with the other
// engines.
//
// Clamping tactical picks into the narrow box above defeated their entire
// purpose: the zone catalog puts deep corners at x = ±0.60 and z = 1.15, and
// wide mid at ±0.65, so six of the twelve zones collapsed onto the clamp
// boundary — deep_wide_left and wide_left resolved to the SAME point. The one
// thing this branch exists to produce, an occasional accidental wide angle,
// was the one thing the clamp removed.
const TACTICAL_X_MIN = -0.7;
const TACTICAL_X_MAX =  0.7;
const TACTICAL_Z_MIN =  0.1;
const TACTICAL_Z_MAX =  1.3;

// Exploit-lite tuning — see the header comment for the rationale behind each
// value relative to Int/Pro. The ceiling caps momentum scaling (worker sends
// momentumScaleExploit up to 1.2×) so a hot streak can't push a club player
// into international-grade surveillance.
const EXPLOIT_FACTOR = 0.20;
const EXPLOIT_CEILING = 0.30;
const MIN_SHOTS_BEFORE_EXPLOIT = 7;
const PUNISH_DELAY_RALLIES = 4;
const EXPLOIT_JITTER_SIGMA = 0.18;
// Same anti-fixation K as the smart tiers — with exploit at 0.20 fixation is
// already unlikely, but cycling among the top cells keeps the rare exploit
// shots from all landing in one spot.
const EXPLOIT_TOPK = 3;

// Pace adaptation (see the block in computeTarget). The matched pace is a
// bit under the incoming speed (a controlled return gives back less than
// came in), banded to [2.5, 7.0] m/s — the ceiling is what keeps this tier
// a "long rally" partner: even a hard-hit ball comes back at rally pace,
// never amplified. Blend weight 0.5 splits the difference between the
// stroke's textbook pace and the matched pace.
const PACE_MATCH_RATIO = 0.85;
const PACE_MATCH_MIN = 2.5;
const PACE_MATCH_MAX = 7.0;
const PACE_ADAPT_BLEND = 0.5;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Highest-scoring seed key, for the new-weakness reset signal. Duplicated
// from intermediate.js (which keeps it private); pro.js carries the same
// copy.
function topSeedKey(shrunk) {
  if (shrunk.length === 0) return null;
  let bestKey = null;
  let bestScore = -Infinity;
  for (const s of shrunk) {
    if (s.shrunkScore > bestScore) {
      bestScore = s.shrunkScore;
      bestKey = `${s.x.toFixed(2)},${s.z.toFixed(2)}`;
    }
  }
  return bestKey;
}

function gaussian01(rng) {
  let u, v, s;
  do {
    u = rng() * 2 - 1;
    v = rng() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  return u * Math.sqrt(-2 * Math.log(s) / s);
}

export function createBeginnerEngine({ rng = Math.random } = {}) {
  // Ring buffer of tactical zone names so occasional wide shots don't
  // repeat back-to-back.
  let recentZones = [];
  const RECENT_ZONES_WINDOW = 2;
  // Ring buffer of shot types, for anti-repeat pressure in the selector.
  let recentTypes = [];
  const RECENT_TYPES_WINDOW = 4;
  // No-instant-punishment state, same mechanism as Int/Pro but with the
  // longer club delay. Starts unfrozen so a pre-existing weakness (engine
  // recreated mid-session) isn't double-delayed.
  let lastTopCellKey = null;
  let ralliesSinceTopChanged = PUNISH_DELAY_RALLIES;

  function ingestShot(_shot, _history) {
    // Shot already pushed to ShotHistory by the worker; all this engine
    // keeps per-rally is the punish-delay counter. (This used to be a
    // no-op — "Beginner does not learn" — before the exploit-lite pass.)
    ralliesSinceTopChanged += 1;
  }

  function computeTarget(history, ctx) {
    // --- Struggle heatmap (exploit-lite) ----------------------------------
    // Built every turn once there's enough history, even on turns that
    // won't exploit, so a top-cell change is detected the rally it happens
    // and the punish delay starts counting from there — same bookkeeping
    // order as intermediate.js. history is null in some unit tests.
    let shrunk = null;
    const shots = history ? history.getAll() : [];
    if (shots.length >= MIN_SHOTS_BEFORE_EXPLOIT) {
      shrunk = shrinkScores(filterByCellArea(buildSeeds(shots)));
      const topKey = topSeedKey(shrunk);
      if (topKey !== lastTopCellKey) {
        lastTopCellKey = topKey;
        ralliesSinceTopChanged = 0;
      }
    }

    // --- Target placement -------------------------------------------------
    const playerXZ = ctx && ctx.player_xz;
    const playerVelXZ = ctx && ctx.player_velocity_xz;
    let target_x, target_z;
    if (rng() < TACTICAL_PROBABILITY_BY_DIFFICULTY.beginner) {
      const pick = pickTacticalTarget(rng, playerXZ, playerVelXZ, recentZones);
      if (pick) {
        target_x = clamp(pick.target[0], TACTICAL_X_MIN, TACTICAL_X_MAX);
        target_z = clamp(pick.target[1], TACTICAL_Z_MIN, TACTICAL_Z_MAX);
        recentZones.push(pick.name);
        if (recentZones.length > RECENT_ZONES_WINDOW) recentZones.shift();
      }
    }
    // Exploit-lite roll. Alternatives, not additives — a tactical pick
    // already consumed this shot. No opponent-position bias on the weights
    // (biasWeightsAwayFromPlayer stays a smart-tier tool): a club player who
    // has noticed your weak backhand aims at the backhand, period, without
    // also reading where you're standing. The wide jitter uses the tactical
    // bounds because the weak spot may itself sit outside the ordinary
    // center box.
    if (target_x === undefined && shrunk &&
        ralliesSinceTopChanged >= PUNISH_DELAY_RALLIES) {
      const exploitScale = (ctx && ctx.momentumScaleExploit) || 1.0;
      const effectiveExploit = Math.min(EXPLOIT_CEILING, EXPLOIT_FACTOR * exploitScale);
      if (rng() < effectiveExploit) {
        const weights = keepTopK(
          shrunk.map(s => Math.max(0, s.shrunkScore)),
          EXPLOIT_TOPK,
        );
        const idx = weightedSampleIndex(weights, rng);
        if (idx >= 0) {
          const chosen = shrunk[idx];
          target_x = clamp(
            chosen.x + gaussian01(rng) * EXPLOIT_JITTER_SIGMA,
            TACTICAL_X_MIN, TACTICAL_X_MAX,
          );
          target_z = clamp(
            chosen.z + gaussian01(rng) * EXPLOIT_JITTER_SIGMA,
            TACTICAL_Z_MIN, TACTICAL_Z_MAX,
          );
        }
      }
    }
    if (target_x === undefined) {
      // Ordinary shot: gaussian around the box center, with the center
      // leaned gently away from the player — see AWAY_BIAS_GAIN. Current
      // position only, deliberately not anticipated: reacting to where the
      // opponent stands is instinct, aiming at where they'll be is a skill
      // this tier doesn't have.
      let centerX = (TARGET_X_MIN + TARGET_X_MAX) / 2;
      if (playerXZ && Number.isFinite(playerXZ.x)) {
        centerX += clamp(
          -playerXZ.x * AWAY_BIAS_GAIN,
          -AWAY_BIAS_MAX_M, AWAY_BIAS_MAX_M,
        );
      }
      target_x = clamp(
        centerX + gaussian01(rng) * X_JITTER_SIGMA,
        TARGET_X_MIN,
        TARGET_X_MAX,
      );
      target_z = TARGET_Z_MIN + rng() * (TARGET_Z_MAX - TARGET_Z_MIN);
    }

    // --- Shot type + speed/spin -------------------------------------------
    // Same selector + sampler path as Intermediate/Pro, with the
    // beginner-tuned BASE_TYPE_WEIGHTS and DIFFICULTY_CAPS. Anti-repeat
    // and incoming-ball bias fire the same way — Beginner now visibly
    // picks a push vs a block vs a drive, with face angles and windups
    // that read as different strokes.
    const shotType = selectShotType({
      difficulty: 'beginner',
      incoming: ctx && ctx.incoming,
      recentTypes,
      rng,
      momentumBias: ctx && ctx.momentumBiasShotTypeWeights,
      matchState: ctx ? { score_margin: ctx.score_margin, score_total: ctx.score_total } : null,
      style: ctx && ctx.style,
      isServeReturn: ctx && ctx.isServeReturn,
      // Placement is already decided; the stroke must fit it.
      targetZ: target_z,
    });
    const { speed: rawSpeed, spin: target_spin, sideSpin: target_sidespin } =
      sampleShotParameters({
        shotType,
        difficulty: 'beginner',
        rng,
      });
    // Pace adaptation — a rally partner returns at a pace related to what
    // came in, not always at the stroke's textbook pace. Blend the sampled
    // speed halfway toward a "matched" pace (a bit under the incoming
    // speed, banded so a soft ball still gets a real return and a fast one
    // never gets amplified). Half-weight keeps the stroke's identity — a
    // push stays slower than a drive off the same ball — while making the
    // return speed visibly track the rally: soft exchanges stay soft, and a
    // hard-hit ball comes back with pace taken OFF it, which is what keeps
    // a rally alive instead of escalating it.
    const inSpeed = (ctx && ctx.incoming && Number.isFinite(ctx.incoming.speed_mps))
      ? ctx.incoming.speed_mps
      : null;
    let pacedSpeed = rawSpeed;
    if (inSpeed !== null) {
      const matched = Math.min(PACE_MATCH_MAX,
        Math.max(PACE_MATCH_MIN, inSpeed * PACE_MATCH_RATIO));
      pacedSpeed += (matched - pacedSpeed) * PACE_ADAPT_BLEND;
    }
    // Deep targets can't carry full pace — see depthSpeedFactor. Beginner
    // speeds rarely strain the envelope, but applying it here keeps all three
    // engines on one rule rather than leaving a silent exception.
    //
    // The minSpeed rail matters after scaling: a slow touch shot aimed deep
    // would otherwise scale to under 1 m/s, which will not even carry the net.
    // Intermediate and Pro already clamp here; Beginner previously did not.
    //
    // momentumSwingSpeedScale is applied here too. Beginner already consumes
    // the momentum SHOT-TYPE bias (above) but silently dropped the swing-speed
    // half, so a beginner on a confidence streak picked bolder shots and then
    // hit them at exactly the same pace — the visible half of momentum was
    // missing at the one tier where nerves should read most clearly.
    const swingScale = (ctx && typeof ctx.momentumSwingSpeedScale === 'number')
      ? ctx.momentumSwingSpeedScale
      : 1;
    const caps = DIFFICULTY_CAPS.beginner;
    const target_speed = Math.max(
      caps.minSpeed,
      pacedSpeed * swingScale * depthSpeedFactor(target_z),
    );
    recentTypes.push(shotType);
    if (recentTypes.length > RECENT_TYPES_WINDOW) recentTypes.shift();

    // Spec wire field. Nothing consumes payload[4] — aiFSM reads indices
    // 0,1,2,3,5,6. Kept because removing it would renumber the later slots
    // across all three engines, the FSM and the tests for no behavioural gain.
    const confidence = 1.0;
    // 7-element payload (matches Int/Pro shape). Payload[5] carries the
    // picked shot type so the FSM's telegraph pipeline can render the
    // stroke visually; [6] is signed sidespin rps (see sampleSideSpin).
    return [target_x, target_z, target_speed, target_spin, confidence, shotType,
            target_sidespin];
  }

  function reset() {
    recentZones = [];
    recentTypes = [];
    lastTopCellKey = null;
    ralliesSinceTopChanged = PUNISH_DELAY_RALLIES;
  }

  return { ingestShot, computeTarget, reset };
}
