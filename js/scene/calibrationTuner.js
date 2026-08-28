// P13 spec §C4 — manual calibration tuner. Fine-adjust T_cal via 6 knobs:
// posOffset x/y/z (±0.25 m step 0.001) + pitch/roll/yaw (±180° step 0.5°).
//
// Matches the WristMenu / PhysicsTuner / CalibrationWizard panel interface
// (mesh, hitTestUV, setHovered, selectHovered, show/hide/isVisible, on) so
// inGame.js activePanel() routing accepts it without branching.
//
// Rotation UI: rotOffset is stored as a quaternion in calibration.js, but
// this panel exposes Euler XYZ (pitch, roll, yaw) in degrees because that's
// what a player can reason about. We hold Euler as UI state so successive
// stepper presses don't accumulate quat→euler→quat conversion drift.
// On show() we (re-)seed Euler from the current rotOffset quaternion; on
// any stepper press we recompute the quaternion from Euler and push.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import {
  getPosOffset, getRotOffset, setPosOffset, setRotOffset, subscribe as subscribeCalibration,
} from '../xr/calibration.js';

const CANVAS_W = 640;
const CANVAS_H = 780;
const PLANE_W = 0.34;
const PLANE_H = PLANE_W * (CANVAS_H / CANVAS_W);

const COLORS = {
  bg:        '#0a0e18',
  border:    '#00ff88',
  title:     '#00ff88',
  rowLabel:  '#e6edf5',
  rowValue:  '#00ff88',
  rowDesc:   '#7aa6c4',
  stepperBg: '#1a2030',
  stepperFg: '#e6edf5',
  hoverBg:   '#00ff88',
  hoverFg:   '#0a0e18',
  backBorder:'rgba(255,80,80,0.6)',
  backText:  '#ff8888',
};

const POS_MIN = -0.25, POS_MAX = 0.25;
const ROT_MIN = -180, ROT_MAX = 180;

export class CalibrationTuner {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = 16;

    const geometry = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);

    // Euler UI state — seeded on show() from the live rotOffset quaternion.
    this.eulerDeg = { x: 0, y: 0, z: 0 };
    // Position UI state mirrors calibration.posOffset directly (no conversion).
    this.posM = { x: 0, y: 0, z: 0 };

    this.hovered = null;
    this.buttons = [];
    this.listeners = { back: [] };

    // Redraw if calibration changes externally (e.g., wizard applies while
    // tuner is open).
    this._unsub = subscribeCalibration(() => {
      if (this.mesh.visible) {
        this._syncFromCalibration();
        this.draw();
      }
    });

    this._buildKnobs();
    this.layoutButtons();
  }

  _buildKnobs() {
    this.KNOBS = [
      {
        id: 'posX', label: 'Pos X (m)',
        desc: 'Blade offset LEFT/RIGHT of the grip along its local X axis.',
        get: () => this.posM.x, set: (v) => this._setPos('x', v),
        step: 0.001, fmt: (v) => v.toFixed(3), min: POS_MIN, max: POS_MAX,
      },
      {
        id: 'posY', label: 'Pos Y (m)',
        desc: 'Blade offset UP/DOWN of the grip along its local Y axis.',
        get: () => this.posM.y, set: (v) => this._setPos('y', v),
        step: 0.001, fmt: (v) => v.toFixed(3), min: POS_MIN, max: POS_MAX,
      },
      {
        id: 'posZ', label: 'Pos Z (m)',
        desc: 'Slides paddle along the handle: + = down (butt out), − = blade further out.',
        get: () => this.posM.z, set: (v) => this._setPos('z', v),
        step: 0.001, fmt: (v) => v.toFixed(3), min: POS_MIN, max: POS_MAX,
      },
      {
        id: 'pitch', label: 'Pitch (°)',
        desc: 'Blade face tilt UP/DOWN. Dominant grip variable — start here.',
        get: () => this.eulerDeg.x, set: (v) => this._setEuler('x', v),
        step: 0.5, fmt: (v) => v.toFixed(1), min: ROT_MIN, max: ROT_MAX,
      },
      {
        id: 'roll', label: 'Roll (°)',
        desc: 'Blade twist about the handle axis. Distinguishes shakehand vs penhold.',
        get: () => this.eulerDeg.z, set: (v) => this._setEuler('z', v),
        step: 0.5, fmt: (v) => v.toFixed(1), min: ROT_MIN, max: ROT_MAX,
      },
      {
        id: 'yaw', label: 'Yaw (°)',
        desc: 'Blade face aim LEFT/RIGHT. Usually zero for most grips.',
        get: () => this.eulerDeg.y, set: (v) => this._setEuler('y', v),
        step: 0.5, fmt: (v) => v.toFixed(1), min: ROT_MIN, max: ROT_MAX,
      },
    ];
  }

  layoutButtons() {
    this.buttons.length = 0;
    const padX = 24;
    const titleH = 56;
    const rowH = 82;
    const stepperW = 64;
    const stepperH = 46;

    let y = titleH + 24;
    for (let i = 0; i < this.KNOBS.length; i++) {
      const k = this.KNOBS[i];
      this.buttons.push({
        id: 'm-' + k.id, kind: 'minus', knob: k,
        x: padX, y, w: stepperW, h: stepperH,
      });
      this.buttons.push({
        id: 'p-' + k.id, kind: 'plus', knob: k,
        x: CANVAS_W - padX - stepperW, y, w: stepperW, h: stepperH,
      });
      y += rowH;
    }

    this.buttons.push({
      id: 'back', kind: 'back',
      x: padX, y: CANVAS_H - 64, w: CANVAS_W - 2 * padX, h: 48,
    });
  }

  show() {
    this._syncFromCalibration();
    this.mesh.visible = true;
    this.draw();
  }
  hide() { this.mesh.visible = false; this.hovered = null; }
  isVisible() { return this.mesh.visible; }

  on(event, fn) { if (this.listeners[event]) this.listeners[event].push(fn); }
  emit(event, payload) {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const fn of arr) fn(payload);
  }

  draw() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_W - 4, CANVAS_H - 4);

    ctx.fillStyle = COLORS.title;
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Paddle Fine-Tune', CANVAS_W / 2, 36);

    for (const k of this.KNOBS) this.drawRow(k);
    for (const b of this.buttons) this.drawButton(b);

    this.texture.needsUpdate = true;
  }

  drawRow(knob) {
    const ctx = this.ctx;
    const ref = this.buttons.find((b) => b.kind === 'minus' && b.knob === knob);
    if (!ref) return;
    const rowMidY = ref.y + ref.h / 2;

    ctx.fillStyle = COLORS.rowLabel;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(knob.label, ref.x + ref.w + 16, rowMidY);

    ctx.fillStyle = COLORS.rowValue;
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(knob.fmt(knob.get()), CANVAS_W - ref.x - ref.w - 16, rowMidY);

    ctx.fillStyle = COLORS.rowDesc;
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(knob.desc, ref.x, ref.y + ref.h + 4);
  }

  drawButton(b) {
    const ctx = this.ctx;
    const isHovered = this.hovered === b.id;

    let bg = COLORS.stepperBg;
    let fg = COLORS.stepperFg;
    if (b.kind === 'back') { bg = COLORS.bg; fg = COLORS.backText; }
    if (isHovered) { bg = COLORS.hoverBg; fg = COLORS.hoverFg; }

    ctx.fillStyle = bg;
    ctx.fillRect(b.x, b.y, b.w, b.h);

    if (b.kind === 'back') {
      ctx.strokeStyle = COLORS.backBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }

    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (b.kind === 'minus') {
      ctx.font = 'bold 34px sans-serif';
      ctx.fillText('−', b.x + b.w / 2, b.y + b.h / 2);
    } else if (b.kind === 'plus') {
      ctx.font = 'bold 34px sans-serif';
      ctx.fillText('+', b.x + b.w / 2, b.y + b.h / 2);
    } else if (b.kind === 'back') {
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('Back to Menu', b.x + b.w / 2, b.y + b.h / 2);
    }
  }

  hitTestUV(u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const px = u * CANVAS_W;
    const py = (1 - v) * CANVAS_H;
    for (const b of this.buttons) {
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
        return b.id;
      }
    }
    return null;
  }

  setHovered(id) {
    if (this.hovered === id) return;
    this.hovered = id;
    this.draw();
  }

  selectHovered() {
    if (!this.hovered) return false;
    const button = this.buttons.find((b) => b.id === this.hovered);
    if (!button) return false;
    this.activate(button);
    return true;
  }

  activate(button) {
    if (button.kind === 'back') { this.emit('back'); return; }
    if (button.kind === 'minus' || button.kind === 'plus') {
      const sign = button.kind === 'plus' ? 1 : -1;
      const k = button.knob;
      let next = k.get() + sign * k.step;
      if (typeof k.min === 'number') next = Math.max(k.min, next);
      if (typeof k.max === 'number') next = Math.min(k.max, next);
      k.set(next);
      this.draw();
    }
  }

  // --- internal ---

  _syncFromCalibration() {
    const p = getPosOffset();
    this.posM.x = p.x; this.posM.y = p.y; this.posM.z = p.z;
    // Convert quaternion → Euler XYZ in degrees for the UI. Using XYZ order
    // means the pitch (X) slider maps to the dominant grip variable per spec
    // §C4 ("UI order: pitch first").
    const e = new THREE.Euler().setFromQuaternion(getRotOffset(), 'XYZ');
    this.eulerDeg.x = (e.x * 180) / Math.PI;
    this.eulerDeg.y = (e.y * 180) / Math.PI;
    this.eulerDeg.z = (e.z * 180) / Math.PI;
  }

  _setPos(axis, value) {
    this.posM[axis] = value;
    const v = new THREE.Vector3(this.posM.x, this.posM.y, this.posM.z);
    setPosOffset(v);  // triggers filter flush + persist via calibration.onChange
  }

  _setEuler(axis, deg) {
    this.eulerDeg[axis] = deg;
    const e = new THREE.Euler(
      (this.eulerDeg.x * Math.PI) / 180,
      (this.eulerDeg.y * Math.PI) / 180,
      (this.eulerDeg.z * Math.PI) / 180,
      'XYZ',
    );
    const q = new THREE.Quaternion().setFromEuler(e);
    setRotOffset(q);
  }

  dispose() {
    if (this._unsub) this._unsub();
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.listeners.back.length = 0;
  }
}
