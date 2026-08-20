# VR Table Tennis AI Opponent — Build Spec

**Audience:** coding agent (Claude Code, Cursor, etc.) or human engineer.
**Goal:** an AI opponent (floating paddle, no avatar required) that plays believable rallies across Easy / Intermediate / Hard difficulty modes.
**Non-goals:** rendering, networking, VR input plumbing, multiplayer. This spec is the AI brain only — it consumes player paddle pose and ball state, produces AI paddle pose.

---

## 0. Conventions

- **Coordinate frame:** right-handed. `+X` along the long axis of the table (player → AI), `+Y` up, `+Z` to the player's right. Origin at the center of the table surface.
- **Units:** meters, seconds, kilograms, radians. No mixed units anywhere.
- **Tick rate:** AI runs at 90 Hz (matches typical VR framerate). All time constants below are in seconds.
- **Language:** spec is language-agnostic but examples are in pseudocode close to Python/C#. Use whichever the host engine prefers.

---

## 1. Constants (use exactly these values)

```
# Ball (ITTF standard 40+ ball)
BALL_MASS              = 0.0027        # kg
BALL_RADIUS            = 0.02          # m
BALL_DRAG_COEFF        = 0.4           # dimensionless
AIR_DENSITY            = 1.225         # kg/m^3
BALL_CROSS_SECTION     = pi * BALL_RADIUS**2   # m^2
GRAVITY                = 9.81          # m/s^2 along -Y
MAGNUS_COEFF           = 1.5e-5        # empirical, N·s/rad for TT ball

# Table
TABLE_LENGTH           = 2.74          # m (along X)
TABLE_WIDTH            = 1.525         # m (along Z)
TABLE_HEIGHT           = 0.76          # m (Y of top surface)
NET_HEIGHT             = 0.1525        # m above table surface
TABLE_RESTITUTION      = 0.9           # normal coefficient of restitution
TABLE_FRICTION         = 0.25          # tangential friction at bounce

# Paddle (rubber-on-sponge, both sides)
PADDLE_RESTITUTION     = 0.85
PADDLE_FRICTION        = 0.7           # high friction → spin transfer
PADDLE_RADIUS_EFFECTIVE = 0.075        # m, used for reachable-set queries
```

Validate Layer 1 by checking: a ball launched at 8 m/s horizontal, 0.3 m above the table, with zero spin, should bounce once and land within 5 cm of the analytical no-drag prediction. Bake this as a unit test.

---

## 2. Core data structures

```
BallState:
    position: Vec3            # m
    velocity: Vec3            # m/s
    angular_velocity: Vec3    # rad/s
    timestamp: float          # s

PaddleState:
    position: Vec3
    orientation: Quat         # paddle face normal = orientation * (0, 0, 1)
    linear_velocity: Vec3
    angular_velocity: Vec3
    timestamp: float

BallFuture:
    # Predicted ball trajectory; updated by Layer 3
    sample_times: list[float]            # seconds from now
    positions: list[Vec3]
    velocities: list[Vec3]
    confidence: float                    # 0..1, decays with prediction horizon
    bounce_time: float | None
    arrives_at_ai_side: bool
    estimated_arrival_time: float | None
    estimated_arrival_zone: AABB | None  # uncertainty cloud on AI side

ReachableSet:
    # What the AI paddle can physically achieve in the next T seconds
    # Conservative approximation: an axis-aligned ellipsoid in (x, y, z, t) space
    center: Vec3                         # current paddle position
    max_accel: float                     # m/s^2, from difficulty params
    max_jerk: float                      # m/s^3
    horizon: float                       # s

DifficultyParams:
    pre_contact_lead_time: float         # s   (Easy 0.05, Int 0.15, Hard 0.25)
    prediction_pos_noise: float          # m   (Easy 0.15, Int 0.06, Hard 0.02)
    spin_estimation_accuracy: float      # 0..1 (Easy 0.4, Int 0.75, Hard 0.95)
    paddle_max_accel: float              # m/s^2 (Easy 8, Int 18, Hard 30)
    paddle_max_jerk: float               # m/s^3 (Easy 40, Int 100, Hard 200)
    reachable_cone_halfangle: float      # rad  (Easy 0.70, Int 1.05, Hard 1.40)
    tactical_plies: int                  # 1, 2, 3
    placement_variance: float            # m   (Easy 0.25, Int 0.12, Hard 0.04)
    serve_pool_size: int                 # 4, 10, 20
    adapt_to_player_after_points: int    # 99 (off), 5, 2
    fatigue_rate: float                  # per minute (Easy 0.03, Int 0.015, Hard 0.005)
    recovery_rate: float                 # per second after error (Easy 0.2, Int 0.5, Hard 1.0)

MatchState:
    score_self: int
    score_opponent: int
    points_history: list[PointOutcome]
    momentum: float                      # -1..1, EMA of last 5 points
    fatigue: float                       # 0..1, grows over match duration
    tilt: float                          # 0..1, spikes after own errors, decays
    player_pattern_model: PatternModel   # populated only if Layer 5 enabled

PointOutcome:
    winner: "self" | "opponent"
    shot_count: int
    end_reason: "net" | "out" | "miss" | "winner"
    final_ball_position: Vec3
```

---

## 3. File / module layout

```
ai_opponent/
├── constants.py / Constants.cs          # Section 1
├── types.py / Types.cs                  # Section 2
├── layer1_physics/
│   ├── ball_dynamics.py                 # integrate_ball_one_step()
│   ├── collisions.py                    # ball_table_bounce(), ball_paddle_hit()
│   └── pose_buffer.py                   # ring buffer of PaddleState, 300ms history
├── layer2_motion/
│   ├── trajectory_planner.py            # min_jerk_trajectory()
│   └── paddle_controller.py             # step() returns next PaddleState
├── layer3_predictor/
│   ├── pre_contact.py                   # predict_from_player_swing()
│   ├── at_contact.py                    # compute_outgoing_ball_state()
│   └── post_bounce.py                   # refine_after_bounce()
├── layer4_tactical/
│   ├── shot_selector.py                 # choose_return_shot()
│   ├── serve_generator.py               # sample_serve()
│   └── pattern_model.py                 # tracks player tendencies
├── layer5_match_state/
│   └── match_state.py                   # update_after_point(), modulators
├── difficulty.py                        # presets: EASY, INTERMEDIATE, HARD
├── orchestrator.py                      # main tick(): wires all layers
└── tests/
    ├── test_ball_dynamics.py            # bounce-and-land within 5 cm
    ├── test_min_jerk.py                 # boundary conditions
    ├── test_at_contact.py               # known paddle → known ball state
    ├── test_pre_contact_swing.py        # recorded swing → predicted ball
    ├── test_reachable_set.py            # known params → known reach
    └── test_end_to_end_rally.py         # 10-shot rally completes
```

A coding agent should build files in the order in Section 7. Do not skip ahead.

---

## 4. Function signatures

### Layer 1 — Physics

```
def integrate_ball_one_step(state: BallState, dt: float) -> BallState:
    """
    RK4 integration of:
      dv/dt = -g·ĵ - (0.5·rho·Cd·A / m)·|v|·v + (k_magnus / m)·(omega × v)
      dx/dt = v
    omega is treated as constant during the step (no spin decay model for v1).
    dt should be <= 0.002 s for accuracy under spin. Use 0.001 s default.
    """

def ball_table_bounce(state: BallState) -> BallState:
    """
    Trigger when state.position.y - BALL_RADIUS <= TABLE_HEIGHT and v.y < 0,
    AND the ball is within table footprint in (X, Z).
    Normal: v_y' = -TABLE_RESTITUTION * v_y
    Tangent: v_xz' = v_xz - TABLE_FRICTION * (v_xz - r·(omega × n)_xz_component)
    Spin couples: topspin (omega_z > 0 from player view) speeds up post-bounce v_x;
                  backspin slows it. Use the standard "spin-modified rebound" model.
    Return new BallState with corrected position (push out of table by epsilon).
    """

def ball_paddle_hit(ball: BallState, paddle: PaddleState) -> BallState:
    """
    Compute outgoing ball state from rigid-body collision with a moving plate.
    n = paddle face normal (world space).
    v_rel = ball.velocity - paddle.linear_velocity
    v_n = (v_rel · n) * n
    v_t = v_rel - v_n
    v_n' = -PADDLE_RESTITUTION * v_n
    v_t' = v_t * (1 - PADDLE_FRICTION) + (PADDLE_FRICTION) * (paddle_surface_velocity_at_contact)
    omega' = (1 - PADDLE_FRICTION) * omega + (PADDLE_FRICTION / BALL_RADIUS) * (n × v_t')
    Return ball state with velocity = paddle.linear_velocity + v_n' + v_t', and omega = omega'.
    """
```

### Layer 2 — Motion

```
def min_jerk_trajectory(start: PaddleState, end_pos: Vec3, end_vel: Vec3,
                        duration: float) -> Callable[[float], PaddleState]:
    """
    Returns a function f(t) for t in [0, duration] that produces a quintic
    polynomial position curve matching:
      f(0).position = start.position, f(0).velocity = start.linear_velocity,
      f(0).acceleration = 0  (or current acceleration if tracked)
      f(duration).position = end_pos, f(duration).velocity = end_vel,
      f(duration).acceleration = 0
    Orientation interpolates via SLERP from start to a target orientation
    computed by the planner.
    """

def is_trajectory_feasible(traj: Callable, params: DifficultyParams) -> bool:
    """
    Sample the trajectory at 90 Hz and check that |acceleration| <= max_accel
    and |jerk| <= max_jerk at every sample. Return False if violated.
    """

def paddle_controller_step(current: PaddleState, target_traj: Callable,
                           t_in_traj: float, dt: float) -> PaddleState:
    """
    Returns next paddle state by sampling target_traj(t_in_traj + dt).
    Smooth blending if target_traj has just been replaced.
    """
```

### Layer 3 — Prediction

```
def predict_from_player_swing(paddle_history: PoseBuffer, lead_time: float,
                              noise: float) -> BallFuture | None:
    """
    Examine paddle pose over the last 300 ms.
    Detect that a swing is in progress: monotonic increase in |velocity|
    over >= 6 frames (~66 ms) AND ball is on player's side approaching paddle.
    If swing detected:
      - Extrapolate paddle trajectory forward to estimated contact moment
        using current acceleration (treat as constant over short horizon).
      - Estimate ball position at contact by intersecting ball's predicted
        trajectory with the extrapolated paddle plane.
      - Apply ball_paddle_hit() with extrapolated paddle state.
      - Add Gaussian noise of stddev `noise` to outgoing ball position
        sampled along trajectory.
      - Return BallFuture with confidence proportional to (lead_time available)
        / (lead_time desired).
    If no swing detected, return None.
    """

def compute_outgoing_ball_state(actual_ball: BallState,
                                actual_paddle: PaddleState) -> BallState:
    """
    Called at the frame collision is detected.
    Same as ball_paddle_hit() but using ground-truth states.
    This is the canonical post-contact ball state; overrides Layer 3a prediction.
    """

def refine_after_bounce(observed_state: BallState,
                        existing_future: BallFuture) -> BallFuture:
    """
    Called when ball table-bounces.
    Re-integrate forward from observed_state, replacing the post-bounce portion
    of existing_future. Spin estimation accuracy is reflected by how closely
    observed bounce response matches model (large discrepancy = high spin we
    underestimated; tighten estimate going forward).
    """
```

### Layer 4 — Tactical

```
def get_reachable_set(paddle: PaddleState, params: DifficultyParams,
                      horizon: float) -> ReachableSet:
    """
    Conservative reachable set: paddle can reach any point within
    0.5 * max_accel * horizon^2 of current position, constrained to within
    reachable_cone_halfangle from a "ready stance" axis (varies by handedness;
    default for AI is centered on its own side of the table).
    Returns ReachableSet for downstream feasibility queries.
    """

def choose_return_shot(ball_future: BallFuture, reachable: ReachableSet,
                       params: DifficultyParams, match: MatchState,
                       player_paddle: PaddleState) -> ShotPlan:
    """
    ShotPlan = (contact_point: Vec3, contact_time: float,
                paddle_velocity_at_contact: Vec3, paddle_orientation: Quat)

    Algorithm:
    1. Sample candidate contact points from intersection of ball_future
       trajectory with reachable set (5-10 candidates spaced in time).
    2. For each candidate, sample 3 outgoing shot directions: crosscourt,
       down-the-line, middle. For Hard mode also sample short-vs-long.
    3. For each (contact_point, outgoing_direction): compute required paddle
       velocity using inverse of ball_paddle_hit.
    4. Score each by:
       - return_in_bounds_likelihood (use placement_variance for jitter)
       - tactical_value: distance from player_paddle.position to predicted
         landing spot, weighted by params.tactical_plies (lookahead).
       - feasibility: trajectory min_jerk from current state must satisfy
         is_trajectory_feasible.
    5. Apply MatchState modulators:
       - tilt reduces effective placement accuracy
       - fatigue reduces effective max_accel
       - momentum > 0 increases aggression (prefer winner-attempt shots)
    6. Return highest-scoring plan, or a "scramble" plan (any in-bounds return)
       if no good shot found, or None if truly unreachable.
    """

def sample_serve(params: DifficultyParams, match: MatchState) -> ShotPlan:
    """
    Returns a serve from a pool of size params.serve_pool_size, sampled in
    a 3D space of (placement, spin_type, pace). Avoid recently-used serves
    (window of 3) to prevent repetition.
    """
```

### Layer 5 — Match State

```
def update_match_state(match: MatchState, outcome: PointOutcome) -> MatchState:
    """
    - Append outcome.
    - Update momentum: EMA over last 5 points (alpha = 0.3).
    - Update tilt: spike by 0.3 if outcome.winner == "opponent" and
      end_reason == "miss"; decay 0.1 per point otherwise.
    - Update player_pattern_model if enabled (Layer 5 active above difficulty
      threshold).
    """

def modulate_params(base: DifficultyParams, match: MatchState) -> DifficultyParams:
    """
    Return a copy of base with:
      paddle_max_accel *= (1 - 0.3 * match.fatigue)
      placement_variance *= (1 + 0.5 * match.tilt)
      spin_estimation_accuracy *= (1 - 0.2 * match.tilt)
    Modulated params are recomputed once per point, not per frame.
    """
```

---

## 5. Orchestrator main loop

```
def tick(dt: float):
    # 1. Read inputs
    ball = sensing.get_ball_state()
    player_paddle = sensing.get_player_paddle_state()
    pose_buffer.push(player_paddle)

    # 2. Detect events
    if collision_detected(ball, player_paddle):
        ball_future = layer3.compute_outgoing_ball_state(ball, player_paddle)
        ball_future = wrap_as_future(ball_future)
    elif ball_just_bounced(ball):
        ball_future = layer3.refine_after_bounce(ball, ball_future)
    else:
        # Continuously try pre-contact prediction
        early = layer3.predict_from_player_swing(
            pose_buffer, params.pre_contact_lead_time, params.prediction_pos_noise
        )
        if early is not None and (ball_future is None
                                  or early.confidence > ball_future.confidence):
            ball_future = early

    # 3. Plan if needed
    if ball_future and ball_future.arrives_at_ai_side:
        reachable = layer4.get_reachable_set(ai_paddle, params, horizon=1.0)
        plan = layer4.choose_return_shot(
            ball_future, reachable, params, match_state, player_paddle
        )
        if plan and (current_plan is None or plan_should_supersede(plan, current_plan)):
            current_plan = plan
            current_traj = layer2.min_jerk_trajectory(
                ai_paddle,
                plan.contact_point,
                plan.paddle_velocity_at_contact,
                plan.contact_time - now
            )

    # 4. Step the paddle
    if current_traj:
        ai_paddle = layer2.paddle_controller_step(ai_paddle, current_traj,
                                                  t_in_traj, dt)
        t_in_traj += dt

    # 5. End-of-point bookkeeping
    if point_ended():
        match_state = layer5.update_match_state(match_state, last_outcome)
        params = layer5.modulate_params(base_params, match_state)
        current_plan = None
        current_traj = None
```

---

## 6. Difficulty presets

```
EASY = DifficultyParams(
    pre_contact_lead_time=0.05,
    prediction_pos_noise=0.15,
    spin_estimation_accuracy=0.4,
    paddle_max_accel=8.0,
    paddle_max_jerk=40.0,
    reachable_cone_halfangle=0.70,
    tactical_plies=1,
    placement_variance=0.25,
    serve_pool_size=4,
    adapt_to_player_after_points=99,
    fatigue_rate=0.03,
    recovery_rate=0.2,
)

INTERMEDIATE = DifficultyParams(
    pre_contact_lead_time=0.15,
    prediction_pos_noise=0.06,
    spin_estimation_accuracy=0.75,
    paddle_max_accel=18.0,
    paddle_max_jerk=100.0,
    reachable_cone_halfangle=1.05,
    tactical_plies=2,
    placement_variance=0.12,
    serve_pool_size=10,
    adapt_to_player_after_points=5,
    fatigue_rate=0.015,
    recovery_rate=0.5,
)

HARD = DifficultyParams(
    pre_contact_lead_time=0.25,
    prediction_pos_noise=0.02,
    spin_estimation_accuracy=0.95,
    paddle_max_accel=30.0,
    paddle_max_jerk=200.0,
    reachable_cone_halfangle=1.40,
    tactical_plies=3,
    placement_variance=0.04,
    serve_pool_size=20,
    adapt_to_player_after_points=2,
    fatigue_rate=0.005,
    recovery_rate=1.0,
)
```

---

## 7. Build order (strict — do not skip)

Each step has a **definition of done** the agent must verify before moving on.

1. **Constants + types.** DoD: all values present with units in comments; types compile.
2. **Layer 1 ball dynamics.** DoD: `test_ball_dynamics` passes — ball launched at 8 m/s lands within 5 cm of analytical no-drag prediction; with 100 rad/s topspin, ball curves downward more than no-spin case by at least 3 cm at the same horizontal distance.
3. **Layer 1 collisions.** DoD: `test_collisions` — backspin ball hits table and post-bounce horizontal velocity is reduced vs no-spin; topspin ball post-bounce horizontal velocity is increased. Paddle hit with paddle moving forward at 5 m/s, ball stationary, produces ball velocity ≈ paddle_velocity * 1.85 in normal direction (close to 2*v from elastic plate, reduced by restitution).
4. **Pose buffer.** DoD: 300 ms ring buffer at 90 Hz; query for "velocity 100 ms ago" works.
5. **Layer 2 min-jerk.** DoD: `test_min_jerk` — boundary conditions hit exactly; jerk profile is bounded; trajectory is C2 continuous.
6. **Layer 2 paddle controller.** DoD: handed a trajectory, produces correct interpolated states; smooth blending on trajectory replacement (no position discontinuity > 1 cm).
7. **Layer 3b at-contact.** DoD: `test_at_contact` — given canned paddle hitting canned ball, output matches Layer 1 collision function exactly. (This is mostly a wrapper but it's the "ground truth" reference for Layer 3a.)
8. **Layer 3c post-bounce refinement.** DoD: given an observed bounce with unexpected behavior, BallFuture re-integration uses observed post-bounce state, not predicted.
9. **Reachable set.** DoD: at max_accel = 18, horizon = 0.5 s, reachable ellipsoid has semi-axis ≈ 2.25 m. Inside the cone, within range = reachable. Outside the cone, never reachable.
10. **End-to-end reactive AI (Layers 1 + 2 + 3b + minimal 4).** DoD: `test_end_to_end_rally` — ball served at AI, AI returns it in-bounds, player echoes it back (scripted bot), AI returns again. 10-shot rally completes without anyone missing. Use INTERMEDIATE difficulty for this test. **At this checkpoint the AI is already better than most shipped products.**
11. **Layer 3a pre-contact prediction.** DoD: `test_pre_contact_swing` — feed a recorded 200 ms player swing; the prediction's contact point is within `prediction_pos_noise` of the actual contact point that occurs when the swing completes. AI paddle has begun moving toward the predicted return zone *before* the player's contact frame.
12. **Layer 4 tactical depth.** DoD: with `tactical_plies=2`, AI's chosen shot lands at least 30 cm farther from `player_paddle.position` than with `tactical_plies=1`, averaged over 50 rallies.
13. **Layer 4 serve generator.** DoD: 20 serves sampled with `serve_pool_size=10` show 10 unique (placement, spin, pace) buckets; no repetition within 3 consecutive serves.
14. **Layer 5 match state.** DoD: after 5 simulated lost points in a row, modulated `placement_variance` is at least 1.3x base.
15. **Difficulty parameter sweep.** DoD: full game (first to 11) at EASY: human-equivalent player wins. At HARD: human-equivalent player loses. At INTERMEDIATE: roughly 50/50 over 10 games. Tune presets until this holds.

---

## 8. Common failure modes to test for explicitly

These are bugs to actively probe in QA. Each gets its own test.

- **Paddle freezes on wide shots.** Test: ball trajectory passes within reachable set but 1.5 m from paddle center; verify paddle moves toward it.
- **Paddle teleports.** Test: track per-frame paddle position delta; never > max_velocity * dt + epsilon.
- **AI returns spin shots as if flat.** Test: serve heavy backspin; AI's return must compensate (paddle angle more closed, more upward velocity) — verify return clears the net and lands in.
- **AI reacts identically on every difficulty.** Test: same incoming ball, three difficulties; verify materially different contact points and return placements.
- **AI commits early and can't update.** Test: fake a swing then change direction; verify AI's predicted contact point updates within 33 ms of the swing direction change.
- **Serve repetition.** Test: 30 serves; verify no 3 consecutive are identical in any of (placement, spin, pace).
- **AI never misses on Hard.** Test: 100 points on Hard against scripted attacking player; verify AI miss rate is between 5% and 15% (perfect AI is a bug).
- **Rally always ends in 1-2 shots.** Test: average rally length over 50 points on Intermediate should be >= 4 shots.

---

## 9. What this spec deliberately omits

- **Animation / IK for a visible arm.** Out of scope. Paddle pose is the output; rendering layer handles visualization.
- **Spin decay over flight.** v1 treats angular velocity as constant during flight. Real balls lose spin to air drag (~5-10% per second). Add in v2 if needed.
- **Net cord physics.** Touching the net is treated as a fault; we don't simulate net cord dribblers. Add in v2.
- **Voice / personality.** Not part of the AI brain.
- **Learning across matches.** PatternModel resets per match. Persistent player modeling is v2.
- **Multiplayer / doubles.** Single AI vs single player only.

---

## 10. Ambiguity flags for the implementing agent

If the agent encounters any of the following, STOP and ask:

- The host engine's coordinate frame differs from Section 0 — get explicit mapping before writing any vector math.
- The host engine's collision callback fires *after* penetration rather than at contact — need to do continuous collision detection or back-solve contact time.
- Paddle pose samples arrive at non-uniform intervals — clarify whether to interpolate or use raw samples.
- The game allows two-handed grips or non-standard paddle shapes — current spec assumes single rigid paddle with flat face.

Everything else in this spec is intended to be unambiguous. If something feels ambiguous, re-read the relevant section; if still ambiguous, file an issue rather than guess.
