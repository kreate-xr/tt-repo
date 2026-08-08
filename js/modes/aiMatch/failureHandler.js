// Failure-mode handling. V2 spec §section_7.
//
// Five failure modes the spec calls out:
//   1. ai_worker_timeout   — worker doesn't respond within 50ms
//   2. solver_infeasibility_repeat — solver returns infeasible 3x in a row
//   3. ball_unreachable_in_time — reachability gate says unreachable
//   4. xr_session_lost     — XR session ends mid-rally
//   5. ball_state_corruption — ball position/velocity contains NaN/Infinity
//
// This module handles (1), (2), and (5). Modes (3) and (4) are owned by
// other components:
//   - (3) lives in aiFSM, which on intent.reachability === 'unreachable'
//         bails to RECOVERING (lunge-and-miss). failureHandler doesn't
//         re-implement reachability; it just exposes a flag the FSM can
//         check.
//   - (4) is handled by the host's existing teardown path. aiMatch.dispose
//         is called by inGame.js when the XR session ends; that disposes
//         worker, rallyManager, server, etc. failureHandler.dispose
//         strengthens that chain by terminating the worker safely even
//         if it's mid-message.
//
// Spec principles: always degrade gracefully, never crash, log with
// enough context to debug, prefer "AI loses point" over "game freezes".

import * as THREE from 'three';
import { spawnBallAt, ballVelocity, ballAngularVelocity } from '../../physics/ball.js';
import { ballModel, tableBox, tableSurfaceY } from '../../scene/models.js';

// Spec §section_7.failure_modes.ai_worker_timeout.detection.
export const TARGET_REQUEST_TIMEOUT_MS = 50;
// Spec §section_7.failure_modes.solver_infeasibility_repeat.definition.
export const SOLVER_INFEASIBLE_REPEAT_LIMIT = 3;
// Spec §section_7.failure_modes.ball_state_corruption.detection — ball
// physics "impossible velocity (e.g., > 100 m/s)".
export const BALL_SPEED_SANITY_LIMIT_MPS = 100;

// Safe fallback target [target_x, target_z, speed, spin, confidence] —
// spec calls for "Beginner-mode safe shot (center, medium speed, low spin)".
const SAFE_FALLBACK_TARGET = [0.0, 0.7, 4.0, 0.0, 0.5];

export function createFailureHandler({ worker = null, log = null } = {}) {
  const logFn = log || ((msg) => console.warn('[failureHandler]', msg));

  // --- Worker target-request timeout state -------------------------------
  let pendingTimer = null;
  let pendingCallback = null;
  let lastKnownGoodTarget = null;

  // Request a target through the worker with a timeout safety net. If the
  // worker doesn't respond within TARGET_REQUEST_TIMEOUT_MS, we fire the
  // callback with the last-known-good target (or the safe fallback). The
  // real response (if it eventually arrives) is dropped by onTargetResponse
  // because the timer's already cleared.
  function requestTarget(postFn, callback) {
    if (typeof postFn !== 'function' || typeof callback !== 'function') {
      throw new Error('failureHandler.requestTarget needs postFn + callback');
    }
    // Clear any in-flight request — only one round-trip outstanding.
    cancelPendingRequest();
    pendingCallback = callback;
    postFn();
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const fallback = lastKnownGoodTarget
        ? lastKnownGoodTarget.slice()
        : SAFE_FALLBACK_TARGET.slice();
      logFn(`worker timeout ${TARGET_REQUEST_TIMEOUT_MS}ms — using ${lastKnownGoodTarget ? 'last-known-good' : 'safe fallback'} target`);
      const cb = pendingCallback;
      pendingCallback = null;
      if (cb) cb(fallback);
    }, TARGET_REQUEST_TIMEOUT_MS);
  }

  // Called when the worker responds. Cancels the timeout, stores the
  // target as last-known-good, and (if the response arrived in time)
  // delivers it to the original callback. Returns true if delivered,
  // false if the timeout already fired (the response is then dropped).
  function onTargetResponse(target) {
    if (Array.isArray(target) && target.length >= 5) {
      lastKnownGoodTarget = target.slice();
    }
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      const cb = pendingCallback;
      pendingCallback = null;
      if (cb && target) cb(target);
      return true;
    }
    return false;
  }

  function cancelPendingRequest() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingCallback = null;
  }

  // --- Solver infeasibility counter --------------------------------------
  let solverInfeasibleCount = 0;

  // Call after every solver run with the feasible boolean.
  function onSolverResult(feasible) {
    if (feasible) {
      solverInfeasibleCount = 0;
    } else {
      solverInfeasibleCount += 1;
      if (solverInfeasibleCount === SOLVER_INFEASIBLE_REPEAT_LIMIT) {
        logFn(`solver infeasible ${SOLVER_INFEASIBLE_REPEAT_LIMIT}× in a row — committing to honest miss`);
      }
    }
  }

  function shouldGiveUpRally() {
    return solverInfeasibleCount >= SOLVER_INFEASIBLE_REPEAT_LIMIT;
  }

  function resetSolverCount() { solverInfeasibleCount = 0; }
  function getSolverInfeasibleCount() { return solverInfeasibleCount; }

  // --- Ball state corruption check ---------------------------------------
  // Returns true when ball state is valid. Returns false (after auto-reset)
  // when corruption was detected and the ball was respawned at a safe
  // serve position. Callers can use the return value to gate downstream
  // logic that depends on ball state for the current frame.
  // Cooldown so a persistent corruption doesn't trigger a reset every
  // frame. Initialized to -Infinity so the FIRST reset goes through
  // immediately regardless of when in process lifetime the corruption is
  // first detected.
  let lastResetAtMs = -Infinity;
  const RESET_COOLDOWN_MS = 1000;

  function validateBallState() {
    if (!ballModel || !ballModel.visible) return true;

    const p = ballModel.position;
    const v = ballVelocity;
    const w = ballAngularVelocity;

    const positionBad = !isFiniteVec(p);
    const velocityBad = !isFiniteVec(v) || v.lengthSq() > BALL_SPEED_SANITY_LIMIT_MPS * BALL_SPEED_SANITY_LIMIT_MPS;
    const spinBad = !isFiniteVec(w);

    if (positionBad || velocityBad || spinBad) {
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      if (now - lastResetAtMs < RESET_COOLDOWN_MS) {
        // Avoid storm-resetting if corruption persists frame-after-frame.
        return false;
      }
      lastResetAtMs = now;
      logFn(`ball state corruption (posBad=${positionBad} velBad=${velocityBad} spinBad=${spinBad}) — resetting`);
      resetBallToSafePosition();
      return false;
    }
    return true;
  }

  function resetBallToSafePosition() {
    if (!tableBox || !ballModel) return;
    const x = (tableBox.min.x + tableBox.max.x) / 2;
    const y = (tableSurfaceY || 0) + 0.30;
    const z = tableBox.min.z + 0.05;
    spawnBallAt(
      new THREE.Vector3(x, y, z),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0),
    );
  }

  // --- Dispose ------------------------------------------------------------
  function dispose() {
    cancelPendingRequest();
    if (worker) {
      try { worker.terminate(); }
      catch (e) { logFn('worker terminate error: ' + (e && e.message || e)); }
    }
  }

  return {
    // Worker round-trip
    requestTarget,
    onTargetResponse,
    cancelPendingRequest,
    getLastKnownGoodTarget: () => lastKnownGoodTarget ? lastKnownGoodTarget.slice() : null,

    // Solver loop
    onSolverResult,
    shouldGiveUpRally,
    resetSolverCount,
    getSolverInfeasibleCount,

    // Ball state
    validateBallState,
    resetBallToSafePosition,

    // Lifecycle
    dispose,
  };
}

function isFiniteVec(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
