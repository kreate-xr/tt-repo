// Ball Machine practice — the model (js/modes/training/practice.js).
//
// Pins: every ball this mode can ever ask for is a real feed (both hands,
// every speed step, with and without the Random switch); steps cycle or draw
// as the practice says; the thumbstick steps stop at the ends of their range;
// and "backhand" mirrors for a left-hander.

const THREE = require('three');
const { solveFeed } = require('../js/modes/training/feedEngine.js');
const { mulberry32 } = require('../js/util/rng.js');
const { WINGS } = require('../js/modes/training/session.js');
const {
  PRACTICES, PRACTICE_ORDER, PracticeModel, practiceConfig, getPractice,
  SPEED_STEPS, TEMPO_STEPS, BASE,
} = require('../js/modes/training/practice.js');

// Real ITTF table, player half +z (same env as tests/session.test.js).
const HALF_LEN = 1.37;
const HALF_WID = 0.7625;
const env = {
  ballRadius: 0.02,
  tableSurfaceY: 0,
  tableBox: new THREE.Box3(
    new THREE.Vector3(-HALF_WID, -0.001, -HALF_LEN),
    new THREE.Vector3(HALF_WID, 0.001, HALF_LEN),
  ),
  netBox: new THREE.Box3(
    new THREE.Vector3(-HALF_WID - 0.14, 0, -0.005),
    new THREE.Vector3(HALF_WID + 0.14, 0.1525, 0.005),
  ),
};

const speedSteps = [];
for (let s = SPEED_STEPS.min; s <= SPEED_STEPS.max; s++) speedSteps.push(s);

describe('feasibility', () => {
  // A ball the solver refuses is skipped by the machine, which the player
  // reads as the machine breaking.
  for (const p of PRACTICES) {
    test(`${p.id}: every step lands at every speed, both hands, random or not`, () => {
      const bad = [];
      for (const hand of ['R', 'L']) {
        for (const speedStep of speedSteps) {
          for (const step of p.steps) {
            for (const wing of [WINGS.BH, WINGS.MID, WINGS.FH]) {
              const cfg = { ...practiceConfig(step, { hand, speedStep, wing }), scatterSigma: 0 };
              if (!solveFeed(cfg, env).feasible) {
                bad.push(`${hand} speed${speedStep} ${step.spinType}/${step.depth} wing=${wing}`);
              }
            }
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe('the list', () => {
  test('eight practices, each with a label, a one-line blurb and at least one step', () => {
    expect(PRACTICE_ORDER).toEqual([
      'forehand', 'backhand', 'push', 'loop', 'sidespin', 'twoPoint', 'threePoint', 'readSpin',
    ]);
    for (const p of PRACTICES) {
      expect(p.label).toBeTruthy();
      expect(p.blurb.length).toBeLessThanOrEqual(60);
      expect(p.steps.length).toBeGreaterThan(0);
    }
    expect(getPractice('nope')).toBeNull();
  });

  test('step 0 is the Beginner feed; the top speed step is near Player pace and spin', () => {
    const base = practiceConfig(PRACTICES[0].steps[0]);
    expect(base.speed).toBeCloseTo(BASE.speed);
    expect(base.spinMagnitude).toBeCloseTo(BASE.spin);
    const top = practiceConfig(PRACTICES[0].steps[0], { speedStep: SPEED_STEPS.max });
    expect(top.speed).toBeCloseTo(9);
    expect(top.spinMagnitude).toBeGreaterThan(250);
    expect(top.spinMagnitude).toBeLessThan(300);
  });

  test('backhand and forehand mirror for a left-hander', () => {
    const bh = getPractice('backhand').steps[0];
    expect(practiceConfig(bh, { hand: 'R' }).placement.zone).toBe(7);
    expect(practiceConfig(bh, { hand: 'L' }).placement.zone).toBe(9);
  });
});

describe('model', () => {
  test('an unknown practice falls back to the first', () => {
    expect(new PracticeModel({ practice: 'ghost' }).practice.id).toBe('forehand');
  });

  test('a fixed practice cycles its steps in order', () => {
    const m = new PracticeModel({ practice: 'threePoint' });
    const zones = [0, 1, 2, 3].map((b) => m.nextConfig(b).placement.zone);
    expect(zones).toEqual([7, 8, 9, 7]);
  });

  test('a random practice draws its steps', () => {
    const m = new PracticeModel({ practice: 'readSpin', rng: mulberry32(7) });
    const spins = new Set();
    for (let b = 0; b < 40; b++) spins.add(m.nextConfig(b).spinType);
    expect([...spins].sort()).toEqual(['back', 'top']);
  });

  test('the Random switch moves the ball between all three sides, keeping the spin', () => {
    const m = new PracticeModel({ practice: 'forehand', random: true, rng: mulberry32(3) });
    const zones = new Set();
    for (let b = 0; b < 60; b++) {
      const c = m.nextConfig(b);
      zones.add(c.placement.zone);
      expect(c.spinType).toBe('top');
    }
    expect([...zones].sort()).toEqual([7, 8, 9]);
  });

  test('speed steps change pace and stop at both ends', () => {
    const m = new PracticeModel({ practice: 'forehand' });
    const v0 = m.nextConfig(0).speed;
    expect(m.adjust('speed', 1)).toMatchObject({ kind: 'speed', changed: true, level: 4, of: 8 });
    expect(m.nextConfig(1).speed).toBeGreaterThan(v0);
    for (let i = 0; i < 10; i++) m.adjust('speed', 1);
    expect(m.adjust('speed', 1)).toMatchObject({ changed: false, level: 8 });
    for (let i = 0; i < 20; i++) m.adjust('speed', -1);
    expect(m.speedLevel).toBe(1);
    expect(m.nextConfig(2).speed).toBeLessThan(v0);
  });

  test('tempo steps shorten the gap between balls and stop at both ends', () => {
    const m = new PracticeModel({ practice: 'forehand' });
    const i0 = m.nextConfig(0).interval;
    m.adjust('tempo', 1);
    expect(m.nextConfig(1).interval).toBeCloseTo(i0 - TEMPO_STEPS.seconds);
    for (let i = 0; i < 10; i++) m.adjust('tempo', 1);
    expect(m.tempoLevel).toBe(m.tempoLevels);
    expect(m.nextConfig(2).interval).toBeGreaterThanOrEqual(0.8);
    expect(m.adjust('nope', 1)).toBeNull();
  });

  test('counts returns and streaks, and says so in one line', () => {
    const m = new PracticeModel({ practice: 'push' });
    m.recordOutcome({ result: 'returned' });
    m.recordOutcome({ result: 'returned' });
    m.recordOutcome({ result: 'miss' });
    m.recordOutcome({ result: 'returned' });
    expect([m.faced, m.returned, m.streak, m.bestStreak]).toEqual([4, 3, 1, 2]);
    expect(m.liveLine()).toBe('Push the backspin  ·  Speed 3/8  ·  Tempo 3/7  ·  3/4 back');
    expect(new PracticeModel({ practice: 'push', random: true }).liveLine()).toMatch(/\(random\)/);
  });
});

describe('build your own', () => {
  const {
    CUSTOM_OPTIONS, CUSTOM_DEFAULT, customPractice, customSummary, normalizeCustom,
  } = require('../js/modes/training/practice.js');

  test('every spin x side x length lands at every speed, for both hands', () => {
    const bad = [];
    for (const spin of CUSTOM_OPTIONS.spin) {
      for (const length of CUSTOM_OPTIONS.length) {
        // 'random' draws from the three real sides, so sweep those.
        for (const wing of [WINGS.BH, WINGS.MID, WINGS.FH]) {
          const p = customPractice({ spin: spin.id, side: 'middle', length: length.id });
          for (const step of p.steps) {
            for (const hand of ['R', 'L']) {
              for (const speedStep of speedSteps) {
                const cfg = { ...practiceConfig(step, { hand, speedStep, wing }), scatterSigma: 0 };
                if (!solveFeed(cfg, env).feasible) bad.push(`${spin.id}/${length.id} ${wing} ${hand} speed${speedStep}`);
              }
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test('a choice becomes the ball it names', () => {
    const cfg = (choice, hand = 'R') => practiceConfig(customPractice(choice).steps[0], { hand });
    expect(cfg({ spin: 'back', side: 'forehand', length: 'short' })).toMatchObject({
      spinType: 'back', depth: 'short', placement: { kind: 'zone', zone: 3 },
    });
    expect(cfg({ spin: 'none', side: 'backhand', length: 'long' })).toMatchObject({
      spinType: 'none', depth: 'deep', placement: { kind: 'zone', zone: 7 },
    });
    // Left-hander: the backhand is on the other side.
    expect(cfg({ spin: 'top', side: 'backhand', length: 'long' }, 'L').placement.zone).toBe(9);
  });

  test('sidespin alternates both directions; its short is the half-long band', () => {
    const p = customPractice({ spin: 'side', side: 'middle', length: 'short' });
    expect(p.steps.map((s) => s.spinType)).toEqual(['side-L', 'side-R']);
    expect(p.steps.every((s) => s.depth === 'half-long')).toBe(true);
  });

  test('anything unreadable falls back to the default choice', () => {
    expect(normalizeCustom(null)).toEqual(CUSTOM_DEFAULT);
    expect(normalizeCustom({ spin: 'wobble', side: 7 })).toEqual(CUSTOM_DEFAULT);
    expect(customSummary({ spin: 'back', side: 'random', length: 'short' })).toBe('Backspin  ·  Random  ·  Short');
  });

  test('the model plays the built ball; Random side comes from the choice, not the list switch', () => {
    const fixed = new PracticeModel({
      practice: 'custom', custom: { spin: 'back', side: 'backhand', length: 'long' }, random: true,
    });
    expect(fixed.random).toBe(false);
    expect(fixed.nextConfig(0)).toMatchObject({ spinType: 'back', placement: { kind: 'zone', zone: 7 } });
    expect(fixed.liveLine()).toMatch(/^Backspin {2}· {2}Backhand {2}· {2}Long {2}· {2}Speed 3\/8/);

    const rnd = new PracticeModel({
      practice: 'custom', custom: { spin: 'top', side: 'random', length: 'long' }, rng: mulberry32(5),
    });
    const zones = new Set();
    for (let b = 0; b < 60; b++) zones.add(rnd.nextConfig(b).placement.zone);
    expect([...zones].sort()).toEqual([7, 8, 9]);
  });
});
