// WristMenu — does the PLAY tile actually emit?
//
// Bisects "play click is not working": if this passes, the wrist menu is
// fine and the fault is downstream in inGame; if it fails, it is here.
// (The tile's event is still named 'training' — the stable key from before
// the Machine Play menu merged into the unified PLAY menu.)

jest.mock('../js/scene/sceneSetup.js', () => ({ scene: { add: () => {}, remove: () => {} } }));
jest.mock('../js/scene/audio.js', () => ({
  playMenuHoverTick: () => {}, playMenuSelectClick: () => {},
}));
jest.mock('../js/xr/haptics.js', () => ({ pulseActive: () => {} }));
jest.mock('../js/scene/models.js', () => ({
  BALL_COLORS: { orange: { hex: 0xffa500 }, white: { hex: 0xffffff } },
  getBallColorId: () => 'orange',
  TABLE_COLORS: { blue: { id: 'blue', base: '#0d478d' }, green: { id: 'green', base: '#1e6b47' } },
  getTableColorId: () => 'blue',
}));
jest.mock('../js/xr/driftDetector.js', () => ({ getDriftFlag: () => false }));

function makeCtx() {
  const store = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: () => {} });
      }
      return () => {};
    },
    set(t, prop, v) { t[prop] = v; return true; },
    has() { return true; },
  });
}

beforeAll(() => {
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => makeCtx() }),
  };
});

const { WristMenu, RULES_COLUMNS } = require('../js/scene/wristMenu.js');

function uvOfButton(menu, id) {
  const b = menu.buttons.find((x) => x.id === id);
  if (!b) throw new Error(`no button "${id}" — buttons: ${menu.buttons.map((x) => x.id).join(', ')}`);
  const px = b.shape === 'circle' ? b.cx : b.x + b.w / 2;
  const py = b.shape === 'circle' ? b.cy : b.y + b.h / 2;
  return [px / 1024, 1 - py / 410];
}

describe('PLAY tile', () => {
  test('a play mode button exists (id kept as mode-training)', () => {
    const menu = new WristMenu();
    const ids = menu.buttons.map((b) => b.id);
    expect(ids).toContain('mode-training');
  });

  test('the drill picker is gone', () => {
    const ids = new WristMenu().buttons.map((b) => b.id);
    expect(ids).not.toContain('drill-prev');
    expect(ids).not.toContain('drill-next');
  });

  test('its hit region resolves to the tile', () => {
    const menu = new WristMenu();
    const [u, v] = uvOfButton(menu, 'mode-training');
    expect(menu.hitTestUV(u, v)).toBe('mode-training');
  });

  test('clicking it emits "training" with the selected difficulty', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('training', (p) => seen.push(p));

    const [u, v] = uvOfButton(menu, 'mode-training');
    menu.setHovered(menu.hitTestUV(u, v));
    menu.selectHovered();

    expect(seen).toHaveLength(1);
    expect(seen[0].difficulty).toBe('beginner');
  });

  test('it does NOT emit start — that would try to launch a drill directly', () => {
    const menu = new WristMenu();
    const starts = [];
    menu.on('start', (p) => starts.push(p));
    const [u, v] = uvOfButton(menu, 'mode-training');
    menu.setHovered(menu.hitTestUV(u, v));
    menu.selectHovered();
    expect(starts).toHaveLength(0);
  });
});

describe('event registration', () => {
  // THE ROOT CAUSE of "training click is not working".
  //
  // listeners was a fixed object literal of known event names and on() was
  // `if (this.listeners[event]) this.listeners[event].push(fn)`. Registering
  // anything outside that literal was silently discarded — no error, no
  // warning — so the TRAINING tile hit-tested correctly, ran activate(),
  // called emit(), and did nothing, while every pre-existing option worked.
  test('a handler for a brand-new event name is actually registered', () => {
    const menu = new WristMenu();
    let got = null;
    menu.on('some-event-that-did-not-exist-before', (p) => { got = p; });
    menu.emit('some-event-that-did-not-exist-before', { ok: true });
    expect(got).toEqual({ ok: true });
  });

  test('multiple handlers on one event all fire', () => {
    const menu = new WristMenu();
    const calls = [];
    menu.on('training', () => calls.push('a'));
    menu.on('training', () => calls.push('b'));
    menu.emit('training', {});
    expect(calls).toEqual(['a', 'b']);
  });

  test('a throwing handler cannot suppress the others', () => {
    // A throw here would propagate out through activate() → selectHovered()
    // → the XR select event and read as "the button does nothing".
    const menu = new WristMenu();
    let reached = false;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    menu.on('training', () => { throw new Error('bad handler'); });
    menu.on('training', () => { reached = true; });
    expect(() => menu.emit('training', {})).not.toThrow();
    expect(reached).toBe(true);
    console.error.mockRestore();
  });

  test('emitting an event with no handlers is a no-op', () => {
    expect(() => new WristMenu().emit('nobody-listening', {})).not.toThrow();
  });

  test('dispose clears handlers without throwing', () => {
    const menu = new WristMenu();
    menu.on('training', () => {});
    expect(() => menu.dispose()).not.toThrow();
  });

  test('the physics tuner button only exists in dev sessions', () => {
    // Default (production): no ?tuner/?selftest, so no gear button, and
    // calibrate slides into the first dock slot so there is no gap.
    const menu = new WristMenu();
    expect(menu.buttons.some((b) => b.id === 'tune')).toBe(false);
    expect(menu.buttons.find((b) => b.id === 'calibrate').x).toBe(32);
    const dev = new WristMenu({ showTune: true });
    expect(dev.buttons.some((b) => b.id === 'tune')).toBe(true);
  });

  test('every event the menu can emit has a reachable path', () => {
    // Guards the inverse mistake: a tile wired to an event name that nothing
    // downstream listens for.
    const menu = new WristMenu();
    for (const event of ['start', 'training', 'tune', 'calibrate', 'ballColor', 'dominantHand', 'mrBackdrop', 'exit']) {
      let fired = false;
      menu.on(event, () => { fired = true; });
      menu.emit(event, {});
      expect(fired).toBe(true);
    }
  });
});

describe('the other tiles still work', () => {
  test('the second Machine Play tile is gone — one front door to the machine', () => {
    // Rally, survival and score challenge live inside the unified PLAY menu
    // now (as a root row and the editor's end-condition cycler), so a
    // separate tile would open a menu with nothing left in it.
    const ids = new WristMenu().buttons.map((b) => b.id);
    expect(ids).not.toContain('mode-machinePlay');
  });

  test('ai match emits start with its drill id', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('start', (p) => seen.push(p));
    const [u, v] = uvOfButton(menu, 'mode-aiMatch');
    menu.setHovered(menu.hitTestUV(u, v));
    menu.selectHovered();
    expect(seen[0].drill).toBe('aiMatch');
  });

  test('every mode tile resolves to itself, none shadowed', () => {
    const menu = new WristMenu();
    for (const id of ['mode-training', 'mode-aiMatch', 'mode-multiplayer']) {
      const [u, v] = uvOfButton(menu, id);
      expect(menu.hitTestUV(u, v)).toBe(id);
    }
  });
});

function click(menu, id) {
  const [u, v] = uvOfButton(menu, id);
  menu.setHovered(menu.hitTestUV(u, v));
  menu.selectHovered();
}

describe('match-length pill', () => {
  // Best-of-5 to 11 is 20-40 minutes in a headset. This control is how a
  // player asks for one game instead — and, because the lobby reads the same
  // stored preference, the default format for a room they host.

  test('offers one segment per length, defaulting to best-of-5', () => {
    const menu = new WristMenu();
    const ids = menu.buttons.filter((b) => b.kind === 'format').map((b) => b.id);
    expect(ids).toEqual(['bestOf-1', 'bestOf-3', 'bestOf-5']);
    expect(menu.bestOf).toBe(5);
  });

  test('each segment is individually clickable and sets the length', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('bestOf', (p) => seen.push(p));
    click(menu, 'bestOf-3');
    expect(menu.bestOf).toBe(3);
    click(menu, 'bestOf-1');
    expect(menu.bestOf).toBe(1);
    expect(seen).toEqual([{ bestOf: 3 }, { bestOf: 1 }]);
  });

  test('the new pill does not shadow the difficulty segments beside it', () => {
    // The two pills share the top row; a mis-sized hit region on either
    // swallows the other's edge segment and reads as a dead button.
    const menu = new WristMenu();
    for (const id of ['diff-0', 'diff-1', 'diff-2', 'bestOf-1', 'bestOf-3', 'bestOf-5']) {
      expect(menu.hitTestUV(...uvOfButton(menu, id))).toBe(id);
    }
  });

  test('the whole top row stays inside the panel capsule', () => {
    // Canvas has no clipping: a row wider than the capsule paints its ends
    // over the rounded edge and off the visible panel.
    const menu = new WristMenu();
    const row = menu.buttons.filter((b) => b.kind === 'segment' || b.kind === 'format');
    expect(Math.min(...row.map((b) => b.x))).toBeGreaterThan(79);
    expect(Math.max(...row.map((b) => b.x + b.w))).toBeLessThan(1024 - 79);
  });

  test('picking a length does not start a drill', () => {
    const menu = new WristMenu();
    const starts = [];
    menu.on('start', (p) => starts.push(p));
    click(menu, 'bestOf-1');
    expect(starts).toHaveLength(0);
  });
});

describe('competition rules', () => {
  // The trophy toggle is gone and ITTF rules are always on, so what these
  // guard now is that it STAYS gone: no dock button, no state, no flag in the
  // start payload for aiMatch to read a stale `false` out of.

  test('there is no rules dock and no competition state to toggle', () => {
    const menu = new WristMenu();
    expect(menu.buttons.find((b) => b.id === 'rules')).toBeUndefined();
    expect(menu.competitionMode).toBeUndefined();
  });

  test('start payloads carry no competition flag — the match factory defaults it on', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('start', (p) => seen.push(p));
    click(menu, 'mode-aiMatch');
    expect(seen[0].options).toEqual({ bestOf: menu.bestOf });
    expect('competition' in seen[0].options).toBe(false);
  });

  test('start payloads carry the match length too', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('start', (p) => seen.push(p));
    click(menu, 'bestOf-1');
    click(menu, 'mode-aiMatch');
    expect(seen[0].options.bestOf).toBe(1);
  });

  test('the trophy slot is now the rules card, and still hit-tests', () => {
    const menu = new WristMenu();
    const [u, v] = uvOfButton(menu, 'ballColor');
    expect(menu.hitTestUV(u, v)).toBe('ballColor');
    const [u2, v2] = uvOfButton(menu, 'help');
    expect(menu.hitTestUV(u2, v2)).toBe('help');
  });

  test('the caption line states the service law when nothing is hovered', () => {
    const menu = new WristMenu();
    const lines = [];
    menu.ctx.fillText = (t) => lines.push(String(t));
    menu.hovered = null;
    menu.drawDockCaption();
    expect(lines.join(' ')).toMatch(/16 cm/);
    expect(lines.join(' ')).toMatch(/end line/);
  });
});

describe('rules card', () => {
  function textOf(menu) {
    const lines = [];
    const ctx = menu.ctx;
    const prev = ctx.fillText;
    ctx.fillText = (t) => lines.push(String(t));
    menu.draw();
    ctx.fillText = prev;
    return lines.join(' | ');
  }

  test('? opens a screen that replaces the controls with one BACK pill', () => {
    const menu = new WristMenu();
    expect(menu.helpOpen).toBe(false);
    click(menu, 'help');
    expect(menu.helpOpen).toBe(true);
    expect(menu.buttons.map((b) => b.id)).toEqual(['help-close']);
    // The pill chrome is nulled too, or the difficulty/format containers
    // paint through from the main screen.
    expect(menu._diffPill).toBe(null);
    expect(menu._formatPill).toBe(null);
  });

  test('it states the service law point by point, not as a caption', () => {
    const menu = new WristMenu();
    click(menu, 'help');
    const text = textOf(menu);
    expect(text).toMatch(/ITTF RULES/);
    expect(text).toMatch(/SERVICE/);
    expect(text).toMatch(/RALLY/);
    expect(text).toMatch(/SCORING/);
    expect(text).toMatch(/16 cm/);
    expect(text).toMatch(/end line/);
    expect(text).toMatch(/First to 11/);
    // The hover caption belongs to the main screen and must not bleed
    // through onto the card.
    expect(text).not.toMatch(/tap \? for all the rules/);
  });

  test('BACK returns to the controls', () => {
    const menu = new WristMenu();
    click(menu, 'help');
    click(menu, 'help-close');
    expect(menu.helpOpen).toBe(false);
    const ids = menu.buttons.map((b) => b.id);
    expect(ids).toContain('mode-aiMatch');
    expect(ids).toContain('help');
    expect(ids).not.toContain('help-close');
    // Rebuilt, not appended to — the main screen's buttons must appear once.
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The card is hand-laid-out on a fixed canvas, so the copy has to stay
  // inside the geometry. fillText condenses instead of wrapping, which means
  // an over-long line degrades silently — it just looks squeezed in headset.
  test('the copy fits the columns it is drawn into', () => {
    for (const col of RULES_COLUMNS) {
      expect(col.points.length).toBeLessThanOrEqual(6);
      for (const line of col.points) {
        expect(line.length).toBeLessThanOrEqual(34);
      }
    }
  });

  test('closing the menu while reading the card reopens on the controls', () => {
    const menu = new WristMenu();
    click(menu, 'help');
    menu.hide();
    expect(menu.helpOpen).toBe(false);
    expect(menu.buttons.map((b) => b.id)).toContain('mode-aiMatch');
  });
});

describe('dominant-hand dock button', () => {
  // Bounding box of any button, circles included, for the overlap sweep.
  function box(b) {
    if (b.shape === 'circle') {
      return { x0: b.cx - b.r, y0: b.cy - b.r, x1: b.cx + b.r, y1: b.cy + b.r };
    }
    return { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
  }
  // Half-pixel tolerance: adjacent pill segments share an edge, and
  // `rowX + segW + segW` vs `rowX + 2 * segW` differ in the last float bit.
  function overlaps(a, b, eps = 0.5) {
    return a.x0 + eps < b.x1 && b.x0 + eps < a.x1 && a.y0 + eps < b.y1 && b.y0 + eps < a.y1;
  }

  test('sits centred under the Table / Ball pair and overlaps nothing', () => {
    // Also with the dev-only Tune button present: the hand button mirrors
    // its slot on the other side, so both layouts must stay collision-free.
    for (const opts of [{}, { showTune: true }]) {
      const menu = new WristMenu(opts);
      const hand = menu.buttons.find((b) => b.id === 'dominantHand');
      const table = menu.buttons.find((b) => b.id === 'tableColor');
      const ball = menu.buttons.find((b) => b.id === 'ballColor');
      expect(hand).toBeDefined();
      // Centred under the pair, on the row below it.
      expect(hand.x + hand.w / 2).toBe((table.x + ball.x + ball.w) / 2);
      expect(hand.y).toBeGreaterThan(ball.y + ball.h);
      // Clear of the mode tiles' crosshair ticks (x ≈ 822), the caption line
      // (y ≈ 323) and the capsule's rounded end (x ≈ 992 at this height).
      expect(hand.x).toBeGreaterThan(822);
      expect(hand.y + hand.h).toBeLessThan(323);
      expect(hand.x + hand.w).toBeLessThan(992);
      // No button overlaps any other.
      const boxes = menu.buttons.map((b) => [b.id, box(b)]);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlaps(boxes[i][1], boxes[j][1]) ? `${boxes[i][0]} × ${boxes[j][0]}` : null)
            .toBeNull();
        }
      }
    }
  });

  test('hit-tests, and a tap emits the OTHER hand', () => {
    let hand = 'R';
    const menu = new WristMenu({ getDominantHand: () => hand });
    const seen = [];
    menu.on('dominantHand', (p) => { seen.push(p.hand); hand = p.hand; });
    expect(menu.hitTestUV(...uvOfButton(menu, 'dominantHand'))).toBe('dominantHand');
    click(menu, 'dominantHand');
    click(menu, 'dominantHand');
    expect(seen).toEqual(['L', 'R']);
  });

  test('the icon and caption report the CURRENT hand through the getter', () => {
    let hand = 'L';
    const menu = new WristMenu({ getDominantHand: () => hand });
    const drawn = () => {
      const texts = [];
      menu.ctx.fillText = (t) => texts.push(String(t));
      menu.hovered = 'dominantHand';
      menu.draw();
      return texts.join(' | ');
    };
    expect(drawn()).toMatch(/Dominant Hand\s+—\s+Left/);
    expect(drawn()).toMatch(/\| L \|/);
    hand = 'R';   // changed elsewhere (settings screen / swing detection)
    expect(drawn()).toMatch(/Dominant Hand\s+—\s+Right/);
    expect(drawn()).toMatch(/\| R \|/);
  });

  test('defaults to right-handed when no getter is supplied', () => {
    const menu = new WristMenu();
    const seen = [];
    menu.on('dominantHand', (p) => seen.push(p.hand));
    click(menu, 'dominantHand');
    expect(seen).toEqual(['L']);
  });
});

describe('passthrough backdrop dock button', () => {
  function box(b) {
    if (b.shape === 'circle') {
      return { x0: b.cx - b.r, y0: b.cy - b.r, x1: b.cx + b.r, y1: b.cy + b.r };
    }
    return { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
  }
  function overlaps(a, b, eps = 0.5) {
    return a.x0 + eps < b.x1 && b.x0 + eps < a.x1 && a.y0 + eps < b.y1 && b.y0 + eps < a.y1;
  }

  test('exists only in MR sessions, and the layout is unchanged without it', () => {
    // The Focus Room has its own back wall — no toggle there.
    const vr = new WristMenu();
    expect(vr.buttons.some((b) => b.id === 'mrBackdrop')).toBe(false);
    const mr = new WristMenu({ showBackdrop: true });
    expect(mr.buttons.some((b) => b.id === 'mrBackdrop')).toBe(true);
    // Every other button sits exactly where it does without the toggle.
    for (const b of vr.buttons) {
      const same = mr.buttons.find((x) => x.id === b.id);
      expect(same).toBeDefined();
      expect(box(same)).toEqual(box(b));
    }
  });

  test('sits beside the hand button on its row and overlaps nothing', () => {
    for (const opts of [{ showBackdrop: true }, { showBackdrop: true, showTune: true }]) {
      const menu = new WristMenu(opts);
      const bd = menu.buttons.find((b) => b.id === 'mrBackdrop');
      const hand = menu.buttons.find((b) => b.id === 'dominantHand');
      const ball = menu.buttons.find((b) => b.id === 'ballColor');
      // Same row as the hand, immediately to its left, under the top pair.
      expect(bd.y).toBe(hand.y);
      expect(bd.x + bd.w).toBeLessThan(hand.x);
      expect(hand.x - (bd.x + bd.w)).toBeLessThanOrEqual(8);
      expect(bd.y).toBeGreaterThan(ball.y + ball.h);
      // Clear of the MULTI tile's ring at this height (x ≈ 799) and the
      // caption line (y ≈ 323).
      expect(bd.x).toBeGreaterThan(822);
      expect(bd.y + bd.h).toBeLessThan(323);
      const boxes = menu.buttons.map((b) => [b.id, box(b)]);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(overlaps(boxes[i][1], boxes[j][1]) ? `${boxes[i][0]} × ${boxes[j][0]}` : null)
            .toBeNull();
        }
      }
    }
  });

  test('hit-tests, and a tap emits the OTHER state read through the getter', () => {
    let on = false;
    const menu = new WristMenu({ showBackdrop: true, getBackdropOn: () => on });
    const seen = [];
    menu.on('mrBackdrop', (p) => { seen.push(p.on); on = p.on; });
    expect(menu.hitTestUV(...uvOfButton(menu, 'mrBackdrop'))).toBe('mrBackdrop');
    click(menu, 'mrBackdrop');
    click(menu, 'mrBackdrop');
    click(menu, 'mrBackdrop');
    expect(seen).toEqual([true, false, true]);
  });

  test('the caption reports the CURRENT state through the getter', () => {
    let on = false;
    const menu = new WristMenu({ showBackdrop: true, getBackdropOn: () => on });
    const drawn = () => {
      const texts = [];
      menu.ctx.fillText = (t) => texts.push(String(t));
      menu.hovered = 'mrBackdrop';
      menu.draw();
      return texts.join(' | ');
    };
    expect(drawn()).toMatch(/Backdrop\s+—\s+Off/);
    on = true;   // stored elsewhere (inGame.js owns the profile write)
    expect(drawn()).toMatch(/Backdrop\s+—\s+On/);
  });

  test('draws without a getter (defaults to off) and does not throw', () => {
    const menu = new WristMenu({ showBackdrop: true });
    menu.hovered = 'mrBackdrop';
    expect(() => menu.draw()).not.toThrow();
    const seen = [];
    menu.on('mrBackdrop', (p) => seen.push(p.on));
    click(menu, 'mrBackdrop');
    expect(seen).toEqual([true]);
  });
});
