// M7 Review & Stats — the analysis core.
//
// Pure computation over the event log: no scene imports, no rendering. The
// world-space panels that display this need Slice 5's panel toolkit, but none
// of the reasoning below does, so it is built and tested first — the same
// order that worked for M1 (engine verified headless, UI after).
//
// P15 §M7's design rule is enforced here by omission: this module produces
// POST-SESSION analysis. It deliberately exposes nothing shaped like a
// real-time coaching cue, because the in-drill HUD is specified as minimal
// (success tick + streak only) and rich feedback belongs after the session.

import * as THREE from 'three';
import { rolloutToFirstBounce } from '../../physics/rollout.js';
import { solvePaddle } from '../../ai/paddleSolver.js';
import { OUTCOMES } from '../../profile/eventLog.js';

// --- Blade Heatmap ----------------------------------------------------------

// Blade half-extent in metres. A table-tennis blade is ~15 cm across, so
// ±0.085 m covers the face plus the small overhang where edge hits land —
// clipping those to the rim would hide exactly the mishits worth seeing.
const BLADE_EXTENT_M = 0.085;

/**
 * Bin contact points into a square density grid over the blade face.
 *
 * @param {Array<{x,y,stroke}>} points paddle-LOCAL contact points
 * @returns {{grid:number[][], bins:number, extent:number, total:number,
 *            hotspot:{ix,iy,x,y,count}|null, offBlade:number}}
 */
export function bladeHeatmap(points, { bins = 9, extent = BLADE_EXTENT_M, stroke = null } = {}) {
  const grid = Array.from({ length: bins }, () => new Array(bins).fill(0));
  let total = 0;
  let offBlade = 0;

  for (const p of points || []) {
    if (stroke && p.stroke !== stroke) continue;
    const ix = binIndex(p.x, extent, bins);
    const iy = binIndex(p.y, extent, bins);
    if (ix === null || iy === null) {
      // Counted, not silently dropped: a player who keeps missing the blade
      // entirely is the most important case this view has to surface.
      offBlade++;
      continue;
    }
    grid[iy][ix]++;
    total++;
  }

  let hotspot = null;
  for (let iy = 0; iy < bins; iy++) {
    for (let ix = 0; ix < bins; ix++) {
      if (!hotspot || grid[iy][ix] > hotspot.count) {
        hotspot = {
          ix, iy, count: grid[iy][ix],
          x: binCenter(ix, extent, bins),
          y: binCenter(iy, extent, bins),
        };
      }
    }
  }
  if (hotspot && hotspot.count === 0) hotspot = null;

  return { grid, bins, extent, total, hotspot, offBlade };
}

function binIndex(v, extent, bins) {
  if (!Number.isFinite(v)) return null;
  if (v < -extent || v > extent) return null;
  const i = Math.floor(((v + extent) / (2 * extent)) * bins);
  return Math.min(bins - 1, Math.max(0, i));
}

function binCenter(i, extent, bins) {
  const cell = (2 * extent) / bins;
  return -extent + cell * (i + 0.5);
}

// Below this the offset is inside normal shot-to-shot spread and calling it
// out would be noise dressed as insight.
const ADVICE_THRESHOLD_M = 0.012;

/**
 * The one-line reading behind M7's "your loops contact 2 cm low — try earlier
 * timing". Returns null when the contact pattern is well centred, because a
 * report that always finds a fault trains players to ignore it.
 */
export function heatmapAdvice(offset, strokeLabel = 'shots') {
  if (!offset || offset.n === 0) return null;
  const { x, y } = offset;
  if (Math.hypot(x, y) < ADVICE_THRESHOLD_M) return null;

  const parts = [];
  if (Math.abs(y) >= ADVICE_THRESHOLD_M) {
    parts.push(`${(Math.abs(y) * 100).toFixed(1)} cm ${y < 0 ? 'low' : 'high'}`);
  }
  if (Math.abs(x) >= ADVICE_THRESHOLD_M) {
    parts.push(`${(Math.abs(x) * 100).toFixed(1)} cm ${x < 0 ? 'toward the handle' : 'toward the tip'}`);
  }
  // Timing hint only for the vertical axis — a lateral offset is a spacing
  // problem, not a timing one, and conflating them would give wrong advice.
  const hint = Math.abs(y) >= ADVICE_THRESHOLD_M
    ? (y < 0 ? ' — try contacting earlier' : ' — try contacting later')
    : ' — adjust your spacing to the ball';

  return `Your ${strokeLabel} contact ${parts.join(' and ')}${hint}`;
}

// --- Why-Did-I-Miss ---------------------------------------------------------

// M7: "One screen, three facts, no lecture." The three facts are the contact
// point, the angle error, and the two landings — nothing else is returned.

export const FAULTS = Object.freeze({
  ANGLE: 'angle',       // face was pointed wrong
  CONTACT: 'contact',   // struck off-centre on the blade
  UNSOLVED: 'unsolved', // no reference shot existed to compare against
  NONE: 'none',
});

// A face-normal error past this dominates any contact-point error: ~6° is
// already enough to put a deep drive off the end of the table.
const ANGLE_FAULT_DEG = 6;
const CONTACT_FAULT_M = 0.025;

/**
 * Compare what the player did at contact against what the solver says was
 * required to land the ball on `target`.
 *
 * The reference costs nothing to produce — B7's solvePaddle already computes
 * the required face normal for a commanded landing, which is precisely the
 * "what you should have done" half of this screen.
 *
 * @returns {{
 *   angleErrorDeg:number|null, requiredNormal:THREE.Vector3|null,
 *   actualLanding:{x,z}|null, wouldHaveLanding:{x,z}|null,
 *   contactOffsetM:number|null, primaryFault:string, feasible:boolean
 * }}
 */
export function whyDidIMiss({
  contactPos, contactVel, contactSpin,
  actualFaceNormal, actualOutVel, actualOutSpin,
  contactLocal = null,
  target = { x: 0, z: 1.0 }, targetSpeed = 8, targetSpin = 0,
  difficulty = 'intermediate', env,
}) {
  const solved = safeSolve({
    targetX: target.x, targetZ: target.z, targetSpeed, targetSpin,
    contactPos, contactVel, contactSpin, difficulty, env,
  });

  // Where the ball actually went, rolled forward through the shared
  // integrator so this agrees with what the player saw.
  const actualLanding = (actualOutVel && contactPos)
    ? rolloutToFirstBounce(contactPos, actualOutVel,
      actualOutSpin || new THREE.Vector3(), env)
    : null;

  let angleErrorDeg = null;
  if (solved && solved.feasible && actualFaceNormal && solved.faceNormal) {
    const a = actualFaceNormal.clone().normalize();
    const b = solved.faceNormal.clone().normalize();
    angleErrorDeg = THREE.MathUtils.radToDeg(Math.acos(clamp(a.dot(b), -1, 1)));
  }

  const contactOffsetM = contactLocal
    ? Math.hypot(contactLocal.x || 0, contactLocal.y || 0)
    : null;

  return {
    angleErrorDeg: angleErrorDeg === null ? null : round2(angleErrorDeg),
    requiredNormal: solved && solved.feasible ? solved.faceNormal : null,
    actualLanding: actualLanding ? { x: round3(actualLanding.x), z: round3(actualLanding.z) } : null,
    wouldHaveLanding: solved && solved.feasible && solved.predictedLanding
      ? { x: round3(solved.predictedLanding.x), z: round3(solved.predictedLanding.z) }
      : null,
    contactOffsetM: contactOffsetM === null ? null : round3(contactOffsetM),
    primaryFault: classifyFault(angleErrorDeg, contactOffsetM, solved),
    feasible: !!(solved && solved.feasible),
  };
}

// The solver runs on untrusted recorded state and can throw on degenerate
// input (a zero-length contact velocity, say). A diagnosis screen must never
// be the thing that crashes a session review.
function safeSolve(args) {
  try {
    return solvePaddle(args);
  } catch (e) {
    return null;
  }
}

function classifyFault(angleErrorDeg, contactOffsetM, solved) {
  if (!solved || !solved.feasible) return FAULTS.UNSOLVED;
  const angleBad = angleErrorDeg !== null && angleErrorDeg >= ANGLE_FAULT_DEG;
  const contactBad = contactOffsetM !== null && contactOffsetM >= CONTACT_FAULT_M;
  if (angleBad && contactBad) {
    // Report the one that dominates rather than both — "no lecture".
    return (angleErrorDeg / ANGLE_FAULT_DEG) >= (contactOffsetM / CONTACT_FAULT_M)
      ? FAULTS.ANGLE : FAULTS.CONTACT;
  }
  if (angleBad) return FAULTS.ANGLE;
  if (contactBad) return FAULTS.CONTACT;
  return FAULTS.NONE;
}

// --- Weakness Report --------------------------------------------------------

// M7: "each weakness links a drill preset". Mapping the failure dimension to
// the preset that trains it is the whole value — a report that only names
// weaknesses leaves the player to guess what to do about it.
const SPIN_TO_PRESET = {
  back: 'BackspinPush',
  top: 'FHTopspin',
  none: 'Warmup',
  'side-L': 'RandomLight',
  'side-R': 'RandomLight',
  combo: 'RandomLight',
};

// Zone columns: 1/4/7 are one wing, 3/6/9 the other, 2/5/8 the middle.
function zonePreset(zone) {
  const col = (zone - 1) % 3;
  if (col === 0) return 'BHTopspin';
  if (col === 2) return 'FHTopspin';
  return 'SmashSetup';
}

// Below this a "weakness" is a couple of unlucky balls, not a pattern.
const MIN_ATTEMPTS = 5;

/**
 * Rank the player's failure modes, worst first, each linked to the preset that
 * drills it.
 *
 * Dimensions with too few attempts are excluded rather than ranked on noise;
 * `insufficientData` reports what was skipped so the UI can say "not enough
 * data yet" instead of implying the player has no weakness there.
 */
export function weaknessReport(log, { minAttempts = MIN_ATTEMPTS, limit = 3 } = {}) {
  const items = [];
  const insufficient = [];

  for (const [zone, v] of log.errorsByZone()) {
    const entry = {
      kind: 'zone', key: zone, label: `Zone ${zone}`,
      attempts: v.attempts, failures: v.failures, rate: v.rate,
      preset: zonePreset(zone),
    };
    (v.attempts >= minAttempts ? items : insufficient).push(entry);
  }

  for (const [spin, v] of log.errorsBySpin()) {
    const entry = {
      kind: 'spin', key: spin, label: `${spin} spin`,
      attempts: v.attempts, failures: v.failures, rate: v.rate,
      preset: SPIN_TO_PRESET[spin] || 'RandomLight',
    };
    (v.attempts >= minAttempts ? items : insufficient).push(entry);
  }

  // Rank by failure rate, breaking ties on sample size so a 3/5 outranks a
  // 6/10 only when it is genuinely worse, not merely noisier.
  items.sort((a, b) => (b.rate - a.rate) || (b.attempts - a.attempts));

  // A dimension the player never failed is a STRENGTH. Listing "Zone 5 — 0%
  // missed" under weaknesses and prescribing a drill for it is worse than
  // unhelpful: it buries the real weaknesses and sends the player to practise
  // something they already do. `all` keeps them for the full breakdown.
  const failing = items.filter((w) => w.failures > 0);

  return {
    weaknesses: failing.slice(0, limit),
    all: items,
    insufficientData: insufficient,
  };
}

/** Overall session headline for the top of the report. */
export function sessionHeadline(log) {
  const counts = log.outcomeCounts();
  const total = counts.returned + counts.miss + counts.error;
  if (total === 0) return 'No balls played yet';
  const pct = Math.round(log.returnRate() * 100);
  return `${counts.returned}/${total} returned (${pct}%) · longest rally ${log.longestRally()}`;
}

// --- helpers ----------------------------------------------------------------

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

export { OUTCOMES };
