// Physics tuning constants. Validated in MR — change with care.
//
// Tunables marked `let` are runtime-mutable via the setters below (used by the
// in-XR PhysicsTuner panel for A/B tuning without rebuild). ESM live bindings
// mean consumers reading `DRAG_COEFFICIENT` inside a per-frame function pick
// up the new value automatically — no re-import needed.

// Master toggle for the "weighty ball" perception pass — gates haptics, paddle
// pose smoothing, drag, sub-bass thud, and impact squash. Flip to false to A/B
// against the original floaty feel in headset without reverting code.
export const WEIGHTY_BALL_ENABLED = true;

// Gravity bumped past Earth-real so drops read as "authoritative" — a real
// ping-pong ball's arc is loopy; -12 gives it a flatter, more decisive drop
// that reads as "this thing has mass pulling it down." Combined with lower
// drag below, the ball punches through air like a heavier object.
export let GRAVITY = WEIGHTY_BALL_ENABLED ? -12.0 : -9.8;

// Aerodynamic buoyancy on the ball. F_B = ρ_air · V · g (upward), acceleration
// = F_B / m = ρ_air · V · g_real / m. For an ITTF ball (r=0.02, m=0.0027) in
// air (ρ=1.2 kg/m³) at real g=9.81:
//     a_B = 1.2 · (4/3)π(0.02)³ · 9.81 / 0.0027 ≈ 0.146 m/s² upward
// This is ~1.2% of the tuned GRAVITY magnitude — imperceptible in a single
// arc but present so long lobs (~2 s aloft) don't cheat by omission. Uses the
// REAL g (not the tuned GRAVITY value) because buoyancy is a property of the
// displaced-air weight, not of whatever gravity the sim wants for feel.
// Applied only in flight (not at contacts) via ballVelocity.y += this * dt.
export const BUOYANCY_ACCEL = 0.146;

// Spin tuning — vertical brush → top/back, horizontal brush → left/right sidespin.
// Spin is driven by RELATIVE tangent velocity (paddle − ball) at contact, so a glancing
// ball generates spin even with a stationary paddle (slice physics).
//
// Physical no-slip ceiling for a solid sphere of radius R is Δω = (5/(7R))·(v_t × n),
// so the coefficient is 5/(7·0.02) ≈ 35.7. Ping-pong rubber is tacky and the
// contact is elastic enough that a well-brushed hit gets close to that limit;
// 35 is ~98% of no-slip and lines up with how much spin real players generate
// off a brush. Downstream paths (edge scale, air drag) model different physical
// effects rather than the same one — no double-counting to compensate for here.
export const SPIN_CAPTURE_GAIN = 35;
// Magnus curvature. Applied as a = MAGNUS_COEFFICIENT · (ω × v). Real
// ping-pong ball has k_m ≈ 3e-6 N·s/rad; divided by the 2.7 g ball mass
// that's an effective a-coefficient of ~1.1e-3 (subtle curve, most of the
// lateral displacement accumulates late in flight per Δx = ½·a·t²). The
// sim runs somewhat above realistic so the curve is legible in VR, but
// 0.018 was too aggressive: it made the ball visibly curve from the very
// first frames after paddle contact, breaking the "flies mostly straight,
// kicks after the bounce" perception real players expect. That perception
// is real physics — pure vertical sidespin can't be transferred into
// lateral velocity by the table bounce (contact is on the spin axis, ω × r
// = 0), so all lateral motion comes from Magnus, and half-·a·t² makes it
// mostly manifest in the second half of the trajectory when the coefficient
// is at a realistic level.
//
// 0.010 gives (2× original 0.005, still below the 0.018 that was "too much"):
//   ω = 50 rad/s (light brush), v = 5 m/s: a_M = 2.5 m/s²  → ~14 cm bounce-time
//   ω = 100 rad/s (moderate),   v = 8 m/s: a_M = 8 m/s²    → ~35 cm
//   ω = 200 rad/s (heavy),      v = 10 m/s: a_M = 20 m/s²  → ~90 cm
// The 2× bump is a deliberate readability trade-off: the AI's shot vocabulary
// (LOOP with heavy topspin vs SLICE with heavy backspin vs SMASH with none)
// is only visually distinguishable if the resulting flight ARCS differ. At
// 0.005 the AI's engine picked "loop" vs "drive" and the ball landed in
// nearly the same spot with an indistinguishable arc — players couldn't
// see the shot type they were playing against. 0.010 shows a real dip on
// topspin and float on backspin while staying under the 0.018 threshold
// that broke the "flies straight, then kicks" perception.
export let MAGNUS_COEFFICIENT = 0.010;
// Vertical Magnus scale — controls topspin drop / backspin lift visibility.
// Was 0.85 (dampening the vertical curve to keep "runaway dips" in check).
// Lifted to 1.0 so topspin loops actually DIVE into the court and backspin
// slices actually FLOAT — the two most recognizable spin arcs in table
// tennis. Combined with the MAGNUS_COEFFICIENT bump above, a heavy loop
// now drops ~30-40 cm more than a flat drive over the same range, which
// reads to the eye as "that ball is spinning."
export const MAGNUS_VERTICAL_SCALE = 1.0;
// Air drag on rotation. Applied as ω *= exp(-SPIN_DAMPING * dt) per frame.
// Real 2.7 g ping-pong balls lose ~5–10% of spin per second to air; at 0.35
// this was ~30%/sec, killing Magnus curve before it could bend the trajectory.
// 0.10 matches the real-world upper bound and lets a spinny shot keep visibly
// curving across the full flight. `let` for PhysicsTuner.
export let SPIN_DAMPING = 0.10;

// Quadratic air drag on the ball. The old linear model (v *= 1 - k·dt) bled
// the same fraction of speed per second at every velocity — physically wrong.
// Real drag is F_d = ½·ρ·Cd·A·v², i.e. dv/dt = -k·|v|·v with k ≈ 0.14 for a
// 40 mm 2.7 g ITTF ball. Under the quadratic model a smash bleeds much more
// speed per second than a soft push, so hard hits arrive slower and soft
// touches carry farther — the correct physical behavior.
// 0.10 is slightly under the true physical value: the linear model tuned
// around 0.35 was clearly over-damped at rally speeds, and 0.10 gives a
// rally-typical 6 m/s ball a comparable half-life to the old model while
// letting fast smashes actually bleed and slow dinks actually float. Applied
// per Euler step as v_next = v / (1 + k·|v|·dt) — semi-implicit form, stable
// at any dt. Set to 0 to disable drag entirely.
export let DRAG_COEFFICIENT = WEIGHTY_BALL_ENABLED ? 0.10 : 0;

// Table friction — couples spin to linear velocity on bounce. Both are the
// same friction impulse J at the contact point, so they should be at the
// same fraction of the no-slip physical ceiling. The linear coefficient
// 0.12 corresponds to 42% of no-slip ((2/7)·|slip|); the angular coefficient
// needs to match that fraction: 0.42·5/(7R) with R=0.02 gives 15.
//
// Player-chosen trade-off: raised from 5 to 12 to make backspin actually
// brake and topspin actually kick forward off the bounce. The visual had
// a sampling constraint at 3-fold ball symmetry — 15 Hz Nyquist at 90 Hz
// VR meant very-high spins wagon-wheeled and appeared to spin backward.
// That's since been resolved: the ball texture in models.js now carries a
// SINGLE asymmetric anchor (an off-hemisphere cert dot) plus a manufacturing
// seam line, dropping effective symmetry to 1-fold and lifting the Nyquist
// ceiling to ~45 Hz. `let` so PhysicsTuner can still drop this back toward
// 5 in-headset if a specific rally aesthetic calls for it.
export let TABLE_SPIN_GAIN = 12;
export const TABLE_LINEAR_FRICTION = 0.12;

// Table COR reference (median of the speed-dependent curve — see
// tableRestitution()). Tuner adjusts this scalar; the hi/lo offsets below
// preserve the curve shape while shifting overall bounciness. A very light
// drop bounces at ~median + HI_OFFSET, a hard smash at ~median + LO_OFFSET
// (LO_OFFSET is negative). Physical rationale: real tables lose more energy
// at high impact speed because the wood-composite deck flexes and the ball
// deforms more — a soft drop is nearly elastic, a slam is not.
export let TABLE_RESTITUTION = 0.75;
export const TABLE_RESTITUTION_HI_OFFSET = 0.13;   // low-speed lift
export const TABLE_RESTITUTION_LO_OFFSET = -0.13;  // high-speed loss
export const TABLE_RESTITUTION_V_STAR    = 4.0;    // m/s transition scale

// Discrete lateral velocity kick at the table bounce, driven by ω_y (sidespin).
// Applied as Δv = TABLE_SIDESPIN_KICK · ω_y in the direction perpendicular to
// the ball's horizontal velocity (matching the direction Magnus is already
// curving the ball).
//
// Physical justification: ideal-rigid-ball-on-rigid-table physics predicts
// zero lateral kick from pure vertical sidespin — the contact point sits on
// the spin axis so ω × r = 0 at the bottom of the ball, and friction has
// nothing to grab. Real ping-pong contacts have a finite-size deformable
// patch: off-axis points in the patch DO have tangential surface velocity
// from ω_y, and asymmetries in the deformation history and table micro-
// texture leave a small net lateral friction impulse. The effect is tiny
// physically (~1–5 cm/s for typical amateur spin) but real ping-pong
// players observe and rely on it as a bounce "kick" that reads distinct
// from the pre-bounce Magnus drift.
//
// In VR at low ball speeds the physical value is not visually legible, so
// we exaggerate: 0.010 gives ~1 m/s kick for a moderate ω_y=100 rad/s serve
// on a fully-formed bounce. Combined with a subtle MAGNUS_COEFFICIENT this
// produces the perception players intuitively expect: ball flies mostly
// straight in the air, then clearly kicks laterally at the bounce.
//
// Gated on bounce impact (|v_y| > 0.3 m/s and linearly ramping to full at
// |v_y| = 1.5 m/s) in ball.js. Without that gate every marginal residual
// hop fires a kick perpendicular to the ball's current direction of travel,
// which acts as a centripetal force and spirals the ball in loops on the
// table instead of letting it die out. The gate matches the physical
// mechanism — finite-patch effects only matter when contact force is real.
export let TABLE_SIDESPIN_KICK = 0.010;

// --- Table edge ("edge ball" — spec P8) ------------------------------------
// When the ball grazes the top edge of the table (center outside the XZ AABB
// but within one ballRadius of the perimeter line at tableSurfaceY), it
// deflects along a radial normal instead of the flat (0,1,0) — producing the
// signature "unreturnable edge ball" that skews low and outward. Spec P8
// says spin coupling is optional here ("plain reflection with en is
// acceptable"). We do plain reflection + a stiffer spin damp because edge
// contact is chaotic and the ball is spun by the corner curvature in a way
// no simple friction model captures — killing spin to a residual is more
// honest than pretending we're transferring it accurately.
export const TABLE_EDGE_SPIN_DAMP    = 0.6;
// Edge contacts feel a bit less lively than a flat top-face bounce because
// the collision is against the deck's beveled rim, not the sponge-backed
// playing surface. Scale the tableRestitution() output by this factor.
export const TABLE_EDGE_COR_SCALE    = 0.85;

// Net (soft cloth — most kinetic energy absorbed).
export const NET_NORMAL_RESTITUTION = 0.1;
export const NET_TANGENT_DAMP = 0.4;
export const NET_SPIN_DAMP = 0.3;

// --- Net top-cord (the "let ball" moment) ----------------------------------
// A ball clipping the top of the net cord is physically distinct from a ball
// hitting the middle/face of the net cloth. The cord is a tensioned string:
// it absorbs almost all vertical energy (ball basically dies on it), but
// preserves more horizontal drift than the cloth face (so the ball can
// dribble over the top), AND introduces small unpredictable lateral
// deflection from cord tension asymmetry and finite-cord-diameter geometry.
// Real players see this moment constantly and instantly recognize it — the
// uniform slab math treated it as a boring face-of-net hit.
export const NET_TOP_CORD_RESTITUTION    = 0.05;   // stiffer vertical damp than face
export const NET_TOP_CORD_TANGENT_KEEP   = 0.60;   // vs 0.40 face — preserves dribble-over
export const NET_TOP_CORD_LATERAL_JITTER = 0.15;   // m/s, random horizontal impulse magnitude

// Paddle COR reference (median of the speed-dependent curve — see
// paddleRestitution()). Real rubber is near-elastic at low impact speed
// (~0.90) and drops toward ~0.72 on hard smashes as sponge damping and ball
// deformation eat energy. Tuner adjusts this scalar; hi/lo offsets shift the
// curve endpoints in lockstep so cranking "Bounciness" preserves the
// speed-dependent shape while raising or lowering overall liveliness.
export let PADDLE_RESTITUTION = WEIGHTY_BALL_ENABLED ? 0.82 : 0.9;
export const PADDLE_RESTITUTION_HI_OFFSET = 0.08;   // low-speed lift
export const PADDLE_RESTITUTION_LO_OFFSET = -0.10;  // high-speed loss
export const PADDLE_RESTITUTION_V_STAR    = 6.0;    // m/s transition scale

// Asymptotic ceiling on effective paddle contact speed fed to the impulse
// math. Represents the maximum face velocity a human arm can realistically
// produce with a real paddle (~200 g + arm inertia rate-limit acceleration).
// VR removes that rate-limit — a 100 g controller in free space can produce
// 15+ m/s of face velocity from a wrist flick, which the (1+e) reflection
// amplifies into a rocketing outgoing ball.
//
// Applied as a TANH SOFT-CLIP inside computeImpulse (not a hard clamp): |v|
// scales as cap·tanh(|v|/cap), so swings below the cap feel 1:1, swings near
// the cap see diminishing returns, and swings well past it hit hard but
// stay bounded — the ball "resists" being accelerated further, which is
// exactly how muscle recruitment behaves in reality. Set to 0 to disable.
export let PADDLE_CONTACT_SPEED_CAP = WEIGHTY_BALL_ENABLED ? 6.5 : 0;

// --- Edge / rim strikes -----------------------------------------------------
// Player-only. When the ball straddles the paddle rim (radialDist within one
// ballRadius of hitRadius) we override the standard rubber-face impulse with
// a wood-blade edge model: stiffer restitution (bare wood has less give than
// sponge rubber), reduced spin capture (no rubber grip → nearly frictionless
// tangential contact), and a randomized normal within a cone so the ball flies
// off in an unpredictable direction. This reproduces the signature TT "edge
// ball" moment. AI paddles skip this branch — their solver plans clean face
// hits and the AI's own edge-zone contacts fall back to standard physics.
export const PADDLE_EDGE_RESTITUTION = 0.92;
// Edge-zone spin retention. The edge band is the 3–5 cm annulus between the
// physical rubber radius and (radius + swingMargin + ballRadius). A pure wood-
// blade contact (bare wood + ball) retains essentially no grip, but many hits
// in this band are physically rubber-rim-on-ball — the ball's rim overlaps
// the rubber even though the ball's center is just past the rubber edge. Real
// rubber-rim strikes preserve roughly half the spin of a face hit; 0.5 is a
// reasonable single-value approximation across the whole band. Going lower
// (the prior 0.15) treated every band hit as bare-wood and silently killed
// spin for hits that were physically still on rubber.
export const PADDLE_EDGE_SPIN_SCALE = 0.5;
export const PADDLE_EDGE_NORMAL_JITTER_RAD = 0.26;  // ~15° cone half-angle

// --- Sweet-spot falloff -----------------------------------------------------
// Real paddles have a center of percussion where COR and spin transfer peak
// and both fall off toward the rim. Old code was binary: full rubber physics
// inside faceRadius, wood-blade edge model outside. That step ignores the
// perceptual gradient every skilled player uses to judge contact quality.
// We model a smooth falloff of restitution and spin capture from the face
// center out to the rim (see sweetSpotFactor). Squared falloff so the center
// has a genuine sweet ~60% of the face where the ball flies clean, then rolls
// off harder toward the rim. Edge strikes bypass this and use their own
// scalar model (PADDLE_EDGE_RESTITUTION / PADDLE_EDGE_SPIN_SCALE).
//
// Rim reaches ~SWEET_SPOT_MIN_FACTOR of peak. 0.85 gives a felt but not
// punishing off-center penalty — a rim face hit still returns, it just
// bleeds ~15% extra energy and spin vs a clean center strike.
export const SWEET_SPOT_MIN_FACTOR   = 0.85;
// Inverse haptic scaling — off-center hits vibrate MORE (the bat rings in
// the hand), not less. 0.35 means a rim face hit feels ~35% stronger in
// haptic intensity than a center hit at the same impact speed.
export const SWEET_SPOT_HAPTIC_BOOST = 0.35;

// Fraction of the paddle-angular-velocity × r_contact contribution folded into
// vContact. A wrist snap can generate 60+ rad/s of paddleW, which at r≈0.07 m
// adds 4+ m/s of purely-rotational contact speed on top of the linear swing.
// Real players can't produce those angular rates because the paddle+arm mass
// resists it. Damping this contribution (not the linear swing) targets the
// wrist-flick free-ride without softening deliberate strokes. 1.0 = original
// full contribution. 0.85 under weight-sim: previous 0.7 combined with the
// angular-velocity median filter (since removed — see ball.js _velSamples
// comment) was double-cutting brush strokes. With the filter no longer
// killing wrist-snap peaks, we can tighten this closer to 1.0 and get brush
// spin back while still trimming the very worst wrist-flick rockets.
// PADDLE_CONTACT_SPEED_CAP handles the rocket case on the normal component.
export const PADDLE_ANGULAR_CONTRIBUTION = WEIGHTY_BALL_ENABLED ? 0.85 : 1.0;

export const HIT_COOLDOWN = 0.05;

// --- Floor collision (spec P8) --------------------------------------------
// Two Y levels are relevant here:
//   FLOOR_LEVEL_Y (0): the actual visible floor plane in arena mode. Ball
//     bounces here with FLOOR_RESTITUTION and loses spin/tangential energy
//     to friction. Without this, missed shots visibly clip through the arena
//     floor before disappearing — a first-30-seconds VR immersion break.
//   FLOOR_Y (-2): safety net for the "ball tunneled somehow" edge case.
//     Under normal play the floor bounce dissipates all vertical energy long
//     before the ball reaches this level, so this trigger effectively only
//     fires as a bug catch.
// Spec P8: en = 0.7, μ = 0.3, same P5/P6 math with floor plane.
export const FLOOR_LEVEL_Y     = 0;
export const FLOOR_RESTITUTION = 0.7;
export const FLOOR_FRICTION    = 0.25;   // tangential energy loss per bounce
export const FLOOR_SPIN_DAMP   = 0.85;   // ω decay per floor contact — carpet-like
export const FLOOR_Y = -2;

// Pseudo-haptic paddle pose smoothing — per-frame lerp/slerp alpha applied to
// the visual paddle's world transform as it follows the controller grip.
// alpha=1 → instant snap (the paddle is the controller, zero added lag);
// alpha<1 → effective lag of dt/alpha seconds, adds perceived weight per
// Rietzler "Breaking the Tracking" but reduces 1:1 control fidelity.
//
// DEFAULT IS 1.0 — the controller should feel like the paddle. The smoothing
// is preserved as a tunable for players who want weight feel over precision;
// drop both to ~0.6/0.85 via the PhysicsTuner panel to A/B.
export let PADDLE_POS_SMOOTHING = 1.0;
export let PADDLE_ROT_SMOOTHING = 1.0;

// Squash-and-stretch on paddle contact — purely visual, does not affect physics.
// Ball briefly compresses to (1+amount, 1-amount, 1+amount) and recovers linearly.
// Disabled by default: players read the per-bounce vertex deformation as the
// ball "changing shape" during rapid rallies, especially on table + floor
// bounces where the effect stacks. The physics tuner still exposes the knob
// via setSquashAmount() if a subtler version (e.g. 0.02, paddle-only) is
// wanted — set it back non-zero to re-enable.
export const SQUASH_DURATION = 0.08;   // seconds
export let SQUASH_AMOUNT = 0.0;        // 0 = off. Was 0.05.

// Haptic pulse on paddle hit. Intensity scales linearly with impact speed and
// clamps to [floor, 1]; duration interpolates from short for soft taps to longer
// for hard smashes (longer pulses psychoacoustically read as more mass).
export const HAPTIC_FLOOR = 0.25;
export let HAPTIC_MAX_SPEED = 8.0;      // m/s at which intensity saturates at 1.0
export const HAPTIC_DURATION_MIN_MS = 60;
// Paddle impact envelope target: main pulse (up to 160 ms) + tail (~100 ms) in
// pulseImpact() → ~260 ms total felt event on hard hits. 120 ms flat pulses
// read as clicks; the arm-nerve integration window for weight is ~200 ms, so
// keeping the main pulse ≥ 160 ms is what makes hits feel meaty.
export const HAPTIC_DURATION_MAX_MS = 160;
// Lighter pulse on table bounce so the floor has felt presence.
export const HAPTIC_BOUNCE_SCALE = 0.4;

// Swing whoosh — synthesized wind sound during fast paddle motion. Reinforces
// "cutting through air with a substantial object" without introducing visual
// lag. Below threshold the sound is silent; above max_speed, gain saturates.
export const SWING_WHOOSH_THRESHOLD = 1.0;   // m/s, below this no sound
export const SWING_WHOOSH_MAX_SPEED  = 6.0;  // m/s, full saturation point
export const SWING_WHOOSH_MAX_GAIN   = 0.22; // peak gain (audio is band-limited noise)

// Ball rolling audio — persistent bandpass-filtered noise, spatialized at
// the ball position, gain-modulated by horizontal speed. Only audible when
// the ball is on a surface (see ball.js — gated on the same near-surface
// conditions as ROLLING_FRICTION). Threshold-gated so a stationary ball is
// silent (avoids background hiss on a static settled ball).
//
// Peak gain kept subtle — the rolling sound is a scene-continuity cue, not a
// gameplay one. Loud rolling would compete with the ambient bed and pull
// attention from paddle/table impacts.
export const BALL_ROLL_MIN_SPEED = 0.15;   // m/s horizontal — below this, silent
export const BALL_ROLL_MAX_SPEED = 2.0;    // m/s — full saturation
export const BALL_ROLL_MAX_GAIN  = 0.06;   // peak gain (subtle)

// Continuous swing haptic — low-intensity pulses scaled to paddle speed. Feels
// like air resistance through the hand. Coexists with the much stronger impact
// pulse on contact (which dominates the felt sensation for ~100 ms after hit).
export const SWING_HAPTIC_THRESHOLD     = 1.5;  // m/s
export const SWING_HAPTIC_MAX_SPEED     = 6.0;
export const SWING_HAPTIC_MAX_INTENSITY = 0.18; // peak amplitude (0..1)
export const SWING_HAPTIC_PULSE_MS      = 22;   // per-frame pulse duration

// Stuck-ball recovery — when the ball stops on the table or wedges near the net,
// we'd otherwise wait for it to fall below FLOOR_Y forever. After the ball stays
// below STATIONARY_VEL for STATIONARY_TIME, treat it as lost so the feeder advances.
export const STATIONARY_VEL = 0.18;     // m/s
export const STATIONARY_TIME = 0.9;     // seconds

// Rolling friction on the table. Applied per frame while the ball is
// resting on the surface (y at rest, |v_y| tiny). Without this, once a ball
// settles it glides frictionlessly across the table until it falls off the
// edge — cosmetically wrong for real TT where balls roll and die in ~1-2
// seconds. Value chosen so a ball settling at 0.5 m/s halves in ~0.9 s.
// Applied as v_horizontal *= (1 − k·dt) per frame; k=0.8/s.
export const ROLLING_FRICTION = 0.8;
// Vertical-velocity threshold under which the ball counts as "on the
// table" for rolling-friction purposes. Set above the residual bounce
// noise (typical low-amplitude re-bounce at ~0.1-0.2 m/s) so the ball
// starts rolling before it fully stops bouncing, giving a smooth transition
// from the last few micro-bounces into a pure roll.
export const ROLLING_VY_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// Runtime setters — used by the in-XR PhysicsTuner. Each clamps to a sensible
// range so a fat-fingered "+" doesn't push the sim into nonsense. Re-exports
// stay live: ball.js reads `GRAVITY` inside tickPhysics() each frame, so the
// new value takes effect on the next tick.
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export function setGravity(v)                { GRAVITY = clamp(v, -15, -5); }
export function setDragCoefficient(v)        { DRAG_COEFFICIENT = clamp(v, 0, 0.30); }
export function setTableRestitution(v)       { TABLE_RESTITUTION = clamp(v, 0.3, 0.98); }
export function setPaddleRestitution(v)      { PADDLE_RESTITUTION = clamp(v, 0.3, 0.98); }
export function setPaddlePosSmoothing(v)     { PADDLE_POS_SMOOTHING = clamp(v, 0.15, 1.0); }
export function setPaddleRotSmoothing(v)     { PADDLE_ROT_SMOOTHING = clamp(v, 0.15, 1.0); }
export function setSquashAmount(v)           { SQUASH_AMOUNT = clamp(v, 0, 0.35); }
export function setHapticMaxSpeed(v)         { HAPTIC_MAX_SPEED = clamp(v, 2, 20); }
export function setPaddleContactSpeedCap(v)  { PADDLE_CONTACT_SPEED_CAP = clamp(v, 0, 15); }
export function setSpinDamping(v)            { SPIN_DAMPING = clamp(v, 0, 1); }
export function setMagnusCoefficient(v)      { MAGNUS_COEFFICIENT = clamp(v, 0, 0.05); }
export function setTableSpinGain(v)          { TABLE_SPIN_GAIN = clamp(v, 0, 20); }
export function setTableSidespinKick(v)      { TABLE_SIDESPIN_KICK = clamp(v, 0, 0.03); }

// ---------------------------------------------------------------------------
// Physics helpers — centralized so per-step Euler paths (ball tick, AI
// rollout, trajectory preview, serve simulator) and closed-form ballistic
// solvers (feeder launcher, serve solver) all use the same math. Changing
// the drag or restitution model means changing it here; every caller picks
// up the new behavior via ESM live bindings.
// ---------------------------------------------------------------------------

// Per-step quadratic drag update. Integrates dv/dt = -k · |v| · v with the
// semi-implicit form v_next = v / (1 + k·|v|·dt). Unconditionally stable at
// any dt (unlike explicit Euler which can flip sign on large dt·k·v).
// Mutates `vel` in place. No-op when DRAG_COEFFICIENT is 0 or vel is tiny.
export function applyDragStep(vel, dt) {
  if (DRAG_COEFFICIENT <= 0) return;
  const speed = vel.length();
  if (speed < 1e-4) return;
  vel.multiplyScalar(1 / (1 + DRAG_COEFFICIENT * speed * dt));
}

// Analytic drag-compensated launch-speed boost. For a target horizontal range
// X reached in time T under quadratic drag, the required launch speed v_0 is
//   v_0 = (e^(k·X) - 1) / (k·T)
// derived from x(T) = (1/k)·ln(1 + k·v_0·T). The boost factor
//   (e^(k·X) - 1) / (k·X)
// converts the naive drag-free launch speed (X/T) into the drag-compensated
// value. Assumes horizontal motion dominates (good for short low-arc flights
// like feeder feeds and serves). Returns 1.0 when drag is disabled or the
// range is degenerate.
export function dragBoostFactor(rangeX, T) {
  if (DRAG_COEFFICIENT <= 0 || rangeX < 1e-4 || T < 1e-4) return 1;
  const kX = DRAG_COEFFICIENT * rangeX;
  return (Math.exp(kX) - 1) / kX;
}

// Speed-dependent paddle COR. Real rubber is near-elastic on soft touches
// and loses more energy on hard hits. Curve: e(v) = lo + (hi − lo)·exp(−v/v*)
// where hi/lo are derived from PADDLE_RESTITUTION so tuner changes shift
// the whole curve. `impactSpeed` is |v_rel · n| at the paddle face.
export function paddleRestitution(impactSpeed) {
  const hi = PADDLE_RESTITUTION + PADDLE_RESTITUTION_HI_OFFSET;
  const lo = PADDLE_RESTITUTION + PADDLE_RESTITUTION_LO_OFFSET;
  return lo + (hi - lo) * Math.exp(-impactSpeed / PADDLE_RESTITUTION_V_STAR);
}

// Speed-dependent table COR. Same shape as paddleRestitution — see comment
// on TABLE_RESTITUTION for physical rationale. `impactSpeed` is |v_y| at
// bounce.
export function tableRestitution(impactSpeed) {
  const hi = TABLE_RESTITUTION + TABLE_RESTITUTION_HI_OFFSET;
  const lo = TABLE_RESTITUTION + TABLE_RESTITUTION_LO_OFFSET;
  return lo + (hi - lo) * Math.exp(-impactSpeed / TABLE_RESTITUTION_V_STAR);
}

// Sweet-spot falloff on the paddle face. Returns 1.0 at the center and
// SWEET_SPOT_MIN_FACTOR at the rim, with a squared falloff so the middle
// ~60% of the face reads as "clean" and the outer band as progressively
// off. Callers multiply COR and spin capture by this to model center-of-
// percussion advantage. `radialDist` is the distance from face center to
// contact point on the paddle plane; `faceRadius` is the physical rubber
// radius. Clamped so a radialDist beyond faceRadius (edge zone) still
// returns MIN — but edge strikes typically bypass this helper.
export function sweetSpotFactor(radialDist, faceRadius) {
  if (faceRadius < 1e-6) return 1;
  const r = Math.min(1, radialDist / faceRadius);
  return 1 - (1 - SWEET_SPOT_MIN_FACTOR) * r * r;
}
