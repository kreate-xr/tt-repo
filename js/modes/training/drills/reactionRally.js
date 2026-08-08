// Reaction Rally — speed/rate ramps with streak. Single life: drill ends on first miss.

export const REACTION_RALLY = {
  id: 'reactionRally',
  label: 'Reaction Rally',
};

const lerp = (a, b, t) => a + (b - a) * t;

export function createReactionRallyDrill({ feeder, stats, ballEvents, profile }) {
  feeder.setPlacementMode('random');
  feeder.setSpinSequence(['topspin']);

  const baseInterval = profile.feedIntervalSec;
  const baseFlight = profile.flightTime;
  const baseSpinMag = profile.spinMag;

  let currentBallReturned = false;
  let finished = false;

  feeder.onFeed((shot) => {
    if (stats.shotsFed > 0 && !currentBallReturned) {
      stats.recordMiss();
      finished = true;
      feeder.pause();
      return;
    }
    currentBallReturned = false;
    stats.recordFeed(shot);
  });

  ballEvents.onPaddleHit(() => {
    if (!currentBallReturned) {
      currentBallReturned = true;
      stats.recordReturn();
    }
  });

  ballEvents.onBallLost(() => {
    if (!currentBallReturned && !finished) {
      stats.recordMiss();
      finished = true;
      feeder.pause();
    }
  });

  return {
    update(_dt) {
      const t = Math.min(stats.currentStreak / 20, 1);
      feeder.profile.feedIntervalSec = lerp(baseInterval, baseInterval * 0.55, t);
      feeder.profile.flightTime = lerp(baseFlight, baseFlight * 0.65, t);
      feeder.profile.spinMag = lerp(baseSpinMag, baseSpinMag * 1.4, t);
    },
    isFinished() { return finished; },
    liveLine() {
      return `Streak ${stats.currentStreak}  Best ${stats.longestStreak}`;
    },
    dispose() {},
  };
}
