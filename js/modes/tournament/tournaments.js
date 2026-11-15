// Tournament mode — the ladder and the player's progress through it.
//
// Pure data + logic: no THREE, no DOM, so every path through the bracket is a
// unit test (tests/tournaments.test.js) rather than a headset session.
//
// THE LADDER: three knockout tournaments of three rounds each. Each tournament
// is played at one AI tier, and each round's opponent has a FIXED play style
// (js/ai/playerStyles.js) rather than the random roll a quick AI match gets,
// so the player learns to beat each style in turn. That is the point of the
// mode: in the Eleven Table Tennis review analysis, "beat better and better AIs
// in each tourney" was the most requested missing feature.
//
// The Club Cup is all-rounders. The Club tier has no developed style by design
// (playerStyles.js STYLE_POOL_BY_DIFFICULTY.beginner), and the tournament
// does not change that, so its three opponents differ only in name.
//
// RULES:
//   - Win a round and you move on to the next. Win the final and you take the
//     title, and the tournament starts again at the quarter-final for a
//     replay.
//   - Lose a round and you stay on it. RETRY plays the same opponent again.
//     Eleven reviewers complained about one "impossible" opponent blocking
//     progress, so a loss never sends the player back to the quarter-final.
//   - Taking a title unlocks the next tournament. Whether the tier allows the
//     player in at all is js/account/tier.js's call (canUseTournament), not
//     this file's.
//
// Opponents are fictional. No real player's name is used.

const STORAGE_KEY = 'sportyxr.tournament';
const VERSION = 1;

export const ROUNDS = Object.freeze([
  Object.freeze({ id: 'qf', label: 'QUARTER-FINAL', bestOf: 3 }),
  Object.freeze({ id: 'sf', label: 'SEMI-FINAL', bestOf: 3 }),
  Object.freeze({ id: 'f', label: 'FINAL', bestOf: 5 }),
]);
export const FINAL_ROUND = ROUNDS.length - 1;

// One sentence per style: how this opponent plays and how to beat them. It is
// shown before the match, so it has to fit on one menu row.
export const STYLE_NOTES = Object.freeze({
  allround: 'All-rounder. Steady, mixes everything. Keep the rally going.',
  attacker: 'Attacker. Loops and drives early. Block it back, then counter.',
  blocker: 'Blocker. Takes it on the rise at the edge. Move them side to side.',
  chopper: 'Chopper. Plays far back with heavy backspin. Lift it, then attack the float.',
});

export const STYLE_LABELS = Object.freeze({
  allround: 'All-rounder', attacker: 'Attacker', blocker: 'Blocker', chopper: 'Chopper',
});

const opp = (name, country, style) => Object.freeze({ name, country, style });

export const TOURNAMENTS = Object.freeze({
  club: Object.freeze({
    id: 'club', label: 'CLUB CUP', difficulty: 'beginner', requires: null,
    opponents: Object.freeze([
      opp('Tom Ellery', 'ENG', 'allround'),
      opp('Nina Vos', 'NED', 'allround'),
      opp('Arjun Kale', 'IND', 'allround'),
    ]),
  }),
  national: Object.freeze({
    id: 'national', label: 'NATIONAL OPEN', difficulty: 'intermediate', requires: 'club',
    opponents: Object.freeze([
      opp('Kenji Arai', 'JPN', 'attacker'),
      opp('Sofia Lund', 'SWE', 'blocker'),
      opp('Hugo Mercier', 'FRA', 'chopper'),
    ]),
  }),
  world: Object.freeze({
    id: 'world', label: 'WORLD MASTERS', difficulty: 'pro', requires: 'national',
    opponents: Object.freeze([
      opp('Mateus Rocha', 'BRA', 'blocker'),
      opp('Ilse Kramer', 'AUT', 'chopper'),
      opp('Joon Seo-ha', 'KOR', 'attacker'),
    ]),
  }),
});

export const TOURNAMENT_ORDER = Object.freeze(['club', 'national', 'world']);

/** "Kenji Arai (JPN)": the name the scoreboard and report card show. */
export function opponentLabel(o) {
  return `${o.name} (${o.country})`;
}

/** The match a round plays: the tier, the opponent and the length. */
export function roundMatch(tournamentId, roundIndex) {
  const t = TOURNAMENTS[tournamentId];
  const round = ROUNDS[roundIndex];
  if (!t || !round) return null;
  const opponent = t.opponents[roundIndex];
  return {
    tournamentId,
    roundIndex,
    roundLabel: round.label,
    isFinal: roundIndex === FINAL_ROUND,
    difficulty: t.difficulty,
    bestOf: round.bestOf,
    opponent,
  };
}

const emptyProgress = () => ({ round: 0, titles: 0 });

// Anything unreadable (another version, hand-edited, half-written) becomes
// fresh progress for that tournament rather than an exception in a menu.
function sanitize(raw) {
  const out = {};
  for (const id of TOURNAMENT_ORDER) {
    const p = raw && raw.progress && raw.progress[id];
    const round = Number(p && p.round);
    const titles = Number(p && p.titles);
    out[id] = {
      round: Number.isInteger(round) && round >= 0 && round <= FINAL_ROUND ? round : 0,
      titles: Number.isInteger(titles) && titles > 0 ? titles : 0,
    };
  }
  return out;
}

/**
 * The player's progress, persisted in localStorage. `storage` is injected so
 * tests run without a browser; a storage that is missing or throws (private
 * browsing) leaves progress in memory for this page load only.
 */
export function createTournamentStore({ storage = defaultStorage() } = {}) {
  let progress = load();

  function load() {
    try {
      const raw = storage ? storage.getItem(STORAGE_KEY) : null;
      return sanitize(raw ? JSON.parse(raw) : null);
    } catch {
      return sanitize(null);
    }
  }

  function save() {
    try {
      if (storage) storage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, progress }));
    } catch { /* storage full or unavailable: keep playing from memory */ }
  }

  function get(id) { return progress[id] || emptyProgress(); }

  return {
    /** { round, titles } for one tournament. `round` is the next round to play. */
    getProgress(id) { return { ...get(id) }; },

    /** Has the player won the tournament this one requires? (Tier is separate.) */
    isUnlocked(id) {
      const t = TOURNAMENTS[id];
      if (!t) return false;
      return !t.requires || get(t.requires).titles > 0;
    },

    /**
     * Record a finished round. A result for any round other than the one the
     * player is on is ignored, so a stale report card can't advance the
     * bracket twice.
     *
     * Returns { outcome, nextRound }:
     *   'advanced' won a round before the final, nextRound is the next one
     *   'champion' won the final, the tournament resets to the quarter-final
     *   'retry'    lost, nextRound is the same round
     *   'ignored'  not the current round, nothing changed
     */
    recordResult(id, roundIndex, won) {
      if (!TOURNAMENTS[id]) return { outcome: 'ignored', nextRound: 0 };
      const p = get(id);
      if (roundIndex !== p.round) return { outcome: 'ignored', nextRound: p.round };
      if (!won) return { outcome: 'retry', nextRound: p.round };
      if (roundIndex === FINAL_ROUND) {
        progress[id] = { round: 0, titles: p.titles + 1 };
        save();
        return { outcome: 'champion', nextRound: 0 };
      }
      progress[id] = { round: p.round + 1, titles: p.titles };
      save();
      return { outcome: 'advanced', nextRound: p.round + 1 };
    },

    /** Re-read storage (another tab, tests). */
    reload() { progress = load(); },
  };
}

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
