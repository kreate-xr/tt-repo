// TEMPORARY — fast-swing tracking capture for one headset test. Remove after.
//
// Question: do fast swings (smashes, loops, flicks) miss balls that slow
// swings would hit? The Quest has no console we can read
// (headset-diagnostics round-trip), so this records each time the ball comes
// near the player's paddle and POSTs the records to the Vite dev server, which
// appends them to diag/swingcap.jsonl (gitignored, see vite.config.js).
//
// ON ONLY WITH  ?swingcap  ON THE DEV SERVER. A production build has
// __IS_DEV_SERVER__ = false, so it can never post.
//
// One record per APPROACH: the ball enters 35 cm of the paddle face and is
// followed until it is hit or moves clearly away. Per approach:
//   hit       was there a player contact
//   minD      closest ball ↔ drawn-paddle face distance (m)
//   rawD      ball ↔ REAL controller face distance at that moment (m)
//   lag       drawn paddle ↔ real controller gap at that moment (m): the
//             smoothing lag on fast swings
//   speed     raw paddle speed at the closest moment (m/s)
//   peak      peak raw paddle speed during the approach (m/s)
//   maxDt     longest frame during the approach (s): dropped frames
//   supp      contacts were suppressed (tracking-loss window) during it
//   frozen    the paddle was frozen (emulated pose) during it
//   cross     the ball crossed the face plane without a contact:
//             { cooldown, radial, limit }
// Plus a session-start marker and a heartbeat every 5 s with counters, so an
// empty file can be told apart from "never started".

import { setSwingDiagHandler } from '../physics/ball.js';
import { shouldFreezePaddle } from '../xr/trackingLossGuard.js';

const ENDPOINT = '/__swingcap';
const ENTER_M = 0.35;      // an approach starts inside this distance
const LEAVE_MARGIN_M = 0.10; // ...and ends once the ball is this much past its closest
const FLUSH_MS = 1000;
const HEARTBEAT_MS = 5000;

export function isSwingCaptureRequested() {
  const dev = typeof __IS_DEV_SERVER__ !== 'undefined' && __IS_DEV_SERVER__;
  return dev && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('swingcap');
}

let queue = [];
let timers = [];
let firstSent = false;
const counters = { frames: 0, approaches: 0, hits: 0, crossMisses: 0, posted: 0, postFailed: 0 };

// Current approach (numbers only: frame() runs every frame).
let active = false;
let a = null;
// After an approach ends the ball is still near the paddle (it was just hit,
// or is just past it). Wait until it has left the zone before arming a new
// one, or every hit would be followed by a fake "miss".
let waitExit = false;
const resetApproach = () => ({
  start: 0, minD: Infinity, rawD: -1, lag: -1, speed: 0, peak: 0, maxDt: 0,
  supp: false, frozen: false, cross: null,
});

function post(lines) {
  counters.posted += lines.length;
  fetch(ENDPOINT, {
    method: 'POST', body: lines.join('\n') + '\n', keepalive: true,
    headers: { 'content-type': 'application/x-ndjson' },
  }).catch(() => { counters.postFailed += lines.length; });
}

function push(rec) {
  queue.push(JSON.stringify(rec));
  // The first record goes at once, so a short trial confirms the pipeline.
  if (!firstSent) { firstSent = true; flush(); }
}

function flush() {
  if (queue.length === 0) return;
  const lines = queue;
  queue = [];
  post(lines);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

function finish(t, hit) {
  counters.approaches++;
  if (hit) counters.hits++;
  push({
    type: 'approach', t: r3(t), hit,
    minD: r3(a.minD), rawD: r3(a.rawD), lag: r3(a.lag),
    speed: r3(a.speed), peak: r3(a.peak), maxDt: r3(a.maxDt),
    supp: a.supp, frozen: a.frozen, cross: a.cross,
  });
  active = false;
  a = null;
  waitExit = true;
}

const handler = {
  frame(t, dt, ball, face, rawFace, speed, suppressed, hit) {
    counters.frames++;
    const dx = ball.x - face.x, dy = ball.y - face.y, dz = ball.z - face.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (waitExit) {
      if (d > ENTER_M) waitExit = false;
      else if (!hit) return;
    }
    if (!active && (d < ENTER_M || hit)) { active = true; a = resetApproach(); a.start = t; }
    if (!active) return;

    if (speed > a.peak) a.peak = speed;
    if (dt > a.maxDt) a.maxDt = dt;
    if (suppressed) a.supp = true;
    if (shouldFreezePaddle()) a.frozen = true;
    if (d < a.minD) {
      a.minD = d;
      a.speed = speed;
      if (rawFace) {
        const rx = ball.x - rawFace.x, ry = ball.y - rawFace.y, rz = ball.z - rawFace.z;
        a.rawD = Math.sqrt(rx * rx + ry * ry + rz * rz);
        const lx = rawFace.x - face.x, ly = rawFace.y - face.y, lz = rawFace.z - face.z;
        a.lag = Math.sqrt(lx * lx + ly * ly + lz * lz);
      }
    }
    if (hit) finish(t, true);
    else if (d > a.minD + LEAVE_MARGIN_M || d > ENTER_M + LEAVE_MARGIN_M) finish(t, false);
  },
  crossMiss(t, cooldown, radial, limit) {
    counters.crossMisses++;
    if (active) a.cross = { cooldown, radial: r3(radial), limit: r3(limit) };
  },
};

/** Start capturing (XR session start). No-op unless ?swingcap on the dev server. */
export function startSwingCapture() {
  if (!isSwingCaptureRequested() || timers.length) return false;
  setSwingDiagHandler(handler);
  push({
    type: 'start', at: new Date().toISOString(),
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  });
  timers.push(setInterval(flush, FLUSH_MS));
  timers.push(setInterval(() => push({ type: 'hb', ...counters }), HEARTBEAT_MS));
  return true;
}

/** Stop and send what is left (XR session end). */
export function stopSwingCapture() {
  if (!timers.length) return;
  push({ type: 'stop', ...counters });
  flush();
  for (const id of timers) clearInterval(id);
  timers = [];
  setSwingDiagHandler(null);
}
