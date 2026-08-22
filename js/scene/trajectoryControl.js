// In-XR control panel for the Trajectory Practice drill. Picks spin, speed
// and spin intensity; the dotted preview is driven from these selections, and
// the paddle trigger launches the ball.
//
// Rebuilt on panelKit + panelStyle: this was the last live panel still
// hand-rolling its own hit test, hover state and green-bordered look from the
// pre-P15 era, which made Trajectory Practice read as a different app from
// the training menu that launched it. Hit geometry and routing now come from
// Panel; the visual language (dark glass card, accent-green selection, muted
// labels) is the same one trainingMenu and machinePlayMenu draw.
//
// The public surface is unchanged — SPINS / SPEED_LEVELS / INTENSITY_LEVELS,
// the spinChange / speedChange / intensityChange / back / hide events, and
// the mesh / hover / select methods inGame.js routes input through — so
// trajectoryPractice.js and the host plumbing did not move.

import * as THREE from 'three';
import { playMenuHoverTick, playMenuSelectClick } from './audio.js';
import * as haptics from '../xr/haptics.js';
import { Panel, WIDGETS } from './panelKit.js';
import { COLORS, F, roundRect } from './panelStyle.js';

const CANVAS_W = 512;
const CANVAS_H = 640;
const PLANE_W = 0.30;
const PLANE_H = 0.38;

const HEADER_H = 78;
const FOOTER_Y = CANVAS_H - 86;

// Side labels are from the PLAYER's perspective (the person holding the paddle
// on the +Z side of the table). Ball travels in +Z toward the player, so
// Magnus = ω × v: sideA (ω=+Y) curves to +X → player's RIGHT; sideB (ω=-Y)
// curves to -X → player's LEFT. Keep sideA/sideB physics stable and just
// label the buttons to match what the player actually sees.
export const SPINS = [
  { id: 'topspin',  label: 'TOP',  color: '#ff5a66' },
  { id: 'backspin', label: 'BACK', color: '#4d9dff' },
  { id: 'sideB',    label: 'L',    color: '#ffa94d' },
  { id: 'sideA',    label: 'R',    color: '#ffd54d' },
  { id: 'none',     label: 'FLAT', color: '#e6edf5' },
];

export const SPEED_LEVELS = [
  { label: '1', flightTime: 0.85 }, // slowest
  { label: '2', flightTime: 0.70 },
  { label: '3', flightTime: 0.58 },
  { label: '4', flightTime: 0.48 },
  { label: '5', flightTime: 0.40 }, // fastest
];

// Angular velocity magnitudes (rad/s). Higher = more dramatic curve in flight
// AND a stronger post-bounce kick (table friction couples ω → linear velocity).
export const INTENSITY_LEVELS = [
  { label: '1', spinMag: 8  }, // very light — barely any curve
  { label: '2', spinMag: 20 },
  { label: '3', spinMag: 35 }, // moderate (default)
  { label: '4', spinMag: 55 },
  { label: '5', spinMag: 80 }, // heavy — sharp post-bounce kick
];

// The three option rows, driven from one table so layout and draw cannot
// disagree about what exists.
const ROWS = [
  { kind: 'spin',      label: 'SPIN',           options: SPINS,            hint: null },
  { kind: 'speed',     label: 'SPEED',          options: SPEED_LEVELS,     hint: '1 slow · 5 fast' },
  { kind: 'intensity', label: 'SPIN INTENSITY', options: INTENSITY_LEVELS, hint: '1 light · 5 heavy' },
];

export class TrajectoryControl {
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

    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H), material);
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    this.spinIndex = 0;
    this.speedIndex = 2;
    this.intensityIndex = 2;

    this.panel = new Panel({ width: CANVAS_W, height: CANVAS_H });
    this.listeners = { spinChange: [], speedChange: [], intensityChange: [], back: [], hide: [] };

    this.layout();
    this.draw();
  }

  on(event, fn) { if (this.listeners[event]) this.listeners[event].push(fn); }
  emit(event, payload) {
    const arr = this.listeners[event]; if (!arr) return;
    for (const fn of arr) fn(payload);
  }

  show() { this.mesh.visible = true; this.panel.show(); this.draw(); }
  hide() { this.mesh.visible = false; this.panel.hide(); }
  isVisible() { return this.mesh.visible; }

  getSpin() { return SPINS[this.spinIndex]; }
  getSpeed() { return SPEED_LEVELS[this.speedIndex]; }
  getIntensity() { return INTENSITY_LEVELS[this.intensityIndex]; }

  // inGame.js reads this to decide whether a trigger press belongs to the
  // panel or launches a ball.
  get hovered() { return this.panel.hoveredId; }

  layout() {
    const p = this.panel;
    p.clear();

    const padX = 24;
    const gap = 10;
    const cellH = 56;
    const totalW = CANVAS_W - 2 * padX;

    let y = HEADER_H + 40;
    this._rowRects = [];
    for (const row of ROWS) {
      const w = (totalW - (row.options.length - 1) * gap) / row.options.length;
      this._rowRects.push({ row, labelY: y - 18 });
      for (let i = 0; i < row.options.length; i++) {
        p.add({
          id: `${row.kind}:${i}`, kind: WIDGETS.BUTTON, shape: 'rect',
          x: padX + i * (w + gap), y, w, h: cellH,
        });
      }
      y += cellH + 62;
    }

    // Footer: Hide (close panel) + Back (exit drill), same shape as the
    // training menu's footer buttons.
    const bw = (totalW - 12) / 2;
    p.add({ id: 'hide', kind: WIDGETS.BUTTON, shape: 'rect', x: padX, y: FOOTER_Y, w: bw, h: 48 });
    p.add({ id: 'back', kind: WIDGETS.BUTTON, shape: 'rect', x: padX + bw + 12, y: FOOTER_Y, w: bw, h: 48 });
  }

  draw() {
    const ctx = this.ctx;
    const hov = this.panel.hoveredId;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = COLORS.bg;
    roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 22);
    ctx.fill();

    // Header.
    ctx.fillStyle = COLORS.accent;
    ctx.font = F(700, 26);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('TRAJECTORY', 24, 34);
    ctx.fillStyle = COLORS.muted;
    ctx.font = F(500, 13);
    ctx.fillText('Pick spin and speed · trigger off-panel launches', 24, 58);

    ctx.strokeStyle = COLORS.hairline;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(24, HEADER_H);
    ctx.lineTo(CANVAS_W - 24, HEADER_H);
    ctx.stroke();

    // Option rows.
    for (const { row, labelY } of this._rowRects) {
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.muted;
      ctx.font = F(600, 14);
      ctx.textAlign = 'left';
      ctx.fillText(row.label, 24, labelY);
      if (row.hint) {
        ctx.textAlign = 'right';
        ctx.font = F(500, 12);
        ctx.fillText(row.hint, CANVAS_W - 24, labelY);
      }

      const selected = this._selectedIndex(row.kind);
      for (let i = 0; i < row.options.length; i++) {
        const w = this.panel.get(`${row.kind}:${i}`);
        if (!w) continue;
        const on = i === selected;
        const hovered = hov === w.id;

        // Same idiom as the feed editor's segments: accent fill + dark text
        // when selected, glass fill otherwise, hover ring on top.
        ctx.fillStyle = on ? COLORS.accent : (hovered ? COLORS.panelHover : COLORS.panel);
        roundRect(ctx, w.x, w.y, w.w, w.h, 12);
        ctx.fill();
        if (hovered && !on) {
          ctx.strokeStyle = COLORS.accent;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Spin cells keep a per-spin colour tick so TOP/BACK/L/R stay
        // visually distinct at a glance; selection still reads as accent.
        if (row.kind === 'spin' && !on) {
          ctx.fillStyle = row.options[i].color;
          roundRect(ctx, w.x + 10, w.y + 8, w.w - 20, 4, 2);
          ctx.fill();
        }

        ctx.fillStyle = on ? '#0e1116' : COLORS.text;
        ctx.font = F(600, 20);
        ctx.textAlign = 'center';
        ctx.fillText(row.options[i].label, w.x + w.w / 2, w.y + w.h / 2 + (row.kind === 'spin' && !on ? 4 : 0));
      }
    }

    // Current-selection summary, same muted one-liner the menus use.
    ctx.fillStyle = COLORS.muted;
    ctx.font = F(500, 14);
    ctx.textAlign = 'center';
    ctx.fillText(
      `${this.getSpin().label} · speed ${this.getSpeed().label} · intensity ${this.getIntensity().label}`,
      CANVAS_W / 2, FOOTER_Y - 30,
    );

    // Footer buttons.
    for (const [id, label] of [['hide', 'HIDE PANEL'], ['back', '‹ BACK']]) {
      const w = this.panel.get(id);
      if (!w) continue;
      ctx.fillStyle = hov === id ? COLORS.panelHover : COLORS.panel;
      roundRect(ctx, w.x, w.y, w.w, w.h, 20);
      ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.font = F(600, 16);
      ctx.textAlign = 'center';
      ctx.fillText(label, w.x + w.w / 2, w.y + w.h / 2);
    }

    this.texture.needsUpdate = true;
  }

  _selectedIndex(kind) {
    if (kind === 'spin') return this.spinIndex;
    if (kind === 'speed') return this.speedIndex;
    return this.intensityIndex;
  }

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

    if (id === 'back') { this.emit('back'); return true; }
    if (id === 'hide') { this.emit('hide'); return true; }

    const [kind, idx] = id.split(':');
    const i = Number(idx);
    if (kind === 'spin') {
      this.spinIndex = i;
      this.draw();
      this.emit('spinChange', { spin: SPINS[i] });
    } else if (kind === 'speed') {
      this.speedIndex = i;
      this.draw();
      this.emit('speedChange', { speed: SPEED_LEVELS[i] });
    } else if (kind === 'intensity') {
      this.intensityIndex = i;
      this.draw();
      this.emit('intensityChange', { intensity: INTENSITY_LEVELS[i] });
    }
    return true;
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    for (const key of Object.keys(this.listeners)) this.listeners[key].length = 0;
  }
}
