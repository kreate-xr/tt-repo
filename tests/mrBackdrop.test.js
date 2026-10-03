// Passthrough backdrop builder — the scene-facing contract (mrBackdrop.js).
//
// Mirrors tests/focusRoom.test.js: real three (CJS build via
// moduleNameMapper), mocked scene modules. What matters here is the handle
// shape inGame.js relies on (setVisible follows the profile setting, dispose
// releases everything), that the screen starts hidden (the setting is off by
// default and a flash of wall on session start would be a bug), and that
// the geometry lands where the spec says.

const TABLE_BOX = {
  min: { x: -0.7625, y: 0.74, z: -3.04 },
  max: { x: 0.7625, y: 0.76, z: -0.30 },
};

function loadBackdrop({ tableBox = TABLE_BOX } = {}) {
  jest.resetModules();
  const scene = { add: jest.fn(), remove: jest.fn() };
  jest.doMock('../js/scene/sceneSetup.js', () => ({ scene, ARENA_LIGHT_LAYER: 3 }));
  jest.doMock('../js/scene/models.js', () => ({ tableBox }));
  return { mod: require('../js/scene/mrBackdrop.js'), scene };
}

test('returns null before loadModels populated tableBox', () => {
  const { mod, scene } = loadBackdrop({ tableBox: null });
  expect(mod.createMRBackdrop()).toBeNull();
  expect(scene.add).not.toHaveBeenCalled();
});

test('handle shape: starts hidden, setVisible/show/hide drive the group', () => {
  const { mod, scene } = loadBackdrop();
  const b = mod.createMRBackdrop();
  expect(b).not.toBeNull();
  expect(scene.add).toHaveBeenCalledWith(b.group);
  for (const key of ['show', 'hide', 'setVisible', 'isVisible', 'dispose']) {
    expect(typeof b[key]).toBe('function');
  }
  expect(b.isVisible()).toBe(false);
  b.setVisible(true);
  expect(b.group.visible).toBe(true);
  b.setVisible(false);
  expect(b.group.visible).toBe(false);
  b.show();
  expect(b.isVisible()).toBe(true);
  b.hide();
  expect(b.isVisible()).toBe(false);
  // Coerces: the store hands back booleans, but a truthy/undefined must not
  // leave the group in a non-boolean state.
  b.setVisible(undefined);
  expect(b.group.visible).toBe(false);
  b.dispose();
});

test('the wall faces the player from behind the far edge, at spec size', () => {
  const { mod } = loadBackdrop();
  const { BACKDROP } = require('../js/scene/mrBackdropSpec.js');
  const b = mod.createMRBackdrop();
  const wall = b.group.children.find((o) => o.isMesh && !o.isInstancedMesh);
  expect(wall).toBeDefined();
  expect(wall.position.z).toBeCloseTo(-3.04 - BACKDROP.STANDOFF_Z);
  expect(wall.position.x).toBeCloseTo(0);
  // Standing on the floor: centre at half height.
  expect(wall.position.y).toBeCloseTo(BACKDROP.HEIGHT_Y / 2);
  expect(wall.geometry.parameters.width).toBe(BACKDROP.WIDTH_X);
  expect(wall.geometry.parameters.height).toBe(BACKDROP.HEIGHT_Y);
  // A PlaneGeometry faces +Z, toward the player; no rotation, FrontSide.
  expect(wall.rotation.y).toBe(0);
  expect(wall.material.side).toBe(require('three').FrontSide);
  b.dispose();
});

test('every mesh keeps layer 0 AND enables the arena light layer 3', () => {
  const { mod } = loadBackdrop();
  const b = mod.createMRBackdrop();
  let meshCount = 0;
  b.group.traverse((obj) => {
    if (!obj.isMesh) return;
    meshCount++;
    expect(obj.layers.mask & 1).toBeTruthy();
    expect(obj.layers.mask & (1 << 3)).toBeTruthy();
  });
  // The wall alone; the mark arrives async and is not counted.
  expect(meshCount).toBeGreaterThanOrEqual(1);
  b.dispose();
});

test('carries no edge trim — the screen is the wall and the mark only', () => {
  const { mod } = loadBackdrop();
  const b = mod.createMRBackdrop();
  expect(b.group.children.some((o) => o.isInstancedMesh)).toBe(false);
  expect(b.group.children.filter((o) => o.isMesh)).toHaveLength(1);
  b.dispose();
});

test('dispose removes the group and releases geometries and materials', () => {
  const { mod, scene } = loadBackdrop();
  const b = mod.createMRBackdrop();
  const geoSpies = [];
  const matSpies = [];
  b.group.traverse((obj) => {
    if (obj.isMesh) {
      geoSpies.push(jest.spyOn(obj.geometry, 'dispose'));
      matSpies.push(jest.spyOn(obj.material, 'dispose'));
    }
  });
  expect(geoSpies.length).toBeGreaterThan(0);
  b.dispose();
  expect(scene.remove).toHaveBeenCalledWith(b.group);
  for (const s of geoSpies) expect(s).toHaveBeenCalled();
  for (const s of matSpies) expect(s).toHaveBeenCalled();
});
