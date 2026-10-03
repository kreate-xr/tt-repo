// Start-screen wiring. Two flows:
//   - Solo: click a venue button (Mixed Reality / Focus Room) → straight
//     into XR. The venue IS the entry point; there is no second Enter step.
//     The Desktop Preview escape hatch is commented out for the beta launch
//     (below, and in index.html).
//   - Multiplayer: Create Room / Join Room → lobby negotiates a peer
//     connection BEFORE entering XR, then both peers click a venue with the
//     live NetworkManager handed through.

import { friendlyLobbyError } from '../lobby/lobbyErrors.js';
import { loadBestOf, saveBestOf, matchLengthLabel } from '../modes/matchFormat.js';
import { mark, recordJoinFailure } from '../analytics/session.js';

// LobbyManager drags in the signaling/WebRTC stack including the Firebase
// SDK (~1 MB of parse on the Quest CPU) — lazy-loaded on the first
// Create/Join click so solo and AI sessions never pay for it.
function loadLobbyManager() {
  return import('../lobby/LobbyManager.js');
}
import { XR_MODES } from './xrModes.js';
import { canEnter } from './accountPanel.js';

export function wireOverlay({ overlay, loadingScreen, statusEl, startInGame /*, startDesktop */ }) {
  const createRoomBtn = document.getElementById('create-room');
  const joinRoomBtn = document.getElementById('join-room');
  const roomCodeInput = document.getElementById('room-code-input');
  const mpStatusEl = document.getElementById('multiplayer-status');
  const bestOfSelect = document.getElementById('mp-best-of');

  let lobby = null;
  let pendingNetworkManager = null;
  // Match length for a room created HERE. Latched at Create time (below) so a
  // later fiddle with the dropdown can't change the format out from under a
  // guest who has already joined; a joiner leaves it null and adopts the
  // host's over the connection. Shares its stored value with the in-XR menus.
  let hostBestOf = null;
  if (bestOfSelect) {
    bestOfSelect.value = String(loadBestOf());
    bestOfSelect.addEventListener('change', () => {
      bestOfSelect.value = String(saveBestOf(bestOfSelect.value));
    });
  }
  // Bumped every time a lobby attempt starts or is cancelled. Async
  // continuations capture the value at their start and bail if it moved on,
  // so an abandoned attempt can never clobber the one that replaced it.
  let lobbySession = 0;

  // XR venue buttons: 'ar' (passthrough MR) and 'vr-focus' (the procedural
  // Focus Room venue — js/scene/focusRoom.js). Each button IS the entry
  // point: one click requests that session type. WebXR fixes the session
  // type at request time, which is why the venue is chosen out here rather
  // than from inside a running session.
  //
  // BETA LAUNCH: the GLB venues ('vr' stadium / 'vr-tt') are absent from
  // XR_MODES, so no button is built for them.
  const modeSlot = document.getElementById('xr-mode-slot');
  const venueBtns = XR_MODES.map((m) => {
    let b = modeSlot ? modeSlot.querySelector(`button[data-mode="${m.id}"]`) : null;
    if (!b) {
      // Markup without this venue's button — build it, so a drifted
      // index.html can never leave a shipped mode with no way in.
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'enter-venue';
      b.dataset.mode = m.id;
      const text = document.createElement('span');
      text.className = 'venue-text';
      for (const [cls, val] of [['venue-label', m.label], ['venue-sub', m.sub]]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = val;
        text.append(span);
      }
      b.append(text);
      (modeSlot || document.body).append(b);
    }
    // The visible label is just the venue name; the full call to action is
    // the accessible one.
    b.setAttribute('aria-label', m.cta);
    b.addEventListener('click', () => enterVenue(m, b));
    return b;
  });

  // Both venues ship disabled in the markup. Arming them here is the whole
  // "not until the page is ready" rule: wireOverlay runs at the end of
  // main.js, i.e. only once the scene and in-game module graph has been
  // imported, so a click can never land on a half-loaded app.
  let entryGateOpen = false;
  function setEntryEnabled(enabled, hint) {
    entryGateOpen = enabled;
    for (const b of venueBtns) {
      b.disabled = !enabled || entering;
      b.title = enabled ? '' : (hint || '');
    }
  }

  function setMpStatus(text, isError = false) {
    if (!mpStatusEl) return;
    mpStatusEl.textContent = text || '';
    mpStatusEl.style.color = isError ? '#dc2626' : '#4f46e5';
  }

  // Entry is not instant — on a re-entry startInGame deliberately waits out
  // the previous session's runtime teardown before asking for a new one, and
  // then downloads assets. Without feedback that reads as a dead button, and
  // the extra clicks it invites are exactly what used to collide with the
  // session request. Both venues stay disabled for the duration; the start
  // screen is hidden long before this resolves, so the restore lands out of
  // sight.
  let entering = false;
  function enterVenue(mode, btn) {
    if (entering || !entryGateOpen) return;
    // If a lobby negotiation is in flight but hasn't produced a NetworkManager
    // yet, entering XR would silently drop into solo mode. Block the click.
    if (lobby && !pendingNetworkManager) {
      setMpStatus('Still connecting to your opponent — wait for the ✓ Connected message (or click Create/Join again to start over).', true);
      return;
    }
    // Free trial used up and not unlocked: the paywall opens instead.
    // Synchronous on purpose — see canEnter in accountPanel.js.
    if (!canEnter()) return;
    entering = true;
    const labelEl = btn.querySelector('.venue-label');
    const label = labelEl ? labelEl.textContent : '';
    if (labelEl) labelEl.textContent = 'Starting…';
    for (const b of venueBtns) b.disabled = true;
    const restore = (err) => {
      if (err) console.error('startInGame failed:', err);
      entering = false;
      if (labelEl) labelEl.textContent = label;
      for (const b of venueBtns) b.disabled = !entryGateOpen;
    };
    const entry = startInGame({
      overlay,
      loadingScreen,
      statusEl,
      xrMode: mode.id,
      multiplayer: pendingNetworkManager
        ? {
            networkManager: pendingNetworkManager,
            role: pendingNetworkManager.role,
            lobby,
            bestOf: hostBestOf,
          }
        : null,
    });
    // startInGame resolves once the session is live (not when it ends), so the
    // buttons are armed again by the time the player is back on this screen.
    Promise.resolve(entry).then(() => restore(), restore);
  }

  setEntryEnabled(true);
  // The funnel's second step: modules are loaded and the venue buttons are
  // live. A big gap between pageLoad and this one is a bundle problem; a big
  // drop-off AFTER it is a "player looked at the page and left" problem.
  mark('entryArmed');

  // BETA LAUNCH: no Desktop Preview on the landing page — the two venue
  // buttons above are the whole choice. This block also *created* the button when the
  // markup lacked it, so it has to stay off for the markup change to hold.
  // Re-enable together with the button in index.html (and the startDesktop
  // param in the signature above).
  //
  // let enterDesktopBtn = document.getElementById('enter-desktop');
  // if (!enterDesktopBtn) {
  //   enterDesktopBtn = document.createElement('button');
  //   enterDesktopBtn.id = 'enter-desktop';
  //   enterDesktopBtn.textContent = 'Desktop Preview';
  //   enterDesktopBtn.style.cssText = `
  //     margin-top: 12px; padding: 12px 36px; font-size: 1rem;
  //     border: 2px solid rgba(255,255,255,0.2); border-radius: 12px;
  //     background: transparent; color: #aaa; cursor: pointer;
  //     transition: all 0.2s;
  //   `;
  //   modeSlot.append(enterDesktopBtn);
  // }
  // enterDesktopBtn.addEventListener('click', () => startDesktop({ overlay, loadingScreen, statusEl }));

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
    hostBestOf = null;
    if (old) {
      try { await old.teardown(); } catch { /* best-effort */ }
    }
  }

  function onLobbyConnected(nm, role) {
    pendingNetworkManager = nm;
    wireHelloEcho(nm, role);
    nm.sendEvent({ type: 'HELLO', from: role });
    setMpStatus(`✓ Opponent connected! Click ${XR_MODES.map((m) => `“${m.label}”`).join(' or ')} — start playing once you're both in.`);
    setEntryEnabled(true);
  }

  async function handleCreate() {
    await resetLobby();
    const mySession = lobbySession;
    // Latch the format for this room before the first await — resetLobby just
    // cleared it, and from here on it is what the guest will be playing.
    hostBestOf = bestOfSelect ? saveBestOf(bestOfSelect.value) : loadBestOf();
    setEntryEnabled(false, 'Waiting for opponent…');
    setMpStatus('Creating room…');
    try {
      const { LobbyManager } = await loadLobbyManager();
      if (lobbySession !== mySession) return; // cancelled while loading
      lobby = new LobbyManager();
      const codeMessage = (c) => `Room code: ${c} — ${matchLengthLabel(hostBestOf).toLowerCase()}. Share it with your opponent and wait here. (Click Create again for a new code.)`;
      const { code, ready } = lobby.createRoom({
        // Re-rolled after a collision: reprint so the code on screen is the
        // one actually being hosted.
        onCode: (next) => {
          if (lobbySession !== mySession) return;
          setMpStatus(codeMessage(next));
        },
      });
      setMpStatus(codeMessage(code));
      const nm = await ready;
      if (lobbySession !== mySession) return; // cancelled or replaced meanwhile
      onLobbyConnected(nm, 'host');
    } catch (err) {
      if (lobbySession !== mySession) return; // failure from an attempt we already abandoned
      console.error('createRoom failed:', err);
      // The one failure we cannot reproduce and the player will never report.
      recordJoinFailure('host', err);
      setMpStatus(friendlyLobbyError(err, ''), true);
      await resetLobby();
      setEntryEnabled(true);
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
    setEntryEnabled(false, 'Connecting to host…');
    setMpStatus(`Joining ${code}…`);
    try {
      const { LobbyManager } = await loadLobbyManager();
      if (lobbySession !== mySession) return; // cancelled while loading
      lobby = new LobbyManager();
      const nm = await lobby.joinRoom(code);
      if (lobbySession !== mySession) return; // cancelled or replaced meanwhile
      onLobbyConnected(nm, 'guest');
    } catch (err) {
      if (lobbySession !== mySession) return;
      console.error('joinRoom failed:', err);
      recordJoinFailure('guest', err);
      setMpStatus(friendlyLobbyError(err, code), true);
      await resetLobby();
      setEntryEnabled(true);
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
