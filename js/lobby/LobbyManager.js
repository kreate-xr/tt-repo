// Lobby state machine. Generates room codes, drives the signaling client, and
// produces a fully-negotiated NetworkManager once both peers are connected.
//
//   const lobby = new LobbyManager({ signalingUrl, iceServers });
//   const { code, ready } = lobby.createRoom();   // displays `code`
//   const nm = await ready;                       // resolves when peer joins + DC opens
//
//   // Other side:
//   const nm = await lobby.joinRoom(userEnteredCode);
//
// On failure (room full, ICE timeout, channel degraded), the returned promise
// rejects with a tagged Error. The caller decides whether to retry.

import { SignalingClient } from '../network/SignalingClient.js';
import { NetworkManager } from '../network/NetworkManager.js';
import { getDefaultIceServers } from '../network/iceConfig.js';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit easily-confused chars
const ROOM_CODE_LEN = 6;

function generateRoomCode() {
  let out = '';
  const a = ROOM_CODE_ALPHABET;
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += a[Math.floor(Math.random() * a.length)];
  }
  return out;
}

export class LobbyManager {
  constructor({ iceServers } = {}) {
    this.iceServers = iceServers;
    this.signaling = null;
    this.networkManager = null;
    // Stored for reconnect — once we've successfully connected once, we know
    // what to try again with. Role is now assigned by the Firestore-based
    // SignalingClient transaction, not by client-side intent.
    this.role = null;
    this.code = null;
  }

  createRoom() {
    const code = generateRoomCode();
    this.role = 'host';
    this.code = code;
    const ready = this._connectAs('host', code);
    return { code, ready };
  }

  async joinRoom(code) {
    if (!code || typeof code !== 'string') throw new Error('joinRoom requires a code');
    this.role = 'guest';
    this.code = code.toUpperCase();
    return this._connectAs(this.role, this.code);
  }

  // Tear down the existing peer connection + signaling socket, then run the
  // initial connect flow again with the same role + code. Returns the new
  // NetworkManager. ReconnectHandler retries this.
  async reconnect() {
    if (!this.role || !this.code) throw new Error('LobbyManager.reconnect: no prior session');
    try { if (this.networkManager) await this.networkManager.teardown(); } catch {}
    try { if (this.signaling) this.signaling.close(); } catch {}
    this.signaling = null;
    this.networkManager = null;
    return this._connectAs(this.role, this.code);
  }

  async _connectAs(_intentRole, code) {
    // _intentRole is informational only — the SignalingClient's Firestore
    // transaction is authoritative. If two peers race on `createRoom` for
    // the same code, one of them gets assigned 'guest' atomically.
    this.signaling = new SignalingClient();
    let assignedRole;
    try {
      const result = await this.signaling.connect(code);
      assignedRole = result.role;
    } catch (err) {
      this.signaling.close();
      this.signaling = null;
      throw err;
    }
    this.role = assignedRole;

    this.networkManager = new NetworkManager({
      role: assignedRole,
      signaling: this.signaling,
      iceServers: this.iceServers || getDefaultIceServers(),
    });

    // Resolve when fully connected, reject on ICE failure.
    return new Promise((resolve, reject) => {
      this.networkManager.on('connected', () => resolve(this.networkManager));
      this.networkManager.on('iceFailed', (info) => {
        reject(new Error(`ICE_TIMEOUT: ${JSON.stringify(info)}`));
      });
      this.networkManager.start().catch(reject);
    });
  }

  async teardown() {
    if (this.networkManager) await this.networkManager.teardown();
    if (this.signaling) this.signaling.close();
    this.networkManager = null;
    this.signaling = null;
  }
}
