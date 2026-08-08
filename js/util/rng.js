// Seeded pseudo-random generation — the single source of determinism for
// every path that must be reproducible:
//
//   M5 Daily Drill      one server-defined config/day, fixed seed so two
//                       players' scores are comparable
//   M6 Skill Test       "same synthetic player run twice → same tier ± 0"
//   M11 MR/VR parity    "identical drill logs given identical inputs"
//   M1 feed scatter     the χ² fit over 500 feeds needs a fixed sequence
//
// Before this module the only seeded generator in the codebase was a
// `mulberry32` copy-pasted into tests/imperfection.test.js — production code
// called `Math.random()` directly in 20 files. The consumer convention was
// already right (`imperfection.js` takes `rng = Math.random` as a default
// parameter and threads it down); what was missing was a generator to pass in.
// This module supplies one and keeps that convention: functions here take an
// `rng` as their FIRST argument rather than closing over module state, so two
// independent streams never interleave into each other's sequence.
//
// mulberry32 specifically: chosen to match the generator the tests already
// pin, so their expected sequences stay valid. 32-bit state, period 2^32,
// passes gjrand — far beyond what feed scatter and miss injection need.

// Deterministic generator. Same seed → same sequence, on every platform:
// all operations are 32-bit integer ops (Math.imul, >>>) with no float
// intermediates, so there is no engine-dependent rounding.
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a over a string → 32-bit seed. Lets callers seed from meaningful text
// ("daily-2026-08-02", a drill config's URL string) instead of tracking
// integers, which is what makes the Daily Drill's "same drill for everyone
// today" property expressible without a server handing out seeds.
export function hashSeed(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Derive an independent stream from a root seed and a name. Two subsystems
// drawing from one shared rng are order-coupled: adding a single draw to the
// feeder would shift every subsequent miss-injection decision, silently
// invalidating a replay. Named streams make each subsystem's sequence depend
// only on (rootSeed, name) and its own draw count.
export function deriveStream(rootSeed, name) {
  return mulberry32((hashSeed(name) ^ (rootSeed >>> 0)) >>> 0);
}

// --- Distribution helpers ---------------------------------------------------
// All take `rng` first and hold no state, so they are safe to call against
// any stream in any order.

// Uniform in [lo, hi).
export function uniform(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

// Uniform integer in [lo, hi] inclusive.
export function int(rng, lo, hi) {
  return Math.floor(lo + rng() * (hi - lo + 1));
}

// Uniform element of an array. Returns undefined for an empty array rather
// than throwing — callers on the feed path treat "no candidates" as a skip.
export function pick(rng, arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

// Box–Muller pair. Returns BOTH normal deviates because the transform
// produces two per call and discarding one would double the draw count —
// which matters here: placement scatter is 2-D (x and z), so it wants exactly
// one pair per feed. `out` is any {x, y} — a THREE.Vector2 or a plain object.
//
// Guards u→0: log(0) is -Infinity, so the sample is clamped to the smallest
// value the generator can emit rather than returning NaN.
export function gaussianPair(rng, out = { x: 0, y: 0 }) {
  const u = Math.max(rng(), 1 / 4294967296);
  const v = rng();
  const r = Math.sqrt(-2 * Math.log(u));
  const theta = 2 * Math.PI * v;
  out.x = r * Math.cos(theta);
  out.y = r * Math.sin(theta);
  return out;
}

// Single normal deviate, mean 0 / stdev 1. Costs the same two draws as
// gaussianPair and throws the second away — prefer gaussianPair when you
// need two, so the stream advances by one pair per logical event.
const _pairScratch = { x: 0, y: 0 };
export function gaussian(rng) {
  return gaussianPair(rng, _pairScratch).x;
}

// Fisher–Yates, in place. Used for spin-sequence shuffles, which currently
// call Math.random() directly and so cannot be replayed.
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
