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

test('ceiling fixtures read as recessed lamps against the dark ceiling', () => {
  const { ROOM, LIGHT_PANELS } = require('../js/scene/focusRoomSpec.js');
  // A recessed troffer reads by a three-step falloff: the lamp, the lit
  // reflector framing it, then the ceiling. The reveal must therefore sit
  // strictly BETWEEN the panel and the ceiling on EVERY channel — darker than
  // the lamp so it does not merge into it, lighter than the ceiling so the
  // frame is not swallowed by it. It was the other way round while the ceiling
  // was milky white and unlit panels could only read as a shadow gap; the
  // ceiling going back to dark flips this with it. The frame also has to
  // actually extend past the panel, or there is no frame.
  // Compared by LUMA, not per channel: these are lit surfaces judged by how
  // bright they read, and a chromatic value can legitimately sit below a
  // neutral one on a single channel while reading brighter overall.
  const luma = (hex) => 0.2126 * ((hex >> 16) & 0xff)
    + 0.7152 * ((hex >> 8) & 0xff) + 0.0722 * (hex & 0xff);
  expect(luma(LIGHT_PANELS.REVEAL_COLOR)).toBeGreaterThan(luma(ROOM.CEILING_COLOR));
  expect(luma(LIGHT_PANELS.REVEAL_COLOR)).toBeLessThan(luma(LIGHT_PANELS.COLOR));
  expect(LIGHT_PANELS.REVEAL_MARGIN).toBeGreaterThan(0);
});

test('one recess reveal per panel, clear of the ceiling and the panel tops', () => {
  const { mod } = loadFocusRoom();
  const { ROOM, LIGHT_PANELS } = require('../js/scene/focusRoomSpec.js');
  const room = mod.createFocusRoom();

  const revealW = LIGHT_PANELS.W + 2 * LIGHT_PANELS.REVEAL_MARGIN;
  let reveals = null;
  room.group.traverse((o) => {
    if (o.isInstancedMesh && o.geometry.parameters
        && Math.abs(o.geometry.parameters.width - revealW) < 1e-9) reveals = o;
  });
  expect(reveals).not.toBeNull();

  // One per fixture position.
  const { computeFocusRoomLayout } = require('../js/scene/focusRoomSpec.js');
  const layout = computeFocusRoomLayout(TABLE_BOX);
  expect(reveals.count).toBe(layout.panelSlots.length);

  // Slung under the ceiling plane and above the panel tops — a face coplanar
  // with either z-fights into a shimmer directly overhead.
  const ceilingY = ROOM.HEIGHT_Y - 0.01;
  const panelTop = layout.panelY + LIGHT_PANELS.THICK / 2;
  const THREE = require('three');
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  for (let i = 0; i < reveals.count; i++) {
    reveals.getMatrixAt(i, m);
    m.decompose(pos, quat, scl);
    expect(pos.y + LIGHT_PANELS.REVEAL_THICK / 2).toBeLessThan(ceilingY);
    expect(pos.y - LIGHT_PANELS.REVEAL_THICK / 2).toBeGreaterThan(panelTop);
  }
  room.dispose();
});
