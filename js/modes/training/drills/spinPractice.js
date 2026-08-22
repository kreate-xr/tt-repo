// Spin practice — the Practice menu's "Spin" intent.
//
// The M1 machine runs the spinMix pattern in random order: same spot every
// ball, different spin, so reading the spin is the entire task. Because it is
// a random pattern, the M10 curriculum tuner steers the draw toward whichever
// spin the player keeps missing — the drill converges on the weakness by
// itself instead of asking the player to pick "backspin drill" off a list.
//
// The coloured ring cue is ported from the deleted legacy Spin Reader (the
// one idea of that drill worth keeping): a ring around the ball tinted by the
// incoming spin, faded per difficulty — always visible for beginners, a
// glimpse for intermediate, absent for pro. The answer is also printed in the
// HUD line, because the drill teaches ball-reading, not memory: the player
// checks their read against the truth every ball.

import * as THREE from 'three';
import { ballModel, ballRadius } from '../../../scene/models.js';
import { createM1BallMachineDrill } from './m1BallMachine.js';
import { validateConfig, INFINITE } from '../drillConfig.js';

export const SPIN_PRACTICE = {
  id: 'spinPractice',
  label: 'Spin',
};

// Keyed by DrillConfig spin types (drillConfig.SPIN_TYPES), matching the
// trajectory panel's palette so a colour means the same spin everywhere.
const SPIN_COLOR = {
  top:      0xff5a66,
  back:     0x4d9dff,
  'side-L': 0xffa94d,
  'side-R': 0xffd54d,
  none:     0xe6edf5,
};

const SPIN_LABEL = {
  top: 'TOPSPIN', back: 'BACKSPIN', 'side-L': 'SIDE-L', 'side-R': 'SIDE-R', none: 'NO SPIN',
};

// Ring visibility per difficulty tier (profile.id from difficulty.js).
const CUE_PROFILES = {
  beginner:     { initialOpacity: 0.85, fadeStart: 999, fadeDuration: 0 },   // never fades
  intermediate: { initialOpacity: 0.85, fadeStart: 0.3, fadeDuration: 0.3 }, // a glimpse
  pro:          { initialOpacity: 0,    fadeStart: 0,   fadeDuration: 0 },   // read it raw
};

// Middling pace, real spin. The pattern's steps override spinType per ball;
// speed/interval here set the rhythm they all share.
const BASE_CONFIG = {
  speed: 7, spinType: 'top', spinMagnitude: 120,
  placement: { kind: 'zone', zone: 5 }, depth: 'deep',
  scatterSigma: 0.06, interval: 2.8, burstCount: INFINITE,
};

export function createSpinPracticeDrill({ ballEvents, seed, profile, hand = 'R' } = {}) {
  const cue = CUE_PROFILES[profile && profile.id] || CUE_PROFILES.beginner;

  // Per-spin read record, fed from the M1 verdicts.
  const perSpin = {};
  const record = (spin, returned) => {
    if (!spin) return;
    perSpin[spin] = perSpin[spin] || { faced: 0, returned: 0 };
    perSpin[spin].faced++;
    if (returned) perSpin[spin].returned++;
  };

  const inner = createM1BallMachineDrill({
    ballEvents, seed,
    config: validateConfig(BASE_CONFIG),
    pattern: 'spinMix',
    random: true,
    hand,
    onOutcome: (o) => record(o.spin, o.result === 'returned'),
  });

  // The ring rides the ball model, exactly as the legacy cue did: spin lives
  // on ballModel's quaternion, so a child ring rotates with the true spin.
  const ringGeom = new THREE.TorusGeometry(ballRadius * 1.7, ballRadius * 0.18, 8, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.visible = false;
  if (ballModel) ballModel.add(ring);

  let lastFeedSeen = null;
  let timeSinceFeed = 0;

  return {
    figure: inner.figure,

    update(dt) {
      inner.update(dt);

      // New feed → re-arm the cue for its spin. Read off the snapshot rather
      // than a callback so this wrapper adds no state to the M1 drill.
      const lf = inner.getSnapshot().lastFeed;
      if (lf && lf !== lastFeedSeen) {
        lastFeedSeen = lf;
        timeSinceFeed = 0;
        if (cue.initialOpacity > 0) {
          ringMat.color.setHex(SPIN_COLOR[lf.config.spinType] ?? 0xffffff);
          ringMat.opacity = cue.initialOpacity;
          ring.visible = true;
        }
      }

      if (ring.visible && cue.fadeDuration > 0) {
        timeSinceFeed += dt;
        if (timeSinceFeed > cue.fadeStart) {
          const t = (timeSinceFeed - cue.fadeStart) / cue.fadeDuration;
          ringMat.opacity = Math.max(0, cue.initialOpacity * (1 - t));
          if (ringMat.opacity <= 0) ring.visible = false;
        }
      }
    },

    isFinished() { return inner.isFinished(); },

    liveLine() {
      const lf = inner.getSnapshot().lastFeed;
      const cur = lf ? (SPIN_LABEL[lf.config.spinType] || lf.config.spinType) : '…';
      const faced = Object.values(perSpin).reduce((a, r) => a + r.faced, 0);
      const read = Object.values(perSpin).reduce((a, r) => a + r.returned, 0);
      return `Spin: ${cur}  ·  Read ${read}/${faced}`;
    },

    // Exposed for tests and the summary handoff.
    getPerSpin() { return JSON.parse(JSON.stringify(perSpin)); },

    getSnapshot() { return inner.getSnapshot(); },
    getLog() { return inner.getLog(); },
    getSummary() { return inner.getSummary(); },
    getRecentContacts() { return inner.getRecentContacts(); },
    setConfig(next) { return inner.setConfig(next); },

    dispose() {
      if (ring.parent) ring.parent.remove(ring);
      ringGeom.dispose();
      ringMat.dispose();
      inner.dispose();
    },
  };
}
