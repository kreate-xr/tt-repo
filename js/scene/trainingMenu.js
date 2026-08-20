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
import { Panel, WIDGETS } from './panelKit.js';
import { COLORS, F, roundRect } from './panelStyle.js';
import { layoutFeedEditor, drawFeedEditor } from './feedEditor.js';
import { TrainingMenuModel, SCREENS } from '../modes/training/menuModel.js';
import { bladeHeatmap } from '../modes/training/analysis.js';

const CANVAS_W = 1024;
const CANVAS_H = 640;

export const PLANE_W = 1.40;
export const PLANE_H = PLANE_W * (CANVAS_H / CANVAS_W);

const HEADER_H = 76;
const FOOTER_Y = CANVAS_H - 74;
const BODY_Y = HEADER_H + 12;

// Footer shortcuts, left to right. Four 200px buttons plus three 24px gaps is
// 872px inside a 1024px canvas, so they stay centred with a comfortable
// margin; adding a fifth would need the width reduced.
const FOOTER_IDS = ['settings', 'calibrate', 'tune', 'exit'];

export class TrainingMenu {
  constructor({ presets = null, settings = null, difficulties = null,
    getSessionLog = null, getRecentContacts = null } = {}) {
    this.model = new TrainingMenuModel({
      presets, settings, getSessionLog, getRecentContacts,
    });
    this.panel = new Panel({ width: CANVAS_W, height: CANVAS_H });
    this.listeners = new Map();
    this.pokeCursor = null;
    // Host-injected `(config) => warning|null`, run after Custom Feed edits so
    // an unfeedable config is called out on the panel, not just in-drill.
    this.feasibilityProbe = null;
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

  setFeasibilityProbe(fn) { this.feasibilityProbe = fn; }

  _refreshFeasibility() {
    if (!this.feasibilityProbe || this.model.screen !== SCREENS.CUSTOM_FEED) return;
    try {
      this.model.message = this.feasibilityProbe(this.model.config) || null;
    } catch (e) {
      console.error('feasibility probe threw:', e);
    }
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
    // Settings live INSIDE this menu rather than in a panel of their own, so
    // this navigates instead of emitting. Guarded against stacking a second
    // copy when the player taps SETTINGS while already on it.
    if (id === 'footer:settings') {
      if (m.screen === SCREENS.SETTINGS) return undefined;
      m.navigate(SCREENS.SETTINGS);
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
      this._refreshFeasibility();
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

    if (id.startsWith('zone:')) {
      m.setZone(Number(id.slice(5)));
      this._refreshFeasibility();
      return this.rebuild();
    }
    if (id.startsWith('cycle:')) {
      const [, key, dir] = id.split(':');
      if (key === 'burstCount') m.stepBurst(Number(dir));
      else m.cycleField(key, Number(dir));
      this._refreshFeasibility();
      return this.rebuild();
    }
    if (id.startsWith('toggle:')) {
      const key = id.slice(7);
      m.setField(key, !m.config[key]);
      this._refreshFeasibility();
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
    this._refreshFeasibility();
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
    const total = fw * FOOTER_IDS.length + gap * (FOOTER_IDS.length - 1);
    let fx = (CANVAS_W - total) / 2;
    for (const id of FOOTER_IDS) {
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
    // The editor itself is shared with the Machine Play menu's settings
    // screen (scene/feedEditor.js). The difficulty segment rides along here
    // because it is still meaningful on this screen: it selects the AI tier
    // the ladders and match modes use.
    this._editor = layoutFeedEditor(this.panel, {
      model: this.model,
      difficulties: this.difficulties,
      canvasW: CANVAS_W,
      bodyY: BODY_Y,
      showSave: true,
    });
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
    if (!this._editor) return;
    drawFeedEditor(this.ctx, this.panel, {
      model: this.model,
      layout: this._editor,
      difficulties: this.difficulties,
      difficultyIndex: this.difficultyIndex,
      startLabel: 'START',
    });
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
    const labels = {
      settings: 'SETTINGS', calibrate: 'CALIBRATE', tune: 'PHYSICS', exit: 'CLOSE',
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const id of FOOTER_IDS) {
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
