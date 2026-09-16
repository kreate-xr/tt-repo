// M1 Ball Machine — FeedEngine.
//
// The headline clause is TEST M1: "500 feeds per preset land within 2 cm of
// commanded scatter distribution (χ² fit)". That is really two claims, and
// they are tested separately here:
//   1. ACCURACY  — each feed lands where it was commanded (≤ 2 cm).
//   2. SCATTER   — the commanded points themselves follow the configured
//                  gaussian σ, verified by a χ² goodness-of-fit test.
//
// Everything runs headless: feedEngine.js imports no scene module, so the
// table geometry is injected. These are real ITTF dimensions (2.74 × 1.525 m,
// net 15.25 cm) rather than arbitrary numbers, so a failure here means a
// failure on the real table.

const THREE = require('three');

const {
  solveFeed, solveElevation, zoneTarget, originPosition, applyScatter,
  FeedEngine,
} = require('../js/modes/training/feedEngine.js');
const {
  defaultConfig, validateConfig, INFINITE, ARC_NET_CLEARANCE, SPIN_MAX_RAD_S,
  zoneForDepth,
} = require('../js/modes/training/drillConfig.js');
const { mulberry32 } = require('../js/util/rng.js');
const { rolloutToFirstBounce } = require('../js/physics/rollout.js');

// ITTF table: 2.74 m long, 1.525 m wide, net 15.25 cm above the surface.
// Player half is +z; the machine sits at -z, matching models.js and the
// existing feeder.
const HALF_LEN = 1.37;
const HALF_WID = 0.7625;
const NET_H = 0.1525;

const env = {
  ballRadius: 0.02,
  tableSurfaceY: 0,
  tableBox: new THREE.Box3(
    new THREE.Vector3(-HALF_WID, -0.001, -HALF_LEN),
    new THREE.Vector3(HALF_WID, 0.001, HALF_LEN),
  ),
  netBox: new THREE.Box3(
    new THREE.Vector3(-HALF_WID - 0.14, 0, -0.005),
    new THREE.Vector3(HALF_WID + 0.14, NET_H, 0.005),
  ),
};

// The zone is authoritative for the landing row, so a test that asks for a
// depth band without naming a zone gets the centre-column zone of that band —
// preserving the intent of the many `depth: 'deep'`-style cases below.
const cfg = (over = {}) => {
  const merged = { ...defaultConfig(), ...over };
  if (over.depth && !over.placement) {
    merged.placement = { kind: 'zone', zone: zoneForDepth(over.depth) };
  }
  return validateConfig(merged);
};

describe('geometry', () => {
  test('the default zone-5 target sits on the player half', () => {
    const t = zoneTarget(cfg({}), env);
    expect(t.z).toBeGreaterThan(0);
    expect(t.z).toBeLessThan(HALF_LEN);
    expect(Math.abs(t.x)).toBeLessThan(HALF_WID);
  });

  test('the zone row controls z, near-net rows landing shorter', () => {
    // Same column, three rows → same x, increasing z.
    const short = zoneTarget(cfg({ placement: { kind: 'zone', zone: 2 } }), env);
    const half = zoneTarget(cfg({ placement: { kind: 'zone', zone: 5 } }), env);
    const deep = zoneTarget(cfg({ placement: { kind: 'zone', zone: 8 } }), env);
    expect(short.x).toBeCloseTo(half.x, 6);
    expect(half.x).toBeCloseTo(deep.x, 6);
    expect(short.z).toBeLessThan(half.z);
    expect(half.z).toBeLessThan(deep.z);
  });

  test('depth alone does not move the target — the zone is authoritative', () => {
    const a = zoneTarget(validateConfig({ ...defaultConfig(), depth: 'short' }), env);
    const b = zoneTarget(validateConfig({ ...defaultConfig(), depth: 'deep' }), env);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.z).toBeCloseTo(b.z, 6);
  });

  test('zone column controls x independently of depth', () => {
    const left = zoneTarget(cfg({ placement: { kind: 'zone', zone: 4 } }), env);
    const mid = zoneTarget(cfg({ placement: { kind: 'zone', zone: 5 } }), env);
    const right = zoneTarget(cfg({ placement: { kind: 'zone', zone: 6 } }), env);
    expect(left.x).toBeLessThan(mid.x);
    expect(mid.x).toBeLessThan(right.x);
    expect(left.z).toBeCloseTo(right.z, 6);
  });

  test('all nine zones land on the table', () => {
    for (let zone = 1; zone <= 9; zone++) {
      const t = zoneTarget(cfg({ placement: { kind: 'zone', zone } }), env);
      expect(Math.abs(t.x)).toBeLessThan(HALF_WID);
      expect(t.z).toBeGreaterThan(0);
      expect(t.z).toBeLessThan(HALF_LEN);
    }
  });

  test('a free point outside the player half is clamped into it', () => {
    const t = zoneTarget(cfg({ placement: { kind: 'free', x: 99, z: -99 } }), env);
    expect(t.x).toBeLessThanOrEqual(HALF_WID);
    expect(t.z).toBeGreaterThan(0); // pulled onto the player's side of the net
  });

  test('feed origins differ in the ways M1 describes', () => {
    const cL = originPosition(cfg({ feedOrigin: 'L-far' }), env);
    const cR = originPosition(cfg({ feedOrigin: 'R-far' }), env);
    const near = originPosition(cfg({ feedOrigin: 'center-near' }), env);
    const far = originPosition(cfg({ feedOrigin: 'center-far' }), env);
    expect(cL.x).toBeLessThan(cR.x);            // L/R shift laterally
    expect(far.z).toBeLessThan(near.z);         // far sits further back
    expect(near.y).toBeCloseTo(far.y, 6);
  });
});

describe('scatter', () => {
  test('zero sigma produces no jitter', () => {
    const rng = mulberry32(1);
    const base = zoneTarget(cfg({}), env);
    const jittered = applyScatter(base.clone(), 0, rng, env);
    expect(jittered.x).toBeCloseTo(base.x, 9);
    expect(jittered.z).toBeCloseTo(base.z, 9);
  });

  test('scatter is reproducible for a given seed', () => {
    const a = applyScatter(zoneTarget(cfg({}), env), 0.1, mulberry32(7), env);
    const b = applyScatter(zoneTarget(cfg({}), env), 0.1, mulberry32(7), env);
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.z).toBeCloseTo(b.z, 12);
  });

  test('scattered points stay on the player half even at max sigma', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      const t = applyScatter(zoneTarget(cfg({ depth: 'deep' }), env), 0.4, rng, env);
      expect(Math.abs(t.x)).toBeLessThanOrEqual(HALF_WID);
      expect(t.z).toBeGreaterThan(0);
      expect(t.z).toBeLessThanOrEqual(HALF_LEN);
    }
  });
});

describe('elevation solver', () => {
  test('finds an angle that reaches the commanded range', () => {
    const spawn = originPosition(cfg({}), env);
    const dir = new THREE.Vector3(0, 0, 1);
    const spin = new THREE.Vector3();
    const range = 2.0;
    const { theta, feasible } = solveElevation(spawn, dir, 8, spin, range, env, 'low');
    expect(feasible).toBe(true);

    const vel = dir.clone().multiplyScalar(8 * Math.cos(theta));
    vel.y = 8 * Math.sin(theta);
    const r = require('../js/physics/rollout.js')
      .rolloutToSurfacePlane(spawn, vel, spin, env, { dt: 0.003 });
    expect(r.z - spawn.z).toBeCloseTo(range, 1);
  });

  test('the high branch flies higher than the low branch to the same point', () => {
    const spawn = originPosition(cfg({}), env);
    const dir = new THREE.Vector3(0, 0, 1);
    const spin = new THREE.Vector3();
    const low = solveElevation(spawn, dir, 8, spin, 2.0, env, 'low');
    const high = solveElevation(spawn, dir, 8, spin, 2.0, env, 'high');
    expect(high.theta).toBeGreaterThan(low.theta);
  });

  test('an unreachable target reports infeasible rather than throwing', () => {
    const spawn = originPosition(cfg({}), env);
    const dir = new THREE.Vector3(0, 0, 1);
    // 2 m/s cannot carry a ball 5 m.
    const sol = solveElevation(spawn, dir, 2, new THREE.Vector3(), 5.0, env, 'low');
    expect(sol.feasible).toBe(false);
    expect(Number.isFinite(sol.theta)).toBe(true);
  });
});

describe('feed solving — accuracy', () => {
  test('a default feed lands within 2 cm of its commanded point', () => {
    const feed = solveFeed(cfg({ scatterSigma: 0 }), env, { rng: mulberry32(1) });
    expect(feed.verifiedLanding).not.toBeNull();
    expect(feed.errorM).toBeLessThan(0.02);
    expect(feed.onTable).toBe(true);
    expect(feed.clearedNet).toBe(true);
  });

  test('the launch speed equals the commanded speed', () => {
    // M1 defines `speed` as post-contact ball speed, so |v| at spawn must be
    // exactly the commanded value — the solver may only choose DIRECTION.
    for (const speed of [4, 8, 12, 18]) {
      const feed = solveFeed(cfg({ speed, scatterSigma: 0 }), env, { rng: mulberry32(2) });
      expect(feed.velocity.length()).toBeCloseTo(speed, 6);
    }
  });

  test('accuracy holds across every zone', () => {
    for (let zone = 1; zone <= 9; zone++) {
      const feed = solveFeed(
        cfg({ placement: { kind: 'zone', zone }, scatterSigma: 0 }),
        env, { rng: mulberry32(zone) },
      );
      expect(feed.errorM).toBeLessThan(0.02);
      expect(feed.onTable).toBe(true);
    }
  });

  test('accuracy holds across every spin type at full magnitude', () => {
    // Sidespin is the hard case: Magnus curves the ball off the aim line, so
    // this is what the aim-correction loop exists for.
    for (const spinType of ['none', 'top', 'back', 'side-L', 'side-R']) {
      const feed = solveFeed(
        cfg({ spinType, spinMagnitude: SPIN_MAX_RAD_S, scatterSigma: 0 }),
        env, { rng: mulberry32(5) },
      );
      expect(feed.errorM).toBeLessThan(0.02);
      expect(feed.onTable).toBe(true);
    }
  });

  // THE CORE CONTRACT.
  //
  // Not every (speed, depth, origin) combination is physically makeable — a
  // 5 m/s feed cannot cross 2.9 m of table (vacuum max range at 45° is
  // v²/g = 2.55 m), and nothing lands 23 cm past the net at 15 m/s. The
  // machine's obligation is therefore not "always succeed", it is: succeed
  // accurately, or say so. A feed marked feasible must be right.
  const assertContract = (feed) => {
    if (feed.feasible) {
      expect(feed.errorM).toBeLessThan(0.02);
      expect(feed.clearedNet).toBe(true);
      expect(feed.onTable).toBe(true);
    }
  };

  test('every feasible depth × origin feed is accurate', () => {
    for (const depth of ['short', 'half-long', 'deep']) {
      for (const feedOrigin of ['L-far', 'center-near', 'R-far']) {
        assertContract(solveFeed(cfg({ depth, feedOrigin, scatterSigma: 0 }), env,
          { rng: mulberry32(9) }));
      }
    }
  });

  test('the ordinary depth × origin combinations ARE feasible', () => {
    // Guards the contract above from being satisfied vacuously by an engine
    // that simply declares everything infeasible.
    for (const depth of ['half-long', 'deep']) {
      for (const feedOrigin of ['L-far', 'center-near', 'R-far']) {
        const feed = solveFeed(cfg({ depth, feedOrigin, scatterSigma: 0 }), env,
          { rng: mulberry32(9) });
        expect(feed.feasible).toBe(true);
        expect(feed.errorM).toBeLessThan(0.02);
      }
    }
  });

  test('a feed is never reported feasible while its own verification fails', () => {
    // Regression: feasibility was judged on the SEED trajectory, before Newton
    // refined the angles. That produced feeds marked feasible whose measured
    // net clearance was -0.004 m — a net ball the engine called good.
    for (const depth of ['short', 'half-long', 'deep']) {
      for (const speed of [3, 5, 8, 12, 15, 20]) {
        for (const feedOrigin of ['L-far', 'center-near', 'R-far']) {
          const feed = solveFeed(cfg({ depth, speed, feedOrigin, scatterSigma: 0 }),
            env, { rng: mulberry32(101) });
          if (feed.feasible) {
            expect(feed.clearedNet).toBe(true);
            expect(feed.onTable).toBe(true);
            expect(feed.errorM).toBeLessThan(0.02);
          }
        }
      }
    }
  });

  test('the verified landing agrees with an independent bounce rollout', () => {
    // Cross-check against rolloutToFirstBounce (the table-bounded predicate)
    // so the reported landing is not an artefact of the plane rollout.
    // rolloutToFirstBounce does NOT interpolate the surface crossing, so the
    // two paths can disagree by up to one VERIFY step of horizontal travel
    // (~4 m/s × 3 ms ≈ 1.2 cm); 1.5 cm covers that bound. The old 1 cm limit
    // sat inside it and only passed on integration phase luck — the realism
    // retune (Earth gravity, physical drag) shifted the phase and exposed it.
    const feed = solveFeed(cfg({ scatterSigma: 0 }), env, { rng: mulberry32(11) });
    const bounce = rolloutToFirstBounce(feed.spawn, feed.velocity, feed.spin, env);
    expect(bounce).not.toBeNull();
    expect(Math.hypot(bounce.x - feed.verifiedLanding.x, bounce.z - feed.verifiedLanding.z))
      .toBeLessThan(0.015);
  });

  test('feasible feeds clear the net', () => {
    for (const depth of ['half-long', 'deep']) {
      for (const speed of [9, 15]) {
        const feed = solveFeed(cfg({ depth, speed, scatterSigma: 0 }), env,
          { rng: mulberry32(13) });
        expect(feed.feasible).toBe(true);
        expect(feed.clearedNet).toBe(true);
        expect(feed.netClearance).toBeGreaterThan(0);
      }
    }
  });

  test('a short feed is a lob: the flat arc cannot clear the net, the lofted one lands it', () => {
    // Physical, not incidental: landing 23 cm past a 15.25 cm net means
    // descending steeply just after the net. At 8 m/s the flattest arc that
    // reaches the point crosses the net BELOW the cord from the near origin,
    // so the solver must take the lofted branch — which, at the physical
    // drag and Magnus, converges from either origin. (Under the old 1.8×
    // loop-spin Magnus the 375 rad/s topspin default bent the near-vertical
    // lob enough that the near origin was refused outright; this test used
    // to pin that refusal.)
    for (const feedOrigin of ['L-far', 'center-near']) {
      const feed = solveFeed(cfg({ depth: 'short', feedOrigin, scatterSigma: 0 }),
        env, { rng: mulberry32(9) });
      expect(feed.feasible).toBe(true);
      expect(feed.errorM).toBeLessThan(0.02);
      // Lofted: it clears the cord by far more than any driven feed could.
      expect(feed.netClearance).toBeGreaterThan(0.5);
    }

    // And the reason it lofts: the low branch from the near origin, aimed
    // straight at the same point with the same spin, goes into the net.
    const near = solveFeed(cfg({ depth: 'short', feedOrigin: 'center-near', scatterSigma: 0 }),
      env, { rng: mulberry32(9) });
    const dir = near.commandedLanding.clone().sub(near.spawn);
    dir.y = 0;
    const range = dir.length();
    dir.normalize();
    const low = solveElevation(near.spawn, dir, near.config.speed, near.spin, range, env, 'low');
    expect(low.feasible).toBe(true);
    const vel = dir.clone().multiplyScalar(near.config.speed * Math.cos(low.theta))
      .addScaledVector(new THREE.Vector3(0, 1, 0), near.config.speed * Math.sin(low.theta));
    const flat = rolloutToFirstBounce(near.spawn, vel, near.spin.clone(), env);
    expect(flat).not.toBeNull();
    expect(flat.netClearance).toBeLessThanOrEqual(0);
  });

  // Reported from the headset: "if I slow the speed the ball is not coming to
  // the player — it pitches on the machine's side and doesn't cross over."
  describe('low speed still puts the ball on the player side', () => {
    const SLOW = [3, 4, 5, 6, 7];

    test('a slow feed at a deep target lands past the net, not short', () => {
      for (const speed of SLOW) {
        const feed = solveFeed(cfg({ speed, depth: 'deep', scatterSigma: 0 }), env,
          { rng: mulberry32(4242) });
        if (!feed.feasible) continue;   // too slow to clear the net at all
        // The player's half is +z; landing at negative z is the machine's own
        // court, which is precisely the reported failure.
        expect(feed.verifiedLanding.z).toBeGreaterThan(0);
        expect(feed.clearedNet).toBe(true);
        expect(feed.onTable).toBe(true);
      }
    });

    test('an out-of-reach target is pulled in rather than fired short', () => {
      const feed = solveFeed(cfg({ speed: 5, depth: 'deep', feedOrigin: 'center-far', scatterSigma: 0 }),
        env, { rng: mulberry32(1) });
      if (feed.reachClamped) {
        expect(feed.feasible).toBe(true);
        expect(feed.verifiedLanding.z).toBeGreaterThan(0);
        // It landed shorter than asked, but it DID arrive.
        expect(feed.commandedLanding.z).toBeLessThan(feed.requestedLanding.z);
      }
    });

    test('a clamped feed still lands accurately on its adjusted target', () => {
      for (const speed of SLOW) {
        const feed = solveFeed(cfg({ speed, depth: 'deep', scatterSigma: 0 }), env,
          { rng: mulberry32(7) });
        if (feed.feasible) expect(feed.errorM).toBeLessThan(0.02);
      }
    });

    test('speed still controls pace — a slower feed is not silently sped up', () => {
      for (const speed of SLOW) {
        const feed = solveFeed(cfg({ speed, depth: 'deep', scatterSigma: 0 }), env,
          { rng: mulberry32(9) });
        expect(feed.velocity.length()).toBeCloseTo(speed, 6);
      }
    });

    test('the clamp reports what was requested so the UI can say so', () => {
      const feed = solveFeed(cfg({ speed: 4, depth: 'deep', scatterSigma: 0 }), env,
        { rng: mulberry32(11) });
      expect(feed.requestedLanding).toBeTruthy();
      expect(typeof feed.reachClamped).toBe('boolean');
      expect(feed.maxReachM).toBeGreaterThan(0);
    });

    test('spin changes the reachable range, since Magnus scales with speed', () => {
      // Not a separate knob: a = k·ω×v, so topspin shortens reach at a given
      // speed and backspin extends it. Measuring reach with the ACTUAL spin
      // is what keeps the clamp correct across spin types.
      const reach = (spinType) => solveFeed(
        cfg({ speed: 5, spinType, spinMagnitude: 350, depth: 'deep', scatterSigma: 0 }),
        env, { rng: mulberry32(13) },
      ).maxReachM;
      expect(reach('back')).toBeGreaterThan(reach('top'));
    });
  });

  test('an unreachably slow feed is flagged rather than silently missing', () => {
    // 2 m/s from behind the far end line cannot reach a deep target.
    const feed = solveFeed(cfg({ speed: 2, depth: 'deep', feedOrigin: 'center-far', scatterSigma: 0 }),
      env, { rng: mulberry32(17) });
    expect(feed.feasible).toBe(false);
  });

  test('solveFeed never throws on any valid config combination', () => {
    for (const spinType of ['none', 'top', 'back', 'side-L', 'side-R', 'combo']) {
      for (const arc of ['flat', 'medium', 'lob']) {
        for (const speed of [2, 25]) {
          expect(() => solveFeed(
            cfg({ spinType, arc, speed, spinMagnitude: SPIN_MAX_RAD_S }),
            env, { rng: mulberry32(19) },
          )).not.toThrow();
        }
      }
    }
  });
});

describe('arc selection', () => {
  test('lob clears the net by more than flat at the same speed and target', () => {
    const base = { speed: 9, scatterSigma: 0, spinType: 'none' };
    const flat = solveFeed(cfg({ ...base, arc: 'flat' }), env, { rng: mulberry32(23) });
    const lob = solveFeed(cfg({ ...base, arc: 'lob' }), env, { rng: mulberry32(23) });
    expect(lob.netClearance).toBeGreaterThan(flat.netClearance);
  });

  test('a lob still lands on the commanded point', () => {
    const feed = solveFeed(cfg({ arc: 'lob', speed: 9, scatterSigma: 0 }), env,
      { rng: mulberry32(29) });
    expect(feed.errorM).toBeLessThan(0.02);
    expect(feed.onTable).toBe(true);
  });

  test('the achieved clearance is reported, not the requested one', () => {
    // Arc is a preference over the two achievable trajectories, so the
    // reported clearance must be measured rather than echoed back.
    const feed = solveFeed(cfg({ arc: 'flat', speed: 9, scatterSigma: 0 }), env,
      { rng: mulberry32(31) });
    expect(feed.netClearance).not.toBe(ARC_NET_CLEARANCE.flat);
    expect(feed.netClearance).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  test('the same seed reproduces an identical feed', () => {
    const a = solveFeed(cfg({ scatterSigma: 0.1 }), env, { rng: mulberry32(41) });
    const b = solveFeed(cfg({ scatterSigma: 0.1 }), env, { rng: mulberry32(41) });
    expect(a.commandedLanding.x).toBeCloseTo(b.commandedLanding.x, 12);
    expect(a.velocity.x).toBeCloseTo(b.velocity.x, 12);
    expect(a.velocity.y).toBeCloseTo(b.velocity.y, 12);
    expect(a.velocity.z).toBeCloseTo(b.velocity.z, 12);
  });

  test('different seeds produce different scatter', () => {
    const a = solveFeed(cfg({ scatterSigma: 0.1 }), env, { rng: mulberry32(41) });
    const b = solveFeed(cfg({ scatterSigma: 0.1 }), env, { rng: mulberry32(42) });
    expect(a.commandedLanding.x).not.toBeCloseTo(b.commandedLanding.x, 6);
  });
});

// --- TEST M1 ---------------------------------------------------------------

describe('TEST M1: 500 feeds land within 2 cm of the commanded distribution', () => {
  // The six Quick Feed presets, per M1.
  const PRESETS = {
    Warmup:        { speed: 6,  spinType: 'none', spinMagnitude: 0,   interval: 2.5, depth: 'half-long' },
    'FH topspin':   { speed: 9,  spinType: 'top',  spinMagnitude: 300, placement: { kind: 'zone', zone: 9 } },
    'BH topspin':   { speed: 9,  spinType: 'top',  spinMagnitude: 300, placement: { kind: 'zone', zone: 7 } },
    // Short placements need the far origin's longer, more arcing path — see
    // the short-feed test above.
    'Backspin push': { speed: 7, spinType: 'back', spinMagnitude: 275, depth: 'short', arc: 'flat', feedOrigin: 'center-far' },
    'Random light': { speed: 7,  spinType: 'none', spinMagnitude: 0,   scatterSigma: 0.2, placement: { kind: 'zone', zone: 8 } },
    // A smash setup is a ball the PLAYER attacks: high and unhurried, not fast.
    'Smash setup':  { speed: 8,  spinType: 'top',  spinMagnitude: 225, arc: 'lob', depth: 'half-long' },
  };

  for (const [name, over] of Object.entries(PRESETS)) {
    test(`${name}: 500 feeds all land within 2 cm of commanded`, () => {
      const rng = mulberry32(1234);
      const config = cfg({ ...over, burstCount: INFINITE });
      let worst = 0;
      let offTable = 0;
      let netFails = 0;
      let infeasible = 0;

      for (let i = 0; i < 500; i++) {
        const feed = solveFeed(config, env, { rng });
        expect(feed.verifiedLanding).not.toBeNull();
        worst = Math.max(worst, feed.errorM);
        if (!feed.onTable) offTable++;
        if (!feed.clearedNet) netFails++;
        if (!feed.feasible) infeasible++;
      }

      expect(worst).toBeLessThan(0.02);
      expect(offTable).toBe(0);
      expect(netFails).toBe(0);
      // A curated preset must be makeable on every single ball, including at
      // the tails of its own scatter. If this fails the PRESET is wrong — its
      // speed/depth pairing asks for a shot the table geometry forbids — not
      // the solver.
      expect(infeasible).toBe(0);
    }, 60000);
  }

  test('commanded scatter follows the configured gaussian (χ² fit)', () => {
    // χ² goodness-of-fit on the x-axis scatter against the configured σ.
    // Uses 8 equiprobable bins under the normal CDF, so every expected count
    // is N/8 and the statistic is well-conditioned.
    const SIGMA = 0.12;
    const N = 500;
    const rng = mulberry32(2024);
    const config = cfg({ scatterSigma: SIGMA, depth: 'half-long' });
    const center = zoneTarget(config, env);

    const zs = [];
    for (let i = 0; i < N; i++) {
      const feed = solveFeed(config, env, { rng });
      zs.push((feed.commandedLanding.x - center.x) / SIGMA);
    }

    // Equiprobable bin edges in z for 8 bins: the normal quantiles at k/8.
    const edges = [-Infinity, -1.1503, -0.6745, -0.3186, 0, 0.3186, 0.6745, 1.1503, Infinity];
    const bins = new Array(8).fill(0);
    for (const z of zs) {
      for (let b = 0; b < 8; b++) {
        if (z > edges[b] && z <= edges[b + 1]) { bins[b]++; break; }
      }
    }

    const expected = N / 8;
    const chi2 = bins.reduce((acc, o) => acc + ((o - expected) ** 2) / expected, 0);

    // 7 degrees of freedom, critical value 24.32 at p = 0.001. A generous
    // threshold on purpose: this must catch "the distribution is wrong",
    // not flag a healthy generator on an unlucky seed.
    expect(chi2).toBeLessThan(24.32);
    // Every bin should be populated — a dead bin means clamping is eating
    // the tails rather than the σ being honoured.
    for (const count of bins) expect(count).toBeGreaterThan(0);
  }, 60000);

  test('scatter σ actually controls the spread', () => {
    const spread = (sigma) => {
      const rng = mulberry32(555);
      const config = cfg({ scatterSigma: sigma, depth: 'half-long' });
      const xs = [];
      for (let i = 0; i < 200; i++) xs.push(solveFeed(config, env, { rng }).commandedLanding.x);
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
    };
    const tight = spread(0.05);
    const wide = spread(0.25);
    expect(tight).toBeGreaterThan(0.03);
    expect(tight).toBeLessThan(0.07);
    expect(wide).toBeGreaterThan(tight * 2);
  }, 60000);

  // Rapid Fire is a pattern, not a preset, but it is held to the same bar:
  // every ball of its sweep must be makeable across the whole scatter
  // distribution, at a warm-up pace AND run hot. If this fails the PATTERN's
  // step/origin pairing is wrong, not the solver.
  describe('Rapid fire sweep is 100% feasible from every origin', () => {
    const { PATTERNS, buildStepConfig } = require('../js/modes/training/patterns.js');

    for (const speed of [8, 12]) {
      test(`500 feeds cycling the sweep at speed ${speed}`, () => {
        const rng = mulberry32(1234);
        const base = cfg({ speed, scatterSigma: 0.05, burstCount: INFINITE });
        const steps = PATTERNS.rapidFire.steps.map((s) => buildStepConfig(base, s));
        let worst = 0;
        let offTable = 0;
        let netFails = 0;
        let infeasible = 0;

        for (let i = 0; i < 500; i++) {
          const feed = solveFeed(steps[i % steps.length], env, { rng });
          expect(feed.verifiedLanding).not.toBeNull();
          worst = Math.max(worst, feed.errorM);
          if (!feed.onTable) offTable++;
          if (!feed.clearedNet) netFails++;
          if (!feed.feasible) infeasible++;
        }

        expect(worst).toBeLessThan(0.02);
        expect(offTable).toBe(0);
        expect(netFails).toBe(0);
        expect(infeasible).toBe(0);
      }, 60000);
    }
  });
});

describe('FeedEngine scheduling', () => {
  const step = (engine, dt, times) => {
    const feeds = [];
    for (let i = 0; i < times; i++) {
      const f = engine.update(dt);
      if (f) feeds.push(f);
    }
    return feeds;
  };

  test('feeds at roughly the configured interval', () => {
    const engine = new FeedEngine(cfg({ interval: 2.0, burstCount: INFINITE }), env,
      { rng: mulberry32(61) });
    // 10 s at 100 Hz → ~5 feeds after the shorter initial countdown.
    const feeds = step(engine, 0.01, 1000);
    expect(feeds.length).toBeGreaterThanOrEqual(4);
    expect(feeds.length).toBeLessThanOrEqual(6);
  });

  test('stops after the burst count and reports finished', () => {
    const engine = new FeedEngine(cfg({ interval: 1.0, burstCount: 3 }), env,
      { rng: mulberry32(63) });
    const feeds = step(engine, 0.02, 1000);
    expect(feeds).toHaveLength(3);
    expect(engine.finished).toBe(true);
    expect(engine.remaining).toBe(0);
  });

  test('an infinite burst never finishes', () => {
    const engine = new FeedEngine(cfg({ interval: 0.8, burstCount: INFINITE }), env,
      { rng: mulberry32(65) });
    step(engine, 0.05, 400);
    expect(engine.finished).toBe(false);
    expect(engine.remaining).toBe(INFINITE);
  });

  test('pause halts feeding and resume continues it', () => {
    const engine = new FeedEngine(cfg({ interval: 1.0, burstCount: INFINITE }), env,
      { rng: mulberry32(67) });
    engine.pause();
    expect(step(engine, 0.05, 200)).toHaveLength(0);
    engine.resume();
    expect(step(engine, 0.05, 200).length).toBeGreaterThan(0);
  });

  test('the gate holds the next feed until the caller allows it', () => {
    // Replaces the old feeder's inline `ballModel.visible` check — the scene
    // coupling this split exists to remove.
    const engine = new FeedEngine(cfg({ interval: 0.8, burstCount: INFINITE }), env,
      { rng: mulberry32(69) });
    let allow = false;
    for (let i = 0; i < 200; i++) engine.update(0.05, () => allow);
    expect(engine.fedCount).toBe(0);
    allow = true;
    for (let i = 0; i < 100; i++) engine.update(0.05, () => allow);
    expect(engine.fedCount).toBeGreaterThan(0);
  });

  test('the audio cue fires before its feed, once per feed', () => {
    const engine = new FeedEngine(cfg({ interval: 1.5, burstCount: 3, audioCue: true }), env,
      { rng: mulberry32(71) });
    let cues = 0;
    let feeds = 0;
    engine.onCue(() => { cues++; });
    engine.onFeed(() => { feeds++; });
    for (let i = 0; i < 2000; i++) engine.update(0.01);
    expect(feeds).toBe(3);
    expect(cues).toBe(3);
  });

  test('no cue fires when the cue is disabled', () => {
    const engine = new FeedEngine(cfg({ interval: 1.0, burstCount: 2, audioCue: false }), env,
      { rng: mulberry32(73) });
    let cues = 0;
    engine.onCue(() => { cues++; });
    for (let i = 0; i < 1000; i++) engine.update(0.01);
    expect(cues).toBe(0);
  });

  test('reset restarts the burst', () => {
    const engine = new FeedEngine(cfg({ interval: 0.8, burstCount: 2 }), env,
      { rng: mulberry32(75) });
    step(engine, 0.05, 200);
    expect(engine.finished).toBe(true);
    engine.reset();
    expect(engine.fedCount).toBe(0);
    expect(engine.finished).toBe(false);
    expect(step(engine, 0.05, 200)).toHaveLength(2);
  });

  test('feeds carry an increasing index', () => {
    const engine = new FeedEngine(cfg({ interval: 0.8, burstCount: 4 }), env,
      { rng: mulberry32(77) });
    const feeds = step(engine, 0.05, 400);
    expect(feeds.map((f) => f.index)).toEqual([1, 2, 3, 4]);
  });

  test('setConfig validates and clamps what it is given', () => {
    const engine = new FeedEngine(cfg({}), env, { rng: mulberry32(79) });
    const applied = engine.setConfig({ ...defaultConfig(), spinMagnitude: 9000, speed: 999 });
    expect(applied.spinMagnitude).toBe(SPIN_MAX_RAD_S);
    expect(applied.speed).toBe(25);
  });

  test('unsubscribing stops delivery', () => {
    const engine = new FeedEngine(cfg({ interval: 0.8, burstCount: INFINITE }), env,
      { rng: mulberry32(81) });
    let calls = 0;
    const off = engine.onFeed(() => { calls++; });
    step(engine, 0.05, 100);
    const seen = calls;
    expect(seen).toBeGreaterThan(0);
    off();
    step(engine, 0.05, 100);
    expect(calls).toBe(seen);
  });
});
