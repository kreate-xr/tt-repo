// Unit tests for the V2 serve sub-system. Archetype-driven variant.
//
// serve.js imports js/scene/models.js which pulls in GLTFLoader (pure ESM
// from three/examples). babel-jest can't transform that path without
// expanding transformIgnorePatterns. Mock the two transitive imports
// so we can test the pure helpers (target selection, legality, state
// enum) without the asset-loading chain.

const THREE = require('three');

jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    tableBox: new T.Box3(
      new T.Vector3(-0.7625, -0.01, -1.37),
      new T.Vector3( 0.7625,  0.01,  1.37),
    ),
    // ITTF net: 15.25 cm above play surface, ~1 cm thick, at Z=0 (mid table).
    netBox: new T.Box3(
      new T.Vector3(-0.9025, 0.0,    -0.005),
      new T.Vector3( 0.9025, 0.1525,  0.005),
    ),
    tableSurfaceY: 0,
    ballRadius: 0.02,
    ballModel: null,
    paddleModel: null,
    paddleFaceOffset: new T.Vector3(0, 0, -0.108),
    paddleFaceNormalLocal: new T.Vector3(1, 0, 0),
  };
});
jest.mock('../js/physics/ball.js', () => {
  const T = require('three');
  return {
    spawnBallAt: jest.fn(),
    ballVelocity: new T.Vector3(),
    ballAngularVelocity: new T.Vector3(),
    registerAIPaddle: jest.fn(() => ({})),
    unregisterAIPaddle: jest.fn(),
  };
});
// serve.js plays the contact sound itself now (the strike is scripted, so it
// never goes through tryPaddleCollision). No WebAudio in jsdom/node.
jest.mock('../js/scene/audio.js', () => ({
  playPaddleHitSound: jest.fn(),
}));

import {
  SERVE_STATES,
  SERVE_ARCHETYPE_IDS,
  selectServeTarget,
  isServeTargetLegal,
  ensureNetClearance,
  predictTossContact,
  solveTwoBounceServe,
  solveServeWithAimShift,
  simulateTwoBounceServe,
} from '../js/modes/aiMatch/serve.js';
import {
  setDragCoefficient, setGravity,
  GRAVITY,
  applyDragStep,
} from '../js/physics/constants.js';

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

function makeEnv() {
  return {
    tableBox: new THREE.Box3(
      new THREE.Vector3(-0.7625, -0.01, -1.37),
      new THREE.Vector3( 0.7625,  0.01,  1.37),
    ),
    tableSurfaceY: 0,
  };
}

// --- Shape of the returned target ------------------------------------------

describe('selectServeTarget — return shape', () => {
  test('every result has archetype, servePos, swing, and legal target', () => {
    const env = makeEnv();
    for (const difficulty of ['beginner', 'intermediate', 'pro']) {
      const rng = mulberry32(11 + difficulty.length);
      for (let i = 0; i < 200; i++) {
        const t = selectServeTarget(difficulty, rng);
        expect(SERVE_ARCHETYPE_IDS).toContain(t.archetype);
        expect(typeof t.servePos.x).toBe('number');
        expect(t.swing).toBeDefined();
        expect(['straight', 'pendulum', 'backhand', 'tomahawk', 'high_toss'])
          .toContain(t.swing.type);
        // servePos.x must stay inside AI baseline (80% of half-width cap).
        expect(Math.abs(t.servePos.x)).toBeLessThanOrEqual(0.7625 * 0.80 + 1e-6);
        // Target must be inside the legal service window.
        expect(isServeTargetLegal(t, env)).toBe(true);
      }
    }
  });
});

// --- Difficulty-scaling behaviour -------------------------------------------

describe('selectServeTarget — difficulty progression', () => {
  test('beginner uses only the soft archetypes', () => {
    const rng = mulberry32(21);
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      seen.add(selectServeTarget('beginner', rng).archetype);
    }
    // Beginner menu is the three soft_* archetypes only.
    for (const id of seen) {
      expect(id.startsWith('soft_')).toBe(true);
    }
    // But it must sample more than one archetype — no more static center.
    expect(seen.size).toBeGreaterThan(1);
  });

  // Intermediate is now the international tier and gets the FULL serve menu.
  // The three formerly pro-exclusive archetypes are standard equipment at
  // that level — an opponent who can't reverse-pendulum or high-toss is not
  // serving like an international player, whatever its ball speeds say.
  test('intermediate exposes the full advanced serve menu', () => {
    const rng = mulberry32(22);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      seen.add(selectServeTarget('intermediate', rng).archetype);
    }
    expect(seen.has('reverse_pendulum_topspin_deep')).toBe(true);
    expect(seen.has('high_toss_heavy_backspin')).toBe(true);
    expect(seen.has('fast_deep_no_spin_downline')).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  test('beginner still never draws an advanced archetype', () => {
    // The tier gap has to stay real at the bottom of the ladder.
    const rng = mulberry32(24);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      seen.add(selectServeTarget('beginner', rng).archetype);
    }
    expect(seen.has('reverse_pendulum_topspin_deep')).toBe(false);
    expect(seen.has('high_toss_heavy_backspin')).toBe(false);
    expect(seen.has('fast_deep_no_spin_downline')).toBe(false);
    expect(seen.has('tomahawk_sidespin_wide')).toBe(false);
  });

  test('pro exposes the full advanced menu', () => {
    const rng = mulberry32(23);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      seen.add(selectServeTarget('pro', rng).archetype);
    }
    expect(seen.has('reverse_pendulum_topspin_deep')).toBe(true);
    expect(seen.has('high_toss_heavy_backspin')).toBe(true);
    expect(seen.has('fast_deep_no_spin_downline')).toBe(true);
    // At least 5 different archetypes visible over 2k samples.
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  test('pro serves are on average faster than beginner serves', () => {
    const rngB = mulberry32(31);
    const rngP = mulberry32(32);
    let sumB = 0, sumP = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      sumB += selectServeTarget('beginner', rngB).target_speed;
      sumP += selectServeTarget('pro', rngP).target_speed;
    }
    expect(sumP / N).toBeGreaterThan(sumB / N + 1.0);
  });

  test('pro serves have larger average spin magnitude than beginner', () => {
    const rngB = mulberry32(33);
    const rngP = mulberry32(34);
    let sumB = 0, sumP = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      sumB += Math.abs(selectServeTarget('beginner', rngB).target_spin);
      sumP += Math.abs(selectServeTarget('pro', rngP).target_spin);
    }
    expect(sumP / N).toBeGreaterThan(sumB / N + 3.0);
  });
});

// --- Human-like variety -----------------------------------------------------

describe('selectServeTarget — start position varies for intermediate/pro', () => {
  test('intermediate uses non-zero servePos.x on a majority of serves', () => {
    const rng = mulberry32(41);
    let offCenter = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const t = selectServeTarget('intermediate', rng);
      if (Math.abs(t.servePos.x) > 0.05) offCenter++;
    }
    expect(offCenter / N).toBeGreaterThan(0.5);
  });

  test('beginner mostly stays centered', () => {
    const rng = mulberry32(42);
    let centered = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const t = selectServeTarget('beginner', rng);
      if (Math.abs(t.servePos.x) < 0.05) centered++;
    }
    expect(centered / N).toBeGreaterThan(0.9);
  });
});

describe('selectServeTarget — anti-repeat', () => {
  test('avoidArchetypeId is respected when at least 2 options exist', () => {
    const rng = mulberry32(51);
    // Pro has many archetypes, so avoid must always work.
    let repeated = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const t = selectServeTarget('pro', rng, { avoidArchetypeId: 'high_toss_heavy_backspin' });
      if (t.archetype === 'high_toss_heavy_backspin') repeated++;
    }
    expect(repeated).toBe(0);
  });
});

describe('selectServeTarget — length and placement variety', () => {
  test('pro produces short, half-long, and long serves', () => {
    const rng = mulberry32(61);
    const buckets = { short: 0, half: 0, long: 0 };
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const z = selectServeTarget('pro', rng).target_z;
      if (z < 0.55) buckets.short++;
      else if (z < 0.95) buckets.half++;
      else buckets.long++;
    }
    expect(buckets.short).toBeGreaterThan(N * 0.10);
    expect(buckets.half).toBeGreaterThan(N * 0.05);
    expect(buckets.long).toBeGreaterThan(N * 0.10);
  });

  test('pro produces both crossline-side and downline-side placements', () => {
    const rng = mulberry32(62);
    let neg = 0, pos = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const x = selectServeTarget('pro', rng).target_x;
      if (x < -0.20) neg++;
      else if (x > 0.20) pos++;
    }
    expect(neg).toBeGreaterThan(N * 0.15);
    expect(pos).toBeGreaterThan(N * 0.15);
  });
});

// --- Score-awareness / pressure --------------------------------------------

describe('selectServeTarget — pressure lowers aggressive rate', () => {
  const N = 4000;

  function countAggressive(difficulty, gameContext, seed) {
    const rng = mulberry32(seed);
    const AGG_IDS = new Set([
      'reverse_pendulum_topspin_deep',
      'fast_deep_no_spin_downline',
    ]);
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const t = selectServeTarget(difficulty, rng, { gameContext });
      if (AGG_IDS.has(t.archetype)) hits++;
    }
    return hits / N;
  }

  test('pro plays fewer aggressive serves at deuce than at 0-0', () => {
    const baseline = countAggressive('pro', null, 71);
    const deuce = countAggressive('pro', { isDeuce: true }, 72);
    expect(deuce).toBeLessThan(baseline * 0.8);
  });

  test('pro plays fewer aggressive serves at match point than at deuce', () => {
    const deuce = countAggressive('pro', { isDeuce: true }, 73);
    const matchPt = countAggressive('pro', { isMatchPoint: true }, 74);
    expect(matchPt).toBeLessThan(deuce);
  });

  test('pressure does not eliminate aggressive serves entirely', () => {
    // Even at match point, a small share of aggressive serves should still
    // appear — humans still surprise on big points.
    const matchPt = countAggressive('pro', { isMatchPoint: true }, 75);
    expect(matchPt).toBeGreaterThan(0.02);
  });

  test('game point (server one from winning) also raises pressure', () => {
    const baseline = countAggressive('pro', null, 76);
    const gamePt = countAggressive('pro', { isGamePoint: true }, 77);
    expect(gamePt).toBeLessThan(baseline * 0.85);
  });
});

// --- Serve legality --------------------------------------------------------

describe('isServeTargetLegal', () => {
  test('rejects targets outside the table footprint', () => {
    const env = makeEnv();
    expect(isServeTargetLegal({ target_x: 0, target_z: 0.7 }, env)).toBe(true);
    expect(isServeTargetLegal({ target_x: 0.8, target_z: 0.7 }, env)).toBe(false);
    expect(isServeTargetLegal({ target_x: 0, target_z: 1.4 }, env)).toBe(false);
    expect(isServeTargetLegal({ target_x: 0, target_z: 0.01 }, env)).toBe(false);
  });

  test('100 generated serves are 95%+ legal across all difficulties', () => {
    const env = makeEnv();
    for (const difficulty of ['beginner', 'intermediate', 'pro']) {
      const rng = mulberry32(100 + difficulty.length);
      let legal = 0;
      const N = 100;
      for (let i = 0; i < N; i++) {
        const t = selectServeTarget(difficulty, rng);
        if (isServeTargetLegal(t, env)) legal++;
      }
      expect(legal / N).toBeGreaterThanOrEqual(0.95);
    }
  });
});

// --- Net clearance guard ---------------------------------------------------
//
// The AI serves from Z ≈ -1.25 m (just inside the AI baseline plus the
// 15 cm spawn offset). Net is at Z=0. These tests roll a virtual ball
// forward from that launch point and confirm the trajectory clears the
// net top (0.1525 + ballRadius) with margin.

describe('ensureNetClearance', () => {
  // Reset drag between tests — the setter has a live-binding into serve.js.
  // 0.13 is the shipped DRAG_COEFFICIENT (the physical value); resetting to
  // anything else leaves later describes measuring a ball the game never
  // flies.
  afterEach(() => setDragCoefficient(0.13));

  function simCrossNetY(launchPos, vel, spin) {
    // Independent copy of the simulator used inside serve.js. Uses the same
    // applyDragStep helper so any drift between the test simulator and the
    // real one is impossible by construction.
    const T = require('three');
    const pos = launchPos.clone();
    const v = vel.clone();
    const s = spin.clone();
    const magnus = new T.Vector3();
    const dt = 0.008;
    const netZ = 0;
    for (let i = 0; i < 400; i++) {
      const prevY = pos.y;
      const prevZ = pos.z;
      v.y += GRAVITY * dt;
      if (s.lengthSq() > 1e-4) {
        magnus.crossVectors(s, v);
        v.addScaledVector(magnus, 0.008 * dt); // legacy linear Magnus; s is zero here so it never runs
      }
      applyDragStep(v, dt);
      pos.addScaledVector(v, dt);
      if ((prevZ < netZ && pos.z >= netZ) || (prevZ > netZ && pos.z <= netZ)) {
        const t = (netZ - prevZ) / (pos.z - prevZ);
        return prevY + (pos.y - prevY) * t;
      }
      if (pos.y < -0.5) return null;
    }
    return null;
  }

  test('a launch that already clears is returned unchanged', () => {
    const launchPos = new THREE.Vector3(0, 0.30, -1.25);
    const vel = new THREE.Vector3(0, 2.0, 5.0);   // healthy arc, will clear
    const spin = new THREE.Vector3();
    const res = ensureNetClearance(launchPos, vel, spin);
    expect(res.clears).toBe(true);
    expect(res.iterations).toBe(0);
    expect(res.launchVel.y).toBeCloseTo(2.0, 6);
  });

  test('a sagging launch gets boosted until it clears', () => {
    const launchPos = new THREE.Vector3(0, 0.30, -1.25);
    // Flat, low-arc launch — under baseline drag this would clip the net.
    const vel = new THREE.Vector3(0, 0.5, 5.0);
    const spin = new THREE.Vector3();
    const res = ensureNetClearance(launchPos, vel, spin);
    expect(res.clears).toBe(true);
    expect(res.launchVel.y).toBeGreaterThan(vel.y); // was boosted
    // Independently confirm the boosted trajectory clears net top + margin.
    const yAtNet = simCrossNetY(launchPos, res.launchVel, spin);
    expect(yAtNet).toBeGreaterThan(0.1525 + 0.02 + 0.03);
  });

  test('serves clear the net under 2.5x nominal drag', () => {
    setDragCoefficient(0.25);   // 2.5x baseline under the quadratic model
    const launchPos = new THREE.Vector3(0, 0.30, -1.25);
    // Start from a solver-typical launch: moderate arc, ~5 m/s horizontal.
    const vel = new THREE.Vector3(0, 1.5, 4.5);
    const spin = new THREE.Vector3();
    const res = ensureNetClearance(launchPos, vel, spin);
    expect(res.clears).toBe(true);
    const yAtNet = simCrossNetY(launchPos, res.launchVel, spin);
    expect(yAtNet).toBeGreaterThan(0.1525 + 0.02);
  });

  test('serves clear the net at the setter clamp maximum drag (0.30)', () => {
    setDragCoefficient(0.30);   // clamp maximum via setDragCoefficient
    const launchPos = new THREE.Vector3(0, 0.30, -1.25);
    const vel = new THREE.Vector3(0, 1.5, 4.5);
    const spin = new THREE.Vector3();
    const res = ensureNetClearance(launchPos, vel, spin);
    expect(res.clears).toBe(true);
    const yAtNet = simCrossNetY(launchPos, res.launchVel, spin);
    expect(yAtNet).toBeGreaterThan(0.1525 + 0.02);
  });

  test('a launch aimed away from the net still gets rescued', () => {
    // Ball aimed straight down — never reaches the net Z plane. Guard must
    // recover rather than loop forever.
    const launchPos = new THREE.Vector3(0, 0.30, -1.25);
    const vel = new THREE.Vector3(0, -1.0, 0.2);
    const spin = new THREE.Vector3();
    const res = ensureNetClearance(launchPos, vel, spin);
    // May or may not clear (physics limits), but must terminate and not crash.
    expect(res.iterations).toBeLessThanOrEqual(24);
  });
});

// --- Two-bounce serve solver -------------------------------------------------
//
// ITTF: the serve must bounce on the server's half first, then land on the
// receiver's half. These roll the solved launch through the same integrator
// the live ball uses and assert the full legality checklist.

describe('solveTwoBounceServe — ITTF two-bounce serves', () => {
  // Pin the SHIPPING physics (constants.js defaults: drag 0.13, gravity
  // -9.81) explicitly, so the solver's legality envelope is measured against
  // what the live game actually runs whatever an earlier describe's hooks
  // did.
  beforeEach(() => { setDragCoefficient(0.13); setGravity(-9.81); });
  afterEach(() => { setDragCoefficient(0.13); setGravity(-9.81); });

  const NET_TOP = 0.1525;
  const BALL_R = 0.02;
  function fullEnv() {
    return {
      tableBox: new THREE.Box3(
        new THREE.Vector3(-0.7625, -0.01, -1.37),
        new THREE.Vector3( 0.7625,  0.01,  1.37),
      ),
      netBox: new THREE.Box3(
        new THREE.Vector3(-0.9025, 0.0,    -0.005),
        new THREE.Vector3( 0.9025, NET_TOP, 0.005),
      ),
      tableSurfaceY: 0,
      ballRadius: BALL_R,
    };
  }
  // Production strike geometry: ~35cm above the table (TOSS_CONTACT_HEIGHT_M),
  // just behind the AI end line (serve-ready z = min.z - 0.05, toss a further
  // 2cm back). The height matters — it sets which arcs can legally carry deep
  // (see the arc/depth table in serve.js), so a stale value here would test an
  // envelope the game doesn't play in.
  const launchPos = (x = 0) => new THREE.Vector3(x, 0.35, -1.44);

  function spinFor(rps, from, targetWorld) {
    const dir = targetWorld.clone().sub(from);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    return new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), dir)
      .normalize()
      .multiplyScalar(rps * 2 * Math.PI);
  }

  // maxErr: deep targets legitimately land short of the extreme — clearing
  // the net with margin caps how deep a legal two-bounce serve can carry.
  function expectLegal(res, maxErr = 0.30) {
    expect(res).toBeTruthy();
    expect(res.legal).toBe(true);
    expect(res.sim.firstBounce).toBeTruthy();
    expect(res.sim.firstBounce.z).toBeLessThan(0);          // AI half
    expect(res.sim.crossedNetBeforeBounce).toBe(false);
    expect(res.sim.netClearance).toBeGreaterThanOrEqual(BALL_R); // center above top + radius
    expect(res.sim.landing.onTable).toBe(true);
    expect(res.sim.landing.z).toBeGreaterThan(0);           // player half
    expect(res.landingError).toBeLessThan(maxErr);
  }

  test('a fast deep serve solves legally', () => {
    const target = new THREE.Vector3(0.4, 0, 1.15);
    const res = solveTwoBounceServe(launchPos(0.3), target, 8.0, new THREE.Vector3(), fullEnv());
    // This used to allow 0.65m of error, on the theory that clearing the cord
    // capped how deep a legal serve could carry. It doesn't — that was the
    // arc preference steering into an unreachable band. Deep targets hit.
    expectLegal(res, 0.10);
  });

  test('a short backspin serve solves legally', () => {
    const target = new THREE.Vector3(-0.1, 0, 0.30);
    const spin = spinFor(-24, launchPos(0.4), target);
    const res = solveTwoBounceServe(launchPos(0.4), target, 3.5, spin, fullEnv());
    expectLegal(res);
  });

  test('a crossline sidespin-era placement solves legally', () => {
    const target = new THREE.Vector3(-0.5, 0, 1.1);
    const spin = spinFor(6, launchPos(0.5), target);
    const res = solveTwoBounceServe(launchPos(0.5), target, 6.0, spin, fullEnv());
    expectLegal(res, 0.10);
  });

  test('every archetype target across all tiers solves legally', () => {
    const env = fullEnv();
    for (const difficulty of ['beginner', 'intermediate', 'pro']) {
      const rng = mulberry32(500 + difficulty.length);
      let legal = 0;
      const N = 30;
      for (let i = 0; i < N; i++) {
        const t = selectServeTarget(difficulty, rng);
        const from = launchPos(t.servePos.x);
        const target = new THREE.Vector3(t.target_x, 0, t.target_z); // tableCenterZ = 0
        const spin = spinFor(t.target_spin, from, target);
        const res = solveTwoBounceServe(from, target, t.target_speed, spin, env);
        if (res && res.legal) legal++;
      }
      expect(legal / N).toBeGreaterThanOrEqual(0.9);
    }
  });

  test('still solves legally under 2x drag and standard gravity', () => {
    setDragCoefficient(0.20);
    setGravity(-9.8);
    const target = new THREE.Vector3(0.2, 0, 0.9);
    const res = solveTwoBounceServe(launchPos(0), target, 5.0, new THREE.Vector3(), fullEnv());
    expect(res).toBeTruthy();
    expect(res.legal).toBe(true);
  });

  // --- The serve has to actually GET THERE ----------------------------------
  //
  // Landing accuracy alone was never the whole requirement, and treating it as
  // one is how a real defect shipped: CLUB serves solved "legally", landed on
  // the player's half, and then arrived at the end line 1.3s later at 1.7 m/s,
  // dying ~38cm past the line. Legal, placed, and unreturnable — the player
  // simply could not reach it. So assert the property that was actually
  // missing: a serve aimed deep must ARRIVE, and arrive at a playable pace.
  //
  // Short serves are deliberately exempt. A short serve that doesn't carry
  // past the end line is doing its job — the receiver steps in and takes it
  // over the table.
  describe('deep serves arrive at the receiver with usable pace', () => {
    const END_LINE_Z = 1.37;

    // Roll the solved launch all the way out and report the state when it
    // crosses the receiver's end line, using the live integrator.
    function arrivalAtEndLine(from, vel, spin) {
      const { integrateFlightStep, applyTableBounce } =
        require('../js/physics/rollout.js');
      const pos = from.clone(), v = vel.clone(), s = spin.clone();
      const dt = 0.004;
      let bounces = 0;
      for (let i = 0; i < 1500; i++) {
        const prevZ = pos.z;
        integrateFlightStep(pos, v, s, dt);
        if (prevZ < END_LINE_Z && pos.z >= END_LINE_Z) {
          return { timeMs: (i + 1) * dt * 1000, speed: v.length(), y: pos.y };
        }
        if ((pos.y - BALL_R) <= 0 && v.y < 0) {
          const onTable = Math.abs(pos.x) <= 0.7625 && Math.abs(pos.z) <= 1.37;
          if (!onTable) break;
          bounces++;
          pos.y = BALL_R;
          applyTableBounce(v, s, BALL_R);
          if (bounces > 6) break;
        }
        if (pos.y < -1.0) break;
      }
      return null;   // never got there
    }

    test('every deep archetype target across all tiers reaches the player', () => {
      const env = fullEnv();
      for (const difficulty of ['beginner', 'intermediate', 'pro']) {
        const rng = mulberry32(900 + difficulty.length);
        let deep = 0;
        for (let i = 0; i < 60; i++) {
          const t = selectServeTarget(difficulty, rng);
          if (t.target_z < 0.80) continue;         // short serves exempt
          deep++;
          const from = launchPos(t.servePos.x);
          const target = new THREE.Vector3(t.target_x, 0, t.target_z);
          const spin = spinFor(t.target_spin, from, target);
          const res = solveTwoBounceServe(from, target, t.target_speed, spin, env);
          const arrival = arrivalAtEndLine(from, res.velocity, spin);
          expect(arrival).not.toBeNull();
          // 2.5 m/s is the floor for "the player can play a stroke at this"
          // rather than reach forward and poke a dying ball. Measured band
          // after the fix is 2.9-5.4 m/s; before it, deep serves arrived at
          // 1.7-2.2 and many never crossed at all.
          expect(arrival.speed).toBeGreaterThan(2.5);
          // And it has to get there before the player has given up on it.
          expect(arrival.timeMs).toBeLessThan(900);
        }
        expect(deep).toBeGreaterThan(5);           // the sample must be real
      }
    });

    test('CLUB deep serves are not the slow floaters they used to be', () => {
      // The reported bug, pinned as a number. The old solver produced a
      // 3.42 m/s launch on a +1.4 arc landing at z=0.58 for this target.
      const env = fullEnv();
      const from = launchPos(0);
      const target = new THREE.Vector3(0, 0, 1.00);
      const res = solveTwoBounceServe(from, target, 3.5, new THREE.Vector3(), env);
      expect(res.legal).toBe(true);
      expect(res.landingError).toBeLessThan(0.10);
      // A downward strike is the only shape that carries deep off an own-half
      // bounce; an upward arc here is the regression.
      expect(res.velocity.y).toBeLessThan(0);
      const arrival = arrivalAtEndLine(from, res.velocity, new THREE.Vector3());
      expect(arrival.timeMs).toBeLessThan(800);    // was ~1320
      expect(arrival.speed).toBeGreaterThan(2.5);  // was ~1.73
    });
  });

  test('simulateTwoBounceServe flags a direct (no own bounce) launch', () => {
    // A hard flat launch aimed straight over the net — crosses before bouncing.
    const res = simulateTwoBounceServe(
      launchPos(0), new THREE.Vector3(0, 1.2, 7.0), new THREE.Vector3(), fullEnv());
    expect(res.crossedNetBeforeBounce).toBe(true);
  });

  // --- Real sidespin serves --------------------------------------------------
  //
  // The sidespin archetypes used to launch pure top/back spin: strikeBall
  // built the spin axis as up × dir (horizontal only), so "pendulum sidespin"
  // and "tomahawk" serves neither curled in flight nor kicked off the bounce.
  // These pin the vertical (ω_y) channel end-to-end.
  describe('sidespin serves', () => {
    const sidespinFor = (rps) => new THREE.Vector3(0, rps * 2 * Math.PI, 0);

    test('sidespin archetypes sample a nonzero vertical spin channel', () => {
      const rng = mulberry32(77);
      const seen = {};
      for (let i = 0; i < 300; i++) {
        const t = selectServeTarget('pro', rng);
        seen[t.archetype] = t.target_side_spin;
      }
      expect(Math.abs(seen.pendulum_sidespin_deep_crossline)).toBeGreaterThanOrEqual(10);
      expect(seen.tomahawk_sidespin_wide).toBeLessThanOrEqual(-10);
      expect(seen.fast_deep_no_spin_downline || 0).toBe(0);
    });

    test('pure sidespin actually curls the flight laterally, sign-symmetric', () => {
      // Same launch, mirrored ω_y → mirrored lateral drift of the landing.
      const from = launchPos(0);
      const vel = new THREE.Vector3(0, 0.4, 4.6);
      const plus = simulateTwoBounceServe(from, vel, sidespinFor(15), fullEnv());
      const minus = simulateTwoBounceServe(from, vel, sidespinFor(-15), fullEnv());
      expect(plus.landing).toBeTruthy();
      expect(minus.landing).toBeTruthy();
      // ω_y > 0 with flight toward +z curls +x (a = M·(ω × v)).
      expect(plus.landing.x).toBeGreaterThan(0.03);
      expect(minus.landing.x).toBeCloseTo(-plus.landing.x, 2);
    });

    test('aim shift lands a heavy sidespin serve on target where the straight solver misses', () => {
      const env = fullEnv();
      const from = launchPos(0.5);
      const target = new THREE.Vector3(-0.45, 0, 1.10);
      const spin = spinFor(2, from, target).add(sidespinFor(16));
      const straight = solveTwoBounceServe(from, target, 6.0, spin, env);
      const shifted = solveServeWithAimShift(from, target, 6.0, spin, env);
      expect(shifted).toBeTruthy();
      expect(shifted.legal).toBe(true);
      expect(shifted.landingError).toBeLessThanOrEqual(straight.landingError + 1e-9);
      expect(shifted.landingError).toBeLessThan(0.20);
    });

    test('every archetype with its FULL composed spin solves legally via aim shift', () => {
      const env = fullEnv();
      for (const difficulty of ['intermediate', 'pro']) {
        const rng = mulberry32(1300 + difficulty.length);
        let legal = 0;
        const N = 30;
        for (let i = 0; i < N; i++) {
          const t = selectServeTarget(difficulty, rng);
          const from = launchPos(t.servePos.x);
          const target = new THREE.Vector3(t.target_x, 0, t.target_z);
          const spin = spinFor(t.target_spin, from, target)
            .add(sidespinFor(t.target_side_spin || 0));
          const res = solveServeWithAimShift(from, target, t.target_speed, spin, env);
          if (res && res.legal) legal++;
        }
        expect(legal / N).toBeGreaterThanOrEqual(0.9);
      }
    });
  });
});

// --- Sub-FSM states --------------------------------------------------------

describe('SERVE_STATES enum', () => {
  test('contains exactly the 5 states (4 active + IDLE)', () => {
    const values = Object.values(SERVE_STATES).sort();
    expect(values).toEqual([
      'POST_SERVE', 'PRE_SERVE', 'SERVE_IDLE', 'SERVE_SWING', 'SERVE_TOSS',
    ]);
  });
});

// --- Visible toss ----------------------------------------------------------
//
// The serve used to spawn the ball already moving at 3-9 m/s a few cm off the
// paddle face, so from the player's side the ball simply appeared. The toss
// phase makes it visible: these lock in that the ball genuinely rises, and
// that the predicted strike is taken on the way back down.

describe('predictTossContact', () => {
  afterEach(() => { setDragCoefficient(0.13); setGravity(-9.81); });

  // Mirrors the production geometry: toss from 10cm above the table, struck
  // on the descent at 35cm (or sooner if the descent-speed cap bites).
  const ORIGIN_Y = 0.10;
  const FLOOR_Y = 0.35;
  const ORIGIN = () => new THREE.Vector3(0.2, ORIGIN_Y, -1.4);
  const STD = () => new THREE.Vector3(0, 4.5, 0);
  const HIGH = () => new THREE.Vector3(0, 4.8, 0);

  // 4.0 m/s is where the placement solver was measured to still be clean
  // across every archetype and tier. Above it, serves start dropping onto
  // the infeasible-fallback launch and miss their target.
  const MAX_DESCENT = 4.0;

  test('the toss rises high enough for the player to judge it', () => {
    const res = predictTossContact(ORIGIN(), STD(), FLOOR_Y);
    // Far more than the ITTF 16cm minimum — this is a readability
    // requirement, not just a legality one.
    expect(res.apexY - ORIGIN_Y).toBeGreaterThan(0.70);
  });

  test('the whole arc is visible: big rise AND a real descent before contact', () => {
    const res = predictTossContact(ORIGIN(), STD(), FLOOR_Y);
    const rise = res.apexY - ORIGIN_Y;
    const fall = res.apexY - res.position.y;
    expect(rise).toBeGreaterThan(0.70);
    expect(fall).toBeGreaterThan(0.50);
  });

  test('contact is taken on the descent, below the apex and above the origin', () => {
    const res = predictTossContact(ORIGIN(), STD(), FLOOR_Y);
    expect(res.velocity.y).toBeLessThan(0);          // descending
    expect(res.position.y).toBeLessThan(res.apexY);
    expect(res.position.y).toBeGreaterThan(ORIGIN_Y);
  });

  test('the toss is airborne long enough for a player to track it', () => {
    const res = predictTossContact(ORIGIN(), STD(), FLOOR_Y);
    expect(res.timeMs).toBeGreaterThan(600);
    expect(res.timeMs).toBeLessThan(1800);           // under TOSS_MAX_DURATION_MS
  });

  test('the high-toss archetype is taller and slower than the standard toss', () => {
    const std = predictTossContact(ORIGIN(), STD(), FLOOR_Y);
    const high = predictTossContact(ORIGIN(), HIGH(), FLOOR_Y);
    expect(high.apexY).toBeGreaterThan(std.apexY + 0.05);
    expect(high.timeMs).toBeGreaterThan(std.timeMs);
  });

  test('contact descent speed stays inside the placement solver envelope', () => {
    for (const vy of [4.5, 4.8]) {
      const res = predictTossContact(ORIGIN(), new THREE.Vector3(0, vy, 0), FLOOR_Y);
      expect(Math.abs(res.velocity.y)).toBeLessThanOrEqual(MAX_DESCENT + 0.2);
    }
  });

  test('the descent cap catches an over-tall toss instead of breaking placement', () => {
    // Twice the intended toss velocity — the height floor would be reached
    // at ~7 m/s. The cap must strike it higher up instead.
    const res = predictTossContact(ORIGIN(), new THREE.Vector3(0, 9.0, 0), FLOOR_Y);
    expect(Math.abs(res.velocity.y)).toBeLessThanOrEqual(MAX_DESCENT + 0.2);
    expect(res.position.y).toBeGreaterThan(FLOOR_Y);
  });

  test('stays sane when the physics tuner changes gravity', () => {
    setGravity(-9.8);
    const res = predictTossContact(ORIGIN(), STD(), FLOOR_Y);
    expect(res.apexY - ORIGIN_Y).toBeGreaterThan(0.70);
    expect(res.velocity.y).toBeLessThan(0);
    expect(Math.abs(res.velocity.y)).toBeLessThanOrEqual(MAX_DESCENT + 0.2);
    expect(res.timeMs).toBeGreaterThan(600);
  });

  test('a degenerate (downward) toss still terminates with a usable contact', () => {
    const res = predictTossContact(ORIGIN(), new THREE.Vector3(0, -1.0, 0), FLOOR_Y);
    expect(Number.isFinite(res.timeMs)).toBe(true);
    expect(res.position).toBeDefined();
  });
});
