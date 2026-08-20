// Over-net point burst — the brief "+1" / "FOUL" flash above the net.
//
// The interesting behavior is the self-contained timeline: burst() must show
// both meshes, update(dt) must run the pop / rise / fade and then fully
// retire the effect (invisible AND zero opacity) with no timers involved,
// and a re-burst mid-animation must restart cleanly.

beforeAll(() => {
  global.document = {
    createElement: () => {
      // ONE context per canvas — getContext() must return the same object
      // every call, or the fillText spy the test inspects is not the one the
      // burst drew into.
      const ctx = {
        clearRect() {},
        fillText: jest.fn(),
      };
      return { width: 0, height: 0, getContext: () => ctx };
    },
  };
});
afterAll(() => { delete global.document; });

const NET_BOX = {
  min: { x: -0.7625, y: 0.76, z: -1.75 },
  max: { x: 0.7625, y: 0.9125, z: -1.73 },
};

function loadPointBurst() {
  jest.resetModules();
  const scene = { add: jest.fn(), remove: jest.fn() };
  jest.doMock('../js/scene/sceneSetup.js', () => ({ scene }));
  jest.doMock('../js/scene/models.js', () => ({ netBox: NET_BOX }));
  return { mod: require('../js/scene/pointBurst.js'), scene };
}

// The canvas is stubbed, so assert on what the burst DREW rather than pixels.
function drawnText(b) {
  return b.textMesh.material.map.image.getContext('2d').fillText.mock.calls.map(c => c[0]);
}

test('a player point flashes +1 and both meshes appear over the net', () => {
  const { mod } = loadPointBurst();
  const b = mod.createPointBurst();
  b.burst({ winner: 'player' });
  expect(drawnText(b)).toContain('+1');
  expect(b.textMesh.visible).toBe(true);
  expect(b.ringMesh.visible).toBe(true);
  // Anchored above the net tape, centered on its X.
  expect(b.textMesh.position.x).toBeCloseTo(0);
  expect(b.textMesh.position.y).toBeGreaterThan(NET_BOX.max.y);
  b.dispose();
});

test('the effect fully retires itself after its duration', () => {
  const { mod } = loadPointBurst();
  const b = mod.createPointBurst();
  b.burst({ winner: 'ai' });
  // Mid-flight: visible with some opacity.
  b.update(0.3);
  expect(b.textMesh.visible).toBe(true);
  expect(b.textMesh.material.opacity).toBeGreaterThan(0);
  // The ring dies first (shockwave is a front-of-timeline accent).
  b.update(0.3);
  expect(b.ringMesh.visible).toBe(false);
  // Past the full duration: everything off, nothing lingering at opacity 0.
  b.update(1.0);
  expect(b.textMesh.visible).toBe(false);
  expect(b.textMesh.material.opacity).toBe(0);
  expect(b.ringMesh.material.opacity).toBe(0);
  // Idle update is a no-op, not a crash.
  expect(() => b.update(0.016)).not.toThrow();
  b.dispose();
});

test('the text rises as the animation plays', () => {
  const { mod } = loadPointBurst();
  const b = mod.createPointBurst();
  b.burst({ winner: 'player' });
  const y0 = b.textMesh.position.y;
  b.update(0.5);
  expect(b.textMesh.position.y).toBeGreaterThan(y0);
  b.dispose();
});

test('a foul flashes FOUL regardless of who scored', () => {
  const { mod } = loadPointBurst();
  const b = mod.createPointBurst();
  b.burst({ winner: 'ai', foul: 'player' });
  const texts = drawnText(b);
  expect(texts).toContain('FOUL');
  expect(texts).not.toContain('+1');
  b.dispose();
});

test('an unknown winner with no foul is ignored', () => {
  const { mod } = loadPointBurst();
  const b = mod.createPointBurst();
  b.burst({ winner: null });
  expect(b.textMesh.visible).toBe(false);
  expect(drawnText(b)).toHaveLength(0);
  b.dispose();
});

test('re-bursting mid-animation restarts the timeline', () => {
  const { mod } = loadPointBurst();
  const b = mod.createPointBurst();
  b.burst({ winner: 'player' });
  b.update(0.9); // deep into the fade
  const fadedOpacity = b.textMesh.material.opacity;
  b.burst({ winner: 'ai' });
  expect(b.textMesh.material.opacity).toBeGreaterThan(fadedOpacity);
  expect(b.ringMesh.visible).toBe(true);
  b.dispose();
});

test('dispose removes both meshes from the scene', () => {
  const { mod, scene } = loadPointBurst();
  const b = mod.createPointBurst();
  b.dispose();
  expect(scene.remove).toHaveBeenCalledTimes(2);
});
