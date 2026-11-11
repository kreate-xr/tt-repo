// In-session side of paid-play metering (functions/src/playtime.js is the
// server side). The file keeps its name from the free-trial days; there is
// no trial any more, and the free version is never metered — js/modes/
// inGame.js only creates this clock for a full-version player.
//
// While the player is actually PLAYING — free play or a drill / match, with
// the XR session visible — this holds a short lease from the backend and
// renews it before it runs out. Menus, the tuner and a hidden session stop
// the clock with an explicit `end`, so they cost nothing.
//
// An answer that says the account is NOT entitled (the unlock was refunded,
// or the cached tier was stale) just stops the clock: the free version has
// nothing to meter. A network error or a 5xx retries.
//
// PAID, WHILE A REFUND IS STILL POSSIBLE: FAIL-CLOSED. The refund rule reads
// the play time the server metered, and the server only meters what it hears
// about — so play the server cannot see (offline, say) may not go on for
// long. Once play has gone OFFLINE_GRACE_MS without a lease the server
// granted, onBlocked fires and the session ends. The unmetered time is kept
// through `offlineStore` (localStorage in the game), so leaving and
// re-entering does not start a fresh allowance; only a successful call clears
// it. The server answers `metered: false` once no refund is possible any more
// (3 days, 2 h, or the one refund used), and from then on nothing is metered
// and nothing can interrupt play.
//
// Pure: the API call, the clock, the timers and the store are injected, so
// the whole lease lifecycle runs under Jest with fake time.

const RENEW_MARGIN_MS = 10_000;
const RETRY_MS = 10_000;
export const OFFLINE_GRACE_MS = 120_000;
const WATCH_MS = 5_000;

/**
 * @param {object} deps
 * @param {(action: 'start'|'renew'|'end') => Promise<{entitled: boolean, metered?: boolean, leaseSec: number|null}>} deps.lease
 * @param {() => void} [deps.onBlocked]  called once: paid play went unmetered too long
 * @param {boolean} [deps.metered]  last /api/me answer, so a session that starts
 *        offline fails closed before any lease call has answered
 * @param {{ get: () => number, set: (ms: number) => void }} [deps.offlineStore]
 * @param {() => number} [deps.now]
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 * @param {(msg: string, err?: any) => void} [deps.log]
 */
export function createTrialClock({
  lease,
  onBlocked = () => {},
  metered: meteredHint = false,
  offlineStore = { get: () => 0, set: () => {} },
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  log = () => {},
}) {
  let playing = false;
  let done = false;      // settled (nothing to meter) or blocked: the clock never runs again
  let blocked = false;
  let settled = false;   // the server said there is nothing to meter
  let timer = null;
  // Paid-play metering (fail-closed) state.
  let metered = !!meteredHint;
  let coveredUntil = 0;  // end of the last lease the server granted (local clock)
  let lastAccrue = null;
  let unmeteredMs = Math.max(0, Number(offlineStore.get()) || 0);
  let watch = null;
  // Calls are strictly ordered (start → renew… → end) so the server never
  // sees an `end` overtaken by the `renew` it was meant to follow.
  let chain = Promise.resolve();

  function cancelTimer() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  function schedule(ms, action) {
    cancelTimer();
    timer = setTimer(() => { timer = null; send(action); }, ms);
  }

  function setUnmetered(ms) {
    unmeteredMs = ms;
    try { offlineStore.set(ms); } catch { /* storage unavailable: per session only */ }
  }

  // Adds the play since the last look that no granted lease covers.
  function accrue() {
    const t = now();
    if (playing && metered && !done && lastAccrue !== null) {
      const from = Math.max(lastAccrue, coveredUntil);
      if (t > from) setUnmetered(unmeteredMs + (t - from));
    }
    lastAccrue = t;
  }

  function stopWatch() {
    if (watch !== null) { clearTimer(watch); watch = null; }
  }

  // Independent of the call chain, so a request that hangs still counts.
  function startWatch() {
    if (watch !== null || !metered || !playing || done) return;
    watch = setTimer(() => {
      watch = null;
      accrue();
      if (unmeteredMs >= OFFLINE_GRACE_MS) block();
      else startWatch();
    }, WATCH_MS);
  }

  function block() {
    if (blocked) return;
    blocked = true;
    done = true;
    playing = false;
    cancelTimer();
    stopWatch();
    onBlocked();
  }

  function handle(action, res) {
    if (done) return;
    // Any answer proves the server is reachable.
    accrue();
    setUnmetered(0);
    if (res.entitled && res.metered) {
      // Paid, refund still possible: keep metering, fail closed.
      metered = true;
      if (action === 'end') return;
      coveredUntil = now() + (res.leaseSec || 0) * 1000;
      if (playing) {
        schedule(Math.max(1000, res.leaseSec * 1000 - RENEW_MARGIN_MS), 'renew');
        startWatch();
      }
      return;
    }
    // Paid and past any refund, or not paid at all: nothing to meter, now or
    // later in this session.
    metered = false;
    stopWatch();
    settled = true;
    done = true;
    cancelTimer();
  }

  // `final`: the closing `end` from dispose(), which must go out even though
  // the clock is already marked done by the time the chain reaches it.
  function send(action, final = false) {
    chain = chain.then(async () => {
      if (done && !final) return;
      if (final && (settled || blocked)) return;
      // A queued renew that lost a race with setPlaying(false) has nothing to do.
      if (action === 'renew' && !playing) return;
      try {
        handle(action, await lease(action));
      } catch (err) {
        log(`[meter] ${action} failed — retrying`, err);
        if (playing && action !== 'end') schedule(RETRY_MS, action === 'start' ? 'start' : 'renew');
      }
    });
    return chain;
  }

  return {
    /** Play started or stopped (menus, tuner, hidden session, end of XR). */
    setPlaying(next) {
      if (done || next === playing) return chain;
      accrue();
      playing = next;
      cancelTimer();
      if (next) startWatch();
      else stopWatch();
      return send(next ? 'start' : 'end');
    },
    /** End of the XR session: stop the clock and settle the bill. */
    dispose() {
      accrue();
      const wasPlaying = playing;
      playing = false;
      cancelTimer();
      stopWatch();
      const settle = wasPlaying && !done;
      done = true;
      if (settle) send('end', true);
      return chain;
    },
    get blocked() { return blocked; },
    get running() { return playing && !done; },
    /** Test seam: resolves once every queued call has settled. */
    _settled: () => chain,
  };
}
