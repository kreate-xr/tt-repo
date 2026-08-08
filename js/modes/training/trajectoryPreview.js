// Forward-simulates the ball's flight using the same physics as tickPhysics, so
// the dotted preview matches the live ball. Renders the samples as a Points
// cloud (depth-test off so it shows through the table model).

import * as THREE from 'three';
import { scene } from '../../scene/sceneSetup.js';
import { ballRadius, tableBox, tableSurfaceY } from '../../scene/models.js';
import {
  integrateFlightStep, applyTableBounce, isTableBounce, DT_PRESETS,
} from '../../physics/rollout.js';

const SAMPLE_DT = DT_PRESETS.PREVIEW;
const MAX_SAMPLES_BEFORE_BOUNCE = 90;
const MAX_SAMPLES_AFTER_BOUNCE = 50;

// Returns an array of THREE.Vector3 samples representing the ball's path until
// it leaves the play volume (or hits the floor).
//
// The integration and bounce response come from js/physics/rollout.js, which
// is the same code tickPhysics is mirrored from. That identity is the whole
// point of the preview: a dotted line drawn from an approximation of the
// physics teaches the player the wrong lesson about spin.
export function simulateTrajectory(startPos, startVel, startAngVel) {
  const positions = [];
  const p = startPos.clone();
  const v = startVel.clone();
  const w = startAngVel.clone();
  const env = { ballRadius, tableSurfaceY, tableBox };
  let bounced = false;

  // Pre-bounce arc.
  for (let i = 0; i < MAX_SAMPLES_BEFORE_BOUNCE; i++) {
    positions.push(p.clone());
    integrateFlightStep(p, v, w, SAMPLE_DT);

    if (!bounced && isTableBounce(p, v, env)) {
      p.y = tableSurfaceY + ballRadius;
      applyTableBounce(v, w, ballRadius);
      bounced = true;
      break;
    }
    if (p.y < tableSurfaceY - 0.5) break; // off side of table
  }

  if (bounced) {
    for (let j = 0; j < MAX_SAMPLES_AFTER_BOUNCE; j++) {
      positions.push(p.clone());
      integrateFlightStep(p, v, w, SAMPLE_DT);
      if (p.y - ballRadius < tableSurfaceY - 0.4) break;
    }
  }

  return positions;
}

// --- Renderer -----------------------------------------------------------------

const SPIN_COLORS = {
  topspin:  0xff3344,
  backspin: 0x3388ff,
  sideA:    0xffcc22,
  sideB:    0xff8822,
  none:     0xffffff,
};

// Round soft-edge dot texture painted once and shared across all instances.
// Radial alpha gradient gives PointsMaterial a proper circular sprite instead
// of the default hard square.
let DOT_TEXTURE = null;
function getDotTexture() {
  if (DOT_TEXTURE) return DOT_TEXTURE;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  grad.addColorStop(0.00, 'rgba(255,255,255,1.00)');
  grad.addColorStop(0.40, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.30)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  DOT_TEXTURE = new THREE.CanvasTexture(canvas);
  DOT_TEXTURE.minFilter = THREE.LinearFilter;
  DOT_TEXTURE.magFilter = THREE.LinearFilter;
  return DOT_TEXTURE;
}

export class TrajectoryDots {
  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
    const material = new THREE.PointsMaterial({
      size: 0.026,
      map: getDotTexture(),
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
      depthWrite: false,
      vertexColors: true,
      alphaTest: 0.02,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.renderOrder = 998;
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  setFromSamples(samples, spinName) {
    if (!samples || !samples.length) {
      this.points.visible = false;
      return;
    }
    const n = samples.length;
    const flatPos = new Float32Array(n * 3);
    const flatCol = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      flatPos[i * 3]     = samples[i].x;
      flatPos[i * 3 + 1] = samples[i].y;
      flatPos[i * 3 + 2] = samples[i].z;
      // Head bright, tail fades to ~30% brightness — reads as motion trail.
      const t = i / Math.max(n - 1, 1);
      const b = 1.0 - 0.70 * t;
      flatCol[i * 3]     = b;
      flatCol[i * 3 + 1] = b;
      flatCol[i * 3 + 2] = b;
    }
    this.points.geometry.dispose();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(flatPos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(flatCol, 3));
    this.points.geometry = geom;
    this.points.material.color.setHex(SPIN_COLORS[spinName] ?? 0xffffff);
    this.points.visible = true;
  }

  hide() { this.points.visible = false; }
  show() { this.points.visible = true; }

  dispose() {
    if (this.points.parent) this.points.parent.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
