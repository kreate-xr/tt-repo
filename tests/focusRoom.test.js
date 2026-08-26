// Procedural Focus Room builder — the scene-facing contract.
//
// The interesting behaviors: the handle exposes the same shape as
// createArena() (so inGame/aiMatch consumers work unchanged), every mesh
// keeps layer 0 while also enabling the arena-light layer 3 (the WebXR
// ArrayCamera contract from arena.js), the fixtures carry names
// arenaLighting.js can resolve, and dispose() actually releases what was
// built. Real three (CJS build via moduleNameMapper), mocked scene modules.

const TABLE_BOX = {
  min: { x: -0.7625, y: 0.74, z: -3.04 },
  max: { x: 0.7625, y: 0.76, z: -0.30 },
};

function loadFocusRoom({ tableBox = TABLE_BOX } = {}) {
  jest.resetModules();
  const scene = { add: jest.fn(), remove: jest.fn() };
  jest.doMock('../js/scene/sceneSetup.js', () => ({ scene, ARENA_LIGHT_LAYER: 3 }));
  jest.doMock('../js/scene/models.js', () => ({ tableBox }));
  return { mod: require('../js/scene/focusRoom.js'), scene };
}

test('returns null before loadModels populated tableBox', () => {
  const { mod, scene } = loadFocusRoom({ tableBox: null });
  expect(mod.createFocusRoom()).toBeNull();
  expect(scene.add).not.toHaveBeenCalled();
});

test('handle has the createArena shape and the venue-specific getters', () => {
  const { mod, scene } = loadFocusRoom();
  const room = mod.createFocusRoom();
  expect(room).not.toBeNull();
  expect(scene.add).toHaveBeenCalledWith(room.group);
  for (const key of ['show', 'hide', 'dispose', 'getBackWallAnchor',
    'getStadiumScreens', 'getCrowdAnchors', 'getStadiumFixtures', 'getBrandingBoards']) {
    expect(typeof room[key]).toBe('function');
  }
  // Synchronous build — ready resolves immediately.
  expect(room.ready).toBeInstanceOf(Promise);
  // Stadium-only accessors are empty, never null (consumers .length them).
  expect(room.getStadiumScreens()).toEqual([]);
  expect(room.getCrowdAnchors()).toEqual([]);
  expect(room.getBrandingBoards()).toEqual([]);
  room.dispose();
});

test('back wall anchor is the wall-mount contract the scoreboard expects', () => {
  const { mod } = loadFocusRoom();
  const room = mod.createFocusRoom();
  const a = room.getBackWallAnchor();
  expect(a.x).toBeCloseTo(0);
  expect(a.y).toBeCloseTo(2.2);
  expect(a.z).toBeCloseTo(-1.67 - 6 + 0.02);
  expect(a.wallWidth).toBeCloseTo(8);
  expect(a.wallHeight).toBeCloseTo(4.5);
  room.dispose();
});

test('every mesh keeps layer 0 AND enables the arena light layer 3', () => {
  const { mod } = loadFocusRoom();
  const room = mod.createFocusRoom();
  let meshCount = 0;
  room.group.traverse((obj) => {
    if (!obj.isMesh) return;
    meshCount++;
    // Bit 0 (camera) must stay set — ArrayCamera layer isolation is
    // unreliable; bit 3 (arena lights) must be added.
    expect(obj.layers.mask & 1).toBeTruthy();
    expect(obj.layers.mask & (1 << 3)).toBeTruthy();
  });
  // Shell, floor, ceiling, court border, barriers, stripes, wall accents,
  // center panel, ring panels.
  expect(meshCount).toBeGreaterThanOrEqual(9);
  room.dispose();
});

test('fixtures carry the names arenaLighting.js resolves, with pulsable materials', () => {
  const { mod } = loadFocusRoom();
  const room = mod.createFocusRoom();
  const fixtures = room.getStadiumFixtures();
  expect(fixtures.map((f) => f.name).sort()).toEqual(['CeilingRing', 'CenterLightBox']);
  for (const f of fixtures) {
    // arenaLighting's setBlendedColor mutates mesh.material.color.
    expect(f.mesh.material.color).toBeDefined();
  }
  // The two fixtures must pulse independently — no shared material.
  expect(fixtures[0].mesh.material).not.toBe(fixtures[1].mesh.material);
  room.dispose();
});

test('show/hide toggle group visibility; room starts hidden', () => {
  const { mod } = loadFocusRoom();
  const room = mod.createFocusRoom();
  expect(room.group.visible).toBe(false);
  room.show();
  expect(room.group.visible).toBe(true);
  room.hide();
  expect(room.group.visible).toBe(false);
  room.dispose();
});

test('dispose removes the group and releases geometries and materials', () => {
  const { mod, scene } = loadFocusRoom();
  const room = mod.createFocusRoom();
  const geoSpies = [];
  const matSpies = [];
  room.group.traverse((obj) => {
    if (obj.isMesh) {
      geoSpies.push(jest.spyOn(obj.geometry, 'dispose'));
      matSpies.push(jest.spyOn(obj.material, 'dispose'));
    }
  });
  expect(geoSpies.length).toBeGreaterThan(0);
  room.dispose();
  expect(scene.remove).toHaveBeenCalledWith(room.group);
  for (const s of geoSpies) expect(s).toHaveBeenCalled();
  for (const s of matSpies) expect(s).toHaveBeenCalled();
});
