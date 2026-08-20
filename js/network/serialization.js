// Wire serialization for the two data channels.
//   gameChannel  — msgpack (binary, compact for 60 Hz floats)
//   eventChannel — JSON    (human-readable, low frequency)
//
// Packet-type constants are centralized here so producers/consumers can't drift.

import msgpack from 'msgpack-lite';

export const PacketType = Object.freeze({
  // Game channel (msgpack)
  BALL_STATE:    1,
  PADDLE_STATE:  2,
  PING:          3,
  PONG:          4,
  // Unreliable duplicate of OWNERSHIP_HANDOFF — the receiver adopts whichever
  // copy lands first (dedupe by hitId), which is nearly always one of these
  // at a single one-way trip with no ordering delay.
  HANDOFF_G:     5,
  // Unreliable duplicate of NET_HIT (dedupe by eid) so the sound plays at
  // one one-way trip instead of waiting on reliable-channel ordering.
  NET_HIT_G:     6,

  // Event channel (JSON), kept as string codes for readability in logs
  OWNERSHIP_HANDOFF:  'OWNERSHIP_HANDOFF',
  TABLE_BOUNCE:       'TABLE_BOUNCE',
  NET_HIT:            'NET_HIT',
  BALL_LOST:          'BALL_LOST',
  SCORE_UPDATE:       'SCORE_UPDATE',
  // Rally verdict from the ball owner: { rallySeq, winner:
  // 'host'|'guest'|null, reason }. Both peers run the same deterministic
  // match transition; rallySeq (the sender's pre-apply rally counter) dedupes
  // crossed/duplicate verdicts. NOT named `seq` — NetworkManager.sendEvent
  // stamps the transport sequence number into `seq` in place, so a payload
  // field of that name would be silently clobbered before encoding.
  RALLY_END:          'RALLY_END',
  RECONCILIATION:     'RECONCILIATION',
  THERMAL_STATE:      'THERMAL_STATE',
  PLAYER_PAUSED:      'PLAYER_PAUSED',
  GAME_READY:         'GAME_READY',
  HELLO:              'HELLO',
  RECONNECT_RESTORE:  'RECONNECT_RESTORE',
});

export function encodeGame(packet) {
  return msgpack.encode(packet);
}

export function decodeGame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  return msgpack.decode(bytes);
}

export function encodeEvent(packet) {
  return JSON.stringify(packet);
}

export function decodeEvent(raw) {
  return JSON.parse(raw);
}
