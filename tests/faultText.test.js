// Fault copy for the 2D HUD log — full-sentence rule statements shown when
// the local player commits a fault.

const { faultRuleText, faultCue, LOW_TOSS_WARNING_CUE } = require('../js/scene/faultText.js');

describe('faultRuleText', () => {
  test('states the rule for the HUD log', () => {
    expect(faultRuleText('illegalVolley')).toMatch(/ITTF/);
    expect(faultRuleText('serveFault', 'overTable')).toMatch(/end line/);
    expect(faultRuleText('serveFault', 'belowTable')).toMatch(/playing surface/);
  });

  test('bounce-based serve faults keep the generic line', () => {
    expect(faultRuleText('serveFault')).toMatch(/bounce on your half/);
  });

  test('ordinary outcomes have no rule to state', () => {
    expect(faultRuleText('doubleBounce')).toBe('');
    expect(faultRuleText('ballLost', 'out')).toBe('');
  });
});

// In-headset cue under the FOUL call: a reason AND a fix for every fault the
// rules engine can call, so the player is never left guessing.
describe('faultCue', () => {
  const SERVE_DETAILS = ['overTable', 'belowTable', 'lowToss', 'noOwnBounce', 'doubleOwnBounce', 'net', 'missedHalf'];

  test.each(SERVE_DETAILS)('serve fault %s has its own reason and tip', (detail) => {
    const cue = faultCue('serveFault', detail);
    expect(cue.reason).toBeTruthy();
    expect(cue.tip).toBeTruthy();
    expect(cue).not.toEqual(faultCue('serveFault'));
  });

  test('every serve reason is distinct', () => {
    const reasons = SERVE_DETAILS.map((d) => faultCue('serveFault', d).reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  test('rally faults and the whiffed serve are covered too', () => {
    for (const [reason, detail] of [['illegalVolley'], ['doubleHit'], ['netTouch'], ['ballLost', 'serveMiss'], ['serveFault']]) {
      const cue = faultCue(reason, detail);
      expect(cue && cue.reason && cue.tip).toBeTruthy();
    }
  });

  test('ordinary outcomes are not faults', () => {
    expect(faultCue('doubleBounce')).toBeNull();
    expect(faultCue('ballLost', 'out')).toBeNull();
    expect(faultCue('ballLost', 'missedReturn')).toBeNull();
  });

  test('the low-toss warning says it is a retake', () => {
    expect(LOW_TOSS_WARNING_CUE.reason).toMatch(/retake/i);
    expect(LOW_TOSS_WARNING_CUE.tip).toMatch(/16 cm/);
  });
});
