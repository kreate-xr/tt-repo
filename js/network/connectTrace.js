// Phase timing for the lobby handshake.
//
// A join is a chain of SERIAL round trips — anonymous auth, the room
// transaction, peerReady, offer, answer, ICE candidate exchange, DTLS — and a
// stall in any one of them looks identical from the menu: a "CONNECTING…"
// panel that just sits there. This records one timestamp per phase and dumps
// the deltas when the data channels open, so a slow join names its own culprit
// instead of needing a guess.
//
// OFF by default — opt in with ?trace=1, the same query-param convention the
// lag injector uses (see NetworkManager's parseLagSimFromLocation). Kept in
// the build rather than deleted because the joins worth diagnosing are the
// ones that only happen on a headset over someone else's Wi-Fi, where
// attaching a profiler is not an option and a redeploy to add logging back is
// the slow way round.
//
//   https://…/?trace=1     → phase timings in the console
const ENABLED = (() => {
  if (typeof location === 'undefined' || !location.search) return false;
  try { return new URLSearchParams(location.search).has('trace'); }
  catch { return false; }
})();

// Console output is what ?trace gates. COLLECTION is unconditional: a failed
// join on a stranger's Wi-Fi is exactly the case nobody thought to add ?trace
// to, and the arrays cost a handful of small objects per attempt. The session
// doc reads them back through getTraceSummary().
const marks = [];
let t0 = null;

// Work that happens BEFORE any attempt exists — the lazy lobby-chunk import,
// Firebase SDK construction, the speculative anonymous-auth warm. traceMark
// no-ops while t0 is null, so without this channel none of it is recordable,
// and it is exactly the part that differs between a cold first join and a
// warm one. Absolute performance.now(), page-lifetime (never cleared per
// attempt), dumped as its own table at traceEnd.
const bootMarks = [];

export function traceBoot(label, detail) {
  const atMs = performance.now();
  bootMarks.push({ label, atMs, detail });
  if (!ENABLED) return;
  console.info(`[connect] @${atMs.toFixed(0)}ms (boot) ${label}${detail ? `  ${detail}` : ''}`);
}

export function traceStart(label = 'start') {
  t0 = performance.now();
  marks.length = 0;
  traceMark(label);
}

export function traceMark(label, detail) {
  if (t0 === null) return; // no attempt in flight
  const atMs = performance.now() - t0;
  marks.push({ label, atMs, detail });
  if (!ENABLED) return;
  console.info(`[connect] +${atMs.toFixed(0)}ms  ${label}${detail ? `  ${detail}` : ''}`);
}

// Phase deltas as DATA, for js/analytics/session.js to attach to the session
// doc when a multiplayer connect fails. Safe to call at any point — mid-attempt
// (t0 still set) or after traceEnd, which leaves `marks` intact until the next
// traceStart. Rounded to whole ms; the sub-ms precision is noise over Wi-Fi and
// a shorter doc is a cheaper write.
export function getTraceSummary() {
  return {
    boot: bootMarks.map((m) => ({
      phase: m.label,
      atMs: Math.round(m.atMs),
      ...(m.detail ? { detail: String(m.detail) } : {}),
    })),
    phases: marks.map((m, i) => ({
      phase: m.label,
      sinceStartMs: Math.round(m.atMs),
      deltaMs: Math.round(m.atMs - (i ? marks[i - 1].atMs : 0)),
      ...(m.detail ? { detail: String(m.detail) } : {}),
    })),
    totalMs: marks.length ? Math.round(marks[marks.length - 1].atMs) : 0,
  };
}

export function traceEnd(label = 'connected') {
  if (t0 === null) return;
  traceMark(label);
  if (!ENABLED) { t0 = null; return; }
  // Boot table first: a negative msBeforeStart means the phase was still
  // running after the button press, i.e. the player waited on it.
  if (bootMarks.length) {
    const bootRows = bootMarks.map((m) => ({
      phase: m.label,
      msBeforeStart: Math.round(t0 - m.atMs),
      detail: m.detail || '',
    }));
    console.info('[connect] boot phases (before the button press)');
    if (console.table) console.table(bootRows);
    else console.info(bootRows);
  }
  const rows = marks.map((m, i) => ({
    phase: m.label,
    sinceStartMs: Math.round(m.atMs),
    // The delta column is the one that matters: the single biggest gap is the
    // phase to fix.
    deltaMs: Math.round(m.atMs - (i ? marks[i - 1].atMs : 0)),
    detail: m.detail || '',
  }));
  console.info(`[connect] TOTAL ${Math.round(marks[marks.length - 1].atMs)}ms`);
  if (console.table) console.table(rows);
  else console.info(rows);
  t0 = null;
}
