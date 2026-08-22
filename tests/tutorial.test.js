// M9 Tutorial — step model and step-config feasibility.
//
// Two failure modes matter here. A gating bug (a step that advances on a miss
// or can never be passed) strands a first-time player inside the mode built
// to welcome them. And an infeasible step config means the machine silently
// refuses every feed — so each step's config is held to the same contract as
// the Quick Feed presets: solveFeed must call it feasible.

const THREE = require('three');

const {
  TutorialModel, TUTORIAL_STEPS, TUTORIAL_COMPLETE_LINE,
} = require('../js/modes/training/tutorial.js');
const { INFINITE } = require('../js/modes/training/drillConfig.js');
const { solveFeed } = require('../js/modes/training/feedEngine.js');
const { mulberry32 } = require('../js/util/rng.js');

// Same ITTF geometry the FeedEngine tests inject.
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

const returned = { result: 'returned' };
const missed = { result: 'miss' };

describe('the sequence itself', () => {
  test('is four steps — an on-ramp, not a course', () => {
    expect(TUTORIAL_STEPS).toHaveLength(4);
  });

  test('every step feeds forever, so a lesson cannot run out of balls', () => {
    for (const s of TUTORIAL_STEPS) expect(s.config.burstCount).toBe(INFINITE);
  });

  test('every step config is feasible — the machine never refuses a lesson', () => {
    for (const s of TUTORIAL_STEPS) {
      const feed = solveFeed(s.config, env, { rng: mulberry32(7) });
      expect(feed.feasible).toBe(true);
    }
  });

  test('the last step is the backspin taste, the first is spinless', () => {
    expect(TUTORIAL_STEPS[0].config.spinType).toBe('none');
    expect(TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1].config.spinType).toBe('back');
  });
});

describe('step gating', () => {
  test('one return passes the first step', () => {
    const m = new TutorialModel();
    expect(m.recordOutcome(returned)).toEqual({ advanced: true, completed: false });
    expect(m.step.id).toBe('threeInARow');
  });

  test('misses never advance a step', () => {
    const m = new TutorialModel();
    for (let i = 0; i < 10; i++) m.recordOutcome(missed);
    expect(m.stepIndex).toBe(0);
  });

  test('the streak step demands consecutive returns', () => {
    const m = new TutorialModel();
    m.recordOutcome(returned);                    // → threeInARow
    m.recordOutcome(returned);
    m.recordOutcome(returned);
    m.recordOutcome(missed);                      // streak broken at 2
    expect(m.count).toBe(0);
    m.recordOutcome(returned);
    m.recordOutcome(returned);
    const r = m.recordOutcome(returned);
    expect(r.advanced).toBe(true);
    expect(m.step.id).toBe('placement');
  });

  test('an error (touched, put wrong) breaks a streak like a miss', () => {
    const m = new TutorialModel();
    m.recordOutcome(returned);                    // → threeInARow
    m.recordOutcome(returned);
    m.recordOutcome({ result: 'error' });
    expect(m.count).toBe(0);
  });

  test('the placement step counts only in-zone returns, without resetting', () => {
    const m = new TutorialModel();
    m.recordOutcome(returned);
    for (let i = 0; i < 3; i++) m.recordOutcome(returned);   // → placement
    expect(m.step.id).toBe('placement');
    expect(m.needsZones).toBe(true);

    m.recordOutcome({ result: 'returned', inZone: true });
    m.recordOutcome({ result: 'returned', inZone: false });  // no credit...
    m.recordOutcome(missed);                                 // ...and no reset
    expect(m.count).toBe(1);
    const r = m.recordOutcome({ result: 'returned', inZone: true });
    expect(r.advanced).toBe(true);
    expect(m.step.id).toBe('backspin');
    expect(m.needsZones).toBe(false);
  });

  test('one lifted backspin ball completes the tutorial', () => {
    const m = new TutorialModel();
    m.recordOutcome(returned);
    for (let i = 0; i < 3; i++) m.recordOutcome(returned);
    m.recordOutcome({ result: 'returned', inZone: true });
    m.recordOutcome({ result: 'returned', inZone: true });
    expect(m.complete).toBe(false);
    const r = m.recordOutcome(returned);
    expect(r).toEqual({ advanced: true, completed: true });
    expect(m.complete).toBe(true);
  });

  test('outcomes after completion are a no-op', () => {
    const m = new TutorialModel();
    m.recordOutcome(returned);
    for (let i = 0; i < 3; i++) m.recordOutcome(returned);
    m.recordOutcome({ result: 'returned', inZone: true });
    m.recordOutcome({ result: 'returned', inZone: true });
    m.recordOutcome(returned);
    expect(m.recordOutcome(returned)).toEqual({ advanced: false, completed: false });
    expect(m.complete).toBe(true);
  });
});

describe('the HUD line', () => {
  test('names the step, the task and the progress', () => {
    const m = new TutorialModel();
    expect(m.instruction()).toMatch(/^Step 1 of 4/);
    m.recordOutcome(returned);                    // → threeInARow
    m.recordOutcome(returned);
    expect(m.instruction()).toMatch(/^Step 2 of 4/);
    expect(m.instruction()).toMatch(/\(1\/3\)/);
  });

  test('a single-ball goal shows no counter — "(0/1)" is noise', () => {
    expect(new TutorialModel().instruction()).not.toMatch(/\(0\/1\)/);
  });

  test('completion swaps to the handoff line', () => {
    const m = new TutorialModel();
    m.recordOutcome(returned);
    for (let i = 0; i < 3; i++) m.recordOutcome(returned);
    m.recordOutcome({ result: 'returned', inZone: true });
    m.recordOutcome({ result: 'returned', inZone: true });
    m.recordOutcome(returned);
    expect(m.instruction()).toBe(TUTORIAL_COMPLETE_LINE);
  });
});
