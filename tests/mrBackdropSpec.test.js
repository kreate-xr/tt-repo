// Passthrough backdrop placement — the pure layout half (mrBackdropSpec.js).
//
// The screen has two neighbours it must not collide with, and each is a
// number from another module: the floating scoreboard sits 0.8 m behind the
// far table edge (scoreboard.js) and the screen must stand behind it; and
// the brand mark must clear the scoreboard's top edge. These are the numbers
// a future retune of either module would silently break.

const { BACKDROP, computeMRBackdropLayout } = require('../js/scene/mrBackdropSpec.js');
const { ROOM } = require('../js/scene/focusRoomSpec.js');

// The real table as models.js registers it: far (AI) edge at z = -3.04,
// near edge at -0.30, table surface at 0.76.
const TABLE_BOX = {
  min: { x: -0.7625, y: 0.74, z: -3.04 },
  max: { x: 0.7625, y: 0.76, z: -0.30 },
};
// scoreboard.js floating placement (no wall anchor in MR).
const SCOREBOARD_DISTANCE_BEHIND_AI_M = 0.8;
const SCOREBOARD_HEIGHT_ABOVE_TABLE_M = 1.0;
const SCOREBOARD_PANEL_H_M = 1.40 * (1152 / 2048);

test('returns null before loadModels populated tableBox', () => {
  expect(computeMRBackdropLayout(null)).toBeNull();
});

test('the screen is centred on the table and stands behind the far edge', () => {
  const l = computeMRBackdropLayout(TABLE_BOX);
  expect(l.centerX).toBeCloseTo(0);
  expect(l.wallZ).toBeCloseTo(-3.04 - BACKDROP.STANDOFF_Z);
  expect(l.wallZ).toBeLessThan(TABLE_BOX.min.z);
  // Decals sit in front of the wall face, toward the player (+Z).
  expect(l.faceZ).toBeGreaterThan(l.wallZ);
  expect(l.faceZ - l.wallZ).toBeLessThan(0.05);
  expect(l.width).toBe(BACKDROP.WIDTH_X);
  expect(l.height).toBe(BACKDROP.HEIGHT_Y);
});

test('the screen stands behind the floating scoreboard, not through it', () => {
  const l = computeMRBackdropLayout(TABLE_BOX);
  const scoreboardZ = TABLE_BOX.min.z - SCOREBOARD_DISTANCE_BEHIND_AI_M;
  expect(l.faceZ).toBeLessThan(scoreboardZ - 0.25);
});

test('the mark clears the scoreboard below it and the screen top above it', () => {
  const scoreboardTop = TABLE_BOX.max.y + SCOREBOARD_HEIGHT_ABOVE_TABLE_M + SCOREBOARD_PANEL_H_M / 2;
  const markBottom = BACKDROP.MARK_Y - BACKDROP.MARK_MAX_HEIGHT_M / 2;
  const markTop = BACKDROP.MARK_Y + BACKDROP.MARK_MAX_HEIGHT_M / 2;
  expect(markBottom).toBeGreaterThan(scoreboardTop + 0.1);
  expect(markTop).toBeLessThan(BACKDROP.HEIGHT_Y - 0.3);
});

test('the screen is as wide as the Focus Room, so it reads as a wall not a board', () => {
  expect(BACKDROP.WIDTH_X).toBe(ROOM.WIDTH_X);
  // Tall enough to pass a standing eye line by a wide margin, shorter than
  // the venue so it does not cut through a domestic ceiling.
  expect(BACKDROP.HEIGHT_Y).toBeGreaterThan(3.0);
  expect(BACKDROP.HEIGHT_Y).toBeLessThan(ROOM.HEIGHT_Y);
});
