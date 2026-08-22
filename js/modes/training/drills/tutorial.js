// M9 Tutorial — the drill wrapper.
//
// A config script over the M1 machine, not a second feed path (anti-dead-code
// rule 1): createM1BallMachineDrill does all the feeding, verdicts and
// logging; this wrapper advances the TutorialModel on each per-ball verdict,
// swaps the feed config when a step is passed, and shows the target zones
// during the placement step. The step logic itself lives in
// training/tutorial.js, scene-free, where it is unit-testable.

import { createM1BallMachineDrill } from './m1BallMachine.js';
import { TutorialModel } from '../tutorial.js';
import { TargetZones } from '../targets.js';
import { setSetting } from '../../../profile/store.js';

export const TUTORIAL = {
  id: 'tutorial',
  label: 'Tutorial',
};

export function createTutorialDrill({ ballEvents, seed } = {}) {
  const model = new TutorialModel();

  // Zones exist only while the placement step is live: they are scene meshes,
  // and leaving them up through the backspin step would keep instructing the
  // player to aim at something that no longer scores.
  let zones = null;
  const syncZones = () => {
    if (model.needsZones && !zones) {
      zones = new TargetZones();
      zones.activateAll();
    } else if (!model.needsZones && zones) {
      zones.dispose();
      zones = null;
    }
  };

  const inner = createM1BallMachineDrill({
    ballEvents,
    seed,
    config: model.config(),
    onOutcome: (outcome) => {
      // Zone judgement happens here rather than in the model so the model
      // stays scene-free. testBounce also flashes the zone green/red, which
      // is the only aim feedback the step needs — no extra HUD text.
      let inZone = false;
      if (zones && outcome.result === 'returned' && outcome.landing) {
        inZone = zones.testBounce(outcome.landing.x, outcome.landing.z) === 'hit';
      }
      const { advanced, completed } = model.recordOutcome({
        result: outcome.result, inZone,
      });
      if (!advanced) return;
      syncZones();
      if (completed) {
        // Persisted as a setting: the menu's tutorial row reads it to swap
        // its subtitle, and coerceSettings defaults it for old profiles.
        setSetting('tutorialComplete', true);
      } else {
        inner.setConfig(model.config());
      }
    },
  });

  return {
    // Exposed for tests: step assertions without reaching into closures.
    model,

    update(dt) {
      inner.update(dt);
      if (zones) zones.update(dt);
    },

    // The inner drill feeds forever (every step is burstCount ∞); the
    // tutorial is what ends, when its last step is passed.
    isFinished() { return model.complete; },

    // The instruction IS the live line. The M1 counters would bury it, and
    // per P15 §M7 one short line is all the in-drill HUD gets.
    liveLine() { return model.instruction(); },

    // M7 passthroughs, so Review & Stats treats a tutorial session like any
    // other machine session.
    getSnapshot() { return inner.getSnapshot(); },
    getLog() { return inner.getLog(); },
    getSummary() { return inner.getSummary(); },
    getRecentContacts() { return inner.getRecentContacts(); },

    dispose() {
      if (zones) { zones.dispose(); zones = null; }
      inner.dispose();
    },
  };
}
