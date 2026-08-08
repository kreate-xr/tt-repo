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
import { createArena, onArenaLoadProgress } from '../scene/arena.js';
import { loadModels, ballModel, tableBox, tableSurfaceY, setBallColor } from '../scene/models.js';
import { initDebugHud, hudLog, isDebugHudReady, refreshHud, SELF_TEST } from '../scene/hud.js';
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
import { createM1BallMachineDrill, M1_BALL_MACHINE } from './training/drills/m1BallMachine.js';
import { getQuickFeed } from './training/presets.js';
import { validateConfig, INFINITE, parseDeepLink } from './training/drillConfig.js';
import { createTargetPracticeDrill, TARGET_PRACTICE } from './training/drills/targetPractice.js';
import { createSpinReaderDrill, SPIN_READER } from './training/drills/spinReader.js';
import { createReactionRallyDrill, REACTION_RALLY } from './training/drills/reactionRally.js';
import { createTrajectoryPracticeDrill, TRAJECTORY_PRACTICE } from './training/drills/trajectoryPractice.js';
import { createMultiplayerDrill, MULTIPLAYER } from './multiplayer/multiplayer.js';
import { createAIMatchDrill, AI_MATCH } from './aiMatch/aiMatch.js';
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
};

export async function startInGame({ overlay, loadingScreen, statusEl, multiplayer = null, xrMode = 'ar' } = {}) {
  if (!navigator.xr) {
    if (statusEl) statusEl.textContent = 'WebXR not available in this browser.';
    return;
  }

  // 'ar' → passthrough MR (see the real room); 'vr' / 'vr-tt' → dark arena
  // with spotlights, differing only in which venue GLB is loaded. WebXR
  // session type is fixed at request time, so this is a pre-session choice,
  // driven by the toggle on the start screen.
  const isVR = xrMode === 'vr' || xrMode === 'vr-tt';
  const sessionType = isVR ? 'immersive-vr' : 'immersive-ar';
  const supported = await navigator.xr.isSessionSupported(sessionType);
  if (!supported) {
    const label = isVR ? 'Immersive VR' : 'Immersive AR';
    if (statusEl) statusEl.textContent = `${label} not supported on this device.`;
    return;
  }

  if (overlay) overlay.style.display = 'none';
  await loadModels(loadingScreen, statusEl);
  if (!isDebugHudReady()) initDebugHud();
  initStatsHud();
  // Arena mode: solid dark clear + dimmed base lights + build the room.
  // AR mode keeps the historical transparent clear so passthrough shows.
  let arena = null;
  if (isVR) {
    setArenaClear();
    setArenaLighting();
    arena = createArena(xrMode === 'vr-tt' ? 'tt' : 'stadium');
    if (arena) arena.show();
    // Block the XR session request until the venue GLB is mounted. Otherwise
    // the player enters the headset and sees a black void for however long the
    // 22 MB download + Draco decode takes, with no feedback. Reuse the
    // pre-existing loading screen for the wait; loadModels() already hid it
    // before we get here.
    if (arena && arena.ready) {
      const loadingMsg = loadingScreen ? loadingScreen.querySelector('p') : null;
      if (loadingScreen) {
        if (loadingMsg) loadingMsg.textContent = 'Loading arena…';
        loadingScreen.style.display = 'flex';
      }
      const unsubscribe = loadingMsg ? onArenaLoadProgress((loaded, total, pct) => {
        loadingMsg.textContent = `Loading arena… ${Math.floor(pct)}% ` +
          `(${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`;
      }) : null;
      try {
        await arena.ready;
      } catch (err) {
        console.error('Arena failed to load:', err);
        if (statusEl) statusEl.textContent = 'Failed to load arena: ' + (err?.message || err);
        if (loadingScreen) loadingScreen.style.display = 'none';
        if (arena) arena.dispose();
        restoreARLighting();
        if (overlay) overlay.style.display = 'flex';
        if (unsubscribe) unsubscribe();
        return;
      }
      if (unsubscribe) unsubscribe();
      if (loadingScreen) loadingScreen.style.display = 'none';
    }
  } else {
    setTransparentClear();
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
    await renderer.xr.setSession(session);
    haptics.setSession(session);

    // P16 §5.1: In MR (passthrough) start with the fallback tint so the
    // first few frames — before an XRLightProbe estimate lands — don't
    // look like the VR-tuned key. Rim stays on for silhouette.
    if (xrMode === 'ar') applyMRFallbackLighting();
  } catch (err) {
    console.error('Failed to start XR session:', err);
    const label = isVR ? 'VR' : 'MR';
    if (statusEl) statusEl.textContent = `Failed to start ${label} session: ` + err.message;
    if (overlay) overlay.style.display = 'flex';
    // Roll back arena-mode side effects so the start screen isn't left with
    // a dimmed scene state after a failed request.
    if (isVR) {
      if (arena) arena.dispose();
      restoreARLighting();
    }
    return;
  }

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

  // --- Floating menu + laser ---
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
    getSessionLog: () => lastSessionLog,
    // Prefer the LIVE drill's contacts so review works mid-session too;
    // fall back to the last finished drill's.
    getRecentContacts: () => (
      (drillInstance && drillInstance.getRecentContacts)
        ? drillInstance.getRecentContacts()
        : lastContacts
    ),
  });
  scene.add(trainingMenu.mesh);
  wristMenu.show(); // visible from the moment the session starts
  const laser = createLaserLine();
  scene.add(laser);

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

  // --- Paddle binding ---
  // Slider drag state. A drag is press → move → release, so it needs the
  // trigger's RELEASE as well as its press; `draggingSliderId` pins the drag
  // to whichever slider was grabbed.
  let draggingSliderId = null;
  // Last UV the laser hit on the active panel — the trigger handler needs the
  // pointer position, but it only receives a grip.
  let lastPanelUV = null;

  const xr = setupXRPaddle(session, {
    onSelect: (grip) => handleTrigger(grip),
    onSelectEnd: () => { draggingSliderId = null; },
  });

  xr.onPaddleAttached(() => {
    const targetRay = xr.getActiveTargetRay();
    if (targetRay) {
      if (laser.parent) laser.parent.remove(laser);
      targetRay.add(laser);
    }
  });

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
  trainingMenu.on('tune', () => { trainingMenu.hide(); enterTuner(tuner); });
  trainingMenu.on('exit', () => onTunerBack());

  wristMenu.on('freeplay', () => enterFreePlay());
  wristMenu.on('tune', () => enterTuner(tuner));
  wristMenu.on('calibrate', () => enterTuner(calibWizard));
  wristMenu.on('ballColor', ({ colorId }) => setBallColor(colorId));
  wristMenu.on('exit', () => endSession());

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
      arenaAnchor: arena && arena.getBackWallAnchor ? arena.getBackWallAnchor() : null,
      // Full arena handle so drills can opt into stadium-specific
      // enhancements (live scoreboard on the venue's TV meshes, positional
      // crowd audio on the 24 audience sections). Null when no arena is
      // mounted (AR/MR mode). Drills should feature-detect the accessor
      // methods (getStadiumScreens / getCrowdAnchors) since only the
      // stadium variant populates them.
      arena,
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
      if (currentTuner === trainingMenu && trainingMenu.sliderAt && lastPanelUV) {
        draggingSliderId = trainingMenu.sliderAt(lastPanelUV.u, lastPanelUV.v);
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
    const paddleHand = xr.getActiveHandedness();
    if (!paddleHand) return;
    let pressed = false;
    let altPressed = false;
    for (const src of session.inputSources) {
      if (src.handedness !== paddleHand) continue;
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
    // The training menu is a MENU, not a transient in-play tool: it is read,
    // scrolled and configured. Head-billboarding it at 1.1 m puts a
    // 1.4 m-wide panel in the player's face, too close to read. It gets the
    // wrist menu's fixed world anchor instead — same distance, same pose —
    // so moving between the two menus doesn't change where you look.
    if (state === 'tuner' && currentTuner === trainingMenu && trainingMenu.isVisible()) {
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
    const mesh = (state === 'tuner' && currentTuner === trainingMenu)
      ? trainingMenu.mesh
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
      if (draggingSliderId && panel === trainingMenu) {
        trainingMenu.dragAt(uv.x, uv.y, draggingSliderId);
      } else {
        panel.setHovered(panel.hitTestUV(uv.x, uv.y));
      }
      laser.scale.z = Math.max(0.05, hits[0].distance);
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
    laser.geometry.dispose();
    laser.material.dispose();
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
  const clock = new THREE.Clock();
  renderer.setAnimationLoop((_t, frame) => {
    let dt = clock.getDelta();
    if (dt > 0.1) dt = 0.016;

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
    const paddleNode = xr.getPaddleAnchor() || xr.getActiveController();
    tickPhysics(dt, paddleNode, clock.elapsedTime, { ballOwned });

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
      setLiveLine('Physics Tuner  —  changes apply live  —  A/X to close');
    }

    if (state === 'drill' && !drillFinished && drillInstance && drillInstance.isFinished()) {
      drillFinished = true;
      showDrillSummary();
    }

    if (SELF_TEST) refreshHud();
    renderer.render(scene, camera);
  });
}
