// Trajectory Practice — pick spin + speed, see the dotted predicted path,
// pull the trigger to launch a ball that follows it. No scoring; pure study.

import * as THREE from 'three';
import { ballModel } from '../../../scene/models.js';
import { spawnBallAt } from '../../../physics/ball.js';
import { TrajectoryControl, SPINS, SPEED_LEVELS } from '../../../scene/trajectoryControl.js';
import { TrajectoryDots, simulateTrajectory } from '../trajectoryPreview.js';
import { SPIN_AXES } from '../feeder.js';
import { getSpawnPos, getLandingPos, ballisticVelocity } from '../launchKinematics.js';

export const TRAJECTORY_PRACTICE = {
  id: 'trajectoryPractice',
  label: 'Trajectory Practice',
};

export function createTrajectoryPracticeDrill({ stats, ballEvents, profile, hooks = {} }) {
  const control = new TrajectoryControl();
  const dots = new TrajectoryDots();

  const spawnPos = new THREE.Vector3();
  const landingPos = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const angVel = new THREE.Vector3();

  let ballInFlight = false;
  let cachedSpinName = null;

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
    cachedSpinName = spin.id;
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
    stats.recordFeed({ spin: cachedSpinName });
  }

  return {
    isTrajectoryDrill: true,
    usesFeeder: false,     // manual launch; inGame should skip feeder.update
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
