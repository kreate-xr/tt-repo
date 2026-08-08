// Visual Mexican-wave animation across the 24 audience sections in the
// stadium GLB (Seats_Audi_1 .. Seats_Audi_24). Complements crowdAudio.js
// — the audio module fires cheers on individual sides for point events,
// this module drives a coordinated visual pulse that sweeps around the
// entire ring for larger moments (match start, game end, match end).
//
// Approach — color pulse, no geometry motion:
//   The seat nodes are static decorative meshes. Translating or scaling
//   them would look uncanny (the audience "floats"). Instead we pulse
//   each section's material color / emissive toward a bright accent tint,
//   in sequence around the ring, so the arena appears to light up in a
//   wave pattern. Reads as "everyone stood up and raised their arms"
//   without any of the fragility of animating pretend-people geometry.
//
// Section ordering:
//   We sort sections by angle around the table center (atan2) so the wave
//   sweeps continuously around the arena instead of skipping between
//   named indices, which may not be arranged in azimuthal order in the
//   GLB. First wave step starts at whichever section is closest to the
//   +X axis; subsequent steps progress counter-clockwise.
//
// Materials: some seat sections in the GLB share a single material across
// meshes; snapshotting per unique material (not per mesh) means one write
// affects every mesh sharing the material — usually what you want for
// "the whole section flashes together."

import * as THREE from 'three';

// Per-section pulse timings. A section's pulse ramps up over PULSE_UP,
// holds at peak for PULSE_HOLD, then ramps back down over PULSE_DOWN.
// Total per-section: 400ms. Sections are staggered by STAGGER so the
// leading edge of one pulse begins while the previous is still active,
// producing a continuous wave rather than a discrete blink sequence.
const PULSE_UP = 0.10;
const PULSE_HOLD = 0.08;
const PULSE_DOWN = 0.22;
const PULSE_TOTAL = PULSE_UP + PULSE_HOLD + PULSE_DOWN;
const STAGGER = 0.09;

// Wave accent color — bright warm gold reads as "cheer flash" against
// the typical dark navy / grey seat tones. Interpolated toward from the
// snapshot color per-section per-frame.
const WAVE_COLOR = new THREE.Color(0xffd24a);
const WAVE_STRENGTH = 0.85; // peak lerp factor toward WAVE_COLOR

export function createCrowdWave({ sections = [], tableCenter = null } = {}) {
  if (!sections || sections.length === 0) return null;

  // Sort sections by angle around the table center so the wave sweeps
  // continuously. If no tableCenter provided, fall back to the mean
  // position of all sections.
  const center = tableCenter || sections.reduce((acc, s) => acc.add(s.position), new THREE.Vector3())
    .multiplyScalar(1 / sections.length);
  const orderedSections = [...sections].sort((a, b) => {
    const aa = Math.atan2(a.position.z - center.z, a.position.x - center.x);
    const bb = Math.atan2(b.position.z - center.z, b.position.x - center.x);
    return aa - bb;
  });

  // Collect meshes per section + snapshot materials. snapshots is keyed
  // by material so shared materials get one snapshot; sectionEntries
  // maps each section to the SET of materials it touches (a section may
  // legally contain multiple materials — e.g. seats + railing tint).
  const snapshots = new Map(); // material -> { color, emissive?, emissiveIntensity? }
  const sectionEntries = orderedSections.map((s) => {
    const mats = new Set();
    if (s.node) {
      s.node.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of list) {
          mats.add(mat);
          if (!snapshots.has(mat)) {
            const snap = { color: mat.color ? mat.color.clone() : null };
            if (mat.emissive) {
              snap.emissive = mat.emissive.clone();
              snap.emissiveIntensity = typeof mat.emissiveIntensity === 'number'
                ? mat.emissiveIntensity : 1;
            }
            snapshots.set(mat, snap);
          }
        }
      });
    }
    return { section: s, materials: mats };
  });

  // Active waves. Each entry: { t, duration, delaysBySection: Array<number> }
  // where delaysBySection[i] is when section i's pulse begins.
  const activeWaves = [];

  function applyPulse(mat, k) {
    const snap = snapshots.get(mat);
    if (!snap) return;
    if (snap.color && mat.color) {
      mat.color.copy(snap.color).lerp(WAVE_COLOR, k);
    }
    if (snap.emissive && mat.emissive) {
      mat.emissive.copy(snap.emissive).lerp(WAVE_COLOR, k);
    }
    if (snap.emissiveIntensity != null && 'emissiveIntensity' in mat) {
      mat.emissiveIntensity = snap.emissiveIntensity * (1 + k * 1.5);
    }
  }

  function restoreMaterial(mat) {
    const snap = snapshots.get(mat);
    if (!snap) return;
    if (snap.color && mat.color) mat.color.copy(snap.color);
    if (snap.emissive && mat.emissive) mat.emissive.copy(snap.emissive);
    if (snap.emissiveIntensity != null && 'emissiveIntensity' in mat) {
      mat.emissiveIntensity = snap.emissiveIntensity;
    }
  }

  function restoreAll() {
    for (const m of snapshots.keys()) restoreMaterial(m);
  }

  /**
   * Trigger a wave that sweeps the entire arena once. `laps` allows
   * multiple sweeps for extra-big moments (match end passes 2 or 3).
   * `direction` = 'cw' | 'ccw' — flips the stagger order.
   */
  function startWave({ laps = 1, direction = 'ccw' } = {}) {
    const n = sectionEntries.length;
    const perLap = STAGGER * n;
    const duration = perLap * laps + PULSE_TOTAL;
    const delaysBySection = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = direction === 'ccw' ? i : (n - 1 - i);
      delaysBySection[i] = idx * STAGGER;
    }
    activeWaves.push({ t: 0, duration, delaysBySection, laps, perLap });
  }

  function pulseValueForSection(waveT, delay, laps, perLap) {
    // Sum contributions across all laps — if `laps > 1` a section's pulse
    // recurs at delay + k * perLap for k in [0, laps). Take the max
    // instead of sum so peak brightness stays sane on overlapping laps.
    let best = 0;
    for (let k = 0; k < laps; k++) {
      const startT = delay + k * perLap;
      const local = waveT - startT;
      if (local < 0 || local > PULSE_TOTAL) continue;
      let k01;
      if (local < PULSE_UP) {
        k01 = local / PULSE_UP;
      } else if (local < PULSE_UP + PULSE_HOLD) {
        k01 = 1;
      } else {
        k01 = 1 - (local - PULSE_UP - PULSE_HOLD) / PULSE_DOWN;
      }
      if (k01 > best) best = k01;
    }
    return best * WAVE_STRENGTH;
  }

  function update(dt) {
    if (activeWaves.length === 0) return;
    // Reset every tracked material to the snapshot first, then re-apply
    // the max pulse contribution from any active wave. This avoids
    // stacking contributions from overlapping waves (which would blow
    // out to solid WAVE_COLOR quickly) and correctly returns sections
    // to their base tint as each wave passes them.
    restoreAll();
    for (let i = activeWaves.length - 1; i >= 0; i--) {
      const w = activeWaves[i];
      w.t += dt;
      if (w.t >= w.duration) {
        activeWaves.splice(i, 1);
        continue;
      }
      for (let s = 0; s < sectionEntries.length; s++) {
        const k = pulseValueForSection(w.t, w.delaysBySection[s], w.laps, w.perLap);
        if (k <= 0) continue;
        for (const mat of sectionEntries[s].materials) applyPulse(mat, k);
      }
    }
  }

  function dispose() {
    activeWaves.length = 0;
    restoreAll();
    snapshots.clear();
  }

  return {
    startWave,
    update,
    dispose,
    sectionCount: orderedSections.length,
  };
}
