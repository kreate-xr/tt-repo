// Dual data channel setup.
//
//   game   — unreliable, unordered (msgpack-encoded 60 Hz state)
//   events — reliable, ordered     (JSON; ownership handoff, score, etc.)
//
// Only the host (offerer) calls createChannels(). The guest reads the channels
// off pc.ondatachannel — see receiveChannels() for that side. After both peers
// observe the channels in 'open' state, verifyChannels() asserts the browser
// did not silently downgrade the negotiated config.

const GAME_LABEL = 'game';
const EVENT_LABEL = 'events';

export function createChannels(pc) {
  const game = pc.createDataChannel(GAME_LABEL, {
    ordered: false,
    maxRetransmits: 0,
  });
  const events = pc.createDataChannel(EVENT_LABEL, {
    ordered: true,
  });
  return { game, events };
}

// Guest-side: receive both channels via pc.ondatachannel and resolve once both
// have arrived. The host's createChannels order is preserved by the SDP, so
// labels are how we route them.
export function receiveChannels(pc) {
  return new Promise((resolve, reject) => {
    let game = null;
    let events = null;
    const timeout = setTimeout(() => {
      reject(new Error('DATA_CHANNELS_TIMEOUT: peer did not open both channels'));
    }, 15000);

    pc.addEventListener('datachannel', (e) => {
      const ch = e.channel;
      if (ch.label === GAME_LABEL) game = ch;
      else if (ch.label === EVENT_LABEL) events = ch;
      else return;
      if (game && events) {
        clearTimeout(timeout);
        resolve({ game, events });
      }
    });
  });
}

export function waitForOpen(...channels) {
  return Promise.all(channels.map((ch) => new Promise((resolve, reject) => {
    if (ch.readyState === 'open') return resolve();
    if (ch.readyState === 'closed') return reject(new Error('CHANNEL_CLOSED_BEFORE_OPEN'));
    ch.addEventListener('open', () => resolve(), { once: true });
    ch.addEventListener('error', (e) => reject(e), { once: true });
  })));
}

// Throws CHANNEL_DEGRADED if the browser silently re-negotiated either channel
// away from the requested config. Caller must teardown and retry on throw.
export function verifyChannels(game, events) {
  if (game.ordered !== false || game.maxRetransmits !== 0) {
    throw new Error(`CHANNEL_DEGRADED: gameChannel fell back (ordered=${game.ordered}, maxRetransmits=${game.maxRetransmits})`);
  }
  if (events.ordered !== true) {
    throw new Error(`CHANNEL_DEGRADED: eventChannel is not ordered (ordered=${events.ordered})`);
  }
}
