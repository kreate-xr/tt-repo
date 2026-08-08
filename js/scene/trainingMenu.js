// M0 training menu — the renderer.
//
// Draws whatever TrainingMenuModel reports and routes input back to it. All
// navigation and editing logic lives in the model (and is unit-tested); this
// file owns canvas drawing, the THREE mesh, and hit-region layout only.
//
// Built on panelKit, so hit-testing, hover-change detection and slider
// clamping come from one tested implementation rather than being hand-rolled
// for a sixth time.
//
// Exposes the same surface WristMenu did — mesh / show / hide / isVisible /
// on / setHovered / selectHovered / setPokeCursor / clearPokeCursor /
// hitTestUV / update / dispose — so inGame.js swaps the class and nothing
// else about its input plumbing changes.

import * as THREE from 'three';
import { playMenuHoverTick, playMenuSelectClick } from './audio.js';
import * as haptics from '../xr/haptics.js';
import { Panel, WIDGETS, sliderFraction } from './panelKit.js';
import {
  TrainingMenuModel, SCREENS, CUSTOM_FIELDS, formatField,
} from '../modes/training/menuModel.js';
import { bladeHeatmap } from '../modes/training/analysis.js';

const CANVAS_W = 1024;
const CANVAS_H = 640;

export const PLANE_W = 1.40;
export const PLANE_H = PLANE_W * (CANVAS_H / CANVAS_W);

const ACCENT = '#3ddc97';
const COLORS = {
  bg: 'rgba(14,17,22,0.94)',
  panel: 'rgba(255,255,255,0.05)',
  panelHover: 'rgba(61,220,151,0.16)',
  text: '#eef2f6',
  muted: '#8b97a5',
  disabled: '#59626e',
  accent: ACCENT,
  warn: '#ff9a9a',
  track: 'rgba(255,255,255,0.12)',
};

const F = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

const HEADER_H = 76;
const FOOTER_Y = CANVAS_H - 74;
const BODY_Y = HEADER_H + 12;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class TrainingMenu {
  constructor({ presets = null, difficulties = null, getSessionLog = null,
    getRecentContacts = null } = {}) {
    this.model = new TrainingMenuModel({ presets, getSessionLog, getRecentContacts });
    this.panel = new Panel({ width: CANVAS_W, height: CANVAS_H });
    this.listeners = new Map();
    this.pokeCursor = null;
    this.difficulties = difficulties || [
      { id: 'beginner', label: 'CLUB' },
      { id: 'intermediate', label: 'INTERNATIONAL' },
      { id: 'pro', label: 'ELITE' },
    ];
    this.difficultyIndex = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Mipmaps + anisotropy: without them the panel shimmers when minified,
    // because head micro-motion re-samples different texels each frame.
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = 16;

    const material = new THREE.MeshBasicMaterial({
      map: this.texture, side: THREE.DoubleSide, transparent: true,
      // depthTest off, matching the other panels: with it on the menu
      // z-fights transparent geometry drawn before it (trail, shadow).
      depthTest: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H), material);
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    this.layout();
    this.draw();
  }

  // --- host interface (mirrors WristMenu) ------------------------------------

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      try { fn(payload); } catch (e) { console.error(`menu handler "${event}" threw:`, e); }
    }
  }

  show() { this.mesh.visible = true; this.panel.show(); this.draw(); }
  hide() { this.mesh.visible = false; this.panel.hide(); this.pokeCursor = null; }
  isVisible() { return this.mesh.visible; }

  hitTestUV(u, v) {
    // Remember where the ray is pointing. setHovered() only receives an id,
    // so without this a slider press would know WHICH slider but not WHERE
    // along it — and would have nothing to set the value from.
    this._lastUV = { u, v };
    return this.panel.hitTestUV(u, v);
  }

  /** Adopt the tier the wrist menu already has selected, so opening training
   *  doesn't silently reset it to CLUB. */
  setDifficulty(id) {
    const i = this.difficulties.findIndex((d) => d.id === id);
    if (i >= 0 && i !== this.difficultyIndex) { this.difficultyIndex = i; this.rebuild(); }
  }

  setHovered(id) {
    if (this.panel.hoveredId === id) return;
    this.panel.hoveredId = id;
    if (id != null) {
      try { playMenuHoverTick(); } catch (e) { /* audio optional */ }
      haptics.pulseActive(0.15, 15);
    }
    this.draw();
  }

  setPokeCursor(u, v, proximity) { this.pokeCursor = { u, v, proximity }; this.draw(); }
  clearPokeCursor() { if (this.pokeCursor) { this.pokeCursor = null; this.draw(); } }

  update() { /* no per-frame animation; redraws are event-driven */ }

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

  // --- input handling -------------------------------------------------------

  handle(id) {
    const m = this.model;

    if (id === 'back') {
      // At the root there is nowhere left to pop, so backing out closes this
      // sub-menu and returns to the wrist menu — which is left exactly as it
      // was. Deeper in, it pops one level.
      if (!m.back()) { this.emit('back'); return undefined; }
      return this.rebuild();
    }
    if (id === 'footer:calibrate') return this.emit('calibrate');
    if (id === 'footer:tune') return this.emit('tune');
    // "CLOSE" rather than "EXIT": this leaves training and returns to the
    // wrist menu; it does not end the XR session.
    if (id === 'footer:exit') return this.emit('back');
    if (id.startsWith('diff:')) {
      this.difficultyIndex = Number(id.slice(5));
      return this.rebuild();
    }

    if (id.startsWith('item:')) {
      const res = m.selectItem(id.slice(5));
      if (res && res.action === 'freePlay') return this.emit('freeplay');
      if (res && res.action === 'start') {
        return this.start(res.config, res.preset, res.drill, res.options);
      }
      return this.rebuild();
    }

    if (id === 'start') return this.start(m.config, m.selectedPreset);
    if (id === 'save') {
      // Auto-named: in-headset text entry does not exist, and blocking the
      // save behind a keyboard would make the feature unreachable.
      const n = (this.model.presetsApi ? this.model.presetsApi.getPresets().length : 0) + 1;
      m.savePreset(`Custom ${n}`);
      return this.rebuild();
    }

    // Tapping anywhere on a slider track jumps to that value. Without this a
    // slider could ONLY be moved by a successful drag, so a plain press did
    // nothing at all — which is how it reads as "drag is not working".
    if (id.startsWith('slider:') && this._lastUV) {
      this.dragAt(this._lastUV.u, this._lastUV.v);
      return undefined;
    }

    if (id.startsWith('zone:')) { m.setZone(Number(id.slice(5))); return this.rebuild(); }
    if (id.startsWith('cycle:')) {
      const [, key, dir] = id.split(':');
      if (key === 'burstCount') m.stepBurst(Number(dir));
      else m.cycleField(key, Number(dir));
      return this.rebuild();
    }
    if (id.startsWith('toggle:')) {
      const key = id.slice(7);
      m.setField(key, !m.config[key]);
      return this.rebuild();
    }
    return undefined;
  }

  /**
   * Slider drag, driven by the host while the trigger is held.
   *
   * `sliderId` pins the drag to the slider that was originally grabbed.
   * Re-hit-testing every frame instead would hand control to whatever the ray
   * happens to be over, and since the track is only ~18 px tall the smallest
   * vertical wobble would silently drop the drag — or worse, start editing a
   * neighbouring field.
   */
  dragAt(u, v, sliderId = null) {
    const id = sliderId || this.panel.hitTestUV(u, v);
    if (!id || !id.startsWith('slider:')) return false;
    const w = this.panel.get(id);
    if (!w || w.disabled) return false;
    const before = w.value;
    this.panel.dragSliderUV(id, u, v);
    if (w.value === before) return false;
    this.model.setField(id.slice(7), w.value);
    this.rebuild();
    return true;
  }

  /** Slider id under a UV point, or null — lets the host start a drag. */
  sliderAt(u, v) {
    const id = this.panel.hitTestUV(u, v);
    return id && id.startsWith('slider:') ? id : null;
  }

  // `drill` defaults to the ball machine; the legacy drills pass their own id.
  // `options` carries M2's pattern / random / ladder selection.
  start(config, preset, drill = 'ballMachine', options = null) {
    this.emit('start', {
      drill,
      config,
      preset,
      options,
      difficulty: this.difficulties[this.difficultyIndex].id,
    });
  }

  rebuild() { this.layout(); this.draw(); }

  // --- layout ---------------------------------------------------------------

  layout() {
    const p = this.panel;
    p.clear();

    // Back / close, always present so there is never a dead end.
    p.add({ id: 'back', kind: WIDGETS.BUTTON, shape: 'rect', x: 24, y: 20, w: 120, h: 40 });

    if (this.model.screen === SCREENS.CUSTOM_FEED) this.layoutCustom();
    else this.layoutList();

    // Footer.
    const fw = 200;
    const gap = 24;
    const total = fw * 3 + gap * 2;
    let fx = (CANVAS_W - total) / 2;
    for (const id of ['calibrate', 'tune', 'exit']) {
      p.add({ id: `footer:${id}`, kind: WIDGETS.BUTTON, shape: 'rect', x: fx, y: FOOTER_Y, w: fw, h: 48 });
      fx += fw + gap;
    }
  }

  layoutList() {
    const p = this.panel;
    const items = this.model.items();
    const gap = 6;
    const x = 80;
    const w = CANVAS_W - 160;
    const top = BODY_Y + 12;

    // Row height is DERIVED from the space between the header and the footer,
    // not fixed. At a fixed 56 px the nine root items ran to y=684 while the
    // footer starts at 566, so the last two sat underneath the footer buttons
    // — and because the footer is registered later it won the hit test, making
    // "Free Play" and "Tutorial" unclickable (a click on Free Play activated
    // PHYSICS instead). Fitting to the available height makes that structural.
    const available = (FOOTER_Y - 18) - top;
    const rowH = Math.max(
      36,
      Math.min(56, Math.floor(available / Math.max(1, items.length)) - gap),
    );

    let y = top;
    this._rows = [];
    for (const item of items) {
      const rect = { x, y, w, h: rowH };
      p.add({
        id: `item:${item.id}`, kind: WIDGETS.LIST_ROW, shape: 'rect',
        ...rect, disabled: item.available === false,
      });
      this._rows.push({ item, rect, compact: rowH < 48 });
      y += rowH + gap;
    }
  }

  layoutCustom() {
    const p = this.panel;
    // Difficulty segment (still meaningful: it selects the AI tier the
    // ladders and match modes use).
    const segW = 180;
    for (let i = 0; i < this.difficulties.length; i++) {
      p.add({
        id: `diff:${i}`, kind: WIDGETS.SEGMENT, shape: 'rect',
        x: 620 + i * (segW / 1.6), y: 22, w: segW / 1.6 - 4, h: 36, index: i,
      });
    }

    // Zone grid, left column.
    this._zoneGrid = { x: 60, y: BODY_Y + 46, cell: 78, gap: 6 };
    const g = this._zoneGrid;
    for (let z = 1; z <= 9; z++) {
      const col = (z - 1) % 3;
      const row = Math.floor((z - 1) / 3);
      p.add({
        id: `zone:${z}`, kind: WIDGETS.BUTTON, shape: 'rect',
        x: g.x + col * (g.cell + g.gap),
        y: g.y + row * (g.cell + g.gap),
        w: g.cell, h: g.cell, zone: z,
      });
    }

    // Start / Save under the grid.
    const by = g.y + 3 * (g.cell + g.gap) + 24;
    p.add({ id: 'start', kind: WIDGETS.BUTTON, shape: 'rect', x: 60, y: by, w: 150, h: 52 });
    p.add({ id: 'save', kind: WIDGETS.BUTTON, shape: 'rect', x: 222, y: by, w: 130, h: 52 });

    // Field rows, right column.
    const fx = 400;
    const fw = CANVAS_W - fx - 60;
    const rowH = 40;
    let y = BODY_Y + 8;
    this._fieldRows = [];
    for (const field of CUSTOM_FIELDS) {
      if (field.kind === 'zoneGrid') continue;   // drawn as the grid
      const disabled = field.key === 'spinMagnitude' && !this.model.spinAmountEnabled;
      const row = { field, x: fx, y, w: fw, h: rowH, disabled };

      if (field.kind === 'slider') {
        p.add({
          id: `slider:${field.key}`, kind: WIDGETS.SLIDER, shape: 'rect',
          x: fx + 210, y: y + 12, w: fw - 300, h: 18,
          min: field.min, max: field.max, step: field.step,
          value: this.model.config[field.key], disabled,
        });
      } else if (field.kind === 'segment' || field.kind === 'burst') {
        p.add({
          id: `cycle:${field.key}:-1`, kind: WIDGETS.STEPPER, shape: 'rect',
          x: fx + 210, y: y + 4, w: 40, h: 32, delta: -1, disabled,
        });
        p.add({
          id: `cycle:${field.key}:1`, kind: WIDGETS.STEPPER, shape: 'rect',
          x: fx + fw - 60, y: y + 4, w: 40, h: 32, delta: 1, disabled,
        });
      } else if (field.kind === 'toggle') {
        p.add({
          id: `toggle:${field.key}`, kind: WIDGETS.TOGGLE, shape: 'rect',
          x: fx + 210, y: y + 4, w: 90, h: 32,
          value: this.model.config[field.key], disabled,
        });
      }
      this._fieldRows.push(row);
      y += rowH;
    }
  }

  // --- drawing --------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = COLORS.bg;
    roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 26);
    ctx.fill();

    this.drawHeader();
    if (this.model.screen === SCREENS.CUSTOM_FEED) this.drawCustom();
    else {
      this.drawList();
      if (this.model.screen === SCREENS.REVIEW) this.drawBladeHeatmap();
    }
    this.drawFooter();
    this.drawPoke();

    this.texture.needsUpdate = true;
  }

  drawHeader() {
    const ctx = this.ctx;
    const hov = this.panel.hoveredId;

    const back = this.panel.get('back');
    if (back) {
      ctx.fillStyle = hov === 'back' ? COLORS.panelHover : COLORS.panel;
      roundRect(ctx, back.x, back.y, back.w, back.h, 20);
      ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.font = F(600, 18);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.model.canGoBack ? '‹ BACK' : '✕ CLOSE',
        back.x + back.w / 2, back.y + back.h / 2);
    }

    ctx.fillStyle = COLORS.accent;
    ctx.font = F(700, 30);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.model.title, 170, 40);

    ctx.fillStyle = COLORS.muted;
    ctx.font = F(500, 15);
    ctx.fillText(this.model.breadcrumb, 170, 64);

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(24, HEADER_H);
    ctx.lineTo(CANVAS_W - 24, HEADER_H);
    ctx.stroke();
  }

  drawList() {
    const ctx = this.ctx;
    const hov = this.panel.hoveredId;
    for (const { item, rect, compact } of this._rows || []) {
      const disabled = item.available === false;
      const hovered = hov === `item:${item.id}` && !disabled;

      ctx.fillStyle = hovered ? COLORS.panelHover : COLORS.panel;
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 12);
      ctx.fill();

      if (hovered) {
        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = disabled ? COLORS.disabled : COLORS.text;
      ctx.font = F(600, compact ? 19 : 22);
      const sub = item.subtitle || item.note;
      // In compact rows there is no room for two stacked lines, so the
      // subtitle moves to the right of the label rather than being clipped.
      const stacked = sub && !compact;
      ctx.fillText(item.label, rect.x + 22, rect.y + (stacked ? 20 : rect.h / 2));

      if (sub) {
        ctx.fillStyle = disabled ? COLORS.disabled : COLORS.muted;
        ctx.font = F(500, compact ? 13 : 15);
        if (stacked) {
          ctx.fillText(sub, rect.x + 22, rect.y + 41);
        } else {
          ctx.textAlign = 'right';
          ctx.fillText(sub, rect.x + rect.w - 46, rect.y + rect.h / 2);
          ctx.textAlign = 'left';
        }
      }

      if (item.screen) {
        ctx.fillStyle = disabled ? COLORS.disabled : COLORS.muted;
        ctx.font = F(600, 22);
        ctx.textAlign = 'right';
        ctx.fillText('›', rect.x + rect.w - 22, rect.y + rect.h / 2);
      }
    }
  }

  drawCustom() {
    const ctx = this.ctx;
    const hov = this.panel.hoveredId;
    const cfg = this.model.config;

    // Difficulty segment.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.difficulties.length; i++) {
      const w = this.panel.get(`diff:${i}`);
      if (!w) continue;
      const on = i === this.difficultyIndex;
      ctx.fillStyle = on ? COLORS.accent : (hov === w.id ? COLORS.panelHover : COLORS.panel);
      roundRect(ctx, w.x, w.y, w.w, w.h, 16);
      ctx.fill();
      ctx.fillStyle = on ? '#0e1116' : COLORS.muted;
      ctx.font = F(600, 12);
      ctx.fillText(this.difficulties[i].label, w.x + w.w / 2, w.y + w.h / 2);
    }

    // Zone grid.
    const g = this._zoneGrid;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.muted;
    ctx.font = F(600, 15);
    ctx.fillText('PLACEMENT  (near net → your end)', g.x, g.y - 22);

    const activeZone = this.model.zone;
    for (let z = 1; z <= 9; z++) {
      const w = this.panel.get(`zone:${z}`);
      if (!w) continue;
      const on = z === activeZone;
      ctx.fillStyle = on ? COLORS.accent : (hov === w.id ? COLORS.panelHover : COLORS.panel);
      roundRect(ctx, w.x, w.y, w.w, w.h, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = on ? '#0e1116' : COLORS.muted;
      ctx.font = F(700, 20);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(z), w.x + w.w / 2, w.y + w.h / 2);
    }

    // Start / Save.
    const start = this.panel.get('start');
    if (start) {
      ctx.fillStyle = hov === 'start' ? '#5ef0b0' : COLORS.accent;
      roundRect(ctx, start.x, start.y, start.w, start.h, 26);
      ctx.fill();
      ctx.fillStyle = '#0e1116';
      ctx.font = F(700, 22);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('START', start.x + start.w / 2, start.y + start.h / 2);
    }
    const save = this.panel.get('save');
    if (save) {
      ctx.fillStyle = hov === 'save' ? COLORS.panelHover : COLORS.panel;
      roundRect(ctx, save.x, save.y, save.w, save.h, 26);
      ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.font = F(600, 18);
      ctx.fillText('SAVE', save.x + save.w / 2, save.y + save.h / 2);
    }

    if (this.model.message) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = F(500, 15);
      ctx.textAlign = 'left';
      ctx.fillText(this.model.message, 60, save.y + save.h + 24);
    }

    // Field rows.
    for (const row of this._fieldRows || []) {
      const { field } = row;
      const dim = row.disabled;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = dim ? COLORS.disabled : COLORS.text;
      ctx.font = F(600, 17);
      ctx.fillText(field.label, row.x, row.y + row.h / 2);

      ctx.fillStyle = dim ? COLORS.disabled : COLORS.accent;
      ctx.font = F(600, 16);
      ctx.textAlign = 'right';
      ctx.fillText(formatField(field, cfg), row.x + row.w, row.y + row.h / 2);

      if (field.kind === 'slider') {
        const w = this.panel.get(`slider:${field.key}`);
        if (w) {
          ctx.fillStyle = COLORS.track;
          roundRect(ctx, w.x, w.y + 6, w.w, 6, 3);
          ctx.fill();
          const f = sliderFraction(cfg[field.key], w);
          ctx.fillStyle = dim ? COLORS.disabled : COLORS.accent;
          roundRect(ctx, w.x, w.y + 6, Math.max(6, w.w * f), 6, 3);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(w.x + w.w * f, w.y + 9, hov === w.id ? 11 : 9, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (field.kind === 'segment' || field.kind === 'burst') {
        for (const dir of [-1, 1]) {
          const w = this.panel.get(`cycle:${field.key}:${dir}`);
          if (!w) continue;
          ctx.fillStyle = hov === w.id ? COLORS.panelHover : COLORS.panel;
          roundRect(ctx, w.x, w.y, w.w, w.h, 16);
          ctx.fill();
          ctx.fillStyle = dim ? COLORS.disabled : COLORS.text;
          ctx.font = F(700, 18);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(dir < 0 ? '‹' : '›', w.x + w.w / 2, w.y + w.h / 2);
        }
      } else if (field.kind === 'toggle') {
        const w = this.panel.get(`toggle:${field.key}`);
        if (w) {
          const on = !!cfg[field.key];
          ctx.fillStyle = on ? COLORS.accent : COLORS.panel;
          roundRect(ctx, w.x, w.y, w.w, w.h, 16);
          ctx.fill();
          ctx.fillStyle = on ? '#0e1116' : COLORS.muted;
          ctx.font = F(600, 14);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(on ? 'ON' : 'OFF', w.x + w.w / 2, w.y + w.h / 2);
        }
      }
    }
  }

  /**
   * M7 Blade Heatmap — contact-point density on the paddle face.
   *
   * Drawn beside the weakness list rather than as a row, because it is the
   * one piece of M7 that is genuinely spatial: "your contacts cluster low and
   * toward the handle" is a picture, and rendering it as a sentence throws
   * away what makes it useful.
   */
  drawBladeHeatmap() {
    const log = this.model.getSessionLog ? this.model.getSessionLog() : null;
    if (!log) return;
    const points = log.contactPoints();
    if (points.length === 0) return;

    const ctx = this.ctx;
    const map = bladeHeatmap(points, { bins: 9 });
    const size = 168;
    const x = CANVAS_W - size - 60;
    const y = BODY_Y + 16;

    ctx.fillStyle = COLORS.muted;
    ctx.font = F(600, 14);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('BLADE CONTACT', x, y - 10);

    // Face backdrop.
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, x, y, size, size, 12);
    ctx.fill();

    const cell = size / map.bins;
    const peak = Math.max(1, map.hotspot ? map.hotspot.count : 1);
    for (let iy = 0; iy < map.bins; iy++) {
      for (let ix = 0; ix < map.bins; ix++) {
        const n = map.grid[iy][ix];
        if (n === 0) continue;
        // Row 0 of the grid is the BOTTOM of the blade (local y = -extent),
        // and canvas y grows downward, so rows are drawn inverted — without
        // this the heatmap is vertically mirrored and "low" reads as "high".
        const px = x + ix * cell;
        const py = y + (map.bins - 1 - iy) * cell;
        ctx.fillStyle = `rgba(61,220,151,${0.18 + 0.72 * (n / peak)})`;
        ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
      }
    }

    // Blade centre, so the offset is readable against a reference.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + size / 2, y);
    ctx.lineTo(x + size / 2, y + size);
    ctx.moveTo(x, y + size / 2);
    ctx.lineTo(x + size, y + size / 2);
    ctx.stroke();

    ctx.fillStyle = COLORS.muted;
    ctx.font = F(500, 13);
    let note = `${map.total} contacts`;
    if (map.offBlade > 0) note += ` · ${map.offBlade} off blade`;
    ctx.fillText(note, x, y + size + 20);
  }

  drawFooter() {
    const ctx = this.ctx;
    const hov = this.panel.hoveredId;
    const labels = { calibrate: 'CALIBRATE', tune: 'PHYSICS', exit: 'CLOSE' };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const id of ['calibrate', 'tune', 'exit']) {
      const w = this.panel.get(`footer:${id}`);
      if (!w) continue;
      const isExit = id === 'exit';
      ctx.fillStyle = hov === w.id
        ? (isExit ? 'rgba(255,120,120,0.16)' : COLORS.panelHover)
        : COLORS.panel;
      roundRect(ctx, w.x, w.y, w.w, w.h, 24);
      ctx.fill();
      ctx.fillStyle = isExit ? COLORS.warn : COLORS.text;
      ctx.font = F(600, 16);
      ctx.fillText(labels[id], w.x + w.w / 2, w.y + w.h / 2);
    }
  }

  drawPoke() {
    if (!this.pokeCursor) return;
    const { u, v, proximity } = this.pokeCursor;
    const px = u * CANVAS_W;
    const py = (1 - v) * CANVAS_H;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(px, py, 10 + 14 * (1 - (proximity || 0)), 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}
