// The post-session card: feedback, then the early-access ask.
//
// js/modes/inGame.js used to end an XR session by simply restoring the
// overlay — same hero, same scroll position, no acknowledgement the player had
// played at all. That is the one moment in the whole app where asking for
// anything works: the match just ended, the headset is still on, and the flat
// panel has a real keyboard behind it. This fills that slot.
//
// Ordering is deliberate. Feedback comes first because a one-tap rating is a
// small commitment, and having just told us what they think is what earns the
// bigger ask underneath it. Everything is optional and the card dismisses.
//
// All Firebase work is lazy-imported through js/auth/upgrade.js, so a player
// who never opens this card never pays for the SDK.

import { getMatchSummary } from '../analytics/session.js';

let els = null;
let rating = null;
let feedbackSent = false;
let signedUp = false;

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
  // A rating on its own is the whole point of the tap — send it immediately
  // rather than making the player also find the button. The textarea can
  // still be sent separately afterwards.
  submitFeedback({ silentIfEmpty: true });
}

async function submitFeedback({ silentIfEmpty = false } = {}) {
  const text = els.feedback ? els.feedback.value.trim() : '';
  if (rating === null && !text) {
    if (!silentIfEmpty) setStatus('Add a rating or a note first.', true);
    return;
  }
  if (els.feedbackSend) els.feedbackSend.disabled = true;
  try {
    const { saveFeedback } = await import('../auth/upgrade.js');
    await saveFeedback({
      rating,
      text,
      // What the rating is ABOUT. Without it a "2" is unreadable six weeks
      // later; with it we can separate "the game is bad" from "that match
      // went badly".
      context: { ...(getMatchSummary() || {}), page: 'post-session' },
    });
    feedbackSent = true;
    setStatus('Thanks — that helps a lot.');
  } catch (err) {
    console.warn('[feedback] not sent:', (err && err.code) || (err && err.message));
    setStatus('Could not send that just now — sorry.', true);
  } finally {
    if (els.feedbackSend) els.feedbackSend.disabled = false;
  }
}

async function joinWithGoogle() {
  if (signedUp) return;
  els.google.disabled = true;
  setStatus('Opening Google sign-in…');
  try {
    const { linkGoogle, saveSignup, friendlyAuthError } = await import('../auth/upgrade.js');
    let result;
    try {
      result = await linkGoogle();
    } catch (err) {
      setStatus(friendlyAuthError(err), true);
      return;
    }
    if (!result.email) {
      // A Google account with no address on the token — rare, but the signup
      // row requires one, so fall the player through to typing it.
      setStatus('Signed in, but we could not read your email — enter it below.', true);
      return;
    }
    await saveSignup(result.email, 'google', result.previousUid || null);
    signedUp = true;
    setStatus(`You're on the list — ${result.email}`);
    els.emailRow.hidden = true;
    els.or.hidden = true;
  } catch (err) {
    console.warn('[signup] google path failed:', (err && err.code) || (err && err.message));
    setStatus('Could not complete sign-in — try the email option.', true);
  } finally {
    els.google.disabled = false;
  }
}

async function joinWithEmail() {
  if (signedUp) return;
  const address = els.email.value.trim();
  const { isValidEmail, saveSignup } = await import('../auth/upgrade.js');
  if (!isValidEmail(address)) {
    setStatus('That does not look like an email address.', true);
    els.email.focus();
    return;
  }
  els.emailSend.disabled = true;
  setStatus('Adding you…');
  try {
    await saveSignup(address, 'manual');
    signedUp = true;
    setStatus("You're on the list — thanks!");
    els.emailRow.hidden = true;
    els.or.hidden = true;
    els.google.hidden = true;
  } catch (err) {
    const code = (err && err.code) || '';
    // The rules allow create only, so a second submit from the same account
    // is denied. That is "already on the list", not a failure.
    if (code === 'permission-denied') {
      signedUp = true;
      setStatus("You're already on the list.");
    } else {
      console.warn('[signup] email path failed:', code || (err && err.message));
      setStatus('Could not add you just now — sorry.', true);
    }
  } finally {
    els.emailSend.disabled = false;
  }
}

function hide() {
  if (els && els.card) els.card.hidden = true;
}

/**
 * Show the card. Called from js/modes/inGame.js's XR 'end' handler, right
 * after the overlay is restored.
 */
export function showPostSession() {
  if (!els || !els.card) return;
  const stats = getMatchSummary();
  if (els.summary) els.summary.textContent = summaryLine(stats);
  // A player who already sent both on a previous session should not be asked
  // again — the card still appears (the summary is new) with the asks gone.
  if (feedbackSent && signedUp) {
    els.card.hidden = false;
    return;
  }
  els.card.hidden = false;
  setStatus('');
}

/** Idempotent DOM wiring. Safe to call when the markup is absent. */
export function wirePostSession() {
  const card = $('post-session');
  if (!card || els) return;
  els = {
    card,
    dismiss: $('post-dismiss'),
    summary: $('post-summary'),
    ratingBtns: Array.from(card.querySelectorAll('.rating-btn')),
    feedback: $('post-feedback'),
    feedbackSend: $('post-feedback-send'),
    google: $('post-google'),
    email: $('post-email'),
    emailSend: $('post-email-send'),
    emailRow: card.querySelector('.join-row'),
    or: card.querySelector('.post-or'),
    status: $('post-status'),
  };

  for (const b of els.ratingBtns) {
    b.addEventListener('click', () => setRating(Number(b.dataset.rating)));
  }
  if (els.feedbackSend) els.feedbackSend.addEventListener('click', () => submitFeedback());
  if (els.google) els.google.addEventListener('click', joinWithGoogle);
  if (els.emailSend) els.emailSend.addEventListener('click', joinWithEmail);
  if (els.email) {
    els.email.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinWithEmail(); });
  }
  if (els.dismiss) els.dismiss.addEventListener('click', hide);
}
