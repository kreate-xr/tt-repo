// In-XR physics tuner panel. Lets the player A/B physics knobs in-headset
// without rebuilding. Matches the WristMenu interface (mesh, hitTestUV,
// setHovered, selectHovered, isVisible/show/hide) so it slots into the
// existing activePanel() routing in inGame.js with no special handling.
//
// Each row exposes one constants.js value with [−] [LABEL: VALUE] [+] and a
// one-line plain-language description underneath.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import * as P from '../physics/constants.js';
import * as W from '../physics/paddleWeight.js';

const CANVAS_W = 640;
const CANVAS_H = 1396;   // grew to fit 14 knob rows (paddle weight added) without overlapping Back button
const PLANE_W = 0.34;
const PLANE_H = 0.742;   // PLANE_W * CANVAS_H / CANVAS_W to preserve aspect

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

// Each knob: get the live value, push a new value via setter, and step size
// for ± buttons. Description is plain English — what changing this DOES.
const KNOBS = [
  {
    id:    'paddleRest',
    label: 'Paddle Bounciness',
    desc:  'Overall rubber liveliness. Soft touches stay lively; hard smashes bleed more energy.',
    get:   () => P.PADDLE_RESTITUTION,
    set:   (v) => P.setPaddleRestitution(v),
    step:  0.05,
    fmt:   (v) => v.toFixed(2),
  },
  {
    id:    'paddleWeight',
    label: 'Paddle Weight',
    desc:  'How heavy the bat feels. Higher = longer haptic thud and a deeper contact sound.',
    get:   () => W.PADDLE_WEIGHT,
    set:   (v) => W.setPaddleWeight(v),
    step:  0.1,
    fmt:   (v) => W.paddleWeightGrams(v).toFixed(0) + ' g',
  },
  {
    id:    'contactCap',
    label: 'Swing Speed Ceiling',
    desc:  'Max effective swing speed (m/s). Lower = hard swings tire out, ball feels heavier.',
    get:   () => P.PADDLE_CONTACT_SPEED_CAP,
    set:   (v) => P.setPaddleContactSpeedCap(v),
    step:  0.5,
    fmt:   (v) => v.toFixed(1),
  },
  {
    id:    'tableRest',
    label: 'Table Bounciness',
    desc:  'Overall table liveliness. Soft drops bounce well; hard slams die on the table.',
    get:   () => P.TABLE_RESTITUTION,
    set:   (v) => P.setTableRestitution(v),
    step:  0.05,
    fmt:   (v) => v.toFixed(2),
  },
  {
    id:    'drag',
    label: 'Air Resistance',
    desc:  'How much air slows the ball. Grows with speed — smashes bleed much more than dinks.',
    get:   () => P.DRAG_COEFFICIENT,
    set:   (v) => P.setDragCoefficient(v),
    step:  0.02,
    fmt:   (v) => v.toFixed(2),
  },
  {
    id:    'gravity',
    label: 'Gravity',
    desc:  'How fast the ball falls. More negative = drops faster.',
    get:   () => P.GRAVITY,
    set:   (v) => P.setGravity(v),
    step:  0.5,
    fmt:   (v) => v.toFixed(1),
  },
  {
    id:    'posSmooth',
    label: 'Paddle Position Lag',
    desc:  'Paddle visual lag. Lower = more "heavy" feel (can cause motion sickness).',
    get:   () => P.PADDLE_POS_SMOOTHING,
    set:   (v) => P.setPaddlePosSmoothing(v),
    step:  0.05,
    fmt:   (v) => v.toFixed(2),
  },
  {
    id:    'rotSmooth',
    label: 'Paddle Rotation Lag',
    desc:  'Paddle turn lag. Keep close to 1.0 — rotation lag triggers nausea fast.',
    get:   () => P.PADDLE_ROT_SMOOTHING,
    set:   (v) => P.setPaddleRotSmoothing(v),
    step:  0.05,
    fmt:   (v) => v.toFixed(2),
  },
  {
    id:    'hapticMax',
    label: 'Haptic Peak Speed',
    desc:  'Impact speed (m/s) where haptic buzz hits max. Lower = even soft hits buzz hard.',
    get:   () => P.HAPTIC_MAX_SPEED,
    set:   (v) => P.setHapticMaxSpeed(v),
    step:  1,
    fmt:   (v) => v.toFixed(0),
  },
  {
    id:    'squash',
    label: 'Ball Squish on Hit',
    desc:  'Visual ball deformation at impact. 0 = no squish, 0.20 = cartoonish.',
    get:   () => P.SQUASH_AMOUNT,
    set:   (v) => P.setSquashAmount(v),
    step:  0.02,
    fmt:   (v) => v.toFixed(2),
  },
  {
    id:    'spinDamping',
    label: 'Spin Air Damping',
    desc:  'How fast spin dies in flight. Lower = spin lasts longer, Magnus curve compounds.',
    get:   () => P.SPIN_DAMPING,
    set:   (v) => P.setSpinDamping(v),
    step:  0.02,
    fmt:   (v) => v.toFixed(2),
  },
  {
    id:    'magnus',
    label: 'Magnus Curvature',
    desc:  'How much spin bends the ball\'s flight. Higher = more visible curve.',
    get:   () => P.MAGNUS_COEFFICIENT,
    set:   (v) => P.setMagnusCoefficient(v),
    step:  0.002,
    fmt:   (v) => v.toFixed(3),
  },
  {
    id:    'tableSpin',
    label: 'Table Spin Kick',
    desc:  'How much spin affects the ball off the bounce. Higher = topspin kicks, backspin brakes.',
    get:   () => P.TABLE_SPIN_GAIN,
    set:   (v) => P.setTableSpinGain(v),
    step:  1,
    fmt:   (v) => v.toFixed(0),
  },
  {
    id:    'sidespinKick',
    label: 'Sidespin Bounce Kick',
    desc:  'Lateral jump at bounce from sidespin. Higher = ball clearly kicks left/right off the table.',
    get:   () => P.TABLE_SIDESPIN_KICK,
    set:   (v) => P.setTableSidespinKick(v),
    step:  0.002,
    fmt:   (v) => v.toFixed(3),
  },
];

export class PhysicsTuner {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Trilinear + anisotropic; without mipmaps the panel shimmers when
    // minified onto the display at typical viewing distance.
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

    this.hovered = null;
    this.buttons = []; // { id, kind: 'minus'|'plus'|'back', knob?, x, y, w, h }
    this.layoutButtons();

    this.listeners = { back: [] };
    this.draw();
  }

  layoutButtons() {
    const padX = 24;
    const titleH = 64;
    const rowH = 86;      // label row (46) + desc (28) + gap (12)
    const stepperW = 64;
    const stepperH = 46;

    let y = titleH + 16;
    for (let i = 0; i < KNOBS.length; i++) {
      const k = KNOBS[i];
      // Minus button on the left, plus on the right.
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

    // Back button at bottom.
    this.buttons.push({
      id: 'back', kind: 'back',
      x: padX, y: CANVAS_H - 64, w: CANVAS_W - 2 * padX, h: 48,
    });
  }

  show() { this.mesh.visible = true; this.draw(); }
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
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Physics Tuner', CANVAS_W / 2, 38);

    for (const k of KNOBS) {
      this.drawRow(k);
    }

    // Steppers + back button on top of the row text.
    for (const b of this.buttons) {
      this.drawButton(b);
    }

    this.texture.needsUpdate = true;
  }

  drawRow(knob) {
    const ctx = this.ctx;
    // Find the minus button for y reference.
    const ref = this.buttons.find((b) => b.kind === 'minus' && b.knob === knob);
    if (!ref) return;
    const rowY = ref.y;
    const rowMidY = rowY + ref.h / 2;

    // Label + value (center between the steppers).
    ctx.fillStyle = COLORS.rowLabel;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(knob.label, ref.x + ref.w + 16, rowMidY);

    ctx.fillStyle = COLORS.rowValue;
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(knob.fmt(knob.get()), CANVAS_W - ref.x - ref.w - 16, rowMidY);

    // Description below the row.
    ctx.fillStyle = COLORS.rowDesc;
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(knob.desc, ref.x, rowY + ref.h + 4);
  }

  drawButton(b) {
    const ctx = this.ctx;
    const isHovered = this.hovered === b.id;

    let bg = COLORS.stepperBg;
    let fg = COLORS.stepperFg;
    if (b.kind === 'back') {
      bg = COLORS.bg;
      fg = COLORS.backText;
    }
    if (isHovered) {
      bg = COLORS.hoverBg;
      fg = COLORS.hoverFg;
    }

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
    if (button.kind === 'back') {
      this.emit('back');
      return;
    }
    if (button.kind === 'minus' || button.kind === 'plus') {
      const sign = button.kind === 'plus' ? 1 : -1;
      const k = button.knob;
      const next = k.get() + sign * k.step;
      k.set(next);
      this.draw();
    }
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.listeners.back.length = 0;
  }
}
