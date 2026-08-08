// Player-serve controller — press-trigger-to-toss.
//
// When the rally manager hands the serve to the player, arm() is called.
// The player then pulls the trigger on either controller — routed through
// inGame.js's handleTrigger → drill.launch() → this module's launch() —
// and a courtesy ball is spawned in front of them. From there the player
// hits it with the paddle exactly like any other rally shot.
//
// Kept deliberately minimal after an earlier "palm-toss" version (preview
// mesh floating above the off-hand + upward-flick detection) failed to
// surface reliably in-headset. The single-button contract has zero pose
// dependencies and can never silently fail.

import * as THREE from 'three';
import { tableBox, tableSurfaceY, ballModel } from '../../scene/models.js';
import { spawnBallAt } from '../../physics/ball.js';
import { hudLog } from '../../scene/hud.js';

// Toss geometry.
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
// natural. Small forward drift keeps the ball over the table so it doesn't
// fall behind the player's baseline.
const TOSS_HEIGHT_ABOVE_TABLE_M = 0.30;
const TOSS_INSET_FROM_EDGE_M    = 0.05;
const TOSS_UP_VY_MPS   = 4.0;
const TOSS_FORWARD_VZ_MPS = -0.15;
const TOSS_LATERAL_JITTER_MPS = 0.2;

export function createPlayerServeController() {
  let armed = false;

  function arm() {
    armed = true;
    hudLog('[serve] pull trigger to toss');
    return true;
  }

  function disarm() {
    armed = false;
  }

  function isArmed() { return armed; }

  // Called by the drill's launch() hook when the player pulls either trigger.
  // No-op unless we're currently armed — that guarantees mid-rally trigger
  // presses (e.g. paddle-hand poke gestures) can't spawn a phantom second ball.
  function launch() {
    if (!armed) return false;
    if (!tableBox || !ballModel) return false;

    const x = (tableBox.min.x + tableBox.max.x) / 2;
    const y = (tableSurfaceY || 0) + TOSS_HEIGHT_ABOVE_TABLE_M;
    const z = tableBox.max.z - TOSS_INSET_FROM_EDGE_M;
    spawnBallAt(
      new THREE.Vector3(x, y, z),
      new THREE.Vector3(
        (Math.random() - 0.5) * TOSS_LATERAL_JITTER_MPS,
        TOSS_UP_VY_MPS,
        TOSS_FORWARD_VZ_MPS,
      ),
      new THREE.Vector3(),
    );

    armed = false;
    return true;
  }

  // Kept as a no-op so aiMatch's per-frame update() loop can call it
  // unconditionally without a type check.
  function update(/* dt */) {}

  function dispose() {
    armed = false;
  }

  return { arm, disarm, isArmed, update, launch, dispose };
}
