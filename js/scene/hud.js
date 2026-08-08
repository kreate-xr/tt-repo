// Debug HUD (visible in headset). Singleton DOM overlay.

export const SELF_TEST = new URLSearchParams(window.location.search).has('selftest');

let debugHud = null;
const debugLines = [];
const DEBUG_HUD_MAX_LINES = 8;
const DEBUG_HUD_FADE_MS = 3000;

export function initDebugHud() {
  if (debugHud) return;
  debugHud = document.createElement('div');
  debugHud.style.cssText = `
    position:fixed; bottom:12px; left:12px; right:12px;
    font:13px/1.4 monospace; color:#0f0; background:rgba(0,0,0,0.7);
    padding:8px 10px; border-radius:6px; z-index:9999;
    pointer-events:none; max-height:40vh; overflow:hidden;
  `;
  document.body.appendChild(debugHud);
}

export function hudLog(msg) {
  console.log(msg);
  if (!debugHud) return;
  debugLines.push({ text: msg, time: Date.now() });
  if (debugLines.length > DEBUG_HUD_MAX_LINES) debugLines.shift();
  refreshHud();
}

export function refreshHud() {
  if (!debugHud) return;
  const now = Date.now();
  while (debugLines.length && now - debugLines[0].time > DEBUG_HUD_FADE_MS) debugLines.shift();
  debugHud.innerHTML = debugLines.map(l => {
    const age = now - l.time;
    const opacity = Math.max(0, 1 - age / DEBUG_HUD_FADE_MS);
    const color = l.text.includes('HIT!') ? '#0f0' :
                  l.text.includes('MISS') ? '#ff0' :
                  l.text.includes('BLOCK') ? '#f80' :
                  l.text.includes('FAIL') ? '#f00' : '#0ff';
    return `<div style="opacity:${opacity.toFixed(2)};color:${color}">${l.text}</div>`;
  }).join('');
}

export function isDebugHudReady() {
  return debugHud !== null;
}
