// Shared AudioContext for the page lifetime. Must be created BEFORE entering
// a WebXR session — on Quest browser, allowing WebXR to spin up its own audio
// graph after WebRTC/WebAudio is already active makes the headset volume
// rocker stop controlling master volume.
//
// init() is idempotent and safe to call from anywhere. getContext() returns
// null until init() has been called, so callers (e.g. scene/audio.js) can
// fall back to lazy creation outside XR.

let sharedContext = null;
let initPromise = null;

export function init() {
  if (sharedContext) return Promise.resolve(sharedContext);
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error('AudioContext unsupported in this browser');
    sharedContext = new AudioCtor();
    if (sharedContext.state === 'suspended') {
      try { await sharedContext.resume(); } catch {}
    }
    return sharedContext;
  })();
  return initPromise;
}

export function getContext() {
  return sharedContext;
}

export function isInitialized() {
  return sharedContext !== null;
}
