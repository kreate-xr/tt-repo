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

import { validateConfig } from './drillConfig.js';
import {
  FeedConfigModel, CUSTOM_FIELDS, BURST_STOPS, describeConfig, formatField,
} from './feedConfigModel.js';
import { QUICK_FEED, QUICK_FEED_ORDER } from './presets.js';
import { PATTERNS, PATTERN_ORDER } from './patterns.js';
import { TIERS, TIER_SETTINGS } from './ladder.js';
import {
  weaknessReport, sessionHeadline, heatmapAdvice, whyDidIMiss, FAULTS,
} from './analysis.js';
import { SETTING_SPECS } from '../../profile/store.js';

// The config-editing half of this model now lives in feedConfigModel.js so the
// Machine Play menu can edit a feed with the same rules. Re-exported here
// because the Custom Feed renderer and its tests have always imported these
// from the menu model, and moving the import site adds nothing.
export { CUSTOM_FIELDS, BURST_STOPS, describeConfig, formatField };

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
  SETTINGS: 'settings',
});

// M10 global settings, as menu rows.
//
// Only settings that ACTUALLY DO SOMETHING are selectable. store.js states the
// rule this follows ("a setting that changes nothing is worse than no
// setting"), and the rest of this menu states the other half of it: unbuilt
// things are listed and disabled rather than hidden, so "not wired yet" stays
// distinguishable from "I can't find it". Wiring one of these up is then a
// two-line change here — drop `note` and set `available: true`.
export const SETTING_ROWS = Object.freeze([
  {
    key: 'dominantHand', label: 'Dominant hand', available: true,
    help: 'Which hand holds the paddle. Drill patterns mirror to match',
    valueLabels: { L: 'Left', R: 'Right' },
  },
  { key: 'ballSpeedMultiplier', label: 'Ball speed',   note: 'not wired yet' },
  { key: 'tableHeightOffset',   label: 'Table height', note: 'not wired yet' },
  { key: 'hudDensity',          label: 'HUD density',  note: 'not wired yet' },
  { key: 'units',               label: 'Units',        note: 'not wired yet' },
  { key: 'audioCues',           label: 'Audio cues',   note: 'not wired yet' },
]);

/** Player-facing text for a setting's current value. */
export function formatSettingValue(row, value) {
  if (row.format) return row.format(value);
  if (row.valueLabels && row.valueLabels[String(value)] !== undefined) {
    return row.valueLabels[String(value)];
  }
  return String(value);
}

// M2's submenu. Only what actually runs is enabled; the rest is listed so
// "not built" stays distinguishable from "can't find it".
export const DRILL_ITEMS = Object.freeze([
  // Starts directly — no sub-screen. It runs on the pattern machinery, but
  // burying it inside Pattern Drills made it too hard to reach; `random`
  // is pinned so a stale Random Mode visit can't shuffle it.
  { id: 'rapidFire', label: 'Rapid Fire', action: 'startPattern', random: false, available: true,
    subtitle: 'Machine sweeps side to side, feeding non-stop' },
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

export class TrainingMenuModel extends FeedConfigModel {
  constructor({
    presets = null, settings = null, getSessionLog = null, getRecentContacts = null,
  } = {}) {
    super();
    this.stack = [SCREENS.ROOT];
    // Injected so the model stays testable without localStorage; the renderer
    // passes the real profile store.
    this.presetsApi = presets;
    // The same store in practice, but a separate slot: preset storage and
    // global settings are independent capabilities, and a caller that wants
    // one should not be forced to stub the other.
    this.settingsApi = settings;
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
    this.message = null;
  }

  get screen() { return this.stack[this.stack.length - 1]; }

  /**
   * Handedness decides which column is the backhand, so patterns mirror for
   * left-handers (see patterns.js resolveWing / resolveOrigin). Read live from
   * the profile rather than copied at construction: the settings screen can
   * change it between two drill starts off the same model instance.
   * Falls back to right-handed when no store is attached.
   */
  get hand() {
    const v = this.settingsApi ? this.settingsApi.getSetting('dominantHand') : 'R';
    return v === 'L' ? 'L' : 'R';
  }

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
      case SCREENS.SETTINGS:      return 'SETTINGS';
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
      [SCREENS.SETTINGS]: 'SETTINGS',
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
      case SCREENS.SETTINGS:
        return SETTING_ROWS.map((row) => {
          if (!row.available) {
            return { id: `setting:${row.key}`, label: row.label, available: false, note: row.note };
          }
          if (!this.settingsApi) {
            return {
              id: `setting:${row.key}`, label: row.label, available: false,
              note: 'profile storage unavailable',
            };
          }
          const value = this.settingsApi.getSetting(row.key);
          return {
            id: `setting:${row.key}`,
            label: row.label,
            // Value first: on a settings row what the player is scanning for
            // is the current state, not the description.
            subtitle: `${formatSettingValue(row, value)} — ${row.help}`,
            action: 'cycleSetting',
            settingKey: row.key,
            available: true,
          };
        });
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
    // Settings rows toggle in place — no sub-screen for a two-value choice.
    // Returns null so the host just redraws and the player stays put.
    if (item.action === 'cycleSetting') {
      this.cycleSetting(item.settingKey);
      return null;
    }
    // Legacy drills take a difficulty, not a DrillConfig — passing one would
    // be silently ignored by their factories.
    if (item.action === 'startDrill') return { action: 'start', drill: id, config: null };

    if (item.action === 'startPattern') {
      // An item may pin its own random flag (Rapid Fire in the Drills list);
      // rows on the Patterns screen inherit how that screen was entered.
      const random = item.random !== undefined ? !!item.random : this.randomMode;
      return {
        action: 'start',
        config: this.config,
        options: { pattern: id, random, hand: this.hand },
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
  //
  // setField / setZone / cycleField / stepBurst / zone / spinAmountEnabled all
  // come from FeedConfigModel, so the Machine Play settings screen edits a
  // config under exactly the same rules.

  /**
   * Advance one setting to its next legal value and persist it.
   *
   * Returns the value actually stored (which store.js may have coerced), or
   * null when there is nothing to change. Subscribers of the profile store —
   * notably xrPaddle, which re-binds the paddle on a dominant-hand change —
   * are notified by the store itself, so nothing here needs to know who cares.
   */
  cycleSetting(key) {
    const row = SETTING_ROWS.find((r) => r.key === key);
    const spec = SETTING_SPECS[key];
    if (!row || !row.available || !spec) return null;
    if (!this.settingsApi || typeof this.settingsApi.setSetting !== 'function') return null;

    const current = this.settingsApi.getSetting(key);
    let next;
    if (spec.type === 'enum') {
      // indexOf < 0 (a value from a newer build) restarts at the first legal
      // one rather than throwing — same forgiving stance as coerceSetting.
      const i = spec.values.indexOf(current);
      next = spec.values[(i + 1) % spec.values.length];
    } else if (spec.type === 'boolean') {
      next = !current;
    } else {
      // Numbers need a step list to cycle through; none of the live rows are
      // numeric yet, so refuse rather than inventing an increment.
      return null;
    }

    const stored = this.settingsApi.setSetting(key, next);
    this.message = `${row.label}: ${formatSettingValue(row, stored)}`;
    return stored;
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

