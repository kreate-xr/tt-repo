// Machine Play menu — the renderer.
//
// Opened by the wrist menu's PLAY tile. Draws whatever MachinePlayModel
// reports and routes input back to it; all navigation and config editing lives
// in the model, and the settings screen is the shared feed editor
// (scene/feedEditor.js) that Custom Feed uses.
//
// Exposes exactly the surface inGame.js drives a panel through — mesh / show /
// hide / isVisible / on / setHovered / selectHovered / setPokeCursor /
// clearPokeCursor / hitTestUV / sliderAt / dragAt / update / dispose — so it
// rides the existing currentTuner machinery with no new input plumbing.

import * as THREE from 'three';
import { playMenuHoverTick, playMenuSelectClick } from './audio.js';
import * as haptics from '../xr/haptics.js';
import { Panel, WIDGETS } from './panelKit.js';
import { COLORS, F, roundRect } from './panelStyle.js';
import { layoutFeedEditor, drawFeedEditor } from './feedEditor.js';
import { ENDLESS_FEED_FIELDS } from '../modes/training/feedConfigModel.js';
import { MachinePlayModel, SCREENS } from '../modes/machinePlay/machinePlayModel.js';

const CANVAS_W = 1024;
const CANVAS_H = 640;

export const PLANE_W = 1.40;
export const PLANE_H = PLANE_W * (CANVAS_H / CANVAS_W);

const HEADER_H = 76;
const FOOTER_Y = CANVAS_H - 74;
const BODY_Y = HEADER_H + 12;

export class MachinePlayMenu {
  constructor() {
    this.model = new MachinePlayModel();
    this.panel = new Panel({ width: CANVAS_W, height: CANVAS_H });
    this.listeners = new Map();
    this.pokeCursor = null;
    // Host-injected `(config) => warning|null`. Same probe the training menu
    // uses: an unfeedable config is called out on the panel rather than only
    // revealing itself in-play as a machine that silently never fires.
    this.feasibilityProbe = null;

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

  // --- host interface --------------------------------------------------------

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
    // Remember where the ray is pointing. setHovered() only receives an id, so
    // without this a slider press would know WHICH slider but not WHERE along
    // it — and would have nothing to set the value from.
    this._lastUV = { u, v };
    return this.panel.hitTestUV(u, v);
  }

  setFeasibilityProbe(fn) { this.feasibilityProbe = fn; }

  _refreshFeasibility() {
    if (!this.feasibilityProbe || this.model.screen !== SCREENS.SETTINGS) return;
    try {
      this.model.message = this.feasibilityProbe(this.model.config) || null;
    } catch (e) {
      console.error('feasibility probe threw:', e);
    }
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

  // --- input handling --------------------------------------------------------

  handle(id) {
    const m = this.model;

    if (id === 'back') {
      // At the root there is nowhere to pop, so backing out closes this menu
      // and returns to the wrist menu, which is left exactly as it was.
      if (!m.back()) { this.emit('back'); return undefined; }
      return this.rebuild();
    }
    if (id === 'footer:calibrate') return this.emit('calibrate');
    if (id === 'footer:tune') return this.emit('tune');
    // "CLOSE" rather than "EXIT": this returns to the wrist menu; it does not
    // end the XR session.
    if (id === 'footer:exit') return this.emit('back');

    if (id.startsWith('item:')) {
      const res = m.selectItem(id.slice(5));
      if (res && res.action === 'freeHit') return this.emit('freeHit');
      if (res && res.action === 'start') return this.start(res);
      this._refreshFeasibility();
      return this.rebuild();
    }

    // START on the settings screen plays the edited feed straight away, so a
    // config never has to be carried back to the root to be used.
    if (id === 'start') return this.start(m.startFromSettings());

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
      m.cycleField(key, Number(dir));
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

  start({ mode, config, target }) {
    this.emit('start', { mode, config, target });
  }

  /**
   * Slider drag, driven by the host while the trigger is held.
   *
   * `sliderId` pins the drag to the slider that was originally grabbed —
   * re-hit-testing every frame would hand control to whatever the ray happens
   * to be over, and the track is only ~18 px tall.
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

  rebuild() { this.layout(); this.draw(); }

  // --- layout ----------------------------------------------------------------

  layout() {
    const p = this.panel;
    p.clear();

    // Back / close, always present so there is never a dead end.
    p.add({ id: 'back', kind: WIDGETS.BUTTON, shape: 'rect', x: 24, y: 20, w: 120, h: 40 });

    if (this.model.screen === SCREENS.SETTINGS) this.layoutSettings();
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
    const gap = 8;
    const x = 80;
    const w = CANVAS_W - 160;
    const top = BODY_Y + 12;

    // Row height is DERIVED from the space between header and footer, never
    // fixed. The training menu shipped with fixed rows and its last two items
    // ended up underneath the footer — which wins the hit test, so those rows
    // silently activated the wrong button. Fitting to the available height
    // makes that impossible rather than merely unlikely.
    const available = (FOOTER_Y - 18) - top;
    const rowH = Math.max(
      44,
      Math.min(72, Math.floor(available / Math.max(1, items.length)) - gap),
    );

    let y = top;
    this._rows = [];
    for (const item of items) {
      const rect = { x, y, w, h: rowH };
      p.add({
        id: `item:${item.id}`, kind: WIDGETS.LIST_ROW, shape: 'rect',
        ...rect, disabled: item.available === false,
      });
      this._rows.push({ item, rect, compact: rowH < 56 });
      y += rowH + gap;
    }
  }

  layoutSettings() {
    // No difficulty segment: nothing here runs an AI opponent, so a tier
    // control would be a widget with no effect. No Save either — presets are
    // the training menu's job, and this screen edits a live rally.
    this._editor = layoutFeedEditor(this.panel, {
      model: this.model,
      fields: ENDLESS_FEED_FIELDS,
      difficulties: null,
      canvasW: CANVAS_W,
      bodyY: BODY_Y,
      showSave: false,
    });
  }

  // --- drawing ---------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = COLORS.bg;
    roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 26);
    ctx.fill();

    this.drawHeader();
    if (this.model.screen === SCREENS.SETTINGS) this.drawSettings();
    else this.drawList();
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

    ctx.strokeStyle = COLORS.hairline;
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
      ctx.font = F(600, compact ? 20 : 23);
      const sub = item.subtitle || item.note;
      // In compact rows there is no room for two stacked lines, so the
      // subtitle moves to the right of the label rather than being clipped.
      const stacked = sub && !compact;
      ctx.fillText(item.label, rect.x + 22, rect.y + (stacked ? rect.h * 0.36 : rect.h / 2));

      if (sub) {
        ctx.fillStyle = disabled ? COLORS.disabled : COLORS.muted;
        ctx.font = F(500, compact ? 13 : 15);
        if (stacked) {
          ctx.fillText(sub, rect.x + 22, rect.y + rect.h * 0.68);
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

  drawSettings() {
    if (!this._editor) return;
    drawFeedEditor(this.ctx, this.panel, {
      model: this.model,
      layout: this._editor,
      difficulties: null,
      // "PLAY", not "START": this button begins a rally, and the same word the
      // drill menu uses would suggest it starts a counted set.
      startLabel: 'PLAY',
    });
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
        ? (isExit ? COLORS.warnHover : COLORS.panelHover)
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
