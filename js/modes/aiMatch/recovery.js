// Recovery — owns the timing constants that govern the AI's post-contact
// "follow-through and return to ready" window. Spec §recovery_design.
//
// Two key spec rules expressed here:
//   1. Pro AI has the LONGEST recovery, not shortest (counterintuitive).
//      A bigger swing needs deeper biomechanical recovery; that creates the
//      vulnerability window skilled players exploit with quick returns.
//      Without it, Pro mode has no skill ceiling.
//   2. During RECOVERING, paddle movement speed is multiplied by 0.4 (i.e.
//      the AI moves at 40% of normal). A quick player return during this
//      window forces a scramble or miss. This is THE primary skill-ceiling
//      mechanic in the entire game.
//
// The "no instant reset" rule (spec §recovery_design.no_instant_reset_rule)
// is enforced by the FSM's update loop — it drives the paddle toward
// readyPose via driveTowardPose at a rate-limited speed, never snaps. The
// constant below is the rate cap that produces the visible vulnerability.

// Recovery durations per difficulty, in milliseconds.
//
// Lengthened for the higher tiers alongside the international re-tune: the
// attacking strokes now leave the bat at up to 22-25 m/s, and a bigger swing
// is a longer recovery. This is also the ONLY counter a human has against a
// tier hitting faster than reaction time — take the vulnerability window away
// and the AI stops being beatable rather than becoming harder.
export const RECOVERY_MS = Object.freeze({
  beginner: 300,
  intermediate: 420,
  pro: 450,
});

// Spec §recovery_design.vulnerability_window. Pinned at 0.4 — the AI moves
// at 40% normal speed during the entire RECOVERING state.
export const VULNERABILITY_SPEED_MULTIPLIER = 0.4;

// Helper used by tests and any external observer that needs to know whether
// the AI is currently exploitable. Returns true while elapsedMs < duration.
export function isWithinVulnerabilityWindow(elapsedMs, difficulty) {
  const duration = RECOVERY_MS[difficulty] || RECOVERY_MS.beginner;
  return elapsedMs >= 0 && elapsedMs < duration;
}

// Look up the recovery duration with a Beginner fallback for unknown values.
export function recoveryDurationMs(difficulty) {
  return RECOVERY_MS[difficulty] || RECOVERY_MS.beginner;
}
