// P13 spec §C7 — tracking-loss guard.
//
// Verifies the 100 ms freeze window: emulated pose → freeze this frame,
// contact suppressed for 100 ms after; clean pose → guard clears.

import {
  update, shouldFreezePaddle, shouldSuppressContact, _resetForTests, _wasPoseValidThisFrame,
} from '../js/xr/trackingLossGuard.js';

function fakeFrame(poseResult) {
  return {
    getPose: (_gripSpace, _refSpace) => poseResult,
  };
}
function fakeInputSource() {
  return { gripSpace: {} };
}
const fakeRefSpace = {};

describe('trackingLossGuard', () => {
  beforeEach(() => _resetForTests());

  test('non-XR frame args → not frozen, no contact suppression', () => {
    update(null, null, null);
    expect(shouldFreezePaddle()).toBe(false);
    expect(shouldSuppressContact()).toBe(false);
  });

  test('clean pose (emulatedPosition=false) → not frozen', () => {
    update(fakeFrame({ emulatedPosition: false }), fakeInputSource(), fakeRefSpace);
    expect(shouldFreezePaddle()).toBe(false);
    expect(_wasPoseValidThisFrame()).toBe(true);
  });

  test('emulated pose → freeze this frame AND suppress contact', () => {
    update(fakeFrame({ emulatedPosition: true }), fakeInputSource(), fakeRefSpace);
    expect(shouldFreezePaddle()).toBe(true);
    expect(shouldSuppressContact()).toBe(true);
  });

  test('null pose → freeze (tracker dropped)', () => {
    update(fakeFrame(null), fakeInputSource(), fakeRefSpace);
    expect(shouldFreezePaddle()).toBe(true);
    expect(shouldSuppressContact()).toBe(true);
  });

  test('getPose throws → freeze', () => {
    const throwingFrame = { getPose: () => { throw new Error('nope'); } };
    update(throwingFrame, fakeInputSource(), fakeRefSpace);
    expect(shouldFreezePaddle()).toBe(true);
    expect(shouldSuppressContact()).toBe(true);
  });

  test('contact suppression window closes ~100 ms after last emulated frame', async () => {
    update(fakeFrame({ emulatedPosition: true }), fakeInputSource(), fakeRefSpace);
    expect(shouldSuppressContact()).toBe(true);

    // Advance one clean frame — freeze should clear THIS frame but suppress
    // stays true until the 100 ms window elapses.
    update(fakeFrame({ emulatedPosition: false }), fakeInputSource(), fakeRefSpace);
    expect(shouldFreezePaddle()).toBe(false);
    expect(shouldSuppressContact()).toBe(true);

    // Wait past the window.
    await new Promise((r) => setTimeout(r, 130));
    // shouldSuppressContact reads performance.now() directly — no need to call
    // update() first, though a real loop would.
    expect(shouldSuppressContact()).toBe(false);
  });
});
