// Swing preparation — the biomechanical governor the player was missing.
//
// WHY THIS EXISTS. Real table-tennis rallies are self-limiting. Not because
// the rubber is dead, but because a player receiving a fast ball has less
// time and physically cannot produce a full stroke: the arm shortens the
// swing, the shot loses pace, and the exchange settles. Stroke energy is
// budgeted by preparation. That negative feedback loop is the whole reason
// two humans can rally without the ball accelerating off the table.
//
// The AI already lives under exactly that constraint. interception.js places
// its windup anchor contactSpeed × swingDur/2 behind the contact and hard-
// caps it at WINDUP_DISTANCE_MAX_M = 0.85 ("the biggest backswing a human
// plays"), then rejects any plan whose peak speed exceeds max_paddle_speed ×
// 1.1. The player had no equivalent. A VR flick costs ~150 ms and a 100 g
// controller no matter what is coming across the net, so the player could
// produce a maximum-energy stroke against any ball at any rally speed.
//
// WHAT THAT BROKE. PLAYER_SPIN_GAIN (2.5) compensates a controller swing
// reaching roughly a fifth of real racket-head speed. It multiplies
// spinCaptureGain — but the friction impulse that spins the ball also pushes
// it, and impulse.js correctly locks the two together through
// HOLLOW_SPHERE_MOI_FACTOR (Δv_t = (2/3)·R·Δω). So the gain necessarily
// scales the LINEAR kick too:
//
//     gain 35   (AI)      kick 0.467 m/s per m/s of slip
//     gain 87.5 (player)  kick 1.167 m/s per m/s of slip
//
// Above 1.0 means a brushing swing injects more linear speed than the slip
// it came from, and PADDLE_CONTACT_SPEED_CAP deliberately caps only the
// NORMAL component, so nothing bounded that channel. Against the AI it is
// invisible: paddleSolver inverts a target landing point through (1 + e) and
// dissipates the surplus every other stroke. Between two humans there is no
// governor, so it compounds — which is what MULTIPLAYER_PADDLE_COR_SCALE (now
// removed) was trimming, in the wrong term (normal reflection) for the wrong
// cause.
//
// THE MODEL. Gain is earned, not granted. At contact we measure how far the
// paddle actually travelled along its swing axis since the stroke's
// turnaround, and ramp the compensation between "no stroke at all" (raw
// physics, gain 1.0) and "a committed stroke" (full PLAYER_SPIN_GAIN). A
// hurried jab at an incoming smash gets what a real blocker gets: the
// reflection, and nothing extra. Faster rally → less preparation → less
// amplification → pace self-limits, in BOTH modes, with no per-mode constant.
//
// This file is pure and side-effect-free: no THREE, no DOM, no module state.
// Positions come in as plain numbers so tests can drive a stroke directly.

// Stroke travel (m, measured along the swing axis) at or below which no
// compensation is applied. A block or a stab: the paddle is placed, not
// swung. 0.10 m is about the length of a wrist-only jab.
export const SWING_PREP_MIN_M = 0.10;

// Stroke travel at which the full PLAYER_SPIN_GAIN is earned. Calibrated
// against the 20-contact headset capture behind PLAYER_SPIN_GAIN itself
// (2026-09-02: median paddle face-centre speed 2.68 m/s): a committed ~150 ms
// forward stroke at that measured median covers ~0.40 m. So a normal rally
// stroke keeps today's feel and full gain — the governor is meant to bite on
// hurried shots, not to quietly nerf every stroke. Well under the AI's
// WINDUP_DISTANCE_MAX_M (0.85), which is a maximum, not a typical.
export const SWING_PREP_FULL_M = 0.40;

// Only motion within this many seconds of contact counts as part of the
// stroke. Without it, slowly carrying the paddle across the room between
// rallies would accumulate into "preparation".
export const SWING_PREP_WINDOW_SEC = 0.5;

// Forward speed (m/s) below which a sample is drifting, not stroking. Ends
// the walk-back the same way a turnaround does — a hand creeping forward at
// 5 cm/s is holding the paddle out, not winding up.
export const SWING_PREP_STALL_MPS = 0.15;

// Ring capacity. 72 samples covers 0.6 s at 120 Hz and 0.8 s at 90 Hz — a
// comfortable margin over SWING_PREP_WINDOW_SEC at every Quest refresh rate.
export const SWING_PREP_CAPACITY = 72;

// Smoothstep so the gain has no corner a player can feel as a step change
// mid-stroke. Below MIN → 0, above FULL → 1.
export function preparationFraction(
  travelM,
  minM = SWING_PREP_MIN_M,
  fullM = SWING_PREP_FULL_M,
) {
  if (!(travelM > minM)) return 0;
  if (!(fullM > minM)) return 1;
  if (travelM >= fullM) return 1;
  const u = (travelM - minM) / (fullM - minM);
  return u * u * (3 - 2 * u);
}

// Map stroke travel to the spin-capture multiplier actually applied at
// contact. Always ≥ 1: this compensates a slow input, it never generates
// LESS spin than the physics says (the same floor setPlayerSpinGain clamps
// to). maxGain is PLAYER_SPIN_GAIN, so the tuner row still governs the top.
export function preparationGain(travelM, maxGain, minM, fullM) {
  if (!(maxGain > 1)) return 1;
  return 1 + (maxGain - 1) * preparationFraction(travelM, minM, fullM);
}

// A fixed-size ring of timestamped paddle face-centre positions.
//
// Zero-alloc by construction: one flat Float64Array laid out as
// [t, x, y, z] per slot, no objects created in sample() or strokeTravel().
// tickPhysics runs this every XR frame and a GC pause on Quest's mobile heap
// reads as a dropped frame, which is precisely where the ball is being
// watched — the same rule ball.js and rollout.js already follow.
export class SwingTracker {
  constructor(capacity = SWING_PREP_CAPACITY) {
    this.capacity = Math.max(2, capacity | 0);
    this.buf = new Float64Array(this.capacity * 4);
    this.head = 0;   // next slot to write
    this.count = 0;  // total pushed (saturates conceptually at capacity)
  }

  reset() {
    this.head = 0;
    this.count = 0;
  }

  // Record where the paddle face centre is at time t (seconds, arbitrary
  // origin — the same clockTime the tick already carries).
  sample(t, x, y, z) {
    const i = this.head * 4;
    this.buf[i] = t;
    this.buf[i + 1] = x;
    this.buf[i + 2] = y;
    this.buf[i + 3] = z;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  // Distance the paddle travelled along `dir` since the stroke began.
  //
  // Walks backwards from the newest sample, accumulating the forward
  // projection of each frame's displacement, and stops at the first sample
  // that is not part of this stroke:
  //   - projection ≤ 0        the swing reversed — this is the turnaround,
  //                           i.e. the end of the backswing
  //   - forward speed < stall the paddle was drifting, not stroking
  //   - older than the window it belongs to a previous stroke
  //
  // `dir` need not be normalized (callers pass the paddle velocity straight
  // in). A zero-length direction — a genuinely stationary paddle — returns 0,
  // which is the correct answer: a passive block earns no compensation.
  strokeTravel(dirX, dirY, dirZ) {
    const n = this.count;
    if (n < 2) return 0;
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    if (!(len > 1e-9)) return 0;
    const nx = dirX / len;
    const ny = dirY / len;
    const nz = dirZ / len;

    const cap = this.capacity;
    const buf = this.buf;
    const newestSlot = (this.head - 1 + cap) % cap;
    const tNewest = buf[newestSlot * 4];

    let travel = 0;
    for (let k = 0; k < n - 1; k++) {
      const newer = ((this.head - 1 - k) % cap + cap) % cap;
      const older = ((this.head - 2 - k) % cap + cap) % cap;
      const oi = older * 4;
      const ni = newer * 4;
      const tOlder = buf[oi];
      if (tNewest - tOlder > SWING_PREP_WINDOW_SEC) break;
      const dt = buf[ni] - tOlder;
      if (!(dt > 0)) break;
      const proj =
        (buf[ni + 1] - buf[oi + 1]) * nx +
        (buf[ni + 2] - buf[oi + 2]) * ny +
        (buf[ni + 3] - buf[oi + 3]) * nz;
      if (proj <= 0) break;                       // turnaround
      if (proj / dt < SWING_PREP_STALL_MPS) break; // drifting, not stroking
      travel += proj;
    }
    return travel;
  }
}
