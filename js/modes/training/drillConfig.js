// DrillConfig — the serializable description of a feed pattern (P15 §M1),
// plus the compact URL codec behind the spec's deep-link requirement
// ("every drill config must be serializable to a shareable URL string").
//
// This module is deliberately scene-free and physics-free: it validates and
// encodes, it does not feed. FeedEngine consumes a DrillConfig; nothing here
// imports js/scene/* (migration-plan D4) so it runs headless under Jest.
//
// ── SPIN RANGE ──────────────────────────────────────────────────────────────
// M1 specifies spinMagnitude 0–900 rad/s. The engine cannot land a ball
// anywhere near that. The AI code works in REVOLUTIONS PER SECOND; the old
// cap of 160 rad/s derived from js/ai/shotTypeSelector.js's measured limits
// of "±25/26 rps" under the old MAGNUS_COEFFICIENT of 0.010. That coefficient
// is now the physical 0.004, and the AI spin economy was rescaled ×2.5 to
// physical rad/s at the same time (top ~64 rps ≈ 400 rad/s), so 400 is the
// new matching cap. Every training-layer spin magnitude was scaled ×2.5 in
// the same pass, which preserves M·ω (0.010·ω_old == 0.004·2.5·ω_old) and
// therefore keeps every feed trajectory identical.
//
// Decision (recorded in tt-training-migration-plan.md §3.1): clamp to the
// feasible envelope rather than ship a slider whose top half silently
// produces misses. SPIN_MAX_RAD_S is the single source of truth for that
// ceiling, so raising it later is a one-line change gated by the M1 landing
// test rather than a hunt through the UI.
//
// The DEFAULT of 375 rad/s (the spec's 150, rescaled ×2.5) sits just inside
// this ceiling, so the default feed is unaffected by the clamp.
export const SPIN_MAX_RAD_S = 400;

export const CONFIG_VERSION = 1;

export const SPIN_TYPES = ['none', 'top', 'back', 'side-L', 'side-R', 'combo'];
export const DEPTHS = ['short', 'half-long', 'deep'];
export const ARCS = ['flat', 'medium', 'lob'];
export const FEED_ORIGINS = [
  'L-near', 'L-far', 'center-near', 'center-far', 'R-near', 'R-far',
];

// Net-clearance targets per arc, in metres (M1's arc row).
export const ARC_NET_CLEARANCE = Object.freeze({
  flat: 0.05,
  medium: 0.15,
  lob: 0.5,
});

// Burst count sentinel for "∞". Encoded as `inf` in the URL string; kept as a
// distinct value rather than 0/-1 so "feed forever" can never be confused
// with "feed nothing".
export const INFINITE = Infinity;

// Field specs — range, default and step, straight from M1's attribute table.
// The UI reads step/min/max from here so a slider cannot drift from what the
// validator accepts.
export const FIELD_SPECS = Object.freeze({
  speed:         { type: 'number', min: 2,   max: 25,  step: 0.5,  default: 8 },
  spinMagnitude: { type: 'number', min: 0,   max: SPIN_MAX_RAD_S, step: 25, default: 375 },
  omegaX:        { type: 'number', min: -SPIN_MAX_RAD_S, max: SPIN_MAX_RAD_S, step: 10, default: 0 },
  omegaY:        { type: 'number', min: -SPIN_MAX_RAD_S, max: SPIN_MAX_RAD_S, step: 10, default: 0 },
  omegaZ:        { type: 'number', min: -SPIN_MAX_RAD_S, max: SPIN_MAX_RAD_S, step: 10, default: 0 },
  scatterSigma:  { type: 'number', min: 0,   max: 0.4, step: 0.01, default: 0.05 },
  interval:      { type: 'number', min: 0.8, max: 6,   step: 0.1,  default: 2.0 },
  spinType:      { type: 'enum', values: SPIN_TYPES,   default: 'top' },
  depth:         { type: 'enum', values: DEPTHS,       default: 'deep' },
  arc:           { type: 'enum', values: ARCS,         default: 'medium' },
  feedOrigin:    { type: 'enum', values: FEED_ORIGINS, default: 'center-far' },
  audioCue:      { type: 'boolean', default: true },
});

// Placement is either a 3×3 zone (1–9, reading like a phone keypad with 5 in
// the middle — M1's "zone 5 (middle)" default) or a free point on the table.
export const PLACEMENT_ZONE_DEFAULT = 5;

// The zone is authoritative for the landing row, so anything expressed as a
// depth band has to be folded into the zone number. Rows near-net first.
const DEPTH_ROW = { short: 0, 'half-long': 1, deep: 2 };

/** Zone (1–9) for a depth band at a column (0 left, 1 centre, 2 right). */
export const zoneForDepth = (depth, col = 1) =>
  (DEPTH_ROW[depth] ?? 2) * 3 + col + 1;

/** Depth band implied by a zone's row — the inverse of zoneForDepth. */
export const depthForZone = (zone) => DEPTHS[Math.floor((zone - 1) / 3)];

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    speed: FIELD_SPECS.speed.default,
    spinType: FIELD_SPECS.spinType.default,
    spinMagnitude: FIELD_SPECS.spinMagnitude.default,
    omegaX: 0,
    omegaY: 0,
    omegaZ: 0,
    placement: { kind: 'zone', zone: PLACEMENT_ZONE_DEFAULT },
    scatterSigma: FIELD_SPECS.scatterSigma.default,
    depth: FIELD_SPECS.depth.default,
    arc: FIELD_SPECS.arc.default,
    interval: FIELD_SPECS.interval.default,
    burstCount: 20,
    feedOrigin: FIELD_SPECS.feedOrigin.default,
    audioCue: true,
  };
}

// --- Validation -------------------------------------------------------------

function clampNumber(spec, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, n));
}

function coerceField(key, value) {
  const spec = FIELD_SPECS[key];
  if (!spec) return undefined;
  switch (spec.type) {
    case 'number':  return clampNumber(spec, value);
    case 'enum':    return spec.values.includes(value) ? value : spec.default;
    case 'boolean': return typeof value === 'boolean' ? value : spec.default;
    default:        return spec.default;
  }
}

function coercePlacement(p) {
  const fallback = { kind: 'zone', zone: PLACEMENT_ZONE_DEFAULT };
  if (!p || typeof p !== 'object') return fallback;
  if (p.kind === 'free') {
    const x = Number(p.x);
    const z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return fallback;
    // Bounds are intentionally generous (a half-table is ~0.76 × 1.37 m); the
    // feeder clamps to the real table box, which this module cannot see.
    return { kind: 'free', x: Math.min(2, Math.max(-2, x)), z: Math.min(3, Math.max(-3, z)) };
  }
  const zone = Math.round(Number(p.zone));
  if (!Number.isInteger(zone) || zone < 1 || zone > 9) return fallback;
  return { kind: 'zone', zone };
}

function coerceBurst(value) {
  if (value === INFINITE || value === 'inf' || value === null) return INFINITE;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 20;
  return Math.min(100, Math.max(1, n));
}

/**
 * Coerce arbitrary input into a valid DrillConfig. Never throws and never
 * returns a partially-valid object: every field is either the caller's value
 * clamped into range, or the spec default.
 *
 * This is the ONLY way a config should enter the feed path — deep links, saved
 * presets and hand-edited localStorage all arrive untrusted.
 */
export function validateConfig(raw) {
  const input = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    version: CONFIG_VERSION,
    speed: coerceField('speed', input.speed),
    spinType: coerceField('spinType', input.spinType),
    spinMagnitude: coerceField('spinMagnitude', input.spinMagnitude),
    omegaX: coerceField('omegaX', input.omegaX),
    omegaY: coerceField('omegaY', input.omegaY),
    omegaZ: coerceField('omegaZ', input.omegaZ),
    placement: coercePlacement(input.placement),
    scatterSigma: coerceField('scatterSigma', input.scatterSigma),
    depth: coerceField('depth', input.depth),
    arc: coerceField('arc', input.arc),
    interval: coerceField('interval', input.interval),
    burstCount: coerceBurst(input.burstCount),
    feedOrigin: coerceField('feedOrigin', input.feedOrigin),
    audioCue: coerceField('audioCue', input.audioCue),
  };
  // The ω sliders only exist for 'combo' (M1: "combo exposes ω sliders").
  // Zeroing them otherwise keeps the encoded form canonical, so two configs
  // that feed identically also hash identically — which is what lets M5's
  // Daily Drill seed from the config string.
  if (out.spinType !== 'combo') {
    out.omegaX = 0; out.omegaY = 0; out.omegaZ = 0;
  }
  return out;
}

/**
 * Resolve a config's spin to an angular-velocity triple in rad/s.
 *
 * Axis convention matches the existing feeder's SPIN_AXES (right-hand rule,
 * ball travelling in +Z toward the player):
 *   top → +X, back → −X, side-L → −Y, side-R → +Y.
 */
export function resolveSpinVector(config) {
  const m = config.spinMagnitude;
  switch (config.spinType) {
    case 'top':    return { x:  m, y: 0, z: 0 };
    case 'back':   return { x: -m, y: 0, z: 0 };
    case 'side-R': return { x: 0, y:  m, z: 0 };
    case 'side-L': return { x: 0, y: -m, z: 0 };
    case 'combo':  return { x: config.omegaX, y: config.omegaY, z: config.omegaZ };
    case 'none':
    default:       return { x: 0, y: 0, z: 0 };
  }
}

// --- URL codec --------------------------------------------------------------
//
// Positional CSV behind a version prefix: compact, deterministic, and legible
// enough to debug from a pasted link. Field ORDER is frozen per version —
// a new field means CONFIG_VERSION + 1 and a new decoder branch, never an
// insertion into the v1 order.
//
// NOTE on the ×2.5 spin rescale: spinMagnitude (and the ω components) are
// serialized verbatim, so codes minted before the ×2.5 spin rescale carry
// values ≤160 and now decode to visibly flatter feeds than intended. That is
// accepted — the trajectory is still valid, just weaker-spun.

const SPIN_CODES   = { none: 'n', top: 't', back: 'b', 'side-L': 'l', 'side-R': 'r', combo: 'c' };
const DEPTH_CODES  = { short: 's', 'half-long': 'h', deep: 'd' };
const ARC_CODES    = { flat: 'f', medium: 'm', lob: 'l' };
const ORIGIN_CODES = {
  'L-near': 'ln', 'L-far': 'lf', 'center-near': 'cn',
  'center-far': 'cf', 'R-near': 'rn', 'R-far': 'rf',
};
const invert = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k]));
const SPIN_FROM   = invert(SPIN_CODES);
const DEPTH_FROM  = invert(DEPTH_CODES);
const ARC_FROM    = invert(ARC_CODES);
const ORIGIN_FROM = invert(ORIGIN_CODES);

// Trim float noise so encode(decode(s)) === s. Without this, 0.1 + 0.2 style
// drift would make a round-tripped link differ from the original by a digit.
const num = (n) => String(Math.round(n * 1000) / 1000);

function encodePlacement(p) {
  return p.kind === 'free' ? `f${num(p.x)}_${num(p.z)}` : `z${p.zone}`;
}

function decodePlacement(token) {
  if (typeof token !== 'string') return null;
  if (token.startsWith('z')) return { kind: 'zone', zone: Number(token.slice(1)) };
  if (token.startsWith('f')) {
    const [x, z] = token.slice(1).split('_');
    return { kind: 'free', x: Number(x), z: Number(z) };
  }
  return null;
}

/**
 * Encode a DrillConfig to a compact shareable string.
 * Input is validated first, so encoding a hand-built object is always safe.
 */
export function encodeConfig(config) {
  const c = validateConfig(config);
  const fields = [
    num(c.speed),
    SPIN_CODES[c.spinType],
    num(c.spinMagnitude),
    num(c.omegaX),
    num(c.omegaY),
    num(c.omegaZ),
    encodePlacement(c.placement),
    num(c.scatterSigma),
    DEPTH_CODES[c.depth],
    ARC_CODES[c.arc],
    num(c.interval),
    c.burstCount === INFINITE ? 'inf' : String(c.burstCount),
    ORIGIN_CODES[c.feedOrigin],
    c.audioCue ? '1' : '0',
  ];
  return `${CONFIG_VERSION}.${fields.join(',')}`;
}

/**
 * Decode a shareable string back to a DrillConfig.
 *
 * Returns a VALID config for any input — a truncated, corrupted or
 * future-version string yields defaults for the fields it could not read
 * rather than null. A deep link that half-parses should still start a drill;
 * silently dropping the player into nothing is the worse failure.
 *
 * @returns {{config: object, ok: boolean, reason?: string}}
 */
export function decodeConfig(str) {
  if (typeof str !== 'string' || str.length === 0) {
    return { config: defaultConfig(), ok: false, reason: 'empty' };
  }
  const dot = str.indexOf('.');
  if (dot < 0) return { config: defaultConfig(), ok: false, reason: 'no-version' };

  const version = Number(str.slice(0, dot));
  if (!Number.isInteger(version)) {
    return { config: defaultConfig(), ok: false, reason: 'bad-version' };
  }
  if (version > CONFIG_VERSION) {
    // A link from a newer build. Decode what the v1 order guarantees is
    // present rather than refusing outright — the leading fields are stable
    // by construction, so the drill still resembles what was shared.
    return { ...decodeV1(str.slice(dot + 1)), ok: false, reason: 'future-version' };
  }
  return decodeV1(str.slice(dot + 1));
}

function decodeV1(body) {
  const f = body.split(',');
  const placement = decodePlacement(f[6]);
  const config = validateConfig({
    speed: f[0],
    spinType: SPIN_FROM[f[1]],
    spinMagnitude: f[2],
    omegaX: f[3],
    omegaY: f[4],
    omegaZ: f[5],
    placement: placement || undefined,
    scatterSigma: f[7],
    depth: DEPTH_FROM[f[8]],
    arc: ARC_FROM[f[9]],
    interval: f[10],
    burstCount: f[11] === 'inf' ? INFINITE : f[11],
    feedOrigin: ORIGIN_FROM[f[12]],
    audioCue: f[13] === undefined ? undefined : f[13] === '1',
  });
  // 14 fields is a complete v1 string; fewer means truncation, which the
  // caller may want to report even though we produced a usable config.
  const ok = f.length >= 14;
  return ok ? { config, ok: true } : { config, ok: false, reason: 'truncated' };
}

// --- Deep link --------------------------------------------------------------

const DEEP_LINK_PARAM = 'drill';

/**
 * Read a drill config from a URL's query string. Returns null when the
 * parameter is absent, so boot code can tell "no deep link" from "a deep link
 * that failed to parse" (the latter returns a config with ok: false).
 */
export function parseDeepLink(href) {
  try {
    const url = new URL(href);
    const raw = url.searchParams.get(DEEP_LINK_PARAM);
    if (!raw) return null;
    return decodeConfig(raw);
  } catch (e) {
    return null;
  }
}

/** Build a shareable absolute URL for a config against a base href. */
export function buildDeepLink(config, baseHref) {
  const url = new URL(baseHref);
  url.searchParams.set(DEEP_LINK_PARAM, encodeConfig(config));
  return url.toString();
}
