// Virtual off-hand scene module: binds the right rig to the off-hand grip,
// follows hand switches, hides when untracked, drives finger bones from the
// controller buttons, and survives a failed load.

const THREE = require('three');

// GLTFLoader is pure ESM; the module only touches it through the default
// `load` seam, which these tests replace.
jest.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({ GLTFLoader: class {} }));

import { createOffHand } from '../js/scene/offHand.js';

const FINGERS = ['thumb', 'index', 'middle', 'ring'];

// Minimal stand-in for the GLB scene: a mesh plus the named bones offHand.js
// reads. Joint positions are the real left rig's (cm); the right rig is its
// X mirror.
const JOINTS_L = {
  hand: [1.77, 4.90, -7.17],
  index1: [0.45, 5.16, 2.15], middle1: [2.91, 6.06, 1.94],
  ring1: [5.15, 5.60, 1.19], pinky1: [7.06, 4.58, 0.11],
  middle_ignore: [4.79, 1.93, 10.66],
};
function fakeRig(side) {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  const mk = (name, pos) => {
    const b = new THREE.Bone();
    b.name = `hands_b_${side}_${name}`;
    if (pos) b.position.set(side === 'r' ? -pos[0] : pos[0], pos[1], pos[2]);
    root.add(b);
    return b;
  };
  for (const [n, p] of Object.entries(JOINTS_L)) mk(n, p);
  for (const f of FINGERS) for (const i of [1, 2, 3]) if (!JOINTS_L[`${f}${i}`]) mk(`${f}${i}`);
  for (const i of [1, 2, 3]) if (!JOINTS_L[`pinky${i}`]) mk(`pinky${i}`);
  return root;
}

function makeXR() {
  const grips = { left: new THREE.Object3D(), right: new THREE.Object3D() };
  grips.left.position.set(-0.2, 1.1, 0.3);
  grips.right.position.set(0.2, 1.1, 0.3);
  const state = { off: 'left', squeeze: 0, trigger: 0, gone: false };
  const src = () => ({ gamepad: { buttons: [{ value: state.trigger }, { value: state.squeeze }] } });
  return {
    grips, state,
    getOffHandGrip: () => (state.gone ? null : grips[state.off]),
    getOffHandHandedness: () => state.off,
    getOffHandInputSource: () => (state.gone ? null : src()),
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const bone = (oh, side, name) => oh._rigs[side].root.getObjectByName(`hands_b_${side}_${name}`);

async function setup() {
  const xr = makeXR();
  const oh = createOffHand({ xr, load: (side) => Promise.resolve(fakeRig(side)) });
  await flush(); await flush();
  return { xr, oh };
}

test('binds the matching rig under the off-hand grip and shows it', async () => {
  const { xr, oh } = await setup();
  oh.update(1 / 72);
  expect(oh._rigs.l.root.parent).toBe(xr.grips.left);
  expect(oh._rigs.l.root.visible).toBe(true);
  expect(oh._rigs.r.root.parent).toBeNull();
});

test('hand switch moves to the other grip with the other model', async () => {
  const { xr, oh } = await setup();
  oh.update(1 / 72);
  xr.state.off = 'right';            // player flipped dominant hand
  oh.update(1 / 72);
  expect(oh._rigs.l.root.parent).toBeNull();
  expect(oh._rigs.r.root.parent).toBe(xr.grips.right);
  expect(oh._rigs.r.root.visible).toBe(true);
});

test('hidden when the off-hand controller is gone or untracked', async () => {
  const { xr, oh } = await setup();
  oh.update(1 / 72);
  xr.state.gone = true;
  oh.update(1 / 72);
  expect(oh._rigs.l.root.visible).toBe(false);

  xr.state.gone = false;
  xr.grips.left.position.set(0, 0, 0);   // never posed
  oh.update(1 / 72);
  expect(oh._rigs.l.root.visible).toBe(false);
});

test('squeeze curls middle/ring/pinky, trigger curls the index', async () => {
  const { xr, oh } = await setup();
  for (let i = 0; i < 20; i++) oh.update(1 / 72);
  const mid0 = bone(oh, 'l', 'middle2').quaternion.clone();
  const idx0 = bone(oh, 'l', 'index2').quaternion.clone();

  xr.state.squeeze = 1;
  for (let i = 0; i < 20; i++) oh.update(1 / 72);
  expect(bone(oh, 'l', 'middle2').quaternion.angleTo(mid0)).toBeGreaterThan(0.2);
  expect(bone(oh, 'l', 'index2').quaternion.angleTo(idx0)).toBeLessThan(1e-6);

  xr.state.trigger = 1;
  for (let i = 0; i < 20; i++) oh.update(1 / 72);
  expect(bone(oh, 'l', 'index2').quaternion.angleTo(idx0)).toBeGreaterThan(0.2);

  // Release returns to the resting pose.
  xr.state.squeeze = 0; xr.state.trigger = 0;
  for (let i = 0; i < 40; i++) oh.update(1 / 72);
  expect(bone(oh, 'l', 'middle2').quaternion.angleTo(mid0)).toBeLessThan(1e-3);
});

test('load failure leaves the hand off without throwing', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const xr = makeXR();
  const oh = createOffHand({ xr, load: () => Promise.reject(new Error('404')) });
  await flush(); await flush();
  expect(() => oh.update(1 / 72)).not.toThrow();
  expect(xr.grips.left.children.length).toBe(0);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test('dispose detaches from the grip (grips outlive the session)', async () => {
  const { xr, oh } = await setup();
  oh.update(1 / 72);
  oh.dispose();
  expect(xr.grips.left.children.length).toBe(0);
  expect(() => oh.update(1 / 72)).not.toThrow();
});

test('a rebuilt rig measures from rest even if left curled', async () => {
  const xr = makeXR();
  const scene = fakeRig('l');
  const load = (side) => Promise.resolve(side === 'l' ? scene : fakeRig(side));
  const a = createOffHand({ xr, load });
  await flush(); await flush();
  xr.state.squeeze = 1;
  for (let i = 0; i < 20; i++) a.update(1 / 72);
  const curled = a._rigs.l.root.position.clone();
  a.dispose();

  // Next session reuses the same cached scene object.
  const b = createOffHand({ xr, load });
  await flush(); await flush();
  expect(b._rigs.l.root.position.distanceTo(curled)).toBeLessThan(1e-9);
  expect(bone(b, 'l', 'middle2').quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9);
});
