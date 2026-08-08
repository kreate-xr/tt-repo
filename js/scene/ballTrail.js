// Ball motion trail (spec P12) — velocity-aligned fading streak that appears
// only above a speed threshold. Solves a specific VR-realism problem:
//
// At 90 Hz XR framerate, a 15 m/s smash moves ~17 cm per frame — four ball
// diameters between refreshes. Without persistence-of-vision motion blur
// (which real eyes provide but stereo VR renderers do not), the ball reads
// as *teleporting* rather than *moving*. The brain uses streak information
// for velocity estimation and return-timing; without it, fast shots feel
// "cheap" and are hard to track. The ball's cast shadow gives position but
// not velocity — the streak is the missing velocity cue.
//
// Implementation: ring buffer of the last N world positions rendered as a
// THREE.Line with per-vertex colors. Additive blending + darker RGB toward
// the tail produces a natural fade without requiring per-vertex alpha
// support. Head brightness ramps in over a soft speed window so the trail
// doesn't pop on/off at the exact threshold.

import * as THREE from 'three';

// Length of position history in the buffer. Longer = more streak, but at
// very high speeds the streak grows visually huge; capping keeps it
// reasonable across the full speed range. At 90 Hz, 10 samples = 111 ms of
// history — enough to show motion but not so long the streak becomes a
// distraction.
export const TRAIL_SAMPLES = 10;

// Speed window for the trail's fade-in. Below TRAIL_MIN_SPEED it's fully
// invisible; above TRAIL_MAX_SPEED it's at full head brightness. Between
// them the head brightness ramps linearly. Spec P12 says "≥ 8 m/s"; using
// 6 → 10 m/s gives a soft ramp centered on that.
const TRAIL_MIN_SPEED = 6.0;
const TRAIL_MAX_SPEED = 10.0;

// Peak head brightness (RGB 0..1). Kept below 1.0 so the trail reads as a
// faint streak rather than a bright saber — the goal is a *velocity cue*,
// not a visual effect that dominates the ball itself.
const TRAIL_HEAD_BRIGHTNESS = 0.35;

// Number of newest samples to hide. The visible trail's leading vertex
// sits N frames behind the ball — at 90 Hz that's ~22 ms per skip, which
// at even 6 m/s (the trail's minimum speed) puts the trail head ~13 cm
// behind the ball, well clear of the ball's 4 cm diameter.
//
// Fixes the "chopping through ball" artifact that got the trail
// originally disabled: the ring buffer captures positions on both sides
// of a bounce, and the additive+depthWrite=false line paints that kink
// through the ball if the trail head sits on the ball itself. Skipping
// keeps the sharp kink hidden inside the ball's opaque geometry.
export const TRAIL_HEAD_SKIP = 2;

// Minimum buffered samples before anything can be drawn. A line needs 2
// vertices, and the newest TRAIL_HEAD_SKIP are hidden behind the ball, so the
// buffer has to hold both before the trail can appear.
//
// Derived rather than written as a literal: this used to be an inline
// `_sampleCount < TRAIL_HEAD_SKIP + 2` check, and when the head skip was
// introduced the visibility threshold silently moved from 2 samples to 4.
// Tests written against the old contract kept asserting visibility after 2
// pushes and simply started failing. Exporting the derived value lets them
// assert the relationship instead of a stale number.
export const TRAIL_MIN_VISIBLE_SAMPLES = TRAIL_HEAD_SKIP + 2;

let _trailLine = null;
let _positions = null;      // Float32Array (TRAIL_SAMPLES * 3) — line vertex positions
let _colors = null;         // Float32Array (TRAIL_SAMPLES * 3) — per-vertex RGB
let _buffer = null;         // ring buffer of THREE.Vector3, oldest → newest
let _bufferIdx = 0;
let _sampleCount = 0;

/**
 * Create the trail line and attach it to the scene. Call once at scene setup,
 * after the ball has been added. Idempotent — a second call is a no-op.
 */
export function createBallTrail(scene) {
  if (_trailLine) return _trailLine;

  _positions = new Float32Array(TRAIL_SAMPLES * 3);
  _colors = new Float32Array(TRAIL_SAMPLES * 3);
  _buffer = new Array(TRAIL_SAMPLES);
  for (let i = 0; i < TRAIL_SAMPLES; i++) _buffer[i] = new THREE.Vector3();

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(_positions, 3));
  geom.setAttribute('color',    new THREE.BufferAttribute(_colors, 3));

  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    // Additive blending + dark→bright vertex colors fakes an alpha fade
    // without needing per-vertex alpha support. Depth-write off so the
    // streak doesn't punch through the ball's own depth on close approach.
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    linewidth: 2,   // GPU-dependent; on most WebGL impls this is 1 anyway
  });

  _trailLine = new THREE.Line(geom, mat);
  _trailLine.frustumCulled = false;    // ball is small; frustum culling on a
                                       // tiny line is more overhead than gain
  _trailLine.visible = false;
  scene.add(_trailLine);
  return _trailLine;
}

/**
 * Feed the trail a new ball world position + current speed. Call once per
 * physics or render tick from the ball tick, AFTER the ball's position has
 * been integrated for this frame.
 */
export function updateBallTrail(ballPos, speed) {
  if (!_trailLine) return;

  // Push into ring buffer regardless of visibility — otherwise a fast shot
  // that dips below threshold and back would show a stale trail from
  // wherever the ball was last.
  _buffer[_bufferIdx].copy(ballPos);
  _bufferIdx = (_bufferIdx + 1) % TRAIL_SAMPLES;
  if (_sampleCount < TRAIL_SAMPLES) _sampleCount++;

  // Need at least 2 visible samples AFTER the head skip to draw a line.
  if (speed < TRAIL_MIN_SPEED || _sampleCount < TRAIL_MIN_VISIBLE_SAMPLES) {
    _trailLine.visible = false;
    return;
  }

  // Linear ramp of head brightness across the speed window. Prevents the
  // trail from popping on at exactly the threshold.
  const t = Math.min(1, (speed - TRAIL_MIN_SPEED) / (TRAIL_MAX_SPEED - TRAIL_MIN_SPEED));
  const headBrightness = TRAIL_HEAD_BRIGHTNESS * t;

  // Walk the ring buffer oldest → newest, writing to the line's vertex
  // buffers. Age fraction: 0 = oldest sample (tail, dark), 1 = newest
  // (head, bright). Squared falloff on brightness so the tail fades faster
  // than linear — more motion-blur-shaped.
  for (let i = 0; i < TRAIL_SAMPLES; i++) {
    // Ring index oldest-first. When count < capacity we haven't wrapped, so
    // the oldest is index 0; once wrapped, oldest is at _bufferIdx.
    const wrapped = _sampleCount === TRAIL_SAMPLES;
    const srcIdx = wrapped
      ? (_bufferIdx + i) % TRAIL_SAMPLES
      : Math.min(i, _sampleCount - 1);
    const pos = _buffer[srcIdx];
    const o = i * 3;
    _positions[o]     = pos.x;
    _positions[o + 1] = pos.y;
    _positions[o + 2] = pos.z;

    const age = i / (TRAIL_SAMPLES - 1);    // 0 tail → 1 head
    const brightness = headBrightness * age * age;
    _colors[o]     = brightness;
    _colors[o + 1] = brightness;
    _colors[o + 2] = brightness;
  }

  _trailLine.geometry.attributes.position.needsUpdate = true;
  _trailLine.geometry.attributes.color.needsUpdate = true;
  // Only draw the range we've actually filled MINUS the head skip — the
  // newest TRAIL_HEAD_SKIP vertices are hidden behind the ball so we don't
  // paint through it at bounce kinks.
  _trailLine.geometry.setDrawRange(0, _sampleCount - TRAIL_HEAD_SKIP);
  _trailLine.visible = true;
}

/**
 * Drop all buffered history. Call from spawnBallAt so the trail doesn't
 * span from the ball's last life to its new spawn point.
 */
export function resetBallTrail() {
  _bufferIdx = 0;
  _sampleCount = 0;
  if (_trailLine) _trailLine.visible = false;
}

// Test-only accessors.
export function _trailStateForTest() {
  return {
    line: _trailLine,
    sampleCount: _sampleCount,
    positions: _positions,
    colors: _colors,
    visible: _trailLine ? _trailLine.visible : false,
  };
}
