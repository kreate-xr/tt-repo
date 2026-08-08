// Per-session stats. Per the plan: no persistence, no localStorage.

export class SessionStats {
  constructor(drillId, difficultyLabel) {
    this.drillId = drillId;
    this.difficulty = difficultyLabel;
    this.startedAt = performance.now();
    this.shotsFed = 0;
    this.shotsReturned = 0;
    this.onTarget = 0;
    this.currentStreak = 0;
    this.longestStreak = 0;
    this.perSpinResults = {}; // { topspin: { faced: 3, cleared: 2 }, ... }
  }

  recordFeed(shot) {
    this.shotsFed++;
    if (shot && shot.spin) {
      this.perSpinResults[shot.spin] = this.perSpinResults[shot.spin] || { faced: 0, cleared: 0 };
      this.perSpinResults[shot.spin].faced++;
    }
  }

  recordReturn() {
    this.shotsReturned++;
    this.currentStreak++;
    if (this.currentStreak > this.longestStreak) this.longestStreak = this.currentStreak;
  }

  recordReturnCleared(spinName) {
    if (spinName && this.perSpinResults[spinName]) {
      this.perSpinResults[spinName].cleared++;
    }
  }

  recordMiss() {
    this.currentStreak = 0;
  }

  recordOnTarget() {
    this.onTarget++;
  }

  durationSec() {
    return (performance.now() - this.startedAt) / 1000;
  }

  accuracyPct() {
    if (!this.shotsFed) return 0;
    return Math.round((this.onTarget / this.shotsFed) * 100);
  }

  returnPct() {
    if (!this.shotsFed) return 0;
    return Math.round((this.shotsReturned / this.shotsFed) * 100);
  }

  snapshot() {
    return {
      drillId: this.drillId,
      difficulty: this.difficulty,
      shotsFed: this.shotsFed,
      shotsReturned: this.shotsReturned,
      onTarget: this.onTarget,
      longestStreak: this.longestStreak,
      perSpinResults: { ...this.perSpinResults },
      durationSec: this.durationSec(),
      accuracyPct: this.accuracyPct(),
      returnPct: this.returnPct(),
    };
  }
}
