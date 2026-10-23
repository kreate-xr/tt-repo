// Player progress history — the data behind the start page's "Your progress".

class MemoryStorage {
  constructor() { this._store = new Map(); this.failNextWrite = false; }
  getItem(k)    { return this._store.has(k) ? this._store.get(k) : null; }
  setItem(k, v) {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('quota'); }
    this._store.set(k, String(v));
  }
  removeItem(k) { this._store.delete(k); }
  clear()       { this._store.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const {
  KINDS, MAX_ENTRIES, TREND_POINTS,
  loadProgress, recordAiMatch, recordTraining, clearProgress, summarizeProgress,
} = require('../js/profile/progress.js');

const aiMatch = (accuracyPct, { won = true, maxSpeedKmh = 40, difficulty = 'beginner' } = {}) => ({
  difficulty, won, playerGames: won ? 2 : 1, aiGames: won ? 1 : 2,
  stats: { shots: 30, accuracyPct, maxSpeedKmh, topSpinPct: 20, durationMs: 300000 },
});

const training = (score, level = 'beginner') => ({
  level, levelLabel: level === 'player' ? 'Player' : 'Beginner',
  score, depth: 50, bestStreak: 6, weakestLabel: 'Spin',
});

beforeEach(() => {
  globalThis.localStorage.clear();
  globalThis.localStorage.failNextWrite = false;
});

describe('storage', () => {
  test('empty history summarizes as empty', () => {
    const v = summarizeProgress();
    expect(v.empty).toBe(true);
    expect(v.ai).toBeNull();
    expect(v.training).toBeNull();
    expect(v.recent).toEqual([]);
  });

  test('records an AI match with its stats and date', () => {
    expect(recordAiMatch(aiMatch(70, { maxSpeedKmh: 51.6 }), 1234)).toBe(true);
    const [e] = loadProgress();
    expect(e).toMatchObject({
      kind: KINDS.AI, date: 1234, difficulty: 'beginner', won: true,
      playerGames: 2, aiGames: 1, accuracyPct: 70, maxSpeedKmh: 52,
    });
  });

  test('keeps at most MAX_ENTRIES, dropping the oldest', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) recordTraining(training(i % 100), i);
    const entries = loadProgress();
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].date).toBe(5);
  });

  test('a failed write reports false and never throws', () => {
    globalThis.localStorage.failNextWrite = true;
    expect(recordAiMatch(aiMatch(50))).toBe(false);
    expect(loadProgress()).toEqual([]);
  });

  test('corrupt or foreign data loads as empty', () => {
    globalThis.localStorage.setItem('sportyxr.progress', '{broken');
    expect(loadProgress()).toEqual([]);
    globalThis.localStorage.setItem('sportyxr.progress', JSON.stringify({ version: 99, entries: [{}] }));
    expect(loadProgress()).toEqual([]);
  });

  test('clearProgress empties the history', () => {
    recordAiMatch(aiMatch(50));
    clearProgress();
    expect(loadProgress()).toEqual([]);
  });
});

describe('summary', () => {
  test('AI: record, accuracy delta vs previous match, best speed', () => {
    recordAiMatch(aiMatch(60, { won: false, maxSpeedKmh: 55 }), 1);
    recordAiMatch(aiMatch(68, { won: true, maxSpeedKmh: 48 }), 2);
    const { ai } = summarizeProgress();
    expect(ai).toMatchObject({
      played: 2, won: 1, lastAccuracy: 68, accuracyDelta: 8, bestSpeedKmh: 55,
    });
    expect(ai.accuracyTrend).toEqual([60, 68]);
  });

  test('AI: first match has no delta', () => {
    recordAiMatch(aiMatch(60), 1);
    expect(summarizeProgress().ai.accuracyDelta).toBeNull();
  });

  test('trend is capped at TREND_POINTS, newest last', () => {
    for (let i = 0; i < TREND_POINTS + 3; i++) recordAiMatch(aiMatch(i), i);
    const t = summarizeProgress().ai.accuracyTrend;
    expect(t).toHaveLength(TREND_POINTS);
    expect(t[t.length - 1]).toBe(TREND_POINTS + 2);
  });

  test('training best and trend follow the level last played', () => {
    recordTraining(training(90, 'beginner'), 1);
    recordTraining(training(55, 'player'), 2);
    recordTraining(training(62, 'player'), 3);
    const { training: tr } = summarizeProgress();
    expect(tr).toMatchObject({
      played: 3, level: 'player', lastScore: 62, bestScore: 62, weakestLabel: 'Spin',
    });
    expect(tr.scoreTrend).toEqual([55, 62]);
  });

  test('recent lists the last five, newest first, across both kinds', () => {
    for (let i = 0; i < 4; i++) recordAiMatch(aiMatch(50), i);
    recordTraining(training(70), 10);
    recordTraining(training(75), 11);
    const { recent } = summarizeProgress();
    expect(recent.map((e) => e.date)).toEqual([11, 10, 3, 2, 1]);
  });
});
