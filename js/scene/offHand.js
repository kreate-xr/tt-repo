// Virtual off-hand — a hand drawn on the serving (non-paddle) controller.
//
// Tester feedback: in MR you see your real arm run into nothing, and with no
// hand on the controller the grip-hold/release serve toss is hard to judge.
// This puts a skinned hand on the off-hand grip, wrapped around the
// controller the way the player's real hand is, and closes the fingers with
// the real GRIP / trigger — so the squeeze that picks up the serve ball is
// visible. The held ball itself is still placed by playerServe.js (just above
// the fist, HOLD_OFFSET_LOCAL); nothing here touches the serve state machine.
//
// The pose math lives in js/xr/offHandPose.js. This module only owns the
// meshes: load, bind to whichever grip is the off-hand this frame, apply the
// curl. The hand is cosmetic — a load failure leaves it off, never the game.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  handModelFor, computeGripAlign, curlFromButton, stepCurl, shouldShowOffHand,
  FINGER_CURL_DEG, THUMB_TUCK_DEG, SQUEEZE_REST_CURL, TRIGGER_REST_CURL,
} from '../xr/offHandPose.js';

const MODEL_URL = { l: 'models/l_hand_skeletal_lowres.glb', r: 'models/r_hand_skeletal_lowres.glb' };
const HANDEDNESS = { l: 'left', r: 'right' };
const TRIGGER_BUTTON_INDEX = 0;   // xr-standard: buttons[0] trigger, [1] squeeze
const SQUEEZE_BUTTON_INDEX = 1;   // same button playerServe.js holds the ball with

// Neutral glove tone rather than a skin colour — reads as "your hand" without
// picking a skin tone for the player. MeshStandardMaterial goes near-black in
// passthrough when the estimated room light is dim (see ballMachineFigure.js),
// so MR gets an emissive floor.
const HAND_COLOR = 0xd4d7dc;
const HAND_EMISSIVE_AR = 0x3a3d42;

const DEG = Math.PI / 180;
const ZAXIS = new THREE.Vector3(0, 0, 1);
const YAXIS = new THREE.Vector3(0, 1, 0);

let sharedLoader = null;
const loadPromises = new Map();   // side -> Promise<gltf.scene>

function loadSide(side) {
  if (!loadPromises.has(side)) {
    if (!sharedLoader) sharedLoader = new GLTFLoader();
    loadPromises.set(side, sharedLoader.loadAsync(MODEL_URL[side]).then(g => g.scene));
  }
  return loadPromises.get(side);
}

// Build one usable rig from a loaded GLB scene: root transform onto grip
// space, per-bone open/closed quaternions, material for the session mode.
function buildRig(side, gltfScene, isAR) {
  const b = (name) => gltfScene.getObjectByName(`hands_b_${side}_${name}`);
  // The parsed scene is cached across sessions, so a previous session's rig
  // may still own it with its fingers left curled. Measure from a clean rest
  // pose in the scene's own frame.
  gltfScene.removeFromParent();
  gltfScene.traverse((o) => {
    if (!o.isBone) return;
    if (o.userData.restQuat) o.quaternion.copy(o.userData.restQuat);
    else o.userData.restQuat = o.quaternion.clone();
  });
  gltfScene.updateMatrixWorld(true);
  const wp = (name) => {
    const o = b(name);
    if (!o) throw new Error(`hand rig missing bone ${name}`);
    return o.getWorldPosition(new THREE.Vector3());
  };
  const align = computeGripAlign({
    wrist: wp('hand'), index1: wp('index1'), middle1: wp('middle1'),
    ring1: wp('ring1'), pinky1: wp('pinky1'), middleTip: wp('middle_ignore'),
  }, HANDEDNESS[side]);
  if (!align) throw new Error('hand rig joints degenerate');

  const root = new THREE.Group();
  root.name = `offHand_${side}`;
  root.add(gltfScene);
  root.position.copy(align.position);
  root.quaternion.copy(align.quaternion);
  root.scale.setScalar(align.scale);
  root.visible = false;

  const material = new THREE.MeshStandardMaterial({
    color: HAND_COLOR,
    roughness: 0.65,
    metalness: 0,
    emissive: isAR ? HAND_EMISSIVE_AR : 0x000000,
  });
  gltfScene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material && o.material.dispose) o.material.dispose();
    o.material = material;
    // Skinned bounds are the rest pose; a curled finger can leave them and
    // pop out of view at the frustum edge. One small hand — not worth it.
    o.frustumCulled = false;
  });

  // [bone, openQuat, closedQuat] per curl group. Rest = open.
  const groups = { squeeze: [], trigger: [] };
  const addChain = (group, names, degs, axis) => {
    names.forEach((n, i) => {
      const bone = b(n);
      if (!bone) return;
      const open = bone.quaternion.clone();
      const closed = open.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, degs[i] * DEG));
      groups[group].push([bone, open, closed]);
    });
  };
  addChain('trigger', ['index1', 'index2', 'index3'], FINGER_CURL_DEG.index, ZAXIS);
  for (const f of ['middle', 'ring', 'pinky']) {
    addChain('squeeze', [`${f}1`, `${f}2`, `${f}3`], FINGER_CURL_DEG[f], ZAXIS);
  }
  addChain('squeeze', ['thumb1', 'thumb2', 'thumb3'], THUMB_TUCK_DEG, YAXIS);

  return { side, root, material, groups };
}

function applyCurl(entries, t) {
  for (let i = 0; i < entries.length; i++) {
    const [bone, open, closed] = entries[i];
    bone.quaternion.slerpQuaternions(open, closed, t);
  }
}

function buttonValue(src, index) {
  const btn = src.gamepad.buttons && src.gamepad.buttons[index];
  if (!btn) return 0;
  // Quest reports analog values; fall back to pressed for digital pads.
  return typeof btn.value === 'number' ? btn.value : (btn.pressed ? 1 : 0);
}

/**
 * @param {object} opts
 *   xr     — setupXRPaddle handle (getOffHandGrip / getOffHandHandedness /
 *            getOffHandInputSource)
 *   isAR   — passthrough session (emissive lift on the material)
 *   load   — test seam: side -> Promise<Object3D>; defaults to the GLB loader
 */
export function createOffHand({ xr, isAR = false, load = loadSide } = {}) {
  const rigs = { l: null, r: null };
  let disposed = false;
  let current = null;        // rig currently parented to a grip
  let squeezeCurl = SQUEEZE_REST_CURL;
  let triggerCurl = TRIGGER_REST_CURL;

  for (const side of ['l', 'r']) {
    Promise.resolve()
      .then(() => load(side))
      .then((gltfScene) => {
        if (disposed) return;
        rigs[side] = buildRig(side, gltfScene, isAR);
      })
      .catch((err) => {
        console.warn(`[offHand] ${side} hand unavailable — off-hand stays hidden:`, err);
      });
  }

  function release() {
    if (!current) return;
    current.root.visible = false;
    if (current.root.parent) current.root.parent.remove(current.root);
    current = null;
  }

  function update(dt) {
    if (disposed || !xr) return;
    const grip = xr.getOffHandGrip ? xr.getOffHandGrip() : null;
    const src = xr.getOffHandInputSource ? xr.getOffHandInputSource() : null;
    const side = handModelFor(xr.getOffHandHandedness ? xr.getOffHandHandedness() : null);
    const rig = side ? rigs[side] : null;
    // three.js refreshes the grip's world matrix at render time; read this
    // frame's pose, not last frame's, for the tracked test.
    if (grip) grip.updateMatrixWorld();

    if (!rig || !shouldShowOffHand(grip, src)) {
      if (current) current.root.visible = false;
      // Unparent on a hand switch so the old rig doesn't ride the new paddle
      // grip; a plain tracking dropout keeps it parented for a cheap return.
      if (current && (current !== rig || current.root.parent !== grip)) release();
      return;
    }

    if (current !== rig || rig.root.parent !== grip) {
      release();
      grip.add(rig.root);
      current = rig;
    }
    rig.root.visible = true;

    squeezeCurl = stepCurl(squeezeCurl, curlFromButton(buttonValue(src, SQUEEZE_BUTTON_INDEX), SQUEEZE_REST_CURL), dt);
    triggerCurl = stepCurl(triggerCurl, curlFromButton(buttonValue(src, TRIGGER_BUTTON_INDEX), TRIGGER_REST_CURL), dt);
    applyCurl(rig.groups.squeeze, squeezeCurl);
    applyCurl(rig.groups.trigger, triggerCurl);
  }

  function dispose() {
    disposed = true;
    // Grips are renderer.xr singletons that outlive the session.
    release();
    for (const side of ['l', 'r']) {
      if (rigs[side]) rigs[side].material.dispose();
      rigs[side] = null;
    }
  }

  return { update, dispose, _rigs: rigs };
}
