// Sound effects via Web Audio API. Mostly synthesized; the ball bounce and
// the two paddle face hits are recorded samples (public/sounds/ —
// Ball_Bounce.wav, Paddle_Hit_Self.wav, Paddle_Hit_Opponent.wav) with the
// synths kept as fallbacks while the samples load.
//
// Audio graph — one shared graph per page lifetime:
//
//   [per-sound synth]──►[spatial head (panner OR gain)]──┬──►[dry gain]──►┐
//                                                        │                │
//                                                        └──►[send gain]──┤
//                                                                         │
//                                                                    ┌────┴────┐
//                                                                    │masterOut│──►destination
//                                                                    └────┬────┘
//                                                     ┌──►[reverbLP]──►[wet gain]──┤
//                                            [convolver]                            │
//                                                     ▲                             │
//                                             convolverIn                           │
//                                                     ▲                             │
//                                                     └── all "send" gains          │
//                                                                                   │
//                              [ambient bed noise + filter]──►[ambient gain]────────┘
//
// Dry+send lets each source choose its wetness (menu clicks: small send,
// impacts: full send). Spatial head routes through an HRTF PannerNode when
// the caller supplies a world position; otherwise it's a plain gain so the
// sound plays center-listener. The AudioListener is synced to the XR camera
// each frame by updateAudioListener() so pans track head rotation.

import * as THREE from 'three';
import { getContext as getBridgeContext } from '../network/AudioContextBridge.js';
import {
  SWING_WHOOSH_THRESHOLD, SWING_WHOOSH_MAX_SPEED, SWING_WHOOSH_MAX_GAIN,
  BALL_ROLL_MIN_SPEED, BALL_ROLL_MAX_SPEED, BALL_ROLL_MAX_GAIN,
} from '../physics/constants.js';

// Master toggle for the room-acoustics pass. Flip false to A/B against the
// dry graph without reverting code. When false: no reverb bus, no ambient
// bed, spatial heads collapse to plain gains — sounds route dry to master.
export const ROOM_ACOUSTICS_ENABLED = true;

// RT60 target for the synthesized hall IR. 1.35 s reads as a mid-size
// sports hall (small gymnasium). TT competition venues are closer to 1.8 s
// but that starts smearing the paddle click; 1.35 s keeps hits legible
// while giving the room a felt presence.
const HALL_RT60 = 1.35;
// Reverb return level — how much wet reaches master. Tuned so hits still
// read as crisp (dry dominates the first ~40 ms), and the tail sits
// underneath as ambience rather than a slap-back effect.
const REVERB_WET_GAIN = 0.30;
// Low-pass on the wet bus. Real halls absorb high frequencies faster than
// mids/lows so the reverb tail sounds warmer than the dry hit; 4.2 kHz
// approximates that per-band decay difference without a full multiband IR.
const REVERB_LP_CUTOFF = 4200;
// Ambient bed — low-level filtered noise floor so silences between hits
// don't sound synthetic. Tuned quiet enough to be pre-attentive; if you
// notice it, it's too loud. Value is pre-compensated for MASTER_GAIN so the
// bed's effective level stays where it was tuned (0.024 at unity master).
const AMBIENT_GAIN = 0.008;
// Distance model for spatial panners. refDistance 2.0 / rolloff 0.8 keeps a
// far-table bounce (~3 m) at ~-3 dB instead of the ~-11 dB the old
// refDistance 1.0 / rolloff 1.3 gave — enough attenuation to still read as
// "over there" but not so much that rally sounds vanish at 100% headset
// volume. maxDistance covers the full room.
const PANNER_REF_DISTANCE = 2.0;
const PANNER_MAX_DISTANCE = 20;
const PANNER_ROLLOFF = 0.8;

// Master makeup gain. Every source in the graph is tuned conservatively
// (intensity scaling, dry sends < 1, distance rolloff), which left the whole
// mix ~10-15 dB under full scale. Driven hot on purpose — the limiter on the
// master bus (see ensureAudioGraph) is what keeps this from clipping, so
// loudness comes from limiting headroom, not from a clean-peak budget.
const MASTER_GAIN = 3.0;

// Loudness floor for impact one-shots. Physical intensity still scales the
// sound, but a soft bounce maps to 50% gain rather than near-silence — below
// this the Quest speakers render soft table contacts as inaudible. The
// remaining 50% span keeps soft-vs-smash still clearly distinguishable.
const IMPACT_GAIN_FLOOR = 0.5;
function flooredGain(intensity) {
  return IMPACT_GAIN_FLOOR + (1 - IMPACT_GAIN_FLOOR) * Math.min(Math.max(intensity, 0), 1);
}

// Recorded samples are peak-normalized to this level after decode so a quiet
// take (Paddle_Hit_Opponent.wav peaks at -8 dBFS) plays as loud as a hot one.
const SAMPLE_NORM_PEAK = 0.89; // ~-1 dBFS

let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = getBridgeContext() || new AudioContext();
  return audioCtx;
}
export function getAudioContext() {
  return ctx();
}

// ---------------------------------------------------------------------------
// Shared graph — lazily built once. All sources ultimately flow into
// masterOut. Reverb bus and ambient bed are gated behind
// ROOM_ACOUSTICS_ENABLED; when false, convolverIn stays null and
// makeSpatialHead skips the send branch entirely.
// ---------------------------------------------------------------------------
let masterOut = null;
let convolverIn = null;
let convolver = null;
let reverbLP = null;
let reverbReturn = null;

// Synthesize a stereo impulse response for a mid-sized reverberant hall.
// Uses decaying noise per channel with a short pre-delay + early-reflection
// buildup, then exponential decay to −60 dB over rt60 seconds. Cheaper than
// shipping a real IR file and adjustable at build time. L/R are independent
// random draws → decorrelated stereo width.
function buildHallIR(a, rt60) {
  const sampleRate = a.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * rt60));
  const buffer = a.createBuffer(2, length, sampleRate);
  // ln(1000) / RT60 gives the exponential decay rate that reaches −60 dB
  // at t = RT60. Standard reverb-design math.
  const decayRate = 6.907 / rt60;
  // Pre-delay before any reverb kicks in (bare direct sound). ~8 ms is
  // typical for a listener a few metres from the walls.
  const preDelay = 0.008;
  // Buildup time — early reflections rise smoothly rather than clicking on.
  const buildupTau = 0.025;

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const bt = Math.max(0, t - preDelay);
      const build = 1 - Math.exp(-bt / buildupTau);
      const env = build * Math.exp(-decayRate * t);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return buffer;
}

// Ambient sports-hall bed — long white-noise buffer through a bandpass
// filter and a very low gain. The filter kills sibilance and rumble so
// only a mid-band "room air" tone remains. Loops indefinitely once started.
function startAmbientBed(a) {
  const bufferSize = a.sampleRate * 6; // 6 s buffer — no perceivable loop point
  const buffer = a.createBuffer(1, bufferSize, a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const src = a.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  const hp = a.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 180;
  hp.Q.value = 0.7;

  const bp = a.createBiquadFilter();
  bp.type = 'lowpass';
  bp.frequency.value = 900;
  bp.Q.value = 0.8;

  const g = a.createGain();
  g.gain.value = AMBIENT_GAIN;

  src.connect(hp).connect(bp).connect(g).connect(masterOut);
  src.start();
}

function ensureAudioGraph() {
  const a = ctx();
  if (masterOut) return a;

  masterOut = a.createGain();
  masterOut.gain.value = MASTER_GAIN;

  // Brick-wall-ish limiter between master and destination. With MASTER_GAIN
  // pushing the mix hotter, simultaneous hard smash + reverb tail can exceed
  // full scale; fast attack keeps that from clipping while normal play stays
  // below threshold and passes untouched.
  const limiter = a.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  masterOut.connect(limiter).connect(a.destination);

  // Kick off the sample fetches now — the graph is built on the first
  // menu interaction, long before the first rally, so the buffers are ready
  // by the time a ball lands.
  ensureSamples(a);

  if (!ROOM_ACOUSTICS_ENABLED) return a;

  // Reverb bus. convolverIn is what per-source send gains connect to; it's
  // a bare gain so we can feed the convolver from many sources without
  // re-wiring the convolver itself.
  convolverIn = a.createGain();
  convolverIn.gain.value = 1.0;

  convolver = a.createConvolver();
  convolver.buffer = buildHallIR(a, HALL_RT60);

  reverbLP = a.createBiquadFilter();
  reverbLP.type = 'lowpass';
  reverbLP.frequency.value = REVERB_LP_CUTOFF;
  reverbLP.Q.value = 0.5;

  reverbReturn = a.createGain();
  reverbReturn.gain.value = REVERB_WET_GAIN;

  convolverIn.connect(convolver).connect(reverbLP).connect(reverbReturn).connect(masterOut);

  startAmbientBed(a);

  return a;
}

// Public wrapper so other modules (crowdAudio.js) can build their own
// positional sources without re-implementing the dry+send fan-out. Returns
// the same node makeSpatialHead does — caller connects their source into it.
export function createSpatialHead(position, opts) {
  return makeSpatialHead(position, opts);
}

// Spatial routing head for a one-shot source. If `position` is a THREE.Vector3
// and room acoustics is on, returns a PannerNode positioned there — HRTF
// panning gives the impact its "somewhere in the room" spatial signature.
// Otherwise returns a plain GainNode so the sound plays center-listener.
// The returned node fans out into (a) a dry gain into master and (b) a
// send gain into the reverb bus. Caller connects their source's final gain
// to this head.
function makeSpatialHead(position, opts) {
  const a = ensureAudioGraph();
  const drySend = (opts && opts.dry != null) ? opts.dry : 0.95;
  const wetSend = (opts && opts.wet != null) ? opts.wet : 0.55;

  let head;
  if (position && ROOM_ACOUSTICS_ENABLED) {
    const panner = a.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = PANNER_REF_DISTANCE;
    panner.maxDistance = PANNER_MAX_DISTANCE;
    panner.rolloffFactor = PANNER_ROLLOFF;
    const t = a.currentTime;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(position.x, t);
      panner.positionY.setValueAtTime(position.y, t);
      panner.positionZ.setValueAtTime(position.z, t);
    } else if (panner.setPosition) {
      panner.setPosition(position.x, position.y, position.z);
    }
    head = panner;
  } else {
    head = a.createGain();
    head.gain.value = 1.0;
  }

  const dry = a.createGain();
  dry.gain.value = drySend;
  head.connect(dry).connect(masterOut);

  if (ROOM_ACOUSTICS_ENABLED && convolverIn && wetSend > 0) {
    const send = a.createGain();
    send.gain.value = wetSend;
    head.connect(send).connect(convolverIn);
  }

  return head;
}

// ---------------------------------------------------------------------------
// Pooled spatial heads for one-shot impacts. makeSpatialHead builds a fresh
// HRTF PannerNode (the most expensive panner — its kernels are set up per
// node) plus gains on EVERY bounce/hit; on a fanless XR2 that construction
// cost lands inside the frame that plays the sound. The pool pre-builds a
// small ring of panner+dry(+send) heads once and repositions them per shot —
// the same pattern ensureBallRoll already uses for the rolling sound.
//
// Reuse hazard: re-acquiring a slot re-points its position/gains while a
// previous shot's tail may still be sounding through it. With 8 slots and
// impact tails well under a second, a slot's reuse interval at rally rates
// is seconds — the collision is inaudible in practice.
//
// Long-lived heads (crowdAudio) must NOT use this — they keep createSpatialHead.
const IMPACT_HEAD_POOL_SIZE = 8;
let impactHeadPool = null;
let impactHeadPoolIdx = 0;

function buildImpactHeadPool(a) {
  impactHeadPool = [];
  for (let i = 0; i < IMPACT_HEAD_POOL_SIZE; i++) {
    const panner = a.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = PANNER_REF_DISTANCE;
    panner.maxDistance = PANNER_MAX_DISTANCE;
    panner.rolloffFactor = PANNER_ROLLOFF;
    const dry = a.createGain();
    panner.connect(dry).connect(masterOut);
    let send = null;
    if (convolverIn) {
      send = a.createGain();
      panner.connect(send).connect(convolverIn);
    }
    impactHeadPool.push({ panner, dry, send });
  }
}

// Drop-in replacement for makeSpatialHead on the one-shot impact paths.
// Falls through to makeSpatialHead when there's no position or spatial audio
// is off (those return a plain GainNode — no panner to pool).
function acquireImpactHead(position, opts) {
  if (!position || !ROOM_ACOUSTICS_ENABLED) return makeSpatialHead(position, opts);
  const a = ensureAudioGraph();
  if (!impactHeadPool) buildImpactHeadPool(a);
  const slot = impactHeadPool[impactHeadPoolIdx];
  impactHeadPoolIdx = (impactHeadPoolIdx + 1) % IMPACT_HEAD_POOL_SIZE;

  const p = slot.panner;
  if (p.positionX) {
    p.positionX.value = position.x;
    p.positionY.value = position.y;
    p.positionZ.value = position.z;
  } else if (p.setPosition) {
    p.setPosition(position.x, position.y, position.z);
  }
  slot.dry.gain.value = (opts && opts.dry != null) ? opts.dry : 0.95;
  if (slot.send) {
    slot.send.gain.value = (opts && opts.wet != null) ? opts.wet : 0.55;
  }
  return p;
}

// Build every lazily-created audio asset up front. Called from the in-XR
// loading phase (a user gesture has already happened, so the context may
// run) — without this, the first swing/roll paid a 96k-sample noise fill
// INSIDE a render frame, and the first impact built its HRTF panner there
// too. Idempotent; failures are non-fatal (context blocked in odd embeds).
export function prewarmAudio() {
  try {
    const a = ensureAudioGraph();  // master bus, samples fetch, hall IR, ambient bed
    ensureWhoosh();                // 2 s noise buffer + filter chain
    ensureBallRoll();              // 2 s noise buffer + panner chain
    if (ROOM_ACOUSTICS_ENABLED && !impactHeadPool) buildImpactHeadPool(a);
  } catch (err) {
    console.warn('[audio] prewarm skipped:', err);
  }
}

// ---------------------------------------------------------------------------
// AudioListener sync — WebXR camera pose drives Web Audio's spatial listener
// so HRTF pans track head rotation. Called from the main render loop each
// frame with renderer.xr.getCamera().
// ---------------------------------------------------------------------------
const _listenerPos = new THREE.Vector3();
const _listenerQuat = new THREE.Quaternion();
const _listenerFwd = new THREE.Vector3();
const _listenerUp = new THREE.Vector3();

export function updateAudioListener(cameraOrObject3D) {
  if (!ROOM_ACOUSTICS_ENABLED || !cameraOrObject3D) return;
  const a = ctx();
  if (!a || !a.listener) return;

  cameraOrObject3D.getWorldPosition(_listenerPos);
  cameraOrObject3D.getWorldQuaternion(_listenerQuat);
  // Camera convention: −Z forward, +Y up. Applies to both flat + XR cameras.
  _listenerFwd.set(0, 0, -1).applyQuaternion(_listenerQuat);
  _listenerUp .set(0, 1,  0).applyQuaternion(_listenerQuat);

  const l = a.listener;
  if (l.positionX) {
    // Direct .value writes, not setValueAtTime: this runs every render frame,
    // and nine timeline events per frame is ~810 automation events/second for
    // the audio thread to sort and expire. Plain assignment carries no
    // timeline cost and head-tracking needs no sample-accurate scheduling.
    l.positionX.value = _listenerPos.x;
    l.positionY.value = _listenerPos.y;
    l.positionZ.value = _listenerPos.z;
    l.forwardX.value  = _listenerFwd.x;
    l.forwardY.value  = _listenerFwd.y;
    l.forwardZ.value  = _listenerFwd.z;
    l.upX.value       = _listenerUp.x;
    l.upY.value       = _listenerUp.y;
    l.upZ.value       = _listenerUp.z;
  } else if (l.setPosition) {
    l.setPosition   (_listenerPos.x, _listenerPos.y, _listenerPos.z);
    l.setOrientation(_listenerFwd.x, _listenerFwd.y, _listenerFwd.z,
                      _listenerUp.x,  _listenerUp.y,  _listenerUp.z);
  }
}

// ---------------------------------------------------------------------------
// One-shot sound effects. Each accepts an optional world-space THREE.Vector3
// so the caller can position the impact in the room; when omitted, plays
// center-listener with slight reverb tail.
// ---------------------------------------------------------------------------

// Recorded samples — one clean take each for the table bounce and the two
// paddle face hits (the local player's and the opponent's, which are
// different recordings so the far-side return reads differently from your
// own contact). Loaded lazily (fetch + decodeAudioData, same flow as
// crowdAudio.js); until a buffer is ready — or if its fetch fails (dev
// server without the asset, offline) — the synthesized variants play
// instead, so an impact is never silent.
const SAMPLE_URLS = {
  bounce: 'sounds/Ball_Bounce.wav',
  paddleSelf: 'sounds/Paddle_Hit_Self.wav',
  paddleOpponent: 'sounds/Paddle_Hit_Opponent.wav',
};
const sampleBuffers = {};
let samplesLoadStarted = false;

// Peak-normalize a decoded buffer in place to SAMPLE_NORM_PEAK. The takes
// were recorded at different levels (opponent hit peaks 6 dB under the other
// two); normalizing here means gain staging downstream can assume every
// sample starts at the same loudness.
function normalizeBuffer(buf) {
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak > 0.0001) {
    const scale = SAMPLE_NORM_PEAK / peak;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < data.length; i++) data[i] *= scale;
    }
  }
  return buf;
}

function ensureSamples(a) {
  if (samplesLoadStarted) return;
  samplesLoadStarted = true;
  for (const [name, url] of Object.entries(SAMPLE_URLS)) {
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((arr) => a.decodeAudioData(arr))
      .then((buf) => { sampleBuffers[name] = normalizeBuffer(buf); })
      .catch(() => { /* synth fallback stays active */ });
  }
}

export function playBounceSound(volume, position) {
  const a = ensureAudioGraph();
  ensureSamples(a);
  const intensity = Math.min(Math.max(volume, 0), 1.0);

  if (sampleBuffers.bounce) {
    const src = a.createBufferSource();
    src.buffer = sampleBuffers.bounce;
    // Pitch tracks impact like the old synth's filter did (harder hit →
    // brighter), plus a small random jitter so rapid bounces don't sound
    // machine-gun identical.
    src.playbackRate.value =
      (0.94 + 0.12 * intensity) * (1 + (Math.random() - 0.5) * 0.06);

    const gain = a.createGain();
    gain.gain.value = flooredGain(intensity);

    const head = acquireImpactHead(position, { dry: 0.9, wet: 0.5 });
    src.connect(gain).connect(head);
    src.start();
    return;
  }

  const duration = 0.04;
  const bufferSize = a.sampleRate * duration;
  const buffer = a.createBuffer(1, bufferSize, a.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = a.createBufferSource();
  noise.buffer = buffer;

  const bandpass = a.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 2500 + intensity * 1000;
  bandpass.Q.value = 2.5;

  const gain = a.createGain();
  gain.gain.setValueAtTime(flooredGain(intensity), a.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + duration);

  const head = acquireImpactHead(position, { dry: 0.9, wet: 0.5 });
  noise.connect(bandpass).connect(gain).connect(head);
  noise.start();
  noise.stop(a.currentTime + duration);
}

// volume → overall amplitude (0-1). intensity → optional [0,1] used to pick the
// sub-bass "body" frequency. Heavier-feeling hits use a lower-pitched thud
// (bigger objects ring at lower frequencies — cross-modal weight cue). If
// intensity is omitted, falls back to volume.
//
// `shape` is the optional blade-weight shaping from physics/paddleWeight.js
// ({ bodyFreqScale, bodyDecayScale, bodyGainScale }). It moves the sub-bass
// body only — the rubber click on top is a property of the rubber, not the
// blade mass. Omitted → neutral, byte-identical to the pre-weight sound.
//
// `hitter` picks which recorded sample plays: 'opponent' for the AI/remote
// paddle, anything else (including omitted) for the local player's.
export function playPaddleHitSound(volume, intensity, position, shape, hitter) {
  const a = ensureAudioGraph();
  ensureSamples(a);
  const t = a.currentTime;
  const vol = Math.min(volume, 1.0);
  // outVol drives amplitude; vol/k keep the raw physical value for pitch and
  // timbre so a soft touch still *sounds* soft, just not inaudible.
  const outVol = flooredGain(vol);
  const k = intensity != null ? Math.min(Math.max(intensity, 0), 1) : vol;
  const freqScale  = shape && shape.bodyFreqScale  > 0 ? shape.bodyFreqScale  : 1;
  const decayScale = shape && shape.bodyDecayScale > 0 ? shape.bodyDecayScale : 1;
  const gainScale  = shape && shape.bodyGainScale  > 0 ? shape.bodyGainScale  : 1;

  // Sub-bass gets less reverb than the click — real halls carry mids further,
  // but a wet low-end here would smear into a boom on hard smashes.
  const head = acquireImpactHead(position, { dry: 0.9, wet: 0.55 });

  const hitBuffer = hitter === 'opponent'
    ? sampleBuffers.paddleOpponent
    : sampleBuffers.paddleSelf;
  if (hitBuffer) {
    const src = a.createBufferSource();
    src.buffer = hitBuffer;
    // Pitch tracks impact intensity (harder hit → slightly brighter) with a
    // small random jitter so fast rallies don't sound machine-gun identical.
    // Blade weight folds into the rate: a heavier bat rings lower, same cue
    // the synth body's freqScale carries.
    src.playbackRate.value =
      (0.96 + 0.08 * k) * freqScale * (1 + (Math.random() - 0.5) * 0.05);

    const gain = a.createGain();
    gain.gain.value = outVol * gainScale;

    src.connect(gain).connect(head);
    src.start(t);
    return;
  }

  // Layer 1 — rubber-on-plastic click. Existing 2200 Hz bandpass, unchanged.
  const bufferSize = a.sampleRate * 0.025;
  const noiseBuffer = a.createBuffer(1, bufferSize, a.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }
  const noiseSrc = a.createBufferSource();
  noiseSrc.buffer = noiseBuffer;

  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 2200;
  filter.Q.value = 0.8;

  const clickGain = a.createGain();
  clickGain.gain.setValueAtTime(outVol * 0.9, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

  noiseSrc.connect(filter).connect(clickGain).connect(head);
  noiseSrc.start(t);

  // Layer 2 — sub-bass body that gives the hit "weight." Lower frequency for
  // harder hits (matches real heavy-object physics). Sub-bass is *felt* more
  // than *heard* on the Quest 3s speakers; a longer envelope and higher gain
  // register in the chest, which reads as mass. 100 ms exponential decay.
  //
  // Blade weight shifts this layer: a heavier bat rings lower and slightly
  // longer. Floored at 40 Hz — below that the Quest speakers reproduce nothing
  // and the "hit" loses its body entirely instead of gaining weight.
  const bodyFreq = Math.max(40, (160 - 70 * k) * freqScale);  // 160 Hz soft → 90 Hz smash
  const bodyDecay = 0.1 * decayScale;
  const body = a.createOscillator();
  const bodyGain = a.createGain();
  body.type = 'sine';
  body.frequency.setValueAtTime(bodyFreq, t);
  body.frequency.exponentialRampToValueAtTime(
    Math.max(40, bodyFreq * 0.7), t + bodyDecay * 0.9,
  );
  bodyGain.gain.setValueAtTime(Math.min(1, outVol * 0.58 * gainScale), t);
  bodyGain.gain.exponentialRampToValueAtTime(0.001, t + bodyDecay);

  body.connect(bodyGain).connect(head);
  body.start(t);
  body.stop(t + bodyDecay + 0.01);
}

// Wood-edge strike — sharp, dry "clack" for when the ball hits the paddle
// rim instead of the rubber face.
// `shape` as in playPaddleHitSound. Here it moves the tonal ring of the clack
// (the wood itself) but leaves the noise burst alone — the burst is the ball
// skidding off the rim, which does not care how heavy the blade is.
export function playPaddleEdgeSound(volume, intensity, position, shape) {
  const a = ensureAudioGraph();
  const t = a.currentTime;
  const vol = Math.min(volume, 1.0);
  const outVol = flooredGain(vol);
  const k = intensity != null ? Math.min(Math.max(intensity, 0), 1) : vol;
  const freqScale  = shape && shape.bodyFreqScale  > 0 ? shape.bodyFreqScale  : 1;
  const decayScale = shape && shape.bodyDecayScale > 0 ? shape.bodyDecayScale : 1;

  // Edge clacks are the most dramatic hall echo in real play — bumped wet.
  const head = acquireImpactHead(position, { dry: 0.85, wet: 0.75 });

  const dur = 0.022;
  const bufSize = Math.max(1, Math.floor(a.sampleRate * dur));
  const buf = a.createBuffer(1, bufSize, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
  const noiseSrc = a.createBufferSource();
  noiseSrc.buffer = buf;

  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 4600 + 800 * k;
  filter.Q.value = 2.4;

  const clickGain = a.createGain();
  clickGain.gain.setValueAtTime(outVol * 1.05, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + dur);

  noiseSrc.connect(filter).connect(clickGain).connect(head);
  noiseSrc.start(t);
  noiseSrc.stop(t + dur);

  const ringDecay = 0.035 * decayScale;
  const osc = a.createOscillator();
  const oscGain = a.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime((2800 + 400 * k) * freqScale, t);
  osc.frequency.exponentialRampToValueAtTime(1800 * freqScale, t + ringDecay * 0.85);
  oscGain.gain.setValueAtTime(outVol * 0.22, t);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + ringDecay);
  osc.connect(oscGain).connect(head);
  osc.start(t);
  osc.stop(t + ringDecay + 0.005);
}

// ---------------------------------------------------------------------------
// Swing whoosh — persistent noise source gain-modulated by paddle velocity.
// Routes through master (no reverb — the whoosh IS the near-field wind, a
// tail would feel unnatural / smear the perceived paddle position).
// ---------------------------------------------------------------------------

let whooshSrc    = null;
let whooshFilter = null;
let whooshGain   = null;

function ensureWhoosh() {
  if (whooshSrc) return;
  const a = ensureAudioGraph();

  const bufferSize = a.sampleRate * 2;
  const buffer = a.createBuffer(1, bufferSize, a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  whooshSrc = a.createBufferSource();
  whooshSrc.buffer = buffer;
  whooshSrc.loop = true;

  whooshFilter = a.createBiquadFilter();
  whooshFilter.type = 'lowpass';
  whooshFilter.frequency.value = 200;
  whooshFilter.Q.value = 1.2;

  whooshGain = a.createGain();
  whooshGain.gain.value = 0;

  whooshSrc.connect(whooshFilter).connect(whooshGain).connect(masterOut);
  whooshSrc.start();
}

// Per-frame update. speed is paddle face center velocity in m/s.
export function updateSwingWhoosh(speed) {
  ensureWhoosh();
  const a = ctx();
  const t = a.currentTime;

  const range = Math.max(0.001, SWING_WHOOSH_MAX_SPEED - SWING_WHOOSH_THRESHOLD);
  const norm = Math.max(0, Math.min((speed - SWING_WHOOSH_THRESHOLD) / range, 1));

  const targetGain = SWING_WHOOSH_MAX_GAIN * norm * norm;
  const targetFreq = 220 + 1400 * norm;

  whooshGain.gain.setTargetAtTime(targetGain, t, 0.03);
  whooshFilter.frequency.setTargetAtTime(targetFreq, t, 0.03);
}

// ---------------------------------------------------------------------------
// Ball rolling — persistent bandpass-filtered noise routed through a
// spatial panner so the sound tracks the ball's world position. Gain and
// filter cutoff modulate with horizontal rolling speed. Silent below
// BALL_ROLL_MIN_SPEED.
//
// Why a persistent source (like whoosh) instead of one-shots: rolling is a
// continuous physical event, not a discrete impact. One-shots would either
// re-trigger with audible seams or need a per-frame stitching scheme.
// Persistent source + gain modulation gives seamless fade in/out at the
// speed threshold and continuous timbre change as the ball speeds up or
// slows down.
//
// Panner is created once and its position is updated per frame — cheaper
// than the makeSpatialHead per-shot flow used by impacts, and correct
// because we only ever want one instance of this sound.
// ---------------------------------------------------------------------------
let ballRollSrc    = null;
let ballRollFilter = null;
let ballRollGain   = null;
let ballRollPanner = null;

function ensureBallRoll() {
  if (ballRollSrc) return;
  const a = ensureAudioGraph();

  const bufferSize = a.sampleRate * 2;
  const buffer = a.createBuffer(1, bufferSize, a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  ballRollSrc = a.createBufferSource();
  ballRollSrc.buffer = buffer;
  ballRollSrc.loop = true;

  // Bandpass around the hollow-plastic-on-hard-surface spectrum. Real
  // ping-pong balls rolling on wood/concrete peak around 700-1200 Hz with
  // a fair Q — a narrow resonance rather than broadband noise. Frequency
  // is speed-modulated below.
  ballRollFilter = a.createBiquadFilter();
  ballRollFilter.type = 'bandpass';
  ballRollFilter.frequency.value = 700;
  ballRollFilter.Q.value = 5.0;

  ballRollGain = a.createGain();
  ballRollGain.gain.value = 0;

  if (ROOM_ACOUSTICS_ENABLED) {
    ballRollPanner = a.createPanner();
    ballRollPanner.panningModel = 'HRTF';
    ballRollPanner.distanceModel = 'inverse';
    ballRollPanner.refDistance = PANNER_REF_DISTANCE;
    ballRollPanner.maxDistance = PANNER_MAX_DISTANCE;
    ballRollPanner.rolloffFactor = PANNER_ROLLOFF;
    ballRollSrc.connect(ballRollFilter).connect(ballRollGain).connect(ballRollPanner).connect(masterOut);
  } else {
    ballRollSrc.connect(ballRollFilter).connect(ballRollGain).connect(masterOut);
  }
  ballRollSrc.start();
}

/**
 * Per-frame update. Call from ball tick with the ball's current horizontal
 * speed (m/s) and world position. Pass speed=0 (or don't call it) when the
 * ball is airborne — the exponential smoothing on gain fades it out
 * automatically. `position` is optional; if omitted (or panner disabled),
 * the sound plays center-listener.
 */
export function updateBallRoll(speed, position) {
  ensureBallRoll();
  const a = ctx();
  const t = a.currentTime;

  if (position && ballRollPanner) {
    // setTargetAtTime with a short time constant so the panner tracks fast
    // ball motion without stepping — smoother than direct setValue.
    if (ballRollPanner.positionX) {
      ballRollPanner.positionX.setTargetAtTime(position.x, t, 0.02);
      ballRollPanner.positionY.setTargetAtTime(position.y, t, 0.02);
      ballRollPanner.positionZ.setTargetAtTime(position.z, t, 0.02);
    } else if (ballRollPanner.setPosition) {
      ballRollPanner.setPosition(position.x, position.y, position.z);
    }
  }

  const range = Math.max(0.001, BALL_ROLL_MAX_SPEED - BALL_ROLL_MIN_SPEED);
  const norm = Math.max(0, Math.min((speed - BALL_ROLL_MIN_SPEED) / range, 1));

  const targetGain = BALL_ROLL_MAX_GAIN * norm * norm;
  // Frequency rises with speed — real rolling sound gets brighter as the
  // ball spins faster over surface texture.
  const targetFreq = 500 + 800 * norm;

  ballRollGain.gain.setTargetAtTime(targetGain, t, 0.05);
  ballRollFilter.frequency.setTargetAtTime(targetFreq, t, 0.05);
}

// ---------------------------------------------------------------------------
// Menu UI ticks — dry-dominant, tiny reverb send so they still sit in the
// room. No spatial position (menus are head-anchored, not world-anchored).
// ---------------------------------------------------------------------------
export function playMenuHoverTick() {
  const a = ensureAudioGraph();
  const t = a.currentTime;
  const duration = 0.018;
  const bufSize = Math.max(1, Math.floor(a.sampleRate * duration));
  const buf = a.createBuffer(1, bufSize, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 4200;
  filter.Q.value = 3.0;
  const gain = a.createGain();
  gain.gain.setValueAtTime(0.14, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  const head = makeSpatialHead(null, { dry: 1.0, wet: 0.15 });
  src.connect(filter).connect(gain).connect(head);
  src.start(t);
  src.stop(t + duration);
}

export function playMenuSelectClick() {
  const a = ensureAudioGraph();
  const t = a.currentTime;
  const head = makeSpatialHead(null, { dry: 1.0, wet: 0.15 });

  const nDur = 0.028;
  const bufSize = Math.max(1, Math.floor(a.sampleRate * nDur));
  const buf = a.createBuffer(1, bufSize, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = a.createBufferSource();
  noise.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 3500;
  filter.Q.value = 2.5;
  const nGain = a.createGain();
  nGain.gain.setValueAtTime(0.30, t);
  nGain.gain.exponentialRampToValueAtTime(0.001, t + nDur);
  noise.connect(filter).connect(nGain).connect(head);
  noise.start(t);
  noise.stop(t + nDur);

  const osc = a.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1200, t);
  osc.frequency.exponentialRampToValueAtTime(720, t + 0.06);
  const oscGain = a.createGain();
  oscGain.gain.setValueAtTime(0.13, t);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  osc.connect(oscGain).connect(head);
  osc.start(t);
  osc.stop(t + 0.075);
}

// Umpire's whistle — two short blasts, called when the local player fouls.
//
// Synthesized rather than sampled: a rules call needs a sound that is
// unmistakably NOT part of the rally. A real pea whistle is a strong ~2.4kHz tone plus a slightly
// detuned partial, warbling as the pea rattles, over a breathy noise floor.
// That combination is what makes it read as a whistle rather than a beep,
// so all three parts are here.
//
// Non-spatial (position null): the umpire is not an object in the arena, and
// panning the call would make the player look for a source that isn't there.
const WHISTLE_BLAST_S = 0.16;
const WHISTLE_GAP_S = 0.09;
const WHISTLE_FREQ_HZ = 2400;
// The pea's rattle. Fast enough to hear as texture, not as vibrato.
const WHISTLE_WARBLE_HZ = 28;
const WHISTLE_WARBLE_CENTS = 55;

function whistleBlast(a, head, startAt, duration) {
  // Body: two oscillators a few cents apart beat against each other, which
  // is most of the "air" in a whistle tone.
  for (const [detune, level] of [[0, 0.10], [WHISTLE_WARBLE_CENTS, 0.055]]) {
    const osc = a.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(WHISTLE_FREQ_HZ, startAt);
    osc.detune.setValueAtTime(detune, startAt);
    // Pea rattle: a small periodic pitch wobble on the upper partial only.
    if (detune !== 0) {
      const lfo = a.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = WHISTLE_WARBLE_HZ;
      const lfoGain = a.createGain();
      lfoGain.gain.value = 30; // cents of swing
      lfo.connect(lfoGain).connect(osc.detune);
      lfo.start(startAt);
      lfo.stop(startAt + duration);
    }
    const g = a.createGain();
    // Fast but not instant attack — a clicked-on sine sounds like a beep.
    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.exponentialRampToValueAtTime(level, startAt + 0.012);
    g.gain.setValueAtTime(level, startAt + duration - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(g).connect(head);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.01);
  }

  // Breath: bandpassed noise around the fundamental.
  const bufSize = Math.max(1, Math.floor(a.sampleRate * duration));
  const buf = a.createBuffer(1, bufSize, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = a.createBufferSource();
  noise.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = WHISTLE_FREQ_HZ;
  bp.Q.value = 6;
  const nGain = a.createGain();
  nGain.gain.setValueAtTime(0.0001, startAt);
  nGain.gain.exponentialRampToValueAtTime(0.045, startAt + 0.015);
  nGain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  noise.connect(bp).connect(nGain).connect(head);
  noise.start(startAt);
  noise.stop(startAt + duration);
}

export function playFoulWhistle() {
  const a = ensureAudioGraph();
  const t = a.currentTime;
  // Dry-heavy: a whistle in a hall has some tail, but too much wet turns the
  // two blasts into one smear.
  const head = makeSpatialHead(null, { dry: 1.0, wet: 0.25 });
  whistleBlast(a, head, t, WHISTLE_BLAST_S);
  whistleBlast(a, head, t + WHISTLE_BLAST_S + WHISTLE_GAP_S, WHISTLE_BLAST_S);
}
