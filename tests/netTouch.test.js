// Net-assembly touch watcher (js/scene/netTouch.js) — ITTF Law 2.10.
//
// The interesting behaviour isn't the distance test, it's the latch: one
// physical touch must produce exactly one fault, and a blade resting on the
// cord must not machine-gun faults at 90Hz.

import {
  createNetTouchWatcher,
  distanceToBox,
  NET_TOUCH_MARGIN_M,
  NET_RELEASE_MARGIN_M,
} from '../js/scene/netTouch.js';

// Net spanning the table width, sitting on the surface.
const NET_BOX = {
  min: { x: -0.7625, y: 0, z: -0.01 },
  max: { x: 0.7625, y: 0.1525, z: 0.01 },
};

// Straight out from the net face along +Z, at net height.
const at = (z) => ({ x: 0, y: 0.08, z });

function makeWatcher(probeRef) {
  return createNetTouchWatcher({
    getProbe: () => probeRef.value,
    getNetBox: () => NET_BOX,
  });
}

describe('distanceToBox', () => {
  test('is zero inside the box and euclidean outside', () => {
    expect(distanceToBox({ x: 0, y: 0.05, z: 0 }, NET_BOX)).toBe(0);
    expect(distanceToBox({ x: 0, y: 0.08, z: 0.21 }, NET_BOX)).toBeCloseTo(0.2, 5);
    // Diagonal: clear of both the top and the face.
    expect(distanceToBox({ x: 0, y: 0.2525, z: 0.11 }, NET_BOX)).toBeCloseTo(Math.hypot(0.1, 0.1), 5);
  });

  test('missing geometry is infinitely far, never a touch', () => {
    expect(distanceToBox(null, NET_BOX)).toBe(Infinity);
    expect(distanceToBox(at(0), null)).toBe(Infinity);
  });
});

describe('createNetTouchWatcher', () => {
  test('fires once when the paddle reaches the net, not every frame', () => {
    const probe = { value: at(0.5) };
    const w = makeWatcher(probe);
    expect(w.update()).toBe(false);

    probe.value = at(0.01 + NET_TOUCH_MARGIN_M - 0.01); // inside touch margin
    expect(w.update()).toBe(true);
    // Held against the net — still one touch, not a stream of them.
    expect(w.update()).toBe(false);
    expect(w.update()).toBe(false);
  });

  test('a second touch needs the paddle to actually clear the net first', () => {
    const probe = { value: at(0.02) };
    const w = makeWatcher(probe);
    expect(w.update()).toBe(true);

    // Jitter back out past the touch margin but INSIDE the release margin —
    // this is boundary chatter, not a new touch.
    probe.value = at(0.01 + NET_TOUCH_MARGIN_M + 0.01);
    expect(w.update()).toBe(false);
    probe.value = at(0.02);
    expect(w.update()).toBe(false);

    // Genuinely clear, then come back: that's a new touch.
    probe.value = at(0.01 + NET_RELEASE_MARGIN_M + 0.02);
    expect(w.update()).toBe(false);
    expect(w.isLatched()).toBe(false);
    probe.value = at(0.02);
    expect(w.update()).toBe(true);
  });

  test('an untracked controller at the world origin is not a touch', () => {
    // The origin sits inside the net box, so without this guard every
    // tracking dropout would call a fault.
    const probe = { value: { x: 0, y: 0, z: 0 } };
    const w = makeWatcher(probe);
    expect(w.update()).toBe(false);
  });

  test('no probe or no net geometry judges nothing', () => {
    const probe = { value: null };
    const w = makeWatcher(probe);
    expect(w.update()).toBe(false);
    const w2 = createNetTouchWatcher({ getProbe: () => at(0), getNetBox: () => null });
    expect(w2.update()).toBe(false);
  });

  test('a paddle parked on the net does not fire the instant a new rally starts', () => {
    // reset() deliberately preserves the latch: the ball being dead doesn't
    // move the player's hand, and the next serve must not open with a fault
    // they are already committing and cannot see.
    const probe = { value: at(0.02) };
    const w = makeWatcher(probe);
    expect(w.update()).toBe(true);
    w.reset();
    expect(w.update()).toBe(false);
  });
});
