// scoreboard.js coalesces full-board repaints: the patches from one point
// ending (score, server change, game end) arrive back to back, and each used
// to repaint the 2048×1152 canvas on its own. Now state applies at once and
// the paint happens once, in a microtask, with the final state.

const THREE = require('three');

const renders = [];
jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/models.js', () => {
  const T = require('three');
  return {
    netBox: new T.Box3(new T.Vector3(-0.9, 0.76, -0.01), new T.Vector3(0.9, 0.91, 0.01)),
    tableBox: new T.Box3(new T.Vector3(-0.76, 0, -1.37), new T.Vector3(0.76, 0.76, 1.37)),
    tableSurfaceY: 0.76,
  };
});
jest.mock('../js/scene/scoreboardLayout.js', () => {
  const actual = jest.requireActual('../js/scene/scoreboardLayout.js');
  return {
    ...actual,
    renderScoreboardLayout: (ctx, state) => { renders.push({ ...state }); },
    renderClockValue: () => {},
  };
});

const { createScoreboard } = require('../js/scene/scoreboard.js');

beforeAll(() => {
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
  };
});
beforeEach(() => { renders.length = 0; });

const flush = () => Promise.resolve();

test('a burst of patches repaints once, with the final state', async () => {
  const board = createScoreboard();
  renders.length = 0; // the initial paint at creation
  board.update({ playerScore: 3, aiScore: 2 });
  board.update({ currentServer: 'ai' });
  board.setMatchOverBanner('GAME');
  expect(renders).toHaveLength(0);
  await flush();
  expect(renders).toHaveLength(1);
  expect(renders[0]).toMatchObject({
    playerScore: 3, aiScore: 2, currentServer: 'ai', matchOverBanner: 'GAME',
  });
});

test('a clock-only patch does not repaint the board', async () => {
  const board = createScoreboard();
  renders.length = 0;
  board.update({ elapsedMs: 5000 });
  await flush();
  expect(renders).toHaveLength(0);
});

test('no repaint after dispose', async () => {
  const board = createScoreboard();
  renders.length = 0;
  board.update({ playerScore: 1 });
  board.dispose();
  await flush();
  expect(renders).toHaveLength(0);
});

test('the board is still a mesh in the scene graph', () => {
  expect(createScoreboard().mesh).toBeInstanceOf(THREE.Mesh);
});
