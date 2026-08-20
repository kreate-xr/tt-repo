// Start-screen wiring. Two flows:
//   - Solo: Enter MR / Desktop Preview → straight into XR
//   - Multiplayer: Create Room / Join Room → lobby negotiates a peer
//     connection BEFORE entering XR, then both peers click Enter MR with the
//     live NetworkManager handed through.

import { LobbyManager } from '../lobby/LobbyManager.js';

export function wireOverlay({ overlay, loadingScreen, statusEl, startInGame, startDesktop }) {
  const enterMRBtn = document.getElementById('enter-mr');
  const createRoomBtn = document.getElementById('create-room');
  const joinRoomBtn = document.getElementById('join-room');
  const roomCodeInput = document.getElementById('room-code-input');
  const mpStatusEl = document.getElementById('multiplayer-status');

  let lobby = null;
  let pendingNetworkManager = null;
  // Bumped every time a lobby attempt starts or is cancelled. Async
  // continuations capture the value at their start and bail if it moved on,
  // so an abandoned attempt can never clobber the one that replaced it.
  let lobbySession = 0;

  // BETA LAUNCH: passthrough MR only. The VR venue picker (Arena / TT Arena)
  // is disabled — uncomment the block below to restore it for the full
  // release. Comments (and therefore this whole block) are stripped by the
  // production build, so none of it is visible in the shipped bundle. The
  // localStorage key is deliberately left alone so a pre-beta venue choice
  // comes back when the picker returns.
  const xrMode = 'ar';
  /*
  // XR mode toggle: 'ar' (passthrough, current default) vs 'vr' (dark
  // stadium venue) vs 'vr-tt' (alternate tt-arena venue). WebXR session type
  // is fixed at request time so this is pre-session. Persisted so a
  // returning player doesn't have to re-pick.
  const XR_MODE_STORAGE_KEY = 'trailclaude.xrMode';
  const VALID_MODES = new Set(['ar', 'vr', 'vr-tt']);
  let xrMode = 'ar';
  try {
    const saved = localStorage.getItem(XR_MODE_STORAGE_KEY);
    if (VALID_MODES.has(saved)) xrMode = saved;
  } catch { // localStorage disabled — stick with default
  }

  const modeToggleWrap = document.createElement('div');
  modeToggleWrap.id = 'xr-mode-toggle';
  modeToggleWrap.style.cssText = `
    display: flex; gap: 10px; flex-wrap: wrap;
  `;
  function makeModeBtn(mode, label, sub) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = mode;
    b.innerHTML = `<div style="font-weight:700">${label}</div><div style="font-size:0.75rem;opacity:0.75">${sub}</div>`;
    b.style.cssText = `
      padding: 9px 18px; border-radius: 12px; cursor: pointer;
      background: #fff; color: #4b5268; transition: all 0.15s;
      border: 2px solid #e6e9f4; font-family: inherit; text-align: center;
      box-shadow: 0 4px 12px rgba(38,43,82,0.06);
    `;
    b.addEventListener('click', () => {
      xrMode = mode;
      try { localStorage.setItem(XR_MODE_STORAGE_KEY, mode); } catch {}
      refreshModeBtns();
    });
    return b;
  }
  const arBtn   = makeModeBtn('ar',    'Room',     'passthrough MR');
  const vrBtn   = makeModeBtn('vr',    'Arena',    'stadium venue');
  const vrTTBtn = makeModeBtn('vr-tt', 'TT Arena', 'new venue');
  modeToggleWrap.append(arBtn, vrBtn, vrTTBtn);
  // The landing page provides a dedicated slot; fall back to inserting
  // before the Enter button for older markup.
  const modeSlot = document.getElementById('xr-mode-slot');
  if (modeSlot) modeSlot.append(modeToggleWrap);
  else enterMRBtn.before(modeToggleWrap);
  function refreshModeBtns() {
    for (const b of [arBtn, vrBtn, vrTTBtn]) {
      const active = b.dataset.mode === xrMode;
      b.style.borderColor = active ? '#4f46e5' : '#e6e9f4';
      b.style.background  = active ? 'rgba(79,70,229,0.08)' : '#fff';
      b.style.color       = active ? '#4f46e5' : '#4b5268';
    }
    enterMRBtn.textContent = xrMode === 'ar' ? 'Enter Mixed Reality' : 'Enter Arena';
  }
  refreshModeBtns();
  */

  function setMpStatus(text, isError = false) {
    if (!mpStatusEl) return;
    mpStatusEl.textContent = text || '';
    mpStatusEl.style.color = isError ? '#dc2626' : '#4f46e5';
  }

  function setEnterMrEnabled(enabled, hint) {
    enterMRBtn.disabled = !enabled;
    enterMRBtn.title = enabled ? '' : (hint || '');
  }

  enterMRBtn.addEventListener('click', () => {
    // If a lobby negotiation is in flight but hasn't produced a NetworkManager
    // yet, entering MR would silently drop into solo mode. Block the click.
    if (lobby && !pendingNetworkManager) {
      setMpStatus('Still connecting to your opponent — wait for the ✓ Connected message (or click Create/Join again to start over).', true);
      return;
    }
    startInGame({
      overlay,
      loadingScreen,
      statusEl,
      xrMode,
      multiplayer: pendingNetworkManager
        ? { networkManager: pendingNetworkManager, role: pendingNetworkManager.role, lobby }
        : null,
    });
  });

  let enterDesktopBtn = document.getElementById('enter-desktop');
  if (!enterDesktopBtn) {
    enterDesktopBtn = document.createElement('button');
    enterDesktopBtn.id = 'enter-desktop';
    enterDesktopBtn.textContent = 'Desktop Preview';
    enterDesktopBtn.style.cssText = `
      margin-top: 12px; padding: 12px 36px; font-size: 1rem;
      border: 2px solid rgba(255,255,255,0.2); border-radius: 12px;
      background: transparent; color: #aaa; cursor: pointer;
      transition: all 0.2s;
    `;
    enterMRBtn.after(enterDesktopBtn);
  }
  enterDesktopBtn.addEventListener('click', () => startDesktop({ overlay, loadingScreen, statusEl }));

  function wireHelloEcho(nm, role) {
    nm.on('eventMessage', (msg) => {
      if (msg && msg.type === 'HELLO') {
        console.log(`[multiplayer] received HELLO from peer (${msg.from}); local=${role}`);
      }
    });
  }

  // Cancel whatever lobby attempt is in flight (if any) and invalidate its
  // pending continuations. Clicking Create/Join always lands here first, so
  // a stuck attempt is escaped by simply clicking again — never by reloading.
  async function resetLobby() {
    lobbySession++;
    const old = lobby;
    lobby = null;
    pendingNetworkManager = null;
    if (old) {
      try { await old.teardown(); } catch { /* best-effort */ }
    }
  }

  function friendlyLobbyError(err, code) {
    const msg = String((err && err.message) || err || '');
    if (msg.includes('ROOM_NOT_FOUND')) return `Room ${code} not found — double-check the code with your friend.`;
    if (msg.includes('ROOM_FULL')) return `Room ${code} already has two players. Ask your friend to create a new room.`;
    if (msg.includes('ICE_TIMEOUT')) return 'Could not connect to the other player (network issue). Both of you: try again with a new room.';
    // Unrecognized failure: keep the raw SDK/SDP error out of the UI.
    console.error('lobby error:', err);
    return 'Connection failed — check your internet connection and try again.';
  }

  function onLobbyConnected(nm, role) {
    pendingNetworkManager = nm;
    wireHelloEcho(nm, role);
    nm.sendEvent({ type: 'HELLO', from: role });
    setMpStatus(`✓ Opponent connected! Click “${enterMRBtn.textContent}” — start playing once you're both in.`);
    setEnterMrEnabled(true);
  }

  async function handleCreate() {
    await resetLobby();
    const mySession = lobbySession;
    lobby = new LobbyManager();
    setEnterMrEnabled(false, 'Waiting for opponent…');
    setMpStatus('Creating room…');
    try {
      const { code, ready } = lobby.createRoom();
      setMpStatus(`Room code: ${code} — share it with your opponent and wait here. (Click Create again for a new code.)`);
      const nm = await ready;
      if (lobbySession !== mySession) return; // cancelled or replaced meanwhile
      onLobbyConnected(nm, 'host');
    } catch (err) {
      if (lobbySession !== mySession) return; // failure from an attempt we already abandoned
      console.error('createRoom failed:', err);
      setMpStatus(friendlyLobbyError(err, ''), true);
      await resetLobby();
      setEnterMrEnabled(true);
    }
  }

  async function handleJoin() {
    const code = (roomCodeInput.value || '').trim().toUpperCase();
    if (code.length !== 6) {
      setMpStatus('Room codes are 6 characters — check the code and try again.', true);
      return;
    }
    await resetLobby();
    const mySession = lobbySession;
    lobby = new LobbyManager();
    setEnterMrEnabled(false, 'Connecting to host…');
    setMpStatus(`Joining ${code}…`);
    try {
      const nm = await lobby.joinRoom(code);
      if (lobbySession !== mySession) return; // cancelled or replaced meanwhile
      onLobbyConnected(nm, 'guest');
    } catch (err) {
      if (lobbySession !== mySession) return;
      console.error('joinRoom failed:', err);
      setMpStatus(friendlyLobbyError(err, code), true);
      await resetLobby();
      setEnterMrEnabled(true);
    }
  }

  if (createRoomBtn) createRoomBtn.addEventListener('click', handleCreate);
  if (joinRoomBtn) joinRoomBtn.addEventListener('click', handleJoin);
  if (roomCodeInput) {
    roomCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleJoin();
    });
  }
}
