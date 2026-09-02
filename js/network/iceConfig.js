// ICE server configuration. STUN alone leaves ~15% of players (symmetric /
// restrictive NAT) unable to connect at all — TURN relay is the fallback that
// makes those sessions work.
//
// Relay sizing, from the actual wire format (msgpack-lite encodes every
// non-integer as a 9-byte float64, so the packets are not as small as they
// look): BALL_STATE carries 9 floats + seq + timestamp ≈ 126 B, PADDLE_STATE
// ≈ 123 B, and NetworkManager's send loop emits BOTH at 60 Hz. That is
// ~15 KB/s of payload, ~200 kbps per direction once DTLS/SCTP/UDP/IP headers
// are counted (~80 B on 120 packets/s), so ~400 kbps for a relayed session —
// TURN carries both directions. Packet rate (240 pps/session) saturates a
// small coturn box before bandwidth does; budget a few hundred concurrent
// relayed sessions per $5 VM, and ~$0.003 of cloud egress per relayed
// 10-minute match. A managed service (Cloudflare Calls, Twilio NTS,
// Metered.ca) removes the capacity planning entirely.
//
// Configuration, in priority order:
//   1. Explicit override passed to LobbyManager({ iceServers }) — use this to
//      inject short-lived HMAC credentials fetched from a backend at
//      lobby-join time (standard TURN REST API pattern). Preferred for
//      production: never ship long-lived TURN credentials in the bundle.
//   2. Vite env vars (build-time, fine for testing / small deployments):
//        VITE_TURN_URLS       comma-separated, e.g.
//                             turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp
//        VITE_TURN_USERNAME
//        VITE_TURN_CREDENTIAL
//   3. STUN-only fallback (Google public STUN) — direct P2P still works.
//
// This module is the only place that reads TURN env config. It uses
// import.meta.env, so keep it out of Jest-imported dependency chains
// (babel-jest cannot transform import.meta to CJS).

export function getDefaultIceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  if (env.VITE_TURN_URLS) {
    servers.push({
      urls: env.VITE_TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
      username: env.VITE_TURN_USERNAME || '',
      credential: env.VITE_TURN_CREDENTIAL || '',
    });
  }
  return servers;
}
