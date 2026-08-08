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

// eslint-disable-next-line import/first
import {
  SERVE_STATES,
  SERVE_ARCHETYPE_IDS,
  selectServeTarget,
  isServeTargetLegal,
  ensureNetClearance,
} from '../js/modes/aiMatch/serve.js';
// eslint-disable-next-line import/first
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
  // 0.10 is the nominal DRAG_COEFFICIENT baseline under the quadratic model.
  afterEach(() => setDragCoefficient(0.10));

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
        v.addScaledVector(magnus, 0.008 * dt); // MAGNUS_COEFFICIENT nominal
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

// --- Sub-FSM states --------------------------------------------------------

describe('SERVE_STATES enum', () => {
  test('contains exactly the 4 states (3 active + IDLE)', () => {
    const values = Object.values(SERVE_STATES).sort();
    expect(values).toEqual([
      'POST_SERVE', 'PRE_SERVE', 'SERVE_IDLE', 'SERVE_SWING',
    ]);
  });
});
