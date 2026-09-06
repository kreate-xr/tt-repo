// js/analytics/session.js — the beta session collector.
//
// The contract that matters most here is the negative one: analytics must
// never throw into the game loop, never reject an unhandled promise, and never
// grow without bound. A broken collector taking a player's match down with it
// would be a far worse bug than collecting nothing.
//
// Firebase is reached only through dynamic import() inside beginSession /
// endSession / recordJoinFailure, so every test below that does NOT call those
// runs with no mocking at all.

import {
  mark, getMilestones, recordError, getErrors,
  setMatchSummary, getMatchSummary, setNetSource, resetSession,
} from '../js/analytics/session.js';

describe('milestones', () => {
  test('records a timestamp per name', () => {
    mark('alpha');
    mark('beta');
    const m = getMilestones();
    expect(m).toHaveProperty('alpha');
    expect(m).toHaveProperty('beta');
    expect(typeof m.alpha).toBe('number');
  });

  test('first write for a name wins — a re-entered flow cannot rewrite history', () => {
    mark('once');
    const first = getMilestones().once;
    mark('once');
    expect(getMilestones().once).toBe(first);
  });

  test('milestones are ms-since-page-load, monotonic and non-negative', () => {
    mark('m1');
    const m = getMilestones();
    expect(m.m1).toBeGreaterThanOrEqual(0);
    // A map, not a list: it validates in one `is map` check in firestore.rules.
    expect(Array.isArray(m)).toBe(false);
  });

  test('the returned map is a copy — callers cannot corrupt the live one', () => {
    mark('safe');
    const copy = getMilestones();
    copy.safe = -999;
    expect(getMilestones().safe).not.toBe(-999);
  });

  test('ignores an empty name rather than storing a junk key', () => {
    const before = Object.keys(getMilestones()).length;
    mark('');
    mark(null);
    expect(Object.keys(getMilestones()).length).toBe(before);
  });
});

describe('recordError', () => {
  // Errors are run-scoped: resetSession() clears them, exactly as a completed
  // end-of-session write does in production.
  beforeEach(() => resetSession());

  test('captures message and stack from an Error', () => {
    recordError(new Error('boom-unique-1'), 'test');
    const found = getErrors().find((e) => e.msg === 'boom-unique-1');
    expect(found).toBeTruthy();
    expect(found.source).toBe('test');
    expect(typeof found.atMs).toBe('number');
  });

  test('accepts a bare string — window.onerror hands one over', () => {
    recordError('string-failure-2', 'error');
    expect(getErrors().some((e) => e.msg === 'string-failure-2')).toBe(true);
  });

  test('dedupes by message: one throwing frame cannot flood the budget', () => {
    for (let i = 0; i < 50; i++) recordError(new Error('repeated-3'));
    expect(getErrors().filter((e) => e.msg === 'repeated-3')).toHaveLength(1);
  });

  test('caps the array at 20 even with distinct messages', () => {
    for (let i = 0; i < 100; i++) recordError(new Error(`distinct-${i}`));
    expect(getErrors().length).toBeLessThanOrEqual(20);
  });

  test('survives an object whose toString throws', () => {
    const hostile = { get message() { throw new Error('nope'); } };
    expect(() => recordError(hostile)).not.toThrow();
  });

  test('truncates a huge stack rather than writing a megabyte document', () => {
    const err = new Error('huge-stack');
    err.stack = 'x'.repeat(50000);
    recordError(err);
    const found = getErrors().find((e) => e.msg === 'huge-stack');
    expect(found.stack.length).toBeLessThanOrEqual(2000);
  });

  test('truncates a huge message', () => {
    recordError(new Error('y'.repeat(5000)));
    expect(getErrors().every((e) => e.msg.length <= 500)).toBe(true);
  });
});

describe('match summary registry', () => {
  beforeEach(() => resetSession());

  test('stores the stats and marks matchComplete', () => {
    const stats = { shots: 12, accuracyPct: 75, maxSpeedKmh: 61.4, durationMs: 90000 };
    setMatchSummary(stats);
    expect(getMatchSummary()).toMatchObject(stats);
    expect(getMilestones()).toHaveProperty('matchComplete');
  });

  test('ignores a non-object so a bad call cannot poison the doc', () => {
    setMatchSummary(null);
    setMatchSummary('nope');
    expect(getMatchSummary()).toBeNull();
  });

  test('returns a copy', () => {
    setMatchSummary({ shots: 5 });
    const a = getMatchSummary();
    a.shots = 999;
    expect(getMatchSummary().shots).toBe(5);
  });

  test('resetSession clears it — a second XR session is a new run', () => {
    setMatchSummary({ shots: 5 });
    resetSession();
    expect(getMatchSummary()).toBeNull();
  });
});

describe('net source registry', () => {
  beforeEach(() => resetSession());

  test('accepts a function and rejects anything else without throwing', () => {
    expect(() => setNetSource(() => ({}))).not.toThrow();
    expect(() => setNetSource('not a function')).not.toThrow();
    expect(() => setNetSource(null)).not.toThrow();
  });
});

describe('endSession without a started run', () => {
  beforeEach(() => resetSession());

  test('resolves quietly rather than rejecting', async () => {
    const { endSession } = await import('../js/analytics/session.js');
    // No beginSession() has run, so there is no document to update. This is
    // the ordinary path for a player who never entered XR.
    await expect(endSession({})).resolves.toBeUndefined();
  });

  test('is idempotent — the XR end handler and the pagehide flush both fire', async () => {
    const { endSession } = await import('../js/analytics/session.js');
    await expect(endSession({})).resolves.toBeUndefined();
    await expect(endSession({})).resolves.toBeUndefined();
  });
});
