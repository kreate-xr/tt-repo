// Orchestrator for the WebRTC peer connection. Wires the SignalingClient (SDP
// + ICE relay) to the two data channels (game + events) and exposes a small
// event surface for higher layers. Has no game logic.
//
//   const nm = new NetworkManager({ role, signaling, iceServers });
//   await nm.start();              // negotiates, opens channels, verifies
//   nm.on('gameMessage', fn);      // decoded msgpack packet
//   nm.on('eventMessage', fn);     // decoded JSON packet
//   nm.sendGame(packet);
//   nm.sendEvent(packet);
//   await nm.teardown();
//
// The send loop (rate-controlled setTimeout, decoupled from rAF) is started
// by the multiplayer drill in Phase 3 once it has an outboundState bag wired
// up. NetworkManager only exposes start/stop hooks here.

import { createChannels, receiveChannels, waitForOpen, verifyChannels } from './DataChannels.js';
import { encodeGame, decodeGame, encodeEvent, decodeEvent, PacketType } from './serialization.js';
import { ClockSync, PING_INTERVAL_MS } from './ClockSync.js';

const ICE_TIMEOUT_MS = 30000;

// STUN-only fallback for direct construction (tests, harnesses). Production
// paths go through LobbyManager, which injects TURN via iceConfig.js —
// env-driven config lives there because this file must stay importable under
// Jest (babel-jest cannot transform import.meta).
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
];

// Dev-only inbound lag injector, driven by query params:
//   ?fakeLag=80&jitter=20&loss=5   (ms, ±ms, % — loss applies to the
//                                   unreliable game channel only)
// This is the practical way to test latency handling on Quest hardware:
// browser dev-tools throttling does not affect WebRTC data channels, and
// OS-level shapers need a second machine.
function parseLagSimFromLocation() {
  if (typeof location === 'undefined' || !location.search) return null;
  try {
    const q = new URLSearchParams(location.search);
    if (!q.has('fakeLag')) return null;
    return {
      lagMs: parseFloat(q.get('fakeLag')) || 0,
      jitterMs: parseFloat(q.get('jitter')) || 0,
      lossPct: parseFloat(q.get('loss')) || 0,
    };
  } catch {
    return null;
  }
}

export class NetworkManager {
  constructor({ role, signaling, iceServers, lagSim } = {}) {
    if (role !== 'host' && role !== 'guest') {
      throw new Error('NetworkManager role must be "host" or "guest"');
    }
    this.role = role;
    this.signaling = signaling;
    this.iceServers = iceServers || DEFAULT_ICE_SERVERS;
    this.lagSim = lagSim !== undefined ? lagSim : parseLagSimFromLocation();

    this.pc = null;
    this.gameChannel = null;
    this.eventChannel = null;
    this.remoteDescSet = false;
    this.pendingIce = [];

    this.outboundSeq = { game: 0, event: 0 };
    this.outboundState = { ball: null, paddle: null };
    // Peer clock-offset estimator. Fed by PING/PONG on the game channel;
    // consumed in _wireChannels to stamp every inbound packet with tLocal.
    this.clock = new ClockSync();
    this.pingHandle = null;

    this.listeners = {
      connected: [], disconnected: [], channelDegraded: [],
      gameMessage: [], eventMessage: [], iceFailed: [],
    };

    this.sendLoopHandle = null;
    this._teardownStarted = false;
  }

  on(event, fn) {
    if (this.listeners[event]) this.listeners[event].push(fn);
  }

  _emit(event, payload) {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const fn of arr) {
      try { fn(payload); } catch (e) { console.error(`NetworkManager listener for ${event} threw:`, e); }
    }
  }

  async start() {
    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: 'all',
    });

    // Forward local ICE candidates to the peer.
    this.pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) this.signaling.sendIce(e.candidate);
    });

    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') {
        this._emit('disconnected', { state: s });
      }
    });

    // Drain ICE from the signaling client, queueing until remote desc is set.
    this.signaling.on('ice', async (msg) => {
      if (!msg.candidate) return;
      if (!this.remoteDescSet) {
        this.pendingIce.push(msg.candidate);
        return;
      }
      try { await this.pc.addIceCandidate(msg.candidate); }
      catch (err) { console.warn('addIceCandidate failed:', err); }
    });

    let channelsPromise;
    if (this.role === 'host') {
      // Host: create channels BEFORE the offer so they appear in the SDP.
      const channels = createChannels(this.pc);
      channelsPromise = Promise.resolve(channels);
      this._wireChannels(channels);

      this.signaling.on('answer', async (msg) => {
        try {
          await this.pc.setRemoteDescription(msg.sdp);
          this.remoteDescSet = true;
          await this._drainPendingIce();
        } catch (err) { console.error('host setRemoteDescription failed:', err); }
      });

      // The signaling server emits peerReady once both peers have JOINed. The
      // host kicks off the offer at that point.
      this.signaling.on('peerReady', async () => {
        try {
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this.signaling.sendOffer(offer);
        } catch (err) { console.error('host createOffer failed:', err); }
      });
    } else {
      // Guest: wait for the offer, then answer. Channels arrive via
      // pc.ondatachannel — the receiveChannels promise resolves once both are
      // present (matched by label).
      channelsPromise = receiveChannels(this.pc).then((channels) => {
        this._wireChannels(channels);
        return channels;
      });

      this.signaling.on('offer', async (msg) => {
        try {
          await this.pc.setRemoteDescription(msg.sdp);
          this.remoteDescSet = true;
          await this._drainPendingIce();
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.signaling.sendAnswer(answer);
        } catch (err) { console.error('guest answer flow failed:', err); }
      });
    }

    // Hard ICE timeout. If we never reach connected/completed within
    // ICE_TIMEOUT_MS, surface a failure so the lobby can retry.
    const iceTimeout = setTimeout(() => {
      const s = this.pc && this.pc.iceConnectionState;
      if (s !== 'connected' && s !== 'completed') {
        this._emit('iceFailed', { iceConnectionState: s });
      }
    }, ICE_TIMEOUT_MS);
    this.pc.addEventListener('iceconnectionstatechange', () => {
      const s = this.pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') clearTimeout(iceTimeout);
    });

    const { game, events } = await channelsPromise;
    await waitForOpen(game, events);
    verifyChannels(game, events);

    this.startPingLoop();
    this._emit('connected', { role: this.role });
  }

  _wireChannels({ game, events }) {
    this.gameChannel = game;
    this.eventChannel = events;
    game.binaryType = 'arraybuffer';

    game.addEventListener('message', (e) => {
      try {
        const packet = decodeGame(e.data);
        this._inject(() => this._handleGamePacket(packet), /* droppable */ true);
      } catch (err) { console.warn('gameChannel decode failed:', err); }
    });
    events.addEventListener('message', (e) => {
      try {
        const packet = decodeEvent(e.data);
        // Reliable channel: lag applies, loss must not (delivery is guaranteed).
        this._inject(() => this._handleEventPacket(packet), false);
      } catch (err) { console.warn('eventChannel decode failed:', err); }
    });
  }

  _handleGamePacket(packet) {
    const now = performance.now();
    // Clock-sync traffic is handled here and never surfaced to game code.
    // Reply to pings synchronously — turnaround delay adds to measured RTT.
    if (packet.type === PacketType.PING) {
      this.sendGame(this.clock.makePong(packet, now));
      return;
    }
    if (packet.type === PacketType.PONG) {
      this.clock.onPong(packet, now);
      return;
    }
    this._stampLocalTime(packet, now);
    this._emit('gameMessage', packet);
  }

  _handleEventPacket(packet) {
    this._stampLocalTime(packet, performance.now());
    this._emit('eventMessage', packet);
  }

  // Dev lag injector pass-through (no-op without ?fakeLag). Delays run at
  // delivery time, so timestamp handling downstream sees genuinely late
  // packets — including PING/PONG, which keeps the measured RTT honest.
  _inject(deliver, droppable) {
    if (!this.lagSim) { deliver(); return; }
    if (droppable && this.lagSim.lossPct > 0 && Math.random() * 100 < this.lagSim.lossPct) return;
    const jitter = (Math.random() * 2 - 1) * this.lagSim.jitterMs;
    const delay = this.lagSim.lagMs + jitter;
    if (delay <= 0) { deliver(); return; }
    setTimeout(deliver, delay);
  }

  // Single choke point that converts the sender-clock `timestamp` on every
  // inbound packet into the receiver clock domain. Downstream consumers
  // (GameStateSync, PaddleSync, handoff projection) must use tLocal, never
  // the raw timestamp. Before the first pong lands (~250 ms after connect)
  // fall back to arrival time — off by one-way jitter only, far better than
  // an untranslated foreign timestamp.
  _stampLocalTime(packet, now) {
    packet.tLocal = (this.clock.isReady() && typeof packet.timestamp === 'number')
      ? this.clock.toLocalTime(packet.timestamp)
      : now;
  }

  startPingLoop() {
    if (this.pingHandle) return;
    this.pingHandle = setInterval(() => {
      this.sendGame(this.clock.makePing(performance.now()));
    }, PING_INTERVAL_MS);
  }

  stopPingLoop() {
    if (this.pingHandle) clearInterval(this.pingHandle);
    this.pingHandle = null;
  }

  async _drainPendingIce() {
    const queue = this.pendingIce;
    this.pendingIce = [];
    for (const c of queue) {
      try { await this.pc.addIceCandidate(c); }
      catch (err) { console.warn('queued addIceCandidate failed:', err); }
    }
  }

  sendGame(packet) {
    if (!this.gameChannel || this.gameChannel.readyState !== 'open') return;
    packet.seq = ++this.outboundSeq.game;
    packet.timestamp = performance.now();
    this.gameChannel.send(encodeGame(packet));
  }

  sendEvent(packet) {
    if (!this.eventChannel || this.eventChannel.readyState !== 'open') return;
    packet.seq = ++this.outboundSeq.event;
    packet.timestamp = performance.now();
    this.eventChannel.send(encodeEvent(packet));
  }

  // Start a setTimeout-based send loop that drains outboundState at the given
  // rate. Independent of requestAnimationFrame so a backgrounded tab does not
  // freeze network output. Phase 3 enables this once outboundState is populated.
  startSendLoop(rateHz = 60) {
    if (this.sendLoopHandle) return;
    const interval = Math.max(1, 1000 / rateHz);
    const tick = () => {
      this._drainOutbound();
      this.sendLoopHandle = setTimeout(tick, interval);
    };
    tick();
  }

  stopSendLoop() {
    if (this.sendLoopHandle) clearTimeout(this.sendLoopHandle);
    this.sendLoopHandle = null;
  }

  setSendRate(rateHz) {
    if (!this.sendLoopHandle) return;
    this.stopSendLoop();
    this.startSendLoop(rateHz);
  }

  _drainOutbound() {
    // outboundState.{ball,paddle} are already complete wire packets written by
    // GameStateSync.writeLocal / PaddleSync.writeLocal (each includes its own
    // `type` field plus the payload). sendGame attaches seq + timestamp.
    if (this.outboundState.ball) {
      this.sendGame(this.outboundState.ball);
    }
    if (this.outboundState.paddle) {
      this.sendGame(this.outboundState.paddle);
    }
  }

  async teardown() {
    if (this._teardownStarted) return;
    this._teardownStarted = true;
    this.stopSendLoop();
    this.stopPingLoop();
    try { if (this.gameChannel) this.gameChannel.close(); } catch {}
    try { if (this.eventChannel) this.eventChannel.close(); } catch {}
    try { if (this.pc) this.pc.close(); } catch {}
    try { if (this.signaling) this.signaling.close(); } catch {}
    this.gameChannel = null;
    this.eventChannel = null;
    this.pc = null;
  }
}
