// ServeArrow — placement, fade lifecycle, and disposal.
//
// The arrow is a pure visual, but its contract has geometry and state that
// can regress silently: it must sit on the PLAYER's half (z between table
// center and the near edge), fade fully in and out through update(dt), keep
// its pulse inside sane opacity bounds, and force-hide via the safety timer
// even when the update loop never runs (paused XR session).

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

test('returns null before the table model has loaded', () => {
  const { createServeArrow } = loadServeArrow({ tableBox: null });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(createServeArrow()).toBeNull();
  warn.mockRestore();
});

describe('placement', () => {
  test('lies flat just above the felt, centered on the player half', () => {
    const { createServeArrow, scene } = loadServeArrow();
    const arrow = createServeArrow();
    const { position, rotation } = arrow.mesh;

    expect(scene.add).toHaveBeenCalledWith(arrow.mesh);
    expect(rotation.x).toBeCloseTo(-Math.PI / 2);
    expect(position.x).toBeCloseTo(0);
    expect(position.y).toBeCloseTo(TABLE_SURFACE_Y + 0.002);
    // Player half: between table center z and the near (max.z) edge.
    const centerZ = (TABLE_BOX.min.z + TABLE_BOX.max.z) / 2;
    expect(position.z).toBeGreaterThan(centerZ);
    expect(position.z).toBeLessThan(TABLE_BOX.max.z);
    expect(arrow.mesh.visible).toBe(false);
    arrow.dispose();
  });
});

describe('fade lifecycle', () => {
  test('show() fades in and the pulse stays inside sane bounds', () => {
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    arrow.show();
    expect(arrow.mesh.visible).toBe(true);

    // Mid-fade after one 50ms frame (fade-in window is 200ms).
    arrow.update(0.05);
    const midFade = arrow.mesh.material.opacity;
    expect(midFade).toBeGreaterThan(0);

    // Finish the fade, then walk a full second; opacity must keep pulsing
    // within BASE ± AMPLITUDE (0.35 ± 0.10) and never blink off.
    arrow.update(1);
    for (let i = 0; i < 60; i++) {
      arrow.update(1 / 60);
      const o = arrow.mesh.material.opacity;
      expect(o).toBeGreaterThanOrEqual(0.24);
      expect(o).toBeLessThanOrEqual(0.46);
    }
    arrow.dispose();
  });

  test('the chevrons flow while shown', () => {
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    const texture = arrow.mesh.material.map;
    arrow.show();
    const before = texture.offset.y;
    arrow.update(0.1);
    expect(texture.offset.y).not.toBe(before);
    arrow.dispose();
  });

  test('hide() fades out to invisible', () => {
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    arrow.show();
    arrow.update(1); // fully in
    arrow.hide();
    arrow.update(1); // fade-out window is 180ms, so 1s is fully out
    expect(arrow.mesh.material.opacity).toBe(0);
    expect(arrow.mesh.visible).toBe(false);
    arrow.dispose();
  });

  test('safety timer force-hides even if update() never runs', () => {
    jest.useFakeTimers();
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    arrow.show();
    arrow.update(1);
    arrow.hide();
    // No update() calls — simulate a paused XR render loop.
    jest.advanceTimersByTime(500);
    expect(arrow.mesh.visible).toBe(false);
    expect(arrow.mesh.material.opacity).toBe(0);
    arrow.dispose();
    jest.useRealTimers();
  });

  test('show() right after hide() cancels the pending force-hide', () => {
    jest.useFakeTimers();
    const { createServeArrow } = loadServeArrow();
    const arrow = createServeArrow();
    arrow.show();
    arrow.update(1);
    arrow.hide();
    arrow.show();
    jest.advanceTimersByTime(500);
    expect(arrow.mesh.visible).toBe(true);
    arrow.dispose();
    jest.useRealTimers();
  });
});

test('dispose() removes the mesh from the scene', () => {
  const { createServeArrow, scene } = loadServeArrow();
  const arrow = createServeArrow();
  arrow.dispose();
  expect(scene.remove).toHaveBeenCalledWith(arrow.mesh);
});
