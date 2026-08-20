// Fault copy for the 2D HUD log — full-sentence rule statements shown when
// the local player commits a fault.

const { faultRuleText } = require('../js/scene/faultText.js');

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
