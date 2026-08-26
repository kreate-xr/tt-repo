// LobbyMenuModel — the state machine behind the in-XR multiplayer panel.
//
// Exercises the create/join/cancel/error flows with a fake LobbyManager, in
// particular the stale-session guard: a cancelled attempt whose connection
// later resolves must NOT deliver, or an abandoned room could hijack the
// session the player has since moved on to.

const {
  LobbyMenuModel, MP_SCREENS, ROOM_CODE_LEN,
} = require('../js/modes/multiplayer/lobbyMenuModel.js');

function makeLobby(overrides = {}) {
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
    ...overrides,
  };
  return lobby;
}

function makeModel(lobbyFactory) {
  const events = { changes: 0, connected: null };
  const model = new LobbyMenuModel({
    createLobby: lobbyFactory,
    onChange: () => { events.changes++; },
    onConnected: (mp) => { events.connected = mp; },
  });
  return { model, events };
}

const typeCode = (model, code) => { for (const ch of code) model.appendChar(ch); };

describe('construction', () => {
  test('requires a createLobby factory', () => {
    expect(() => new LobbyMenuModel()).toThrow(/createLobby/);
  });

  test('starts at HOME with empty state', () => {
    const { model } = makeModel(() => makeLobby());
    expect(model.screen).toBe(MP_SCREENS.HOME);
    expect(model.codeEntry).toBe('');
    expect(model.connected).toBeNull();
  });
});

describe('create (host) flow', () => {
  test('shows the code while waiting, delivers on connect', async () => {
    const lobby = makeLobby();
    const { model, events } = makeModel(() => lobby);

    const p = model.startCreate();
    expect(model.screen).toBe(MP_SCREENS.HOSTING);
    expect(model.hostCode).toBe('ABCDEF');
    expect(model.message).toMatch(/waiting/i);

    const nm = { fakeNm: 'host' };
    lobby.resolveReady(nm);
    await p;

    expect(events.connected).toEqual({ networkManager: nm, role: 'host', lobby });
    expect(model.connected.networkManager).toBe(nm);
    // Ownership passed to the host — the model must no longer hold the lobby,
    // or a later cancel()/hide() would tear down the live connection.
    expect(model.lobby).toBeNull();
    expect(lobby.torn).toBe(false);
  });

  test('cancel during hosting tears the room down and blocks late delivery', async () => {
    const lobby = makeLobby();
    const { model, events } = makeModel(() => lobby);

    const p = model.startCreate();
    model.cancel();
    expect(model.screen).toBe(MP_SCREENS.HOME);
    await Promise.resolve();
    expect(lobby.torn).toBe(true);

    // The abandoned attempt's connection resolving late must not deliver.
    lobby.resolveReady({ fakeNm: 'late' });
    await p;
    expect(events.connected).toBeNull();
    expect(model.connected).toBeNull();
  });

  test('failure lands back on HOME with a friendly error', async () => {
    const lobby = makeLobby();
    const { model } = makeModel(() => lobby);

    const p = model.startCreate();
    lobby.rejectReady(new Error('ICE_TIMEOUT: {}'));
    await p;

    expect(model.screen).toBe(MP_SCREENS.HOME);
    expect(model.error).toMatch(/could not connect/i);
    expect(lobby.torn).toBe(true);
  });
});

describe('code entry', () => {
  test('only accepts alphabet characters, up to the code length', () => {
    const { model } = makeModel(() => makeLobby());
    model.openJoin();

    model.appendChar('A');
    model.appendChar('1');   // not in the alphabet (confusable with I/l)
    model.appendChar('O');   // omitted from the alphabet
    model.appendChar('I');   // omitted from the alphabet
    expect(model.codeEntry).toBe('A');

    typeCode(model, 'BCDEFG');
    expect(model.codeEntry).toBe('ABCDEF');
    expect(model.codeEntry.length).toBe(ROOM_CODE_LEN);
    expect(model.canJoin()).toBe(true);
  });

  test('ignores input while not on the JOIN screen', () => {
    const { model } = makeModel(() => makeLobby());
    model.appendChar('A');
    expect(model.codeEntry).toBe('');
  });

  test('backspace removes the last character', () => {
    const { model } = makeModel(() => makeLobby());
    model.openJoin();
    typeCode(model, 'ABC');
    model.backspace();
    expect(model.codeEntry).toBe('AB');
  });
});

describe('join (guest) flow', () => {
  test('joins with the entered code and delivers the connection', async () => {
    const lobby = makeLobby();
    const { model, events } = makeModel(() => lobby);
    model.openJoin();
    typeCode(model, 'QRSTUV');

    await model.startJoin();

    expect(lobby.joinedWith).toBe('QRSTUV');
    expect(events.connected.role).toBe('guest');
    expect(events.connected.lobby).toBe(lobby);
    expect(model.lobby).toBeNull();
  });

  test('refuses to join with a short code', async () => {
    const lobby = makeLobby();
    const { model } = makeModel(() => lobby);
    model.openJoin();
    typeCode(model, 'ABC');
    await model.startJoin();
    expect(lobby.joinedWith).toBeUndefined();
    expect(model.screen).toBe(MP_SCREENS.JOIN);
  });

  test('failure returns to the keyboard with the code kept for editing', async () => {
    const lobby = makeLobby({
      async joinRoom() { throw new Error('ROOM_NOT_FOUND'); },
    });
    const { model, events } = makeModel(() => lobby);
    model.openJoin();
    typeCode(model, 'ABCDEF');

    await model.startJoin();

    expect(model.screen).toBe(MP_SCREENS.JOIN);
    expect(model.error).toMatch(/not found/i);
    expect(model.codeEntry).toBe('ABCDEF');
    expect(events.connected).toBeNull();
    expect(lobby.torn).toBe(true);
  });
});

describe('back navigation', () => {
  test('JOIN pops to HOME', () => {
    const { model } = makeModel(() => makeLobby());
    model.openJoin();
    expect(model.back()).toBe(true);
    expect(model.screen).toBe(MP_SCREENS.HOME);
  });

  test('HOSTING cancels the attempt and pops to HOME', async () => {
    const lobby = makeLobby();
    const { model } = makeModel(() => lobby);
    model.startCreate();
    expect(model.back()).toBe(true);
    expect(model.screen).toBe(MP_SCREENS.HOME);
    await Promise.resolve();
    expect(lobby.torn).toBe(true);
  });

  test('HOME returns false — the host closes the panel', () => {
    const { model } = makeModel(() => makeLobby());
    expect(model.back()).toBe(false);
  });
});
