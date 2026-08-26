// Ready position — neutral pose the AI paddle returns to between rallies.
// V2 spec §section_4.
//
// Pro AI also shifts ready position slightly based on the player's recent
// landing centroid. This is the "anticipation" skilled human players do
// unconsciously — standing toward where the opponent tends to hit.
// Beginner and Intermediate stay at neutral.
//
// Coordinate notes: spec assumes "AI on z>0 side"; our host has AI on the
// z<0 side (negative z, behind net). We compute the neutral pose RELATIVE
// to tableBox.min.z so the geometry is correct regardless of which side
// the AI sits on. y_m=0.95 above floor in spec → tableSurfaceY+0.19 here
// (table is at y=0.76 in ITTF, paddle held ~19cm above surface).
//
// "Updates between rallies, not during" — refresh of the ready pose
// happens at the RECOVERING→IDLE transition in aiFSM. Per-frame readers
// see a stable value.

import * as THREE from 'three';

// Spec §section_4.neutral_ready_position_world (converted to our coords):
// paddle held at chest height = ~19cm above table surface.
const NEUTRAL_Y_ABOVE_TABLE_M = 0.19;
// Default "13cm behind back edge of AI's half" for allround / attacker
// styles. Choppers stand meters back, blockers stand right on the edge —
// setStyleHomeDistance() overrides at match creation.
const DEFAULT_Z_BEHIND_AI_EDGE_M = 0.13;
let _styleHomeDistance = DEFAULT_Z_BEHIND_AI_EDGE_M;
export function setStyleHomeDistance(m) {
  if (typeof m === 'number' && Number.isFinite(m) && m >= 0 && m < 3) {
    _styleHomeDistance = m;
  }
}
// Legacy constant kept exported for any downstream that read it (tests).
// The runtime value now comes from _styleHomeDistance.
const NEUTRAL_Z_BEHIND_AI_EDGE_M = DEFAULT_Z_BEHIND_AI_EDGE_M;

// Spec §section_4.anticipatory_bias.pro_logic.
const RECENT_LANDINGS_CAPACITY = 10;
const BIAS_FACTOR = 0.30;
const BIAS_CAP_M = 0.20;

// Asymmetric scramble bias (§human-feel improvements): after the AI itself
// reaches wide to hit a ball, real players don't teleport back to center —
// they stay leaning toward the same side because their body momentum is
// there. We record the AI's own last contact x and lean 25% of the way
// back toward it, capped at 18cm so the AI isn't camped out permanently.
const SCRAMBLE_BIAS_FRACTION = 0.25;
const SCRAMBLE_BIAS_CAP_M = 0.18;
// Only apply scramble bias if the AI reached at least this far off-center
// on the last shot — small in-place adjustments shouldn't trigger a lean.
const SCRAMBLE_MIN_OFFSET_M = 0.15;

// Vertical bias based on the last incoming ball. High ball → squat 3cm
// lower on the next rally (real players drop their stance after tracking
// a high ball). Short ball → raise 2cm (poised to lunge for another
// short one at the net). Applied on top of NEUTRAL_Y_ABOVE_TABLE_M.
const HIGH_BALL_HEIGHT_THRESHOLD_M = 0.35;
const SHORT_BOUNCE_DEPTH_THRESHOLD_M = 0.45;
const HIGH_BALL_SQUAT_M = -0.03;
const SHORT_BALL_LIFT_M = 0.02;

// Pre-contact anticipation (spec §pre_contact_lead_time) — the live,
// mid-rally counterpart of the between-rally centroid bias above. The
// moment the AI's own shot is away it KNOWS where the player will have to
// take the ball (its own aim point), and a skilled player is already
// drifting toward the likely reply corridor before the opponent's contact
// — that pre-move is most of what separates "anticipates" from "reacts".
// The corridor comes from the LEARNED return-direction model below: the
// crosscourt return (x sign flips on a diagonal) is the high-margin,
// high-frequency reply, so the prior leans toward the mirror of the AI's
// own target x — and the observed cross/line ratio then drags the lean
// toward what this player actually does. The counter-play stays real: a
// player who reads the lean and goes the other way wrong-foots the AI —
// anticipation SHOULD be punishable, and the cap keeps the punishment
// window honest rather than terminal.
// Beginner doesn't anticipate (reacting late IS the club tell);
// Intermediate leans half; Pro leans fully.
const ANTICIPATION_FRACTION_BY_DIFFICULTY = Object.freeze({
  beginner: 0,
  intermediate: 0.5,
  pro: 1.0,
});
const ANTICIPATION_CAP_M = 0.22;

// --- Return-direction pattern model -----------------------------------------
// The lean above needs a crosscourt probability. It started life as a fixed
// prior (crosscourt is the high-margin return, most players favour it) but
// a fixed prior is exactly the thing a down-the-line player beats all match
// — so the probability is LEARNED: every observed return updates an EWMA of
// "did it cross?", and the lean follows the player who keeps going down the
// line until it points the other way. The prior 0.8 reproduces the original
// fixed lean (expected-return factor 1 − 2p = −0.6) until evidence arrives.
const RETURN_CROSS_PRIOR = 0.8;
const RETURN_CROSS_EWMA_ALPHA = 0.15;
const RETURN_CROSS_MIN = 0.2;
const RETURN_CROSS_MAX = 0.95;
// Contacts near the centre line have no meaningful cross/line identity, and
// returns to the middle vote for neither side.
const RETURN_MIN_CONTACT_X_M = 0.15;
const RETURN_MIN_LANDING_X_M = 0.10;
let _returnCrossProb = RETURN_CROSS_PRIOR;

// Feed one observed return: where the player took the ball (world x) and
// where their return landed on the AI's half (world x).
export function recordReturnDirection(contactX, landingX) {
  if (!Number.isFinite(contactX) || !Number.isFinite(landingX)) return;
  if (Math.abs(contactX) < RETURN_MIN_CONTACT_X_M) return;
  if (Math.abs(landingX) < RETURN_MIN_LANDING_X_M) return;
  const crossed = Math.sign(landingX) !== Math.sign(contactX) ? 1 : 0;
  _returnCrossProb = clamp(
    _returnCrossProb + RETURN_CROSS_EWMA_ALPHA * (crossed - _returnCrossProb),
    RETURN_CROSS_MIN, RETURN_CROSS_MAX,
  );
}

export function getReturnCrossProb() { return _returnCrossProb; }

// Lateral lean toward the expected return corridor, given where the AI just
// aimed its own shot (world x). Returns 0 when the tier doesn't anticipate
// or the aim point is unknown. `crossProb` defaults to the learned pattern
// model; tests pass it explicitly for purity.
export function anticipationLeanX({ difficulty, aiTargetX, baseX = 0, crossProb } = {}) {
  const f = ANTICIPATION_FRACTION_BY_DIFFICULTY[difficulty] ?? 0;
  if (!f || typeof aiTargetX !== 'number' || !Number.isFinite(aiTargetX)) return 0;
  const p = typeof crossProb === 'number' ? crossProb : _returnCrossProb;
  // E[return x] ≈ contact x · (1 − 2p): p = 0.5 leans nowhere, p → 1 leans
  // fully to the mirror side, p < 0.5 (a down-the-line specialist) leans
  // SAME-side — the model can invert the old hardcoded assumption.
  const expectedReturnX = aiTargetX * (1 - 2 * p);
  return clamp((expectedReturnX - baseX) * f, -ANTICIPATION_CAP_M, ANTICIPATION_CAP_M);
}

// Idle "settle" wobble — the paddle sways gently between rallies instead
// of holding a statue pose. Two overlapping sines (different periods and
// axes) produce a natural, non-repeating drift. Amplitudes are small
// enough to not affect gameplay reach.
const IDLE_WOBBLE_AMP_X_M = 0.010;
const IDLE_WOBBLE_AMP_Y_M = 0.006;
const IDLE_WOBBLE_PERIOD_X_MS = 2700;
const IDLE_WOBBLE_PERIOD_Y_MS = 1900;

const _recentLandings = [];
let _lastAIContact = null;       // { x, z } world coords of AI's last strike
let _lastIncomingBall = null;    // { contact_height_m, bounce_depth_m }

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Record a player's outgoing-shot landing on the AI side. Called by
// aiMatch when a player paddle hit produces a known landing point
// (shotAdapter.getLastRollout().bouncePoint). World coords are fine;
// only the centroid matters and that's frame-invariant within a session.
export function recordPlayerLanding(x, z) {
  if (typeof x !== 'number' || typeof z !== 'number') return;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  _recentLandings.push({ x, z });
  if (_recentLandings.length > RECENT_LANDINGS_CAPACITY) _recentLandings.shift();
}

// Reset on mode entry / dispose. New aiMatch sessions start fresh.
export function resetRecentLandings() {
  _recentLandings.length = 0;
  _lastAIContact = null;
  _lastIncomingBall = null;
  _styleHomeDistance = DEFAULT_Z_BEHIND_AI_EDGE_M;
  _returnCrossProb = RETURN_CROSS_PRIOR;
}

// Called when the AI paddle actually strikes the ball. Used to compute
// the "still leaning toward my last shot" scramble bias — real players
// don't magically re-center after reaching wide. World coords.
export function recordAIContact(x, z) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return;
  _lastAIContact = { x, z: (typeof z === 'number' && Number.isFinite(z)) ? z : 0 };
}

// Called when a player's shot is analyzed. Used for the ready-pose
// vertical bias (high ball → squat, short ball → raise).
export function recordIncomingBall(snapshot) {
  if (!snapshot) return;
  _lastIncomingBall = {
    contact_height_m: snapshot.contact_height_m,
    bounce_depth_m:   snapshot.bounce_depth_m,
  };
}

// Additive per-frame offset for the IDLE settle wobble. Callers add the
// returned Vector3 to their drive target. Deterministic on nowMs.
export function idleSettleOffset(nowMs, out) {
  if (!out) out = { x: 0, y: 0, z: 0 };
  const tx = (nowMs % IDLE_WOBBLE_PERIOD_X_MS) / IDLE_WOBBLE_PERIOD_X_MS * Math.PI * 2;
  const ty = (nowMs % IDLE_WOBBLE_PERIOD_Y_MS) / IDLE_WOBBLE_PERIOD_Y_MS * Math.PI * 2;
  out.x = Math.sin(tx) * IDLE_WOBBLE_AMP_X_M;
  out.y = Math.sin(ty) * IDLE_WOBBLE_AMP_Y_M;
  out.z = 0;
  return out;
}

// Test-only inspector.
export function _recentLandingCount() { return _recentLandings.length; }

function computeCentroid() {
  if (_recentLandings.length === 0) return null;
  let sx = 0, sz = 0;
  for (const l of _recentLandings) { sx += l.x; sz += l.z; }
  return { x: sx / _recentLandings.length, z: sz / _recentLandings.length };
}

// Compute the ready pose for the given difficulty.
//
// env: { tableBox: THREE.Box3, tableSurfaceY: number }
// difficulty: 'beginner' | 'intermediate' | 'pro'
//
// Returns: { position: THREE.Vector3, normal: THREE.Vector3 }
export function computeReadyPose({ tableBox, tableSurfaceY, difficulty } = {}) {
  // Defensive fallback for tests / pre-models-loaded calls.
  if (!tableBox) {
    return {
      position: new THREE.Vector3(0, (tableSurfaceY || 0.76) + NEUTRAL_Y_ABOVE_TABLE_M, -1.5),
      normal:   new THREE.Vector3(0, 0.20, 0.98).normalize(),
    };
  }

  const baseX = (tableBox.min.x + tableBox.max.x) / 2;
  const baseY = tableSurfaceY + NEUTRAL_Y_ABOVE_TABLE_M;
  // Style-aware home distance: attackers close, choppers meters back.
  const baseZ = tableBox.min.z - _styleHomeDistance;

  let biasX = 0;
  let biasZ = 0;
  let biasY = 0;

  if (difficulty === 'pro') {
    const centroid = computeCentroid();
    if (centroid) {
      // Bias 30% of the way from neutral toward the centroid, capped at
      // ±0.20m. Without the cap, an extreme centroid could pull ready
      // position off-table.
      biasX = clamp((centroid.x - baseX) * BIAS_FACTOR, -BIAS_CAP_M, BIAS_CAP_M);
      biasZ = clamp((centroid.z - baseZ) * BIAS_FACTOR, -BIAS_CAP_M, BIAS_CAP_M);
    }
  }

  // Scramble bias — after a wide AI contact, don't recenter fully. All
  // difficulties get this because the "body momentum carries" is a
  // biomechanical fact, not a skill signal.
  if (_lastAIContact) {
    const offset = _lastAIContact.x - baseX;
    if (Math.abs(offset) > SCRAMBLE_MIN_OFFSET_M) {
      const scramble = clamp(offset * SCRAMBLE_BIAS_FRACTION, -SCRAMBLE_BIAS_CAP_M, SCRAMBLE_BIAS_CAP_M);
      biasX += scramble;
    }
  }

  // Vertical bias from the last incoming ball — squat after a high one,
  // rise onto the balls of the feet after a short one at the net.
  if (_lastIncomingBall) {
    if (typeof _lastIncomingBall.contact_height_m === 'number'
        && _lastIncomingBall.contact_height_m > HIGH_BALL_HEIGHT_THRESHOLD_M) {
      biasY += HIGH_BALL_SQUAT_M;
    } else if (typeof _lastIncomingBall.bounce_depth_m === 'number'
        && _lastIncomingBall.bounce_depth_m < SHORT_BOUNCE_DEPTH_THRESHOLD_M) {
      biasY += SHORT_BALL_LIFT_M;
    }
  }

  return {
    position: new THREE.Vector3(baseX + biasX, baseY + biasY, baseZ + biasZ),
    normal:   new THREE.Vector3(0, 0.20, 0.98).normalize(),
  };
}

// Exposed constants for tests + downstream tuning.
export const READY_POSITION_CONSTANTS = Object.freeze({
  NEUTRAL_Y_ABOVE_TABLE_M,
  NEUTRAL_Z_BEHIND_AI_EDGE_M,
  RECENT_LANDINGS_CAPACITY,
  BIAS_FACTOR,
  BIAS_CAP_M,
  SCRAMBLE_BIAS_FRACTION,
  SCRAMBLE_BIAS_CAP_M,
  SCRAMBLE_MIN_OFFSET_M,
  HIGH_BALL_HEIGHT_THRESHOLD_M,
  SHORT_BOUNCE_DEPTH_THRESHOLD_M,
  HIGH_BALL_SQUAT_M,
  SHORT_BALL_LIFT_M,
  IDLE_WOBBLE_AMP_X_M,
  IDLE_WOBBLE_AMP_Y_M,
  IDLE_WOBBLE_PERIOD_X_MS,
  IDLE_WOBBLE_PERIOD_Y_MS,
  ANTICIPATION_CAP_M,
  RETURN_CROSS_PRIOR,
  RETURN_CROSS_EWMA_ALPHA,
  RETURN_CROSS_MIN,
  RETURN_CROSS_MAX,
});
