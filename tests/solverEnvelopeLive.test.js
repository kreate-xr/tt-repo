// Solver feasibility on the LIVE table geometry, through the FSM's soften
// ladder — the permanent version of the one-off harness that diagnosed the
// 2026-08-30 "AI lost its intelligence" regression.
//
// solverEnvelope.test.js measures the solver on a symmetric ITTF table at
// y = 0. The game does not play there: Table.glb's authored anchors put the
// surface at 0.78 m, the cord top at 0.9325 m, and the deck 2 cm off-centre
// in x (−0.8302 … 0.6841). The net gate reads that geometry, and the FSM does
// not take the solver's first answer — on infeasible it retries the same
// tactical target down a soften ladder and only then plays the centre-table
// safe block. What the player experiences is the OUTCOME of that chain, so
// this is what the numbers below measure, per tier:
//
//   intelligent   full-pace solve OR a laddered same-target solve
//   safeBlock     the 4 m/s zero-spin centre ball
//   miss          nothing solved — an honest whiff
//
// Baseline at the 2026-08-30 fix (two-rung ladder, drag 0.17, linear
// Magnus): intelligent 93%, safe block 6-7% at intermediate/pro. The 2026-09
// physics pass (drag 0.13, saturating Magnus, flatter table COR) re-measured
// against this file and added the third ladder rung; the thresholds below
// are the floor the tiers must keep, and a drop is a tier-identity
// regression whatever the physics claims.

const THREE = require('three');

// Real Table.glb anchor geometry (see table-glb-off-ittf-spec: the asset is
// 2 cm tall and 1.1 cm narrow, and the net is 4.7 cm short of spec).
const SURFACE_Y = 0.78;
const CORD_TOP_Y = 0.9325;
const TABLE_MIN_X = -0.8302;
const TABLE_MAX_X = 0.6841;
const TABLE_HALF_Z = 1.3658;
const BALL_R = 0.02;

jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    tableBox: new T.Box3(
      new T.Vector3(-0.8302, 0.78 - 0.001, -1.3658),
      new T.Vector3(0.6841, 0.78 + 0.001, 1.3658),
    ),
    tableSurfaceY: 0.78,
    ballRadius: 0.02,
    ballModel: null,
  };
});
jest.mock('../js/physics/ball.js', () => {
  const T = require('three');
  return { ballVelocity: new T.Vector3(), ballAngularVelocity: new T.Vector3() };
});

import { rolloutForAIInterception } from '../js/ai/shotAdapter.js';
import { solvePaddle } from '../js/ai/paddleSolver.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

const TABLE_CENTER_X = (TABLE_MIN_X + TABLE_MAX_X) / 2;

function liveEnv() {
  const tableBox = new THREE.Box3(
    v(TABLE_MIN_X, SURFACE_Y - 0.001, -TABLE_HALF_Z),
    v(TABLE_MAX_X, SURFACE_Y + 0.001, TABLE_HALF_Z),
  );
  // Mirrors models.js: the net box spans the posts (14 cm past each side),
  // surface to cord top, ±5 mm thick, then inflated by one ball radius.
  const netBox = new THREE.Box3(
    v(TABLE_MIN_X - 0.14, SURFACE_Y, -0.005),
    v(TABLE_MAX_X + 0.14, CORD_TOP_Y, 0.005),
  ).expandByScalar(BALL_R);
  return {
    tableSurfaceY: SURFACE_Y,
    tableCenterX: TABLE_CENTER_X,
    tableCenterZ: 0,
    ballRadius: BALL_R,
    tableBox,
    netBox,
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

// Plausible player shots → real AI interception states, on the live deck.
function realisticContacts(n, rng) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 30) {
    const r = rolloutForAIInterception(
      v(TABLE_CENTER_X + (rng() - 0.5) * 1.0, SURFACE_Y + 0.25 + rng() * 0.35, 0.6 + rng() * 0.6),
      v((rng() - 0.5) * 1.5, 0.3 + rng() * 1.6, -(4 + rng() * 6)),
      v((rng() - 0.5) * 120, 0, 0),
    );
    if (r) out.push(r);
  }
  return out;
}

// aiFSM.paddleSolveJob, minus the generator plumbing: full solve, then the
// soften ladder on the same target, then the safe block. The rung scales
// mirror aiFSM.SOFTEN_LADDER — change both.
const SOFTEN_LADDER = [
  { speedScale: 0.80, spinScale: 0.6 },
  { speedScale: 0.62, spinScale: 0.45 },
  { speedScale: 0.45, spinScale: 0.35 },
];
const SOFTEN_MIN_SPEED = 3.0;

function solveLikeTheFSM(req) {
  const full = solvePaddle(req);
  if (full.feasible) return 'intelligent';
  for (const rung of SOFTEN_LADDER) {
    const r = solvePaddle({
      ...req,
      targetSpeed: Math.max(SOFTEN_MIN_SPEED, req.targetSpeed * rung.speedScale),
      targetSpin: req.targetSpin * rung.spinScale,
      targetSideSpin: (req.targetSideSpin || 0) * rung.spinScale,
    });
    if (r.feasible) return 'intelligent';
  }
  const safe = solvePaddle({
    targetX: TABLE_CENTER_X, targetZ: 0.7, targetSpeed: 4.0, targetSpin: 0,
    contactPos: req.contactPos, contactVel: req.contactVel, contactSpin: req.contactSpin,
    difficulty: req.difficulty, env: req.env,
  });
  return safe.feasible ? 'safeBlock' : 'miss';
}

const CONTACTS = realisticContacts(120, mulberry32(11));

describe('live-geometry solver envelope through the soften ladder', () => {
  const { createBeginnerEngine } = require('../js/ai/engines/beginner.js');
  const { createIntermediateEngine } = require('../js/ai/engines/intermediate.js');
  const { createProEngine } = require('../js/ai/engines/pro.js');
  const { ShotHistory } = require('../js/ai/shotHistory.js');

  const FACTORIES = {
    beginner: createBeginnerEngine,
    intermediate: createIntermediateEngine,
    pro: createProEngine,
  };

  function runTier(difficulty) {
    const env = liveEnv();
    const engine = FACTORIES[difficulty]({ rng: mulberry32(5) });
    const history = new ShotHistory();
    const tally = { intelligent: 0, safeBlock: 0, miss: 0 };
    for (const c of CONTACTS) {
      const t = engine.computeTarget(history, {});
      const [tx, tz, speed, spin] = t;
      const sideSpin = t.length > 6 && Number.isFinite(t[6]) ? t[6] : 0;
      const outcome = solveLikeTheFSM({
        // Engines aim in table-centred x; the live deck is off-centre.
        targetX: TABLE_CENTER_X + tx, targetZ: tz,
        targetSpeed: speed, targetSpin: spin, targetSideSpin: sideSpin,
        contactPos: v(c.contactPoint.x, c.contactPoint.y, c.contactPoint.z),
        contactVel: v(c.contactVelocity.x, c.contactVelocity.y, c.contactVelocity.z),
        contactSpin: v(c.contactSpin.x, c.contactSpin.y, c.contactSpin.z),
        difficulty, env,
      });
      tally[outcome] += 1;
      engine.ingestShot(null, null);
    }
    const n = CONTACTS.length;
    const rates = {
      intelligent: tally.intelligent / n,
      safeBlock: tally.safeBlock / n,
      miss: tally.miss / n,
    };
    // Printed on purpose: this is the measurement the physics constants'
    // comments cite. Read it with --verbose.
    console.log(`[solverEnvelopeLive] ${difficulty}: ` +
      `intelligent ${(rates.intelligent * 100).toFixed(1)}%  ` +
      `safeBlock ${(rates.safeBlock * 100).toFixed(1)}%  ` +
      `miss ${(rates.miss * 100).toFixed(1)}%`);
    return rates;
  }

  test('the contact generator produced a usable sample on the live deck', () => {
    expect(CONTACTS.length).toBe(120);
    // Sanity: contacts sit above the real surface, not the symmetric y = 0.
    for (const c of CONTACTS) expect(c.contactPoint.y).toBeGreaterThan(SURFACE_Y);
  });

  test.each(['intermediate', 'pro'])(
    '%s keeps its identity: tactical shots dominate, the safe block stays the exception',
    (difficulty) => {
      const r = runTier(difficulty);
      expect(r.intelligent).toBeGreaterThanOrEqual(0.90);
      expect(r.safeBlock).toBeLessThanOrEqual(0.10);
    },
  );

  test('beginner mostly plays the ball it means to', () => {
    const r = runTier('beginner');
    expect(r.intelligent).toBeGreaterThanOrEqual(0.75);
  });
});
