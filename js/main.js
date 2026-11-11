// First import in the graph: the container bootstrap should not sit behind
// three.js evaluating. See js/analytics/gtm.js — it is a module rather than
// the inline snippet because the CSP has no 'unsafe-inline'.
import './analytics/gtm.js';
import './scene/sceneSetup.js';
import { startInGame } from './modes/inGame.js';
import { wireOverlay } from './ui/overlay.js';
import { mark, recordError, installUnloadFlush } from './analytics/session.js';
import { wirePostSession } from './ui/postSession.js';
import { wireAccountPanel } from './ui/accountPanel.js';
import { refreshProgress } from './ui/progressPanel.js';

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
wireAccountPanel();
refreshProgress();

const overlay = document.getElementById('overlay');
const loadingScreen = document.getElementById('loading');
const statusEl = document.getElementById('status');

wireOverlay({
  overlay,
  loadingScreen,
  statusEl,
  startInGame,
});
