// Machine Play menu — the model.
//
// Same split as the training menu (modes/training/menuModel.js): screens,
// navigation and config editing as pure data, so "does Back from Rally
// Settings return to the root with the edits kept?" is a unit test rather
// than something you find out in a headset.
//
// Config editing comes from FeedConfigModel, so the settings screen here obeys
// exactly the same rules as Custom Feed — one validator, one set of ranges.

import { FeedConfigModel, describeConfig } from '../training/feedConfigModel.js';
import { validateConfig, INFINITE } from '../training/drillConfig.js';
import { QUICK_FEED } from '../training/presets.js';
// From machineModes.js, not machinePlay.js: the drill reaches the scene, and
// this model must stay headless.
import { MACHINE_MODES, DEFAULT_CHALLENGE_TARGET } from './machineModes.js';

export const SCREENS = Object.freeze({
  ROOT: 'root',
  SETTINGS: 'settings',
  CHALLENGE: 'challenge',
});

// Targets a Score Challenge can be set to. Named stops rather than a slider
// for the same reason burst count is: these are the numbers a player actually
// picks, and a 1–200 slider makes every one of them awkward to hit.
export const CHALLENGE_TARGETS = Object.freeze([10, 25, 50, 100]);

export const ROOT_ITEMS = Object.freeze([
  { id: 'quickRally', label: '1. Quick Rally', action: 'start', mode: MACHINE_MODES.RALLY,
    subtitle: 'Endless feed · no fail state', available: true },
  { id: 'settings', label: '2. Rally Settings', screen: SCREENS.SETTINGS,
    subtitle: 'Speed, spin, placement, interval', available: true },
  { id: 'survival', label: '3. Survival', action: 'start', mode: MACHINE_MODES.SURVIVAL,
    subtitle: 'One miss ends the run', available: true },
  { id: 'challenge', label: '4. Score Challenge', screen: SCREENS.CHALLENGE,
    subtitle: 'Race to a return count', available: true },
  { id: 'freeHit', label: '5. Free Hit', action: 'freeHit',
    subtitle: 'Empty table · serve it yourself', available: true },
]);

export class MachinePlayModel extends FeedConfigModel {
  constructor() {
    super();
    this.stack = [SCREENS.ROOT];
    // Warmup rather than the M1 default: this is the casual entry point, and
    // the default feed (8 m/s, 150 rad/s topspin) is a drill setting that
    // makes a first rally unplayable for most people. Burst is pinned to
    // infinite because every mode here owns its own ending.
    this.config = validateConfig({ ...QUICK_FEED.Warmup.config, burstCount: INFINITE });
    this.challengeTarget = DEFAULT_CHALLENGE_TARGET;
  }

  get screen() { return this.stack[this.stack.length - 1]; }

  get title() {
    switch (this.screen) {
      case SCREENS.SETTINGS:  return 'RALLY SETTINGS';
      case SCREENS.CHALLENGE: return 'SCORE CHALLENGE';
      default:                return 'MACHINE PLAY';
    }
  }

  get breadcrumb() {
    const names = {
      [SCREENS.ROOT]: 'MACHINE PLAY',
      [SCREENS.SETTINGS]: 'RALLY SETTINGS',
      [SCREENS.CHALLENGE]: 'SCORE CHALLENGE',
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

  /**
   * Keep burst pinned to infinite through every edit.
   *
   * The settings screen does not show a Balls control, but presets and saved
   * configs carry one, and FeedConfigModel.setField re-validates the WHOLE
   * config each time — so without this a finite burst could ride in and stop
   * the machine mid-game.
   */
  setField(key, value) {
    const out = super.setField(key, value);
    if (this.config.burstCount !== INFINITE) {
      this.config = validateConfig({ ...this.config, burstCount: INFINITE });
    }
    return out;
  }

  /** Rows for the current list screen. The settings screen returns []. */
  items() {
    switch (this.screen) {
      case SCREENS.ROOT:
        return ROOT_ITEMS.map((i) => ({
          ...i,
          // Quick Rally advertises what it is about to feed, so the player can
          // tell whether Rally Settings needs a visit before pressing it.
          subtitle: i.id === 'quickRally' ? describeConfig(this.config) : i.subtitle,
        }));
      case SCREENS.CHALLENGE:
        return CHALLENGE_TARGETS.map((n) => ({
          id: `target:${n}`,
          label: `${n} returns`,
          subtitle: n === this.challengeTarget ? 'current target' : null,
          action: 'startChallenge',
          target: n,
          available: true,
        }));
      default:
        return [];
    }
  }

  /** Activate a list row. Returns an action for the host, or null. */
  selectItem(id) {
    const item = this.items().find((i) => i.id === id);
    if (!item || item.available === false) return null;

    if (item.screen) {
      this.navigate(item.screen);
      return null;
    }
    if (item.action === 'freeHit') return { action: 'freeHit' };
    if (item.action === 'start') {
      return { action: 'start', mode: item.mode, config: this.config };
    }
    if (item.action === 'startChallenge') {
      this.challengeTarget = item.target;
      return {
        action: 'start',
        mode: MACHINE_MODES.CHALLENGE,
        config: this.config,
        target: item.target,
      };
    }
    return null;
  }

  /** START on the settings screen plays the edited feed as a Quick Rally. */
  startFromSettings() {
    return { action: 'start', mode: MACHINE_MODES.RALLY, config: this.config };
  }
}
