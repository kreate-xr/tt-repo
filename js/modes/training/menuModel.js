// M0 training menu — the model.
//
// Screens, navigation, and config editing as pure data. The renderer
// (scene/trainingMenu.js) draws whatever this reports and sends input back;
// it holds no navigation state of its own. Splitting it this way is what
// makes "does leaving the Ball Machine editor keep the edits for the next
// visit?" a unit test rather than something you discover in a headset.
//
// P15 §M0's tree, trimmed to what actually runs. During the build-out,
// unimplemented modes were listed and DISABLED so "not built" stayed
// distinguishable from "I can't find it"; now that this menu ships to
// players, a screen that is half grey rows reads as broken rather than as a
// roadmap. The roadmap lives in ai-docs/tt-training-migration-plan.md — a
// mode gets a row here when it gets an implementation, not before.

import { validateConfig, INFINITE } from './drillConfig.js';
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
// From machineModes.js, not machinePlay.js: the drill reaches the scene, and
// this model must stay headless.
import {
  MACHINE_MODES, CHALLENGE_TARGETS,
} from '../machinePlay/machineModes.js';

// The config-editing half of this model now lives in feedConfigModel.js so the
// Machine Play menu can edit a feed with the same rules. Re-exported here
// because the Custom Feed renderer and its tests have always imported these
// from the menu model, and moving the import site adds nothing.
export { CUSTOM_FIELDS, BURST_STOPS, describeConfig, formatField };

export const SCREENS = Object.freeze({
  ROOT: 'root',
  // One screen for the whole machine: the feed editor with a preset cycler.
  // Quick Feed and Saved Presets used to be separate screens over the same
  // DrillConfig; a preset is just a saved editor state, so they merged.
  CUSTOM_FEED: 'customFeed',
  PRACTICE: 'practice',
  PATTERNS: 'patterns',
  LADDERS: 'ladders',
  REVIEW: 'review',
  SETTINGS: 'settings',
});

// M10 global settings, as menu rows.
//
// Only settings that ACTUALLY DO SOMETHING get a row. store.js states the
// rule ("a setting that changes nothing is worse than no setting") — the
// unwired M10 settings keep their SETTING_SPECS entries for storage
// compatibility but are not shown. Wiring one up means adding its row here.
export const SETTING_ROWS = Object.freeze([
  {
    key: 'dominantHand', label: 'Dominant hand', available: true,
    help: 'Which hand holds the paddle. Drill patterns mirror to match',
    valueLabels: { L: 'Left', R: 'Right' },
  },
]);

/** Player-facing text for a setting's current value. */
export function formatSettingValue(row, value) {
  if (row.format) return row.format(value);
  if (row.valueLabels && row.valueLabels[String(value)] !== undefined) {
    return row.valueLabels[String(value)];
  }
  return String(value);
}

// The Practice screen — intents, not mechanisms. The player picks WHAT to
// work on; which pattern, drill wrapper or ladder serves that intent is this
// menu's business, not theirs. This replaced a Drills screen that listed the
// machinery by name (patterns / random mode / ladders / four legacy drills)
// and asked the player to know table-tennis pedagogy before their first ball.
export const PRACTICE_ITEMS = Object.freeze([
  // The on-ramp lives here now, not on the root: three root rows get the
  // whole panel, and "learn the basics" IS a practice intent. Runs as a
  // drill (drills/tutorial.js) — a scripted feed sequence, so it starts
  // directly like the other id-started drills. Once completed, items()
  // demotes it to the bottom of this list.
  { id: 'tutorial', label: 'Learn the Basics', action: 'startDrill', available: true,
    subtitle: 'Three minutes: first return to first backspin' },
  { id: 'spinPractice', label: 'Spin', action: 'startDrill', available: true,
    subtitle: 'Read top, back and side off the machine' },
  { id: 'placementPractice', label: 'Placement', action: 'startDrill', available: true,
    subtitle: 'Land your returns in the lit target zone' },
  // Rapid Fire's non-stop sweep with a ladder on top: it levels up while the
  // player keeps up and backs off when they don't. Absorbs both the old
  // Rapid Fire row and the legacy Reaction Rally.
  { id: 'reaction', label: 'Reaction', action: 'startReaction', available: true,
    subtitle: 'Non-stop sweep that levels up as you keep up' },
  { id: 'movement', label: 'Movement', screen: 'patterns', available: true,
    subtitle: 'Falkenberg and the other classic footwork shapes' },
  { id: 'ladders', label: 'Level Up', screen: 'ladders', available: true,
    subtitle: 'Bronze to Diamond, auto-adjusting' },
  // Study more than practice, but this list is where people look for things
  // to do — and with Ball Machine now a single editor screen there is no
  // hub left for it to live on.
  { id: 'trajectoryPractice', label: 'Study a Shot', action: 'startDrill', available: true,
    subtitle: 'Launch a ball and watch its flight path' },
  { id: 'weaknesses', label: 'Fix My Weaknesses', screen: 'review', available: true,
    subtitle: 'Drills picked from what you actually miss' },
]);

// The one root. The Machine Play menu used to be a second front door over
// the same machine — Quick Rally was Ball Machine's Warmup preset on an
// infinite burst, Free Hit was Free Play under another name, and Survival /
// Score Challenge were end conditions promoted to modes. All of it now lives
// here: Just Rally is the one-tap casual row, and how a custom feed ENDS is a
// cycler on the Ball Machine editor, composing with every feed instead of
// being pinned to one.
//
// Labels carry no numbers; items() numbers them so the numbers always read
// top-to-bottom. The tutorial is not a root row — it leads the Practice list
// (see PRACTICE_ITEMS), which keeps the root at three full-height rows.
export const ROOT_ITEMS = Object.freeze([
  // The "I have ten minutes" button: the Warmup feed, endless, no fail state.
  // Fixed rather than reading the editor's config so one tap always means the
  // same thing; a custom endless rally is Ball Machine with Balls set to ∞.
  { id: 'justRally',   label: 'Just Rally',     action: 'startRally', available: true,
    subtitle: 'One tap — easy endless feed, no fail state' },
  { id: 'practice',    label: 'Practice',       screen: SCREENS.PRACTICE, available: true,
    subtitle: 'Pick what to work on' },
  // Straight into the editor — presets ride along as a cycler on that
  // screen, so there is no hub of near-identical sub-screens to cross first.
  { id: 'ballMachine', label: 'Ball Machine',   screen: SCREENS.CUSTOM_FEED, available: true,
    subtitle: 'Set the feed and how it ends — presets included' },
  // No Review & Stats row: the review screen is reached from Practice › Fix
  // My Weaknesses, where the player is already asking the question it
  // answers. No Free Play row either: the empty table is the state the game
  // falls into when the menu closes with nothing running (A/X from the wrist
  // menu), not a mode to pick.
]);

// How a Ball Machine session ends — the editor's end-condition cycler.
// 'drill' leaves the ending to the Balls setting (the classic burst); the
// others wrap the same feed in the machine-play scorer, which pins the burst
// to infinite because the mode owns its own ending.
export const END_DRILL = 'drill';
export const END_SURVIVAL = 'survival';
export const END_CONDITIONS = Object.freeze([
  END_DRILL,
  END_SURVIVAL,
  ...CHALLENGE_TARGETS.map((n) => `race:${n}`),
]);

/** Player-facing text for an end-condition key. */
export function endConditionLabel(key) {
  if (key === END_DRILL) return 'Until balls run out';
  if (key === END_SURVIVAL) return 'Survival — one miss';
  if (typeof key === 'string' && key.startsWith('race:')) {
    return `Race to ${key.slice(5)}`;
  }
  return String(key);
}

// Sentinel for "no preset — the config is whatever the player has edited".
// First entry of the preset cycle so ‹ from the first real preset lands on it.
export const PRESET_CUSTOM = '__custom__';

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
    // The pattern screen's feed-order toggle. Reset to in-order on each
    // entry to the screen (selectItem does this), flipped in place by the
    // screen's own Feed Order row.
    this.randomMode = false;
    // The Ball Machine editor's end-condition cycler. Drill (Balls setting
    // ends it) is the default; Survival / Race wrap the same feed in the
    // machine-play scorer at start time.
    this.endCondition = END_DRILL;
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
      case SCREENS.ROOT:          return 'PLAY';
      case SCREENS.CUSTOM_FEED:   return 'BALL MACHINE';
      case SCREENS.PRACTICE:      return 'PRACTICE';
      case SCREENS.PATTERNS:      return 'MOVEMENT';
      case SCREENS.LADDERS:       return 'LEVEL UP';
      case SCREENS.REVIEW:        return 'REVIEW & STATS';
      case SCREENS.SETTINGS:      return 'SETTINGS';
      default:                    return 'PLAY';
    }
  }

  /** Breadcrumb for the header, e.g. "PLAY › BALL MACHINE". */
  get breadcrumb() {
    const names = {
      [SCREENS.ROOT]: 'PLAY',
      [SCREENS.CUSTOM_FEED]: 'BALL MACHINE',
      [SCREENS.PRACTICE]: 'PRACTICE',
      [SCREENS.PATTERNS]: 'MOVEMENT',
      [SCREENS.LADDERS]: 'LEVEL UP',
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
      case SCREENS.ROOT: {
        const rows = ROOT_ITEMS.map((i) => ({ ...i }));
        rows.forEach((r, i) => { r.label = `${i + 1}. ${r.label}`; });
        return rows;
      }
      case SCREENS.PRACTICE: {
        const rows = PRACTICE_ITEMS.map((i) => ({ ...i }));
        // A finished tutorial stays on the list (it is rerunnable) but stops
        // leading it: the row moves to the bottom and says it is done —
        // "learn the basics" as the first thing a veteran sees is a nag.
        if (this.settingsApi
            && this.settingsApi.getSetting('tutorialComplete') === true) {
          const i = rows.findIndex((r) => r.id === 'tutorial');
          const [t] = rows.splice(i, 1);
          t.subtitle = 'Completed ✓ — run it again any time';
          rows.push(t);
        }
        return rows;
      }
      case SCREENS.PATTERNS:
        // The order toggle replaces the old separate "Random Mode" entry:
        // shuffled vs in-order is a property of how you run a shape, not a
        // different mode deserving its own branch.
        return [{
          id: '__order__',
          label: 'Feed order',
          subtitle: this.randomMode
            ? 'Shuffled — reads like a real opponent'
            : 'In order — learn the shape first',
          action: 'toggleOrder',
          available: true,
        }].concat(PATTERN_ORDER.map((id) => ({
          id, label: PATTERNS[id].label, subtitle: PATTERNS[id].note,
          action: 'startPattern', available: true,
        })));
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
    // Settings rows toggle in place — no sub-screen for a two-value choice.
    // Returns null so the host just redraws and the player stays put.
    if (item.action === 'cycleSetting') {
      this.cycleSetting(item.settingKey);
      return null;
    }
    // Drills started by id carry no config: the tutorial and the practice
    // wrappers supply their own, and trajectory practice takes none.
    if (item.action === 'startDrill') return { action: 'start', drill: id, config: null };

    // Just Rally: the Warmup feed, endless, through the machine-play scorer
    // (which supplies the rally live line and streak counters). Always the
    // same feed regardless of what the editor holds — one tap, one meaning.
    if (item.action === 'startRally') {
      return {
        action: 'start',
        drill: 'machinePlay',
        config: validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE }),
        options: { machineMode: MACHINE_MODES.RALLY },
      };
    }

    // Flip the pattern screen's feed order in place — no sub-screen, no
    // navigation, the host just redraws.
    if (item.action === 'toggleOrder') {
      this.randomMode = !this.randomMode;
      return null;
    }

    // The Reaction intent: Rapid Fire's non-stop sweep with the ladder
    // running difficulty. Starts at bronze; the ladder promotes and demotes
    // from there, so there is no tier to choose before the first ball.
    if (item.action === 'startReaction') {
      return {
        action: 'start',
        config: this.config,
        options: {
          pattern: 'rapidFire', random: false, ladderTier: 'bronze', hand: this.hand,
        },
      };
    }

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
      // M7 weakness rows: each names the Quick Feed preset that drills it.
      const key = item.presetKey || id;
      if (!QUICK_FEED[key]) return null;
      this.config = validateConfig(QUICK_FEED[key].config);
      this.selectedPreset = key;
      return { action: 'start', config: this.config, preset: key };
    }
    return null;
  }

  // --- Preset cycler (Ball Machine screen) ----------------------------------
  //
  // The one editor screen replaces the old Quick Feed and Saved Presets
  // lists: the cycle is Custom → the six curated feeds → whatever the player
  // has saved. Loading a preset overwrites the working config; editing any
  // field afterwards clears the attribution (FeedConfigModel.setField), which
  // snaps the cycler's label back to Custom without losing the edits.

  /** Cycle entries: PRESET_CUSTOM, quick-feed keys, then saved names. */
  presetOptions() {
    const saved = this.presetsApi ? this.presetsApi.getPresets() : [];
    return [PRESET_CUSTOM, ...QUICK_FEED_ORDER, ...saved.map((p) => p.name)];
  }

  /** Player-facing name of the cycler's current position. */
  get presetLabel() {
    const key = this.selectedPreset;
    if (!key) return 'Custom';
    if (QUICK_FEED[key]) return QUICK_FEED[key].label;
    return key;
  }

  /**
   * Step the preset cycler and load the landed-on config. Returns the new
   * selection key (PRESET_CUSTOM when landing on Custom), or null when the
   * step went nowhere.
   */
  cyclePreset(dir) {
    const options = this.presetOptions();
    const current = this.selectedPreset || PRESET_CUSTOM;
    let i = options.indexOf(current);
    if (i < 0) i = 0;   // a stale selection (deleted save) restarts at Custom
    const next = options[(i + dir + options.length) % options.length];

    if (next === PRESET_CUSTOM) {
      // Custom keeps the working config as-is: it IS the player's edits.
      this.selectedPreset = null;
      this.message = null;
      return PRESET_CUSTOM;
    }
    const source = QUICK_FEED[next]
      ? QUICK_FEED[next].config
      : (this.presetsApi ? this.presetsApi.getPresets() : [])
        .find((p) => p.name === next)?.config;
    if (!source) return null;
    this.config = validateConfig(source);
    this.selectedPreset = next;
    this.message = describeConfig(this.config);
    return next;
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

  // --- End condition (Ball Machine screen) ----------------------------------
  //
  // What used to be the Machine Play menu's Survival and Score Challenge
  // rows, recast as a property of the feed being edited. 'drill' hands the
  // ending to the Balls setting; the others start through the machine-play
  // scorer, which pins the burst to infinite because the mode owns its ending.

  /** Whether the Balls setting currently decides anything — for the editor
   *  to grey the row out under Survival / Race. */
  get burstEnabled() { return this.endCondition === END_DRILL; }

  /** Step the end-condition cycler. Returns the new key. */
  cycleEndCondition(dir) {
    let i = END_CONDITIONS.indexOf(this.endCondition);
    if (i < 0) i = 0;
    this.endCondition = END_CONDITIONS[
      (i + dir + END_CONDITIONS.length) % END_CONDITIONS.length];
    return this.endCondition;
  }

  get endConditionLabel() { return endConditionLabel(this.endCondition); }

  /** The editor's START action, shaped by the end condition. */
  startCurrent() {
    if (this.endCondition === END_SURVIVAL) {
      return {
        action: 'start', drill: 'machinePlay', config: this.config,
        options: { machineMode: MACHINE_MODES.SURVIVAL },
      };
    }
    if (this.endCondition.startsWith('race:')) {
      return {
        action: 'start', drill: 'machinePlay', config: this.config,
        options: {
          machineMode: MACHINE_MODES.CHALLENGE,
          target: Number(this.endCondition.slice(5)),
        },
      };
    }
    return { action: 'start', config: this.config, preset: this.selectedPreset };
  }
}

/** What a ladder tier actually feels like, so the choice is informed. */
function ladderSubtitle(tier) {
  const s = TIER_SETTINGS[tier];
  const pace = s.paceMul >= 1.2 ? 'fast' : s.paceMul >= 1 ? 'steady' : 'relaxed';
  return `${Math.round(s.speedMul * 100)}% pace · ${pace} · scatter ${s.scatter.toFixed(2)} m`;
}

