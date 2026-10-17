// Pure off-hand pose math: model choice, grip alignment against the WebXR
// gripSpace contract, button → curl mapping, curl smoothing, visibility.

const THREE = require('three');
import {
  handModelFor, computeGripAlign, curlFromButton, stepCurl, shouldShowOffHand,
  HAND_MODEL_SCALE, CURL_DEADZONE, SQUEEZE_REST_CURL,
  FIST_CENTROID_PALM_CM, FIST_CENTROID_WRIST_CM, FIST_CENTER_IN_GRIP_CM,
} from '../js/xr/offHandPose.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

// Left-rig rest joints (cm), measured from public/models/l_hand_skeletal_lowres.glb.
const LEFT = {
  wrist: v(1.77, 4.90, -7.17),
  index1: v(0.45, 5.16, 2.15),
  middle1: v(2.91, 6.06, 1.94),
  ring1: v(5.15, 5.60, 1.19),
  pinky1: v(7.06, 4.58, 0.11),
  middleTip: v(4.79, 1.93, 10.66),
};
// The right rig is the exact X mirror.
const mirror = (j) => Object.fromEntries(Object.entries(j).map(([k, p]) => [k, v(-p.x, p.y, p.z)]));
const RIGHT = mirror(LEFT);

// Model-space point → grip space through the returned transform.
function toGrip(align, p) {
  return p.clone().multiplyScalar(align.scale).applyQuaternion(align.quaternion).add(align.position);
}
function dirToGrip(align, d) {
  return d.clone().applyQuaternion(align.quaternion).normalize();
}

describe('handModelFor', () => {
  test('maps WebXR handedness to the model side', () => {
    expect(handModelFor('left')).toBe('l');
    expect(handModelFor('right')).toBe('r');
  });
  test('no hand for unknown / missing handedness', () => {
    expect(handModelFor(null)).toBeNull();
    expect(handModelFor('none')).toBeNull();
  });
});

describe('computeGripAlign — WebXR gripSpace contract', () => {
  for (const [hand, j] of [['left', LEFT], ['right', RIGHT]]) {
    describe(hand, () => {
      const a = computeGripAlign(j, hand);
      const palmCtr = j.index1.clone().add(j.middle1).add(j.ring1).add(j.pinky1).multiplyScalar(0.25);

      test('uses the centimetre → metre scale', () => {
        expect(a.scale).toBe(HAND_MODEL_SCALE);
      });

      test('-Z runs along the knuckles toward the thumb (index side)', () => {
        const d = dirToGrip(a, j.index1.clone().sub(j.pinky1));
        expect(d.z).toBeLessThan(-0.95);
      });

      test('back of the hand faces +X for the right hand, -X for the left', () => {
        // Finger tips curl toward the palm, so the tip offset points palm-ward.
        const towardPalm = dirToGrip(a, j.middleTip.clone().sub(j.middle1));
        if (hand === 'right') expect(towardPalm.x).toBeLessThan(0);
        else expect(towardPalm.x).toBeGreaterThan(0);
      });

      test('+Y points up the arm (wrist side)', () => {
        const d = dirToGrip(a, j.wrist.clone().sub(j.middle1));
        expect(d.y).toBeGreaterThan(0.9);
      });

      test('fist centroid lands on the real Quest handle (FIST_CENTER_IN_GRIP_CM)', () => {
        // Same construction as the module: knuckle centre, pushed into the
        // palm and back toward the wrist.
        const across = j.index1.clone().sub(j.pinky1).normalize();
        const fwd = j.middle1.clone().sub(j.wrist).normalize();
        const palm = new THREE.Vector3().crossVectors(fwd, across).normalize();
        if (j.middleTip.clone().sub(j.middle1).dot(palm) < 0) palm.negate();
        const fist = palmCtr.clone()
          .addScaledVector(palm, FIST_CENTROID_PALM_CM)
          .addScaledVector(fwd, -FIST_CENTROID_WRIST_CM);
        const g = toGrip(a, fist).multiplyScalar(100);
        const c = FIST_CENTER_IN_GRIP_CM;
        expect(g.x).toBeCloseTo(hand === 'left' ? -c.back : c.back, 5);
        expect(g.y).toBeCloseTo(c.y, 5);
        expect(g.z).toBeCloseTo(c.z, 5);
      });

      test('the hand wraps the handle (+Z of the origin), not the controller head', () => {
        expect(toGrip(a, palmCtr).z).toBeGreaterThan(0);
      });
    });
  }

  test('left and right alignments are mirror images across grip X', () => {
    const l = computeGripAlign(LEFT, 'left');
    const r = computeGripAlign(RIGHT, 'right');
    for (const k of Object.keys(LEFT)) {
      const pl = toGrip(l, LEFT[k]);
      const pr = toGrip(r, RIGHT[k]);
      expect(pr.x).toBeCloseTo(-pl.x, 5);
      expect(pr.y).toBeCloseTo(pl.y, 5);
      expect(pr.z).toBeCloseTo(pl.z, 5);
    }
  });

  test('degenerate joints → null', () => {
    expect(computeGripAlign({ ...LEFT, pinky1: LEFT.index1.clone() }, 'left')).toBeNull();
    expect(computeGripAlign({ ...LEFT, wrist: LEFT.middle1.clone() }, 'left')).toBeNull();
  });
});

describe('curlFromButton', () => {
  test('released / garbage → rest curl', () => {
    expect(curlFromButton(0)).toBe(0);
    expect(curlFromButton(undefined, 0.4)).toBeCloseTo(0.4);
    expect(curlFromButton(NaN, 0.4)).toBeCloseTo(0.4);
    expect(curlFromButton(CURL_DEADZONE, 0.4)).toBeCloseTo(0.4);
  });
  test('fully pressed → 1, clamps above', () => {
    expect(curlFromButton(1, SQUEEZE_REST_CURL)).toBe(1);
    expect(curlFromButton(1.3, SQUEEZE_REST_CURL)).toBe(1);
  });
  test('monotonic between rest and 1', () => {
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const c = curlFromButton(x, SQUEEZE_REST_CURL);
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c).toBeGreaterThanOrEqual(SQUEEZE_REST_CURL);
      expect(c).toBeLessThanOrEqual(1);
      prev = c;
    }
  });
});

describe('stepCurl', () => {
  test('converges without overshoot and lands exactly', () => {
    let c = 0;
    for (let i = 0; i < 30; i++) {
      const next = stepCurl(c, 1, 1 / 72);
      expect(next).toBeGreaterThanOrEqual(c);
      expect(next).toBeLessThanOrEqual(1);
      c = next;
    }
    expect(c).toBe(1);
  });
  test('closes visibly within ~3 frames at 72 Hz', () => {
    let c = 0;
    for (let i = 0; i < 3; i++) c = stepCurl(c, 1, 1 / 72);
    expect(c).toBeGreaterThan(0.9);
  });
  test('frame-rate independent', () => {
    let a = 0, b = 0;
    for (let i = 0; i < 2; i++) a = stepCurl(a, 1, 0.005);
    b = stepCurl(b, 1, 0.01);
    expect(a).toBeCloseTo(b, 6);
  });
  test('zero / bad dt is a no-op', () => {
    expect(stepCurl(0.3, 1, 0)).toBe(0.3);
    expect(stepCurl(0.3, 1, NaN)).toBe(0.3);
  });
});

describe('shouldShowOffHand', () => {
  const tracked = () => {
    const g = new THREE.Object3D();
    g.position.set(0.2, 1.1, 0.4);
    g.updateMatrixWorld();
    return g;
  };
  const ctrl = { gamepad: { buttons: [] } };

  test('tracked controller grip → shown', () => {
    expect(shouldShowOffHand(tracked(), ctrl)).toBe(true);
  });
  test('no grip / no source → hidden', () => {
    expect(shouldShowOffHand(null, ctrl)).toBe(false);
    expect(shouldShowOffHand(tracked(), null)).toBe(false);
  });
  test('bare tracked hand (no gamepad, has hand) → hidden', () => {
    expect(shouldShowOffHand(tracked(), { hand: {} })).toBe(false);
    expect(shouldShowOffHand(tracked(), { gamepad: {}, hand: {} })).toBe(false);
  });
  test('grip hidden by three.js (pose lost) → hidden', () => {
    const g = tracked();
    g.visible = false;
    expect(shouldShowOffHand(g, ctrl)).toBe(false);
  });
  test('never-posed grip at the origin → hidden', () => {
    const g = new THREE.Object3D();
    g.updateMatrixWorld();
    expect(shouldShowOffHand(g, ctrl)).toBe(false);
  });
});
