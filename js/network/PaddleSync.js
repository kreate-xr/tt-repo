// Remote paddle synchronization.
//
// Outbound: every render frame the multiplayer drill calls writeLocal() with
// the local paddle's face center, face normal, and linear velocity (in world
// coords, which equals table-local since the table is centered at the origin).
// Latest values land in outboundState.paddle for NetworkManager's send loop.
//
// Inbound: onRemotePacket() ingests remote paddle packets, drops out-of-order
// ones via seq, and keeps a 3-packet jitter buffer. Each frame the drill
// calls getRemoteFace(now) which returns the interpolated, mirrored
// (across the net = the xy plane at z=0) face center / normal / velocity for
// registerAIPaddle to consume in collision detection.
//
// Mirror rules (sender world frame → receiver world frame, mirroring across
// the net plane — the xy plane at z = tableCenterZ):
//   position:              (x, y, z)  → (x, y, 2*Cz - z)
//   linear velocity:       (x, y, z)  → (x, y, -z)
//   angular velocity (pseudovector): (x, y, z) → (-x, -y, z)
//   face normal (vector):  (x, y, z)  → (x, y, -z)

import { PacketType } from './serialization.js';

const JITTER_BUFFER_SIZE = 3;
// Beyond the newest packet, dead-reckon the face center along the sent
// paddle velocity for at most this long, then freeze. Keeps opponent swings
// visually continuous through single packet drops without the overshoot
// artifacts unbounded extrapolation of human motion would produce.
export const PADDLE_EXTRAP_CAP_MS = 50;

export class PaddleSync {
  constructor(tableCenterZ = 0) {
    this.tableCenterZ = tableCenterZ;
    this.lastSeq = 0;
    this.buffer = []; // { ts, fc, fn, pv } in *receiver* frame (already mirrored)

    // Mutable face object handed to registerAIPaddle.getFace(). Reused each
    // frame to avoid allocation.
    this.face = {
      center:   { x: 0, y: 0, z: 0 },
      normal:   { x: 0, y: 0, z: 1 },
      velocity: { x: 0, y: 0, z: 0 },
    };
    // THREE.Vector3 views — the multiplayer drill copies these into its
    // registerAIPaddle face fields each frame. PaddleSync stays Three.js-free
    // by returning plain {x,y,z} objects; the drill bridges into Vector3.
  }

  // Drop buffered remote packets and reset seq tracking. Use after a reconnect
  // swap when the seq stream restarts from a new NetworkManager.
  clear() {
    this.buffer.length = 0;
    this.lastSeq = 0;
  }

  // outboundState is NetworkManager.outboundState — we write the latest local
  // paddle pose into the .paddle slot. The send loop drains it at 60 Hz.
  writeLocal(outboundState, faceCenterWorld, faceNormalWorld, paddleVelocityWorld) {
    outboundState.paddle = {
      type: PacketType.PADDLE_STATE,
      fc: [faceCenterWorld.x,   faceCenterWorld.y,   faceCenterWorld.z],
      fn: [faceNormalWorld.x,   faceNormalWorld.y,   faceNormalWorld.z],
      pv: [paddleVelocityWorld.x, paddleVelocityWorld.y, paddleVelocityWorld.z],
    };
  }

  onRemotePacket(packet) {
    if (!packet || typeof packet.seq !== 'number') return;
    if (packet.seq <= this.lastSeq) return; // out-of-order drop
    this.lastSeq = packet.seq;

    const fc = packet.fc, fn = packet.fn, pv = packet.pv;
    if (!fc || !fn || !pv) return;

    // Position mirrors across the net plane (z = tableCenterZ); vectors flip z.
    const cz2 = 2 * this.tableCenterZ;
    this.buffer.push({
      // Receiver-clock timestamp (see GameStateSync.onRemoteBallPacket).
      ts: packet.tLocal,
      fc: { x: fc[0], y: fc[1], z: cz2 - fc[2] },
      fn: { x: fn[0], y: fn[1], z:     -fn[2] },
      pv: { x: pv[0], y: pv[1], z:     -pv[2] },
    });
    while (this.buffer.length > JITTER_BUFFER_SIZE) this.buffer.shift();
  }

  // Compute the face pose for the remote paddle at receiver-clock time `now`
  // (the drill passes performance.now() minus a small render delay so a
  // bracketing pair of packets normally exists — see multiplayer.js
  // REMOTE_INTERP_DELAY_MS). Interpolates inside the jitter buffer; beyond
  // the newest packet it extrapolates along the sent paddle velocity, capped
  // at PADDLE_EXTRAP_CAP_MS, then freezes.
  getRemoteFace(now) {
    const len = this.buffer.length;
    if (len === 0) return this.face;

    const newest = this.buffer[len - 1];
    if (len === 1 || now >= newest.ts) {
      // At or beyond the newest sample: capped dead reckoning of the center.
      let gapMs = now - newest.ts;
      if (!(gapMs > 0)) gapMs = 0; // also covers len === 1 with now < ts
      if (gapMs > PADDLE_EXTRAP_CAP_MS) gapMs = PADDLE_EXTRAP_CAP_MS;
      const gapS = gapMs / 1000;
      this.face.center.x   = newest.fc.x + newest.pv.x * gapS;
      this.face.center.y   = newest.fc.y + newest.pv.y * gapS;
      this.face.center.z   = newest.fc.z + newest.pv.z * gapS;
      this.face.normal.x   = newest.fn.x; this.face.normal.y = newest.fn.y; this.face.normal.z = newest.fn.z;
      this.face.velocity.x = newest.pv.x; this.face.velocity.y = newest.pv.y; this.face.velocity.z = newest.pv.z;
      return this.face;
    }

    // Find the bracketing pair a.ts <= now <= b.ts (clamping below the
    // oldest sample to t = 0).
    let a = this.buffer[0];
    let b = this.buffer[1];
    for (let i = len - 2; i >= 0; i--) {
      if (this.buffer[i].ts <= now) {
        a = this.buffer[i];
        b = this.buffer[i + 1];
        break;
      }
    }
    const span = b.ts - a.ts;
    let t = span > 0 ? (now - a.ts) / span : 1;
    if (t < 0) t = 0; else if (t > 1) t = 1;

    this.face.center.x = a.fc.x + (b.fc.x - a.fc.x) * t;
    this.face.center.y = a.fc.y + (b.fc.y - a.fc.y) * t;
    this.face.center.z = a.fc.z + (b.fc.z - a.fc.z) * t;
    // Normal: lerp + renormalize. Slerp would be cleaner but linear is fine
    // for the small per-frame angular delta paddles produce.
    this.face.normal.x = a.fn.x + (b.fn.x - a.fn.x) * t;
    this.face.normal.y = a.fn.y + (b.fn.y - a.fn.y) * t;
    this.face.normal.z = a.fn.z + (b.fn.z - a.fn.z) * t;
    const nlen = Math.hypot(this.face.normal.x, this.face.normal.y, this.face.normal.z) || 1;
    this.face.normal.x /= nlen;
    this.face.normal.y /= nlen;
    this.face.normal.z /= nlen;
    // Velocity: use the newer bracket packet's value directly.
    this.face.velocity.x = b.pv.x;
    this.face.velocity.y = b.pv.y;
    this.face.velocity.z = b.pv.z;
    return this.face;
  }
}
