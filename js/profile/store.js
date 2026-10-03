// Training profile store (P15 §M10 + the spec's persistence rule: "all
// settings + progress in one profile JSON, per C5 storage rules").
//
// Modelled on js/xr/calibration.js — same persist / subscribe / silent-failure
// shape — but with two things calibration.js does not need:
//
//   1. MIGRATION. calibration.js drops persisted state on a version mismatch
//      (`if (parsed.version !== STORAGE_VERSION) return null`). That is fine
//      for a transform the wizard can re-fit in 20 seconds; it is not fine for
//      a player's settings and progress. Unknown-version payloads
//      are migrated forward where possible and otherwise preserved untouched,
//      never silently discarded.
//   2. QUOTA HANDLING that the caller can see. A dropped calibration write is
//      invisible and recoverable; a dropped progress save looks to the player
//      like the app lost their work, so the failure is recorded and readable
//      via lastWriteError() for the UI to surface.
//
// Deliberately NOT stored here: the M7 event log. It is append-only and grows
// without bound, so it needs its own sink with its own trimming policy —
// rewriting the whole profile blob on every feed would be quadratic.
//
// D1 (migration plan): M10's `assist level` setting is absent on purpose.
// No P11 assist system exists; a setting that changes nothing is worse than
// no setting.

const STORAGE_KEY = 'p15.profile';
export const SCHEMA_VERSION = 1;

// M10 global training settings. Each entry carries its own clamp so a hand
// edited localStorage blob, an out-of-date deep link, or a future schema
// change cannot inject a value the engine can't honour.
export const SETTING_SPECS = Object.freeze({
  ballSpeedMultiplier: { type: 'number', min: 0.6, max: 1.2, default: 1.0 },
  tableHeightOffset:   { type: 'number', min: -0.15, max: 0.15, default: 0 },
  dominantHand:        { type: 'enum', values: ['L', 'R'], default: 'R' },
  hudDensity:          { type: 'enum', values: ['minimal', 'standard'], default: 'minimal' },
  units:               { type: 'enum', values: ['metric', 'imperial'], default: 'metric' },
  audioCues:           { type: 'boolean', default: true },
  // Training Session best scores (0–100, 0 = never played), one per level.
  // Progress rather than preference, but it rides the settings blob: two
  // numbers do not earn their own persistence path, and coerceSettings
  // defaulting them makes old profiles correct with no migration.
  sessionBestBeginner: { type: 'number', min: 0, max: 100, default: 0 },
  sessionBestPlayer:   { type: 'number', min: 0, max: 100, default: 0 },
  // Passthrough backdrop (js/scene/mrBackdrop.js): a screen behind the far
  // end of the table that hides the player's room. Off by default — "play
  // in your room" is what Mixed Reality promises on the start screen, and
  // the screen is for the player whose room they would rather not look at.
  // Toggled from the wrist menu in MR sessions only; ignored in the Focus
  // Room, which has its own back wall.
  mrBackdrop:          { type: 'boolean', default: false },
});

function defaultSettings() {
  const out = {};
  for (const [key, spec] of Object.entries(SETTING_SPECS)) out[key] = spec.default;
  return out;
}

function emptyProfile() {
  return {
    version: SCHEMA_VERSION,
    settings: defaultSettings(),
    presets: [],
    // dominantHand starts unset so "from first swing detection" (M10) can
    // distinguish "never observed" from "player chose R". SETTING_SPECS still
    // supplies 'R' as the value used until detection or an explicit choice.
    handDetected: false,
  };
}

let _profile = emptyProfile();
let _loaded = false;
let _lastWriteError = null;
const _subscribers = new Set();

// --- Validation -------------------------------------------------------------

// Coerce one setting to a legal value, or return the default when the input is
// unusable. Never throws: this runs against untrusted persisted JSON.
export function coerceSetting(key, value) {
  const spec = SETTING_SPECS[key];
  if (!spec) return undefined;
  switch (spec.type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return spec.default;
      return Math.min(spec.max, Math.max(spec.min, n));
    }
    case 'enum':
      return spec.values.includes(value) ? value : spec.default;
    case 'boolean':
      return typeof value === 'boolean' ? value : spec.default;
    default:
      return spec.default;
  }
}

function coerceSettings(raw) {
  const out = defaultSettings();
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(SETTING_SPECS)) {
      if (key in raw) out[key] = coerceSetting(key, raw[key]);
    }
  }
  return out;
}

// --- Migration --------------------------------------------------------------

// Version-to-version upgrades. Each entry takes the profile shape at version
// N and returns the shape at N+1. Adding a schema version means adding one
// function here, never editing an existing one.
const MIGRATIONS = {
  // 0 → 1 is the bootstrap case: pre-versioned blobs never shipped, so this
  // only ever fires on a payload written by a build that predates the field.
  0: (p) => ({ ...p, version: 1, presets: Array.isArray(p.presets) ? p.presets : [] }),
};

// Walk a persisted payload forward to SCHEMA_VERSION.
//
// A payload from a NEWER build than this one is left alone and reported as
// unmigratable — downgrading by stripping fields we don't recognise would
// destroy data belonging to a build the player may still be using. The caller
// falls back to defaults for the session without writing over the blob.
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  let p = raw;
  let v = Number.isInteger(p.version) ? p.version : 0;
  if (v > SCHEMA_VERSION) return { ok: false, reason: 'future-version', version: v };
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, reason: 'no-migration-path', version: v };
    p = step(p);
    v = p.version;
  }
  return { ok: true, profile: p };
}

// --- Load / persist ---------------------------------------------------------

export function load() {
  _loaded = true;
  let raw = null;
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) { _profile = emptyProfile(); return _profile; }
    raw = JSON.parse(text);
  } catch (e) {
    // Unparseable or unavailable storage — run on defaults rather than
    // failing to start. The bad blob is left in place for diagnosis.
    _profile = emptyProfile();
    return _profile;
  }

  const result = migrate(raw);
  if (!result.ok) {
    _profile = emptyProfile();
    // A future-version blob is not an error the player caused; flag it so the
    // UI can explain why their settings are missing instead of showing none.
    _lastWriteError = result.reason === 'future-version'
      ? 'profile was written by a newer version — running with defaults'
      : null;
    return _profile;
  }

  _profile = {
    version: SCHEMA_VERSION,
    settings: coerceSettings(result.profile.settings),
    // Saved presets from the removed Ball Machine editor. Nothing reads them
    // any more; they are carried through untouched rather than dropped, so a
    // write from this build never destroys data a player made.
    presets: Array.isArray(result.profile.presets) ? result.profile.presets : [],
    handDetected: result.profile.handDetected === true,
  };
  return _profile;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_profile));
    _lastWriteError = null;
    return true;
  } catch (e) {
    // QuotaExceededError, or private-browsing storage denial. Unlike
    // calibration.js we surface this — progress vanishing without
    // explanation reads as data loss.
    _lastWriteError = (e && e.name === 'QuotaExceededError')
      ? 'storage full — changes not saved'
      : 'storage unavailable — changes not saved';
    return false;
  }
}

export function lastWriteError() {
  return _lastWriteError;
}

function ensureLoaded() {
  if (!_loaded) load();
}

function notify() {
  for (const cb of _subscribers) {
    try { cb(_profile); } catch (e) { /* one bad subscriber can't block others */ }
  }
}

export function subscribe(cb) {
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

// --- Settings API -----------------------------------------------------------

export function getSettings() {
  ensureLoaded();
  return { ..._profile.settings };
}

export function getSetting(key) {
  ensureLoaded();
  return _profile.settings[key];
}

// Returns the value actually stored, which may differ from the requested one
// when it was out of range — callers that echo the value into a UI should use
// the return rather than assuming the write took verbatim.
export function setSetting(key, value) {
  ensureLoaded();
  if (!SETTING_SPECS[key]) return undefined;
  const coerced = coerceSetting(key, value);
  if (_profile.settings[key] === coerced) return coerced;
  _profile.settings[key] = coerced;
  // An explicit choice of hand closes the question permanently — otherwise the
  // next swing's detection would silently overwrite what the player just set.
  if (key === 'dominantHand') _profile.handDetected = true;
  persist();
  notify();
  return coerced;
}

// M10: "dominant hand — from first swing detection". Records the observation
// once; an explicit setSetting('dominantHand', …) afterwards still wins, and
// detection never overrides a choice the player already made.
export function recordDetectedHand(hand) {
  ensureLoaded();
  if (_profile.handDetected) return _profile.settings.dominantHand;
  if (hand !== 'L' && hand !== 'R') return _profile.settings.dominantHand;
  _profile.settings.dominantHand = hand;
  _profile.handDetected = true;
  persist();
  notify();
  return hand;
}

// --- Test / reset support ---------------------------------------------------

// Drops in-memory state AND the persisted blob. Used by tests; kept explicit
// so no code path resets a profile as a side effect of something else.
export function resetProfile() {
  _profile = emptyProfile();
  _loaded = true;
  _lastWriteError = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to do */ }
  notify();
}

// Raw snapshot, for the M7 export path and for tests asserting persisted shape.
export function snapshot() {
  ensureLoaded();
  return JSON.parse(JSON.stringify(_profile));
}
