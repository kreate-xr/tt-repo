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
//   2. persist() — localStorage write keyed by active profile string + paddle
//      hand (both Quest controllers report the same profile string, so a
//      profile-only key made the two hands share one — mis-handed — fit).
//      Live edits (Quick Fit stick input, setCalibration({persist:false}))
//      skip this until commitCalibration().
//   3. notify subscribers so any open calibration UI redraws.
//
// Getters return SHARED references — callers must clone before mutating.

import * as THREE from 'three';
import { PRESETS, getPresetCopy, matchProfile } from './calibrationPresets.js';
import { applyAdjust, clampAdjust } from './paddleAdjust.js';

const STORAGE_PREFIX = 'p13.calibration.';
const STORAGE_VERSION = 1;

// Quick Fit result: the live 'handle_grip' derivation plus three knobs
// (paddleAdjust.js). Persisted as the knobs, not just the offsets, so a GLB
// re-export or derivation fix still flows through — same reason derived
// presets reload from the live derivation in _applyPersisted.
export const QUICK_FIT_PRESET = 'quick_fit';
export const QUICK_FIT_BASE = 'handle_grip';

const _posOffset = PRESETS.default.posOffset.clone();
const _rotOffset = PRESETS.default.rotOffset.clone();
let _presetName = 'default';
let _activeProfile = null;
let _activeHand = null;
let _adjust = null;        // {faceDeg, batDeg, slideM} while preset is quick_fit
let _uncommitted = false;  // live edit in progress; persisted on commit

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

// Quick Fit knobs in effect, or null when the active T_cal is not a Quick Fit.
export function getAdjust() {
  return _adjust;
}

// True between a setCalibration({persist:false}) and the commit — lets
// subscribers skip per-frame work (HUD logging) during a live stick edit.
export function isUncommitted() {
  return _uncommitted;
}

export function setPosOffset(v) {
  _posOffset.copy(v);
  _presetName = 'custom';
  _adjust = null;
  _onChange();
}

export function setRotOffset(q) {
  _rotOffset.copy(q);
  _presetName = 'custom';
  _adjust = null;
  _onChange();
}

export function setPreset(name) {
  const snapshot = getPresetCopy(name);
  _posOffset.copy(snapshot.posOffset);
  _rotOffset.copy(snapshot.rotOffset);
  _presetName = PRESETS[name] ? name : 'default';
  _adjust = null;
  _onChange();
}

// Apply both together — used by the wizard when it commits a solved rotOffset
// but leaves posOffset at the preset default. Single onChange() so filter is
// flushed once and subscribers see a consistent state.
//
// `adjust` records Quick Fit knobs alongside a QUICK_FIT_PRESET result.
// `persist: false` is the live-edit path (Quick Fit applies every stick
// frame): pose and subscribers update, localStorage waits for
// commitCalibration().
export function setCalibration({ posOffset, rotOffset, presetName, adjust, persist = true }) {
  if (posOffset) _posOffset.copy(posOffset);
  if (rotOffset) _rotOffset.copy(rotOffset);
  if (presetName) _presetName = presetName;
  _adjust = (_presetName === QUICK_FIT_PRESET && adjust) ? { ...adjust } : null;
  _onChange(persist);
}

// Persist a live edit and give subscribers one settled notification.
export function commitCalibration() {
  _onChange(true);
}

// Called from xrPaddle.js whenever the paddle binds to a grip. `hand`
// ('left'|'right') scopes storage per paddle hand; omitted, the legacy
// profile-only key is used. A per-hand miss falls back to the legacy key
// once (migration) and re-saves under the per-hand key. Nothing stored →
// first launch seeds the measured 'handle_grip' fit when the model has
// registered it, else matchProfile(). Only writes new values if they differ
// from current — avoids spurious filter flushes when the same controller
// reconnects mid-session.
export function loadForProfile(profileString, hand) {
  _activeProfile = profileString || null;
  _activeHand = (hand === 'left' || hand === 'right') ? hand : null;
  _uncommitted = false;
  let persisted = _readStorage(_storageKey());
  let migrated = false;
  if (!persisted && _activeHand && profileString) {
    persisted = _readStorage(STORAGE_PREFIX + profileString);
    migrated = !!persisted;
  }
  if (persisted) {
    _applyPersisted(persisted);
    if (migrated) _persist();
    return;
  }
  const suggested = PRESETS[QUICK_FIT_BASE] ? QUICK_FIT_BASE : matchProfile(profileString);
  if (suggested !== _presetName || _adjust) {
    setPreset(suggested);
  }
}

function _applyPersisted(persisted) {
  // Quick Fit: rebuild from the LIVE base derivation + stored knobs.
  const base = PRESETS[QUICK_FIT_BASE];
  if (persisted.preset === QUICK_FIT_PRESET && persisted.adjust && base) {
    const adj = clampAdjust({ ...persisted.adjust });
    const res = applyAdjust(base, adj);
    if (_presetName !== QUICK_FIT_PRESET || !_equalsCurrent(res)) {
      setCalibration({ ...res, presetName: QUICK_FIT_PRESET, adjust: adj });
    } else {
      _adjust = adj;
    }
    return;
  }
  // Derived presets (e.g. 'handle_grip') are computed from the loaded
  // asset's anchors, so the LIVE derivation is the source of truth, not the
  // numbers snapshotted at persist time — otherwise a re-exported GLB or a
  // derivation fix stays shadowed by localStorage forever. Safe to bypass
  // the snapshot: any manual tweak renames the preset to 'custom', so a
  // persisted derived name means the player never touched the values.
  // (Attach always happens after the paddle model exists, so the derived
  // preset is registered by the time this runs; if registration failed,
  // PRESETS has no entry and we fall through to the snapshot.)
  const live = PRESETS[persisted.preset];
  if (live && live.isDerived) {
    if (persisted.preset !== _presetName || _adjust ||
        !_equalsCurrent({ posOffset: live.posOffset, rotOffset: live.rotOffset })) {
      setPreset(persisted.preset);
    }
    return;
  }
  // A Quick Fit whose base is missing this session also lands here: its
  // stored offsets are the last-known result, better than a silent reset.
  if (!_equalsCurrent(persisted) || _presetName !== (persisted.preset || 'custom') || _adjust) {
    _posOffset.copy(persisted.posOffset);
    _rotOffset.copy(persisted.rotOffset);
    _presetName = persisted.preset || 'custom';
    _adjust = null;
    _onChange();
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

function _onChange(persist = true) {
  _uncommitted = !persist;
  if (_flushFilterFn) _flushFilterFn();
  if (_contactLogClearFn) _contactLogClearFn();
  if (persist) _persist();
  for (const cb of _subscribers) {
    try { cb(); } catch (e) { /* swallow — one bad sub can't block others */ }
  }
}

function _storageKey() {
  if (!_activeProfile) return null;
  return STORAGE_PREFIX + _activeProfile + (_activeHand ? '.' + _activeHand : '');
}

function _persist() {
  const key = _storageKey();
  if (!key) return;
  try {
    const payload = {
      version: STORAGE_VERSION,
      profileString: _activeProfile,
      preset: _presetName,
      posOffset: [_posOffset.x, _posOffset.y, _posOffset.z],
      rotOffset: [_rotOffset.x, _rotOffset.y, _rotOffset.z, _rotOffset.w],
    };
    if (_adjust) payload.adjust = { ..._adjust };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (e) {
    // localStorage can throw in private-browsing / quota-full contexts.
    // Calibration is still usable in-session; just not persisted.
  }
}

function _readStorage(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION) return null;
    if (!Array.isArray(parsed.posOffset) || parsed.posOffset.length !== 3) return null;
    if (!Array.isArray(parsed.rotOffset) || parsed.rotOffset.length !== 4) return null;
    const a = parsed.adjust;
    const adjust = (a && [a.faceDeg, a.batDeg, a.slideM].every(Number.isFinite))
      ? { faceDeg: a.faceDeg, batDeg: a.batDeg, slideM: a.slideM }
      : null;
    return {
      preset: parsed.preset,
      posOffset: new THREE.Vector3().fromArray(parsed.posOffset),
      rotOffset: new THREE.Quaternion().fromArray(parsed.rotOffset),
      adjust,
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
