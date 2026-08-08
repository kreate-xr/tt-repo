// Slice 4 — training event log. Powers M7 Review & Stats, M10's curriculum
// tuner and the M2 ladders.

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
  EventLog, EVENT_TYPES, OUTCOMES, MAX_SESSIONS,
  appendSession, loadSessions, clearSessions, trend,
} = require('../js/profile/eventLog.js');

beforeEach(() => {
  globalThis.localStorage.clear();
  globalThis.localStorage.failNextWrite = false;
});

const feedStub = (over = {}) => ({
  config: { spinType: 'top', speed: 9, placement: { kind: 'zone', zone: 5 } },
  commandedLanding: { x: 0.1, z: 1.0 },
  verifiedLanding: { x: 0.104, z: 1.002 },
  feasible: true,
  ...over,
});

describe('timestamps', () => {
  test('event t is driven by tick, never a wall clock', () => {
    // M11 requires headless vr/ar runs to produce identical logs; Date.now()
    // in the compared surface would make that impossible.
    const log = new EventLog();
    log.tick(0.5);
    const a = log.append(EVENT_TYPES.FEED, {});
    log.tick(0.25);
    const b = log.append(EVENT_TYPES.FEED, {});
    expect(a.t).toBe(500);
    expect(b.t).toBe(750);
  });

  test('two logs driven by identical ticks produce identical events', () => {
    const run = () => {
      const log = new EventLog({ sessionId: 'fixed', drillId: 'm1' });
      for (let i = 0; i < 10; i++) {
        log.tick(0.1);
        log.recordFeed(feedStub(), i);
        log.recordOutcome(i % 3 === 0 ? OUTCOMES.MISS : OUTCOMES.RETURNED, { zone: 5, spin: 'top' });
      }
      return log.events;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  test('no event carries a wall-clock field', () => {
    const log = new EventLog();
    log.tick(1);
    log.recordFeed(feedStub(), 0);
    log.recordContact({ localX: 0.01, localY: -0.02 });
    log.recordOutcome(OUTCOMES.RETURNED, { zone: 3 });
    const keys = new Set(log.events.flatMap((e) => Object.keys(e)));
    for (const banned of ['date', 'timestamp', 'wallClock', 'now']) {
      expect(keys.has(banned)).toBe(false);
    }
  });
});

describe('appending', () => {
  test('typed appenders record the fields M7 needs', () => {
    const log = new EventLog();
    log.recordFeed(feedStub(), 7);
    const e = log.events[0];
    expect(e.type).toBe(EVENT_TYPES.FEED);
    expect(e.i).toBe(7);
    expect(e.spin).toBe('top');
    expect(e.zone).toBe(5);
    expect(e.feasible).toBe(true);
  });

  test('a feed with no verified landing is recorded, not dropped', () => {
    const log = new EventLog();
    log.recordFeed(feedStub({ verifiedLanding: null, feasible: false }), 1);
    expect(log.events[0].vx).toBeNull();
    expect(log.events[0].feasible).toBe(false);
  });

  test('contact points are stored in paddle-local coordinates', () => {
    // World coordinates would be useless the moment the player moves.
    const log = new EventLog();
    log.recordContact({ localX: 0.012, localY: -0.021, stroke: 'loop' });
    expect(log.contactPoints()).toEqual([{ x: 0.012, y: -0.021, stroke: 'loop' }]);
  });

  test('the cap drops new events and counts them rather than growing', () => {
    const log = new EventLog({ maxEvents: 5 });
    for (let i = 0; i < 20; i++) log.append(EVENT_TYPES.FEED, { i });
    expect(log.events).toHaveLength(5);
    expect(log.dropped).toBe(15);
    // Oldest kept: dropping the newest preserves the early session, which is
    // what the ladders reason about.
    expect(log.events[0].i).toBe(0);
  });
});

describe('selectors', () => {
  const build = () => {
    const log = new EventLog();
    // zone 4: 3 attempts, 2 failures. zone 6: 2 attempts, 0 failures.
    log.recordOutcome(OUTCOMES.MISS, { zone: 4, spin: 'back' });
    log.recordOutcome(OUTCOMES.ERROR, { zone: 4, spin: 'back' });
    log.recordOutcome(OUTCOMES.RETURNED, { zone: 4, spin: 'top' });
    log.recordOutcome(OUTCOMES.RETURNED, { zone: 6, spin: 'top' });
    log.recordOutcome(OUTCOMES.RETURNED, { zone: 6, spin: 'top' });
    return log;
  };

  test('returnRate counts misses and errors as failures', () => {
    expect(build().returnRate()).toBeCloseTo(3 / 5, 6);
  });

  test('outcomeCounts separates miss from error', () => {
    // They prescribe different drills, so collapsing them loses the signal.
    expect(build().outcomeCounts()).toEqual({ returned: 3, miss: 1, error: 1 });
  });

  test('errorsByZone reports per-zone rates', () => {
    const z = build().errorsByZone();
    expect(z.get(4)).toEqual({ attempts: 3, failures: 2, rate: 2 / 3 });
    expect(z.get(6)).toEqual({ attempts: 2, failures: 0, rate: 0 });
  });

  test('zones with no attempts are omitted, not reported as 0% failure', () => {
    // Reporting an untried zone as a strength would mislead the weakness
    // report into never prescribing it.
    const z = build().errorsByZone();
    expect(z.has(1)).toBe(false);
    expect(z.has(9)).toBe(false);
  });

  test('errorsBySpin groups independently of zone', () => {
    const s = build().errorsBySpin();
    expect(s.get('back')).toEqual({ attempts: 2, failures: 2, rate: 1 });
    expect(s.get('top').failures).toBe(0);
  });

  test('an empty log yields zeros rather than NaN', () => {
    const log = new EventLog();
    expect(log.returnRate()).toBe(0);
    expect(log.placementSigma()).toBe(0);
    expect(log.longestRally()).toBe(0);
    expect(log.meanContactOffset()).toBeNull();
    expect(log.feedCount).toBe(0);
  });

  test('placementSigma measures spread of the feed error', () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.recordFeed(feedStub(), i);
    // Identical feeds → zero spread.
    expect(log.placementSigma()).toBeCloseTo(0, 6);
  });

  test('meanContactOffset keeps sign so "2 cm low" stays directional', () => {
    const log = new EventLog();
    log.recordContact({ localX: 0, localY: -0.02, stroke: 'loop' });
    log.recordContact({ localX: 0, localY: -0.02, stroke: 'loop' });
    const off = log.meanContactOffset('loop');
    expect(off.y).toBeCloseTo(-0.02, 6);
    expect(off.n).toBe(2);
  });

  test('meanContactOffset filters by stroke', () => {
    const log = new EventLog();
    log.recordContact({ localX: 0, localY: -0.05, stroke: 'loop' });
    log.recordContact({ localX: 0, localY: 0.05, stroke: 'push' });
    expect(log.meanContactOffset('loop').y).toBeCloseTo(-0.05, 6);
    expect(log.meanContactOffset('push').y).toBeCloseTo(0.05, 6);
  });

  test('longestRally takes the max', () => {
    const log = new EventLog();
    log.recordOutcome(OUTCOMES.MISS, { rallyLength: 4 });
    log.recordOutcome(OUTCOMES.MISS, { rallyLength: 11 });
    log.recordOutcome(OUTCOMES.MISS, { rallyLength: 2 });
    expect(log.longestRally()).toBe(11);
  });
});

describe('summary', () => {
  test('is JSON-serialisable and bounded', () => {
    const log = new EventLog({ sessionId: 's1', drillId: 'm1BallMachine' });
    log.tick(60);
    for (let i = 0; i < 30; i++) {
      log.recordFeed(feedStub(), i);
      log.recordOutcome(i % 4 === 0 ? OUTCOMES.MISS : OUTCOMES.RETURNED,
        { zone: 5, spin: 'top' });
    }
    const s = log.summary();
    expect(() => JSON.stringify(s)).not.toThrow();
    expect(s.feeds).toBe(30);
    expect(s.durationMs).toBe(60000);
    expect(s.returnRate).toBeGreaterThan(0);
    // A summary must not embed the raw events — that is the whole point.
    expect(s.events).toBeUndefined();
  });

  test('records dropped events so truncation is never silent', () => {
    const log = new EventLog({ maxEvents: 3 });
    for (let i = 0; i < 10; i++) log.append(EVENT_TYPES.FEED, { i });
    expect(log.summary().droppedEvents).toBe(7);
  });
});

describe('session history', () => {
  const summaryFor = (rate) => ({ returnRate: rate, feeds: 10, drillId: 'm1' });

  test('append then load round-trips', () => {
    appendSession(summaryFor(0.8), 1000);
    const sessions = loadSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].returnRate).toBe(0.8);
    expect(sessions[0].date).toBe(1000);
  });

  test(`keeps at most ${MAX_SESSIONS}, dropping the oldest`, () => {
    for (let i = 0; i < MAX_SESSIONS + 10; i++) appendSession(summaryFor(i / 100), i);
    const sessions = loadSessions();
    expect(sessions).toHaveLength(MAX_SESSIONS);
    // Oldest dropped: the newest 30 survive.
    expect(sessions[sessions.length - 1].date).toBe(MAX_SESSIONS + 9);
    expect(sessions[0].date).toBe(10);
  });

  test('history lives under its own key, not the profile blob', () => {
    // Riding along on profile writes would make every settings change
    // progressively more expensive.
    appendSession(summaryFor(0.5), 1);
    expect(globalThis.localStorage.getItem('p15.sessions')).toBeTruthy();
    expect(globalThis.localStorage.getItem('p15.profile')).toBeNull();
  });

  test('a storage failure is reported, not thrown', () => {
    globalThis.localStorage.failNextWrite = true;
    const res = appendSession(summaryFor(0.5), 1);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('storage');
  });

  test('corrupt history loads as empty rather than throwing', () => {
    globalThis.localStorage.setItem('p15.sessions', '{broken');
    expect(loadSessions()).toEqual([]);
  });

  test('a future-version history is ignored', () => {
    globalThis.localStorage.setItem('p15.sessions',
      JSON.stringify({ version: 99, sessions: [summaryFor(1)] }));
    expect(loadSessions()).toEqual([]);
  });

  test('trend extracts a rolling numeric series', () => {
    appendSession(summaryFor(0.5), 1);
    appendSession(summaryFor(0.7), 2);
    appendSession(summaryFor(0.9), 3);
    expect(trend('returnRate')).toEqual([0.5, 0.7, 0.9]);
  });

  test('trend skips sessions missing the field', () => {
    appendSession({ feeds: 5 }, 1);
    appendSession(summaryFor(0.6), 2);
    expect(trend('returnRate')).toEqual([0.6]);
  });

  test('clearSessions empties the history', () => {
    appendSession(summaryFor(0.5), 1);
    clearSessions();
    expect(loadSessions()).toEqual([]);
  });
});
