// Pure-function regression tests for the paddle-vs-table penetration
// clamp. The clamp pushes the paddle disc out of the table's XZ footprint
// extended semi-infinitely downward — so both top-face clipping (blade
// dipping through the felt) and side-face clipping (horizontal swing into
// the table edge) get resolved.

const THREE = require('three');

import { resolvePaddleTablePenetration } from '../js/physics/paddleTableClamp.js';

function v(x, y, z) { return new THREE.Vector3(x, y, z); }

// Reference table footprint: 1.5 m × 2.7 m centered at origin, felt top at Y=1.
function refTableBox() {
  return new THREE.Box3(v(-0.75, 0.98, -1.35), v(0.75, 1.0, 1.35));
}

const R = 0.15;   // paddle disc radius
const HT = 0.01;  // paddle half-thickness

describe('resolvePaddleTablePenetration — no penetration cases', () => {
  test('paddle well above the table returns zero delta', () => {
    const out = v(9, 9, 9);
    resolvePaddleTablePenetration(v(0, 1.5, 0), v(0, 1, 0), R, HT, refTableBox(), out);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  test('paddle horizontally off the side of the table returns zero delta', () => {
    // Face center 2 m to the right of the table, well below felt level.
    const out = v(9, 9, 9);
    resolvePaddleTablePenetration(v(2.5, 0.5, 0), v(0, 1, 0), R, HT, refTableBox(), out);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  test('null tableBox returns zero delta', () => {
    const out = v(9, 9, 9);
    resolvePaddleTablePenetration(v(0, 0, 0), v(0, 1, 0), R, HT, null, out);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });
});

describe('resolvePaddleTablePenetration — top-face penetration', () => {
  test('horizontal blade with center below felt gets lifted by (top - center)', () => {
    // Horizontal blade: normal = +Y. Center at y=0.98 → depth 0.035 (yTop = 1.0 + 0.01 + 0.005 = 1.015).
    const out = v(0, 0, 0);
    resolvePaddleTablePenetration(v(0, 0.98, 0), v(0, 1, 0), R, HT, refTableBox(), out);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0.035, 4);
    expect(out.z).toBeCloseTo(0, 6);
  });

  test('tilted blade center above felt but rim below gets lifted by rim depth', () => {
    // Vertical blade (normal = +Z): rim spans Y-axis, extending ±R vertically
    // from the face center. Center at y = 1.10 → lowest rim at y = 1.10 - 0.15 = 0.95.
    // yTop = 1.015 → penetration 0.065. Lift by 0.065.
    const out = v(0, 0, 0);
    resolvePaddleTablePenetration(v(0, 1.10, 0), v(0, 0, 1), R, HT, refTableBox(), out);
    expect(out.y).toBeCloseTo(0.065, 3);
    // Center is well inside the XZ footprint; no lateral push expected.
    expect(Math.abs(out.x)).toBeLessThan(1e-4);
    expect(Math.abs(out.z)).toBeLessThan(1e-4);
  });

  test('the CENTER-only clamp would miss this: horizontal blade whose center is above the felt but rim below the felt', () => {
    // Blade tilted 45° so the rim dips below. Face normal in XZ plane so the
    // rim spans a full circle at 45° — some rim points sit below yTop.
    // Face center 0.02 m above yTop; rim extends ±0.15 in every direction of
    // the face plane, so at 45° tilt some rim samples are ~0.15/√2 ≈ 0.106
    // below the center → 0.086 below yTop.
    const n = v(1, 1, 0).normalize();
    const cy = 1.015 + 0.02; // 0.02 above yTop
    const out = v(0, 0, 0);
    resolvePaddleTablePenetration(v(0, cy, 0), n, R, HT, refTableBox(), out);
    // Old center-only logic: faceCenter.y > yTop → no lift → clip.
    // New logic: rim samples penetrate → lift.
    expect(out.y).toBeGreaterThan(0.05);
  });
});

describe('resolvePaddleTablePenetration — side-face penetration', () => {
  test('face center inside the table body pushes out the nearest side', () => {
    // Face center at (0.6, 0.5, 0) — well inside the XZ footprint, deep below
    // felt (0.5 m below yTop=1.015). Shortest exit: +X (0.75 - 0.6 = 0.15).
    // Rim at R=0.15 means the +X rim sample is at 0.75 (at the edge), so the
    // deepest penetration sample is the -X rim at 0.45, wanting +X push 0.30.
    const out = v(0, 0, 0);
    resolvePaddleTablePenetration(v(0.6, 0.5, 0), v(0, 1, 0), R, HT, refTableBox(), out);
    expect(out.x).toBeGreaterThan(0.29);
    expect(out.x).toBeLessThan(0.31);
    // Y push should NOT happen — the top exit is much farther than the side.
    expect(out.y).toBe(0);
  });

  test('face center inside table body, near the -Z side, pushes out through -Z', () => {
    // Center at (0, 0.5, -1.30). zmin = -1.35, so dF = -1.30 - (-1.35) = 0.05.
    // Everything else is farther. Push in -Z direction by ~0.05 (or slightly
    // more due to rim samples reaching further -Z).
    const out = v(0, 0, 0);
    resolvePaddleTablePenetration(v(0, 0.5, -1.30), v(0, 1, 0), R, HT, refTableBox(), out);
    expect(out.z).toBeLessThan(-0.04);
    expect(out.y).toBe(0);
  });
});

describe('resolvePaddleTablePenetration — output vector reuse', () => {
  test('out vector is zeroed at the start of each call, not accumulated', () => {
    const out = v(100, 100, 100);
    resolvePaddleTablePenetration(v(0, 1.5, 0), v(0, 1, 0), R, HT, refTableBox(), out);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });
});
