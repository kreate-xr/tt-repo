// Play menu model — the Training Session's levels, plus Settings.

const {
  TrainingMenuModel, SCREENS, SETTING_ROWS,
} = require('../js/modes/training/menuModel.js');

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
  test('opens on the Training Session and lists only its levels', () => {
    const m = new TrainingMenuModel();
    expect(m.screen).toBe(SCREENS.ROOT);
    expect(m.canGoBack).toBe(false);
    expect(m.title).toBe('TRAINING SESSION');
    expect(m.items().map((i) => i.id)).toEqual(['beginner', 'player']);
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
