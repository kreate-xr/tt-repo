// In-headset frame-rate meter. A small billboarded canvas chip that floats
// near the top of the player's view and reports:
//
//   90.0 FPS · 11.1 ms        (windowed average, color-coded vs. target)
//   drops 2/5s                (frames whose display interval was ≥1.5× the
//                              refresh period — i.e. compositor-visible skips)
//
// Why an in-scene mesh and not DOM: dom-overlay is only honored on
// immersive-ar sessions on Quest — in VR arena mode a DOM meter is invisible
// (same reason the loading panel in inGame.js is a mesh). One chip works in
// both session types.
//
// Why it measures RAW timestamp deltas: the caller feeds it dt derived from
// the XR frame's predicted display time BEFORE the physics hitch cap. Those
// deltas are exact multiples of the display interval, so "dt ≥ 1.5× period"
// is precisely "the compositor skipped at least one frame" — no jitter
// heuristics needed.
//
// Cost discipline: the canvas repaints at most 4×/s and only when the text
// actually changed; the per-frame work is a ring-buffer write and a couple
// of vector ops for the follow behavior.

import * as THREE from 'three';

// Hide with ?nofps. Default-on: the meter exists to catch drops in normal
// play, which is exactly when nobody remembered to add a debug flag.
// typeof guard so the module can be imported under jest (no window there) —
// estimateDisplayHz below is unit-tested.
export const FPS_METER_ENABLED = typeof window === 'undefined'
  ? false
  : !new URLSearchParams(window.location.search).has('nofps');

const WINDOW_FRAMES = 120;      // ~1.3 s at 90 Hz — fast but not twitchy
const DROP_WINDOW_S = 5;        // rolling window for the drop counter
// Repaint rate. Every repaint re-uploads the whole canvas to the GPU, and a
// texture upload mid-frame can itself cost a frame — a debug overlay that
// creates the drops it reports is worse than useless. 2 Hz on a small canvas
// keeps the upload traffic negligible (see canvas sizing in createFpsMeter),
// and the displayed values are quantised so an unchanged string skips the
// upload entirely.
const REDRAW_INTERVAL_S = 0.5;
const PAD_X = 20;               // canvas px of breathing room each side
const BASE_FONT_PX = 32;
const MIN_FONT_PX = 18;
const DROP_FACTOR = 1.5;        // dt ≥ 1.5× refresh period ⇒ skipped frame

// Follow behavior: sits 1.3 m ahead, raised so it rests near the top edge of
// comfortable FOV instead of over the action. Exponential smoothing (τ) so a
// head turn makes it glide rather than stick — hard head-locking a HUD chip
// reads as "painted on my eye" and is mildly nauseating.
const FOLLOW_DISTANCE = 1.3;
const FOLLOW_RAISE = 0.32;
const FOLLOW_TAU_S = 0.25;

const _camPos = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _targetPos = new THREE.Vector3();

// Display rates a headset or monitor plausibly runs at. Estimates snap to the
// nearest of these so the drop threshold doesn't wander frame to frame.
const KNOWN_RATES = [60, 72, 80, 90, 120, 144];
const SNAP_TOLERANCE_HZ = 12;
// Sanity bounds on the estimate. Anything outside is a bad sample, not a
// display — clamping keeps one bogus interval from setting an absurd period.
const MIN_PLAUSIBLE_HZ = 30;
const MAX_PLAUSIBLE_HZ = 240;

const _sortScratch = new Float32Array(WINDOW_FRAMES);

/**
 * Estimate the display refresh rate (Hz) from a window of frame intervals.
 *
 * Uses the MEDIAN interval, deliberately. The first version of this used the
 * minimum, on the reasoning that the shortest interval must be a clean
 * single-frame delta — but that makes the estimate maximally fragile: one
 * anomalously short interval (the XR runtime bursting two frames after a
 * stall, or near-duplicate timestamps) drags the estimated rate to hundreds
 * of Hz, which collapses the drop threshold, which makes every subsequent
 * NORMAL frame register as a dropped one. That reported ~200 drops/5s on a
 * session that was in fact holding a clean 90 Hz.
 *
 * The median is robust to outliers at both ends — short bursts and long
 * hitches alike — and is correct whenever most frames are delivered on time,
 * which is exactly the regime where the drop count carries information.
 *
 * @param {ArrayLike<number>} samples  frame intervals in seconds
 * @param {number} [count]             how many leading entries are valid
 * @returns {number} estimated refresh rate in Hz
 */
export function estimateDisplayHz(samples, count = samples.length) {
  const n = Math.min(count, samples.length);
  if (n <= 0) return 90;

  const scratch = n <= _sortScratch.length ? _sortScratch : new Float32Array(n);
  for (let i = 0; i < n; i++) scratch[i] = samples[i];
  // TypedArray#sort is numeric ascending; subarray shares the buffer so this
  // sorts exactly the populated region.
  const view = scratch.subarray(0, n);
  view.sort();
  const median = view[n >> 1];
  if (!(median > 0)) return 90;

  const rawHz = Math.min(MAX_PLAUSIBLE_HZ, Math.max(MIN_PLAUSIBLE_HZ, 1 / median));

  let target = KNOWN_RATES[0];
  let best = Infinity;
  for (const hz of KNOWN_RATES) {
    const d = Math.abs(hz - rawHz);
    if (d < best) { best = d; target = hz; }
  }
  // Off-list display (desktop preview, unusual panel): keep the raw estimate.
  return best > SNAP_TOLERANCE_HZ ? Math.round(rawHz) : target;
}

export function createFpsMeter(scene) {
  const canvas = document.createElement('canvas');
  // 640×80 = 205 kB per upload, less than half the previous 960×120. At the
  // 2 Hz repaint rate that is ~0.4 MB/s of texture traffic worst case, and
  // usually far less since an unchanged string skips the upload. Sized so the
  // widest string this can produce ("119 FPS · 8.3 ms · drops 148/5s") fits at
  // BASE_FONT_PX inside PAD_X; redraw() additionally shrinks-to-fit, so
  // nothing can spill past the background whatever the device font metrics.
  canvas.width = 640;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, side: THREE.DoubleSide, depthTest: false,
  });
  // 30 cm × 3.75 cm at 1.3 m ≈ 13° × 1.7° of view — legible, not intrusive.
  // Plane aspect matches the canvas (640:80 = 8:1) so glyphs aren't stretched.
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.0375), material);
  mesh.renderOrder = 998; // above scene, below the loading panel's 999
  mesh.frustumCulled = false;
  mesh.visible = FPS_METER_ENABLED;
  scene.add(mesh);

  // Frame-interval ring buffer.
  const dts = new Float32Array(WINDOW_FRAMES);
  let dtCount = 0;
  let dtIdx = 0;
  // Timestamps (in accumulated meter time) of recent dropped frames.
  const dropTimes = [];
  let periodS = 1 / 90;     // refined from the interval window at each redraw
  let periodValid = false;  // no drop counting until the estimate is real
  let timeS = 0;
  let sinceRedraw = 0;
  let lastText = '';
  let followSnapped = false;

  function redraw(fps, ms, target, drops) {
    // Quantised: whole FPS, tenths of a millisecond. Finer precision than the
    // eye can use off a floating HUD, and it makes the string repeat often
    // enough that most repaints (and their GPU uploads) are skipped outright.
    const text = `${Math.round(fps)} FPS · ${ms.toFixed(1)} ms · drops ${drops}/${DROP_WINDOW_S}s`;
    if (text === lastText) return;
    lastText = text;

    // Green within 5% of target, amber within 20%, red below that.
    const color = fps >= target * 0.95 ? '#00ff88'
                : fps >= target * 0.80 ? '#ffcc44'
                : '#ff5566';

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(8, 10, 20, 0.78)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 18);
    ctx.fill();

    // Shrink-to-fit: measure at the preferred size and step down until the
    // string clears the horizontal padding. The drop counter grows a digit
    // under sustained hitching, which is exactly when the meter must stay
    // readable rather than clip.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxWidth = canvas.width - PAD_X * 2;
    let fontPx = BASE_FONT_PX;
    do {
      ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
      if (ctx.measureText(text).width <= maxWidth) break;
      fontPx -= 2;
    } while (fontPx > MIN_FONT_PX);

    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
    texture.needsUpdate = true;
  }

  return {
    mesh,

    /**
     * Call once per rendered frame.
     * @param {number} rawDtS  display-time delta in seconds, UNCAPPED — feed
     *                         the timestamp delta, not the physics dt, or
     *                         hitches disappear from the very meter meant to
     *                         show them.
     * @param {THREE.Camera} xrCamera  renderer.xr.getCamera()
     */
    update(rawDtS, xrCamera) {
      if (!mesh.visible) return;
      timeS += rawDtS;

      dts[dtIdx] = rawDtS;
      dtIdx = (dtIdx + 1) % WINDOW_FRAMES;
      if (dtCount < WINDOW_FRAMES) dtCount++;

      // Drop detection is per-frame and incremental (exact), against the
      // period estimate refined at the last redraw. Suppressed until that
      // estimate exists — the 1/90 prior would misjudge a 60 Hz display's
      // every frame as a drop during the first quarter-second.
      if (periodValid && rawDtS >= periodS * DROP_FACTOR) dropTimes.push(timeS);
      while (dropTimes.length && dropTimes[0] < timeS - DROP_WINDOW_S) dropTimes.shift();

      // --- Follow the view (smoothed) ---
      xrCamera.getWorldPosition(_camPos);
      xrCamera.getWorldDirection(_camFwd);
      _targetPos.copy(_camPos)
        .addScaledVector(_camFwd, FOLLOW_DISTANCE)
        .addScaledVector(THREE.Object3D.DEFAULT_UP, FOLLOW_RAISE);
      if (!followSnapped) {
        mesh.position.copy(_targetPos);
        followSnapped = true;
      } else {
        const alpha = 1 - Math.exp(-rawDtS / FOLLOW_TAU_S);
        mesh.position.lerp(_targetPos, alpha);
      }
      mesh.lookAt(_camPos);

      // --- Stats (redrawn at 4 Hz) ---
      sinceRedraw += rawDtS;
      if (sinceRedraw < REDRAW_INTERVAL_S || dtCount < 10) return;
      sinceRedraw = 0;

      let sum = 0;
      for (let i = 0; i < dtCount; i++) sum += dts[i];
      const avgDt = sum / dtCount;
      const fps = 1 / avgDt;

      const target = estimateDisplayHz(dts, dtCount);
      periodS = 1 / target;
      periodValid = true;

      redraw(fps, avgDt * 1000, target, dropTimes.length);
    },

    setVisible(v) { mesh.visible = v; },

    dispose() {
      if (mesh.parent) mesh.parent.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
