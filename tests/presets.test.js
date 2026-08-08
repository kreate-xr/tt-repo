// M1 Quick Feed presets.
//
// The guarantee: every shipped preset is makeable on EVERY ball of its own
// scatter distribution. A preset that asks for a shot the table geometry
// forbids would feed net balls in play while looking fine in the menu, so
// this runs the real solver over each one rather than just checking fields.

const THREE = require('three');

const { QUICK_FEED, QUICK_FEED_ORDER, getQuickFeed } = require('../js/modes/training/presets.js');
const { solveFeed } = require('../js/modes/training/feedEngine.js');
const { SPIN_TYPES, DEPTHS, ARCS, FEED_ORIGINS } = require('../js/modes/training/drillConfig.js');
const { mulberry32 } = require('../js/util/rng.js');

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

describe('preset shape', () => {
  test('all six M1 Quick Feed presets exist and are ordered', () => {
    expect(QUICK_FEED_ORDER).toHaveLength(6);
    for (const key of QUICK_FEED_ORDER) {
      expect(QUICK_FEED[key]).toBeDefined();
      expect(typeof QUICK_FEED[key].label).toBe('string');
      expect(QUICK_FEED[key].config).toBeTruthy();
    }
  });

  test('every preset config is already valid', () => {
    for (const key of QUICK_FEED_ORDER) {
      const c = QUICK_FEED[key].config;
      expect(SPIN_TYPES).toContain(c.spinType);
      expect(DEPTHS).toContain(c.depth);
      expect(ARCS).toContain(c.arc);
      expect(FEED_ORIGINS).toContain(c.feedOrigin);
      expect(c.speed).toBeGreaterThanOrEqual(2);
      expect(c.speed).toBeLessThanOrEqual(25);
    }
  });

  test('getQuickFeed falls back to Warmup for an unknown key', () => {
    expect(getQuickFeed('nonsense')).toBe(QUICK_FEED.Warmup);
    expect(getQuickFeed(undefined)).toBe(QUICK_FEED.Warmup);
  });

  test('the presets cover a range of spins rather than all being topspin', () => {
    const spins = new Set(QUICK_FEED_ORDER.map((k) => QUICK_FEED[k].config.spinType));
    expect(spins.size).toBeGreaterThanOrEqual(3);
  });
});

describe('every preset is physically makeable', () => {
  for (const key of QUICK_FEED_ORDER) {
    test(`${key} is feasible and accurate over 120 feeds`, () => {
      const { config } = QUICK_FEED[key];
      const rng = mulberry32(4321);
      let worst = 0;
      let infeasible = 0;
      let netFails = 0;
      let offTable = 0;

      for (let i = 0; i < 120; i++) {
        const feed = solveFeed(config, env, { rng });
        worst = Math.max(worst, feed.errorM);
        if (!feed.feasible) infeasible++;
        if (!feed.clearedNet) netFails++;
        if (!feed.onTable) offTable++;
      }

      expect(infeasible).toBe(0);
      expect(netFails).toBe(0);
      expect(offTable).toBe(0);
      expect(worst).toBeLessThan(0.02);
    }, 30000);
  }
});

describe('preset intent', () => {
  test('Backspin push uses a far origin, which short placements require', () => {
    // From a near origin the flattest arc reaching a point 23 cm past the net
    // crosses below the cord. This is load-bearing, not stylistic.
    expect(QUICK_FEED.BackspinPush.config.depth).toBe('short');
    expect(QUICK_FEED.BackspinPush.config.feedOrigin).toContain('far');
  });

  test('Smash setup arrives high and unhurried', () => {
    const c = QUICK_FEED.SmashSetup.config;
    expect(c.arc).toBe('lob');
    expect(c.speed).toBeLessThanOrEqual(9);
  });

  test('FH and BH topspin differ only in which side they attack', () => {
    const fh = QUICK_FEED.FHTopspin.config;
    const bh = QUICK_FEED.BHTopspin.config;
    expect(fh.spinType).toBe(bh.spinType);
    expect(fh.speed).toBe(bh.speed);
    expect(fh.placement.zone).not.toBe(bh.placement.zone);
  });

  test('Random light is the one with meaningful scatter', () => {
    expect(QUICK_FEED.RandomLight.config.scatterSigma).toBeGreaterThan(0.1);
  });

  test('Warmup is the gentlest preset', () => {
    const warmup = QUICK_FEED.Warmup.config;
    expect(warmup.spinMagnitude).toBe(0);
    for (const key of QUICK_FEED_ORDER) {
      expect(warmup.speed).toBeLessThanOrEqual(QUICK_FEED[key].config.speed);
    }
  });
});
