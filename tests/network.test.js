// Unit tests covering: GameStateSync interpolation + seq drop, PaddleSync seq
// drop, ThermalMonitor threshold, ReconnectHandler max-attempts behavior, and
// SessionState serialize/deserialize round-trip.

import { GameStateSync, BALL_EXTRAP_CAP_MS } from '../js/network/GameStateSync.js';
import { PaddleSync, PADDLE_EXTRAP_CAP_MS } from '../js/network/PaddleSync.js';
import * as ThermalMonitor from '../js/network/ThermalMonitor.js';
import { ReconnectHandler } from '../js/network/ReconnectHandler.js';
import { SessionState } from '../js/lobby/SessionState.js';
import { PacketType } from '../js/network/serialization.js';

// ---------------------------------------------------------------------------
// GameStateSync — dead reckoning: projection, deadzone, blend, snap
// ---------------------------------------------------------------------------

// Stub integrator: pure linear motion (no gravity/drag/spin), so expected
// positions are trivially computable — and substep-invariant, so the
// projection loop's 8 ms slicing drops out of the arithmetic. The real
// integrator (physics/rollout.js) has its own suite in tests/rollout.test.js.
function linearStep(pos, vel, _spin, dt) {
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
  return null;
}

function makeSync(tableCenterZ = 0) {
  return new GameStateSync('opponent', tableCenterZ, { stepFlight: linearStep });
}

// `ts` is the RECEIVER-clock time. NetworkManager translates the sender's
// `timestamp` into `tLocal` via ClockSync before the sync modules ever see a
// packet; GameStateSync/PaddleSync consume tLocal only. Feeding a
// sender-domain timestamp as the evaluation clock was exactly the bug the
// old interpolation tests masked.
function makePacket({ seq, ts, p, v, s = [0, 0, 0] }) {
  return { type: PacketType.BALL_STATE, seq, tLocal: ts, p, v, s };
}

describe('GameStateSync dead reckoning', () => {
  const DT = 0.016;

  test('first packet is adopted, projected forward by its age', () => {
    const g = makeSync(0);
    // Sender frame: p z=2 → mirrored z=-2; v z=4 → mirrored vz=-4.
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [1, 0.5, 2], v: [0, 0, 4] }));
    // now=1100 → age 100 ms → z advances by -4 * 0.1 = -0.4.
    const s = g.getDeadReckonedBallState(1100, 0); // dt=0: no mini-sim advance
    expect(s.pos.x).toBeCloseTo(1);
    expect(s.pos.y).toBeCloseTo(0.5);
    expect(s.pos.z).toBeCloseTo(-2.4);
    expect(s.vel.z).toBeCloseTo(-4);
  });

  test('projection age is capped at BALL_EXTRAP_CAP_MS', () => {
    const g = makeSync(0);
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [0, 0, 0], v: [10, 0, 0] }));
    // Age 5000 ms → capped to 120 ms → x = 10 * 0.12 = 1.2, not 50.
    const s = g.getDeadReckonedBallState(6000, 0);
    expect(s.pos.x).toBeCloseTo(10 * (BALL_EXTRAP_CAP_MS / 1000));
  });

  test('mini-sim advances the displayed state between packets', () => {
    const g = makeSync(0);
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [0, 0, 0], v: [2, 0, 0] }));
    g.getDeadReckonedBallState(1000, 0); // adopt at zero age
    // Three frames with no new packet: x advances by v*dt each frame.
    let s;
    for (let i = 0; i < 3; i++) s = g.getDeadReckonedBallState(1000 + (i + 1) * 16, DT);
    expect(s.pos.x).toBeCloseTo(2 * DT * 3);
  });

  test('sub-deadzone error is ignored (no positional micro-jitter)', () => {
    const g = makeSync(0);
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [0, 1, 0], v: [0, 0, 0] }));
    g.getDeadReckonedBallState(1000, 0);
    // Second packet 2 cm off (deadzone is 3 cm) with a new velocity.
    g.onRemoteBallPacket(makePacket({ seq: 2, ts: 1016, p: [0.02, 1, 0], v: [1, 0, 0] }));
    const s = g.getDeadReckonedBallState(1016, 0);
    expect(s.pos.x).toBeCloseTo(0);    // position untouched
    expect(s.vel.x).toBeCloseTo(1);    // velocity still copied
    expect(g.hasCorr).toBe(false);
    expect(g.snapCount).toBe(0);
  });

  test('mid-range error blends smoothly below deadzone within ~200 ms', () => {
    const g = makeSync(0);
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [0, 1, 0], v: [0, 0, 0] }));
    g.getDeadReckonedBallState(1000, 0);
    // 10 cm error → exponential blend, never a hard jump.
    g.onRemoteBallPacket(makePacket({ seq: 2, ts: 1016, p: [0.1, 1, 0], v: [0, 0, 0] }));
    let prevX = 0;
    let now = 1016;
    for (let i = 0; i < 13; i++) { // ~208 ms of frames
      now += 16;
      const s = g.getDeadReckonedBallState(now, DT);
      const frameJump = Math.abs(s.pos.x - prevX);
      expect(frameJump).toBeLessThan(0.03); // each frame folds in < 3 cm
      prevX = s.pos.x;
    }
    expect(prevX).toBeGreaterThan(0.07); // converged to within deadzone of target
    expect(g.snapCount).toBe(0);
  });

  test('error at or beyond SNAP_THRESHOLD_M snaps immediately', () => {
    const g = makeSync(0);
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [0, 1, 0], v: [0, 0, 0] }));
    g.getDeadReckonedBallState(1000, 0);
    g.onRemoteBallPacket(makePacket({ seq: 2, ts: 1016, p: [0.3, 1, 0], v: [0, 0, 0] }));
    const s = g.getDeadReckonedBallState(1016, 0);
    expect(s.pos.x).toBeCloseTo(0.3);
    expect(g.snapCount).toBe(1);
  });

  test('applyAuthoritative (reconciliation) projects and blends like a packet', () => {
    const g = makeSync(0);
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [0, 1, 0], v: [0, 0, 0] }));
    g.getDeadReckonedBallState(1000, 0);
    // Already-mirrored snapshot, 100 ms old, moving +x at 1 m/s: target x =
    // 0.05 + 0.1 = 0.15 → 15 cm error → blend, not snap.
    g.applyAuthoritative(
      { pos: { x: 0.05, y: 1, z: 0 }, vel: { x: 1, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 } },
      1000, 1100,
    );
    g.getDeadReckonedBallState(1100, 0);
    expect(g.hasCorr).toBe(true);
    expect(g.snapCount).toBe(0);
    expect(g.lastCorrectionM).toBeCloseTo(0.15);
  });

  test('mirrors across a non-zero tableCenterZ', () => {
    const Cz = -1.5;
    const g = makeSync(Cz);
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [0, 0, -3], v: [0, 0, 0] }));
    // z' = 2*Cz - z = -3 - (-3) = 0
    const s = g.getDeadReckonedBallState(1000, 0);
    expect(s.pos.z).toBeCloseTo(0);
  });

  test('returns null when no packets received, and again after clear()', () => {
    const g = makeSync(0);
    expect(g.getDeadReckonedBallState(1000, DT)).toBe(null);
    g.onRemoteBallPacket(makePacket({ seq: 1, ts: 1000, p: [0, 0, 0], v: [0, 0, 0] }));
    expect(g.getDeadReckonedBallState(1000, 0)).not.toBe(null);
    g.clear();
    expect(g.getDeadReckonedBallState(1100, DT)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// GameStateSync.onRemoteBallPacket — seq drop (spec §Packet Sequencing)
// ---------------------------------------------------------------------------

describe('GameStateSync seq drop', () => {
  test('discards packets with seq <= lastSeq', () => {
    const g = makeSync(0);
    g.onRemoteBallPacket({ seq: 5, tLocal: 100, p: [5, 0, 0], v: [0, 0, 0], s: [0, 0, 0] });
    expect(g.lastSeq).toBe(5);

    // out-of-order (seq=3 < 5) — must be dropped
    g.onRemoteBallPacket({ seq: 3, tLocal: 90, p: [3, 0, 0], v: [0, 0, 0], s: [0, 0, 0] });
    expect(g.lastSeq).toBe(5);
    expect(g.latest.p.x).toBe(5);

    // duplicate (seq=5 == 5) — also dropped
    g.onRemoteBallPacket({ seq: 5, tLocal: 100, p: [99, 0, 0], v: [0, 0, 0], s: [0, 0, 0] });
    expect(g.latest.p.x).toBe(5);

    // strictly greater — accepted
    g.onRemoteBallPacket({ seq: 6, tLocal: 110, p: [6, 0, 0], v: [0, 0, 0], s: [0, 0, 0] });
    expect(g.lastSeq).toBe(6);
    expect(g.latest.p.x).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// PaddleSync seq drop
// ---------------------------------------------------------------------------

describe('PaddleSync seq drop', () => {
  test('drops out-of-order paddle packets', () => {
    const p = new PaddleSync(0);
    p.onRemotePacket({ seq: 10, tLocal: 0, fc: [0, 0, 0], fn: [0, 1, 0], pv: [0, 0, 0] });
    p.onRemotePacket({ seq: 9, tLocal: 0, fc: [99, 0, 0], fn: [0, 1, 0], pv: [0, 0, 0] });
    expect(p.lastSeq).toBe(10);
    expect(p.buffer.length).toBe(1);
    expect(p.buffer[0].fc.x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PaddleSync — delayed-eval interpolation + capped extrapolation
// ---------------------------------------------------------------------------

describe('PaddleSync.getRemoteFace', () => {
  function feed(p, seq, ts, x, pvx = 0) {
    // Mirror is across z = 0 with all-z-zero fixtures, so x passes through.
    p.onRemotePacket({ seq, tLocal: ts, fc: [x, 0, 0], fn: [0, 1, 0], pv: [pvx, 0, 0] });
  }

  test('interpolates inside the newest bracketing pair, not the two oldest', () => {
    const p = new PaddleSync(0);
    feed(p, 1, 1000, 0);
    feed(p, 2, 1016, 1);
    feed(p, 3, 1032, 2);
    // Eval midway between packets 2 and 3 — the old implementation lerped
    // buffer[0]..buffer[1] and would return 1.0 (clamped) here.
    const f = p.getRemoteFace(1024);
    expect(f.center.x).toBeCloseTo(1.5);
  });

  test('clamps to the oldest sample before the buffer', () => {
    const p = new PaddleSync(0);
    feed(p, 1, 1000, 3);
    feed(p, 2, 1016, 4);
    expect(p.getRemoteFace(900).center.x).toBeCloseTo(3);
  });

  test('extrapolates along sent paddle velocity beyond the newest packet', () => {
    const p = new PaddleSync(0);
    feed(p, 1, 1000, 0, 2);
    feed(p, 2, 1016, 0.5, 2); // moving +x at 2 m/s
    // 20 ms past the newest sample → 0.5 + 2 * 0.02 = 0.54.
    const f = p.getRemoteFace(1036);
    expect(f.center.x).toBeCloseTo(0.54);
    expect(f.velocity.x).toBeCloseTo(2);
  });

  test('freezes at PADDLE_EXTRAP_CAP_MS', () => {
    const p = new PaddleSync(0);
    feed(p, 1, 1000, 0.5, 2);
    // 500 ms past the only sample → capped at 50 ms → 0.5 + 2 * 0.05 = 0.6.
    const far = p.getRemoteFace(1500);
    expect(far.center.x).toBeCloseTo(0.5 + 2 * (PADDLE_EXTRAP_CAP_MS / 1000));
  });
});

// ---------------------------------------------------------------------------
// ThermalMonitor — fires onChange when rolling-avg dt crosses 20 ms
// ---------------------------------------------------------------------------

describe('ThermalMonitor', () => {
  let nowValue = 1000;
  let nowSpy;

  beforeEach(() => {
    nowValue = 1000;
    nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => nowValue);
    ThermalMonitor.reset();
  });
  afterEach(() => {
    nowSpy.mockRestore();
  });

  function advanceFrame(dt) {
    nowValue += dt;
    ThermalMonitor.tick();
  }

  test('starts NOT throttled', () => {
    expect(ThermalMonitor.isThrottled()).toBe(false);
  });

  test('does not flip on a single 25 ms hitch among normal frames', () => {
    // Fill the 10-frame window with normal 11 ms frames
    for (let i = 0; i < 10; i++) advanceFrame(11);
    expect(ThermalMonitor.isThrottled()).toBe(false);

    // Single hitch — avg = (11*9 + 25)/10 = 12.4 ms, still under 20 ms
    advanceFrame(25);
    expect(ThermalMonitor.isThrottled()).toBe(false);
  });

  test('flips to throttled when 10-frame avg exceeds 20 ms', () => {
    // 10 slow frames at 25 ms — avg crosses threshold
    const events = [];
    const unsub = ThermalMonitor.onChange((info) => events.push(info));

    for (let i = 0; i < 10; i++) advanceFrame(25);
    expect(ThermalMonitor.isThrottled()).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].throttled).toBe(true);
    expect(events[0].avgFrameMs).toBeGreaterThan(20);

    // 10 fast frames at 5 ms — flips back
    for (let i = 0; i < 10; i++) advanceFrame(5);
    expect(ThermalMonitor.isThrottled()).toBe(false);
    expect(events.length).toBe(2);
    expect(events[1].throttled).toBe(false);

    unsub();
  });

  test('does not fire change callback while buffer is still filling', () => {
    const events = [];
    ThermalMonitor.onChange((info) => events.push(info));
    // Even at 100 ms/frame, the first 9 ticks should not fire (buffer < 10).
    for (let i = 0; i < 9; i++) advanceFrame(100);
    expect(events.length).toBe(0);
    advanceFrame(100); // 10th frame — buffer full, threshold exceeded
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ReconnectHandler — stops after maxAttempts
// ---------------------------------------------------------------------------

describe('ReconnectHandler maxAttempts', () => {
  let warnSpy;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  function makeFakeNm() {
    const handlers = {};
    return {
      on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); },
      _fire(event, payload) { for (const fn of (handlers[event] || [])) fn(payload); },
    };
  }

  test('stops after maxAttempts when lobby.reconnect keeps failing', async () => {
    const lobby = { reconnect: jest.fn(() => Promise.reject(new Error('boom'))) };
    const rh = new ReconnectHandler({ lobby, sessionState: new SessionState(), maxAttempts: 3, retryDelayMs: 1 });

    const events = { attempting: 0, failed: 0, reconnected: 0 };
    rh.on('attempting', () => events.attempting++);
    rh.on('failed',     () => events.failed++);
    rh.on('reconnected',() => events.reconnected++);

    const nm = makeFakeNm();
    rh.watch(nm);
    nm._fire('disconnected', { state: 'failed' });

    // Each retry is scheduled via setTimeout(..., retryDelayMs=1). Wait for
    // them all to drain.
    await new Promise((r) => setTimeout(r, 50));

    expect(lobby.reconnect).toHaveBeenCalledTimes(3);
    expect(events.attempting).toBe(3);
    expect(events.failed).toBe(1);
    expect(events.reconnected).toBe(0);
  });

  test('resets attempt counter on success', async () => {
    let calls = 0;
    const lobby = {
      reconnect: jest.fn(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('first fail'));
        return Promise.resolve({ id: 'new-nm' });
      }),
    };
    const rh = new ReconnectHandler({ lobby, sessionState: new SessionState(), maxAttempts: 3, retryDelayMs: 1 });

    let reconnectedWith = null;
    rh.on('reconnected', ({ networkManager }) => { reconnectedWith = networkManager; });

    const nm = makeFakeNm();
    rh.watch(nm);
    nm._fire('disconnected', { state: 'failed' });

    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toBe(2);
    expect(reconnectedWith).toEqual({ id: 'new-nm' });
    expect(rh.attempts).toBe(0); // reset on success
  });
});

// ---------------------------------------------------------------------------
// SessionState — serialize / deserialize round-trip
// ---------------------------------------------------------------------------

describe('SessionState round-trip', () => {
  test('serialize → deserialize is identity for all fields', () => {
    const ss = new SessionState();
    ss.scoreSelf = 7;
    ss.scoreOpponent = 4;
    ss.rallyCount = 22;
    ss.ballOwner = 'opponent';
    ss.lastSeq = { game: 188, event: 12 };

    const snap = ss.serialize();
    const roundTripped = SessionState.deserialize(snap);

    expect(roundTripped.scoreSelf).toBe(7);
    expect(roundTripped.scoreOpponent).toBe(4);
    expect(roundTripped.rallyCount).toBe(22);
    expect(roundTripped.ballOwner).toBe('opponent');
    expect(roundTripped.lastSeq).toEqual({ game: 188, event: 12 });
  });

  test('deserialize handles empty / null snapshots gracefully', () => {
    expect(SessionState.deserialize(null).scoreSelf).toBe(0);
    expect(SessionState.deserialize(undefined).scoreSelf).toBe(0);
    expect(SessionState.deserialize({}).scoreSelf).toBe(0);
  });

  test('serialize returns a plain object (not a class instance)', () => {
    const ss = new SessionState();
    const snap = ss.serialize();
    expect(snap.constructor).toBe(Object);
  });
});
