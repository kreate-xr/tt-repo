import { verifyChannels } from '../js/network/DataChannels.js';

describe('verifyChannels', () => {
  test('passes when both channels match the requested config', () => {
    const game   = { ordered: false, maxRetransmits: 0 };
    const events = { ordered: true };
    expect(() => verifyChannels(game, events)).not.toThrow();
  });

  test('throws CHANNEL_DEGRADED when gameChannel falls back to ordered', () => {
    const game   = { ordered: true, maxRetransmits: 0 };
    const events = { ordered: true };
    expect(() => verifyChannels(game, events)).toThrow(/CHANNEL_DEGRADED/);
  });

  test('throws CHANNEL_DEGRADED when gameChannel.maxRetransmits is non-zero', () => {
    const game   = { ordered: false, maxRetransmits: 3 };
    const events = { ordered: true };
    expect(() => verifyChannels(game, events)).toThrow(/CHANNEL_DEGRADED/);
  });

  test('throws CHANNEL_DEGRADED when eventChannel is not ordered', () => {
    const game   = { ordered: false, maxRetransmits: 0 };
    const events = { ordered: false };
    expect(() => verifyChannels(game, events)).toThrow(/CHANNEL_DEGRADED/);
  });
});
