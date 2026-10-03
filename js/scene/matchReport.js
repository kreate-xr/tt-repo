// End-of-match report panel — the mesh + input half of matchReportLayout.js.
//
// Same shape as the other in-XR panels (see trainingMenu.js): a canvas
// texture on a plane, a panelKit Panel for hit geometry, and the
// mesh/hovered/hitTestUV/setHovered/selectHovered surface inGame.js routes the
// laser through. Both match modes construct one at drill start (hidden) and
// show it when the match ends.
//
// The panel is deliberately NOT the wall scoreboard in a different costume:
// the board sits behind the opponent's baseline where a laser can't
// comfortably reach, and this card carries buttons.

import * as THREE from 'three';
import { Panel, WIDGETS } from './panelKit.js';
import { PLANE_W as MENU_PLANE_W } from './wristMenu.js';
import { playMenuHoverTick, playMenuSelectClick } from './audio.js';
import * as haptics from '../xr/haptics.js';
import {
  REPORT_W, REPORT_H, createReportModel, renderMatchReport, reportButtonRects,
} from './matchReportLayout.js';

// Same physical screen as the wrist menu and the multiplayer lobby — imported
// rather than restated so all three stay one size — and, via `staticPlacement`
// below, the same fixed world anchor above the net. Drill panels are
// head-billboarded at 1.1 m by default, which is right for a transient in-play
// tool and wrong for something you read: the card followed the player's gaze
// and sat somewhere no other panel in the game appears.
const PLANE_W = MENU_PLANE_W;
const PLANE_H = PLANE_W * (REPORT_H / REPORT_W);

export class MatchReport {
  constructor(model = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = REPORT_W;
    this.canvas.height = REPORT_H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
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
    // Read by inGame.js's updateMenuPlacement: pin this panel to the menus'
    // fixed world anchor instead of billboarding it in front of the headset.
    this.staticPlacement = true;

    this.panel = new Panel({ width: REPORT_W, height: REPORT_H });
    this.model = createReportModel(model);
    this.listeners = new Map();

    this.layout();
    this.draw();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      // One throwing handler must not stop the others — the same rule
      // panelKit's own emit follows.
      try { fn(payload); } catch (e) { console.error(`matchReport "${event}" threw:`, e); }
    }
  }

  /** Patch the card's data and redraw. Button changes relayout the hit rects. */
  setModel(patch) {
    Object.assign(this.model, patch);
    this.layout();
    this.draw();
  }

  layout() {
    this.panel.clear();
    const rects = reportButtonRects(this.model.buttons.length);
    for (let i = 0; i < this.model.buttons.length; i++) {
      const b = this.model.buttons[i];
      const r = rects[i];
      this.panel.add({
        id: b.id, kind: WIDGETS.BUTTON, shape: 'rect',
        x: r.x, y: r.y, w: r.w, h: r.h,
        disabled: !!b.disabled,
      });
    }
  }

  draw() {
    this.model.hoveredId = this.panel.hoveredId;
    renderMatchReport(this.ctx, this.model);
    this.texture.needsUpdate = true;
  }

  show() {
    this.mesh.visible = true;
    this.panel.show();
    this.draw();
  }

  hide() {
    this.mesh.visible = false;
    this.panel.hide();
  }

  isVisible() { return this.mesh.visible; }

  // inGame.js reads this to decide whether a trigger press belongs to the
  // panel or to drill gameplay.
  get hovered() { return this.panel.hoveredId; }

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
    const widget = this.panel.get(id);
    if (!widget || widget.disabled) return false;
    try { playMenuSelectClick(); } catch (e) { /* audio optional */ }
    haptics.pulseActive(0.3, 25);
    this.emit(id, { id });
    return true;
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.listeners.clear();
  }
}

export function createMatchReport(model = {}) {
  return new MatchReport(model);
}
