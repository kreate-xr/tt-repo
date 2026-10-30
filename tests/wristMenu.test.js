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

  test('the physics tuner tile only exists in dev sessions, inside Settings', () => {
    // Default (production): no ?tuner/?selftest, so no Tune tile.
    const menu = new WristMenu();
    menu.setScreen('settings');
    expect(menu.buttons.some((b) => b.id === 'tune')).toBe(false);
    const dev = new WristMenu({ showTune: true });
    expect(dev.buttons.some((b) => b.id === 'tune')).toBe(false);   // not on the main screen
    dev.setScreen('settings');
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

  test('the rules card and Settings docks both hit-test', () => {
    const menu = new WristMenu();
    expect(menu.hitTestUV(...uvOfButton(menu, 'help'))).toBe('help');
    expect(menu.hitTestUV(...uvOfButton(menu, 'settings'))).toBe('settings');
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

// Bounding box of any button, circles included, for the overlap sweeps.
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
function expectNoOverlaps(menu) {
  const boxes = menu.buttons.map((b) => [b.id, box(b)]);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(overlaps(boxes[i][1], boxes[j][1]) ? `${boxes[i][0]} × ${boxes[j][0]}` : null)
        .toBeNull();
    }
  }
}
function textOfDraw(menu) {
  const texts = [];
  menu.ctx.fillText = (t) => texts.push(String(t));
  menu.draw();
  return texts.join(' | ');
}
function openSettings(opts) {
  const menu = new WristMenu(opts);
  click(menu, 'settings');
  return menu;
}

const SETTING_IDS = ['ballColor', 'tableColor', 'dominantHand', 'foulRules', 'mrBackdrop', 'calibrate', 'tune'];

describe('main screen dock', () => {
  test('is just Rules on the left and Settings on the right', () => {
    for (const opts of [{}, { showTune: true }, { showBackdrop: true, showTune: true }]) {
      const menu = new WristMenu(opts);
      const docks = menu.buttons.filter((b) => b.kind === 'dock');
      expect(docks.map((b) => b.id)).toEqual(['help', 'settings']);
      for (const id of SETTING_IDS) expect(menu.buttons.some((b) => b.id === id)).toBe(false);
      // Mirror images about the panel's centre, clear of the mode row's
      // crosshair ticks (x ≈ 202…822).
      const [help, settings] = docks;
      expect(help.x + help.w / 2 + settings.x + settings.w / 2).toBe(1024);
      expect(help.y).toBe(settings.y);
      expect(help.x + help.w).toBeLessThan(202);
      expect(settings.x).toBeGreaterThan(822);
      expectNoOverlaps(menu);
    }
  });

  test('hovering the gear names what Settings holds', () => {
    const menu = new WristMenu();
    menu.hovered = 'settings';
    expect(textOfDraw(menu)).toMatch(/Settings\s+—\s+ball, table, hand/);
  });

  test('the drift hint moves to the gear, since Paddle Fit is behind it', () => {
    const menu = new WristMenu();
    const arcs = [];
    menu.ctx.arc = (x, y, r) => arcs.push([x, y, r]);
    menu._driftFlagCache = false;
    menu.draw();
    const gear = menu.buttons.find((b) => b.id === 'settings');
    const atGearCorner = () => arcs.some(([x, y, r]) => r === 7 && x === gear.x + gear.w - 8);
    expect(atGearCorner()).toBe(false);
    arcs.length = 0;
    menu._driftFlagCache = true;
    menu.draw();
    expect(atGearCorner()).toBe(true);
    menu._driftFlagCache = false;
  });
});

describe('Settings screen', () => {
  test('Foul Rules toggles: emits the other state and shows the store value', () => {
    let on = true;
    const menu = openSettings({ getFoulRulesOn: () => on });
    const seen = [];
    menu.on('foulRules', (p) => { seen.push(p); on = p.on; });
    expect(textOfDraw(menu)).toMatch(/Foul Rules \| On/);
    click(menu, 'foulRules');
    expect(seen).toEqual([{ on: false }]);
    expect(textOfDraw(menu)).toMatch(/Off · Free/);
    click(menu, 'foulRules');
    expect(seen).toEqual([{ on: false }, { on: true }]);
  });

  test('the main-screen caption says free play while fouls are off', () => {
    const menu = new WristMenu({ getFoulRulesOn: () => false });
    const text = textOfDraw(menu);
    expect(text).toMatch(/FREE PLAY/);
    expect(text).not.toMatch(/toss 16 cm/);
  });

  test('the gear opens it: a title, one tile per setting, and a BACK pill', () => {
    const menu = openSettings();
    expect(menu.settingsOpen).toBe(true);
    expect(menu.helpOpen).toBe(false);
    expect(menu.buttons.map((b) => b.id))
      .toEqual(['ballColor', 'tableColor', 'dominantHand', 'foulRules', 'calibrate', 'settings-close']);
    expect(menu._diffPill).toBe(null);
    expect(menu._formatPill).toBe(null);
    const text = textOfDraw(menu);
    expect(text).toMatch(/SETTINGS/);
    expect(text).not.toMatch(/tap \? for all the rules/);   // main-screen caption stays there
  });

  test('session-specific tiles appear only where they apply', () => {
    const ids = (opts) => openSettings(opts).buttons.map((b) => b.id);
    expect(ids({ showBackdrop: true })).toContain('mrBackdrop');
    expect(ids({})).not.toContain('mrBackdrop');
    expect(ids({ showTune: true })).toContain('tune');
    expect(ids({ showBackdrop: true, showTune: true }))
      .toEqual([...SETTING_IDS, 'settings-close']);
  });

  test('every tile count fits the capsule, overlaps nothing and hit-tests to itself', () => {
    for (const opts of [{}, { showBackdrop: true }, { showTune: true }, { showBackdrop: true, showTune: true }]) {
      const menu = openSettings(opts);
      const tiles = menu.buttons.filter((b) => b.kind === 'tile');
      const back = menu.buttons.find((b) => b.id === 'settings-close');
      for (const t of tiles) {
        // Inside the capsule's rounded ends (≈ 33px inset at the tiles' top
        // edge), below the title's hairline (y = 76), above BACK.
        expect(t.x).toBeGreaterThanOrEqual(40);
        expect(t.x + t.w).toBeLessThanOrEqual(1024 - 40);
        expect(t.y).toBeGreaterThan(76);
        expect(t.y + t.h).toBeLessThan(back.y);
        // Wide enough to aim at with a laser across the room.
        expect(t.w).toBeGreaterThanOrEqual(120);
        expect(menu.hitTestUV(...uvOfButton(menu, t.id))).toBe(t.id);
      }
      expectNoOverlaps(menu);
    }
  });

  test('each tile shows its CURRENT value, read through the getters', () => {
    let hand = 'L';
    let on = false;
    const menu = openSettings({
      showBackdrop: true, getDominantHand: () => hand, getBackdropOn: () => on,
    });
    let text = textOfDraw(menu);
    expect(text).toMatch(/Ball Color \| Orange/);
    expect(text).toMatch(/Table Color \| Blue/);
    expect(text).toMatch(/Dominant Hand \| Left/);
    expect(text).toMatch(/Backdrop \| Off/);
    expect(text).toMatch(/Paddle Fit \| Adjust/);
    hand = 'R'; on = true;   // changed elsewhere (PLAY › SETTINGS, the store)
    text = textOfDraw(menu);
    expect(text).toMatch(/Dominant Hand \| Right/);
    expect(text).toMatch(/Backdrop \| On/);
    // The hand icon is still the bold letter.
    expect(text).toMatch(/\| R \|/);
  });

  test('BACK returns to the main controls, rebuilt rather than appended', () => {
    const menu = openSettings();
    click(menu, 'settings-close');
    expect(menu.settingsOpen).toBe(false);
    const ids = menu.buttons.map((b) => b.id);
    expect(ids).toContain('mode-aiMatch');
    expect(ids).toContain('settings');
    expect(ids).not.toContain('ballColor');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('closing the menu while in Settings reopens on the controls', () => {
    const menu = openSettings();
    menu.hide();
    expect(menu.screen).toBe('main');
    expect(menu.buttons.map((b) => b.id)).toContain('mode-aiMatch');
  });

  test('setHelpOpen(false) does not kick the player out of Settings', () => {
    const menu = openSettings();
    menu.setHelpOpen(false);
    expect(menu.settingsOpen).toBe(true);
  });
});

describe('Settings tiles', () => {
  test('colour tiles emit the next colour in the cycle', () => {
    const menu = openSettings();
    const seen = [];
    menu.on('ballColor', (p) => seen.push(['ball', p.colorId]));
    menu.on('tableColor', (p) => seen.push(['table', p.colorId]));
    click(menu, 'ballColor');
    click(menu, 'tableColor');
    expect(seen).toEqual([['ball', 'white'], ['table', 'green']]);
    expect(menu.settingsOpen).toBe(true);   // a toggle, not a navigation
  });

  test('dominant hand: a tap emits the OTHER hand', () => {
    let hand = 'R';
    const menu = openSettings({ getDominantHand: () => hand });
    const seen = [];
    menu.on('dominantHand', (p) => { seen.push(p.hand); hand = p.hand; });
    click(menu, 'dominantHand');
    click(menu, 'dominantHand');
    expect(seen).toEqual(['L', 'R']);
  });

  test('dominant hand defaults to right-handed when no getter is supplied', () => {
    const menu = openSettings();
    const seen = [];
    menu.on('dominantHand', (p) => seen.push(p.hand));
    click(menu, 'dominantHand');
    expect(seen).toEqual(['L']);
  });

  test('backdrop: a tap emits the OTHER state read through the getter', () => {
    let on = false;
    const menu = openSettings({ showBackdrop: true, getBackdropOn: () => on });
    const seen = [];
    menu.on('mrBackdrop', (p) => { seen.push(p.on); on = p.on; });
    click(menu, 'mrBackdrop');
    click(menu, 'mrBackdrop');
    click(menu, 'mrBackdrop');
    expect(seen).toEqual([true, false, true]);
  });

  test('backdrop draws without a getter (defaults to off) and does not throw', () => {
    const menu = openSettings({ showBackdrop: true });
    menu.hovered = 'mrBackdrop';
    expect(() => menu.draw()).not.toThrow();
    const seen = [];
    menu.on('mrBackdrop', (p) => seen.push(p.on));
    click(menu, 'mrBackdrop');
    expect(seen).toEqual([true]);
  });

  test('Paddle Fit emits calibrate and Tune emits tune', () => {
    const menu = openSettings({ showTune: true });
    const seen = [];
    menu.on('calibrate', () => seen.push('calibrate'));
    menu.on('tune', () => seen.push('tune'));
    click(menu, 'calibrate');
    click(menu, 'tune');
    expect(seen).toEqual(['calibrate', 'tune']);
  });

  test('Paddle Fit says Recheck and carries the drift dot when drift is flagged', () => {
    const menu = openSettings();
    menu._driftFlagCache = true;
    expect(textOfDraw(menu)).toMatch(/Paddle Fit \| Recheck/);
    menu._driftFlagCache = false;
    expect(textOfDraw(menu)).toMatch(/Paddle Fit \| Adjust/);
  });
});
