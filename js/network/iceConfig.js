// ICE server configuration. STUN alone leaves ~15% of players (symmetric /
// restrictive NAT) unable to connect at all — TURN relay is the fallback that
// makes those sessions work. Data-channel traffic is ~10-20 kbps per session,
// so relay bandwidth cost is negligible; a managed service (Cloudflare Calls,
// Twilio NTS, Metered.ca) or a $5 coturn VM both suffice.
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
