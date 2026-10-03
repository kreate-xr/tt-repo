// The post-session dialog: feedback and the early-access ask, one Send.
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
// ONE BUTTON. An earlier cut had "Send feedback" under the note and "Join"
// beside the email, and a player who filled in both had to press both — the
// second press was routinely skipped. Now everything goes out together, only
// the parts that were filled in are sent, and the form is replaced by a
// thank-you so the player knows it landed. Everything is still optional, and
// Escape / the backdrop / the × all close it.
//
// Firestore is lazy-imported through js/data/submissions.js, so a player who
// never sends anything never pays for the SDK.

import { getMatchSummary } from '../analytics/session.js';

let els = null;
let rating = null;
// Account-level: once they are on the list, stop asking.
let signedUp = false;
// Per-session: set once this session's feedback row is written, so a retry
// after a failed signup does not write the rating a second time (the rules
// are create-only, so duplicates cannot be collapsed afterwards).
let feedbackSent = false;
let sending = false;
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
}

function noteText() {
  return els.feedback ? els.feedback.value.trim() : '';
}

function emailText() {
  return els.email && !signedUp ? els.email.value.trim() : '';
}

/**
 * Write the feedback row for this session, if there is anything in it and it
 * has not gone out already. Resolves true when a row was written.
 */
async function sendFeedbackOnce() {
  if (feedbackSent) return false;
  const text = noteText();
  if (rating === null && !text) return false;
  const { saveFeedback } = await import('../data/submissions.js');
  await saveFeedback({
    rating,
    text,
    // What the rating is ABOUT. Without it a "2" is unreadable six weeks
    // later; with it we can separate "the game is bad" from "that match
    // went badly".
    context: { ...(getMatchSummary() || {}), page: 'post-session' },
  });
  feedbackSent = true;
  return true;
}

/**
 * Add the typed address to the list. Resolves 'added', 'already' or null
 * (nothing typed). Throws on a real failure.
 */
async function sendSignup(address) {
  if (!address || signedUp) return null;
  const { saveSignup } = await import('../data/submissions.js');
  try {
    await saveSignup(address);
    signedUp = true;
    return 'added';
  } catch (err) {
    // The rules allow create only, so a second submit from the same account is
    // denied. That is "already on the list", not a failure.
    if (err && err.code === 'permission-denied') {
      signedUp = true;
      return 'already';
    }
    throw err;
  }
}

function showThanks({ gaveFeedback, signup }) {
  const lines = [];
  if (gaveFeedback) {
    lines.push('Your feedback goes straight to the people building this — it genuinely shapes what we fix next.');
  }
  if (signup === 'added') {
    lines.push("You're on the early-access list. We'll send one email when the full version is ready.");
  } else if (signup === 'already') {
    lines.push("You're already on the early-access list — we'll email you when the full version is ready.");
  }
  if (els.doneTitle) {
    els.doneTitle.textContent = gaveFeedback ? 'Thanks for the feedback!' : "You're in!";
  }
  if (els.doneText) els.doneText.textContent = lines.join(' ');
  if (els.form) els.form.hidden = true;
  if (els.done) {
    els.done.hidden = false;
    if (els.doneClose && els.doneClose.focus) els.doneClose.focus();
  }
}

async function submitAll() {
  if (sending || !els) return;
  const address = emailText();
  const hasFeedback = !feedbackSent && (rating !== null || !!noteText());
  if (!hasFeedback && !address) {
    setStatus('Add a rating, a note, or your email first.', true);
    return;
  }
  const { isValidEmail } = await import('../data/submissions.js');
  if (address && !isValidEmail(address)) {
    setStatus('That does not look like an email address.', true);
    els.email.focus();
    return;
  }

  sending = true;
  if (els.send) els.send.disabled = true;
  setStatus('Sending…');
  let gaveFeedback = feedbackSent;
  let signup = null;
  try {
    if (await sendFeedbackOnce()) gaveFeedback = true;
    signup = await sendSignup(address);
    setStatus('');
    showThanks({ gaveFeedback, signup });
  } catch (err) {
    const code = (err && err.code) || (err && err.message);
    if (feedbackSent && address) {
      // Feedback is in; only the email failed. Keep the form so they can
      // retry — the retry sends the email alone.
      console.warn('[signup] not saved:', code);
      setStatus('Feedback sent, but we could not add your email just now — try again?', true);
    } else {
      console.warn('[feedback] not sent:', code);
      setStatus('Could not send that just now — sorry.', true);
    }
  } finally {
    sending = false;
    if (els.send) els.send.disabled = false;
  }
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
  // rating still lit, the old note still in the box, or the thank-you from
  // last time standing in for a form that was never shown.
  rating = null;
  feedbackSent = false;
  for (const b of els.ratingBtns) b.setAttribute('aria-checked', 'false');
  if (els.feedback) els.feedback.value = '';
  if (els.form) els.form.hidden = false;
  if (els.done) els.done.hidden = true;

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
  // rating buttons would let a stray Enter pick a score the player never
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
    form: $('post-form'),
    ratingBtns: Array.from(card.querySelectorAll('.rating-btn')),
    feedback: $('post-feedback'),
    email: $('post-email'),
    signup: $('post-signup'),
    send: $('post-send'),
    status: $('post-status'),
    done: $('post-done'),
    doneTitle: $('post-done-title'),
    doneText: $('post-done-text'),
    doneClose: $('post-done-close'),
  };

  // Focusable so showPostSession can move focus into the dialog without
  // landing on a control, and so screen readers announce it on open.
  if (els.dialog) els.dialog.tabIndex = -1;

  for (const b of els.ratingBtns) {
    b.addEventListener('click', () => setRating(Number(b.dataset.rating)));
  }
  if (els.send) els.send.addEventListener('click', submitAll);
  if (els.email) {
    els.email.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAll(); });
  }
  if (els.doneClose) els.doneClose.addEventListener('click', hide);
  if (els.dismiss) els.dismiss.addEventListener('click', hide);
  // Backdrop click, but only the backdrop itself — a click that started inside
  // the dialog and drifted out (selecting text, say) must not close it.
  card.addEventListener('mousedown', (e) => { if (e.target === card) hide(); });
}
