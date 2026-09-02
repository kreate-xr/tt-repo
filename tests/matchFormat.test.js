// Match length — the shared preference behind the wrist menu's BEST OF pill,
// the lobby's format selector and the two match models.
//
// The coercion is the part worth testing: this value arrives from persisted
// storage, from a <select>, and (in multiplayer) off the wire, so anything
// that reaches gamesToWin has already been through normalizeBestOf. An even
// bestOf has no majority — best-of-2 would "need" 2 games out of 2 — which is
// why the list is odd-only rather than any positive integer.

const {
  BEST_OF_OPTIONS, DEFAULT_BEST_OF,
  normalizeBestOf, gamesToWin, matchLengthLabel, loadBestOf, saveBestOf,
} = require('../js/modes/matchFormat.js');

describe('normalizeBestOf', () => {
  test('passes the offered lengths through', () => {
    for (const n of BEST_OF_OPTIONS) expect(normalizeBestOf(n)).toBe(n);
  });

  test('accepts the string forms storage and <select> hand back', () => {
    expect(normalizeBestOf('3')).toBe(3);
    expect(normalizeBestOf('5')).toBe(5);
  });

  test('anything else falls back to the default', () => {
    for (const bad of [null, undefined, NaN, 0, -3, 2, 4, 7, 'lots', {}, []]) {
      expect(normalizeBestOf(bad)).toBe(DEFAULT_BEST_OF);
    }
  });
});

describe('gamesToWin', () => {
  test('is the majority of the games played', () => {
    expect(gamesToWin(1)).toBe(1);
    expect(gamesToWin(3)).toBe(2);
    expect(gamesToWin(5)).toBe(3);
  });

  test('normalizes first, so junk cannot produce a nonsense target', () => {
    expect(gamesToWin(2)).toBe(gamesToWin(DEFAULT_BEST_OF));
    expect(gamesToWin(undefined)).toBe(gamesToWin(DEFAULT_BEST_OF));
  });
});

describe('matchLengthLabel', () => {
  test('spells out the single-game case rather than saying "BEST OF 1"', () => {
    expect(matchLengthLabel(1)).toBe('SINGLE GAME');
    expect(matchLengthLabel(3)).toBe('BEST OF 3');
    expect(matchLengthLabel(5)).toBe('BEST OF 5');
  });
});

describe('persistence', () => {
  // The menus read this at construction and the panels are built in headless
  // tests with no storage at all — a throw here would take the whole wrist
  // menu down, which is why both paths are try/caught.
  afterEach(() => { delete globalThis.localStorage; });

  test('round-trips through storage', () => {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    };
    expect(loadBestOf()).toBe(DEFAULT_BEST_OF);   // nothing stored yet
    expect(saveBestOf(3)).toBe(3);
    expect(loadBestOf()).toBe(3);
  });

  test('a corrupted stored value reads as the default', () => {
    globalThis.localStorage = { getItem: () => 'best of forever', setItem: () => {} };
    expect(loadBestOf()).toBe(DEFAULT_BEST_OF);
  });

  test('storage that throws is survivable in both directions', () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    };
    expect(loadBestOf()).toBe(DEFAULT_BEST_OF);
    expect(saveBestOf(1)).toBe(1);     // the caller still gets its value back
  });

  test('missing storage entirely (headless) is not an error', () => {
    expect(() => loadBestOf()).not.toThrow();
    expect(() => saveBestOf(3)).not.toThrow();
  });
});
