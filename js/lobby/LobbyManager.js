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
// Code alphabet/length/generator live in roomCodes.js so UI code (the in-XR
// lobby keyboard) can import the format without pulling in this module's
// signaling/WebRTC dependency chain.
import { generateRoomCode } from './roomCodes.js';
import { traceStart } from '../network/connectTrace.js';

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
    const ready = this._connectAs('host', code, { create: true });
    return { code, ready };
  }

  async joinRoom(code) {
    if (!code || typeof code !== 'string') throw new Error('joinRoom requires a code');
    this.role = 'guest';
    this.code = code.toUpperCase();
    return this._connectAs(this.role, this.code, { create: false });
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
    // Host re-creates the room fresh (clearing the stale guest/offer/answer
    // from the dropped session); guest re-joins it. If the guest lands first
    // it sees its own stale slot as ROOM_FULL — ReconnectHandler's retry
    // covers the gap until the host has recreated.
    return this._connectAs(this.role, this.code, { create: this.role === 'host' });
  }

  async _connectAs(role, code, { create = false } = {}) {
    // Clock starts at the button press, not at negotiation — the wait a player
    // actually feels includes auth and the room transaction.
    traceStart(`${role} ${create ? 'create' : 'join'} ${code}`);
    this.signaling = new SignalingClient();
    let assignedRole;
    try {
      const result = await this.signaling.connect(code, { create });
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
    if (this.signaling) {
      // Best-effort room cleanup so the code doesn't rot in Firestore and
      // block retries with ROOM_FULL. (nm.teardown() already closed the
      // signaling listeners; the doc write only needs the ref.)
      if (this.role === 'host') await this.signaling.deleteRoom();
      else if (this.role === 'guest') await this.signaling.leaveRoom();
      this.signaling.close();
    }
    this.networkManager = null;
    this.signaling = null;
  }
}
