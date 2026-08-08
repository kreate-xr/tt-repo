// Training event log (Phase 0 slice 4) — the analytics sink behind M7 Review
// & Stats, M10's curriculum tuner, and the M2 progression ladders.
//
// ── WHY THIS IS NOT xr/contactLog.js (migration-plan D5) ────────────────────
//
// contactLog holds 40 entries and CLEARS on any calibration change. That is
// correct for its job — drift detection must not reason across a recalibration
// — and fatal for a session history, which is exactly the data a player would
// lose. Two different retention policies means two different sinks.
//
// ── STORAGE SHAPE ───────────────────────────────────────────────────────────
//
// Full-fidelity events live in memory for the CURRENT session only; what
// crosses a session boundary is a bounded summary. This is deliberate:
//
//   - M7 Session Replay and Why-Did-I-Miss need every event, but only for the
//     session you are looking at. Memory is the right store for that.
//   - M7 Trends needs 30 sessions, but only aggregates. Persisting every feed
//     of 30 sessions would grow without bound, and — because profile/store.js
//     rewrites its whole JSON blob on each write — appending an event per feed
//     to it would be quadratic. Summaries are written once per session.
//
// ── TIMESTAMPS ──────────────────────────────────────────────────────────────
//
// Event `t` is milliseconds since the log was created, never wall clock.
// M11 requires that a headless run in `vr` and `ar` produce identical logs
// bit-for-bit, which is impossible if Date.now() appears in the compared
// surface. Wall clock is recorded ONCE per session summary, outside the
// per-event data, so a session can still be dated for the Trends axis.

export const EVENT_TYPES = Object.freeze({
  FEED: 'feed',
  CONTACT: 'contact',
  BOUNCE: 'bounce',
  OUTCOME: 'outcome',
});

// Outcome verdicts. `miss` and `error` are distinct: a miss is "never touched
// it", an error is "touched it and put it wrong". M7's weakness report treats
// them differently — they prescribe different drills.
export const OUTCOMES = Object.freeze({
  RETURNED: 'returned',
  MISS: 'miss',
  ERROR: 'error',
});

const MAX_EVENTS = 20000;      // ~1.5 h of dense feeding; guards a runaway loop
export const MAX_SESSIONS = 30; // M7 Trends: "rolling 30-session graphs"

export class EventLog {
  constructor({ sessionId = null, drillId = null, maxEvents = MAX_EVENTS } = {}) {
    this.sessionId = sessionId;
    this.drillId = drillId;
    this.maxEvents = maxEvents;
    this.events = [];
    this.timeMs = 0;
    this.dropped = 0;
  }

  /**
   * Advance the log's clock. The caller drives this from the same dt the
   * physics uses, rather than the log reading a wall clock itself — that is
   * what keeps a replay reproducible and makes headless runs comparable.
   */
  tick(dt) {
    this.timeMs += dt * 1000;
  }

  append(type, payload = {}) {
    if (this.events.length >= this.maxEvents) {
      // Drop newest rather than shifting the array: the early part of a
      // session is what the ladders and weakness report care about, and
      // shifting would silently rewrite history the UI may already be showing.
      this.dropped++;
      return null;
    }
    const event = { t: Math.round(this.timeMs), type, ...payload };
    this.events.push(event);
    return event;
  }

  // --- Typed appenders ------------------------------------------------------
  // Named so call sites read as domain events and the payload shape is fixed
  // in one place rather than at each call.

  /** A ball was fed. `feed` is a FeedEngine solution. */
  recordFeed(feed, index) {
    return this.append(EVENT_TYPES.FEED, {
      i: index,
      spin: feed.config ? feed.config.spinType : null,
      speed: feed.config ? feed.config.speed : null,
      zone: feed.config && feed.config.placement ? feed.config.placement.zone ?? null : null,
      cx: round3(feed.commandedLanding ? feed.commandedLanding.x : null),
      cz: round3(feed.commandedLanding ? feed.commandedLanding.z : null),
      vx: round3(feed.verifiedLanding ? feed.verifiedLanding.x : null),
      vz: round3(feed.verifiedLanding ? feed.verifiedLanding.z : null),
      feasible: !!feed.feasible,
    });
  }

  /**
   * The player's paddle struck the ball. `local` is the contact point in
   * PADDLE-LOCAL coordinates — that is what M7's Blade Heatmap plots, and
   * storing it in world space would make it useless the moment the player
   * moves.
   */
  recordContact({ localX = null, localY = null, speed = null, stroke = null } = {}) {
    return this.append(EVENT_TYPES.CONTACT, {
      lx: round3(localX), ly: round3(localY), speed: round3(speed), stroke,
    });
  }

  recordBounce({ x = null, z = null, side = null } = {}) {
    return this.append(EVENT_TYPES.BOUNCE, { x: round3(x), z: round3(z), side });
  }

  recordOutcome(verdict, { zone = null, spin = null, rallyLength = null } = {}) {
    return this.append(EVENT_TYPES.OUTCOME, { verdict, zone, spin, rallyLength });
  }

  // --- Selectors ------------------------------------------------------------
  // Derived stats are computed on read rather than maintained incrementally.
  // Counters that must be kept in sync with an append path are a classic
  // source of drift, and these run on a menu screen, not the rally loop.

  byType(type) {
    return this.events.filter((e) => e.type === type);
  }

  get feedCount() { return this.byType(EVENT_TYPES.FEED).length; }

  outcomeCounts() {
    const counts = { returned: 0, miss: 0, error: 0 };
    for (const e of this.byType(EVENT_TYPES.OUTCOME)) {
      if (counts[e.verdict] !== undefined) counts[e.verdict]++;
    }
    return counts;
  }

  returnRate() {
    const c = this.outcomeCounts();
    const total = c.returned + c.miss + c.error;
    return total === 0 ? 0 : c.returned / total;
  }

  /**
   * Error rate per 3×3 placement zone — M7's weakness report, and the surface
   * M10's curriculum tuner resamples against.
   *
   * Returns a map of zone → {attempts, failures, rate}. Zones with no
   * attempts are omitted rather than reported as 0% failure, which would read
   * as a strength the player never demonstrated.
   */
  errorsByZone() {
    return groupFailures(this.byType(EVENT_TYPES.OUTCOME), (e) => e.zone);
  }

  errorsBySpin() {
    return groupFailures(this.byType(EVENT_TYPES.OUTCOME), (e) => e.spin);
  }

  /** Standard deviation of the feed's own placement error, in metres. */
  placementSigma() {
    const feeds = this.byType(EVENT_TYPES.FEED)
      .filter((e) => e.vx !== null && e.cx !== null);
    if (feeds.length === 0) return 0;
    const errs = feeds.map((e) => Math.hypot(e.vx - e.cx, e.vz - e.cz));
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const variance = errs.reduce((a, x) => a + (x - mean) ** 2, 0) / errs.length;
    return Math.sqrt(variance);
  }

  /** Contact points for M7's Blade Heatmap, in paddle-local coordinates. */
  contactPoints() {
    return this.byType(EVENT_TYPES.CONTACT)
      .filter((e) => e.lx !== null && e.ly !== null)
      .map((e) => ({ x: e.lx, y: e.ly, stroke: e.stroke }));
  }

  /**
   * Mean contact offset from the blade centre. M7 phrases this as "your loops
   * contact 2 cm low — try earlier timing", so the sign matters and must not
   * be collapsed into a distance.
   */
  meanContactOffset(stroke = null) {
    const pts = this.contactPoints().filter((p) => !stroke || p.stroke === stroke);
    if (pts.length === 0) return null;
    return {
      x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
      y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
      n: pts.length,
    };
  }

  longestRally() {
    return this.byType(EVENT_TYPES.OUTCOME)
      .reduce((best, e) => Math.max(best, e.rallyLength || 0), 0);
  }

  /** Bounded, serialisable roll-up. This is what crosses a session boundary. */
  summary() {
    const counts = this.outcomeCounts();
    return {
      sessionId: this.sessionId,
      drillId: this.drillId,
      durationMs: Math.round(this.timeMs),
      feeds: this.feedCount,
      returned: counts.returned,
      missed: counts.miss,
      errored: counts.error,
      returnRate: round3(this.returnRate()),
      placementSigma: round3(this.placementSigma()),
      longestRally: this.longestRally(),
      errorsByZone: rateMap(this.errorsByZone()),
      errorsBySpin: rateMap(this.errorsBySpin()),
      contactOffset: this.meanContactOffset(),
      droppedEvents: this.dropped,
    };
  }

  clear() {
    this.events.length = 0;
    this.timeMs = 0;
    this.dropped = 0;
  }
}

// --- helpers ----------------------------------------------------------------

function round3(v) {
  return (v === null || v === undefined || !Number.isFinite(v))
    ? null
    : Math.round(v * 1000) / 1000;
}

function groupFailures(outcomes, keyOf) {
  const out = new Map();
  for (const e of outcomes) {
    const key = keyOf(e);
    if (key === null || key === undefined) continue;
    if (!out.has(key)) out.set(key, { attempts: 0, failures: 0, rate: 0 });
    const bucket = out.get(key);
    bucket.attempts++;
    if (e.verdict !== OUTCOMES.RETURNED) bucket.failures++;
    bucket.rate = bucket.failures / bucket.attempts;
  }
  return out;
}

function rateMap(map) {
  const out = {};
  for (const [key, v] of map) {
    out[key] = { attempts: v.attempts, failures: v.failures, rate: round3(v.rate) };
  }
  return out;
}

// --- Session history --------------------------------------------------------
//
// Its own storage key, separate from p15.profile: the profile is rewritten on
// every settings change and every preset save, and a 30-session history riding
// along on those writes would make each one progressively more expensive.

const HISTORY_KEY = 'p15.sessions';
const HISTORY_VERSION = 1;

/**
 * Append a session summary, keeping at most MAX_SESSIONS (newest last).
 *
 * `dateMs` is the ONE place wall clock enters this module — it dates the
 * Trends axis and is supplied by the caller rather than read here, so a
 * headless parity run can pass a fixed value.
 */
export function appendSession(summary, dateMs = null) {
  const history = loadSessions();
  history.push({ ...summary, date: dateMs });
  while (history.length > MAX_SESSIONS) history.shift();
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify({
      version: HISTORY_VERSION,
      sessions: history,
    }));
    return { ok: true, count: history.length };
  } catch (e) {
    return { ok: false, reason: 'storage' };
  }
}

export function loadSessions() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== HISTORY_VERSION) return [];
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (e) {
    return [];
  }
}

export function clearSessions() {
  try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* nothing to do */ }
}

/** Rolling series for one summary field — M7 Trends. */
export function trend(field) {
  return loadSessions()
    .map((s) => (typeof s[field] === 'number' ? s[field] : null))
    .filter((v) => v !== null);
}
