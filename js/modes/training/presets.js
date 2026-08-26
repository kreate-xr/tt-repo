// M1 Quick Feed — the six hardcoded presets.
//
// Every one of these is held to 100% feasibility by the 500-feed test in
// tests/feedEngine.test.js: across the whole of its own scatter distribution
// it must clear the net, land on the table, and land within 2 cm of the
// commanded point. If a change here breaks that, the PRESET is wrong — the
// table geometry forbids the shot it asks for — not the solver.
//
// Two of these values look arbitrary and are not:
//
//   'Backspin push' uses feedOrigin 'center-far'. Short placements need the
//   far origin's longer, more arcing path; from the near origin at these
//   speeds the flattest trajectory that reaches a point 23 cm past the net
//   crosses BELOW the cord, and the feed is correctly refused.
//
//   'Smash setup' is speed 8, not 12+. A ball the player is meant to attack
//   has to arrive high and unhurried; a fast lob is neither, and at 12 m/s
//   the lofted branch overshoots the table.
//
// Ordering matters for the menu: Warmup first, then the stroke-specific
// feeds, then the two that combine things.

import { validateConfig } from './drillConfig.js';

const preset = (label, over) => ({ label, config: validateConfig(over) });

export const QUICK_FEED = {
  Warmup: preset('Warmup', {
    speed: 6, spinType: 'none', spinMagnitude: 0,
    placement: { kind: 'zone', zone: 5 }, depth: 'half-long',
    interval: 2.5, burstCount: 20,
  }),

  FHTopspin: preset('FH topspin', {
    speed: 9, spinType: 'top', spinMagnitude: 300,
    placement: { kind: 'zone', zone: 9 }, depth: 'deep',
    interval: 2.0, burstCount: 20,
  }),

  BHTopspin: preset('BH topspin', {
    speed: 9, spinType: 'top', spinMagnitude: 300,
    placement: { kind: 'zone', zone: 7 }, depth: 'deep',
    interval: 2.0, burstCount: 20,
  }),

  BackspinPush: preset('Backspin push', {
    speed: 7, spinType: 'back', spinMagnitude: 275,
    placement: { kind: 'zone', zone: 2 }, depth: 'short',
    arc: 'flat', feedOrigin: 'center-far',
    interval: 2.2, burstCount: 20,
  }),

  RandomLight: preset('Random light', {
    speed: 7, spinType: 'none', spinMagnitude: 0,
    scatterSigma: 0.2,
    placement: { kind: 'zone', zone: 8 }, depth: 'deep',
    interval: 2.0, burstCount: 20,
  }),

  SmashSetup: preset('Smash setup', {
    speed: 8, spinType: 'top', spinMagnitude: 225,
    arc: 'lob',
    placement: { kind: 'zone', zone: 5 }, depth: 'half-long',
    interval: 2.6, burstCount: 20,
  }),
};

// Menu order, as listed in M1.
export const QUICK_FEED_ORDER = [
  'Warmup', 'FHTopspin', 'BHTopspin', 'BackspinPush', 'RandomLight', 'SmashSetup',
];

export function getQuickFeed(key) {
  return QUICK_FEED[key] || QUICK_FEED.Warmup;
}
