// AI serve sub-system — archetype-driven, human-like variety.
//
// A real table-tennis serve is a joint choice of (start position × swing
// type × spin category × length × placement). The AI now samples from a
// catalog of archetypes per difficulty rather than emitting a uniform
// random target. Consequences you can see:
//   - The AI stands at forehand corner / backhand corner / center between
//     serves instead of always centered.
//   - The paddle's cosmetic swing sweeps sideways for pendulum serves,
//     rises for tomahawks, and pushes straight for backhand/no-spin.
//   - Anti-repeat: the same archetype is never picked twice in a row.
//
// The first two apply to INTERMEDIATE and PRO only. All three archetypes with
// a non-zero beginner weight are `servePosX: 0.0` with a `straight` swing, so
// Beginner always stands dead centre and always plays the same motion — it
// varies only in spin and length, and alternates between two of its three
// archetypes. That is deliberate (a beginner has one serve), but this comment
// used to read as though stance and swing variety applied at every tier.
//
// FSM sub-states:
//   PRE_SERVE   — paddle moves to a serve-ready pose over 400ms (position
//                 varies by archetype).
//   TOSS        — the ball is spawned beside the paddle with a near-vertical
//                 velocity and flies FREELY under the live physics constants,
//                 so the player actually sees it rise. Meanwhile the paddle
//                 draws back and then accelerates into the predicted contact
//                 point. Ends when the ball descends through contact height.
//   SERVE_SWING — the strike already happened on the TOSS→SERVE_SWING edge;
//                 this is the follow-through, 150ms, target pose chosen from
//                 the archetype's swing kinematics.
//   POST_SERVE  — recovery back to ready pose over 300ms; hands off.
//
// Why the strike is SCRIPTED, not a real swept-disc collision:
//
// An earlier toss-then-hit design let the physics collision resolve the
// serve. Coordinating three independent timelines (ball, paddle, swept-disc
// contact) on a few-cm / few-ms budget routinely missed, and a missed serve
// contact is a dead rally. So the ball's flight during TOSS is real and
// visible, but at contact we do NOT rely on the impulse: the AI paddle is
// gated out of the collision set for the whole toss window
// (paddle.setCollisionEnabled(false)), and on the strike frame we solve from
// the ball's ACTUAL position/velocity and write the outgoing velocity+spin
// directly. That keeps every guarantee the old launch-then-swing path had
// (placement, spin, net clearance) while making the serve readable.
//
// The outgoing trajectory is a TWO-BOUNCE serve (ITTF): the ball must strike
// the AI's own half first, then clear the net and land at the archetype's
// target on the player's half. solveTwoBounceServe below finds that launch by
// searching leg-1 flight times over the closed-form serveBallistic solve and
// verifying each candidate through the shared physics integrator (drag,
// Magnus, real table-bounce response). The rally manager faults serves that
// skip the own-half bounce, so this is a rules requirement, not a garnish.
//
// The gate stays closed until the outgoing ball is clear of the hit radius,
// otherwise the follow-through would immediately re-hit its own serve.

import * as THREE from 'three';
import { spawnBallAt, ballVelocity } from '../../physics/ball.js';
import { ballRadius, tableBox, tableSurfaceY, netBox, ballModel } from '../../scene/models.js';
import { playPaddleHitSound } from '../../scene/audio.js';
import { maxPaddleSpeedForDifficulty } from '../../ai/paddleSolver.js';
import { integrateFlightStep, applyTableBounce } from '../../physics/rollout.js';
import { serveBallistic } from '../training/serveBallistics.js';

export const SERVE_STATES = Object.freeze({
  IDLE: 'SERVE_IDLE',
  PRE_SERVE: 'PRE_SERVE',
  TOSS: 'SERVE_TOSS',
  SERVE_SWING: 'SERVE_SWING',
  POST_SERVE: 'POST_SERVE',
});

const PRE_SERVE_DURATION_MS = 400;
const SERVE_SWING_DURATION_MS = 150;
const POST_SERVE_RECOVERY_MS = 300;

const SWING_FORWARD_TRAVEL_M = 0.20;

// --- Toss geometry ---------------------------------------------------------
//
// The free hand tosses from just above the table, beside the paddle, behind
// the AI's end line. The ball then rises most of a metre and is struck on the
// way back down at about net height — the whole arc is in view, which is the
// point: the player has to be able to read the toss to read the serve.
//
// Measured under the shipping physics (gravity -9.81, drag 0.13 — the
// 2026-09 physical value; at the old 0.17 the toss was ~3 cm lower and
// ~20 ms quicker):
//   normal toss: rise 0.91m (apex 1.01m over the table), struck 808ms after
//                release at 0.33m descending at 3.4 m/s
//   high toss:   rise 1.02m (apex 1.12m), struck 864ms after release at
//                0.32m descending at 3.7 m/s
// Serve takes ~1.2s from paddle-ready to contact where it used to take 0.4s
// with no visible ball at all.
//
// WHY THE TOSS IS CAPPED HERE and not made taller still: the strike writes
// the outgoing velocity directly, so the descent speed no longer constrains a
// placement solve — but a faster-falling ball is struck later and lower (see
// MAX_CONTACT_DESCENT_MPS below), and a taller toss buys visibility we
// already have at the cost of serve pacing. These velocities are the
// measured sweet spot; raise them only with the contact choreography.
const TOSS_ORIGIN_HEIGHT_M = 0.10;      // above table surface
const TOSS_LATERAL_OFFSET_M = 0.16;     // free hand sits beside the paddle
// Negative = further from the net than the serve-ready pose, which already
// sits 5cm behind the AI end line. Keeps the whole toss-and-strike behind
// the line (ITTF), and means a missed strike falls off the back of the
// table rather than bouncing on the AI's own half and conceding the point.
const TOSS_FORWARD_OFFSET_M = -0.02;
const TOSS_UP_VY_MPS = 4.5;
const HIGH_TOSS_UP_VY_MPS = 4.8;
const TOSS_DRIFT_MPS = 0.05;            // barely-there horizontal drift

// Contact is taken on the descent at whichever comes FIRST:
//   - the ball falling back to TOSS_CONTACT_HEIGHT_M above the table
//     (the normal case: a natural, above-net-height serve contact), or
//   - the descent speed reaching MAX_CONTACT_DESCENT_MPS.
// The second is a safety valve. It only bites if the toss ends up taller than
// intended — a gravity/drag change from the physics tuner, say — and it
// guarantees the solver never sees an incoming speed it can't place, at the
// cost of the AI striking the ball a bit higher than usual.
//
// WHY 0.35 AND NOT 0.25 (the original): contact height is what sets the
// two-bounce solver's reachable envelope, because the ball must come back
// down onto the server's own half before it crosses the net. At 0.25 m the
// entire mid-arc band (vy −1.2 … +0.3) had NO legal solution at all, and the
// upward arcs that did solve topped out at a 0.5–0.72 m landing — so every
// deep-target archetype was served short, arriving at the receiver's end line
// after 1.3 s at under 2 m/s. Measured at 0.35 m, arcs from −2.2 to −0.7 land
// 0.85–1.37 deep (see the arc/depth table below) and arrive in 0.5–0.8 s at
// 2.7–4.5 m/s. Ten centimetres of
// contact height is the difference between a serve that reaches the player
// and one that dribbles over the line.
const TOSS_CONTACT_HEIGHT_M = 0.35;     // above table surface
const MAX_CONTACT_DESCENT_MPS = 4.0;

const TOSS_MAX_DURATION_MS = 1800;      // safety net if the ball never arrives
const TOSS_SIM_MAX_STEPS = 500;

// Paddle choreography during the toss: draw back for the first stretch, then
// accelerate into the contact point, arriving on the strike frame.
const BACKSWING_FRACTION = 0.55;
const BACKSWING_BACK_M = 0.16;
const BACKSWING_APPROACH_MIN_SPEED_MPS = 1.0;
const ARRIVE_EARLY_FRACTION = 0.92;   // paddle reaches contact just before it
const STRIKE_GRACE_MS = 60;           // wait this long for a lagging ball

// Distance from the paddle face at which the outgoing serve is far enough
// away to safely re-arm the AI paddle's collider.
const COLLISION_REARM_DISTANCE_M = 0.35;

// --- Net-clearance guard (direct flights) ----------------------------------
//
// Rolls a DIRECT (no own-side bounce) launch forward with the ACTIVE physics
// constants and boosts its vertical component until the trajectory clears the
// net top by a margin. The live serve no longer uses this — the strike is a
// two-bounce solve (see solveTwoBounceServe below), whose own verification
// accounts for the table bounce that this simulator deliberately doesn't
// model. Kept as a public helper for direct-flight launches and their tests.

const NET_CLEARANCE_MARGIN_M = 0.04;    // ball CENTER must be this far above net top
const CLEAR_BOOST_STEP_MPS = 0.6;       // vy bump per iteration
const CLEAR_MAX_ITERATIONS = 24;        // caps total added vy at ~14 m/s
const CLEAR_SIM_DT = 0.008;             // integration step (matches shotAdapter timing)
const CLEAR_SIM_MAX_STEPS = 400;        // 3.2s of simulated flight

// Roll a virtual ball forward from launchPos with the ACTIVE physics
// (gravity + drag + Magnus). Returns the Y at which the trajectory crosses
// the net's Z plane, or null if it never crosses within the simulation
// window (ball fell off / stayed on AI side).
function simulateNetCrossingY(launchPos, launchVel, launchSpin, netZ) {
  const pos = launchPos.clone();
  const vel = launchVel.clone();
  const spin = launchSpin.clone();
  const dt = CLEAR_SIM_DT;
  for (let i = 0; i < CLEAR_SIM_MAX_STEPS; i++) {
    const prevY = pos.y;
    const prevZ = pos.z;
    integrateFlightStep(pos, vel, spin, dt);
    // Detect Z-crossing (sign-agnostic — the AI can be on either side).
    if ((prevZ < netZ && pos.z >= netZ) || (prevZ > netZ && pos.z <= netZ)) {
      const denom = pos.z - prevZ;
      if (Math.abs(denom) < 1e-9) return pos.y;
      const t = (netZ - prevZ) / denom;
      return prevY + (pos.y - prevY) * t;
    }
    // Ball fell below table surface without crossing — abandoned trajectory.
    if (pos.y < tableSurfaceY - 0.5) return null;
  }
  return null;
}

// Public helper: given a candidate launch, iteratively boost the vertical
// component of launchVel until the trajectory clears the net at the desired
// margin. Returns the possibly-mutated velocity/spin plus diagnostics.
// Safe to call when netBox is not yet populated (returns input unchanged).
export function ensureNetClearance(launchPos, launchVel, launchSpin) {
  if (!netBox) {
    return { launchVel, launchSpin, clears: true, iterations: 0 };
  }
  const netTopY = netBox.max.y;
  const netZ = (netBox.min.z + netBox.max.z) / 2;
  const requiredY = netTopY + ballRadius + NET_CLEARANCE_MARGIN_M;

  const vel = launchVel.clone();
  const spin = launchSpin.clone();

  for (let iter = 0; iter <= CLEAR_MAX_ITERATIONS; iter++) {
    const yAtNet = simulateNetCrossingY(launchPos, vel, spin, netZ);
    if (yAtNet !== null && yAtNet >= requiredY) {
      return { launchVel: vel, launchSpin: spin, clears: true, iterations: iter };
    }
    // Either doesn't clear (yAtNet < requiredY) or doesn't reach the net
    // (yAtNet === null). Both are fixed by more upward velocity.
    vel.y += CLEAR_BOOST_STEP_MPS;
  }
  // Exhausted — return best effort. Physics is probably over-tuned.
  return { launchVel: vel, launchSpin: spin, clears: false, iterations: CLEAR_MAX_ITERATIONS };
}

// --- Two-bounce serve solver ------------------------------------------------
//
// An ITTF serve strikes the server's own half first, then crosses the net and
// lands in the receiver's court. There is no usable closed form once drag,
// Magnus and the speed-dependent friction-coupled bounce are in play, so this
// is a direct search over the launch itself: aim horizontally at the target,
// and for each of several arc heights (vertical launch speeds, ordered by the
// archetype's speed intent — fast serves try flat arcs first, soft serves
// arced ones) binary-search the horizontal speed until the SECOND bounce
// lands at the target depth. Every trial is rolled through the same
// integrator the live ball uses (integrateFlightStep + applyTableBounce), so
// what the solver accepts is what the table will show.
//
// The arc height is the familiar human trade: a flat fast serve bounces deep
// on the server's own half and skims the net; when it can't both reach depth
// and clear the cord, the next-more-arced candidate gets its chance.

const SERVE_SIM_DT = 0.004;
const SERVE_SIM_MAX_STEPS = 700;          // 2.8 s of simulated flight
// Required clearance above (net top + ball radius) for the ball CENTER. The
// live ball integrates at frame dt (~11 ms at 90 Hz) while this solver
// verifies at 4 ms, so a solver-approved skim can drift a couple of cm by
// the net crossing — the margin must absorb that or "verified" serves clip
// the cord in-headset.
const SERVE_NET_MARGIN_M = 0.035;
// Negative arcs are real serves too: a fast deep serve is struck slightly
// DOWNWARD from just above the table, bouncing early on the server's own
// half and skimming the net on a long flat second leg — that shape is
// unreachable with an upward launch (the own-half bounce constraint caps its
// horizontal speed). Capped at 2.6 up: taller arcs turn into floaty moon
// serves that read as a glitch, not a soft serve.
const SERVE_VY_CANDIDATES_MPS = [-2.2, -1.7, -1.2, -0.7, -0.2, 0.3, 0.8, 1.4, 2.0, 2.6];
const SERVE_VH_MIN_MPS = 1.0;
const SERVE_VH_MAX_MPS = 9.5;
const SERVE_VH_BINARY_STEPS = 9;
const SERVE_LANDING_TOLERANCE_M = 0.30;   // stop trying other arcs below this
// Tighter stop for the sidespin aim-shift loop around the arc solver. The
// arc loop's 0.30 is a "good enough arc, stop burning candidates" tolerance;
// the aim shift exists to remove the lateral curl miss on top of that arc,
// and it used to share the 0.30 — so a heavy pendulum that curled 27 cm
// wide was declared solved and never corrected. That was masked while the
// linear Magnus model over-curled sidespin (misses sat past 0.30 and the
// shift ran); at the physical lift the miss lands just inside it. Each
// shift iteration is one more arc solve, amortized across the toss frames
// like the first, and the loop still stops as soon as the ball is on target.
const SERVE_AIM_SHIFT_TOLERANCE_M = 0.12;
// Meters of landing error a candidate may buy per m/s of arc mismatch.
// Without this a soft touch serve loses to a laser-flat one that happens to
// land 10cm closer — accuracy would erase the archetype's character.
const SERVE_ARC_MISMATCH_WEIGHT = 0.12;
// ...but the allowance is CAPPED. Uncapped, the arc span (−2.2 … +2.6) buys
// up to 0.58 m of forgiveness — twice SERVE_LANDING_TOLERANCE_M — and the
// preference stops being a tiebreak and starts overruling placement outright:
// a soft-serve arc landing 33 cm short scored 0.35 while the accurate flat
// candidate 5 cm from the target scored 0.50 and lost. 0.08 m keeps character
// deciding ties between comparable candidates and nothing more.
const SERVE_ARC_MISMATCH_MAX_M = 0.08;

// --- Arc preference vs. reachable depth -------------------------------------
//
// Deepest legal landing each arc can reach, measured at the production
// contact height (0.35 m, z −1.44) with the shipping physics — drag 0.13,
// gravity −9.81, the 2026-09 table COR curve (e(2.4) 0.88, e(5) 0.85; the
// old ±0.13 curve clamped at COR_MAX for soft own-half bounces, this one
// does not) — no spin, SERVE_NET_MARGIN_M clearance, sweeping vh in 5 cm/s
// steps (re-measure with the same sweep when the physics moves again):
//
//     vy    −2.2   −1.7   −1.2   −0.7   −0.2    +0.3 and above
//     z      1.37   1.35   1.10   0.85   0.73    ~0.69-0.75 (flat ceiling)
//
// (At drag 0.17 with the old curve these were 1.28 / 1.08 / 0.92 / 0.77 /
// 0.71 — the physical ball carries every arc 5-25 cm deeper.)
//
// The own-half bounce is what caps it: an UPWARD launch has only ~0.5 s of
// air before it must land on the server's half, which caps its horizontal
// speed near 3.5 m/s and leaves the post-bounce leg with nothing. Only a
// downward strike carries deep — which is exactly what a real server does.
//
// A target deeper than the preferred arc can reach does NOT fail; it solves
// short and slow, which is how a speed-only preference (prefVy from
// targetSpeed alone) sent every soft archetype — all of which ask for
// 0.85–1.10 depth — onto a +1.4 arc that tops out at 0.78. So the speed
// preference is ceilinged by the depth the target actually demands.
const SERVE_ARC_DEPTH_REF_Z  = [0.73, 1.37];
const SERVE_ARC_DEPTH_REF_VY = [-0.2, -2.2];
// Aim the preference one notch flatter than the bare minimum, so the chosen
// arc isn't sitting exactly on its own reachability limit.
const SERVE_ARC_DEPTH_MARGIN_M = 0.10;

// Max distance (m) the live ball may drift from the predicted toss contact
// before the pre-solved serve launch is discarded and re-solved from the
// real position. Within this radius the aim-shift tolerance (0.30 m) dwarfs
// the landing shift a few cm of launch offset produces.
const PRESOLVE_MAX_DRIFT_M = 0.05;

// Flattest (most negative) arc the preference may sit at, given how deep the
// serve needs to land. Infinity = every arc reaches this depth, so the speed
// intent is free to choose.
function arcCeilingForDepth(depth) {
  const d = depth + SERVE_ARC_DEPTH_MARGIN_M;
  const [z0, z1] = SERVE_ARC_DEPTH_REF_Z;
  if (d <= z0) return Infinity;
  const [vy0, vy1] = SERVE_ARC_DEPTH_REF_VY;
  return vy0 + ((d - z0) / (z1 - z0)) * (vy1 - vy0);
}

// Roll a serve launch through the live physics, across its first table bounce,
// to its second surface contact. Reports everything the legality judgement
// needs: where the first bounce landed, whether the trajectory crossed the
// net plane BEFORE bouncing (an illegal direct serve), the clearance over the
// net top on the post-bounce leg, and the final landing point.
export function simulateTwoBounceServe(launchPos, launchVel, launchSpin, env) {
  const fail = { firstBounce: null, crossedNetBeforeBounce: false, netClearance: null, landing: null };
  if (!env || !env.tableBox) return fail;
  const netZ = env.netBox
    ? (env.netBox.min.z + env.netBox.max.z) / 2
    : (env.tableBox.min.z + env.tableBox.max.z) / 2;
  const netTopY = env.netBox ? env.netBox.max.y : env.tableSurfaceY + 0.1525;

  const pos = launchPos.clone();
  const vel = launchVel.clone();
  const spin = launchSpin.clone();
  let firstBounce = null;
  let crossedNetBeforeBounce = false;
  let netClearance = null;

  for (let i = 0; i < SERVE_SIM_MAX_STEPS; i++) {
    const prevY = pos.y;
    const prevZ = pos.z;
    integrateFlightStep(pos, vel, spin, SERVE_SIM_DT);

    if ((prevZ < netZ && pos.z >= netZ) || (prevZ > netZ && pos.z <= netZ)) {
      const span = pos.z - prevZ;
      const frac = Math.abs(span) > 1e-9 ? (netZ - prevZ) / span : 0;
      const yAtNet = prevY + (pos.y - prevY) * frac;
      if (!firstBounce) crossedNetBeforeBounce = true;
      else if (netClearance === null) netClearance = yAtNet - netTopY;
    }

    if ((pos.y - env.ballRadius) <= env.tableSurfaceY && vel.y < 0) {
      const onTable =
        pos.x >= env.tableBox.min.x && pos.x <= env.tableBox.max.x &&
        pos.z >= env.tableBox.min.z && pos.z <= env.tableBox.max.z;
      if (!firstBounce) {
        // Dropped below the surface plane off-table before any bounce — the
        // launch never reached the table. Unusable candidate.
        if (!onTable) return { firstBounce: null, crossedNetBeforeBounce, netClearance, landing: null };
        firstBounce = { x: pos.x, z: pos.z };
        pos.y = env.tableSurfaceY + env.ballRadius;
        applyTableBounce(vel, spin, env.ballRadius);
      } else {
        return {
          firstBounce, crossedNetBeforeBounce, netClearance,
          landing: { x: pos.x, z: pos.z, onTable },
        };
      }
    }
    if (pos.y < env.tableSurfaceY - 1.0) break;
  }
  return { firstBounce, crossedNetBeforeBounce, netClearance, landing: null };
}

// Find a legal two-bounce launch from launchPos to targetWorld. Returns
// { velocity, legal, landingError, sim } — `legal` false means every
// candidate failed some requirement and `velocity` is the least-bad one
// (physics probably over-tuned). Returns null only on degenerate geometry.
//
// Generator core: yields once after each arc candidate's binary search, so
// the serve FSM can amortize the search across toss frames (one arc ≈ up to
// 9 two-bounce sims ≈ a fraction of a ms) instead of paying the whole search
// in the strike frame. The exported solveTwoBounceServe below drains it
// synchronously — identical computation, identical results.
function* solveTwoBounceServeSteps(launchPos, targetWorld, targetSpeed, launchSpin, env) {
  if (!env || !env.tableBox) return null;
  const netZ = env.netBox
    ? (env.netBox.min.z + env.netBox.max.z) / 2
    : (env.tableBox.min.z + env.tableBox.max.z) / 2;
  // Which side of the net the server occupies (AI is -z in practice, but the
  // solve is side-agnostic).
  const serverSign = Math.sign(launchPos.z - netZ) || -1;
  const recvSign = -serverSign;

  // Horizontal aim straight at the target. Top/back spin (axis perpendicular
  // to this line) drifts laterally only second-order and is folded into
  // landingError; SIDESPIN curls first-order and is corrected by
  // solveServeWithAimShift around this solver, not in here.
  const dir = new THREE.Vector3(
    targetWorld.x - launchPos.x, 0, targetWorld.z - launchPos.z);
  if (dir.lengthSq() < 1e-9) dir.set(0, 0, recvSign);
  dir.normalize();

  // Arc preference from the archetype's speed intent: a 9 m/s serve wants a
  // downward strike and a flat skim, a 3 m/s touch serve a gently arced one.
  // Candidates are tried nearest-preference first, so ties in landing error
  // resolve to the arc that matches the serve's character.
  //
  // Then ceilinged by reachable depth (see arcCeilingForDepth): a soft serve
  // aimed at the back of the service box cannot be played on a soft arc, no
  // matter what its speed intent says, because the own-half bounce won't let
  // that arc carry. Ordering matters as much as scoring here — the arc loop
  // breaks early on the first candidate inside SERVE_LANDING_TOLERANCE_M, so
  // a preference pointing at a short-landing arc is never even compared
  // against the arcs that reach.
  // Depth for arc selection, corrected for diagonal travel: the reachability
  // table above was measured on straight serves, and a crossline serve covers
  // a longer horizontal path for the same z-depth — so it needs the arc that
  // carries the full path length, not just the z component.
  const dxTotal = targetWorld.x - launchPos.x;
  const dzTotal = targetWorld.z - launchPos.z;
  const diagRatio = Math.abs(dzTotal) > 1e-6
    ? Math.hypot(dxTotal, dzTotal) / Math.abs(dzTotal)
    : 1;
  const targetDepth = Math.abs(targetWorld.z - netZ) * diagRatio;
  const prefVy = Math.min(2.6, Math.max(-2.2, Math.min(
    3.4 - 0.55 * targetSpeed,
    arcCeilingForDepth(targetDepth),
  )));
  const vyCandidates = [...SERVE_VY_CANDIDATES_MPS]
    .sort((a, b) => Math.abs(a - prefVy) - Math.abs(b - prefVy));

  const vel = new THREE.Vector3();
  let best = null;

  const evaluate = (vh, vy) => {
    vel.set(dir.x * vh, vy, dir.z * vh);
    const sim = simulateTwoBounceServe(launchPos, vel, launchSpin, env);
    const bounceOnOwnHalf = !!sim.firstBounce &&
      Math.sign(sim.firstBounce.z - netZ) === serverSign &&
      !sim.crossedNetBeforeBounce;
    const clearsNet = sim.netClearance !== null &&
      sim.netClearance >= env.ballRadius + SERVE_NET_MARGIN_M;
    const landsInCourt = !!sim.landing && sim.landing.onTable &&
      Math.sign(sim.landing.z - netZ) === recvSign;
    const landingError = sim.landing
      ? Math.hypot(sim.landing.x - targetWorld.x, sim.landing.z - targetWorld.z)
      : Infinity;
    const legal = bounceOnOwnHalf && clearsNet && landsInCourt;
    // Illegal candidates rank strictly below every legal one, ordered by how
    // much of the legality checklist they fail.
    const score = legal
      ? landingError
      : 1e3 + (bounceOnOwnHalf ? 0 : 400) + (clearsNet ? 0 : 200) +
        (landsInCourt ? 0 : 100) + Math.min(landingError, 99);
    return { velocity: vel.clone(), sim, legal, score, landingError };
  };

  for (const vy of vyCandidates) {
    // Landing depth grows with horizontal speed (at fixed arc), so a binary
    // search homes in on the target depth; legality is judged on every trial
    // and the best-scoring one kept.
    let lo = SERVE_VH_MIN_MPS;
    let hi = SERVE_VH_MAX_MPS;
    const arcPenalty = Math.min(
      SERVE_ARC_MISMATCH_WEIGHT * Math.abs(vy - prefVy),
      SERVE_ARC_MISMATCH_MAX_M,
    );
    for (let i = 0; i < SERVE_VH_BINARY_STEPS; i++) {
      const vh = (lo + hi) / 2;
      const r = evaluate(vh, vy);
      r.score += arcPenalty;
      if (!best || r.score < best.score) best = r;
      const landZ = r.sim.landing ? r.sim.landing.z : null;
      if (landZ === null) {
        // No second surface contact in the window. Crossing the net plane
        // before bouncing means too fast; anything else (died before the
        // table, or settled without a countable landing) reads as too slow.
        if (r.sim.crossedNetBeforeBounce) hi = vh;
        else lo = vh;
      } else if ((targetWorld.z - landZ) * recvSign > 0) {
        lo = vh;                              // landed short — more speed
      } else {
        hi = vh;                              // landed long — less speed
      }
    }
    if (best && best.legal && best.landingError <= SERVE_LANDING_TOLERANCE_M) break;
    yield;
  }
  return best;
}

// Drain a solver generator to completion synchronously.
function drainGenerator(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

export function solveTwoBounceServe(launchPos, targetWorld, targetSpeed, launchSpin, env) {
  return drainGenerator(
    solveTwoBounceServeSteps(launchPos, targetWorld, targetSpeed, launchSpin, env),
  );
}

// Sidespin wrapper around solveTwoBounceServe. The two-bounce solver aims its
// horizontal line straight at the target and can only trade speed for depth,
// so the lateral Magnus curl of a real sidespin serve lands the ball off to
// the side — enough on a heavy pendulum (10-18 rps) to fail legality at the
// sideline. Fix is the same as paddleSolver's aim-shift: re-solve at a
// virtual target displaced opposite the observed miss and let the curl bring
// the ball back. Candidates are always scored against the REAL target, and
// legality (own-half bounce, net clearance, receiver court) is geometric, so
// the shift cannot trade a legal serve for an illegal one unnoticed.
// Generator core — same amortization contract as solveTwoBounceServeSteps:
// yields between arc candidates (via yield*), so a full aim-shift solve can
// be spread across toss frames by the serve FSM.
function* serveSolveSteps(launchPos, targetWorld, targetSpeed, launchSpin, env, maxIters = 3) {
  let best = yield* solveTwoBounceServeSteps(launchPos, targetWorld, targetSpeed, launchSpin, env);
  if (!best) return null;
  const virtual = targetWorld.clone();
  for (let i = 0; i < maxIters; i++) {
    if (!best.sim || !best.sim.landing) break;
    if (best.legal && best.landingError <= SERVE_AIM_SHIFT_TOLERANCE_M) break;
    virtual.x += targetWorld.x - best.sim.landing.x;
    virtual.z += targetWorld.z - best.sim.landing.z;
    const next = yield* solveTwoBounceServeSteps(launchPos, virtual, targetSpeed, launchSpin, env);
    if (!next) break;
    next.landingError = next.sim && next.sim.landing
      ? Math.hypot(next.sim.landing.x - targetWorld.x, next.sim.landing.z - targetWorld.z)
      : Infinity;
    const better = (next.legal && !best.legal)
      || (next.legal === best.legal && next.landingError < best.landingError);
    if (better) best = next;
  }
  return best;
}

export function solveServeWithAimShift(launchPos, targetWorld, targetSpeed, launchSpin, env, maxIters = 3) {
  return drainGenerator(
    serveSolveSteps(launchPos, targetWorld, targetSpeed, launchSpin, env, maxIters),
  );
}

// --- Toss prediction -------------------------------------------------------
//
// Roll the tossed ball forward with the ACTIVE physics constants to find
// where and when it will be struck: on the descent, at the first frame where
// it has either fallen back to contactFloorY or reached the descent-speed
// cap. Doing it by simulation rather than closed form means the choreography
// stays correct when the physics tuner changes gravity or drag.
//
// Returns { timeMs, position, velocity, contactY, apexY }. Never null — a
// degenerate toss that never reaches either condition falls back to the apex
// state, which is always reached.
const _tossSpin = new THREE.Vector3();
export function predictTossContact(tossPos, tossVel, contactFloorY) {
  const dt = CLEAR_SIM_DT;
  const floorY = contactFloorY != null ? contactFloorY : tossPos.y;

  const pos = tossPos.clone();
  const vel = tossVel.clone();
  let apexY = pos.y;
  let apexStep = 0;
  const apexPos = pos.clone();
  const apexVel = vel.clone();

  for (let i = 0; i < TOSS_SIM_MAX_STEPS; i++) {
    _tossSpin.set(0, 0, 0);
    integrateFlightStep(pos, vel, _tossSpin, dt);
    if (pos.y > apexY) {
      apexY = pos.y;
      apexStep = i + 1;
      apexPos.copy(pos);
      apexVel.copy(vel);
    }
    if (vel.y < 0 && (pos.y <= floorY || vel.y <= -MAX_CONTACT_DESCENT_MPS)) {
      return {
        timeMs: (i + 1) * dt * 1000,
        position: pos.clone(),
        velocity: vel.clone(),
        contactY: pos.y,
        apexY,
      };
    }
  }

  // Degenerate toss — strike at the apex instead.
  return {
    timeMs: Math.max(apexStep, 1) * dt * 1000,
    position: apexPos,
    velocity: apexVel,
    contactY: apexY,
    apexY,
  };
}

// --- Archetype catalog -----------------------------------------------------
//
// Each archetype is a bundle of intent. servePos.x is measured as a fraction
// of the AI baseline half-width (−1 = left corner, +1 = right corner, 0 =
// center) and placement.x is the same convention on the player's side. This
// lets us describe crossline / down-the-line without hard-coding handedness.
//
// swing:
//   type            — cosmetic paddle motion during SERVE_SWING
//   lateral         — sideways offset (m) applied to swing target, signed
//                     opposite of servePos.x so pendulums sweep across
//                     the body
//   vertical        — vertical offset (m) applied to swing target
// spin (rps, signed, PHYSICAL scale — see the spin-economy note on
//   MAGNUS_COEFFICIENT in physics/constants.js): negative = backspin
//   (retards forward motion), positive = topspin. Magnitudes are clamped to
//   ~55 rps, the real elite serve ceiling (~3300 rpm).
// sideSpin (rps, signed, optional): spin about the vertical axis — the
//   defining weapon of the international serve game. ω_y > 0 curls the
//   flight toward +x (Magnus, a = M·(ω × v) with v toward the player) and
//   kicks off the bounce; ω_y < 0 mirrors. Signs follow the swing sweep the
//   archetype choreographs: a pendulum from the AI's right sweeps toward −x,
//   and brush slip (−x) × faceNormal (+z) = +ω_y, so pendulums from the
//   right carry positive sidespin, tomahawk/reverse-pendulum from the left
//   carry negative. Omitted = [0, 0] (pure top/back serve).
// length (target_z, m from net into player side): short 0.15–0.40,
//   half 0.55–0.85, long 1.00–1.30. ITTF legal service box ends at 1.37.
// speedRange (m/s at ball landing, feeds solver targetSpeed).
//
// difficultyWeights: relative sampling weight per difficulty. 0 = never.

const ARCHETYPES = Object.freeze([
  {
    id: 'soft_straight_middle',
    swing: { type: 'straight', lateral: 0.00, vertical: 0.00 },
    spinRange: [0, 0],
    lengthRange: [0.90, 1.10],
    placementXRange: [-0.10, 0.10],
    servePosX: 0.0,
    speedRange: [3.2, 3.8],
    // Weight 1 at international: a dead no-spin middle ball is a genuine
    // change-up used to bait an attack, but it is a rare one — this must not
    // become a staple or the tier serves like a beginner.
    difficultyWeights: { beginner: 3, intermediate: 1, pro: 0 },
    risk: 'safe',
  },
  {
    id: 'soft_topspin_middle',
    swing: { type: 'straight', lateral: 0.00, vertical: 0.05 },
    spinRange: [8, 15],
    lengthRange: [0.85, 1.10],
    placementXRange: [-0.15, 0.15],
    servePosX: 0.0,
    speedRange: [3.4, 4.0],
    difficultyWeights: { beginner: 2, intermediate: 1, pro: 0 },
    risk: 'safe',
  },
  {
    id: 'soft_backspin_short',
    swing: { type: 'straight', lateral: 0.00, vertical: -0.05 },
    spinRange: [-20, -10],
    lengthRange: [0.35, 0.55],
    placementXRange: [-0.15, 0.15],
    servePosX: 0.0,
    speedRange: [3.0, 3.6],
    difficultyWeights: { beginner: 2, intermediate: 1, pro: 0 },
    risk: 'safe',
  },
  // DISGUISE: the two right-side pendulum archetypes (this and
  // pendulum_sidespin_deep_crossline) share IDENTICAL swing kinematics on
  // purpose — same stance, same sweep, same vertical. What differs is only
  // the wrist at contact (heavy backspin short vs heavy sidespin deep),
  // which the scripted strike doesn't render. That is the pendulum serve's
  // whole menace at international level: one motion, two very different
  // balls, and the receiver must read flight and bounce, not choreography.
  {
    id: 'pendulum_backspin_short_crossline',
    swing: { type: 'pendulum', lateral: 0.19, vertical: -0.02 },
    spinRange: [-55, -35],
    sideSpinRange: [12, 25],
    lengthRange: [0.20, 0.38],
    placementXRange: [-0.55, -0.30],
    servePosX: +0.55,
    speedRange: [3.5, 4.5],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 3 },
    risk: 'safe',
  },
  {
    id: 'pendulum_sidespin_deep_crossline',
    swing: { type: 'pendulum', lateral: 0.19, vertical: -0.02 },
    spinRange: [-15, 15],
    sideSpinRange: [25, 45],
    lengthRange: [1.00, 1.25],
    placementXRange: [-0.60, -0.35],
    servePosX: +0.55,
    speedRange: [5.5, 7.0],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'medium',
  },
  {
    id: 'backhand_flat_middle',
    swing: { type: 'backhand', lateral: -0.08, vertical: 0.00 },
    spinRange: [-10, 10],
    sideSpinRange: [-20, -8],
    // Half-long by intent (was 0.60-0.90): the flat backhand middle serve is
    // played to die around the receiver's end line, not to arrive with rally
    // pace — its 0.80-0.90 tail sat right on the deep-serve arrival test's
    // boundary and arrived at ~2.48 m/s, under the 2.5 m/s floor that test
    // demands of serves CLAIMING to be deep. 0.55-0.78 keeps it what it is:
    // a half-long change-up (the deep flat role belongs to
    // fast_deep_no_spin_downline).
    lengthRange: [0.55, 0.78],
    placementXRange: [-0.15, 0.15],
    servePosX: -0.25,
    speedRange: [5.0, 6.0],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 1 },
    risk: 'medium',
  },
  {
    id: 'tomahawk_sidespin_wide',
    swing: { type: 'tomahawk', lateral: -0.15, vertical: 0.18 },
    spinRange: [20, 45],
    sideSpinRange: [-45, -25],
    lengthRange: [0.70, 1.10],
    placementXRange: [+0.40, +0.60],
    servePosX: -0.45,
    speedRange: [5.0, 6.5],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'medium',
  },
  {
    id: 'reverse_pendulum_topspin_deep',
    swing: { type: 'pendulum', lateral: -0.18, vertical: 0.05 },
    spinRange: [25, 55],
    sideSpinRange: [-35, -18],
    lengthRange: [1.05, 1.30],
    placementXRange: [+0.30, +0.55],
    servePosX: -0.40,
    speedRange: [6.5, 8.0],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'aggressive',
  },
  {
    id: 'high_toss_heavy_backspin',
    swing: { type: 'high_toss', lateral: 0.08, vertical: 0.25 },
    spinRange: [-55, -45],
    sideSpinRange: [10, 22],
    lengthRange: [0.30, 0.55],
    placementXRange: [-0.20, 0.20],
    servePosX: +0.30,
    speedRange: [3.8, 4.8],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'medium',
  },
  {
    id: 'fast_deep_no_spin_downline',
    swing: { type: 'straight', lateral: 0.00, vertical: 0.02 },
    spinRange: [-5, 5],
    lengthRange: [1.10, 1.30],
    placementXRange: [+0.45, +0.65],
    servePosX: +0.45,
    speedRange: [7.5, 9.0],
    difficultyWeights: { beginner: 0, intermediate: 2, pro: 2 },
    risk: 'aggressive',
  },
]);

export const SERVE_ARCHETYPE_IDS = Object.freeze(ARCHETYPES.map(a => a.id));

// Third-ball attack plans by archetype. Real Pros don't serve randomly —
// they serve TO SET UP their next attack. Each entry names the archetype's
// planned reply pattern:
//
//   expectedReturnZone — where on the AI's side the player's return most
//     likely lands (spec coords: x signed lateral, z from-net distance).
//     If the actual return lands INSIDE (± tolerance) this zone, the
//     third-ball plan fires.
//   attackShotType — the shot the AI plans to hit as the third ball.
//   attackTargetX / attackTargetZ — where the AI plans to place that
//     attack on the PLAYER'S side (spec coords).
//   tolerance — max distance (m) from expectedReturnZone center that
//     still counts as "return landed as expected."
//
// Only aggressive/spinny archetypes get plans. Simple straight serves
// don't SET UP a specific reply; they're just neutral rally openings.
const THIRD_BALL_PLANS = Object.freeze({
  // Short heavy-backspin serve to backhand → expect a push return down
  // the line (deep, backhand side of AI). Plan: loop-kill to the wide
  // forehand corner (crosscourt open winner).
  pendulum_backspin_short_crossline: {
    expectedReturnZone: { x: -0.4, z: 1.0, tolerance: 0.4 },
    attackShotType: 'loop',
    attackTargetX: 0.55,
    attackTargetZ: 1.15,
  },
  // Deep sidespin crossline → expect a block return crosscourt (mid-depth,
  // AI backhand). Plan: heavy topspin drive to the wide forehand.
  pendulum_sidespin_deep_crossline: {
    expectedReturnZone: { x: -0.3, z: 0.7, tolerance: 0.4 },
    attackShotType: 'topspin_drive',
    attackTargetX: 0.60,
    attackTargetZ: 1.05,
  },
  // Wide tomahawk sidespin → expect a stretched return short and to the
  // middle. Plan: FLIP attack over the net down the line.
  tomahawk_sidespin_wide: {
    expectedReturnZone: { x: 0.1, z: 0.5, tolerance: 0.4 },
    attackShotType: 'flip',
    attackTargetX: -0.55,
    attackTargetZ: 1.10,
  },
  // Reverse pendulum topspin deep → expect a hurried block/push somewhere
  // mid-depth. Plan: smash the fast return down the line.
  reverse_pendulum_topspin_deep: {
    expectedReturnZone: { x: 0.2, z: 0.7, tolerance: 0.45 },
    attackShotType: 'smash',
    attackTargetX: -0.55,
    attackTargetZ: 1.10,
  },
  // Heavy backspin high toss → the classic "trap" serve. Backspin is so
  // heavy that most returns pop up. Plan: loop kill to the middle-wide.
  high_toss_heavy_backspin: {
    expectedReturnZone: { x: 0.0, z: 0.6, tolerance: 0.5 },
    attackShotType: 'loop',
    attackTargetX: 0.50,
    attackTargetZ: 1.10,
  },
  // Fast deep no-spin down the line → expect a rushed block back down
  // the line. Plan: smash crosscourt.
  fast_deep_no_spin_downline: {
    expectedReturnZone: { x: 0.4, z: 0.8, tolerance: 0.4 },
    attackShotType: 'smash',
    attackTargetX: -0.55,
    attackTargetZ: 1.05,
  },
});

// Look up the third-ball plan for a given archetype id. Returns null when
// the archetype doesn't have a planned attack (simple/soft serves).
export function thirdBallPlanForArchetype(archetypeId) {
  return THIRD_BALL_PLANS[archetypeId] || null;
}

// Track most-recent archetype per createServer instance for anti-repeat.

function lerp(a, b, t) { return a + (b - a) * t; }
function pick(range, rng) { return lerp(range[0], range[1], rng()); }

// Pressure levels shift archetype weights by risk category. A human at deuce
// or match point plays fewer risky serves but doesn't abandon them entirely
// — the safe multiplier goes up, the aggressive multiplier goes down.
//   normal      — baseline
//   elevated    — deuce OR game point (server one away from winning game)
//   critical    — match point (would-be-deciding game, server one away)
// Weights are multiplicative and applied AFTER the per-difficulty weight.
const PRESSURE_RISK_MULT = Object.freeze({
  normal:    { safe: 1.0, medium: 1.0, aggressive: 1.0 },
  elevated:  { safe: 1.4, medium: 0.9, aggressive: 0.5 },
  critical:  { safe: 1.8, medium: 0.7, aggressive: 0.25 },
});

function pressureFromContext(ctx) {
  if (!ctx) return 'normal';
  if (ctx.isMatchPoint) return 'critical';
  if (ctx.isGamePoint || ctx.isDeuce) return 'elevated';
  return 'normal';
}

// Placement bucket for pattern-progression tracking. Splits the player
// side into three zones — LEFT (x < -0.2), MIDDLE (-0.2..0.2), RIGHT —
// and tracks how many of the last few serves landed in each. Real Pros
// notice when they've served backhand 4 times running and consciously
// mix middle to jam the opponent; without this the AI would happily
// pound the same zone all game because the archetype-level anti-repeat
// only blocks identical archetypes.
function placementBucket(x) {
  if (x < -0.20) return 'left';
  if (x >  0.20) return 'right';
  return 'middle';
}
function archetypeBucket(a) {
  const mid = (a.placementXRange[0] + a.placementXRange[1]) / 2;
  return placementBucket(mid);
}

// Penalty applied to an archetype when its placement bucket has been
// used ≥3 times in the recent-serve window. 0.4 = "possible but strongly
// discouraged" — allows the AI to still choose it (e.g., if all other
// eligible archetypes are also over-used) but heavily biases toward
// variety.
const OVERUSED_BUCKET_PENALTY = 0.4;
const OVERUSE_THRESHOLD = 3;

function bucketCounts(recentPlacements) {
  const counts = { left: 0, middle: 0, right: 0 };
  for (const b of recentPlacements) counts[b] = (counts[b] || 0) + 1;
  return counts;
}

function weightedPickArchetype(difficulty, rng, avoidId = null, gameContext = null, recentPlacements = null) {
  const pressure = pressureFromContext(gameContext);
  const riskMult = PRESSURE_RISK_MULT[pressure];
  const buckets = recentPlacements ? bucketCounts(recentPlacements) : null;
  const eligible = [];
  let total = 0;
  for (const a of ARCHETYPES) {
    const baseW = a.difficultyWeights[difficulty] || 0;
    if (baseW <= 0) continue;
    if (a.id === avoidId) continue;
    let w = baseW * (riskMult[a.risk] || 1.0);
    // Pattern-progression penalty — dampen archetypes whose placement
    // bucket has been over-used in the recent window.
    if (buckets) {
      const b = archetypeBucket(a);
      if ((buckets[b] || 0) >= OVERUSE_THRESHOLD) {
        w *= OVERUSED_BUCKET_PENALTY;
      }
    }
    if (w <= 0) continue;
    eligible.push({ a, w });
    total += w;
  }
  // Fallback: if anti-repeat filtered everything (single-archetype difficulty),
  // allow the repeat rather than silently degrading.
  if (eligible.length === 0) {
    for (const a of ARCHETYPES) {
      const baseW = a.difficultyWeights[difficulty] || 0;
      if (baseW <= 0) continue;
      const w = baseW * (riskMult[a.risk] || 1.0);
      if (w <= 0) continue;
      eligible.push({ a, w });
      total += w;
    }
  }
  let r = rng() * total;
  for (const e of eligible) {
    if ((r -= e.w) <= 0) return e.a;
  }
  return eligible[eligible.length - 1].a;
}

// --- Target selection -------------------------------------------------------
//
// Returns { target_x, target_z, target_speed, target_spin, target_side_spin,
//           mode, archetype, servePos, swing, disguised }.
// target_z is in spec coords (meters from net on player side).
// servePos.x is meters (already converted from fractional to world offset).
// swing describes the cosmetic paddle motion for SERVE_SWING.
export function selectServeTarget(difficulty, rng = Math.random, opts = {}) {
  const avoidId = opts.avoidArchetypeId || null;
  const gameContext = opts.gameContext || null;
  const recentPlacements = opts.recentPlacements || null;
  const arch = weightedPickArchetype(difficulty, rng, avoidId, gameContext, recentPlacements);

  const target_z = pick(arch.lengthRange, rng);
  const target_x = pick(arch.placementXRange, rng);
  const target_speed = pick(arch.speedRange, rng);
  const target_spin = pick(arch.spinRange, rng);
  const target_side_spin = arch.sideSpinRange ? pick(arch.sideSpinRange, rng) : 0;

  const halfWidth = tableBox
    ? (tableBox.max.x - tableBox.min.x) / 2
    : 0.7625;
  // servePos.x is meters from center of AI baseline. Cap at 80% of half-width
  // so the paddle never spawns on the table's outer edge.
  const servePosXMeters = arch.servePosX * halfWidth * 0.80;

  // Derive a coarse "mode" for backward compat with anything reading it.
  let mode;
  if (target_z < 0.50) mode = 'short';
  else if (target_z > 0.95) mode = 'long';
  else mode = 'half_long';
  if (Math.abs(target_x) > 0.45) mode = 'corner';

  return {
    target_x,
    target_z,
    target_speed,
    target_spin,
    target_side_spin,
    mode,
    archetype: arch.id,
    servePos: { x: servePosXMeters },
    swing: {
      type: arch.swing.type,
      lateral: arch.swing.lateral,
      vertical: arch.swing.vertical,
    },
    // True when this serve's motion is shared with at least one other live
    // archetype (the pendulum family's kinematics are deliberately
    // identical), so the receiver cannot infer the spin from the
    // choreography. Kept on the target for telemetry/UI ("what beat you").
    disguised: arch.swing.type === 'pendulum',
  };
}

// A serve target is "legal" if it lands inside the standard service area
// (player side, inside table footprint and above the net plane).
export function isServeTargetLegal(target, env) {
  if (!target) return false;
  if (!env || !env.tableBox) return true;
  if (target.target_z < 0.05 || target.target_z > 1.37) return false;
  const halfWidth = (env.tableBox.max.x - env.tableBox.min.x) / 2;
  if (target.target_x < -halfWidth || target.target_x > halfWidth) return false;
  return true;
}

// --- Serve subsystem -------------------------------------------------------

export function createServer({ paddle, difficulty = 'beginner', rng = Math.random } = {}) {
  let state = SERVE_STATES.IDLE;
  let stateEnteredAtMs = 0;
  let onComplete = null;

  let serveTarget = null;
  let lastArchetypeId = null;
  // Ring buffer of recent serve placement buckets (left/middle/right).
  // Used by weightedPickArchetype to dampen over-used zones. Cleared
  // between games so a fresh game starts with a clean pattern slate.
  const RECENT_PLACEMENT_WINDOW = 5;
  const recentPlacements = [];
  function pushPlacement(bucket) {
    recentPlacements.push(bucket);
    while (recentPlacements.length > RECENT_PLACEMENT_WINDOW) recentPlacements.shift();
  }
  function resetPlacementPattern() {
    recentPlacements.length = 0;
  }

  const swingTargetPos = new THREE.Vector3();
  const swingTargetNormal = new THREE.Vector3();

  // Toss/contact choreography, rebuilt on every serve by tossBall().
  const contactTargetPos = new THREE.Vector3();
  const contactTargetNormal = new THREE.Vector3();
  const backswingPos = new THREE.Vector3();
  let toss = null;              // predictTossContact result for this serve
  // Amortized serve solve, started at toss time from the PREDICTED contact
  // point and stepped one arc candidate per TOSS frame. Solving synchronously
  // in strikeBall cost up to 4 aim-shift solves × 90 sims in the one frame
  // where the AI strikes — a guaranteed hitch on every AI serve. The strike
  // still absorbs toss drift: if the live ball ends up more than
  // PRESOLVE_MAX_DRIFT_M from the predicted contact, strikeBall falls back
  // to the full synchronous solve from the real position.
  let preSolve = null;
  let collisionSuppressed = false;

  // The AI paddle is only conditionally collidable — tests and the headless
  // harness pass stub paddles without the method, so guard every call.
  function setPaddleCollision(enabled) {
    collisionSuppressed = !enabled;
    if (paddle && typeof paddle.setCollisionEnabled === 'function') {
      paddle.setCollisionEnabled(enabled);
    }
  }

  // Once the struck ball is clear of the hit radius, hand the collider back
  // so a fast player return during POST_SERVE is still hittable.
  function maybeRearmCollision() {
    if (!collisionSuppressed) return;
    if (!ballModel || !ballModel.visible) return;
    if (ballModel.position.distanceTo(paddle.faceCenterWorld) > COLLISION_REARM_DISTANCE_M) {
      setPaddleCollision(true);
    }
  }

  // Serve-ready pose: archetype's servePos.x sets the lateral offset from
  // the AI baseline center. Y and Z remain at the AI's baseline edge.
  function computeServeReadyPose(servePosXMeters = 0) {
    if (!tableBox) {
      return {
        position: new THREE.Vector3(servePosXMeters, 1.05, -1.4),
        normal:   new THREE.Vector3(0, 0.15, 0.99).normalize(),
      };
    }
    const centerX = (tableBox.min.x + tableBox.max.x) / 2;
    const halfWidth = (tableBox.max.x - tableBox.min.x) / 2;
    // Clamp so the paddle never spawns past the AI-side edge of the table.
    const maxOffset = halfWidth * 0.85;
    const clampedX = Math.max(-maxOffset, Math.min(maxOffset, servePosXMeters));
    return {
      position: new THREE.Vector3(centerX + clampedX, tableSurfaceY + 0.30, tableBox.min.z - 0.05),
      normal:   new THREE.Vector3(0, 0.15, 0.99).normalize(),
    };
  }

  function transitionTo(next) {
    state = next;
    stateEnteredAtMs = performance.now();
  }

  function startServe(opts = {}) {
    onComplete = opts.onComplete || null;
    serveTarget = selectServeTarget(difficulty, rng, {
      avoidArchetypeId: lastArchetypeId,
      gameContext: opts.gameContext || null,
      recentPlacements,
    });
    lastArchetypeId = serveTarget.archetype;
    pushPlacement(placementBucket(serveTarget.target_x));
    // Third-ball plan: international and above. Serve → forced weak return →
    // pre-planned attack is THE defining pattern of high-level table tennis;
    // an opponent that serves without a follow-up in mind is not playing at
    // that level, whatever its ball speeds say. Beginner is excluded because
    // it doesn't have the shot vocabulary to execute a plan.
    //
    // If the archetype has no configured plan (soft serves, straight
    // middles), this stays null and no third-ball logic fires.
    lastServeThirdBallPlan = (difficulty === 'pro' || difficulty === 'intermediate')
      ? thirdBallPlanForArchetype(serveTarget.archetype)
      : null;
    transitionTo(SERVE_STATES.PRE_SERVE);
    const ready = computeServeReadyPose(serveTarget.servePos.x);
    paddle._serveReadyPose = ready;
  }

  function isFinished() { return state === SERVE_STATES.IDLE; }
  function getState() { return state; }
  function getServeTarget() { return serveTarget; }
  // Third-ball plan for the most recently STARTED serve. Set by
  // startServe() and cleared by consumeLastServeThirdBallPlan() (called
  // by aiMatch on the player's first return). Null when the archetype
  // has no planned attack or when already consumed.
  let lastServeThirdBallPlan = null;
  function getLastServeThirdBallPlan() { return lastServeThirdBallPlan; }
  function consumeLastServeThirdBallPlan() {
    const p = lastServeThirdBallPlan;
    lastServeThirdBallPlan = null;
    return p;
  }

  // Build a cosmetic swing target from the archetype's swing kinematics.
  // Lateral is applied opposite the AI's servePos.x so a pendulum from the
  // right sweeps left-to-right across the body (looks natural).
  function computeSwingTarget() {
    const kin = serveTarget.swing;
    swingTargetPos.copy(paddle.faceCenterWorld)
      .addScaledVector(paddle.faceNormalWorld, SWING_FORWARD_TRAVEL_M);
    // Lateral: signed by opposite of servePos.x so the swing crosses the
    // body. Neutral (servePos.x ≈ 0) still uses lateral as-is.
    const lateralSign = serveTarget.servePos.x >= 0 ? -1 : +1;
    if (kin.lateral !== 0) {
      swingTargetPos.x += kin.lateral * lateralSign;
    }
    if (kin.vertical !== 0) {
      swingTargetPos.y += kin.vertical;
    }
    swingTargetNormal.copy(paddle.faceNormalWorld);
  }

  // World-space landing point this serve is aimed at.
  function targetWorldPoint() {
    // Both axes are table-local — the play surface is not centred on x = 0
    // (see specTargetToWorld in telegraph.js).
    const tableCenterX = tableBox ? (tableBox.min.x + tableBox.max.x) / 2 : 0;
    const tableCenterZ = tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0;
    return new THREE.Vector3(
      tableCenterX + serveTarget.target_x,
      tableSurfaceY || 0,
      tableCenterZ + serveTarget.target_z,
    );
  }

  // Spawn the toss and build the paddle choreography around it.
  //
  // The ball leaves the free hand — modelled as a point offset laterally
  // from the paddle, on the side the swing comes FROM, so a pendulum sweeps
  // across the body toward it. Vertical velocity comes from the archetype:
  // 'high_toss' gets the dramatic version, everything else the standard one.
  function tossBall() {
    const ready = paddle._serveReadyPose || computeServeReadyPose(serveTarget.servePos.x);
    // lateralSign matches computeSwingTarget's convention: the swing crosses
    // the body, so the free hand is on the far side of the swing origin.
    const lateralSign = serveTarget.servePos.x >= 0 ? -1 : +1;
    const tossPos = new THREE.Vector3(
      ready.position.x + lateralSign * TOSS_LATERAL_OFFSET_M,
      (tableSurfaceY || 0) + TOSS_ORIGIN_HEIGHT_M,
      ready.position.z + TOSS_FORWARD_OFFSET_M,
    );
    const vy = serveTarget.swing.type === 'high_toss'
      ? HIGH_TOSS_UP_VY_MPS
      : TOSS_UP_VY_MPS;
    const tossVel = new THREE.Vector3(
      -lateralSign * TOSS_DRIFT_MPS,
      vy,
      TOSS_DRIFT_MPS,
    );

    toss = predictTossContact(
      tossPos, tossVel,
      (tableSurfaceY || 0) + TOSS_CONTACT_HEIGHT_M,
    );

    // Start the amortized launch solve from the predicted contact point —
    // the toss buys a few hundred ms of frames, so by strike time the result
    // is normally ready and strikeBall pays nothing.
    {
      const env = { tableBox, tableSurfaceY, ballRadius, netBox };
      const targetPoint = targetWorldPoint();
      const launchPos = toss.position.clone();
      const launchSpin = computeLaunchSpin(launchPos, targetPoint);
      preSolve = {
        launchPos,
        launchSpin,
        gen: serveSolveSteps(
          launchPos, targetPoint, serveTarget.target_speed, launchSpin, env,
        ),
        done: false,
        result: null,
      };
    }

    // Contact pose: paddle face points from the contact point toward the
    // landing target, tilted slightly up so the serve arcs over the net.
    contactTargetPos.copy(toss.position);
    contactTargetNormal.copy(targetWorldPoint()).sub(contactTargetPos);
    contactTargetNormal.y = 0;
    if (contactTargetNormal.lengthSq() < 1e-6) contactTargetNormal.set(0, 0, 1);
    contactTargetNormal.normalize();
    contactTargetNormal.y = 0.20;
    contactTargetNormal.normalize();

    // Backswing: the mirror image of the follow-through, so the whole motion
    // reads as one continuous swing through the ball.
    const kin = serveTarget.swing;
    backswingPos.copy(contactTargetPos)
      .addScaledVector(contactTargetNormal, -BACKSWING_BACK_M);
    backswingPos.x -= kin.lateral * lateralSign;
    backswingPos.y -= kin.vertical;

    // The ball is about to fly straight into the paddle. Contact is scripted
    // (strikeBall), so the swept-disc collider must stay out of it.
    setPaddleCollision(false);
    spawnBallAt(tossPos, tossVel, new THREE.Vector3());
  }

  // True once the tossed ball has come back down to contact height, or once
  // the scheduled contact time has passed (covers a missing ballModel, e.g.
  // headless, and any drift between prediction and live physics).
  function shouldStrike(elapsedMs) {
    const scheduledMs = toss ? toss.timeMs : PRE_SERVE_DURATION_MS;
    if (ballModel && ballModel.visible) {
      if (ballVelocity.y < 0 && ballModel.position.y <= toss.contactY) return true;
      // Independent of the predicted height: never let the live ball get
      // past the descent speed the placement solver can absorb.
      if (ballVelocity.y <= -MAX_CONTACT_DESCENT_MPS) return true;
      // The live ball can lag the prediction slightly (variable dt, tuner
      // changes mid-toss). Give it a short grace period to actually arrive
      // before forcing the strike, so the paddle isn't seen swinging at
      // empty air. The hard cap below still guarantees termination.
      if (elapsedMs >= scheduledMs + STRIKE_GRACE_MS) return true;
      return elapsedMs >= TOSS_MAX_DURATION_MS;
    }
    // Headless / no ball model: purely scheduled.
    return elapsedMs >= scheduledMs;
  }

  // Drive the paddle back, then into the predicted contact point. The
  // approach leg derives its speed from the time remaining so the paddle
  // arrives ON the strike frame rather than trailing it.
  function driveTossPaddle(dt, elapsedMs) {
    const totalMs = toss ? toss.timeMs : PRE_SERVE_DURATION_MS;
    if (elapsedMs < totalMs * BACKSWING_FRACTION) {
      paddle.driveTowardPose(backswingPos, contactTargetNormal, dt, 2.5);
      return;
    }
    // Aim to be AT the contact point slightly before the predicted strike.
    // Either trigger in shouldStrike can fire a frame or two early; arriving
    // early means the paddle is already there when it does, and it simply
    // holds the pose for the remainder.
    const arriveMs = totalMs * ARRIVE_EARLY_FRACTION;
    const remainingS = Math.max((arriveMs - elapsedMs) / 1000, 1 / 90);
    const dist = paddle.faceCenterWorld.distanceTo(contactTargetPos);
    const needed = Math.max(dist / remainingS, BACKSWING_APPROACH_MIN_SPEED_MPS);
    paddle.driveTowardPose(
      contactTargetPos, contactTargetNormal, dt,
      Math.min(needed, maxPaddleSpeedForDifficulty(difficulty)),
    );
  }

  // Outgoing spin: topspin/backspin about the horizontal axis perpendicular
  // to the direction of travel (feeder.js convention — ball toward +z,
  // topspin = +x), PLUS the archetype's sidespin about the vertical axis —
  // the component that makes a pendulum serve curl in flight and kick off
  // the bounce. Both are rps in the target, rad/s on the ball.
  function computeLaunchSpin(launchPos, targetPoint) {
    const dir = targetPoint.clone().sub(launchPos);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const launchSpin = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), dir)
      .normalize()
      .multiplyScalar(serveTarget.target_spin * 2 * Math.PI);
    launchSpin.y += (serveTarget.target_side_spin || 0) * 2 * Math.PI;
    return launchSpin;
  }

  // Advance the amortized serve solve by one arc candidate. Called once per
  // TOSS frame; strikeBall drains whatever remains (normally nothing).
  function stepPreSolve() {
    if (!preSolve || preSolve.done) return;
    const r = preSolve.gen.next();
    if (r.done) {
      preSolve.done = true;
      preSolve.result = r.value;
    }
  }

  // Scripted contact. Uses the pre-solved launch when the live ball is where
  // the toss prediction said it would be; on real drift (variable dt, tuner
  // changes mid-toss) it re-solves from the ball's REAL position at this
  // instant so the placement isn't thrown off. The outgoing trajectory is a
  // legal two-bounce serve: own half first, then over the net to the target.
  function strikeBall() {
    const live = !!(ballModel && ballModel.visible);
    const launchPos = live ? ballModel.position.clone() : toss.position.clone();

    const env = { tableBox, tableSurfaceY, ballRadius, netBox };
    const targetPoint = targetWorldPoint();

    let solved = null;
    let launchSpin = null;
    if (preSolve && launchPos.distanceTo(preSolve.launchPos) <= PRESOLVE_MAX_DRIFT_M) {
      while (!preSolve.done) stepPreSolve();
      solved = preSolve.result;
      // The solver verified its candidates with THIS spin — launch with the
      // same vector or the Magnus curl won't match the solved trajectory.
      launchSpin = preSolve.launchSpin;
    }
    if (!solved || !solved.velocity) {
      launchSpin = computeLaunchSpin(launchPos, targetPoint);
      solved = solveServeWithAimShift(
        launchPos, targetPoint, serveTarget.target_speed, launchSpin, env,
      );
    }
    let launchVel;
    if (solved && solved.velocity) {
      launchVel = solved.velocity;
      if (!solved.legal && typeof console !== 'undefined') {
        console.warn('[AI serve] no fully legal two-bounce candidate — serving best effort; physics may be over-tuned');
      }
    } else {
      // Degenerate geometry (no table box — headless edge case). Closed-form
      // two-bounce launch at a middle-of-the-road leg-1 time.
      const fb = serveBallistic(launchPos, targetPoint, tableSurfaceY || 0, 0.30, null);
      launchVel = fb.velocity.clone();
    }

    spawnBallAt(launchPos, launchVel, launchSpin);

    // The contact never goes through tryPaddleCollision, so the hit sound
    // would otherwise be missing — a visible toss with a silent strike reads
    // as a glitch. Volume/intensity scale the same way the collision path
    // does (swing speed / 3, clamped).
    const speed = launchVel.length();
    try {
      playPaddleHitSound(Math.min(speed / 3, 1.0), Math.min(speed / 8, 1.0), launchPos, undefined, 'opponent');
    } catch (_) { /* audio graph not up yet (pre-gesture) — not fatal */ }

    computeSwingTarget();
  }

  function update(dt) {
    const nowMs = performance.now();
    switch (state) {
      case SERVE_STATES.IDLE: return;

      case SERVE_STATES.PRE_SERVE: {
        const ready = paddle._serveReadyPose;
        if (ready) paddle.driveTowardPose(ready.position, ready.normal, dt, 2.0);
        if (nowMs - stateEnteredAtMs >= PRE_SERVE_DURATION_MS) {
          tossBall();
          transitionTo(SERVE_STATES.TOSS);
        }
        return;
      }

      case SERVE_STATES.TOSS: {
        const elapsed = nowMs - stateEnteredAtMs;
        driveTossPaddle(dt, elapsed);
        stepPreSolve();
        if (shouldStrike(elapsed)) {
          strikeBall();
          transitionTo(SERVE_STATES.SERVE_SWING);
        }
        return;
      }

      case SERVE_STATES.SERVE_SWING: {
        paddle.driveTowardPose(
          swingTargetPos, swingTargetNormal, dt,
          maxPaddleSpeedForDifficulty(difficulty),
        );
        maybeRearmCollision();
        if (nowMs - stateEnteredAtMs >= SERVE_SWING_DURATION_MS) {
          transitionTo(SERVE_STATES.POST_SERVE);
        }
        return;
      }

      case SERVE_STATES.POST_SERVE: {
        paddle.driveTowardPose(
          paddle.readyPose.position, paddle.readyPose.normal,
          dt, 1.5,
        );
        maybeRearmCollision();
        if (nowMs - stateEnteredAtMs >= POST_SERVE_RECOVERY_MS) {
          transitionTo(SERVE_STATES.IDLE);
          serveTarget = null;
          toss = null;
          preSolve = null;
          // Unconditional restore — by now the serve has travelled at least
          // 1.3m (450ms at the 3 m/s archetype floor), so the collider can
          // never re-hit its own ball, and leaving it gated would make the
          // AI unable to return anything.
          setPaddleCollision(true);
          if (onComplete) {
            const cb = onComplete;
            onComplete = null;
            cb();
          }
        }
        return;
      }
    }
  }

  function dispose() {
    state = SERVE_STATES.IDLE;
    serveTarget = null;
    onComplete = null;
    lastArchetypeId = null;
    toss = null;
    preSolve = null;
    // Never leave the paddle uncollidable if we're torn down mid-toss.
    setPaddleCollision(true);
  }

  return {
    startServe,
    update,
    isFinished,
    getLastServeThirdBallPlan,
    consumeLastServeThirdBallPlan,
    resetPlacementPattern,
    getState,
    getServeTarget,
    dispose,
  };
}
