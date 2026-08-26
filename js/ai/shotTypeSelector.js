// Shot-type-first sampling. Used by all three engines.
//
// Before: engines picked speed and spin uniformly from a fixed range and
// telegraph.js reverse-labelled the (speed, spin) tuple as one of the six
// shot types. Result: higher difficulty widened the numeric range and the
// AI felt like "same shot, faster" rather than a mix of pushes, loops,
// drives and smashes.
//
// After: engines call selectShotType() first — a context-aware weighted
// pick over the six types — then sampleShotParameters() draws speed/spin
// from that type's characteristic distribution. Difficulty controls the
// weights (variety pressure, kill-shot appetite) and caps the numeric
// range at execution — not the type vocabulary.
//
// Worker-safe: no THREE, no DOM. Deterministic given rng. Consumed by
// beginner.js, intermediate.js, pro.js, and (indirectly, via re-export)
// telegraph.js.

import { applyStyleBias } from './playerStyles.js';

// Ten-type vocabulary. Original six (drive/slice/block/loop/push/smash)
// covered rally shots; the extended four (chop/drop_shot/lob/flip) add the
// defensive and short-game vocabulary real TT players use to break rhythm.
//   chop      — heavy defensive backspin, low slow retrieve from far back
//   drop_shot — very short, dies at the net, forces opponent to lunge in
//   lob       — high defensive arc, deep, buys time under pressure
//   flip      — aggressive attack over the net on a short push
// Same string values telegraph.js consumes so face-Y / windup lookups work.
export const SHOT_TYPES = Object.freeze({
  TOPSPIN_DRIVE: 'topspin_drive',
  SLICE:         'slice',
  BLOCK:         'block',
  LOOP:          'loop',
  PUSH:          'push',
  SMASH:         'smash',
  CHOP:          'chop',
  DROP_SHOT:     'drop_shot',
  LOB:           'lob',
  FLIP:          'flip',
});

// Per-type distribution. Gaussian mean + sigma with hard clamps so a
// tail sample never crosses into a neighbouring type's characteristic
// range. Numbers grounded in real table tennis rally telemetry:
//   push  — slow tap, light backspin
//   block — quick redirect, near-flat
//   slice — medium pace, heavy backspin
//   drive — fast topspin rally shot
//   loop  — medium-fast arcing shot with heavy topspin
//   smash — kill shot, very fast, near-flat
// SPIN SCALE (spin-economy unification, 2026-08): all spin numbers here are
// PHYSICAL rps — the same scale the player's brush shots produce through
// SPIN_CAPTURE_GAIN. They were ×2.5 smaller for a long time, cancelling a
// MAGNUS_COEFFICIENT that ran 2.5× physical (see the history note on that
// constant); both moved together, so every arc these tables describe is
// unchanged. The practical ceiling is ~64 rps ≈ 400 rad/s: PADDLE_SPIN_CAP
// (420 rad/s, real rubber-grip saturation) is what the impulse model can
// actually deliver, so requests are kept just inside it — the old top-end
// loop (34 rps at 2.5× Magnus ≡ 85 rps real-equivalent) was super-physical
// and compresses to the 64 ceiling rather than scaling exactly.
export const SHOT_PROFILES = Object.freeze({
  push:          { speedMean: 3.2,  speedSigma: 0.6, speedMin: 2.2, speedMax: 4.5,
                   spinMean: -15,   spinSigma:  5,   spinMin: -30,  spinMax: -3 },
  block:         { speedMean: 4.5,  speedSigma: 1.0, speedMin: 3.0, speedMax: 6.5,
                   spinMean:   0,   spinSigma:  5,   spinMin: -10,  spinMax: 10 },
  slice:         { speedMean: 5.5,  speedSigma: 1.0, speedMin: 4.0, speedMax: 7.5,
                   spinMean: -45,   spinSigma: 10,   spinMin: -64,  spinMax: -25 },
  topspin_drive: { speedMean: 8.0,  speedSigma: 1.2, speedMin: 6.0, speedMax: 10.5,
                   spinMean:  35,   spinSigma:  8,   spinMin:  20,  spinMax:  55 },
  loop:          { speedMean: 6.5,  speedSigma: 1.0, speedMin: 5.0, speedMax:  8.5,
                   spinMean:  57,   spinSigma:  6,   spinMin:  45,  spinMax:  64 },
  smash:         { speedMean: 11.0, speedSigma: 1.3, speedMin: 9.0, speedMax: 13.5,
                   spinMean:   8,   spinSigma:  5,   spinMin:  -5,  spinMax:  20 },
  // Chop — defender's answer to a loop. Slow, heavy backspin, floaty arc that
  // forces the opponent to lift into the next attack.
  //
  // NOTE the base spin here (-55 mean, -64 min) is NOT what any tier plays:
  // the solver cannot hold backspin past about -62 rps on the table, so every
  // tier overrides chop's spin downward in PROFILE_OVERRIDES. The base is kept
  // as the "physical archetype" the overrides are derived from.
  chop:          { speedMean: 4.5,  speedSigma: 0.8, speedMin: 3.2, speedMax:  6.0,
                   spinMean: -55,   spinSigma:  8,   spinMin: -64,  spinMax: -40 },
  // Drop shot — very short, dying near the net. Slow speed, mild backspin
  // (just enough to kill any bounce forward). Distinct from PUSH in that it is
  // *deliberately* short.
  //
  // Kept short by applyTargetDepthBias, which suppresses drop_shot hard at
  // mid and deep targets. Note the coupling runs target → type, not type →
  // zone: pickTacticalTarget takes no shot type and the zone catalog carries
  // no shot-type metadata, so placement is decided first and the stroke is
  // fitted to it. Before that bias existed, 73% of drop shots were aimed deep.
  drop_shot:     { speedMean: 2.5,  speedSigma: 0.4, speedMin: 1.8, speedMax:  3.5,
                   spinMean: -10,   spinSigma:  5,   spinMin: -22,  spinMax:   0 },
  // Lob — defensive high arc. Medium-slow with light topspin (topspin holds
  // the ball down inside the table on the descent so it doesn't sail long).
  lob:           { speedMean: 5.5,  speedSigma: 0.9, speedMin: 4.0, speedMax:  7.5,
                   spinMean:  25,   spinSigma:  8,   spinMin:  10,  spinMax:  45 },
  // Flip — aggressive attack over the net against a short push. Fast for a
  // short ball, moderate topspin. Requires reaching in over the table so
  // reachability may reject it in tight geometries; that's handled downstream.
  flip:          { speedMean: 7.5,  speedSigma: 1.0, speedMin: 5.5, speedMax:  9.5,
                   spinMean:  45,   spinSigma: 10,   spinMin:  25,  spinMax:  60 },
});

// Per-difficulty profile OVERRIDES, merged over SHOT_PROFILES at sample time.
// This — not DIFFICULTY_CAPS — is how tiers differ in pace.
//
// Why the split exists: caps used to be the differentiator, and that quietly
// destroyed shot types. Clamping happens profile-range-first, cap-second, so
// any cap at or below a profile's speedMin collapses that type to a single
// constant. Intermediate's 9.0 cap vs. smash's 9.0 speedMin meant EVERY
// intermediate smash was exactly 9.0 m/s with zero variance; beginner's 5.5
// cap did the same to topspin_drive (profile min 6.0) and smash. A cap must
// never be the thing shaping a distribution — it is a rail, nothing more.
//
// Scaling is deliberately NOT uniform. Between skill levels, touch shots
// (push, drop, chop) barely change pace — a push is a push. What separates
// levels is how hard the ATTACKING shots come: loop, drive, smash, flip.
//
//   beginner     — attacking strokes damped; touch shots at base pace
//   intermediate — international. Attacking strokes set to the top of what the
//                  solver can actually DELIVER (smash 17, drive 14, loop 12.5),
//                  which is the low end of a real international loop's
//                  15-25 m/s; touch shots only modestly lifted
//   pro          — above international; ~1.12x on attacking strokes
//
// Spin is overridden per tier too, for two separate reasons — but NOT to make
// the upper tiers spinnier. Spin here is physical rps under the physical
// MAGNUS_COEFFICIENT (see the scale note above SHOT_PROFILES), and raising
// speed increases Magnus (a = k·ω×v) at unchanged spin anyway. The reasons
// are:
//
//   1. Beginner must not spin like an international player. Without an
//      override its spin bounds sat at base and maxSpin did the shaping.
//   2. Heavy backspin is outside the solver envelope (see the note in
//      PROFILE_OVERRIDES.intermediate), so chop and slice are re-profiled
//      rather than left asking for -32 rps the physics cannot land.
export const PROFILE_OVERRIDES = Object.freeze({
  // Beginner damps BOTH pace and spin. Spin overrides are not cosmetic here:
  // without them the base spin bounds stayed put while DIFFICULTY_CAPS.maxSpin
  // (±15) did the shaping, so 100% of beginner loops emitted exactly +15.0 rps,
  // 77% of slices exactly -15.0, and 37% of drives exactly +15.0. That is the
  // same "a cap must never shape a distribution" defect this table exists to
  // prevent — it was simply still live on the spin axis after being fixed on
  // the speed axis.
  //
  // Every type is listed, including chop and flip which carry zero weight at
  // this tier, so no type is left sitting on base bounds above the rail
  // waiting for whoever next gives it a weight.
  beginner: {
    topspin_drive: { speedMean: 6.0, speedSigma: 0.9,  speedMin: 4.5, speedMax: 7.9,
                     spinMean: 16, spinSigma: 3.5, spinMin: 9, spinMax: 25 },
    loop:          { speedMean: 5.5, speedSigma: 0.85, speedMin: 4.3, speedMax: 7.2,
                     spinMean: 27, spinSigma: 4.5, spinMin: 20, spinMax: 36 },
    smash:         { speedMean: 7.9, speedSigma: 0.95, speedMin: 6.5, speedMax: 8.4,
                     spinMean: 3.5, spinSigma: 2.5, spinMin: -2.5, spinMax: 9 },
    flip:          { speedMean: 4.9, speedSigma: 0.65, speedMin: 3.6, speedMax: 6.2,
                     spinMean: 20, spinSigma: 4.5, spinMin: 11, spinMax: 29 },
    slice:         { spinMean: -20, spinSigma: 4.5, spinMin: -30, spinMax: -11 },
    chop:          { spinMean: -35, spinSigma: 4.5, spinMin: -45, spinMax: -25 },
    push:          { spinMean: -7.5, spinSigma: 2.5, spinMin: -14, spinMax: -1 },
    block:         { spinMean: 0, spinSigma: 2.5, spinMin: -5, spinMax: 5 },
    lob:           { spinMean: 11, spinSigma: 3.5, spinMin: 4.5, spinMax: 20 },
    drop_shot:     { spinMean: -4.5, spinSigma: 2.5, spinMin: -10, spinMax: 0 },
  },
  // These sit inside a MEASURED envelope — see tests/solverEnvelope.test.js,
  // which pins it so a regression shows up as a number.
  //
  // An earlier revision of this table was capped at ~13.5 m/s on the belief
  // that the physics model could not land a faster ball. That was wrong: the
  // measurement behind it was taken against a solver carrying a spin
  // moment-arm unit error (3.15x too costly) and a face-tilt that invalidated
  // its own ballistic solution. With those fixed the real envelope is:
  //
  //     feasible %   z=0.4  z=0.7  z=1.0  z=1.3     (target depth from net)
  //       10 m/s      100    100    100     98
  //       16 m/s      100    100     76     42
  //       25 m/s      100    100     42      0
  //
  // So pace is NOT the constraint — pace AT DEPTH is. Short and mid targets
  // take international speed comfortably; only balls aimed at the far edge run
  // out of table. That is a real constraint in actual table tennis too, and
  // the engines model it by scaling pace with target depth rather than by
  // capping these profiles (see depthSpeedFactor in the engines) — a flat cap
  // would collapse the distribution, which is the defect this whole structure
  // exists to prevent.
  //
  // The attacking means are set to what the solver can ACTUALLY DELIVER, not
  // to what a request can name. Measured launch speed vs requested speed, at
  // 100% feasibility:
  //
  //     requested   12    16    20    24    28
  //     z=0.35    12.6  15.4  15.6  15.6  15.6
  //     z=0.60    12.8  15.9  16.7  16.7  16.7
  //     z=0.90    13.1  16.4  18.0  18.0  18.0
  //
  // Delivery saturates at 15.6-18.0 m/s: past that the angle search can only
  // return trajectories that do not land, so the solver silently substitutes
  // the fastest landable shot. That is reasonable BEHAVIOUR, but it made the
  // numbers here fiction — an earlier revision asked for a 22 m/s smash
  // (27 max) and the player experienced 17.6. Requesting inside the deliverable
  // band means requested ≈ delivered, no silent truncation, and depthSpeedFactor
  // scaling something real instead of a number that was going to be cut anyway.
  //
  // 17-19 m/s is the low end of a real international loop (15-25 m/s). Going
  // higher needs the physics model changed, not these numbers raised.
  //
  // Backspin has its own measured ceiling around -62 rps: heavier backspin
  // floats the ball long and cannot be held on the table at any pace
  // (measured pre-rescale as -30 rps at 2.5× Magnus ≈ -75 now, 5-43%
  // feasible; -40 ≈ -100 now, ~0%). The base `chop` profile at -55 mean /
  // -64 min sits partly outside that, so chop and slice carry spin
  // overrides here. Topspin has no such ceiling inside the deliverable band.
  intermediate: {
    smash:         { speedMean: 17.0, speedSigma: 2.0, speedMin: 14.0, speedMax: 20.0 },
    topspin_drive: { speedMean: 14.0, speedSigma: 2.0, speedMin: 11.0, speedMax: 18.0 },
    loop:          { speedMean: 12.5, speedSigma: 1.8, speedMin: 10.0, speedMax: 16.0 },
    flip:          { speedMean: 10.5, speedSigma: 1.4, speedMin:  8.0, speedMax: 13.5 },
    block:         { speedMean:  7.0, speedSigma: 1.5, speedMin:  4.7, speedMax: 10.1 },
    slice:         { speedMean:  7.5, speedSigma: 1.4, speedMin:  5.5, speedMax: 10.2,
                     spinMean: -42, spinSigma: 9, spinMin: -60, spinMax: -25 },
    lob:           { speedMean:  7.0, speedSigma: 1.15, speedMin: 5.1, speedMax:  9.5 },
    chop:          { speedMean:  6.0, speedSigma: 1.07, speedMin: 4.3, speedMax:  8.0,
                     spinMean: -52, spinSigma: 6, spinMin: -62, spinMax: -40 },
    push:          { speedMean:  4.0, speedSigma: 0.75, speedMin: 2.8, speedMax:  5.6 },
    drop_shot:     { speedMean:  3.0, speedSigma: 0.48, speedMin: 2.2, speedMax:  4.2 },
  },
  // Pro sits ~1.12x above international on attacking strokes and ~1.15x on
  // touch shots, plus slightly wider spin bounds on loop / slice / chop.
  // Pro's loop spin presses against the 64 rps grip ceiling (see the scale
  // note above SHOT_PROFILES) — the mean sits high with a tightened sigma
  // rather than scaling the old distribution exactly, so the top tail stays
  // deliverable instead of being clamp-shaped.
  pro: {
    smash:         { speedMean: 19.0, speedSigma: 2.2, speedMin: 15.7, speedMax: 22.4 },
    topspin_drive: { speedMean: 15.7, speedSigma: 2.2, speedMin: 12.3, speedMax: 20.2 },
    loop:          { speedMean: 14.0, speedSigma: 2.0, speedMin: 11.2, speedMax: 17.9,
                     spinMean: 58, spinSigma: 5, spinMin: 45, spinMax: 64 },
    flip:          { speedMean: 11.8, speedSigma: 1.6, speedMin:  9.0, speedMax: 15.1 },
    block:         { speedMean:  8.1, speedSigma: 1.7, speedMin:  5.4, speedMax: 11.6 },
    slice:         { speedMean:  8.6, speedSigma: 1.6, speedMin:  6.3, speedMax: 11.7,
                     spinMean: -45, spinSigma: 9, spinMin: -62, spinMax: -28 },
    lob:           { speedMean:  8.1, speedSigma: 1.3, speedMin:  5.9, speedMax: 10.9 },
    chop:          { speedMean:  6.9, speedSigma: 1.2, speedMin:  4.9, speedMax:  9.2,
                     spinMean: -55, spinSigma: 6, spinMin: -64, spinMax: -42 },
    push:          { speedMean:  4.6, speedSigma: 0.86, speedMin: 3.2, speedMax:  6.4 },
    drop_shot:     { speedMean:  3.5, speedSigma: 0.55, speedMin: 2.5, speedMax:  4.8 },
  },
});

// Pace a shot can realistically carry to a given target depth, as a MULTIPLIER
// on the sampled speed.
//
// The engines pick target placement and shot type independently, so nothing
// stopped them requesting "22 m/s to a target 10cm past the net" or, more
// commonly, full pace to the back edge. Measured feasibility shows pace itself
// is not the constraint — pace AT DEPTH is:
//
//     feasible %   z=0.4  z=0.7  z=1.0  z=1.3
//       10 m/s      100    100    100     98
//       16 m/s      100    100     76     42
//       25 m/s      100    100     42      0
//
// A fast ball aimed at the far edge simply runs out of table. That is true of
// real table tennis as well — deep balls are placed, not blasted — so this is
// modelling a real constraint, not papering over a solver limitation.
//
// Deliberately a multiplicative scale rather than a cap: a cap would pin every
// deep attacking shot to the same speed, which is exactly the distribution
// collapse that PROFILE_OVERRIDES exists to prevent. Scaling preserves the
// shot's relative variance and its identity.
const DEPTH_FULL_PACE_Z = 0.7;   // at/below this, no reduction
const DEPTH_MAX_Z = 1.37;        // back edge of the half-table
const DEPTH_MIN_PACE_FACTOR = 0.45;
export function depthSpeedFactor(targetZ) {
  if (!Number.isFinite(targetZ) || targetZ <= DEPTH_FULL_PACE_Z) return 1;
  const t = Math.min(1, (targetZ - DEPTH_FULL_PACE_Z) / (DEPTH_MAX_Z - DEPTH_FULL_PACE_Z));
  return 1 - t * (1 - DEPTH_MIN_PACE_FACTOR);
}

// Merge a shot type's base profile with its per-difficulty override.
//
// Resolve the type name BEFORE looking up the override: falling back to the
// base topspin_drive while skipping the tier override would hand an
// international-tier engine a club-pace ball on any unrecognised type name —
// silent, and exactly the kind of mismatch this module now guards against.
export function profileFor(shotType, difficulty) {
  const type = SHOT_PROFILES[shotType] ? shotType : 'topspin_drive';
  const base = SHOT_PROFILES[type];
  const perTier = PROFILE_OVERRIDES[difficulty];
  const ov = perTier && perTier[type];
  return ov ? { ...base, ...ov } : base;
}

// Absolute execution rails per difficulty. These are a LAST-RESORT clamp
// against a pathological sample or a future profile edit — they must sit
// strictly ABOVE every profile bound for that tier so they never bind in
// normal play. If you find yourself lowering a cap to slow a tier down, edit
// PROFILE_OVERRIDES instead; that is the lesson of the collapse described
// above, and `tests/shotTypeSelector.test.js` asserts the rails stay clear.
// maxSpin was previously 15/26/40 (pre-rescale scale) and DID bind — it was
// shaping the spin distribution exactly the way maxSpeed used to shape the
// speed one. Now that every tier carries explicit spin overrides, these sit
// clear on both axes (spin rails in physical rps, above each tier's widest
// profile bound: beginner ±45, intermediate ±62, pro ±64).
export const DIFFICULTY_CAPS = Object.freeze({
  beginner:     { minSpeed: 1.5, maxSpeed:  9.0, maxSpin: 50 },
  intermediate: { minSpeed: 1.5, maxSpeed: 22.0, maxSpin: 66 },
  pro:          { minSpeed: 1.5, maxSpeed: 24.0, maxSpin: 68 },
});

// Base weights per DIFFICULTY. These are the personalities:
//
//   Beginner (shown as CLUB) — plays it safe. Mostly pushes and blocks,
//                occasional drive or lob. NEVER chops or flips (weight 0 —
//                those require timing and swing paths beginners haven't
//                developed). A patient practice partner.
//
//   Intermediate (shown as INTERNATIONAL) — the full vocabulary is in play.
//                Loop is the backbone of the rally, smash is a real threat
//                rather than a rarity, and the short game (drop, flip) and
//                defensive tools (chop) are live options. This entry used to
//                read "solid club player ... No chops or flips", which
//                contradicted its own weights table below (chop 1.0, flip 1.0)
//                after the tier was raised to international.
//
//   Pro (shown as ELITE) — chessmaster. Same vocabulary as INTERNATIONAL but
//                weighted harder toward loop/chop mixing and drop-shot / flip
//                tactical sprinkles, plus tempo mixing that no other tier
//                gets. Every shot has intent.
//
// The weights aren't probabilities — they're relative and get modulated
// by incoming-ball bias, momentum, and anti-repeat before sampling.
export const BASE_TYPE_WEIGHTS = Object.freeze({
  beginner: {
    push:          3.5,
    block:         3.5,
    topspin_drive: 1.5,
    slice:         1.2,
    lob:           0.6,
    drop_shot:     0.3,
    loop:          0.3,
    smash:         0.1,
    chop:          0.0,
    flip:          0.0,
  },
  // International: the full vocabulary is in play. Loop is the backbone of
  // modern high-level rallies, smash is a real threat rather than a rarity,
  // and the short game (drop, flip) and defensive tools (chop) are live
  // options instead of near-zero curiosities. The old shape here — smash 0.7,
  // chop 0.2, flip 0.1 — was a club player's toolkit.
  intermediate: {
    loop:          3.5,
    topspin_drive: 2.5,
    smash:         1.5,
    slice:         1.5,
    block:         1.5,
    chop:          1.0,
    flip:          1.0,
    drop_shot:     0.8,
    push:          0.8,
    lob:           0.4,
  },
  pro: {
    loop:          3.5,
    topspin_drive: 2.5,
    chop:          1.8,
    slice:         1.8,
    smash:         1.5,
    block:         1.2,
    drop_shot:     1.2,
    flip:          1.0,
    push:          0.8,
    lob:           0.5,
  },
});

// Return-of-serve weights per difficulty. Overrides BASE_TYPE_WEIGHTS
// on the AI's first receive after the player's serve. Real TT serve
// returns are almost never full loops or smashes — the ball is short,
// spinny, and slow, so the vocabulary is push / block / flip / slice
// (Pro / Intermediate) with occasional aggressive attacks on weak
// serves. Never SMASH (way too risky) and never CHOP / LOB (defensive
// tools reserved for rally shots).
//
// Weights are relative — same shape as BASE_TYPE_WEIGHTS.
export const SERVE_RETURN_WEIGHTS = Object.freeze({
  beginner: {
    push:      4.0,
    block:     3.0,
    slice:     1.5,
    // Beginners almost never attack a serve — just get it back.
    topspin_drive: 0.3,
    loop:      0.0,
    smash:     0.0,
    chop:      0.0,
    drop_shot: 0.5,
    lob:       0.3,
    flip:      0.0,
  },
  // International receive. The banana flick is a PRIMARY return at this level,
  // not an occasional one — hence flip at 2.0 rather than 1.0. Still never
  // smash (the ball is short) and never chop.
  intermediate: {
    push:      2.5,
    block:     2.5,
    flip:      2.0,
    slice:     1.5,
    topspin_drive: 1.0,
    loop:      0.8,
    smash:     0.0,
    chop:      0.0,
    drop_shot: 0.8,
    lob:       0.2,
  },
  pro: {
    push:      2.5,
    block:     2.5,
    flip:      2.0,
    slice:     1.5,
    topspin_drive: 1.0,
    loop:      0.8,
    smash:     0.0,   // Pros don't smash a serve — even a weak one is short
    chop:      0.0,
    drop_shot: 0.8,
    lob:       0.2,
  },
});

// Anti-repeat penalty. Multiplies the weight of any type that appeared
// recently, graduated by how recent it was. The old version only saw the
// last 2 shots and applied all-or-nothing multipliers — that still let
// through patterns like DRIVE-BLOCK-DRIVE-BLOCK every 3 shots, which
// reads as mechanical. New version:
//   - looks at last 4 shots
//   - graduated per-slot multipliers (most recent hit hardest)
//   - separately detects 2-shot alternating patterns (A-B-A-B-...) and
//     dampens the type that would continue the pattern
const REPEAT_PENALTY_BY_LAG = [0.35, 0.55, 0.75, 0.90];
// Bigram (ABAB) breaker — if the last four picks form an alternation,
// the "next expected" type takes this multiplier to force a break.
const BIGRAM_BREAKER_PENALTY = 0.35;

function gaussian01(rng) {
  let u, v, s;
  do {
    u = rng() * 2 - 1;
    v = rng() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  return u * Math.sqrt(-2 * Math.log(s) / s);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function applyAntiRepeat(weights, recentTypes) {
  if (!recentTypes || recentTypes.length === 0) return weights;

  // Per-type combined multiplier. Each slot the type appears in
  // contributes its own lag penalty, multiplied together. So a type that
  // was the last shot AND two shots ago gets 0.35 × 0.75 ≈ 0.26 — sharper
  // than either alone, matching the old "twice-in-window" penalty while
  // still letting the graduated single-slot lag mean single repeats are
  // discouraged more than they used to be.
  const windowSize = REPEAT_PENALTY_BY_LAG.length;
  const window = recentTypes.slice(-windowSize);
  const multByType = new Map();
  for (let i = 0; i < window.length; i++) {
    const type = window[i];
    // window[window.length-1] = most recent (lag index 0)
    const lag = window.length - 1 - i;
    const slotMult = REPEAT_PENALTY_BY_LAG[lag] ?? 1;
    const prev = multByType.get(type);
    multByType.set(type, prev === undefined ? slotMult : prev * slotMult);
  }

  // Bigram breaker: last 4 form an A-B-A-B alternation → the next pick
  // in the pattern would be A (window[-4] == window[-2] and window[-3] ==
  // window[-1] means the "continuation" is window[-2] repeating).
  let bigramTarget = null;
  if (window.length >= 4) {
    const [a, b, c, d] = window.slice(-4);
    if (a !== b && a === c && b === d) bigramTarget = c; // == a
  }

  const out = {};
  for (const [type, w] of Object.entries(weights)) {
    let mult = multByType.get(type) ?? 1;
    if (type === bigramTarget && BIGRAM_BREAKER_PENALTY < mult) {
      mult = BIGRAM_BREAKER_PENALTY;
    }
    out[type] = w * mult;
  }
  return out;
}

// Situation-aware bias. Reads incoming ball characteristics (produced by
// aiMatch.js from the shotAdapter rollout at request_target time) and
// shifts weights toward the shots a real player would consider.
//
// incoming shape (all optional):
//   speed_mps          scalar, ball speed at AI contact
//   spin_topspin       signed scalar: + topspin, − backspin
//   contact_height_m   height of ball above table surface at contact
//   contact_vy_mps     signed vertical velocity at contact; negative =
//                      descending. Distinguishes a genuinely attackable
//                      high ball (falling fast) from a slow floater.
//   bounce_depth_m     distance from net where the ball bounced on AI side
function applyIncomingBias(weights, incoming) {
  if (!incoming) return weights;
  const out = { ...weights };

  // Short ball (bounced near the net on AI side) — invites a push or
  // short block. Also: a short ball over the net is prime FLIP territory
  // (attack) or a chance to answer short with a DROP_SHOT of our own.
  // Smashing a short low ball rarely lands.
  if (incoming.bounce_depth_m !== undefined && incoming.bounce_depth_m < 0.45) {
    out.push      = (out.push      ?? 0) * 2.0;
    out.block     = (out.block     ?? 0) * 1.4;
    out.slice     = (out.slice     ?? 0) * 1.5;
    out.flip      = (out.flip      ?? 0) * 2.5;
    out.drop_shot = (out.drop_shot ?? 0) * 2.0;
    out.smash     = (out.smash     ?? 0) * 0.4;
    out.loop      = (out.loop      ?? 0) * 0.5;
    out.chop      = (out.chop      ?? 0) * 0.3;
    out.lob       = (out.lob       ?? 0) * 0.3;
  }

  // Deep ball at rally speed — good opening to attack.
  if (incoming.bounce_depth_m !== undefined && incoming.bounce_depth_m > 0.9) {
    out.topspin_drive = (out.topspin_drive ?? 0) * 1.5;
    out.loop          = (out.loop          ?? 0) * 1.4;
    out.push          = (out.push          ?? 0) * 0.4;
    out.drop_shot     = (out.drop_shot     ?? 0) * 0.3;
    out.flip          = (out.flip          ?? 0) * 0.3;
  }

  // High ball at AI contact — but ONLY treat as a kill opportunity if the
  // ball is descending fast enough to actually smash. Real players don't
  // try to kill a slow floater — they loop or drive it. Threshold vy
  // < -2.5 m/s ≈ ball has fallen from ~30cm above contact; slower than
  // that reads as a lift/float that a smash tends to shank into the net.
  const highBall = incoming.contact_height_m !== undefined && incoming.contact_height_m > 0.25;
  const vyKnown = typeof incoming.contact_vy_mps === 'number' && Number.isFinite(incoming.contact_vy_mps);
  const descendingFast = vyKnown && incoming.contact_vy_mps < -2.5;
  if (highBall) {
    if (!vyKnown || descendingFast) {
      // Genuine kill window (fast-descending or legacy behavior when vy
      // unknown, e.g. from tests). Original heavy smash weighting.
      out.smash         = (out.smash         ?? 0) * 4.0;
      out.topspin_drive = (out.topspin_drive ?? 0) * 1.8;
      out.push          = (out.push          ?? 0) * 0.2;
      out.block         = (out.block         ?? 0) * 0.3;
      out.slice         = (out.slice         ?? 0) * 0.3;
    } else {
      // Slow floater at height — loop and drive are the real shots here.
      // Smash gets a modest bump (still attackable) but not the 4× kill
      // bias that made the AI shank open lobs into the net.
      out.loop          = (out.loop          ?? 0) * 2.2;
      out.topspin_drive = (out.topspin_drive ?? 0) * 1.6;
      out.smash         = (out.smash         ?? 0) * 1.3;
      out.push          = (out.push          ?? 0) * 0.4;
      out.block         = (out.block         ?? 0) * 0.5;
    }
  }

  // Heavy incoming backspin — LOOP is the shot that lifts backspin over
  // the net cleanly. Slice / CHOP reinforce the backspin cycle for a slow
  // exchange; block/smash struggle against heavy backspin.
  if (incoming.spin_topspin !== undefined) {
    if (incoming.spin_topspin < -12) {
      out.loop  = (out.loop  ?? 0) * 2.2;
      out.slice = (out.slice ?? 0) * 1.4;
      out.chop  = (out.chop  ?? 0) * 1.6;
      out.smash = (out.smash ?? 0) * 0.3;
      out.block = (out.block ?? 0) * 0.4;
      out.flip  = (out.flip  ?? 0) * 0.3;
    } else if (incoming.spin_topspin > 12) {
      // Heavy incoming topspin — block redirects it cleanly; slice or
      // push at heavy topspin tends to pop the ball up. A CHOP is the
      // defensive answer to a heavy loop, so boost it strongly here.
      out.block         = (out.block         ?? 0) * 1.8;
      out.topspin_drive = (out.topspin_drive ?? 0) * 1.2;
      out.chop          = (out.chop          ?? 0) * 2.0;
      out.push          = (out.push          ?? 0) * 0.4;
    }
  }

  // Very fast incoming — absorbing pace with block/slice/lob is safer
  // than trying to match with a smash. A LOB is the "I have no time,
  // buy me a second" answer to a fast attack.
  if (incoming.speed_mps !== undefined && incoming.speed_mps > 9) {
    out.block     = (out.block     ?? 0) * 1.5;
    out.slice     = (out.slice     ?? 0) * 1.2;
    out.lob       = (out.lob       ?? 0) * 1.8;
    out.smash     = (out.smash     ?? 0) * 0.5;
    out.flip      = (out.flip      ?? 0) * 0.3;
    out.drop_shot = (out.drop_shot ?? 0) * 0.4;
  }

  return out;
}

// Target-depth coherence. A shot type carries an implied depth: a drop shot
// dies at the net, a lob and a chop land deep. Placement is chosen BEFORE the
// stroke (placement is the tactical decision; the stroke is how you execute
// it), so the stroke has to fit the placement — not the other way round.
//
// Without this the two were drawn independently and contradicted each other
// constantly. Measured over 30k shots: 73% of drop shots were aimed DEEP —
// not a change-of-pace touch at all, just a slow ball to the back of the
// table, which is a free attack for the player. Also 25% of lobs and ~26% of
// chops aimed short, and 15% of smashes dropped on the net line. Roughly 10%
// of every shot the AI played was a stroke that contradicted its own target.
//
// Deliberately strong on the contradictions (drop_shot x0.05 when deep) and
// gentle on the merely-unusual, so this shapes coherence without flattening
// the vocabulary. Applied AFTER incoming-ball bias so depth wins the tie: a
// short incoming ball boosts drop_shot x2.0, but a deep target still
// suppresses it.
const SHORT_TARGET_Z = 0.45;
const DEEP_TARGET_Z  = 0.90;
function applyTargetDepthBias(weights, targetZ) {
  if (typeof targetZ !== 'number' || !Number.isFinite(targetZ)) return weights;
  const out = { ...weights };

  if (targetZ < SHORT_TARGET_Z) {
    // Short of the net — the touch game.
    out.drop_shot = (out.drop_shot ?? 0) * 3.0;
    out.push      = (out.push      ?? 0) * 2.0;
    out.flip      = (out.flip      ?? 0) * 1.8;
    out.block     = (out.block     ?? 0) * 1.3;
    // A lob or chop that lands short is a pop-up; a smash aimed at the net
    // line has no table to land on.
    out.lob       = (out.lob       ?? 0) * 0.15;
    out.chop      = (out.chop      ?? 0) * 0.15;
    out.smash     = (out.smash     ?? 0) * 0.40;
    out.loop      = (out.loop      ?? 0) * 0.50;
  } else if (targetZ > DEEP_TARGET_Z) {
    // Deep to the baseline — the power and defensive game.
    out.loop          = (out.loop          ?? 0) * 1.5;
    out.topspin_drive = (out.topspin_drive ?? 0) * 1.4;
    out.chop          = (out.chop          ?? 0) * 1.6;
    out.lob           = (out.lob           ?? 0) * 1.5;
    // A "drop shot" to the baseline is a contradiction in terms.
    out.drop_shot     = (out.drop_shot     ?? 0) * 0.05;
    out.flip          = (out.flip          ?? 0) * 0.30;
    out.push          = (out.push          ?? 0) * 0.60;
  } else {
    // Mid-table. Mostly unconstrained — this is where the rally lives — but
    // the strongly depth-specific strokes still don't belong here. A drop shot
    // that lands 70cm past the net is not a drop shot, it is a slow mid-table
    // ball; suppressing it only at the DEEP threshold left 29% of them here.
    out.drop_shot = (out.drop_shot ?? 0) * 0.25;
    out.lob       = (out.lob       ?? 0) * 0.60;
    out.chop      = (out.chop      ?? 0) * 0.70;
  }

  return out;
}

// Close-game risk aversion. Real players don't gamble on kill shots when
// the score is tight — nerves tighten up and they play higher-percentage
// shots. Applied whenever |aiScore - playerScore| <= CLOSE_MARGIN and the
// combined score is past the "warmup" point where nerves actually kick in.
const CLOSE_MARGIN = 2;
const NERVES_START_TOTAL = 8; // both sides need to have been rallying a bit
function applyScoreMarginBias(weights, matchState) {
  if (!matchState) return weights;
  const margin = matchState.score_margin;
  const total  = matchState.score_total;
  if (typeof margin !== 'number' || !Number.isFinite(margin)) return weights;
  if (typeof total === 'number' && Number.isFinite(total) && total < NERVES_START_TOTAL) {
    return weights;
  }
  if (Math.abs(margin) > CLOSE_MARGIN) return weights;
  const out = { ...weights };
  // Tight score → shave 30% off smash, 15% off drive; nudge block/loop up.
  // Loop stays viable because it's a "safe attack" — high percentage of
  // clearing the net vs. a flat kill.
  out.smash         = (out.smash         ?? 0) * 0.7;
  out.topspin_drive = (out.topspin_drive ?? 0) * 0.85;
  out.block         = (out.block         ?? 0) * 1.15;
  out.loop          = (out.loop          ?? 0) * 1.1;
  return out;
}

// Pro-only tempo mixing. Real strong players deliberately break rhythm:
// after two fast shots they'll drop in a push; after two soft touches
// they'll rip a drive. Encoded here as a hard bias on the third shot in
// a same-tempo streak.
const FAST_TYPES = new Set(['topspin_drive', 'smash']);
const SLOW_TYPES = new Set(['push', 'block', 'slice']);

function applyProTempoMixing(weights, recentTypes) {
  if (!recentTypes || recentTypes.length < 2) return weights;
  const [t1, t2] = recentTypes.slice(-2);
  const bothFast = FAST_TYPES.has(t1) && FAST_TYPES.has(t2);
  const bothSlow = SLOW_TYPES.has(t1) && SLOW_TYPES.has(t2);
  if (!bothFast && !bothSlow) return weights;

  const out = { ...weights };
  if (bothFast) {
    out.push  = (out.push  ?? 0) * 2.5;
    out.slice = (out.slice ?? 0) * 2.0;
    out.smash = (out.smash ?? 0) * 0.3;
  } else {
    out.topspin_drive = (out.topspin_drive ?? 0) * 2.5;
    out.smash         = (out.smash         ?? 0) * 2.0;
    out.push          = (out.push          ?? 0) * 0.4;
  }
  return out;
}

function weightedSample(weights, rng) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return null;
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rng() * total;
  for (const [t, w] of entries) {
    r -= w;
    if (r <= 0) return t;
  }
  return entries[entries.length - 1][0];
}

// Pick a shot type. difficulty is 'beginner' | 'intermediate' | 'pro'.
// incoming is optional (see applyIncomingBias for the shape). recentTypes
// is the last-N shot-type strings the engine picked, used for anti-repeat
// and (Pro only) tempo mixing. momentumBias is an optional function
// (weights → weights) supplied by the worker's MomentumModel; applied
// AFTER incoming bias but BEFORE anti-repeat so a hot streak doesn't
// resurrect a type the engine just picked twice. matchState is optional
// { score_margin, score_total } — used to dampen kill-shot appetite on
// close points (nerves). style is optional (attacker / blocker / chopper
// / allround) — applied FIRST so it shapes the base "personality" of
// this match before context bias fires.
export function selectShotType({ difficulty, incoming, recentTypes, rng, momentumBias, matchState, style, isServeReturn, targetZ }) {
  // Return-of-serve overrides everything else on the AI's first receive.
  // Real players play push/block/flip on serve returns — never loop or
  // smash a short spinny ball. Serve-return weights are also flatter
  // (no style bias applied) because the shot choice is dictated more
  // by the incoming serve's properties than by the AI's personality.
  const baseTable = isServeReturn
    ? (SERVE_RETURN_WEIGHTS[difficulty] || SERVE_RETURN_WEIGHTS.intermediate)
    : (BASE_TYPE_WEIGHTS[difficulty] || BASE_TYPE_WEIGHTS.intermediate);
  let w = { ...baseTable };
  // Style bias FIRST — shapes the personality of this match, then context
  // biases (incoming ball / score / momentum) refine within that identity.
  if (style) w = applyStyleBias(w, style);
  w = applyIncomingBias(w, incoming);
  // Depth coherence AFTER incoming bias, so the target wins the tie — a short
  // incoming ball invites a drop shot, but not to a baseline target.
  w = applyTargetDepthBias(w, targetZ);
  w = applyScoreMarginBias(w, matchState);
  if (typeof momentumBias === 'function') w = momentumBias(w);
  if (difficulty === 'pro') w = applyProTempoMixing(w, recentTypes);
  w = applyAntiRepeat(w, recentTypes);
  return weightedSample(w, rng) || SHOT_TYPES.TOPSPIN_DRIVE;
}

// --- Sidespin ---------------------------------------------------------------
//
// The scalar `spin` above is topspin/backspin — rotation about the lateral
// axis, bending the ball down or floating it. Sidespin is rotation about the
// VERTICAL axis: the ball curls left or right in flight and kicks sideways
// off the bounce. Real rally shots carry it constantly — a brushed slice, a
// sidespin push, a hooked loop — and its absence is one of the tells that
// the opponent is a machine: every ball flies in a vertical plane.
//
// How likely a stroke is to be brushed sideways, as a multiplier on the
// tier's base probability. Grounded in how the strokes are actually hit:
// slices/chops/pushes are wrist-brushed (easy to angle sideways), the flip
// is the banana flick (sidespin is half the point), loops hook/fade, the
// smash is hit flat and hard through the ball — no sidespin, ever.
export const SIDESPIN_TYPE_FACTOR = Object.freeze({
  slice:         1.0,
  flip:          0.9,
  chop:          0.8,
  push:          0.7,
  loop:          0.6,
  block:         0.5,
  drop_shot:     0.5,
  topspin_drive: 0.35,
  lob:           0.2,
  smash:         0.0,
});

// Per-tier base probability and magnitude band (physical rps, always
// positive here — the sign is a fair coin at sample time; left and right are
// equally easy).
//
// Magnitudes are deliberately BELOW the topspin numbers for each tier: the
// solver must cancel sidespin's lateral Magnus drift by aiming off-target
// (see the aim-shift pass in paddleSolver.js) — the bigger the request, the
// bigger the aim offset it has to find. These bands are inside what that
// pass converges on reliably; raise them only against
// tests/paddleSolver.test.js sidespin feasibility numbers.
export const SIDESPIN_BY_DIFFICULTY = Object.freeze({
  beginner:     { prob: 0.45, min: 5.0,  max: 15.0 },
  intermediate: { prob: 0.55, min: 8.0,  max: 22.0 },
  pro:          { prob: 0.60, min: 10.0, max: 27.0 },
});

// Signed sidespin (rps) for one shot, or 0 — most shots still fly straight.
export function sampleSideSpin({ shotType, difficulty, rng }) {
  const tier = SIDESPIN_BY_DIFFICULTY[difficulty] || SIDESPIN_BY_DIFFICULTY.intermediate;
  const factor = SIDESPIN_TYPE_FACTOR[shotType] !== undefined
    ? SIDESPIN_TYPE_FACTOR[shotType]
    : SIDESPIN_TYPE_FACTOR.topspin_drive;
  if (factor <= 0 || rng() >= tier.prob * factor) return 0;
  const mag = tier.min + rng() * (tier.max - tier.min);
  return rng() < 0.5 ? -mag : mag;
}

// Draw concrete speed/spin from the type's Gaussian distribution for THIS
// difficulty (base profile merged with the tier override), clipped first to
// that profile's characteristic bounds and then to the difficulty rail. The
// rail is set clear of every profile bound, so in normal play only the
// profile bounds bite — see PROFILE_OVERRIDES.
//
// sideSpin rides along in the same draw (see sampleSideSpin) so the three
// engines get the full spin state from one call.
export function sampleShotParameters({ shotType, difficulty, rng }) {
  const profile = profileFor(shotType, difficulty);
  const caps    = DIFFICULTY_CAPS[difficulty] || DIFFICULTY_CAPS.intermediate;
  const speedRaw = profile.speedMean + gaussian01(rng) * profile.speedSigma;
  const spinRaw  = profile.spinMean  + gaussian01(rng) * profile.spinSigma;
  const speed = clamp(clamp(speedRaw, profile.speedMin, profile.speedMax),
                      caps.minSpeed, caps.maxSpeed);
  const spin = clamp(clamp(spinRaw, profile.spinMin, profile.spinMax),
                     -caps.maxSpin, caps.maxSpin);
  const sideSpin = sampleSideSpin({ shotType, difficulty, rng });
  return { speed, spin, sideSpin };
}
