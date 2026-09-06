// Procedural wood floor — the tile's wrap invariants.
//
// The floor texture repeats 2x3 across the Focus Room, so a tile that does
// not wrap puts a visible grid on the floor. Both wrap axes are pure math
// (woodFloor.js planTile), so they are assertable without a canvas — which
// matters, because jest runs on the node environment where there is no
// canvas at all and the painting itself can never be exercised here.

function loadWoodFloor() {
  jest.resetModules();
  // sceneSetup pulls in a WebGLRenderer; woodFloor only wants `renderer` for
  // getMaxAnisotropy, and reads it defensively.
  jest.doMock('../js/scene/sceneSetup.js', () => ({ renderer: undefined }));
  return require('../js/scene/woodFloor.js');
}

test('columns divide the tile exactly, so the across-boards seam wraps', () => {
  const { planTile } = loadWoodFloor();
  const { WOOD } = require('../js/scene/focusRoomSpec.js');
  const { cols, colW, columns } = planTile(WOOD.PX);

  expect(cols).toBeGreaterThan(1);
  expect(columns).toHaveLength(cols);
  // The last column's right edge must land ON the tile edge — that is what
  // makes the board edge at x=0 continue the one at x=PX.
  expect(cols * colW).toBeCloseTo(WOOD.PX, 9);
  // And the boards must still be the width they claim to be.
  expect((colW / WOOD.PX) * WOOD.TILE_M).toBeCloseTo(WOOD.PLANK_W_M, 2);
});

test('each column of boards sums to exactly one tile, so end joints wrap', () => {
  const { planTile } = loadWoodFloor();
  const { WOOD } = require('../js/scene/focusRoomSpec.js');
  const { columns } = planTile(WOOD.PX);

  for (const col of columns) {
    const total = col.boards.reduce((s, b) => s + b.len, 0);
    expect(Math.abs(total - WOOD.PX)).toBeLessThan(1e-6);
    expect(col.boards.length).toBeGreaterThanOrEqual(2);
  }
});

test('boards tile their column with no gap and no overlap', () => {
  const { planTile } = loadWoodFloor();
  const { WOOD } = require('../js/scene/focusRoomSpec.js');
  const px = WOOD.PX;
  const { columns } = planTile(px);

  for (const col of columns) {
    // Walk the boards around the tile in position order: each one must start
    // exactly where the previous ended, including across the wrap point.
    const sorted = [...col.boards].sort((a, b) => a.y - b.y);
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const next = sorted[(i + 1) % sorted.length];
      const end = (cur.y + cur.len) % px;
      const gap = Math.abs(end - next.y);
      // `gap` is ~0, or ~px when the two straddle the seam.
      expect(Math.min(gap, Math.abs(gap - px))).toBeLessThan(1e-6);
    }
    // Exactly one board may straddle the seam.
    const straddlers = col.boards.filter(b => b.y + b.len > px);
    expect(straddlers.length).toBeLessThanOrEqual(1);
  }
});

test('the layout is deterministic — same floor in both eyes, every session', () => {
  const { planTile } = loadWoodFloor();
  const { WOOD } = require('../js/scene/focusRoomSpec.js');
  expect(JSON.stringify(planTile(WOOD.PX)))
    .toEqual(JSON.stringify(planTile(WOOD.PX)));
});

test('end joints are staggered between neighbouring columns', () => {
  const { planTile } = loadWoodFloor();
  const { WOOD } = require('../js/scene/focusRoomSpec.js');
  const { columns } = planTile(WOOD.PX);
  // Adjacent columns sharing a joint position would read as a plywood grid
  // rather than a laid floor.
  let aligned = 0;
  for (let i = 1; i < columns.length; i++) {
    for (const a of columns[i - 1].boards) {
      for (const b of columns[i].boards) {
        if (Math.abs(a.y - b.y) < 2) aligned++;
      }
    }
  }
  expect(aligned).toBe(0);
});

test('board tones and grain come from the spec palette', () => {
  const { planTile } = loadWoodFloor();
  const { WOOD } = require('../js/scene/focusRoomSpec.js');
  const { columns } = planTile(WOOD.PX);
  for (const col of columns) {
    for (const { board } of col.boards) {
      expect(WOOD.PLANKS).toContain(board.base);
      expect(Math.abs(board.jitter)).toBeLessThanOrEqual(WOOD.JITTER);
      expect(board.grain).toHaveLength(WOOD.GRAIN_PER_BOARD);
    }
  }
});

test('no canvas (node env) yields null so the flat floor stands', () => {
  const { createWoodFloorTexture } = loadWoodFloor();
  expect(typeof document).toBe('undefined');
  expect(createWoodFloorTexture(8, 12)).toBeNull();
});
