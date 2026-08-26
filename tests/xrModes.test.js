// Start-screen XR mode metadata + stored-choice migration.
//
// The interesting behavior is resolveStoredMode's migration rule: pre-beta
// builds persisted 'vr' / 'vr-tt' (GLB venues that no longer ship) under
// the SAME localStorage key — those must resolve to 'ar', while the two
// live modes pass through untouched.

const { XR_MODES, resolveStoredMode } = require('../js/ui/xrModes.js');

test('the live modes pass through unchanged', () => {
  expect(resolveStoredMode('ar')).toBe('ar');
  expect(resolveStoredMode('vr-focus')).toBe('vr-focus');
});

test('legacy GLB-venue values fall back to ar', () => {
  expect(resolveStoredMode('vr')).toBe('ar');
  expect(resolveStoredMode('vr-tt')).toBe('ar');
});

test('missing or garbage storage falls back to ar', () => {
  expect(resolveStoredMode(null)).toBe('ar');
  expect(resolveStoredMode(undefined)).toBe('ar');
  expect(resolveStoredMode('')).toBe('ar');
  expect(resolveStoredMode('nonsense')).toBe('ar');
});

test('every mode carries the fields overlay.js renders from', () => {
  expect(XR_MODES.length).toBeGreaterThanOrEqual(2);
  for (const m of XR_MODES) {
    expect(typeof m.id).toBe('string');
    expect(typeof m.label).toBe('string');
    expect(typeof m.sub).toBe('string');
    expect(typeof m.cta).toBe('string');
  }
  // 'ar' must exist — it is the universal fallback.
  expect(XR_MODES.some((m) => m.id === 'ar')).toBe(true);
});
