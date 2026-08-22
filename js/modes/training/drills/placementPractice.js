// Placement practice — the Practice menu's "Placement" intent.
//
// The M1 machine feeds a steady, friendly ball; the player's job is to land
// the RETURN inside the lit target zone. Replaces the legacy Target Practice,
// which ran the same idea on the deleted feeder with a bounce-classifying
// state machine. Here the zone judgement reads the return's predicted landing
// straight off the M1 verdict — the same integrator that credits the return,
// so the score and the credit can never disagree.
//
// One zone is lit at a time and rotates on every hit (ported behaviour):
// chasing a moving target is the placement exercise; all-zones-lit is the
// tutorial's gentler variant.

import { createM1BallMachineDrill } from './m1BallMachine.js';
import { TargetZones } from '../targets.js';
import { validateConfig, INFINITE } from '../drillConfig.js';

export const PLACEMENT_PRACTICE = {
  id: 'placementPractice',
  label: 'Placement',
};

// Steady mid-table topspin: consistent enough that the player can think
// about WHERE to put the return rather than how to survive it. Light
// scatter so the incoming ball is not perfectly groove-able.
const BASE_CONFIG = {
  speed: 7, spinType: 'top', spinMagnitude: 90,
  placement: { kind: 'zone', zone: 5 }, depth: 'deep',
  scatterSigma: 0.10, interval: 2.8, burstCount: INFINITE,
};

export function createPlacementPracticeDrill({ ballEvents, seed } = {}) {
  const zones = new TargetZones();
  zones.activate(0);

  let onTarget = 0;
  let returned = 0;

  const inner = createM1BallMachineDrill({
    ballEvents, seed,
    config: validateConfig(BASE_CONFIG),
    onOutcome: (o) => {
      if (o.result !== 'returned') return;
      returned++;
      // No landing (a synthesised bare hit) counts as a return but can't be
      // scored — the zone test needs a point to test.
      if (!o.landing) return;
      if (zones.testBounce(o.landing.x, o.landing.z) === 'hit') {
        onTarget++;
        zones.rotateActive();
      }
    },
  });

  return {
    figure: inner.figure,

    update(dt) {
      inner.update(dt);
      zones.update(dt);
    },

    isFinished() { return inner.isFinished(); },

    liveLine() {
      return `On target ${onTarget}/${returned}  ·  aim for the lit zone`;
    },

    // Exposed for tests.
    getScore() { return { onTarget, returned }; },
    zones,

    getSnapshot() { return inner.getSnapshot(); },
    getLog() { return inner.getLog(); },
    getSummary() { return inner.getSummary(); },
    getRecentContacts() { return inner.getRecentContacts(); },
    setConfig(next) { return inner.setConfig(next); },

    dispose() {
      zones.dispose();
      inner.dispose();
    },
  };
}
