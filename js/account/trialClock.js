// In-session side of the free trial (functions/src/trial.js is the server
// side). While the player is actually PLAYING — free play or a drill / match,
// with the XR session visible — this holds a short lease from the backend and
// renews it before it runs out. Menus, the tuner and a hidden session stop the
// clock with an explicit `end`, so they cost nothing.
//
// FAIL-OPEN. Only a definitive answer from the server ends the trial: no
// lease left, or the per-network new-trial cap. A network error or a 5xx just
// retries — a backend outage must never kick a player (paid or not) out of a
// rally. The server bills real elapsed time on the next successful call, capped
// per lease, so an outage costs the player little and gains a cheater little.
//
// Pure: the API call, the clock and the timers are injected, so the whole
// lease lifecycle runs under Jest with fake time.

const RENEW_MARGIN_MS = 10_000;
const RETRY_MS = 10_000;
const WARN_AT_SEC = 60;

/**
 * @param {object} deps
 * @param {(action: 'start'|'renew'|'end') => Promise<{entitled: boolean, leaseSec: number|null, remainingSec: number|null}>} deps.lease
 * @param {(info: {reason: 'trial_over'|'ip_limit'}) => void} deps.onExpired  called once
 * @param {(remainingSec: number) => void} [deps.onWarn]  called once, near the end
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 * @param {(msg: string, err?: any) => void} [deps.log]
 */
export function createTrialClock({
  lease,
  onExpired,
  onWarn = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  log = () => {},
}) {
  let playing = false;
  let done = false;      // entitled or expired: the clock never runs again
  let expired = false;
  let warned = false;
  let entitledSeen = false;
  let timer = null;
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

  function expire(reason) {
    if (expired) return;
    expired = true;
    done = true;
    playing = false;
    cancelTimer();
    onExpired({ reason });
  }

  function handle(action, res) {
    if (done) return;
    if (res.entitled) {
      // Paid: nothing to meter, now or later in this session.
      entitledSeen = true;
      done = true;
      cancelTimer();
      return;
    }
    if (action === 'end') return;
    if (!res.leaseSec) {
      expire('trial_over');
      return;
    }
    if (!warned && res.remainingSec !== null && res.remainingSec <= WARN_AT_SEC) {
      warned = true;
      onWarn(res.remainingSec);
    }
    if (playing) schedule(Math.max(1000, res.leaseSec * 1000 - RENEW_MARGIN_MS), 'renew');
  }

  // `final`: the closing `end` from dispose(), which must go out even though
  // the clock is already marked done by the time the chain reaches it.
  function send(action, final = false) {
    chain = chain.then(async () => {
      if (done && !final) return;
      if (final && (expired || entitledSeen)) return;
      // A queued renew that lost a race with setPlaying(false) has nothing to do.
      if (action === 'renew' && !playing) return;
      try {
        handle(action, await lease(action));
      } catch (err) {
        if (err && err.code === 'trial_ip_limit') {
          expire('ip_limit');
          return;
        }
        log(`[trial] ${action} failed — retrying`, err);
        if (playing && action !== 'end') schedule(RETRY_MS, action === 'start' ? 'start' : 'renew');
      }
    });
    return chain;
  }

  return {
    /** Play started or stopped (menus, tuner, hidden session, end of XR). */
    setPlaying(next) {
      if (done || next === playing) return chain;
      playing = next;
      cancelTimer();
      return send(next ? 'start' : 'end');
    },
    /** End of the XR session: stop the clock and settle the bill. */
    dispose() {
      const wasPlaying = playing;
      playing = false;
      cancelTimer();
      const settle = wasPlaying && !done;
      done = true;
      if (settle) send('end', true);
      return chain;
    },
    get expired() { return expired; },
    get running() { return playing && !done; },
    /** Test seam: resolves once every queued call has settled. */
    _settled: () => chain,
  };
}
