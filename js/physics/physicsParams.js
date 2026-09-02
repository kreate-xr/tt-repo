// Physics parameter metadata — the single table the PhysicsTuner panel is
// rendered from, restructured into three sections:
//
//   A — LOCKED. Physical constants of the simulation (gravity, drag, the
//       swing-speed ceiling, spin capture). Display-only: these were tunable
//       knobs once, and every one of them turned out to be a trajectory-
//       distorting foot-gun (see the GRAVITY history comment in constants.js).
//       A row here deliberately has no `set` and no `step`.
//   B — EQUIPMENT. What bat and table are you playing on. Restitution medians
//       and table friction, with named presets applied as a complete set.
//   C — FEEL. Presentation-layer knobs: paddle weight, the swing-inertia
//       haptic band, pose smoothing, haptic/visual scaling, spin aesthetics.
//
// Rows are plain descriptors — { id, label, desc, get, set, step, default,
// fmt } — so the panel contains zero physics knowledge and tests can drive
// rows directly through stepRow/resetRow without a canvas in sight.

import * as P from './constants.js';
import * as W from './paddleWeight.js';

const num = (v) => Number(v);

// --- Section A ---------------------------------------------------------------
export const LOCKED_ROWS = [
  {
    id: 'gravity', label: 'Gravity',
    desc: 'Earth-real. Tunable once — broke serve-toss timing, never again.',
    get: () => P.GRAVITY, fmt: (v) => v.toFixed(2) + ' m/s²',
  },
  {
    id: 'drag', label: 'Air Resistance',
    desc: 'Quadratic drag on the ball. Fixed slightly above textbook for read.',
    get: () => P.DRAG_COEFFICIENT, fmt: (v) => v.toFixed(2),
  },
  {
    id: 'contactCap', label: 'Swing Speed Ceiling',
    desc: 'Tanh soft-clip on effective face speed. Matched to a real arm.',
    get: () => P.PADDLE_CONTACT_SPEED_CAP, fmt: (v) => v.toFixed(1) + ' m/s',
  },
  {
    id: 'spinCapture', label: 'Spin Capture',
    desc: 'Brush-to-spin transfer, ~98% of the no-slip physical ceiling.',
    get: () => P.SPIN_CAPTURE_GAIN, fmt: (v) => v.toFixed(0),
  },
];

// --- Section B ---------------------------------------------------------------
// Defaults are the 'ittf' preset — reset on an equipment row answers "what
// does the certified bat/table do", not "what did this build ship with".
export const EQUIPMENT_ROWS = [
  {
    id: 'paddleE0', label: 'Paddle Restitution',
    desc: 'Rubber COR median. Higher = livelier face at every impact speed.',
    get: () => P.PADDLE_E0, set: (v) => P.setPaddleE0(num(v)),
    step: 0.005, default: P.PHYSICS_PRESETS.ittf.paddleE0,
    fmt: (v) => v.toFixed(3),
  },
  {
    id: 'tableEn0', label: 'Table Restitution',
    desc: 'Table COR median. 0.82 = certified table; floors just below it.',
    get: () => P.TABLE_EN_0, set: (v) => P.setTableEn0(num(v)),
    step: 0.005, default: P.PHYSICS_PRESETS.ittf.tableEn0,
    fmt: (v) => v.toFixed(3),
  },
  {
    id: 'tableMu', label: 'Table Friction μ',
    desc: 'Drives the whole spin/linear bounce couple in lockstep.',
    get: () => P.TABLE_MU, set: (v) => P.setTableMu(num(v)),
    step: 0.01, default: P.TABLE_MU_REFERENCE,
    fmt: (v) => v.toFixed(2),
  },
];

export const PRESETS = [
  { id: 'ittf',   label: 'ITTF' },
  { id: 'lively', label: 'Lively' },
  { id: 'dead',   label: 'Dead' },
];

// --- Section C ---------------------------------------------------------------
export const FEEL_ROWS = [
  {
    id: 'paddleWeight', label: 'Paddle Weight',
    desc: 'Heavier = longer haptic thud, deeper contact sound, more recoil.',
    get: () => W.PADDLE_WEIGHT, set: (v) => W.setPaddleWeight(num(v)),
    step: 0.1, default: W.DEFAULT_WEIGHT,
    fmt: (v) => W.paddleWeightGrams(v).toFixed(0) + ' g',
  },
  {
    id: 'inertiaMin', label: 'Inertia Deadzone',
    desc: 'Grip acceleration (m/s²) below which the swing-mass cue is silent.',
    get: () => W.SWING_INERTIA_ACCEL_MIN, set: (v) => W.setSwingInertiaAccelMin(num(v)),
    step: 5, default: W.SWING_INERTIA_DEFAULTS.accelMin,
    fmt: (v) => v.toFixed(0),
  },
  {
    id: 'inertiaMax', label: 'Inertia Band Top',
    desc: 'Acceleration (m/s²) where the swing-mass cue saturates.',
    get: () => W.SWING_INERTIA_ACCEL_MAX, set: (v) => W.setSwingInertiaAccelMax(num(v)),
    step: 10, default: W.SWING_INERTIA_DEFAULTS.accelMax,
    fmt: (v) => v.toFixed(0),
  },
  {
    id: 'inertiaPeak', label: 'Inertia Strength',
    desc: 'Peak amplitude of the swing-mass haptic at neutral weight.',
    get: () => W.SWING_INERTIA_MAX_INTENSITY, set: (v) => W.setSwingInertiaMaxIntensity(num(v)),
    step: 0.02, default: W.SWING_INERTIA_DEFAULTS.maxIntensity,
    fmt: (v) => v.toFixed(2),
  },
  {
    id: 'posSmooth', label: 'Paddle Position Lag',
    desc: 'Visual-only weight lag. Lower = heavier (motion-sickness risk).',
    get: () => P.PADDLE_POS_SMOOTHING, set: (v) => P.setPaddlePosSmoothing(num(v)),
    step: 0.05, default: 0.65, fmt: (v) => v.toFixed(2),
  },
  {
    id: 'rotSmooth', label: 'Paddle Rotation Lag',
    desc: 'Keep near 1.0 — rotation lag triggers nausea fast.',
    get: () => P.PADDLE_ROT_SMOOTHING, set: (v) => P.setPaddleRotSmoothing(num(v)),
    step: 0.05, default: 0.65, fmt: (v) => v.toFixed(2),
  },
  {
    id: 'hapticMax', label: 'Haptic Peak Speed',
    desc: 'Impact speed (m/s) where the contact buzz saturates.',
    get: () => P.HAPTIC_MAX_SPEED, set: (v) => P.setHapticMaxSpeed(num(v)),
    step: 1, default: 8.0, fmt: (v) => v.toFixed(0),
  },
  {
    id: 'squash', label: 'Ball Squish on Hit',
    desc: 'Visual deformation at impact. 0 = off (shipped default).',
    get: () => P.SQUASH_AMOUNT, set: (v) => P.setSquashAmount(num(v)),
    step: 0.02, default: 0.0, fmt: (v) => v.toFixed(2),
  },
  {
    id: 'spinDamping', label: 'Spin Air Damping',
    desc: 'How fast spin dies in flight. Lower = curve compounds longer.',
    get: () => P.SPIN_DAMPING, set: (v) => P.setSpinDamping(num(v)),
    step: 0.02, default: 0.10, fmt: (v) => v.toFixed(2),
  },
  {
    id: 'magnus', label: 'Magnus Curvature',
    desc: 'How much spin bends flight. 0.004 is the physical value.',
    get: () => P.MAGNUS_COEFFICIENT, set: (v) => P.setMagnusCoefficient(num(v)),
    step: 0.001, default: 0.004, fmt: (v) => v.toFixed(3),
  },
  {
    id: 'playerSpinGain', label: 'Player Spin Gain',
    desc: 'Compensates a controller swing reaching ~1/5 real racket speed. 1 = raw physics.',
    get: () => P.PLAYER_SPIN_GAIN, set: (v) => P.setPlayerSpinGain(num(v)),
    step: 0.25, default: 2.5, fmt: (v) => v.toFixed(2),
  },
  {
    id: 'sidespinKick', label: 'Sidespin Bounce Kick',
    desc: 'Lateral top-up at the bounce for pure vertical sidespin.',
    get: () => P.TABLE_SIDESPIN_KICK, set: (v) => P.setTableSidespinKick(num(v)),
    step: 0.0004, default: 0.0008, fmt: (v) => v.toFixed(4),
  },
];

const ALL_TUNABLE = [...EQUIPMENT_ROWS, ...FEEL_ROWS];

export function findRow(id) {
  return ALL_TUNABLE.find((r) => r.id === id) || null;
}

// Step a row by ± one increment. Returns the applied value, or null for a
// row that isn't steppable (locked rows, bad input) — the panel treats null
// as "draw nothing changed" rather than throwing mid-frame in a headset.
export function stepRow(row, dir) {
  if (!row || typeof row.set !== 'function' || !(row.step > 0)) return null;
  row.set(row.get() + (dir >= 0 ? 1 : -1) * row.step);
  return row.get();
}

// Restore a row to its published default. True on success so callers (and
// tests) can distinguish "reset happened" from "this row has no default".
export function resetRow(row) {
  if (!row || typeof row.set !== 'function' || !Number.isFinite(row.default)) return false;
  row.set(row.default);
  return true;
}

// --- Stored-settings migration ----------------------------------------------
// Maps a stored { id: value } blob — possibly written by an older build with
// the flat-KNOBS panel — onto the current rows. Three fates per key:
//   applied   — the row exists (directly or via rename) and took the value.
//   clamped   — the row took the value but its setter moved it into range;
//               reported with requested/applied so a settings screen can say
//               "your old dead-table 0.75 is now 0.90" instead of lying.
//   discarded — the knob no longer exists. gravity/drag/contactCap moved to
//               the locked section, tableSpin is subsumed by tableMu. Their
//               old values are dropped, NOT reinterpreted onto some other row.
const RENAMED = {
  paddleRest: 'paddleE0',   // same quantity, canonical E0 spelling
  tableRest: 'tableEn0',    // same quantity; new range floors at regulation
};

export function migrateStoredPhysics(stored) {
  const report = { applied: [], clamped: [], discarded: [] };
  if (!stored || typeof stored !== 'object') return report;
  for (const key of Object.keys(stored)) {
    const row = findRow(RENAMED[key] || key);
    const requested = Number(stored[key]);
    if (!row || !Number.isFinite(requested)) {
      report.discarded.push(key);
      continue;
    }
    row.set(requested);
    const applied = row.get();
    if (Math.abs(applied - requested) > 1e-9) {
      report.clamped.push({ key, requested, applied });
    }
    report.applied.push({ key, id: row.id, value: applied });
  }
  return report;
}

// --- Persistence -------------------------------------------------------------
// Guarded localStorage helpers — the panel calls these, but they are safe in
// any environment (headless tests, private browsing, quota-full).
export const STORAGE_KEY = 'tt_physics_v2';

export function saveStoredPhysics() {
  if (typeof localStorage === 'undefined') return false;
  const blob = {};
  for (const row of ALL_TUNABLE) blob[row.id] = row.get();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    return true;
  } catch {
    return false;
  }
}

export function loadStoredPhysics() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
