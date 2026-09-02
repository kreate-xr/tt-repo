// In-XR multiplayer lobby panel — create or join a room without leaving the
// headset. Before this panel the ONLY path into multiplayer was the 2D start
// screen (Create/Join there, then Enter MR with the connection already
// negotiated); tapping the wrist menu's MULTI tile in a solo session hit
// enterDrill's no-connection gate and bounced straight back to the menu,
// which read as a dead button.
//
// Same model/renderer split as trainingMenu.js: all lobby state and async
// handling lives in LobbyMenuModel (unit-tested headless); this file owns
// canvas drawing, the THREE mesh, and hit-region layout only. Exposes the
// same host surface as TrainingMenu — mesh / show / hide / isVisible / on /
// setHovered / selectHovered / setPokeCursor / clearPokeCursor / hitTestUV /
// update / dispose — so inGame.js's currentTuner machinery drives it
// unchanged.

import * as THREE from 'three';
import { playMenuHoverTick, playMenuSelectClick } from './audio.js';
import * as haptics from '../xr/haptics.js';
import { Panel } from './panelKit.js';
import { COLORS, F, roundRect } from './panelStyle.js';
import {
  LobbyMenuModel, MP_SCREENS, ROOM_CODE_ALPHABET, ROOM_CODE_LEN, BEST_OF_OPTIONS,
} from '../modes/multiplayer/lobbyMenuModel.js';
import { matchLengthLabel } from '../modes/matchFormat.js';

const CANVAS_W = 1024;
const CANVAS_H = 640;

export const PLANE_W = 1.40;
export const PLANE_H = PLANE_W * (CANVAS_H / CANVAS_W);

const HEADER_H = 76;

// Match-length row on the HOME screen: below the two cards (which end at 400)
// and clear of the status/error line the screen draws at 560.
const BEST_OF_ROW_Y = 462;

// Keyboard grid: the 32-character room-code alphabet as 4 rows of 8. Rendering
// exactly ROOM_CODE_ALPHABET (not a QWERTY layout) means every key is a legal
// code character and no key can ever be an invalid one.
const KEY_COLS = 8;
const KEY_ROWS = [];
for (let i = 0; i < ROOM_CODE_ALPHABET.length; i += KEY_COLS) {
  KEY_ROWS.push(ROOM_CODE_ALPHABET.slice(i, i + KEY_COLS).split(''));
}

const SUBTITLES = {
  [MP_SCREENS.HOME]: 'PLAY A FRIEND OVER THE NETWORK',
  [MP_SCREENS.HOSTING]: 'WAITING FOR YOUR OPPONENT',
  [MP_SCREENS.JOIN]: `ENTER THE ${ROOM_CODE_LEN}-CHARACTER ROOM CODE`,
  [MP_SCREENS.CONNECTING]: 'CONNECTING…',
};

export class MultiplayerMenu {
  constructor({ createLobby } = {}) {
    this.model = new LobbyMenuModel({
      createLobby,
      onChange: () => this.rebuild(),
      onConnected: (mp) => this.emit('connected', mp),
    });
    this.panel = new Panel({ width: CANVAS_W, height: CANVAS_H });
    this.listeners = new Map();
    this.pokeCursor = null;

    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Mipmaps + anisotropy, matching the other panels: without them the
    // canvas shimmers under XR minification.
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

    this.rebuild();
  }

  // --- host interface (mirrors TrainingMenu) --------------------------------

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) {
      try { fn(payload); } catch (e) { console.error(`menu handler "${event}" threw:`, e); }
    }
  }

  show() { this.mesh.visible = true; this.panel.show(); this.rebuild(); }

  hide() {
    this.mesh.visible = false;
    this.panel.hide();
    this.pokeCursor = null;
    // Closing the panel (BACK at root, A/X, session end) abandons whatever
    // attempt is still in flight — but a DELIVERED connection is owned by
    // inGame.js by then and must survive the panel closing behind it.
    if (!this.model.connected) this.model.cancel();
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
      // sub-menu and returns to the wrist menu. Deeper in, it pops one level
      // (and cancels the in-flight attempt if there is one).
      if (!m.back()) this.emit('back');
      return;
    }
    if (id === 'create') { m.startCreate(); return; }
    if (id === 'join') { m.openJoin(); return; }
    if (id === 'cancel') { m.cancel(); return; }
    if (id === 'submit') { m.startJoin(); return; }
    if (id === 'del') { m.backspace(); return; }
    if (id.startsWith('key:')) { m.appendChar(id.slice(4)); return; }
    if (id.startsWith('bo:')) { m.setBestOf(id.slice(3)); return; }
  }

  // --- layout ---------------------------------------------------------------

  rebuild() {
    const p = this.panel;
    const m = this.model;
    p.clear();

    p.add({ id: 'back', shape: 'rect', x: 24, y: 18, w: 130, h: 44, label: '◂ BACK' });

    if (m.screen === MP_SCREENS.HOME) {
      const cardW = 360, cardH = 230, gap = 48;
      const x0 = (CANVAS_W - cardW * 2 - gap) / 2;
      p.add({
        id: 'create', shape: 'rect', x: x0, y: 170, w: cardW, h: cardH,
        label: 'CREATE ROOM', sub: 'Get a code to share',
      });
      p.add({
        id: 'join', shape: 'rect', x: x0 + cardW + gap, y: 170, w: cardW, h: cardH,
        label: 'JOIN ROOM', sub: 'Enter a friend’s code',
      });
      // Match length, host side. Sits under BOTH cards rather than inside the
      // CREATE one because it is also the answer to "what am I about to
      // join?" — a guest reads it and knows the setting exists even though
      // theirs is overridden by whoever created the room.
      const boW = 160, boGap = 12;
      const boRowW = BEST_OF_OPTIONS.length * boW + (BEST_OF_OPTIONS.length - 1) * boGap;
      const bx0 = (CANVAS_W - boRowW) / 2;
      for (let i = 0; i < BEST_OF_OPTIONS.length; i++) {
        const n = BEST_OF_OPTIONS[i];
        p.add({
          id: 'bo:' + n, shape: 'rect', label: matchLengthLabel(n),
          x: bx0 + i * (boW + boGap), y: BEST_OF_ROW_Y, w: boW, h: 56,
          selected: m.bestOf === n,
        });
      }
    } else if (m.screen === MP_SCREENS.JOIN) {
      const KEY_W = 88, KEY_H = 54, KEY_GAP = 10;
      const rowW = KEY_COLS * KEY_W + (KEY_COLS - 1) * (KEY_GAP);
      const kx0 = (CANVAS_W - rowW) / 2;
      for (let r = 0; r < KEY_ROWS.length; r++) {
        for (let c = 0; c < KEY_ROWS[r].length; c++) {
          const ch = KEY_ROWS[r][c];
          p.add({
            id: 'key:' + ch, shape: 'rect', label: ch,
            x: kx0 + c * (KEY_W + KEY_GAP),
            y: 200 + r * (KEY_H + KEY_GAP),
            w: KEY_W, h: KEY_H,
          });
        }
      }
      const pairW = 180 + 16 + 240;
      const bx0 = (CANVAS_W - pairW) / 2;
      p.add({
        id: 'del', shape: 'rect', x: bx0, y: 474, w: 180, h: 56,
        label: '⌫ DELETE', disabled: m.codeEntry.length === 0,
      });
      p.add({
        id: 'submit', shape: 'rect', x: bx0 + 180 + 16, y: 474, w: 240, h: 56,
        label: 'JOIN', accent: true, disabled: !m.canJoin(),
      });
    } else {
      // HOSTING / CONNECTING both offer only CANCEL.
      p.add({
        id: 'cancel', shape: 'rect', x: (CANVAS_W - 240) / 2, y: 470, w: 240, h: 56,
        label: 'CANCEL', warn: true,
      });
    }

    this.draw();
  }

  // --- drawing --------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    const m = this.model;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 28);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();

    // Header
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = F(800, 30);
    ctx.fillText('MULTIPLAYER', CANVAS_W / 2, 34);
    ctx.fillStyle = COLORS.muted;
    ctx.font = F(600, 14);
    ctx.fillText(SUBTITLES[m.screen] || '', CANVAS_W / 2, 62);
    ctx.strokeStyle = COLORS.hairline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(24, HEADER_H);
    ctx.lineTo(CANVAS_W - 24, HEADER_H);
    ctx.stroke();

    // Screen-static content (code slots, status lines) under the widgets.
    if (m.screen === MP_SCREENS.HOSTING) this.drawHostCode();
    if (m.screen === MP_SCREENS.JOIN) this.drawEntrySlots();
    if (m.screen === MP_SCREENS.HOME) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = F(700, 15);
      ctx.fillText('MATCH LENGTH  —  APPLIES TO THE ROOM YOU CREATE', CANVAS_W / 2, BEST_OF_ROW_Y - 26);
    }
    // Hosting: the format is locked in now (a guest may already be joining on
    // it), so it is reported rather than offered. Without this the host has no
    // way to check what they set before someone walks into a best-of-5.
    if (m.screen === MP_SCREENS.HOSTING && m.hostBestOf) {
      ctx.fillStyle = COLORS.accentBright;
      ctx.font = F(700, 22);
      ctx.fillText(matchLengthLabel(m.hostBestOf), CANVAS_W / 2, 340);
    }
    if (m.screen === MP_SCREENS.CONNECTING && m.message) {
      ctx.fillStyle = COLORS.text;
      ctx.font = F(700, 26);
      ctx.fillText(m.message, CANVAS_W / 2, 300);
    }
    if (m.screen === MP_SCREENS.HOSTING && m.message) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = F(600, 20);
      ctx.fillText(m.message, CANVAS_W / 2, 396);
    }
    if (m.screen === MP_SCREENS.HOME && m.message) {
      ctx.fillStyle = COLORS.accent;
      ctx.font = F(600, 20);
      ctx.fillText(m.message, CANVAS_W / 2, 560);
    }
    if (m.error) {
      ctx.fillStyle = COLORS.warn;
      ctx.font = F(600, 19);
      ctx.fillText(m.error, CANVAS_W / 2, m.screen === MP_SCREENS.JOIN ? 172 : 560);
    }

    for (const w of this.panel.widgets) this.drawWidget(w);

    if (this.pokeCursor) this.drawPokeCursor();

    this.texture.needsUpdate = true;
  }

  drawWidget(w) {
    const ctx = this.ctx;
    const hovered = this.panel.hoveredId === w.id;
    const r = Math.min(16, w.h / 2);

    roundRect(ctx, w.x, w.y, w.w, w.h, r);
    // A selected segment is filled with the accent (same grammar as the wrist
    // menu's difficulty control) so the current choice reads at a glance
    // rather than being inferred from a subtle tint.
    if (w.disabled) ctx.fillStyle = COLORS.panel;
    else if (w.selected) ctx.fillStyle = COLORS.accent;
    else if (hovered) ctx.fillStyle = w.warn ? COLORS.warnHover : COLORS.panelHover;
    else ctx.fillStyle = COLORS.panel;
    ctx.fill();

    if (w.accent && !w.disabled) {
      roundRect(ctx, w.x, w.y, w.w, w.h, r);
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let color = COLORS.text;
    if (w.disabled) color = COLORS.disabled;
    else if (w.selected) color = '#0a1a12';   // dark ink on the accent fill
    else if (w.warn) color = COLORS.warn;
    else if (w.accent) color = COLORS.accentBright;

    if (w.sub) {
      // Two-line card (HOME screen).
      ctx.fillStyle = color;
      ctx.font = F(800, 28);
      ctx.fillText(w.label, w.x + w.w / 2, w.y + w.h / 2 - 18);
      ctx.fillStyle = COLORS.muted;
      ctx.font = F(600, 17);
      ctx.fillText(w.sub, w.x + w.w / 2, w.y + w.h / 2 + 22);
    } else {
      ctx.fillStyle = color;
      ctx.font = w.id.startsWith('key:') ? F(700, 26) : F(700, 20);
      // maxWidth so a long label ("SINGLE GAME" in a 160px segment) condenses
      // instead of painting past its own button — canvas has no overflow.
      ctx.fillText(w.label, w.x + w.w / 2, w.y + w.h / 2 + 1, w.w - 18);
    }
  }

  /** Six large boxes showing the code being hosted (HOSTING screen). */
  drawHostCode() {
    const ctx = this.ctx;
    const code = this.model.hostCode || '';
    const BOX_W = 92, BOX_H = 116, GAP = 14;
    const total = ROOM_CODE_LEN * BOX_W + (ROOM_CODE_LEN - 1) * GAP;
    const x0 = (CANVAS_W - total) / 2;
    const y = 180;

    ctx.fillStyle = COLORS.muted;
    ctx.font = F(700, 15);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ROOM CODE', CANVAS_W / 2, 140);

    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      const x = x0 + i * (BOX_W + GAP);
      roundRect(ctx, x, y, BOX_W, BOX_H, 14);
      ctx.fillStyle = COLORS.panel;
      ctx.fill();
      roundRect(ctx, x, y, BOX_W, BOX_H, 14);
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (code[i]) {
        ctx.fillStyle = COLORS.accentBright;
        ctx.font = F(800, 64);
        ctx.fillText(code[i], x + BOX_W / 2, y + BOX_H / 2 + 3);
      }
    }
  }

  /** Six entry slots above the keyboard (JOIN screen). */
  drawEntrySlots() {
    const ctx = this.ctx;
    const entry = this.model.codeEntry;
    const SLOT_W = 64, SLOT_H = 76, GAP = 12;
    const total = ROOM_CODE_LEN * SLOT_W + (ROOM_CODE_LEN - 1) * GAP;
    const x0 = (CANVAS_W - total) / 2;
    const y = 92;

    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      const x = x0 + i * (SLOT_W + GAP);
      roundRect(ctx, x, y, SLOT_W, SLOT_H, 12);
      ctx.fillStyle = COLORS.panel;
      ctx.fill();
      roundRect(ctx, x, y, SLOT_W, SLOT_H, 12);
      // The next slot to fill carries the accent ring — a cursor without
      // a blinking caret, which a canvas redrawn on events can't animate.
      ctx.strokeStyle = i === entry.length ? COLORS.accent : COLORS.hairline;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (entry[i]) {
        ctx.fillStyle = COLORS.text;
        ctx.font = F(800, 40);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(entry[i], x + SLOT_W / 2, y + SLOT_H / 2 + 2);
      }
    }
  }

  drawPokeCursor() {
    const ctx = this.ctx;
    const { u, v, proximity } = this.pokeCursor;
    const cx = u * CANVAS_W;
    const cy = (1 - v) * CANVAS_H;
    const pr = Math.max(0, Math.min(1, proximity));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 26 - 12 * pr);
    g.addColorStop(0, `rgba(61,220,151,${0.55 * (0.5 + 0.5 * pr)})`);
    g.addColorStop(1, 'rgba(61,220,151,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, 26 - 12 * pr, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
