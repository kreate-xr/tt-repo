// Ring buffer of recent shots with per-shot decay weights. Owned by the AI
// worker — never imported on the main thread.
//
// A shot is an 8-element numeric array matching the wire schema posted from
// shotAdapter:
//   [shot_id, timestamp_ms, landing_x, landing_z, success,
//    swing_lateness_ms, ball_speed_at_contact_mps, ball_spin_rps]
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
