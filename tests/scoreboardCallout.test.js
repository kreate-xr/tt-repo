// Center-badge tension callout (DEUCE / GAME POINT / MATCH POINT) computed
// from the shared scoreboard state — standard 11-point, win-by-2 scoring.

const { computeCallout, createScoreboardState } = require('../js/scene/scoreboardLayout.js');

function state(patch, config) {
  return Object.assign(createScoreboardState(config), patch);
}

describe('computeCallout', () => {
  test('no callout during normal play', () => {
    expect(computeCallout(state({ playerScore: 0, aiScore: 0 }))).toBeNull();
    expect(computeCallout(state({ playerScore: 9, aiScore: 7 }))).toBeNull();
    // 10-9 the other way: the trailing side never holds the callout.
    expect(computeCallout(state({ playerScore: 9, aiScore: 10 })).text).toBe('GAME POINT');
  });

  test('game point when a side leads at 10+', () => {
    const c = computeCallout(state({ playerScore: 10, aiScore: 6 }));
    expect(c.text).toBe('GAME POINT');
    const c2 = computeCallout(state({ playerScore: 3, aiScore: 10 }));
    expect(c2.text).toBe('GAME POINT');
  });

  test('deuce at 10-10 and at any later tie', () => {
    expect(computeCallout(state({ playerScore: 10, aiScore: 10 })).text).toBe('DEUCE');
    expect(computeCallout(state({ playerScore: 14, aiScore: 14 })).text).toBe('DEUCE');
  });

  test('advantage after deuce reads as game point', () => {
    expect(computeCallout(state({ playerScore: 12, aiScore: 11 })).text).toBe('GAME POINT');
  });

  test('match point when taking the game takes the match (best of 5)', () => {
    const c = computeCallout(state({ playerScore: 10, aiScore: 8, playerGames: 2 }));
    expect(c.text).toBe('MATCH POINT');
    // Same score, but only 1 game won → just game point.
    const c2 = computeCallout(state({ playerScore: 10, aiScore: 8, playerGames: 1 }));
    expect(c2.text).toBe('GAME POINT');
    // AI side too.
    const c3 = computeCallout(state({ playerScore: 5, aiScore: 10, aiGames: 2 }));
    expect(c3.text).toBe('MATCH POINT');
  });

  test('best of 1 (multiplayer quick match): every game point is match point', () => {
    const c = computeCallout(state({ playerScore: 10, aiScore: 9 }, { bestOf: 1 }));
    expect(c.text).toBe('MATCH POINT');
  });

  test('suppressed once the match-over banner is up', () => {
    const c = computeCallout(state({
      playerScore: 11, aiScore: 9, matchOverBanner: 'YOU WIN!',
    }));
    expect(c).toBeNull();
  });
});
