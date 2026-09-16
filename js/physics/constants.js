// Physics tuning constants. Validated in MR — change with care.
//
// Tunables marked `let` are runtime-mutable via the setters below (used by the
// in-XR PhysicsTuner panel for A/B tuning without rebuild). ESM live bindings
// mean consumers reading `DRAG_COEFFICIENT` inside a per-frame function pick
// up the new value automatically — no re-import needed.

// Master toggle for the "weighty ball" perception pass — gates haptics, paddle
// pose smoothing, the paddle COR/contact-cap/angular-contribution trio,
// sub-bass thud, and impact squash. Flip to false to A/B against the
// original floaty feel in headset without reverting code. Drag is NOT on
// this gate any more: it sits at its physical value (see DRAG_COEFFICIENT)
// and a zero-drag ball is not a baseline worth comparing against.
export const WEIGHTY_BALL_ENABLED = true;

// Earth-real gravity. This shipped at -12 for a while (the "weighty ball"
// pass wanted a flatter, more decisive drop), but the 22% surplus shortened
// every hang time by ~10%, broke serve-toss timing — the single most
// rehearsed motion a real player brings into the headset — and compounded
// with the table COR into a game that played uniformly low and rushed. The
// weighty read is carried by haptics and audio, which don't distort
// trajectories. (Drag carried part of it for a while too, at 30% above
// physical — retired 2026-09 after the first real-player tester called the
// ball "too heavy" off the bounce.)
export let GRAVITY = -9.81;

// Aerodynamic buoyancy on the ball. F_B = ρ_air · V · g (upward), acceleration
// = F_B / m = ρ_air · V · g_real / m. For an ITTF ball (r=0.02, m=0.0027) in
// air (ρ=1.2 kg/m³) at real g=9.81:
//     a_B = 1.2 · (4/3)π(0.02)³ · 9.81 / 0.0027 ≈ 0.146 m/s² upward
// This is ~1.5% of the GRAVITY magnitude — imperceptible in a single
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
// VR input-domain compensation on spin capture. PLAYER CONTACTS ONLY.
//
// SPIN_CAPTURE_GAIN above is correct physics, and measurement confirms the
// transfer chain honours it: a 20-contact headset capture (2026-09-02) came
// back with tangentSpeed median 1.80 m/s → spinMag median 65 rad/s, i.e.
// 1.80 × 35 ≈ 63 predicted vs 65 observed. The model is not lossy.
//
// The problem is upstream of the model. Reaching a real 300 rad/s loop needs
// ~8.6 m/s of tangential contact speed (300 / 35). That capture measured a
// paddle face-centre speed of median 2.68 m/s, max 4.53 — against the 15-20
// m/s a real racket head reaches in a loop. A player holding a 100 g
// controller, standing, with no ball weight and no stroke resistance, simply
// does not produce racket-head speeds; the input domain is roughly a fifth of
// the real one. Correct physics over a 5×-too-small input yields 5×-too-little
// spin, and no adjustment to the transfer can fix an input problem.
//
// So this scales the CAPTURE for the player only, leaving the AI (whose
// paddleSolver plans real-scale strike speeds) on unmodified physics. It is
// deliberately NOT folded into SPIN_CAPTURE_GAIN: that constant is the no-slip
// ceiling and should keep meaning that, so the compensation stays visible and
// separately tunable instead of quietly corrupting a physical quantity — the
// mistake MAGNUS_COEFFICIENT's 0.010 era made and paid for (see its comment).
//
// 2.5 maps the ACHIEVABLE VR range onto the MEANINGFUL spin range. Against the
// measured capture, with the effective gain at 87.5:
//   u_t 0.30 (a block)          →  26 rad/s   nearly flat, as it should be
//   u_t 1.80 (median contact)   → 157 rad/s   past "light brush" (125)
//   u_t 3.40 (a good brush)     → 298 rad/s   a heavy loop
//   u_t 6.37 (best of 20)       → 557 rad/s   compressed by PADDLE_SPIN_CAP
// The cap still binds at the top, which is intended: it models rubber-ball
// grip saturation and is a property of the BALL, so it must not scale with a
// compensation for how fast a human can wave a controller.
//
// SPIN ONLY — it does not add pace. The friction impulse that spins the ball
// also pushes it, and impulse.js locks the two halves together through
// HOLLOW_SPHERE_MOI_FACTOR (Δv_t = (2/3)·R·Δω). For a long time this gain
// multiplied the shared number, so a player's brush injected 1.167 m/s of
// ball speed per m/s of slip against the physical 0.467 — through the one
// channel PADDLE_CONTACT_SPEED_CAP never bounded (it clips the normal
// component only). A player standing ready with a full wind-up earned that
// in full on the very first stroke, which is what the first real-player
// tester reported as "the first hit is too hard on the ball". ball.js now
// hands computeImpulse the physical SPIN_CAPTURE_GAIN as `linearKickGain`
// on player contacts while spinCaptureGain carries this compensation: the
// compensated brush spins the ball 2.5× and pushes it exactly as hard as an
// uncompensated one. The input gap is a SPIN-readability problem; linear
// momentum was never short. swingPreparation.js still scales what a contact
// receives of this ceiling by the stroke behind it.
//
// This knowingly breaks the "one ball, one spin economy" invariant the
// 2026-08 unification established, for players only and for a stated reason.
// Revisit if VR controllers or stroke tracking ever close the speed gap.
export let PLAYER_SPIN_GAIN = 2.5;
// Ceiling on outgoing ball spin after a paddle contact, applied in
// computeImpulse. SPIN_CAPTURE_GAIN is the per-contact TRANSFER ceiling
// (no-slip physics), but nothing bounded the SLIP feeding it: a VR
// wrist-flick can produce 10+ m/s of tangential face speed no real arm
// achieves in a brush, yielding 350-500+ rad/s — and with Magnus applied
// per-frame (at the time linear in ω and ~2.5× physical; today saturating
// and physical, see MAGNUS_COEFFICIENT, but grip still saturates) that
// compounded into cartoon curves. Knee-and-asymptote form: |ω| ≤ KNEE passes
// EXACTLY 1:1 (a pure tanh shaved 4-6% off legitimate mid-range brush spin
// — measurable, and exactly the kind of silent attenuation the tangential
// path was exempted from capping to avoid); above the knee, the excess
// compresses as KNEE + (CAP−KNEE)·tanh((|ω|−KNEE)/(CAP−KNEE)), asymptoting
// at CAP. KNEE=300 / CAP=420 (~4000 rpm) bracket the measured elite loop
// range: a real-technique heavy loop (250-300) is untouched, a 470 rad/s
// elite-peak equivalent lands at ~407, flick exploits saturate at 420.
// Applies to ALL paddle contacts (it models rubber-ball grip saturation,
// not player biomechanics — the AI is bounded by the same ball). Set CAP
// to 0 to disable.
export const PADDLE_SPIN_CAP = 420;
export const PADDLE_SPIN_CAP_KNEE = 300;
// Fraction of "corkscrew" spin (the ω component along the horizontal
// direction of travel) that survives a paddle contact. Real balls carry
// this component — it is the entire mechanism of hook/fade serves, whose
// tilted spin axis converts into a lateral bounce kick via ordinary table
// friction. The sim previously ZEROED it to suppress a visual artifact
// (Magnus_x from corkscrew flips sign at the arc apex when v_y crosses
// zero), which deleted that serve vocabulary and forced the exaggerated
// TABLE_SIDESPIN_KICK as a stand-in. Retaining 35% — real balls do shed
// corkscrew fast through turbulent boundary-layer shear, so full retention
// is wrong too — restores an authentic tilted-axis bounce response while
// keeping the residual apex wobble around ~1 m/s² at rally speeds
// (0.35 · k_eff · ω_cork · v_y with ω_cork ≈ 100, v_y ≈ 3 and k_eff ≈
// MAGNUS_COEFFICIENT at that spin — see magnusCoefficientAt), an order of
// magnitude under the shot's main Magnus curve.
export const CORKSCREW_RETAIN = 0.35;
// Magnus curvature. Applied as a = k_eff(|ω|, |v|) · (ω × v), where
// MAGNUS_COEFFICIENT is the effective coefficient at the reference point
// (ω = 100 rad/s, v = 8 m/s) and magnusCoefficientAt() below saturates it
// with spin the way a real sphere's lift does.
//
// WHY IT SATURATES. The measured lift coefficient of a spinning sphere is
// well fit by CL ≈ 1/(2 + v/(ω·r)) (Bearman & Harvey's golf-ball data; the
// same form fits table-tennis balls at their spin ratios). Lift force is
// ½·ρ·A·CL·v², so with K = ½·ρ·A/m = 0.279 m⁻¹ for the regulation ball:
//
//     a = K·r · v/(v + 2·r·|ω|) · (ω × v)          K·r = 0.00558
//
// At low spin ratio (2rω ≪ v) this IS the linear model; as spin rises the
// prefactor falls off as v/(v + 0.04·ω) and the lift asymptotes instead of
// growing without bound. The sim ran the linear model for a long time and
// paid for it exactly where players brush hardest: it was calibrated at
// ω = 100 and over-predicted 1.8× at loop spin. Acceleration in m/s²,
// linear model vs. this one vs. the fit:
//
//     ω rad/s, v m/s              linear   now    fit
//     100,  8  light rally spin    3.2     3.2    3.0
//     300,  8  loop                9.6     5.8    5.4
//     400, 10  elite loop         16.0     9.2    8.6
//     350,  5  loop after bounce   7.0     4.0    3.7
//     345,  4  heavy backspin serve 5.5    1.8    1.7
//     188, 20  pro 30 rps drive   15.0    16.4   15.3
//
// The "loop after bounce" row is the tester's "after the first bounce the
// ball gets too heavy and falls too fast": table friction ADDS topspin on a
// topspin bounce (TABLE_SPIN_GAIN), so the post-bounce Magnus was the
// LARGEST term in the flight and the linear model doubled it. Pinned by
// tests/physicalReference.test.js at 100/300/400 rad/s.
//
// 0.004 at the reference point is 7% above the fit's 0.0037 — inside the
// fit's own scatter; left alone so tuner rows and stored tuner values keep
// meaning what they always meant. MAGNUS_REF_* are the calibration point,
// not knobs: moving them only re-labels what MAGNUS_COEFFICIENT means.
//
// Perception note that still holds: pure vertical sidespin can't be
// transferred into lateral velocity by the table bounce (contact is on the
// spin axis, ω × r = 0), so all lateral motion comes from Magnus, and
// ½·a·t² makes it manifest mostly in the second half of the flight — the
// "flies mostly straight, kicks after the bounce" look real players expect.
// 0.018 (an early value) curved from the first frame and broke that.
//
// HISTORY — this shipped at 0.010 (~2.5× physical) for a long time, as
// documented "REALISM DEBT": the AI's shot vocabulary encoded spin at ~1/4
// of real-world ω (shotTypeSelector topped out near 100 rad/s where real
// loops run 300-450), so the exaggerated coefficient and the undersized ω
// CANCELLED on AI shots — while PLAYER brush shots (real-scale ω off
// SPIN_CAPTURE_GAIN) curved ~2.5× real. The debt was retired in the spin-
// economy unification (2026-08): shotTypeSelector spin tables, serve
// archetypes and the training feeds all scaled ×2.5 to physical rad/s
// (M·ω preserved, so every AI arc is unchanged), solver strike caps raised
// to real racket-head speeds to carry the bigger tangential component, and
// this dropped to 0.004. An earlier lone attempt to drop just the
// coefficient (to 0.006, tables unscaled) tanked pro-tier high-pace
// feasibility (41/120 vs 115/120 solvable at 18-22 m/s) — Magnus dip is the
// mechanism that lands fast shots, which is why a UNIFORM coefficient change
// and the spin tables must move TOGETHER. Saturation is exempt from that
// rule: it leaves the pace end (high v, moderate ω — the last row above)
// slightly STRONGER and only shaves the high-spin tail, and it was gated on
// the solver-envelope tests before shipping (see the 2026-09 entry in the
// tests/solverEnvelope*.test.js headers for the measured rates).
export let MAGNUS_COEFFICIENT = 0.004;
// Calibration point for MAGNUS_COEFFICIENT (see above). MAGNUS_REF_SCALE is
// the saturation prefactor's reciprocal at that point, so k_eff(ref) ==
// MAGNUS_COEFFICIENT exactly.
export const MAGNUS_REF_OMEGA = 100;    // rad/s
export const MAGNUS_REF_SPEED = 8;      // m/s
export const MAGNUS_BALL_RADIUS = 0.02; // m — enters only via the spin ratio 2rω/v
const MAGNUS_2R = 2 * MAGNUS_BALL_RADIUS;
const MAGNUS_REF_SCALE = (MAGNUS_REF_SPEED + MAGNUS_2R * MAGNUS_REF_OMEGA) / MAGNUS_REF_SPEED;

// Effective Magnus coefficient at a given spin magnitude (rad/s) and speed
// (m/s). Scalar, allocation-free — it runs inside every flight substep
// (rollout.js integrateFlightStep) and the golden-trajectory test mirrors it.
// Returns 0 for a stationary ball (the cross product is zero there anyway).
export function magnusCoefficientAt(omegaMag, speed) {
  const d = speed + MAGNUS_2R * omegaMag;
  return d > 1e-9 ? (MAGNUS_COEFFICIENT * MAGNUS_REF_SCALE * speed) / d : 0;
}
// Vertical Magnus scale — controls topspin drop / backspin lift visibility.
// Was 0.85 (dampening the vertical curve to keep "runaway dips" in check).
// Lifted to 1.0 so topspin loops actually DIVE into the court and backspin
// slices actually FLOAT — the two most recognizable spin arcs in table
// tennis. Measured 2026-09 through integrateFlightStep with the saturating
// lift: a rally drive launched at (0, 1.5, 8) m/s from 1 m high lands at
// z +1.74 flat, +1.11 with a 300 rad/s loop and +1.05 at 400 rad/s — the
// loop drops ~0.6 m shorter, which reads to the eye as "that ball is
// spinning" (and the 300→400 step buying only 5 cm more is the saturation).
export const MAGNUS_VERTICAL_SCALE = 1.0;
// Air drag on rotation. Applied as ω *= exp(-SPIN_DAMPING * dt) per frame.
// Real 2.7 g ping-pong balls lose ~5–10% of spin per second to air; at 0.35
// this was ~30%/sec, killing Magnus curve before it could bend the trajectory.
// 0.10 matches the real-world upper bound and lets a spinny shot keep visibly
// curving across the full flight. `let` for PhysicsTuner.
export let SPIN_DAMPING = 0.10;

// Quadratic air drag on the ball. The old linear model (v *= 1 - k·dt) bled
// the same fraction of speed per second at every velocity — physically wrong.
// Real drag is F_d = ½·ρ·Cd·A·v², i.e. dv/dt = -k·|v|·v. Under the quadratic
// model a smash bleeds much more speed per second than a soft push, so hard
// hits arrive slower and soft touches carry farther — the correct physical
// behavior.
//
// 0.13 IS the physical value: k = ½·ρ·Cd·A/m with ρ = 1.2 kg/m³,
// A = π·(0.02)² = 1.257e-3 m², m = 2.7e-3 kg gives k = 0.279·Cd, and a smooth
// sphere at the ball's Reynolds number (~2e4, sub-critical) has Cd ≈ 0.45-0.50
// → k = 0.126-0.140. Pinned by tests/physicalReference.test.js.
//
// HISTORY. It shipped at 0.10 for a while (deliberately slick, paired with
// -12 gravity for the "heavy ball" read), then at 0.17 through the 2026-08
// realism pass — ~30% above textbook, documented as "a deliberate feel
// choice, not a physics claim" to exaggerate the ball visibly decelerating
// across the table. The first tester who plays real table tennis reported
// exactly that exaggeration: "after the first bounce the ball gets too heavy
// and falls too fast." The weighty read is carried by haptics and audio,
// which do not distort trajectories; drag is not a feel knob any more, which
// is also why it is no longer behind WEIGHTY_BALL_ENABLED — a zero-drag
// "vacuum ball" is not a meaningful A/B baseline against the real value.
//
// Applied per Euler step as v_next = v / (1 + k·|v|·dt) — semi-implicit
// form, stable at any dt. Set to 0 to disable drag entirely.
export let DRAG_COEFFICIENT = 0.13;

// Table friction — couples spin to linear velocity on bounce. Both are the
// same friction impulse J at the contact point, so they should be at the
// same fraction of the no-slip physical ceiling. The linear coefficient
// 0.12 corresponds to 42% of no-slip ((2/7)·|slip|); the angular coefficient
// must match that fraction: 0.42·5/(7R) with R=0.02 gives 15 — which is the
// value below. (It sat at 12 for a while — 34% of ceiling on the angular
// side vs 42% on the linear side, i.e. the bounce disagreed with itself
// about how much friction had acted. Realism pass restored consistency.)
//
// History: raised from 5 to make backspin actually brake and topspin
// actually kick forward off the bounce. The visual had a sampling
// constraint at 3-fold ball symmetry — 15 Hz Nyquist at 90 Hz VR meant
// very-high spins wagon-wheeled and appeared to spin backward.
//
// This comment previously claimed that constraint was resolved by a texture
// carrying "a cert dot plus a manufacturing seam line". That texture did not
// exist when the claim was written: ballTexture.js had no dot, and its seam
// was TWO horizontal bands — latitude circles, which are invariant under
// rotation about the pole axis and so contributed nothing to reading spin.
// The lone asymmetric feature was a swoosh whose strokes go sub-pixel by 3 m.
//
// It is true NOW. ballTexture.js draws the cert dot (sized so it survives
// minification at rally distance, which is what makes it the load-bearing
// anchor), and the seam is a great circle inclined 38° off the pole axis so
// no spin direction leaves it stationary. Effective symmetry is 1-fold,
// lifting the Nyquist ceiling to ~45 Hz as described. `let` so PhysicsTuner
// can still drop this back toward 5 in-headset if a specific rally aesthetic
// calls for it.
export let TABLE_SPIN_GAIN = 15;
export let TABLE_LINEAR_FRICTION = 0.12;

// Table friction coefficient — the single equipment-facing knob behind the
// spin/linear couple above. The internal pair (TABLE_LINEAR_FRICTION 0.12 /
// TABLE_SPIN_GAIN 15) was tuned as a consistent 42%-of-no-slip couple; μ
// scales BOTH linearly so the bounce can never disagree with itself about how
// much friction acted (the failure mode the long comment above describes).
// TABLE_MU_REFERENCE is the μ at which that shipped couple was calibrated, so
// the ITTF default reproduces shipped behavior bit-for-bit. Tuned via
// setTableMu() below; Section B of the tuner panel owns it.
export const TABLE_MU_REFERENCE = 0.25;
export const TABLE_LINEAR_FRICTION_AT_MU_REF = 0.12;
export const TABLE_SPIN_GAIN_AT_MU_REF = 15;
export let TABLE_MU = TABLE_MU_REFERENCE;

// Table COR reference (the "median" the speed-dependent curve pivots on —
// see tableRestitution()). Tuner adjusts this scalar; the hi/lo offsets
// below preserve the curve shape while shifting overall bounciness. A very
// light drop bounces at ~median + HI_OFFSET, a hard smash at ~median +
// LO_OFFSET (LO_OFFSET is negative). Physical rationale: real tables lose
// more energy at high impact speed because the wood-composite deck flexes
// and the ball deforms more — a soft drop is nearly elastic, a slam is not.
//
// THE ONE MEASURED NUMBER is the ITTF certification test: a 30 cm drop
// (impact ≈ 2.43 m/s) must rebound ~23 cm, i.e. e ≈ 0.88 at that speed. The
// curve e(v) = 0.80 + 0.12·exp(−v/6) gives:
//
//     impact   0      2.43    5       8       10      12   m/s
//     e        0.920  0.880   0.852   0.832   0.823   0.816
//
// so this deck passes certification and still loses a little more with
// speed (−0.06 from the drop test to a 10 m/s slam), but no more than that.
// Pinned by tests/physicalReference.test.js (the drop test through the live
// integrator, and a flatness bound e(5) − e(10) ≤ 0.04).
//
// HISTORY. The curve shipped as ±0.13 around the median with V* = 8:
// e(2.4) 0.88, e(5) 0.83, e(8) 0.79, e(10) 0.77 — an extra 0.12 of loss
// between the certification speed and rally pace that the comment ascribed
// to "measured high-speed table data" it never cited. The first real-player
// tester reported the consequence directly ("after the first bounce the
// ball ... falls too fast"): every rally-pace bounce came off the deck 5-8%
// slower than a regulation table's. The offsets are now asymmetric (+0.10 /
// −0.02) so the median 0.82 keeps its meaning for the tuner, the 'ittf'
// preset and the setter floor. Nothing assumes the offsets are symmetric.
//
// Before that it sat at 0.92, a lively-table feel choice above
// certification, where the 0.13 low-speed lift pinned the curve flat at
// COR_MAX for every impact under ~4 m/s. And before THAT, median 0.75 with
// V* = 4 gave e(2.4) ≈ 0.76 — well under regulation, and it read as "dead
// table" rather than "weighty ball."
export let TABLE_RESTITUTION = 0.82;
export const TABLE_RESTITUTION_HI_OFFSET = 0.10;   // low-speed lift
export const TABLE_RESTITUTION_LO_OFFSET = -0.02;  // high-speed loss
export const TABLE_RESTITUTION_V_STAR    = 6.0;    // m/s transition scale

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
// 0.0008 (spin-economy unification, down from 0.002): the assist was tuned
// as "~0.2 m/s kick at a moderate sidespin serve" when moderate meant
// ω_y = 100 rad/s; with the AI/training spin tables rescaled ×2.5 to
// physical rad/s, the same serve now carries ω_y ≈ 250, so the coefficient
// drops ×2.5 to keep the tuned kick strength — still a perceptual assist
// over the ~1-5 cm/s physical value, but no longer a 7° instant direction
// change. The pre-realism-pass 1 m/s kick was ~20× physical and was
// compensating for a mechanism this sim had DELETED: the real "kick off the
// bounce" on hook/fade serves comes from tilted spin axes (ω with a
// component along the direction of travel), which the corkscrew-stripping
// in impulse.js used to zero out entirely. CORKSCREW_RETAIN now preserves
// part of that component, so the table's ordinary spin-friction math
// produces a genuine, spin-axis-correct bounce kick on its own — this
// constant only tops up the pure-vertical-sidespin case where rigid-body
// physics genuinely predicts zero.
//
// Gated on bounce impact (|v_y| > 0.3 m/s and linearly ramping to full at
// |v_y| = 1.5 m/s) in ball.js. Without that gate every marginal residual
// hop fires a kick perpendicular to the ball's current direction of travel,
// which acts as a centripetal force and spirals the ball in loops on the
// table instead of letting it die out. The gate matches the physical
// mechanism — finite-patch effects only matter when contact force is real.
export let TABLE_SIDESPIN_KICK = 0.0008;

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
// One physical net contact spans several frames of resolved overlap; within
// this window position is still corrected but restitution/jitter/sound/events
// are suppressed so the response can't compound frame-over-frame.
export const NET_HIT_COOLDOWN            = 0.12;   // seconds

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

// NO multiplayer-only COR scale. There was one (0.75) for a while, because
// pace compounds between two humans and does not against the AI — paddleSolver
// inverts a target landing point through (1 + e), so a livelier face just makes
// the AI swing softer and its returns arrive at the same planned pace.
//
// It was the wrong term. The energy that compounded was entering through the
// TANGENTIAL friction kick, which impulse.js locks to spin capture via
// HOLLOW_SPHERE_MOI_FACTOR and which PLAYER_SPIN_GAIN was multiplying by 2.5;
// PADDLE_CONTACT_SPEED_CAP bounds only the normal component, so that channel
// was unbounded. Trimming the normal-axis COR to compensate deadened clean
// drives while leaving the actual amplification untouched.
//
// The real asymmetry was that the AI has a biomechanical governor (its windup
// distance is capped at WINDUP_DISTANCE_MAX_M and its plans are speed-
// validated) and the player had none: a VR flick costs the same 150 ms no
// matter what is coming across the net. swingPreparation.js first gave the
// player the same constraint; the 2026-09 pass then closed the channel at
// its source — the compensation is spin-only (ball.js passes the physical
// gain to computeImpulse as linearKickGain), so there is no amplifier left
// to compound and the bat is one bat again. Do not reintroduce a per-mode
// COR — if multiplayer pace still feels wrong, the honest knob is
// PADDLE_CONTACT_SPEED_CAP, for both modes.

// Asymptotic ceiling on effective paddle contact speed fed to the impulse
// math. Represents the maximum face velocity a human arm can realistically
// produce with a real paddle (~200 g + arm inertia rate-limit acceleration).
// VR removes that rate-limit — a 100 g controller in free space can produce
// 15+ m/s of face velocity from a wrist flick, which the (1+e) reflection
// amplifies into a rocketing outgoing ball.
//
// 10.0 (realism pass, up from 6.5). Real racket-head speed at contact is
// 10-15 m/s for a committed forehand loop and ~20 m/s for a full smash —
// 6.5 gave a 10 m/s swing only 5.9 m/s effective, a 40% haircut that
// compressed drives and smashes into the same outgoing pace band. Table
// tennis's shot hierarchy is pace-dominant at the top; capping pace while
// leaving brush spin uncapped quietly inverted that. At 10.0 a full smash
// swing (15 m/s) yields ~9.0 m/s effective — hard hits are again clearly
// faster than drives, while the tanh still tames wrist-flick rockets.
//
// Applied as a TANH SOFT-CLIP inside computeImpulse (not a hard clamp): |v|
// scales as cap·tanh(|v|/cap), so swings below the cap feel 1:1, swings near
// the cap see diminishing returns, and swings well past it hit hard but
// stay bounded — the ball "resists" being accelerated further, which is
// exactly how muscle recruitment behaves in reality. Set to 0 to disable.
export let PADDLE_CONTACT_SPEED_CAP = WEIGHTY_BALL_ENABLED ? 10.0 : 0;

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
// DEFAULT IS 0.65 on both axes — a deliberate trade of 1:1 fidelity for
// weight feel. At 90 Hz that is ~17 ms of effective lag, small enough to stay
// under the rotation-lag nausea threshold but enough that the bat reads as a
// physical object rather than a rigid extension of the controller. Raise both
// to 1.0 via the PhysicsTuner panel for zero added lag (paddle = controller).
//
// Scope: VISUAL POSE AND CONTACT GEOMETRY ONLY. The physics velocity
// estimates (paddleVelocity / paddleAngularVelocity in ball.js) are finite-
// diffed from the RAW grip pose via xrPaddle.getRawPaddlePose — an EMA is a
// low-pass filter, and diffing the smoothed anchor attenuated one-frame
// wrist-snap peaks to ~65% right at contact, silently weakening brush spin
// (slices/loops). Tuning this constant changes where the bat is drawn and
// where it collides, not how much spin or pace a stroke imparts.
export let PADDLE_POS_SMOOTHING = 0.65;
export let PADDLE_ROT_SMOOTHING = 0.65;

// Ceiling on how far the table-penetration resolver may translate the PLAYER's
// paddle away from the hand holding it (js/physics/paddleTableClamp.js). Shares
// the 1 cm contact-visual agreement budget with the impact recoil, because it
// is the same currency: distance between where the hand is and where the bat is
// drawn. Past this the blade clips the table instead of leaving the grip —
// clipping is the milder lie. AI/remote paddles are unbounded (no hand).
export const PADDLE_TABLE_PUSH_MAX = 0.01;

// Ceiling on the pitch-about-the-grip rescue that resolves what the bounded
// translation above can't (js/physics/paddleTableClamp.js:
// resolvePaddleTableTilt). The hand is a fixed point of the rotation, so this
// spends a different currency than PADDLE_TABLE_PUSH_MAX — orientation
// disagreement between the physical controller and the rendered bat, not
// distance. π/2 lets the blade lie fully flat on the felt (what a real bat
// does pressed into a table by a loosening grip); past that the pose is
// unreachable without detaching and the blade clips honestly.
export const PADDLE_TABLE_TILT_MAX = Math.PI / 2;

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
// Band matched to the swing haptic above, for the same reason: cross-modal
// weight only works if the ear and the hand agree, and a 6 m/s saturation put
// the whole wrist-stroke range down near silence. updateSwingWhoosh keeps its
// own squared gain curve — for audio a square is right, since perceived
// loudness is roughly logarithmic in gain and a linear ramp reads as a step.
export const SWING_WHOOSH_THRESHOLD = 0.8;   // m/s, below this no sound
export const SWING_WHOOSH_MAX_SPEED  = 4.5;  // m/s, full saturation point
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

// Continuous swing haptic — pulses scaled to paddle FACE speed. This is the
// primary weight cue: blade inertia is something you feel while swinging, not
// on contact, and it is the only channel that can answer a fast wrist jerk in
// the moment it happens. Coexists with the stronger impact pulse on contact.
//
// Retuned after in-play reports of "the paddle has no weight". The old band
// (1.5 → 6.0 m/s, peak 0.18, squared) left the entire wrist-stroke range
// effectively silent: face speed for a wrist jerk runs ~1.3–3 m/s, which sat
// at or below the old threshold, and the square crushed whatever cleared it
// (2.5 m/s → 0.009 intensity, far under the Quest motor's perceptual floor).
// Meanwhile the blade swings a 13 cm arc about the grip, so the eye saw a
// heavy bat move and the hand felt nothing — the contradiction that reads as
// the blade being loose. The band now covers the speeds people actually play
// at. THESE ARE STARTING POINTS AND MUST BE RE-TUNED ON-DEVICE — Quest motor
// response is not linear in `value` (same caveat as paddleWeight.js).
export const SWING_HAPTIC_THRESHOLD     = 0.5;  // m/s — deadzone for tracking noise
export const SWING_HAPTIC_MAX_SPEED     = 4.0;  // m/s face speed of a committed drive
export const SWING_HAPTIC_MAX_INTENSITY = 0.35; // peak amplitude (0..1)
export const SWING_HAPTIC_PULSE_MS      = 22;   // per-frame pulse duration
export const SWING_HAPTIC_CURVE         = 1.4;  // ramp exponent; 1 = linear

// Stuck-ball recovery — when the ball stops on the table or wedges near the net,
// we'd otherwise wait for it to fall below FLOOR_Y forever. After the ball stays
// below STATIONARY_VEL for STATIONARY_TIME, treat it as lost so the feeder advances.
export const STATIONARY_VEL = 0.18;     // m/s
export const STATIONARY_TIME = 0.9;     // seconds

// Dead-ball bounce damping. A regulation table is nearly elastic at low
// impact speed — the curve tops out at 0.92 as a bounce dies (and sat at the
// 0.95 COR_MAX clamp under the old lively-table default) — so a ball left
// bouncing on the table loses under 10% of its speed per bounce and takes
// ~2v/(g(1−e)) ≈ 10+ seconds to dwindle below the stuck-ball detector —
// during which the feeder (which waits for ballLost) cannot advance.
//
// The first bounce or two of any ball are LIVE play and must keep the full
// curve: a machine feed bounces once before the return, a serve bounces on
// both sides before the receiver's hit. A THIRD bounce with no paddle
// contact in between is dead in every ruleset and every mode, so from that
// bounce on the outgoing vertical velocity takes an extra scale — the ball
// visibly dies over a few hops and comes to rest in ~2-3 s instead. Live
// physics only (ball.js); the predictive rollouts never simulate past the
// bounces that matter for aiming, so they stay on the undamped shared math.
export const DEAD_BALL_BOUNCES = 3;      // bounces since last paddle contact
export const DEAD_BALL_COR_SCALE = 0.65; // extra v_y loss per dead bounce

// Retirement fade. When a point is decided the ball is left alone to finish
// its bounce (see POINT_END_DESPAWN_MS in aiMatch/rallyManager.js) — the
// dead-ball damping above means it usually settles and retires itself long
// before the next serve. The forced removal is only the backstop for a ball
// still moving when the serve window arrives, and hiding THAT one in a
// single frame is the "ball vanishes mid-bounce" artefact this avoids: it
// dissolves over this window instead, still rolling as it goes.
export const BALL_FADE_OUT_MS = 250;

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

// --- Equipment parameters (tuner Section B) ---------------------------------
// Canonical names for the two restitution medians, introduced with the A/B/C
// panel restructure. PADDLE_E0 / TABLE_EN_0 are the SAME quantities as
// PADDLE_RESTITUTION / TABLE_RESTITUTION (the medians the speed-dependent
// curves pivot on) — both spellings are kept as live bindings and every setter
// updates the pair, so legacy consumers and the new panel can never disagree.
//
// Ranges are tighter than the legacy setters on purpose: the equipment layer
// models a bat and table someone could actually buy. TABLE_EN_0 floors at
// 0.80 — just under the CERTIFIED median 0.82 (the ITTF drop-test value the
// curve comment above TABLE_RESTITUTION derives), so the regulation table is
// reachable from the tuner. The floor used to be 0.90, which made the
// certified value unreachable and the 'ittf' preset a lie; the old
// dead-table tuning (median 0.75, e(2.4) ≈ 0.76) still reads as broken
// equipment and still clamps up into range on migration.
export let PADDLE_E0 = PADDLE_RESTITUTION;
export let TABLE_EN_0 = TABLE_RESTITUTION;

export function setPaddleE0(v) {
  PADDLE_E0 = clamp(v, 0.75, 0.95);
  PADDLE_RESTITUTION = PADDLE_E0;
}

export function setTableEn0(v) {
  TABLE_EN_0 = clamp(v, 0.80, 0.98);
  TABLE_RESTITUTION = TABLE_EN_0;
}

export function setTableMu(v) {
  TABLE_MU = clamp(v, 0.05, 0.60);
  const s = TABLE_MU / TABLE_MU_REFERENCE;
  TABLE_LINEAR_FRICTION = TABLE_LINEAR_FRICTION_AT_MU_REF * s;
  TABLE_SPIN_GAIN = TABLE_SPIN_GAIN_AT_MU_REF * s;
}

// Equipment presets — applied as a COMPLETE set so switching between them can
// never accumulate state from a previous preset. 'ittf' is the paper-spec
// bat and table (paddle median from the certification-test COR, μ at the
// couple's calibration point); 'lively' and 'dead' bracket it for A/B feel
// comparisons. Note the shipped LOAD default (weighty-ball paddle median
// 0.82, certified table 0.82) is documented at the definitions above —
// presets are explicit user actions, not the boot state.
// ittf.tableEn0 is the certified median 0.82: with the +0.10 / −0.02 curve
// offsets and V* = 6 this reproduces the ITTF drop test (e(2.4) ≈ 0.88 →
// ~23 cm rebound from 30 cm) instead of the lively 0.92 it shipped with for
// a while — which made the preset labelled "ITTF" bounce well above a
// regulation table, with the setter floor (then 0.90) making the honest
// value unreachable entirely.
export const PHYSICS_PRESETS = {
  ittf:   { paddleE0: 0.878, tableEn0: 0.82, tableMu: 0.25 },
  lively: { paddleE0: 0.90,  tableEn0: 0.95, tableMu: 0.25 },
  dead:   { paddleE0: 0.80,  tableEn0: 0.90, tableMu: 0.18 },
};

export function applyPhysicsPreset(name) {
  const p = PHYSICS_PRESETS[name];
  if (!p) return false;
  setPaddleE0(p.paddleE0);
  setTableEn0(p.tableEn0);
  setTableMu(p.tableMu);
  return true;
}

export function setGravity(v)                { GRAVITY = clamp(v, -15, -5); }
export function setDragCoefficient(v)        { DRAG_COEFFICIENT = clamp(v, 0, 0.30); }
export function setTableRestitution(v)       { TABLE_RESTITUTION = clamp(v, 0.3, 0.98); TABLE_EN_0 = TABLE_RESTITUTION; }
export function setPaddleRestitution(v)      { PADDLE_RESTITUTION = clamp(v, 0.3, 0.98); PADDLE_E0 = PADDLE_RESTITUTION; }
export function setPaddlePosSmoothing(v)     { PADDLE_POS_SMOOTHING = clamp(v, 0.15, 1.0); }
export function setPaddleRotSmoothing(v)     { PADDLE_ROT_SMOOTHING = clamp(v, 0.15, 1.0); }
export function setSquashAmount(v)           { SQUASH_AMOUNT = clamp(v, 0, 0.35); }
export function setHapticMaxSpeed(v)         { HAPTIC_MAX_SPEED = clamp(v, 2, 20); }
export function setPaddleContactSpeedCap(v)  { PADDLE_CONTACT_SPEED_CAP = clamp(v, 0, 15); }
export function setSpinDamping(v)            { SPIN_DAMPING = clamp(v, 0, 1); }
export function setMagnusCoefficient(v)      { MAGNUS_COEFFICIENT = clamp(v, 0, 0.05); }
// Floor of 1 — below it the player would generate LESS spin than the physics
// says, which is a different (and unjustifiable) claim than compensating for a
// slow input. Ceiling of 6 is roughly full compensation for the measured
// racket-speed gap; past that the cap does all the work anyway.
export function setPlayerSpinGain(v)         { PLAYER_SPIN_GAIN = clamp(v, 1, 6); }
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

// Hard ceiling on any coefficient of restitution. A COR ≥ 1 means the ball
// GAINS energy on contact, and for the table that is not just unphysical —
// it is a gameplay deadlock: the bounce map v_next = e(v)·v acquires a
// stable fixed point at the speed where e(v) = 1, so every dying ball
// converges to a perpetual ~15 cm bounce. It then never falls below the
// micro-bounce settle (rollout.js) or the stuck-ball detector's
// STATIONARY_VEL, ballLost never fires, and the rally manager waits on a
// serve that can never be re-offered. The median+HI_OFFSET curve shape
// crosses 1.0 whenever the tuner-adjustable median exceeds (1 − HI_OFFSET),
// which the tuner's 'lively' preset (0.95) does — so the curves clamp here
// rather than trusting the median to stay low.
//
// 0.95 and not 0.99: settle time is governed by the per-bounce loss at the
// ceiling (total dwindle time ≈ 2·v/(g·(1−e))), so a 0.99 cap still leaves
// ~30 s of visible micro-bouncing. At the shipped table median (0.82 +
// 0.10 offset → 0.92 at zero speed) the clamp never binds; it only comes
// into play for tuner medians above 0.85, where it keeps a lively table from
// becoming a perpetual one.
export const COR_MAX = 0.95;

// Speed-dependent paddle COR. Real rubber is near-elastic on soft touches
// and loses more energy on hard hits. Curve: e(v) = lo + (hi − lo)·exp(−v/v*)
// where hi/lo are derived from PADDLE_RESTITUTION so tuner changes shift
// the whole curve. `impactSpeed` is |v_rel · n| at the paddle face.
export function paddleRestitution(impactSpeed) {
  const hi = PADDLE_RESTITUTION + PADDLE_RESTITUTION_HI_OFFSET;
  const lo = PADDLE_RESTITUTION + PADDLE_RESTITUTION_LO_OFFSET;
  return Math.min(COR_MAX, lo + (hi - lo) * Math.exp(-impactSpeed / PADDLE_RESTITUTION_V_STAR));
}

// Speed-dependent table COR. Same shape as paddleRestitution — see comment
// on TABLE_RESTITUTION for physical rationale. `impactSpeed` is |v_y| at
// bounce.
export function tableRestitution(impactSpeed) {
  const hi = TABLE_RESTITUTION + TABLE_RESTITUTION_HI_OFFSET;
  const lo = TABLE_RESTITUTION + TABLE_RESTITUTION_LO_OFFSET;
  return Math.min(COR_MAX, lo + (hi - lo) * Math.exp(-impactSpeed / TABLE_RESTITUTION_V_STAR));
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
