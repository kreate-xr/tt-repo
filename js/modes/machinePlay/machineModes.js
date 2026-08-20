// The Machine Play mode identifiers, on their own.
//
// Deliberately a separate file from machinePlay.js. The menu model needs these
// names, and machinePlay.js reaches the scene through the M1 drill it wraps —
// so importing the modes from there would drag GLTFLoader and the whole scene
// graph into a module that is meant to run headless, taking the menu model's
// unit tests with it.

export const MACHINE_MODES = Object.freeze({
  RALLY: 'rally',
  SURVIVAL: 'survival',
  CHALLENGE: 'challenge',
});

export const DEFAULT_CHALLENGE_TARGET = 25;
