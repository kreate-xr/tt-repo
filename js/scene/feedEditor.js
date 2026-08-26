// The feed editor — zone grid + attribute rows for one DrillConfig.
//
// This is the Ball Machine screen. It once had a twin (the Machine Play
// menu's "Rally Settings") which is why layout options like showSave exist;
// any future second host must keep editing the same object with the same
// validator (see modes/training/feedConfigModel.js) and draw with this code,
// so the two screens can never disagree about which controls exist, which
// range a slider covers, or when spin amount is dimmed.
//
// Split the same way panelKit is: layout is pure arithmetic over widget rects
// and is therefore testable headless; drawing is ctx calls and is not. Both
// take an explicit geometry so a panel with a different canvas size or header
// height can host the editor without this module knowing about either.
//
// Widget ids are part of the contract — `zone:5`, `slider:speed`,
// `cycle:arc:1`, `toggle:audioCue`, `start`, `save`, `diff:0` — because the
// host panel routes input by id and its tests click by id.

import { WIDGETS, sliderFraction } from './panelKit.js';
import { COLORS, F, roundRect } from './panelStyle.js';
import { CUSTOM_FIELDS, formatField } from '../modes/training/feedConfigModel.js';

const ZONE_CELL = 78;
const ZONE_GAP = 6;
const FIELD_ROW_H = 40;
const CONTROL_INSET = 210;   // label column width before a control starts

/**
 * Register the editor's widgets on a Panel.
 *
 * @param {Panel} panel          scene-free widget registry to add to
 * @param {object} opts
 * @param {object} opts.model    a FeedConfigModel (config + spinAmountEnabled)
 * @param {Array}  opts.fields   attribute list; defaults to the full M1 table
 * @param {Array}  opts.difficulties  tier list, or null to omit the segment
 * @param {number} opts.canvasW  panel width in canvas px
 * @param {number} opts.bodyY    first usable y below the panel header
 * @param {boolean} opts.showSave  whether to register the Save button
 * @param {boolean} opts.presetRow  register the ‹ preset › cycler above the
 *          zone grid
 * @param {boolean} opts.endRow  register the ‹ end-condition › cycler as the
 *          last attribute row (how the session ends: drill / survival / race)
 * @returns {{zoneGrid: object, fieldRows: Array, buttonsY: number,
 *          presetY: (number|null), endRow: (object|null)}} geometry the draw
 *          pass needs; the host should keep it until the next layout.
 */
export function layoutFeedEditor(panel, {
  model,
  fields = CUSTOM_FIELDS,
  difficulties = null,
  canvasW = 1024,
  bodyY = 88,
  showSave = true,
  presetRow = false,
  endRow = false,
} = {}) {
  // Difficulty segment. Meaningful wherever an AI tier is in play (ladders,
  // match modes); panels with no tier concept pass null and get no row.
  // Right-aligned in the header, sized so "INTERNATIONAL" fits without
  // shrinking the font below legible — at the old 112 px per segment it
  // was drawn at 12 px and still brushed the segment edges.
  if (difficulties && difficulties.length) {
    const segW = 150;
    const segX0 = canvasW - 24 - difficulties.length * segW;
    for (let i = 0; i < difficulties.length; i++) {
      panel.add({
        id: `diff:${i}`, kind: WIDGETS.SEGMENT, shape: 'rect',
        x: segX0 + i * segW, y: 20, w: segW - 4, h: 40, index: i,
      });
    }
  }

  // Preset cycler, top of the left column: ‹ name ›. Registered before the
  // grid so the flow reads "pick a starting point, then tweak". The steppers
  // reuse the cycle:* stepper look; the name between them is drawn text.
  const gridW = 3 * ZONE_CELL + 2 * ZONE_GAP;
  let presetY = null;
  if (presetRow) {
    presetY = bodyY;
    panel.add({
      id: 'preset:-1', kind: WIDGETS.STEPPER, shape: 'rect',
      x: 60, y: presetY, w: 40, h: 32, delta: -1,
    });
    panel.add({
      id: 'preset:1', kind: WIDGETS.STEPPER, shape: 'rect',
      x: 60 + gridW - 40, y: presetY, w: 40, h: 32, delta: 1,
    });
  }

  // Zone grid, left column — pushed down when the preset row is present.
  const zoneGrid = {
    x: 60, y: bodyY + 46 + (presetRow ? 44 : 0), cell: ZONE_CELL, gap: ZONE_GAP,
  };
  for (let z = 1; z <= 9; z++) {
    const col = (z - 1) % 3;
    const row = Math.floor((z - 1) / 3);
    panel.add({
      id: `zone:${z}`, kind: WIDGETS.BUTTON, shape: 'rect',
      x: zoneGrid.x + col * (zoneGrid.cell + zoneGrid.gap),
      y: zoneGrid.y + row * (zoneGrid.cell + zoneGrid.gap),
      w: zoneGrid.cell, h: zoneGrid.cell, zone: z,
    });
  }

  // Start / Save under the grid.
  const buttonsY = zoneGrid.y + 3 * (zoneGrid.cell + zoneGrid.gap) + 24;
  panel.add({ id: 'start', kind: WIDGETS.BUTTON, shape: 'rect', x: 60, y: buttonsY, w: 150, h: 52 });
  if (showSave) {
    panel.add({ id: 'save', kind: WIDGETS.BUTTON, shape: 'rect', x: 222, y: buttonsY, w: 130, h: 52 });
  }

  // Attribute rows, right column.
  const fx = 400;
  const fw = canvasW - fx - 60;
  let y = bodyY + 8;
  const fieldRows = [];
  for (const field of fields) {
    if (field.kind === 'zoneGrid') continue;   // drawn as the grid
    // A spin AMOUNT with no spin TYPE is meaningless, so the control is
    // registered disabled rather than omitted — a row that vanishes and
    // reappears makes the list jump under the pointer. Same treatment for a
    // Balls count under an end condition that owns its own ending.
    const disabled = (field.key === 'spinMagnitude' && !model.spinAmountEnabled)
      || (field.key === 'burstCount' && model.burstEnabled === false);
    fieldRows.push({ field, x: fx, y, w: fw, h: FIELD_ROW_H, disabled });

    if (field.kind === 'slider') {
      panel.add({
        id: `slider:${field.key}`, kind: WIDGETS.SLIDER, shape: 'rect',
        x: fx + CONTROL_INSET, y: y + 12, w: fw - 300, h: 18,
        min: field.min, max: field.max, step: field.step,
        value: model.config[field.key], disabled,
      });
    } else if (field.kind === 'segment' || field.kind === 'burst') {
      panel.add({
        id: `cycle:${field.key}:-1`, kind: WIDGETS.STEPPER, shape: 'rect',
        x: fx + CONTROL_INSET, y: y + 4, w: 40, h: 32, delta: -1, disabled,
      });
      panel.add({
        id: `cycle:${field.key}:1`, kind: WIDGETS.STEPPER, shape: 'rect',
        x: fx + fw - 60, y: y + 4, w: 40, h: 32, delta: 1, disabled,
      });
    } else if (field.kind === 'toggle') {
      panel.add({
        id: `toggle:${field.key}`, kind: WIDGETS.TOGGLE, shape: 'rect',
        x: fx + CONTROL_INSET, y: y + 4, w: 90, h: 32,
        value: model.config[field.key], disabled,
      });
    }
    y += FIELD_ROW_H;
  }

  // End-condition cycler, styled as one more attribute row at the bottom of
  // the column: how the session ends is a property of the feed being set up,
  // and drawing it anywhere else would suggest otherwise.
  let endRowRect = null;
  if (endRow) {
    endRowRect = { x: fx, y, w: fw, h: FIELD_ROW_H };
    panel.add({
      id: 'end:-1', kind: WIDGETS.STEPPER, shape: 'rect',
      x: fx + CONTROL_INSET, y: y + 4, w: 40, h: 32, delta: -1,
    });
    panel.add({
      id: 'end:1', kind: WIDGETS.STEPPER, shape: 'rect',
      x: fx + fw - 60, y: y + 4, w: 40, h: 32, delta: 1,
    });
  }

  return { zoneGrid, fieldRows, buttonsY, presetY, endRow: endRowRect };
}

/**
 * Draw the editor registered by layoutFeedEditor.
 *
 * `layout` must be the object that call returned — the draw pass reads its
 * rects rather than recomputing them, so the two can never disagree about
 * where a row is.
 */
export function drawFeedEditor(ctx, panel, {
  model,
  layout,
  difficulties = null,
  difficultyIndex = 0,
  startLabel = 'START',
  zoneCaption = 'PLACEMENT  (near net → your end)',
  presetLabel = null,
  endLabel = null,
} = {}) {
  const hov = panel.hoveredId;
  const cfg = model.config;

  // Preset cycler (only when the layout registered one).
  if (layout.presetY != null) {
    for (const dir of [-1, 1]) {
      const w = panel.get(`preset:${dir}`);
      if (!w) continue;
      ctx.fillStyle = hov === w.id ? COLORS.panelHover : COLORS.panel;
      roundRect(ctx, w.x, w.y, w.w, w.h, 16);
      ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.font = F(700, 18);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dir < 0 ? '‹' : '›', w.x + w.w / 2, w.y + w.h / 2);
    }
    const left = panel.get('preset:-1');
    const right = panel.get('preset:1');
    if (left && right) {
      const cx = (left.x + right.x + right.w) / 2;
      ctx.fillStyle = COLORS.accent;
      ctx.font = F(600, 16);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(presetLabel || 'Custom', cx, layout.presetY + 16);
    }
  }

  // Difficulty segment.
  if (difficulties && difficulties.length) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < difficulties.length; i++) {
      const w = panel.get(`diff:${i}`);
      if (!w) continue;
      const on = i === difficultyIndex;
      ctx.fillStyle = on ? COLORS.accent : (hov === w.id ? COLORS.panelHover : COLORS.panel);
      roundRect(ctx, w.x, w.y, w.w, w.h, 16);
      ctx.fill();
      ctx.fillStyle = on ? '#0e1116' : COLORS.muted;
      ctx.font = F(600, 14);
      ctx.fillText(difficulties[i].label, w.x + w.w / 2, w.y + w.h / 2);
    }
  }

  // Zone grid.
  const g = layout.zoneGrid;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.muted;
  ctx.font = F(600, 15);
  ctx.fillText(zoneCaption, g.x, g.y - 22);

  const activeZone = model.zone;
  for (let z = 1; z <= 9; z++) {
    const w = panel.get(`zone:${z}`);
    if (!w) continue;
    const on = z === activeZone;
    ctx.fillStyle = on ? COLORS.accent : (hov === w.id ? COLORS.panelHover : COLORS.panel);
    roundRect(ctx, w.x, w.y, w.w, w.h, 10);
    ctx.fill();
    ctx.strokeStyle = COLORS.hairline;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = on ? '#0e1116' : COLORS.muted;
    ctx.font = F(700, 20);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(z), w.x + w.w / 2, w.y + w.h / 2);
  }

  // Start / Save.
  const start = panel.get('start');
  if (start) {
    ctx.fillStyle = hov === 'start' ? COLORS.accentBright : COLORS.accent;
    roundRect(ctx, start.x, start.y, start.w, start.h, 26);
    ctx.fill();
    ctx.fillStyle = '#0e1116';
    ctx.font = F(700, 22);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(startLabel, start.x + start.w / 2, start.y + start.h / 2);
  }
  const save = panel.get('save');
  if (save) {
    ctx.fillStyle = hov === 'save' ? COLORS.panelHover : COLORS.panel;
    roundRect(ctx, save.x, save.y, save.w, save.h, 26);
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.font = F(600, 18);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SAVE', save.x + save.w / 2, save.y + save.h / 2);
  }

  // Message line (feasibility warnings, save confirmations). Anchored to the
  // button row rather than to the Save widget, which panels may not register.
  if (model.message) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = F(500, 15);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(model.message, 60, layout.buttonsY + 52 + 24);
  }

  // Attribute rows.
  for (const row of layout.fieldRows || []) {
    const { field } = row;
    const dim = row.disabled;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = dim ? COLORS.disabled : COLORS.text;
    ctx.font = F(600, 17);
    ctx.fillText(field.label, row.x, row.y + row.h / 2);

    ctx.fillStyle = dim ? COLORS.disabled : COLORS.accent;
    ctx.font = F(600, 16);
    if (field.kind === 'segment' || field.kind === 'burst') {
      // Centred between the ‹ › steppers — right-aligned at the row edge it
      // would sit underneath the › button, which is drawn after this text.
      ctx.textAlign = 'center';
      ctx.fillText(formatField(field, cfg),
        row.x + (row.w + CONTROL_INSET - 20) / 2, row.y + row.h / 2);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(formatField(field, cfg), row.x + row.w, row.y + row.h / 2);
    }

    if (field.kind === 'slider') {
      const w = panel.get(`slider:${field.key}`);
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
        const w = panel.get(`cycle:${field.key}:${dir}`);
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
      const w = panel.get(`toggle:${field.key}`);
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

  // End-condition row — drawn exactly like a segment row so it reads as part
  // of the attribute table it sits under.
  if (layout.endRow) {
    const row = layout.endRow;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = F(600, 17);
    ctx.fillText('Ends', row.x, row.y + row.h / 2);

    ctx.fillStyle = COLORS.accent;
    ctx.font = F(600, 16);
    ctx.textAlign = 'center';
    ctx.fillText(endLabel || '',
      row.x + (row.w + CONTROL_INSET - 20) / 2, row.y + row.h / 2);

    for (const dir of [-1, 1]) {
      const w = panel.get(`end:${dir}`);
      if (!w) continue;
      ctx.fillStyle = hov === w.id ? COLORS.panelHover : COLORS.panel;
      roundRect(ctx, w.x, w.y, w.w, w.h, 16);
      ctx.fill();
      ctx.fillStyle = COLORS.text;
      ctx.font = F(700, 18);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dir < 0 ? '‹' : '›', w.x + w.w / 2, w.y + w.h / 2);
    }
  }
}
