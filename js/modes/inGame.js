// Unified in-XR mode. Boots the AR session, shows a floating menu in front of
// the headset, and drives a state machine: 'menu' | 'freePlay' | 'drill'.
// Paddle-hand A/X toggles the menu mid-session. Single controller is enough.

import * as THREE from 'three';
import {
  scene, camera, renderer,
  setSceneBackground, setTransparentClear, setArenaClear,
  setArenaLighting, restoreARLighting,
  applyMRFallbackLighting, applyLightEstimate,
} from '../scene/sceneSetup.js';
// BETA LAUNCH: arena/stadium venues disabled — import commented out so the
// venue code (and its strings) is tree-shaken out of the shipped bundle
// entirely. Restore together with the venue picker in js/ui/overlay.js and
// the arena block in startInGame below.
// import { createArena, onArenaLoadProgress } from '../scene/arena.js';
// Focus Room: procedural VR venue ('vr-focus'), no GLB pipeline — live in
// beta while the GLB venues above stay tree-shaken.
import { createFocusRoom } from '../scene/focusRoom.js';
import { createMRBackdrop } from '../scene/mrBackdrop.js';
import { warmWoodTile } from '../scene/woodFloor.js';
import { warmWallTile } from '../scene/wallPanels.js';
import { loadModels, ballModel, tableBox, tableSurfaceY, setBallColor, setTableColor, setNetXRMode } from '../scene/models.js';
// Aliased: this module already has a local endSession() that ends the XR
// session itself (below). Two different things with one obvious name.
import { beginSession, endSession as endAnalyticsRun, mark } from '../analytics/session.js';
import { showPostSession } from '../ui/postSession.js';
import { hudLog, TUNER_ENABLED } from '../scene/hud.js';
// FPS HUD disabled — import kept commented for easy restore.
import {
  tickPhysics, clearListeners, spawnBallAt,
  onPaddleHit, onTableBounce, onNetHit, onBallLost,
  offPaddleHit, offTableBounce, offNetHit, offBallLost,
} from '../physics/ball.js';
import { setupXRPaddle } from './xrPaddle.js';
import {
  WristMenu, createLaserLine,
  PLANE_W as MENU_PLANE_W, PLANE_H as MENU_PLANE_H,
} from '../scene/wristMenu.js';
import { TrainingMenu } from '../scene/trainingMenu.js';
import { MultiplayerMenu } from '../scene/multiplayerMenu.js';
// Boot-phase timing for ?trace=1 (js/network/connectTrace.js). That module has
// no imports of its own, so this static import costs ~1 KB in the entry bundle
// and does NOT pull the Firebase chunk in with it.
import { traceBoot } from '../network/connectTrace.js';
// LobbyManager pulls in the signaling/WebRTC stack including the Firebase
// SDK (~1 MB of parse on the Quest CPU). Loaded in the background once the
// XR session starts (see startInGame) so the initial page bundle — and every
// solo/AI session that never opens multiplayer — doesn't pay for it.
let LobbyManagerCtor = null;
// Warms Firebase (SDK construction, anonymous auth, the first Firestore round
// trip) ahead of the CREATE/JOIN click. Reached through this same dynamic
// import — see the re-export in LobbyManager.js for why it cannot be imported
// directly. Null until the chunk resolves; every call site null-checks.
let prewarmSignaling = null;
function preloadLobbyManager() {
  if (!LobbyManagerCtor) {
    traceBoot('lobby chunk import start');
    import('../lobby/LobbyManager.js')
      .then((m) => {
        LobbyManagerCtor = m.LobbyManager;
        prewarmSignaling = m.prewarmSignaling;
        traceBoot('lobby chunk ready');
      })
      .catch((err) => {
        traceBoot('lobby chunk FAILED');
        console.error('[multiplayer] lobby stack failed to load', err);
      });
  }
}
import * as profileStore from '../profile/store.js';
import { PhysicsTuner } from '../scene/physicsTuner.js';
import { CalibrationWizard } from '../scene/calibrationWizard.js';
import { CalibrationTuner } from '../scene/calibrationTuner.js';
import { paddleAngularVelocity } from '../physics/ball.js';
import { update as updateTrackingLossGuard } from '../xr/trackingLossGuard.js';
import { getProfile } from './training/difficulty.js';
import {
  initStatsHud, setLiveLine, hideLiveLine, showSummary, hideSummary, clearStatsHud,
} from '../scene/statsHud.js';
import { createM1BallMachineDrill } from './training/drills/m1BallMachine.js';
import { WARMUP_FEED } from './training/presets.js';
import { validateConfig, INFINITE } from './training/drillConfig.js';
import { createSessionDrill, SESSION } from './training/drills/session.js';
import { createMultiplayerDrill, MULTIPLAYER } from './multiplayer/multiplayer.js';
import { createAIMatchDrill, AI_MATCH } from './aiMatch/aiMatch.js';
import * as AudioContextBridge from '../network/AudioContextBridge.js';
import { updateAudioListener, prewarmAudio } from '../scene/audio.js';
import * as haptics from '../xr/haptics.js';

const DRILL_FACTORIES = {
  // Play: the Training Session — a scored multiball session (warm-up,
  // footwork, spin, random) run as the M1 ball machine's config provider.
  session:            { meta: SESSION,             create: createSessionDrill },
  multiplayer:        { meta: MULTIPLAYER,         create: createMultiplayerDrill },
  aiMatch:            { meta: AI_MATCH,            create: createAIMatchDrill },
};

// Ceiling on the display rate we ask the runtime for. A Quest WebXR session
// starts at 72 Hz and STAYS there unless the page explicitly calls
// updateTargetFrameRate — which nothing here used to do, so every frame-rate
// number reasoned about elsewhere in this codebase (the paddle velocity
// sampler) was describing a session we never actually requested.
//
// That gap is worth closing because the cost lands on the one object the
// whole game is about. A 40 mm ball at 8 m/s steps 111 mm between frames at
// 72 Hz versus 89 mm at 90 Hz — 2.8 vs 2.2 ball diameters — and perceived
// judder under smooth pursuit scales with exactly that ratio.
//
// Capped at 90 rather than 120 deliberately. 120 Hz would halve the step
// again, but the renderer still supersamples at 1.2× (sceneSetup.js — panel
// text legibility), and dropping frames at 120 would be strictly worse for
// judder than holding 90. That trade can only be settled by measuring on
// device. Raise this to 120 once there is confirmed headroom; the supported
// list is logged below so the decision has numbers behind it.
const PREFERRED_MAX_FRAME_RATE = 90;

/**
 * Ask the runtime for the highest supported display rate at or below
 * PREFERRED_MAX_FRAME_RATE. Best-effort and never fatal: `supportedFrameRates`
 * is absent on the WebXR emulator and on runtimes that don't implement the
 * frame-rate extension, and `updateTargetFrameRate` can reject even when the
 * value came out of that very list. A session at the default rate is a
 * degraded experience, not a broken one, so every failure here is a warning.
 *
 * CALL ONLY AFTER renderer.xr.setSession(), and never on an awaited path —
 * see the call site for why doing otherwise hangs session entry.
 */
async function requestBestFrameRate(session) {
  const rates = session.supportedFrameRates;
  if (!rates || !rates.length || typeof session.updateTargetFrameRate !== 'function') {
    console.log('[XR] frame-rate control unavailable — staying at runtime default');
    return;
  }
  // Copy before sorting: supportedFrameRates is a live Float32Array on the
  // session and sorting it in place mutates runtime-owned state.
  const sorted = Array.from(rates).sort((a, b) => a - b);
  const target = sorted.filter(r => r <= PREFERRED_MAX_FRAME_RATE).pop();
  console.log('[XR] supported frame rates:', sorted.join(', '), '→ requesting', target);
  if (!target) return;
  try {
    await session.updateTargetFrameRate(target);
  } catch (err) {
    console.warn('[XR] updateTargetFrameRate failed, staying at default:', err);
  }
}

// --- Session-switch race guard ---------------------------------------------
// session.end() is asynchronous, and on Quest the OpenXR runtime keeps tearing
// the old immersive session down (and reconfigures the compositor when moving
// between passthrough and VR) for a while AFTER the browser fires 'end' and
// the start screen reappears. A requestSession that lands inside that window
// is rejected with the generic "Failed to request XR session" — the
// intermittent failure players hit when switching MR ↔ VR Focus, and the one
// that also bites re-entering the SAME mode. Three guards close it: hold the
// request until the runtime has had RUNTIME_SETTLE_MS since the previous
// 'end', retry if it is still busy releasing, and refuse a second concurrent
// entry attempt (see entryInFlight) so an impatient click cannot collide with
// the request already in flight.
let lastSessionEnded = null;
let lastSessionEndedAt = 0;

// Only one entry attempt in flight at a time — see the guard in startInGame.
let entryInFlight = false;

// Waiting for 'end' alone is not enough, because 'end' is ALSO what puts the
// start screen back (see the session-end listener at the bottom of this
// file): by the time the player can physically click Enter, the promise below
// has always resolved, so awaiting it adds exactly zero delay on the re-entry
// path it was written for. The wall-clock settle window is the part that
// actually waits — hold the request until this long after the previous 'end',
// so the FIRST attempt (the only one guaranteed to still hold the click's
// transient activation) lands after the runtime has released the compositor.
// Re-entering after a normal pause on the start screen is already past the
// window and pays nothing.
const RUNTIME_SETTLE_MS = 800;

// The timeout cap means a runtime that never fires 'end' can't brick the
// Enter button — we fall through and let the retry loop below deal with it.
function waitForPreviousSessionEnd(timeoutMs = 1500) {
  if (!lastSessionEnded) return Promise.resolve();
  return Promise.race([
    lastSessionEnded,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]).then(() => {
    const sinceEnd = performance.now() - lastSessionEndedAt;
    const settle = RUNTIME_SETTLE_MS - sinceEnd;
    if (!(settle > 0)) return undefined;
    console.log('[XR] previous session ended ' + Math.round(sinceEnd) +
      ' ms ago — settling ' + Math.round(settle) + ' ms before requesting');
    return new Promise((resolve) => setTimeout(resolve, settle));
  });
}

// Delays total ~2.85 s — added to the settle window above this stays inside
// Chromium's ~5 s transient-activation window, so every retry still counts as
// user-activated. SecurityError / NotAllowedError are never retried on the
// FIRST attempt: the activation was never there or the user denied the
// prompt, and repeating the call can only fail the same way. Everything else
// (InvalidStateError, and Quest's runtime-busy rejections, which surface as
// NotSupportedError even though isSessionSupported already said yes) is
// transient teardown state.
//
// The same error on a LATER attempt means something different: the first call
// consumed the activation and the runtime was still busy releasing. That is a
// lost click, not a dead end, so tag it and let the caller ask for one more
// press instead of showing a raw DOM message the player cannot act on.
const SESSION_RETRY_DELAYS_MS = [250, 500, 900, 1200];

async function requestSessionWithRetry(sessionType, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await navigator.xr.requestSession(sessionType, init);
    } catch (err) {
      const fatal = err && (err.name === 'SecurityError' || err.name === 'NotAllowedError');
      if (fatal && attempt > 0) err.xrNeedsAnotherPress = true;
      if (fatal || attempt >= SESSION_RETRY_DELAYS_MS.length) throw err;
      const delay = SESSION_RETRY_DELAYS_MS[attempt];
      console.warn(`[XR] requestSession failed (${err.name || err}) — previous session likely still releasing; retrying in ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Billboarded in-headset progress panel, shown while the GLBs download inside
// the live XR session (assets load AFTER requestSession — see startInGame).
// DOM loading screens are invisible in an immersive session unless dom-overlay
// was granted, so the feedback has to be an in-scene mesh.
function createLoadingPanel() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, side: THREE.DoubleSide, depthTest: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.1125), material);
  mesh.renderOrder = 999;
  const setText = (text) => {
    ctx.fillStyle = 'rgba(10, 12, 24, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '48px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    texture.needsUpdate = true;
  };
  setText('Loading…');
  const dispose = () => {
    mesh.geometry.dispose();
    material.dispose();
    texture.dispose();
  };
  return { mesh, setText, dispose };
}

export async function startInGame({ overlay, loadingScreen, statusEl, multiplayer = null, xrMode = 'ar' } = {}) {
  if (!navigator.xr) {
    if (statusEl) statusEl.textContent = 'WebXR not available in this browser.';
    return;
  }

  // One entry attempt at a time. The start screen stays up until
  // requestSession resolves, and on a re-entry that path now spends up to a
  // second settling the runtime — long enough for an impatient second click
  // to fire a SECOND requestSession. The spec rejects that outright (a
  // pending immersive session is an InvalidStateError) and whichever session
  // does come back is orphaned, with no 'end' listener and no way out but a
  // reload. Cleared as soon as the session is live — the overlay is hidden by
  // then, so no further click can land — or on any failure before that.
  if (entryInFlight) {
    console.warn('[XR] entry already in progress — ignoring duplicate Enter');
    return;
  }
  entryInFlight = true;

  // 'ar' → passthrough MR (see the real room); 'vr-focus' → procedural
  // Focus Room venue (js/scene/focusRoom.js). WebXR session type is fixed
  // at request time, so this is a pre-session choice, driven by the toggle
  // on the start screen.
  //
  // BETA LAUNCH: the GLB venues ('vr' stadium / 'vr-tt') stay disabled —
  // restore the commented line below together with the createArena import
  // and the full venue picker in overlay.js.
  const isVR = xrMode === 'vr-focus';
  // const isVR = xrMode === 'vr' || xrMode === 'vr-tt' || xrMode === 'vr-focus';
  const sessionType = isVR ? 'immersive-vr' : 'immersive-ar';
  const supported = await navigator.xr.isSessionSupported(sessionType);
  if (!supported) {
    const label = isVR ? 'Immersive VR' : 'Immersive AR';
    if (statusEl) statusEl.textContent = `${label} not supported on this device.`;
    entryInFlight = false;
    return;
  }

  // Quest-specific: create the shared AudioContext BEFORE the XR session so
  // WebXR doesn't spin up its own audio graph (which makes the headset volume
  // rocker stop controlling master volume when WebRTC is added later). Safe
  // and idempotent for single-player too.
  try { await AudioContextBridge.init(); } catch (err) { console.warn('AudioContextBridge init failed:', err); }

  // WebXR emulator workaround: Meta's Immersive Web Emulator polyfills
  // navigator.xr but not the global XRWebGLBinding constructor. Three.js's
  // setSession() tries `new XRWebGLBinding(session, gl)` with the emulator's
  // fake session, and the native constructor rejects it ("parameter 1 is
  // not of type 'XRSession'"). Removing the global forces Three.js into the
  // older baseLayer path which works with the emulator. On real Quest the
  // detector returns false and XRWebGLBinding stays intact.
  if (typeof navigator.xr !== 'undefined' && typeof window.XRWebGLBinding !== 'undefined') {
    let emulated = false;
    try {
      emulated = !navigator.xr.isSessionSupported.toString().includes('[native code]');
    } catch {}
    if (emulated) {
      console.log('[WebXR] emulator detected — disabling XRWebGLBinding for compatibility');
      delete window.XRWebGLBinding;
    }
  }

  // If the player just exited a session (mode switch on the start screen),
  // make sure it has actually finished ending before asking for a new one —
  // requesting while the old one is still active is a guaranteed
  // InvalidStateError. Resolved instantly in the normal cold-start case.
  await waitForPreviousSessionEnd();

  // requestSession MUST run while the click's transient user activation is
  // still live (~5 s in Chromium). The old flow downloaded every GLB first,
  // so on a cold cache the first click always died here with NotAllowedError
  // ("user activation is required") and only the second, cache-warm click got
  // in. Assets now load INSIDE the session (below), with progress shown on an
  // in-headset panel.
  let session;
  try {
    // P16 §5.1: 'light-estimation' requested ONLY on immersive-ar. Meta Quest
    // Browser exposes it under the passthrough runtime; requesting it as
    // optional means the session still starts if the runtime doesn't offer it
    // (we'll fall back to the hardcoded MR-tint rig). Not valid on
    // immersive-vr sessions.
    const optionalFeatures = ['hand-tracking', 'plane-detection', 'dom-overlay'];
    if (xrMode === 'ar') optionalFeatures.push('light-estimation');
    session = await requestSessionWithRetry(sessionType, {
      requiredFeatures: ['local-floor'],
      optionalFeatures,
      domOverlay: { root: document.body },
    });
  } catch (err) {
    // Log the NAME as well: the raw message ("Failed to execute
    // 'requestSession' on 'XRSystem': …") is the same string for half a dozen
    // unrelated causes, and the DOMException name is the half that says which.
    console.error('Failed to start XR session:', err && err.name, err);
    const label = isVR ? 'VR' : 'MR';
    if (statusEl) {
      // Lead with the one instruction that actually works — the runtime is
      // busy, not broken, and the next press almost always gets in.
      statusEl.textContent = err && err.xrNeedsAnotherPress
        ? `The headset was still closing the previous session — press Enter ${label} again.`
        : `Failed to start ${label} session — press Enter ${label} again. (${(err && err.name) || 'Error'}: ${err && err.message})`;
    }
    entryInFlight = false;
    // Nothing to roll back — no scene or lighting state has been touched yet.
    return;
  }

  // Arm the switch guard for THIS session before anything can end it (wrist
  // menu, abortEntry, or the runtime itself). { once } so a stale listener
  // never holds the resolved promise's session alive.
  lastSessionEnded = new Promise((resolve) => {
    session.addEventListener('end', () => {
      // Wall-clock stamp for RUNTIME_SETTLE_MS — the event fires well before
      // the Quest runtime has finished letting go of the compositor.
      lastSessionEndedAt = performance.now();
      resolve();
    }, { once: true });
  });
  // Session is ours: the overlay comes down on the next line, so no further
  // Enter click can reach startInGame until the session ends and puts it back.
  entryInFlight = false;

  // Kick the lobby chunk (~368 KB of Firebase SDK) now rather than at the end
  // of setup: the fetch overlaps setSession + the GLB load, and the module's
  // evaluation task slots into the idle main thread while loadModels() waits
  // on the network. Deliberately not at the top of startInGame — the
  // isSessionSupported and requestSession failure paths both return before
  // this point, and downloading it for a player who never got into XR is
  // waste.
  preloadLobbyManager();

  // Session is live and the overlay is coming down — open the analytics run
  // here, not at page load. This is the first ensureAnonymousAuth() for a SOLO
  // player, and its identitytoolkit round trip has no business on the entry
  // critical path. Fire-and-forget: it never rejects and never blocks setup.
  beginSession({ xrMode });

  if (overlay) overlay.style.display = 'none';
  // Arena mode: solid dark clear + dimmed base lights; the room itself is
  // built once the venue GLB arrives, below. AR mode keeps the historical
  // transparent clear so passthrough shows.
  let arena = null;
  // Passthrough backdrop (js/scene/mrBackdrop.js) — MR only, built after
  // loadModels below, shown per the `mrBackdrop` profile setting.
  let backdrop = null;
  if (isVR) {
    setArenaClear();
    setArenaLighting();
  } else {
    setTransparentClear();
  }

  await renderer.xr.setSession(session);
  haptics.setSession(session);

  // MUST come after setSession, and MUST NOT be awaited on the startup path.
  //
  // updateTargetFrameRate() resolves on a FRAME BOUNDARY, and there are no
  // frames until setSession installs the base layer and starts the XR render
  // loop. Awaiting it beforehand deadlocks: the promise waits for a frame,
  // the frame waits for setSession, and setSession waits behind the await.
  // The session opens, the headset shows nothing, and the game never starts.
  //
  // Fire-and-forget for the same reason in reverse — a runtime that never
  // settles the promise (or settles it late) must not be able to stall entry.
  // The rate change lands a frame or two into the asset load either way,
  // which is invisible to the player and costs nothing.
  requestBestFrameRate(session).catch(err =>
    console.warn('[XR] frame-rate request failed:', err));

  // P16 §5.1: In MR (passthrough) start with the fallback tint so the
  // first few frames — before an XRLightProbe estimate lands — don't
  // look like the VR-tuned key. Rim stays on for silhouette.
  if (xrMode === 'ar') applyMRFallbackLighting();

  initStatsHud();

  // --- Controller binding + laser -----------------------------------------
  // MUST run before the asset downloads below. The browser delivers the
  // session's initial `inputsourceschange` moments after the session starts —
  // i.e. during the (possibly long) GLB wait. If the three.js controller/grip
  // spaces don't exist yet, that event finds no slots to bind to and the
  // input sources are dropped; nothing re-binds them until the NEXT
  // inputsourceschange, which in practice is the player opening and closing
  // the Quest system menu. Symptom: no paddle and no laser until the Meta
  // button is pressed.
  let uiInputReady = false; // handleTrigger's menus are built further down
  // Slider drag state. A drag is press → move → release, so it needs the
  // trigger's RELEASE as well as its press; `draggingSliderId` pins the drag
  // to whichever slider was grabbed.
  let draggingSliderId = null;
  // Last UV the laser hit on the active panel — the trigger handler needs the
  // pointer position, but it only receives a grip.
  let lastPanelUV = null;

  const laser = createLaserLine();
  // Start the beam just in front of the targetRay origin. This used to be
  // 0.15 m to keep the beam off the paddle blade, but that left a visible
  // hand-to-beam gap: the ray read as a free-floating stick near the panel
  // rather than something emitted by the thing in your hand, which breaks the
  // sense that you are pointing it. The beam draws with depthTest off and
  // fades toward the hand, so overlapping the blade costs nothing. The
  // raycast still originates at the controller — only the visual is pushed
  // forward, and the tip disc still lands exactly on the hit point (scale
  // compensates below).
  const LASER_START_OFFSET = 0.03;
  laser.position.z = -LASER_START_OFFSET;
  scene.add(laser);

  const xr = setupXRPaddle(session, {
    onSelect: (grip) => { if (uiInputReady) handleTrigger(grip); },
    onSelectEnd: () => { draggingSliderId = null; },
  });

  xr.onPaddleAttached(() => {
    const targetRay = xr.getActiveTargetRay();
    if (targetRay) {
      if (laser.parent) laser.parent.remove(laser);
      targetRay.add(laser);
    }
  });

  // --- In-session asset loading -------------------------------------------
  // The player is already in the headset while the table/paddle GLBs (and in
  // arena mode the venue GLB — 22 MB on first visit) download. Render a
  // billboarded progress panel on a minimal loop so the wait is never a black
  // void; the DOM loading screen still updates in parallel for desktop and
  // dom-overlay. The real animation loop installed at the end of setup
  // replaces this one.
  const loadPanel = createLoadingPanel();
  scene.add(loadPanel.mesh);
  const _loadCamPos = new THREE.Vector3();
  const _loadCamFwd = new THREE.Vector3();
  renderer.setAnimationLoop(() => {
    const xrCam = renderer.xr.getCamera();
    xrCam.getWorldPosition(_loadCamPos);
    xrCam.getWorldDirection(_loadCamFwd);
    _loadCamFwd.y = 0;
    if (_loadCamFwd.lengthSq() < 1e-6) _loadCamFwd.set(0, 0, -1);
    _loadCamFwd.normalize();
    loadPanel.mesh.position.copy(_loadCamPos).addScaledVector(_loadCamFwd, 1.6);
    loadPanel.mesh.lookAt(_loadCamPos);
    renderer.render(scene, camera);
  });

  // Bail-out for load failures after the session is live: put the start
  // screen back and end the session. The 'end' listener that normally
  // restores state isn't registered yet, so clean up manually here.
  // restoreARLighting is safe to call unconditionally — it's a no-op
  // relative to the AR defaults.
  const abortEntry = (message) => {
    if (statusEl) statusEl.textContent = message;
    renderer.setAnimationLoop(null);
    scene.remove(loadPanel.mesh);
    loadPanel.dispose();
    if (arena) { arena.dispose(); arena = null; }
    if (backdrop) { backdrop.dispose(); backdrop = null; }
    restoreARLighting();
    setSceneBackground(new THREE.Color(0x1a1a2e));
    if (loadingScreen) loadingScreen.style.display = 'none';
    if (overlay) overlay.style.display = 'flex';
    if (session && session.end) session.end().catch(() => {});
  };

  loadPanel.setText('Loading models…');
  // Synthesize every lazily-built audio buffer (hall IR, ambient bed, whoosh
  // and roll noise — ~610k samples of main-thread fill) plus the pooled HRTF
  // impact heads NOW, behind the loading panel. Left lazy, the first swing or
  // ball roll paid that fill inside a render frame.
  prewarmAudio();
  // Paint the Focus Room's two procedural tiles (1024² wood floor, 512x1024
  // wall panelling) while loadModels waits on the network, so createFocusRoom
  // below finds both canvases already memoized. setTimeout rather than a bare
  // call so the paint is its own task inside that wait instead of extending
  // this one. Skipped in MR, which builds no venue.
  if (isVR) setTimeout(() => { warmWoodTile(); warmWallTile(); }, 0);
  try {
    await loadModels(loadingScreen, statusEl);
    mark('modelsLoaded');
  } catch (err) {
    abortEntry('Failed to load 3D models: ' + (err?.message || err));
    return;
  }

  // Net compositing is session-mode-dependent (see setNetXRMode): MR keeps
  // the alpha-to-coverage cutout that survives passthrough, VR switches to
  // the authored smooth alpha blend, which cannot shimmer.
  setNetXRMode(isVR ? 'vr' : 'ar');

  // Ball colour default is mode-dependent, and only settable here because
  // setBallColor needs the meshes loadModels just registered.
  //
  // models.js defaults to white: ITTF-legal, the colour most world-federation
  // events use, and correct against the arena's navy floor. In passthrough MR
  // it is the worst available choice — the ball is played against whatever
  // the player's actual room is, and rooms are overwhelmingly white or beige
  // walls. A white ball loses its silhouette against them at exactly the far
  // distances where it is already down to ~11-15 px across, and no amount of
  // rim light rescues a white object in front of a white wall.
  //
  // Orange is the other ITTF-legal colour, so this trades nothing for
  // legibility. The wrist menu still overrides it either way.
  if (!isVR) setBallColor('orange');

  // Passthrough backdrop: the Eleven-style screen behind the far end for
  // players whose room they would rather not look at. Needs tableBox, so it
  // runs after loadModels; synchronous like the Focus Room. Built every MR
  // session and shown only when the profile says so, so the wrist-menu
  // toggle is a visibility flip with nothing to load.
  if (!isVR) {
    backdrop = createMRBackdrop();
    if (backdrop) backdrop.setVisible(profileStore.getSetting('mrBackdrop'));
  }

  // Focus Room: procedural venue, needs tableBox so it can only run after
  // loadModels. Built synchronously — no download, no progress UI. Every
  // downstream consumer (factoryArgs, abortEntry, session-end cleanup)
  // already handles the `arena` handle.
  if (isVR) {
    arena = createFocusRoom();
    if (arena) arena.show();
    // Link the room's shader programs via KHR_parallel_shader_compile instead
    // of stalling the first frame that draws it. Plain `camera`, NOT
    // renderer.xr.getCamera(): compile() reads only camera.layers, to filter
    // lights, and never camera matrices — and ARENA_LIGHT_LAYER is outside
    // both that mask and the XR ArrayCamera's, so the surviving light set, and
    // therefore the program keys, match what the ArrayCamera will render with.
    // Never awaited: a runtime that never settles this must not stall entry.
    renderer.compileAsync(scene, camera)
      .catch((err) => console.warn('[XR] shader precompile failed:', err));
  }

  // BETA LAUNCH: GLB venue loading stays disabled with the createArena
  // import above ('vr' / 'vr-tt' never reach this build's isVR check).
  // Restore into an xrMode dispatch alongside the Focus Room block.
  /*
  if (isVR) {
    // createArena needs tableBox, so it can only run after loadModels.
    arena = createArena(xrMode === 'vr-tt' ? 'tt' : 'stadium');
    if (arena) arena.show();
    if (arena && arena.ready) {
      const loadingMsg = loadingScreen ? loadingScreen.querySelector('p') : null;
      if (loadingScreen) {
        if (loadingMsg) loadingMsg.textContent = 'Loading arena…';
        loadingScreen.style.display = 'flex';
      }
      loadPanel.setText('Loading arena…');
      const unsubscribe = onArenaLoadProgress((loaded, total, pct) => {
        const line = `Loading arena… ${Math.floor(pct)}% ` +
          `(${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`;
        if (loadingMsg) loadingMsg.textContent = line;
        loadPanel.setText(line);
      });
      try {
        await arena.ready;
      } catch (err) {
        console.error('Arena failed to load:', err);
        unsubscribe();
        abortEntry('Failed to load arena: ' + (err?.message || err));
        return;
      }
      unsubscribe();
      if (loadingScreen) loadingScreen.style.display = 'none';
    }
  }
  */

  scene.remove(loadPanel.mesh);
  loadPanel.dispose();

  // The paddle GLB exists now — bind it to whichever controller connected
  // during the load (attachPaddleToGrip no-ops while paddleModel is null,
  // so the 'connected' events that fired mid-download attached nothing).
  xr.resweep('models-loaded');

  // --- MR light-estimation probe (P16 §5). Requested lazily after session
  // start — Meta Quest Browser resolves the promise only once the runtime
  // has a usable estimate (a second or two after entering passthrough).
  // If the feature was denied at session-request time this rejects, and
  // we stay on the MR fallback tint applied above.
  let xrLightProbe = null;
  const _lightDirWorld = new THREE.Vector3();
  const _lightEstColor = { r: 0, g: 0, b: 0 };
  if (xrMode === 'ar' && typeof session.requestLightProbe === 'function') {
    session.requestLightProbe({ reflectionFormat: 'srgba8' })
      .then((probe) => { xrLightProbe = probe; })
      .catch(() => { /* runtime declined; MR fallback rig stays */ });
  }

  // --- State ---
  let state = 'menu'; // 'menu' | 'freePlay' | 'drill' | 'tuner'
  let drillInstance = null;
  let drillFinished = false;
  let lastDrillParams = null;
  let prevStateBeforeTuner = 'menu'; // restore target when leaving the tuner

  const ballEvents = {
    onPaddleHit, onTableBounce, onNetHit, onBallLost,
    offPaddleHit, offTableBounce, offNetHit, offBallLost,
  };

  // --- Floating menu ---
  const wristMenu = new WristMenu({
    // The hub's hand button shows the live profile value (it also changes
    // from PLAY › SETTINGS and from first-swing detection).
    getDominantHand: () => profileStore.getSetting('dominantHand'),
    // The backdrop toggle exists only where there is a room to hide.
    showBackdrop: !isVR,
    getBackdropOn: () => !!profileStore.getSetting('mrBackdrop'),
  });
  scene.add(wristMenu.mesh); // floating in world; billboarded each frame

  // The PLAY menu — a sub-menu of the wrist menu, not a replacement. Lists
  // the Training Session's levels; its Settings screen reads and writes the
  // M10 globals (dominant hand today) through the profile store.
  const trainingMenu = new TrainingMenu({ settings: profileStore });
  scene.add(trainingMenu.mesh);

  wristMenu.show(); // visible from the moment the session starts
  // --- Physics tuner (free-roaming panel, opened from the wrist menu) ---
  const tuner = new PhysicsTuner();
  // currentTuner points to whichever tuner is currently open. State stays
  // 'tuner' while one is up; activePanel() resolves through this ref.
  let currentTuner = null;
  const onTunerBack = () => {
    if (currentTuner) currentTuner.hide();
    currentTuner = null;
    if (prevStateBeforeTuner === 'drill' && drillInstance) {
      state = 'drill';
      if (drillInstance.panel) drillInstance.panel.show();
    } else if (prevStateBeforeTuner === 'freePlay') {
      enterFreePlay();
    } else {
      enterMenu();
    }
  };
  tuner.on('back', onTunerBack);

  // --- Calibration wizard (P13 §C3). Same panel interface as PhysicsTuner
  // so it routes through the existing currentTuner/activePanel machinery
  // with no branching. Grip sampling and ω_grip are wired to xrPaddle.js /
  // ball.js via the constructor callbacks — the wizard stays decoupled
  // from those modules.
  const calibWizard = new CalibrationWizard({
    sampleGrip: (outPos, outQuat) => xr.getSmoothedGripPose(outPos, outQuat),
    getAngularSpeed: () => paddleAngularVelocity.length(),
  });
  const calibTuner = new CalibrationTuner();
  calibWizard.on('back', onTunerBack);
  // On wizard accept, hand off to the fine-tune panel so the player can nudge
  // the just-fitted values without opening a second menu.
  calibWizard.on('accepted', () => {
    calibWizard.hide();
    currentTuner = calibTuner;
    calibTuner.show();
  });
  // Direct "Fine-tune manually" from the wizard's first screen — same
  // hand-off as 'accepted', minus the two-sample fit.
  calibWizard.on('fineTune', () => {
    calibWizard.hide();
    currentTuner = calibTuner;
    calibTuner.show();
  });
  calibTuner.on('back', onTunerBack);

  const raycaster = new THREE.Raycaster();
  const tmpQuat = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  // Reused {u,v} record for the last panel hit — rebuilt-in-place each frame
  // the laser is on a panel instead of allocating a fresh literal.
  const panelUV = { u: 0, v: 0 };
  const tmpCamPos = new THREE.Vector3();
  const tmpCamFwd = new THREE.Vector3();
  const tmpPokePos = new THREE.Vector3();
  const tmpPokeLocal = new THREE.Vector3();

  // Poke input state — tracks whether the off-hand approach is "armed" (in
  // range) and whether it's already fired this poke stroke. Rearms when the
  // finger retracts fully back in front of the plane.
  const POKE_APPROACH_RANGE = 0.16;  // metres in front of plane to engage hover
  const POKE_ENGAGE_DEPTH   = 0.03;  // metres past the plane to fire select
  const POKE_REARM_DEPTH    = 0.04;  // metres in front of plane to rearm
  let pokeArmed = false;
  let pokeTriggered = false;

  // Everything handleTrigger reaches for (menus, tuners, drill state) exists
  // from this point on — let the trigger through. The controllers themselves
  // were bound before the asset load, further up.
  uiInputReady = true;

  // --- Wrist menu actions ---
  wristMenu.on('start', ({ drill, difficulty, config, options }) => {
    // MULTI with no live peer connection opens the in-XR lobby panel instead
    // of bouncing off enterDrill's gate — before that panel existed, the tile
    // was a dead button in any solo session. With a connection already up
    // (lobby auto-entry, or a drill exited back to the menu) it goes straight
    // into the match as before.
    if (drill === 'multiplayer' && !(multiplayer && multiplayer.networkManager)) {
      // Opening the panel is the intent signal. Pay Firebase init + anonymous
      // auth + the first Firestore round trip HERE, while the player is still
      // choosing CREATE vs JOIN or typing a six-character code — otherwise all
      // of it lands inside the wait after the button press.
      traceBoot('MULTI panel opened');
      if (prewarmSignaling) prewarmSignaling();
      enterTuner(mpMenu);
      return;
    }
    // `options` carries the wrist menu's competition-rules flag (and any
    // future per-launch flags) into the drill factory via enterDrill's
    // spread.
    lastDrillParams = { drill, difficulty, config, options };
    enterDrill(drill, difficulty, config, options);
  });
  // The PLAY menu, opened from the wrist menu's PLAY tile as a SUB-menu. It
  // rides the same currentTuner machinery the physics tuner and calibration
  // wizard use — show/hide/isVisible/mesh/selectHovered/'back' — so backing
  // out of it returns to the wrist menu completely unchanged, and no new
  // input plumbing was needed. (The wrist event is still named 'training':
  // it is a stable key, and renaming it buys nothing.)
  wristMenu.on('training', ({ difficulty } = {}) => {
    if (difficulty) trainingMenu.setDifficulty(difficulty);
    enterTuner(trainingMenu);
  });
  trainingMenu.on('back', onTunerBack);
  trainingMenu.on('start', ({ drill, difficulty, config, options }) => {
    trainingMenu.hide();
    currentTuner = null;
    lastDrillParams = { drill, difficulty, config, options };
    enterDrill(drill, difficulty, config, options);
  });
  // The footer shortcuts hand off to the existing panels rather than
  // reimplementing them.
  trainingMenu.on('calibrate', () => { trainingMenu.hide(); enterTuner(calibWizard); });
  // Physics tuner mutates live physics constants (gravity, drag, restitution) —
  // in multiplayer the two clients would silently disagree. Dev-only (?selftest).
  trainingMenu.on('tune', () => { if (TUNER_ENABLED) { trainingMenu.hide(); enterTuner(tuner); } });
  trainingMenu.on('exit', () => onTunerBack());

  // In-XR multiplayer lobby, opened from the wrist menu's MULTI tile when no
  // peer connection exists yet. Rides the same currentTuner machinery as the
  // training menu. On a negotiated connection it adopts the same
  // { networkManager, role, lobby } bundle the 2D start screen hands through,
  // so the drill (and session-end teardown, which reads `multiplayer`) can't
  // tell the two entry paths apart.
  // The lobby stack loads in the background from session start; by the time
  // a user has navigated wrist menu → MULTI → CREATE/JOIN it is resolved. On
  // the (slow-network) chance it isn't, the factory throws inside the menu
  // model's try and surfaces as its friendly retryable error.
  const mpMenu = new MultiplayerMenu({
    createLobby: () => {
      if (!LobbyManagerCtor) {
        throw new Error('MP_STACK_LOADING: multiplayer is still loading — try again in a moment');
      }
      return new LobbyManagerCtor();
    },
  });
  scene.add(mpMenu.mesh);
  mpMenu.on('back', onTunerBack);
  mpMenu.on('connected', (mp) => {
    multiplayer = mp;
    mpMenu.hide();
    currentTuner = null;
    enterDrill('multiplayer', null);
  });

  wristMenu.on('tune', () => { if (TUNER_ENABLED) enterTuner(tuner); });
  wristMenu.on('calibrate', () => enterTuner(calibWizard));
  wristMenu.on('ballColor', ({ colorId }) => setBallColor(colorId));
  wristMenu.on('tableColor', ({ colorId }) => setTableColor(colorId));
  // Same profile key the PLAY › SETTINGS row writes; xrPaddle subscribes to
  // the store and moves the paddle across on the next frame.
  wristMenu.on('dominantHand', ({ hand }) => profileStore.setSetting('dominantHand', hand));
  // The store is the source of truth (the button's icon reads it back), and
  // the screen follows whatever the store actually kept.
  wristMenu.on('mrBackdrop', ({ on }) => {
    const kept = profileStore.setSetting('mrBackdrop', !!on);
    if (backdrop) backdrop.setVisible(kept);
  });
  // A change from the settings screen or swing detection must show on the
  // hub button too; redraw on any profile write (rare — a few per session).
  // Released at session end below: the store outlives the session, and a
  // stale subscriber would paint a disposed canvas.
  const unsubscribeHandRedraw = profileStore.subscribe(() => wristMenu.draw());
  wristMenu.on('exit', () => endSession());

  // Panels that are MENUS rather than transient in-play tools. They get the
  // wrist menu's fixed world anchor instead of head-billboarding at 1.1 m,
  // which puts a 1.4 m-wide panel too close to read, and they own sliders that
  // the trigger has to be able to drag.
  const isMenuPanel = (p) => p === trainingMenu || p === mpMenu;

  function enterTuner(target) {
    prevStateBeforeTuner = state;
    if (drillInstance && drillInstance.panel) drillInstance.panel.hide();
    wristMenu.hide();
    hideLiveLine();
    hideSummary();
    state = 'tuner';
    currentTuner = target;
    target.show();
  }

  // Auto-enter the multiplayer drill if the lobby handed us a live connection.
  // Bypasses the wrist menu on entry; player can still A/X back to it to exit.
  if (multiplayer && multiplayer.networkManager) {
    queueMicrotask(() => enterDrill('multiplayer', null));
  } else if (multiplayer) {
    // A multiplayer object was passed but the NetworkManager was missing —
    // means the user tapped Enter MR before lobby negotiation completed.
    // The overlay gate should prevent this, but surface it in the HUD so any
    // regression is visible from inside the headset rather than silently
    // dropping into solo.
    hudLog('multiplayer: connection not ready at MR entry — entered solo');
  }

  function enterMenu() {
    teardownDrill();
    hideLiveLine();
    hideSummary();
    state = 'menu';
    wristMenu.show();
  }

  function enterFreePlay() {
    teardownDrill();
    stopFreePlayFeeder();
    hideLiveLine();
    hideSummary();
    state = 'freePlay';
    wristMenu.hide();
  }

  // --- M8 Free Play: optional feeder toggle -----------------------------------
  //
  // "Empty table, unlimited balls, no scoring, optional feeder toggle
  // mid-session" (P15 §M8). The feeder is the M1 ball machine itself, run
  // with an infinite burst and no stats sink — a config over a shared
  // primitive rather than a second feed implementation (anti-dead-code rule 1).
  let freePlayFeeder = null;

  function stopFreePlayFeeder() {
    if (freePlayFeeder) {
      freePlayFeeder.dispose();
      freePlayFeeder = null;
    }
  }

  function toggleFreePlayFeeder() {
    if (freePlayFeeder) {
      stopFreePlayFeeder();
      hudLog('feeder off');
      return;
    }
    // Any ball already in flight belongs to the player's own toss; clear it so
    // the machine doesn't wait forever on a ball that will never be returned.
    if (ballModel) ballModel.visible = false;
    const config = validateConfig({
      ...WARMUP_FEED,
      burstCount: INFINITE,
    });
    try {
      freePlayFeeder = createM1BallMachineDrill({ config });
      hudLog('feeder on — B/Y to stop');
    } catch (err) {
      console.error('free play feeder failed to start:', err);
      hudLog(`feeder failed: ${err.message || err}`);
      freePlayFeeder = null;
    }
  }

  function enterDrill(drill, difficulty, config, options) {
    teardownDrill();
    hideSummary();
    const factory = DRILL_FACTORIES[drill];
    if (!factory) {
      hudLog(`unknown drill: ${drill}`);
      enterMenu();
      return;
    }
    const profile = getProfile(difficulty);
    const factoryArgs = {
      ballEvents, profile, config: config || null,
      // Per-drill options (the session's level and hand, a match's best-of).
      // Drills that don't understand a key ignore it.
      ...(options || {}),
      xr,
      // `restart` re-enters the SAME drill with the same parameters — what the
      // match report's PLAY AGAIN needs. Reads lastDrillParams rather than
      // closing over this call's arguments so a drill entered by one path and
      // restarted later still replays what the player actually chose.
      hooks: {
        exitToMenu: enterMenu,
        endSession,
        restart: () => {
          if (!lastDrillParams) return;
          enterDrill(lastDrillParams.drill, lastDrillParams.difficulty,
            lastDrillParams.config, lastDrillParams.options);
        },
      },
      // Populated only when a venue GLB with named walls is loaded (tt-arena).
      // Drills that render UI panels (currently just aiMatch's scoreboard) use
      // it to wall-mount instead of floating in world space.
      // (These two keys were named arenaAnchor / arena pre-beta; renamed to
      // neutral terms because object keys survive minification and the beta
      // bundle must not hint at the unreleased venues.)
      scoreboardAnchor: arena && arena.getBackWallAnchor ? arena.getBackWallAnchor() : null,
      // Full venue handle so drills can opt into stadium-specific
      // enhancements (live scoreboard on the venue's TV meshes, positional
      // crowd audio on the 24 audience sections). Null when no venue is
      // mounted (AR/MR mode). Drills should feature-detect the accessor
      // methods (getStadiumScreens / getCrowdAnchors) since only the
      // stadium variant populates them.
      env: arena,
    };
    // Multiplayer drill needs the live NetworkManager + role from the lobby.
    // Other drills ignore this slot.
    if (drill === 'multiplayer') {
      if (!multiplayer || !multiplayer.networkManager) {
        hudLog('multiplayer: no connection — use the MULTI tile to create or join a room');
        enterMenu();
        return;
      }
      factoryArgs.multiplayer = multiplayer;
    }
    try {
      drillInstance = factory.create(factoryArgs);
    } catch (err) {
      console.error(`failed to start ${drill}:`, err);
      hudLog(`drill failed: ${err.message || err}`);
      enterMenu();
      return;
    }
    drillFinished = false;
    state = 'drill';
    wristMenu.hide();
    if (drillInstance.panelMesh) {
      scene.add(drillInstance.panelMesh);
    }
    hudLog(`drill: ${drill} / ${profile.label}`);
  }

  function teardownDrill() {
    // The Free Play feeder owns a machine figure in the scene, so it must go on
    // every exit path — entering a drill, returning to the menu, or ending the
    // session — not just when Free Play is re-entered.
    stopFreePlayFeeder();
    if (drillInstance && drillInstance.dispose) drillInstance.dispose();
    drillInstance = null;
    clearListeners();
    if (ballModel) ballModel.visible = false;
  }

  function endSession() {
    teardownDrill();
    clearStatsHud();
    if (session && session.end) session.end().catch(() => {});
  }

  function showDrillSummary() {
    // The panel reads the drill's M7 event-log summary — the same numbers
    // Review & Stats analyses. Only the M1-family drills finish AND carry a
    // log; anything else that ever reports finished just skips the panel.
    if (!drillInstance || typeof drillInstance.getSummary !== 'function') return;
    const factory = DRILL_FACTORIES[lastDrillParams && lastDrillParams.drill];
    // The Training Session adds its score card, whose button starts the
    // practice mode for the player's weakest block.
    const report = drillInstance.getReport ? drillInstance.getReport() : null;
    showSummary({
      ...drillInstance.getSummary(),
      drillLabel: factory ? factory.meta.label : null,
      difficultyLabel: getProfile(lastDrillParams && lastDrillParams.difficulty).label,
      report,
    }, {
      onTrainNext: report && report.next ? () => {
        const { drill, config, options } = report.next;
        const difficulty = lastDrillParams && lastDrillParams.difficulty;
        lastDrillParams = { drill, difficulty, config, options };
        enterDrill(drill, difficulty, config, options);
      } : null,
      onRetry: () => {
        if (lastDrillParams) {
          enterDrill(lastDrillParams.drill, lastDrillParams.difficulty,
            lastDrillParams.config, lastDrillParams.options);
        }
      },
      onChangeDrill: () => enterMenu(),
      onExit: () => endSession(),
    });
  }

  // --- Trigger dispatch (paddle hand) ---
  function handleTrigger(grip) {
    if (state === 'tuner') {
      // Grabbing a slider starts a drag that continues until release, even if
      // the ray wanders off the track.
      if (currentTuner && currentTuner.sliderAt && lastPanelUV) {
        draggingSliderId = currentTuner.sliderAt(lastPanelUV.u, lastPanelUV.v);
      }
      if (currentTuner) currentTuner.selectHovered();
      return;
    }
    if (state === 'menu') {
      wristMenu.selectHovered();
      return;
    }
    // If the active drill has its own panel and the laser is hovering a button,
    // route the click there rather than to drill gameplay.
    if (state === 'drill' && drillInstance && drillInstance.panel && drillInstance.panel.hovered) {
      drillInstance.panel.selectHovered();
      return;
    }
    // Drill-specific trigger action (e.g., trajectory practice = launch ball).
    if (state === 'drill' && drillInstance && drillInstance.launch) {
      drillInstance.launch();
      return;
    }
    if (state === 'freePlay') {
      serveFreePlayBall(grip);
      return;
    }
    // Other drills ignore the trigger (their machine owns the feed schedule).
  }

  function serveFreePlayBall(grip) {
    if (grip !== xr.getActiveController() || !ballModel || !tableBox) return;
    const serveX = (tableBox.min.x + tableBox.max.x) / 2;
    const serveY = tableSurfaceY + 0.6;
    const serveZ = tableBox.min.z;
    spawnBallAt(
      new THREE.Vector3(serveX, serveY, serveZ),
      new THREE.Vector3((Math.random() - 0.5) * 0.5, 1.5, 1.6),
      new THREE.Vector3(0, 0, 0),
    );
    hudLog('ball served');
  }

  // --- Paddle-hand A/X toggle (rising edge). Works with a single controller. ---
  let paddleBtnPrev = false;
  let altBtnPrev = false;
  function pollMenuToggle() {
    if (!session) return;
    // Prefer the paddle hand, but fall back to ANY controller when the paddle
    // hasn't bound yet. Assets now load inside the session, so a 'connected'
    // that arrives mid-download attaches nothing (attachPaddleToGrip guards on
    // paddleModel) and activeHandedness stays null. Gating the menu on the
    // bind made that state unrecoverable from inside the headset — the menu is
    // exactly what the player needs when the paddle failed to attach.
    const paddleHand = xr.getActiveHandedness();
    let pressed = false;
    let altPressed = false;
    for (const src of session.inputSources) {
      if (paddleHand && src.handedness !== paddleHand) continue;
      const buttons = src.gamepad && src.gamepad.buttons;
      // Button 4 = A (right) / X (left). Always present on Quest controllers.
      if (buttons && buttons[4] && buttons[4].pressed) pressed = true;
      // Button 5 = B (right) / Y (left) — M8's mid-session feeder toggle.
      if (buttons && buttons[5] && buttons[5].pressed) altPressed = true;
      if (pressed || altPressed) break;
    }

    // B/Y toggles the Free Play feeder. Scoped to freePlay so it can't fire
    // during a drill, where the drill owns the feed schedule.
    if (altPressed && !altBtnPrev && state === 'freePlay') toggleFreePlayFeeder();
    altBtnPrev = altPressed;
    if (pressed && !paddleBtnPrev) {
      // Tuner is open — A/X is the same as the panel's Back button so the
      // player can dismiss it without aiming the laser.
      if (state === 'tuner') {
        if (currentTuner) currentTuner.emit('back');
        paddleBtnPrev = pressed;
        return;
      }
      // In a drill that has its own panel (e.g. Trajectory Practice), A/X toggles
      // that panel directly. The main menu is reachable via the panel's "Back" button.
      if (state === 'drill' && drillInstance && drillInstance.panel) {
        if (drillInstance.panel.isVisible()) drillInstance.panel.hide();
        else drillInstance.panel.show();
      } else if (state === 'menu') {
        // Close main menu and return to whatever was running.
        if (drillInstance) {
          state = 'drill';
          wristMenu.hide();
          if (drillInstance.panel) drillInstance.panel.show();
        } else {
          enterFreePlay();
        }
      } else {
        // Open main menu (no drill panel to toggle).
        state = 'menu';
        wristMenu.show();
      }
    }
    paddleBtnPrev = pressed;
  }

  // --- Floating panel placement -------------------------------------------
  // Main menu: pinned in world space above the near half of the table, at
  // roughly standing-eye height, facing the player. Doesn't chase the head
  // so the player can lean/turn to inspect options without the panel drifting.
  //
  // Tuner + drill panels: still billboard ~1.1 m in front of the headset —
  // they're transient in-play tools where head-follow is what you want.
  function updateMenuPlacement() {
    if (state === 'menu' && wristMenu.isVisible()) {
      placeMenuStatic(wristMenu.mesh);
      return;
    }
    // The training and Machine Play menus are MENUS, not transient in-play
    // tools: they are read, scrolled and configured. Head-billboarding one at
    // 1.1 m puts a 1.4 m-wide panel in the player's face, too close to read.
    // They get the wrist menu's fixed world anchor instead — same distance,
    // same pose — so moving between menus doesn't change where you look.
    if (state === 'tuner' && isMenuPanel(currentTuner) && currentTuner.isVisible()) {
      placeMenuStatic(currentTuner.mesh);
      return;
    }
    const panelMesh = activePanelMesh();
    if (!panelMesh) return;
    // A drill panel can opt into the same fixed anchor (the match report
    // does). Same reasoning as the menus above: a panel you READ — lean
    // toward, point at, look away from — must stay where you left it, and
    // must appear where every other panel in the game appears.
    if (state === 'drill' && drillInstance && drillInstance.panel
        && drillInstance.panel.staticPlacement) {
      placeMenuStatic(panelMesh);
      return;
    }
    const xrCam = renderer.xr.getCamera();
    xrCam.getWorldPosition(tmpCamPos);
    xrCam.getWorldDirection(tmpCamFwd);
    panelMesh.position.copy(tmpCamPos).addScaledVector(tmpCamFwd, 1.1);
    panelMesh.position.y -= 0.10;
    panelMesh.lookAt(tmpCamPos);
  }

  // Fixed world pose for the main menu. Runs every frame while the menu is
  // visible — cheap, and it keeps the pose correct even if the guardian /
  // room-scale origin has shifted between showings. Uses table anchors
  // (rather than a hard-coded coordinate) so the menu tracks whatever pose
  // the table was placed at when models loaded.
  // Whichever panel is up gets the same anchor, so moving between them is a
  // content change rather than a change of place. The caller passes the mesh
  // (it already knows which panel it is asking about); deriving it here from
  // `state` is what stopped anything outside the menu family from using it.
  function placeMenuStatic(mesh) {
    if (!tableBox || tableSurfaceY == null || !mesh) return;
    const centerX = (tableBox.min.x + tableBox.max.x) / 2;
    // Position the panel just above the net (table Z-center) — roughly half
    // the table length from the player, so it's out of the swing volume but
    // still comfortably readable. Opponent-edge placement was too far to
    // read; near-edge placement crowded the player.
    const netZ = (tableBox.min.z + tableBox.max.z) / 2;
    // Anchor by the panel's BOTTOM edge rather than its centre: the training
    // menu's canvas is taller than the wrist menu's, so a shared centre
    // height would drop its lower rows toward the table surface.
    const halfH = (mesh.geometry.parameters && mesh.geometry.parameters.height)
      ? mesh.geometry.parameters.height / 2
      : MENU_PLANE_H / 2;
    mesh.position.set(centerX, tableSurfaceY + 0.47 + halfH, netZ);
    // Default plane normal is +Z; player stands on the +Z side, so the panel
    // faces them. Material is DoubleSide, so text stays legible either way.
    mesh.rotation.set(0, 0, 0);
  }

  function activePanelMesh() {
    if (state === 'tuner' && currentTuner && currentTuner.isVisible()) return currentTuner.mesh;
    if (state === 'menu' && wristMenu.isVisible()) return wristMenu.mesh;
    if (state === 'drill' && drillInstance && drillInstance.panel && drillInstance.panel.isVisible()) {
      return drillInstance.panel.mesh;
    }
    return null;
  }

  function activePanel() {
    if (state === 'tuner' && currentTuner && currentTuner.isVisible()) return currentTuner;
    if (state === 'menu' && wristMenu.isVisible()) return wristMenu;
    if (state === 'drill' && drillInstance && drillInstance.panel && drillInstance.panel.isVisible()) {
      return drillInstance.panel;
    }
    return null;
  }

  // Off-hand controller acts as a fingertip proxy while the player is holding
  // a paddle in the other hand. Runs before the laser raycast on the wrist
  // menu only. Returns true if poke handled hover this frame — in which case
  // updateMenuRaycast() should skip laser hover updates and hide the beam.
  function updatePokeInput() {
    if (state !== 'menu' || !wristMenu.isVisible()) {
      wristMenu.clearPokeCursor();
      pokeArmed = false;
      pokeTriggered = false;
      return false;
    }
    const off = xr.getOffHandGrip();
    if (!off) {
      wristMenu.clearPokeCursor();
      return false;
    }
    off.updateMatrixWorld();
    off.getWorldPosition(tmpPokePos);
    wristMenu.mesh.updateMatrixWorld();
    tmpPokeLocal.copy(tmpPokePos);
    wristMenu.mesh.worldToLocal(tmpPokeLocal);

    // Local frame: +Z away from camera (panel back), so a fingertip on the
    // camera side has negative z. When it crosses through, z becomes positive.
    const halfW = MENU_PLANE_W * 0.5;
    const halfH = MENU_PLANE_H * 0.5;
    const within = Math.abs(tmpPokeLocal.x) < halfW && Math.abs(tmpPokeLocal.y) < halfH;
    const depth = tmpPokeLocal.z;

    // Engage when fingertip approaches from the front and is inside the panel
    // footprint. Retract back past REARM depth clears the trigger.
    const approaching = within && depth > -POKE_APPROACH_RANGE && depth < POKE_ENGAGE_DEPTH + 0.02;
    if (!approaching) {
      wristMenu.clearPokeCursor();
      if (depth < -POKE_REARM_DEPTH) {
        pokeArmed = false;
        pokeTriggered = false;
      }
      return false;
    }

    const u = tmpPokeLocal.x / MENU_PLANE_W + 0.5;
    const v = tmpPokeLocal.y / MENU_PLANE_H + 0.5;
    const id = wristMenu.hitTestUV(u, v);
    wristMenu.setHovered(id);

    // Proximity 0-1: 0 when at outer approach range, 1 when at the plane.
    const proximity = 1 - Math.min(1, Math.max(0, -depth) / POKE_APPROACH_RANGE);
    wristMenu.setPokeCursor(u, v, proximity);

    pokeArmed = true;
    if (pokeArmed && !pokeTriggered && depth > POKE_ENGAGE_DEPTH && id != null) {
      wristMenu.selectHovered();
      pokeTriggered = true;
    }
    if (depth < -POKE_REARM_DEPTH) {
      pokeTriggered = false;
    }
    return true;
  }

  // --- Per-frame raycast against whichever panel is active ---
  function updateMenuRaycast(pokeHandled) {
    const panel = activePanel();
    if (!panel) {
      laser.visible = false;
      return;
    }
    // Poke input took the wheel this frame — hide the laser so the two input
    // modes don't visually compete. Hover is already set by updatePokeInput.
    if (pokeHandled) {
      laser.visible = false;
      return;
    }
    const targetRay = xr.getActiveTargetRay();
    if (!targetRay) {
      laser.visible = false;
      return;
    }

    targetRay.getWorldPosition(tmpVec);
    targetRay.getWorldQuaternion(tmpQuat);
    tmpDir.set(0, 0, -1).applyQuaternion(tmpQuat).normalize();
    raycaster.set(tmpVec, tmpDir);

    const hits = raycaster.intersectObject(panel.mesh, false);
    if (hits.length && hits[0].uv) {
      const uv = hits[0].uv;
      panelUV.u = uv.x;
      panelUV.v = uv.y;
      lastPanelUV = panelUV;
      // A live slider drag owns the ray: keep feeding it the pointer position
      // and don't let hover move to another widget mid-drag.
      if (draggingSliderId && panel.dragAt) {
        panel.dragAt(uv.x, uv.y, draggingSliderId);
      } else {
        panel.setHovered(panel.hitTestUV(uv.x, uv.y));
      }
      // Beam spans from the forward start offset to the hit point, so the
      // tip disc sits exactly on the panel: offset + scale = hit distance.
      laser.scale.z = Math.max(0.05, hits[0].distance - LASER_START_OFFSET);
      laser.visible = true;
    } else {
      panel.setHovered(null);
      // In a drill the paddle hand is playing: a free-aimed beam sweeping the
      // table with every stroke reads as a stuck pointer. Show the miss-state
      // beam only in pure menu contexts, where waving to find the panel is
      // the whole point.
      if (state === 'drill') {
        laser.visible = false;
      } else {
        laser.scale.z = 1.5;
        laser.visible = true;
      }
    }
  }

  // --- Session end cleanup ---
  session.addEventListener('end', () => {
    // FIRST, before any teardown: this is the last moment the page is
    // guaranteed alive, and the write has to be issued from here rather than
    // from an unload handler, which on a headset-removal often never runs.
    endAnalyticsRun({});
    teardownDrill();
    clearStatsHud();
    unsubscribeHandRedraw();
    wristMenu.hide();
    wristMenu.dispose();
    tuner.hide();
    tuner.dispose();
    // hide() cancels any in-flight room the panel still owns; a DELIVERED
    // connection is torn down below via the `multiplayer` bundle instead.
    mpMenu.hide();
    mpMenu.dispose();
    // Hide as well as remove: the beam is usually ON at session end (the Exit
    // button is clicked with the laser aimed at it), and a stale visible=true
    // is what made a resurrected laser render as a stuck ray.
    laser.visible = false;
    if (laser.parent) laser.parent.remove(laser);
    // The laser is a Group (beam tube + tip disc) — dispose its children.
    laser.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    // Tear down arena mode if it was active. restoreARLighting is safe to
    // call unconditionally — it's a no-op relative to the AR defaults.
    if (arena) { arena.dispose(); arena = null; }
    if (backdrop) { backdrop.dispose(); backdrop = null; }
    restoreARLighting();
    setSceneBackground(new THREE.Color(0x1a1a2e));
    if (overlay) overlay.style.display = 'flex';
    // The overlay coming back used to be the whole of "the session ended".
    // The card goes up with it — see js/ui/postSession.js for why this
    // moment and no other.
    showPostSession();
    renderer.setAnimationLoop(null);
    // Close the peer connection on session end so the room is released and
    // the remote peer is notified via the standard onclose path. Prefer the
    // lobby (it always holds the CURRENT NetworkManager after a reconnect
    // swap); fall back to the captured one for the no-lobby case.
    if (multiplayer && multiplayer.lobby) {
      multiplayer.lobby.teardown().catch(() => {});
    } else if (multiplayer && multiplayer.networkManager) {
      multiplayer.networkManager.teardown().catch(() => {});
    }
  });

  // --- Animation loop ---
  // dt derives from the callback's timestamp — in an XR session that is the
  // compositor's PREDICTED DISPLAY TIME, so consecutive deltas are exact
  // multiples of the display interval. THREE.Clock.getDelta() (the old
  // source) measures callback-EXECUTION intervals instead, which jitter by
  // a few ms even at a locked refresh rate; that jitter fed straight into
  // ball displacement (2 ms of dt error at 10 m/s is 2 cm of position error
  // per frame — visible strobing under smooth pursuit). With timestamp
  // deltas, a dropped frame advances physics exactly one extra display
  // interval: correct motion, just sampled once less.
  let lastFrameTimeMs = -1;
  let physicsTimeS = 0; // monotonic sim clock for hit/net cooldowns + squash
  // Reused per-frame options for tickPhysics — a fresh literal here was one
  // more allocation inside the frame loop.
  const tickPhysicsOpts = { ballOwned: true, getRawPose: null };
  renderer.setAnimationLoop((timeMs, frame) => {
    let dt = (lastFrameTimeMs >= 0 && timeMs > lastFrameTimeMs)
      ? (timeMs - lastFrameTimeMs) / 1000
      : 1 / 90; // first frame, or a runtime handed us a non-monotonic stamp
    lastFrameTimeMs = timeMs;
    // Uncapped display-time delta for the FPS meter — it must see the real
    // gap a hitch produced, not the physics-capped version of it.
    // const rawDt = dt;
    // Hitch cap: after a real stall (browser menu, tab focus loss, session
    // pause) advance at most 100 ms of physics and DROP the remainder. The
    // previous clamp substituted a fake 16 ms for the whole gap, which held
    // the ball frozen mid-flight for the length of the stall — the single
    // biggest "ball lags" artifact after a hiccup.
    if (dt > 0.1) dt = 0.1;
    physicsTimeS += dt;

    // Advance the tracking-loss guard first — its state feeds updatePaddleVisual
    // (freeze anchor on emulated) and tickPhysics (suppress contact). Reads
    // XRFrame.getPose().emulatedPosition on the paddle grip's inputSource.
    updateTrackingLossGuard(frame, xr.getActiveInputSource(), renderer.xr.getReferenceSpace());

    // P16 §5.1: drive key + hemi from the room's real light when
    // XRLightProbe is active. Smoothed inside applyLightEstimate (τ≈2 s)
    // so a passing hand or shadow doesn't make the virtual key jitter.
    if (xrLightProbe && frame.getLightEstimate) {
      const est = frame.getLightEstimate(xrLightProbe);
      if (est) {
        const d = est.primaryLightDirection;
        const i = est.primaryLightIntensity;
        _lightDirWorld.set(d.x, d.y, d.z);
        // XR primary-light intensity is in linear RGB space. Take a
        // perceptual mean for our single directional key + hemi split.
        _lightEstColor.r = i.x; _lightEstColor.g = i.y; _lightEstColor.b = i.z;
        const meanI = (i.x + i.y + i.z) / 3;
        // Hemi intensity: SH DC term (first coefficient) if available, else
        // a fraction of primary as a stand-in.
        const sh = est.sphericalHarmonicsCoefficients;
        const hemiI = sh ? Math.max(0, (sh[0] + sh[1] + sh[2]) / 3) : meanI * 0.6;
        applyLightEstimate({
          direction: _lightDirWorld,
          intensity: meanI,
          hemiIntensity: hemiI,
        }, dt);
      }
    }

    pollMenuToggle();

    // Sync Web Audio's spatial listener to the XR camera each frame so HRTF
    // pans on paddle/table sounds track head rotation. Cheap (a few
    // AudioParam writes) and required for the room-acoustics pass to feel
    // spatially anchored to the room rather than the listener origin.
    updateAudioListener(renderer.xr.getCamera());

    // NOTE: no per-frame arena tick here. createArena() exposes no update() —
    // the venue is static geometry once mounted, and the crowd wave/idle
    // animation is owned by aiMatch.js (crowdWave.update), which builds it
    // from arena.getCrowdAnchors(). Calling arena.update() from this loop
    // throws, and a throw inside setAnimationLoop stops three.js from
    // re-queueing the frame — the whole session freezes before render.

    // Drill drives: update only while active and not finished. Every drill
    // owns its own feed schedule now — the legacy shared Feeder is gone.
    if (state === 'drill' && drillInstance && !drillFinished) {
      drillInstance.update(dt);
    }
    // M8: the Free Play feeder runs on the same tick when toggled on.
    if (state === 'freePlay' && freePlayFeeder) {
      freePlayFeeder.update(dt);
    }

    // Smooth the visual paddle's world pose toward the controller grip BEFORE
    // the physics tick so collisions read a consistent pose. The "what you see
    // is what collides" invariant depends on this ordering.
    xr.updatePaddleVisual();

    // In multiplayer, the non-owner peer must not integrate the ball or emit
    // table/net/lost events — the owner streams state and mirrors events via
    // the reliable channel. drillInstance.isLocalOwner() reports current side.
    const ballOwned = !(drillInstance && drillInstance.isLocalOwner && !drillInstance.isLocalOwner());
    // Pass the smoothed paddle anchor as the collision pose source. Falls back
    // to the raw grip if no anchor (defensive — shouldn't happen in practice).
    // getRawPose feeds the physics VELOCITY estimate from the unsmoothed grip
    // pose so the pseudo-haptic smoothing can't attenuate brush-stroke spin;
    // contact geometry still reads the smoothed anchor.
    const paddleNode = xr.getPaddleAnchor() || xr.getActiveController();
    tickPhysicsOpts.ballOwned = ballOwned;
    tickPhysicsOpts.getRawPose = xr.getRawPaddlePose;
    tickPhysics(dt, paddleNode, physicsTimeS, tickPhysicsOpts);

    // Decide where the menu lives, then run poke first (fingertip proxy) and
    // fall back to laser hover if poke didn't engage.
    updateMenuPlacement();
    const pokeHandled = updatePokeInput();
    updateMenuRaycast(pokeHandled);
    wristMenu.update(dt);
    // Expire transient wizard messages ("hold still" prompts, etc.).
    if (calibWizard.isVisible()) calibWizard.tick(performance.now());

    // Live HUD line
    if (state === 'drill' && drillInstance && !drillFinished) {
      setLiveLine(drillInstance.liveLine());
    } else if (state === 'freePlay') {
      setLiveLine(freePlayFeeder
        ? 'Free Play  —  feeder ON (B/Y to stop)  —  A/X for menu'
        : 'Free Play  —  trigger to serve  —  B/Y feeder  —  A/X for menu');
    } else if (state === 'menu') {
      setLiveLine('Aim laser at a button  —  trigger to select');
    } else if (state === 'tuner') {
      // "Physics Tuner" was shown for every panel that rides this state,
      // including the two menus, which made the hint wrong more often than
      // right once training gained its own sub-menu tree.
      setLiveLine(isMenuPanel(currentTuner)
        ? 'Aim laser at a row  —  trigger to select  —  A/X to close'
        : 'Physics Tuner  —  changes apply live  —  A/X to close');
    }

    if (state === 'drill' && !drillFinished && drillInstance && drillInstance.isFinished()) {
      drillFinished = true;
      showDrillSummary();
    }

    renderer.render(scene, camera);
  });
}
