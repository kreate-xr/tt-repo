// Focus Room layout math — the pure-data contract focusRoom.js builds from.
//
// What matters here is the scoreboard-anchor contract (identical shape and
// formula to arena.js getBackWallAnchor so createScoreboard({anchor}) works
// unchanged) and the clearance guarantees: barriers clear of the table,
// panels clear of the ceiling, scoreboard clear of the wall top.

const {
  ROOM, COURT, BARRIER, BARRIER_LOGO, LIGHT_PANELS, computeFocusRoomLayout,
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
  expect(a.y - SCOREBOARD_H / 2).toBeGreaterThan(BARRIER.HEIGHT);
  expect(SCOREBOARD_W).toBeLessThan(a.wallWidth);
});

test('barrier segments ring the court: inside the room, clear of the table', () => {
  const layout = computeFocusRoomLayout(TABLE_BOX);
  expect(layout.barrierSegments.length).toBeGreaterThanOrEqual(10);
  const halfW = ROOM.WIDTH_X / 2;
  for (const seg of layout.barrierSegments) {
    // Inside the room footprint.
    expect(Math.abs(seg.x - layout.center.x)).toBeLessThan(halfW);
    expect(seg.z).toBeGreaterThan(layout.backWallInnerZ);
    expect(seg.z).toBeLessThan(layout.frontWallInnerZ);
    // Clear of the table: either well outside its X span or beyond a
    // baseline in Z (side rows sit ~2 m out; end rows ~2 m past baselines).
    const outsideX = Math.abs(seg.x) >= COURT.HALF_X - 1e-9;
    const outsideZ = seg.z <= TABLE_BOX.min.z - 1.0 || seg.z >= TABLE_BOX.max.z + 1.0;
    expect(outsideX || outsideZ).toBe(true);
  }
});

test('every barrier gets a branding decal, facing the court', () => {
  const layout = computeFocusRoomLayout(TABLE_BOX);
  const { barrierSegments: segs, barrierLogos: logos, center } = layout;
  expect(logos.length).toBe(segs.length);
  const gap = BARRIER.THICK / 2 + BARRIER_LOGO.OFFSET;
  logos.forEach((logo, i) => {
    const seg = segs[i];
    // The decal's own normal, (sin, cos) of its rotY — which is the
    // direction it was pushed off the panel face.
    const nx = Math.sin(logo.rotY);
    const nz = Math.cos(logo.rotY);
    // Faces the court center, never out at the wall behind it.
    const toCenter = (center.x - seg.x) * nx + (center.z - seg.z) * nz;
    expect(toCenter).toBeGreaterThan(0);
    // Clear of the panel face by the full gap, along that same normal.
    expect(logo.x).toBeCloseTo(seg.x + nx * gap);
    expect(logo.z).toBeCloseTo(seg.z + nz * gap);
    expect(gap).toBeGreaterThan(BARRIER.THICK / 2);
    // Centered on the panel it prints onto.
    expect(logo.y).toBeCloseTo(BARRIER.HEIGHT / 2);
  });
});

test('the printed mark fits inside the barrier panel it sits on', () => {
  // Worst case is the height ceiling binding — the mark still has to clear
  // the panel top (where the stripe cap wraps) and the floor.
  const halfH = BARRIER_LOGO.MAX_HEIGHT / 2;
  expect(BARRIER.HEIGHT / 2 + halfH).toBeLessThan(BARRIER.HEIGHT - 0.05);
  expect(BARRIER.HEIGHT / 2 - halfH).toBeGreaterThan(0.05);
  // And the width has to leave real panel either side of the print.
  expect(BARRIER_LOGO.WIDTH).toBeLessThan(BARRIER.SEG_W - 0.2);
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

test('barrier stripe cap has real clearance on every axis (anti z-fight)', () => {
  // The stripe caps the barrier panel; a coplanar or near-coplanar face
  // pair z-fights into a glittery shimmer at distance. Each overhang must
  // be several millimeters, not zero-or-epsilon.
  expect(BARRIER.STRIPE_LIP).toBeGreaterThanOrEqual(0.004);
  expect(BARRIER.STRIPE_WRAP).toBeGreaterThanOrEqual(0.008);
  expect(BARRIER.STRIPE_END).toBeGreaterThanOrEqual(0.008);
  // And the lipped stripe must still fully hide the panel's top face:
  // stripe bottom must sit below the panel top.
  expect(BARRIER.STRIPE_H - BARRIER.STRIPE_LIP).toBeGreaterThan(0.01);
});

test('null tableBox yields null (mirrors createArena guard)', () => {
  expect(computeFocusRoomLayout(null)).toBeNull();
});
