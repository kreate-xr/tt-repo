// The free / unlocked line under the venue buttons, and the venue gate.
// There is no trial: the free version is unlimited, the line says what the
// full game adds, and only the Arena is gated at the door.

import { accessLine, canEnter } from '../js/ui/accountPanel.js';
import { setFull } from '../js/account/tier.js';

test('free: no clock, no "trial", and it names what unlocking adds', () => {
  for (const acc of [null, { entitled: false }, { entitled: false, signedIn: true }]) {
    const line = accessLine(acc);
    expect(line.state).toBe('free');
    expect(line.title).toMatch(/free to play/i);
    expect(line.title + line.sub).not.toMatch(/trial|minutes? (left|of play)/i);
    for (const word of ['International', 'Elite', 'best of 3', 'Arena', 'hosting']) {
      expect(line.sub).toContain(word);
    }
  }
});

test('owned: the full game line', () => {
  const line = accessLine({ entitled: true });
  expect(line.state).toBe('owned');
  expect(line.title).toMatch(/unlocked/i);
});

describe('canEnter', () => {
  afterEach(() => setFull(false));

  test('free: Mixed Reality and the Focus Room go straight in', () => {
    setFull(false);
    expect(canEnter('ar')).toBe(true);
    expect(canEnter('vr-focus')).toBe(true);
  });

  test('free: the Arena does not (the unlock dialog opens instead)', () => {
    setFull(false);
    // No markup in this test: startPurchase is a no-op without the modal.
    expect(canEnter('vr-arena')).toBe(false);
  });

  test('full: every venue', () => {
    setFull(true);
    expect(['ar', 'vr-focus', 'vr-arena'].every(canEnter)).toBe(true);
  });
});
