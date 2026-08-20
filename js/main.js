import './scene/sceneSetup.js';
import { startInGame } from './modes/inGame.js';
import { startDesktop } from './modes/desktop.js';
import { wireOverlay } from './ui/overlay.js';

// Last-resort visibility for anything that slips past local handlers —
// without these, a rejected promise in the network stack dies silently.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason);
});
window.addEventListener('error', (e) => {
  console.error('[uncaught error]', e.error || e.message);
});

const overlay = document.getElementById('overlay');
const loadingScreen = document.getElementById('loading');
const statusEl = document.getElementById('status');

wireOverlay({
  overlay,
  loadingScreen,
  statusEl,
  startInGame,
  startDesktop,
});
