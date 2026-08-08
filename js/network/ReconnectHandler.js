// Detect + recover from peer-connection failures mid-game.
//
//   const rh = new ReconnectHandler({ lobby, sessionState });
//   rh.watch(networkManager);
//   rh.on('attempting',  ({ attempt }) => hud(`reconnecting #${attempt}…`));
//   rh.on('reconnected', ({ networkManager: newNm }) => drill.swap(newNm));
//   rh.on('failed',      ({ attempts })  => hud('connection lost'));
//
// On failure, calls lobby.reconnect() (re-signal + re-negotiate). Retries up
// to maxAttempts with retryDelayMs backoff. Emits 'failed' when exhausted.
// onSuccess() resets the counter so a future drop can recover again.

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1500;

export class ReconnectHandler {
  constructor({ lobby, sessionState, maxAttempts = DEFAULT_MAX_ATTEMPTS, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}) {
    if (!lobby) throw new Error('ReconnectHandler requires { lobby }');
    this.lobby = lobby;
    this.sessionState = sessionState;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.attempts = 0;
    this.busy = false;
    this.disposed = false;
    this.listeners = { attempting: [], reconnected: [], failed: [] };
  }

  on(event, fn) {
    if (this.listeners[event]) this.listeners[event].push(fn);
  }

  _emit(event, payload) {
    for (const fn of this.listeners[event] || []) {
      try { fn(payload); } catch (e) { console.error(`ReconnectHandler ${event} listener threw:`, e); }
    }
  }

  // Attach to a NetworkManager's failure events. Call again after a successful
  // reconnect to watch the new manager.
  watch(networkManager) {
    if (!networkManager) return;
    networkManager.on('disconnected', (info) => this._handle({ reason: 'disconnected', info }));
    networkManager.on('iceFailed', (info) => this._handle({ reason: 'iceFailed', info }));
  }

  onSuccess() {
    this.attempts = 0;
  }

  async _handle(failureInfo) {
    if (this.disposed) return;
    if (this.busy) return; // already handling one
    if (this.attempts >= this.maxAttempts) {
      this._emit('failed', { attempts: this.attempts, reason: failureInfo });
      return;
    }
    this.busy = true;
    this.attempts++;
    this._emit('attempting', { attempt: this.attempts, reason: failureInfo });
    try {
      const newNm = await this.lobby.reconnect();
      this.busy = false;
      this.onSuccess();
      this._emit('reconnected', { networkManager: newNm });
    } catch (err) {
      this.busy = false;
      console.warn(`reconnect attempt ${this.attempts} failed:`, err);
      if (this.attempts >= this.maxAttempts) {
        this._emit('failed', { attempts: this.attempts, reason: err });
      } else {
        setTimeout(() => this._handle({ reason: 'retry', info: err }), this.retryDelayMs);
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.listeners.attempting = [];
    this.listeners.reconnected = [];
    this.listeners.failed = [];
  }
}
