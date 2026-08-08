import './scene/sceneSetup.js';
import { startInGame } from './modes/inGame.js';
import { startDesktop } from './modes/desktop.js';
import { wireOverlay } from './ui/overlay.js';

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
