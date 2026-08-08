// Paddle calibration presets. Numeric values sourced from P13 spec C1.
//
// IMPORTANT (spec C1 AGENT NOTE): grip-space axis conventions differ across
// controllers/runtimes. These presets are seeds — the wizard (C3) is the source
// of truth. Also, our paddle GLB has a baked model-to-controller Euler in
// models.js:33-35, so the "shakehand" preset here reproduces the spec's raw-
// grip-frame intent but MAY need empirical adjustment against a real headset
// before shipping. Tracked as Gotcha (b) in the plan file.
//
// The 'default' preset captures the pre-calibration hardcoded values that
// shipped in xrPaddle.js — it's what identity behavior looks like today, and
// is what a first-launch player sees before touching the wizard. This keeps
// on-first-launch feel byte-identical to the pre-P13 build.

import * as THREE from 'three';

function quatFromAxisAngle(axis, degrees) {
  return new THREE.Quaternion().setFromAxisAngle(
    axis.clone().normalize(),
    (degrees * Math.PI) / 180,
  );
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// Pre-P13 baseline: the (0, 0.005, -0.02) cosmetic offset that used to live in
// xrPaddle.js:53/136, no rotation change. Anyone on today's build who never
// runs the wizard gets this — nothing changes for them.
const defaultPreset = {
  posOffset: new THREE.Vector3(0, 0.005, -0.02),
  rotOffset: new THREE.Quaternion(),
};

// Spec C1 shakehand: blade center 14 cm beyond grip along handle direction;
// face ~perpendicular to handle.
const shakehandPreset = {
  posOffset: new THREE.Vector3(0, 0.02, -0.14),
  rotOffset: quatFromAxisAngle(AXIS_X, -80),
};

// Spec C1 penhold: blade closer to hand, face rolled a quarter turn.
// Compose: first -80° about X, then +90° about Z (spec order).
const penholdPreset = (() => {
  const q = quatFromAxisAngle(AXIS_X, -80);
  q.premultiply(quatFromAxisAngle(AXIS_Z, 90));
  return { posOffset: new THREE.Vector3(0, 0.03, -0.10), rotOffset: q };
})();

export const PRESETS = {
  default: defaultPreset,
  shakehand: shakehandPreset,
  penhold: penholdPreset,
};

// Best-effort preset choice for a given XRInputSource profile string
// (event.data.profiles[0], most-specific first). We currently only expose
// 'shakehand' as an auto-match target because it's the near-universal grip
// for beginners; the wizard is where a player picks penhold explicitly.
// Returns a preset NAME (string key of PRESETS), not the object.
export function matchProfile(profileString) {
  if (!profileString || typeof profileString !== 'string') return 'default';
  const s = profileString.toLowerCase();
  // Known-good controllers where the spec's shakehand seeds are close enough
  // to try as an initial guess. Empirically tune in-headset per Gotcha (b).
  // Left commented until the shakehand preset numbers are validated against
  // a real Quest — we don't want to auto-shift the paddle for existing users
  // on first launch just because a controller string matched.
  //
  // if (s.includes('touch')) return 'shakehand';
  // if (s.includes('pico'))  return 'shakehand';
  // if (s.includes('index')) return 'shakehand';
  return 'default';
}

// Snapshot copy so callers can freely mutate without touching the preset table.
export function getPresetCopy(name) {
  const p = PRESETS[name] || PRESETS.default;
  return {
    posOffset: p.posOffset.clone(),
    rotOffset: p.rotOffset.clone(),
  };
}
