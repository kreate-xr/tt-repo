// Machine Play menu model — navigation, mode selection and config pinning.

const {
  MachinePlayModel, SCREENS, ROOT_ITEMS, CHALLENGE_TARGETS,
} = require('../js/modes/machinePlay/machinePlayModel.js');
// From machineModes.js, not machinePlay.js — importing the drill would pull
// the scene graph (and GLTFLoader) into a headless model test.
const { MACHINE_MODES, DEFAULT_CHALLENGE_TARGET } = require('../js/modes/machinePlay/machineModes.js');
const { INFINITE } = require('../js/modes/training/drillConfig.js');

describe('navigation', () => {
  test('starts at the root with no way back', () => {
    const m = new MachinePlayModel();
    expect(m.screen).toBe(SCREENS.ROOT);
    expect(m.canGoBack).toBe(false);
    expect(m.back()).toBe(false);
  });

  test('lists the five root rows, all reachable', () => {
    const items = new MachinePlayModel().items();
    expect(items).toHaveLength(ROOT_ITEMS.length);
    // Unlike the training menu there is nothing here that is "not built yet",
    // so a disabled row would be a bug rather than honest signposting.
    for (const i of items) expect(i.available).toBe(true);
  });

  test('a row with a screen navigates and back pops one level', () => {
    const m = new MachinePlayModel();
    expect(m.selectItem('settings')).toBeNull();
    expect(m.screen).toBe(SCREENS.SETTINGS);
    expect(m.canGoBack).toBe(true);
    expect(m.back()).toBe(true);
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('the settings screen is not a list screen', () => {
    const m = new MachinePlayModel();
    m.selectItem('settings');
    expect(m.items()).toEqual([]);
  });

  test('breadcrumb tracks the whole stack', () => {
    const m = new MachinePlayModel();
    m.selectItem('challenge');
    expect(m.breadcrumb).toBe('MACHINE PLAY › SCORE CHALLENGE');
  });
});

describe('starting a mode', () => {
  test('Quick Rally starts the rally mode with the current config', () => {
    const m = new MachinePlayModel();
    const res = m.selectItem('quickRally');
    expect(res.action).toBe('start');
    expect(res.mode).toBe(MACHINE_MODES.RALLY);
    expect(res.config).toBe(m.config);
  });

  test('Survival starts the survival mode', () => {
    const res = new MachinePlayModel().selectItem('survival');
    expect(res.mode).toBe(MACHINE_MODES.SURVIVAL);
  });

  test('Free Hit returns an action rather than navigating', () => {
    const m = new MachinePlayModel();
    expect(m.selectItem('freeHit')).toEqual({ action: 'freeHit' });
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('Score Challenge lists its targets and starts on the chosen one', () => {
    const m = new MachinePlayModel();
    m.selectItem('challenge');
    expect(m.items()).toHaveLength(CHALLENGE_TARGETS.length);

    const res = m.selectItem('target:50');
    expect(res.action).toBe('start');
    expect(res.mode).toBe(MACHINE_MODES.CHALLENGE);
    expect(res.target).toBe(50);
    expect(m.challengeTarget).toBe(50);
  });

  test('the default challenge target is marked as current before any choice', () => {
    const m = new MachinePlayModel();
    m.selectItem('challenge');
    const current = m.items().filter((i) => i.subtitle === 'current target');
    expect(current).toHaveLength(1);
    expect(current[0].target).toBe(DEFAULT_CHALLENGE_TARGET);
  });

  test('START on the settings screen plays the edited feed as a rally', () => {
    const m = new MachinePlayModel();
    m.selectItem('settings');
    m.setField('speed', 11);
    const res = m.startFromSettings();
    expect(res.mode).toBe(MACHINE_MODES.RALLY);
    expect(res.config.speed).toBe(11);
  });

  test('an unknown row is ignored rather than throwing', () => {
    expect(new MachinePlayModel().selectItem('nonsense')).toBeNull();
  });
});

describe('config', () => {
  test('the burst is infinite from the start — each mode owns its own ending', () => {
    expect(new MachinePlayModel().config.burstCount).toBe(INFINITE);
  });

  test('editing any field cannot reintroduce a finite burst', () => {
    // FeedConfigModel re-validates the WHOLE config on every edit, so a
    // finite burstCount riding in from a preset would otherwise survive and
    // stop the machine mid-game for reasons the player cannot see.
    const m = new MachinePlayModel();
    m.config = { ...m.config, burstCount: 20 };
    m.setField('speed', 9);
    expect(m.config.burstCount).toBe(INFINITE);
  });

  test('edits survive a trip into a sub-screen and back', () => {
    const m = new MachinePlayModel();
    m.selectItem('settings');
    m.setZone(3);
    m.back();
    m.selectItem('settings');
    expect(m.zone).toBe(3);
  });

  test('the zone grid drives the depth band, as in Custom Feed', () => {
    const m = new MachinePlayModel();
    m.setZone(1);
    expect(m.config.depth).toBe('short');
    m.setZone(8);
    expect(m.config.depth).toBe('deep');
  });

  test('Quick Rally advertises the feed it is about to run', () => {
    const m = new MachinePlayModel();
    m.setField('speed', 12);
    const row = m.items().find((i) => i.id === 'quickRally');
    expect(row.subtitle).toContain('12');
  });
});
