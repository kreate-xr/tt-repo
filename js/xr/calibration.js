// Paddle calibration singleton (P13 spec §C0/C1/C5).
//
// Owns the T_cal transform (posOffset in grip-local m, rotOffset as a
// grip-local quaternion) applied to the visual paddle anchor in xrPaddle.js.
// Because the physics tick reads pose from that same anchor (see inGame.js
// where xr.getPaddleAnchor() is passed to tickPhysics), calibration is
// automatically inherited by collisions — see plan Gotcha (e): do NOT compose
// T_cal a second time inside ball.js.
//
// Setters have side-effects:
//   1. flushPaddleFilter() — median-of-3 vel history in ball.js is stale after
//      an offset change (spec C7); callers wire this via setFilterFlushHandler.
//   2. persist() — localStorage write keyed by active profile string.
//   3. notify subscribers so any open calibration UI redraws.
//
// Getters return SHARED references — callers must clone before mutating.

import * as THREE from 'three';
import { PRESETS, getPresetCopy, matchProfile } from './calibrationPresets.js';

const STORAGE_PREFIX = 'p13.calibration.';
const STORAGE_VERSION = 1;

const _posOffset = PRESETS.default.posOffset.clone();
const _rotOffset = PRESETS.default.rotOffset.clone();
let _presetName = 'default';
let _activeProfile = null;

const _subscribers = new Set();
let _flushFilterFn = null;
let _contactLogClearFn = null;

// ball.js sets this so setters can invalidate the velocity filter. Wired at
// XR session startup; safe to be null (no-op) before then.
export function setFilterFlushHandler(fn) {
  _flushFilterFn = fn;
}

// contactLog.js sets this so drift signal doesn't survive recalibration
// (plan Gotcha d). Optional — Phase 7 wires it, earlier phases leave it null.
export function setContactLogClearHandler(fn) {
  _contactLogClearFn = fn;
}

export function getPosOffset() {
  return _posOffset;
}

export function getRotOffset() {
  return _rotOffset;
}

export function getPresetName() {
  return _presetName;
}

export function getActiveProfile() {
  return _activeProfile;
}

export function setPosOffset(v) {
  _posOffset.copy(v);
  _presetName = 'custom';
  _onChange();
}

export function setRotOffset(q) {
  _rotOffset.copy(q);
  _presetName = 'custom';
  _onChange();
}

export function setPreset(name) {
  const snapshot = getPresetCopy(name);
  _posOffset.copy(snapshot.posOffset);
  _rotOffset.copy(snapshot.rotOffset);
  _presetName = PRESETS[name] ? name : 'default';
  _onChange();
}

// Apply both together — used by the wizard when it commits a solved rotOffset
// but leaves posOffset at the preset default. Single onChange() so filter is
// flushed once and subscribers see a consistent state.
export function setCalibration({ posOffset, rotOffset, presetName }) {
  if (posOffset) _posOffset.copy(posOffset);
  if (rotOffset) _rotOffset.copy(rotOffset);
  if (presetName) _presetName = presetName;
  _onChange();
}

// Called from xrPaddle.js when a grip's 'connected' event fires with a profile
// string. Applies persisted T_cal for that profile if we have one, else seeds
// from matchProfile(). Only writes new values if they differ from current —
// avoids spurious filter flushes when the same controller reconnects mid-session.
export function loadForProfile(profileString) {
  _activeProfile = profileString || null;
  const persisted = _readStorage(profileString);
  if (persisted) {
    if (!_equalsCurrent(persisted)) {
      _posOffset.copy(persisted.posOffset);
      _rotOffset.copy(persisted.rotOffset);
      _presetName = persisted.preset || 'custom';
      _onChange();
    }
    return;
  }
  const suggested = matchProfile(profileString);
  if (suggested !== _presetName) {
    setPreset(suggested);
  }
}

export function subscribe(cb) {
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

// Compose a grip world-pose with the current T_cal into a paddle world-pose.
// Extracted so xrPaddle.js (updatePaddleVisual) and the C6a feel-neutrality
// test exercise the exact same math — any drift between the two would create
// a "physics reads different pose than the mesh renders" bug that violates
// the "what you see is what collides" invariant.
//
// Order (from spec §C0): posOffset is grip-local, so translate by gripRot *
// posOffset first, THEN compose rotOffset. Reversing rotates the offset by
// the post-composed quaternion and shifts the blade.
//
// Uses a scratch Vector3 to avoid per-call allocation; not reentrant-safe,
// but the physics/render loop is single-threaded so this is fine.
const _composeScratch = new THREE.Vector3();
export function composeCalibratedPose(gripPos, gripQuat, outPos, outQuat) {
  _composeScratch.copy(_posOffset).applyQuaternion(gripQuat);
  outPos.copy(gripPos).add(_composeScratch);
  outQuat.copy(gripQuat).multiply(_rotOffset);
}

// Variant that composes with an EXPLICIT (posOffset, rotOffset) rather than
// module state. Used by tests that need to compare two different T_cal
// values without racing the singleton. Also useful for the wizard preview.
export function composePoseWith(gripPos, gripQuat, posOffset, rotOffset, outPos, outQuat) {
  _composeScratch.copy(posOffset).applyQuaternion(gripQuat);
  outPos.copy(gripPos).add(_composeScratch);
  outQuat.copy(gripQuat).multiply(rotOffset);
}

// --- internal ---

function _onChange() {
  if (_flushFilterFn) _flushFilterFn();
  if (_contactLogClearFn) _contactLogClearFn();
  _persist();
  for (const cb of _subscribers) {
    try { cb(); } catch (e) { /* swallow — one bad sub can't block others */ }
  }
}

function _persist() {
  if (!_activeProfile) return;
  try {
    const payload = {
      version: STORAGE_VERSION,
      profileString: _activeProfile,
      preset: _presetName,
      posOffset: [_posOffset.x, _posOffset.y, _posOffset.z],
      rotOffset: [_rotOffset.x, _rotOffset.y, _rotOffset.z, _rotOffset.w],
    };
    localStorage.setItem(STORAGE_PREFIX + _activeProfile, JSON.stringify(payload));
  } catch (e) {
    // localStorage can throw in private-browsing / quota-full contexts.
    // Calibration is still usable in-session; just not persisted.
  }
}

function _readStorage(profileString) {
  if (!profileString) return null;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + profileString);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION) return null;
    if (!Array.isArray(parsed.posOffset) || parsed.posOffset.length !== 3) return null;
    if (!Array.isArray(parsed.rotOffset) || parsed.rotOffset.length !== 4) return null;
    return {
      preset: parsed.preset,
      posOffset: new THREE.Vector3().fromArray(parsed.posOffset),
      rotOffset: new THREE.Quaternion().fromArray(parsed.rotOffset),
    };
  } catch (e) {
    return null;
  }
}

function _equalsCurrent(other) {
  const dp = _posOffset.distanceToSquared(other.posOffset);
  if (dp > 1e-14) return false;
  const dq = Math.abs(_rotOffset.x - other.rotOffset.x) +
             Math.abs(_rotOffset.y - other.rotOffset.y) +
             Math.abs(_rotOffset.z - other.rotOffset.z) +
             Math.abs(_rotOffset.w - other.rotOffset.w);
  return dq < 1e-6;
}
