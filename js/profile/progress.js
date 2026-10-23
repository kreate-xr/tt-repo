// Player progress history — one small summary per finished AI match or
// Training Session, read back by the start page's "Your progress" section.
//
// ── WHY NOT eventLog.js's appendSession ────────────────────────────────────
//
// p15.sessions holds ball-machine drill summaries (per-feed failure maps) and
// trend() reads any numeric field across all of them. Mixing match results
// into it would make every trend series a blend of two different measures.
// Its own key keeps both histories honest.
//
// ── COST ────────────────────────────────────────────────────────────────────
//
// One synchronous localStorage write of a few KB, made once at the end of a
// match / session — the moment the report card goes up and no ball is in
// play. Nothing here runs per frame, and nothing here may throw into the
// game: every entry point swallows storage failures.

const STORAGE_KEY = 'sportyxr.progress';
const VERSION = 1;
export const MAX_ENTRIES = 100;
export const TREND_POINTS = 10;

export const KINDS = Object.freeze({ AI: 'ai', TRAINING: 'training' });

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((e) => e && (e.kind === KINDS.AI || e.kind === KINDS.TRAINING));
  } catch (e) {
    return [];
  }
}

function save(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, entries }));
    return true;
  } catch (e) {
    return false;
  }
}

function append(entry) {
  const entries = loadProgress();
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
  return save(entries);
}

/**
 * A finished AI match. `stats` is getStats() from js/modes/matchStats.js.
 * @returns {boolean} whether the write landed
 */
export function recordAiMatch({ difficulty, won, playerGames, aiGames, stats }, dateMs = Date.now()) {
  const s = stats || {};
  return append({
    kind: KINDS.AI,
    date: dateMs,
    difficulty: String(difficulty || 'beginner'),
    won: !!won,
    playerGames: num(playerGames),
    aiGames: num(aiGames),
    shots: num(s.shots),
    accuracyPct: num(s.accuracyPct),
    maxSpeedKmh: Math.round(num(s.maxSpeedKmh)),
    topSpinPct: num(s.topSpinPct),
    durationMs: num(s.durationMs),
  });
}

/**
 * A finished full Training Session (focus runs are practice, not recorded).
 * `report` is SessionModel.report() from js/modes/training/session.js.
 */
export function recordTraining({ level, levelLabel, score, depth, bestStreak, weakestLabel }, dateMs = Date.now()) {
  return append({
    kind: KINDS.TRAINING,
    date: dateMs,
    level: String(level || 'beginner'),
    levelLabel: String(levelLabel || level || ''),
    score: num(score),
    depth: depth == null ? null : num(depth),
    bestStreak: num(bestStreak),
    weakestLabel: weakestLabel ? String(weakestLabel) : null,
  });
}

export function clearProgress() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to do */ }
}

/**
 * Everything the start page shows, derived from the stored entries. Pure, so
 * the view stays dumb and this stays testable.
 */
export function summarizeProgress(entries = loadProgress()) {
  const ai = entries.filter((e) => e.kind === KINDS.AI);
  const tr = entries.filter((e) => e.kind === KINDS.TRAINING);

  let aiView = null;
  if (ai.length) {
    const last = ai[ai.length - 1];
    const prev = ai.length > 1 ? ai[ai.length - 2] : null;
    aiView = {
      played: ai.length,
      won: ai.filter((e) => e.won).length,
      lastAccuracy: last.accuracyPct,
      accuracyDelta: prev ? last.accuracyPct - prev.accuracyPct : null,
      bestSpeedKmh: Math.max(...ai.map((e) => e.maxSpeedKmh)),
      accuracyTrend: ai.slice(-TREND_POINTS).map((e) => e.accuracyPct),
    };
  }

  let trainingView = null;
  if (tr.length) {
    const last = tr[tr.length - 1];
    // Scores are only comparable within a level, so best and trend follow the
    // level the player last trained at.
    const sameLevel = tr.filter((e) => e.level === last.level);
    trainingView = {
      played: tr.length,
      level: last.level,
      levelLabel: last.levelLabel,
      lastScore: last.score,
      bestScore: Math.max(...sameLevel.map((e) => e.score)),
      weakestLabel: last.weakestLabel,
      scoreTrend: sameLevel.slice(-TREND_POINTS).map((e) => e.score),
    };
  }

  return {
    empty: entries.length === 0,
    ai: aiView,
    training: trainingView,
    recent: entries.slice(-5).reverse(),
  };
}
