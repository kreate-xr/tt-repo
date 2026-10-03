// Play menu — the model.
//
// Screens and navigation as pure data. The renderer (scene/trainingMenu.js)
// draws whatever this reports and sends input back; it holds no navigation
// state of its own, so every menu path is a unit test rather than something
// discovered in a headset.
//
// Play is the Training Session and nothing else: the root lists its levels,
// one tap starts it. The older modes (Just Rally, the Practice intents, the
// Ball Machine editor) were removed when the session replaced them. The only
// other screen is Settings, reached from the footer.

import { SETTING_SPECS } from '../../profile/store.js';
import { LEVELS, LEVEL_ORDER } from './session.js';

export const SCREENS = Object.freeze({
  ROOT: 'root',
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

export class TrainingMenuModel {
  constructor({ settings = null } = {}) {
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

  get title() {
    return this.screen === SCREENS.SETTINGS ? 'SETTINGS' : 'TRAINING SESSION';
  }

  /** Breadcrumb for the header, e.g. "PLAY › SETTINGS". */
  get breadcrumb() {
    return this.screen === SCREENS.SETTINGS ? 'PLAY › SETTINGS' : 'PLAY';
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
    // The subtitle carries the level's best score to beat, once there is one.
    return SESSION_LEVEL_ITEMS.map((i) => {
      const best = this.settingsApi
        ? Number(this.settingsApi.getSetting(i.bestKey)) || 0 : 0;
      return { ...i, subtitle: best > 0 ? `${i.subtitle}  ·  Best ${best}%` : i.subtitle };
    });
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
