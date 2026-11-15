// Play menu model — the Training Session's levels, plus Settings.

const {
  TrainingMenuModel, SCREENS, SETTING_ROWS,
} = require('../js/modes/training/menuModel.js');

// These suites describe the FULL version; js/account/tier.js defaults to the
// free one, whose locks have their own tests below.
const tier = require('../js/account/tier.js');
beforeEach(() => tier.setFull(true));

// Fake settings store with the same contract as profile/store.js: setSetting
// returns what was actually stored, and rejects unknown keys.
const fakeSettings = (initial = {}) => {
  const values = { dominantHand: 'R', audioCues: true, ...initial };
  return {
    getSetting: (k) => values[k],
    setSetting: (k, v) => {
      if (!(k in values)) return undefined;
      values[k] = v;
      return v;
    },
    _values: values,
  };
};

describe('play', () => {
  test('opens on the Training Session: its levels, then the Ball Machine row', () => {
    const m = new TrainingMenuModel();
    expect(m.screen).toBe(SCREENS.ROOT);
    expect(m.canGoBack).toBe(false);
    expect(m.title).toBe('TRAINING');
    expect(m.items().map((i) => i.id)).toEqual(['beginner', 'player', 'machine']);
    for (const i of m.items()) expect(i.available).toBe(true);
  });

  test('a level row starts the session with that level and the dominant hand', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings({ dominantHand: 'L' }) });
    expect(m.selectItem('player')).toEqual({
      action: 'start', drill: 'session', config: null,
      options: { level: 'player', hand: 'L' },
    });
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('a level row shows its best score once there is one', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings({ sessionBestPlayer: 82 }) });
    const [beginner, player] = m.items();
    expect(beginner.subtitle).not.toMatch(/Best/);
    expect(player.subtitle).toMatch(/Best 82%/);
  });

  test('unknown rows do nothing', () => {
    expect(new TrainingMenuModel().selectItem('ballMachine')).toBeNull();
  });
});

describe('navigation', () => {
  test('settings is one level down and back returns to play', () => {
    const m = new TrainingMenuModel();
    m.navigate(SCREENS.SETTINGS);
    expect(m.title).toBe('SETTINGS');
    expect(m.breadcrumb).toBe('PLAY › SETTINGS');
    expect(m.back()).toBe(true);
    expect(m.screen).toBe(SCREENS.ROOT);
    expect(m.back()).toBe(false);
  });

  test('reset returns to the root', () => {
    const m = new TrainingMenuModel();
    m.navigate(SCREENS.SETTINGS);
    m.reset();
    expect(m.screen).toBe(SCREENS.ROOT);
  });
});

describe('settings screen', () => {
  test('lists only wired settings, all of them live', () => {
    // A setting that changes nothing is worse than no setting (store.js);
    // the unwired M10 settings keep their specs but get no row.
    const m = new TrainingMenuModel({ settings: fakeSettings() });
    m.navigate(SCREENS.SETTINGS);
    const items = m.items();
    expect(items).toHaveLength(SETTING_ROWS.length);
    for (const i of items) expect(i.available).toBe(true);
    expect(items.find((i) => i.id === 'setting:dominantHand')).toBeTruthy();
  });

  test('the dominant-hand row shows its current value', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings({ dominantHand: 'L' }) });
    m.navigate(SCREENS.SETTINGS);
    const hand = m.items().find((i) => i.id === 'setting:dominantHand');
    expect(hand.subtitle).toMatch(/^Left/);
  });

  test('selecting the row cycles the value and persists it', () => {
    const store = fakeSettings({ dominantHand: 'R' });
    const m = new TrainingMenuModel({ settings: store });
    m.navigate(SCREENS.SETTINGS);

    expect(m.selectItem('setting:dominantHand')).toBeNull(); // stays on screen
    expect(store._values.dominantHand).toBe('L');
    expect(m.screen).toBe(SCREENS.SETTINGS);

    // Two values, so it cycles back rather than dead-ending.
    m.selectItem('setting:dominantHand');
    expect(store._values.dominantHand).toBe('R');
  });

  test('an unwired setting has no row and cannot be cycled', () => {
    const store = fakeSettings({ audioCues: true });
    const m = new TrainingMenuModel({ settings: store });
    m.navigate(SCREENS.SETTINGS);
    expect(m.items().find((i) => i.id === 'setting:audioCues')).toBeUndefined();
    expect(m.selectItem('setting:audioCues')).toBeNull();
    expect(m.cycleSetting('audioCues')).toBeNull();
    expect(store._values.audioCues).toBe(true);
  });

  test('without a store the rows are disabled rather than crashing', () => {
    const m = new TrainingMenuModel();
    m.navigate(SCREENS.SETTINGS);
    const hand = m.items().find((i) => i.id === 'setting:dominantHand');
    expect(hand.available).toBe(false);
    expect(hand.note).toBeTruthy();
    expect(m.selectItem('setting:dominantHand')).toBeNull();
  });

  test('cycleSetting refuses unknown keys', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings() });
    expect(m.cycleSetting('nonesuch')).toBeNull();
  });
});

describe('handedness', () => {
  test('defaults to right-handed with no store attached', () => {
    expect(new TrainingMenuModel().hand).toBe('R');
  });

  test('changing the setting is picked up without rebuilding the model', () => {
    const store = fakeSettings({ dominantHand: 'R' });
    const m = new TrainingMenuModel({ settings: store });
    expect(m.hand).toBe('R');
    m.navigate(SCREENS.SETTINGS);
    m.selectItem('setting:dominantHand');
    expect(m.hand).toBe('L');
  });
});

describe('free version', () => {
  const free = (id) => id === 'beginner';

  test('Beginner stays open; Player is locked, tappable, and says so', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings({ sessionBestPlayer: 82 }), canUseLevel: free });
    const [beginner, player] = m.items();
    expect(beginner.locked).toBeUndefined();
    expect(player).toMatchObject({ id: 'player', locked: true, available: true, action: 'locked' });
    expect(player.subtitle).toMatch(/full game/i);
    expect(player.subtitle).not.toMatch(/Best/);
  });

  test('a tap on the locked level starts nothing', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings(), canUseLevel: free });
    expect(m.selectItem('player')).toEqual({ action: 'locked', feature: 'trainingLevel' });
    expect(m.selectItem('beginner')).toMatchObject({ action: 'start', options: { level: 'beginner' } });
  });

  test('the default reads the tier, live', () => {
    tier.setFull(false);
    const m = new TrainingMenuModel({ settings: fakeSettings() });
    expect(m.selectItem('player').action).toBe('locked');
    tier.setFull(true);
    expect(m.selectItem('player').action).toBe('start');
  });
});

describe('ball machine', () => {
  const open = (opts) => {
    const m = new TrainingMenuModel(opts);
    expect(m.selectItem('machine')).toBeNull();
    return m;
  };

  test('the row opens the list: eight practices, Build your own, then the Random switch', () => {
    const m = open();
    expect(m.screen).toBe(SCREENS.MACHINE);
    expect(m.title).toBe('BALL MACHINE');
    expect(m.breadcrumb).toBe('PLAY › BALL MACHINE');
    expect(m.items().map((i) => i.id)).toEqual([
      'practice:forehand', 'practice:backhand', 'practice:push', 'practice:loop',
      'practice:sidespin', 'practice:twoPoint', 'practice:threePoint', 'practice:readSpin',
      'customOpen',
      'machineRandom',
    ]);
    for (const i of m.items()) expect(i.subtitle).toBeTruthy();
    expect(m.back()).toBe(true);
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('a practice row starts the machine on it, with the hand and the Random switch', () => {
    const m = open({ settings: fakeSettings({ dominantHand: 'L' }) });
    expect(m.selectItem('practice:push')).toEqual({
      action: 'start', drill: 'practice', config: null,
      options: { practice: 'push', hand: 'L', random: false },
    });
    expect(m.selectItem('machineRandom')).toBeNull();
    expect(m.items().find((i) => i.id === 'machineRandom').subtitle).toMatch(/^On/);
    expect(m.selectItem('practice:loop').options).toEqual({ practice: 'loop', hand: 'L', random: true });
    expect(m.selectItem('machineRandom')).toBeNull();
    expect(m.items().find((i) => i.id === 'machineRandom').subtitle).toMatch(/^Off/);
  });

  test('on the free version only the two drives start; the rest are tappable locks', () => {
    tier.setFull(false);
    const m = open();
    const rows = m.items().filter((i) => i.id.startsWith('practice:'));
    expect(rows.filter((r) => !r.locked).map((r) => r.id)).toEqual(['practice:forehand', 'practice:backhand']);
    expect(m.selectItem('practice:forehand').action).toBe('start');
    expect(m.selectItem('practice:readSpin')).toEqual({ action: 'locked', feature: 'practice' });
    // The Random switch is not a lock.
    expect(m.items().find((i) => i.id === 'machineRandom').locked).toBeUndefined();
  });
});

describe('build your own', () => {
  const open = (opts) => {
    const m = new TrainingMenuModel(opts);
    m.selectItem('machine');
    expect(m.selectItem('customOpen')).toBeNull();
    return m;
  };
  const sub = (m, id) => m.items().find((i) => i.id === id).subtitle;

  test('opens its own screen: spin, side, length, then START with the choice spelled out', () => {
    const m = open();
    expect(m.screen).toBe(SCREENS.CUSTOM);
    expect(m.title).toBe('BUILD YOUR OWN');
    expect(m.breadcrumb).toBe('PLAY › BALL MACHINE › BUILD YOUR OWN');
    expect(m.items().map((i) => i.id)).toEqual(['custom:spin', 'custom:side', 'custom:length', 'custom:start']);
    expect(sub(m, 'custom:start')).toBe('Topspin  ·  Forehand  ·  Long');
    expect(m.back()).toBe(true);
    expect(m.screen).toBe(SCREENS.MACHINE);
  });

  test('a tap moves a choice to its next value and wraps round', () => {
    const m = open();
    expect(m.selectItem('custom:spin')).toBeNull();
    expect(sub(m, 'custom:spin')).toMatch(/^Backspin/);
    for (let i = 0; i < 3; i++) m.selectItem('custom:spin');
    expect(sub(m, 'custom:spin')).toMatch(/^Topspin/);
    m.selectItem('custom:length');
    m.selectItem('custom:side');
    expect(sub(m, 'custom:start')).toBe('Topspin  ·  Middle  ·  Short');
  });

  test('START runs the machine on the built ball, and the choice is remembered', () => {
    const m = open({ settings: fakeSettings({ dominantHand: 'L' }) });
    m.selectItem('custom:spin');
    expect(m.selectItem('custom:start')).toEqual({
      action: 'start', drill: 'practice', config: null,
      options: {
        practice: 'custom', custom: { spin: 'back', side: 'forehand', length: 'long' },
        hand: 'L', random: false,
      },
    });
    m.reset();
    m.selectItem('machine');
    m.selectItem('customOpen');
    expect(sub(m, 'custom:spin')).toMatch(/^Backspin/);
  });

  test('is a tappable lock on the free version', () => {
    tier.setFull(false);
    const m = new TrainingMenuModel();
    m.selectItem('machine');
    expect(m.items().find((i) => i.id === 'customOpen').locked).toBe(true);
    expect(m.selectItem('customOpen')).toEqual({ action: 'locked', feature: 'practice' });
    expect(m.screen).toBe(SCREENS.MACHINE);
  });
});
