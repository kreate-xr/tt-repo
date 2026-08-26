// Momentum model — rubber-band honesty gating.
//
// The rubber-band softens the AI when it leads big (engagement mechanic).
// The top tier opts out of the LEADING half via easeUpWhenLeading: an elite
// opponent that plays worse when ahead caps how strong ELITE can feel. The
// trailing half ("press when behind") is authentic and stays for every tier.

import { createMomentumModel } from '../js/ai/momentum.js';

function feedMargin(m, aiScore, playerScore) {
  // One update carrying the target margin (winner just flavours momentum).
  m.update({ winner: aiScore >= playerScore ? 'ai' : 'player', aiScore, playerScore });
}

describe('easeUpWhenLeading gate', () => {
  test('default model eases up when leading big', () => {
    const m = createMomentumModel();
    feedMargin(m, 9, 2);                       // +7, past the deadzone
    const eased = m.exploitScale();
    const n = createMomentumModel();
    feedMargin(n, 6, 5);                       // +1, inside deadzone
    expect(eased).toBeLessThan(n.exploitScale());
  });

  test('honest model (pro) does NOT ease up when leading', () => {
    const withBand = createMomentumModel();
    const honest = createMomentumModel({ easeUpWhenLeading: false });
    feedMargin(withBand, 9, 2);
    feedMargin(honest, 9, 2);
    // Same momentum value, but no rubber-band exploit drop or swing drop.
    expect(honest.exploitScale()).toBeGreaterThan(withBand.exploitScale());
    expect(honest.swingSpeedScale()).toBeGreaterThan(withBand.swingSpeedScale());
  });

  test('both models still press when trailing big', () => {
    const withBand = createMomentumModel();
    const honest = createMomentumModel({ easeUpWhenLeading: false });
    feedMargin(withBand, 2, 9);
    feedMargin(honest, 2, 9);
    expect(honest.exploitScale()).toBeCloseTo(withBand.exploitScale(), 10);
  });
});
