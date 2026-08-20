// Feed-config editing, shared by every panel that edits a DrillConfig.
//
// Extracted from menuModel.js when the Machine Play menu gained its own
// settings screen. Both menus edit the SAME object (a DrillConfig) through the
// SAME validator, so the editing rules — spin amount is meaningless without a
// spin type, the zone grid owns the depth band, burst steps through named
// stops — belong in one place. Duplicating them would let the two screens
// disagree about what a legal edit is, which is invisible until a config that
// one panel accepts is silently clamped by the other.
//
// Scene-free and physics-free, like drillConfig.js: it validates and reports,
// it does not draw and it does not feed.

import {
  FIELD_SPECS, SPIN_TYPES, ARCS, FEED_ORIGINS,
  defaultConfig, validateConfig, INFINITE, SPIN_MAX_RAD_S, depthForZone,
} from './drillConfig.js';

/**
 * The Custom Feed attribute list — M1's table, in the order it is edited.
 *
 * Each entry declares how it is EDITED, not how it is drawn, so the renderer
 * can lay out a slider or a segment without knowing what a "scatter sigma" is.
 * Ranges come from FIELD_SPECS so a control can never offer a value the
 * validator would clamp — the spin slider in particular stops at the feasible
 * envelope rather than the spec's unreachable 900 rad/s.
 */
export const CUSTOM_FIELDS = Object.freeze([
  { key: 'speed', label: 'Speed', kind: 'slider', unit: 'm/s',
    min: FIELD_SPECS.speed.min, max: FIELD_SPECS.speed.max, step: FIELD_SPECS.speed.step },
  { key: 'spinType', label: 'Spin', kind: 'segment', options: SPIN_TYPES },
  { key: 'spinMagnitude', label: 'Spin amount', kind: 'slider', unit: 'rad/s',
    min: 0, max: SPIN_MAX_RAD_S, step: FIELD_SPECS.spinMagnitude.step },
  // No separate Depth row: the zone grid is authoritative for the landing
  // row, so a depth control here would either fight it or be a lie.
  { key: 'placement', label: 'Placement', kind: 'zoneGrid' },
  { key: 'arc', label: 'Arc', kind: 'segment', options: ARCS },
  { key: 'scatterSigma', label: 'Scatter', kind: 'slider', unit: 'm',
    min: FIELD_SPECS.scatterSigma.min, max: FIELD_SPECS.scatterSigma.max,
    step: FIELD_SPECS.scatterSigma.step },
  { key: 'interval', label: 'Interval', kind: 'slider', unit: 's',
    min: FIELD_SPECS.interval.min, max: FIELD_SPECS.interval.max,
    step: FIELD_SPECS.interval.step },
  { key: 'burstCount', label: 'Balls', kind: 'burst' },
  { key: 'feedOrigin', label: 'Machine position', kind: 'segment', options: FEED_ORIGINS },
  { key: 'audioCue', label: 'Audio cue', kind: 'toggle' },
]);

/**
 * Fields for a screen whose mode owns the ball count.
 *
 * Machine Play runs every mode on an infinite burst — Survival ends on a miss,
 * Score Challenge ends at its target, Quick Rally never ends — so a "Balls"
 * stepper there would be a control with no effect. Deriving the subset from
 * CUSTOM_FIELDS rather than writing a second list means a field added to the
 * feed editor shows up on both screens automatically.
 */
export const ENDLESS_FEED_FIELDS = Object.freeze(
  CUSTOM_FIELDS.filter((f) => f.key !== 'burstCount'),
);

// Burst is stepped through named stops rather than a raw slider — "20 balls"
// and "∞" are the choices a player actually wants, and a 1–100 slider makes
// both awkward to hit.
export const BURST_STOPS = Object.freeze([5, 10, 20, 30, 50, 100, INFINITE]);

/**
 * Everything needed to edit one DrillConfig through a panel.
 *
 * Subclassed rather than composed because both menu models ARE a config
 * editor plus navigation; a `.feed` sub-object would mean every renderer
 * reaching through it for the same six calls.
 */
export class FeedConfigModel {
  constructor() {
    this.config = defaultConfig();
    this.selectedPreset = null;
    this.message = null;
  }

  /**
   * Set one config field. Always routes through validateConfig, so no control
   * can put an out-of-range value into the engine even if its own bounds are
   * wrong — the validator stays the single gate.
   */
  setField(key, value) {
    this.config = validateConfig({ ...this.config, [key]: value });
    this.selectedPreset = null;  // it's no longer the preset once edited
    return this.config[key];
  }

  /** Set the 3×3 placement zone (M1's zone grid). */
  setZone(zone) {
    // Keep `depth` in step with the zone's row so the summary line,
    // serialization and depth-reading drills all agree with the grid.
    this.config = validateConfig({
      ...this.config,
      placement: { kind: 'zone', zone },
      depth: depthForZone(zone),
    });
    this.selectedPreset = null;
    return this.config.placement.zone;
  }

  get zone() {
    return this.config.placement.kind === 'zone' ? this.config.placement.zone : null;
  }

  /** Step an enum field through its options, for a segment control. */
  cycleField(key, dir = 1) {
    const field = CUSTOM_FIELDS.find((f) => f.key === key);
    if (!field || !field.options) return null;
    const i = field.options.indexOf(this.config[key]);
    const next = field.options[
      ((i + dir) % field.options.length + field.options.length) % field.options.length
    ];
    return this.setField(key, next);
  }

  /** Step burst count through its named stops rather than by ±1. */
  stepBurst(dir = 1) {
    const i = BURST_STOPS.indexOf(this.config.burstCount);
    const from = i < 0 ? 2 : i;   // default to the 20-ball stop
    const next = BURST_STOPS[Math.min(BURST_STOPS.length - 1, Math.max(0, from + dir))];
    return this.setField('burstCount', next);
  }

  /**
   * Whether the spin AMOUNT control should be live at all. A spin magnitude is
   * meaningless with no spin type, so the renderer dims it.
   */
  get spinAmountEnabled() {
    return this.config.spinType !== 'none';
  }
}

/** One-line human summary of a config, for list subtitles. */
export function describeConfig(config) {
  const c = validateConfig(config);
  const spin = c.spinType === 'none' ? 'no spin' : `${c.spinType} ${Math.round(c.spinMagnitude)}`;
  const balls = c.burstCount === INFINITE ? '∞' : c.burstCount;
  return `${c.speed} m/s · ${spin} · ${c.depth} · ${balls} balls`;
}

/** Display string for a field's current value, including units. */
export function formatField(field, config) {
  const v = config[field.key];
  switch (field.kind) {
    case 'toggle': return v ? 'ON' : 'OFF';
    case 'burst':  return v === INFINITE ? '∞' : String(v);
    case 'zoneGrid': {
      const p = config.placement;
      return p.kind === 'free' ? 'free point' : `zone ${p.zone}`;
    }
    case 'slider': {
      const decimals = field.step < 1 ? (field.step < 0.05 ? 2 : 1) : 0;
      return `${v.toFixed(decimals)} ${field.unit || ''}`.trim();
    }
    default: return String(v);
  }
}
