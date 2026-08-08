// Spin Reader — feeder cycles through spin types in random order.
// Optional colored ring on the ball as a learning aid (fades or hides per difficulty).

import * as THREE from 'three';
import { ballModel, ballRadius, tableBox } from '../../../scene/models.js';

export const SPIN_READER = {
  id: 'spinReader',
  label: 'Spin Reader',
};

const SPIN_COLOR = {
  topspin:  0xff3344,
  backspin: 0x3388ff,
  sideA:    0xffcc22,
  sideB:    0xff8822,
  none:     0xffffff,
};

const SPIN_LABEL = {
  topspin:  'TOP',
  backspin: 'BACK',
  sideA:    'SIDE-A',
  sideB:    'SIDE-B',
  none:     'NO SPIN',
};

const ALL_SPINS = ['topspin', 'backspin', 'sideA', 'sideB', 'none'];

function shuffled(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function createSpinReaderDrill({ feeder, stats, ballEvents }) {
  feeder.setPlacementMode('random');
  feeder.setSpinSequence(shuffled(ALL_SPINS));

  // Ring visibility & fade per difficulty
  const cueProfiles = {
    Beginner:     { initialOpacity: 0.85, fadeStart: 999, fadeDuration: 0 }, // never fades
    Intermediate: { initialOpacity: 0.85, fadeStart: 0.3, fadeDuration: 0.3 },
    Pro:          { initialOpacity: 0,    fadeStart: 0,   fadeDuration: 0 }, // never visible
  };
  const cueProfile = cueProfiles[stats.difficulty] || cueProfiles.Beginner;

  // Ring mesh — child of the ball so it follows position automatically.
  const ringGeom = new THREE.TorusGeometry(ballRadius * 1.7, ballRadius * 0.18, 8, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.visible = false;
  // Parent the ring to ballModel — spin now lives on ballModel's quaternion
  // and squash is applied per-vertex on the ball meshes, so the ring rotates
  // with the ball's spin and is not affected by the mesh-level deformation.
  if (ballModel) ballModel.add(ring);

  let currentSpin = null;
  let timeSinceFeed = 0;
  let phase = 'idle';
  let currentBallReturned = false;

  feeder.onFeed((shot) => {
    if (stats.shotsFed > 0 && !currentBallReturned) stats.recordMiss();
    currentSpin = shot.spin;
    stats.recordFeed(shot);

    timeSinceFeed = 0;
    phase = 'awaitingFeederBounce';
    currentBallReturned = false;

    if (cueProfile.initialOpacity > 0) {
      ringMat.color.setHex(SPIN_COLOR[currentSpin] || 0xffffff);
      ringMat.opacity = cueProfile.initialOpacity;
      ring.visible = true;
    } else {
      ring.visible = false;
    }
  });

  ballEvents.onPaddleHit(() => {
    if (!currentBallReturned) {
      currentBallReturned = true;
      stats.recordReturn();
    }
    if (phase === 'awaitingFeederBounce' || phase === 'awaitingPaddleHit') {
      phase = 'awaitingReturnOutcome';
    }
  });

  ballEvents.onTableBounce(({ z }) => {
    if (phase === 'awaitingFeederBounce') {
      phase = 'awaitingPaddleHit';
      return;
    }
    if (phase === 'awaitingReturnOutcome') {
      // "Cleared" only counts if the return landed on the opponent half (z < centerZ).
      const centerZ = tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0;
      if (z < centerZ) {
        stats.recordReturnCleared(currentSpin);
        phase = 'idle';
      }
      // If it bounced again on player's half, stay in awaitingReturnOutcome
      // — a second bounce that crosses still counts.
    }
  });

  ballEvents.onNetHit(() => {
    if (phase === 'awaitingReturnOutcome') {
      // didn't clear net — no recordReturnCleared
      phase = 'idle';
    }
  });

  ballEvents.onBallLost(() => {
    if (!currentBallReturned) stats.recordMiss();
    phase = 'idle';
    ring.visible = false;
  });

  return {
    update(dt) {
      if (!ring.visible) return;
      timeSinceFeed += dt;
      if (cueProfile.fadeDuration > 0 && timeSinceFeed > cueProfile.fadeStart) {
        const fadeT = (timeSinceFeed - cueProfile.fadeStart) / cueProfile.fadeDuration;
        const opa = Math.max(0, cueProfile.initialOpacity * (1 - fadeT));
        ringMat.opacity = opa;
        if (opa <= 0) ring.visible = false;
      }
    },
    isFinished() { return false; },
    liveLine() {
      const cleared = Object.values(stats.perSpinResults).reduce((a, r) => a + r.cleared, 0);
      const faced = Object.values(stats.perSpinResults).reduce((a, r) => a + r.faced, 0);
      const cur = currentSpin ? SPIN_LABEL[currentSpin] : '...';
      return `Spin: ${cur}  Cleared ${cleared}/${faced}`;
    },
    dispose() {
      if (ring.parent) ring.parent.remove(ring);
      ringGeom.dispose();
      ringMat.dispose();
    },
  };
}
