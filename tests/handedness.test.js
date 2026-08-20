// Paddle-hand policy. These are the rules a right-handed developer never
// exercises by accident, which is how the hardcoded 'right' survived so long.

const {
  paddleHandFromSetting, shouldSwitchPaddleHand, DEFAULT_PADDLE_HAND,
} = require('../js/xr/handedness.js');

describe('paddleHandFromSetting', () => {
  test("maps the profile's L/R onto WebXR handedness", () => {
    expect(paddleHandFromSetting('L')).toBe('left');
    expect(paddleHandFromSetting('R')).toBe('right');
  });

  test('falls back to the default for anything unrecognised', () => {
    // Persisted JSON is untrusted — a hand-edited blob or an older build can
    // put anything here, and none of it may throw.
    for (const v of [undefined, null, '', 'left', 'l', 0, {}, 'Z']) {
      expect(paddleHandFromSetting(v)).toBe(DEFAULT_PADDLE_HAND);
    }
  });
});

describe('shouldSwitchPaddleHand', () => {
  test('takes the paddle to the preferred hand when it appears', () => {
    expect(shouldSwitchPaddleHand('left', 'right', 'right')).toBe(true);
    expect(shouldSwitchPaddleHand('right', 'left', 'left')).toBe(true);
  });

  test('a left-hander keeps the paddle when the right controller wakes up', () => {
    // The original bug: with 'right' hardcoded as preferred, this returned
    // true and the bat was yanked out of a lefty's hand mid-session.
    expect(shouldSwitchPaddleHand('left', 'right', 'left')).toBe(false);
  });

  test('the non-preferred hand never steals the paddle', () => {
    expect(shouldSwitchPaddleHand('right', 'left', 'right')).toBe(false);
  });

  test('already on the preferred hand is not a switch', () => {
    expect(shouldSwitchPaddleHand('right', 'right', 'right')).toBe(false);
    expect(shouldSwitchPaddleHand('left', 'left', 'left')).toBe(false);
  });

  test('an untracked hand (null) still yields to the preferred one', () => {
    // activeHandedness is null until a grip reports handedness; the first
    // preferred-hand grip to arrive must be able to claim the paddle.
    expect(shouldSwitchPaddleHand(null, 'right', 'right')).toBe(true);
    expect(shouldSwitchPaddleHand(null, 'left', 'right')).toBe(false);
  });
});
