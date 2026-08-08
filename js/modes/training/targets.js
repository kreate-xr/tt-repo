// Translucent scoring zones on the opponent's half of the table.
// Player tries to land returns inside one of these zones.

import * as THREE from 'three';
import { scene } from '../../scene/sceneSetup.js';
import { tableBox, tableSurfaceY } from '../../scene/models.js';

const ZONE_COLOR = 0x00aaff;
const ZONE_HIT_COLOR = 0x00ff66;
const ZONE_MISS_COLOR = 0xff5544;

export class TargetZones {
  constructor(layout = 'corners') {
    this.zones = [];
    this.activeIndex = -1;
    this.buildZones(layout);
  }

  buildZones(layout) {
    if (!tableBox) return;
    const minX = tableBox.min.x, maxX = tableBox.max.x;
    const minZ = tableBox.min.z;                    // far edge (opponent side)
    const centerZ = (tableBox.min.z + tableBox.max.z) / 2;
    const halfWidth = (maxX - minX) / 2;
    const halfX = halfWidth * 0.85;

    const zoneSize = 0.27;
    const inset = 0.06;
    // 3 zones on the opponent's half: far-left corner, far-right corner, far-center.
    const positions = [
      { x: -halfX + 0.05, z: minZ + inset + zoneSize / 2 },
      { x:  halfX - 0.05, z: minZ + inset + zoneSize / 2 },
      { x:  0,            z: (minZ + centerZ) / 2 },
    ];

    for (const p of positions) {
      const geom = new THREE.PlaneGeometry(zoneSize, zoneSize);
      const mat = new THREE.MeshBasicMaterial({
        color: ZONE_COLOR,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(p.x, tableSurfaceY + 0.002, p.z);
      scene.add(mesh);

      this.zones.push({
        mesh,
        material: mat,
        bounds: {
          minX: p.x - zoneSize / 2,
          maxX: p.x + zoneSize / 2,
          minZ: p.z - zoneSize / 2,
          maxZ: p.z + zoneSize / 2,
        },
        flashTimer: 0,
      });
    }
  }

  // Activate one zone (others dim). Returns the bounds for aim hints, etc.
  activate(index) {
    this.activeIndex = ((index % this.zones.length) + this.zones.length) % this.zones.length;
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      z.material.opacity = (i === this.activeIndex) ? 0.55 : 0.16;
      z.material.color.setHex(ZONE_COLOR);
    }
  }

  activateAll() {
    this.activeIndex = -1;
    for (const z of this.zones) {
      z.material.opacity = 0.45;
      z.material.color.setHex(ZONE_COLOR);
    }
  }

  // Test bounce point. Returns 'hit', 'miss', or null when no zone is active.
  testBounce(x, z) {
    if (!this.zones.length) return null;

    const candidates = (this.activeIndex >= 0)
      ? [this.zones[this.activeIndex]]
      : this.zones;

    for (const zone of candidates) {
      if (x >= zone.bounds.minX && x <= zone.bounds.maxX &&
          z >= zone.bounds.minZ && z <= zone.bounds.maxZ) {
        zone.material.color.setHex(ZONE_HIT_COLOR);
        zone.material.opacity = 0.85;
        zone.flashTimer = 0.6;
        return 'hit';
      }
    }
    // Miss flash — flash the active zone (or the closest one if all-active mode)
    const flashTarget = (this.activeIndex >= 0)
      ? this.zones[this.activeIndex]
      : this.closestZone(x, z);
    if (flashTarget) {
      flashTarget.material.color.setHex(ZONE_MISS_COLOR);
      flashTarget.material.opacity = 0.7;
      flashTarget.flashTimer = 0.4;
    }
    return 'miss';
  }

  closestZone(x, z) {
    let best = null, bestD = Infinity;
    for (const zone of this.zones) {
      const cx = (zone.bounds.minX + zone.bounds.maxX) / 2;
      const cz = (zone.bounds.minZ + zone.bounds.maxZ) / 2;
      const d = (cx - x) * (cx - x) + (cz - z) * (cz - z);
      if (d < bestD) { bestD = d; best = zone; }
    }
    return best;
  }

  update(dt) {
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      if (z.flashTimer > 0) {
        z.flashTimer -= dt;
        if (z.flashTimer <= 0) {
          z.material.color.setHex(ZONE_COLOR);
          z.material.opacity = (i === this.activeIndex) ? 0.55 : (this.activeIndex < 0 ? 0.45 : 0.16);
        }
      }
    }
  }

  rotateActive() {
    if (this.activeIndex < 0) return;
    this.activate(this.activeIndex + 1);
  }

  dispose() {
    for (const z of this.zones) {
      scene.remove(z.mesh);
      z.mesh.geometry.dispose();
      z.material.dispose();
    }
    this.zones.length = 0;
  }
}
