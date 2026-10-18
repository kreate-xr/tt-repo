// Courtside last-point screen (js/scene/sideScreen.js): the numbers it shows.
// Rendering is plain canvas drawing; what is worth pinning is the unit
// conversion (rad/s → rpm, m/s → km/h) and the empty / match-over states.

jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add() {}, remove() {} } }));

const { createSideScreenState, formatSideScreen } = require('../js/scene/sideScreen.js');

describe('sideScreen — formatSideScreen', () => {
  test('pre-match idle state shows dashes and the first server', () => {
    const f = formatSideScreen({ ...createSideScreenState(), nextServer: 'player', servesLeft: 2 });
    expect(f).toMatchObject({ speed: '—', spin: '—', spinLabel: '', rally: '—', serve: 'YOUR SERVE', servesLeft: '2 LEFT' });
  });

  test('converts the last shot to km/h and rpm (rounded to 10)', () => {
    const f = formatSideScreen({
      ...createSideScreenState(),
      pointPlayed: true,
      rallyStrokes: 7,
      // 17.5 m/s = 63 km/h; 250 rad/s = 2387 rpm → 2,390.
      lastShot: { outSpeed: 17.5, spinMag: 250, spinType: 'TOP' },
      nextServer: 'ai',
      servesLeft: 1,
    });
    expect(f).toMatchObject({ speed: '63', spin: '2,390', spinLabel: 'TOPSPIN', rally: '7', serve: 'AI SERVES', servesLeft: '1 LEFT' });
  });

  test('side-spin labels collapse to SIDESPIN', () => {
    for (const spinType of ['R-SPIN', 'L-SPIN']) {
      const f = formatSideScreen({ ...createSideScreenState(), pointPlayed: true, lastShot: { outSpeed: 5, spinMag: 10, spinType } });
      expect(f.spinLabel).toBe('SIDESPIN');
    }
  });

  test('a point the player never touched reads NO RETURN', () => {
    const f = formatSideScreen({ ...createSideScreenState(), pointPlayed: true, rallyStrokes: 1, lastShot: null });
    expect(f).toMatchObject({ speed: '—', spin: '—', spinLabel: 'NO RETURN', rally: '1' });
  });

  test('match over replaces the serve line', () => {
    const f = formatSideScreen({ ...createSideScreenState(), pointPlayed: true, matchOver: true });
    expect(f).toMatchObject({ serve: 'MATCH OVER', servesLeft: '' });
  });
});
