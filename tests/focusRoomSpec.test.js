// Focus Room layout math — the pure-data contract focusRoom.js builds from.
//
// What matters here is the scoreboard-anchor contract (identical shape and
// formula to arena.js getBackWallAnchor so createScoreboard({anchor}) works
// unchanged) and the clearance guarantees: panels clear of the ceiling,
// scoreboard clear of the wall top, and the branding mark clear of the
// scoreboard it now shares the back wall with.

const {
  ROOM, LIGHT_PANELS, WALL_MARK, computeFocusRoomLayout,
} = require('../js/scene/focusRoomSpec.js');

// tableBox as models.js derives it from the Table.glb edge anchors.
const TABLE_BOX = {
  min: { x: -0.7625, y: 0.74, z: -3.04 },
  max: { x: 0.7625, y: 0.76, z: -0.30 },
};

// Scoreboard wall-mount panel size from scoreboard.js: PANEL_W_M 1.40 × 2
// upscale, 16:9-ish layout aspect (2048×1152).
const SCOREBOARD_W = 1.40 * 2.0;
const SCOREBOARD_H = SCOREBOARD_W * (1152 / 2048);

test('room is centered on the table, long end toward the AI', () => {
  const layout = computeFocusRoomLayout(TABLE_BOX);
  expect(layout.center.x).toBeCloseTo(0);
  expect(layout.center.z).toBeCloseTo(-1.67);
  expect(layout.backWallInnerZ).toBeCloseTo(-1.67 - ROOM.LENGTH_Z / 2);
  // Player stands at the origin — the room must extend behind them.
  expect(layout.frontWallInnerZ).toBeGreaterThan(1.5);
});

test('back wall anchor matches the arena.js contract shape and formula', () => {
  const layout = computeFocusRoomLayout(TABLE_BOX);
  const a = layout.backWallAnchor;
  expect(a.x).toBeCloseTo(0);
  // min(2.2, height*0.7) — with a 4.5 m wall the 2.2 m banner height wins.
  expect(a.y).toBeCloseTo(2.2);
  // 2 cm off the inner wall face, toward the player (+Z side of the wall).
  expect(a.z).toBeCloseTo(layout.backWallInnerZ + 0.02);
  expect(a.wallWidth).toBe(ROOM.WIDTH_X);
  expect(a.wallHeight).toBe(ROOM.HEIGHT_Y);
});

test('the wall-mounted scoreboard fits on the back wall with clearance', () => {
  const layout = computeFocusRoomLayout(TABLE_BOX);
  const a = layout.backWallAnchor;
  expect(a.y + SCOREBOARD_H / 2).toBeLessThan(ROOM.HEIGHT_Y);
  expect(a.y - SCOREBOARD_H / 2).toBeGreaterThan(0);
  expect(SCOREBOARD_W).toBeLessThan(a.wallWidth);
});

test('light panels hang below the ceiling and inside the room', () => {
  const layout = computeFocusRoomLayout(TABLE_BOX);
  // Top face of a panel box must sit clear below the interior ceiling
  // plane (which is 1 cm under the shell top).
  const panelTop = layout.panelY + LIGHT_PANELS.THICK / 2;
  expect(panelTop).toBeLessThan(ROOM.HEIGHT_Y - 0.01);
  const halfW = ROOM.WIDTH_X / 2;
  for (const slot of layout.panelSlots) {
    expect(Math.abs(slot.x - layout.center.x) + LIGHT_PANELS.W / 2).toBeLessThanOrEqual(halfW);
    expect(slot.z - LIGHT_PANELS.D / 2).toBeGreaterThan(layout.backWallInnerZ);
    expect(slot.z + LIGHT_PANELS.D / 2).toBeLessThan(layout.frontWallInnerZ);
  }
  // Exactly one center panel (the CenterLightBox fixture).
  expect(layout.panelSlots.filter((p) => p.isCenter).length).toBe(1);
});

test('the back-wall mark clears the scoreboard below and the ceiling above', () => {
  // The mark and the scoreboard share the back wall. The board spans
  // a.y +/- SCOREBOARD_H/2; the mark sits above it, and both have to stay
  // inside the room. Height is derived from the asset's measured aspect at
  // load, so the ceiling here is what the builder clamps to.
  const layout = computeFocusRoomLayout(TABLE_BOX);
  const boardTop = layout.backWallAnchor.y + SCOREBOARD_H / 2;
  const markBottom = WALL_MARK.BACK_Y - WALL_MARK.MAX_HEIGHT_M / 2;
  const markTop = WALL_MARK.BACK_Y + WALL_MARK.MAX_HEIGHT_M / 2;
  expect(markBottom).toBeGreaterThan(boardTop);
  // Clear of the cornice, which hangs from the ceiling.
  expect(markTop).toBeLessThan(ROOM.HEIGHT_Y - ROOM.CORNICE_H - 0.02);
});

test('the front-wall mark sits on a clear wall, above the accent stripe', () => {
  const markBottom = WALL_MARK.FRONT_Y - WALL_MARK.MAX_HEIGHT_M / 2;
  const markTop = WALL_MARK.FRONT_Y + WALL_MARK.MAX_HEIGHT_M / 2;
  const stripeTop = ROOM.ACCENT_STRIPE_Y + ROOM.ACCENT_STRIPE_H / 2;
  expect(markBottom).toBeGreaterThan(stripeTop);
  expect(markTop).toBeLessThan(ROOM.HEIGHT_Y - ROOM.CORNICE_H - 0.02);
  // Both marks must fit across the wall they are printed on.
  expect(WALL_MARK.WIDTH_M).toBeLessThan(ROOM.WIDTH_X);
  // Off the wall face, or it z-fights into a shimmer at distance.
  expect(WALL_MARK.OFFSET).toBeGreaterThan(0);
});

test('null tableBox yields null (mirrors createArena guard)', () => {
  expect(computeFocusRoomLayout(null)).toBeNull();
});
