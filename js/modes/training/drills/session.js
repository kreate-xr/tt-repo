// Training Session — the drill wrapper.
//
// One M1 machine for the whole session, not one per set: the SessionModel is
// the machine's config provider (it picks every ball) and the machine's
// per-ball verdicts flow back into it. A single machine keeps one event log,
// so the end-of-set panel sees the session as one session. Rests are the
// machine paused, not torn down.
//
// Scene-facing work stays here (table geometry for the depth score, the
// profile's best score); the sets, pace and scoring live in session.js.

import { createM1BallMachineDrill } from './m1BallMachine.js';
import { SessionModel, SETS, BLOCKS, stepConfig } from '../session.js';
import { tableBox } from '../../../scene/models.js';
import { mulberry32 } from '../../../util/rng.js';
import { getSetting, setSetting } from '../../../profile/store.js';

export const SESSION = {
  id: 'session',
  label: 'Training Session',
};

/**
 * Where the score card's button sends the player: a focus run of the set
 * they scored lowest on (inside their weakest block), at the level they just
 * played. Returned as a start request the host feeds straight into
 * enterDrill. Null after a focus run — "Again" already repeats it.
 */
export function nextTraining(report, { level, hand = 'R' } = {}) {
  if (report.focus || !report.weakestSet) return null;
  const set = SETS.find((s) => s.id === report.weakestSet);
  return {
    label: set.label,
    drill: 'session',
    config: null,
    options: { level, hand, focus: set.id },
  };
}

export function createSessionDrill({
  ballEvents, seed, level = 'beginner', hand = 'R', focus = null,
} = {}) {
  // The machine keeps its own seeded stream for scatter; the model's draws
  // (which step a random set feeds) get a separate stream, fresh each session
  // unless a seed is given, so the random sets cannot be learned by heart.
  const rng = mulberry32(seed == null ? (Math.random() * 0x100000000) >>> 0 : seed);

  const model = new SessionModel({
    level, hand, rng, focus,
    // Player half is +z; returns land on the machine's half, far end at min z.
    tableHalf: { farZ: tableBox.min.z, netZ: (tableBox.min.z + tableBox.max.z) / 2 },
  });

  const inner = createM1BallMachineDrill({
    ballEvents, seed,
    config: stepConfig(model.level, model.sets[0].steps[0], { hand: model.hand }),
    configProvider: (ball) => model.nextConfig(ball),
    onOutcome: (o) => model.recordOutcome(o),
  });
  // Nothing feeds until the intro countdown ends.
  inner.pause();

  // Best scores are for the full session only; a focus run is practice.
  const bestKey = model.focus ? null : model.level.bestKey;
  const previousBest = bestKey ? Number(getSetting(bestKey)) || 0 : 0;
  let saved = false;

  return {
    figure: inner.figure,
    // Exposed for tests.
    model,

    update(dt) {
      inner.update(dt);
      const ev = model.tick(dt);
      if (ev === 'pause') inner.pause();
      else if (ev === 'resume') inner.resume();
      else if (ev === 'done' && !saved) {
        saved = true;
        const { score } = model.report();
        if (bestKey && score > previousBest) setSetting(bestKey, score);
      }
    },

    isFinished() { return model.complete; },

    liveLine() { return model.liveLine(); },

    /** The score card: the model's report plus best score and next step. */
    getReport() {
      const r = model.report();
      const label = (id) => (id ? BLOCKS[id].label : null);
      return {
        ...r,
        focusLabel: r.focus ? r.sets[0].label : null,
        best: bestKey ? Math.max(previousBest, r.score) : null,
        previousBest,
        newBest: !!bestKey && r.score > previousBest,
        strongestLabel: label(r.strongest),
        weakestLabel: label(r.weakest),
        next: nextTraining(r, { level: model.level.id, hand: model.hand }),
      };
    },

    getSnapshot() { return inner.getSnapshot(); },
    getLog() { return inner.getLog(); },
    getSummary() { return inner.getSummary(); },

    dispose() { inner.dispose(); },
  };
}
