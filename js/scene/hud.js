// Dev diagnostics. The on-screen debug HUD overlay has been removed;
// hudLog forwards to the console only when the page is loaded with ?selftest.

export const SELF_TEST = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('selftest');

export function hudLog(msg) {
  if (SELF_TEST) console.log(msg);
}
