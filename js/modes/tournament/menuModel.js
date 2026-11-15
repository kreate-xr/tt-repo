// Tournament menu — the model.
//
// Same shape as the Play menu's model (js/modes/training/menuModel.js) so the
// same renderer, scene/trainingMenu.js, draws it: screen / title / breadcrumb
// / canGoBack / navigate / back / reset / items / selectItem. All navigation
// lives here and is unit-tested.
//
// Two screens:
//   ROOT     one row per tournament, with progress, or why it is closed
//   BRACKET  the three rounds of one tournament. Rounds already won are
//            ticked, the next one is the row to tap, later ones wait.

import {
  TOURNAMENTS, TOURNAMENT_ORDER, ROUNDS, STYLE_NOTES, STYLE_LABELS,
  roundMatch, opponentLabel, createTournamentStore,
} from './tournaments.js';
import { canUseTournament, effectiveBestOf } from '../../account/tier.js';
import { matchLengthLabel } from '../matchFormat.js';

export const SCREENS = Object.freeze({ ROOT: 'root', BRACKET: 'bracket' });

export const LOCKED_TOURNAMENT_SUBTITLE = 'Full game  ·  unlock it on the start page';

const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();

export class TournamentMenuModel {
  /**
   * @param {object} [opts]
   * @param {object} [opts.store] createTournamentStore() instance (injected for tests)
   * @param {(id: string) => boolean} [opts.canUse] tier gate, read on every call
   * @param {(n: number) => number} [opts.bestOfFor] the length the tier lets a round play
   */
  constructor({
    store = createTournamentStore(), canUse = canUseTournament, bestOfFor = effectiveBestOf,
  } = {}) {
    this.store = store;
    this.canUse = canUse;
    this.bestOfFor = bestOfFor;
    this.stack = [SCREENS.ROOT];
    this.tournamentId = null;
    this.message = null;
  }

  get screen() { return this.stack[this.stack.length - 1]; }

  get title() {
    return this.screen === SCREENS.BRACKET && this.tournamentId
      ? TOURNAMENTS[this.tournamentId].label : 'TOURNAMENT';
  }

  get breadcrumb() {
    return this.screen === SCREENS.BRACKET && this.tournamentId
      ? `TOURNAMENT › ${TOURNAMENTS[this.tournamentId].label}` : 'TOURNAMENT';
  }

  get canGoBack() { return this.stack.length > 1; }

  navigate(screen) { this.stack.push(screen); this.message = null; }

  back() {
    if (!this.canGoBack) return false;
    this.stack.pop();
    if (this.screen === SCREENS.ROOT) this.tournamentId = null;
    this.message = null;
    return true;
  }

  reset() { this.stack = [SCREENS.ROOT]; this.tournamentId = null; this.message = null; }

  /** Jump straight to one tournament's bracket (the report card's TOURNAMENT button). */
  openBracket(id) {
    if (!TOURNAMENTS[id]) return;
    this.reset();
    this.tournamentId = id;
    this.navigate(SCREENS.BRACKET);
  }

  /** Re-read progress, e.g. after a match recorded a result. */
  refresh() { this.store.reload(); }

  items() {
    return this.screen === SCREENS.BRACKET ? this.bracketItems() : this.rootItems();
  }

  rootItems() {
    return TOURNAMENT_ORDER.map((id) => {
      const t = TOURNAMENTS[id];
      const base = { id, label: t.label };
      if (!this.canUse(id)) {
        return { ...base, action: 'locked', locked: true, available: true, subtitle: LOCKED_TOURNAMENT_SUBTITLE };
      }
      if (!this.store.isUnlocked(id)) {
        const req = TOURNAMENTS[t.requires].label.split(' ').map(titleCase).join(' ');
        return { ...base, available: false, note: `Win the ${req} to enter` };
      }
      const p = this.store.getProgress(id);
      const next = roundMatch(id, p.round);
      const parts = [];
      if (p.titles > 0) parts.push(p.titles === 1 ? 'Champion' : `Champion ×${p.titles}`);
      parts.push(`Next: ${titleCase(next.roundLabel)} vs ${next.opponent.name}`);
      return { ...base, action: 'open', available: true, screen: true, subtitle: parts.join('  ·  ') };
    });
  }

  bracketItems() {
    const id = this.tournamentId;
    const p = this.store.getProgress(id);
    return ROUNDS.map((round, i) => {
      const m = roundMatch(id, i);
      const who = opponentLabel(m.opponent);
      if (i < p.round) {
        return { id: `round:${i}`, label: `✓  ${round.label}`, available: false, note: `Beat ${who}` };
      }
      if (i === p.round) {
        const length = matchLengthLabel(this.bestOfFor(m.bestOf));
        return {
          id: `round:${i}`,
          label: `${round.label} vs ${who}`,
          subtitle: `${STYLE_NOTES[m.opponent.style]}  ·  ${titleCase(length)}`,
          action: 'startRound',
          available: true,
        };
      }
      return {
        id: `round:${i}`, label: round.label, available: false,
        note: `${STYLE_LABELS[m.opponent.style]}  ·  win the ${titleCase(ROUNDS[i - 1].label)} first`,
      };
    });
  }

  /** Activate a row. Returns an action for the host, or null. */
  selectItem(itemId) {
    const item = this.items().find((i) => i.id === itemId);
    if (!item || item.available === false) return null;
    if (item.action === 'locked') return { action: 'locked', feature: 'tournament' };
    if (item.action === 'open') {
      this.tournamentId = item.id;
      this.navigate(SCREENS.BRACKET);
      return null;
    }
    if (item.action === 'startRound') {
      const roundIndex = Number(itemId.split(':')[1]);
      return this.startAction(this.tournamentId, roundIndex);
    }
    return null;
  }

  /** The start payload for one round: what inGame hands enterDrill. */
  startAction(tournamentId, roundIndex) {
    const m = roundMatch(tournamentId, roundIndex);
    if (!m) return null;
    return {
      action: 'start',
      drill: 'aiMatch',
      difficulty: m.difficulty,
      config: null,
      options: {
        bestOf: this.bestOfFor(m.bestOf),
        tournament: { tournamentId, roundIndex },
      },
    };
  }
}
