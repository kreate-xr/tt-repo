// Synthesized sound effects via Web Audio API. No external audio files.
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
// notice it, it's too loud.
const AMBIENT_GAIN = 0.024;
// Distance model for spatial panners — refDistance is roughly the ball
// radius from the head at close-quarters play, maxDistance covers the
// full room. Rolloff 1.3 gives a subtle "away/near" cue without making
// far bounces silent.
const PANNER_REF_DISTANCE = 1.0;
const PANNER_MAX_DISTANCE = 20;
const PANNER_ROLLOFF = 1.3;

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
let ambientSrc = null;
let ambientGainNode = null;

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

  ambientSrc = src;
  ambientGainNode = g;
}

function ensureAudioGraph() {
  const a = ctx();
  if (masterOut) return a;

  masterOut = a.createGain();
  masterOut.gain.value = 1.0;
  masterOut.connect(a.destination);

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
  const t = a.currentTime;
  if (l.positionX) {
    l.positionX.setValueAtTime(_listenerPos.x, t);
    l.positionY.setValueAtTime(_listenerPos.y, t);
    l.positionZ.setValueAtTime(_listenerPos.z, t);
    l.forwardX .setValueAtTime(_listenerFwd.x, t);
    l.forwardY .setValueAtTime(_listenerFwd.y, t);
    l.forwardZ .setValueAtTime(_listenerFwd.z, t);
    l.upX      .setValueAtTime(_listenerUp .x, t);
    l.upY      .setValueAtTime(_listenerUp .y, t);
    l.upZ      .setValueAtTime(_listenerUp .z, t);
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

// Single bandpass-filtered noise burst — bright plastic click, no bass body.
export function playBounceSound(volume, position) {
  const a = ensureAudioGraph();
  const intensity = Math.min(Math.max(volume, 0), 1.0);
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
  gain.gain.setValueAtTime(intensity, a.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + duration);

  const head = makeSpatialHead(position, { dry: 0.9, wet: 0.5 });
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
export function playPaddleHitSound(volume, intensity, position, shape) {
  const a = ensureAudioGraph();
  const t = a.currentTime;
  const vol = Math.min(volume, 1.0);
  const k = intensity != null ? Math.min(Math.max(intensity, 0), 1) : vol;
  const freqScale  = shape && shape.bodyFreqScale  > 0 ? shape.bodyFreqScale  : 1;
  const decayScale = shape && shape.bodyDecayScale > 0 ? shape.bodyDecayScale : 1;
  const gainScale  = shape && shape.bodyGainScale  > 0 ? shape.bodyGainScale  : 1;

  // Sub-bass gets less reverb than the click — real halls carry mids further,
  // but a wet low-end here would smear into a boom on hard smashes.
  const head = makeSpatialHead(position, { dry: 0.9, wet: 0.55 });

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
  clickGain.gain.setValueAtTime(vol * 0.9, t);
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
  bodyGain.gain.setValueAtTime(Math.min(1, vol * 0.58 * gainScale), t);
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
  const k = intensity != null ? Math.min(Math.max(intensity, 0), 1) : vol;
  const freqScale  = shape && shape.bodyFreqScale  > 0 ? shape.bodyFreqScale  : 1;
  const decayScale = shape && shape.bodyDecayScale > 0 ? shape.bodyDecayScale : 1;

  // Edge clacks are the most dramatic hall echo in real play — bumped wet.
  const head = makeSpatialHead(position, { dry: 0.85, wet: 0.75 });

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
  clickGain.gain.setValueAtTime(vol * 1.05, t);
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
  oscGain.gain.setValueAtTime(vol * 0.22, t);
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
// Synthesized rather than sampled: public/ carries only the three crowd
// tracks, and a rules call needs a sound that is unmistakably NOT part of
// the rally. A real pea whistle is a strong ~2.4kHz tone plus a slightly
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
