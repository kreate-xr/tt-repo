// The ball machine's built-in Warmup feed.
//
// The guarantee: the feed Free Play and the machine's default rely on is
// makeable on EVERY ball of its own scatter distribution. A feed that asks
// for a shot the table geometry forbids would put net balls in play, so this
// runs the real solver rather than just checking fields.

const THREE = require('three');

const { WARMUP_FEED } = require('../js/modes/training/presets.js');
const { solveFeed } = require('../js/modes/training/feedEngine.js');
const { validateConfig } = require('../js/modes/training/drillConfig.js');
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

test('the warmup feed is already a valid config', () => {
  expect(validateConfig(WARMUP_FEED)).toEqual(WARMUP_FEED);
});

test('the warmup feed is gentle: slow, no spin, centred', () => {
  expect(WARMUP_FEED.speed).toBeLessThanOrEqual(6);
  expect(WARMUP_FEED.spinType).toBe('none');
  expect(WARMUP_FEED.placement).toEqual({ kind: 'zone', zone: 5 });
});

test('the warmup feed is feasible and accurate over 120 feeds', () => {
  const rng = mulberry32(4321);
  let worst = 0;
  let infeasible = 0;
  let netFails = 0;
  let offTable = 0;

  for (let i = 0; i < 120; i++) {
    const feed = solveFeed(WARMUP_FEED, env, { rng });
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
