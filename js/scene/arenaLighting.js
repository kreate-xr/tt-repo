// Reactive lighting on the stadium's built-in ceiling fixture meshes
// (CeilingRing, CenterLightBox, LightBox, Light_Box_Big, CeilingGrill*).
//
// Design decision — NO real THREE.SpotLights above the table.
// See arena.js file header: adding per-fixture SpotLights (a) tanked frame
// rate on Quest because per-mesh lighting scales with light count × ~70
// venue meshes, and (b) made the ball read as strobe-lit because
// KHR_materials_specular is boosted 2× on Ball.glb and a fast-moving ball
// punched a specular hotspot through each spotlight cone in turn. Instead
// we ONLY animate the emissive/color of the fixture meshes themselves —
// no per-frame shading cost on gameplay meshes, and the visual read
// ("that ring is pulsing bright!") is exactly the same to the player.
//
// The fixtures ship with KHR_materials_unlit (per the arena.js comment) so
// they draw their material color directly regardless of scene lighting.
// That means animating `.color` on the material gives us a pulse-in-the-fixture
// look for free — we don't need to touch `.emissive` (unlit ignores it).
// For MeshStandardMaterial fixtures (defensive fallback) we animate both.
//
// Trigger surface:
//   pulseMatchPoint() — 4 quick red pulses on the CeilingRing over ~2s.
//                       Signals "this next point could win the match."
//   pulsePoint(winnerSide) — one ~0.9s swell in the winner's color on the
//                       CenterLightBox after an ordinary point.
//   celebrateMatch(winnerSide) — 3s color-cycle on all fixtures. Winner's
//                       color hue rotates through the ring.
//   pulseServe() — subtle single dim + brighten on the CenterLightBox
//                       between rallies. Optional ambient touch.
//
// All animations are advanced by update(dt) — call from the drill's own
// update loop. Cheap: a handful of color assignments per frame while an
// animation is active, no-op otherwise.

import * as THREE from 'three';

// Names we treat as ceiling fixtures. Order matters only for the
// celebration cycle — we sweep the color through in list order for a
// "wave" effect around the ring.
const FIXTURE_NAMES = [
  'CeilingRing',
  'CenterLightBox',
  'Light_Box_Big',
  'LightBox',
  'CeilingGrill002',
  'CeilingGrill006',
  'CeilingGrill010',
  'CeilingGrill015',
];

// Match-point pulse tuning. 4 pulses × 0.5s = 2s total.
const PULSE_COUNT = 4;
const PULSE_PERIOD = 0.5;
// Warm-red pulse tint. Blends between original and this at pulse peak.
const PULSE_COLOR = new THREE.Color(0xff2a2a);
// Per-point swell. Short and gentle — it fires after EVERY point, so
// anything longer or stronger turns the venue into a strobe over a rally.
const POINT_PULSE_DURATION = 0.9;
const POINT_PULSE_STRENGTH = 0.55;
// Celebration cycle: golden → magenta → cyan → gold. 3s total.
const CELEBRATE_DURATION = 3.0;
const CELEBRATE_COLORS = [
  new THREE.Color(0xffd24a), // warm gold
  new THREE.Color(0xff5aa8), // magenta
  new THREE.Color(0x4ac8ff), // cyan
  new THREE.Color(0xffd24a), // back to gold
];

export function createArenaLighting({ fixtures = [] } = {}) {
  if (!fixtures || fixtures.length === 0) return null;

  // Build per-material snapshots so we can restore + interpolate. Some
  // fixtures share materials (KHR_materials_unlit references); we snapshot
  // by material identity, not per mesh, so mutating once affects all
  // sharing meshes — usually the desired behavior for "the whole ring
  // glows red." A Map keeps snapshots unique.
  const snapshots = new Map(); // material -> { color: Color, emissive?: Color, emissiveIntensity?: number }
  const materialsByName = new Map(); // fixture-name -> Set<material>

  for (const entry of fixtures) {
    if (!entry || !entry.mesh) continue;
    const mesh = entry.mesh;
    const name = entry.name || mesh.name || '(unnamed)';
    const mat = mesh.material;
    if (!mat) continue;
    if (!snapshots.has(mat)) {
      const snap = { color: mat.color ? mat.color.clone() : null };
      if (mat.emissive) {
        snap.emissive = mat.emissive.clone();
        snap.emissiveIntensity = typeof mat.emissiveIntensity === 'number' ? mat.emissiveIntensity : 1;
      }
      snapshots.set(mat, snap);
    }
    if (!materialsByName.has(name)) materialsByName.set(name, new Set());
    materialsByName.get(name).add(mat);
  }

  // Anim state: array of active animations. Each is { name, t, duration, apply(mat, k) }
  // where k is normalized 0..1 progress. apply() writes to material each frame;
  // reset happens automatically when the animation finishes (we call apply(mat, 1)
  // one last time via a specific "restore" mode).
  const active = [];

  function materialsForNames(names) {
    const out = [];
    for (const name of names) {
      const set = materialsByName.get(name);
      if (!set) continue;
      for (const m of set) out.push(m);
    }
    return out;
  }

  function restoreMaterials(mats) {
    for (const m of mats) {
      const snap = snapshots.get(m);
      if (!snap) continue;
      if (snap.color && m.color) m.color.copy(snap.color);
      if (snap.emissive && m.emissive) m.emissive.copy(snap.emissive);
      if (snap.emissiveIntensity != null && 'emissiveIntensity' in m) {
        m.emissiveIntensity = snap.emissiveIntensity;
      }
    }
  }

  function setBlendedColor(mat, target, k) {
    // Interpolate from the SNAPSHOT (not current) so overlapping animations
    // don't drift. Emissive interpolates the same way when present.
    const snap = snapshots.get(mat);
    if (!snap) return;
    if (snap.color && mat.color) {
      mat.color.copy(snap.color).lerp(target, k);
    }
    if (snap.emissive && mat.emissive) {
      mat.emissive.copy(snap.emissive).lerp(target, Math.min(1, k * 1.5));
    }
    if (snap.emissiveIntensity != null && 'emissiveIntensity' in mat) {
      // Boost emissive intensity proportional to pulse strength.
      mat.emissiveIntensity = snap.emissiveIntensity * (1 + k * 2);
    }
  }

  function pulseMatchPoint() {
    // Only pulse the ring — that's the "warning" fixture. Everything else
    // stays quiet so the ring reads as a distinct urgent cue.
    const mats = materialsForNames(['CeilingRing']);
    if (mats.length === 0) return;
    const duration = PULSE_COUNT * PULSE_PERIOD;
    active.push({
      name: 'matchPointPulse',
      t: 0,
      duration,
      apply(t) {
        // Sinusoidal pulse over each PULSE_PERIOD, gated to positive half.
        const phase = (t % PULSE_PERIOD) / PULSE_PERIOD;
        const k = Math.max(0, Math.sin(phase * Math.PI));
        for (const m of mats) setBlendedColor(m, PULSE_COLOR, k * 0.9);
      },
      onEnd() { restoreMaterials(mats); },
    });
  }

  // Single soft swell in the winner's color after an ordinary point.
  // Peripheral mood only — the scoreboard is what actually tells the player
  // who won; this just keeps the venue reacting. Uses the
  // CenterLightBox rather than the ring so it can never be confused with
  // pulseMatchPoint()'s urgent red ring flashing.
  function pulsePoint(winnerSide = 'player') {
    const mats = materialsForNames(['CenterLightBox']);
    if (mats.length === 0) return;
    const tint = winnerSide === 'ai'
      ? new THREE.Color(0xff9c6b)
      : new THREE.Color(0x8ea6ff);
    active.push({
      name: 'pointPulse',
      t: 0,
      duration: POINT_PULSE_DURATION,
      apply(t) {
        // Half a sine over the whole duration: swell in, swell out, once.
        const k = Math.sin((t / POINT_PULSE_DURATION) * Math.PI);
        for (const m of mats) setBlendedColor(m, tint, k * POINT_PULSE_STRENGTH);
      },
      onEnd() { restoreMaterials(mats); },
    });
  }

  function celebrateMatch(winnerSide = 'player') {
    // Winner tint biases the color cycle. player = cool blue-shifted,
    // ai = warm orange-shifted. Otherwise the cycle uses CELEBRATE_COLORS.
    const winnerTint = winnerSide === 'player'
      ? new THREE.Color(0x8ea6ff)
      : new THREE.Color(0xff9c6b);
    const mats = materialsForNames(FIXTURE_NAMES);
    if (mats.length === 0) return;
    active.push({
      name: 'celebrate',
      t: 0,
      duration: CELEBRATE_DURATION,
      apply(t) {
        const progress = t / CELEBRATE_DURATION;
        // Cycle through CELEBRATE_COLORS, then blend a fraction of the
        // winnerTint on top for team-color feel.
        const segF = progress * (CELEBRATE_COLORS.length - 1);
        const segI = Math.min(CELEBRATE_COLORS.length - 2, Math.floor(segF));
        const segK = segF - segI;
        const cyclePart = new THREE.Color().copy(CELEBRATE_COLORS[segI]).lerp(CELEBRATE_COLORS[segI + 1], segK);
        const tinted = cyclePart.clone().lerp(winnerTint, 0.35);
        // Blend strength ramps up-and-down: full during middle 60%, fades
        // in/out at the edges so the transition into/out of celebration
        // isn't jarring.
        let strength;
        if (progress < 0.2) strength = progress / 0.2;
        else if (progress > 0.8) strength = (1 - progress) / 0.2;
        else strength = 1;
        for (const m of mats) setBlendedColor(m, tinted, strength);
      },
      onEnd() { restoreMaterials(mats); },
    });
  }

  function update(dt) {
    if (active.length === 0) return;
    for (let i = active.length - 1; i >= 0; i--) {
      const a = active[i];
      a.t += dt;
      if (a.t >= a.duration) {
        a.apply(a.duration);
        if (a.onEnd) a.onEnd();
        active.splice(i, 1);
      } else {
        a.apply(a.t);
      }
    }
  }

  function dispose() {
    // Run any lingering end callbacks so materials revert. Then clear the
    // snapshot map; the materials themselves are owned by the arena GLB
    // and shared across sessions — we never dispose them.
    for (const a of active) { if (a.onEnd) a.onEnd(); }
    active.length = 0;
    // Belt-and-braces: restore every tracked material once more.
    for (const [m, snap] of snapshots.entries()) {
      if (snap.color && m.color) m.color.copy(snap.color);
      if (snap.emissive && m.emissive) m.emissive.copy(snap.emissive);
      if (snap.emissiveIntensity != null && 'emissiveIntensity' in m) {
        m.emissiveIntensity = snap.emissiveIntensity;
      }
    }
    snapshots.clear();
    materialsByName.clear();
  }

  return {
    pulseMatchPoint,
    pulsePoint,
    celebrateMatch,
    update,
    dispose,
    fixtureCount: fixtures.length,
  };
}
