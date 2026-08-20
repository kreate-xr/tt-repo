// Perceived paddle weight — one scalar, wired to the channels that actually
// carry heft, in the order they carry it.
//
// The ranking matters more than any individual number here. From heaviest to
// lightest contribution:
//
//   1. Ball response. What the ball DOES off the face is most of the felt
//      mass — a heavy blade returns a ball that leaves harder and drops less.
//      That lives in the restitution curve + contact speed cap in
//      constants.js, NOT here. This module deliberately does not touch them:
//      they are already tuned and shared with the AI solver, and re-deriving
//      them from a weight slider would desync the AI's inverse model. Weight
//      is a *presentation* layer on top of an already-meaty impulse.
//   2. Haptics. Amplitude and duration envelopes only — WebXR's
//      `hapticActuator.pulse(value, durationMs)` exposes no frequency control,
//      so "heavier" can only mean stronger and/or longer. The arm integrates
//      vibration over ~200 ms, so duration is the more convincing of the two.
//      These numbers are a starting point and MUST be re-tuned on-device;
//      Quest motor response is not linear in `value`.
//   3. Audio. Bigger objects ring lower. A heavier blade's contact body drops
//      in pitch and rings marginally longer. Cross-modal — the ear tells the
//      hand what it just felt.
//   4. Visual pseudo-inertia. OFF by default, and weight does NOT turn it on.
//      See PSEUDO_INERTIA_ENABLED below for why.
//
// Everything is expressed as a symmetric deviation about the `allround` class
// (weight 0.5), so the default setting reproduces the pre-weight behavior
// exactly — every scale function returns 1.0 (or its input unchanged) at 0.5.
// That makes "is the weight system doing anything?" a decidable question and
// keeps A/B against the shipped feel honest.

import { swingWeightScale, paddleMassProperties } from './paddleSpec.js';

const clamp01 = (v) => (v > 1 ? 1 : v < 0 ? 0 : v);

// Named classes, with the real bat masses they stand for.
//
// CORRECTED: these used to read 72 / 85 / 98 g, which is the mass of a BARE
// BLADE. An assembled competition racket — blade plus two rubber sheets, which
// is what the player is holding — runs 165–195 g, because a sheet of rubber
// with its sponge is another 45–50 g per side. The old numbers described a bat
// nobody plays with, and they disagreed by a factor of two with the mass that
// physics/paddleSpec.js derives from the actual geometry (~188 g), which would
// have put two contradictory weights on screen. `allround` is pinned to the
// shipped spec's own mass so the display and the bat agree by construction.
//
// Only the display changes: the 0/0.5/1 weight scalar is what drives every
// feel channel, and those are untouched.
export const WEIGHT_CLASSES = {
  light:    { weight: 0.0, grams: 167 },
  allround: { weight: 0.5, grams: 185 },
  heavy:    { weight: 1.0, grams: 203 },
};

export const DEFAULT_WEIGHT = WEIGHT_CLASSES.allround.weight;

// Live binding — consumers read it inside per-hit functions, so a change from
// the tuner takes effect on the next contact with no re-import.
export let PADDLE_WEIGHT = DEFAULT_WEIGHT;

export function setPaddleWeight(v) {
  PADDLE_WEIGHT = clamp01(Number(v) || 0);
}

// Convenience for menus / calibration presets that think in names, not scalars.
// Unknown names fall back to `allround` rather than throwing — a bad adapter
// preset should not take the session down mid-swing.
export function setPaddleWeightClass(name) {
  const c = WEIGHT_CLASSES[name] || WEIGHT_CLASSES.allround;
  PADDLE_WEIGHT = c.weight;
  return PADDLE_WEIGHT;
}

// Grams for display. Linear between the class anchors.
export function paddleWeightGrams(weight = PADDLE_WEIGHT) {
  const w = clamp01(weight);
  const { light, heavy } = WEIGHT_CLASSES;
  return light.grams + (heavy.grams - light.grams) * w;
}

// Signed deviation from neutral, in [-0.5, +0.5]. Every channel below is a
// linear function of this, so `deviation(0.5) === 0` is the single invariant
// that makes the default a no-op.
function deviation(weight) {
  return clamp01(weight) - DEFAULT_WEIGHT;
}

// --- Channel 2: haptics -----------------------------------------------------
// Full-range spread (light → heavy) as a fraction of the base value. Duration
// is the wider of the two on purpose: at a fixed amplitude, a longer pulse
// reads as more mass transfer, whereas cranking amplitude alone mostly reads
// as "louder buzz" and starts to tickle rather than thud.
export const HAPTIC_WEIGHT_AMP_RANGE = 0.30;   // ±15% amplitude about neutral
export const HAPTIC_WEIGHT_DUR_RANGE = 0.50;   // ±25% duration about neutral

// Shape an already-computed impact envelope for the current blade. Takes and
// returns amplitude + duration only — there is no frequency term to shape.
// Intensity stays clamped to [0,1] (pulse() rejects out-of-range values);
// duration is floored at 1 ms so a light blade can never produce a 0 ms pulse,
// which some runtimes treat as "cancel".
export function hapticWeightEnvelope(intensity, durationMs, weight = PADDLE_WEIGHT) {
  const d = deviation(weight);
  const amp = intensity * (1 + HAPTIC_WEIGHT_AMP_RANGE * d);
  const dur = durationMs * (1 + HAPTIC_WEIGHT_DUR_RANGE * d);
  return {
    intensity: Math.min(1, Math.max(0, amp)),
    durationMs: Math.max(1, Math.round(dur)),
  };
}

// --- Channel 3: audio -------------------------------------------------------
// Applied to the sub-bass "body" layer of the contact sound only; the
// high-frequency rubber click is a property of the rubber, not the blade mass,
// and shifting it just makes the hit sound like a different ball.
export const AUDIO_WEIGHT_FREQ_RANGE  = 0.30;  // ±15% body pitch, INVERTED
export const AUDIO_WEIGHT_DECAY_RANGE = 0.30;  // ±15% body ring length
export const AUDIO_WEIGHT_GAIN_RANGE  = 0.20;  // ±10% body level

export function audioWeightShape(weight = PADDLE_WEIGHT) {
  const d = deviation(weight);
  return {
    // Heavier → lower. This is the whole cue; the other two just keep the
    // lower pitch from sounding thin next to the unchanged click.
    bodyFreqScale:  1 - AUDIO_WEIGHT_FREQ_RANGE * d,
    bodyDecayScale: 1 + AUDIO_WEIGHT_DECAY_RANGE * d,
    bodyGainScale:  1 + AUDIO_WEIGHT_GAIN_RANGE * d,
  };
}

// --- Channel 4: visual ------------------------------------------------------
// Tracking lag as a weight cue (Rietzler's pseudo-haptics) works in a seated
// desktop demo and fails in a racket sport: the paddle is the one object the
// player is aiming with, and lag between the hand and the blade is read as
// broken tracking long before it is read as mass. It also breaks the
// contact-visual agreement budget — the rendered face is no longer where the
// collision face is.
//
// So: OFF, and the weight slider does not turn it on. Note that the lerp
// alphas in constants.js (PADDLE_POS_SMOOTHING / PADDLE_ROT_SMOOTHING) do NOT
// sit at 1.0 — they ship at 0.65, ~17 ms of added lag at 90 Hz, a standing
// feel choice made there and documented at their definition. That smoothing is
// fixed and tuner-adjustable; what stays off is any coupling from THIS
// module's weight scalar into it. If anyone does revisit that coupling, the
// two constraints from the feel notes are non-negotiable:
//   - whole-group only. The lag goes on the single paddleAnchor pose that the
//     mesh AND the physics tick both read (see xrPaddle.js). Lagging the face
//     mesh alone would put the visual and the collider in different places.
//   - tiny lag, fast recovery. A long tail turns every stroke into a fight.
//
// The post-impact recoil in xr/paddleRecoil.js is the sanctioned visual cue
// instead: it is whole-group, it pivots at the hand so nothing detaches, and
// it is fully recovered in 130 ms. Weight scales its magnitude below.
export const PSEUDO_INERTIA_ENABLED = false;

export const RECOIL_WEIGHT_RANGE = 0.40;       // ±20% kick-back about neutral

// --- Channel 0: the bat's own geometry --------------------------------------
// The slider above is a preference. The bat is a fact: physics/paddleSpec.js
// integrates mass over the same silhouette the mesh is extruded from, so a
// longer handle or thicker sponge changes the second moment about the grip
// whether or not anyone touches the slider. That is the honest source of heft,
// and it is why this factor is separate from `deviation` — one is what the
// player asked for, the other is what they are holding.
//
// Sub-linear (square root) and clamped: swing weight scales as the square of
// how far mass sits from the hand, so a raw ratio turns a 15% longer handle
// into a 40% louder kick. The clamp is a guard against a spec override
// (`?paddle.handleLength=…`) driving the visual off the rails mid-session.
export const GEOMETRY_SWING_EXPONENT = 0.5;
export const GEOMETRY_SWING_MIN = 0.6;
export const GEOMETRY_SWING_MAX = 1.6;

export function geometrySwingScale() {
  const s = swingWeightScale();
  if (!(s > 0)) return 1;
  return Math.min(GEOMETRY_SWING_MAX,
    Math.max(GEOMETRY_SWING_MIN, Math.pow(s, GEOMETRY_SWING_EXPONENT)));
}

// Live mass properties of the bat actually in hand, for HUD/tuner display.
// Grams here is measured, not looked up — WEIGHT_CLASSES is the player-facing
// approximation, this is the truth.
export function paddleMeasuredProperties() {
  return paddleMassProperties();
}

// Multiplier for the recoil peak. Heavier blade decelerates less at contact in
// reality — but it also pivots further in a relaxed grip, which is what the
// eye sees, so heavier reads as more kick.
//
// Exactly 1.0 for the default slider position AND the shipped spec, preserving
// this module's feel-neutrality contract: the geometry term is a ratio against
// the shipped bat, so it is 1 until someone changes the bat.
export function recoilWeightScale(weight = PADDLE_WEIGHT) {
  return (1 + RECOIL_WEIGHT_RANGE * deviation(weight)) * geometrySwingScale();
}
