// FeedEngine — the M1 Ball Machine's core: a DrillConfig in, a fully solved
// and forward-VERIFIED feed out.
//
// This is the half of the old feeder.js that is not animation. The split is
// migration-plan D4: nothing here imports js/scene/*, geometry arrives via an
// injected `env`, so the whole aiming path is testable headless. ServerFigure
// (the windup→swing→recover animation) keeps the scene dependency and stays
// where it is.
//
//   env = { ballRadius, tableSurfaceY, tableBox, netBox }
//
// ── WHY A SEARCH AND NOT A CLOSED FORM ──────────────────────────────────────
//
// The old feeder called serveBallistic(), a closed-form solve under gravity
// plus a drag correction factor. That is fine for a serve whose only
// requirement is "bounce twice, roughly there". M1 is stricter: it commands a
// post-contact SPEED and a landing point, and its TEST clause asks for 2 cm
// placement accuracy under spin up to the solver envelope. Magnus curvature
// has no closed-form inverse, so a commanded speed plus a commanded landing
// point has to be solved numerically and then verified by rolling the shot
// forward through the same integrator the live ball uses.
//
// That verification is the point. `rolloutToSurfacePlane` steps the shot with
// physics/rollout.js — the same module ball.js mirrors — so a feed that
// reports "lands at X" lands at X in play, rather than in an approximation
// that has drifted from the engine.
//
// ── WHAT "ARC" CAN AND CANNOT MEAN ──────────────────────────────────────────
//
// Given a launch point, a commanded speed and a commanded landing point,
// exactly TWO trajectories exist: a flat one and a lofted one (the classic
// ballistic pair, deformed by drag and Magnus but still a pair). Their net
// clearances are therefore already determined — arc cannot be an independent
// constraint on top of speed and placement without over-determining the
// system.
//
// So arc SELECTS between the two achievable trajectories, picking whichever
// clearance sits closest to the spec's target for that arc (flat 0.05 m,
// medium 0.15 m, lob 0.5 m). The clearance actually achieved is reported back
// as `netClearance` so the UI can show the truth rather than the request.
// In practice flat and medium both resolve to the low branch at most speeds
// and lob to the high one.

import * as THREE from 'three';
import {
  rolloutToSurfacePlane, rolloutToFirstBounce, DT_PRESETS,
} from '../../physics/rollout.js';
import {
  validateConfig, resolveSpinVector, ARC_NET_CLEARANCE, INFINITE,
} from './drillConfig.js';
import { gaussianPair } from '../../util/rng.js';

// Coarser than DT_PRESETS.VERIFY: the elevation search runs ~120 rollouts per
// feed, and at this stage it only needs to bracket an angle. The final answer
// is always re-verified at VERIFY fidelity before it leaves this module.
const DT_SEARCH = 0.004;

// Elevation search bounds (radians from horizontal). The lower bound is
// slightly negative because a machine mounted above table height can feed
// downward; the upper bound is past the drag-shifted peak-range angle.
// A fast feed has to be aimed BELOW horizontal: at 15 m/s the ball covers the
// table's length long before gravity brings it down from muzzle height, so the
// solution sits at a negative elevation. Clamping at −0.35 rad pinned those
// shots against the boundary — Newton stalled there with ~2 cm of residual
// error that no number of iterations could remove.
const THETA_MIN = -0.9;
// Generous upper bound: a lob onto a short target needs a genuinely steep
// launch, and clamping at 1.35 rad (77°) stopped Newton converging on exactly
// those shots. The peak-range angle sits far below this, so widening it costs
// the search nothing and only gives the high branch room.
const THETA_MAX = 1.45;

const TERNARY_ITERS = 14;
const BISECT_ITERS = 18;

// Newton refinement. 6 iterations is generous — convergence is quadratic once
// the initial guess is on the right branch, and heavy sidespin (the worst
// case, curving the ball over a metre off the aim line) settles in about 3.
const NEWTON_ITERS = 12;
const NEWTON_H = 0.01;       // finite-difference step, radians
const NEWTON_MAX_STEP = 0.30; // radians; stops a bad Jacobian throwing the
                              // solution onto the other trajectory branch

// Convergence target, well inside M1's 2 cm tolerance so the remaining budget
// absorbs the search-dt → verify-dt shift.
const AIM_TOL_M = 0.002;

// Minimum distance past the net for any commanded landing point. A target
// closer than this is not feedable at the low end of the speed range — the
// ball has to clear a 15.25 cm net and come down again within a few
// centimetres, which no launch angle achieves. Clamping here means the
// machine never COMMANDS a shot it cannot make; genuine infeasibility is
// still reported rather than hidden.
const MIN_NET_INSET_M = 0.12;

const _up = new THREE.Vector3(0, 1, 0);

// --- Geometry ---------------------------------------------------------------

// Rows of the 3×3 grid, near-net first. Depth overrides which row is used
// (M1: "depth — overrides placement y-band"), so the two share this mapping.
const DEPTH_ROW = { short: 0, 'half-long': 1, deep: 2 };

/**
 * Centre of a 3×3 placement zone on the PLAYER's half.
 *
 * Zones read like a phone keypad with 5 in the middle: 1–3 nearest the net,
 * 7–9 nearest the player's end line. Row is taken from `depth` rather than
 * from the zone, per the spec's override rule; the zone supplies the column.
 *
 * Player half is +z (the feeder sits at −z), matching the existing feeder and
 * models.js.
 */
export function zoneTarget(config, env, out = new THREE.Vector3()) {
  const { tableBox, tableSurfaceY } = env;
  const centerZ = (tableBox.min.z + tableBox.max.z) / 2;
  const halfDepth = tableBox.max.z - centerZ;
  const width = tableBox.max.x - tableBox.min.x;

  if (config.placement.kind === 'free') {
    // Free point — clamp into the player's half with a small inset so a
    // teleport-cursor drop on the very edge still produces a legal feed.
    const inset = 0.04;
    return out.set(
      clamp(config.placement.x, tableBox.min.x + inset, tableBox.max.x - inset),
      tableSurfaceY,
      clamp(config.placement.z, centerZ + MIN_NET_INSET_M, tableBox.max.z - inset),
    );
  }

  const col = (config.placement.zone - 1) % 3;
  const row = DEPTH_ROW[config.depth];

  // Band centres at 1/6, 3/6, 5/6 across each axis — a sixth in from each
  // edge, which keeps the outer zones clear of the edge without collapsing
  // them toward the middle.
  const x = tableBox.min.x + width * ((col * 2 + 1) / 6);
  const z = centerZ + halfDepth * ((row * 2 + 1) / 6);
  return out.set(x, tableSurfaceY, z);
}

/**
 * Machine muzzle position for a feed origin (M1: "machine pos: L/center/R ×
 * near/far — changes incoming angle").
 *
 * `far` sits back behind the end line, which lengthens the flight and
 * flattens the incoming angle; `near` sits just off the end line like the
 * current feeder.
 */
export function originPosition(config, env, out = new THREE.Vector3()) {
  const { tableBox, tableSurfaceY } = env;
  const centerX = (tableBox.min.x + tableBox.max.x) / 2;
  const halfWidth = (tableBox.max.x - tableBox.min.x) / 2;

  const [side, dist] = config.feedOrigin.split('-');
  const lateral = side === 'L' ? -halfWidth * 0.6 : side === 'R' ? halfWidth * 0.6 : 0;
  const z = dist === 'far' ? tableBox.min.z - 0.40 : tableBox.min.z + 0.05;

  // Muzzle height. 0.38 m above the surface rather than the old feeder's
  // 0.25 m: a short feed has to drop onto a point ~23 cm past a 15.25 cm net,
  // and from 25 cm the flattest trajectory that reaches there crosses the net
  // 4 mm LOW — measurably unfeedable. The extra height buys the descent angle
  // that makes short balls possible, and matches where a real ball machine's
  // muzzle actually sits.
  return out.set(centerX + lateral, tableSurfaceY + 0.38, z);
}

/**
 * Apply placement scatter. Gaussian in both axes with the config's σ, which is
 * what M1's χ² fit expects — a uniform box would fail that test even at the
 * right spread.
 *
 * Draws exactly one gaussian PAIR per feed so the stream advances by a fixed
 * amount per logical event; a replay stays aligned even if σ changes.
 */
export function applyScatter(target, sigma, rng, env) {
  if (!(sigma > 0) || typeof rng !== 'function') return target;
  const pair = gaussianPair(rng);
  target.x += pair.x * sigma;
  target.z += pair.y * sigma;

  // Keep the jittered point on the player's half — a 0.4 m σ can otherwise
  // push a deep-corner target off the table, which would command a feed that
  // is a miss by construction.
  const { tableBox } = env;
  const centerZ = (tableBox.min.z + tableBox.max.z) / 2;
  const inset = 0.03;
  target.x = clamp(target.x, tableBox.min.x + inset, tableBox.max.x - inset);
  target.z = clamp(target.z, centerZ + MIN_NET_INSET_M, tableBox.max.z - inset);
  return target;
}

// --- Aiming -----------------------------------------------------------------

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Launch velocity for a given elevation angle about the horizontal aim
// direction, at fixed speed.
function velocityAt(dir, speed, theta, out) {
  return out.copy(dir).multiplyScalar(speed * Math.cos(theta))
    .addScaledVector(_up, speed * Math.sin(theta));
}

// Signed horizontal range achieved at an elevation angle, measured along the
// aim direction. Returns null when the shot never comes down (shouldn't
// happen inside the angle bounds, but the rollout can bail on step ceiling).
function rangeAt(spawn, dir, speed, spin, theta, env, dt, scratch) {
  const vel = velocityAt(dir, speed, theta, scratch.vel);
  const r = rolloutToSurfacePlane(spawn, vel, spin, env, { dt });
  if (!r) return null;
  return (r.x - spawn.x) * dir.x + (r.z - spawn.z) * dir.z;
}

/**
 * Solve the elevation angle that lands the ball at `range` along `dir`.
 *
 * Range as a function of elevation is unimodal (rises to a peak near 45°,
 * shifted down by drag, then falls), so there are two roots. `branch` picks
 * which: 'low' is the flat/driven trajectory, 'high' the lofted one.
 *
 * @returns {{theta:number, feasible:boolean}} feasible is false when even the
 *          peak-range angle cannot reach the target at this speed — the caller
 *          gets the best-effort angle rather than nothing, so the machine
 *          still feeds a ball and the UI can say "too slow to reach there".
 */
export function solveElevation(spawn, dir, speed, spin, range, env, branch, dt = DT_SEARCH) {
  const scratch = { vel: new THREE.Vector3() };
  const f = (t) => rangeAt(spawn, dir, speed, spin, t, env, dt, scratch);

  // Locate the peak-range angle by ternary search on a unimodal function.
  let lo = THETA_MIN;
  let hi = THETA_MAX;
  for (let i = 0; i < TERNARY_ITERS; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const r1 = f(m1);
    const r2 = f(m2);
    if (r1 === null || r2 === null) break;
    if (r1 < r2) lo = m1; else hi = m2;
  }
  const thetaPeak = (lo + hi) / 2;
  const peakRange = f(thetaPeak);

  if (peakRange === null) return { theta: 0.25, feasible: false, peakRange: 0 };
  if (peakRange < range) {
    // Out of reach at this speed. Report the furthest this speed CAN carry
    // the ball so the caller can bring the target within reach rather than
    // launching a shot that is short by construction.
    return { theta: thetaPeak, feasible: false, peakRange };
  }

  // Bisect the requested side of the peak. Range is monotonic on each side,
  // so a plain bisection is stable here.
  let a = branch === 'high' ? thetaPeak : THETA_MIN;
  let b = branch === 'high' ? THETA_MAX : thetaPeak;
  for (let i = 0; i < BISECT_ITERS; i++) {
    const mid = (a + b) / 2;
    const r = f(mid);
    if (r === null) { b = mid; continue; }
    // Below the peak range increases with angle; above it decreases.
    const tooShort = branch === 'high' ? (r > range) : (r < range);
    if (tooShort) a = mid; else b = mid;
  }
  return { theta: (a + b) / 2, feasible: true, peakRange };
}

/**
 * Solve a complete feed: config → launch velocity, spin, and the landing point
 * it actually produces when rolled forward through the shared integrator.
 *
 * The aim-correction loop is what delivers the placement accuracy. The
 * elevation search nails the range ALONG the aim direction, but sidespin
 * curves the ball off that line, so the residual is corrected by moving the
 * aim point against the observed error and re-solving. Three iterations
 * converge well inside 2 cm because the error map is near-identity.
 *
 * @returns {{
 *   spawn, velocity, spin, commandedLanding, verifiedLanding,
 *   netClearance, clearedNet, onTable, feasible, errorM
 * }}
 */
export function solveFeed(rawConfig, env, { rng = null, target = null } = {}) {
  const config = validateConfig(rawConfig);

  const spawn = originPosition(config, env);
  const commanded = target
    ? target.clone()
    : applyScatter(zoneTarget(config, env), config.scatterSigma, rng, env);

  const s = resolveSpinVector(config);
  const spin = new THREE.Vector3(s.x, s.y, s.z);
  const speed = config.speed;

  // Bearing from the machine to the commanded point. Azimuth is solved as an
  // OFFSET from this, so φ = 0 is the naive "point straight at it" aim and the
  // solver only has to find the sidespin correction.
  const baseDir = new THREE.Vector3();
  let range = horizontalDir(spawn, commanded, baseDir);

  // ── REACH CLAMP ───────────────────────────────────────────────────────────
  //
  // A commanded speed and a commanded landing point can contradict each
  // other: 5 m/s cannot carry a ball the ~2.9 m from the far machine position
  // to a deep target (ballistic max range at 45° is v²/g ≈ 2.55 m, and drag
  // makes it worse). Previously the solver reported `feasible: false` and
  // returned its best effort — a shot that pitched on the MACHINE's own half
  // and never crossed the net.
  //
  // A ball machine should always put the ball on the player's side; speed is
  // meant to control pace, not whether the ball arrives. So when the target
  // is out of reach, the TARGET is pulled in along the same bearing until it
  // is reachable, rather than the speed being silently raised (which would
  // ignore what the player asked for) or the shot being fired short.
  //
  // Spin matters here and is not a separate knob: Magnus scales with speed
  // (a = k·ω×v), so at low speed heavy topspin shortens the reachable range
  // further. Measuring the reach with the ACTUAL spin, rather than assuming a
  // drag-free envelope, is what keeps this correct across spin types.
  let reachClamped = false;
  const requested = commanded.clone();

  let seeds = solveSeeds(spawn, baseDir, speed, spin, range, env);
  const maxReach = Math.max(seeds.low.peakRange || 0, seeds.high.peakRange || 0);

  if (!seeds.low.feasible && !seeds.high.feasible && maxReach > 0 && maxReach < range) {
    // Land just inside the reachable limit — at exactly peak range the only
    // solution is the max-range angle, where the aiming Jacobian is singular
    // and Newton cannot converge.
    const usable = maxReach * 0.94;
    const centerZ = (env.tableBox.min.z + env.tableBox.max.z) / 2;
    const pulled = new THREE.Vector3(
      spawn.x + baseDir.x * usable,
      env.tableSurfaceY,
      spawn.z + baseDir.z * usable,
    );
    // Only accept the pull-in if it still lands on the PLAYER's half; if the
    // speed cannot even clear the net the feed stays infeasible and the
    // caller skips it rather than dribbling a ball into the machine's court.
    if (pulled.z > centerZ + MIN_NET_INSET_M) {
      commanded.copy(pulled);
      reachClamped = true;
      range = horizontalDir(spawn, commanded, baseDir);
      seeds = solveSeeds(spawn, baseDir, speed, spin, range, env);
    }
  }
  // Azimuth is resolved AFTER any reach clamp, since pulling the target in
  // along the bearing can shift it.
  const baseAzimuth = Math.atan2(baseDir.x, baseDir.z);
  const { branch, anyCleared } = chooseBranch(spawn, baseAzimuth, speed, spin, config, env, seeds);

  const solved = newtonAim(
    spawn, commanded, speed, spin, baseAzimuth, seeds[branch].theta, env,
  );

  const result = solved.result;

  // Feasibility is judged on the FINAL trajectory, not the seed.
  //
  // chooseBranch tests viability using the seeded elevation along the direct
  // bearing, but Newton then moves both angles — so a branch that cleared the
  // net at seed time can end up clipping it once refined. Reporting the seed's
  // verdict produced feeds marked feasible with a measured clearance of
  // −0.004 m, i.e. a net ball the engine claimed was fine. The machine must
  // never report a shot as good when its own forward verification says it
  // hits the net or misses the table.
  const feasible = seeds[branch].feasible &&
    solved.converged &&
    anyCleared &&
    !!result && result.clearedNet && result.onTable;

  return {
    spawn,
    velocity: solved.velocity,
    spin,
    commandedLanding: commanded,
    verifiedLanding: result ? new THREE.Vector3(result.x, result.y, result.z) : null,
    netClearance: result ? result.netClearance : null,
    clearedNet: result ? result.clearedNet : false,
    onTable: result ? result.onTable : false,
    feasible,
    errorM: solved.errorM,
    // True when the commanded placement was out of reach at this speed and
    // the landing point was pulled in to keep the ball on the player's side.
    reachClamped,
    requestedLanding: requested,
    maxReachM: maxReach,
    config,
  };
}

// Solve the seed elevation for both trajectory branches along a bearing.
function solveSeeds(spawn, dir, speed, spin, range, env) {
  return {
    low: solveElevation(spawn, dir, speed, spin, range, env, 'low', DT_SEARCH),
    high: solveElevation(spawn, dir, speed, spin, range, env, 'high', DT_SEARCH),
  };
}

/**
 * Refine (elevation, azimuth) so the ball lands on the commanded point, by
 * 2-D Newton iteration with a numerical Jacobian.
 *
 * WHY NEWTON AND NOT "MOVE THE AIM POINT BY THE ERROR"
 *
 * The obvious correction — aim at the target, see where it lands, shift the
 * aim against the error, repeat — assumes the landing point responds to the
 * aim point one-for-one. Under heavy sidespin it does not: moving the aim
 * also changes how long Magnus acts along the new heading, so the response
 * gain is closer to 1.5. Correcting by the full error therefore OVERSHOOTS
 * and the iteration oscillates (measured: −1.16 m → −0.22 m → +0.56 m → …),
 * needing 8+ passes to reach centimetres.
 *
 * Newton measures that gain instead of assuming it. Two extra rollouts per
 * iteration buy the local Jacobian, and convergence goes from oscillatory to
 * quadratic — about 3 iterations for the worst sidespin case, and it costs
 * fewer rollouts overall than the naive loop did.
 */
function newtonAim(spawn, commanded, speed, spin, baseAzimuth, theta0, env) {
  const vel = new THREE.Vector3();
  const dir = new THREE.Vector3();

  let theta = theta0;
  let phi = 0;
  let result = null;
  let errorM = Infinity;
  let converged = false;

  // Landing error at (θ, φ), at the given fidelity. Returns null if the shot
  // never comes down inside the step ceiling.
  const evaluate = (t, p, dt) => {
    dirAt(baseAzimuth + p, dir);
    velocityAt(dir, speed, t, vel);
    return rolloutToSurfacePlane(spawn, vel, spin, env, { dt });
  };

  for (let iter = 0; iter < NEWTON_ITERS; iter++) {
    // Iterate at VERIFY fidelity, not the coarser search dt.
    //
    // Converging at one dt and reporting at another leaves an error floor:
    // the two integrations land ~1.2 cm apart on a typical feed, which is
    // most of M1's 2 cm budget spent on nothing but step size. Newton needs
    // only ~3 iterations × 3 rollouts, so the finer step is affordable here
    // in a way it was not for the 1-D bracketing search that seeds it.
    const dt = DT_PRESETS.VERIFY;
    const base = evaluate(theta, phi, dt);
    if (!base) break;

    const ex = base.x - commanded.x;
    const ez = base.z - commanded.z;
    errorM = Math.hypot(ex, ez);
    result = base;

    if (errorM < AIM_TOL_M) { converged = true; break; }

    // Numerical Jacobian: ∂(x,z)/∂(θ,φ).
    const dTheta = evaluate(theta + NEWTON_H, phi, dt);
    const dPhi = evaluate(theta, phi + NEWTON_H, dt);
    if (!dTheta || !dPhi) break;

    const j11 = (dTheta.x - base.x) / NEWTON_H;  // ∂x/∂θ
    const j21 = (dTheta.z - base.z) / NEWTON_H;  // ∂z/∂θ
    const j12 = (dPhi.x - base.x) / NEWTON_H;    // ∂x/∂φ
    const j22 = (dPhi.z - base.z) / NEWTON_H;    // ∂z/∂φ

    const det = j11 * j22 - j12 * j21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) break; // singular; keep best so far

    // Solve J · Δ = −error.
    let dt_ = (-ex * j22 + ez * j12) / det;
    let dp = (-ez * j11 + ex * j21) / det;

    // Cap the step. A near-singular Jacobian at the top of the arc can
    // otherwise fling the solution onto the other branch, which lands
    // somewhere valid but not where the arc setting asked for.
    const stepLen = Math.hypot(dt_, dp);
    if (stepLen > NEWTON_MAX_STEP) {
      const scale = NEWTON_MAX_STEP / stepLen;
      dt_ *= scale;
      dp *= scale;
    }

    theta = clamp(theta + dt_, THETA_MIN, THETA_MAX);
    phi += dp;
  }

  // Final confirmation at full fidelity.
  const finalResult = evaluate(theta, phi, DT_PRESETS.VERIFY);
  if (finalResult) {
    result = finalResult;
    errorM = Math.hypot(finalResult.x - commanded.x, finalResult.z - commanded.z);
  }

  dirAt(baseAzimuth + phi, dir);
  velocityAt(dir, speed, theta, vel);

  return { velocity: vel.clone(), result, errorM, converged: converged || errorM < 0.02 };
}

// Horizontal unit direction for an absolute azimuth (measured as atan2(x, z),
// so 0 points along +z toward the player).
function dirAt(azimuth, out) {
  return out.set(Math.sin(azimuth), 0, Math.cos(azimuth));
}

function horizontalDir(spawn, aim, out) {
  out.set(aim.x - spawn.x, 0, aim.z - spawn.z);
  const len = out.length();
  if (len < 1e-6) { out.set(0, 0, 1); return 0; }
  out.divideScalar(len);
  return len;
}

/**
 * Pick the trajectory branch whose net clearance sits closest to the arc's
 * target, using the seeded elevation solutions.
 *
 * Also reports whether ANY branch clears the net: when neither does, the
 * commanded shot is not makeable at this speed and the caller marks the feed
 * infeasible rather than launching a ball into the net and calling it a feed.
 */
function chooseBranch(spawn, baseAzimuth, speed, spin, config, env, seeds) {
  const wanted = ARC_NET_CLEARANCE[config.arc];
  const dir = dirAt(baseAzimuth, new THREE.Vector3());
  const vel = new THREE.Vector3();

  // Measure both branches' clearance, keeping only those that clear the net.
  const viable = [];
  let anyCleared = false;
  for (const branch of ['low', 'high']) {
    velocityAt(dir, speed, seeds[branch].theta, vel);
    const r = rolloutToSurfacePlane(spawn, vel, spin, env, { dt: DT_SEARCH });
    if (!r || r.netClearance === null || r.netClearance <= 0) continue;
    anyCleared = true;
    viable.push({ branch, clearance: r.netClearance });
  }
  if (viable.length === 0) return { branch: 'low', anyCleared: false };
  if (viable.length === 1) return { branch: viable[0].branch, anyCleared };

  // Arc expresses an ORDERING over the two achievable trajectories, not a
  // nearest-match to its nominal clearance.
  //
  // Nearest-match reads plausibly and is wrong: the lofted branch typically
  // clears by ~1.7 m against lob's nominal 0.5 m, while the flat branch
  // clears by ~0.16 m. |0.16 − 0.5| < |1.7 − 0.5|, so "closest" hands lob the
  // FLAT trajectory — making lob and flat produce byte-identical feeds. The
  // spec's 0.05/0.15/0.5 figures are targets to aim at, not distances to
  // minimise against a two-element set.
  //
  // So: flat takes the lower trajectory, lob the upper, and only medium —
  // which genuinely sits between them — picks by proximity.
  const low = viable.find((v) => v.branch === 'low');
  const high = viable.find((v) => v.branch === 'high');
  if (config.arc === 'flat') return { branch: low.branch, anyCleared };
  if (config.arc === 'lob') return { branch: high.branch, anyCleared };
  const pick = Math.abs(low.clearance - wanted) <= Math.abs(high.clearance - wanted) ? low : high;
  return { branch: pick.branch, anyCleared };
}

// --- Scheduling -------------------------------------------------------------

/**
 * Feed scheduler. Owns interval/burst timing and the pre-feed audio cue, and
 * emits solved feeds to listeners. Scene-free: it does not spawn the ball
 * itself, it hands the caller everything needed to.
 *
 * The caller drives it with update(dt) and receives feeds via onFeed().
 */
export class FeedEngine {
  /**
   * `animationLeadSec` is the delay between this engine emitting a feed and
   * the ball actually launching — the server figure's windup+swing prelude.
   * It is subtracted from the next interval so the PERCEIVED rhythm tracks
   * `config.interval` instead of running late by the length of the animation
   * on every ball. The legacy feeder did the same subtraction inline; making
   * it a constructor option keeps the user-facing interval meaning what it
   * says while letting a caller with no animation pass 0.
   */
  constructor(config, env, { rng = Math.random, seed = null, animationLeadSec = 0 } = {}) {
    this.env = env;
    this.setConfig(config);
    this.rng = rng;
    this.seed = seed;
    this.animationLeadSec = animationLeadSec;
    this.configProvider = null;

    this.timeUntilNext = Math.min(this.config.interval, 1.2);
    this.fedCount = 0;
    this.paused = false;
    this.finished = false;
    this.listeners = [];
    this.cueListeners = [];
    this._cueFired = false;
    this.lastFeed = null;
  }

  setConfig(config) {
    this.config = validateConfig(config);
    return this.config;
  }

  onFeed(fn) { this.listeners.push(fn); return () => pull(this.listeners, fn); }
  onCue(fn)  { this.cueListeners.push(fn); return () => pull(this.cueListeners, fn); }

  pause()  { this.paused = true; }
  resume() { this.paused = false; }

  get remaining() {
    return this.config.burstCount === INFINITE
      ? INFINITE
      : Math.max(0, this.config.burstCount - this.fedCount);
  }

  /**
   * Advance the schedule. `gate` is an optional predicate the caller uses to
   * hold the next feed until the previous ball has cleared — the old feeder
   * checked ballModel.visible inline, which is exactly the scene coupling
   * this split removes.
   */
  update(dt, gate = null) {
    if (this.paused || this.finished) return null;
    if (gate && !gate()) return null;

    this.timeUntilNext -= dt;

    // Pre-feed tick (M1's "audio cue — pre-feed tick (timing aid)"), fired one
    // cue-lead before contact so it functions as a timing aid rather than a
    // report of something that already happened.
    if (!this._cueFired && this.config.audioCue && this.timeUntilNext <= CUE_LEAD_SEC) {
      this._cueFired = true;
      for (const fn of this.cueListeners) fn();
    }

    if (this.timeUntilNext > 0) return null;
    return this.feedNow();
  }

  /**
   * Supply a per-feed config, overriding this.config for that ball only.
   *
   * This is what lets M2's patterns run on the same engine: a Falkenberg
   * sequence is not a different feeder, it is the same feeder handed a
   * different placement each ball. Without it a pattern would have to call
   * setConfig() between feeds and race the interval timer.
   */
  setConfigProvider(fn) { this.configProvider = fn; }

  /** Solve and emit one feed immediately, regardless of the interval timer. */
  feedNow() {
    const perFeed = this.configProvider
      ? validateConfig(this.configProvider(this.fedCount))
      : this.config;
    const feed = solveFeed(perFeed, this.env, { rng: this.rng });
    this.fedCount++;
    this.lastFeed = feed;
    feed.index = this.fedCount;

    // Pace comes from the config that was actually FED, so a pattern step
    // carrying its own interval (a slow push before a fast drive) is honoured
    // rather than being overridden by the base config's pace.
    this.timeUntilNext = Math.max(perFeed.interval - this.animationLeadSec, 0.1);
    this._cueFired = false;
    if (this.config.burstCount !== INFINITE && this.fedCount >= this.config.burstCount) {
      this.finished = true;
    }
    for (const fn of this.listeners) fn(feed);
    return feed;
  }

  reset() {
    this.fedCount = 0;
    this.finished = false;
    this.lastFeed = null;
    this._cueFired = false;
    this.timeUntilNext = Math.min(this.config.interval, 1.2);
  }

  dispose() {
    this.listeners.length = 0;
    this.cueListeners.length = 0;
  }
}

const CUE_LEAD_SEC = 0.35;

function pull(arr, fn) {
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
}

// Re-exported so callers that only need to confirm a solved feed lands in
// bounds don't reach past this module into physics/.
export { rolloutToFirstBounce };
