// Dev diagnostics. The on-screen debug HUD overlay has been removed;
// hudLog forwards to the console only when the page is loaded with ?selftest.

export const SELF_TEST = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('selftest');

// Dev-only physics tuner gate. The A/B tuner panel (and its menu buttons)
// only exist when the page is loaded with ?tuner (or ?selftest, which
// implies a dev session). Production players never see it.
export const TUNER_ENABLED = SELF_TEST
  || (typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).has('tuner'));

export function hudLog(msg) {
  if (SELF_TEST) console.log(msg);
}
