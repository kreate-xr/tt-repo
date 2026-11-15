// Ball Machine practice — the drill wrapper.
//
// One M1 machine fed by a PracticeModel (js/modes/training/practice.js): the
// model picks every ball, the machine's verdicts flow back into it. The feed
// never ends on its own; the player leaves with A/X.
//
// The trigger asks for the next ball at once; otherwise the tempo gap paces
// the feed.
//
// The thumbstick steps (speed, tempo) are announced over the net with the
// same in-world card the fault reasons use, because the DOM live line is not
// drawn in VR venues (dom-overlay is honoured in Mixed Reality only).

import { createM1BallMachineDrill } from './m1BallMachine.js';
import { PracticeModel } from '../practice.js';
import { createPointBurst } from '../../../scene/pointBurst.js';
import { mulberry32 } from '../../../util/rng.js';

export const PRACTICE = {
  id: 'practice',
  label: 'Ball Machine',
};

const STICK_HINT = 'Stick up / down: speed  ·  left / right: tempo';
// The opening card is the one place the player learns the trigger skips the
// wait. Kept short: the card squeezes a long line rather than wrapping it.
const START_HINT = 'Trigger: next ball now  ·  Stick: speed and tempo';

export function createPracticeDrill({
  ballEvents, seed, practice = null, custom = null, hand = 'R', random = false,
} = {}) {
  // Fresh draws each run unless a seed is given, so Random cannot be learned.
  const rng = mulberry32(seed == null ? (Math.random() * 0x100000000) >>> 0 : seed);
  const model = new PracticeModel({ practice, custom, hand, random, rng });

  const inner = createM1BallMachineDrill({
    ballEvents, seed,
    config: model.nextConfig(0),
    configProvider: (ball) => model.nextConfig(ball),
    onOutcome: (o) => model.recordOutcome(o),
  });

  const card = createPointBurst();
  if (card) {
    card.notice({ reason: model.practice.blurb, tip: START_HINT }, 'GO');
  }

  return {
    figure: inner.figure,
    // Exposed for tests.
    model,

    /**
     * One thumbstick step from the host. kind 'speed' | 'tempo', dir ±1.
     * Applies from the next ball. Returns the model's answer.
     */
    adjust(kind, dir) {
      const r = model.adjust(kind, dir);
      if (r && card) {
        const name = kind === 'speed' ? 'Speed' : 'Tempo';
        card.notice({
          reason: `${name} ${r.level} of ${r.of}`,
          tip: r.changed ? STICK_HINT : `That is the ${dir > 0 ? 'highest' : 'lowest'}`,
        }, name.toUpperCase());
      }
      return r;
    },

    /**
     * Trigger press (inGame's drill trigger hook): next ball now, so the
     * player is never stuck waiting on the tempo gap or a ball rolling away.
     */
    launch() { return inner.feedNow(); },

    update(dt) {
      inner.update(dt);
      if (card) card.update(dt);
    },

    // Endless by design: no score card, the player leaves with A/X.
    isFinished() { return false; },

    liveLine() { return model.liveLine(); },

    getSnapshot() { return inner.getSnapshot(); },
    getLog() { return inner.getLog(); },
    getSummary() { return inner.getSummary(); },

    dispose() {
      inner.dispose();
      if (card) card.dispose();
    },
  };
}
