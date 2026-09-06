import './scene/sceneSetup.js';
import { startInGame } from './modes/inGame.js';
// BETA LAUNCH: desktop mode is off the landing page, so it is not imported
// either — this keeps js/modes/desktop.js out of the bundle. Restore
// alongside the button in index.html / js/ui/overlay.js.
// import { startDesktop } from './modes/desktop.js';
import { wireOverlay } from './ui/overlay.js';
import { mark, recordError, installUnloadFlush } from './analytics/session.js';
import { wirePostSession } from './ui/postSession.js';

// Last-resort visibility for anything that slips past local handlers —
// without these, a rejected promise in the network stack dies silently.
// They also feed the session doc: a console.error nobody is attached to see
// is worth nothing on a stranger's headset, and these two handlers are the
// only place an unexpected failure reliably surfaces.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason);
  recordError(e.reason, 'unhandledrejection');
});
window.addEventListener('error', (e) => {
  console.error('[uncaught error]', e.error || e.message);
  recordError(e.error || e.message, 'error');
});

mark('pageLoad');
// Catches the tab going away without an XR 'end' event — headset removed
// mid-session, browser killed. The 'end' handler is still the primary path.
installUnloadFlush();
wirePostSession();

const overlay = document.getElementById('overlay');
const loadingScreen = document.getElementById('loading');
const statusEl = document.getElementById('status');

wireOverlay({
  overlay,
  loadingScreen,
  statusEl,
  startInGame,
  // startDesktop,
});
