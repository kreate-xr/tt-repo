// Trajectory Practice — pick spin + speed, see the dotted predicted path,
// pull the trigger to launch a ball that follows it. No scoring; pure study.

import * as THREE from 'three';
import { ballModel } from '../../../scene/models.js';
import { spawnBallAt } from '../../../physics/ball.js';
import { TrajectoryControl } from '../../../scene/trajectoryControl.js';
import { TrajectoryDots, simulateTrajectory } from '../trajectoryPreview.js';
import { getSpawnPos, getLandingPos, ballisticVelocity } from '../launchKinematics.js';

// Spin axes (right-hand rule, ball moving in +Z toward player at z=0):
//   topspin  → ω in +X (ball drops faster)
//   backspin → ω in -X (ball floats / slows on bounce)
//   sideA    → ω in +Y (ball curves toward +X mid-flight)
//   sideB    → ω in -Y (ball curves toward -X mid-flight)
// Moved here from feeder.js when the legacy feed path was deleted — this
// drill is the convention's only remaining consumer.
const SPIN_AXES = {
  topspin:  new THREE.Vector3( 1, 0, 0),
  backspin: new THREE.Vector3(-1, 0, 0),
  sideA:    new THREE.Vector3( 0, 1, 0),
  sideB:    new THREE.Vector3( 0, -1, 0),
  none:     new THREE.Vector3( 0, 0, 0),
};

export const TRAJECTORY_PRACTICE = {
  id: 'trajectoryPractice',
  label: 'Trajectory Practice',
};

export function createTrajectoryPracticeDrill({ ballEvents, hooks = {} }) {
  const control = new TrajectoryControl();
  const dots = new TrajectoryDots();

  const spawnPos = new THREE.Vector3();
  const landingPos = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const angVel = new THREE.Vector3();

  let ballInFlight = false;

  function recomputePreview() {
    const spin = control.getSpin();
    const speed = control.getSpeed();
    const intensity = control.getIntensity();

    getSpawnPos(spawnPos);
    getLandingPos(0, landingPos); // center placement for preview
    ballisticVelocity(spawnPos, landingPos, speed.flightTime, velocity);

    const axis = SPIN_AXES[spin.id] || SPIN_AXES.none;
    angVel.copy(axis).multiplyScalar(intensity.spinMag);

    const samples = simulateTrajectory(spawnPos, velocity, angVel);
    dots.setFromSamples(samples, spin.id);
    if (ballInFlight) dots.hide(); // don't show preview while a real ball is flying
  }

  control.on('spinChange', recomputePreview);
  control.on('speedChange', recomputePreview);
  control.on('intensityChange', recomputePreview);
  control.on('back', () => { if (hooks.exitToMenu) hooks.exitToMenu(); });
  control.on('hide', () => control.hide());

  ballEvents.onBallLost(() => {
    ballInFlight = false;
    dots.show(); // re-show preview for next launch
  });

  // Initial preview computed on first update once tableBox is reliably available.
  let initialized = false;

  function launch() {
    if (ballInFlight) return;
    if (!ballModel) return;
    // Recompute fresh in case the player moved or table just loaded
    recomputePreview();
    spawnBallAt(spawnPos, velocity, angVel);
    ballInFlight = true;
    dots.hide(); // hide preview while live ball flies; actual ball is the truth now
  }

  return {
    isTrajectoryDrill: true,
    panel: control,        // for inGame.js raycast routing
    panelMesh: control.mesh,
    launch,                // called by inGame.js when paddle trigger fires outside the panel
    update(_dt) {
      if (!initialized) {
        recomputePreview();
        control.show();
        initialized = true;
      }
    },
    isFinished() { return false }, // open-ended; user exits via Back button
    liveLine() {
      const sp = control.getSpin().label;
      const sd = control.getSpeed().label;
      const it = control.getIntensity().label;
      if (!control.isVisible()) {
        return `Practice: ${sp} sp${sd} int${it}  ·  trigger=launch  ·  A/X=panel`;
      }
      return `Trajectory  —  ${sp}  speed ${sd}  intensity ${it}  ·  trigger off-panel to launch`;
    },
    dispose() {
      control.hide();
      control.dispose();
      dots.dispose();
    },
  };
}
