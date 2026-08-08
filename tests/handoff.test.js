// HandoffManager — optimistic-authority protocol: hitId parity/monotonicity,
// dual-channel duplication, dedupe, implicit ACK via hid-tagged BALL_STATE,
// stale-epoch drops, timeout fallback, and the pending-race rule.

import { HandoffManager, HANDOFF_ACK_TIMEOUT_MS, HANDOFF_DUP_DELAYS_MS } from '../js/network/HandoffManager.js';
import { PacketType } from '../js/network/serialization.js';

function makeHm(role = 'host', nowRef = { t: 1000 }) {
  const reliable = [];
  const game = [];
  const hm = new HandoffManager({
    role,
    sendReliable: (m) => reliable.push(m),
    sendGame: (m) => game.push(m),
    now: () => nowRef.t,
  });
  return { hm, reliable, game, nowRef };
}

const BALL = { p: [0, 1, 0], v: [0, 0, 3], s: [0, 0, 0] };

describe('HandoffManager.localHit', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('host ids are even, guest ids are odd, both monotonic', () => {
    const { hm: host } = makeHm('host');
    expect(host.localHit(BALL) % 2).toBe(0);
    const first = host.currentHitId;
    expect(host.localHit(BALL)).toBeGreaterThan(first);

    const { hm: guest } = makeHm('guest');
    expect(guest.localHit(BALL) % 2).toBe(1);
  });

  test('sends one reliable copy and HANDOFF_DUP_DELAYS_MS game copies', () => {
    const { hm, reliable, game } = makeHm('host');
    const hitId = hm.localHit(BALL);

    expect(reliable).toHaveLength(1);
    expect(reliable[0].type).toBe(PacketType.OWNERSHIP_HANDOFF);
    expect(reliable[0].hitId).toBe(hitId);
    expect(reliable[0].ball).toBe(BALL);

    expect(game).toHaveLength(1); // delay-0 copy is synchronous
    jest.advanceTimersByTime(Math.max(...HANDOFF_DUP_DELAYS_MS));
    expect(game).toHaveLength(HANDOFF_DUP_DELAYS_MS.length);
    for (const g of game) {
      expect(g.type).toBe(PacketType.HANDOFF_G);
      expect(g.hitId).toBe(hitId);
    }
    // Fresh object per send — sendGame stamps seq/timestamp in place, so a
    // shared object would ship stale stamps.
    expect(new Set(game).size).toBe(game.length);

    expect(hm.isPending()).toBe(true);
  });
});

describe('HandoffManager.onRemoteHandoff', () => {
  test('adopts a fresh handoff once; duplicates across channels are ignored', () => {
    const { hm } = makeHm('host');
    const msg = { hitId: 7, ball: BALL };
    expect(hm.onRemoteHandoff(msg)).toBe(true);
    expect(hm.currentHitId).toBe(7);
    // Reliable copy + 3 unreliable copies → only the first adopted.
    expect(hm.onRemoteHandoff(msg)).toBe(false);
    expect(hm.onRemoteHandoff({ hitId: 7, ball: BALL })).toBe(false);
    // Older epoch — stale.
    expect(hm.onRemoteHandoff({ hitId: 5, ball: BALL })).toBe(false);
  });

  test('remote handoff while ours is pending wins (causally later) and clears pending', () => {
    jest.useFakeTimers();
    const { hm } = makeHm('host');
    const mine = hm.localHit(BALL);
    expect(hm.isPending()).toBe(true);
    // Opponent returned the ball inside our RTT window: their id builds on ours.
    expect(hm.onRemoteHandoff({ hitId: mine + 1, ball: BALL })).toBe(true);
    expect(hm.isPending()).toBe(false);
    expect(hm.currentHitId).toBe(mine + 1);
    jest.useRealTimers();
  });

  test('rejects malformed messages', () => {
    const { hm } = makeHm('host');
    expect(hm.onRemoteHandoff(null)).toBe(false);
    expect(hm.onRemoteHandoff({})).toBe(false);
    expect(hm.onRemoteHandoff({ hitId: 'x' })).toBe(false);
  });
});

describe('HandoffManager.onBallStateHid', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('first hid-matching packet is the implicit ACK, then normal flow', () => {
    const { hm } = makeHm('host');
    const hitId = hm.localHit(BALL);
    expect(hm.onBallStateHid(hitId)).toBe('ack');
    expect(hm.isPending()).toBe(false);
    // Same tag again: plain current-epoch packet.
    expect(hm.onBallStateHid(hitId)).toBe('ok');
  });

  test('packets tagged with an older epoch are stale', () => {
    const { hm } = makeHm('host');
    hm.onRemoteHandoff({ hitId: 9, ball: BALL });
    expect(hm.onBallStateHid(8)).toBe('stale');
    expect(hm.onBallStateHid(9)).toBe('ok');
    expect(hm.onBallStateHid(11)).toBe('ok'); // newer epoch (handoff still in flight)
  });

  test('non-matching tag does not ACK a pending handoff', () => {
    const { hm } = makeHm('host');
    const hitId = hm.localHit(BALL);
    expect(hm.onBallStateHid(hitId - 2)).toBe('stale');
    expect(hm.isPending()).toBe(true);
  });
});

describe('HandoffManager.tick timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('flips after HANDOFF_ACK_TIMEOUT_MS without an ACK', () => {
    const nowRef = { t: 1000 };
    const { hm } = makeHm('host', nowRef);
    hm.localHit(BALL);
    expect(hm.tick(nowRef.t + HANDOFF_ACK_TIMEOUT_MS)).toBe(false); // not yet expired
    expect(hm.tick(nowRef.t + HANDOFF_ACK_TIMEOUT_MS + 1)).toBe(true);
    expect(hm.isPending()).toBe(false);
    expect(hm.tick(nowRef.t + 9999)).toBe(false); // idempotent
  });

  test('no timeout when nothing is pending', () => {
    const { hm } = makeHm('guest');
    expect(hm.tick(99999)).toBe(false);
  });
});

describe('rally sequence', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('alternating hits keep ids strictly increasing with correct parity', () => {
    const { hm: host } = makeHm('host');
    const { hm: guest } = makeHm('guest');

    let last = 0;
    for (let i = 0; i < 5; i++) {
      const h = host.localHit(BALL);
      expect(h).toBeGreaterThan(last);
      expect(h % 2).toBe(0);
      last = h;
      expect(guest.onRemoteHandoff({ hitId: h, ball: BALL })).toBe(true);
      expect(host.onBallStateHid(h)).toBe('ack'); // guest's tagged stream

      const g = guest.localHit(BALL);
      expect(g).toBeGreaterThan(last);
      expect(g % 2).toBe(1);
      last = g;
      expect(host.onRemoteHandoff({ hitId: g, ball: BALL })).toBe(true);
      expect(guest.onBallStateHid(g)).toBe('ack');
    }
  });
});
