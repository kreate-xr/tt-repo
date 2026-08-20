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

// Congestion governor thresholds (see _updateCongestion). High-water marks
// trip the backoff; both signals must sit below the low-water marks for
// CONGESTION_RECOVERY_MS before the rate is restored.
export const CONGESTION_BUFFERED_HIGH_BYTES = 4096; // ~13 send ticks of backlog
export const CONGESTION_BUFFERED_LOW_BYTES = 1024;
export const CONGESTION_QUEUE_HIGH_MS = 60;
export const CONGESTION_QUEUE_LOW_MS = 25;
export const CONGESTION_RECOVERY_MS = 2000;

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
      gameMessage: [], eventMessage: [], iceFailed: [], congestion: [],
    };

    this.sendLoopHandle = null;
    this.baseRateHz = 60;
    this.congested = false;
    this._congestionClearSince = null;
    this._iceTimeoutHandle = null;
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

    // Hard ICE timeout, armed when negotiation actually begins — NOT at
    // start(). The host may sit in the lobby indefinitely before a guest
    // joins, and that waiting time must not count against ICE.
    const armIceTimeout = () => {
      if (this._iceTimeoutHandle) return;
      this._iceTimeoutHandle = setTimeout(() => {
        if (this._teardownStarted) return;
        const s = this.pc && this.pc.iceConnectionState;
        if (s !== 'connected' && s !== 'completed') {
          this._emit('iceFailed', { iceConnectionState: s });
        }
      }, ICE_TIMEOUT_MS);
    };
    this.pc.addEventListener('iceconnectionstatechange', () => {
      const s = this.pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') clearTimeout(this._iceTimeoutHandle);
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
      // host kicks off the offer at that point — negotiation starts here, so
      // this is where the ICE clock starts too.
      this.signaling.on('peerReady', async () => {
        armIceTimeout();
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

      // A guest only gets here after successfully joining a room whose host
      // is present, so negotiation is genuinely underway — arm immediately
      // (also covers a host that vanished before sending the offer).
      armIceTimeout();
    }

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

  // Both send paths stamp `seq` and `timestamp` into the packet IN PLACE just
  // before encoding — application payloads must not use those top-level field
  // names (they'd be silently overwritten; RALLY_END's rally counter is named
  // `rallySeq` for exactly this reason).
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
  // The interval is recomputed every tick so congestion backoff (and
  // setSendRate) take effect within one send interval.
  startSendLoop(rateHz = 60) {
    if (this.sendLoopHandle) return;
    this.baseRateHz = rateHz;
    const tick = () => {
      this._updateCongestion(performance.now());
      this._drainOutbound();
      const interval = Math.max(1, 1000 / this._effectiveRateHz());
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
    this.baseRateHz = rateHz;
  }

  _effectiveRateHz() {
    return this.congested ? this.baseRateHz / 2 : this.baseRateHz;
  }

  // Congestion governor for the fixed-rate state stream. Two independent
  // signals, either of which marks the link congested:
  //   - gameChannel.bufferedAmount: bytes SCTP has accepted but not yet put
  //     on the wire. The unreliable channel never retransmits, but outbound
  //     frames still queue behind a slow link — a growing buffer means we
  //     are producing faster than the path drains.
  //   - clock.queuingDelayMs(): smoothed ping RTT above its windowed minimum
  //     — standing queue in the network itself (bufferbloat), which
  //     bufferedAmount can't see once bytes leave the local SCTP stack.
  // While congested, _effectiveRateHz halves baseRateHz (30 Hz at the
  // default 60). Dead reckoning rides a 30 Hz stream easily, and halving the
  // offered load drains the queue instead of feeding it. Recovery is
  // hysteretic: both signals must stay below the low-water marks for
  // CONGESTION_RECOVERY_MS before restoring, so a marginal link doesn't
  // oscillate between rates.
  _updateCongestion(now) {
    const buffered = this.gameChannel ? this.gameChannel.bufferedAmount : 0;
    const qDelay = this.clock.queuingDelayMs();
    const overHigh = buffered >= CONGESTION_BUFFERED_HIGH_BYTES
      || (qDelay !== null && qDelay >= CONGESTION_QUEUE_HIGH_MS);

    if (overHigh) {
      this._congestionClearSince = null;
      if (!this.congested) {
        this.congested = true;
        this._emit('congestion', { congested: true, bufferedBytes: buffered, queuingDelayMs: qDelay });
      }
      return;
    }
    if (!this.congested) return;

    const underLow = buffered < CONGESTION_BUFFERED_LOW_BYTES
      && (qDelay === null || qDelay < CONGESTION_QUEUE_LOW_MS);
    if (!underLow) {
      this._congestionClearSince = null;
      return;
    }
    if (this._congestionClearSince === null) {
      this._congestionClearSince = now;
      return;
    }
    if (now - this._congestionClearSince >= CONGESTION_RECOVERY_MS) {
      this.congested = false;
      this._congestionClearSince = null;
      this._emit('congestion', { congested: false, bufferedBytes: buffered, queuingDelayMs: qDelay });
    }
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
    if (this._iceTimeoutHandle) clearTimeout(this._iceTimeoutHandle);
    try { if (this.gameChannel) this.gameChannel.close(); } catch {}
    try { if (this.eventChannel) this.eventChannel.close(); } catch {}
    try { if (this.pc) this.pc.close(); } catch {}
    try { if (this.signaling) this.signaling.close(); } catch {}
    this.gameChannel = null;
    this.eventChannel = null;
    this.pc = null;
  }
}
