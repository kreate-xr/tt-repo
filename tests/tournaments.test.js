// Tournament mode — the ladder data, the progress store, and the menu model.

const {
  TOURNAMENTS, TOURNAMENT_ORDER, ROUNDS, FINAL_ROUND, STYLE_NOTES,
  roundMatch, opponentLabel, createTournamentStore,
} = require('../js/modes/tournament/tournaments.js');
const { PLAYER_STYLES } = require('../js/ai/playerStyles.js');
const { TournamentMenuModel, SCREENS, LOCKED_TOURNAMENT_SUBTITLE } = require('../js/modes/tournament/menuModel.js');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('the ladder', () => {
  test('three tournaments, Club → International → Elite, each unlocking the next', () => {
    expect(TOURNAMENT_ORDER).toEqual(['club', 'national', 'world']);
    expect(TOURNAMENT_ORDER.map((id) => TOURNAMENTS[id].difficulty))
      .toEqual(['beginner', 'intermediate', 'pro']);
    expect(TOURNAMENT_ORDER.map((id) => TOURNAMENTS[id].requires)).toEqual([null, 'club', 'national']);
  });

  test('quarter and semi are best of 3, the final best of 5', () => {
    expect(ROUNDS.map((r) => r.bestOf)).toEqual([3, 3, 5]);
    expect(FINAL_ROUND).toBe(2);
  });

  test('every opponent has a real style with a note, and one opponent per round', () => {
    const styles = Object.values(PLAYER_STYLES);
    for (const id of TOURNAMENT_ORDER) {
      const { opponents } = TOURNAMENTS[id];
      expect(opponents).toHaveLength(ROUNDS.length);
      for (const o of opponents) {
        expect(styles).toContain(o.style);
        expect(STYLE_NOTES[o.style]).toBeTruthy();
        expect(o.country).toMatch(/^[A-Z]{3}$/);
      }
    }
  });

  test('the Club Cup is all-rounders (Club AI has no style); the others meet three different styles', () => {
    expect(TOURNAMENTS.club.opponents.every((o) => o.style === 'allround')).toBe(true);
    for (const id of ['national', 'world']) {
      const set = new Set(TOURNAMENTS[id].opponents.map((o) => o.style));
      expect(set.size).toBe(3);
      expect(set.has('allround')).toBe(false);
    }
  });

  test('roundMatch describes the match a round plays', () => {
    expect(roundMatch('national', 2)).toEqual({
      tournamentId: 'national', roundIndex: 2, roundLabel: 'FINAL', isFinal: true,
      difficulty: 'intermediate', bestOf: 5, opponent: TOURNAMENTS.national.opponents[2],
    });
    expect(roundMatch('nope', 0)).toBeNull();
    expect(roundMatch('club', 3)).toBeNull();
    expect(opponentLabel(TOURNAMENTS.club.opponents[0])).toBe('Tom Ellery (ENG)');
  });
});

describe('progress store', () => {
  test('starts at the quarter-final with no titles; only the Club Cup is open', () => {
    const s = createTournamentStore({ storage: memoryStorage() });
    expect(s.getProgress('club')).toEqual({ round: 0, titles: 0 });
    expect(TOURNAMENT_ORDER.map(s.isUnlocked)).toEqual([true, false, false]);
  });

  test('a win moves to the next round; a loss stays on the same one', () => {
    const s = createTournamentStore({ storage: memoryStorage() });
    expect(s.recordResult('club', 0, true)).toEqual({ outcome: 'advanced', nextRound: 1 });
    expect(s.recordResult('club', 1, false)).toEqual({ outcome: 'retry', nextRound: 1 });
    expect(s.getProgress('club').round).toBe(1);
  });

  test('winning the final takes the title, resets to the quarter-final and unlocks the next tournament', () => {
    const s = createTournamentStore({ storage: memoryStorage() });
    s.recordResult('club', 0, true);
    s.recordResult('club', 1, true);
    expect(s.recordResult('club', 2, true)).toEqual({ outcome: 'champion', nextRound: 0 });
    expect(s.getProgress('club')).toEqual({ round: 0, titles: 1 });
    expect(s.isUnlocked('national')).toBe(true);
    expect(s.isUnlocked('world')).toBe(false);
  });

  test('a result for a round the player is not on changes nothing (a stale card)', () => {
    const s = createTournamentStore({ storage: memoryStorage() });
    s.recordResult('club', 0, true);
    expect(s.recordResult('club', 0, true)).toEqual({ outcome: 'ignored', nextRound: 1 });
    expect(s.recordResult('ghost', 0, true).outcome).toBe('ignored');
    expect(s.getProgress('club').round).toBe(1);
  });

  test('progress survives a reload through storage', () => {
    const storage = memoryStorage();
    const a = createTournamentStore({ storage });
    a.recordResult('club', 0, true);
    const b = createTournamentStore({ storage });
    expect(b.getProgress('club').round).toBe(1);
  });

  test('corrupt or foreign storage reads as fresh progress, not an exception', () => {
    for (const raw of ['{not json', JSON.stringify({ progress: { club: { round: 9, titles: -2 } } }), '42']) {
      const s = createTournamentStore({ storage: memoryStorage({ 'sportyxr.tournament': raw }) });
      expect(s.getProgress('club')).toEqual({ round: 0, titles: 0 });
    }
  });

  test('storage that throws keeps progress in memory', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    const s = createTournamentStore({ storage: throwing });
    expect(s.recordResult('club', 0, true).outcome).toBe('advanced');
    expect(s.getProgress('club').round).toBe(1);
  });
});

describe('menu model', () => {
  const full = () => true;
  const free = (id) => id === 'club';
  const make = ({ canUse = full, bestOfFor = (n) => n, storage = memoryStorage() } = {}) => {
    const store = createTournamentStore({ storage });
    return { store, model: new TournamentMenuModel({ store, canUse, bestOfFor }) };
  };

  test('root lists the three tournaments; later ones say what opens them', () => {
    const { model } = make();
    const items = model.items();
    expect(items.map((i) => i.id)).toEqual(['club', 'national', 'world']);
    expect(items[0]).toMatchObject({ action: 'open', available: true });
    expect(items[0].subtitle).toBe('Next: Quarter-final vs Tom Ellery');
    expect(items[1]).toMatchObject({ available: false, note: 'Win the Club Cup to enter' });
    expect(items[2]).toMatchObject({ available: false, note: 'Win the National Open to enter' });
    expect(model.title).toBe('TOURNAMENT');
  });

  test('on the free version the full-game tournaments are tappable locks', () => {
    const { model } = make({ canUse: free });
    const [, national, world] = model.items();
    for (const row of [national, world]) {
      expect(row).toMatchObject({ action: 'locked', locked: true, subtitle: LOCKED_TOURNAMENT_SUBTITLE });
    }
    expect(model.selectItem('national')).toEqual({ action: 'locked', feature: 'tournament' });
  });

  test('opening a tournament shows its bracket: done, next, waiting', () => {
    const { store, model } = make();
    store.recordResult('club', 0, true);
    expect(model.selectItem('club')).toBeNull();
    expect(model.screen).toBe(SCREENS.BRACKET);
    expect(model.title).toBe('CLUB CUP');
    expect(model.breadcrumb).toBe('TOURNAMENT › CLUB CUP');
    const [qf, sf, f] = model.items();
    expect(qf).toMatchObject({ available: false, note: 'Beat Tom Ellery (ENG)' });
    expect(qf.label).toMatch(/QUARTER-FINAL/);
    expect(sf).toMatchObject({ action: 'startRound', available: true });
    expect(sf.label).toBe('SEMI-FINAL vs Nina Vos (NED)');
    expect(sf.subtitle).toMatch(/All-rounder.*Best of 3$/);
    expect(f).toMatchObject({ available: false });
    expect(model.back()).toBe(true);
    expect(model.screen).toBe(SCREENS.ROOT);
  });

  test('tapping the next round starts an AI match at the tournament tier with the round index', () => {
    const { model } = make();
    model.selectItem('club');
    expect(model.selectItem('round:0')).toEqual({
      action: 'start', drill: 'aiMatch', difficulty: 'beginner', config: null,
      options: { bestOf: 3, tournament: { tournamentId: 'club', roundIndex: 0 } },
    });
    // A round already won or still waiting starts nothing.
    expect(model.selectItem('round:2')).toBeNull();
  });

  test('the match length follows the tier: single game on the free version', () => {
    const { model } = make({ canUse: free, bestOfFor: () => 1 });
    model.selectItem('club');
    expect(model.items()[0].subtitle).toMatch(/Single game$/);
    expect(model.selectItem('round:0').options.bestOf).toBe(1);
  });

  test('a title shows on the root row', () => {
    const { store, model } = make();
    for (let i = 0; i < 3; i++) store.recordResult('club', i, true);
    expect(model.items()[0].subtitle).toMatch(/^Champion {2}· {2}Next: Quarter-final/);
    for (let i = 0; i < 3; i++) store.recordResult('club', i, true);
    expect(model.items()[0].subtitle).toMatch(/^Champion ×2/);
  });

  test('openBracket jumps straight to a tournament from the report card', () => {
    const { model } = make();
    model.openBracket('club');
    expect(model.screen).toBe(SCREENS.BRACKET);
    expect(model.canGoBack).toBe(true);
    model.openBracket('ghost');
    expect(model.screen).toBe(SCREENS.BRACKET);
  });
});
