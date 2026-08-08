// P13 spec §C8 — passive calibration drift detection.
//
// Reads the contact ring buffer and flags likely-stale calibration. Two
// independent signals (either fires the flag):
//
//   1) Median |r_c| offset direction is consistent AND magnitude > 25 mm.
//      Consistency = circular variance of r_c angles < 0.3. Interpretation:
//      the player systematically hits the ball off-center in the same
//      direction — grip has shifted, calibration center is now elsewhere.
//
//   2) Fraction of "flat" hits (|u_t|/|v_n| < 0.3) that land LONG or SHORT
//      with the SAME sign > 70%. Interpretation: face pitch is systematically
//      off — a paddle that should be square is not.
//
// The flag is a display cue — never auto-adjusts T_cal. Player must open the
// wizard themselves. Spec §C8 rationale: silent changes break the player's
// trust in cause and effect.

import { snapshot, count } from './contactLog.js';

const MIN_SAMPLES = 40;         // spec: rolling window of last 40 hits
const CIRC_VAR_THRESHOLD = 0.3;
const MEDIAN_RC_THRESHOLD_M = 0.025;
const FLAT_UT_VN_THRESHOLD = 0.3;
const FLAT_LAND_SIGN_THRESHOLD = 0.70;

/**
 * Returns { drifted: boolean, reason: 'off-center' | 'flat-bias' | null }.
 * `drifted=false` when there aren't enough samples yet OR neither branch
 * fires. The reason string exists so a HUD tooltip can be specific about
 * why the wizard is being suggested.
 */
export function evaluate() {
  if (count() < MIN_SAMPLES) return { drifted: false, reason: null };

  const samples = snapshot();

  // --- Branch 1: consistent off-center strike direction ---
  // We treat r_c as a 2-vector in the disc plane using its x and y components
  // (paddleFaceOffset's local frame; z is normal-direction and near zero for
  // a face hit). Circular variance V = 1 - |R|, where R = mean unit vector.
  let sumX = 0, sumY = 0;
  const mags = [];
  for (const s of samples) {
    const m = Math.hypot(s.rcX, s.rcY);
    if (m > 1e-9) {
      sumX += s.rcX / m;
      sumY += s.rcY / m;
    }
    mags.push(m);
  }
  const R = Math.hypot(sumX, sumY) / samples.length;
  const circVar = 1 - R;
  mags.sort((a, b) => a - b);
  const medianRc = mags[Math.floor(mags.length / 2)];
  if (circVar < CIRC_VAR_THRESHOLD && medianRc > MEDIAN_RC_THRESHOLD_M) {
    return { drifted: true, reason: 'off-center' };
  }

  // --- Branch 2: flat hits land same-sign long/short ---
  // Only counts entries where landZSign is populated (0 = not yet resolved
  // by a following table bounce). If too few resolved samples, skip.
  let flatCount = 0;
  let flatLong = 0;   // +1
  let flatShort = 0;  // -1
  for (const s of samples) {
    if (s.utOverVn < FLAT_UT_VN_THRESHOLD && s.landZSign !== 0) {
      flatCount++;
      if (s.landZSign > 0) flatLong++;
      else flatShort++;
    }
  }
  if (flatCount >= 10) {  // guard against tiny sub-samples
    const longFrac = flatLong / flatCount;
    const shortFrac = flatShort / flatCount;
    if (longFrac > FLAT_LAND_SIGN_THRESHOLD || shortFrac > FLAT_LAND_SIGN_THRESHOLD) {
      return { drifted: true, reason: 'flat-bias' };
    }
  }

  return { drifted: false, reason: null };
}

// Convenience for UI code that just wants a boolean.
export function getDriftFlag() {
  return evaluate().drifted;
}
