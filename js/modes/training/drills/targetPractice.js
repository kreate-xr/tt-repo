// Target Practice — score returns that land in active zones on opponent's half.

import { TargetZones } from '../targets.js';
import { tableBox } from '../../../scene/models.js';

export const TARGET_PRACTICE = {
  id: 'targetPractice',
  label: 'Target Practice',
};

export function createTargetPracticeDrill({ feeder, stats, ballEvents }) {
  feeder.setPlacementMode('alternating');
  feeder.setSpinSequence(['topspin']);

  const zones = new TargetZones('corners');
  zones.activate(0); // start with first zone active

  // State machine to classify table bounces:
  //   awaitingFeederBounce → first bounce after feed (the feeder's landing) — ignored
  //   awaitingPaddleHit    → paddle must register before next bounce
  //   awaitingReturnBounce → next bounce is the player's return — tested vs zones
  //   idle                 → ball lost or scored, waiting for next feed
  let phase = 'idle';
  let currentBallReturned = false;
  let currentBallScored = false;

  feeder.onFeed(() => {
    if (stats.shotsFed > 0 && !currentBallReturned) stats.recordMiss();
    stats.recordFeed();
    phase = 'awaitingFeederBounce';
    currentBallReturned = false;
    currentBallScored = false;
  });

  ballEvents.onPaddleHit(() => {
    if (!currentBallReturned) {
      currentBallReturned = true;
      stats.recordReturn();
    }
    if (phase === 'awaitingFeederBounce' || phase === 'awaitingPaddleHit') {
      phase = 'awaitingReturnBounce';
    }
  });

  ballEvents.onTableBounce(({ x, z }) => {
    if (phase === 'awaitingFeederBounce') {
      phase = 'awaitingPaddleHit';
      return;
    }
    if (phase === 'awaitingReturnBounce' && !currentBallScored) {
      // Only score once the ball has crossed to the opponent half.
      const centerZ = tableBox ? (tableBox.min.z + tableBox.max.z) / 2 : 0;
      if (z >= centerZ) return; // weak return, still on player half — wait for next bounce
      const result = zones.testBounce(x, z);
      if (result === 'hit') {
        stats.recordOnTarget();
        currentBallScored = true;
        zones.rotateActive();
      }
      phase = 'idle';
    }
  });

  ballEvents.onBallLost(() => {
    if (!currentBallReturned) stats.recordMiss();
    phase = 'idle';
  });

  return {
    update(dt) { zones.update(dt); },
    isFinished() { return false; },
    liveLine() {
      const acc = stats.accuracyPct();
      return `On-target ${stats.onTarget}/${stats.shotsFed}  ${acc}%`;
    },
    dispose() { zones.dispose(); },
  };
}
