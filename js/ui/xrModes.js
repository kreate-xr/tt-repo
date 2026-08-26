// XR mode metadata + stored-choice resolution for the start-screen picker.
// DOM-free on purpose so the migration logic is unit-testable (overlay.js
// owns the buttons, this module owns what the buttons mean).

export const XR_MODE_STORAGE_KEY = 'trailclaude.xrMode';

// Modes the CURRENT build can actually enter. The GLB venues ('vr' stadium /
// 'vr-tt') are disabled for beta — see js/ui/overlay.js — so they are
// deliberately absent here.
export const XR_MODES = [
  { id: 'ar',       label: 'Mixed Reality', sub: 'play in your room',   cta: 'Enter Mixed Reality' },
  { id: 'vr-focus', label: 'Focus Room',    sub: 'distraction-free VR', cta: 'Enter Focus Room' },
];

// Map whatever localStorage holds to a mode this build supports. Pre-beta
// builds persisted 'vr' / 'vr-tt' under the same key; those map to GLB
// venues that no longer ship, so they resolve to 'ar'. Callers must NOT
// rewrite the stored value on read — a pre-beta venue choice should come
// back if/when the full picker returns; only an explicit click persists.
export function resolveStoredMode(saved) {
  return XR_MODES.some((m) => m.id === saved) ? saved : 'ar';
}
