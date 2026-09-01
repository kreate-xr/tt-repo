// ServeArrow — placement, side selection, fade lifecycle, and disposal.
//
// The arrow is a pure visual, but its contract has geometry and state that
// can regress silently: each half's arrow must sit on its own side of the
// table and point AT the net (an Euler-order change would silently spin the
// opponent's chevrons down the table), only the serving half may be lit,
// both must fade fully in and out through update(dt), keep the pulse inside
// sane opacity bounds, and force-hide via the safety timer even when the
// update loop never runs (paused XR session).

const { Vector3 } = require('three');

// Jest runs in a node environment (no jsdom). serveArrow draws its chevron
// tile on a 2D canvas at init, so stub just enough of document/canvas for
// the draw calls to no-op. THREE.CanvasTexture happily wraps the fake.
beforeAll(() => {
  global.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
      }),
    }),
  };
});
afterAll(() => { delete global.document; });

const TABLE_SURFACE_Y = 0.76;
const TABLE_BOX = {
  min: { x: -0.7625, y: 0.74, z: -3.04 },
  max: { x: 0.7625, y: 0.76, z: -0.3 },
};
const CENTER_Z = (TABLE_BOX.min.z + TABLE_BOX.max.z) / 2;

// serveArrow reads tableBox at module-require time via live bindings, so the
// "not ready" case needs a fresh module graph with a different mock — hence
// doMock + resetModules instead of a hoisted top-level jest.mock.
function loadServeArrow({ tableBox = TABLE_BOX } = {}) {
  jest.resetModules();
  const scene = { add: jest.fn(), remove: jest.fn() };
  jest.doMock('../js/scene/sceneSetup.js', () => ({ scene }));
  jest.doMock('../js/scene/models.js', () => ({
    tableBox,
    tableSurfaceY: TABLE_SURFACE_Y,
  }));
  const { createServeArrow } = require('../js/scene/serveArrow.js');
  return { createServeArrow, scene };
}

// World-space direction the chevron apex points: the plane's local +Y run
// through the mesh's own rotation.
function apexDirection(mesh) {
  mesh.updateMatrixWorld(true);
  return new Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
}

test('returns null before the table model has loaded', () => {
  const { createServeArrow } = loadServeArrow({ tableBox: null });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(createServeArrow()).toBeNull();
  warn.mockRestore();
});

describe('placement', () => {
  test('both halves lie flat just above the felt, each on its own side', () => {
    const { createServeArrow, scene } = loadServeArrow();
    const arrow = createServeArrow();
    const { player, opponent } = arrow.meshes;

    expect(scene.add).toHaveBeenCalledWith(player);
    expect(scene.add).toHaveBeenCalledWith(opponent);
    for (const mesh of [player, opponent]) {
      expect(mesh.rotation.x).toBeCloseTo(-Math.PI / 2);
      expect(mesh.position.x).toBeCloseTo(0);
      expect(mesh.position.y).toBeCloseTo(TABLE_SURFACE_Y + 0.002);
      expect(mesh.visible).toBe(false);
    }
    // Player half: between table center z and the near (max.z) edge.
    expect(player.position.z).toBeGreaterThan(CENTER_Z);
    expect(player.position.z).toBeLessThan(TABLE_BOX.max.z);
    // Opponent half: the mirror, between center z and the far (min.z) edge.
    expect(opponent.position.z).toBeLessThan(CENTER_Z);
    expect(opponent.position.z).toBeGreaterThan(TABLE_BOX.min.z);
    arrow.dispose();
  });

  test('both halves point their chevrons AT the net, not down the table', () => {
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    // The net sits at CENTER_Z, so "toward the net" is -Z from the player
    // half (higher z) and +Z from the opponent half (lower z).
    expect(apexDirection(arrow.meshes.player).z).toBeCloseTo(-1);
    expect(apexDirection(arrow.meshes.opponent).z).toBeCloseTo(1);
    arrow.dispose();
  });
});

describe('side selection', () => {
  test('show() lights only the named half', () => {
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    const { player, opponent } = arrow.meshes;

    arrow.show('player');
    arrow.update(1);
    expect(player.material.opacity).toBeGreaterThan(0);
    expect(opponent.visible).toBe(false);

    arrow.show('opponent');
    arrow.update(1); // long enough for the player half to fade fully out
    expect(opponent.material.opacity).toBeGreaterThan(0);
    expect(player.visible).toBe(false);
    expect(player.material.opacity).toBe(0);
    arrow.dispose();
  });

  test('show() defaults to the player half', () => {
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    arrow.show();
    expect(arrow.meshes.player.visible).toBe(true);
    expect(arrow.meshes.opponent.visible).toBe(false);
    arrow.dispose();
  });

  test('hide() retires both halves', () => {
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    arrow.show('opponent');
    arrow.update(1);
    arrow.hide();
    arrow.update(1);
    expect(arrow.meshes.player.visible).toBe(false);
    expect(arrow.meshes.opponent.visible).toBe(false);
    arrow.dispose();
  });
});

describe('fade lifecycle', () => {
  // Both halves share one implementation; run the lifecycle against each so a
  // side-specific wiring slip can't hide behind the other's passing test.
  for (const side of ['player', 'opponent']) {
    test(`[${side}] show() fades in and the pulse stays inside sane bounds`, () => {
      const { createServeArrow } = loadServeArrow();
      const arrow = createServeArrow();
      const mesh = arrow.meshes[side];
      arrow.show(side);
      expect(mesh.visible).toBe(true);

      // Mid-fade after one 50ms frame (fade-in window is 200ms).
      arrow.update(0.05);
      expect(mesh.material.opacity).toBeGreaterThan(0);

      // Finish the fade, then walk a full second; opacity must keep pulsing
      // within BASE ± AMPLITUDE (0.35 ± 0.10) and never blink off.
      arrow.update(1);
      for (let i = 0; i < 60; i++) {
        arrow.update(1 / 60);
        const o = mesh.material.opacity;
        expect(o).toBeGreaterThanOrEqual(0.24);
        expect(o).toBeLessThanOrEqual(0.46);
      }
      arrow.dispose();
    });

    test(`[${side}] the chevrons flow while shown`, () => {
      const { createServeArrow } = loadServeArrow();
      const arrow = createServeArrow();
      const texture = arrow.meshes[side].material.map;
      arrow.show(side);
      const before = texture.offset.y;
      arrow.update(0.1);
      expect(texture.offset.y).not.toBe(before);
      arrow.dispose();
    });

    test(`[${side}] hide() fades out to invisible`, () => {
      const { createServeArrow } = loadServeArrow();
      const arrow = createServeArrow();
      const mesh = arrow.meshes[side];
      arrow.show(side);
      arrow.update(1); // fully in
      arrow.hide();
      arrow.update(1); // fade-out window is 180ms, so 1s is fully out
      expect(mesh.material.opacity).toBe(0);
      expect(mesh.visible).toBe(false);
      arrow.dispose();
    });
  }

  test('safety timer force-hides even if update() never runs', () => {
    jest.useFakeTimers();
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    arrow.show('opponent');
    arrow.update(1);
    arrow.hide();
    // No update() calls — simulate a paused XR render loop.
    jest.advanceTimersByTime(500);
    expect(arrow.meshes.opponent.visible).toBe(false);
    expect(arrow.meshes.opponent.material.opacity).toBe(0);
    arrow.dispose();
    jest.useRealTimers();
  });

  test('show() right after hide() cancels the pending force-hide', () => {
    jest.useFakeTimers();
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    arrow.show('player');
    arrow.update(1);
    arrow.hide();
    arrow.show('player');
    jest.advanceTimersByTime(500);
    expect(arrow.meshes.player.visible).toBe(true);
    arrow.dispose();
    jest.useRealTimers();
  });

  test('repeated hide() calls do not re-arm the safety timer', () => {
    jest.useFakeTimers();
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    const mesh = arrow.meshes.opponent;
    arrow.show('opponent');
    arrow.update(1);
    arrow.hide();
    // The receiver calls hide() every frame once the remote ball is live; a
    // hide() that re-armed the timeout each call would push the force-hide
    // out forever.
    for (let i = 0; i < 30; i++) {
      arrow.hide();
      jest.advanceTimersByTime(16);
    }
    expect(mesh.visible).toBe(false);
    expect(mesh.material.opacity).toBe(0);
    arrow.dispose();
    jest.useRealTimers();
  });
});

test('dispose() removes both meshes from the scene', () => {
  const { createServeArrow, scene } = loadServeArrow();
  const arrow = createServeArrow();
  const { player, opponent } = arrow.meshes;
  arrow.dispose();
  expect(scene.remove).toHaveBeenCalledWith(player);
  expect(scene.remove).toHaveBeenCalledWith(opponent);
});
