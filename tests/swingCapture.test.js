// TEMPORARY — js/diag/swingCapture.js (fast-swing headset capture). Delete
// together with the module after the headset test.

const THREE = require('three');

let mockDiagHandler = null;
jest.mock('../js/physics/ball.js', () => ({
  setSwingDiagHandler: (h) => { mockDiagHandler = h; },
}));
let mockFrozen = false;
jest.mock('../js/xr/trackingLossGuard.js', () => ({ shouldFreezePaddle: () => mockFrozen }));

let posts;
beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  mockDiagHandler = null;
  mockFrozen = false;
  posts = [];
  globalThis.__IS_DEV_SERVER__ = true;
  globalThis.window = { location: { search: '?swingcap' } };
  globalThis.fetch = jest.fn((url, opts) => {
    posts.push(...opts.body.trim().split('\n').map((l) => JSON.parse(l)));
    return Promise.resolve({ ok: true });
  });
});
afterEach(() => {
  jest.useRealTimers();
  delete globalThis.__IS_DEV_SERVER__;
  delete globalThis.window;
  delete globalThis.fetch;
});

const face = new THREE.Vector3(0, 1, 0);
const at = (dist) => new THREE.Vector3(0, 1, dist);

// Ball travels toward the face and away again; `hitAt` marks the contact frame.
function pass(h, { from = 0.6, to = 0.6, closest = 0.02, speed = 3, hitAt = null, t0 = 0 } = {}) {
  const path = [];
  for (let d = from; d > closest; d -= 0.05) path.push(d);
  path.push(closest);
  for (let d = closest + 0.05; d < to; d += 0.05) path.push(d);
  path.forEach((d, i) => {
    h.frame(t0 + i * 0.011, 0.011, at(d), face, face, speed, false, hitAt === i);
  });
  return path.length;
}

function start() {
  const m = require('../js/diag/swingCapture.js');
  expect(m.startSwingCapture()).toBe(true);
  return m;
}

test('does nothing without ?swingcap or off the dev server', () => {
  globalThis.window.location.search = '';
  expect(require('../js/diag/swingCapture.js').startSwingCapture()).toBe(false);
  expect(mockDiagHandler).toBeNull();
  jest.resetModules();
  globalThis.window.location.search = '?swingcap';
  globalThis.__IS_DEV_SERVER__ = false;
  expect(require('../js/diag/swingCapture.js').startSwingCapture()).toBe(false);
});

test('posts a start marker at once, then one approach per pass', () => {
  const m = start();
  expect(posts[0].type).toBe('start');
  pass(mockDiagHandler, { speed: 7 });
  jest.advanceTimersByTime(1000);
  const approaches = posts.filter((p) => p.type === 'approach');
  expect(approaches).toHaveLength(1);
  expect(approaches[0]).toMatchObject({ hit: false, minD: 0.02, speed: 7, peak: 7, supp: false, lag: 0 });
  m.stopSwingCapture();
  expect(posts[posts.length - 1].type).toBe('stop');
});

test('a hit ends the approach as a hit, with no fake miss as the ball leaves', () => {
  start();
  // contact at the closest frame (index of `closest` in the path)
  const n = Math.ceil((0.6 - 0.02) / 0.05);
  pass(mockDiagHandler, { hitAt: n });
  jest.advanceTimersByTime(1000);
  const approaches = posts.filter((p) => p.type === 'approach');
  expect(approaches.map((p) => p.hit)).toEqual([true]);
});

test('a plane crossing without contact and a frozen paddle are attached to the approach', () => {
  start();
  mockDiagHandler.frame(0, 0.011, at(0.2), face, face, 9, true, false);
  mockFrozen = true;
  mockDiagHandler.frame(0.011, 0.03, at(0.05), face, face, 9, false, false);
  mockDiagHandler.crossMiss(0.012, false, 0.12, 0.11);
  mockDiagHandler.frame(0.022, 0.011, at(0.3), face, face, 9, false, false);
  jest.advanceTimersByTime(1000);
  const [a] = posts.filter((p) => p.type === 'approach');
  expect(a).toMatchObject({
    hit: false, supp: true, frozen: true, maxDt: 0.03,
    cross: { cooldown: false, radial: 0.12, limit: 0.11 },
  });
});

test('heartbeat carries the counters', () => {
  start();
  pass(mockDiagHandler);
  jest.advanceTimersByTime(5000);
  const hb = posts.filter((p) => p.type === 'hb').pop();
  expect(hb).toMatchObject({ approaches: 1, hits: 0 });
  expect(hb.frames).toBeGreaterThan(0);
});
