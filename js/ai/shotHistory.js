// Ring buffer of recent shots with per-shot decay weights. Owned by the AI
// worker — never imported on the main thread.
//
// A shot is a numeric array matching the wire schema posted from
// shotAdapter:
//   [shot_id, timestamp_ms, landing_x, landing_z, success,
//    swing_lateness_ms, ball_speed_at_contact_mps, ball_spin_rps,
//    sent_spin_rps, sent_speed_mps]
//
// Fields [6]/[7] are the ball state the player HAD at their contact —
// back-filled only when they reached it, so they are useless for scouting
// misses. Fields [8]/[9] are what the AI SENT (signed top/back rps and
// speed, sampled just after the shot's bounce on the player's half) —
// present on every record including misses, which is exactly what the spin
// scouting below needs: "they missed" is the strongest signal, and it must
// carry WHAT they missed against. Older 8-element records simply leave the
// new fields undefined and are skipped by the scout.
//
// Internally each shot is stored as an object keyed by field name plus a
// `weight` that decays every push. Tests at t+5/t+10/t+20 read directly off
// this weight to confirm the decay schedule matches spec (0.93 per rally).

export const SHOT_FIELDS = [
  'shot_id',
  'timestamp_ms',
  'landing_x',
  'landing_z',
  'success',
  'swing_lateness_ms',
  'ball_speed_at_contact_mps',
  'ball_spin_rps',
  'sent_spin_rps',
  'sent_speed_mps',
];

export const DEFAULT_CAPACITY = 15;
export const DEFAULT_DECAY = 0.93;

function arrayToShot(arr) {
  const obj = {};
  for (let i = 0; i < SHOT_FIELDS.length; i++) obj[SHOT_FIELDS[i]] = arr[i];
  return obj;
}

export class ShotHistory {
  constructor({ capacity = DEFAULT_CAPACITY, decay = DEFAULT_DECAY } = {}) {
    this.capacity = capacity;
    this.decay = decay;
    this.buf = [];
  }

  // Insert a new shot. Existing shots age by one decay step BEFORE the new
  // shot lands at weight 1.0 — this is what makes the t+N test cases work
  // out to exactly decay^N (not decay^(N+1)).
  //
  // If a shot with the same shot_id already exists, treat the call as an
  // in-place update (the success field is back-filled this way by the
  // adapter once a rally outcome is known) rather than a new sample. This
  // prevents the same rally from being decayed twice or double-counted.
  push(shot) {
    const incoming = Array.isArray(shot) ? arrayToShot(shot) : { ...shot };

    const existingIdx = this.buf.findIndex(s => s.shot_id === incoming.shot_id);
    if (existingIdx >= 0) {
      const prev = this.buf[existingIdx];
      this.buf[existingIdx] = { ...prev, ...incoming, weight: prev.weight };
      return;
    }

    for (const s of this.buf) s.weight *= this.decay;

    incoming.weight = 1.0;
    this.buf.push(incoming);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  getAll() { return this.buf.slice(); }
  size() { return this.buf.length; }
  reset() { this.buf.length = 0; }
}

// --- Spin scouting -----------------------------------------------------------
//
// The spatial struggle heatmap learns WHERE the player fails; this learns
// WHAT they fail against. Every AI shot is classed by the top/back spin it
// arrived with (sent_spin_rps, physical scale), and the same struggle
// scoring the heatmap uses (miss 3, lateness/100 × 2, success −0.3) is
// accumulated per class with the ring buffer's decay weights — so a player
// who has STOPPED missing against backspin ages out of the exploit.
//
// Class thresholds are on the AI's OUTGOING spin: a −12 rps ball (≈75 rad/s
// backspin) is a genuine push/slice-family ball; +20 rps is unmistakable
// topspin. Between them is flat-ish and scouts nothing.
export const SPIN_CLASS_BACKSPIN_MAX_RPS = -12;
export const SPIN_CLASS_TOPSPIN_MIN_RPS = 20;
// Minimum decayed sample mass in a class before it can be exploited —
// two lucky misses must not brand a player "can't handle backspin".
export const SCOUT_MIN_CLASS_SAMPLES = 3;
// The winning class must beat the runner-up by this factor, and clear this
// absolute struggle floor, or the scout stays silent (no exploit).
export const SCOUT_DOMINANCE_FACTOR = 1.3;
export const SCOUT_MIN_STRUGGLE = 0.8;

export function spinClassOf(sentSpinRps) {
  if (typeof sentSpinRps !== 'number' || !Number.isFinite(sentSpinRps)) return null;
  if (sentSpinRps <= SPIN_CLASS_BACKSPIN_MAX_RPS) return 'backspin';
  if (sentSpinRps >= SPIN_CLASS_TOPSPIN_MIN_RPS) return 'topspin';
  return 'flat';
}

// shots: ShotHistory.getAll() output. Returns
//   { weakness: 'backspin'|'topspin'|'flat'|null, classes: {cls: {score, mass}} }
// weakness is null until one class dominates with enough evidence.
export function computeSpinScouting(shots) {
  const classes = {
    backspin: { score: 0, mass: 0 },
    flat:     { score: 0, mass: 0 },
    topspin:  { score: 0, mass: 0 },
  };
  for (const s of shots || []) {
    const cls = spinClassOf(s.sent_spin_rps);
    if (!cls) continue; // pre-schema record
    const w = typeof s.weight === 'number' ? s.weight : 1;
    const struggle = (s.success ? -0.3 : 3)
      + ((s.swing_lateness_ms || 0) / 100) * 2;
    classes[cls].score += struggle * w;
    classes[cls].mass += w;
  }
  let best = null;
  let bestAvg = -Infinity;
  let runnerUpAvg = -Infinity;
  for (const [cls, c] of Object.entries(classes)) {
    if (c.mass < SCOUT_MIN_CLASS_SAMPLES) continue;
    const avg = c.score / c.mass;
    if (avg > bestAvg) { runnerUpAvg = bestAvg; bestAvg = avg; best = cls; }
    else if (avg > runnerUpAvg) { runnerUpAvg = avg; }
  }
  const dominates = best !== null
    && bestAvg >= SCOUT_MIN_STRUGGLE
    && (runnerUpAvg === -Infinity || bestAvg >= runnerUpAvg * SCOUT_DOMINANCE_FACTOR || runnerUpAvg <= 0);
  return { weakness: dominates ? best : null, classes };
}
