// Play menu — the model.
//
// Screens and navigation as pure data. The renderer (scene/trainingMenu.js)
// draws whatever this reports and sends input back; it holds no navigation
// state of its own, so every menu path is a unit test rather than something
// discovered in a headset.
//
// The root lists the Training Session's levels (one tap starts it) and a row
// into the Ball Machine: a short list of things to practise plus a Random
// switch (js/modes/training/practice.js). The older modes (Just Rally, the
// Practice intents, the Ball Machine EDITOR with its sliders) were removed
// when the session replaced them; the Ball Machine list has nothing to
// configure, by design. Settings is reached from the footer.

import { SETTING_SPECS } from '../../profile/store.js';
import { LEVELS, LEVEL_ORDER } from './session.js';
import {
  PRACTICES, CUSTOM_ID, CUSTOM_OPTIONS, CUSTOM_DEFAULT, customSummary,
} from './practice.js';
import { canUseTrainingLevel, canUsePractice } from '../../account/tier.js';

// The row subtitle of a level that is in the full game only.
export const LOCKED_LEVEL_SUBTITLE = 'Full game  ·  unlock it on the start page';

export const SCREENS = Object.freeze({
  ROOT: 'root',
  // The Ball Machine's list: what to practise, plus the Random switch.
  MACHINE: 'machine',
  // Build your own ball: spin, side, length. Three rows to tap through.
  CUSTOM: 'custom',
  SETTINGS: 'settings',
});

const TITLES = Object.freeze({
  [SCREENS.ROOT]: 'TRAINING',
  [SCREENS.MACHINE]: 'BALL MACHINE',
  [SCREENS.CUSTOM]: 'BUILD YOUR OWN',
  [SCREENS.SETTINGS]: 'SETTINGS',
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
    help: 'Which hand holds the paddle. Forehand and backhand sides mirror to match',
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

// The root: one row per Training Session level, straight from session.js.
// bestKey is the profile setting the session writes that level's best to.
export const SESSION_LEVEL_ITEMS = Object.freeze(LEVEL_ORDER.map((id) => ({
  id, label: LEVELS[id].label, action: 'startSession', available: true,
  bestKey: LEVELS[id].bestKey, subtitle: LEVELS[id].blurb,
})));

// The root's last row: into the Ball Machine list.
const MACHINE_ROW = Object.freeze({
  id: 'machine', label: 'Ball Machine', action: 'openMachine', available: true, screen: true,
  subtitle: 'Pick one thing to practise  ·  endless, no score',
});

export class TrainingMenuModel {
  /**
   * @param {object} [opts]
   * @param {object} [opts.settings] profile store (getSetting / setSetting)
   * @param {(levelId: string) => boolean} [opts.canUseLevel] whether this
   *        player's tier has the level (js/account/tier.js); read on every
   *        call, so an unlock that lands mid-session shows on the next redraw
   */
  constructor({
    settings = null, canUseLevel = canUseTrainingLevel, canUsePracticeId = canUsePractice,
  } = {}) {
    this.canUseLevel = canUseLevel;
    this.canUsePracticeId = canUsePracticeId;
    // The Ball Machine's Random switch. Kept for the session, not persisted:
    // it is a per-practice choice, not a preference.
    this.machineRandom = false;
    // The Build-your-own choice. Also kept for the session only.
    this.custom = { ...CUSTOM_DEFAULT };
    this.stack = [SCREENS.ROOT];
    // Injected so the model stays testable without localStorage; the renderer
    // passes the real profile store.
    this.settingsApi = settings;
    // One-line feedback under the list (a settings change).
    this.message = null;
  }

  get screen() { return this.stack[this.stack.length - 1]; }

  /**
   * Handedness decides which side is the backhand, so the session mirrors
   * for left-handers. Read live from the profile rather than copied at
   * construction: Settings can change it between two starts off the same
   * model instance. Falls back to right-handed when no store is attached.
   */
  get hand() {
    const v = this.settingsApi ? this.settingsApi.getSetting('dominantHand') : 'R';
    return v === 'L' ? 'L' : 'R';
  }

  get title() { return TITLES[this.screen] || TITLES[SCREENS.ROOT]; }

  /** Breadcrumb for the header, e.g. "PLAY › SETTINGS". */
  get breadcrumb() {
    if (this.screen === SCREENS.ROOT) return 'PLAY';
    if (this.screen === SCREENS.CUSTOM) return `PLAY › ${TITLES[SCREENS.MACHINE]} › ${TITLES[SCREENS.CUSTOM]}`;
    return `PLAY › ${TITLES[this.screen]}`;
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

  /** Rows for the current screen. */
  items() {
    if (this.screen === SCREENS.SETTINGS) return this.settingItems();
    if (this.screen === SCREENS.MACHINE) return this.machineItems();
    if (this.screen === SCREENS.CUSTOM) return this.customItems();
    return [...this.levelItems(), MACHINE_ROW];
  }

  levelItems() {
    // The subtitle carries the level's best score to beat, once there is one.
    // A level in the full game only stays tappable — the tap says so — and
    // its subtitle says it up front.
    return SESSION_LEVEL_ITEMS.map((i) => {
      if (!this.canUseLevel(i.id)) {
        return { ...i, action: 'locked', locked: true, subtitle: LOCKED_LEVEL_SUBTITLE };
      }
      const best = this.settingsApi
        ? Number(this.settingsApi.getSetting(i.bestKey)) || 0 : 0;
      return { ...i, subtitle: best > 0 ? `${i.subtitle}  ·  Best ${best}%` : i.subtitle };
    });
  }

  /** The Ball Machine list: one row per practice, then the Random switch. */
  machineItems() {
    const rows = PRACTICES.map((p) => {
      const base = { id: `practice:${p.id}`, label: p.label, available: true };
      if (!this.canUsePracticeId(p.id)) {
        return { ...base, action: 'locked', locked: true, subtitle: LOCKED_LEVEL_SUBTITLE };
      }
      return { ...base, action: 'startPractice', practiceId: p.id, subtitle: p.blurb };
    });
    // Build your own: its own screen, because it has three choices to make.
    rows.push(this.canUsePracticeId(CUSTOM_ID)
      ? {
        id: 'customOpen', label: 'Build your own', action: 'openCustom', available: true,
        screen: true, subtitle: 'Choose the spin, the side and the length',
      }
      : {
        id: 'customOpen', label: 'Build your own', action: 'locked', locked: true,
        available: true, subtitle: LOCKED_LEVEL_SUBTITLE,
      });
    rows.push({
      id: 'machineRandom', label: 'Random side', action: 'toggleRandom', available: true,
      subtitle: this.machineRandom
        ? 'On: each ball goes to a different side'
        : 'Off: the ball goes where the practice says',
    });
    return rows;
  }

  /** Build your own: one row per choice (tap to change), then START. */
  customItems() {
    const labelOf = (key) => CUSTOM_OPTIONS[key].find((o) => o.id === this.custom[key]).label;
    const row = (key, label) => ({
      id: `custom:${key}`, label, action: 'cycleCustom', customKey: key, available: true,
      subtitle: `${labelOf(key)}  ·  tap to change`,
    });
    return [
      row('spin', 'Spin'),
      row('side', 'Side'),
      row('length', 'Length'),
      {
        id: 'custom:start', label: 'START', action: 'startCustom', available: true,
        subtitle: customSummary(this.custom),
      },
    ];
  }

  settingItems() {
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
        // Value first: on a settings row what the player is scanning for is
        // the current state, not the description.
        subtitle: `${formatSettingValue(row, value)} — ${row.help}`,
        action: 'cycleSetting',
        settingKey: row.key,
        available: true,
      };
    });
  }

  /** Activate a row. Returns an action for the host, or null. */
  selectItem(id) {
    const item = this.items().find((i) => i.id === id);
    if (!item || item.available === false) return null;

    // Settings rows toggle in place — no sub-screen for a two-value choice.
    // Returns null so the host just redraws and the player stays put.
    if (item.action === 'cycleSetting') {
      this.cycleSetting(item.settingKey);
      return null;
    }

    // A full-game level or practice on the free version: nothing starts, the
    // host says why.
    if (item.action === 'locked') {
      return { action: 'locked', feature: this.screen === SCREENS.MACHINE ? 'practice' : 'trainingLevel' };
    }

    if (item.action === 'openMachine') {
      this.navigate(SCREENS.MACHINE);
      return null;
    }
    if (item.action === 'toggleRandom') {
      this.machineRandom = !this.machineRandom;
      return null;
    }
    if (item.action === 'openCustom') {
      this.navigate(SCREENS.CUSTOM);
      return null;
    }
    // One tap moves a choice to its next value, wrapping round.
    if (item.action === 'cycleCustom') {
      const list = CUSTOM_OPTIONS[item.customKey];
      const i = list.findIndex((o) => o.id === this.custom[item.customKey]);
      this.custom[item.customKey] = list[(i + 1) % list.length].id;
      return null;
    }
    if (item.action === 'startCustom') {
      return {
        action: 'start', drill: 'practice', config: null,
        options: { practice: CUSTOM_ID, custom: { ...this.custom }, hand: this.hand, random: false },
      };
    }
    // The Ball Machine on the chosen practice; endless until the player leaves.
    if (item.action === 'startPractice') {
      return {
        action: 'start', drill: 'practice', config: null,
        options: { practice: item.practiceId, hand: this.hand, random: this.machineRandom },
      };
    }

    // The Training Session at the chosen level. Every feed value is the
    // session's own; the level and the hand are all it takes.
    if (item.action === 'startSession') {
      return {
        action: 'start', drill: 'session', config: null,
        options: { level: id, hand: this.hand },
      };
    }
    return null;
  }

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
}
