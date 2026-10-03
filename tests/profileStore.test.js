// Slice 3 — training profile store (P15 §M10 + persistence rule).
//
// Covers the two behaviours this store adds over calibration.js's persistence:
// forward migration instead of silent discard, and quota failures the caller
// can actually see.

// Shim localStorage in the Node test environment, matching the convention in
// tests/calibrationPersistence.test.js. Must be installed BEFORE the import.
class MemoryStorage {
  constructor() { this._store = new Map(); this.failNextWrite = null; }
  getItem(k)    { return this._store.has(k) ? this._store.get(k) : null; }
  setItem(k, v) {
    if (this.failNextWrite) {
      const err = new Error('quota');
      err.name = this.failNextWrite;
      this.failNextWrite = null;
      throw err;
    }
    this._store.set(k, String(v));
  }
  removeItem(k) { this._store.delete(k); }
  clear()       { this._store.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const store = require('../js/profile/store.js');
const {
  SCHEMA_VERSION, SETTING_SPECS,
  migrate, coerceSetting,
  load, resetProfile, snapshot, subscribe, lastWriteError,
  getSettings, getSetting, setSetting, recordDetectedHand,
} = store;

const STORAGE_KEY = 'p15.profile';

beforeEach(() => {
  globalThis.localStorage.clear();
  globalThis.localStorage.failNextWrite = null;
  resetProfile();
});

describe('defaults', () => {
  test('a fresh profile matches every SETTING_SPECS default', () => {
    const s = getSettings();
    for (const [key, spec] of Object.entries(SETTING_SPECS)) {
      expect(s[key]).toBe(spec.default);
    }
  });

  test('D1: no assist-level setting exists', () => {
    // The migration plan drops M10's assist level until a P11 spec exists.
    // A setting that changes nothing is worse than no setting, so assert its
    // absence rather than leaving it to reappear by accident.
    expect(SETTING_SPECS.assistLevel).toBeUndefined();
    expect(getSettings().assistLevel).toBeUndefined();
  });
});

describe('setting clamps', () => {
  test('numeric settings clamp to their spec range', () => {
    expect(setSetting('ballSpeedMultiplier', 99)).toBe(1.2);
    expect(setSetting('ballSpeedMultiplier', -5)).toBe(0.6);
    expect(setSetting('ballSpeedMultiplier', 0.9)).toBe(0.9);

    expect(setSetting('tableHeightOffset', 10)).toBe(0.15);
    expect(setSetting('tableHeightOffset', -10)).toBe(-0.15);
  });

  test('non-finite numbers fall back to the default, not NaN', () => {
    expect(setSetting('ballSpeedMultiplier', NaN)).toBe(1.0);
    expect(setSetting('ballSpeedMultiplier', 'banana')).toBe(1.0);
    expect(setSetting('tableHeightOffset', Infinity)).toBe(0);
  });

  test('enum settings reject unknown values', () => {
    expect(setSetting('hudDensity', 'standard')).toBe('standard');
    expect(setSetting('hudDensity', 'enormous')).toBe('minimal');
    expect(setSetting('dominantHand', 'L')).toBe('L');
    expect(setSetting('units', 'imperial')).toBe('imperial');
  });

  test('boolean settings reject non-booleans', () => {
    expect(setSetting('audioCues', false)).toBe(false);
    expect(setSetting('audioCues', 'yes')).toBe(true); // back to default
  });

  test('unknown keys are ignored', () => {
    expect(setSetting('notARealSetting', 5)).toBeUndefined();
    expect(getSettings().notARealSetting).toBeUndefined();
  });

  test('coerceSetting is pure and does not touch stored state', () => {
    setSetting('ballSpeedMultiplier', 1.1);
    expect(coerceSetting('ballSpeedMultiplier', 99)).toBe(1.2);
    expect(getSetting('ballSpeedMultiplier')).toBe(1.1);
  });
});

describe('persistence roundtrip', () => {
  test('settings survive a reload', () => {
    setSetting('ballSpeedMultiplier', 0.8);
    setSetting('units', 'imperial');
    load(); // re-read from storage
    expect(getSetting('ballSpeedMultiplier')).toBe(0.8);
    expect(getSetting('units')).toBe('imperial');
  });

  test('corrupt JSON in storage falls back to defaults without throwing', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, '{not json at all');
    expect(() => load()).not.toThrow();
    expect(getSetting('ballSpeedMultiplier')).toBe(1.0);
  });

  test('out-of-range persisted values are clamped on load, not trusted', () => {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: SCHEMA_VERSION,
      settings: { ballSpeedMultiplier: 50, hudDensity: 'bogus' },
      presets: [],
    }));
    load();
    expect(getSetting('ballSpeedMultiplier')).toBe(1.2);
    expect(getSetting('hudDensity')).toBe('minimal');
  });

  test('presets saved by an older build survive a load and a write', () => {
    // The Ball Machine editor that made them is gone, but a write from this
    // build must not destroy data a player made.
    const saved = [{ name: 'old', config: { speed: 5 } }];
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: SCHEMA_VERSION, settings: {}, presets: saved,
    }));
    load();
    setSetting('units', 'imperial');
    expect(JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY)).presets).toEqual(saved);
  });
});

describe('migration', () => {
  test('an unversioned payload migrates forward and keeps its presets', () => {
    const result = migrate({ settings: {}, presets: [{ name: 'old', config: { speed: 3 } }] });
    expect(result.ok).toBe(true);
    expect(result.profile.version).toBe(SCHEMA_VERSION);
    expect(result.profile.presets).toHaveLength(1);
  });

  test('a future-version payload is refused rather than downgraded', () => {
    // Stripping fields we don't understand would destroy data belonging to a
    // build the player may still be using.
    const result = migrate({ version: SCHEMA_VERSION + 5, settings: {}, presets: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('future-version');
  });

  test('a future-version blob is left intact in storage', () => {
    const futureBlob = JSON.stringify({
      version: SCHEMA_VERSION + 5,
      settings: { ballSpeedMultiplier: 1.1 },
      presets: [{ name: 'from-the-future', config: { speed: 9 } }],
      unknownFutureField: 42,
    });
    globalThis.localStorage.setItem(STORAGE_KEY, futureBlob);
    load();
    // Runs on defaults for the session...
    expect(getSetting('ballSpeedMultiplier')).toBe(1.0);
    // ...but the player's data is still on disk, untouched.
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBe(futureBlob);
    expect(lastWriteError()).toMatch(/newer version/);
  });

  test('malformed input is reported, not thrown', () => {
    expect(migrate(null).ok).toBe(false);
    expect(migrate('a string').ok).toBe(false);
    expect(migrate(42).ok).toBe(false);
  });
});

describe('quota failure is visible', () => {
  test('a quota error surfaces through lastWriteError', () => {
    globalThis.localStorage.failNextWrite = 'QuotaExceededError';
    setSetting('units', 'imperial');
    expect(lastWriteError()).toMatch(/storage full/);
  });

  test('a generic storage denial reports differently from a quota error', () => {
    globalThis.localStorage.failNextWrite = 'SecurityError';
    setSetting('units', 'imperial');
    expect(lastWriteError()).toMatch(/unavailable/);
  });

  test('a failed write does not crash the session and state stays usable', () => {
    globalThis.localStorage.failNextWrite = 'QuotaExceededError';
    expect(() => setSetting('ballSpeedMultiplier', 0.7)).not.toThrow();
    expect(getSetting('ballSpeedMultiplier')).toBe(0.7); // in-memory still correct
  });

  test('a later successful write clears the error', () => {
    globalThis.localStorage.failNextWrite = 'QuotaExceededError';
    setSetting('units', 'imperial');
    expect(lastWriteError()).toBeTruthy();
    setSetting('units', 'metric');
    expect(lastWriteError()).toBeNull();
  });
});

describe('dominant hand detection (M10)', () => {
  test('first detection records the hand', () => {
    expect(recordDetectedHand('L')).toBe('L');
    expect(getSetting('dominantHand')).toBe('L');
  });

  test('detection only fires once — a second swing cannot flip it', () => {
    recordDetectedHand('L');
    recordDetectedHand('R');
    expect(getSetting('dominantHand')).toBe('L');
  });

  test('an explicit choice survives later detection attempts', () => {
    setSetting('dominantHand', 'L');
    // An explicit choice must not be treated as "never observed".
    recordDetectedHand('R');
    expect(getSetting('dominantHand')).toBe('L');
  });

  test('an invalid hand is ignored', () => {
    expect(recordDetectedHand('sideways')).toBe('R');
    expect(snapshot().handDetected).toBe(false);
  });
});

describe('subscribe', () => {
  test('fires on setting changes, and stops after unsubscribing', () => {
    let calls = 0;
    const unsub = subscribe(() => { calls++; });
    setSetting('units', 'imperial');
    setSetting('dominantHand', 'L');
    expect(calls).toBe(2);
    unsub();
    setSetting('units', 'metric');
    expect(calls).toBe(2);
  });

  test('does not fire when a set is a no-op', () => {
    setSetting('units', 'imperial');
    let calls = 0;
    subscribe(() => { calls++; });
    setSetting('units', 'imperial');
    expect(calls).toBe(0);
  });

  test('a throwing subscriber cannot block the others', () => {
    let reached = false;
    subscribe(() => { throw new Error('bad subscriber'); });
    subscribe(() => { reached = true; });
    expect(() => setSetting('units', 'imperial')).not.toThrow();
    expect(reached).toBe(true);
  });
});
