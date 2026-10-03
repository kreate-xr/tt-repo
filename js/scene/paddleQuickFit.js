// Quick Fit — the one-screen paddle calibration for a bare controller.
//
// The two-pose wizard (calibrationWizard.js) and the 6-row ± stepper panel
// (calibrationTuner.js) are precise but hard: four screens of poses, or
// reasoning about Pitch/Roll/Yaw in 0.5° presses. With a bare controller there
// is no real blade to register against — "calibrated" means the bat sits where
// the player expects — so this panel lets them SEE and FEEL it instead:
//
//   paddle-hand stick ←/→   face angle      (roll about the handle)
//   paddle-hand stick ↑/↓   bat angle       (tilt vs. the controller)
//   other-hand  stick ↑/↓   blade distance  (slide along the handle)
//
// The paddle moves live while the stick is held (setCalibration persist:false,
// so no localStorage write per frame); Done / A-X / any close commits.
// Knobs are layered on the measured 'handle_grip' fit via paddleAdjust.js and
// always rebuilt from base + knobs, never accumulated onto the live pose.
//
// Same host surface as MultiplayerMenu / CalibrationTuner (mesh, show, hide,
// isVisible, on, emit, hitTestUV, setHovered, selectHovered) so inGame.js's
// currentTuner machinery drives it unchanged. Scene-free apart from the mesh:
// inGame.js adds it to the scene.

import * as THREE from 'three';
import { playMenuHoverTick, playMenuSelectClick } from './audio.js';
import * as haptics from '../xr/haptics.js';
import { Panel } from './panelKit.js';
import { COLORS, F, roundRect } from './panelStyle.js';
import {
  getPosOffset, getRotOffset, getPresetName, getAdjust,
  setCalibration, setPreset, commitCalibration, isUncommitted,
  QUICK_FIT_PRESET, QUICK_FIT_BASE,
} from '../xr/calibration.js';
import { PRESETS, getPresetCopy } from '../xr/calibrationPresets.js';
import { applyAdjust, stepAdjust, zeroAdjust, isZeroAdjust } from '../xr/paddleAdjust.js';

const CANVAS_W = 640;
const CANVAS_H = 720;
export const PLANE_W = 0.36;
export const PLANE_H = PLANE_W * (CANVAS_H / CANVAS_W);

// Readout redraw cap while a stick is held. The pose itself updates every
// frame; re-uploading a 640×720 canvas texture at 72–90 Hz buys nothing.
const REDRAW_INTERVAL_S = 0.1;

const PAD = 32;
const BTN_H = 64;
const GAP = 14;

export class PaddleQuickFit {
  constructor() {
    this.panel = new Panel({ width: CANVAS_W, height: CANVAS_H });
    this.listeners = new Map();

    // Base T_cal the knobs are layered on, and whether it is the measured
    // fit (→ result saves as quick_fit, knobs remembered) or some other
    // custom/preset fit (→ result saves as 'custom').
    this.base = { posOffset: new THREE.Vector3(), rotOffset: new THREE.Quaternion() };
    this.onMeasured = false;
    this.adjust = zeroAdjust();
    this._scratch = { posOffset: new THREE.Vector3(), rotOffset: new THREE.Quaternion() };
    this._redrawTimer = 0;
    this._readoutDirty = false;

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

    const material = new THREE.MeshBasicMaterial({
      map: this.texture, side: THREE.DoubleSide, transparent: true, depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H), material);
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    this._layout();
  }

  // --- host interface ---------------------------------------------------------

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      try { fn(payload); } catch (e) { console.error(`quick fit handler "${event}" threw:`, e); }
    }
  }

  show() {
    this._seedFromCalibration();
    this.mesh.visible = true;
    this.panel.show();
    this.draw();
  }

  // Every close path (Done, A/X → 'back', hand-off to the wizard/tuner)
  // goes through hide(), so committing here means a live edit can never be
  // left applied-but-unsaved.
  hide() {
    if (isUncommitted()) commitCalibration();
    this.mesh.visible = false;
    this.panel.hide();
  }

  isVisible() { return this.mesh.visible; }

  hitTestUV(u, v) { return this.panel.hitTestUV(u, v); }

  setHovered(id) {
    if (this.panel.hoveredId === id) return;
    this.panel.hoveredId = id;
    if (id != null) {
      try { playMenuHoverTick(); } catch (e) { /* audio optional */ }
      haptics.pulseActive(0.15, 15);
    }
    this.draw();
  }

  selectHovered() {
    const id = this.panel.hoveredId;
    if (!id) return false;
    try { playMenuSelectClick(); } catch (e) { /* audio optional */ }
    haptics.pulseActive(0.3, 25);
    this.handle(id);
    return true;
  }

  dispose() {
    if (this.texture) this.texture.dispose();
    if (this.mesh) {
      if (this.mesh.geometry) this.mesh.geometry.dispose();
      if (this.mesh.material) this.mesh.material.dispose();
    }
    this.listeners.clear();
  }

  // --- input ----------------------------------------------------------------

  handle(id) {
    if (id === 'done') { this.emit('back'); return; }
    if (id === 'reset') { this.reset(); return; }
    if (id === 'wizard') { this.emit('wizard'); return; }
    if (id === 'fineTune') { this.emit('fineTune'); return; }
  }

  /**
   * Per-frame thumbstick feed from inGame.js (Gamepad axes, −1 = left/up).
   * Applies T_cal live without persisting; returns true if anything moved.
   */
  applyStick(faceStickX, batStickY, slideStickY, dt) {
    if (!this.mesh.visible) return false;
    if (!stepAdjust(this.adjust, faceStickX, batStickY, slideStickY, dt)) return false;
    this._apply(false);
    this._readoutDirty = true;
    this._redrawTimer += dt;
    if (this._redrawTimer >= REDRAW_INTERVAL_S) {
      this._redrawTimer = 0;
      this._readoutDirty = false;
      this.draw();
    }
    return true;
  }

  // Flush the throttled readout once the stick is released.
  update(dt) {
    if (!this._readoutDirty) return;
    this._redrawTimer += dt;
    if (this._redrawTimer >= REDRAW_INTERVAL_S) {
      this._redrawTimer = 0;
      this._readoutDirty = false;
      this.draw();
    }
  }

  // Back to the measured fit (the first-launch default), knobs zeroed.
  reset() {
    setPreset(PRESETS[QUICK_FIT_BASE] ? QUICK_FIT_BASE : 'default');
    this._seedFromCalibration();
    this.draw();
  }

  // --- internal ---------------------------------------------------------------

  _seedFromCalibration() {
    const name = getPresetName();
    const measured = PRESETS[QUICK_FIT_BASE];
    const adj = getAdjust();
    if (measured && name === QUICK_FIT_PRESET && adj) {
      this._setBase(getPresetCopy(QUICK_FIT_BASE), true);
      this.adjust = { ...adj };
    } else if (measured && name === QUICK_FIT_BASE) {
      this._setBase(getPresetCopy(QUICK_FIT_BASE), true);
      this.adjust = zeroAdjust();
    } else {
      // Wizard/tuner/preset fit: adjust relative to what the player has now,
      // rather than snapping the bat to the measured fit on open.
      this._setBase({ posOffset: getPosOffset(), rotOffset: getRotOffset() }, false);
      this.adjust = zeroAdjust();
    }
    this._redrawTimer = 0;
    this._readoutDirty = false;
  }

  _setBase({ posOffset, rotOffset }, onMeasured) {
    this.base.posOffset.copy(posOffset);
    this.base.rotOffset.copy(rotOffset);
    this.onMeasured = onMeasured;
  }

  _apply(persist) {
    const res = applyAdjust(this.base, this.adjust, this._scratch);
    if (this.onMeasured) {
      const zero = isZeroAdjust(this.adjust);
      setCalibration({
        posOffset: res.posOffset,
        rotOffset: res.rotOffset,
        presetName: zero ? QUICK_FIT_BASE : QUICK_FIT_PRESET,
        adjust: zero ? null : this.adjust,
        persist,
      });
    } else {
      setCalibration({
        posOffset: res.posOffset, rotOffset: res.rotOffset, presetName: 'custom', persist,
      });
    }
  }

  _layout() {
    const p = this.panel;
    p.clear();
    const w = CANVAS_W - 2 * PAD;
    const half = (w - GAP) / 2;
    let y = CANVAS_H - PAD - 2 * BTN_H - GAP;
    p.add({ id: 'done', kind: 'button', label: 'DONE', accent: true, x: PAD, y, w: half, h: BTN_H });
    p.add({ id: 'reset', kind: 'button', label: 'RESET', x: PAD + half + GAP, y, w: half, h: BTN_H });
    y += BTN_H + GAP;
    p.add({ id: 'wizard', kind: 'button', label: 'Precise 2-pose fit', x: PAD, y, w: half, h: BTN_H });
    p.add({ id: 'fineTune', kind: 'button', label: 'Number fine-tune', x: PAD + half + GAP, y, w: half, h: BTN_H });
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 28);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.accent;
    ctx.font = F(800, 30);
    ctx.fillText('PADDLE FIT', CANVAS_W / 2, 50);
    ctx.fillStyle = COLORS.muted;
    ctx.font = F(600, 18);
    ctx.fillText('Hold the controller like your bat. Use the sticks —', CANVAS_W / 2, 92);
    ctx.fillText('the paddle moves live.', CANVAS_W / 2, 116);

    const a = this.adjust;
    this._drawRow(160, 'Face angle', 'Paddle-hand stick  ◀ ▶', `${_signed(a.faceDeg, 0)}°`);
    this._drawRow(250, 'Bat angle', 'Paddle-hand stick  ▲ ▼', `${_signed(a.batDeg, 0)}°`);
    this._drawRow(340, 'Blade distance', 'Other-hand stick  ▲ ▼', `${_signed(a.slideM * 100, 1)} cm`);

    if (!this.onMeasured) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = F(600, 16);
      ctx.textAlign = 'center';
      ctx.fillText('Adjusting your current custom fit. RESET returns to the measured fit.', CANVAS_W / 2, 440, CANVAS_W - 2 * PAD);
    }

    for (const w of this.panel.widgets) this._drawButton(w);
    this.texture.needsUpdate = true;
  }

  _drawRow(y, label, hint, value) {
    const ctx = this.ctx;
    roundRect(ctx, PAD, y, CANVAS_W - 2 * PAD, 76, 14);
    ctx.fillStyle = COLORS.panel;
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = F(700, 22);
    ctx.fillText(label, PAD + 20, y + 26);
    ctx.fillStyle = COLORS.muted;
    ctx.font = F(600, 15);
    ctx.fillText(hint, PAD + 20, y + 54);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.accentBright;
    ctx.font = F(800, 28);
    ctx.fillText(value, CANVAS_W - PAD - 20, y + 38);
  }

  _drawButton(w) {
    const ctx = this.ctx;
    const hovered = this.panel.hoveredId === w.id;
    roundRect(ctx, w.x, w.y, w.w, w.h, 16);
    ctx.fillStyle = hovered ? COLORS.panelHover : COLORS.panel;
    ctx.fill();
    if (w.accent) {
      roundRect(ctx, w.x, w.y, w.w, w.h, 16);
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = w.accent ? COLORS.accentBright : COLORS.text;
    ctx.font = F(700, 20);
    ctx.fillText(w.label, w.x + w.w / 2, w.y + w.h / 2 + 1, w.w - 18);
  }
}

function _signed(v, digits) {
  const s = v.toFixed(digits);
  // "-0" / "-0.0" after rounding reads as a bug in a live readout.
  if (Number(s) === 0) return (0).toFixed(digits);
  return v > 0 ? '+' + s : s;
}
