// M0 training menu — the model.
//
// Screens, navigation, and config editing as pure data. The renderer
// (scene/trainingMenu.js) draws whatever this reports and sends input back;
// it holds no navigation state of its own. Splitting it this way is what
// makes "does Back from Custom Feed return to Ball Machine, with edits kept?"
// a unit test rather than something you discover in a headset.
//
// P15 §M0's tree, with honest availability: modes whose implementation does
// not exist yet are listed and DISABLED rather than hidden. A menu that
// silently omits half the spec makes it impossible to tell "not built" from
// "I can't find it" — which is precisely the confusion that hid the ball
// machine behind six renamed entries.

import {
  FIELD_SPECS, SPIN_TYPES, DEPTHS, ARCS, FEED_ORIGINS,
  defaultConfig, validateConfig, INFINITE, SPIN_MAX_RAD_S,
} from './drillConfig.js';
import { QUICK_FEED, QUICK_FEED_ORDER } from './presets.js';
import { PATTERNS, PATTERN_ORDER } from './patterns.js';
import { TIERS, TIER_SETTINGS } from './ladder.js';
import {
  weaknessReport, sessionHeadline, heatmapAdvice, whyDidIMiss, FAULTS,
} from './analysis.js';

export const SCREENS = Object.freeze({
  ROOT: 'root',
  BALL_MACHINE: 'ballMachine',
  QUICK_FEED: 'quickFeed',
  CUSTOM_FEED: 'customFeed',
  SAVED_PRESETS: 'savedPresets',
  DRILLS: 'drills',
  PATTERNS: 'patterns',
  LADDERS: 'ladders',
  CLASSIC: 'classic',
  REVIEW: 'review',
});

// M2's submenu. Only what actually runs is enabled; the rest is listed so
// "not built" stays distinguishable from "can't find it".
export const DRILL_ITEMS = Object.freeze([
  { id: 'patternDrills', label: 'Pattern Drills', screen: 'patterns', available: true,
    subtitle: 'Falkenberg and seven more classics' },
  { id: 'randomMode', label: 'Random Mode', screen: 'patterns', random: true, available: true,
    subtitle: 'Same shapes, shuffled — transfers better than blocked practice' },
  { id: 'ladders', label: 'Progression Ladders', screen: 'ladders', available: true,
    subtitle: 'Bronze to Diamond, auto-adjusting' },
  { id: 'classic', label: 'Classic Drills', screen: 'classic', available: true,
    subtitle: 'Target, Spin Reader, Reaction, Trajectory' },
  { id: 'footwork', label: 'Footwork', available: false, note: 'not built yet' },
  { id: 'strokeIso', label: 'Stroke Isolation', available: false, note: 'not built yet' },
  { id: 'thirdBall', label: 'Third Ball', available: false, note: 'not built yet' },
  { id: 'consistency', label: 'Consistency Wall', available: false, note: 'not built yet' },
  { id: 'builder', label: 'Custom Drill Builder', available: false, note: 'not built yet' },
]);

// The four pre-P15 drills. They used to be reachable only through the wrist
// menu's ◀ NAME ▶ picker; removing that picker would have orphaned them, so
// they live here under M0's "2. Drills" branch. They still run on the legacy
// feeder and take a difficulty rather than a DrillConfig, which is why they
// carry `drill` instead of a config.
export const LEGACY_DRILLS = Object.freeze([
  { id: 'targetPractice',     label: 'Target Practice', subtitle: 'Land returns in the scoring zones' },
  { id: 'spinReader',         label: 'Spin Reader',     subtitle: 'Call the spin before it crosses' },
  { id: 'reactionRally',      label: 'Reaction Rally',  subtitle: 'Feeds ramp up as you keep up' },
  { id: 'trajectoryPractice', label: 'Trajectory',      subtitle: 'Launch and study the flight path' },
]);

// The nine M0 branches. `available` marks what actually runs today.
export const ROOT_ITEMS = Object.freeze([
  { id: 'ballMachine', label: '1. Ball Machine', screen: SCREENS.BALL_MACHINE, available: true },
  { id: 'drills',      label: '2. Drills',       screen: SCREENS.DRILLS, available: true },
  { id: 'serveSchool', label: '3. Serve School', available: false, note: 'not built yet' },
  { id: 'readingLab',  label: '4. Reading Lab',  available: false, note: 'not built yet' },
  { id: 'games',       label: '5. Games',        available: false, note: 'not built yet' },
  { id: 'skillTest',   label: '6. Skill Test',   available: false, note: 'not built yet' },
  { id: 'review',      label: '7. Review & Stats', screen: SCREENS.REVIEW, available: true },
  { id: 'freePlay',    label: '8. Free Play',    action: 'freePlay', available: true },
  { id: 'tutorial',    label: '9. Tutorial',     available: false, note: 'not built yet' },
]);

export const BALL_MACHINE_ITEMS = Object.freeze([
  { id: 'quickFeed',    label: 'Quick Feed',    screen: SCREENS.QUICK_FEED, available: true },
  { id: 'customFeed',   label: 'Custom Feed',   screen: SCREENS.CUSTOM_FEED, available: true },
  { id: 'savedPresets', label: 'Saved Presets', screen: SCREENS.SAVED_PRESETS, available: true },
]);

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
  { key: 'placement', label: 'Placement', kind: 'zoneGrid' },
  { key: 'depth', label: 'Depth', kind: 'segment', options: DEPTHS },
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

// Burst is stepped through named stops rather than a raw slider — "20 balls"
// and "∞" are the choices a player actually wants, and a 1–100 slider makes
// both awkward to hit.
export const BURST_STOPS = Object.freeze([5, 10, 20, 30, 50, 100, INFINITE]);

export class TrainingMenuModel {
  constructor({ presets = null, getSessionLog = null, getRecentContacts = null } = {}) {
    this.stack = [SCREENS.ROOT];
    this.config = defaultConfig();
    this.selectedPreset = null;
    // Injected so the model stays testable without localStorage; the renderer
    // passes the real profile store.
    this.presetsApi = presets;
    // Supplies the most recent session's EventLog. A provider rather than a
    // stored log because the menu outlives any single drill, and holding a
    // reference would pin a finished session's events in memory.
    this.getSessionLog = getSessionLog;
    // Supplies recent contact geometry for Why-Did-I-Miss. Separate from the
    // event log: these are live vectors, deliberately not serialised.
    this.getRecentContacts = getRecentContacts;
    // Set when the player entered the pattern list via Random Mode; the same
    // screen serves both, differing only in how steps are ordered.
    this.randomMode = false;
    // Handedness decides which column is the backhand. Read from the profile
    // when one is attached so patterns mirror for left-handers automatically.
    this.hand = 'R';
    this.message = null;
  }

  get screen() { return this.stack[this.stack.length - 1]; }

  get title() {
    switch (this.screen) {
      case SCREENS.ROOT:          return 'TRAINING';
      case SCREENS.BALL_MACHINE:  return 'BALL MACHINE';
      case SCREENS.QUICK_FEED:    return 'QUICK FEED';
      case SCREENS.CUSTOM_FEED:   return 'CUSTOM FEED';
      case SCREENS.SAVED_PRESETS: return 'SAVED PRESETS';
      case SCREENS.DRILLS:        return 'DRILLS';
      case SCREENS.PATTERNS:      return this.randomMode ? 'RANDOM MODE' : 'PATTERNS';
      case SCREENS.LADDERS:       return 'LADDERS';
      case SCREENS.CLASSIC:       return 'CLASSIC DRILLS';
      case SCREENS.REVIEW:        return 'REVIEW & STATS';
      default:                    return 'TRAINING';
    }
  }

  /** Breadcrumb for the header, e.g. "TRAINING › BALL MACHINE › CUSTOM FEED". */
  get breadcrumb() {
    const names = {
      [SCREENS.ROOT]: 'TRAINING',
      [SCREENS.BALL_MACHINE]: 'BALL MACHINE',
      [SCREENS.QUICK_FEED]: 'QUICK FEED',
      [SCREENS.CUSTOM_FEED]: 'CUSTOM FEED',
      [SCREENS.SAVED_PRESETS]: 'SAVED PRESETS',
      [SCREENS.DRILLS]: 'DRILLS',
      [SCREENS.PATTERNS]: 'PATTERNS',
      [SCREENS.LADDERS]: 'LADDERS',
      [SCREENS.CLASSIC]: 'CLASSIC DRILLS',
      [SCREENS.REVIEW]: 'REVIEW & STATS',
    };
    return this.stack.map((s) => names[s] || s).join(' › ');
  }

  get canGoBack() { return this.stack.length > 1; }

  navigate(screen) {
    this.stack.push(screen);
    this.message = null;
  }

  back() {
    if (!this.canGoBack) return false;
    this.stack.pop();
    this.message = null;
    return true;
  }

  reset() {
    this.stack = [SCREENS.ROOT];
    this.message = null;
  }

  /** Rows for the current list screen. Config screens return []. */
  items() {
    switch (this.screen) {
      case SCREENS.ROOT:
        return ROOT_ITEMS.map((i) => ({ ...i }));
      case SCREENS.BALL_MACHINE:
        return BALL_MACHINE_ITEMS.map((i) => ({ ...i }));
      case SCREENS.QUICK_FEED:
        return QUICK_FEED_ORDER.map((key) => ({
          id: key,
          label: QUICK_FEED[key].label,
          subtitle: describeConfig(QUICK_FEED[key].config),
          action: 'startPreset',
          available: true,
        }));
      case SCREENS.DRILLS:
        return DRILL_ITEMS.map((i) => ({ ...i }));
      case SCREENS.CLASSIC:
        return LEGACY_DRILLS.map((d) => ({
          ...d, action: 'startDrill', available: true,
        }));
      case SCREENS.PATTERNS:
        return PATTERN_ORDER.map((id) => ({
          id, label: PATTERNS[id].label, subtitle: PATTERNS[id].note,
          action: 'startPattern', available: true,
        }));
      case SCREENS.LADDERS:
        return TIERS.map((tier) => ({
          id: tier,
          label: tier.charAt(0).toUpperCase() + tier.slice(1),
          subtitle: ladderSubtitle(tier),
          action: 'startLadder', available: true,
        }));
      case SCREENS.REVIEW:
        return this.reviewItems();
      case SCREENS.SAVED_PRESETS: {
        const saved = this.presetsApi ? this.presetsApi.getPresets() : [];
        if (saved.length === 0) {
          return [{
            id: '__empty__', label: 'No saved presets yet',
            subtitle: 'Build one in Custom Feed and press Save',
            available: false,
          }];
        }
        return saved.map((p) => ({
          id: p.name, label: p.name, subtitle: describeConfig(p.config),
          action: 'startSaved', available: true,
        }));
      }
      default:
        return [];
    }
  }

  /**
   * M7 Weakness Report rows. Each weakness carries the preset that drills it,
   * so the report is actionable rather than a list of complaints — tapping a
   * row starts that drill.
   *
   * With no session yet, this says so rather than rendering an empty list:
   * "no data" and "no weaknesses" look identical otherwise, and the second
   * would be a lie.
   */
  reviewItems() {
    const log = this.getSessionLog ? this.getSessionLog() : null;
    if (!log || log.feedCount === 0) {
      return [{
        id: '__nodata__',
        label: 'No session data yet',
        subtitle: 'Play a ball machine drill, then come back',
        available: false,
      }];
    }

    const report = weaknessReport(log);
    const rows = [{
      id: '__headline__',
      label: sessionHeadline(log),
      subtitle: `${log.feedCount} balls fed · placement σ ${log.placementSigma().toFixed(3)} m`,
      available: false,
    }];

    const offset = log.meanContactOffset();
    const advice = heatmapAdvice(offset, 'shots');
    if (advice) {
      rows.push({ id: '__blade__', label: advice, subtitle: 'Blade contact', available: false });
    }

    // M7 Why-Did-I-Miss: "one screen, three facts, no lecture". The three
    // facts are the face-angle error, where it went, and where it would have
    // gone — shown for the most recent contact rather than as a history,
    // because a wall of past shots is the lecture the spec rules out.
    const diag = this.lastMissDiagnosis();
    if (diag) {
      rows.push({
        id: '__whymiss__',
        label: diag.headline,
        subtitle: diag.detail,
        available: false,
      });
    }

    for (const w of report.weaknesses) {
      rows.push({
        id: `weak:${w.kind}:${w.key}`,
        label: `${w.label} — ${Math.round(w.rate * 100)}% missed`,
        subtitle: `${w.failures}/${w.attempts} · drill: ${QUICK_FEED[w.preset] ? QUICK_FEED[w.preset].label : w.preset}`,
        action: 'startPreset',
        presetKey: w.preset,
        available: true,
      });
    }

    if (report.weaknesses.length === 0) {
      rows.push({
        id: '__nofault__',
        label: 'No clear weakness yet',
        subtitle: `${report.insufficientData.length} areas need more balls before they can be judged`,
        available: false,
      });
    }
    return rows;
  }

  /**
   * Diagnose the most recent contact, or null when there is nothing to say.
   *
   * Returns text rather than raw numbers because this is the only consumer,
   * and phrasing it here keeps the renderer free of judgement about what
   * counts as a fault.
   */
  lastMissDiagnosis() {
    if (!this.getRecentContacts) return null;
    const bundle = this.getRecentContacts();
    if (!bundle || !bundle.contacts || bundle.contacts.length === 0) return null;

    const last = bundle.contacts[bundle.contacts.length - 1];
    let r;
    try {
      r = whyDidIMiss({ ...last, env: bundle.env });
    } catch (e) {
      return null;   // a diagnosis screen must never break the review
    }
    if (!r || !r.feasible) return null;

    const where = r.actualLanding
      ? `landed ${r.actualLanding.x.toFixed(2)}, ${r.actualLanding.z.toFixed(2)}`
      : 'went off the table';
    const target = r.wouldHaveLanding
      ? `on target: ${r.wouldHaveLanding.x.toFixed(2)}, ${r.wouldHaveLanding.z.toFixed(2)}`
      : null;

    let headline;
    switch (r.primaryFault) {
      case FAULTS.ANGLE:
        headline = `Paddle angle off by ${r.angleErrorDeg}°`;
        break;
      case FAULTS.CONTACT:
        headline = `Struck ${(r.contactOffsetM * 100).toFixed(1)} cm off centre`;
        break;
      default:
        headline = 'Last shot: clean contact and angle';
        break;
    }
    return {
      headline,
      detail: [where, target].filter(Boolean).join(' · '),
      result: r,
    };
  }

  /** Activate a list row. Returns an action for the host, or null. */
  selectItem(id) {
    const item = this.items().find((i) => i.id === id);
    if (!item || item.available === false) return null;

    if (item.screen) {
      if (item.screen === SCREENS.PATTERNS) this.randomMode = !!item.random;
      this.navigate(item.screen);
      return null;
    }
    if (item.action === 'freePlay') return { action: 'freePlay' };
    // Legacy drills take a difficulty, not a DrillConfig — passing one would
    // be silently ignored by their factories.
    if (item.action === 'startDrill') return { action: 'start', drill: id, config: null };

    if (item.action === 'startPattern') {
      return {
        action: 'start',
        config: this.config,
        options: { pattern: id, random: this.randomMode, hand: this.hand },
      };
    }
    if (item.action === 'startLadder') {
      // A ladder always runs a pattern — a graded sequence of one repeated
      // placement is a speed ramp, not a progression.
      return {
        action: 'start',
        config: this.config,
        options: { pattern: 'twoPoint', ladderTier: id, hand: this.hand },
      };
    }

    if (item.action === 'startPreset') {
      // A weakness row names its preset explicitly; a Quick Feed row is keyed
      // by its own id.
      const key = item.presetKey || id;
      if (!QUICK_FEED[key]) return null;
      this.config = validateConfig(QUICK_FEED[key].config);
      this.selectedPreset = key;
      return { action: 'start', config: this.config, preset: key };
    }
    if (item.action === 'startSaved') {
      const saved = (this.presetsApi ? this.presetsApi.getPresets() : [])
        .find((p) => p.name === id);
      if (!saved) return null;
      this.config = validateConfig(saved.config);
      this.selectedPreset = id;
      return { action: 'start', config: this.config, preset: id };
    }
    return null;
  }

  // --- Custom Feed editing --------------------------------------------------

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
    return this.setField('placement', { kind: 'zone', zone }).zone;
  }

  get zone() {
    return this.config.placement.kind === 'zone' ? this.config.placement.zone : null;
  }

  /** Step the spin type through its options, for a segment control. */
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
   * Whether the spin controls should be shown at all. M1 says combo exposes ω
   * sliders; here the simpler rule is that a spin AMOUNT is meaningless with
   * no spin type, so the renderer dims it.
   */
  get spinAmountEnabled() {
    return this.config.spinType !== 'none';
  }

  savePreset(name) {
    if (!this.presetsApi) return { ok: false, reason: 'no-store' };
    const res = this.presetsApi.savePreset(name, this.config);
    this.message = res.ok
      ? `Saved "${name}"`
      : (res.reason === 'full' ? 'Preset list is full (24 max)' : 'Could not save preset');
    return res;
  }

  startCurrent() {
    return { action: 'start', config: this.config, preset: this.selectedPreset };
  }
}

/** What a ladder tier actually feels like, so the choice is informed. */
function ladderSubtitle(tier) {
  const s = TIER_SETTINGS[tier];
  const pace = s.paceMul >= 1.2 ? 'fast' : s.paceMul >= 1 ? 'steady' : 'relaxed';
  return `${Math.round(s.speedMul * 100)}% pace · ${pace} · scatter ${s.scatter.toFixed(2)} m`;
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
