// Match-long player stats for the end-of-match report — shared by the AI
// match and multiplayer so the two cards measure the same things the same way.
//
// Pure: the caller feeds it from the events it already handles, rather than
// this module subscribing to ballEvents itself. That matters for multiplayer,
// where the local peer STOPS seeing ball events for its own shot the moment
// ownership hands off (~1 RTT after contact) — a collector that watched
// bounces would score the same shot differently online than offline.
//
// ── WHY ACCURACY IS DERIVED FROM VERDICTS ───────────────────────────────────
//
// "Did that shot land in?" is not something either mode can answer from the
// ball's event stream on both sides of the wire (see above). What both modes
// DO have, identically, is the shared rulebook's verdict for every point:
// js/modes/rallyRules.js names the loser and why they lost, and both peers run
// that transition. So a shot counts as an error exactly when the player lost
// the point BY PUTTING THE BALL WHERE IT COULDN'T STAY:
//
//   ballLost/out    the last shot never came down on the far side
//   ballOut         the opponent swatted a ball that had already gone long
//                   (scored to the striker; the loser's shot was still out)
//   ownSideBounce   a return that came down on the hitter's own court
//   serveFault      the serve never made it legally into play
//
// Losing to 'doubleBounce' or 'ballLost/missedReturn' is NOT a shot error —
// the player never got a racket on it, so there is no shot to judge. Fouls
// (illegalVolley, doubleHit, netTouch) aren't placement errors either.

// Reasons that mean "the shot the player just played did not land in".
// detail is checked too: 'ballLost' covers both a shot going long and a ball
// the player never reached.
export const SHOT_ERROR_REASONS = Object.freeze({
  ballLost: (detail) => detail === 'out',
  ballOut: () => true,
  ownSideBounce: () => true,
  serveFault: () => true,
});

export function isPlayerShotError(reason, detail = null) {
  const test = SHOT_ERROR_REASONS[reason];
  return typeof test === 'function' ? !!test(detail) : false;
}

/**
 * @param {object}   opts
 * @param {function} opts.now  monotonic ms source (injected so the duration is
 *                             testable and so callers can share the clock they
 *                             already tick the scoreboard from).
 */
export function createMatchStats({ now = () => Date.now() } = {}) {
  let shots = 0;
  let shotErrors = 0;
  let topSpinShots = 0;
  let maxSpeedKmh = 0;
  let startMs = now();
  let endMs = null;

  /** One player paddle contact, straight from ball.js's paddleHit payload. */
  function recordShot({ outSpeed = 0, spinType = null } = {}) {
    shots += 1;
    // outSpeed is m/s off the paddle — the broadcast "shot speed" number.
    const kmh = (Number(outSpeed) || 0) * 3.6;
    if (kmh > maxSpeedKmh) maxSpeedKmh = kmh;
    // ball.js labels the contact 'TOP' | 'BACK' | 'R-SPIN' | 'L-SPIN' | 'flat'.
    if (spinType === 'TOP') topSpinShots += 1;
  }

  /**
   * One decided point.
   * @param {'player'|'opponent'|null} loser  who lost it (null = let/void rally)
   */
  function recordPoint({ loser = null, reason = null, detail = null } = {}) {
    if (loser !== 'player') return;
    if (isPlayerShotError(reason, detail)) shotErrors += 1;
  }

  /** Freeze the duration at match end so the card doesn't keep counting. */
  function stop() {
    if (endMs === null) endMs = now();
  }

  function reset() {
    shots = 0;
    shotErrors = 0;
    topSpinShots = 0;
    maxSpeedKmh = 0;
    startMs = now();
    endMs = null;
  }

  function getStats() {
    // Clamped: a fault charged without a recorded stroke (a serve faulted on
    // contact position, say) must not push accuracy negative.
    const landed = Math.max(0, shots - shotErrors);
    return {
      shots,
      shotErrors,
      accuracyPct: shots > 0 ? Math.round((landed / shots) * 100) : 0,
      topSpinPct: shots > 0 ? Math.round((topSpinShots / shots) * 100) : 0,
      maxSpeedKmh,
      durationMs: Math.max(0, (endMs === null ? now() : endMs) - startMs),
    };
  }

  return { recordShot, recordPoint, stop, reset, getStats };
}

/** Total points played, from a list of finished sets: [{ player, opponent }]. */
export function totalPointsFromSets(sets = []) {
  return sets.reduce((sum, s) => sum + (s.player | 0) + (s.opponent | 0), 0);
}
