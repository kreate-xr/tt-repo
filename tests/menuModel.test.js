// M0 training menu model — navigation and Custom Feed editing.

const {
  TrainingMenuModel, SCREENS, SETTING_ROWS, CUSTOM_FIELDS, BURST_STOPS,
  describeConfig, formatField,
} = require('../js/modes/training/menuModel.js');
const { INFINITE, SPIN_MAX_RAD_S, validateConfig } = require('../js/modes/training/drillConfig.js');

// Fake preset store so the model is testable without localStorage.
const fakePresets = (initial = []) => {
  let list = [...initial];
  return {
    getPresets: () => list.map((p) => ({ name: p.name, config: { ...p.config } })),
    savePreset: (name, config) => {
      if (list.length >= 24 && !list.find((p) => p.name === name)) {
        return { ok: false, reason: 'full' };
      }
      list = list.filter((p) => p.name !== name).concat([{ name, config }]);
      return { ok: true };
    },
  };
};

describe('navigation', () => {
  test('starts at the root', () => {
    const m = new TrainingMenuModel();
    expect(m.screen).toBe(SCREENS.ROOT);
    expect(m.canGoBack).toBe(false);
  });

  test('lists the five live M0 branches', () => {
    expect(new TrainingMenuModel().items()).toHaveLength(5);
  });

  test('every root row is live — no placeholder entries', () => {
    // The build-out convention of listing unbuilt modes as disabled rows is
    // over: a shipped menu shows only what runs, and the roadmap lives in
    // ai-docs/tt-training-migration-plan.md §7.
    for (const i of new TrainingMenuModel().items()) {
      expect(i.available).toBe(true);
    }
  });

  test('Ball Machine opens the editor directly and backs out', () => {
    // No hub of sub-screens: the root row lands straight on the one editor.
    const m = new TrainingMenuModel();
    m.selectItem('ballMachine');
    expect(m.screen).toBe(SCREENS.CUSTOM_FEED);
    expect(m.canGoBack).toBe(true);
    m.back();
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('back at the root is a no-op', () => {
    const m = new TrainingMenuModel();
    expect(m.back()).toBe(false);
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('selecting a removed or unknown id does nothing', () => {
    // serveSchool was a root row once; a stale id (old deep link, old muscle
    // memory in a test) must be a no-op, not a crash or a navigation.
    const m = new TrainingMenuModel();
    expect(m.selectItem('serveSchool')).toBeNull();
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('breadcrumb tracks the stack', () => {
    const m = new TrainingMenuModel();
    m.selectItem('practice');
    m.selectItem('movement');
    expect(m.breadcrumb).toBe('TRAINING › PRACTICE › MOVEMENT');
  });

  test('Free Play returns an action rather than navigating', () => {
    const m = new TrainingMenuModel();
    expect(m.selectItem('freePlay')).toEqual({ action: 'freePlay' });
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('reset returns to the root from any depth', () => {
    const m = new TrainingMenuModel();
    m.selectItem('practice');
    m.selectItem('movement');
    m.reset();
    expect(m.screen).toBe(SCREENS.ROOT);
    expect(m.canGoBack).toBe(false);
  });
});

describe('practice intents', () => {
  // The Practice screen fronts intents, not machinery: the six rows are the
  // guard that every training capability stays reachable after the legacy
  // drills were absorbed into M1 wrappers.
  test('lists all seven intents, every one live', () => {
    const m = new TrainingMenuModel();
    m.selectItem('practice');
    expect(m.screen).toBe(SCREENS.PRACTICE);
    const ids = m.items().map((i) => i.id);
    for (const id of ['spinPractice', 'placementPractice', 'reaction',
      'movement', 'ladders', 'trajectoryPractice', 'weaknesses']) {
      expect(ids).toContain(id);
    }
    for (const i of m.items()) expect(i.available).toBe(true);
  });

  test('Spin and Placement start their drills by id with no config', () => {
    // The wrappers own their configs; the menu hands over only the id.
    const m = new TrainingMenuModel();
    m.navigate(SCREENS.PRACTICE);
    expect(m.selectItem('spinPractice'))
      .toEqual({ action: 'start', drill: 'spinPractice', config: null });
    expect(m.selectItem('placementPractice'))
      .toEqual({ action: 'start', drill: 'placementPractice', config: null });
  });

  test('Reaction starts Rapid Fire with the ladder running difficulty', () => {
    // Absorbs the old Rapid Fire row AND the legacy Reaction Rally: the
    // non-stop sweep with the bronze ladder underneath, no tier to pick.
    const m = new TrainingMenuModel();
    m.navigate(SCREENS.PRACTICE);
    const res = m.selectItem('reaction');
    expect(res.action).toBe('start');
    expect(res.options.pattern).toBe('rapidFire');
    expect(res.options.ladderTier).toBe('bronze');
    expect(res.options.random).toBe(false);
  });

  test('Movement and Fix My Weaknesses navigate rather than start', () => {
    const m = new TrainingMenuModel();
    m.navigate(SCREENS.PRACTICE);
    expect(m.selectItem('movement')).toBeNull();
    expect(m.screen).toBe(SCREENS.PATTERNS);
    m.back();
    expect(m.selectItem('weaknesses')).toBeNull();
    expect(m.screen).toBe(SCREENS.REVIEW);
  });

  test('Study a Shot starts the trajectory drill from the Practice list', () => {
    const m = new TrainingMenuModel();
    m.navigate(SCREENS.PRACTICE);
    const res = m.selectItem('trajectoryPractice');
    expect(res).toEqual({ action: 'start', drill: 'trajectoryPractice', config: null });
  });
});

describe('tutorial', () => {
  test('leads the root menu', () => {
    // It is the on-ramp for a first session; a returning player scans past
    // one row in no time.
    expect(new TrainingMenuModel().items()[0].id).toBe('tutorial');
  });

  test('starts directly by drill id with no config', () => {
    // The tutorial drill supplies its own per-step configs, so like the
    // legacy drills it starts straight from the row — no sub-screen.
    const m = new TrainingMenuModel();
    const res = m.selectItem('tutorial');
    expect(res).toEqual({ action: 'start', drill: 'tutorial', config: null });
    expect(m.screen).toBe(SCREENS.ROOT);
  });

  test('a finished tutorial says so but stays startable', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings({ tutorialComplete: true }) });
    const row = m.items().find((i) => i.id === 'tutorial');
    expect(row.subtitle).toMatch(/Completed/);
    expect(row.available).toBe(true);
    expect(m.selectItem('tutorial')).toEqual({ action: 'start', drill: 'tutorial', config: null });
  });

  test('an unfinished tutorial keeps its pitch line', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings() });
    const row = m.items().find((i) => i.id === 'tutorial');
    expect(row.subtitle).toMatch(/Three minutes/);
  });
});

describe('M7 review screen', () => {
  const { EventLog, OUTCOMES } = require('../js/profile/eventLog.js');

  const logWithWeakness = () => {
    const log = new EventLog();
    for (let i = 0; i < 10; i++) {
      log.recordFeed({
        config: { spinType: 'back', speed: 7, placement: { kind: 'zone', zone: 4 } },
        commandedLanding: { x: 0.1, z: 1 },
        verifiedLanding: { x: 0.1, z: 1 },
        feasible: true,
      }, i);
      log.recordOutcome(i < 8 ? OUTCOMES.MISS : OUTCOMES.RETURNED, { zone: 4, spin: 'back' });
    }
    return log;
  };

  test('with no session it says so rather than showing an empty list', () => {
    // "No data" and "no weaknesses" look identical otherwise, and the second
    // would be a lie.
    const m = new TrainingMenuModel({ getSessionLog: () => null });
    m.navigate(SCREENS.REVIEW);
    const items = m.items();
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/No session data/);
    expect(items[0].available).toBe(false);
  });

  test('an empty log is treated as no data', () => {
    const m = new TrainingMenuModel({ getSessionLog: () => new EventLog() });
    m.navigate(SCREENS.REVIEW);
    expect(m.items()[0].label).toMatch(/No session data/);
  });

  test('it leads with a session headline', () => {
    const m = new TrainingMenuModel({ getSessionLog: logWithWeakness });
    m.navigate(SCREENS.REVIEW);
    const items = m.items();
    expect(items[0].id).toBe('__headline__');
    expect(items[0].label).toMatch(/returned/);
  });

  test('weaknesses are listed with their miss rate', () => {
    const m = new TrainingMenuModel({ getSessionLog: logWithWeakness });
    m.navigate(SCREENS.REVIEW);
    const weak = m.items().filter((i) => i.id.startsWith('weak:'));
    expect(weak.length).toBeGreaterThan(0);
    expect(weak[0].label).toMatch(/% missed/);
    expect(weak[0].available).toBe(true);
  });

  test('tapping a weakness starts the drill it prescribes', () => {
    // This is what makes the report actionable rather than a list of
    // complaints — the whole point of M7 linking a preset per weakness.
    const m = new TrainingMenuModel({ getSessionLog: logWithWeakness });
    m.navigate(SCREENS.REVIEW);
    const weak = m.items().find((i) => i.id.startsWith('weak:'));
    const res = m.selectItem(weak.id);
    expect(res.action).toBe('start');
    expect(res.config).toBeTruthy();
    expect(res.preset).toBe(weak.presetKey);
  });

  test('backspin failures prescribe the backspin drill end to end', () => {
    const m = new TrainingMenuModel({ getSessionLog: logWithWeakness });
    m.navigate(SCREENS.REVIEW);
    const spinRow = m.items().find((i) => i.id === 'weak:spin:back');
    expect(spinRow).toBeTruthy();
    expect(m.selectItem(spinRow.id).config.spinType).toBe('back');
  });

  test('a session with no clear weakness says so, not nothing', () => {
    const log = new EventLog();
    for (let i = 0; i < 8; i++) {
      log.recordFeed({ config: { spinType: 'top', speed: 9, placement: { kind: 'zone', zone: 5 } },
        commandedLanding: { x: 0, z: 1 }, verifiedLanding: { x: 0, z: 1 }, feasible: true }, i);
      log.recordOutcome(OUTCOMES.RETURNED, { zone: 5, spin: 'top' });
    }
    const m = new TrainingMenuModel({ getSessionLog: () => log });
    m.navigate(SCREENS.REVIEW);
    expect(m.items().some((i) => i.id === '__nofault__')).toBe(true);
  });

  describe('why did I miss', () => {
    const THREE = require('three');
    const env = {
      tableBox: new THREE.Box3(
        new THREE.Vector3(-0.7625, -0.001, -1.37),
        new THREE.Vector3(0.7625, 0.001, 1.37),
      ),
      tableSurfaceY: 0, ballRadius: 0.02, tableCenterZ: 0,
    };
    const contact = (over = {}) => ({
      contactPos: new THREE.Vector3(0.1, 0.25, 1.0),
      contactVel: new THREE.Vector3(0, -1.2, -6.5),
      contactSpin: new THREE.Vector3(20, 0, 0),
      actualOutVel: new THREE.Vector3(0.2, 1.5, -4.5),
      actualOutSpin: new THREE.Vector3(10, 0, 0),
      actualFaceNormal: new THREE.Vector3(0, 0.2, -1).normalize(),
      contactLocal: { x: 0.002, y: -0.003 },
      ...over,
    });

    test('no contacts yields no diagnosis rather than a fabricated one', () => {
      const m = new TrainingMenuModel({
        getSessionLog: logWithWeakness,
        getRecentContacts: () => ({ contacts: [], env }),
      });
      expect(m.lastMissDiagnosis()).toBeNull();
      expect(m.items().some((i) => i.id === '__whymiss__')).toBe(false);
    });

    test('with no provider at all it stays silent', () => {
      const m = new TrainingMenuModel({ getSessionLog: logWithWeakness });
      expect(m.lastMissDiagnosis()).toBeNull();
    });

    test('it diagnoses the most recent contact', () => {
      const m = new TrainingMenuModel({
        getSessionLog: logWithWeakness,
        getRecentContacts: () => ({ contacts: [contact(), contact()], env }),
      });
      const d = m.lastMissDiagnosis();
      if (d) {
        expect(typeof d.headline).toBe('string');
        expect(d.headline.length).toBeGreaterThan(0);
        expect(d.result).toBeTruthy();
      }
    });

    test('a bad face angle is reported in degrees', () => {
      const m = new TrainingMenuModel({
        getSessionLog: logWithWeakness,
        getRecentContacts: () => ({
          contacts: [contact({ actualFaceNormal: new THREE.Vector3(1, 0, 0) })], env,
        }),
      });
      const d = m.lastMissDiagnosis();
      if (d && d.result.primaryFault === 'angle') expect(d.headline).toMatch(/°/);
    });

    test('an off-centre strike is reported in centimetres', () => {
      const m = new TrainingMenuModel({
        getSessionLog: logWithWeakness,
        getRecentContacts: () => ({
          contacts: [contact({ contactLocal: { x: 0.05, y: -0.04 } })], env,
        }),
      });
      const d = m.lastMissDiagnosis();
      if (d && d.result.primaryFault === 'contact') expect(d.headline).toMatch(/cm off centre/);
    });

    test('a degenerate contact never breaks the review screen', () => {
      // The solver runs on recorded state that can be nonsense; a diagnosis
      // must not be the thing that takes the whole screen down.
      const m = new TrainingMenuModel({
        getSessionLog: logWithWeakness,
        getRecentContacts: () => ({
          contacts: [contact({
            contactVel: new THREE.Vector3(NaN, NaN, NaN),
            actualFaceNormal: null,
          })],
          env,
        }),
      });
      expect(() => m.lastMissDiagnosis()).not.toThrow();
      expect(() => m.items()).not.toThrow();
    });
  });

  test('the review branch is enabled in the root menu', () => {
    const review = new TrainingMenuModel().items().find((i) => i.id === 'review');
    expect(review.available).toBe(true);
  });

  test('non-actionable rows cannot be selected', () => {
    const m = new TrainingMenuModel({ getSessionLog: logWithWeakness });
    m.navigate(SCREENS.REVIEW);
    expect(m.selectItem('__headline__')).toBeNull();
  });
});

describe('preset cycler', () => {
  // The one editor screen replaces the Quick Feed and Saved Presets lists:
  // Custom → the six curated feeds → whatever the player saved.
  test('cycles through the six quick feeds, loading each config', () => {
    const m = new TrainingMenuModel();
    expect(m.presetLabel).toBe('Custom');
    m.cyclePreset(1);
    expect(m.presetLabel).toBe('Warmup');
    expect(m.config.spinType).toBe('none');
    m.cyclePreset(1); m.cyclePreset(1); m.cyclePreset(1);
    expect(m.presetLabel).toBe('Backspin push');
    expect(m.config.spinType).toBe('back');
  });

  test('startCurrent hands over the loaded preset and its config', () => {
    const m = new TrainingMenuModel();
    m.cyclePreset(1);                       // Warmup
    const res = m.startCurrent();
    expect(res.action).toBe('start');
    expect(res.preset).toBe('Warmup');
    expect(res.config.speed).toBe(6);
  });

  test('saved presets join the cycle after the quick feeds', () => {
    const store = fakePresets([{ name: 'Mine', config: validateConfig({ speed: 12 }) }]);
    const m = new TrainingMenuModel({ presets: store });
    m.cyclePreset(-1);                      // ‹ from Custom wraps to the end
    expect(m.presetLabel).toBe('Mine');
    expect(m.config.speed).toBe(12);
    expect(m.startCurrent().preset).toBe('Mine');
  });

  test('with no store the cycle is Custom plus the six quick feeds', () => {
    expect(new TrainingMenuModel().presetOptions()).toHaveLength(7);
  });

  test('cycling back to Custom keeps the working config', () => {
    // Custom IS the player's edits — landing on it must not revert them.
    const m = new TrainingMenuModel();
    m.cyclePreset(1);                       // Warmup, speed 6
    m.cyclePreset(-1);                      // back to Custom
    expect(m.presetLabel).toBe('Custom');
    expect(m.selectedPreset).toBeNull();
    expect(m.config.speed).toBe(6);
  });

  test('editing a field snaps the cycler back to Custom', () => {
    // Once edited it is no longer that preset, and claiming otherwise would
    // mislabel what START is about to run.
    const m = new TrainingMenuModel();
    m.cyclePreset(1);
    expect(m.presetLabel).toBe('Warmup');
    m.setField('speed', 20);
    expect(m.presetLabel).toBe('Custom');
  });
});

describe('saving presets', () => {
  test('saving from the editor persists the edited config', () => {
    const store = fakePresets();
    const m = new TrainingMenuModel({ presets: store });
    m.setField('speed', 15);
    expect(m.savePreset('Fast').ok).toBe(true);
    expect(store.getPresets()[0].config.speed).toBe(15);
    expect(m.message).toMatch(/Saved/);
  });

  test('a full preset list reports a usable message', () => {
    const full = Array.from({ length: 24 }, (_, i) => ({ name: `p${i}`, config: validateConfig({}) }));
    const m = new TrainingMenuModel({ presets: fakePresets(full) });
    expect(m.savePreset('one more').ok).toBe(false);
    expect(m.message).toMatch(/full/);
  });

  test('saving with no store attached fails cleanly', () => {
    const m = new TrainingMenuModel();
    expect(m.savePreset('x').ok).toBe(false);
  });
});

describe('custom feed editing', () => {
  test('exposes the M1 attributes', () => {
    const keys = CUSTOM_FIELDS.map((f) => f.key);
    for (const k of ['speed', 'spinType', 'spinMagnitude', 'placement',
      'arc', 'scatterSigma', 'interval', 'burstCount', 'feedOrigin', 'audioCue']) {
      expect(keys).toContain(k);
    }
    // Depth is deliberately NOT a custom field: the zone grid owns the row.
    expect(keys).not.toContain('depth');
  });

  test('the spin slider stops at the feasible envelope, not the spec 900', () => {
    // A control must never offer a value the validator would clamp.
    const spin = CUSTOM_FIELDS.find((f) => f.key === 'spinMagnitude');
    expect(spin.max).toBe(SPIN_MAX_RAD_S);
  });

  test('every slider field declares bounds matching the validator', () => {
    const m = new TrainingMenuModel();
    for (const f of CUSTOM_FIELDS.filter((x) => x.kind === 'slider')) {
      expect(m.setField(f.key, f.max + 1000)).toBeLessThanOrEqual(f.max);
      expect(m.setField(f.key, f.min - 1000)).toBeGreaterThanOrEqual(f.min);
    }
  });

  test('setField routes through the validator', () => {
    const m = new TrainingMenuModel();
    expect(m.setField('spinMagnitude', 9000)).toBe(SPIN_MAX_RAD_S);
    expect(m.setField('speed', -50)).toBe(2);
  });

  test('zone selection covers all nine zones', () => {
    const m = new TrainingMenuModel();
    for (let z = 1; z <= 9; z++) {
      expect(m.setZone(z)).toBe(z);
      expect(m.zone).toBe(z);
    }
  });

  test('an out-of-range zone falls back rather than sticking', () => {
    const m = new TrainingMenuModel();
    m.setZone(99);
    expect(m.zone).toBe(5);
  });

  test('cycling a segment wraps in both directions', () => {
    const m = new TrainingMenuModel();
    const first = m.config.arc;
    m.cycleField('arc', 1);
    expect(m.config.arc).not.toBe(first);
    m.cycleField('arc', -1);
    expect(m.config.arc).toBe(first);
  });

  test('setZone keeps depth in step with the zone row', () => {
    const m = new TrainingMenuModel();
    m.setZone(3);
    expect(m.config.depth).toBe('short');
    m.setZone(5);
    expect(m.config.depth).toBe('half-long');
    m.setZone(7);
    expect(m.config.depth).toBe('deep');
  });

  test('cycling wraps past the ends without going out of bounds', () => {
    const m = new TrainingMenuModel();
    for (let i = 0; i < 20; i++) m.cycleField('spinType', 1);
    expect(validateConfig(m.config).spinType).toBe(m.config.spinType);
  });

  test('burst steps through named stops and clamps at the ends', () => {
    const m = new TrainingMenuModel();
    for (let i = 0; i < 20; i++) m.stepBurst(1);
    expect(m.config.burstCount).toBe(INFINITE);
    for (let i = 0; i < 20; i++) m.stepBurst(-1);
    expect(m.config.burstCount).toBe(BURST_STOPS[0]);
  });

  test('spin amount is disabled when spin type is none', () => {
    const m = new TrainingMenuModel();
    m.setField('spinType', 'none');
    expect(m.spinAmountEnabled).toBe(false);
    m.setField('spinType', 'top');
    expect(m.spinAmountEnabled).toBe(true);
  });

  test('edits survive navigating away and back', () => {
    const m = new TrainingMenuModel();
    m.selectItem('ballMachine');
    m.setField('speed', 17);
    m.back();
    m.selectItem('ballMachine');
    expect(m.config.speed).toBe(17);
  });

  test('startCurrent hands over the edited config', () => {
    const m = new TrainingMenuModel();
    m.setField('speed', 11);
    m.setZone(3);
    const res = m.startCurrent();
    expect(res.action).toBe('start');
    expect(res.config.speed).toBe(11);
    expect(res.config.placement.zone).toBe(3);
  });
});

describe('formatting', () => {
  test('describeConfig produces a readable one-liner', () => {
    const s = describeConfig(validateConfig({ speed: 9, spinType: 'top', spinMagnitude: 120 }));
    expect(s).toMatch(/9 m\/s/);
    expect(s).toMatch(/top/);
  });

  test('no spin reads as "no spin", not "none 0"', () => {
    expect(describeConfig(validateConfig({ spinType: 'none' }))).toMatch(/no spin/);
  });

  test('infinite burst renders as the symbol', () => {
    expect(describeConfig(validateConfig({ burstCount: INFINITE }))).toMatch(/∞/);
  });

  test('formatField renders each control kind', () => {
    const m = new TrainingMenuModel();
    const byKey = (k) => CUSTOM_FIELDS.find((f) => f.key === k);
    expect(formatField(byKey('audioCue'), m.config)).toBe('ON');
    expect(formatField(byKey('speed'), m.config)).toMatch(/m\/s/);
    expect(formatField(byKey('placement'), m.config)).toMatch(/zone 5/);
    m.setField('burstCount', INFINITE);
    expect(formatField(byKey('burstCount'), m.config)).toBe('∞');
  });

  test('slider decimals suit the step size', () => {
    const m = new TrainingMenuModel();
    const scatter = CUSTOM_FIELDS.find((f) => f.key === 'scatterSigma');
    // 0.01 steps need two decimals or the display quantises to nothing.
    expect(formatField(scatter, m.config)).toMatch(/0\.\d\d/);
  });
});

describe('movement screen feed order', () => {
  test('leads with the order toggle, then the eight classics', () => {
    const m = new TrainingMenuModel();
    m.selectItem('practice');
    m.selectItem('movement');
    const items = m.items();
    expect(items[0].id).toBe('__order__');
    expect(items).toHaveLength(9);
    expect(items[0].subtitle).toMatch(/In order/);
  });

  test('toggling flips subsequent pattern starts to shuffled and back', () => {
    const m = new TrainingMenuModel();
    m.navigate(SCREENS.PATTERNS);
    expect(m.selectItem('__order__')).toBeNull();   // stays on screen
    expect(m.items()[0].subtitle).toMatch(/Shuffled/);
    expect(m.selectItem('falkenberg').options.random).toBe(true);
    m.selectItem('__order__');
    expect(m.selectItem('falkenberg').options.random).toBe(false);
  });

  test('re-entering Movement resets to in-order', () => {
    // The toggle is per visit: a shuffled session last week must not
    // silently shuffle today's deliberate shape practice.
    const m = new TrainingMenuModel();
    m.selectItem('practice');
    m.selectItem('movement');
    m.selectItem('__order__');
    m.back();
    m.selectItem('movement');
    expect(m.selectItem('falkenberg').options.random).toBe(false);
  });

  test('a stale toggle cannot shuffle Reaction', () => {
    // Reaction pins random: false regardless of the Movement screen's state.
    const m = new TrainingMenuModel();
    m.selectItem('practice');
    m.selectItem('movement');
    m.selectItem('__order__');                      // shuffled
    m.back();
    const res = m.selectItem('reaction');
    expect(res.options.random).toBe(false);
  });
});

// --- M10 settings screen ------------------------------------------------------

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

describe('handedness reaches the drills', () => {
  test('defaults to right-handed with no store attached', () => {
    expect(new TrainingMenuModel().hand).toBe('R');
  });

  test('patterns are started with the profile handedness, not a fixed R', () => {
    // patterns.js mirrors backhand/forehand columns off this flag, so a
    // left-hander getting 'R' here drills the wrong wing all session.
    const m = new TrainingMenuModel({ settings: fakeSettings({ dominantHand: 'L' }) });
    m.selectItem('practice');
    const res = m.selectItem('reaction');
    expect(res.options.hand).toBe('L');
  });

  test('ladders carry handedness too', () => {
    const m = new TrainingMenuModel({ settings: fakeSettings({ dominantHand: 'L' }) });
    m.selectItem('practice');
    m.selectItem('ladders');
    const res = m.selectItem('bronze');
    expect(res.options.hand).toBe('L');
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
