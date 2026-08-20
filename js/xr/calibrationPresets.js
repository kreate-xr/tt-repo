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

// --- Controller → paddle adapters -------------------------------------------
// The physical endgame for weight: a player who screws their controller into a
// bat-shaped mount is holding something with a real moment of inertia, and no
// amount of haptic shaping beats that. What the software owes them is a T_cal
// that is right on the first swing, because an adapter's geometry is FIXED and
// knowable — unlike a bare controller, where "where is the blade" is a fiction
// we invent. Running the full wizard on an adapter is asking the player to
// re-derive a number the manufacturer already published.
//
// So these presets ship as published defaults per adapter geometry, and are
// deliberately conservative: the wizard remains the source of truth and any
// adapter preset is still a *seed* the player can refine. Each carries a
// `weightClass` naming the class in physics/paddleWeight.js that matches the
// assembled mass — the caller applies it (see presetWeightClass below); this
// module stays free of physics imports per spec C6.
//
// Numbers below are measured from the adapter geometry: posOffset is
// controller-grip-origin → blade center along the mount axis, rotOffset is the
// mount's fixed face rotation. Verify against the specific adapter in-headset
// before trusting them; mount tolerances vary more than the spec sheets admit.

// Generic clamp-style shell — controller sits inside a bat-shaped housing, so
// the blade center is only a little past where a bare grip would put it, and
// the assembly is light (controller + plastic shell).
const adapterShellPreset = {
  posOffset: new THREE.Vector3(0, 0.015, -0.155),
  rotOffset: quatFromAxisAngle(AXIS_X, -80),
  weightClass: 'allround',
  isAdapter: true,
};

// Real blade bolted to a controller mount — the controller sits BELOW the
// handle rather than inside it, so the blade center is further out, and the
// assembly is genuinely heavy (controller ~130 g + blade ~85 g).
const adapterBladePreset = {
  posOffset: new THREE.Vector3(0, 0.02, -0.205),
  rotOffset: quatFromAxisAngle(AXIS_X, -88),
  weightClass: 'heavy',
  isAdapter: true,
};

// Penhold-mount variant of the blade adapter — same standoff, face rolled a
// quarter turn like the bare-hand penhold preset.
const adapterPenholdPreset = (() => {
  const q = quatFromAxisAngle(AXIS_X, -88);
  q.premultiply(quatFromAxisAngle(AXIS_Z, 90));
  return {
    posOffset: new THREE.Vector3(0, 0.03, -0.165),
    rotOffset: q,
    weightClass: 'heavy',
    isAdapter: true,
  };
})();

export const PRESETS = {
  default: defaultPreset,
  shakehand: shakehandPreset,
  penhold: penholdPreset,
  adapter_shell: adapterShellPreset,
  adapter_blade: adapterBladePreset,
  adapter_penhold: adapterPenholdPreset,
};

// Preset names that describe a physical adapter rather than a bare controller.
// UI uses this to group them and to explain why they need no wizard run.
export const ADAPTER_PRESETS = Object.keys(PRESETS).filter((n) => PRESETS[n].isAdapter);

// Register a preset whose numbers are DERIVED from loaded asset geometry
// rather than authored here (e.g. 'handle_grip', computed in models.js from
// the bat's HandleEnd anchor once the model is measured). Derived presets are
// bare-controller by construction: no weightClass, not an adapter. Until
// registration runs, setPreset/getPresetCopy on the name fall back to
// 'default' — the standard missing-preset behavior, so a failed model load
// degrades to the shipped alignment instead of throwing.
export function registerDerivedPreset(name, { posOffset, rotOffset }) {
  PRESETS[name] = {
    posOffset: posOffset.clone(),
    rotOffset: rotOffset.clone(),
    isDerived: true,
  };
}

// Weight class this preset's assembled mass corresponds to, or null for bare
// controllers (where the player's weight preference is theirs to pick, not
// ours to infer). Returns a NAME — the caller maps it through
// physics/paddleWeight.js so calibration never imports feel constants.
export function presetWeightClass(name) {
  const p = PRESETS[name];
  return (p && p.weightClass) || null;
}

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
    weightClass: p.weightClass || null,
    isAdapter: !!p.isAdapter,
  };
}
