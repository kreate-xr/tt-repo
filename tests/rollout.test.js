// Shared forward-integration primitives (js/physics/rollout.js).
//
// These tests exist because the app used to carry THREE copies of this
// integration — in shotAdapter, paddleSolver and trajectoryPreview — and all
// three had silently drifted from the live physics in ball.js. Two of the
// assertions below pin the specific terms that were missing; the last one is
// a source-level guard against the duplication coming back.
//
// rollout.js takes its table geometry via `env` and imports nothing from the
// scene graph, so it can be exercised directly here rather than through a
// hand-copied mirror of the logic.

const THREE = require('three');

import {
  integrateFlightStep, applyTableBounce, isTableBounce,
  rolloutToFirstBounce, DT_PRESETS,
} from '../js/physics/rollout.js';
import {
  GRAVITY, BUOYANCY_ACCEL, MAGNUS_COEFFICIENT, MAGNUS_VERTICAL_SCALE,
  SPIN_DAMPING, TABLE_SIDESPIN_KICK, TABLE_LINEAR_FRICTION,
  applyDragStep, tableRestitution,
} from '../js/physics/constants.js';

const ballRadius = 0.02;
const tableSurfaceY = 0.76;
const env = {
  ballRadius,
  tableSurfaceY,
  tableBox: {
    min: { x: -0.7625, z: -1.37 },
    max: { x:  0.7625, z:  1.37 },
  },
};

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// The integration as the three predictive callers ran it BEFORE consolidation:
// gravity without buoyancy. Kept here as the explicit "what was wrong" baseline
// so the buoyancy assertion below measures a real difference rather than
// restating the implementation.
function legacyFlightStep(pos, vel, spin, dt) {
  vel.y += GRAVITY * dt;
  if (spin.lengthSq() > 1e-4) {
    const m = new THREE.Vector3().crossVectors(spin, vel);
    m.y *= MAGNUS_VERTICAL_SCALE;
    vel.addScaledVector(m, MAGNUS_COEFFICIENT * dt);
    spin.multiplyScalar(Math.exp(-SPIN_DAMPING * dt));
  }
  applyDragStep(vel, dt);
  pos.addScaledVector(vel, dt);
}

describe('flight integration', () => {
  test('includes buoyancy, which the old predictive rollouts omitted', () => {
    const dt = 0.005;
    const steps = 120; // 0.6 s — a typical feed flight time

    const p = v3(0, 1.0, 0), v = v3(0, 0, 4), w = v3(0, 0, 0);
    const lp = v3(0, 1.0, 0), lv = v3(0, 0, 4), lw = v3(0, 0, 0);
    for (let i = 0; i < steps; i++) {
      integrateFlightStep(p, v, w, dt);
      legacyFlightStep(lp, lv, lw, dt);
    }

    // Buoyancy is a small UPWARD acceleration, so the shared step must leave
    // the ball higher and falling more slowly than the legacy one.
    expect(v.y).toBeGreaterThan(lv.y);
    expect(p.y).toBeGreaterThan(lp.y);

    // Drag-free the gap would be Δv_y = BUOYANCY_ACCEL · t. Drag couples the
    // two paths — the buoyant ball is marginally faster, so it bleeds slightly
    // more — which lands the real gap at ~75% of that. Bounded rather than
    // pinned: the point is the term is present and the right size, not a
    // frozen number that re-derives the implementation.
    const t = steps * dt;
    const dragFreeGap = BUOYANCY_ACCEL * t;
    expect(v.y - lv.y).toBeGreaterThan(dragFreeGap * 0.5);
    expect(v.y - lv.y).toBeLessThanOrEqual(dragFreeGap);

    // The systematic height error the old rollouts carried, at a typical feed
    // flight time. Larger than the 2 cm placement tolerance a ball machine
    // needs, which is why this had to be fixed before building one.
    expect(p.y - lp.y).toBeGreaterThan(0.015);
  });

  test('skips the Magnus term below the spin epsilon', () => {
    // A ball with negligible spin must integrate as pure ballistics + drag,
    // no lateral deflection from a near-zero cross product.
    const p = v3(0, 1.0, 0), v = v3(0, 0, 4), w = v3(0, 0.001, 0);
    for (let i = 0; i < 50; i++) integrateFlightStep(p, v, w, 0.005);
    expect(Math.abs(p.x)).toBeLessThan(1e-9);
  });

  test('topspin dives and backspin floats relative to no spin', () => {
    // Ball travelling in +Z. Topspin about +X drops it faster; backspin about
    // −X holds it up. This is the arc players read spin from, so a preview
    // that got the sign wrong would teach the wrong lesson.
    const run = (wx) => {
      const p = v3(0, 1.0, 0), v = v3(0, 0, 6), w = v3(wx, 0, 0);
      for (let i = 0; i < 60; i++) integrateFlightStep(p, v, w, 0.005);
      return p.y;
    };
    expect(run(150)).toBeLessThan(run(0));
    expect(run(-150)).toBeGreaterThan(run(0));
  });
});

describe('table bounce response', () => {
  test('evaluates restitution at |v_y| BEFORE the reflection', () => {
    // Order matters: the COR curve is speed-dependent, so reading |v_y| after
    // the reflection would evaluate the curve at the wrong point.
    const vel = v3(0, -3, 2), spin = v3(0, 0, 0);
    const impact = applyTableBounce(vel, spin, ballRadius);
    expect(impact).toBeCloseTo(3, 10);
    expect(vel.y).toBeCloseTo(3 * tableRestitution(3), 10);
  });

  test('applies the sidespin kick, which the old rollouts omitted', () => {
    // Ball moving in +Z with right sidespin (ω_y > 0) must kick toward +X.
    const spun = v3(0, -3, 4), spunW = v3(0, 100, 0);
    applyTableBounce(spun, spunW, ballRadius);

    const flat = v3(0, -3, 4), flatW = v3(0, 0, 0);
    applyTableBounce(flat, flatW, ballRadius);

    expect(spun.x).toBeGreaterThan(flat.x);
    // Derive the expected magnitude from the live constant rather than
    // pinning a number: the kick is ω_y · TABLE_SIDESPIN_KICK at full impact
    // scale (realism pass dropped the constant from 0.010 to 0.002 — the old
    // hard-coded "> 0.5" was that tuning value in disguise).
    expect(spun.x - flat.x).toBeGreaterThan(100 * TABLE_SIDESPIN_KICK * 0.5);
  });

  test('does not fire the sidespin kick on a low-energy hop', () => {
    // Below the impact gate. Without it, each kick is perpendicular to the
    // current heading and a settling ball spirals on the table.
    const vel = v3(0, -0.2, 0.5), spin = v3(0, 100, 0);
    const before = vel.x;
    applyTableBounce(vel, spin, ballRadius);
    expect(vel.x).toBeCloseTo(before, 10);
  });

  test('friction drags the ball along the surface slip direction', () => {
    // Pure topspin (ω about +X) on a ball moving +Z: the contact patch slips
    // backwards, so friction adds forward speed.
    const vel = v3(0, -2, 3), spin = v3(200, 0, 0);
    applyTableBounce(vel, spin, ballRadius);
    expect(vel.z).toBeGreaterThan(3);
    expect(TABLE_LINEAR_FRICTION).toBeGreaterThan(0);
  });

  test('clamps a settled bounce to zero vertical velocity', () => {
    const vel = v3(0, -0.02, 0.1), spin = v3(0, 0, 0);
    applyTableBounce(vel, spin, ballRadius);
    expect(vel.y).toBe(0);
  });

  test('sidespin kick constant is live', () => {
    // If this is ever tuned to 0 the kick assertions above go vacuous.
    expect(TABLE_SIDESPIN_KICK).toBeGreaterThan(0);
  });
});

describe('bounce predicate', () => {
  test('fires only when descending, at the surface, inside the footprint', () => {
    const atSurface = v3(0, tableSurfaceY + ballRadius - 1e-6, 0);
    expect(isTableBounce(atSurface, v3(0, -1, 0), env)).toBe(true);
    // Rising through the surface is the post-bounce frame, not a new bounce.
    expect(isTableBounce(atSurface, v3(0, 1, 0), env)).toBe(false);
    // Above the surface.
    expect(isTableBounce(v3(0, 1.2, 0), v3(0, -1, 0), env)).toBe(false);
    // Past the side edge — off the table, no bounce.
    expect(isTableBounce(v3(1.5, tableSurfaceY, 0), v3(0, -1, 0), env)).toBe(false);
    // Past the end line.
    expect(isTableBounce(v3(0, tableSurfaceY, 2.0), v3(0, -1, 0), env)).toBe(false);
  });

  test('returns false when table geometry has not loaded', () => {
    expect(isTableBounce(v3(0, 0.7, 0), v3(0, -1, 0), { ballRadius, tableSurfaceY, tableBox: null }))
      .toBe(false);
  });
});

describe('rolloutToFirstBounce', () => {
  // A representative feed: launched from behind the far end line toward the
  // player, landing in the far half.
  const start = () => ({ pos: v3(0, 1.05, -1.30), vel: v3(0.1, 0.5, 4.5), spin: v3(0, 0, 0) });

  test('finds a landing inside the table footprint', () => {
    const s = start();
    const hit = rolloutToFirstBounce(s.pos, s.vel, s.spin, env);
    expect(hit).not.toBeNull();
    expect(hit.y).toBe(tableSurfaceY);
    expect(hit.z).toBeGreaterThanOrEqual(env.tableBox.min.z);
    expect(hit.z).toBeLessThanOrEqual(env.tableBox.max.z);
    expect(hit.t_ms).toBeGreaterThan(0);
  });

  test('does not mutate its inputs', () => {
    const s = start();
    rolloutToFirstBounce(s.pos, s.vel, s.spin, env);
    expect(s.pos.toArray()).toEqual([0, 1.05, -1.30]);
    expect(s.vel.toArray()).toEqual([0.1, 0.5, 4.5]);
  });

  test('step size is a sampling choice, not a physics choice', () => {
    // The three callers integrate at different dt for their own latency
    // budgets. If that choice moved the predicted landing appreciably, the
    // "one physics" property would be nominal only.
    const landings = [DT_PRESETS.VERIFY, DT_PRESETS.INTERCEPT, DT_PRESETS.PREVIEW]
      .map((dt) => {
        const s = start();
        return rolloutToFirstBounce(s.pos, s.vel, s.spin, env, { dt, maxSteps: 4000 });
      });
    for (const l of landings) expect(l).not.toBeNull();

    const zs = landings.map(l => l.z);
    const xs = landings.map(l => l.x);
    // rolloutToFirstBounce reports the first discrete step at/below the
    // surface (no interpolation — see rolloutToSurfacePlane for the
    // interpolating variant), so cross-preset agreement is bounded by one
    // PREVIEW step of horizontal travel: ~4.5 m/s × 22 ms ≈ 10 cm worst
    // case, ~4-5 cm typical. Earth-real gravity (realism pass) lengthened
    // this arc's flight vs the old -12 tuning, which moved the phase of the
    // final step; 5 cm holds comfortably where the old 3 cm was luck.
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.05);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.05);
  });

  test('returns null when the ball never reaches the table', () => {
    // Fired away from the table and upward — falls to the floor off the side.
    const hit = rolloutToFirstBounce(v3(3, 1.0, 0), v3(4, 0, 0), v3(0, 0, 0), env);
    expect(hit).toBeNull();
  });

  test('returns null when the step ceiling is exhausted', () => {
    const s = start();
    expect(rolloutToFirstBounce(s.pos, s.vel, s.spin, env, { maxSteps: 3 })).toBeNull();
  });

  test('without netBox: netClearance null, clearedNet true (back-compat)', () => {
    const s = start();
    const hit = rolloutToFirstBounce(s.pos, s.vel, s.spin, env);
    expect(hit.netClearance).toBeNull();
    expect(hit.clearedNet).toBe(true);
  });

  test('with netBox: reports interpolated clearance over the net plane', () => {
    // Regulation cord top: 15.25 cm above the surface, net at table center.
    const netTopY = tableSurfaceY + 0.1525;
    const withNet = {
      ...env,
      netBox: {
        min: { x: -0.9, y: tableSurfaceY, z: -0.005 },
        max: { x:  0.9, y: netTopY,       z:  0.005 },
      },
    };
    // A clearly lofted arc — apex well above the cord at the crossing.
    const hit = rolloutToFirstBounce(
      v3(0, 1.2, -1.3), v3(0, 2.0, 3.5), v3(0, 0, 0), withNet,
    );
    expect(hit).not.toBeNull();
    expect(hit.netClearance).not.toBeNull();
    expect(hit.clearedNet).toBe(true);
    expect(hit.netClearance).toBeGreaterThan(0);

    // A flat dart from below the cord toward the far side must report a
    // NEGATIVE clearance — this ball would be in the net live, and this
    // field is what lets the paddle solver see that.
    const low = rolloutToFirstBounce(
      v3(0, tableSurfaceY + 0.08, -0.6), v3(0, 0.2, 6.0), v3(0, 0, 0), withNet,
    );
    expect(low).not.toBeNull();
    expect(low.netClearance).toBeLessThan(0);
    expect(low.clearedNet).toBe(false);
  });
});

describe('single source of physics', () => {
  // The regression this whole module exists to prevent: a caller re-deriving
  // the flight integration locally, which then drifts from ball.js. Anything
  // that needs to step a ball forward must go through rollout.js.
  const fs = require('fs');
  const path = require('path');

  const JS_ROOT = path.join(__dirname, '..', 'js');
  // ball.js is the live physics — the definition rollout.js mirrors.
  // rollout.js is the shared predictive copy. No third site is allowed.
  const ALLOWED = new Set([
    path.join('physics', 'ball.js'),
    path.join('physics', 'rollout.js'),
    path.join('physics', 'constants.js'),   // declares the constant
    path.join('scene', 'physicsTuner.js'),  // tuner UI: reads/writes it as a
                                            // live parameter, does not integrate
    path.join('physics', 'physicsParams.js'), // tuner row metadata: same
                                              // read/write-as-parameter role
  ]);

  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  test('no module outside physics/ integrates Magnus itself', () => {
    const offenders = walk(JS_ROOT)
      .filter((file) => {
        const rel = path.relative(JS_ROOT, file);
        if (ALLOWED.has(rel)) return false;
        const src = fs.readFileSync(file, 'utf8');
        // Strip comments so prose discussing the term (paddleSolver has a long
        // note on why pass 1 stays gravity-only) doesn't read as a violation.
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        return code.includes('MAGNUS_COEFFICIENT');
      })
      .map((f) => path.relative(JS_ROOT, f));

    expect(offenders).toEqual([]);
  });
});
