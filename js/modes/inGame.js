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
import { loadModels, ballModel, tableBox, tableSurfaceY, setBallColor } from '../scene/models.js';
import { hudLog, SELF_TEST } from '../scene/hud.js';
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
import * as profileStore from '../profile/store.js';
import { PhysicsTuner } from '../scene/physicsTuner.js';
import { CalibrationWizard } from '../scene/calibrationWizard.js';
import { CalibrationTuner } from '../scene/calibrationTuner.js';
import { paddleAngularVelocity } from '../physics/ball.js';
import { update as updateTrackingLossGuard } from '../xr/trackingLossGuard.js';
import { Feeder } from './training/feeder.js';
import { SessionStats } from './training/stats.js';
import { getProfile } from './training/difficulty.js';
import {
  initStatsHud, setLiveLine, hideLiveLine, showSummary, hideSummary, clearStatsHud,
} from '../scene/statsHud.js';
import {
  createM1BallMachineDrill, M1_BALL_MACHINE, buildEnv as buildFeedEnv,
} from './training/drills/m1BallMachine.js';
import { solveFeed } from './training/feedEngine.js';
import { getQuickFeed } from './training/presets.js';
import { validateConfig, INFINITE, parseDeepLink } from './training/drillConfig.js';
import { createTargetPracticeDrill, TARGET_PRACTICE } from './training/drills/targetPractice.js';
import { createSpinReaderDrill, SPIN_READER } from './training/drills/spinReader.js';
import { createReactionRallyDrill, REACTION_RALLY } from './training/drills/reactionRally.js';
import { createTrajectoryPracticeDrill, TRAJECTORY_PRACTICE } from './training/drills/trajectoryPractice.js';
import { createMultiplayerDrill, MULTIPLAYER } from './multiplayer/multiplayer.js';
import { createAIMatchDrill, AI_MATCH } from './aiMatch/aiMatch.js';
import { createMachinePlayDrill, MACHINE_PLAY } from './machinePlay/machinePlay.js';
import { MachinePlayMenu } from '../scene/machinePlayMenu.js';
import * as AudioContextBridge from '../network/AudioContextBridge.js';
import { updateAudioListener } from '../scene/audio.js';
import * as haptics from '../xr/haptics.js';

const DRILL_FACTORIES = {
  // M1 Ball Machine (P15). Replaces the legacy direct-spawn ball machine —
  // its file is deleted rather than left alongside, per rule 3 of
  // tt-training-migration-plan.md (never two live paths for one behaviour).
  ballMachine:        { meta: M1_BALL_MACHINE,     create: createM1BallMachineDrill },
  targetPractice:     { meta: TARGET_PRACTICE,     create: createTargetPracticeDrill },
  spinReader:         { meta: SPIN_READER,         create: createSpinReaderDrill },
  reactionRally:      { meta: REACTION_RALLY,      create: createReactionRallyDrill },
  trajectoryPractice: { meta: TRAJECTORY_PRACTICE, create: createTrajectoryPracticeDrill },
  multiplayer:        { meta: MULTIPLAYER,         create: createMultiplayerDrill },
  aiMatch:            { meta: AI_MATCH,            create: createAIMatchDrill },
  // Playing AGAINST the machine rather than drilling with it — a scorer around
  // the same M1 feed, not a second feeder. See machinePlay/machinePlay.js.
  machinePlay:        { meta: MACHINE_PLAY,        create: createMachinePlayDrill },
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

  // 'ar' → passthrough MR (see the real room); 'vr' / 'vr-tt' → dark arena
  // with spotlights, differing only in which venue GLB is loaded. WebXR
  // session type is fixed at request time, so this is a pre-session choice,
  // driven by the toggle on the start screen.
  //
  // BETA LAUNCH: pinned to false so the minifier dead-code-eliminates the
  // whole VR branch (mode strings included) from the shipped bundle —
  // overlay.js only ever passes 'ar' while the venue picker is off anyway.
  // Restore the original line with the picker.
  const isVR = false;
  // const isVR = xrMode === 'vr' || xrMode === 'vr-tt';
  const sessionType = isVR ? 'immersive-vr' : 'immersive-ar';
  const supported = await navigator.xr.isSessionSupported(sessionType);
  if (!supported) {
    const label = isVR ? 'Immersive VR' : 'Immersive AR';
    if (statusEl) statusEl.textContent = `${label} not supported on this device.`;
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
    session = await navigator.xr.requestSession(sessionType, {
      requiredFeatures: ['local-floor'],
      optionalFeatures,
      domOverlay: { root: document.body },
    });
  } catch (err) {
    console.error('Failed to start XR session:', err);
    const label = isVR ? 'VR' : 'MR';
    if (statusEl) statusEl.textContent = `Failed to start ${label} session: ` + err.message;
    // Nothing to roll back — no scene or lighting state has been touched yet.
    return;
  }

  if (overlay) overlay.style.display = 'none';
  // Arena mode: solid dark clear + dimmed base lights; the room itself is
  // built once the venue GLB arrives, below. AR mode keeps the historical
  // transparent clear so passthrough shows.
  let arena = null;
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
    restoreARLighting();
    setSceneBackground(new THREE.Color(0x1a1a2e));
    if (loadingScreen) loadingScreen.style.display = 'none';
    if (overlay) overlay.style.display = 'flex';
    if (session && session.end) session.end().catch(() => {});
  };

  loadPanel.setText('Loading models…');
  try {
    await loadModels(loadingScreen, statusEl);
  } catch (err) {
    abortEntry('Failed to load 3D models: ' + (err?.message || err));
    return;
  }

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

  // BETA LAUNCH: venue loading disabled with the createArena import above —
  // xrMode is pinned to 'ar' in overlay.js so isVR can't be true anyway;
  // `arena` stays null and every consumer already null-guards it.
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
  let stats = null;
  let feeder = null;
  let drillInstance = null;
  let drillFinished = false;
  let lastDrillParams = null;
  let prevStateBeforeTuner = 'menu'; // restore target when leaving the tuner

  const ballEvents = {
    onPaddleHit, onTableBounce, onNetHit, onBallLost,
    offPaddleHit, offTableBounce, offNetHit, offBallLost,
  };

  // --- Floating menu ---
  const wristMenu = new WristMenu();
  scene.add(wristMenu.mesh); // floating in world; billboarded each frame

  // P15 M0 training menu — a sub-menu of the wrist menu, not a replacement.
  // Backed by the profile store so Saved Presets persist.
  // `lastSessionLog` is captured at teardown so M7 can review a drill AFTER
  // it ends — reading drillInstance directly would find it already disposed.
  let lastSessionLog = null;
  let lastContacts = null;
  const trainingMenu = new TrainingMenu({
    presets: profileStore,
    // Same module, separate slot — the settings screen reads/writes M10
    // globals (dominant hand today) through this one.
    settings: profileStore,
    getSessionLog: () => lastSessionLog,
    // Prefer the LIVE drill's contacts so review works mid-session too;
    // fall back to the last finished drill's.
    getRecentContacts: () => (
      (drillInstance && drillInstance.getRecentContacts)
        ? drillInstance.getRecentContacts()
        : lastContacts
    ),
  });
  // Custom Feed feasibility warning: dry-run the feed solver (no scatter, so
  // it is deterministic) whenever the config is edited, and put the same hint
  // the drill would show into the panel's message line. Without this an
  // unfeedable config only reveals itself after START, as a machine that
  // silently never fires.
  trainingMenu.setFeasibilityProbe((config) => {
    if (!tableBox) return null;   // arena not loaded yet — nothing to check
    const feed = solveFeed(config, buildFeedEnv());
    return feed.feasible ? null
      : 'Too slow to clear the net at that placement — raise speed or pick a shorter zone';
  });
  scene.add(trainingMenu.mesh);

  // P17 Machine Play — what the wrist menu's PLAY tile now opens. It used to
  // drop straight onto an empty table with one hardcoded warmup feed behind a
  // B/Y toggle, which gave the tile nothing to be about. Same sub-menu
  // machinery as the training menu (show/hide/isVisible/mesh/selectHovered/
  // 'back'), so it needed no new input plumbing either.
  const machinePlayMenu = new MachinePlayMenu();
  machinePlayMenu.setFeasibilityProbe((config) => {
    if (!tableBox) return null;   // arena not loaded yet — nothing to check
    const feed = solveFeed(config, buildFeedEnv());
    return feed.feasible ? null
      : 'Too slow to clear the net at that placement — raise speed or pick a shorter zone';
  });
  scene.add(machinePlayMenu.mesh);

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
  calibTuner.on('back', onTunerBack);

  const raycaster = new THREE.Raycaster();
  const tmpQuat = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
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
  wristMenu.on('start', ({ drill, preset, difficulty, config }) => {
    // `config` arrives fully edited from Custom Feed; `preset` is set only
    // when the config came straight from a preset and was not modified.
    lastDrillParams = { drill, preset, difficulty, config };
    enterDrill(drill, difficulty, preset, config);
  });
  // P15 M0 training menu, opened from the wrist menu's TRAINING pill as a
  // SUB-menu. It rides the same currentTuner machinery the physics tuner and
  // calibration wizard use — show/hide/isVisible/mesh/selectHovered/'back' —
  // so backing out of it returns to the wrist menu completely unchanged, and
  // no new input plumbing was needed.
  wristMenu.on('training', ({ difficulty } = {}) => {
    if (difficulty) trainingMenu.setDifficulty(difficulty);
    enterTuner(trainingMenu);
  });
  trainingMenu.on('back', onTunerBack);
  trainingMenu.on('start', ({ drill, preset, difficulty, config, options }) => {
    trainingMenu.hide();
    currentTuner = null;
    lastDrillParams = { drill, preset, difficulty, config, options };
    enterDrill(drill, difficulty, preset, config, options);
  });
  trainingMenu.on('freeplay', () => {
    trainingMenu.hide();
    currentTuner = null;
    enterFreePlay();
  });
  // The footer shortcuts hand off to the existing panels rather than
  // reimplementing them.
  trainingMenu.on('calibrate', () => { trainingMenu.hide(); enterTuner(calibWizard); });
  // Physics tuner mutates live physics constants (gravity, drag, restitution) —
  // in multiplayer the two clients would silently disagree. Dev-only (?selftest).
  trainingMenu.on('tune', () => { if (SELF_TEST) { trainingMenu.hide(); enterTuner(tuner); } });
  trainingMenu.on('exit', () => onTunerBack());

  // The PLAY tile opens the Machine Play menu instead of entering free play
  // directly. Free Hit is still reachable — it is that menu's fifth row, and
  // still the training menu's "8. Free Play" — so nothing was removed, it just
  // stopped being the only thing behind the tile.
  wristMenu.on('machinePlay', () => enterTuner(machinePlayMenu));
  machinePlayMenu.on('back', onTunerBack);
  machinePlayMenu.on('start', ({ mode, config, target }) => {
    machinePlayMenu.hide();
    currentTuner = null;
    const options = { machineMode: mode, target };
    lastDrillParams = { drill: 'machinePlay', difficulty: null, config, options };
    enterDrill('machinePlay', null, null, config, options);
  });
  machinePlayMenu.on('freeHit', () => {
    machinePlayMenu.hide();
    currentTuner = null;
    enterFreePlay();
  });
  machinePlayMenu.on('calibrate', () => { machinePlayMenu.hide(); enterTuner(calibWizard); });
  machinePlayMenu.on('tune', () => { if (SELF_TEST) { machinePlayMenu.hide(); enterTuner(tuner); } });

  wristMenu.on('tune', () => { if (SELF_TEST) enterTuner(tuner); });
  wristMenu.on('calibrate', () => enterTuner(calibWizard));
  wristMenu.on('ballColor', ({ colorId }) => setBallColor(colorId));
  wristMenu.on('exit', () => endSession());

  // Panels that are MENUS rather than transient in-play tools. They get the
  // wrist menu's fixed world anchor instead of head-billboarding at 1.1 m,
  // which puts a 1.4 m-wide panel too close to read, and they own sliders that
  // the trigger has to be able to drag.
  const isMenuPanel = (p) => p === trainingMenu || p === machinePlayMenu;

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
  } else {
    // P15 deep link: `?drill=<code>` starts the ball machine on that config.
    // The codec and its 42 tests already existed; nothing called it, so every
    // shared link silently did nothing. Only honoured when not entering a
    // multiplayer session, which owns the entry path.
    const link = parseDeepLink(typeof window !== 'undefined' ? window.location.href : '');
    if (link) {
      queueMicrotask(() => {
        lastDrillParams = { drill: 'ballMachine', difficulty: null, config: link.config };
        enterDrill('ballMachine', null, null, link.config);
        // A half-parsed link still starts a drill (decode never returns null),
        // so say when the settings are not exactly what was shared.
        hudLog(link.ok ? 'started from shared link' : `shared link was ${link.reason} — using defaults where unreadable`);
      });
    }
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
      ...getQuickFeed('Warmup').config,
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

  function enterDrill(drill, difficulty, preset, config, options) {
    teardownDrill();
    hideSummary();
    const factory = DRILL_FACTORIES[drill] || DRILL_FACTORIES.ballMachine;
    const profile = getProfile(difficulty);
    stats = new SessionStats(factory.meta.id, profile.label);
    // Only build the legacy Feeder for drills that actually feed through it.
    // It was previously constructed for every mode and then hidden — but
    // constructing it builds a whole ServerFigure into the scene, so the ball
    // machine, AI match and multiplayer each carried a second invisible
    // paddle rig. The flag lives on the drill META so it is known BEFORE the
    // instance exists; the instance-level `usesFeeder` still gates updates.
    feeder = factory.meta.usesFeeder === false ? null : new Feeder(profile);
    const factoryArgs = {
      feeder, stats, ballEvents, profile,
      // M1 drills are driven by a DrillConfig rather than a difficulty
      // profile. Other drills ignore this slot.
      config: config || (preset ? getQuickFeed(preset).config : null),
      // M2 pattern / random / ladder selection. Drills that don't understand
      // these ignore them.
      ...(options || {}),
      xr,
      hooks: { exitToMenu: enterMenu, endSession },
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
        hudLog('multiplayer: create or join a room from the start screen first');
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
    // Drills that don't use the feeder (multiplayer, aiMatch) still get a
    // Feeder instance constructed above — its visual is added to the scene
    // by buildServerFigure(). Hide it so we don't render two paddles on
    // the AI side (feeder's idle paddle + the drill's own AI paddle).
    if (drillInstance.usesFeeder === false && feeder && feeder.emitter) {
      feeder.emitter.visible = false;
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
    // The Free Play feeder owns a ServerFigure in the scene, so it must go on
    // every exit path — entering a drill, returning to the menu, or ending the
    // session — not just when Free Play is re-entered.
    stopFreePlayFeeder();
    // Keep the finished session's events for M7 before the drill goes away.
    if (drillInstance && drillInstance.getLog) {
      const log = drillInstance.getLog();
      if (log && log.feedCount > 0) lastSessionLog = log;
    }
    if (drillInstance && drillInstance.getRecentContacts) {
      const c = drillInstance.getRecentContacts();
      if (c && c.contacts.length > 0) lastContacts = c;
    }
    if (drillInstance && drillInstance.dispose) drillInstance.dispose();
    drillInstance = null;
    if (feeder) { feeder.dispose(); feeder = null; }
    clearListeners();
    if (ballModel) ballModel.visible = false;
  }

  function endSession() {
    teardownDrill();
    clearStatsHud();
    if (session && session.end) session.end().catch(() => {});
  }

  function showDrillSummary() {
    if (!stats) return;
    showSummary(stats.snapshot(), {
      onRetry: () => {
        if (lastDrillParams) {
          enterDrill(lastDrillParams.drill, lastDrillParams.difficulty,
            lastDrillParams.preset, lastDrillParams.config, lastDrillParams.options);
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
    // Other drills ignore the trigger (feeder owns serving).
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
      placeMenuStatic();
      return;
    }
    // The training and Machine Play menus are MENUS, not transient in-play
    // tools: they are read, scrolled and configured. Head-billboarding one at
    // 1.1 m puts a 1.4 m-wide panel in the player's face, too close to read.
    // They get the wrist menu's fixed world anchor instead — same distance,
    // same pose — so moving between menus doesn't change where you look.
    if (state === 'tuner' && isMenuPanel(currentTuner) && currentTuner.isVisible()) {
      placeMenuStatic();
      return;
    }
    const panelMesh = activePanelMesh();
    if (!panelMesh) return;
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
  function placeMenuStatic() {
    if (!tableBox || tableSurfaceY == null) return;
    // Whichever menu is up gets the same anchor, so switching between them
    // is a content change rather than a change of place.
    const mesh = (state === 'tuner' && isMenuPanel(currentTuner))
      ? currentTuner.mesh
      : wristMenu.mesh;
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
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQuat).normalize();
    raycaster.set(tmpVec, dir);

    const hits = raycaster.intersectObject(panel.mesh, false);
    if (hits.length && hits[0].uv) {
      const uv = hits[0].uv;
      lastPanelUV = { u: uv.x, v: uv.y };
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
      laser.scale.z = 1.5;
      laser.visible = true;
    }
  }

  // --- Session end cleanup ---
  session.addEventListener('end', () => {
    teardownDrill();
    clearStatsHud();
    wristMenu.hide();
    wristMenu.dispose();
    tuner.hide();
    tuner.dispose();
    if (laser.parent) laser.parent.remove(laser);
    // The laser is a Group (beam tube + tip disc) — dispose its children.
    laser.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    // Tear down arena mode if it was active. restoreARLighting is safe to
    // call unconditionally — it's a no-op relative to the AR defaults.
    if (arena) { arena.dispose(); arena = null; }
    restoreARLighting();
    setSceneBackground(new THREE.Color(0x1a1a2e));
    if (overlay) overlay.style.display = 'flex';
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

    // Drill drives: feeder + drill update only when active and not finished.
    if (state === 'drill' && drillInstance && !drillFinished) {
      if (feeder && drillInstance.usesFeeder !== false) feeder.update(dt);
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
    tickPhysics(dt, paddleNode, physicsTimeS, { ballOwned, getRawPose: xr.getRawPaddlePose });

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
