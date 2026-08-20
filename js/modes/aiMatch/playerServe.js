// Player-serve controller — physical off-hand toss with a trigger fallback.
//
// When the rally manager hands the serve to the player, arm() is called.
// From there the ball can be put in play two ways:
//
//   1. PHYSICAL TOSS (preferred, needs the off-hand controller): squeeze the
//      GRIP button on the free hand — a ball appears resting in that hand —
//      then swing upward and let go of grip. The ball leaves with the hand's
//      real velocity at release, like tossing an actual serve. The release is
//      a discrete button edge, not gesture recognition: unlike the removed
//      "palm-toss" flick detector this path cannot silently fail — worst case
//      the player releases while stationary and the ball drops at their feet
//      (a whiffed toss → clean ballLost → serve re-offered).
//
//   2. TRIGGER FALLBACK (always available, zero pose dependencies): pull the
//      trigger on either controller — routed through inGame.js's
//      handleTrigger → drill.launch() — and the waiting ball is tossed
//      near-vertically from wherever it is visibly resting (at the off-hand
//      controller, or the fixed point behind the end line when no off-hand is
//      tracked). This is the original single-button contract and remains the
//      guarantee that a missing/dead off-hand controller can never make the
//      game unserveable.
//
// Both paths end the same way: the ball is live, launch listeners fire, and
// the player hits it with the paddle exactly like any other rally shot.

import * as THREE from 'three';
import { tableBox, tableSurfaceY, ballModel, ballRadius } from '../../scene/models.js';
import { spawnBallAt } from '../../physics/ball.js';
import { hudLog } from '../../scene/hud.js';
import { pulseHand } from '../../xr/haptics.js';

// Toss geometry (trigger fallback).
//
// The old numbers (VY=1.4, VZ=-0.5) gave the ball a peak rise of only ~8cm
// under weighty-gravity (-12 m/s²) and a total flight time of ~230ms — the
// ball barely popped up before falling, and the strong forward drift sent
// it toward the AI's end instead of arcing over the player. Players
// reported "the ball is dropped from very low height" — this is why.
//
// New tuning: near-vertical toss to ~1m above table with ~700ms of flight
// so the player has time to see the ball, reset stance, and swing at the
// apex or on descent. Numbers pencil out under weighty gravity (-12):
//   peak rise    = VY²/(2*g) = 16/24 ≈ 0.67m
//   peak height  = spawn 0.30m + 0.67m ≈ 0.97m above table (well above net)
//   time to peak = VY/g ≈ 0.33s ; total flight ≈ 0.67s
// Under standard gravity (-9.8) the arc is a bit taller/slower — still
// natural. The toss starts BEHIND the end line (ITTF service rule); the
// small forward drift carries it to roughly the line by strike time, and a
// whiffed toss falls behind the table — a clean ballLost, re-offered serve.
const TOSS_HEIGHT_ABOVE_TABLE_M = 0.30;
const TOSS_BEHIND_EDGE_M        = 0.05;
const TOSS_UP_VY_MPS   = 4.0;
// Inward drift. Was -0.15, which carried the ball ~10cm forward over its
// ~0.7s flight — enough that a late strike happened INSIDE the end line and
// tripped the serve-position fault (ittfFaults.checkServeContact) on the
// game's own courtesy toss. At -0.05 the whole flight drifts ~3cm, so the
// contact stays behind the line however late the player swings, and the toss
// is closer to the near-vertical one ITTF asks for anyway.
const TOSS_FORWARD_VZ_MPS = -0.05;
const TOSS_LATERAL_JITTER_MPS = 0.2;

// --- Physical toss (off-hand grip hold/release) ------------------------------
// xr-standard gamepad mapping: buttons[0] = trigger, buttons[1] = squeeze.
// (Same convention as inGame.js's buttons[4] A/X poll — Quest controllers
// follow the xr-standard layout.)
const GRIP_BUTTON_INDEX = 1;
// Where the held ball sits relative to the controller, in grip-local space.
// WebXR grip space puts its origin at the center of the fist with -Z pointing
// out through the top of the fist — the direction the controller body and
// tracking head extend. A Quest-style controller reaches roughly 6cm from
// grip origin to the head, so 8.5cm along -Z leaves the ball hovering
// ~2-3cm clear of the controller head, glued to it whatever way the hand
// tilts (a world-up offset here made the ball clip the head when tilted).
const HOLD_OFFSET_LOCAL = new THREE.Vector3(0, 0, -0.085);
// Release velocity = displacement over the freshest ≤ this window of grip
// samples. Long enough to average out single-frame tracking jitter, short
// enough that the estimate is the RELEASE velocity, not the whole windup.
const VELOCITY_WINDOW_MS = 110;
// Below this sample span the estimate is noise-dominated (one frame of
// tracking jitter divided by a tiny dt) — treat as a stationary drop instead.
const MIN_SAMPLE_SPAN_MS = 20;
// Ballistic sanity cap. A real serve toss peaks around 2-3 m/s of hand speed;
// anything past this is a tracking glitch or a deliberate fastball throw, and
// either way it shouldn't rocket the ball through the venue.
const MAX_TOSS_SPEED_MPS = 5;
// ITTF wants the toss to rise ≥16cm from the palm. Under weighty gravity
// (-12 m/s²) that needs vy ≥ √(2·12·0.16) ≈ 1.96 m/s. We don't call a fault —
// the physics will punish a flat toss naturally — we just coach via HUD.
const LOW_TOSS_HINT_VY_MPS = 1.9;

// Pure helper — estimates release velocity from a time-ordered array of
// {t, x, y, z} samples (t in ms). Writes into `out` (a THREE.Vector3) and
// returns it. Zero velocity when there aren't two samples at least
// MIN_SAMPLE_SPAN_MS apart inside VELOCITY_WINDOW_MS of the newest sample.
// Exported for unit tests — everything else in this module needs a headset.
export function estimateReleaseVelocity(samples, out) {
  out.set(0, 0, 0);
  if (!samples || samples.length < 2) return out;
  const newest = samples[samples.length - 1];
  // Oldest sample still inside the window (samples are time-ordered).
  let oldest = null;
  for (let i = 0; i < samples.length; i++) {
    if (newest.t - samples[i].t <= VELOCITY_WINDOW_MS) { oldest = samples[i]; break; }
  }
  if (!oldest) return out;
  const spanMs = newest.t - oldest.t;
  if (spanMs < MIN_SAMPLE_SPAN_MS) return out;
  const inv = 1000 / spanMs;
  out.set(
    (newest.x - oldest.x) * inv,
    (newest.y - oldest.y) * inv,
    (newest.z - oldest.z) * inv,
  );
  const speed = out.length();
  if (speed > MAX_TOSS_SPEED_MPS) out.multiplyScalar(MAX_TOSS_SPEED_MPS / speed);
  return out;
}

// `xr` is the setupXRPaddle handle (getOffHandGrip / getOffHandInputSource /
// getOffHandHandedness). Optional — without it only the trigger path exists,
// which is exactly the old behavior (headless tests, older callers).
// `now` is injectable for deterministic tests.
export function createPlayerServeController({ xr = null, now = () => performance.now() } = {}) {
  let armed = false;
  // Fired the moment a toss ball actually spawns (either path). The rally
  // manager uses this to start its "courtesy ball is live" window — that
  // window must not open at arm() time, because between arm() and the toss
  // the only ball that can emit events is the PREVIOUS rally's leftover ball,
  // and treating its ballLost as "toss lost" double-schedules the serve.
  const launchListeners = [];

  // Physical-toss state.
  let holding = false;      // grip held, preview ball glued to the off-hand
  let prevSqueeze = false;  // for rising/falling edge detection
  const samples = [];       // {t, x, y, z} grip positions, time-ordered
  // The physics ball (ballModel) is a singleton that spawnBallAt reuses, so
  // the in-hand ball is a separate visual — that way the held state can't
  // emit physics events, and the real ball only exists once the toss is
  // genuinely airborne. It's a CLONE of the real ball asset (shared geometry
  // and materials) so what sits at the controller is visually the game ball,
  // not a stand-in sphere.
  let previewMesh = null;
  let previewOwnsResources = false; // true only for the fallback sphere

  const tmpHoldPos = new THREE.Vector3();
  const tmpTossVel = new THREE.Vector3();
  const tmpGripQuat = new THREE.Quaternion();
  const tmpOffset = new THREE.Vector3();

  // World-space hold point: grip origin + HOLD_OFFSET_LOCAL carried into
  // world by the grip's orientation. Returns false when the grip pose is
  // untracked (all-zero world position — same test the xrPaddle attach
  // sweep uses), leaving `out` unusable.
  function readHoldPoint(grip, out) {
    grip.updateMatrixWorld();
    grip.getWorldPosition(out);
    if (out.lengthSq() < 1e-8) return false;
    grip.getWorldQuaternion(tmpGripQuat);
    out.add(tmpOffset.copy(HOLD_OFFSET_LOCAL).applyQuaternion(tmpGripQuat));
    return true;
  }

  function onLaunch(fn) { launchListeners.push(fn); }

  function arm() {
    armed = true;
    // A player already squeezing grip when the serve window opens picks the
    // ball up on the first armed frame — intended (they're saying "gimme").
    prevSqueeze = false;
    hudLog(xr
      ? '[serve] squeeze GRIP on your free hand to hold the ball, release to toss — or pull trigger for an auto-toss'
      : '[serve] pull trigger to toss — bounce the serve on YOUR half first');
    return true;
  }

  function disarm() {
    armed = false;
    cancelHold();
  }

  function isArmed() { return armed; }
  function isHolding() { return holding; }

  function completeLaunch() {
    armed = false;
    prevSqueeze = false;
    if (previewMesh) previewMesh.visible = false;
    for (const fn of launchListeners) fn();
  }

  // --- Trigger fallback ------------------------------------------------------
  // Called by the drill's launch() hook when the player pulls either trigger.
  // No-op unless we're currently armed — that guarantees mid-rally trigger
  // presses (e.g. paddle-hand poke gestures) can't spawn a phantom second
  // ball. Also a no-op while the ball is held in the off-hand: the toss is
  // already in progress, and a paddle-hand trigger graze must not conjure a
  // second ball alongside the held one.
  function launch() {
    if (!armed || holding) return false;
    if (!tableBox || !ballModel) return false;

    // Toss FROM where the ball is visibly waiting — attached to the off-hand
    // controller (or floating at the fallback point when there's no off-hand)
    // — so the trigger reads as launching the ball the player is looking at,
    // not conjuring a second ball at a different spot.
    if (previewMesh && previewMesh.visible) {
      tmpHoldPos.copy(previewMesh.position);
    } else {
      tmpHoldPos.set(
        (tableBox.min.x + tableBox.max.x) / 2,
        (tableSurfaceY || 0) + TOSS_HEIGHT_ABOVE_TABLE_M,
        tableBox.max.z + TOSS_BEHIND_EDGE_M,
      );
    }
    // spawnBallAt copies its arguments, so the tmp vector is safe to pass.
    spawnBallAt(
      tmpHoldPos,
      new THREE.Vector3(
        (Math.random() - 0.5) * TOSS_LATERAL_JITTER_MPS,
        TOSS_UP_VY_MPS,
        TOSS_FORWARD_VZ_MPS,
      ),
      new THREE.Vector3(),
    );

    completeLaunch();
    return true;
  }

  // --- Physical toss ---------------------------------------------------------

  function readOffHand() {
    if (!xr || !xr.getOffHandGrip || !xr.getOffHandInputSource) {
      return { grip: null, pressed: false };
    }
    const grip = xr.getOffHandGrip();
    const src = xr.getOffHandInputSource();
    const btn = src && src.gamepad && src.gamepad.buttons
      ? src.gamepad.buttons[GRIP_BUTTON_INDEX] : null;
    return { grip, pressed: !!(btn && btn.pressed) };
  }

  function pushSample(pos) {
    const t = now();
    samples.push({ t, x: pos.x, y: pos.y, z: pos.z });
    // Trim anything older than the estimation window (+ one frame of slack)
    // so the buffer stays a handful of entries, not a whole hold's worth.
    const cutoff = t - (VELOCITY_WINDOW_MS + 40);
    while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
  }

  function ensurePreview() {
    if (previewMesh) return previewMesh;
    // ballModel's parent is the scene — piggyback on it rather than importing
    // sceneSetup here (keeps this module import-safe for headless tests).
    if (!ballModel || !ballModel.parent) return null;
    if (ballModel.isObject3D && typeof ballModel.clone === 'function') {
      // Clone the real Ball.glb wrapper — geometry and materials are shared,
      // so the held ball is pixel-identical to the ball that spawns on toss.
      previewMesh = ballModel.clone();
      previewOwnsResources = false;
    } else {
      // Ball asset not clonable (shouldn't happen in the app) — plain sphere
      // beats no ball at all.
      previewMesh = new THREE.Mesh(
        new THREE.SphereGeometry(ballRadius || 0.02, 20, 14),
        new THREE.MeshStandardMaterial({ color: 0xfff4e0, roughness: 0.4 }),
      );
      previewOwnsResources = true;
    }
    previewMesh.name = 'playerServeHeldBall';
    previewMesh.visible = false;
    ballModel.parent.add(previewMesh);
    return previewMesh;
  }

  function beginHold(grip) {
    // Untracked grip → don't hand the player an invisible ball at the origin.
    if (!readHoldPoint(grip, tmpHoldPos)) return;
    holding = true;
    samples.length = 0;
    pushSample(tmpHoldPos);
    const mesh = ensurePreview();
    if (mesh) {
      mesh.position.copy(tmpHoldPos);
      mesh.visible = true;
    }
    const hand = xr.getOffHandHandedness ? xr.getOffHandHandedness() : null;
    if (hand) pulseHand(hand, 0.35, 50);
    hudLog('[serve] ball in hand — toss upward and let go of GRIP');
  }

  // While the serve is armed but the ball hasn't been picked up yet, the ball
  // still needs to be SEEN — otherwise the player stands at an empty table
  // wondering where it went. Rest it in the open off-hand when the grip is
  // tracked (matching the "squeeze GRIP to hold" coaching), else float it at
  // the trigger-toss spawn point behind the end line.
  function updateReadyPreview(grip) {
    const mesh = ensurePreview();
    if (!mesh) return;
    if (grip && readHoldPoint(grip, tmpHoldPos)) {
      mesh.position.copy(tmpHoldPos);
      mesh.visible = true;
      return;
    }
    if (!tableBox) { mesh.visible = false; return; }
    mesh.position.set(
      (tableBox.min.x + tableBox.max.x) / 2,
      (tableSurfaceY || 0) + TOSS_HEIGHT_ABOVE_TABLE_M,
      tableBox.max.z + TOSS_BEHIND_EDGE_M,
    );
    mesh.visible = true;
  }

  // Controller vanished / squeeze state unrecoverable mid-hold: put the ball
  // away and fall back to the armed state, where the trigger path still works.
  function cancelHold() {
    holding = false;
    samples.length = 0;
    if (previewMesh) previewMesh.visible = false;
  }

  function releaseToss() {
    const last = samples[samples.length - 1];
    holding = false;
    if (previewMesh) previewMesh.visible = false;
    if (!last || !ballModel) {
      // No usable pose or no ball asset — stay armed, fallback still live.
      samples.length = 0;
      return;
    }
    estimateReleaseVelocity(samples, tmpTossVel);
    samples.length = 0;
    // spawnBallAt copies its arguments, so tmp vectors are safe to pass.
    tmpHoldPos.set(last.x, last.y, last.z);
    spawnBallAt(tmpHoldPos, tmpTossVel, new THREE.Vector3());
    if (tmpTossVel.y < LOW_TOSS_HINT_VY_MPS) {
      hudLog('[serve] low toss — a real serve wants a ~16cm rise before the strike');
    }
    const hand = xr.getOffHandHandedness ? xr.getOffHandHandedness() : null;
    if (hand) pulseHand(hand, 0.2, 35);
    completeLaunch();
  }

  // Per-frame poll. Cheap when idle (single boolean check); only does work
  // while the player is the server (armed) or mid-hold.
  function update(/* dt */) {
    if (!armed && !holding) return;
    const { grip, pressed } = readOffHand();

    if (holding) {
      if (!grip) {
        cancelHold();
        prevSqueeze = false;
        return;
      }
      // Skip samples while the grip is untracked — the frozen preview and the
      // last good sample carry the hold through a brief occlusion.
      if (readHoldPoint(grip, tmpHoldPos)) {
        pushSample(tmpHoldPos);
        if (previewMesh) previewMesh.position.copy(tmpHoldPos);
      }
      if (!pressed) releaseToss();
    } else if (armed && pressed && !prevSqueeze && grip) {
      beginHold(grip);
    } else if (armed) {
      updateReadyPreview(grip);
    }
    prevSqueeze = pressed;
  }

  function dispose() {
    armed = false;
    cancelHold();
    launchListeners.length = 0;
    if (previewMesh) {
      if (previewMesh.parent) previewMesh.parent.remove(previewMesh);
      // The ballModel clone SHARES geometry/materials with the live game ball
      // — disposing them would blank the real ball. Only the fallback sphere
      // owns its resources.
      if (previewOwnsResources) {
        previewMesh.geometry.dispose();
        previewMesh.material.dispose();
      }
      previewMesh = null;
    }
  }

  return { arm, disarm, isArmed, isHolding, update, launch, onLaunch, dispose };
}
