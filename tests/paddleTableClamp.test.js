// Pure-function regression tests for the paddle-vs-table penetration
// clamp. The clamp pushes the paddle disc out of the table's XZ footprint
// extended semi-infinitely downward — so both top-face clipping (blade
// dipping through the felt) and side-face clipping (horizontal swing into
// the table edge) get resolved.

const THREE = require('three');

import {
  resolvePaddleTablePenetration, resolvePaddleTableTilt,
} from '../js/physics/paddleTableClamp.js';

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

describe('resolvePaddleTablePenetration — maxPush bound (player-held paddle)', () => {
  // The delta is applied to paddleAnchor.position, which translates the bat
  // away from the hand holding it. Unbounded, a hand driven deep through the
  // felt shoved the rendered paddle a full penetration depth off the grip —
  // the same detachment artifact that got the translational recoil removed.
  const BUDGET = 0.01;

  test('a deep penetration is capped at the budget, not the full depth', () => {
    const out = v(0, 0, 0);
    // Face center 30 cm below the felt, mid-table: the unbounded push is huge.
    resolvePaddleTablePenetration(v(0, 0.70, 0), v(0, 1, 0), R, HT, refTableBox(), out);
    const unbounded = out.length();
    expect(unbounded).toBeGreaterThan(0.25);

    resolvePaddleTablePenetration(
      v(0, 0.70, 0), v(0, 1, 0), R, HT, refTableBox(), out, BUDGET,
    );
    expect(out.length()).toBeCloseTo(BUDGET, 9);
  });

  test('direction is preserved when the bound bites', () => {
    const unbounded = v(0, 0, 0);
    const bounded = v(0, 0, 0);
    resolvePaddleTablePenetration(v(0, 0.70, 0), v(0, 1, 0), R, HT, refTableBox(), unbounded);
    resolvePaddleTablePenetration(
      v(0, 0.70, 0), v(0, 1, 0), R, HT, refTableBox(), bounded, BUDGET,
    );
    const cos = unbounded.clone().normalize().dot(bounded.clone().normalize());
    expect(cos).toBeCloseTo(1, 9);
  });

  test('a grazing contact is under the bound and resolves in full', () => {
    // 3 mm of dip — the common case. Must not be altered by the clamp.
    const free = v(0, 0, 0);
    const capped = v(0, 0, 0);
    resolvePaddleTablePenetration(v(0, 1.012, 0), v(0, 1, 0), R, HT, refTableBox(), free);
    resolvePaddleTablePenetration(
      v(0, 1.012, 0), v(0, 1, 0), R, HT, refTableBox(), capped, BUDGET,
    );
    expect(free.length()).toBeGreaterThan(0);
    expect(free.length()).toBeLessThan(BUDGET);
    expect(capped.length()).toBeCloseTo(free.length(), 9);
  });

  test('omitting maxPush leaves AI / remote paddles unbounded', () => {
    // Nobody's hand holds those, so there is nothing to detach from and clean
    // non-clipping is the better look. Default must stay Infinity.
    const out = v(0, 0, 0);
    resolvePaddleTablePenetration(v(0, 0.70, 0), v(0, 1, 0), R, HT, refTableBox(), out);
    expect(out.length()).toBeGreaterThan(0.25);
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

// ---------------------------------------------------------------------------
// resolvePaddleTableTilt — the pitch-about-the-grip rescue that runs after the
// bounded translation. The identity it relies on: for a rotation about the
// horizontal axis a = (r_fc × up)/|r_fc × up| through the pivot, a point at
// offset r from the pivot rises at rate (a × r).y = (r_h · r_fc,h)/|r_fc,h|
// per radian — the sample's horizontal offset projected onto the bat's
// horizontal direction. Positive for the whole blade in any real grip.
// ---------------------------------------------------------------------------

const YTOP = 1.0 + HT + 0.005; // felt top + blade half-thickness + margin

function applyAboutPivot(pivot, q, p) {
  return p.clone().sub(pivot).applyQuaternion(q).add(pivot);
}

// Same sampling scheme as the solver: face center + 8 rim points.
function discSamples(faceCenter, normal, radius) {
  const up = v(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(normal, up);
  if (u.lengthSq() < 1e-6) u.crossVectors(normal, v(1, 0, 0));
  u.normalize();
  const w = new THREE.Vector3().crossVectors(normal, u).normalize();
  const pts = [faceCenter.clone()];
  for (let i = 0; i < 8; i++) {
    const th = (i / 8) * Math.PI * 2;
    pts.push(faceCenter.clone()
      .addScaledVector(u, Math.cos(th) * radius)
      .addScaledVector(w, Math.sin(th) * radius));
  }
  return pts;
}

describe('resolvePaddleTableTilt — no-op cases', () => {
  test('paddle above the felt returns 0 and identity', () => {
    const q = new THREE.Quaternion(9, 9, 9, 9);
    const a = resolvePaddleTableTilt(
      v(0, 1.4, 0.5), v(0, 1.2, 0.3), v(0, 1, 0), R, HT, refTableBox(), q,
    );
    expect(a).toBe(0);
    expect(q.w).toBe(1);
    expect(q.x).toBe(0);
  });

  test('null tableBox returns 0', () => {
    const q = new THREE.Quaternion();
    expect(resolvePaddleTableTilt(
      v(0, 1, 0), v(0, 0.5, 0), v(0, 1, 0), R, HT, null, q,
    )).toBe(0);
  });

  test('side-exit penetration is not this solver\'s business', () => {
    // Face center deep in the table body but hugging the +X edge: every
    // penetrating sample's shortest exit is sideways. The translation clamp
    // owns that case; the tilt must not fire.
    const q = new THREE.Quaternion();
    const a = resolvePaddleTableTilt(
      v(0.7, 1.3, 0.2), v(0.7, 0.5, 0), v(0, 1, 0), R, HT, refTableBox(), q,
    );
    expect(a).toBe(0);
  });

  test('bat hanging exactly straight down from the fist is degenerate — no tilt', () => {
    // Pivot directly above the face center: the pitch axis is undefined and
    // no pitch about the hand can lift the blade.
    const q = new THREE.Quaternion();
    const a = resolvePaddleTableTilt(
      v(0, 1.3, 0.5), v(0, 0.95, 0.5), v(0, 0, 1), R, HT, refTableBox(), q,
    );
    expect(a).toBe(0);
  });
});

describe('resolvePaddleTableTilt — deep dip rides up onto the felt', () => {
  // Hand 8.5 cm above the felt over the table, horizontal blade 6.5 cm below
  // yTop and 20 cm forward of the hand — well past the 1 cm translation
  // budget, the case that used to render as a clip.
  const pivot = v(0, 1.10, 0.5);
  const fc = v(0, 0.95, 0.3);
  const n = v(0, 1, 0);

  test('resolves the whole disc above the felt', () => {
    const q = new THREE.Quaternion();
    const a = resolvePaddleTableTilt(pivot, fc, n, R, HT, refTableBox(), q);
    expect(a).toBeGreaterThan(0);

    const fc2 = applyAboutPivot(pivot, q, fc);
    expect(fc2.y).toBeGreaterThanOrEqual(YTOP - 1e-3);

    const n2 = n.clone().applyQuaternion(q);
    for (const s of discSamples(fc2, n2, R)) {
      // Solver tolerance is 0.5 mm on its own sample phases; allow a hair
      // more here since this rim basis can sample at different phases.
      expect(s.y).toBeGreaterThanOrEqual(YTOP - 3e-3);
    }
  });

  test('the hand is a fixed point of the rotation', () => {
    const q = new THREE.Quaternion();
    resolvePaddleTableTilt(pivot, fc, n, R, HT, refTableBox(), q);
    const p2 = applyAboutPivot(pivot, q, pivot);
    expect(p2.distanceTo(pivot)).toBeLessThan(1e-12);
  });

  test('rotation axis is horizontal — a pure pitch, no yaw/roll about vertical', () => {
    const q = new THREE.Quaternion();
    const a = resolvePaddleTableTilt(pivot, fc, n, R, HT, refTableBox(), q);
    const s = Math.sqrt(1 - q.w * q.w);
    expect(s).toBeGreaterThan(0); // a > 0 so the quat is a real rotation
    expect(Math.abs(q.y / s)).toBeLessThan(1e-9);
    expect(a).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
  });

  test('inputs are not mutated', () => {
    const q = new THREE.Quaternion();
    const fcCopy = fc.clone();
    const nCopy = n.clone();
    const pvCopy = pivot.clone();
    resolvePaddleTableTilt(pivot, fc, n, R, HT, refTableBox(), q);
    expect(fc.equals(fcCopy)).toBe(true);
    expect(n.equals(nCopy)).toBe(true);
    expect(pivot.equals(pvCopy)).toBe(true);
  });
});

describe('resolvePaddleTableTilt — maxTilt cap', () => {
  test('an unreachable pose stops at the cap instead of spinning', () => {
    // Same deep dip, but a deliberately tiny budget: the solver must return
    // exactly the cap, and the quat must carry that angle.
    const q = new THREE.Quaternion();
    const a = resolvePaddleTableTilt(
      v(0, 1.10, 0.5), v(0, 0.95, 0.3), v(0, 1, 0), R, HT, refTableBox(), q, 0.1,
    );
    expect(a).toBeCloseTo(0.1, 9);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    expect(angle).toBeCloseTo(0.1, 6);
  });
});

describe('resolvePaddleTableTilt — pipeline with the bounded translation', () => {
  test('a graze the translation fully absorbs produces zero tilt', () => {
    // 3 mm dip: translation (1 cm budget) resolves it entirely, so by the
    // time the tilt solver sees the pose there is nothing left to rotate —
    // small contacts keep the exact in-headset-validated behavior.
    const fc = v(0, 1.012, 0);
    const n = v(0, 1, 0);
    const delta = v(0, 0, 0);
    resolvePaddleTablePenetration(fc, n, R, HT, refTableBox(), delta, 0.01);
    const fcAfter = fc.clone().add(delta);
    const q = new THREE.Quaternion();
    const a = resolvePaddleTableTilt(
      v(0, 1.15, 0.2), fcAfter, n, R, HT, refTableBox(), q,
    );
    expect(a).toBe(0);
    expect(q.w).toBe(1);
  });
});
