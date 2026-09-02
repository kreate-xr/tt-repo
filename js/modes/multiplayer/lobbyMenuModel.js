// In-XR multiplayer lobby model — the state machine behind
// scene/multiplayerMenu.js. Pure logic, no canvas / THREE, so the whole
// create/join/cancel/error flow is unit-testable headless like the other
// menu models.
//
// Owns a LobbyManager-shaped object for the duration of ONE create/join
// attempt. Ownership rule: while an attempt is in flight the model owns the
// lobby and cancel() must tear it down; the moment a connection is DELIVERED
// the whole { networkManager, role, lobby } bundle passes to the host
// (inGame.js), which tears it down at session end — the model never touches
// it again.
//
// `createLobby` is injected rather than importing LobbyManager directly:
// LobbyManager drags in the signaling/WebRTC stack (including the Firebase
// SDK), which has no place in a unit test — and the menu renderer only needs
// the code FORMAT, which lives in lobby/roomCodes.js precisely so it can be
// imported without that chain.

import { ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from '../../lobby/roomCodes.js';
import { friendlyLobbyError } from '../../lobby/lobbyErrors.js';
import {
  BEST_OF_OPTIONS, normalizeBestOf, loadBestOf, saveBestOf,
} from '../matchFormat.js';

export { ROOM_CODE_ALPHABET, ROOM_CODE_LEN, BEST_OF_OPTIONS };

export const MP_SCREENS = Object.freeze({
  HOME: 'home',             // Create / Join choice
  HOSTING: 'hosting',       // code displayed, waiting for the guest
  JOIN: 'join',             // code entry keyboard
  CONNECTING: 'connecting', // joinRoom in flight
});

export class LobbyMenuModel {
  constructor({ createLobby, onChange = null, onConnected = null } = {}) {
    if (typeof createLobby !== 'function') {
      throw new Error('LobbyMenuModel requires a createLobby factory');
    }
    this.createLobby = createLobby;
    this.onChange = onChange;       // re-render hook for the panel
    this.onConnected = onConnected; // receives { networkManager, role, lobby }

    this.screen = MP_SCREENS.HOME;
    this.codeEntry = '';   // join-side keyboard buffer
    this.hostCode = null;  // code being hosted, once createRoom returns it
    // Match length for a room WE create. Seeded from (and written back to) the
    // shared preference the wrist menu's BEST OF control also edits, so the
    // two are never two different answers to the same question. Editable only
    // on HOME: once a code is out in the world the format is the room's, and a
    // guest that joined a best-of-3 must not have it changed underneath them.
    this.bestOf = loadBestOf();
    // The value latched at createRoom time, handed to the drill on connect.
    // Read from here rather than from `bestOf` so it is immune to any later
    // edit, including one made on a HOME screen the player backed out to.
    this.hostBestOf = null;
    this.message = null;   // neutral status line
    this.error = null;     // red error line (friendlyLobbyError output)
    this.lobby = null;     // the in-flight attempt this model owns
    this.connected = null; // delivered bundle — set once, never cleared
    // Bumped on every attempt start / cancel; async continuations capture the
    // value at their start and bail if it moved on, so an abandoned attempt
    // can never clobber the one that replaced it (same guard as the 2D
    // overlay's lobbySession).
    this.session = 0;
  }

  _changed() { if (this.onChange) this.onChange(); }

  /** Cancel the in-flight attempt (if any). Teardown is best-effort async. */
  _reset() {
    this.session++;
    const old = this.lobby;
    this.lobby = null;
    this.hostCode = null;
    this.hostBestOf = null;
    if (old) old.teardown().catch(() => { /* best-effort */ });
  }

  /**
   * Pick the match length for rooms this player hosts. Ignored once an attempt
   * is in flight (see the field comment) and persisted immediately, so the
   * choice survives backing out of the panel — or the session.
   */
  setBestOf(value) {
    if (this.screen !== MP_SCREENS.HOME) return this.bestOf;
    const n = normalizeBestOf(value);
    if (n === this.bestOf) return n;
    this.bestOf = saveBestOf(n);
    this._changed();
    return this.bestOf;
  }

  async startCreate() {
    this._reset();
    const my = this.session;
    // Latch the format for this room before anything can await.
    this.hostBestOf = this.bestOf;
    this.screen = MP_SCREENS.HOSTING;
    this.message = 'Creating room…';
    this.error = null;
    this._changed();
    try {
      // Inside the try: the factory may throw when the lazily-loaded lobby
      // stack isn't ready yet — that lands on the friendly retryable error
      // path instead of escaping as an unhandled rejection.
      this.lobby = this.createLobby();
      const { code, ready } = this.lobby.createRoom({
        // A collision re-roll swaps the code out from under us; repaint so the
        // panel never advertises one the host is no longer hosting.
        onCode: (next) => {
          if (this.session !== my) return;
          this.hostCode = next;
          this._changed();
        },
      });
      this.hostCode = code;
      this.message = 'Share this code — waiting for your opponent…';
      this._changed();
      const nm = await ready;
      if (this.session !== my) return;
      this._deliver(nm);
    } catch (err) {
      if (this.session !== my) return;
      this._fail(err, this.hostCode || '', MP_SCREENS.HOME);
    }
  }

  openJoin() {
    if (this.screen === MP_SCREENS.JOIN) return;
    this.screen = MP_SCREENS.JOIN;
    this.error = null;
    this._changed();
  }

  appendChar(ch) {
    if (this.screen !== MP_SCREENS.JOIN) return;
    if (this.codeEntry.length >= ROOM_CODE_LEN) return;
    if (!ROOM_CODE_ALPHABET.includes(ch)) return;
    this.codeEntry += ch;
    this._changed();
  }

  backspace() {
    if (!this.codeEntry) return;
    this.codeEntry = this.codeEntry.slice(0, -1);
    this._changed();
  }

  canJoin() {
    return this.screen === MP_SCREENS.JOIN && this.codeEntry.length === ROOM_CODE_LEN;
  }

  async startJoin() {
    if (!this.canJoin()) return;
    const code = this.codeEntry;
    this._reset();
    const my = this.session;
    this.screen = MP_SCREENS.CONNECTING;
    this.message = `Joining ${code}…`;
    this.error = null;
    this._changed();
    try {
      // Same containment as startCreate: a throwing factory fails friendly.
      this.lobby = this.createLobby();
      const nm = await this.lobby.joinRoom(code);
      if (this.session !== my) return;
      this._deliver(nm);
    } catch (err) {
      if (this.session !== my) return;
      // Land back on the keyboard with the code still in place, so a typo can
      // be fixed rather than retyped from scratch.
      this._fail(err, code, MP_SCREENS.JOIN);
    }
  }

  /** Abort whatever is in flight and return to the Create/Join choice. */
  cancel() {
    this._reset();
    this.screen = MP_SCREENS.HOME;
    this.message = null;
    this.error = null;
    this._changed();
  }

  /**
   * One level up. Returns false when already at the root — the host closes
   * the panel then (mirrors TrainingMenuModel.back()).
   */
  back() {
    if (this.screen === MP_SCREENS.JOIN) {
      this.screen = MP_SCREENS.HOME;
      this.error = null;
      this._changed();
      return true;
    }
    if (this.screen === MP_SCREENS.HOSTING || this.screen === MP_SCREENS.CONNECTING) {
      this.cancel();
      return true;
    }
    return false;
  }

  _deliver(nm) {
    const lobby = this.lobby;
    this.lobby = null; // ownership passes to the host — see header comment
    this.hostCode = null;
    // `bestOf` is null for a guest: the room's format belongs to whoever
    // created it, and the guest adopts it over the wire.
    this.connected = { networkManager: nm, role: lobby.role, lobby, bestOf: this.hostBestOf };
    this.message = 'Opponent connected!';
    this.error = null;
    this._changed();
    if (this.onConnected) this.onConnected(this.connected);
  }

  _fail(err, code, screen) {
    const old = this.lobby;
    this.lobby = null;
    this.hostCode = null;
    if (old) old.teardown().catch(() => { /* best-effort */ });
    this.error = friendlyLobbyError(err, code);
    this.message = null;
    this.screen = screen;
    this._changed();
  }
}
