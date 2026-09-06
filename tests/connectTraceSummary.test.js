// js/network/connectTrace.js — getTraceSummary(), and the change that makes
// it useful.
//
// connectTrace used to no-op entirely without ?trace, which meant the joins we
// most need to explain — a stranger's headset stalling on a network we have
// never seen — recorded nothing, because nobody adds a query param before
// hitting a bug. Collection is now unconditional; only the console output is
// still gated. These tests pin that down, since silently reverting to
// "collect only when ?trace" would leave the session doc's net.trace block
// permanently empty and nothing else would fail.

import {
  traceBoot, traceStart, traceMark, traceEnd, getTraceSummary,
} from '../js/network/connectTrace.js';

describe('getTraceSummary', () => {
  test('collects phases with NO ?trace in the URL', () => {
    // No jsdom in this project, so `location` is undefined and the ?trace
    // gate is off — which is exactly the production case for a player who
    // never added the param.
    traceStart('start');
    traceMark('anon auth');
    traceMark('room txn');
    const t = getTraceSummary();
    expect(t.phases.map((p) => p.phase)).toEqual(['start', 'anon auth', 'room txn']);
  });

  test('deltaMs is per-phase, sinceStartMs cumulative', () => {
    traceStart('start');
    traceMark('a');
    traceMark('b');
    const { phases } = getTraceSummary();
    for (const p of phases) {
      expect(p.deltaMs).toBeGreaterThanOrEqual(0);
      expect(p.sinceStartMs).toBeGreaterThanOrEqual(p.deltaMs);
    }
    // Cumulative timings never decrease along the chain.
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i].sinceStartMs).toBeGreaterThanOrEqual(phases[i - 1].sinceStartMs);
    }
  });

  test('traceStart clears the previous attempt — a retry is not appended', () => {
    traceStart('start');
    traceMark('first-attempt-only');
    traceStart('start');
    traceMark('second');
    const names = getTraceSummary().phases.map((p) => p.phase);
    expect(names).not.toContain('first-attempt-only');
    expect(names).toContain('second');
  });

  test('marks survive traceEnd, so the summary is readable after the fact', () => {
    traceStart('start');
    traceMark('offer');
    traceEnd('connected');
    const { phases, totalMs } = getTraceSummary();
    // This is the ordering the failure path depends on: the lobby catches,
    // then asks for the summary.
    expect(phases.map((p) => p.phase)).toContain('connected');
    expect(totalMs).toBeGreaterThanOrEqual(0);
  });

  test('a mark before any traceStart is ignored rather than mis-timed', () => {
    traceEnd('connected');       // clears t0
    traceMark('orphan');
    traceStart('start');
    expect(getTraceSummary().phases.map((p) => p.phase)).not.toContain('orphan');
  });

  test('boot marks are page-lifetime and carry their detail', () => {
    traceBoot('lobby chunk ready', 'detail-here');
    const { boot } = getTraceSummary();
    const found = boot.find((b) => b.phase === 'lobby chunk ready');
    expect(found).toBeTruthy();
    expect(found.detail).toBe('detail-here');
    expect(found.atMs).toBeGreaterThanOrEqual(0);
  });

  test('omits the detail key entirely when there is none — smaller documents', () => {
    traceStart('start');
    traceMark('no-detail');
    const p = getTraceSummary().phases.find((x) => x.phase === 'no-detail');
    expect(p).not.toHaveProperty('detail');
  });

  test('everything is a whole number — sub-ms precision is noise over Wi-Fi', () => {
    traceStart('start');
    traceMark('a');
    const { phases, totalMs } = getTraceSummary();
    for (const p of phases) {
      expect(Number.isInteger(p.deltaMs)).toBe(true);
      expect(Number.isInteger(p.sinceStartMs)).toBe(true);
    }
    expect(Number.isInteger(totalMs)).toBe(true);
  });

  test('totalMs is 0 with no phases rather than undefined', () => {
    traceStart('start');
    traceEnd('connected');
    // A fresh start with nothing after it still summarises cleanly.
    expect(typeof getTraceSummary().totalMs).toBe('number');
  });
});
