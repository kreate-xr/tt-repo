// Thermal-throttle detector for Quest 3S. The headset has no fan, so under
// sustained load (WebXR render + physics + WebRTC) the Snapdragon XR2 Gen 2
// starts down-clocking. Symptoms: frame dt creeps from 11 ms → 20 ms+, packet
// backlog grows, opponent desyncs. The browser does not surface this state.
//
// Heuristic: 10-frame rolling average of dt. If avg > 20 ms, declare
// throttled. State changes fire a one-shot listener callback (no flood).
//
// Usage from the multiplayer drill:
//   ThermalMonitor.onChange(({ throttled }) => { ... });
//   // per render frame:
//   ThermalMonitor.tick();

const FRAME_HISTORY = 10;
const THERMAL_THRESHOLD_MS = 20;

let deltas = [];
let lastTime = (typeof performance !== 'undefined' ? performance : Date).now();
let throttled = false;
const listeners = [];

export function tick() {
  const now = performance.now();
  const dt = now - lastTime;
  lastTime = now;
  deltas.push(dt);
  if (deltas.length > FRAME_HISTORY) deltas.shift();

  // Wait for the buffer to fill before declaring — single 20ms hitches (e.g.
  // GC pause) should not flip the flag.
  if (deltas.length < FRAME_HISTORY) return;

  let sum = 0;
  for (const d of deltas) sum += d;
  const avg = sum / deltas.length;
  const isThrottled = avg > THERMAL_THRESHOLD_MS;

  if (isThrottled !== throttled) {
    throttled = isThrottled;
    for (const fn of listeners) {
      try { fn({ throttled, avgFrameMs: avg }); }
      catch (e) { console.error('ThermalMonitor listener threw:', e); }
    }
  }
}

export function onChange(fn) {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function isThrottled() { return throttled; }

// Test/reset hook — used at session boundaries so a fresh game doesn't
// inherit thermal state from a prior run.
export function reset() {
  deltas = [];
  lastTime = performance.now();
  throttled = false;
}
