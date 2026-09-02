// Match length — the one match-format setting the player gets to choose, and
// the only one. Everything else about the scoring (11 points, win by 2, serve
// every 2 points, deuce at 10-10) is ITTF-fixed and stays fixed: exposing it
// would multiply the ways two peers can disagree for no gain.
//
// WHY THIS EXISTS AT ALL: the default is best-of-5 to 11, which is 20-40
// minutes in a headset. That is the right length for a match you sat down to
// play and the wrong one for "one quick game before dinner" — and in
// multiplayer the guest used to have no say and no way to even find out what
// they had joined.
//
// One shared module because the value is answered in four places that must
// agree: the wrist menu (AI match), the in-XR lobby panel and the 2D start
// screen (hosting a room), and the match models that score it. The choice is
// persisted so it survives a session, using the same plain-localStorage idiom
// as the wrist menu's competition-rules toggle rather than the training
// profile store — this is a hub preference, not training progress.
//
// AUTHORITY IN MULTIPLAYER: the host's value wins. The guest starts on its own
// last choice (so its scoreboard reads sensibly before the first packet lands)
// and adopts the host's from the SCORE_UPDATE stream — see matchModel.restore.

export const BEST_OF_OPTIONS = Object.freeze([1, 3, 5]);
export const DEFAULT_BEST_OF = 5;

// Shared with the wrist menu's 'tt_competition_rules' key — same namespace,
// same "settings that live outside the training profile" bucket.
const STORAGE_KEY = 'tt_best_of';

/**
 * Coerce anything (a persisted string, a wire field, a stale deep link) to one
 * of the offered lengths. Never throws and never returns an even number: a
 * best-of-2 has no majority and would make `gamesNeeded` a lie.
 */
export function normalizeBestOf(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_BEST_OF;
  return BEST_OF_OPTIONS.includes(n) ? n : DEFAULT_BEST_OF;
}

/** Games one side must win to take the match. */
export function gamesToWin(bestOf) {
  return Math.floor(normalizeBestOf(bestOf) / 2) + 1;
}

/**
 * Display form. "BEST OF 1" is technically true and reads like a typo, so the
 * single-game case gets its own wording.
 */
export function matchLengthLabel(bestOf) {
  const n = normalizeBestOf(bestOf);
  return n === 1 ? 'SINGLE GAME' : `BEST OF ${n}`;
}

// Storage is absent in headless tests and can throw in private browsing; both
// fall back to the default rather than breaking the menu that reads this.
export function loadBestOf() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_BEST_OF : normalizeBestOf(raw);
  } catch (e) {
    return DEFAULT_BEST_OF;
  }
}

/** Returns the value actually stored, which may differ from the request. */
export function saveBestOf(value) {
  const n = normalizeBestOf(value);
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch (e) { /* no storage — session-only choice */ }
  return n;
}
