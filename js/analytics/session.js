// Beta session analytics — ONE Firestore document per play session.
//
// Deliberately not an event bus. The beta ships on a public link, so the
// players who hit something broken are exactly the ones who will never tell us
// about it; what we need back is a funnel (where did they stop?) and enough
// context to debug a failure we cannot reproduce. That is one small document,
// not a stream.
//
// ── WHY TWO WRITES ──────────────────────────────────────────────────────────
//
// The doc is CREATED at XR session start and UPDATED once at session end.
// Taking a headset off kills the tab, and a Firestore write queued during
// teardown may never flush — so an end-only design loses precisely the
// sessions that ended badly, which are the ones worth reading. Creating at
// start means a lost end-write still records that a session began, and
// "started but never ended" is itself the strongest signal in the funnel.
//
// ── SHAPE ───────────────────────────────────────────────────────────────────
//
//   sessions/{uid}/runs/{runId}
//     created: startedAt, xrMode, ua, screen, appVersion
//     updated: endedAt, durationMs, milestones{}, match{}, net{}, errors[]
//
// milestones is a MAP of name → ms-since-page-load, not a list of events: it
// validates in one `is map` check, queries without unpacking, and is a
// fraction of the size.
//
// ── CONTRACT ────────────────────────────────────────────────────────────────
//
// Nothing here may throw into the game loop or reject an unhandled promise.
// Analytics failing is not a reason for a player's match to fail, so every
// entry point swallows and every network call is fire-and-forget.

import { getTraceSummary } from '../network/connectTrace.js';

// Bounds. A runaway loop must not turn one session into a megabyte of writes,
// and firestore.rules caps these server-side too — keep the two in step.
const MAX_ERRORS = 20;
const MAX_STACK_CHARS = 2000;
const MAX_MSG_CHARS = 500;

// Injected by vite.config.js `define`. Absent under Jest and in any consumer
// that imports this module outside a Vite build, hence the typeof guard.
const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

const nowMs = () =>
  (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

// Page-load origin for every milestone. Module evaluation is close enough to
// load for a funnel measured in seconds, and it needs no listener.
const originMs = nowMs();

const milestones = Object.create(null);
const errors = [];
// Errors repeat — a broken render path throws once per frame. Dedupe by
// message so one bug cannot consume the whole MAX_ERRORS budget.
const seenErrors = new Set();

let runDoc = null;      // { ref, fs } once created
let beginPromise = null;
let ended = false;
let disabled = false;   // set when Firebase is unusable; makes every call a no-op

// Filled by the game modes as a match plays out. A registry rather than an
// argument threaded through inGame.js: aiMatch and multiplayer already own
// these numbers and both end in a report, while inGame.js has no view of
// either. Keeps the wiring to one import and one call per mode.
let matchSummary = null;
let netSource = null;

/**
 * The finished match's stats — getStats() from js/modes/matchStats.js. Called
 * by both modes as they raise the end-of-match card, which is also the moment
 * the funnel's last milestone is true.
 */
export function setMatchSummary(stats) {
  if (!stats || typeof stats !== 'object') return;
  mark('matchComplete');
  matchSummary = stats;
}

/**
 * Register a getter for live network health, read once at session end.
 * A getter, not a snapshot: the interesting values (rtt, thermal state) are
 * the ones current when the session ended, not when multiplayer started.
 *
 * @param {() => ({telemetry?: object, thermalThrottled?: boolean, connectFailed?: boolean})} fn
 */
export function setNetSource(fn) {
  netSource = typeof fn === 'function' ? fn : null;
}

/** The last finished match, for the post-session card's summary line. */
export function getMatchSummary() {
  return matchSummary ? { ...matchSummary } : null;
}

/** Milestone timestamp, ms since page load. First write for a name wins. */
export function mark(name) {
  if (!name || name in milestones) return;
  milestones[name] = Math.round(nowMs() - originMs);
}

/** @returns {object} a copy — callers must not mutate the live map. */
export function getMilestones() {
  return { ...milestones };
}

/**
 * One captured error. Fed by the global handlers in js/main.js and by any
 * catch that wants the failure on the record.
 */
export function recordError(err, source = 'window') {
  try {
    const msg = String(
      (err && (err.message || err.reason || err)) || 'unknown'
    ).slice(0, MAX_MSG_CHARS);
    if (seenErrors.has(msg)) return;
    if (errors.length >= MAX_ERRORS) return;
    seenErrors.add(msg);
    const stack = err && err.stack ? String(err.stack).slice(0, MAX_STACK_CHARS) : '';
    errors.push({
      msg,
      stack,
      source: String(source).slice(0, 40),
      atMs: Math.round(nowMs() - originMs),
    });
  } catch {
    // A throwing toString on the error object is not worth a second failure.
  }
}

export function getErrors() {
  return errors.slice();
}

/** Test seam + re-entry: a second XR session in one page load is a new run. */
export function resetSession() {
  resetRun();
  matchSummary = null;
  netSource = null;
}

// Run-scoped state only. Errors are cleared with it because they have already
// been written into the run document they belong to — carrying them into the
// NEXT run's document would double-count every one of them.
function resetRun() {
  runDoc = null;
  beginPromise = null;
  ended = false;
  errors.length = 0;
  seenErrors.clear();
}

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    }
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function deviceInfo() {
  const out = {};
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      out.ua = String(navigator.userAgent).slice(0, 300);
    }
    if (typeof screen !== 'undefined' && screen.width) {
      out.screen = `${screen.width}x${screen.height}`;
    }
  } catch { /* headless */ }
  return out;
}

/**
 * Create the run document. Fire-and-forget: callers do not await it, and the
 * returned promise never rejects.
 *
 * This is also where ensureAnonymousAuth() first fires for a SOLO player —
 * before this, only multiplayer minted a uid. Call it AFTER the session is
 * live (js/modes/inGame.js), never at page load: the identitytoolkit round
 * trip belongs off the entry critical path.
 *
 * @param {{xrMode?: string}} opts
 */
export function beginSession({ xrMode = null } = {}) {
  if (disabled || beginPromise) return beginPromise || Promise.resolve();
  mark('sessionStart');

  beginPromise = (async () => {
    // Both lazy so the Firebase SDK stays out of the entry chunk, matching how
    // js/modes/inGame.js already defers LobbyManager.
    const [{ ensureAnonymousAuth, getDb }, fs] = await Promise.all([
      import('../network/firebaseClient.js'),
      import('firebase/firestore'),
    ]);
    const user = await ensureAnonymousAuth();
    const ref = fs.doc(getDb(), 'sessions', user.uid, 'runs', randomId());
    await fs.setDoc(ref, {
      startedAt: fs.serverTimestamp(),
      xrMode: xrMode ? String(xrMode).slice(0, 20) : 'unknown',
      appVersion: String(APP_VERSION).slice(0, 40),
      ...deviceInfo(),
    });
    runDoc = { ref, fs };
  })().catch((err) => {
    // A missing VITE_FIREBASE_* or a blocked identitytoolkit means analytics
    // are simply off for this page load. Not worth a second attempt per
    // session, and definitely not worth surfacing to the player.
    disabled = true;
    console.warn('[analytics] session start not recorded:', (err && err.code) || (err && err.message));
  });

  return beginPromise;
}

/** The `net` block: WebRTC health plus, on a failed join, the phase timings. */
function netBlock({ telemetry = null, thermalThrottled = null, connectFailed = false } = {}) {
  const net = {};
  if (telemetry && typeof telemetry === 'object') {
    for (const k of ['rtt', 'jitter', 'packetsLost', 'connectionType',
                     'ballCorrectionP95', 'snapsPerMinute', 'handoffAdoptMs']) {
      const v = telemetry[k];
      if (v !== undefined && v !== null) net[k] = v;
    }
  }
  if (thermalThrottled !== null) net.thermalThrottled = !!thermalThrottled;
  // The phase breakdown is the whole point of collecting connectTrace
  // unconditionally: a stranger's join that stalled at ICE on unknown Wi-Fi is
  // otherwise undebuggable. Only attached on failure — a successful join's
  // timings are noise at one doc per session.
  if (connectFailed) {
    try {
      const t = getTraceSummary();
      if (t && (t.phases.length || t.boot.length)) {
        net.connectFailed = true;
        net.trace = t;
      }
    } catch { /* tracing must never break the write */ }
  }
  return net;
}

/**
 * Close the run out. Safe to call more than once — only the first lands, so
 * the XR 'end' handler and the pagehide fallback can both call it.
 *
 * @param {object} payload
 * @param {object} [payload.match]  getStats() from js/modes/matchStats.js
 * @param {object} [payload.training]  summary() from js/profile/eventLog.js
 * @param {object} [payload.telemetry]  TelemetryReporter.lastMetrics
 * @param {boolean} [payload.thermalThrottled]
 * @param {boolean} [payload.connectFailed]
 */
export function endSession(payload = {}) {
  if (disabled || ended) return Promise.resolve();
  ended = true;
  mark('sessionEnd');

  return (async () => {
    // The create may still be in flight when a player exits fast; without this
    // the update races it and fails on a document that does not exist yet.
    if (beginPromise) await beginPromise;
    if (!runDoc) return;
    const { ref, fs } = runDoc;

    // Registered sources first, explicit payload wins — so a caller with
    // better information at teardown can always override.
    let net = {};
    try {
      net = { ...(netSource ? netSource() : {}), ...payload };
    } catch { net = { ...payload }; }

    const update = {
      endedAt: fs.serverTimestamp(),
      durationMs: Math.max(0, Math.round(nowMs() - originMs)),
      milestones: getMilestones(),
      net: netBlock(net),
    };
    const match = payload.match || matchSummary;
    if (match) update.match = match;
    if (payload.training) update.training = payload.training;
    if (errors.length) update.errors = errors.slice(0, MAX_ERRORS);

    await fs.updateDoc(ref, update);
    // Leaving XR and going straight back in is a normal thing to do, and it is
    // a SECOND session — clearing the run state here is what lets the next
    // beginSession() open its own document instead of silently no-opping.
    // matchSummary deliberately survives: the post-session card reads it.
    resetRun();
  })().catch((err) => {
    console.warn('[analytics] session end not recorded:', (err && err.code) || (err && err.message));
  });
}

/**
 * A multiplayer join that never connected — its own one-shot document.
 *
 * The lobby negotiates BEFORE the player enters XR (see js/ui/overlay.js), so
 * a failed join never reaches beginSession() and would otherwise vanish
 * entirely. It is also the single most valuable thing to capture: nobody can
 * reproduce a stranger's headset failing to connect over a hotel network, and
 * the connectTrace phase breakdown names which round trip stalled.
 *
 * Written and closed immediately, independent of the main run lifecycle, so a
 * player who retries and succeeds still gets a normal session doc.
 *
 * @param {'host'|'guest'} role
 * @param {Error} err
 */
export function recordJoinFailure(role, err) {
  if (disabled) return Promise.resolve();
  return (async () => {
    const [{ ensureAnonymousAuth, getDb }, fs] = await Promise.all([
      import('../network/firebaseClient.js'),
      import('firebase/firestore'),
    ]);
    const user = await ensureAnonymousAuth();
    const ref = fs.doc(getDb(), 'sessions', user.uid, 'runs', randomId());
    await fs.setDoc(ref, {
      startedAt: fs.serverTimestamp(),
      endedAt: fs.serverTimestamp(),
      xrMode: `lobby-${role}`,
      appVersion: String(APP_VERSION).slice(0, 40),
      durationMs: Math.max(0, Math.round(nowMs() - originMs)),
      milestones: getMilestones(),
      net: netBlock({ connectFailed: true }),
      errors: [{
        msg: String((err && (err.code || err.message)) || 'join failed').slice(0, MAX_MSG_CHARS),
        stack: '',
        source: 'lobby',
        atMs: Math.round(nowMs() - originMs),
      }],
      ...deviceInfo(),
    });
  })().catch((e) => {
    console.warn('[analytics] join failure not recorded:', (e && e.code) || (e && e.message));
  });
}

/**
 * Last-ditch flush. The XR 'end' handler is the primary path and fires while
 * the page is still alive; this only catches the case where the tab goes away
 * without it (headset removed, browser killed). visibilitychange is the
 * reliable signal on mobile-class browsers — 'unload' is not.
 */
export function installUnloadFlush() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const flush = () => {
    // Only meaningful if a run was actually opened and not already closed.
    if (beginPromise && !ended) endSession({});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
