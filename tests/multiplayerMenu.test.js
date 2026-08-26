// MultiplayerMenu — end-to-end smoke test of the real panel class, in the
// same spirit as trainingMenu.test.js: a throw anywhere inside draw() would
// propagate out through wristMenu.emit() and surface as "the MULTI button
// does nothing", so this drives the actual click path headless.

const THREE = require('three');

jest.mock('../js/scene/audio.js', () => ({
  playMenuHoverTick: () => {}, playMenuSelectClick: () => {},
}));
jest.mock('../js/xr/haptics.js', () => ({ pulseActive: () => {} }));

// Canvas stub: any 2D context call is a no-op, any property is writable.
function makeCtx() {
  const store = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
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

const { MultiplayerMenu } = require('../js/scene/multiplayerMenu.js');
const { MP_SCREENS, ROOM_CODE_ALPHABET } = require('../js/modes/multiplayer/lobbyMenuModel.js');

function makeLobby() {
  const lobby = {
    role: null,
    torn: false,
    createRoom() {
      lobby.role = 'host';
      const ready = new Promise((res, rej) => {
        lobby.resolveReady = res;
        lobby.rejectReady = rej;
      });
      return { code: 'ABCDEF', ready };
    },
    async joinRoom(code) {
      lobby.role = 'guest';
      lobby.joinedWith = code;
      return { fakeNm: true };
    },
    async teardown() { lobby.torn = true; },
  };
  return lobby;
}

function makeMenu() {
  const lobby = makeLobby();
  const menu = new MultiplayerMenu({ createLobby: () => lobby });
  return { menu, lobby };
}

// Resolve a widget id to a UV point at its centre, mirroring what a laser
// raycast against the panel plane produces.
function uvOf(menu, id) {
  const w = menu.panel.get(id);
  if (!w) throw new Error(`no widget "${id}"`);
  return [(w.x + w.w / 2) / menu.panel.width, 1 - (w.y + w.h / 2) / menu.panel.height];
}

function clickById(menu, id) {
  const [u, v] = uvOf(menu, id);
  const hit = menu.hitTestUV(u, v);
  expect(hit).toBe(id);        // the region must actually resolve to it
  menu.setHovered(hit);
  return menu.selectHovered();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('construction', () => {
  test('constructs and draws without throwing', () => {
    expect(() => makeMenu()).not.toThrow();
  });

  test('exposes the interface inGame.js drives it through', () => {
    const { menu } = makeMenu();
    for (const m of ['show', 'hide', 'isVisible', 'on', 'hitTestUV', 'setHovered',
      'selectHovered', 'setPokeCursor', 'clearPokeCursor', 'update', 'dispose']) {
      expect(typeof menu[m]).toBe('function');
    }
    expect(menu.mesh).toBeInstanceOf(THREE.Mesh);
    expect(menu.mesh.geometry.attributes.uv).toBeTruthy();
  });
});

describe('host flow by click', () => {
  test('CREATE ROOM → hosting screen with the code, then connected', async () => {
    const { menu, lobby } = makeMenu();
    menu.show();
    let connected = null;
    menu.on('connected', (mp) => { connected = mp; });

    clickById(menu, 'create');
    expect(menu.model.screen).toBe(MP_SCREENS.HOSTING);
    expect(menu.model.hostCode).toBe('ABCDEF');
    expect(menu.panel.get('cancel')).toBeTruthy();

    const nm = { fakeNm: 'host' };
    lobby.resolveReady(nm);
    await flush();
    expect(connected).toEqual({ networkManager: nm, role: 'host', lobby });
  });

  test('CANCEL while hosting tears the room down and returns home', async () => {
    const { menu, lobby } = makeMenu();
    menu.show();
    clickById(menu, 'create');
    clickById(menu, 'cancel');
    expect(menu.model.screen).toBe(MP_SCREENS.HOME);
    await flush();
    expect(lobby.torn).toBe(true);
  });

  test('hiding the panel mid-attempt (A/X close) abandons the room', async () => {
    const { menu, lobby } = makeMenu();
    menu.show();
    clickById(menu, 'create');
    menu.hide();
    await flush();
    expect(lobby.torn).toBe(true);
  });
});

describe('join flow by click', () => {
  test('keyboard renders the full room-code alphabet and nothing else', () => {
    const { menu } = makeMenu();
    menu.show();
    clickById(menu, 'join');
    const keys = menu.panel.widgets.filter((w) => w.id.startsWith('key:'));
    expect(keys.map((w) => w.id.slice(4)).join('')).toBe(ROOM_CODE_ALPHABET);
    // Every key must be individually clickable at its centre.
    for (const w of keys) expect(menu.hitTestUV(...uvOf(menu, w.id))).toBe(w.id);
  });

  test('JOIN stays un-hittable until six characters are typed', () => {
    const { menu } = makeMenu();
    menu.show();
    clickById(menu, 'join');
    // Disabled widgets are skipped by hit-testing, so a click lands on nothing.
    expect(menu.hitTestUV(...uvOf(menu, 'submit'))).toBeNull();
    for (const ch of 'ABCDEF') clickById(menu, 'key:' + ch);
    expect(menu.model.codeEntry).toBe('ABCDEF');
    expect(menu.hitTestUV(...uvOf(menu, 'submit'))).toBe('submit');
  });

  test('typing a code and clicking JOIN connects as guest', async () => {
    const { menu, lobby } = makeMenu();
    menu.show();
    let connected = null;
    menu.on('connected', (mp) => { connected = mp; });

    clickById(menu, 'join');
    for (const ch of 'QRSTUV') clickById(menu, 'key:' + ch);
    clickById(menu, 'submit');
    await flush();

    expect(lobby.joinedWith).toBe('QRSTUV');
    expect(connected.role).toBe('guest');
  });

  test('DELETE removes the last character', () => {
    const { menu } = makeMenu();
    menu.show();
    clickById(menu, 'join');
    for (const ch of 'ABC') clickById(menu, 'key:' + ch);
    clickById(menu, 'del');
    expect(menu.model.codeEntry).toBe('AB');
  });
});

describe('back navigation', () => {
  test('BACK pops JOIN to HOME, then closes via the back event', () => {
    const { menu } = makeMenu();
    menu.show();
    let closed = 0;
    menu.on('back', () => { closed++; });

    clickById(menu, 'join');
    clickById(menu, 'back');
    expect(menu.model.screen).toBe(MP_SCREENS.HOME);
    expect(closed).toBe(0);

    clickById(menu, 'back');
    expect(closed).toBe(1);
  });

  test('a delivered connection survives the panel closing behind it', async () => {
    const { menu, lobby } = makeMenu();
    menu.show();
    clickById(menu, 'create');
    lobby.resolveReady({ fakeNm: true });
    await flush();

    menu.hide();   // inGame hides the panel on its 'connected' handler
    await flush();
    expect(lobby.torn).toBe(false);
  });
});
