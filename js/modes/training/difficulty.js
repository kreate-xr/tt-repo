// Difficulty profiles. Drills can override individual fields if needed.
//
// `id` is the stable machine key — it selects the AI engine (see
// ENGINE_FACTORIES in js/ai/worker.js) and must never change.
// `label` is display text only and is free to change; the wrist menu already
// shows something different from the label here. Deriving the engine key from
// the label used to work only by coincidence, and would have silently
// resolved to `undefined` the moment the two wordings converged.
export const DIFFICULTY = {
  beginner: {
    id: 'beginner',
    feedIntervalSec: 1.6,
    flightTime: 0.62,
    spinMag: 12,
    placementJitter: 0.10,
    label: 'Club',
  },
  intermediate: {
    id: 'intermediate',
    feedIntervalSec: 1.1,
    flightTime: 0.55,
    spinMag: 25,
    placementJitter: 0.18,
    label: 'International',
  },
  pro: {
    id: 'pro',
    feedIntervalSec: 0.75,
    flightTime: 0.42,
    spinMag: 40,
    placementJitter: 0.28,
    label: 'Elite',
  },
};

export function getProfile(name) {
  return DIFFICULTY[name] || DIFFICULTY.beginner;
}
