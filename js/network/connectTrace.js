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

const marks = [];
let t0 = null;

export function traceStart(label = 'start') {
  if (!ENABLED) return;
  t0 = performance.now();
  marks.length = 0;
  traceMark(label);
}

export function traceMark(label, detail) {
  if (!ENABLED || t0 === null) return; // disabled, or no attempt in flight
  const atMs = performance.now() - t0;
  marks.push({ label, atMs, detail });
  console.info(`[connect] +${atMs.toFixed(0)}ms  ${label}${detail ? `  ${detail}` : ''}`);
}

export function traceEnd(label = 'connected') {
  if (!ENABLED || t0 === null) return;
  traceMark(label);
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
