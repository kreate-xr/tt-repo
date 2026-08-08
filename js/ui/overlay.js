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
  } catch { /* localStorage disabled — stick with default */ }

  const modeToggleWrap = document.createElement('div');
  modeToggleWrap.id = 'xr-mode-toggle';
  modeToggleWrap.style.cssText = `
    display: flex; gap: 8px; margin-top: 12px; justify-content: center;
  `;
  function makeModeBtn(mode, label, sub) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = mode;
    b.innerHTML = `<div style="font-weight:600">${label}</div><div style="font-size:0.75rem;opacity:0.75">${sub}</div>`;
    b.style.cssText = `
      padding: 8px 16px; border-radius: 10px; cursor: pointer;
      background: transparent; color: #ddd; transition: all 0.15s;
      border: 2px solid rgba(255,255,255,0.15);
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
  enterMRBtn.before(modeToggleWrap);
  function refreshModeBtns() {
    for (const b of [arBtn, vrBtn, vrTTBtn]) {
      const active = b.dataset.mode === xrMode;
      b.style.borderColor = active ? '#8ea6ff' : 'rgba(255,255,255,0.15)';
      b.style.background  = active ? 'rgba(142,166,255,0.12)' : 'transparent';
      b.style.color       = active ? '#fff' : '#ddd';
    }
    enterMRBtn.textContent = xrMode === 'ar' ? 'Enter Mixed Reality' : 'Enter Arena';
  }
  refreshModeBtns();

  function setMpStatus(text, isError = false) {
    if (!mpStatusEl) return;
    mpStatusEl.textContent = text || '';
    mpStatusEl.style.color = isError ? '#ff8888' : '#8ad';
  }

  function setEnterMrEnabled(enabled, hint) {
    enterMRBtn.disabled = !enabled;
    enterMRBtn.title = enabled ? '' : (hint || '');
  }

  enterMRBtn.addEventListener('click', () => {
    // If a lobby negotiation is in flight but hasn't produced a NetworkManager
    // yet, entering MR would silently drop into solo mode. Block the click.
    if (lobby && !pendingNetworkManager) {
      setMpStatus('Still connecting — please wait for "Peer says hi" before entering.', true);
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
        setMpStatus(`Connected as ${role}. Peer says hi. Click Enter Mixed Reality.`);
      }
    });
  }

  async function handleCreate() {
    if (lobby) {
      setMpStatus('Already in a lobby. Reload to reset.', true);
      return;
    }
    setMpStatus('Connecting to signaling…');
    setEnterMrEnabled(false, 'Waiting for opponent…');
    lobby = new LobbyManager();
    try {
      const { code, ready } = lobby.createRoom();
      setMpStatus(`Room code: ${code}  —  share with opponent. Waiting…`);
      const nm = await ready;
      pendingNetworkManager = nm;
      wireHelloEcho(nm, 'host');
      nm.sendEvent({ type: 'HELLO', from: 'host' });
      setMpStatus(`Connected as host. Click Enter Mixed Reality to start.`);
      setEnterMrEnabled(true);
    } catch (err) {
      console.error('createRoom failed:', err);
      setMpStatus(`Room failed: ${err.message || err}`, true);
      if (lobby) await lobby.teardown();
      lobby = null;
      pendingNetworkManager = null;
      setEnterMrEnabled(true);
    }
  }

  async function handleJoin() {
    if (lobby) {
      setMpStatus('Already in a lobby. Reload to reset.', true);
      return;
    }
    const code = (roomCodeInput.value || '').trim().toUpperCase();
    if (code.length < 4) {
      setMpStatus('Enter a valid room code.', true);
      return;
    }
    setMpStatus(`Joining ${code}…`);
    setEnterMrEnabled(false, 'Connecting to host…');
    lobby = new LobbyManager();
    try {
      const nm = await lobby.joinRoom(code);
      pendingNetworkManager = nm;
      wireHelloEcho(nm, 'guest');
      nm.sendEvent({ type: 'HELLO', from: 'guest' });
      setMpStatus(`Connected as guest. Click Enter Mixed Reality to start.`);
      setEnterMrEnabled(true);
    } catch (err) {
      console.error('joinRoom failed:', err);
      setMpStatus(`Join failed: ${err.message || err}`, true);
      if (lobby) await lobby.teardown();
      lobby = null;
      pendingNetworkManager = null;
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
