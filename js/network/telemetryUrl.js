// Where the multiplayer drill's 2 s pc.getStats() beacon POSTs.
//
// Its own module because it reads import.meta.env, which babel-jest cannot
// transform — keeping it out of multiplayer.js lets Jest import the drill
// (tests mock this file), same reasoning as js/network/iceConfig.js.
export const TELEMETRY_URL = (() => {
  const fromEnv = typeof import.meta !== 'undefined'
    && import.meta.env
    && import.meta.env.VITE_TELEMETRY_URL;
  if (fromEnv) return fromEnv;
  const host = (typeof location !== 'undefined' && location.hostname) || 'localhost';
  // No deployed sink: the :8081 dev server (server/telemetry-server.js) only
  // exists locally. Off localhost, disable beaconing (TelemetryReporter keeps
  // sampling for the in-session HUD; it just doesn't POST anywhere).
  if (host !== 'localhost' && host !== '127.0.0.1') return null;
  // Always plain http(s) — telemetry sink is independent of the signaling
  // protocol. Match the page's protocol to avoid mixed-content blocking.
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'https' : 'http';
  return `${proto}://${host}:8081/telemetry`;
})();
