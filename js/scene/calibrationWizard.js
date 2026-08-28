// P13 spec §C3 — two-sample calibration wizard, in-headset canvas panel.
//
// State flow: PICK_PRESET → SAMPLE_A → SAMPLE_B → SOLVED → apply/retry.
// Matches the WristMenu / PhysicsTuner interface (mesh, hitTestUV, setHovered,
// selectHovered, show/hide/isVisible, on) so inGame.js activePanel()/
// activePanelMesh() route to it with no branching.
//
// The wizard captures grip quaternions at Confirm time and passes them to
// solveRotOffset. Grip is sampled via a caller-provided callback (sampleGrip)
// so the wizard doesn't couple to xrPaddle.js directly — inGame.js wires the
// callback at construction.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { paddleFaceNormalLocal, paddleFaceOffset } from './models.js';
import { solveRotOffset, sampleIsSteady, SAMPLE_MAX_ANGULAR_SPEED } from '../xr/calibrationSolver.js';
import { setCalibration, setPreset, getPosOffset } from '../xr/calibration.js';
import { PRESETS } from '../xr/calibrationPresets.js';

const CANVAS_W = 720;
const CANVAS_H = 900;
const PLANE_W = 0.36;
const PLANE_H = PLANE_W * (CANVAS_H / CANVAS_W);

const COLORS = {
  bg:        '#0a0e18',
  border:    '#00ff88',
  title:     '#00ff88',
  bodyText:  '#e6edf5',
  hint:      '#7aa6c4',
  errText:   '#ff8888',
  okText:    '#00ff88',
  btnBg:     '#1a2030',
  btnFg:     '#e6edf5',
  btnHoverBg:'#00ff88',
  btnHoverFg:'#0a0e18',
  btnPrimary:'#00ff88',
  btnPrimaryFg:'#0a0e18',
};

// Steps
const STEP_PICK_PRESET = 'pick-preset';
const STEP_SAMPLE_A    = 'sample-a';
const STEP_SAMPLE_B    = 'sample-b';
const STEP_SOLVED      = 'solved';

export class CalibrationWizard {
  /**
   * @param {object} opts
   * @param {(outPos: THREE.Vector3, outQuat: THREE.Quaternion) => boolean} opts.sampleGrip
   *   Fills out pos+quat with the current paddle-hand grip world pose. Returns
   *   true on success, false if no paddle is attached.
   * @param {() => number} opts.getAngularSpeed  Current |ω_grip| in rad/s.
   */
  constructor({ sampleGrip, getAngularSpeed }) {
    this.sampleGrip = sampleGrip;
    this.getAngularSpeed = getAngularSpeed || (() => 0);

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

    // Wizard state.
    this.step = STEP_PICK_PRESET;
    this.chosenPreset = 'default';
    this.qGripA = new THREE.Quaternion();
    this.qGripB = new THREE.Quaternion();
    this.solvedR = null;         // THREE.Quaternion when the wizard is done
    this.transientMessage = null; // { text, color, expiresAt }

    this.hovered = null;
    this.buttons = [];
    this.listeners = { back: [], accepted: [], fineTune: [] };

    this.rebuildForStep();
    this.draw();
  }

  show() {
    this.step = STEP_PICK_PRESET;
    this.chosenPreset = 'default';
    this.solvedR = null;
    this.transientMessage = null;
    this.rebuildForStep();
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

  // Called by the outer loop every frame to expire the transient message.
  // Cheap: only redraws when the message actually clears.
  tick(nowMs) {
    if (this.transientMessage && nowMs > this.transientMessage.expiresAt) {
      this.transientMessage = null;
      this.draw();
    }
  }

  // Redefine the button set for the current step. Physicial layout uses a
  // uniform 2-column footer at the bottom of the canvas plus a wide button
  // strip above it — visually stable across steps so hover targets don't
  // reflow unexpectedly.
  rebuildForStep() {
    this.buttons = [];
    const btnH = 74;
    const gap = 16;
    const padX = 40;
    const footerY = CANVAS_H - 60 - btnH;

    if (this.step === STEP_PICK_PRESET) {
      // Four presets stacked, then a Back button in the footer.
      const btnW = CANVAS_W - padX * 2;
      let y = 300;
      // Only offered once models.js has derived it from the loaded bat's
      // anchors — absent (broken asset), the button is simply not shown
      // rather than silently applying 'default' under the wrong name.
      if (PRESETS.handle_grip) {
        this.buttons.push({
          id: 'preset-handle-grip', label: 'Handle in grip (measured fit)', primary: true,
          x: padX, y, w: btnW, h: btnH,
        });
        y += btnH + gap;
      }
      this.buttons.push({
        id: 'preset-shakehand', label: 'Shakehand grip', primary: !PRESETS.handle_grip,
        x: padX, y, w: btnW, h: btnH,
      });
      y += btnH + gap;
      this.buttons.push({
        id: 'preset-penhold', label: 'Penhold grip',
        x: padX, y, w: btnW, h: btnH,
      });
      y += btnH + gap;
      this.buttons.push({
        id: 'preset-default', label: 'Keep current defaults',
        x: padX, y, w: btnW, h: btnH,
      });
      y += btnH + gap;
      // Straight to the manual Pos/Rot stepper panel, skipping the two-sample
      // fit. Before this button the only route to Fine-Tune was completing the
      // wizard — a player who just wants to nudge the paddle a centimeter had
      // to redo the whole sampling dance to reach a ± button.
      this.buttons.push({
        id: 'fine-tune', label: 'Fine-tune manually (Pos / Rot)',
        x: padX, y, w: btnW, h: btnH,
      });
    } else if (this.step === STEP_SAMPLE_A) {
      this.buttons.push({
        id: 'confirm-a', label: 'Confirm', primary: true,
        x: padX, y: footerY, w: (CANVAS_W - 2 * padX - gap) / 2, h: btnH,
      });
      this.buttons.push({
        id: 'back-to-preset', label: 'Back',
        x: CANVAS_W / 2 + gap / 2, y: footerY,
        w: (CANVAS_W - 2 * padX - gap) / 2, h: btnH,
      });
    } else if (this.step === STEP_SAMPLE_B) {
      this.buttons.push({
        id: 'confirm-b', label: 'Confirm', primary: true,
        x: padX, y: footerY, w: (CANVAS_W - 2 * padX - gap) / 2, h: btnH,
      });
      this.buttons.push({
        id: 'back-to-sample-a', label: 'Back',
        x: CANVAS_W / 2 + gap / 2, y: footerY,
        w: (CANVAS_W - 2 * padX - gap) / 2, h: btnH,
      });
    } else if (this.step === STEP_SOLVED) {
      this.buttons.push({
        id: 'apply', label: 'Apply', primary: true,
        x: padX, y: footerY, w: (CANVAS_W - 2 * padX - gap) / 2, h: btnH,
      });
      this.buttons.push({
        id: 'retry', label: 'Retry',
        x: CANVAS_W / 2 + gap / 2, y: footerY,
        w: (CANVAS_W - 2 * padX - gap) / 2, h: btnH,
      });
    }

    // "Exit wizard" always available at the very bottom.
    this.buttons.push({
      id: 'exit', label: 'Exit calibration',
      x: padX, y: CANVAS_H - 46, w: CANVAS_W - 2 * padX, h: 36,
      small: true,
    });
  }

  draw() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_W - 4, CANVAS_H - 4);

    // Title
    ctx.fillStyle = COLORS.title;
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Paddle Calibration', CANVAS_W / 2, 44);

    // Step indicator + body text
    this.drawStepBody();

    for (const b of this.buttons) this.drawButton(b);

    // Transient message overlay (rejection reasons, mostly).
    if (this.transientMessage) {
      ctx.fillStyle = this.transientMessage.color;
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.transientMessage.text, CANVAS_W / 2, CANVAS_H - 130);
    }

    this.texture.needsUpdate = true;
  }

  drawStepBody() {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    if (this.step === STEP_PICK_PRESET) {
      ctx.fillStyle = COLORS.bodyText;
      ctx.font = '22px sans-serif';
      wrapText(ctx, 'Let\'s fit the paddle to your grip.', CANVAS_W / 2, 110, CANVAS_W - 80, 30);
      ctx.fillStyle = COLORS.hint;
      ctx.font = '18px sans-serif';
      wrapText(ctx, 'Pick the grip that feels closest to how you hold a real paddle. You can fine-tune it in the next step. "Handle in grip" is measured from the bat model itself: the controller body becomes the handle, blade extending forward from your fist.', CANVAS_W / 2, 180, CANVAS_W - 80, 26);
    } else if (this.step === STEP_SAMPLE_A) {
      ctx.fillStyle = COLORS.okText;
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText('Step 1 of 2', CANVAS_W / 2, 100);

      ctx.fillStyle = COLORS.bodyText;
      ctx.font = '22px sans-serif';
      wrapText(ctx, 'Press the paddle FACE flat on the table, rubber-side up.', CANVAS_W / 2, 150, CANVAS_W - 80, 30);
      ctx.fillStyle = COLORS.hint;
      ctx.font = '18px sans-serif';
      wrapText(ctx, 'Hold it steady, then tap Confirm with your other hand. Pressing on the virtual table gives you feedback that pure "hold level" cannot.', CANVAS_W / 2, 240, CANVAS_W - 80, 26);
    } else if (this.step === STEP_SAMPLE_B) {
      ctx.fillStyle = COLORS.okText;
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText('Step 2 of 2', CANVAS_W / 2, 100);

      ctx.fillStyle = COLORS.bodyText;
      ctx.font = '22px sans-serif';
      wrapText(ctx, 'Hold the paddle upright with the tip pointing UP and the face pointing at the far end of the table.', CANVAS_W / 2, 150, CANVAS_W - 80, 30);
      ctx.fillStyle = COLORS.hint;
      ctx.font = '18px sans-serif';
      wrapText(ctx, 'Handle down, blade up. Steady hand, then Confirm.', CANVAS_W / 2, 270, CANVAS_W - 80, 26);
    } else if (this.step === STEP_SOLVED) {
      ctx.fillStyle = COLORS.okText;
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText('Calibration ready.', CANVAS_W / 2, 110);

      ctx.fillStyle = COLORS.bodyText;
      ctx.font = '20px sans-serif';
      wrapText(ctx, 'Apply the new grip fit? If the paddle feels wrong, tap Retry to redo the two samples.', CANVAS_W / 2, 180, CANVAS_W - 80, 28);
    }
  }

  drawButton(b) {
    const ctx = this.ctx;
    const isHovered = this.hovered === b.id;
    const isPrimary = !!b.primary;

    let bg = COLORS.btnBg;
    let fg = COLORS.btnFg;
    if (isPrimary && !isHovered) {
      bg = COLORS.btnPrimary;
      fg = COLORS.btnPrimaryFg;
    }
    if (isHovered) {
      bg = COLORS.btnHoverBg;
      fg = COLORS.btnHoverFg;
    }

    ctx.fillStyle = bg;
    roundRectPath(ctx, b.x, b.y, b.w, b.h, 12);
    ctx.fill();

    ctx.fillStyle = fg;
    ctx.font = b.small ? '18px sans-serif' : 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
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
    // Exit is universal.
    if (button.id === 'exit') { this.emit('back'); return; }
    // Manual tuner hand-off — leaves the current T_cal untouched; the tuner
    // seeds its steppers from whatever is live.
    if (button.id === 'fine-tune') { this.emit('fineTune'); return; }

    if (this.step === STEP_PICK_PRESET) {
      const map = {
        'preset-handle-grip': 'handle_grip',
        'preset-shakehand': 'shakehand',
        'preset-penhold': 'penhold',
        'preset-default': 'default',
      };
      const preset = map[button.id];
      if (preset) {
        this.chosenPreset = preset;
        setPreset(preset);
        this.step = STEP_SAMPLE_A;
        this.rebuildForStep();
        this.draw();
      }
      return;
    }

    if (button.id === 'back-to-preset') {
      this.step = STEP_PICK_PRESET;
      this.rebuildForStep(); this.draw();
      return;
    }
    if (button.id === 'back-to-sample-a') {
      this.step = STEP_SAMPLE_A;
      this.rebuildForStep(); this.draw();
      return;
    }

    if (button.id === 'confirm-a') {
      if (!this._captureSample(this.qGripA)) return;
      this.step = STEP_SAMPLE_B;
      this.rebuildForStep(); this.draw();
      return;
    }
    if (button.id === 'confirm-b') {
      if (!this._captureSample(this.qGripB)) return;
      const result = this._solve();
      if (result.error) {
        this._showTransient('Cannot fit — ' + this._humanizeError(result.error), COLORS.errText);
        return;
      }
      this.solvedR = result.R;
      this.step = STEP_SOLVED;
      this.rebuildForStep(); this.draw();
      return;
    }
    if (button.id === 'apply') {
      // Preset posOffset stays; the wizard only fits rotOffset. Player can
      // tweak posOffset in the manual tuner if needed.
      setCalibration({
        posOffset: getPosOffset().clone(),  // keep current preset's posOffset
        rotOffset: this.solvedR,
        presetName: 'custom',
      });
      this.emit('accepted');
      return;
    }
    if (button.id === 'retry') {
      this.step = STEP_SAMPLE_A;
      this.rebuildForStep(); this.draw();
      return;
    }
  }

  // --- internal ---

  _captureSample(outQuat) {
    const angSpeed = this.getAngularSpeed();
    if (!sampleIsSteady(angSpeed)) {
      this._showTransient(
        `Too much motion (${angSpeed.toFixed(1)} rad/s > ${SAMPLE_MAX_ANGULAR_SPEED} limit) — hold still, retry`,
        COLORS.errText,
      );
      return false;
    }
    const tmpPos = new THREE.Vector3();
    if (!this.sampleGrip(tmpPos, outQuat)) {
      this._showTransient('No paddle detected — attach a controller', COLORS.errText);
      return false;
    }
    return true;
  }

  _solve() {
    // n_local: paddle face normal in paddle-model local frame (models.js
    // computes this from the GLB after PADDLE_EULER). handle_local: the
    // handle→tip axis, approximated as the normalized paddleFaceOffset
    // (which points from the grip origin toward the blade center).
    //
    // Both are cloned before normalize() — the exports from models.js are
    // shared refs and we must not mutate them.
    const nLocal = paddleFaceNormalLocal.clone().normalize();
    const handleLocal = paddleFaceOffset.clone().normalize();
    return solveRotOffset(this.qGripA, this.qGripB, nLocal, handleLocal);
  }

  _humanizeError(code) {
    switch (code) {
      case 'poses-too-similar': return 'the two samples looked the same. Reset paddle for step 2.';
      case 'handle-parallel-to-normal': return 'paddle model geometry error (contact support).';
      case 'sample-b-face-not-upright': return 'in step 2 the face was pointing up/down, not toward the opponent.';
      default: return code;
    }
  }

  _showTransient(text, color) {
    this.transientMessage = { text, color, expiresAt: performance.now() + 2500 };
    this.draw();
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.listeners.back.length = 0;
    this.listeners.accepted.length = 0;
  }
}

// --- helpers ---

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, cx, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let curY = y;
  for (let i = 0; i < words.length; i++) {
    const test = line + words[i] + ' ';
    if (ctx.measureText(test).width > maxWidth && i > 0) {
      ctx.fillText(line.trim(), cx, curY);
      line = words[i] + ' ';
      curY += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line.trim(), cx, curY);
}
