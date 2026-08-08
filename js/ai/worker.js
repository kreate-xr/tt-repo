// AI Web Worker entry. Routes messages between the main thread and the
// active engine. Runs the decision layer at ~5Hz; main thread interpolates
// rendering at 90Hz. No DOM, no THREE, no physics.
//
// Spec §ai_worker_design.message_protocol:
//   main → worker: {type: 'init', config}, {type: 'shot', payload},
//                  {type: 'request_target', context}, {type: 'reset'},
//                  {type: 'set_difficulty', value}
//   worker → main: {type: 'ready'}, {type: 'target', payload},
//                  {type: 'error', message}
//
// All three engines are wired in ENGINE_FACTORIES below. (This previously said
// Intermediate and Pro fall back to Beginner "for now" — they have not for a
// long time.)

import { ShotHistory } from './shotHistory.js';
import { createBeginnerEngine } from './engines/beginner.js';
import { createIntermediateEngine } from './engines/intermediate.js';
import { createProEngine } from './engines/pro.js';
import { createMomentumModel } from './momentum.js';

const ENGINE_FACTORIES = {
  beginner: createBeginnerEngine,
  intermediate: createIntermediateEngine,
  pro: createProEngine,
};

let history = new ShotHistory();
let engine = createBeginnerEngine();
let momentum = createMomentumModel();
let difficulty = 'beginner';
// Player style for this session (attacker / blocker / chopper / allround).
// Picked by aiMatch.js at match creation and sent in the init message so
// engines and the shot-type selector can shape weights per style.
let style = 'allround';

function makeEngine(diff) {
  const factory = ENGINE_FACTORIES[diff] || createBeginnerEngine;
  return factory();
}

function safe(fn) {
  try { fn(); }
  catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'init': {
      difficulty = (msg.config && msg.config.difficulty) || 'beginner';
      style = (msg.config && msg.config.style) || 'allround';
      engine = makeEngine(difficulty);
      history.reset();
      momentum.reset();
      self.postMessage({ type: 'ready' });
      break;
    }
    case 'point_result': {
      // { winner: 'ai'|'player', aiScore, playerScore } — main thread
      // forwards these from rallyManager.on('onPointScored'). Momentum
      // is derived from both signals so an AI comeback at 4-9 registers
      // as tentative-but-improving rather than instantly euphoric.
      safe(() => momentum.update(msg.payload || {}));
      break;
    }
    case 'shot': {
      safe(() => {
        history.push(msg.payload);
        engine.ingestShot(msg.payload, history);
      });
      break;
    }
    case 'request_target': {
      safe(() => {
        // Inject the current momentum value into ctx so engines can scale
        // their exploit factor and shot-type weights without needing their
        // own state.
        const baseCtx = msg.context || {};
        const ctx = {
          ...baseCtx,
          momentum: momentum.get(),
          momentumScaleExploit: momentum.exploitScale(),
          momentumSwingSpeedScale: momentum.swingSpeedScale(),
          momentumBiasShotTypeWeights: momentum.biasShotTypeWeights,
          // NOTE: no momentumMissRateBoost here. The miss dice are rolled on
          // the MAIN thread (aiFSM), which tracks its own streak and reads
          // STREAK_MISS_BOOST_ADDITIVE from momentum.js directly. This context
          // used to carry the value too, where no engine ever read it.
          style,
        };
        const target = engine.computeTarget(history, ctx);
        self.postMessage({ type: 'target', payload: target });
      });
      break;
    }
    case 'reset': {
      safe(() => {
        history.reset();
        engine.reset();
        momentum.reset();
      });
      break;
    }
    case 'set_difficulty': {
      safe(() => {
        difficulty = msg.value;
        engine = makeEngine(difficulty);
        // Switching tier is a NEW OPPONENT, so everything learned about the
        // player under the old one has to go with it. This previously rebuilt
        // only the engine, leaving the new tier to inherit the previous
        // opponent's 15-slot ShotHistory and its momentum/streak state — so
        // dropping from ELITE to CLUB would hand the beginner a fully-trained
        // struggle heatmap to exploit despite having "seen" nothing.
        //
        // Latent, not live: nothing currently posts set_difficulty (aiMatch
        // builds a fresh worker per match, so difficulty is fixed at init).
        // Fixed anyway because the handler exists and the failure would be
        // silent — the AI would just be inexplicably sharp.
        //
        // NOTE `style` is deliberately NOT re-picked here. It is chosen on the
        // main thread by aiMatch (pickStyleForMatch) and also drives
        // paddle.movementMultiplier, so re-rolling it worker-side would put
        // the two threads out of sync. A caller of set_difficulty must send a
        // fresh init config too.
        history.reset();
        momentum.reset();
      });
      break;
    }
  }
};

self.postMessage({ type: 'ready' });
