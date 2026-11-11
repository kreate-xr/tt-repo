// js/account/tier.js — what the free version has, what the full version adds,
// and how the last known answer survives a reload (and an offline start).

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

let tier;
beforeEach(() => {
  jest.resetModules();
  globalThis.localStorage = fakeStorage();
  tier = require('../js/account/tier.js');
});
afterAll(() => { delete globalThis.localStorage; });

describe('free version', () => {
  test('is the default with nothing known', () => {
    expect(tier.isFull()).toBe(false);
  });

  test('has Club AI, a single game, Beginner training, Mixed Reality and the Focus Room', () => {
    expect(['beginner', 'intermediate', 'pro'].map(tier.canUseAiLevel)).toEqual([true, false, false]);
    expect([1, 3, 5].map(tier.canUseBestOf)).toEqual([true, false, false]);
    expect(['beginner', 'player'].map(tier.canUseTrainingLevel)).toEqual([true, false]);
    expect(['ar', 'vr-focus', 'vr-arena'].map(tier.canUseVenue)).toEqual([true, true, false]);
    expect(tier.canHostRoom()).toBe(false);
    expect(tier.canSeeProgressHistory()).toBe(false);
  });

  test('a stored length or tier it does not have falls back instead of failing', () => {
    expect(tier.effectiveBestOf(5)).toBe(1);
    expect(tier.effectiveBestOf(1)).toBe(1);
    expect(tier.effectiveAiLevel('pro')).toBe('beginner');
    expect(tier.effectiveAiLevel('beginner')).toBe('beginner');
  });
});

describe('full version', () => {
  test('has everything', () => {
    tier.setFull(true);
    expect(['beginner', 'intermediate', 'pro'].every(tier.canUseAiLevel)).toBe(true);
    expect([1, 3, 5].every(tier.canUseBestOf)).toBe(true);
    expect(['beginner', 'player'].every(tier.canUseTrainingLevel)).toBe(true);
    expect(['ar', 'vr-focus', 'vr-arena'].every(tier.canUseVenue)).toBe(true);
    expect(tier.canHostRoom()).toBe(true);
    expect(tier.canSeeProgressHistory()).toBe(true);
    expect(tier.effectiveBestOf(5)).toBe(5);
    expect(tier.effectiveAiLevel('pro')).toBe('pro');
  });

  test('only a literal true unlocks', () => {
    tier.setFull('yes');
    expect(tier.isFull()).toBe(false);
    tier.setFull(1);
    expect(tier.isFull()).toBe(false);
  });
});

describe('the last known answer', () => {
  test('survives a reload, so a full player keeps the full game offline', () => {
    tier.setFull(true);
    expect(globalThis.localStorage.data['tt.fullVersion']).toBe('1');
    const stored = globalThis.localStorage;
    jest.resetModules();
    globalThis.localStorage = stored;
    expect(require('../js/account/tier.js').isFull()).toBe(true);
  });

  test('a false answer (sign-out, refund) clears it', () => {
    globalThis.localStorage = fakeStorage({ 'tt.fullVersion': '1' });
    jest.resetModules();
    tier = require('../js/account/tier.js');
    expect(tier.isFull()).toBe(true);
    tier.setFull(false);
    expect(tier.isFull()).toBe(false);
    expect(globalThis.localStorage.data['tt.fullVersion']).toBeUndefined();
  });

  test('blocked storage: the answer still holds for this page load', () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    jest.resetModules();
    tier = require('../js/account/tier.js');
    expect(tier.isFull()).toBe(false);
    tier.setFull(true);
    expect(tier.isFull()).toBe(true);
  });
});

describe('change notifications', () => {
  test('fire on a change only, and stop after unsubscribing', () => {
    const seen = [];
    const off = tier.onTierChange((v) => seen.push(v));
    tier.setFull(false); // no change
    tier.setFull(true);
    tier.setFull(true); // no change
    tier.setFull(false);
    off();
    tier.setFull(true);
    expect(seen).toEqual([true, false]);
  });

  test('a throwing listener does not stop the others', () => {
    const seen = [];
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    tier.onTierChange(() => { throw new Error('boom'); });
    tier.onTierChange((v) => seen.push(v));
    tier.setFull(true);
    expect(seen).toEqual([true]);
    err.mockRestore();
  });
});

test('every locked feature has an in-headset line and a page sentence', () => {
  for (const [key, msg] of Object.entries(tier.LOCKED)) {
    expect(typeof msg.head).toBe('string');
    expect(msg.head.length).toBeGreaterThan(0);
    expect(msg.page).toMatch(/full game/);
    // The in-XR caption line holds ~925 px at the caption font: keep it short.
    expect(msg.head.length).toBeLessThanOrEqual(80);
    expect(key).toMatch(/^[a-z][A-Za-z]+$/);
  }
});
