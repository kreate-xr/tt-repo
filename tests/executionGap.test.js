// Execution gap — a permanent regression guard on the step between "the
// solver decided what the paddle must do" and "the paddle did it".
//
// WHY THIS EXISTS
//
// Every other AI test stops at solvePaddle: it verifies that the solved
// paddle velocity and face normal, run through the real impulse model, put
// the ball where the engine asked. None of them asked whether the FSM
// actually DELIVERS that paddle velocity at contact.
//
// It didn't. planTrajectory builds a hermite quintic whose terminal
// derivative is the solver's paddle velocity, but the FSM drives the paddle
// by LINEARLY interpolating between keyframes and AIPaddle.refreshVelocity
// hands the physics a per-frame finite difference of that. With 8 uniform
// keyframes the last segment spanned quintic u in [0.643, 1], so the physics
// saw the chord average of an accelerating curve: 0.884x the solved speed on
// every single shot, never more. That cost ~4 cm of net clearance and put
// 7.4% of intermediate returns into the net (20-30% on short placed targets)
// while the solver reported 0% — invisible to every existing test.
//
// The symptom was "the AI's returns keep hitting the net and rallies die",
// which no assertion elsewhere would catch, because both halves were
// individually correct. This file measures the seam between them.

const THREE = require('three');

jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    tableBox: new T.Box3(
      new T.Vector3(-0.7625, -0.001, -1.37),
      new T.Vector3(0.7625, 0.001, 1.37),
    ),
    tableSurfaceY: 0,
    ballRadius: 0.02,
    ballModel: null,
  };
});
jest.mock('../js/physics/ball.js', () => {
  const T = require('three');
  return { ballVelocity: new T.Vector3(), ballAngularVelocity: new T.Vector3() };
});

import { rolloutForAIInterception } from '../js/ai/shotAdapter.js';
import { solvePaddle, MAX_PADDLE_SPEED_MPS } from '../js/ai/paddleSolver.js';
import { planTrajectory, interpolateTrajectory } from '../js/modes/aiMatch/interception.js';
import { telegraphLeadMsForSpeed } from '../js/modes/aiMatch/telegraph.js';
import { computeImpulse } from '../js/physics/impulse.js';
import {
  PADDLE_RESTITUTION, SPIN_CAPTURE_GAIN, paddleRestitution,
} from '../js/physics/constants.js';
import { rolloutToFirstBounce } from '../js/physics/rollout.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

// Regulation net over a regulation table, inflated by the ball radius the
// same way models.js builds the live collider.
const NET_CORD_Y = 0.1525;
const BALL_R = 0.02;

function makeEnv() {
  return {
    tableSurfaceY: 0,
    tableCenterX: 0,
    tableCenterZ: 0,
    ballRadius: BALL_R,
    tableBox: new THREE.Box3(v(-0.7625, -0.001, -1.37), v(0.7625, 0.001, 1.37)),
    netBox: new THREE.Box3(
      v(-0.915, -BALL_R, -0.005 - BALL_R),
      v(0.915, NET_CORD_Y + BALL_R, 0.005 + BALL_R),
    ),
  };
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same generator as solverEnvelope.test.js: plausible player shots run
// through the REAL interception rollout, so the contact geometry is the one
// the game actually produces.
function realisticContacts(n, rng) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 30) {
    const r = rolloutForAIInterception(
      v((rng() - 0.5) * 1.0, 0.25 + rng() * 0.35, 0.6 + rng() * 0.6),
      v((rng() - 0.5) * 1.5, 0.3 + rng() * 1.6, -(4 + rng() * 6)),
      v((rng() - 0.5) * 120, 0, 0),
    );
    if (r) out.push(r);
  }
  return out;
}

const CONTACTS = realisticContacts(120, mulberry32(11));

// The flight the live physics would produce from a paddle pose and velocity.
function flightAfterContact(contactPos, contactVel, contactSpin, paddleV, faceNormal, env) {
  const impulse = computeImpulse(
    contactVel, contactSpin, contactPos,
    paddleV, null, null,
    faceNormal, env.ballRadius,
    PADDLE_RESTITUTION, SPIN_CAPTURE_GAIN,
    { restitutionCurve: paddleRestitution },
  );
  return rolloutToFirstBounce(contactPos, impulse.ballV_out, impulse.ballW_out, env);
}

// Replay the trajectory exactly as aiFSM + AIPaddle do: snapToPose to the
// keyframe interpolation each frame, then read velocity as the per-frame
// finite difference (AIPaddle.refreshVelocity). `framesEarly` shifts the
// contact frame off the nominal contact instant, since the live hit fires on
// whichever frame the ball first overlaps the blade.
const FRAME_MS = 1000 / 72;
function deliveredPose(keyframes, contactMs, framesEarly) {
  const tHit = contactMs - framesEarly * FRAME_MS;
  const pos = new THREE.Vector3(); const face = new THREE.Vector3();
  const prev = new THREE.Vector3(); const prevFace = new THREE.Vector3();
  interpolateTrajectory(keyframes, tHit, pos, face);
  interpolateTrajectory(keyframes, tHit - FRAME_MS, prev, prevFace);
  return {
    pos,
    face: face.normalize(),
    vel: pos.clone().sub(prev).multiplyScalar(1000 / FRAME_MS),
  };
}

// One measurement pass over the realistic contacts x a grid of targets.
function measure({ difficulty, framesEarly, targets }) {
  let n = 0;
  let speedRatioSum = 0;
  let faceErrSum = 0;
  let plannedClearanceSum = 0;
  let executedClearanceSum = 0;
  let executedNetHits = 0;
  let plannedNetHits = 0;

  for (const c of CONTACTS) {
    for (const t of targets) {
      const env = makeEnv();
      const contactPos = v(c.contactPoint.x, c.contactPoint.y, c.contactPoint.z);
      const contactVel = v(c.contactVelocity.x, c.contactVelocity.y, c.contactVelocity.z);
      const contactSpin = v(c.contactSpin.x, c.contactSpin.y, c.contactSpin.z);

      const solved = solvePaddle({
        targetX: 0, targetZ: t.z, targetSpeed: t.speed, targetSpin: t.spin,
        contactPos, contactVel, contactSpin, difficulty, env,
      });
      if (!solved.feasible) continue;

      const planned = flightAfterContact(
        contactPos, contactVel, contactSpin, solved.paddleV, solved.faceNormal, env);
      if (!planned || planned.netClearance === null) continue;

      // A ready pose behind the contact on the AI's side, and the neutral
      // (body-orientation) face the FSM starts the reveal from.
      const neutral = v(0, 0, t.z).sub(contactPos);
      neutral.y = 0;
      neutral.normalize();
      const timeBudgetMs = 380;
      const plan = planTrajectory({
        currentPos: v(contactPos.x * 0.5, 0.30, contactPos.z - 0.45),
        currentFaceNormal: neutral.clone(),
        contactPos,
        contactFaceNormal: solved.faceNormal,
        contactPaddleVelocity: solved.paddleV,
        timeBudgetMs,
        maxPaddleSpeed: MAX_PADDLE_SPEED_MPS[difficulty],
        maxApproachSpeed: 3.2,
        neutralFaceNormal: neutral.clone(),
        telegraphLeadMs: telegraphLeadMsForSpeed(t.speed),
        tableBox: env.tableBox,
        tableSurfaceY: 0,
      });

      const delivered = deliveredPose(plan.keyframes, timeBudgetMs, framesEarly);
      const executed = flightAfterContact(
        contactPos, contactVel, contactSpin, delivered.vel, delivered.face, env);

      n += 1;
      speedRatioSum += delivered.vel.length() / Math.max(1e-6, solved.paddleV.length());
      faceErrSum += Math.acos(
        Math.min(1, Math.max(-1, delivered.face.dot(solved.faceNormal))));
      plannedClearanceSum += planned.netClearance;
      if (planned.netClearance < 0) plannedNetHits += 1;
      if (!executed || executed.netClearance === null || executed.netClearance < 0) {
        executedNetHits += 1;
      } else {
        executedClearanceSum += executed.netClearance;
      }
    }
  }

  return {
    n,
    speedRatio: speedRatioSum / n,
    faceErrorRad: faceErrSum / n,
    plannedClearance: plannedClearanceSum / n,
    executedClearance: executedClearanceSum / n,
    plannedNetHitRate: plannedNetHits / n,
    executedNetHitRate: executedNetHits / n,
  };
}

// The grid the INTERNATIONAL (intermediate) tier plays: short through deep,
// rally pace through drive pace, light through heavy topspin.
const RALLY_TARGETS = [];
for (const z of [0.6, 0.9, 1.2]) {
  for (const speed of [8, 10, 12]) {
    for (const spin of [15, 30, 45]) RALLY_TARGETS.push({ z, speed, spin });
  }
}

describe('the paddle delivers the velocity the solver solved for', () => {
  test('the sample is large enough to mean something', () => {
    expect(CONTACTS.length).toBe(120);
    const m = measure({ difficulty: 'intermediate', framesEarly: 0, targets: RALLY_TARGETS });
    expect(m.n).toBeGreaterThan(2000);
  }, 120000);

  // The headline guard. This was 0.884 before the phase-spacing fix in
  // interception.js, and the shortfall was one-directional — the paddle was
  // never fast, only ever slow.
  test('contact speed is within 2% of the solved paddle speed', () => {
    for (const difficulty of ['beginner', 'intermediate', 'pro']) {
      const m = measure({ difficulty, framesEarly: 0, targets: RALLY_TARGETS });
      expect(m.speedRatio).toBeGreaterThan(0.98);
      expect(m.speedRatio).toBeLessThan(1.02);
    }
  }, 240000);

  // The face was never the problem — pinned so a future telegraph change
  // cannot quietly make it one.
  test('the face at contact is the solver face', () => {
    const m = measure({ difficulty: 'intermediate', framesEarly: 0, targets: RALLY_TARGETS });
    expect(m.faceErrorRad).toBeLessThan(0.005);   // < 0.3 degrees
  }, 120000);

  // Contact fires on whichever frame the ball first overlaps the blade, which
  // is not necessarily the nominal contact instant. The delivered stroke must
  // stay right across that window, not only at the exact terminal sample.
  // Contact fires in whichever FRAME the ball crosses the swept blade, not at
  // the planned instant, and the impulse reads that frame's finite difference.
  // So the stroke has to be right across a window either side of nominal, not
  // only at the exact terminal sample.
  //
  // The two sides fail differently, and both were broken:
  //   LATE  — the plan used to stop dead at contact and interpolateTrajectory
  //           clamps, so the paddle had already parked: 0.50x at half a frame
  //           late, 0.00x at a full frame. The follow-through fixes this
  //           outright, since it runs at exactly the terminal velocity.
  //   EARLY — the residual here is the real quintic, which is genuinely still
  //           accelerating a frame before contact. A real racket is slower
  //           28 ms before contact too. Nothing to fix; pinned so it cannot
  //           quietly get worse.
  test('a contact firing late still delivers the full stroke', () => {
    for (const framesEarly of [-0.5, -1]) {
      const m = measure({ difficulty: 'intermediate', framesEarly, targets: RALLY_TARGETS });
      expect(m.speedRatio).toBeGreaterThan(0.99);
      expect(m.faceErrorRad).toBeLessThan(0.005);
      expect(m.executedNetHitRate).toBe(0);
    }
  }, 240000);

  test('a contact firing early delivers all but the last of the acceleration', () => {
    for (const [framesEarly, minRatio] of [[0.5, 0.96], [1, 0.93]]) {
      const m = measure({ difficulty: 'intermediate', framesEarly, targets: RALLY_TARGETS });
      expect(m.speedRatio).toBeGreaterThan(minRatio);
      expect(m.faceErrorRad).toBeLessThan(0.01);   // < 0.6 degrees
      expect(m.executedNetHitRate).toBeLessThan(0.02);
    }
  }, 240000);
});

describe('executed returns clear the net as reliably as planned ones', () => {
  // What the player actually sees. The solver verifies 0% net hits by
  // construction (it rejects anything that does not clear); the question is
  // whether the executed stroke agrees.
  test('the executed net-hit rate matches the planned one', () => {
    for (const difficulty of ['intermediate', 'pro']) {
      const m = measure({ difficulty, framesEarly: 0, targets: RALLY_TARGETS });
      expect(m.plannedNetHitRate).toBe(0);
      expect(m.executedNetHitRate).toBeLessThan(0.005);
    }
  }, 240000);

  // Clearance is where the regression shows up first, before any ball
  // actually touches the cord — 15.5 cm planned collapsed to 11.3 cm executed
  // under the old spacing. Losing more than a centimetre of the planned arc
  // means the delivered stroke is drifting from the solved one again.
  test('executed clearance tracks planned clearance to within a centimetre', () => {
    const m = measure({ difficulty: 'intermediate', framesEarly: 0, targets: RALLY_TARGETS });
    expect(m.plannedClearance - m.executedClearance).toBeLessThan(0.01);
  }, 120000);

  // Short placed targets are where the whole failure concentrated: they are
  // planned with the least clearance to start with (5-9 cm), so they are the
  // first thing a delivery shortfall pushes into the net. 20-30% net hits
  // here before the fix.
  test('short placed targets — the worst cell — clear the net', () => {
    const shortTargets = [];
    for (const speed of [10, 12]) {
      for (const spin of [15, 30, 45]) shortTargets.push({ z: 0.6, speed, spin });
    }
    const m = measure({ difficulty: 'intermediate', framesEarly: 0, targets: shortTargets });
    expect(m.n).toBeGreaterThan(500);
    expect(m.executedNetHitRate).toBeLessThan(0.01);
  }, 120000);
});
