// Free version vs full version — the one place that decides what is locked.
//
// Two tiers, no trial:
//
//   FREE   Club AI, best of 1, Beginner Training Session, Mixed Reality and
//          Focus Room, joining a room someone with the full game hosts, the
//          last result on the start page, the Club Cup tournament, the
//          Ball Machine's forehand and backhand practices.
//          Unlimited, no sign-up.
//   FULL   everything: International + Elite AI, best of 3 / 5, the Player
//          Training Session, the Arena, hosting rooms, progress trends, the
//          National Open and World Masters tournaments, every Ball Machine
//          practice.
//
// The answer comes from /api/me (`entitled`, i.e. entitlements/{uid}.active),
// fed in by js/ui/accountPanel.js. In-XR menus need it synchronously and may
// open before that answer lands (or with no connection at all), so the last
// known answer is kept in localStorage: a full-version player keeps the full
// game offline, and with nothing known yet everyone is on the free version.
// Like the rest of the game this is enforced client-side; a patched client
// can skip it, which is accepted at this price (functions/index.js).
//
// DEMO: `npm run dev:demo` (vite.config.js) serves the full version to every
// headset with no account and no connection, for an exhibition stand without
// internet. The flag is defined true only under the dev server in demo mode —
// `vite build` always defines it false, so no deployed bundle can carry it.
// While it is on, server answers are ignored and nothing is written to
// storage, so leaving demo mode returns each headset to its real tier.
//
// No Firebase in here — it is imported by the startup bundle and the menus.

const STORE_KEY = 'tt.fullVersion';

// Read behind a typeof guard so the module also loads under Jest, where
// nothing is substituted (see eslint.config.mjs).
const DEMO_FULL = typeof __DEMO_FULL__ !== 'undefined' ? __DEMO_FULL__ === true : false;

export const FREE_AI_LEVELS = Object.freeze(['beginner']);
export const FREE_BEST_OF = 1;
export const FREE_TRAINING_LEVELS = Object.freeze(['beginner']);
export const FREE_VENUES = Object.freeze(['ar', 'vr-focus']);
// The Club Cup is the free player's taste of the Tournament ladder; the
// National Open and World Masters are in the full game.
export const FREE_TOURNAMENTS = Object.freeze(['club']);
// Ball Machine practices (js/modes/training/practice.js): the two basic
// drives are free, the spin, footwork and reading practices are in the full
// game.
export const FREE_PRACTICES = Object.freeze(['forehand', 'backhand']);

/**
 * What the player is told when they reach for something locked. `head` fits
 * the in-XR caption line; `page` is the sentence above the 2D checkout.
 */
export const LOCKED = Object.freeze({
  aiLevel: {
    head: 'INTERNATIONAL and ELITE are in the full game  ·  unlock it on the start page',
    page: 'International and Elite AI are in the full game.',
  },
  bestOf: {
    head: 'Best of 3 and 5 are in the full game  ·  unlock it on the start page',
    page: 'Best-of-3 and best-of-5 matches are in the full game.',
  },
  trainingLevel: {
    head: 'Player level is in the full game  ·  unlock it on the start page',
    page: 'The Player level Training Session is in the full game.',
  },
  arena: {
    head: 'The Arena is in the full game',
    page: 'The Arena is in the full game.',
  },
  hostRoom: {
    head: 'Hosting a room is in the full game  ·  joining one is free',
    page: 'Hosting a room is in the full game. Friends you invite join free.',
  },
  practice: {
    head: 'This practice is in the full game  ·  unlock it on the start page',
    page: 'The spin, footwork and read-the-spin practices are in the full game.',
  },
  tournament: {
    head: 'The National Open and World Masters are in the full game',
    page: 'The National Open and World Masters tournaments are in the full game.',
  },
});

function readStore() {
  try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
}

let full = DEMO_FULL || readStore();
const listeners = new Set();

/** true = the full version is unlocked on this account (or was, last we heard). */
export function isFull() { return full; }

/** true = the dev server's demo mode is forcing the full version (no account behind it). */
export function isDemoFull() { return DEMO_FULL; }

/**
 * Record the server's answer. Called on every /api/me answer — including a
 * `false` after a sign-out or a refund, which takes the full version away.
 */
export function setFull(next) {
  if (DEMO_FULL) return;
  const value = next === true;
  try {
    if (value) localStorage.setItem(STORE_KEY, '1');
    else localStorage.removeItem(STORE_KEY);
  } catch { /* storage unavailable: this page load only */ }
  if (value === full) return;
  full = value;
  for (const fn of listeners) {
    try { fn(full); } catch (err) { console.error('[tier] listener failed:', err); }
  }
}

/** Called with the new value whenever the tier changes. Returns an unsubscribe. */
export function onTierChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function canUseAiLevel(id) { return full || FREE_AI_LEVELS.includes(id); }
export function canUseBestOf(n) { return full || Number(n) === FREE_BEST_OF; }
export function canUseTrainingLevel(id) { return full || FREE_TRAINING_LEVELS.includes(id); }
export function canUseVenue(modeId) { return full || FREE_VENUES.includes(modeId); }
export function canHostRoom() { return full; }
export function canUsePractice(id) { return full || FREE_PRACTICES.includes(id); }
export function canUseTournament(id) { return full || FREE_TOURNAMENTS.includes(id); }
export function canSeeProgressHistory() { return full; }

/** The match length actually played: a stored best-of-5 plays as best of 1 on the free version. */
export function effectiveBestOf(n) { return canUseBestOf(n) ? n : FREE_BEST_OF; }

/** The AI tier actually played: a locked one falls back to Club. */
export function effectiveAiLevel(id) { return canUseAiLevel(id) ? id : FREE_AI_LEVELS[0]; }

/** Test seam: forget the in-memory answer and re-read storage. */
export function _resetForTests() {
  full = DEMO_FULL || readStore();
  listeners.clear();
}
