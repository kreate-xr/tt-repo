// The ball machine's one built-in feed.
//
// Warmup is what Free Play's machine (B/Y on an empty table) feeds, and what
// the M1 drill falls back to when a caller gives it no config: slow, flat,
// dead-centre, so it is makeable by anyone. The Training Session defines its
// own feeds (session.js) and does not use this.
//
// Held to 100% feasibility by the 120-feed test in tests/presets.test.js:
// across its whole scatter distribution it must clear the net, land on the
// table, and land within 2 cm of the commanded point.

import { validateConfig } from './drillConfig.js';

export const WARMUP_FEED = validateConfig({
  speed: 6, spinType: 'none', spinMagnitude: 0,
  placement: { kind: 'zone', zone: 5 }, depth: 'half-long',
  interval: 2.5, burstCount: 20,
});
