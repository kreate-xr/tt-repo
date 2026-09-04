// AI opponent finite-state machine. Single source of truth for the AI's
// behavior across a rally; rendering reads from it every frame, decisions
// flow through it at ~5Hz (event-driven, NOT per-frame).
//
// Spec §ai_fsm_design and §data_flow_per_rally:
//
//   IDLE
//     │  player paddle contacts ball
//     ▼
//   PREDICTING
//     │  physics rollout returns predicted AI-side contact point
//     ▼
//   DECIDING
//     │  AI worker returns target via postMessage
//     ▼
//   MOVING                       (body orientation telegraph visible: face
//     │  exactly at T-400ms       normal points toward target XZ)
//     ▼
//   COMMITTED                    (commitment lock; ±5cm micro-correction
//     │  exactly at T-150ms       allowed; beyond = honest miss)
//     ▼
//   SWINGING                     (paddle angle telegraph fires: face Y
//     │  paddle reaches ball      indicates shot type per spec table)
//     ▼
//   CONTACT  →  RECOVERING       (0.4 movement speed = vulnerability
//                ↓                window; smooth lerp back to ready pose)
//               IDLE
//
// Driving discipline: this module does NOT subscribe to ballEvents directly.
// The aiMatch orchestrator subscribes once and routes to onPlayerHit /
// onAIContact / onBallLost / onTargetReceived. This guarantees the
// shotAdapter rollout runs BEFORE the FSM reads its result.

import * as THREE from 'three';
import { ballModel, ballRadius, tableBox, tableSurfaceY, netBox } from '../../scene/models.js';
import { MOVEMENT_SPEED_MPS } from './aiPaddle.js';
import {
  faceNormalForShot, shotTypeFromTarget, disguisedShotTypeFor,
  specTargetToWorld, SHOT_TYPES,
  WINDUP_DEPTH_M_BY_POWER, powerTierForSpeed, telegraphLeadMsForSpeed,
  COMMIT_LOCK_BEFORE_CONTACT_MS,
} from './telegraph.js';
import {
  RECOVERY_MS, VULNERABILITY_SPEED_MULTIPLIER,
} from './recovery.js';
import {
  MISS_RATE_BY_DIFFICULTY,
  SHAKEN_MULTIPLIER, SHAKEN_SHOTS,
  shouldInjectMiss, sampleMissCause, applyMissToIntent, scaleMissRateForSituation,
  shouldWasteHalfStep, wastedStepOffsetVec, WASTED_STEP_DURATION_MS,
} from './imperfection.js';
import { solvePaddleSteps, maxPaddleSpeedForDifficulty } from '../../ai/paddleSolver.js';
import { STREAK_THRESHOLD, STREAK_MISS_BOOST_ADDITIVE } from '../../ai/momentum.js';
import { checkReachability, REACHABILITY } from './reachability.js';
import { planTrajectory, interpolateTrajectory, clampPlannedPosAboveTable } from './interception.js';
import { recordAIContact, idleSettleOffset, anticipationLeanX } from './readyPosition.js';

export const STATES = Object.freeze({
  IDLE: 'IDLE',
  PREDICTING: 'PREDICTING',
  DECIDING: 'DECIDING',
  MOVING: 'MOVING',
  COMMITTED: 'COMMITTED',
  SWINGING: 'SWINGING',
  CONTACT: 'CONTACT',
  RECOVERING: 'RECOVERING',
});

// Commitment-lock and telegraph timing, per spec §the_five_non_negotiable_rules.
// Both now live in telegraph.js so the invariant "telegraph lead < commit
// lock" can be unit-tested; re-exported here for existing callers.
export { COMMIT_LOCK_BEFORE_CONTACT_MS };
// How long the AI takes to READ the spin on an incoming ball, in ms.
//
// Without this the AI is a perfect instrument: shotAdapter hands it an exact
// physics rollout the instant the player makes contact, so heavy spin costs
// it nothing. Real players — international ones included — read pace and line
// first and the curve a beat later, which is why a well-disguised loop wins
// points against opponents fast enough to reach it.
//
// Kept deliberately short. This is a mid-approach correction, not a handicap:
// it must expire well before COMMIT_LOCK_BEFORE_CONTACT_MS so the AI still
// has time to correct, and it only bites on balls with real spin (see
// MISREAD_MIN_OFFSET_M) so flat rallies are untouched.
export const READ_LATENCY_MS = 120;
// Per-tier read latency. This used to be the flat 120 above for everyone,
// which meant CLUB and ELITE perceived the ball identically and only
// footwork and dice separated them — no real ladder works that way. How
// fast you read spin off the opponent's racket IS a skill axis: a club
// player commits to their first (spin-blind) read for most of the approach;
// an elite player has the curve decoded almost off the bounce of the
// opponent's contact. Every value stays under COMMIT_LOCK_BEFORE_CONTACT_MS
// with margin at rally flight times, so this remains a mid-approach
// correction, never an uncorrectable blindfold.
export const READ_LATENCY_MS_BY_DIFFICULTY = Object.freeze({
  beginner: 280,
  intermediate: 150,
  pro: 90,
});
// Minimum distance between the spin-blind and true interception points for
// the misread to be worth simulating. Below this the correction would be
// inside the existing micro-correction budget and invisible.
export const MISREAD_MIN_OFFSET_M = 0.04;

// Telegraph lead is no longer flat — it scales with shot pace via
// telegraph.TELEGRAPH_LEAD_MS_BY_POWER (150 soft / 250 medium / 350 power),
// because an international-pace ball arrives at or below human reaction time
// and has to be readable from the backswing. This constant is retained as the
// soft-tier value and for external callers; the FSM uses telegraphLeadMs().
export const TELEGRAPH_BEFORE_CONTACT_MS = 150;

// Swing-phase paddle speed multiplier. Spec doesn't pin a number; 4x ready
// speed produces an impact velocity in the existing physics that yields
// returns in the target ball-speed range for Beginner (3-5 m/s) without
// the AI looking sluggish at first contact.
const SWING_SPEED_MULTIPLIER = 4.0;

// Spec §ai_worker_design.engines.pro disguised-serve hook. Fraction of the
// SWINGING window during which the paddle face displays the DISGUISED shot
// type. After this fraction elapses, the "wrist" rotates to the actual
// shot type — the visible face Y at contact matches the impulse direction
// the existing physics applies. Pro only; non-Pro difficulties show actual
// from the start (displayedShotType === shotType).
const DISGUISE_FRACTION_OF_SWING = 2 / 3;

// Spec §step_4_commit + §step_5_execute_with_telegraph.micro_correction_budget_m
// Micro-correction allowance after the commitment lock fires. The paddle may
// follow the live ball by UP TO ±5cm from the committed interception point.
// Deviation beyond this budget = honest miss: the paddle stays at the limit
// and the ball passes by. This is the gameplay-critical "commitment lets the
// AI miss" behavior — late spin from the player can fool a committed AI.
const MICRO_CORRECTION_BUDGET_M = 0.05;

// Debug logging — flip false for production / playtest with no console noise.
const DEBUG_LOG = false;

function tableCenterZ() {
  return tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0;
}

// The spec frame's X origin. Table.glb's play surface is not centred on
// x = 0, so this is not the no-op it looks like — see specTargetToWorld in
// telegraph.js.
function tableCenterX() {
  return tableBox ? (tableBox.min.x + tableBox.max.x) / 2 : 0;
}

export function createAIFSM({ paddle, intent, difficulty = 'beginner', failureHandler = null }) {
  let state = STATES.IDLE;
  let stateEnteredAtMs = performance.now();

  // Reusable temp vectors — avoids per-frame allocations on the hot path.
  const _normalTmp        = new THREE.Vector3();
  const _correctedTarget  = new THREE.Vector3();
  const _targetWorldTmp   = new THREE.Vector3();
  const _wastedStepTarget = new THREE.Vector3();
  const _swingPosTmp      = new THREE.Vector3();
  const _swingDirTmp      = new THREE.Vector3();
  const _idlePoseTmp      = new THREE.Vector3();
  const _idleWobbleTmp    = { x: 0, y: 0, z: 0 };
  const _disguiseFaceTmp  = new THREE.Vector3();
  // V2 §section_2 interception trajectory interpolation temps.
  const _trajectoryPos    = new THREE.Vector3();
  const _trajectoryFace   = new THREE.Vector3();
  // Phase 1-2 fallback normals, used before a target arrives or when we
  // can't compute a directional face normal.
  const _readyNormal      = new THREE.Vector3(0, 0.20, 0.98).normalize();

  // Post-miss "shaken" state. Counts how many shots ago the last miss
  // occurred; while shotsSinceMiss < SHAKEN_SHOTS the base miss rate is
  // multiplied by SHAKEN_MULTIPLIER. Reset to a large sentinel on FSM
  // creation so the first shot of a match plays with base rate.
  let shotsSinceMiss = 999;

  // Consecutive-point streak tracking. Losing 3+ in a row shakes the AI
  // (defense sags) — additive boost to miss rate. Fed by aiMatch's
  // onPointScored listener via onPointResult().
  // Single source of truth in momentum.js — the shot-type half of this rule
  // lives there, the miss-rate half here, and they must agree.
  const STREAK_LOSS_THRESHOLD = STREAK_THRESHOLD;
  const STREAK_LOSS_MISS_BOOST = STREAK_MISS_BOOST_ADDITIVE;
  let consecutiveLostPoints = 0;

  // Spin read-latency state — see READ_LATENCY_MS. While a misread is
  // pending, the AI's planned trajectory aims at where a spin-blind read said
  // the ball would be; once the read completes, update() re-plans onto the
  // true interception point.
  let misreadCorrectionPending = false;
  let readCompleteAtPerfMs = 0;
  const _misreadOffset = new THREE.Vector3();
  const _misreadTarget = new THREE.Vector3();

  // Amortized paddle solve in flight (see onTargetReceived). Non-null only
  // between the worker's target reply and finishTargetReceived.
  let pendingSolve = null;
  // Verification rollouts advanced per frame while flight time is plentiful
  // (~0.3-0.6 ms of solver work per frame), and the time-to-contact below
  // which the remaining job is drained in one go instead — waiting more
  // frames there could eat into the swing.
  // 3 (was 2): the soften ladder can chain up to 4 solves on a ball whose
  // full-pace request is infeasible; 3/frame keeps even that worst case ahead
  // of the drain threshold on a normal flight without measurable frame cost.
  const SOLVE_ROLLOUTS_PER_FRAME = 3;
  const SOLVE_DRAIN_BELOW_MS = 450;

  function transition(next) {
    if (state === next) return;
    if (DEBUG_LOG) console.log(`[AI FSM] ${state} → ${next}`);
    state = next;
    stateEnteredAtMs = performance.now();
  }

  // How fast this AI covers ground, style-adjusted. Distinct from the strike
  // cap (maxPaddleSpeedForDifficulty), which is racket-head speed through
  // contact. Reach and the trajectory's approach phase are gated on THIS;
  // only the swing phase is gated on the strike cap.
  function footworkSpeed() {
    const styleMult = (paddle && typeof paddle.movementMultiplier === 'number')
      ? paddle.movementMultiplier
      : 1;
    return (MOVEMENT_SPEED_MPS[difficulty] || MOVEMENT_SPEED_MPS.beginner) * styleMult;
  }

  // Plan the 8-keyframe interception trajectory toward `contactPos`. Called
  // once when the target arrives, and again mid-approach when the spin read
  // completes and the AI has to correct off its first (spin-blind) read.
  // Leaves any existing trajectory untouched if the new plan can't be built,
  // so a failed re-plan degrades to "kept its original read" rather than to
  // no trajectory at all.
  function planTrajectoryTo(contactPos) {
    const timeBudgetMs = intent.predictedContactPerfMs - performance.now();
    if (timeBudgetMs <= 50) return false;
    // Pace-scaled face reveal: the visible face starts rotating toward the
    // contact normal telegraphLeadMs before contact (150/250/350 by power),
    // so a smash's backswing is readable in real time, not as a fixed sliver
    // of whatever the budget happens to be.
    const speed = intent.target ? intent.target[2] : 0;
    // Pro disguise: the reveal passes through the DISGUISED shot type's face
    // for the first 2/3 of the window, then wrist-snaps to the true contact
    // face. displayedShotType is set by onTargetReceived (Pro only, spinful
    // shots only); this is the path that finally consumes it — the old one
    // only ran when the solver had already failed.
    let disguiseFace = null;
    if (difficulty === 'pro'
        && intent.displayedShotType
        && intent.displayedShotType !== intent.shotType) {
      disguiseFace = faceNormalForShot(
        intent.displayedShotType, contactPos, intent.targetWorld, _disguiseFaceTmp,
      );
    }
    const plan = planTrajectory({
      currentPos: paddle.faceCenterWorld,
      currentFaceNormal: paddle.faceNormalWorld,
      contactPos,
      contactFaceNormal: intent.solverFaceNormal,
      contactPaddleVelocity: intent.solverPaddleVelocity,
      timeBudgetMs,
      maxPaddleSpeed: maxPaddleSpeedForDifficulty(difficulty),
      maxApproachSpeed: footworkSpeed(),
      telegraphLeadMs: speed > 0 ? telegraphLeadMsForSpeed(speed) : null,
      disguiseFaceNormal: disguiseFace,
      // Keeps the windup anchor and keyframes above the felt — an upward
      // (loop) swing direction otherwise plans the backswing under the table.
      tableBox,
      tableSurfaceY,
    });
    if (!plan || !plan.keyframes || plan.keyframes.length === 0) return false;
    intent.trajectory = plan.keyframes;
    intent.trajectoryPlannedAtMs = performance.now();
    if (DEBUG_LOG) {
      console.log(`[AI FSM] trajectory planned: ${plan.keyframes.length} keyframes, peakSpeed=${plan.peakSpeed_mps.toFixed(2)} m/s, reachable=${plan.reachable}`);
    }
    return true;
  }

  // How far ahead of contact this shot's swing becomes visible. Scales with
  // the shot's pace — see TELEGRAPH_LEAD_MS_BY_POWER. A hard shot has to be
  // readable from the backswing or it is unreturnable rather than difficult.
  function telegraphLeadMs() {
    const targetSpeed = (intent.target && intent.target[2]) || 5.0;
    return telegraphLeadMsForSpeed(targetSpeed);
  }

  // ±5cm micro-correction from the locked interception point. Spec
  // §step_4_commit.scramble_behavior. Returns the world-space target the
  // paddle should drive to this frame.
  function correctedInterceptTarget(out) {
    out.copy(intent.predictedContact);
    if (!ballModel || !ballModel.visible) return out;
    const dx = ballModel.position.x - intent.predictedContact.x;
    const dy = ballModel.position.y - intent.predictedContact.y;
    const dz = ballModel.position.z - intent.predictedContact.z;
    const len = Math.hypot(dx, dy, dz);
    if (len <= MICRO_CORRECTION_BUDGET_M) {
      out.set(intent.predictedContact.x + dx,
              intent.predictedContact.y + dy,
              intent.predictedContact.z + dz);
    } else {
      const scale = MICRO_CORRECTION_BUDGET_M / len;
      out.set(intent.predictedContact.x + dx * scale,
              intent.predictedContact.y + dy * scale,
              intent.predictedContact.z + dz * scale);
    }
    return out;
  }

  // Build the face normal used during MOVING and COMMITTED: points from the
  // paddle toward the world target. Y component held flat (0) so the paddle
  // shows "body orientation toward target side" without yet revealing shot
  // type — that reveal happens in SWINGING via the telegraph Y.
  function bodyOrientationNormal(out) {
    if (!intent.target) return out.copy(_readyNormal);
    const dx = intent.targetWorld.x - paddle.faceCenterWorld.x;
    const dz = intent.targetWorld.z - paddle.faceCenterWorld.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return out.copy(_readyNormal);
    out.set(dx / len, 0, dz / len);
    return out;
  }

  // Build the telegraph face normal during SWINGING — XZ toward target,
  // Y from shot type per spec §telegraph_design. The active shot type
  // depends on swing progress: early = displayedShotType (the disguise on
  // Pro, == actual on non-Pro), late = actual shotType (the late-wrist
  // reveal that matches the impulse at contact).
  function telegraphFaceNormal(out, swingElapsedMs) {
    if (!intent.target || !intent.shotType) return out.copy(_readyNormal);
    const useActual = swingElapsedMs >= telegraphLeadMs() * DISGUISE_FRACTION_OF_SWING;
    const activeType = useActual ? intent.shotType : (intent.displayedShotType || intent.shotType);
    return faceNormalForShot(
      activeType,
      paddle.faceCenterWorld,
      intent.targetWorld,
      out,
    );
  }

  // --- External events (called by aiMatch orchestrator) ---------------------

  function onPlayerHit(rolloutResult, rolloutSpinBlind = null) {
    // Hard commitment lock — once we've entered COMMITTED for the current
    // rally, a new player hit cannot reset the FSM. The prior rally must
    // play out (contact OR miss + recovery) before a new prediction starts.
    if (state === STATES.COMMITTED || state === STATES.SWINGING ||
        state === STATES.CONTACT || state === STATES.RECOVERING) {
      if (DEBUG_LOG) console.log(`[AI FSM] onPlayerHit ignored in ${state} (commit lock)`);
      return;
    }
    if (!rolloutResult) {
      transition(STATES.IDLE);
      return;
    }
    transition(STATES.PREDICTING);

    // Spin read latency. The AI's FIRST read of the ball is spin-blind — it
    // sees pace and line but hasn't registered the curve yet. Only balls with
    // real spin on them are affected; on a flat ball the two rollouts agree
    // and behaviour is identical to before, which keeps the blast radius on
    // exactly the shots where the realism gap lives.
    //
    // We record where the spin-blind read said the ball would be, and how
    // far that is from the truth. update() uses this to re-plan mid-approach
    // once READ_LATENCY_MS has elapsed — the AI commits to a slightly wrong
    // interception point and corrects late, the way a player misreading a
    // loop does.
    misreadCorrectionPending = false;
    if (rolloutSpinBlind && rolloutSpinBlind.contactPoint) {
      const dx = rolloutSpinBlind.contactPoint.x - rolloutResult.contactPoint.x;
      const dy = rolloutSpinBlind.contactPoint.y - rolloutResult.contactPoint.y;
      const dz = rolloutSpinBlind.contactPoint.z - rolloutResult.contactPoint.z;
      if (Math.hypot(dx, dy, dz) >= MISREAD_MIN_OFFSET_M) {
        _misreadOffset.set(dx, dy, dz);
        misreadCorrectionPending = true;
      }
    }
    readCompleteAtPerfMs = performance.now()
      + (READ_LATENCY_MS_BY_DIFFICULTY[difficulty] ?? READ_LATENCY_MS);

    intent.predictedContact.set(
      rolloutResult.contactPoint.x,
      rolloutResult.contactPoint.y,
      rolloutResult.contactPoint.z,
    );
    intent.predictedContactPerfMs = performance.now() + rolloutResult.contactTimeMs;
    // V2: capture ball state at predicted contact so paddleSolver can
    // compute the impulse that produces the engine's intended outgoing
    // shot. rolloutResult populated by shotAdapter.rolloutForAIInterception.
    if (rolloutResult.contactVelocity) {
      intent.predictedContactBallVel.set(
        rolloutResult.contactVelocity.x,
        rolloutResult.contactVelocity.y,
        rolloutResult.contactVelocity.z,
      );
    }
    if (rolloutResult.contactSpin) {
      intent.predictedContactBallSpin.set(
        rolloutResult.contactSpin.x,
        rolloutResult.contactSpin.y,
        rolloutResult.contactSpin.z,
      );
    }
    intent.hasPrediction = true;
    intent.committed = false;
    intent.shotType = null;
    intent.target = null;
    intent.solverFeasible = false;
    intent.reachability = 'reachable';
    // A fresh prediction obsoletes any solve still amortizing for the old one.
    pendingSolve = null;
    transition(STATES.DECIDING);
  }

  function onTargetReceived(targetPayload) {
    intent.target = targetPayload;
    // Derive shot type + world-space target so the FSM update() loop can
    // build the telegraph face normal without recomputing on every frame.
    const speed = targetPayload[2];
    const spin  = targetPayload[3];
    // Prefer the engine's picked shot type (targetPayload[5]) when present.
    // All three engines emit the type they chose so PUSH renders as PUSH (not
    // SLICE) and mid-band DRIVE/LOOP shots don't collapse into each other via
    // the numeric-range lookup. Only the worker-timeout fallback payload is
    // 5 elements and falls through to the derivation — Beginner has emitted 6
    // since it gained a real shot vocabulary.
    const pickedType = (targetPayload.length > 5) ? targetPayload[5] : null;
    intent.shotType = pickedType || shotTypeFromTarget(speed, spin);
    // Pro only: compute the disguised shot type (sign-flipped spin) for the
    // early-SWINGING telegraph. Non-Pro difficulties show the actual shot
    // type from the start. If the disguise would be ambiguous (spin = 0,
    // so no sign to flip), fall back to actual.
    if (difficulty === 'pro') {
      const disguised = disguisedShotTypeFor(speed, spin);
      intent.displayedShotType = disguised || intent.shotType;
    } else {
      intent.displayedShotType = intent.shotType;
    }
    specTargetToWorld(
      targetPayload[0], targetPayload[1],
      tableCenterX(), tableCenterZ(), tableSurfaceY,
      intent.targetWorld,
    );

    // V2 §section_1 + §section_3: solver + reachability gate.
    //
    // Solver computes the paddle face_normal and velocity required to
    // produce the intended outgoing shot, run through the host's existing
    // collision physics. On infeasible, fall back ONCE to a safe target
    // (center-table, low-medium speed, no spin). If still infeasible OR
    // unreachable, the AI plays out the swing anyway but the resulting
    // miss is honest — paddle physics produces a poor return.
    // netBox makes the solver net-aware: without it, pass-2 verification
    // flies straight through where the net stands and every fast flat shot
    // (smash especially) off a mid-height contact "verified" onto a target
    // it could never reach live. Live ES-module binding — null until the
    // table GLB loads, populated long before the first rally decision.
    const env = {
      tableBox, tableSurfaceY, ballRadius, netBox,
      tableCenterX: tableCenterX(),
      tableCenterZ: tableCenterZ(),
    };
    // Payload [6] (sidespin, rps) is emitted by all three engines; the
    // worker-timeout fallback payload is shorter, so default to a flat ball.
    const sideSpin = (targetPayload.length > 6 && Number.isFinite(targetPayload[6]))
      ? targetPayload[6]
      : 0;
    // The solve runs AMORTIZED: solvePaddleSteps yields between verification
    // rollouts (up to 20 per solve; the soften ladder + safe fallback can
    // chain up to 4 solves on a hard ball — a guaranteed frame hitch when
    // run synchronously inside this worker-reply callback).
    // update() steps the job a few rollouts per frame while the FSM sits in
    // DECIDING — the same place it already waits on the worker round-trip —
    // and drains it whole once contact gets close. finishTargetReceived
    // carries everything downstream of the solver.
    pendingSolve = {
      gen: paddleSolveJob({
        targetX: targetPayload[0], targetZ: targetPayload[1],
        targetSpeed: speed, targetSpin: spin, targetSideSpin: sideSpin,
        contactPos: intent.predictedContact,
        contactVel: intent.predictedContactBallVel,
        contactSpin: intent.predictedContactBallSpin,
        difficulty, env,
      }),
      speed,
      spin,
    };
    stepPendingSolve();
  }

  // First solve at the engine's target. On infeasible, degrade the way a
  // real player does before abandoning the point of the shot: keep the SAME
  // tactical target (the zone pick, the wrong-footing, the weakness exploit)
  // and soften pace + spin — the lifted, controlled version of the same
  // stroke. Only when even that can't clear/land does the centre-table safe
  // block (spec §infeasibility_fallback) fire.
  //
  // This ladder is what keeps the net-aware solver from LOOKING like a
  // lobotomy: the gate correctly rejects full-pace spin shots that cannot
  // clear the cord from a given contact (pre-gate they "verified" and then
  // netted live), but routing every rejection straight to the 4 m/s
  // zero-spin centre block erased the tiers' placement identity — measured
  // 2026-08-30 at ~15% of all intermediate/pro rally shots, concentrated in
  // exactly the high-spin/high-pace shots that read as intelligence.
  const SOFTEN_LADDER = [
    { speedScale: 0.80, spinScale: 0.6 },
    { speedScale: 0.62, spinScale: 0.3 },
  ];
  // Floor for softened pace: above a drop-shot touch, below the safe block's
  // 4.0 — softening below this reads as a fluffed swing, not a controlled one.
  const SOFTEN_MIN_SPEED = 3.0;

  function* paddleSolveJob(req) {
    let solverResult = yield* solvePaddleSteps(req);
    let usedSafe = false;
    let softened = null;
    if (!solverResult.feasible) {
      for (const rung of SOFTEN_LADDER) {
        const speed = Math.max(SOFTEN_MIN_SPEED, req.targetSpeed * rung.speedScale);
        const spin = req.targetSpin * rung.spinScale;
        const sideSpin = (req.targetSideSpin || 0) * rung.spinScale;
        const r = yield* solvePaddleSteps({
          ...req, targetSpeed: speed, targetSpin: spin, targetSideSpin: sideSpin,
        });
        if (r.feasible) {
          solverResult = r;
          softened = { speed, spin, sideSpin };
          break;
        }
      }
    }
    if (!solverResult.feasible) {
      const safeResult = yield* solvePaddleSteps({
        targetX: 0, targetZ: 0.7,
        targetSpeed: 4.0, targetSpin: 0,
        contactPos: req.contactPos,
        contactVel: req.contactVel,
        contactSpin: req.contactSpin,
        difficulty: req.difficulty, env: req.env,
      });
      if (safeResult.feasible) {
        solverResult = safeResult;
        usedSafe = true;
      }
    }
    return { solverResult, usedSafe, softened };
  }

  // Advance the amortized paddle solve. Runs a few rollouts per frame while
  // there's flight time to spare, and drains the whole job when the contact
  // is close enough that waiting another frame could squeeze the swing.
  function stepPendingSolve() {
    if (!pendingSolve) return;
    const remainingMs = intent.predictedContactPerfMs - performance.now();
    const drainAll = !(remainingMs > SOLVE_DRAIN_BELOW_MS);
    let steps = 0;
    for (;;) {
      const r = pendingSolve.gen.next();
      if (r.done) {
        const job = pendingSolve;
        pendingSolve = null;
        finishTargetReceived(r.value.solverResult, r.value.usedSafe, r.value.softened, job);
        return;
      }
      steps += 1;
      if (!drainAll && steps >= SOLVE_ROLLOUTS_PER_FRAME) return;
    }
  }

  // Everything downstream of the paddle solve: fallback re-pointing,
  // reachability gate, imperfection dice, trajectory plan, MOVING transition.
  function finishTargetReceived(solverResult, usedSafe, softened, { speed, spin }) {
    if (softened && !usedSafe) {
      // Re-point intent at the pace/spin actually being played so the windup
      // sizing (update() reads intent.target[2]) and telegraph match the
      // softened stroke instead of the abandoned full-pace request. Target
      // and shot type stay — it is the same shot, played with control.
      speed = softened.speed;
      spin = softened.spin;
      intent.target = intent.target.slice();
      intent.target[2] = softened.speed;
      intent.target[3] = softened.spin;
      if (intent.target.length > 6) intent.target[6] = softened.sideSpin;
      if (DEBUG_LOG) console.log(`[AI FSM] solver softened to speed=${softened.speed.toFixed(2)} spin=${softened.spin.toFixed(2)} (same target)`);
    }
    if (usedSafe) {
      // Re-point `intent` at the shot we are ACTUALLY playing. Previously
      // only solverResult was swapped, leaving intent.target,
      // intent.targetWorld and intent.shotType describing the abandoned
      // aggressive shot — so the AI telegraphed a smash, sized its windup
      // from the smash's speed (update() reads intent.target[2] for
      // WINDUP_DEPTH_M_BY_POWER), and then played a 4 m/s centre ball. The
      // mismatch reads as the AI flinching mid-stroke.
      intent.target = [0, 0.7, 4.0, 0, 1.0, SHOT_TYPES.BLOCK];
      intent.shotType = SHOT_TYPES.BLOCK;
      intent.displayedShotType = SHOT_TYPES.BLOCK;
      specTargetToWorld(0, 0.7, tableCenterX(), tableCenterZ(), tableSurfaceY, intent.targetWorld);
      if (DEBUG_LOG) console.log('[AI FSM] solver fell back to safe target');
    } else if (!solverResult.feasible && DEBUG_LOG) {
      console.log('[AI FSM] solver infeasible even on safe target — honest miss');
    }
    intent.solverFeasible = solverResult.feasible;
    intent.solverFaceNormal.copy(solverResult.faceNormal);
    intent.solverPaddleVelocity.copy(solverResult.paddleV);
    if (failureHandler) failureHandler.onSolverResult(solverResult.feasible);
    if (DEBUG_LOG && solverResult.feasible) {
      console.log(`[AI FSM] solver: paddleSpeed=${solverResult.paddleSpeed.toFixed(2)} m/s, landingErr=${(solverResult.landingError || 0).toFixed(3)}m`);
    }

    // Reachability gate (spec §section_3).
    const reach = checkReachability({
      currentPos: paddle.faceCenterWorld,
      contactPos: intent.predictedContact,
      timeBudgetMs: intent.predictedContactPerfMs - performance.now(),
      maxApproachSpeed: footworkSpeed(),
    });
    intent.reachability = reach.status;
    if (DEBUG_LOG && reach.status !== REACHABILITY.REACHABLE) {
      console.log(`[AI FSM] reachability=${reach.status} required=${reach.requiredAvgSpeed.toFixed(2)} m/s`);
    }

    // V2 §section_7 mode (3) + (2): bail to RECOVERING when the AI cannot
    // physically reach the contact in time, or when the solver has been
    // infeasible 3× in a row. Both produce a "lunge and miss" — the rally
    // ends naturally via the rallyManager when the ball goes out / double-
    // bounces.
    const unreachable = reach.status === REACHABILITY.UNREACHABLE;
    const giveUp = failureHandler && failureHandler.shouldGiveUpRally();
    if (unreachable || giveUp) {
      if (DEBUG_LOG) console.log(`[AI FSM] honest miss: unreachable=${unreachable} giveUp=${giveUp}`);
      intent.willMiss = true;
      intent.missCause = unreachable ? 'stretched_too_far' : 'general_inaccuracy';
      intent.solverFeasible = false; // ensure no trajectory drive
      intent.trajectory = null;
      // NOTE: honest misses do NOT trigger the "shaken" nerves state.
      // Reaching too far is a physical event, not a psychological one —
      // otherwise a single wrong-footed miss cascades into 2-3 more
      // shanks on the next rallies, which reads as the AI "collapsing"
      // after any hard shot.
      transition(STATES.RECOVERING);
      return;
    }

    // Deliberate-imperfection injection — spec §imperfection_design. Roll
    // the miss-rate dice BEFORE the commitment lock fires so the AI plays
    // out the bad swing without "knowing" it'll miss.
    intent.willMiss = false;
    intent.missCause = null;
    const baseMissRate = MISS_RATE_BY_DIFFICULTY[difficulty] || 0;
    // Nerves — recent miss inflates the odds of another for the next
    // couple of shots (see imperfection.js). Cap at 1.0 so we never
    // guarantee a miss.
    const shakenMult = (shotsSinceMiss < SHAKEN_SHOTS) ? SHAKEN_MULTIPLIER : 1;
    // Loss-streak defense sag — additive boost on top of shaken.
    const streakBoost = (consecutiveLostPoints >= STREAK_LOSS_THRESHOLD) ? STREAK_LOSS_MISS_BOOST : 0;

    // Situational scaling — how hard is THIS shot? reachFactor is the
    // dominant term and the FSM already computed it above; feeding it in is
    // what makes errors track being out of position instead of a coin flip.
    const reachFactor = Number.isFinite(reach.requiredAvgSpeed)
      ? reach.requiredAvgSpeed / Math.max(1e-6, footworkSpeed())
      : undefined;
    const incomingSpinRps = intent.predictedContactBallSpin
      ? intent.predictedContactBallSpin.length() / (2 * Math.PI)
      : undefined;
    const situationalRate = scaleMissRateForSituation(baseMissRate, {
      reachFactor,
      timeToContactMs: intent.predictedContactPerfMs - performance.now(),
      incomingSpinRps,
      // Crossover jam: lateral distance from the interception point to the
      // AI's body line (its ready position). A ball straight at the body is
      // the elbow ball — now as uncomfortable for the AI as its own
      // elbow-seam tactic makes it for the player.
      bodyJamOffsetM: (paddle.readyPose && paddle.readyPose.position)
        ? intent.predictedContact.x - paddle.readyPose.position.x
        : undefined,
    });

    const missRate = Math.min(1, situationalRate * shakenMult + streakBoost);
    if (shouldInjectMiss(missRate)) {
      // Cause selection also reads reachFactor so "stretched too far" is only
      // chosen when the AI genuinely was stretched.
      const cause = sampleMissCause(Math.random, { reachFactor });
      applyMissToIntent(intent, cause);
      shotsSinceMiss = 0;
      if (DEBUG_LOG) console.log(`[AI FSM] miss injected: cause=${cause} rate=${missRate.toFixed(3)}${shakenMult > 1 ? ' (shaken)' : ''}`);
    } else {
      shotsSinceMiss += 1;
    }

    if (DEBUG_LOG) {
      const disguiseNote = (difficulty === 'pro' && intent.displayedShotType !== intent.shotType)
        ? ` (disguised as ${intent.displayedShotType})` : '';
      console.log(`[AI FSM] target received: shotType=${intent.shotType}${disguiseNote} speed=${speed.toFixed(2)} spin=${spin.toFixed(2)}`);
    }

    // V2 §section_2: plan the 8-keyframe interception trajectory now (once
    // per rally). MOVING/COMMITTED/SWINGING just interpolate keyframes;
    // no per-frame trajectory recomputation. Plan only when solver is
    // feasible — without a known terminal velocity the quintic can't be
    // built, so we fall back to the windup-strike heuristic in SWINGING.
    intent.trajectory = null;
    intent.trajectoryPlannedAtMs = 0;
    if (intent.solverFeasible) {
      // While the spin read is still pending, aim the approach at the
      // SPIN-BLIND interception point. planTrajectoryTo re-plans onto the
      // true point once the read completes (see update/MOVING).
      planTrajectoryTo(misreadCorrectionPending
        ? _misreadTarget.copy(intent.predictedContact).add(_misreadOffset)
        : intent.predictedContact);
    }
    if (state === STATES.DECIDING) {
      // Roll wasted-half-step on the transition into MOVING. Time-to-contact
      // is read against the (possibly mistimed) predictedContactPerfMs so
      // a "mistimed_swing" miss can still get a wasted step if there's
      // enough budget — that's a believable compound imperfection.
      const tToContact = intent.predictedContactPerfMs - performance.now();
      if (shouldWasteHalfStep(tToContact)) {
        wastedStepOffsetVec(Math.random, intent.wastedStepOffset);
        intent.wastedStepActive = true;
        intent.wastedStepExpiresPerfMs = performance.now() + WASTED_STEP_DURATION_MS;
        if (DEBUG_LOG) console.log('[AI FSM] wasted half-step activated');
      } else {
        intent.wastedStepActive = false;
        intent.wastedStepOffset.set(0, 0, 0);
      }
      transition(STATES.MOVING);
    }
  }

  function onAIContact() {
    // The AI's paddle just struck the ball. tryPaddleCollision in the host
    // has already applied the impulse; we just advance state.
    // Feed the contact position into readyPosition so the next ready-pose
    // computation biases toward the same side (scramble bias — body
    // momentum carries you, you don't teleport back to center).
    if (paddle && paddle.faceCenterWorld) {
      recordAIContact(paddle.faceCenterWorld.x, paddle.faceCenterWorld.z);
    }
    // Contact already happened — a solve still amortizing is for a swing
    // that's over. (Normally impossible: the drain threshold resolves it
    // well before contact.)
    pendingSolve = null;
    transition(STATES.CONTACT);
    transition(STATES.RECOVERING);
  }

  function onBallLost() {
    intent.hasPrediction = false;
    intent.committed = false;
    // Drop any pending spin-read correction — it belongs to a rally that no
    // longer exists, and leaving it armed would fire against the next one.
    misreadCorrectionPending = false;
    // Same for a solve still amortizing: its rally is gone.
    pendingSolve = null;
    // And the pre-contact anticipation lean with it: the next rally opens
    // from a neutral ready position (receiving a serve with a stale lean
    // from last rally's aim point would be leaning at a ghost).
    intent.targetWorld.set(0, 0, 0);
    transition(STATES.IDLE);
  }

  // Called by aiMatch on rallyManager.onPointScored. Updates the loss/win
  // streak counters that feed the miss-rate defense-sag boost above.
  function onPointResult({ winner } = {}) {
    if (winner === 'ai') {
      consecutiveLostPoints = 0;
    } else if (winner === 'player') {
      consecutiveLostPoints += 1;
    }
  }

  // --- Per-frame update -----------------------------------------------------

  function update(dt) {
    const nowMs = performance.now();
    // Advance any amortized paddle solve first — its completion drives the
    // DECIDING → MOVING transition the state blocks below react to.
    stepPendingSolve();
    // Style-aware base movement speed. paddle.movementMultiplier defaults
    // to 1.0 for allround; choppers get 1.25× (more ground coverage),
    // blockers get 0.90× (they stay close to the edge). Same value the
    // reachability gate and the trajectory's approach phase are held to.
    const baseSpeed = footworkSpeed();

    switch (state) {
      case STATES.IDLE:
      case STATES.PREDICTING:
      case STATES.DECIDING: {
        // Add a small breathing "settle" wobble so the AI isn't statue-
        // still between rallies. Deterministic sinusoid, sub-cm amplitude
        // — doesn't affect gameplay, does read as alive on-screen.
        idleSettleOffset(nowMs, _idleWobbleTmp);
        _idlePoseTmp.copy(paddle.readyPose.position);
        _idlePoseTmp.x += _idleWobbleTmp.x;
        _idlePoseTmp.y += _idleWobbleTmp.y;
        // Pre-contact anticipation: with our own shot away toward
        // intent.targetWorld, drift toward the expected (crosscourt-biased)
        // return corridor BEFORE the player's contact. targetWorld is zeroed
        // by intent.reset() each rally, so this only engages mid-rally when
        // the aim point is real; a down-the-line reply wrong-foots the lean,
        // as it should.
        if (intent.targetWorld.lengthSq() > 1e-6) {
          _idlePoseTmp.x += anticipationLeanX({
            difficulty,
            aiTargetX: intent.targetWorld.x,
            baseX: paddle.readyPose.position.x,
          });
        }
        paddle.driveTowardPose(
          _idlePoseTmp, paddle.readyPose.normal,
          dt, baseSpeed,
        );
        break;
      }

      case STATES.MOVING: {
        if (!intent.hasPrediction) { transition(STATES.IDLE); break; }
        // Wasted half-step expiry tick (applies to both trajectory and
        // fallback paths).
        if (intent.wastedStepActive && nowMs >= intent.wastedStepExpiresPerfMs) {
          intent.wastedStepActive = false;
          intent.wastedStepOffset.set(0, 0, 0);
        }
        // Spin read completed — the AI has now seen the curve and corrects
        // off its initial spin-blind read onto the true interception point.
        // This is the visible "oh, that's spinning" adjustment mid-approach.
        if (misreadCorrectionPending && nowMs >= readCompleteAtPerfMs) {
          misreadCorrectionPending = false;
          if (intent.solverFeasible && intent.trajectory) {
            planTrajectoryTo(intent.predictedContact);
            if (DEBUG_LOG) console.log('[AI FSM] spin read complete — corrected off misread');
          }
        }
        if (intent.trajectory) {
          // V2 §section_2: trajectory-driven paddle motion. Interpolate
          // 8-keyframe plan for position + face. Snap (no rate-limited
          // driveTowardPose) because the trajectory IS the speed plan —
          // the planner already enforced peak ≤ cap × 1.1.
          const elapsed = nowMs - intent.trajectoryPlannedAtMs;
          interpolateTrajectory(intent.trajectory, elapsed, _trajectoryPos, _trajectoryFace);
          paddle.snapToPose(_trajectoryPos, _trajectoryFace);
        } else {
          // Fallback when solver was infeasible — old body-orientation
          // drive + wasted-step offset, rate-limited by base movement speed.
          const faceN = bodyOrientationNormal(_normalTmp);
          const moveTarget = intent.wastedStepActive
            ? _wastedStepTarget.copy(intent.predictedContact).add(intent.wastedStepOffset)
            : intent.predictedContact;
          paddle.driveTowardPose(moveTarget, faceN, dt, baseSpeed);
        }
        // Enter the commitment lock at T-400ms before predicted contact.
        const tMinusContact = intent.predictedContactPerfMs - nowMs;
        if (tMinusContact <= COMMIT_LOCK_BEFORE_CONTACT_MS) {
          intent.committed = true;
          transition(STATES.COMMITTED);
        }
        break;
      }

      case STATES.COMMITTED: {
        if (intent.trajectory) {
          const elapsed = nowMs - intent.trajectoryPlannedAtMs;
          interpolateTrajectory(intent.trajectory, elapsed, _trajectoryPos, _trajectoryFace);
          paddle.snapToPose(_trajectoryPos, _trajectoryFace);
        } else {
          // Fallback: live-ball ±5cm micro-correction tracking + body
          // orientation face.
          const faceN = bodyOrientationNormal(_normalTmp);
          const t = correctedInterceptTarget(_correctedTarget);
          paddle.driveTowardPose(t, faceN, dt, baseSpeed);
        }
        const tMinusContact = intent.predictedContactPerfMs - nowMs;
        if (tMinusContact <= telegraphLeadMs()) {
          transition(STATES.SWINGING);
        }
        break;
      }

      case STATES.SWINGING: {
        // V2 §section_2: trajectory-driven swing when planned. The
        // 8-keyframe plan already produces the correct paddle velocity
        // through the contact point (terminal velocity = solver's
        // computed paddleV by construction of the quintic). Fallback to
        // the old windup-strike heuristic only when solver was
        // infeasible — then we don't know what speed to aim for, so the
        // cap-speed strike is our best approximation.
        if (intent.trajectory) {
          const elapsedSinceTrajectory = nowMs - intent.trajectoryPlannedAtMs;
          interpolateTrajectory(intent.trajectory, elapsedSinceTrajectory, _trajectoryPos, _trajectoryFace);
          paddle.snapToPose(_trajectoryPos, _trajectoryFace);
          // Safety net: bail back to RECOVERING if contact never fires
          // (ball passed outside hit radius, etc.). The trajectory ends at
          // predictedContactPerfMs; +80ms grace before bailing.
          if (nowMs > intent.predictedContactPerfMs + 80) {
            if (DEBUG_LOG) console.log('[AI FSM] trajectory swing timed out without contact');
            transition(STATES.RECOVERING);
          }
          break;
        }
        // ---- Fallback: pre-Phase-2 windup-strike heuristic ----
        const elapsed = nowMs - stateEnteredAtMs;
        const totalSwingMs = telegraphLeadMs();

        // V2: paddle MUST arrive at contact with approximately the
        // solver's computed velocity vector (magnitude AND direction).
        // The strike-phase speed cap = |solverPaddleVelocity|; the swing
        // direction = solverPaddleVelocity.normalize(). When solver was
        // infeasible, fall back to the heuristic cap and XZ-toward-target
        // direction (older Phase 1 behavior).
        let speedCap;
        let swingDir;
        if (intent.solverFeasible) {
          const solverV = intent.solverPaddleVelocity;
          const solverSpeed = solverV.length();
          if (solverSpeed > 1e-6) {
            speedCap = solverSpeed;
            swingDir = _swingDirTmp.copy(solverV).multiplyScalar(1 / solverSpeed);
          } else {
            speedCap = baseSpeed * SWING_SPEED_MULTIPLIER;
            swingDir = bodyOrientationNormal(_swingDirTmp);
          }
        } else {
          speedCap = baseSpeed * SWING_SPEED_MULTIPLIER;
          swingDir = bodyOrientationNormal(_swingDirTmp);
        }

        // Windup pull-back distance from the spec lookup table — bigger
        // power tier = deeper windup. Default to medium when target speed
        // is unavailable (defensive; shouldn't happen post-onTargetReceived).
        const targetSpeed = (intent.target && intent.target[2]) || 5.0;
        const windupDepth = WINDUP_DEPTH_M_BY_POWER[powerTierForSpeed(targetSpeed)]
          || WINDUP_DEPTH_M_BY_POWER.medium;
        const followThroughDepth = 0.20;

        // Strike phase = time for paddle to traverse windupDepth at cap
        // speed. Timed so paddle arrives AT interception AT T=0 (end of
        // SWINGING). Clamped to a 30ms minimum so the strike is visible.
        const strikeDurationMs = Math.max(30, (windupDepth / speedCap) * 1000);
        const strikeStartMs = Math.max(0, totalSwingMs - strikeDurationMs);

        // V2 §section_1.telegraph_integration: solver output IS the face
        // normal source of truth (replaces telegraph's FACE_Y_BY_SHOT_TYPE
        // lookup for rally shots). The legacy telegraphFaceNormal lookup
        // stays as a fallback for when the solver was infeasible — in
        // that case the AI still produces a swing visually, but the
        // result is an honest miss because paddle speed/angle no longer
        // match what the host's physics needs.
        //
        // V2 spec also drops the Pro rally-shot disguise. Disguise applies
        // ONLY to serves (Phase 4). _readyNormal is used during early
        // SWINGING for the body-orientation prep, then we lerp to the
        // solver normal as we approach contact — spec §section_2 will
        // formalise this as a slerp across the swing, but Phase 1 uses a
        // simple binary switch at the strike boundary.
        const faceN = intent.solverFeasible
          ? (elapsed < strikeStartMs
              ? bodyOrientationNormal(_normalTmp)         // neutral during windup
              : _normalTmp.copy(intent.solverFaceNormal))  // solver normal during strike
          : telegraphFaceNormal(_normalTmp, elapsed);
        const correctedInterception = correctedInterceptTarget(_correctedTarget);

        let swingTarget;
        if (elapsed < strikeStartMs) {
          // Windup: retreat to (interception - swingDir * windupDepth).
          // Clamped above the felt for the same reason as the planned path:
          // an upward swingDir puts this anchor under the table.
          swingTarget = _swingPosTmp.copy(correctedInterception)
                                    .addScaledVector(swingDir, -windupDepth);
          clampPlannedPosAboveTable(swingTarget, tableBox, tableSurfaceY);
        } else {
          // Strike: drive PAST interception to (interception + swingDir *
          // followThrough). Paddle reaches interception when it has
          // traveled windupDepth (i.e., elapsed == strikeStartMs +
          // windupDepth/speedCap ≈ totalSwingMs == T=0), still moving at
          // cap speed toward followThrough — exactly the relative velocity
          // the host's collision math needs to impart a meaningful impulse.
          swingTarget = _swingPosTmp.copy(correctedInterception)
                                    .addScaledVector(swingDir, followThroughDepth);
        }

        paddle.driveTowardPose(swingTarget, faceN, dt, speedCap);

        // Safety net: if the contact event never fired (ball passed outside
        // hit radius, etc.), bail back to RECOVERING so the FSM doesn't get
        // stuck swinging forever.
        if (elapsed > totalSwingMs + 80) {
          if (DEBUG_LOG) console.log('[AI FSM] swing timed out without contact');
          transition(STATES.RECOVERING);
        }
        break;
      }

      case STATES.CONTACT: {
        // Single-frame state — onAIContact() immediately follows the impulse
        // application by transitioning to RECOVERING. If we land here on a
        // frame update without a transition having happened, advance.
        transition(STATES.RECOVERING);
        break;
      }

      case STATES.RECOVERING: {
        // Vulnerability window — paddle moves at 40% speed back to ready
        // pose. A quick player return during this window forces a scramble
        // or miss. Spec §recovery_design.vulnerability_window.
        paddle.driveTowardPose(
          paddle.readyPose.position, paddle.readyPose.normal,
          dt, baseSpeed * VULNERABILITY_SPEED_MULTIPLIER,
        );
        const elapsed = nowMs - stateEnteredAtMs;
        const duration = RECOVERY_MS[difficulty] || RECOVERY_MS.beginner;
        if (elapsed >= duration) {
          intent.hasPrediction = false;
          intent.committed = false;
          intent.shotType = null;
          // V2 §section_4: refresh ready pose on RECOVERING → IDLE — this
          // is the "between rallies, not during" point where Pro's
          // anticipatory bias can shift the neutral pose toward the
          // player's recent landing centroid.
          if (paddle.refreshReadyPose) paddle.refreshReadyPose();
          transition(STATES.IDLE);
        }
        break;
      }
    }

    paddle.refreshVelocity(dt);
  }

  function getState() { return state; }
  function getDifficulty() { return difficulty; }

  return {
    update,
    onPlayerHit,
    onTargetReceived,
    onAIContact,
    onBallLost,
    onPointResult,
    getState,
    getDifficulty,
  };
}
