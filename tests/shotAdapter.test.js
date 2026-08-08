// Unit tests for the shotAdapter physics rollout.
// Spec §testing_requirements.unit_tests_jest:
//   - shotAdapter physics rollout produces stable landing_x/z across 100
//     randomized initial conditions
//
// The rollout reads tableBox / tableSurfaceY / ballRadius from models.js
// which in turn imports GLTFLoader (browser-DOM dependent). We mock those
// imports to keep the test pure and CPU-only.

const THREE = require('three');

jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    tableBox: new T.Box3(
      new T.Vector3(-0.7625, -0.001, -1.37),
      new T.Vector3( 0.7625,  0.001,  1.37),
    ),
    tableSurfaceY: 0,
    ballRadius: 0.02,
    ballModel: null,
  };
});

jest.mock('../js/physics/ball.js', () => {
  const T = require('three');
  return {
    ballVelocity: new T.Vector3(),
    ballAngularVelocity: new T.Vector3(),
  };
});

// eslint-disable-next-line import/first
import {
  rolloutForAIInterception, rolloutToBounceOnAISide,
  createShotAdapter, AI_PADDLE_ID,
} from '../js/ai/shotAdapter.js';
// eslint-disable-next-line import/first
import { ballVelocity, ballAngularVelocity } from '../js/physics/ball.js';

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

describe('rolloutForAIInterception', () => {
  test('produces a result for a canonical mid-table → AI-side return', () => {
    const pos  = new THREE.Vector3(0,    0.30, 0.50);   // above player side
    const vel  = new THREE.Vector3(0.05, 1.4, -3.0);    // toward AI side
    const spin = new THREE.Vector3(0, 0, 0);
    const r = rolloutForAIInterception(pos, vel, spin);
    expect(r).not.toBeNull();
    expect(r.bouncePoint.z).toBeLessThan(0);            // AI side
    expect(r.bounceTimeMs).toBeGreaterThan(0);
    expect(r.contactTimeMs).toBeGreaterThan(r.bounceTimeMs);
    expect(r.contactPoint.y).toBeGreaterThan(0);        // above table after bounce
  });

  test('returns null when ball is moving away from the table (no bounce)', () => {
    const pos  = new THREE.Vector3(0,  0.30, 0.50);
    const vel  = new THREE.Vector3(0, 5.0, 5.0);        // straight up and away
    const spin = new THREE.Vector3(0, 0, 0);
    const r = rolloutForAIInterception(pos, vel, spin);
    expect(r).toBeNull();
  });

  test('determinism: identical inputs produce identical landing across 100 randomized inits', () => {
    const rng = mulberry32(101);
    const inputs = [];
    for (let i = 0; i < 100; i++) {
      inputs.push({
        pos: new THREE.Vector3(rng() * 0.6 - 0.3, 0.20 + rng() * 0.4, 0.3 + rng() * 0.5),
        vel: new THREE.Vector3((rng() - 0.5) * 1.0, 0.5 + rng() * 2.0, -2.0 - rng() * 4.0),
        spin: new THREE.Vector3((rng() - 0.5) * 50, 0, 0),
      });
    }
    // Run twice, compare.
    const passA = inputs.map(i => rolloutForAIInterception(i.pos, i.vel, i.spin));
    const passB = inputs.map(i => rolloutForAIInterception(i.pos, i.vel, i.spin));
    for (let i = 0; i < inputs.length; i++) {
      if (passA[i] === null) {
        expect(passB[i]).toBeNull();
      } else {
        expect(passA[i].bouncePoint.x).toBeCloseTo(passB[i].bouncePoint.x, 10);
        expect(passA[i].bouncePoint.z).toBeCloseTo(passB[i].bouncePoint.z, 10);
        expect(passA[i].bounceTimeMs).toBeCloseTo(passB[i].bounceTimeMs, 10);
        expect(passA[i].contactPoint.x).toBeCloseTo(passB[i].contactPoint.x, 10);
        expect(passA[i].contactPoint.z).toBeCloseTo(passB[i].contactPoint.z, 10);
      }
    }
  });

  test('does NOT mutate the input vectors (pure function)', () => {
    const pos  = new THREE.Vector3(0,    0.30, 0.50);
    const vel  = new THREE.Vector3(0.05, 1.4, -3.0);
    const spin = new THREE.Vector3(0, 0, 0);
    const posCopy  = pos.clone();
    const velCopy  = vel.clone();
    const spinCopy = spin.clone();
    rolloutForAIInterception(pos, vel, spin);
    expect(pos.equals(posCopy)).toBe(true);
    expect(vel.equals(velCopy)).toBe(true);
    expect(spin.equals(spinCopy)).toBe(true);
  });

  test('rolloutToBounceOnAISide wrapper returns just the bounce', () => {
    const pos  = new THREE.Vector3(0,    0.30, 0.50);
    const vel  = new THREE.Vector3(0.05, 1.4, -3.0);
    const spin = new THREE.Vector3(0, 0, 0);
    const r = rolloutToBounceOnAISide(pos, vel, spin);
    expect(r).not.toBeNull();
    expect(typeof r.x).toBe('number');
    expect(typeof r.z).toBe('number');
    expect(typeof r.t_ms).toBe('number');
    expect(r.z).toBeLessThan(0); // AI side
  });

  test('bounce point is on AI side (z < 0 with tableCenterZ=0 in mock)', () => {
    const rng = mulberry32(202);
    let onAISide = 0;
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const r = rolloutForAIInterception(
        new THREE.Vector3((rng() - 0.5) * 0.6, 0.30, 0.4 + rng() * 0.6),
        new THREE.Vector3((rng() - 0.5) * 0.6, 1.0 + rng() * 1.5, -2.5 - rng() * 3.0),
        new THREE.Vector3(0, 0, 0),
      );
      if (r) {
        total += 1;
        if (r.bouncePoint.z < 0) onAISide += 1;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(onAISide).toBe(total); // every recorded bounce is on AI side
  });
});

// The learning contract: one history record = one AI shot placement plus how
// the player coped with it. These tests pin the pairing, because getting it
// wrong is silent — the Voronoi pipeline happily consumes garbage seeds and
// the AI just aims badly.
//
// Mock table has tableCenterZ = 0, so AI side is z < 0 and player side z > 0.
describe('createShotAdapter — history record pairing', () => {
  function harness() {
    const posted = [];
    const handlers = {};
    const ballEvents = {
      onPaddleHit:   fn => { handlers.paddleHit = fn; },
      onTableBounce: fn => { handlers.tableBounce = fn; },
      onBallLost:    fn => { handlers.ballLost = fn; },
    };
    const worker = { postMessage: m => posted.push(m.payload) };
    const adapter = createShotAdapter({ worker, ballEvents });
    return {
      adapter, posted,
      aiHit:      () => handlers.paddleHit({ origin: AI_PADDLE_ID }),
      playerHit:  () => handlers.paddleHit({ origin: 'player' }),
      bounce:     (x, z) => handlers.tableBounce({ x, z, impactSpeed: 2 }),
      ballLost:   () => handlers.ballLost({}),
    };
  }

  test('AI shot landing on the player half opens a record at that landing', () => {
    const h = harness();
    h.aiHit();
    h.bounce(0.42, 1.10);
    expect(h.posted).toHaveLength(1);
    const [, , landingX, landingZ, success] = h.posted[0];
    expect(landingX).toBeCloseTo(0.42, 6);
    expect(landingZ).toBeCloseTo(1.10, 6); // |z - centerZ|, centerZ = 0
    expect(success).toBe(0);               // placeholder until resolved
  });

  test('player returning it back-fills success=1 under the same shot_id', () => {
    const h = harness();
    ballVelocity.set(0, 0, -7.5);
    ballAngularVelocity.set(0, 0, 4 * Math.PI); // 2 rps
    h.aiHit();
    h.bounce(-0.3, 0.8);
    h.playerHit();

    expect(h.posted).toHaveLength(2);
    const [open, resolved] = h.posted;
    expect(resolved[0]).toBe(open[0]); // same shot_id → in-place update
    expect(resolved[4]).toBe(1);
    expect(resolved[6]).toBeCloseTo(7.5, 6); // ball speed the player faced
    expect(resolved[7]).toBeCloseTo(2.0, 6); // spin rps
  });

  test('player never reaching it resolves the record as a miss', () => {
    const h = harness();
    h.aiHit();
    h.bounce(0.6, 1.2);
    h.ballLost();

    expect(h.posted).toHaveLength(2);
    expect(h.posted[1][0]).toBe(h.posted[0][0]);
    expect(h.posted[1][4]).toBe(0);
  });

  test('a player serve produces no record — no AI shot to attribute it to', () => {
    const h = harness();
    h.bounce(0.2, 0.9); // serve bouncing, no preceding AI hit
    h.playerHit();
    expect(h.posted).toHaveLength(0);
  });

  test('an AI-side bounce is not mistaken for the landing', () => {
    const h = harness();
    h.aiHit();
    h.bounce(0.1, -0.5);  // net clip / own-half bounce — ignored
    expect(h.posted).toHaveLength(0);
    h.bounce(0.1, 0.95);  // the real landing
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0][3]).toBeCloseTo(0.95, 6);
  });

  test('a double bounce on the player half only opens one record', () => {
    const h = harness();
    h.aiHit();
    h.bounce(0.5, 1.0);
    h.bounce(0.55, 1.3); // second bounce — player already lost the point
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0][3]).toBeCloseTo(1.0, 6);
  });

  test('landings accumulate across a rally with distinct shot_ids', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.aiHit();
      h.bounce(0.1 * i, 0.9);
      h.playerHit();
    }
    const opens = h.posted.filter(p => p[4] === 0);
    const ids = new Set(opens.map(p => p[0]));
    expect(opens).toHaveLength(3);
    expect(ids.size).toBe(3);
  });
});
