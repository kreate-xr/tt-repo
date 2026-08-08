// In-XR control panel for the Trajectory Practice drill. Picks spin and speed;
// the dotted preview is driven from these selections, and the paddle trigger
// launches the ball. Uses the same canvas/UV-raycast pattern as WristMenu.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';

const CANVAS_W = 512;
const CANVAS_H = 640;
const PLANE_W = 0.30;
const PLANE_H = 0.38;

const COLORS = {
  bg:           '#0a0e18',
  border:       '#00ff88',
  title:        '#00ff88',
  sectionLabel: '#7aa6c4',
  buttonBg:     '#1a2030',
  buttonText:   '#e6edf5',
  selectedBg:   '#003d2a',
  selectedText: '#00ff88',
  hoverBg:      '#00ff88',
  hoverText:    '#0a0e18',
  hint:         '#aaaaaa',
  backBorder:   'rgba(255,255,255,0.25)',
};

// Side labels are from the PLAYER's perspective (the person holding the paddle
// on the +Z side of the table). Ball travels in +Z toward the player, so
// Magnus = ω × v: sideA (ω=+Y) curves to +X → player's RIGHT; sideB (ω=-Y)
// curves to -X → player's LEFT. Keep sideA/sideB physics stable and just
// label the buttons to match what the player actually sees.
export const SPINS = [
  { id: 'topspin',  label: 'TOP',  color: '#ff3344' },
  { id: 'backspin', label: 'BACK', color: '#3388ff' },
  { id: 'sideB',    label: 'L',    color: '#ff8822' },
  { id: 'sideA',    label: 'R',    color: '#ffcc22' },
  { id: 'none',     label: 'FLAT', color: '#ffffff' },
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

    this.spinIndex = 0;
    this.speedIndex = 2;
    this.intensityIndex = 2;
    this.hovered = null;

    this.buttons = [];
    this.layoutButtons();

    this.listeners = { spinChange: [], speedChange: [], intensityChange: [], back: [], hide: [] };

    this.draw();
  }

  on(event, fn) { if (this.listeners[event]) this.listeners[event].push(fn); }
  emit(event, payload) {
    const arr = this.listeners[event]; if (!arr) return;
    for (const fn of arr) fn(payload);
  }

  show() { this.mesh.visible = true; this.draw(); }
  hide() { this.mesh.visible = false; this.hovered = null; }
  isVisible() { return this.mesh.visible; }

  getSpin() { return SPINS[this.spinIndex]; }
  getSpeed() { return SPEED_LEVELS[this.speedIndex]; }
  getIntensity() { return INTENSITY_LEVELS[this.intensityIndex]; }

  layoutButtons() {
    const padX = 24;
    const rowGap = 10;
    const totalW = CANVAS_W - 2 * padX;
    const w = (totalW - 4 * rowGap) / 5;
    const rowH = 60;

    // Spin row.
    {
      const y = 130;
      for (let i = 0; i < SPINS.length; i++) {
        this.buttons.push({
          id: 'spin-' + i, kind: 'spin', index: i,
          label: SPINS[i].label,
          color: SPINS[i].color,
          x: padX + i * (w + rowGap), y, w, h: rowH,
        });
      }
    }

    // Speed row.
    {
      const y = 250;
      for (let i = 0; i < SPEED_LEVELS.length; i++) {
        this.buttons.push({
          id: 'speed-' + i, kind: 'speed', index: i,
          label: SPEED_LEVELS[i].label,
          x: padX + i * (w + rowGap), y, w, h: rowH,
        });
      }
    }

    // Spin intensity row (controls magnitude — affects post-bounce kick).
    {
      const y = 370;
      for (let i = 0; i < INTENSITY_LEVELS.length; i++) {
        this.buttons.push({
          id: 'intensity-' + i, kind: 'intensity', index: i,
          label: INTENSITY_LEVELS[i].label,
          x: padX + i * (w + rowGap), y, w, h: rowH,
        });
      }
    }

    // Bottom row: Hide (close panel) + Back to Menu (exit drill).
    {
      const gap = 12;
      const halfW = (totalW - gap) / 2;
      const y = 540;
      this.buttons.push({
        id: 'hide', kind: 'hide', label: 'Hide Panel',
        x: padX, y, w: halfW, h: rowH,
      });
      this.buttons.push({
        id: 'back', kind: 'back', label: 'Back to Menu',
        x: padX + halfW + gap, y, w: halfW, h: rowH,
      });
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, CANVAS_W - 4, CANVAS_H - 4);

    ctx.fillStyle = COLORS.title;
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Trajectory Practice', CANVAS_W / 2, 50);

    ctx.fillStyle = COLORS.hint;
    ctx.font = '15px sans-serif';
    ctx.fillText('Pick spin + speed.  Pull trigger to launch.', CANVAS_W / 2, 86);

    // Section labels
    ctx.fillStyle = COLORS.sectionLabel;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SPIN', 28, 116);
    ctx.fillText('SPEED', 28, 236);
    ctx.fillText('SPIN INTENSITY', 28, 356);

    // Right-side scale hints
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.hint;
    ctx.font = '13px sans-serif';
    ctx.fillText('1 slow  ·  5 fast', CANVAS_W - 28, 236);
    ctx.fillText('1 light  ·  5 heavy', CANVAS_W - 28, 356);

    for (const b of this.buttons) {
      this.drawButton(b);
    }

    // Currently selected indicator (sub-line)
    ctx.fillStyle = COLORS.hint;
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    const cur = `${SPINS[this.spinIndex].label}  ·  speed ${SPEED_LEVELS[this.speedIndex].label}  ·  intensity ${INTENSITY_LEVELS[this.intensityIndex].label}`;
    ctx.fillText(cur, CANVAS_W / 2, 510);

    this.texture.needsUpdate = true;
  }

  drawButton(b) {
    const ctx = this.ctx;
    const isHovered = this.hovered === b.id;
    const isSelected =
      (b.kind === 'spin' && b.index === this.spinIndex) ||
      (b.kind === 'speed' && b.index === this.speedIndex) ||
      (b.kind === 'intensity' && b.index === this.intensityIndex);

    let bg = COLORS.buttonBg;
    let textColor = COLORS.buttonText;

    if (b.kind === 'back' || b.kind === 'hide') {
      bg = COLORS.bg;
      textColor = COLORS.buttonText;
    } else if (isSelected) {
      bg = COLORS.selectedBg;
      textColor = COLORS.selectedText;
    }
    if (isHovered) {
      bg = COLORS.hoverBg;
      textColor = COLORS.hoverText;
    }

    ctx.fillStyle = bg;
    ctx.fillRect(b.x, b.y, b.w, b.h);

    if (b.kind === 'back' || b.kind === 'hide') {
      ctx.strokeStyle = COLORS.backBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    } else if (isSelected && !isHovered) {
      ctx.strokeStyle = b.color || COLORS.selectedText;
      ctx.lineWidth = 3;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    } else if (b.kind === 'spin' && b.color && !isHovered) {
      // Subtle color stripe at the top so spins are visually distinct.
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x, b.y, b.w, 4);
    }

    ctx.fillStyle = textColor;
    ctx.font = (b.kind === 'back' || b.kind === 'hide' ? 'bold 22px sans-serif' : 'bold 28px sans-serif');
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
    const button = this.buttons.find(b => b.id === this.hovered);
    if (!button) return false;
    if (button.kind === 'spin') {
      this.spinIndex = button.index;
      this.draw();
      this.emit('spinChange', { spin: SPINS[this.spinIndex] });
    } else if (button.kind === 'speed') {
      this.speedIndex = button.index;
      this.draw();
      this.emit('speedChange', { speed: SPEED_LEVELS[this.speedIndex] });
    } else if (button.kind === 'intensity') {
      this.intensityIndex = button.index;
      this.draw();
      this.emit('intensityChange', { intensity: INTENSITY_LEVELS[this.intensityIndex] });
    } else if (button.kind === 'back') {
      this.emit('back');
    } else if (button.kind === 'hide') {
      this.emit('hide');
    }
    return true;
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.listeners.spinChange.length = 0;
    this.listeners.speedChange.length = 0;
    this.listeners.intensityChange.length = 0;
    this.listeners.back.length = 0;
    this.listeners.hide.length = 0;
  }
}
