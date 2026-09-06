// The post-session dialog: feedback, then the early-access ask.
//
// js/modes/inGame.js used to end an XR session by simply restoring the
// overlay — same hero, same scroll position, no acknowledgement the player had
// played at all. That is the one moment in the whole app where asking for
// anything works: the match just ended, the headset is still on, and the flat
// panel has a real keyboard behind it.
//
// A MODAL rather than a card in the page. An in-hero card inherited the exact
// problem it was meant to fix — the overlay is restored at whatever scroll
// position the player left from, so the card could open below the fold and be
// missed entirely. A centred dialog cannot be scrolled past.
//
// Ordering is deliberate: a one-tap rating is a small commitment, and having
// just told us what they think is what earns the bigger ask underneath it.
// Everything is optional, and Escape / the backdrop / the × all close it.
//
// Firestore is lazy-imported through js/data/submissions.js, so a player who
// never sends anything never pays for the SDK.

import { getMatchSummary } from '../analytics/session.js';

let els = null;
let rating = null;
let signedUp = false;
// Tapping a rating submits it, but a player picking 4 by going 1-2-3-4 taps
// four times. Without a debounce that is four rows for one opinion, and the
// rules are create-only so they cannot be collapsed afterwards. One row, the
// last value.
let ratingTimer = null;
const RATING_DEBOUNCE_MS = 900;
// Whatever had focus before the dialog opened, so closing puts it back.
let lastFocused = null;

function $(id) { return document.getElementById(id); }

function setStatus(text, isError = false) {
  if (!els || !els.status) return;
  els.status.textContent = text || '';
  els.status.classList.toggle('error', !!isError);
}

/** "14 shots · 79% accuracy · top 62 km/h" — only the parts we actually have. */
function summaryLine(stats) {
  if (!stats) return '';
  const bits = [];
  if (stats.shots) bits.push(`${stats.shots} shot${stats.shots === 1 ? '' : 's'}`);
  if (stats.shots) bits.push(`${stats.accuracyPct}% accuracy`);
  if (stats.maxSpeedKmh > 0) bits.push(`top ${Math.round(stats.maxSpeedKmh)} km/h`);
  return bits.join(' · ');
}

function setRating(value) {
  rating = value;
  for (const b of els.ratingBtns) {
    b.setAttribute('aria-checked', String(Number(b.dataset.rating) === value));
  }
  // A rating needs no second confirming click — that is the whole point of the
  // one-tap path. Deferred just long enough to absorb a run of taps.
  if (ratingTimer) clearTimeout(ratingTimer);
  ratingTimer = setTimeout(() => {
    ratingTimer = null;
    submitFeedback({ silentIfEmpty: true });
  }, RATING_DEBOUNCE_MS);
}

async function submitFeedback({ silentIfEmpty = false } = {}) {
  // An explicit Send beats a pending auto-submit — otherwise the note goes in
  // one row and the rating lands in a second a moment later.
  if (ratingTimer) { clearTimeout(ratingTimer); ratingTimer = null; }
  const text = els.feedback ? els.feedback.value.trim() : '';
  if (rating === null && !text) {
    if (!silentIfEmpty) setStatus('Add a rating or a note first.', true);
    return;
  }
  if (els.feedbackSend) els.feedbackSend.disabled = true;
  try {
    const { saveFeedback } = await import('../data/submissions.js');
    await saveFeedback({
      rating,
      text,
      // What the rating is ABOUT. Without it a "2" is unreadable six weeks
      // later; with it we can separate "the game is bad" from "that match
      // went badly".
      context: { ...(getMatchSummary() || {}), page: 'post-session' },
    });
    setStatus('Thanks — that helps a lot.');
  } catch (err) {
    console.warn('[feedback] not sent:', (err && err.code) || (err && err.message));
    setStatus('Could not send that just now — sorry.', true);
  } finally {
    if (els.feedbackSend) els.feedbackSend.disabled = false;
  }
}

async function joinWithEmail() {
  if (signedUp) return;
  const address = els.email.value.trim();
  const { isValidEmail, saveSignup } = await import('../data/submissions.js');
  if (!isValidEmail(address)) {
    setStatus('That does not look like an email address.', true);
    els.email.focus();
    return;
  }
  els.emailSend.disabled = true;
  setStatus('Adding you…');
  try {
    await saveSignup(address);
    signedUp = true;
    setStatus("You're on the list — thanks!");
    hideSignupAsk();
  } catch (err) {
    const code = (err && err.code) || '';
    // The rules allow create only, so a second submit from the same account is
    // denied. That is "already on the list", not a failure.
    if (code === 'permission-denied') {
      signedUp = true;
      setStatus("You're already on the list.");
      hideSignupAsk();
    } else {
      console.warn('[signup] not saved:', code || (err && err.message));
      setStatus('Could not add you just now — sorry.', true);
    }
  } finally {
    els.emailSend.disabled = false;
  }
}

// Leaves the status line visible (it carries the confirmation) but takes the
// field away, so a second submit is not even offered.
function hideSignupAsk() {
  if (!els) return;
  if (els.emailRow) els.emailRow.hidden = true;
  if (els.consent) els.consent.hidden = true;
}

function onKeydown(e) {
  if (e.key === 'Escape') hide();
}

export function hide() {
  if (!els || !els.card || els.card.hidden) return;
  els.card.hidden = true;
  document.removeEventListener('keydown', onKeydown);
  // The landing page under the dialog is itself a scroll container; releasing
  // it here pairs with the lock in showPostSession.
  document.body.style.overflow = '';
  if (lastFocused && lastFocused.focus) {
    try { lastFocused.focus(); } catch { /* element may be gone */ }
  }
  lastFocused = null;
}

/**
 * Show the dialog. Called from js/modes/inGame.js's XR 'end' handler, right
 * after the overlay is restored.
 */
export function showPostSession() {
  if (!els || !els.card) return;
  const stats = getMatchSummary();
  if (els.summary) els.summary.textContent = summaryLine(stats);

  // PER-SESSION RESET. Leaving XR and going back in is normal, and without
  // this the dialog reopens carrying the previous session's state: the old
  // rating still lit and the old note still in the box. Because tapping a
  // rating submits immediately, that stale note would then be sent a second
  // time, attached to THIS match's context — a duplicate row saying something
  // about a match it was never about.
  if (ratingTimer) { clearTimeout(ratingTimer); ratingTimer = null; }
  rating = null;
  for (const b of els.ratingBtns) b.setAttribute('aria-checked', 'false');
  if (els.feedback) els.feedback.value = '';

  // signedUp is account-level rather than per-session: once they are on the
  // list, stop asking. Hides the whole block so the heading does not sit above
  // an empty space.
  if (els.signup) els.signup.hidden = signedUp;

  setStatus('');
  lastFocused = document.activeElement;
  els.card.hidden = false;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKeydown);
  // Focus the dialog itself rather than the first control: landing on the
  // rating buttons would let a stray Enter submit a score the player never
  // chose.
  if (els.dialog && els.dialog.focus) els.dialog.focus();
}

/** Idempotent DOM wiring. Safe to call when the markup is absent. */
export function wirePostSession() {
  const card = $('post-session');
  if (!card || els) return;
  els = {
    card,
    dialog: card.querySelector('.modal'),
    dismiss: $('post-dismiss'),
    summary: $('post-summary'),
    ratingBtns: Array.from(card.querySelectorAll('.rating-btn')),
    feedback: $('post-feedback'),
    feedbackSend: $('post-feedback-send'),
    email: $('post-email'),
    emailSend: $('post-email-send'),
    emailRow: card.querySelector('.field-row'),
    signup: $('post-signup'),
    consent: card.querySelector('.consent'),
    status: $('post-status'),
  };

  // Focusable so showPostSession can move focus into the dialog without
  // landing on a control, and so screen readers announce it on open.
  if (els.dialog) els.dialog.tabIndex = -1;

  for (const b of els.ratingBtns) {
    b.addEventListener('click', () => setRating(Number(b.dataset.rating)));
  }
  if (els.feedbackSend) els.feedbackSend.addEventListener('click', () => submitFeedback());
  if (els.emailSend) els.emailSend.addEventListener('click', joinWithEmail);
  if (els.email) {
    els.email.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinWithEmail(); });
  }
  if (els.dismiss) els.dismiss.addEventListener('click', hide);
  // Backdrop click, but only the backdrop itself — a click that started inside
  // the dialog and drifted out (selecting text, say) must not close it.
  card.addEventListener('mousedown', (e) => { if (e.target === card) hide(); });
}
