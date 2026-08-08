// Main-thread bridge between the existing ball-event listeners and the AI
// worker. Translates the host's paddleHit/tableBounce/ballLost stream into
// the 8-field shot schema the worker consumes, and runs a non-mutating
// physics rollout to compute landing_x / landing_z (the existing listeners
// only fire AT contact, not at the subsequent bounce, so the AI would have
// no way to learn target zones without this rollout).
//
// Spec §shot_adapter_design. Wire payload order:
//   [shot_id, timestamp_ms, landing_x, landing_z, success,
//    swing_lateness_ms, ball_speed_at_contact_mps, ball_spin_rps]
//
// Also exports rolloutForAIInterception used by the FSM to find both the
// AI-side bounce point AND the interception point ~CONTACT_DELAY_MS_DEFAULT
// after the bounce. Sharing the rollout helper avoids running the same
// integration twice per player hit.
//
// Threading: this module is main-thread. It reads ballModel.position /
// ballVelocity / ballAngularVelocity (live exports from physics/ball.js)
// during sampleEachFrame() and during rollout. The rollout uses LOCAL
// Vector3 copies — it must NEVER mutate the live ball state.

import * as THREE from 'three';
import { ballModel, ballRadius, tableBox, tableSurfaceY } from '../scene/models.js';
import { ballVelocity, ballAngularVelocity } from '../physics/ball.js';
import { FLOOR_Y } from '../physics/constants.js';
import {
  integrateFlightStep, applyTableBounce, isTableBounce, DT_PRESETS,
} from '../physics/rollout.js';

// Step size and ceiling for the rollout. 200Hz integration, slightly finer
// than the real physics tick (which runs at frame rate). 600 steps = 3s —
// long enough to catch any plausible bounce, short enough that p99 rollout
// time stays well under 3ms on Quest 3 (spec budget is "~3ms").
const ROLLOUT_DT_S = DT_PRESETS.INTERCEPT;
const ROLLOUT_MAX_STEPS = 600;

// Delay from AI-side bounce to AI interception, in ms. Roughly the time the
// ball spends rising between bounce and apex on a typical return — gives the
// paddle a meet point above the table where contact physics works cleanly.
// Phase 3 will derive this per-shot from target speed; Phase 1 uses a fixed
// value to keep the FSM simple.
export const CONTACT_DELAY_MS_DEFAULT = 200;

export const AI_PADDLE_ID = 'ai-opponent';

// Immutable zero-spin vector for the spin-blind rollout. rolloutForAIInterception
// copies its inputs, so sharing one instance is safe.
const _zeroSpin = new THREE.Vector3(0, 0, 0);

// Env handed to the shared rollout predicates. Rebuilt per call rather than
// cached at module scope because models.js populates ballRadius / tableBox /
// tableSurfaceY asynchronously after GLB load — a module-scope snapshot would
// capture undefined.
function rolloutEnv() {
  return { ballRadius, tableSurfaceY, tableBox };
}

// Pure forward rollout. Steps the ball until either:
//   - First table-surface bounce on AI side (z < tableCenterZ) — captures
//     {bouncePoint, bounceTimeMs}, applies bounce response, continues another
//     contactDelayMs to capture {contactPoint, contactTimeMs}, then returns.
//   - First table-surface bounce on PLAYER side — applies bounce response
//     and keeps going (the player-side bounce isn't the landing we want;
//     a curving shot might cross back to AI side eventually).
//   - Floor (y < FLOOR_Y) — returns null (ball off-table, no landing).
//   - ROLLOUT_MAX_STEPS exhausted — returns null.
//
// Returns null if no AI-side bounce occurred inside the rollout horizon.
export function rolloutForAIInterception(
  startPos, startVel, startSpin,
  contactDelayMs = CONTACT_DELAY_MS_DEFAULT,
) {
  if (!tableBox) return null;
  const tableCenterZ = (tableBox.min.z + tableBox.max.z) / 2;

  const pos  = new THREE.Vector3().copy(startPos);
  const vel  = new THREE.Vector3().copy(startVel);
  const spin = new THREE.Vector3().copy(startSpin);
  const env  = rolloutEnv();

  let bouncePoint = null;
  let bounceTimeMs = 0;
  const contactDelaySteps = Math.max(1, Math.round(contactDelayMs / (ROLLOUT_DT_S * 1000)));

  for (let i = 0; i < ROLLOUT_MAX_STEPS; i++) {
    integrateFlightStep(pos, vel, spin, ROLLOUT_DT_S);

    if (!bouncePoint && isTableBounce(pos, vel, env)) {
      const onAISide = pos.z < tableCenterZ;
      if (onAISide) {
        // Record the bounce point and continue forward to the contact point.
        bouncePoint = { x: pos.x, y: pos.y, z: pos.z };
        bounceTimeMs = i * ROLLOUT_DT_S * 1000;
        pos.y = tableSurfaceY + ballRadius;
        applyTableBounce(vel, spin, ballRadius);
        // Continue stepping for contactDelaySteps to reach the contact point.
        const contactEndStep = i + contactDelaySteps;
        for (let j = i + 1; j <= contactEndStep && j < ROLLOUT_MAX_STEPS; j++) {
          integrateFlightStep(pos, vel, spin, ROLLOUT_DT_S);
          if (pos.y < FLOOR_Y) return null;
        }
        return {
          bouncePoint,
          bounceTimeMs,
          contactPoint: { x: pos.x, y: pos.y, z: pos.z },
          contactTimeMs: bounceTimeMs + contactDelayMs,
          // Ball state at the contact moment — solver needs incoming
          // velocity and spin to compute the impulse that produces the
          // engine's requested outgoing speed/spin.
          contactVelocity: { x: vel.x, y: vel.y, z: vel.z },
          contactSpin:     { x: spin.x, y: spin.y, z: spin.z },
        };
      } else {
        // Bounced on player side first — apply bounce, keep rolling.
        pos.y = tableSurfaceY + ballRadius;
        applyTableBounce(vel, spin, ballRadius);
      }
    }

    if (pos.y < FLOOR_Y) return null;
  }
  return null;
}

// Thin wrapper exposed for tests + alternative callers that only want the
// bounce point (e.g., a future Voronoi tile lookup that runs independently
// of the FSM).
export function rolloutToBounceOnAISide(startPos, startVel, startSpin) {
  const r = rolloutForAIInterception(startPos, startVel, startSpin, 0);
  return r ? { x: r.bouncePoint.x, z: r.bouncePoint.z, t_ms: r.bounceTimeMs } : null;
}

// --- Adapter ----------------------------------------------------------------

// Subscribes to ballEvents and posts shot messages to the AI worker. Returns
// {sampleEachFrame, getLastRollout, dispose}. The caller MUST call
// sampleEachFrame() every frame so net-crossing timestamps are recorded for
// swing_lateness_ms.
//
// What a history record MEANS — this is the whole point of the learning
// system, and it used to describe the wrong thing:
//
//   One record = one AI shot placement + how the player coped with it.
//     landing_x/landing_z  where the AI's shot actually bounced on the
//                          PLAYER's half (spec coords)
//     swing_lateness_ms    how late the player swung at that ball
//     success              1 = player made contact, 0 = they never did
//
// The engines' struggle heatmap then reads "the player is late / misses when
// the ball lands here" and aims there. Previously this recorded where the
// PLAYER's shot landed on the AI's half, and intermediate.js used those same
// coordinates as a target on the PLAYER's half — two unrelated facts, so
// every exploit-path shot was aimed at noise.
//
// We use the ACTUAL bounce (from the tableBounce event) rather than the AI's
// intended target: the AI misses its target regularly, and what matters is
// where the ball really landed, because that is what the player had to deal
// with.
//
// Records are posted at bounce time with a success=0 placeholder, then
// re-posted under the same shot_id once the outcome is known.
// ShotHistory.push handles the in-place update.
//
// A player serve produces no record — there is no preceding AI shot to
// attribute the outcome to.
//
// getLastRollout() returns the rolloutForAIInterception result from the most
// recent player hit, so the FSM can read the predicted interception point
// without running its own rollout.
export function createShotAdapter({ worker, ballEvents }) {
  if (!worker) throw new Error('shotAdapter: worker is required');
  if (!ballEvents) throw new Error('shotAdapter: ballEvents is required');

  let shotIdCounter = 0;
  let lastNetCrossingMs = null;
  let pending = null;
  let lastRollout = null;
  let lastRolloutSpinBlind = null;
  // True between an AI contact and the ball's next player-side bounce — the
  // window in which a bounce IS that AI shot's landing. Guards against
  // crediting a double bounce, or an AI-side net clip, as the landing.
  let awaitingAILanding = false;

  let prevSampleZ = null;
  let prevSampleT = null;

  function tableCenterZ() {
    return tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0;
  }

  function sampleEachFrame() {
    if (!ballModel || !ballModel.visible || !tableBox) {
      prevSampleZ = null;
      prevSampleT = null;
      return;
    }
    const z = ballModel.position.z;
    const tMs = performance.now();
    const centerZ = tableCenterZ();
    if (prevSampleZ !== null) {
      const prevSide = Math.sign(prevSampleZ - centerZ);
      const currSide = Math.sign(z - centerZ);
      if (prevSide !== 0 && currSide !== 0 && prevSide !== currSide) {
        const dt = tMs - prevSampleT;
        const u = (centerZ - prevSampleZ) / (z - prevSampleZ);
        lastNetCrossingMs = prevSampleT + u * dt;
      }
    }
    prevSampleZ = z;
    prevSampleT = tMs;
  }

  // The FSM reads getLastRollout() to find its interception point. This must
  // keep running on every player hit regardless of whether a history record
  // is open.
  //
  // We also run a SPIN-BLIND rollout — the same integration with the spin term
  // zeroed. That is what the ball would do if you misread the spin entirely,
  // and it is the AI's initial read: for the first ~120ms after the player's
  // contact the AI moves toward the spin-blind interception point, then
  // corrects once it has "seen" the curve. Without this the AI is a perfect
  // instrument — it gets an exact, instantaneous solution to the incoming
  // ball and heavy spin costs it nothing, which no real player experiences.
  function runInterceptionRollout() {
    if (!ballModel) return;
    lastRollout = rolloutForAIInterception(
      ballModel.position, ballVelocity, ballAngularVelocity,
    );
    lastRolloutSpinBlind = rolloutForAIInterception(
      ballModel.position, ballVelocity, _zeroSpin,
    );
  }

  // The AI's shot has landed on the player's half. Open a record for it and
  // post it immediately with placeholders; the outcome back-fills below once
  // the player either returns it or doesn't.
  //
  // World bounce coords → spec "table-local" coords: signed lateral x,
  // non-negative "meters from net" z.
  function openRecordForAILanding(bounce) {
    const centerZ = tableCenterZ();
    shotIdCounter += 1;
    pending = [
      shotIdCounter,
      performance.now(),
      bounce.x,
      Math.abs(bounce.z - centerZ),
      0,   // success                   — back-filled
      0,   // swing_lateness_ms         — back-filled on player contact
      0,   // ball_speed_at_contact_mps — back-filled on player contact
      0,   // ball_spin_rps             — back-filled on player contact
    ];
    // Post a snapshot, not the live array: `pending` is mutated in place by
    // the resolvers below, and a same-realm transport (tests, any future
    // synchronous shim) would otherwise see the record change under it.
    worker.postMessage({ type: 'shot', payload: pending.slice() });
  }

  // Player reached the AI's shot: back-fill how late they were and the ball
  // state they had to read, then mark it returned.
  function resolvePendingWithPlayerContact() {
    if (!pending) return;
    pending[4] = 1;
    pending[5] = (lastNetCrossingMs !== null)
      ? (performance.now() - lastNetCrossingMs)
      : 0;
    pending[6] = ballVelocity.length();
    pending[7] = ballAngularVelocity.length() / (2 * Math.PI);
    worker.postMessage({ type: 'shot', payload: pending.slice() });
    pending = null;
  }

  // Player never got to it — leave lateness at 0 and record the miss. This is
  // the strongest signal the struggle score has (misses weigh 3).
  function resolvePendingAsMiss() {
    if (!pending) return;
    pending[4] = 0;
    worker.postMessage({ type: 'shot', payload: pending.slice() });
    pending = null;
  }

  function onTableBounce(info) {
    if (!info || !tableBox) return;
    if (!awaitingAILanding) return;
    // Player half only. AI side is z < centerZ (same convention the rollout
    // uses); an AI-side bounce means a net clip or a serve bouncing on the
    // server's own half, neither of which is the landing we're waiting for.
    if (info.z < tableCenterZ()) return;
    awaitingAILanding = false;
    openRecordForAILanding(info);
  }

  function onPaddleHit(info) {
    if (!info) return;
    if (info.origin === 'player') {
      resolvePendingWithPlayerContact();
      runInterceptionRollout();
    } else if (info.origin === AI_PADDLE_ID) {
      // Any record still open was never resolved by a player contact. Drop it
      // rather than mislabel it.
      pending = null;
      awaitingAILanding = true;
      // Measure the player's lateness from THIS ball's net crossing.
      lastNetCrossingMs = null;
    }
  }

  function onBallLost() {
    resolvePendingAsMiss();
    awaitingAILanding = false;
    prevSampleZ = null;
    prevSampleT = null;
  }

  ballEvents.onPaddleHit(onPaddleHit);
  ballEvents.onTableBounce(onTableBounce);
  ballEvents.onBallLost(onBallLost);

  function dispose() {
    pending = null;
    lastRollout = null;
    prevSampleZ = null;
    prevSampleT = null;
    lastNetCrossingMs = null;
    awaitingAILanding = false;
    lastRolloutSpinBlind = null;
    if (ballEvents.offPaddleHit)   ballEvents.offPaddleHit(onPaddleHit);
    if (ballEvents.offTableBounce) ballEvents.offTableBounce(onTableBounce);
    if (ballEvents.offBallLost)    ballEvents.offBallLost(onBallLost);
  }

  function getLastRollout() { return lastRollout; }
  // The AI's INITIAL read of the incoming ball, before it has registered the
  // spin. Null when the spin-blind integration finds no AI-side bounce.
  function getLastRolloutSpinBlind() { return lastRolloutSpinBlind; }

  return { sampleEachFrame, getLastRollout, getLastRolloutSpinBlind, dispose };
}
