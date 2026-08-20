// In-XR physics tuner panel. Matches the WristMenu interface (mesh, hitTestUV,
// setHovered, selectHovered, isVisible/show/hide) so it slots into the
// existing activePanel() routing in inGame.js with no special handling.
//
// Restructured from the flat KNOBS list into the three sections the metadata
// table in physics/physicsParams.js defines:
//   A — locked physical constants, display-only. No steppers, by design.
//   B — equipment (restitution medians, table μ) with named presets.
//   C — feel knobs (weight, swing-inertia band, smoothing, haptics, spin).
// The panel holds no physics knowledge: every row is drawn from its
// descriptor and driven through stepRow/resetRow, so a deleted setter shows
// up as a compile-time missing import in ONE module, not a dead '+' button
// discovered in a headset.
//
// Tunable state persists via physicsParams' guarded storage helpers; stored
// blobs from older builds are migrated (renames applied, deleted knobs
// discarded, out-of-range values clamped) rather than reinterpreted.

import * as THREE from 'three';
import { scene } from './sceneSetup.js';
import { COLORS as UI, F, roundRect } from './panelStyle.js';
import { applyPhysicsPreset } from '../physics/constants.js';
import {
  LOCKED_ROWS, EQUIPMENT_ROWS, FEEL_ROWS, PRESETS,
  stepRow, resetRow, migrateStoredPhysics, loadStoredPhysics, saveStoredPhysics,
} from '../physics/physicsParams.js';

const CANVAS_W = 640;
const CANVAS_H = 1180;
const PLANE_W = 0.34;
const PLANE_H = PLANE_W * CANVAS_H / CANVAS_W;   // preserve aspect

const SECTIONS = [
  { id: 'A', title: 'Locked',    rows: LOCKED_ROWS },
  { id: 'B', title: 'Equipment', rows: EQUIPMENT_ROWS },
  { id: 'C', title: 'Feel',      rows: FEEL_ROWS },
];

const PAD_X = 24;
const TAB_Y = 64;
const TAB_H = 46;
const ROWS_TOP = TAB_Y + TAB_H + 20;
const ROW_H = 84;        // stepper row (44) + desc (26) + gap (14)
const BTN = 44;          // stepper / reset square
const PRESET_H = 44;

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

    // Restore saved tuning before the first draw so the panel opens showing
    // what the sim is actually running.
    const stored = loadStoredPhysics();
    if (stored) migrateStoredPhysics(stored);

    this.section = 'B';
    this.hovered = null;
    this.buttons = []; // { id, kind, x, y, w, h, row?, section?, preset? }
    this.listeners = { back: [] };

    this.layoutButtons();
    this.draw();
  }

  activeRows() {
    return SECTIONS.find((s) => s.id === this.section).rows;
  }

  layoutButtons() {
    this.buttons = [];

    // Tabs — always present, one per section.
    const tabW = Math.floor((CANVAS_W - 2 * PAD_X - 2 * 12) / SECTIONS.length);
    SECTIONS.forEach((s, i) => {
      this.buttons.push({
        id: 'tab-' + s.id, kind: 'tab', section: s.id,
        x: PAD_X + i * (tabW + 12), y: TAB_Y, w: tabW, h: TAB_H,
      });
    });

    let y = ROWS_TOP;

    // Preset strip at the top of the equipment section.
    if (this.section === 'B') {
      const pw = Math.floor((CANVAS_W - 2 * PAD_X - 2 * 12) / PRESETS.length);
      PRESETS.forEach((p, i) => {
        this.buttons.push({
          id: 'preset-' + p.id, kind: 'preset', preset: p,
          x: PAD_X + i * (pw + 12), y, w: pw, h: PRESET_H,
        });
      });
      y += PRESET_H + 20;
    }

    // Row controls. Section A rows are locked — value display only, no
    // stepper or reset buttons at all.
    for (const row of this.activeRows()) {
      if (typeof row.set === 'function') {
        this.buttons.push({ id: 'm-' + row.id, kind: 'minus', row, x: PAD_X, y, w: BTN, h: BTN });
        this.buttons.push({
          id: 'p-' + row.id, kind: 'plus', row,
          x: CANVAS_W - PAD_X - 2 * BTN - 10, y, w: BTN, h: BTN,
        });
        this.buttons.push({
          id: 'r-' + row.id, kind: 'reset', row,
          x: CANVAS_W - PAD_X - BTN, y, w: BTN, h: BTN,
        });
      }
      row._y = y;   // drawRow anchor — layout owns geometry, draw reads it
      y += ROW_H;
    }

    this.buttons.push({
      id: 'back', kind: 'back',
      x: PAD_X, y: CANVAS_H - 64, w: CANVAS_W - 2 * PAD_X, h: 48,
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
    ctx.fillStyle = UI.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.strokeStyle = UI.hairline;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CANVAS_W - 2, CANVAS_H - 2);

    ctx.fillStyle = UI.accent;
    ctx.font = F(700, 30);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Physics Tuner', CANVAS_W / 2, 36);

    for (const row of this.activeRows()) this.drawRow(row);
    for (const b of this.buttons) this.drawButton(b);

    this.texture.needsUpdate = true;
  }

  drawRow(row) {
    const ctx = this.ctx;
    const y = row._y;
    if (y === undefined) return;
    const locked = typeof row.set !== 'function';
    const midY = y + BTN / 2;
    const labelX = locked ? PAD_X : PAD_X + BTN + 14;
    const valueX = locked
      ? CANVAS_W - PAD_X
      : CANVAS_W - PAD_X - 2 * BTN - 10 - 14;

    ctx.fillStyle = locked ? UI.muted : UI.text;
    ctx.font = F(600, 19);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.label, labelX, midY);

    ctx.fillStyle = locked ? UI.muted : UI.accent;
    ctx.font = F(700, 20);
    ctx.textAlign = 'right';
    ctx.fillText(row.fmt(row.get()), valueX, midY);

    ctx.fillStyle = UI.muted;
    ctx.font = F(400, 14);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(row.desc, PAD_X, y + BTN + 6);
  }

  drawButton(b) {
    const ctx = this.ctx;
    const isHovered = this.hovered === b.id;
    const isActiveTab = b.kind === 'tab' && b.section === this.section;

    let bg = UI.panel;
    let fg = UI.text;
    if (isActiveTab) { bg = UI.panelHover; fg = UI.accentBright; }
    if (b.kind === 'back') { bg = UI.warnHover; fg = UI.warn; }
    if (isHovered) { bg = UI.accent; fg = UI.bg; }

    ctx.fillStyle = bg;
    roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fill();

    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    if (b.kind === 'minus')       { ctx.font = F(700, 30); ctx.fillText('−', cx, cy); }
    else if (b.kind === 'plus')   { ctx.font = F(700, 30); ctx.fillText('+', cx, cy); }
    else if (b.kind === 'reset')  { ctx.font = F(700, 24); ctx.fillText('↺', cx, cy); }
    else if (b.kind === 'tab') {
      const s = SECTIONS.find((x) => x.id === b.section);
      ctx.font = F(700, 18);
      ctx.fillText(`${b.section} · ${s.title}`, cx, cy);
    } else if (b.kind === 'preset') { ctx.font = F(600, 18); ctx.fillText(b.preset.label, cx, cy); }
    else if (b.kind === 'back')   { ctx.font = F(700, 20); ctx.fillText('Back to Menu', cx, cy); }
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
    switch (button.kind) {
      case 'back':
        this.emit('back');
        return;
      case 'tab':
        if (button.section !== this.section) {
          this.section = button.section;
          this.hovered = null;
          this.layoutButtons();
        }
        this.draw();
        return;
      case 'minus':
      case 'plus':
        stepRow(button.row, button.kind === 'plus' ? +1 : -1);
        break;
      case 'reset':
        resetRow(button.row);
        break;
      case 'preset':
        applyPhysicsPreset(button.preset.id);
        break;
      default:
        return;
    }
    saveStoredPhysics();
    this.draw();
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.listeners.back.length = 0;
  }
}
