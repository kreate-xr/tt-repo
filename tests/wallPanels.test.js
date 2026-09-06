// Wall finish — the black wall and its floor bounce.
//
// The wall treatment is a purely VERTICAL gradient: black everywhere, warmed
// over the bottom by the wood floor's bounce. Two things about that are easy
// to break silently, so they are pinned here — the wall must actually be
// black (it is the ground the side-wall graphic is printed on), and the
// texture must stay horizontally uniform, because focusRoom.js relies on that
// to skip any per-face UV work on the shell.

const TABLE_BOX = {
  min: { x: -0.7625, y: 0.74, z: -3.04 },
  max: { x: 0.7625, y: 0.76, z: -0.30 },
};

function loadRoom() {
  jest.resetModules();
  const scene = { add: jest.fn(), remove: jest.fn() };
  jest.doMock('../js/scene/sceneSetup.js', () => ({
    scene, ARENA_LIGHT_LAYER: 3, renderer: undefined,
  }));
  jest.doMock('../js/scene/models.js', () => ({ tableBox: TABLE_BOX }));
  return require('../js/scene/focusRoom.js');
}

test('the wall is black — the graphic needs a black ground', () => {
  const { ROOM } = require('../js/scene/focusRoomSpec.js');
  expect(ROOM.WALL_COLOR).toBe(0x000000);
});

test('the finish is a vertical gradient only, so no per-face UV work is needed', () => {
  const { WALL_PANEL } = require('../js/scene/focusRoomSpec.js');
  // A horizontally uniform texture needs no width. If someone reintroduces
  // horizontal structure they will have to widen this, and that is the signal
  // that the shell's per-face UV rescale has to come back with it.
  expect(WALL_PANEL.PX_W).toBeLessThanOrEqual(16);
  expect(WALL_PANEL.PX_H).toBeGreaterThanOrEqual(256);
  // The bounce has to stay inside the room to be a floor bounce at all.
  expect(WALL_PANEL.BOUNCE_H_M).toBeGreaterThan(0);
  expect(WALL_PANEL.BOUNCE_H_M).toBeLessThan(ROOM_HEIGHT());
  expect(WALL_PANEL.SKIRT_H_M).toBeLessThan(WALL_PANEL.BOUNCE_H_M);
});

function ROOM_HEIGHT() {
  return require('../js/scene/focusRoomSpec.js').ROOM.HEIGHT_Y;
}

test('the shell keeps three.js default 0..1 UVs on every face', () => {
  const mod = loadRoom();
  const { ROOM } = require('../js/scene/focusRoomSpec.js');
  const room = mod.createFocusRoom();

  let shell = null;
  room.group.traverse(o => {
    if (o.isMesh && o.geometry && o.geometry.type === 'BoxGeometry'
        && o.geometry.parameters.height === ROOM.HEIGHT_Y) shell = o;
  });
  expect(shell).not.toBeNull();

  const uv = shell.geometry.attributes.uv;
  expect(uv.count).toBe(24);
  for (let i = 0; i < uv.count; i++) {
    expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
    expect(uv.getX(i)).toBeLessThanOrEqual(1);
    expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
    expect(uv.getY(i)).toBeLessThanOrEqual(1);
  }
  room.dispose();
});

test('both side-wall graphics clear the floor, ceiling and wall ends', () => {
  const { ROOM, SIDE_WALL_ART } = require('../js/scene/focusRoomSpec.js');
  expect(SIDE_WALL_ART.WALLS).toHaveLength(2);
  expect(SIDE_WALL_ART.WALLS.map(wall => wall.side).sort()).toEqual(['left', 'right']);

  for (const wall of SIDE_WALL_ART.WALLS) {
    // Height comes from each asset's measured aspect at runtime; 1.5 is what
    // both WebPs actually are, so check the placement that implies.
    const height = wall.WIDTH_M / 1.5;
    expect(wall.CENTER_Y - height / 2).toBeGreaterThan(0);
    expect(wall.CENTER_Y + height / 2).toBeLessThan(ROOM.HEIGHT_Y);
    // Printed on a side wall, so it has to fit along the room's length.
    expect(wall.WIDTH_M).toBeLessThan(ROOM.LENGTH_Z);
    // And it must not swallow the wall — that is what made them read as
    // wallpaper at 4.5 m.
    expect(height).toBeLessThan(ROOM.HEIGHT_Y / 2);
    // Centred on the wall: equal wall above and below. A literal CENTER_Y
    // left more room above than below and read as sitting toward the floor.
    const below = wall.CENTER_Y - height / 2;
    const above = ROOM.HEIGHT_Y - (wall.CENTER_Y + height / 2);
    expect(below).toBeCloseTo(above, 9);
    // A WebP: the PNG masters are 8-20x larger and must not be shipped.
    expect(wall.URL).toMatch(/\.webp$/);
  }
  // Off the wall face, or it z-fights into a shimmer at distance.
  expect(SIDE_WALL_ART.OFFSET).toBeGreaterThan(0);
});

test('the room has edge trim — a black box needs visible corners', () => {
  const mod = loadRoom();
  const { ROOM } = require('../js/scene/focusRoomSpec.js');
  const room = mod.createFocusRoom();

  // Four corner posts + one cornice band per wall. Without these nothing
  // marks where one black wall stops and the next starts.
  const instanced = [];
  room.group.traverse(o => { if (o.isInstancedMesh) instanced.push(o); });
  const trim = instanced.find(o => o.count === 8);
  expect(trim).toBeDefined();

  const THREE = require('three');
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  let posts = 0, cornices = 0;
  for (let i = 0; i < trim.count; i++) {
    trim.getMatrixAt(i, m);
    m.decompose(pos, quat, scl);
    if (Math.abs(scl.y - ROOM.HEIGHT_Y) < 1e-6) {
      posts++;
      // A corner post stands at a corner, not along a wall.
      expect(Math.abs(pos.x)).toBeGreaterThan(ROOM.WIDTH_X / 2 - 0.2);
    } else {
      cornices++;
      // The cornice sits at the top, under the ceiling plane.
      expect(pos.y + scl.y / 2).toBeLessThan(ROOM.HEIGHT_Y - 0.01);
      expect(pos.y).toBeGreaterThan(ROOM.HEIGHT_Y * 0.9);
    }
  }
  expect(posts).toBe(4);
  expect(cornices).toBe(4);
  room.dispose();
});

test('every room edge is the one venue blue', () => {
  const { ROOM, WALL_PANEL } = require('../js/scene/focusRoomSpec.js');
  // The court border, wall stripe, skirting rail, corner posts and cornice
  // are deliberately the same colour — that is what makes them read as one
  // edge language wrapping the room instead of five unrelated details. They
  // are driven from a single constant, so this catches any of them drifting.
  expect(ROOM.TRIM_COLOR).toBe(ROOM.ACCENT_COLOR);
  expect(WALL_PANEL.SKIRT_COLOR).toBe(ROOM.ACCENT_COLOR);
});

test('trim reads against both surfaces it separates', () => {
  const { ROOM, WALL_PANEL } = require('../js/scene/focusRoomSpec.js');
  // Anything painted over black can only lift it, so trim and skirting must
  // both be lighter than the wall or they simply do not exist.
  expect(ROOM.TRIM_COLOR).toBeGreaterThan(ROOM.WALL_COLOR);
  expect(WALL_PANEL.SKIRT_COLOR).toBeGreaterThan(ROOM.WALL_COLOR);
  // And lighter than the slate ceiling too — with a black wall AND a dark
  // ceiling the cornice is the only thing marking the join between them, so
  // it has to out-read the darker of the two rather than sit between them.
  // (It had to be DARKER than the ceiling while the ceiling was milky white;
  // taking the ceiling back to dark flips this with it.)
  //
  // By LUMA, not per channel. The trim is blue and the ceiling is a neutral
  // slate, so the trim carries LESS red (0x3b vs 0x41) while still reading
  // clearly brighter — luma 117 against 79. A per-channel assertion here
  // fails on a trim that is doing exactly what it should.
  const luma = (hex) => 0.2126 * ((hex >> 16) & 0xff)
    + 0.7152 * ((hex >> 8) & 0xff) + 0.0722 * (hex & 0xff);
  expect(luma(ROOM.TRIM_COLOR)).toBeGreaterThan(luma(ROOM.CEILING_COLOR));
  // Wide enough not to be a shimmering hairline from across the room.
  expect(ROOM.TRIM_W).toBeGreaterThanOrEqual(0.04);
  expect(ROOM.CORNICE_H).toBeGreaterThanOrEqual(0.04);
});

test('no canvas (node env) yields null so the plain black shell stands', () => {
  jest.resetModules();
  jest.doMock('../js/scene/sceneSetup.js', () => ({ renderer: undefined }));
  const { createWallPanelTexture } = require('../js/scene/wallPanels.js');
  expect(typeof document).toBe('undefined');
  expect(createWallPanelTexture()).toBeNull();
});

test('the side-wall graphic resolves to null headlessly and never rejects', async () => {
  jest.resetModules();
  const { loadSideWallArt } = require('../js/scene/sideWallArt.js');
  await expect(loadSideWallArt()).resolves.toBeNull();
});
